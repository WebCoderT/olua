#!/usr/bin/env node
/**
 * 世界权威审计（#581）：怪物的生成与掉落只认服务端
 *
 * ===========================================================================
 * 为什么要有它
 * ===========================================================================
 * 「服务端权威」在这个项目里已经做过多轮（#35 怪物状态 / #295 刷怪区 / #316 掉落抽取 /
 * #325 拾取入包 / #550 伤害结算），但每一轮都留了一条**回滚路径**：「实时通道不可用时
 * 客户端自己算一遍」。单看每条都合理（离线也能玩），合起来就是：
 *
 *   - 断线（或改包把通道关掉）→ 客户端按 Tiled 的 monster 对象组**自己刷怪**；
 *   - 打死自己刷出来的怪 → 客户端自己 `rollDropTable` 抽掉落、`addGood` 进背包。
 *
 * 这些怪没有服务端实例 id，掉落也没有服务端账本 —— 于是「掉出来的东西」在服务端眼里
 * 不存在，但它已经进了本地背包，下一次存档推上去就变成了真的。**没有任何现有审计能看见
 * 这条链**：每一段代码都是合法的，坏的是「两套来源」这件事本身。
 *
 * 所以把「客户端不许自己造」钉成机器判据。判据都是静态可判的，不需要跑客户端：
 *
 *   1. 客户端 `ui/` 下不许出现 `spawnByAreas`（本地按区域生成）与 `rollDropTable` /
 *      `resolveDropTable`（本地抽掉落）；
 *   2. 掉落入包只许走 `StorageManager.applyPickResult`（照搬服务端落的格子），
 *      `addGood` 不许在 `ui/` 里被调用（它只有一个定义，出现在别的行就是本地发物品）；
 *   3. 唯一入口接线：`GameMap` 发 `sendWorldJoin`、`MonsterManager` 落 `applyWorldState`、
 *      **铺地只走服务端的 `dropSpawn` / `world.drops`**（#804：`MonsterManager` 不许碰掉落，
 *      客户端不许出现 `spawnResults` / `spawnRemoteDrops` / `scatterDropPositions`），
 *      pick 帧只带 `dropId`；
 *   4. 服务端那一侧真的在算：`world.service` 读 `map_spawn_areas` 播种、
 *      `combat-settlement` 抽掉落并调 `roles.pickDrop`；
 *   5. 怪物数值与表现**客户端零副本**（#588，取代 #586 的「出厂兜底」）：configs/monster
 *      不许再长数值字段、旧类型 MonsterData/MonsterConfig 不许复活、运行时表必须被
 *      快照两段（monsters + monsterPresentations）填充、MonsterManager 只认运行时表。
 *
 * 输出风格与 `audit-map-origin.cjs` 一致：违规逐条指名道姓（文件:行 + 原文 + 该怎么做），exit 1。
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const CLIENT_UI = path.join(ROOT, "client", "assets", "ui");
const CLIENT_CONFIGS = path.join(ROOT, "client", "assets", "configs");
const SERVER = path.join(ROOT, "server", "src");

/** @type {Array<{file: string, line: number, hint: string}>} */
const problems = [];

function problem(file, line, hint) {
  problems.push({ file: path.relative(ROOT, file), line, hint });
}

function read(file, label) {
  if (!fs.existsSync(file)) {
    problems.push({ file: path.relative(ROOT, file), line: 0, hint: `${label}：文件不存在（被删了？先确认这是有意的）` });
    return "";
  }
  return fs.readFileSync(file, "utf8");
}

/** 递归收集 .ts 文件（跳过 .meta / .d.ts） */
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** 断言某个目录下所有文件都不含这些模式 */
function forbid(dir, patterns, hint) {
  for (const file of walk(dir)) {
    const lines = read(file, "扫描目标").split(/\r?\n/);
    lines.forEach((text, index) => {
      for (const pattern of patterns) {
        if (pattern.test(text)) {
          problem(file, index + 1, `${hint}（命中 ${pattern}）：${text.trim()}`);
        }
      }
    });
  }
}

/** 断言某个**文件**里不许出现这些模式（forbid 是扫目录，单文件单独一条路） */
function forbidFile(file, patterns, hint) {
  const lines = read(file, "扫描目标").split(/\r?\n/);
  lines.forEach((text, index) => {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        problem(file, index + 1, `${hint}（命中 ${pattern}）：${text.trim()}`);
      }
    }
  });
}

/** 断言某个文件里必须出现这些模式 */
function requirePatterns(file, patterns, hintPrefix) {
  const text = read(file, "必需接线");
  if (!text) return;
  const lines = text.split(/\r?\n/);
  for (const { pattern, hint } of patterns) {
    const index = lines.findIndex((line) => pattern.test(line));
    if (index < 0) problem(file, 0, `${hintPrefix}：${hint}`);
  }
}

// ---------------------------------------------------------------------------
// 一、客户端不许自己刷怪
// ---------------------------------------------------------------------------
forbid(CLIENT_UI, [/spawnByAreas/], "客户端不许按区域本地刷怪（怪物实例只能来自服务端 world 帧）");
forbid(CLIENT_UI, [/static hurt\(/], "客户端不许本地扣血（怪物只在服务端生成，断线时场上无怪可打；hurt() 在 #581 已删）");
forbid(
  path.join(ROOT, "client", "assets", "skills"),
  [/MonsterManager\.hurt\(/, /calcSkillDamage\(/],
  "技能实现不许本地算伤害（出手只发 sendCast，扣血 / 飘字 / 死亡等 settle 帧回来）",
);

const OLD_SPAWNER = path.join(CLIENT_UI, "components", "map", "MonsterAreaSpawner.ts");
if (fs.existsSync(OLD_SPAWNER)) {
  problem(OLD_SPAWNER, 0, "这个类在 #581 已删除（它只剩「发 worldJoin + 本地刷怪回滚」两件事，前者搬进 GameMap）。不要重新加回来");
}

// ---------------------------------------------------------------------------
// 二、客户端不许自己抽掉落 / 自己发物品
// ---------------------------------------------------------------------------
forbid(CLIENT_UI, [/rollDropTable/, /resolveDropTable/], "客户端不许抽掉落（服务端 settle 帧的 reward 就是结果，客户端只演）");
forbid(CLIENT_CONFIGS, [/export function resolveDropTable/], "掉落表只作为服务端 seed 的来源，客户端不再解析它（#581 删了这条回滚）");

// addGood 只有一个定义（StorageManager 里），别处出现就是「本地发物品」
for (const file of walk(CLIENT_UI)) {
  if (path.basename(file) === "StorageManager.ts") continue;
  const lines = read(file, "扫描目标").split(/\r?\n/);
  lines.forEach((text, index) => {
    if (/\baddGood\s*\(/.test(text)) {
      problem(file, index + 1, `客户端不许本地发物品：入包只能照搬服务端应答（StorageManager.applyPickResult）——${text.trim()}`);
    }
  });
}

// ---------------------------------------------------------------------------
// 三、唯一入口的接线
// ---------------------------------------------------------------------------
const GAME_MAP = path.join(CLIENT_UI, "components", "map", "GameMap.ts");
const MONSTER_MANAGER = path.join(CLIENT_UI, "core", "MonsterManager.ts");
const DROP_MANAGER = path.join(CLIENT_UI, "core", "DropManager.ts");
const COMBAT_CHANNEL = path.join(CLIENT_UI, "utils", "net", "CombatChannel.ts");

requirePatterns(GAME_MAP, [
  { pattern: /CombatChannel\.sendWorldJoin\(this\.onMapId\);/, hint: "建图必须登记「我在哪张图」（服务端据此播种）" },
]);

requirePatterns(MONSTER_MANAGER, [
  { pattern: /static applyWorldState\(/, hint: "服务端快照的落场点不见了 —— 怪物会永远刷不出来" },
]);

// 怪物管理器**不许再碰掉落**（#804）：铺地只有服务端广播一条路。
// #804 之前这里挂着两条 —— `spawnResults(reward.drops)`（自己杀的）与
// `spawnRemoteDrops(kill.dp)`（别人杀的），那正是「同一堆东西铺两遍、位置对不上、
// 别人的还捡不起来」的来源。掉落现在是世界实体，只由 `dropSpawn` / `world.drops` 铺。
forbidFile(MONSTER_MANAGER, [/DropManager\./], "MonsterManager 不许碰掉落（只清怪；铺地归 DropManager.onDropSpawn）");

requirePatterns(DROP_MANAGER, [
  // 铺地两条路进同一个实现：增量 `dropSpawn` 与全量 `world.drops`（进图 / 重连）
  { pattern: /static onDropSpawn\(frame: DropSpawnFrame\)/, hint: "铺地必须由服务端的 dropSpawn 帧驱动" },
  { pattern: /static applySnapshot\(drops: DropSnapshot\[\] \| undefined, mapId: string\)/, hint: "进图 / 重连必须按 world.drops 重建" },
  { pattern: /private static spawnOne\(snapshot: DropSnapshot\)/, hint: "两条路必须进同一个铺地实现（否则又会出现两套表现）" },
  { pattern: /StorageManager\.applyPickResult\(/, hint: "入包要照搬服务端落的格子（applyPickResult）" },
]);

// 客户端不许再出现「自己铺 / 自己散落掉落」的旧入口（#804 已把它们删干净）
forbid(
  CLIENT_UI,
  [/spawnResults\s*\(/, /spawnRemoteDrops\s*\(/, /scatterDropPositions\s*\(/],
  "客户端不许自己铺 / 自己散落掉落（#804：坐标与生命周期都在服务端，客户端只摆节点）",
);

// 拾取帧只带 dropId（#802）：带 castId + 下标就是退回「击杀者的账本」那套，
// 别人的掉落根本没有那个账本（这正是旧实现捡不起别人东西的原因）
{
  const text = read(COMBAT_CHANNEL, "实时通道");
  if (!/static sendPick\(dropId: string\): boolean/.test(text)) {
    problem(COMBAT_CHANNEL, 0, "sendPick 必须按 dropId 发请求（不是 castId + 下标）");
  }
  if (/type: "pick", data: \{[^}]*castId/.test(text)) {
    problem(COMBAT_CHANNEL, 0, "pick 帧又带上 castId 了（拾取定位只有 dropId 一处）");
  }
}

// ---------------------------------------------------------------------------
// 四、服务端那一侧真的在算
// ---------------------------------------------------------------------------
const WORLD = path.join(SERVER, "modules", "world", "world.service.ts");
// #809：播种 / 密度 / 落点从 world.service 拆进了 RoomManager（一间房一个对象）。
// 判据不变，只是**盯的位置跟着搬** —— 世界权威不可能因为换了文件就搬到客户端去。
const ROOM_MANAGER = path.join(SERVER, "modules", "world", "room", "room.manager.ts");
const SETTLEMENT = path.join(SERVER, "modules", "realtime", "combat-settlement.service.ts");
// #802：拾取从「结算域顺手入包」搬进了地面实体服务（DropService 是 pick 的唯一入口）。
// 判据不变（入包必须在服务端），盯的位置跟着搬 —— 权威不可能因为换了文件就搬到客户端去
const DROP_SERVICE = path.join(SERVER, "modules", "realtime", "drop.service.ts");

requirePatterns(ROOM_MANAGER, [
  { pattern: /spawnAreas\.listByMap\(/, hint: "播种必须读 map_spawn_areas（不是客户端配置）" },
  // #852：密度对齐挂在 tick 上，目标数只许来自 spawnTargetOf（管理端页面显示的那个数也是它算的）
  { pattern: /alignDensity\(room: Room/, hint: "密度对齐必须由 tick 驱动（改了 max / 系数下一秒就生效）" },
  { pattern: /spawnTargetOf\(/, hint: "目标只数只许用 spawnTargetOf 算（别在世界服务里另抄一份公式）" },
  // #850：落点钳进图内（越界区域不再把怪刷到图外）
  { pattern: /clampPointToMap\(/, hint: "落点必须钳进图内（#850）" },
]);

requirePatterns(WORLD, [
  { pattern: /processRespawns\(/, hint: "重生必须由服务端 tick 驱动" },
  // #849：落盘按 worldPersistMs 节流，否则那个配置就是个死字段
  {
    pattern: /now - this\.lastPersistAt >= this\.persistMs\(\)/,
    hint: "落盘必须按 worldPersistMs 节流（#849：每次 tick 无条件 flush 等于这个配置没接线）",
  },
]);

requirePatterns(SETTLEMENT, [
  { pattern: /rollDrops\(/, hint: "掉落抽取必须在服务端" },
]);

requirePatterns(DROP_SERVICE, [
  // 入包只有这一个入口：`DropService.pick`（九步校验 → roles.pickDrop → 状态迁移 → 广播）
  { pattern: /this\.roles\.pickDrop\(/, hint: "入包必须在服务端（pick 帧的落点）" },
  // 地面实体必须落进投影表：否则管理端读不到「这张图地上现在有什么」，重启清场也没依据
  { pattern: /this\.worldDrops\.upsert\(/, hint: "地面掉落必须写进投影表（world_drops）" },
]);

// ---------------------------------------------------------------------------
// 五、怪物数值的归属：服务端独有，客户端零副本（#588，取代 #586 的「出厂兜底」口径）
// ---------------------------------------------------------------------------
// #586 那版审「覆写全不全」；#588 把客户端的本地副本整个删了 —— 数值唯一来源是
// 服务端 monsters 表，资源表现唯一来源是服务端 monster-presentation 生成物。
// #670 起连「怪物手感参数（monsterAI）」也搬去了服务端（`runtime_params.monster_ai`）：
// 客户端不再跑怪物行为，这一区只剩**表现层**的默认动作速度倍率。
// 副本没了，「覆写漏字段」这类 bug 从根上消失；新的坏法是**运行时表没人填**
// （表空 = 全场怪退化为 key 名字 + 攻防 0，看起来像「快照没生效」），所以这里钉两层：
//   静态层 —— 客户端 configs/types 里不许再长出怪物数值与资源字段；
//   接线层 —— 快照入口必须把两段数据填进运行时表，消费点必须只认运行时表。
const APPLY_SNAPSHOT = path.join(CLIENT_CONFIGS, "apply-snapshot.ts");
// #626 起怪物手感常量与运行时表都在 configs/game-config（原 monster.ts / monsterRuntime.ts）。
// 判据不变，但范围要收窄到「怪物手感参数」那一区 —— 整个文件里别的域本来就有 maxHp 之类的字段。
const GAME_CONFIG = path.join(CLIENT_CONFIGS, "game-config.ts");
const MONSTER_REGION = 15;
/** 取 game-config 里某个 //#region N 的正文（找不到返回空串，由调用方报问题） */
function regionOf(source, index) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`//#region ${index} ·`));
  if (start < 0) return "";
  const end = lines.findIndex((line, i) => i > start && line.startsWith("//#endregion"));
  if (end < 0) return "";
  return lines.slice(start + 1, end).join("\n");
}
{
  // —— 静态层：客户端配置里不许再有怪物数值副本 ——
  const gameConfigSource = read(GAME_CONFIG, "客户端快照配置");
  const monsterConfig = regionOf(gameConfigSource, MONSTER_REGION);
  if (monsterConfig) {
    // 只看代码行：注释里提到字段名（归属说明）不算副本
    const code = monsterConfig.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line)).join("\n");
    const NUMERIC_FIELDS = ["maxHp", "physicalAttack", "magicAttack", "taoistAttack", "physicalDefense", "magicDefense", "taoistDefense"];
    const leaked = NUMERIC_FIELDS.filter((field) => new RegExp(`\\b${field}\\b`).test(code));
    if (leaked.length > 0) {
      problem(MONSTER_CONFIG, 0, `configs/monster 又出现了怪物数值字段（${leaked.join("/")}）—— #588 起数值服务端独有，这里只许有默认移速倍率`);
    }
    if (!/\bmonsterDefaultSpeedRate\b/.test(monsterConfig)) {
      problem(GAME_CONFIG, 0, "game-config 的怪物表现参数区连 monsterDefaultSpeedRate 都没了 —— 被删过头了，动作速度还住在这里");
    }
    // 怪物行为参数（出手间隔 / 移动节奏 / 激怒）已整体归服务端（#670）：
    // 客户端一旦又长出这些常量，通常意味着本地 AI 也跟着回来了 —— 那正是「两个人的怪在打架」的根源
    const BEHAVIOR_FIELDS = ["attackInterval", "attackRange", "idleMoveInterval", "wanderRadius", "pushDuration"];
    const behavior = BEHAVIOR_FIELDS.filter((field) => new RegExp(`\\b${field}\\b`).test(code));
    if (behavior.length > 0) {
      problem(GAME_CONFIG, 0, `怪物行为参数又回到客户端了（${behavior.join("/")}）—— #670 起 AI 全在服务端，改参数请改 runtime_params.monster_ai`);
    }
  }

  // 类型层：MonsterData / MonsterConfig 这两个旧类型不许复活（字段会顺着类型长回来）
  for (const file of walk(path.join(ROOT, "client", "assets", "types"))) {
    const lines = read(file, "怪物类型").split(/\r?\n/);
    lines.forEach((text, index) => {
      if (/\b(MonsterData|MonsterConfig)\b/.test(text)) {
        problem(file, index + 1, `旧怪物数据类型 #588 已删 —— 类型复活通常意味着本地副本也跟着回来了：${text.trim()}`);
      }
    });
  }

  // —— 接线层：运行时表必须被快照填充 ——
  const text = read(APPLY_SNAPSHOT, "快照应用");
  // applyMonsterRows 的实现随 #626 搬进 game-config（总入口仍在 apply-snapshot 调用它）
  const body = /export function applyMonsterRows\([\s\S]*?\n\}/.exec(gameConfigSource)?.[0] ?? "";
  if (!body) {
    problem(GAME_CONFIG, 0, "找不到 applyMonsterRows —— 怪物数值落表入口变了，请先确认服务端权威还在，再同步改本审计");
  } else {
    if (!/applyMonsterRuntimeStats\(row\.id,/.test(body)) {
      problem(GAME_CONFIG, 0, "applyMonsterRows 没写运行时数值表（applyMonsterRuntimeStats）—— 快照来了也进不了消费点的视野");
    }
    const OWNED = ["label", "level", "tier", "maxHp", "attributes.physicalAttack", "attributes.magicAttack", "attributes.taoistAttack", "attributes.physicalDefense", "attributes.magicDefense", "attributes.taoistDefense"];
    for (const field of OWNED) {
      if (!new RegExp(`row\\.${field.replace(/\./g, "\\.")}`).test(body)) {
        problem(GAME_CONFIG, 0, `applyMonsterRows 少了 row.${field} 的落表：这一项会永远停在退化值（0 或 key 名）—— 管理端改了、游戏里没变`);
      }
    }
  }
  if (!/applyMonsterRows\(snapshot\.monsters\)/.test(text)) {
    problem(APPLY_SNAPSHOT, 0, "applyMonsterRows 没被快照入口调用 —— 写了等于没写（快照一来就该落表）");
  }
  // 表现段是 #588 新增的快照段：没接 = 全场怪刷不出来（spawn 按资源表过滤，缺行直接跳过）
  if (!/applyMonsterPresentations\(snapshot\.monsterPresentations\)/.test(text)) {
    problem(APPLY_SNAPSHOT, 0, "快照入口没接 applyMonsterPresentations —— 表现段（icon/out/几何/移速）没人落表，怪物会被 spawn 整只跳过");
  }

  // —— 消费层：MonsterManager 只认运行时表，不许回头 import 客户端配置 ——
  const monsterManager = read(MONSTER_MANAGER, "怪物管理器");
  if (monsterManager && /from\s+"\.\.\/\.\.\/configs\/monster"/.test(monsterManager)) {
    problem(MONSTER_MANAGER, 0, "MonsterManager 又 import 了 configs/monster —— 资源与数值一律走 monsterRuntime 的运行时表（monsterResourceOf / monsterStatsOrDefault）");
  }
  requirePatterns(MONSTER_MANAGER, [
    { pattern: /monsterResourceOf\(/, hint: "spawn 前必须查运行时资源表（缺行跳过 = 没法渲染的怪不落场）" },
    { pattern: /monsterStatsOrDefault\(/, hint: "spawn 必须从运行时数值表取属性（本地没有兜底副本可抄）" },
  ]);

  // —— 服务端那一侧真的在下发：快照带表现段 ——
  // #655 起出厂数据在库里，这一段从仓储读（不再是常量数组），判据只看「字段有没有接上」
  const CLIENT_CONFIG_SERVICE = path.join(SERVER, "modules", "game-config", "client-config.service.ts");
  requirePatterns(CLIENT_CONFIG_SERVICE, [
    { pattern: /monsterPresentations:\s*[\w.]*monsterPresentations[\w.]*\.listAll\(\)/, hint: "快照必须携带 monsterPresentations 段（客户端零副本，全靠这一段）" },
  ]);
}

// ---------------------------------------------------------------------------

if (problems.length === 0) {
  const scanned = walk(CLIENT_UI).length;
  console.log(
    `✓ 世界权威：客户端 ${scanned} 个文件无本地刷怪 / 无本地掉落结算；` +
      "唯一入口（sendWorldJoin / applyWorldState / dropSpawn + world.drops / pickDrop(dropId)）齐全；" +
      "怪物数值与表现客户端零副本（game-config 怪物区无数值字段、运行时表由快照两段填充）",
  );
  process.exit(0);
}

console.error(`✗ 世界权威：${problems.length} 处问题（怪物生成与掉落的权威只能在服务端）\n`);
for (const item of problems) {
  console.error(`  ${item.file}${item.line ? `:${item.line}` : ""}`);
  console.error(`    ${item.hint}`);
}
process.exit(1);
