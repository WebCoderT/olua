#!/usr/bin/env node
/**
 * 战魂逐级明文表回归单测（issue #17 建；#590 重写为服务端种子口径）
 *
 * #590 起战魂数据的唯一书写处 = `server/src/shared/soul-seed.ts`（消耗 + 属性两张逐阶明文表
 * 都在服务端），客户端 configs/game-config 是**空运行时表**（快照整表下发）—— 本测试盯的是这套
 * 数据本身的不变量：
 *
 * · 数据完整性：两张表与外观序列逐阶对齐、等级 1~37 连续（错位会在消费端静默 undefined）
 * · 消耗曲线：逐阶严格递增、全为正整数；总消耗与「约 527 万」口径一致
 * · 属性曲线：逐阶不降（含跨系列跳档：灵体 → 兽魂/魔将 → 魔神 边界严格上升）、满阶 ≈ 60 级裸属性 67.5%
 * · 三条成长线排序不被打破：满阶称号 < 满阶军衔 < 满阶战魂（README 口径 39% < 52.5% < 67.5%）
 * · 数据链路：客户端运行时表 = 服务端种子逐行展开（seedRuntimeTables 用真实种子灌）
 * · 客户端零数据：soul.ts 里不再有任何战魂数据或派生公式（读源码静态断言）
 *
 * 用法：node client/tools/test-soul-growth.cjs
 */
const fs = require("fs");
const path = require("path");
const { prepare, compileServerShared, seedRuntimeTables, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const ASSETS = path.resolve(__dirname, "..", "assets");

function main() {
  let outDir;
  try {
    outDir = prepare("olua-soul-growth", ["configs/game-config.ts", "configs/game-config.ts", "configs/game-config.ts", "configs/game-config.ts"]);
  } catch (error) {
    fail(String(error.message ?? error));
    return;
  }

  seedRuntimeTables(outDir);
  const soulSeed = require(compileServerShared("soul-seed.ts", "olua-soul-soul-seed"));
  const growthSeed = require(compileServerShared("growth-seed.ts", "olua-soul-growth-seed"));
  const { soulLevels, soulMaxLevel, getSoulLevel } = require(path.join(outDir, "configs/game-config.js"));
  const { titleLevels } = require(path.join(outDir, "configs/game-config.js"));
  const { rankLevels } = require(path.join(outDir, "configs/game-config.js"));

  // 消耗表 = 种子展开行的 bindGold（升到 N 阶的价；37 阶满阶不再有消耗）
  const soulUpgradeCosts = soulSeed.SOUL_SEEDS.map((row) => row.bindGold);

  console.log("\n=== 数据完整性：两张表与外观序列逐阶对齐 ===");
  check(soulMaxLevel() === 37, `战魂共 ${soulMaxLevel()} 阶（resources/war-soul 的 37 个外观目录）`);
  check(soulSeed.SOUL_SEEDS.length === 37, "服务端种子 37 行");
  check(soulLevels.length === soulSeed.SOUL_SEEDS.length, "客户端运行时表行数 = 服务端种子行数（#590 整表重建）");
  // 属性键序不参与比较（种子行 hpRecover 在末尾、客户端构造顺序不同），属性按固定键序取值再比
  const ATTR_KEYS = ["maxHp", "hpRecover", "physicalAttack", "magicAttack", "taoistAttack", "physicalDefense", "magicDefense", "taoistDefense"];
  const attrJson = (attributes) => JSON.stringify(ATTR_KEYS.map((key) => attributes[key]));
  const seedMismatch = soulLevels.filter((config, index) => {
    const seed = soulSeed.SOUL_SEEDS[index];
    return (
      config.level !== seed.level ||
      config.label !== seed.label ||
      config.description !== seed.description ||
      config.bindGold !== seed.bindGold ||
      config.animation !== seed.animation ||
      config.animationFrameRate !== seed.animationFrameRate ||
      attrJson(config.attributes) !== attrJson(seed.attributes)
    );
  });
  check(!seedMismatch.length, "客户端每行与服务端种子逐行一致（属性/消耗/文案/动画）", seedMismatch.map((config) => config.level).join("、") || "37 阶全部命中");
  soulLevels.forEach((config, index) => {
    if (config.level !== index + 1) fail(`等级不连续：第 ${index + 1} 项 level = ${config.level}`);
    if (typeof config.bindGold !== "number" || !(config.bindGold > 0)) fail(`${config.level} 阶消耗缺失`);
    if (!config.attributes || typeof config.attributes.maxHp !== "number") fail(`${config.level} 阶属性缺失`);
  });
  check(true, `1~${soulMaxLevel()} 阶逐项消耗与属性齐全（缺失会在上方直接 fail）`);
  check(getSoulLevel(0) === null && getSoulLevel(-1) === null, "未激活战魂（level ≤ 0）返回 null");
  check(getSoulLevel(soulMaxLevel() + 1) === null, `超出满阶（${soulMaxLevel() + 1} 阶）返回 null`);

  console.log("\n=== 消耗曲线：逐阶严格递增 ===");
  let costLadderOk = true;
  for (let i = 1; i < soulUpgradeCosts.length; i++) {
    if (!(soulUpgradeCosts[i] > soulUpgradeCosts[i - 1])) costLadderOk = false;
    if (!Number.isInteger(soulUpgradeCosts[i])) costLadderOk = false;
  }
  check(costLadderOk, "升阶消耗逐阶严格递增且全为整数");
  const totalCost = soulUpgradeCosts.reduce((sum, cost) => sum + cost, 0);
  check(totalCost === 5272500, `升满战魂合计 ${totalCost} 绑定元宝（改了消耗表记得同步文档里「约 527 万」那句口径）`);
  check(soulUpgradeCosts[0] === 300, "1 阶 300（新手第一阶不心疼）");
  check(soulUpgradeCosts[soulUpgradeCosts.length - 1] === 410700, `末阶 ${soulUpgradeCosts[soulUpgradeCosts.length - 1]}（约为 1 阶的 1300 倍，长线压力）`);

  console.log("\n=== 属性曲线：逐阶不降、跳档可见、满阶定标 ===");
  const upper = (value) => (Array.isArray(value) ? value[1] : value);
  const lower = (value) => (Array.isArray(value) ? value[0] : value);
  const keys = ["maxHp", "physicalAttack", "magicAttack", "taoistAttack", "physicalDefense", "magicDefense", "taoistDefense", "hpRecover"];
  let monotonicOk = true;
  for (let i = 1; i < soulLevels.length; i++) {
    for (const key of keys) {
      if (upper(soulLevels[i].attributes[key]) < upper(soulLevels[i - 1].attributes[key])) monotonicOk = false;
      if (lower(soulLevels[i].attributes[key]) < lower(soulLevels[i - 1].attributes[key])) monotonicOk = false;
    }
  }
  check(monotonicOk, "全部属性逐阶不降（上限与下限都校验）");
  check(soulLevels[20].attributes.maxHp > soulLevels[19].attributes.maxHp, "跨系列跳档可见：20 阶（灵体系末）→ 21 阶（兽魂/魔将系首）属性上升");
  check(soulLevels[35].attributes.maxHp > soulLevels[34].attributes.maxHp, "跨系列跳档可见：35 阶（兽魂系末）→ 36 阶（魔神系首）属性上升");
  const soulBare60 = growthSeed.getRoleLevelAttributes(60);
  const freezeRate = 0.5 * 1.35; // 冻结时的口径：等效 60 级裸属性 × rate 0.5 × 魔神系 factor 1.35
  check(soulLevels[soulLevels.length - 1].attributes.maxHp === Math.round(soulBare60.maxHp * freezeRate), `满阶 maxHp = 60 级裸 maxHp × ${freezeRate}（冻结定标 ${soulLevels[soulLevels.length - 1].attributes.maxHp}）`);
  check(upper(soulLevels[soulLevels.length - 1].attributes.physicalAttack) === Math.round(soulBare60.physicalAttack[1] * freezeRate), "满阶攻击上限同一口径");
  check(soulLevels[soulLevels.length - 1].attributes.maxHp / soulLevels[0].attributes.maxHp > 1000, `满阶 vs 1 阶 maxHp 拉开 ${Math.round(soulLevels[soulLevels.length - 1].attributes.maxHp / soulLevels[0].attributes.maxHp)} 倍（长线成长可感知）`);

  console.log("\n=== 三条成长线：满阶收益排序 称号 < 军衔 < 战魂 ===");
  const titleMaxHp = titleLevels[titleLevels.length - 1].attributes.maxHp;
  const rankMaxHp = rankLevels[rankLevels.length - 1].attributes.maxHp;
  const soulMaxHp = soulLevels[soulLevels.length - 1].attributes.maxHp;
  check(titleMaxHp < rankMaxHp, `满阶称号 maxHp ${titleMaxHp}（≈39%）< 满阶军衔 ${rankMaxHp}（≈52.5%）`);
  check(rankMaxHp < soulMaxHp, `满阶军衔 ${rankMaxHp} < 满阶战魂 ${soulMaxHp}（≈67.5%）`);
  check(
    Math.round((titleMaxHp / soulBare60.maxHp) * 100) === 39 && Math.round((rankMaxHp / soulBare60.maxHp) * 100) === 53,
    "称号/军衔的满阶收益比例与 README 描述一致（39% / 52.5%，四舍五入 53）",
  );

  console.log("\n=== 客户端零数据：soul.ts 不再有任何数据或派生 ===");
  const soulSrc = fs.readFileSync(path.join(ASSETS, "configs/game-config.ts"), "utf8");
  check(!/getRoleLevelAttributes|getEquivalentLevel|scaleAttributes|soulGrowth|soulUpgradeCosts|soulLevelAttributes/.test(soulSrc), "soul.ts 不再引用等级曲线、旧派生函数或本地数据表");
  check(/soulLevels: SoulLevelConfig\[\] = \[\]/.test(soulSrc), "运行时表以空数组起（快照到达后整表重建）");
  // 数据明文搬家了：两张表现在只在服务端种子
  const soulSeedSrc = fs.readFileSync(path.join(ASSETS, "..", "..", "server", "src", "shared", "soul-seed.ts"), "utf8");
  check(/SOUL_UPGRADE_COSTS: number\[\] = \[/.test(soulSeedSrc) && /SOUL_ATTRIBUTE_ROWS/.test(soulSeedSrc), "消耗表与属性表以字面量形式在服务端种子里（唯一书写处）");

  finish("PASS：战魂逐级明文表完整、曲线单调、三条成长线排序保持、数据唯一来源在服务端种子。");
}

main();
