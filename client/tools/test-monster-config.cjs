#!/usr/bin/env node
/**
 * 怪物配置单测（client/tools/test-monster-config.cjs）
 *
 * 盯的不变量（改 configs/monster / gen-monster-config.cjs 后必须全绿）：
 * · 220 只怪条目齐全，且**每只都有实测几何**：contentSize > 0（历史上 5~220 号全是 new Size()
 *   即 0×0 → 碰撞盒为 0、怪物点不中、血条贴在中心）、outOffset 与素材 trim 反向偏移一致
 *   —— 几何断言直接重读素材 .meta 的 auto-trim 数据全量复核（生成器与引擎同一数据源）；
 * · 动作速度：运行时每只怪的 speedRate 都是**完整 11 个动作**且 >0（条目不写时由
 *   monsterDefaultSpeedRate 打底合成，见 configs/monster 尾部的合并式）；
 * · 主动怪规则：tier=boss 或身体宽 ≥ 阈值（与生成器头部常量一致），普通小体型怪不误判；
 * · 出售价规则：normal = level×2 / elite = level×5 / boss = level×20；
 * · 老怪行为不回退：1~4 号 moveSpeed 2 / detectRange 200 / stand 速度 1；
 * · 资源在位：每只怪的 icon 与 out 素材目录、基准帧 meta 都真实存在；
 * · 接线：createMonsterBody 消费 outOffset（不接的话偏移字段是死的，身体中心回不到原点）。
 *
 * 数据层跑在沙箱里（真实的 configs/monster + growth + drop，见 lib/configs-sandbox.cjs），素材与源码断言直接读文件。
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish } = require("./lib/configs-sandbox.cjs");

const outDir = prepare("olua-monster-config", ["configs/monster.ts"]);
const { monsters, monsterDefaultSpeedRate } = require(path.join(outDir, "configs/monster.js"));

const MONSTER_SRC = fs.readFileSync(path.join(PROJECT_ROOT, "assets/configs/monster.ts"), "utf8");
const HELPER_SRC = fs.readFileSync(path.join(PROJECT_ROOT, "assets/ui/helpers/GameUiHelper.ts"), "utf8");
const TYPE_SRC = fs.readFileSync(path.join(PROJECT_ROOT, "assets/types/monster.ts"), "utf8");
const GEN_SRC = fs.readFileSync(path.join(PROJECT_ROOT, "tools/gen-monster-config.cjs"), "utf8");
const OUT_RES = path.join(PROJECT_ROOT, "assets/resources/monster/out");

/** 主动怪的身体宽阈值（与 gen-monster-config.cjs 头部的 AGGRESSIVE_BODY_WIDTH 同源，改一处要同步另一处） */
const AGGRESSIVE_BODY_WIDTH = 250;
/** 几何基准帧：stand·正面·第 1 帧（与生成器一致） */
const STAND_DOWN_FRAME = 40;
/** 动作全集（ACTION 枚举的**值**，运行时 speedRate 的键就是它们） */
const ACTION_KEYS = ["stand", "walk", "run", "attack_near", "attack_skill_1", "test3", "attack_far", "injured", "a1", "die", "test1"];

/** tier 不进运行时对象（MonsterConfig 无此字段，只在条目里供 monsterStats 定级）→ 从生成后的源码里解析 */
function readTiers() {
  const tiers = new Map();
  const blocks = MONSTER_SRC.slice(MONSTER_SRC.indexOf("const monsterData"), MONSTER_SRC.indexOf("\n];", MONSTER_SRC.indexOf("const monsterData"))).split(/\n  \{/).slice(1);
  for (const block of blocks) {
    const key = /key:\s*"([^"]+)"/.exec(block);
    if (!key) continue;
    const tier = /tier:\s*"(\w+)"/.exec(block);
    tiers.set(key[1], tier ? tier[1] : "normal");
  }
  return tiers;
}
const tierByKey = readTiers();

/** 重读某只怪基准帧 meta 的 auto-trim 数据（生成器与引擎同一数据源，这里独立复核） */
function readTrim(key) {
  const metaPath = path.join(OUT_RES, key, `${String(STAND_DOWN_FRAME).padStart(5, "0")}.png.meta`);
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  const sfMeta = Object.values(meta.subMetas).find((sub) => sub.importer === "sprite-frame");
  return sfMeta.userData;
}

const all = [...monsters.values()];
const keys = [...monsters.keys()].sort((a, b) => Number(a) - Number(b));

//#region A. 数据行为

check(keys.length === 220 && keys.every((key, index) => key === String(index + 1)), "220 只怪条目齐全且 key 连续（1~220）", `实得 ${keys.length} 条`);

check(
  all.every((m) => m.contentSize.width > 0 && m.contentSize.height > 0),
  "每只怪 contentSize 都有实测值（宽高 > 0，不再有 new Size() 空 占位）",
);

const geoMismatch = [];
for (const [key, m] of monsters) {
  const trim = readTrim(key);
  if (m.contentSize.width !== trim.width || m.contentSize.height !== trim.height) geoMismatch.push(`${key}:size`);
  if (m.outOffset.x !== -trim.offsetX || m.outOffset.y !== -trim.offsetY) geoMismatch.push(`${key}:offset`);
}
check(geoMismatch.length === 0, "contentSize / outOffset 与素材 .meta 的 auto-trim 全量一致", geoMismatch.slice(0, 5).join(", ") || "220/220");

check(
  all.every((m) => {
    const values = ACTION_KEYS.map((action) => m.speedRate[action]);
    return values.length === ACTION_KEYS.length && values.every((value) => typeof value === "number" && value > 0);
  }),
  "运行时每只怪 speedRate 都是完整 11 个动作且 >0（默认表打底合成）",
);
check(
  ACTION_KEYS.every((action) => typeof monsterDefaultSpeedRate[action] === "number" && monsterDefaultSpeedRate[action] > 0),
  "monsterDefaultSpeedRate 覆盖全部 11 个动作",
);

const ruleBroken = [...monsters].filter(([key, m]) => m.aggressive !== (tierByKey.get(key) === "boss" || m.contentSize.width >= AGGRESSIVE_BODY_WIDTH));
check(ruleBroken.length === 0, `主动怪规则一致（boss 或身体宽 ≥ ${AGGRESSIVE_BODY_WIDTH}px）`, ruleBroken.map(([key]) => key).slice(0, 5).join(","));
check([...monsters.values()].filter((m) => m.aggressive).length > 0 && all.filter((m) => !m.aggressive).length > 0, "主动 / 被动两类都有（规则真的铺开了）", `主动 ${[...monsters.values()].filter((m) => m.aggressive).length}/220`);

const pricePerLevel = { normal: 2, elite: 5, boss: 20 };
const priceBroken = [...monsters].filter(([key, m]) => m.sellPirce !== m.level * pricePerLevel[tierByKey.get(key)]);
check(priceBroken.length === 0, "出售价规则一致（normal×2 / elite×5 / boss×20）", priceBroken.map(([key]) => key).slice(0, 5).join(","));

check(
  [1, 2, 3, 4].every((index) => {
    const m = monsters.get(String(index));
    return m && m.moveSpeed === 2 && m.detectRange === 200 && m.speedRate.stand === 1 && m.speedRate.walk === 1;
  }),
  "1~4 号老怪行为不回退（速度 2 / 检测 200 / 待机走动 1 秒循环）",
);

const resMissing = [];
for (const [key, m] of monsters) {
  if (!fs.existsSync(path.join(OUT_RES, key, `${String(STAND_DOWN_FRAME).padStart(5, "0")}.png`))) resMissing.push(`${key}:帧`);
  if (!fs.existsSync(path.join(PROJECT_ROOT, "assets/resources", `${m.icon}.png`))) resMissing.push(`${key}:icon`);
}
check(resMissing.length === 0, "每只怪的基准帧与 icon 资源都在磁盘上", resMissing.slice(0, 5).join(", "));

//#endregion

//#region B. 接线（源码断言）

check(/speedRate:\s*\{\s*\.\.\.monsterDefaultSpeedRate,\s*\.\.\.data\.speedRate\s*\}/.test(MONSTER_SRC), "configs/monster 建表时默认速度打底 + 条目覆盖合并");
check(/animationNode\.setPosition\(monster\.outOffset\.x,\s*monster\.outOffset\.y,\s*0\)/.test(HELPER_SRC), "createMonsterBody 消费 outOffset（身体中心对准节点原点）");
check(/speedRate\?:\s*Partial<SpeedRate>/.test(TYPE_SRC), "MonsterData.speedRate 允许只写覆盖动作");
check(/speedRate:\s*SpeedRate;/.test(TYPE_SRC), "MonsterConfig.speedRate 必填（运行时合成后完整）");
check(/const AGGRESSIVE_BODY_WIDTH = 250;/.test(GEN_SRC) && `AGGRESSIVE_BODY_WIDTH = ${AGGRESSIVE_BODY_WIDTH}` && /const AGGRESSIVE_BODY_WIDTH = 250;/.test(GEN_SRC), "生成器阈值与测试同源（250）");
check(/const STAND_DOWN_FRAME = 40;/.test(GEN_SRC), "生成器几何基准帧 = stand·正面·第 1 帧");

//#endregion

finish("PASS：怪物 220 条配置（几何实测 / 动作速度 / 主动怪与出售价规则 / 资源在位 / 接线）全部通过");
