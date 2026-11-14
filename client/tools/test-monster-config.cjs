#!/usr/bin/env node
/**
 * 怪物配置单测（client/tools/test-monster-config.cjs）
 *
 * #588 起客户端没有怪物数据文件 —— 本测盯的新不变量（改 gen-monster-config.cjs /
 * monster-seed.ts / monsterRuntime.ts 后必须全绿）：
 * · 快照的 monster_presentation 220 行齐全，且**每只都有实测几何**：
 *   contentSize > 0、outOffset 与图集基准帧 trim 反向偏移一致（直接重读 plist 独立复核，
 *   生成器与引擎同一数据源）；
 * · key 双向对账：资源行（monster_presentation）与数值行（monsters）一一对应（生成器断言，这里复核）；
 * · 动作速度：经 applyMonsterPresentation 落运行时表后，每只怪 speedRate 都是**完整 11 个动作**
 *   且 >0（快照覆盖与 monsterDefaultSpeedRate 在落表时合成）；
 * · 主动怪取值：每只怪都有明确的布尔值，且快照里至少有一只主动（#751 起「谁主动」归运营，
 *   生成器只按体型 / tier 打印建议、不写库 —— 所以不再断言快照符合体型规则）；
 * · 老怪行为不回退：1~4 号 moveSpeed 2 / detectRange 200 / stand 速度 1；
 * · 资源在位：每只怪的 icon 与 out 图集都真实存在；
 * · 接线：createMonsterBody 消费 outOffset；运行时表消费方不再 import configs/game-config 的怪物 Map
 *   （那个 Map 已经不存在，谁抄旧代码谁编译红 —— 这里再钉一道源码断言）。
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish } = require("./lib/configs-sandbox.cjs");

const outDir = prepare("olua-monster-config", ["configs/game-config.ts", "configs/game-config.ts"]);
const { monsterResource, applyMonsterPresentation } = require(path.join(outDir, "configs/game-config.js"));
const { monsterDefaultSpeedRate } = require(path.join(outDir, "configs/game-config.js"));

/** #655 起怪物数值与表现都是库里的行（快照 = server/data/config-sync.sql） */
const factory = require("./lib/factory-data.cjs");
const HELPER_SRC = fs.readFileSync(path.join(PROJECT_ROOT, "assets/ui/helpers/GameUiHelper.ts"), "utf8");
const GEN_SRC = fs.readFileSync(path.join(PROJECT_ROOT, "tools/gen-monster-config.cjs"), "utf8");
const RUNTIME_SRC = fs.readFileSync(path.join(PROJECT_ROOT, "assets/configs/game-config.ts"), "utf8");
const OUT_RES = path.join(PROJECT_ROOT, "assets/resources/monster/out");

/** 几何基准帧（与生成器一致）：图集 stand 是 8 向 × 4 帧，方向 4 = 正面第 0 帧 */
const STAND_BASE_FRAME = "d4_00.png";
/** 动作全集（ACTION 枚举的**值**，运行时 speedRate 的键就是它们） */
const ACTION_KEYS = ["stand", "walk", "run", "attack_near", "attack_skill_1", "test3", "attack_far", "injured", "a1", "die", "test1"];

/** 重读某只怪基准帧的图集 trim 数据（生成器与引擎同一数据源，这里独立复核） */
function readTrim(key) {
  const plistPath = path.join(OUT_RES, key, "stand", "stand.plist");
  const plist = fs.readFileSync(plistPath, "utf8");
  const i = plist.indexOf(`<key>${STAND_BASE_FRAME}</key>`);
  const seg = plist.slice(i, i + 700);
  const tuple = (name) => {
    const m = new RegExp(`<key>${name}</key>\\s*<string>\\{([^}]+)\\}`).exec(seg);
    return m[1].split(",").map(Number);
  };
  const size = tuple("spriteSize");
  const offset = tuple("spriteOffset");
  return { width: size[0], height: size[1], offsetX: offset[0], offsetY: offset[1] };
}

const rows = new Map(factory.monsterPresentations().map((row) => [row.id, row]));
const tierByKey = new Map(factory.monsters().map((row) => [String(row.id), row.tier]));

//#region A. 数据行为（服务端资源行 → 运行时表）

const keys = [...rows.keys()].sort((a, b) => Number(a) - Number(b));
// 怪有几只是资源侧数据（美术出一只就多一行）；要守的是「key 连续、与数值表一一对应」
check(keys.length > 0 && keys.every((key, index) => key === String(index + 1)), "怪物资源行齐全且 key 从 1 连续（无缺口）", `实得 ${keys.length} 条`);
check(tierByKey.size === keys.length, "数值表行数 = 资源表行数（key 双向对账的另一半）", `资源 ${keys.length} / 数值 ${tierByKey.size}`);
check(keys.every((key) => tierByKey.has(key)) && [...tierByKey.keys()].every((key) => rows.has(key)), "资源行与数值行的 key 一一对应（生成器断言之外的复核）");

check(
  [...rows.values()].every((m) => m.contentSize.width > 0 && m.contentSize.height > 0),
  "每只怪 contentSize 都有实测值（宽高 > 0，不再有 0×0 占位）",
);

const geoMismatch = [];
for (const [key, m] of rows) {
  const trim = readTrim(key);
  if (m.contentSize.width !== trim.width || m.contentSize.height !== trim.height) geoMismatch.push(`${key}:size`);
  if (m.outOffset.x !== -trim.offsetX || m.outOffset.y !== -trim.offsetY) geoMismatch.push(`${key}:offset`);
}
check(geoMismatch.length === 0, "contentSize / outOffset 与图集基准帧 trim 全量一致", geoMismatch.slice(0, 5).join(", ") || "220/220");

// 落运行时表（真实的 monsterRuntime.applyMonsterPresentation —— 合并逻辑是行为，不是复制）
for (const [key, row] of rows) applyMonsterPresentation(key, row);
check(monsterResource.size === 220, "快照落表后运行时资源表 220 条", `实得 ${monsterResource.size} 条`);

let rateBroken = 0;
for (const m of monsterResource.values()) {
  const values = ACTION_KEYS.map((action) => m.speedRate[action]);
  if (values.length !== ACTION_KEYS.length || !values.every((value) => typeof value === "number" && value > 0)) rateBroken += 1;
}
check(rateBroken === 0, "落表后每只怪 speedRate 都是完整 11 个动作且 >0（快照覆盖与默认表合成）", `坏 ${rateBroken} 条`);
check(
  ACTION_KEYS.every((action) => typeof monsterDefaultSpeedRate[action] === "number" && monsterDefaultSpeedRate[action] > 0),
  "monsterDefaultSpeedRate 覆盖全部 11 个动作",
);

// #751：主动与否是**玩法决定**，归运营（管理端「怪物配置」勾选）。生成器只按体型 / tier
// **打印建议**、不再写库，所以这里不再断言「快照符合体型规则」—— 运营把一只小怪改成主动是合法的。
check(
  [...rows.values()].every((m) => typeof m.aggressive === "boolean"),
  "每只怪都有明确的主动 / 被动取值（布尔）",
);
{
  const aggressiveCount = [...rows.values()].filter((m) => m.aggressive).length;
  check(aggressiveCount > 0, "快照里至少有一只主动怪（规则真的铺开过）", `主动 ${aggressiveCount}/220`);
}

check(
  [1, 2, 3, 4].every((index) => {
    const m = rows.get(String(index));
    return m && m.moveSpeed === 2 && m.detectRange === 200;
  }),
  "1~4 号老怪行为不回退（速度 2 / 检测 200）",
);

const resMissing = [];
for (const [key, m] of rows) {
  if (!fs.existsSync(path.join(OUT_RES, key, "stand", "stand.plist"))) resMissing.push(`${key}:图集`);
  if (!fs.existsSync(path.join(PROJECT_ROOT, "assets/resources", `${m.icon}.png`))) resMissing.push(`${key}:icon`);
}
check(resMissing.length === 0, "每只怪的图集与 icon 资源都在磁盘上", resMissing.slice(0, 5).join(", "));

//#endregion

//#region B. 接线（源码断言）

check(/animationNode\.setPosition\(monster\.outOffset\.x,\s*monster\.outOffset\.y,\s*0\)/.test(HELPER_SRC), "createMonsterBody 消费 outOffset（身体中心对准节点原点）");
check(/const AGGRESSIVE_BODY_WIDTH = 250;/.test(GEN_SRC), "生成器阈值与测试同源（250）");
check(
  !/SET[^`]*aggressive\s*=/.test(GEN_SRC),
  "生成器不再写 aggressive（写口在管理端 PATCH /admin/monsters/:id，重跑几何不许抹掉运营的值）",
);
check(GEN_SRC.includes(`"${STAND_BASE_FRAME}"`), `生成器几何基准帧 = ${STAND_BASE_FRAME}`);
// 客户端不许再 import configs/game-config 的怪物 Map（那个 Map 已经删了；谁抄旧代码这里红）
check(!/from "\.\.\/\.\.\/configs\/monster"/.test(fs.readFileSync(path.join(PROJECT_ROOT, "assets/ui/core/MonsterManager.ts"), "utf8")), "MonsterManager 不再 import configs/game-config（数据全走 monsterRuntime）");
check(/speedRate:\s*\{\s*\.\.\.monsterDefaultSpeedRate,\s*\.\.\.\(row\.speedRate \?\? \{\}\)\s*\}/.test(RUNTIME_SRC), "运行时表落表时默认速度打底 + 快照覆盖合并");
// 真机踩到的坑（#588 验证轮）：Animation.play 在「还没挂进场景」的节点上调用，
// Cocos 3.8.7 不会在启用后自动恢复 —— spriteFrame 一直空，站着不动的怪整只不显示。
// 判据不是「play 过」，而是「挂进怪物层之后又播了一次」。
{
  const manager = fs.readFileSync(path.join(PROJECT_ROOT, "assets/ui/core/MonsterManager.ts"), "utf8");
  const body = /static spawn\([\s\S]*?\n  \}/.exec(manager)?.[0] ?? "";
  const mountAt = body.indexOf("LayerManager.addToMonsterLayer(monsterNode)");
  const replayAt = body.indexOf("replayCurrent(monsterNode)", mountAt);
  check(mountAt >= 0 && replayAt > mountAt, "spawn 在把怪挂进场景之后再重播待机动画（否则站着的怪没有帧 = 不显示）");
}

//#endregion

finish("PASS：怪物 220 条资源行（几何实测 / 动作速度合成 / 主动怪规则 / 资源在位 / 接线）全部通过");
