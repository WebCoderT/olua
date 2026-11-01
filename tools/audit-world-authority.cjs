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
 *      `DropManager.spawnResults` 的 `castId` **必填**（缺省就是「本地口径的掉落」）；
 *   4. 服务端那一侧真的在算：`world.service` 读 `map_spawn_areas` 播种、
 *      `combat-settlement` 抽掉落并调 `roles.pickDrop`。
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

requirePatterns(GAME_MAP, [
  { pattern: /CombatChannel\.sendWorldJoin\(this\.onMapId\);/, hint: "建图必须登记「我在哪张图」（服务端据此播种）" },
]);

requirePatterns(MONSTER_MANAGER, [
  { pattern: /static applyWorldState\(/, hint: "服务端快照的落场点不见了 —— 怪物会永远刷不出来" },
  { pattern: /DropManager\.spawnResults\(reward\.drops/, hint: "掉落必须来自 settle 帧的 reward（不是本地结算）" },
]);

requirePatterns(DROP_MANAGER, [
  { pattern: /static spawnResults\(results: DropResult\[\], position: Vec3, castId: number\)/, hint: "spawnResults 的 castId 必须必填 —— 可选参数就是「本地口径的掉落」" },
  { pattern: /StorageManager\.applyPickResult\(/, hint: "入包要照搬服务端落的格子（applyPickResult）" },
]);

// spawnResults 的参数表里不许出现 `castId?:`
{
  const text = read(DROP_MANAGER, "掉落管理器");
  if (/spawnResults\([^)]*castId\?:/.test(text)) {
    problem(DROP_MANAGER, 0, "spawnResults 的 castId 又变成可选了（可选 = 允许没有服务端账本的掉落物）");
  }
}

// ---------------------------------------------------------------------------
// 四、服务端那一侧真的在算
// ---------------------------------------------------------------------------
const WORLD = path.join(SERVER, "modules", "world", "world.service.ts");
const SETTLEMENT = path.join(SERVER, "modules", "realtime", "combat-settlement.service.ts");

requirePatterns(WORLD, [
  { pattern: /spawnAreas\.listByMap\(/, hint: "播种必须读 map_spawn_areas（不是客户端配置）" },
  { pattern: /processRespawns\(/, hint: "重生必须由服务端 tick 驱动" },
]);

requirePatterns(SETTLEMENT, [
  { pattern: /rollDrops\(/, hint: "掉落抽取必须在服务端" },
  { pattern: /roles\.pickDrop\(/, hint: "入包必须在服务端（pick 帧的落点）" },
]);

// ---------------------------------------------------------------------------

if (problems.length === 0) {
  const scanned = walk(CLIENT_UI).length;
  console.log(
    `✓ 世界权威：客户端 ${scanned} 个文件无本地刷怪 / 无本地掉落结算；` +
      "唯一入口（sendWorldJoin / applyWorldState / spawnResults(castId) / pickDrop）齐全",
  );
  process.exit(0);
}

console.error(`✗ 世界权威：${problems.length} 处问题（怪物生成与掉落的权威只能在服务端）\n`);
for (const item of problems) {
  console.error(`  ${item.file}${item.line ? `:${item.line}` : ""}`);
  console.error(`    ${item.hint}`);
}
process.exit(1);
