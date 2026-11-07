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
          // 快照落库入口总是编：`hydrateSnapshotTables()` 要走线上同一条 `apply*` 链
          path.join(PROJECT_ROOT, "assets/configs/apply-snapshot.ts"),
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
 * 把出厂数据按**线上同一条路**灌进沙箱
 *
 * 客户端那几张表（装备变体 / 药品 / 材料 / 技能 / 时装 / 任务 / 引导 / 战力权重）
 * 加载期都是**空表** —— 数据进游戏后由 `GET /game-config` 送下来。单测一直把「这些表有值」
 * 当既有前提（背包回收、整理、对比、掉落名、更好装备提示…），而它们测的不是「快照有没有到」，
 * 是规则本身，所以 `prepare()` 编完就灌好：与进游戏后 `applyConfigSnapshot` 的最终状态同形。
 *
 * #655 起数据只有一处权威 = 数据库，仓库里的逐行投影就是 `server/data/config-sync.sql`
 * （`factory-data.cjs` 把它读成快照 DTO 形状）。所以这里**不再编服务端种子**，
 * 调用的 `applyContentSnapshot` / `applySkillSnapshot` / `applyEquipments` 也与线上同一份实现。
 */
function hydrateSnapshotTables(outDir) {
  const has = (rel) => fs.existsSync(path.join(outDir, rel));
  const factory = require("./factory-data.cjs");
  // 新手引导步骤（#605）：客户端不再存这张表（服务端下发）
  // 不灌就是空表 —— 而空表在客户端被当作「服务端把引导关了」，`guideStepCount()` 为 0，
  // 存档里的进度会被归一成「已完成」：引导相关断言会全部假绿。
  if (has("configs/guide.js")) {
    require(path.join(outDir, "configs/guide.js")).applyGuideSteps(factory.guideSteps());
  }
  // #626 起快照各域的表与落库都在 `configs/game-config`，一个 require 就能全灌
  if (!has("configs/game-config.js") || !has("configs/apply-snapshot.js")) return;
  const cfg = require(path.join(outDir, "configs/game-config.js"));
  const snap = require(path.join(outDir, "configs/apply-snapshot.js"));

  // 技能 / 状态：线上 `applySkillSnapshot` 那一段
  snap.applySkillSnapshot({ skills: factory.skills(), statuses: factory.statuses() });

  if (!has("configs/equipments.js")) return;

  // 战斗力权重（#603）：空表时 equipmentCombatValue 恒 0，「更好装备」提示会把所有候选判成不更好
  cfg.applyCombatWeights(factory.combatWeights());
  // 顺序讲究：倍率先装（它决定展开档数；空数组一件都展开不出来），再装槽位与文案
  const meta = factory.equipmentMeta();
  const equipmentsMod = require(path.join(outDir, "configs/equipments.js"));
  cfg.applyEquipmentRules(meta.prefixRates, meta.suffixRates);
  // 颜色也走线上同一条路（#724 起客户端无内置色，不灌就是空表 = 不染色）
  equipmentsMod.applyEquipmentQualityLabels(meta.prefixLabels, meta.suffixLabels, meta.prefixColors, meta.suffixColors);
  equipmentsMod.applyEquipmentSlots(factory.equipmentSlots());

  // 内容表一次落完（装备 → 药品 → 货币 → 卷轴 → 材料 → 怪物 → NPC → 任务 → 时装），末尾自带 rebuildItemIndex
  snap.applyContentSnapshot({
    equipments: factory.equipmentVariants(),
    drugs: factory.drugs(),
    moneyItems: factory.moneyItems(),
    levelScrolls: factory.levelScrolls(),
    items: factory.items(),
    monsters: factory.monsters(),
    monsterPresentations: factory.monsterPresentations(),
    npcs: factory.npcs(),
    quests: factory.quests(),
    fashions: factory.fashions(),
  });
}

/** 取沙箱的 `cc` 垫片模块（ccExtra 里导出的可调状态在这里读改，例如屏幕尺寸/缩放） */
function loadCcShim(outDir) {
  // outDir = <sandbox>/out，垫片在 <sandbox>/node_modules/cc/index.js
  return require(path.join(path.dirname(outDir), "node_modules/cc/index.js"));
}

/**
 * 把出厂数据灌进沙箱里的运行时表（#590 / #655）
 *
 * 等级 / 称号 / 战魂 / 军衔在客户端是**空运行时表**（快照到达后整表重建），而单测的
 * Role / UI 消费方在进游戏语境里才被用到 —— 测试里要拿到与快照一致的表，就按线上
 * 同一条路灌：数据来自 `server/data/config-sync.sql`（`factory-data.cjs` 读成 DTO 形状），
 * 落库走 `applyGrowthSnapshot` / `apply*Rows` 这些真实实现，**不在测试里复刻任何一行数据**。
 *
 * @param {string} outDir prepare() / prepareStorage() 的产物目录
 * @returns {{ levelMap: Map<number, object>, titleLevels: object[], soulLevels: object[], rankLevels: object[] }}
 */
function seedRuntimeTables(outDir) {
  // #626 起四张表都在 `configs/game-config` 里，一个 require 全部拿到；
  // 产物里没有它说明这条测试链根本不消费这些表，直接返回 null（调用方各自按需断言）
  const has = (rel) => fs.existsSync(path.join(outDir, rel));
  if (!has("configs/game-config.js")) {
    return { levelConfigOf: null, levelCurves: null, titleLevels: null, soulLevels: null, rankLevels: null };
  }
  const factory = require("./factory-data.cjs");
  const cfg = require(path.join(outDir, "configs/game-config.js"));

  require(path.join(outDir, "configs/apply-snapshot.js")).applyGrowthSnapshot({
    growthScalars: Object.entries(factory.growthScalars()).map(([key, value]) => ({ key, value })),
    levelCurves: factory.levelCurves(),
  });
  cfg.applyTitleRows(factory.titles());
  cfg.applySoulRows(factory.souls());
  cfg.applyRankRows(factory.ranks());

  // 装备（#603 第九域）**不在这里** —— 它不再是「快照到达后才有」，而是 prepare() 编完就
  // 按线上同一条路灌好的既存前提（见本文件顶部的 hydrateSnapshotTables）。这里只管四张
  // 「#590 起客户端零数据」的运行时表。

  return {
    levelConfigOf: cfg.levelConfigOf,
    levelCurves: cfg.levelCurves,
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

module.exports = { PROJECT_ROOT, findTsc, prepare, loadCcShim, hydrateSnapshotTables, seedRuntimeTables, check, finish, fail };
