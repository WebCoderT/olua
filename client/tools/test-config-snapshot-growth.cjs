#!/usr/bin/env node
/**
 * 配置快照覆写（成长底座）回归单测（#361 建、#590 重写）
 *
 * #590 起曲线 / 标量 / 经验公式全部搬去服务端（server/src/shared/growth-seed.ts 是唯一书写处），
 * 客户端不再有任何派生 —— 断言口径随之翻转：
 * · **零本地数据** —— 模块加载期 levelMap / titleLevels / soulLevels / rankLevels 全是空表
 * · **整表重建** —— 快照 `levels` / `titles` / `souls` / `ranks` 段到达后先清空再按行填
 *   （数组与 Map 的**引用不变**），服务端没有的行客户端就没有
 * · **上限走标量** —— roleMaxLevel / mpRecoverPerSecond 由 growthScalars 下发；未知标量键忽略不炸
 * · **兜底不炸** —— 空快照（旧服务端）保留当前值；同一份快照重复覆写幂等
 *
 * 行数据用**真实配置快照**（factory-data 从 server/data/config-sync.sql 读出 /
 * soul-seed / rank-seed）展开，不在测试里复刻一行数值。
 *
 * 用法：node client/tools/test-config-snapshot-growth.cjs
 */
const path = require("path");
const { prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");
/** #655 起配置的唯一来源是数据库快照（server/data/config-sync.sql） */
const factory = require("./lib/factory-data.cjs");

function main() {
  let outDir;
  try {
    outDir = prepare("olua-snapshot-growth", ["configs/apply-snapshot.ts"]);
  } catch (error) {
    fail(String(error.message ?? error));
    return;
  }

  const growth = require(path.join(outDir, "configs/game-config.js"));
  const level = require(path.join(outDir, "configs/game-config.js"));
  const title = require(path.join(outDir, "configs/game-config.js"));
  const soul = require(path.join(outDir, "configs/game-config.js"));
  const rank = require(path.join(outDir, "configs/game-config.js"));
  const snapshotApi = require(path.join(outDir, "configs/apply-snapshot.js"));

  const { levelMap } = level;
  const { titleLevels } = title;
  const { soulLevels } = soul;
  const { rankLevels } = rank;
  // roleMaxLevel 是 `export let`：CommonJS 下解构会拷成快照，必须按属性读
  const maxLevel = () => growth.roleMaxLevel;

  // 快照行就是「库里那几行」本身（DTO 形状已由 factory-data 换算好）
  const growthSeed = { GROWTH_SCALARS: factory.growthScalars() };
  const levelMapRows = new Map(factory.levels().map((row) => [row.level, row]));
  const roleMaxLevelValue = factory.levels().length;

  const levelRows = (scale = 1) =>
    factory.levels().map((row) => ({ ...row, maxHp: Math.round(row.maxHp * scale) }));
  const titleRows = () => factory.titles().map(({ updatedAt, ...row }) => row);
  const soulRows = () => factory.souls().map(({ updatedAt, ...row }) => row);
  const rankRows = () => factory.ranks().map(({ updatedAt, ...row }) => row);

  console.log("\n=== 零本地数据：加载期全是空表 ===");
  check(levelMap.size === 0, "levelMap 加载期为空（等级数据唯一来源 = 快照 levels 段）", String(levelMap.size));
  check(titleLevels.length === 0, "titleLevels 加载期为空");
  check(soulLevels.length === 0, "soulLevels 加载期为空");
  check(rankLevels.length === 0, "rankLevels 加载期为空");

  console.log("\n=== levels 段整表重建（引用不变）===");
  const mapRef = levelMap;
  snapshotApi.applyGrowthSnapshot({ growthScalars: [], levels: levelRows() });
  check(mapRef === levelMap, "levelMap 引用不变（消费方拿到的还是同一个 Map）");
  check(levelMap.size === roleMaxLevelValue, "行数 = 服务端 roleMaxLevel", `${levelMap.size}`);
  check(levelMap.get(1).maxHp === levelMapRows.get(1).maxHp, "1 级 maxHp = 种子展开值", String(levelMap.get(1).maxHp));
  check(levelMap.get(1).exp === levelMapRows.get(1).exp, "1 级升级经验 = 快照下发的最终值（客户端不再派生）", String(levelMap.get(1).exp));
  check(Array.isArray(levelMap.get(1).physicalAttack), "区间对象转回客户端元组 [min, max]", JSON.stringify(levelMap.get(1).physicalAttack));

  // 模拟服务端改曲线后下发的新值：同一份行数据整体放大
  snapshotApi.applyGrowthSnapshot({ growthScalars: [], levels: levelRows(2) });
  check(levelMap.get(1).maxHp === levelMapRows.get(1).maxHp * 2, "第二份快照整表替换（不是只增量补行）", String(levelMap.get(1).maxHp));

  console.log("\n=== 三条成长线：titles / souls / ranks 段 ===");
  title.applyTitleRows(titleRows());
  soul.applySoulRows(soulRows());
  rank.applyRankRows(rankRows());
  check(titleLevels.length === titleRows().length, "称号阶数 = 快照行数", String(titleLevels.length));
  check(titleLevels[0].attributes.physicalAttack[0] === titleRows()[0].attributes.physicalAttack.min, "称号属性 = 快照值（客户端零派生）");
  check(soulLevels.length === soulRows().length, "战魂阶数 = 快照行数", String(soulLevels.length));
  check(rankLevels.length === rankRows().length, "军衔阶数 = 快照行数（1 连续到 100）", String(rankLevels.length));
  check(rankLevels[0].tier === rankRows()[0].tier, "军衔大段名（tier）随快照下发", rankLevels[0].tier);
  check(titleMax() === titleLevels.length, "titleMaxLevel() 读的是运行时表", String(titleMax()));
  check(soulMax() === soulLevels.length, "soulMaxLevel() 读的是运行时表", String(soulMax()));
  check(rankMax() === rankLevels.length, "rankMaxLevel() 读的是运行时表", String(rankMax()));

  console.log("\n=== 标量：roleMaxLevel 下发 ===");
  snapshotApi.applyGrowthScalars([{ key: "roleMaxLevel", value: 70, description: "", updatedAt: 0 }]);
  check(maxLevel() === 70, "等级上限读到服务端的 70", String(maxLevel()));
  snapshotApi.applyGrowthScalars([{ key: "attributeRange.unknownRate", value: 999, description: "", updatedAt: 0 }]);
  check(maxLevel() === 70, "未知标量键被忽略，不影响其余参数", String(maxLevel()));

  console.log("\n=== 标量：mpRecoverPerSecond 下发（#605）===");
  // 与 roleMaxLevel 一样是 `export let`：CommonJS 下解构会拷成快照，必须按属性读
  const roleConfig = require(path.join(outDir, "configs/role.js"));
  const mpRate = () => roleConfig.mpRecoverPerSecond;
  check(
    roleConfig.mpRecoverPerSecond === growthSeed.GROWTH_SCALARS.mpRecoverPerSecond,
    "出厂值 = 服务端种子（快照没到时的兜底两边一致）",
    `${roleConfig.mpRecoverPerSecond} vs ${growthSeed.GROWTH_SCALARS.mpRecoverPerSecond}`,
  );
  snapshotApi.applyGrowthScalars([{ key: "mpRecoverPerSecond", value: 5, description: "", updatedAt: 0 }]);
  check(mpRate() === 5, "回复速度随快照覆写成 5（客户端演出与结算同速）", String(mpRate()));
  snapshotApi.applyGrowthScalars([{ key: "mpRecoverPerSecond", value: -3, description: "", updatedAt: 0 }]);
  check(mpRate() === 0, "负数按 0 处理（配置拍错时宁可不回蓝，也不能倒扣）", String(mpRate()));
  snapshotApi.applyGrowthScalars([{ key: "roleMaxLevel", value: 70, description: "", updatedAt: 0 }]);
  check(mpRate() === 0, "只下发别的标量时回复速度保持不变（不是每次整份重置）", String(mpRate()));

  console.log("\n=== 缩表：服务端把上限调小 ===");
  const shrunken = levelRows().filter((row) => row.level <= 50);
  snapshotApi.applyGrowthSnapshot({ growthScalars: [], levels: shrunken });
  check(levelMap.size === 50, "整表重建后行数跟着缩（管理端调小上限，客户端没有幽灵等级）", String(levelMap.size));
  check(!levelMap.has(51) && !levelMap.has(70), "50 级以上已清空");

  console.log("\n=== 契约（#604）：空快照必须炸，不再「保留当前值」 ===");
  snapshotApi.applyGrowthSnapshot({ growthScalars: [], levels: levelRows() });
  const hpBefore = levelMap.get(1).maxHp;
  let contractError = "";
  try {
    snapshotApi.applyConfigSnapshot({});
  } catch (error) {
    contractError = String((error && error.message) || error);
  }
  check(contractError.indexOf("levels") >= 0, "空快照抛错，错误里点名 levels 段", contractError.slice(0, 60));
  check(levelMap.get(1).maxHp === hpBefore, "抛错前不落库（等级表还是上一份快照的样子）");
  check(maxLevel() === 70, "抛错不动等级上限", String(maxLevel()));

  const reapply = () => {
    snapshotApi.applyGrowthSnapshot({ growthScalars: [], levels: levelRows(2) });
    title.applyTitleRows(titleRows());
    soul.applySoulRows(soulRows());
    rank.applyRankRows(rankRows());
  };
  reapply();
  const once = JSON.stringify([...levelMap.entries()]);
  reapply();
  const twice = JSON.stringify([...levelMap.entries()]);
  check(once === twice, "同一份快照连续覆写两次结果一致（幂等，重进游戏不会滚雪球）");
  check(titleLevels.length === titleRows().length && rankLevels.length === rankRows().length, "幂等同样覆盖三条成长线");

  function titleMax() { return title.titleMaxLevel(); }
  function soulMax() { return soul.soulMaxLevel(); }
  function rankMax() { return rank.rankMaxLevel(); }

  finish("配置快照成长底座：全部断言通过");
}

main();
