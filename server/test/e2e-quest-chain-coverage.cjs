#!/usr/bin/env node
/**
 * 主线任务链覆盖守点（server/test/e2e-quest-chain-coverage.cjs，issue #1084）
 *
 * ## 这一套在测什么
 *
 * #1084 的主线链（docs/31 §九）是一次性脚本 `oneoff-seed-quest-chain.ts` 落库的
 * **运营数据**（quests / npcs / map_npcs / map_spawn_areas 都是配置表，不走表结构
 * 变更）—— 脚本按 docs/31 §9.3 / §9.4 的基准生成逐行显式值。这份守点保证：
 *
 * 1. **kill 目标集合 == monsters 全集**（一只不漏、一只不多）—— 后续往 monsters
 *    加怪 / 删怪时，任务链必须跟着重排，不许静默漏覆盖；
 * 2. **主线链 prev_quest_id 连通无断链、无环**：首环 = 8005（接在 8004「战魂之门」
 *    之后）、末环 = 60 级 boss（2026-11-19 拍板的段内环序：报到 → 清怪 → 复命 → boss）；
 * 3. **每只怪在 map_spawn_areas 至少一个区**，且每个区落在**自己那张图**的真实像素边界内
 *    （§9.5 全量落位重排后没有「有环无怪」的死环；#1150 换图后 220 区按等级段分铺到 6 张图，
 *    边界判据改成按 maps 表的 pixel_width/height 逐图比 —— 不写死任何一张图的尺寸）；
 * 4. **逐环奖励在 §9.4 基准的容差带内**（reward_exp / reward_bind_gold / min_level），
 *    防手改跑飞 —— 基准公式与脚本同源（docs/31 §9.4），这里只做容差复核不重算精确值。
 *
 * 纯数据库断言，起一台**临时文件库**的服务（不碰任何业务接口，起服只为把
 * config-sync.sql 灌进空库 —— 存量库要跑过 `oneoff-seed-quest-chain.ts --apply`
 * 并重导快照才有这批行，全新 clone 靠空库首启灌种子）。
 *
 * 用法：npm run test:e2e:quest-chain（无需 build）
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const ADMIN_CODE = "e2e-quest-chain-root";

let passed = 0;
let failed = 0;
const failures = [];

function check(ok, label, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  [OK] ${label}${detail ? " —— " + detail : ""}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  [!!] ${label}${detail ? " —— " + detail : ""}`);
  }
}

function checkEqual(actual, expected, label) {
  return check(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`,
  );
}

function group(label) {
  console.log(`\n▶ ${label}`);
}

/** docs/31 §9.4 基准（与 oneoff-seed-quest-chain.ts 同源，两边都对着同一篇文档） */
const SEGMENTS = [1, 11, 21, 31, 41, 51];
const round10 = (v) => Math.round(v / 10) * 10;
const killExpBasis = (level, count, per) => round10(count * (level + 1) * per);
const goldBasis = (segStart) => Math.round(800 * (1 + (segStart - 1) / 10));

/** 起一台临时文件库的服务（文件库才能被第二连接守点读取） */
async function startServer(dbPath) {
  const port = await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ENTRY], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      API_PREFIX: "api",
      DB_PATH: dbPath,
      JWT_SECRET: "e2e-quest-chain-secret",
      ADMIN_REGISTER_CODE: ADMIN_CODE,
      LOG_REQUESTS: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(String(chunk)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务进程提前退出（code=${child.exitCode}）\n${errors.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return { kill: () => child.kill("SIGTERM") };
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill("SIGTERM");
  throw new Error(`等待服务启动超时\n${errors.join("")}`);
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-quest-chain-${Date.now()}.db`);
  const server = await startServer(dbPath);
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
const monsters = db.prepare("SELECT id, label, tier, level FROM monsters ORDER BY level, CAST(id AS INTEGER)").all();
const quests = db
  .prepare(
    "SELECT id, kind, label, prev_quest_id, min_level, npc_id, objective_type, objective_target, objective_count, reward_exp, reward_bind_gold FROM quests WHERE kind = 'main' ORDER BY CAST(id AS INTEGER)",
  )
  .all();
const byId = new Map(quests.map((q) => [q.id, q]));
const CHAIN = quests.filter((q) => q.id >= "8005" && q.id !== "8100" && !(q.id >= "8100" && q.id <= "8109"));

group("一、kill 目标集合 == monsters 全集（一只不漏、一只不多）");
{
  const killTargets = new Set(CHAIN.filter((q) => q.objective_type === "kill").map((q) => q.objective_target));
  const monsterIds = new Set(monsters.map((m) => m.id));
  const missing = [...monsterIds].filter((id) => !killTargets.has(id));
  const extra = [...killTargets].filter((id) => !monsterIds.has(id));
  check(missing.length === 0, "每只怪都有讨伐环", missing.length ? `缺 ${missing.join(",")}` : "220 只全覆盖");
  check(extra.length === 0, "没有指向不存在怪物的环", extra.length ? `多 ${extra.join(",")}` : "");
  checkEqual(CHAIN.filter((q) => q.objective_type === "kill").length, monsters.length, "kill 环数 == 怪物数（一环一怪）");
}

group("二、主线链 prev_quest_id 连通无断链、无环（首环 8005、末环 60 级 boss）");
{
  const head = byId.get("8005");
  check(!!head && head.prev_quest_id === "8004", "首环 8005 接在 8004「战魂之门」之后");
  // 从 8005 沿 prev 链走到底：无断链（每一步都找得到行）、无环（步数 = 链长即终止）
  let cur = "8005";
  let prev = "8004";
  let steps = 0;
  let broken = "";
  const seen = new Set();
  while (cur && byId.has(cur)) {
    if (seen.has(cur)) {
      broken = `成环 @ ${cur}`;
      break;
    }
    seen.add(cur);
    const q = byId.get(cur);
    if (q.prev_quest_id !== prev) {
      broken = `断链 @ ${cur}（prev 期望 ${prev}，实际 ${q.prev_quest_id}）`;
      break;
    }
    prev = cur;
    cur = quests[quests.indexOf(q) + 1] ? quests[quests.indexOf(q) + 1].id : "";
    steps++;
  }
  check(!broken && steps === CHAIN.length, "链从 8005 走到底无断链、无环", broken || `${steps} 步`);
  const tail = CHAIN[CHAIN.length - 1];
  const tailMonster = monsters.find((m) => m.id === tail.objective_target);
  check(
    tail.objective_type === "kill" && !!tailMonster && tailMonster.tier === "boss" && tailMonster.level === 60,
    "末环 = 60 级 boss 的讨伐环",
    `${tail.id} → ${tailMonster ? tailMonster.label : "?"}`,
  );
  const daily = db.prepare("SELECT id FROM quests WHERE id = '8101'").get();
  check(!!daily, "日常 8101 原地保留（主线 id 跳过 8100~8109）");
  const stolen = CHAIN.filter((q) => q.id >= "8100" && q.id <= "8109");
  check(stolen.length === 0, "主线链没有占用日常 id 段");
}

group("三、每只怪在 map_spawn_areas 至少一个区（#1084 全量落位重排）");
{
  const covered = new Set(db.prepare("SELECT DISTINCT monster_key FROM map_spawn_areas").all().map((r) => r.monster_key));
  const missing = monsters.filter((m) => !covered.has(m.id));
  check(missing.length === 0, "每只怪都能刷出来", missing.length ? `缺 ${missing.slice(0, 8).map((m) => m.id).join(",")}` : `${covered.size} 种全覆盖`);
  const areas = db.prepare("SELECT map_id, monster_key, min, max, cx, cy, w, h FROM map_spawn_areas").all();
  // 边界判据跟快照走：每张图的真实像素尺寸来自 maps 表（#1150 换图后区是**按段分图**铺的，
  // 旧的 8192 常量既不是任何一张图的尺寸，也会把「合法但不在 8192 内」的区误判成越界）
  const mapSize = new Map(
    db.prepare("SELECT map_id, pixel_width, pixel_height FROM maps").all().map((m) => [m.map_id, m]),
  );
  const orphan = areas.filter((a) => !mapSize.has(a.map_id));
  check(
    orphan.length === 0,
    "刷怪区的 map_id 都在 maps 表里（没有孤儿区）",
    orphan.slice(0, 5).map((a) => `${a.map_id}:${a.monster_key}`).join(","),
  );
  const oob = areas.filter((a) => {
    const m = mapSize.get(a.map_id);
    if (!m) return false;
    return (
      a.cx - a.w / 2 < 0 ||
      a.cx + a.w / 2 > m.pixel_width ||
      a.cy + a.h / 2 > 0 ||
      a.cy - a.h / 2 < -m.pixel_height
    );
  });
  check(
    oob.length === 0,
    "刷怪区都落在自己那张图内（按快照的 pixel_width/height 判，不写死 8192）",
    oob.slice(0, 5).map((a) => `图${a.map_id} ${a.monster_key} @${Math.round(a.cx)},${Math.round(a.cy)}`).join("；"),
  );
  const dangling = areas.filter((a) => !monsters.some((m) => m.id === a.monster_key));
  check(dangling.length === 0, "没有指向不存在怪物的刷怪区", dangling.slice(0, 5).map((a) => a.monster_key).join(","));
  const empty = areas.filter((a) => a.min < 1 || a.max < a.min);
  check(empty.length === 0, "每个区的 min ≥ 1 且 max ≥ min", empty.slice(0, 5).map((a) => `${a.map_id}:${a.monster_key}`).join(","));

  // 使者分驻（#1162）：使者 s 必须落在第 s 段猎场图上 —— 这是「任务链串联地图」的载体，
  // 搬回一张图（比如全挤回村）会让玩家升段不用跑图，串联就名存实亡。
  const BAND_MAPS = ["0", "2", "4", "6", "8", "10"]; // 与 BAND_PLAN 逐段对应
  const stationed = db
    .prepare("SELECT npc_id, map_id FROM map_npcs WHERE npc_id IN ('0101','0102','0103','0104','0105','0106')")
    .all();
  checkEqual(stationed.length, 6, "六位使者都落了 map_npcs 点位");
  const misstationed = stationed.filter((r) => {
    const s = Number(r.npc_id.slice(-1)) - 1;
    return r.map_id !== BAND_MAPS[s];
  });
  check(
    misstationed.length === 0,
    "使者按段分驻猎场（壹→图0 … 陆→图10）",
    misstationed.map((r) => `${r.npc_id}→图${r.map_id}`).join(","),
  );
}

group("四、逐环奖励在 §9.4 基准的容差带内（防手改跑飞）");
{
  // 段归属：环 min_level = 段起始（boss 环 +5），按 npc 反查段最稳（0101~0106 与段一一对应）
  const segOfNpc = (npcId) => {
    const idx = Number(npcId) - 101;
    return idx >= 0 && idx < SEGMENTS.length ? SEGMENTS[idx] : null;
  };
  const expRow = db.prepare("SELECT value FROM growth_scalars WHERE key = 'expGain.expPerLevel'").get();
  const expPerLevel = expRow ? Number(expRow.value) : 5;
  let badExp = 0;
  let badGold = 0;
  let badLevel = 0;
  const detail = [];
  for (const q of CHAIN) {
    const start = segOfNpc(q.npc_id);
    if (!start) {
      badLevel++;
      detail.push(`${q.id} npc ${q.npc_id} 不在 0101~0106`);
      continue;
    }
    if (q.objective_type === "kill") {
      const m = monsters.find((x) => x.id === q.objective_target);
      const isBoss = m && m.tier === "boss";
      const count = isBoss ? 1 : q.objective_count;
      const exp = killExpBasis(m.level, count, expPerLevel);
      if (Math.abs(q.reward_exp - exp) > Math.max(12, exp * 0.15)) {
        badExp++;
        detail.push(`${q.id} reward_exp ${q.reward_exp} 偏离基准 ${exp}`);
      }
      const gold = goldBasis(start) * (isBoss ? 1.1 : 1);
      if (Math.abs(q.reward_bind_gold - gold) > gold * 0.12) {
        badGold++;
        detail.push(`${q.id} reward_bind_gold ${q.reward_bind_gold} 偏离基准 ${Math.round(gold)}`);
      }
      const wantLevel = isBoss ? start + 5 : start;
      if (q.min_level !== wantLevel) {
        badLevel++;
        detail.push(`${q.id} min_level ${q.min_level} != ${wantLevel}`);
      }
    } else if (q.objective_type === "talk") {
      // talk 环 = 本段普通怪 kill 环均值 × 2（与脚本同源：killExpList 只收普通怪；±20% 容差）
      const segKills = CHAIN.filter((x) => {
        if (x.npc_id !== q.npc_id || x.objective_type !== "kill") return false;
        const m = monsters.find((mm) => mm.id === x.objective_target);
        return m && m.tier !== "boss";
      });
      const segExp = segKills.reduce((acc, x) => {
        const m = monsters.find((mm) => mm.id === x.objective_target);
        return acc + killExpBasis(m.level, x.objective_count, expPerLevel);
      }, 0);
      const mean = segExp / Math.max(1, segKills.length);
      const want = round10(mean * 2);
      if (Math.abs(q.reward_exp - want) > Math.max(24, want * 0.2)) {
        badExp++;
        detail.push(`${q.id} talk reward_exp ${q.reward_exp} 偏离段均值×2 基准 ${want}`);
      }
      if (Math.abs(q.reward_bind_gold - goldBasis(start)) > goldBasis(start) * 0.12) {
        badGold++;
        detail.push(`${q.id} talk reward_bind_gold ${q.reward_bind_gold} 偏离段基准 ${goldBasis(start)}`);
      }
    } else {
      badLevel++;
      detail.push(`${q.id} 主线链里出现了 ${q.objective_type} 环`);
    }
  }
  check(badExp === 0, "reward_exp 全部在基准容差内", badExp ? detail.slice(0, 5).join("；") : "232 环全过");
  check(badGold === 0, "reward_bind_gold 全部在基准容差内", badGold ? detail.slice(0, 5).join("；") : "232 环全过");
  check(badLevel === 0, "min_level = 段起始（boss +5），无越段环", badLevel ? detail.slice(0, 5).join("；") : "232 环全过");
}

console.log(`\n${failed === 0 ? "✅" : "❌"} 主线链覆盖：${passed} 条通过 / ${failed} 条失败`);
if (failed > 0) {
  console.log("\n失败项：");
  failures.forEach((item) => console.log(`  - ${item}`));
  process.exitCode = 1;
}
    db.close();
  } finally {
    server.kill();
    fs.rmSync(dbPath, { force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
