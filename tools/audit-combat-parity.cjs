#!/usr/bin/env node
/**
 * 守卫：服务端的角色属性汇总是否与客户端 `combatCalc` 算出同一份结果
 *
 * ===========================================================================
 * 为什么必须有这个
 * ===========================================================================
 * `audit-battle-rules.cjs` 只守住了「**数据**没漂移」，守不住「**算法**写得对不对」：
 * 表一模一样，也可能有人在服务端把 `maxHp` 忘了加装备、把战斗力的区间属性取了平均、
 * 或者把战魂的等级当成下标 —— 这些都会让两端静默地算出不同结果。
 *
 * 而这一类偏差的表现不是报错，是「玩家觉得怪变难打了」。所以要锁死的是**结果**，
 * 不是某一个字段。
 *
 * ===========================================================================
 * 期望值从哪来（这里最容易自欺）
 * ===========================================================================
 * 最硬的做法是**直接跑客户端那份真的算子**：把 `GameHelper.combatCalc` 编译进 Node
 * （cc 垫片 + `StorageManager` 打桩），输入一组角色，拿它算出来的数当期望值。
 *
 * 如果这条脚本自己再写一版「我以为客户端怎么算」，那它守的只是自己的理解，
 * 客户端一改这里照样全绿 —— 那种测试比没有更糟，因为它给人安全感。
 *
 * ===========================================================================
 * 覆盖范围
 * ===========================================================================
 * - 全部角色等级（裸装）
 * - 全部战魂 / 称号 / 军衔等级（单独变动）
 * - 全部装备：一件一件地穿（555 件）
 * - 多槽位穿戴 + 伪随机组合（固定种子 → 可复现）
 * - 未知装备 id：两端都跳过，且服务端要有明确记录（不是静默）
 *
 * 用法：node tools/audit-combat-parity.cjs
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const ASSETS = path.join(ROOT, "client", "assets");
const SERVER_SRC = path.join(ROOT, "server", "src");
const TSC = path.join(ROOT, "server", "node_modules", ".bin", "tsc");

/** 固定的随机种子（要为的是「跑一万次结果一样」，不是看起来随机） */
const RANDOM_SEED = 20261010;
/** 伪随机组合的组数 */
const RANDOM_CASES = 2000;
/** 逐项比对的字段（区间属性要连两个分量一起比） */
const COMPARE_KEYS = ["maxHp", "hpRecover", "maxMp", "physicalAttack", "magicAttack", "taoistAttack", "physicalDefense", "magicDefense", "taoistDefense", "combat"];

function main() {
  if (!fs.existsSync(TSC)) fail(`找不到 tsc：${TSC}（先在 server/ 下装依赖）`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "olua-parity-"));
  try {
    writeCcShim(work);
    const client = loadClient(work);
    const server = loadServer(work);

    const cases = buildCases(client, server);
    let comparisons = 0;
    for (const testCase of cases) comparisons += compare(client, server, testCase);

    // 计数与打印分开记：只打印前几处（避免刷屏），但**计数必须是全量**，
    // 否则工作报告里说「3 组不一致」，实际有可能是几千组 —— 那句话本身就在误导
    if (mismatchCount > 0) {
      fail(`战斗属性两端不一致：${mismatchCount} 项算出不同结果（${cases.length} 组输入，共比对 ${comparisons} 项）\n  服务端这份必须与客户端 combatCalc 一致 —— 改哪一端的算法都行，但两边必须相等`);
    }
    checkEdgeCases(server);

    console.log(`✔ 角色属性两端一致（${cases.length} 组输入 × ${COMPARE_KEYS.length} 项 = ${comparisons} 次比对，随机种子 ${RANDOM_SEED}）`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

//#region 加载两端

/**
 * 编译并加载客户端那一份真的 combatCalc
 *
 * cc 用垫片顶住、`StorageManager` 直接打桩：这两个都不是 combatCalc 要用到的东西，
 * 只是 `GameHelper.ts` 里**别的**方法带来的 require 链。让它们进来只会越陷越深，
 * 打桩比一层层垫真实得多 —— 反正期望值只关心 combatCalc 那条路径。
 */
function loadClient(work) {
  const outdir = path.join(work, "client-out");
  const tsconfig = path.join(work, "client-tsconfig.json");
  fs.writeFileSync(
    tsconfig,
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "CommonJS",
          moduleResolution: "node",
          outDir: outdir,
          rootDir: ASSETS,
          skipLibCheck: true,
          esModuleInterop: true,
          strict: false,
          noEmitOnError: false,
        },
        files: [path.join(ASSETS, "ui", "core", "GameHelper.ts")],
      },
      null,
      2,
    ),
    "utf8",
  );
  runTsc(tsconfig, "客户端 GameHelper");

  const storageManagerPath = path.join(outdir, "ui", "core", "StorageManager.js");
  require.cache[storageManagerPath] = {
    id: storageManagerPath,
    filename: storageManagerPath,
    loaded: true,
    exports: { findOnlineRole: () => null, findRole: () => null },
    children: [],
    paths: [],
  };

  const mod = require(path.join(outdir, "ui", "core", "GameHelper.js"));
  const GameHelper = mod.default ?? mod;
  if (typeof GameHelper.combatCalc !== "function") fail("没拿到客户端 combatCalc（GameHelper 的导出变了？）");

  // 装备候选直接取服务端生成物的键：那本来就是「展开后的物品 id」，与客户端同一口径
  const equipmentTypes = require(path.join(outdir, "types", "good.js"));
  // 用 bind 而不是直接取函数：combatCalc 内部走 this.twoAttributesCalc，脱离类就散了
  return { combatCalc: GameHelper.combatCalc.bind(GameHelper), equipmentTypes };
}

/** 编译并加载服务端这份汇总函数 */
function loadServer(work) {
  const outdir = path.join(work, "server-out");
  const tsconfig = path.join(work, "server-tsconfig.json");
  fs.writeFileSync(
    tsconfig,
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "CommonJS",
          moduleResolution: "node",
          outDir: outdir,
          rootDir: SERVER_SRC,
          skipLibCheck: true,
          esModuleInterop: true,
          strict: false,
          noEmitOnError: false,
        },
        files: [path.join(SERVER_SRC, "modules", "combat", "role-attributes.ts")],
      },
      null,
      2,
    ),
    "utf8",
  );
  runTsc(tsconfig, "服务端 role-attributes");

  const combat = require(path.join(outdir, "modules", "combat", "role-attributes.js"));
  const generated = require(path.join(outdir, "modules", "combat", "battle-rules.generated.js"));
  return {
    summarizeRoleAttributes: combat.summarizeRoleAttributes,
    summarizeRoleAttributesWithNotes: combat.summarizeRoleAttributesWithNotes,
    // 键本来就是「展开后的物品 id」，与客户端 getEquipment 同一口径 —— 直接拿来当候选集
    equipmentIds: Object.keys(generated.EQUIPMENT_ATTRIBUTES),
  };
}

/**
 * 跑 tsc
 *
 * 这里**不能**用「有没有 error TS」来判断成败：这个临时编译单元里没有 Cocos 的类型，
 * 于是 `Cannot find module 'cc'`（TS2307）会连带派生出一堆 TS2xxx（属性不存在、类型
 * 不匹配…）—— 它们全是缺类型的**后果**，不是源码的错误，JS 产物照样是对的。
 *
 * 所以只看 TS1xxx（语法）与 TS5xxx（配置）：那两类错了才真的没产物、或产物是坏的。
 * 语义层面的把关另有其人 —— 客户端有 `client/tools/tsconfig.check.json`、
 * 服务端有 `tsc --noEmit`，两个都在真类型环境下跑，没必要在这里重复一遍。
 */
function runTsc(tsconfig, label) {
  let log = "";
  try {
    log = execFileSync(TSC, ["-p", tsconfig], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    log = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  const fatal = log
    .split("\n")
    .map((line) => /error TS(\d+)/.exec(line))
    .filter((matched) => matched !== null)
    // TS1xxx = 语法，TS5xxx = 配置；两者之外的（绝大多数 TS2xxx）只是缺 cc 类型的连带告警
    .filter(([, code]) => code.startsWith("1") || code.startsWith("5"));
  if (fatal.length > 0) fail(`编译${label}失败：\n${log.split("\n").slice(0, 3).join("\n")}`);
}

//#endregion

//#region 输入集

function buildCases(client, server) {
  const cases = [];
  const push = (label, role) => cases.push({ label, role });

  // ① 全等级裸装
  for (let level = 1; level <= 60; level++) push(`等级 ${level} 裸装`, makeRole(level, {}, 0, 0, 0));

  // ② 三个等级型来源各自单独变动，全遍历 —— 一次性验证「下标和等级」没搞反
  for (let soul = 0; soul <= 40; soul++) push(`等级 30 + 战魂 ${soul}`, makeRole(30, {}, soul, 0, 0));
  for (let title = 0; title <= 40; title++) push(`等级 30 + 称号 ${title}`, makeRole(30, {}, 0, title, 0));
  for (let rank = 0; rank <= 110; rank++) push(`等级 30 + 军衔 ${rank}`, makeRole(30, {}, 0, 0, rank));

  // ③ 全装备一件一件地穿（含前后缀变体）
  const ids = server.equipmentIds;
  const slot = equipmentSlot(client);
  for (const id of ids) push(`等级 30 + 单穿 ${id}`, makeRole(30, { [slot]: id }, 0, 0, 0));

  // ④ 多个槽位一起穿（取相邻的一批 id，尽量凑出真实的多件组合）
  const slots = equipmentSlots(client);
  for (let index = 0; index < 40; index++) {
    const equipments = {};
    slots.forEach((name, offset) => {
      equipments[name] = ids[(index * 7 + offset * 13) % ids.length];
    });
    push(`等级 ${(index % 60) + 1} + 满槽位第 ${index} 组`, makeRole((index % 60) + 1, equipments, index % 38, index % 35, index % 101));
  }

  // ⑤ 伪随机组合（固定种子）
  const random = mulberry32(RANDOM_SEED);
  for (let index = 0; index < RANDOM_CASES; index++) {
    const equipments = {};
    slots.forEach((name) => {
      if (random() < 0.55) equipments[name] = ids[Math.floor(random() * ids.length)];
    });
    push(`随机组合 #${index}`, makeRole(1 + Math.floor(random() * 60), equipments, Math.floor(random() * 41), Math.floor(random() * 41), Math.floor(random() * 111)));
  }

  // ⑥ 查不到的装备 id：两端都应跳过（数值与空槽位一致）
  push("等级 30 + 未知装备 id", makeRole(30, { [slot]: "not_a_real_equipment" }, 0, 0, 0));

  return cases;
}

function makeRole(level, equipments, soulOfWar, title, rank) {
  return { level, equipments: { ...equipments }, soulOfWar, title, rank };
}

function equipmentSlot(client) {
  return equipmentSlots(client)[0];
}

function equipmentSlots(client) {
  const values = Object.values(client.equipmentTypes.EQUIPMENT_TYPE ?? {}).filter((value) => typeof value === "string");
  if (values.length === 0) fail("没取到客户端 EQUIPMENT_TYPE（types/good 改了？）");
  return values;
}

//#endregion

//#region 比对

/** 累计的不一致项数（全量计，与打印了几处无关） */
let mismatchCount = 0;
/** 已经打印的不一致条数（超过 MAX_MISMATCH_DETAILS 就不再刷屏） */
let printed = 0;
const MAX_MISMATCH_DETAILS = 3;

function compare(client, server, testCase) {
  // 客户端那版会直接写回传入对象，所以每组用例都要给它一份干净的副本
  const expectedRole = client.combatCalc({ ...testCase.role, equipments: { ...testCase.role.equipments } });
  const actual = server.summarizeRoleAttributes(testCase.role);
  if (!actual) {
    mismatchCount++;
    if (printed < MAX_MISMATCH_DETAILS) showMismatch({ label: testCase.label, key: "*", expected: "有结果", actual: "null（服务端认为算不出）" }, printed++);
    return COMPARE_KEYS.length;
  }

  for (const key of COMPARE_KEYS) {
    if (sameValue(expectedRole[key], actual[key])) continue;
    mismatchCount++;
    if (printed < MAX_MISMATCH_DETAILS) showMismatch({ label: testCase.label, key, expected: expectedRole[key], actual: actual[key] }, printed++);
  }
  return COMPARE_KEYS.length;
}

function sameValue(expected, actual) {
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return false;
    if (expected.length !== actual.length) return false;
    return expected.every((value, index) => value === actual[index]);
  }
  return expected === actual;
}

function showMismatch(detail, index) {
  if (index === 0) console.error("\n✗ 战斗属性两端不一致，前几处：");
  console.error(`  ${detail.label}：${detail.key} 期望 ${JSON.stringify(detail.expected)}，实际 ${JSON.stringify(detail.actual)}`);
}

/**
 * 边界情形：这些不属于「和客户端比对」，属于服务端自己的契约
 *
 * 客户端在等级查不到时是「原样返回」（等于没重算），服务端没有旧值可用，必须返回 null
 * —— 给 0 会被读成「算过了，结果就是 0」，那是完全不同的意思。
 */
function checkEdgeCases(server) {
  const missing = server.summarizeRoleAttributes({ level: 9999 });
  if (missing !== null) fail("等级曲线里没有的等级，服务端应当返回 null（静默给 0 会被当成「算过了」）");

  const noted = server.summarizeRoleAttributesWithNotes({ level: 30, equipments: { WEAPON: "not_a_real_equipment" } });
  if (noted.notes.unknownEquipmentIds.length !== 1) {
    fail("查不到的装备 id 应当被记进 notes（不然属性悄悄少一截，表面上看不出来）");
  }
  const valid = server.summarizeRoleAttributesWithNotes({ level: 30, equipments: { WEAPON: null } });
  if (valid.notes.unknownEquipmentIds.length !== 0) fail("空槽位不该被当成未知装备");
}

//#endregion

/** 固定种子的伪随机（要让「跑多少次都一样」，别用 Math.random） */
function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 最小 Cocos 垫片：任何没提供的 API 都返回一个万能替身
 *
 * combatCalc 根本不碰引擎，垫的是依赖链上**别的方法**碰到的东西（例如
 * `sys.Feature.EVENT_MOUSE`）。用替身兜住整棵树，比一个一个补强。
 */
function writeCcShim(work) {
  const shimDir = path.join(work, "client-out", "node_modules", "cc");
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(path.join(shimDir, "package.json"), '{"name":"cc","version":"0.0.0","main":"index.js"}', "utf8");
  fs.writeFileSync(
    path.join(shimDir, "index.js"),
    `"use strict";
const cache = new Map();
function any(name) {
  if (!cache.has(name)) {
    const fn = function () { return any(name + "()"); };
    cache.set(name, new Proxy(fn, {
      get(target, prop) {
        if (prop === "__esModule") return undefined;
        if (prop === "then") return undefined;
        if (prop === Symbol.toPrimitive) return () => 0;
        if (prop === "toString" || prop === "valueOf") return () => name;
        if (prop in target) return target[prop];
        return any(name + "." + String(prop));
      },
      set() { return true; },
      has() { return true; },
      apply() { return any(name + "()"); },
      construct() { return any("new " + name + "()"); },
    }));
  }
  return cache.get(name);
}
const deep = (own, prefix) => new Proxy(own, {
  get(target, prop) {
    if (prop in target) return target[prop];
    return any(prefix + String(prop));
  },
  has() { return true; },
});
const sys = deep({
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
  platform: 0, os: "", isNative: false, isMobile: false, isBrowser: true, hasFeature: () => true,
}, "sys.");
const base = {
  Color: class Color { constructor(v) { this.value = v; } },
  Vec2: class Vec2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } },
  Vec3: class Vec3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } },
  Size: class Size { constructor(w = 0, h = 0) { this.width = w; this.height = h; } },
  v2: (x = 0, y = 0) => ({ x, y }),
  v3: (x = 0, y = 0, z = 0) => ({ x, y, z }),
  color: (v) => v,
  math: { clamp: (v, a, b) => Math.min(Math.max(v, a), b), lerp: (a, b, t) => a + (b - a) * t, randomRangeInt: (a) => a, random: () => 0 },
  sys,
  director: deep({ getScene: () => null, loadScene: () => {} }, "director."),
  log: () => {}, warn: () => {}, error: () => {},
  instantiate: (x) => x,
  resources: { load: () => {}, loadDir: () => {} },
  isValid: (v) => v !== null && v !== undefined,
};
module.exports = deep(base, "cc.");
`,
    "utf8",
  );
}

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

main();
