#!/usr/bin/env node
/**
 * 配置层单测的共用沙箱（client/tools/test-bag-*.cjs 都用它，改这里即可让所有配置层单测跟着变）
 *
 * 做法：把 `assets/configs/items.ts`（连同它依赖的 equipments / drug / material / growth / role / types）
 * 编译成 CommonJS 到临时目录，再用一个只实现 `Vec2` / `Vec3` / `Size` / `Color` 的 `cc` 垫片顶替引擎 ——
 * 配置表只用到这四个纯数据类，没有任何引擎行为，于是 node 里就能直接 require **真实的配置表与真实函数**
 * 跑断言（不是复刻一份逻辑）。
 *
 * 用法：
 *   const { prepare } = require("./lib/configs-sandbox.cjs");
 *   const outDir = prepare("olua-bag-tidy");  // 沙箱目录名，各脚本取不同的名字互不干扰
 *   const { tidyBagGrid } = require(path.join(outDir, "configs/items.js"));
 *
 * tsc 自动探测（工程里不必装 typescript，Cocos 自带的就够用）：
 *   环境变量 TSC → 工程 node_modules → /Applications/Cocos/Creator/<版本>/…/typescript/bin/tsc
 * 手动指定：TSC=/path/to/tsc node client/tools/test-bag-tidy.cjs
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

//#region cc 垫片（只给 node 跑 configs 用：四个纯数据类，构造 + 读字段）

const CC_SHIM = `/**
 * cc 运行时垫片（由 client/tools/lib/configs-sandbox.cjs 生成，请勿手改）
 * assets/configs 只用 Vec2 / Vec3 / Size / Color 做数据构造，没有任何引擎行为，最小实现即可。
 * Color 要能吃 new Color(255,255,255) 与 new Color("#DDDDDD") 两种写法（配置表两种都用）。
 */
class Vec2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } }
class Vec3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } }
class Size { constructor(width = 0, height = 0) { this.width = width; this.height = height; } }
class Color {
  constructor(r = 255, g = 255, b = 255, a = 255) {
    if (typeof r === "string") { this.hex = r; this.r = 0; this.g = 0; this.b = 0; this.a = 255; return; }
    this.r = r; this.g = g; this.b = b; this.a = a;
  }
}
Color.WHITE = new Color(255, 255, 255, 255);
Color.BLACK = new Color(0, 0, 0, 255);
module.exports = { Vec2, Vec3, Size, Color };
`;

//#endregion

//#region 找 tsc

function findTsc() {
  const candidates = [process.env.TSC, path.join(PROJECT_ROOT, "node_modules/typescript/bin/tsc")];
  // Cocos Creator 各版本自带的 typescript
  for (const creatorRoot of ["/Applications/Cocos/Creator", "/Applications/CocosCreator"]) {
    if (!fs.existsSync(creatorRoot)) continue;
    for (const version of fs.readdirSync(creatorRoot)) {
      const base = path.join(creatorRoot, version, "CocosCreator.app/Contents/Resources/app.asar.unpacked/node_modules/typescript/bin");
      candidates.push(path.join(base, "tsc"), path.join(base, "tsc.js"));
    }
  }
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) ?? null;
}

//#endregion

/**
 * 编译配置表并返回产物目录（同一进程内重复调用同一名字会重建沙箱）
 * @param {string} sandboxName 沙箱目录名（os.tmpdir() 下），各脚本互不干扰
 * @param {string[]} [extraEntries] 额外要一起编译的配置入口（assets 下的相对路径，
 *   如 "configs/border.ts"——不依赖 items.ts 的配置文件，单测要用它就得单独列进来
 *   或 "ui/utils/layout/ScreenLayout.ts" 这类只依赖 cc 的纯逻辑模块）
 * @param {string} [ccExtra] 追加到 `cc` 垫片末尾的源码（例如补上 screen / view 让屏幕适配的纯函数可跑）
 * @returns {string} CommonJS 产物目录（里面有 configs/items.js 等）
 */
function prepare(sandboxName, extraEntries = [], ccExtra = "") {
  const tscPath = findTsc();
  if (!tscPath) {
    console.error("找不到 tsc：请在工程里装 typescript，或用环境变量指定，例如");
    console.error("  TSC=/Applications/Cocos/Creator/3.8.7/CocosCreator.app/Contents/Resources/app.asar.unpacked/node_modules/typescript/bin/tsc node client/tools/test-bag-tidy.cjs");
    throw new Error("缺少 tsc");
  }
  console.log(`tsc: ${tscPath}`);

  const sandbox = path.join(os.tmpdir(), sandboxName);
  const outDir = path.join(sandbox, "out");
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(path.join(sandbox, "node_modules/cc"), { recursive: true });
  fs.writeFileSync(path.join(sandbox, "node_modules/cc/index.js"), CC_SHIM + ccExtra);
  fs.writeFileSync(path.join(sandbox, "node_modules/cc/package.json"), JSON.stringify({ name: "cc", main: "index.js" }, null, 2));
  fs.writeFileSync(
    path.join(sandbox, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2019",
          module: "CommonJS",
          moduleResolution: "node",
          strict: false,
          skipLibCheck: true,
          esModuleInterop: true,
          experimentalDecorators: true,
          noEmitOnError: false,
          rootDir: path.join(PROJECT_ROOT, "assets"),
          outDir,
          baseUrl: PROJECT_ROOT,
          // 类型仍用工程自己的声明（只影响编译期），运行期走上面的垫片
          paths: { cc: [path.join(PROJECT_ROOT, "temp/declarations/cc.d.ts")] },
          types: [],
        },
        files: [
          path.join(PROJECT_ROOT, "assets/configs/items.ts"),
          ...extraEntries.map((entry) => path.join(PROJECT_ROOT, "assets", entry)),
        ],
      },
      null,
      2,
    ),
  );
  const result = spawnSync(process.execPath, [tscPath, "-p", path.join(sandbox, "tsconfig.json")], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(result.stdout || "");
    console.error(result.stderr || "");
    throw new Error(`配置表编译失败（tsc 退出码 ${result.status}）`);
  }
  hydrateSnapshotTables(outDir);
  return outDir;
}

/**
 * 把「#603 搬到服务端」的那几张表按线上同一条路灌进沙箱（装备 555 变体 + 战斗力权重）
 *
 * 客户端 `configs/equipments` / `configs/growth` / `configs/battle` 加载期都是**空表**
 * （数据在服务端 `equipment-seed.ts` / `combat-seed.ts`），但配置层单测一直把
 * 「这些表有值」当既有前提（背包回收、整理、对比、掉落名、更好装备提示…）。
 * 这些断言测的不是「快照有没有到」，而是规则本身 —— 所以 `prepare()` 编完就灌好：
 * 与进游戏后 `applyConfigSnapshot` 的最终状态同形。
 *
 * 用**真实种子 + 真实装载函数**而不是在测试里造数据：展开规则（5×3 档、rate 相乘、
 * 回收价取整）只有 `buildEquipmentMap` 一份，测试与线上算出来的一定是同一组数字。
 */
function hydrateSnapshotTables(outDir) {
  const has = (rel) => fs.existsSync(path.join(outDir, rel));
  // 新手引导步骤（#605）：客户端不再存这张表（服务端下发），单测里的步骤来自 guide-seed.ts。
  // 不灌就是空表 —— 而空表在客户端被当作「服务端把引导关了」，`guideStepCount()` 为 0，
  // 存档里的进度会被归一成「已完成」：引导相关断言会全部假绿。
  if (has("configs/guide.js")) {
    const guideSeed = require(compileServerShared("guide-seed.ts", "olua-seed-guide"));
    require(path.join(outDir, "configs/guide.js")).applyGuideSteps(guideSeed.GUIDE_STEP_SEEDS);
  }
  // #626 起快照各域的表与落库都在 `configs/game-config`，一个 require 就能全灌
  if (!has("configs/game-config.js")) return;
  const cfg = require(path.join(outDir, "configs/game-config.js"));

  // 任务（#603 第六域）：客户端只剩空数组，数据在 quest-seed.ts ——
  // 任务面板 / 可接判定 / NPC 头顶标记的断言都读这张表
  const questSeed = require(compileServerShared("quest-seed.ts", "olua-seed-quest"));
  cfg.questData.length = 0;
  questSeed.QUEST_SEED_ROWS.forEach((row) => cfg.questData.push(row));
  // 任务仓读的是 quests Map（由 questData 重建），不重建就是空表
  cfg.rebuildQuests();

  // 技能（#603 第十一域）：客户端只剩空数组 + 「职业 → 技能 id」的派生规则，
  // 数值在 skill-seed.ts —— 技能栏 / 快捷栏 / 技能弹窗 / 普攻距离判定的断言都读这张表。
  const skillSeed = require(compileServerShared("skill-seed.ts", "olua-seed-skill"));
  cfg.applySkillData(skillSeed.SKILL_SEED_ROWS);

  // 时装（#603 第十二域）：衣柜 / 取源规则 / 预载的断言都读 fashionData，
  // 数据在 fashion-seed.ts（种子形状 = 快照形状，直接走线上同一个 applyFashionData）
  const fashionSeed = require(compileServerShared("fashion-seed.ts", "olua-seed-fashion"));
  cfg.applyFashionData(fashionSeed.FASHION_SEED_ROWS);

  if (!has("configs/equipments.js")) return;

  const equipmentsMod = require(path.join(outDir, "configs/equipments.js"));
  const equipmentSeed = require(requireEquipmentSeed());

  // 战斗力权重（#603）：空表时 equipmentCombatValue 恒 0，「更好装备」提示会把所有候选判成不更好
  const combatSeed = require(compileServerShared("combat-seed.ts", "olua-seed-combat"));
  cfg.applyCombatWeights(combatSeed.COMBAT_WEIGHTS_SEED);

  // 顺序讲究：倍率先装（它决定展开档数，空数组一件都展开不出来），再装槽位与文案
  cfg.applyEquipmentRules(equipmentSeed.EQUIPMENT_PREFIX_RATE_SEEDS, equipmentSeed.EQUIPMENT_SUFFIX_RATE_SEEDS, equipmentSeed.EQUIPMENT_RECYCLE_CURVE_SEED);
  equipmentsMod.applyEquipmentQualityLabels(equipmentSeed.EQUIPMENT_PREFIX_LABEL_SEEDS, equipmentSeed.EQUIPMENT_SUFFIX_LABEL_SEEDS);
  // 槽位的 order 就是种子数组下标（与 equipment_slots.sort_order 的出厂值同源）
  equipmentsMod.applyEquipmentSlots(equipmentSeed.EQUIPMENT_SLOT_SEEDS.map((slot, order) => ({ ...slot, order })));

  const variants = equipmentsMod.applyEquipmentSeed(equipmentSeed.EQUIPMENT_SEED_ROWS);
  if (variants.length === 0) throw new Error("装备种子一件都没展开出来");

  // 药品 / 材料（#603 第十域）：客户端这两张表也是空的，数据在 item-seed.ts。
  // 单测里背包里装的药、掉落名、商城条目都按 id 查这张表 —— 不灌就是「查不到该物品」。
  const itemSeed = require(compileServerShared("item-seed.ts", "olua-seed-item"));
  cfg.applyDrugData(itemSeed.DRUG_SEED_ROWS);
  cfg.applyItemBaseData(itemSeed.ITEM_BASE_SEED_ROWS);
  // 总表按「装备 → 药品 → 材料」重建（顺序只有客户端这一份实现）
  require(path.join(outDir, "configs/items.js")).rebuildItemIndex();

  // 装备属性（#590）：种子不带八项属性（由 growth-seed.equipmentStats 公式算），展开出来的
  // 变体属性是 0 —— 这里按「公式 × 前后缀倍率」重算，与生成物 / 服务端 seed 同一来源。
  // items 总表与部位 Map 引用的是同一批对象，原地改一处即两边同步。
  const growthSeed = require(compileServerShared("growth-seed.ts", "olua-seed-growth"));
  const RANGE_KEYS = ["physicalAttack", "magicAttack", "taoistAttack", "physicalDefense", "magicDefense", "taoistDefense"];
  for (const map of [
    equipmentsMod.clothes,
    equipmentsMod.weapons,
    equipmentsMod.rings,
    equipmentsMod.nicklaces,
    equipmentsMod.shoes,
    equipmentsMod.helmets,
    equipmentsMod.belts,
  ]) {
    map.forEach((item) => {
      const stats = growthSeed.equipmentStats(Number(item.level) || 0, String(item.slot ?? ""));
      const rate = (cfg.equipmentPrefixRates[Number(item.prefix) || 0] ?? 1) * (cfg.equipmentSuffixRates[Number(item.suffix) || 0] ?? 1);
      item.maxHp = Math.round(stats.maxHp * rate);
      item.hpRecover = Math.round(stats.hpRecover * rate);
      for (const key of RANGE_KEYS) item[key] = [Math.round(stats[key][0] * rate), Math.round(stats[key][1] * rate)];
      // recyclePrice 由 buildEquipmentMap 按「曲线 × rate」算好（曲线已由 applyEquipmentRules 装进来），不动
    });
  }
}

/** 装备种子编译产物（进程内只编一次：单测常在一个进程里 prepare 两次） */
let equipmentSeedPath = null;

function requireEquipmentSeed() {
  if (!equipmentSeedPath) equipmentSeedPath = compileServerShared("equipment-seed.ts", "olua-seed-equipment");
  return equipmentSeedPath;
}

/** 取沙箱的 `cc` 垫片模块（ccExtra 里导出的可调状态在这里读改，例如屏幕尺寸/缩放） */
function loadCcShim(outDir) {
  // outDir = <sandbox>/out，垫片在 <sandbox>/node_modules/cc/index.js
  return require(path.join(path.dirname(outDir), "node_modules/cc/index.js"));
}

/**
 * 编译服务端 `server/src/shared` 下的纯数据源（如 monster-seed.ts）供单测真跑。
 * #588 起客户端没有怪物数值副本 —— 击杀目标 key、数值锚点等断言都改从种子取，
 * 用真实 expandMonsterSeed 展开而不是在测试里复刻一份公式。
 * @param {string} entry 相对 server/src/shared 的入口（如 "monster-seed.ts"）
 * @param {string} sandboxName 沙箱目录名，各脚本取不同名字互不干扰
 * @returns {string} 编译产物 JS 路径，直接 require
 */
function compileServerShared(entry, sandboxName) {
  const tscPath = findTsc();
  if (!tscPath) throw new Error("缺少 tsc（同 prepare 的要求）");
  const serverShared = path.resolve(PROJECT_ROOT, "..", "server", "src", "shared");
  const sandbox = path.join(os.tmpdir(), sandboxName);
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(sandbox, { recursive: true });
  fs.writeFileSync(
    path.join(sandbox, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2019",
          module: "CommonJS",
          moduleResolution: "node",
          strict: false,
          skipLibCheck: true,
          esModuleInterop: true,
          rootDir: serverShared,
          outDir: path.join(sandbox, "out"),
          types: [],
        },
        files: [path.join(serverShared, entry)],
      },
      null,
      2,
    ),
  );
  const result = spawnSync(process.execPath, [tscPath, "-p", path.join(sandbox, "tsconfig.json")], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(result.stdout || "");
    console.error(result.stderr || "");
    throw new Error(`服务端 shared 编译失败（${entry}，tsc 退出码 ${result.status}）`);
  }
  return path.join(sandbox, "out", entry.replace(/\.ts$/, ".js"));
}

/**
 * 把服务端种子灌进沙箱里的运行时表（#590）
 *
 * #590 起等级 / 称号 / 战魂 / 军衔在客户端是**空运行时表**（快照到达后整表重建），
 * 而单测的 Role / UI 消费方在进游戏语境里才被用到 —— 测试里要拿到与快照一致的表，
 * 就用真实种子（compileServerShared）当场展开灌进去，**不**在测试里复刻任何一行数据。
 *
 * @param {string} outDir prepare() / prepareStorage() 的产物目录
 * @returns {{ levelMap: Map<number, object>, titleLevels: object[], soulLevels: object[], rankLevels: object[] }}
 */
function seedRuntimeTables(outDir) {
  const growth = require(compileServerShared("growth-seed.ts", "olua-seed-growth"));

  // 快照行形状：六项区间是 {min,max} 对象（种子与 LEVEL_ATTRIBUTES 里是 [min,max] 元组）
  const range = (tuple) => ({ min: tuple[0], max: tuple[1] });
  const toRangeAttributes = (attributes) => ({
    maxHp: attributes.maxHp,
    hpRecover: attributes.hpRecover,
    physicalAttack: range(attributes.physicalAttack),
    magicAttack: range(attributes.magicAttack),
    taoistAttack: range(attributes.taoistAttack),
    physicalDefense: range(attributes.physicalDefense),
    magicDefense: range(attributes.magicDefense),
    taoistDefense: range(attributes.taoistDefense),
  });

  // #626 起四张表都在 `configs/game-config` 里，一个 require 全部拿到；
  // 产物里没有它说明这条测试链根本不消费这些表，直接返回 null（调用方各自按需断言）
  const has = (rel) => fs.existsSync(path.join(outDir, rel));
  if (!has("configs/game-config.js")) {
    return { levelMap: null, titleLevels: null, soulLevels: null, rankLevels: null };
  }
  const cfg = require(path.join(outDir, "configs/game-config.js"));

  cfg.applyLevelRows(
    Object.entries(growth.ROLE_LEVEL_ATTRIBUTES).map(([key, a]) => ({
      level: Number(key),
      maxHp: a.maxHp,
      maxMp: a.maxMp,
      hpRecover: a.hpRecover,
      physicalAttack: range(a.physicalAttack),
      magicAttack: range(a.magicAttack),
      taoistAttack: range(a.taoistAttack),
      physicalDefense: range(a.physicalDefense),
      magicDefense: range(a.magicDefense),
      taoistDefense: range(a.taoistDefense),
      exp: a.exp,
    })),
  );
  const titleSeed = require(compileServerShared("title-seed.ts", "olua-seed-title"));
  cfg.applyTitleRows(titleSeed.TITLE_SEEDS.map((row) => ({ ...row, attributes: toRangeAttributes(row.attributes) })));
  const soulSeed = require(compileServerShared("soul-seed.ts", "olua-seed-soul"));
  cfg.applySoulRows(soulSeed.SOUL_SEEDS.map((row) => ({ ...row, attributes: toRangeAttributes(row.attributes) })));
  const rankSeed = require(compileServerShared("rank-seed.ts", "olua-seed-rank"));
  cfg.applyRankRows(rankSeed.RANK_SEEDS.map((row) => ({ ...row, attributes: toRangeAttributes(row.attributes) })));

  // 装备（#603 第九域）**不在这里** —— 它不再是「快照到达后才有」，而是 prepare() 编完就
  // 按线上同一条路灌好的既存前提（见本文件顶部的 hydrateSnapshotTables）。这里只管四张
  // 「#590 起客户端零数据」的运行时表。

  return {
    levelMap: cfg.levelMap,
    titleLevels: cfg.titleLevels,
    soulLevels: cfg.soulLevels,
    rankLevels: cfg.rankLevels,
  };
}

//#region 断言小工具（各脚本共用，打印风格一致）

let failed = 0;

function check(ok, label, detail = "") {
  if (ok) console.log(`  [OK] ${label}${detail ? " —— " + detail : ""}`);
  else {
    failed++;
    console.log(`  [!!] ${label}${detail ? " —— " + detail : ""}`);
  }
}

/** 末尾统一收口：打印总结，有失败项时把退出码置 1 */
function finish(passMessage) {
  if (failed) {
    console.log(`\n!! 有 ${failed} 项断言不通过`);
    process.exitCode = 1;
    return false;
  }
  console.log(`\n${passMessage}`);
  return true;
}

/** 前置检查失败（例如找不到 tsc）时用：直接结束并置失败退出码 */
function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

//#endregion

module.exports = { PROJECT_ROOT, findTsc, prepare, loadCcShim, compileServerShared, hydrateSnapshotTables, seedRuntimeTables, check, finish, fail };
