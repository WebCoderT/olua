#!/usr/bin/env node
/**
 * 广播统计专项 e2e（server/test/e2e-realtime-stats.cjs，issue #767）
 *
 * ## 这一套在测什么
 *
 * 同步延迟测量基线的服务端一半：三条广播出口（world / monster-ai / players）每轮的
 * 收件人数 / 帧条数 / JSON 字节数 / stringify 耗时 / 实际间隔，按
 * `REALTIME_STATS_INTERVAL_MS` 汇总打一行日志（`广播统计[...]`）。
 *
 * 这是**测量**，不是调参 —— issue 的硬边界：不改任何同步参数、广播路径里不许加
 * await / setTimeout。所以断言只落在「开关打开能看到数字、关掉零输出」上，
 * 不锁数值本身（收件人数随连接数走、KB 随帧内容走，锁了就是假红）。
 *
 * ## 三段
 *
 * 1. **开关打开**（`REALTIME_STATS_INTERVAL_MS=300`）：一个玩家进图并连续上报位置
 *    （players 轮必然发生），怪在图里游走 / 追人（monster-ai 轮迟早发生，出厂
 *    游走间隔 4~9s）—— 从 stdout 断言两类统计行都出现且五个数字齐全、收件 ≥ 1；
 * 2. **开关关闭**（`REALTIME_STATS_INTERVAL_MS=0`）：同样的活动跑 1.5s，
 *    断言 stdout 里一条统计行都没有（关闭 = 零输出，钩子全是空操作）；
 * 3. **默认值钉在源码上**：`statsMs()` 的兜底是 `?? 10_000`（默认打开）、
 *    配置键在 `configuration.ts` 登记过 —— 防止有人把默认值改没了没人知道。
 *
 * ## 与其他 e2e 的关键差别
 *
 * - **统计行打到 stdout**（Nest Logger），起服务端用 `stdio: pipe` 收着断言，
 *   与 e2e-world-viewers 的「空闲卸载日志」同一手法；
 * - 不 seed 世界也能跑：玩家互见帧不依赖怪，monster-ai 帧等怪自己动
 *   （本套不关心它动了多少 —— 统计行出现即证明「轮」真的在跑）。
 *
 * 用法：npm run test:e2e:realtime-stats（前置 npm run build）
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

const HOME_MAP = "0";
/** 统计汇总窗口（毫秒）：压小让「几秒的活动」也覆盖多个窗口 */
const STATS_MS = 300;
/** 广播统计行的前缀（与 realtime.service flushStats 的文案同源） */
const STATS_PREFIX = "广播统计[";

//#region 断言小工具（与 e2e-world-viewers 同款口径）

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
  return ok;
}

function checkEqual(actual, expected, label) {
  return check(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}

function group(label) {
  console.log(`\n▶ ${label}`);
}

//#endregion

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (label, predicate, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(50);
  }
  check(false, `${label}（等待超时）`);
  return last;
};

/** 起服务端（statsOn：REALTIME_STATS_INTERVAL_MS 的值，"0" = 关闭） */
async function startServer(dbPath, statsMs) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ENTRY], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      API_PREFIX: "api",
      DB_PATH: dbPath,
      JWT_SECRET: "e2e-realtime-stats-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      // 世界层拉远：这一套不关心重生与密度，别让世界帧把画面搅乱
      WORLD_TICK_MS: "200",
      WORLD_PERSIST_MS: "500",
      WORLD_RESPAWN_MS: "600000",
      REALTIME_STATS_INTERVAL_MS: String(statsMs),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(String(chunk)));
  child.stderr.on("data", (chunk) => chunks.push(String(chunk)));

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务进程提前退出（code=${child.exitCode}）\n${chunks.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return { baseUrl, port, child, logs: () => chunks.join("") };
    } catch {
      /* 还没起来 */
    }
    await sleep(100);
  }
  throw new Error("等待服务启动超时");
}

async function api(baseUrl, method, route, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}/api/${route}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

/** 统计行解析：`广播统计[kind] Xs 内：N 轮 / 帧 N / 收件 N 人次 / N.NKB / stringify N.Nms / 平均轮间隔 Nms` */
function parseStatsLines(logs, kind) {
  return logs
    .split("\n")
    .filter((line) => line.includes(`${STATS_PREFIX}${kind}]`))
    .map((line) => {
      const rounds = /(\d+) 轮 \/ 帧 (\d+) \/ 收件 (\d+) 人次 \/ ([\d.]+)KB \/ stringify ([\d.]+)ms \/ 平均轮间隔 (\d+)ms/.exec(line);
      return rounds
        ? { rounds: Number(rounds[1]), frames: Number(rounds[2]), recipients: Number(rounds[3]), kb: Number(rounds[4]), stringifyMs: Number(rounds[5]), avgIntervalMs: Number(rounds[6]) }
        : null;
    })
    .filter(Boolean);
}

/**
 * 一个玩家的完整活动：进图 + 连续上报交替位置
 *
 * 位置每帧都变 = 互见增量每拍都有变化 = players 轮必然发生（这一套唯一保证
 * 「一定有活动」的开关）。返回后连接保持打开，怪物 AI 照常跑。
 */
async function activePlayer(baseUrl, label) {
  const registered = await api(baseUrl, "POST", "auth/register", { body: { username: `stats_${label}`, password: "pass1234" } });
  const token = registered.body && registered.body.data && registered.body.data.token;
  if (!token) throw new Error(`注册失败：${JSON.stringify(registered.body)}`);
  await api(baseUrl, "POST", "roles", { token, body: { name: `统计${label}`, occupation: "1", sex: "1" } });
  const ticket = await api(baseUrl, "POST", "realtime/ticket", { token });
  const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.body.data.ticket)}`);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ type: "worldJoin", data: { mapId: HOME_MAP } }));
  await sleep(400);
  // 连续上报交替位置：坐标系里左右蹭（不走出刷怪区，也不触发任何校验）
  for (let i = 0; i < 20; i += 1) {
    socket.send(JSON.stringify({ type: "pos", data: { mapId: HOME_MAP, x: i % 2 === 0 ? 400 : 404, y: -400, hp: 100, moving: i % 2 === 0 } }));
    await sleep(80);
  }
  return socket;
}

async function stopServer(server, dbPath) {
  if (server.child.exitCode === null && !server.child.signalCode) {
    server.child.kill("SIGTERM");
    await sleep(300);
    if (server.child.exitCode === null && !server.child.signalCode) server.child.kill("SIGKILL");
  }
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbPath + suffix, { force: true });
}

(async () => {
  //#region 一、开关打开：统计行出现且五个数字齐全

  group("一、开关打开（REALTIME_STATS_INTERVAL_MS=300）：统计行出现且数字齐全");
  const dbPath1 = path.join(os.tmpdir(), `olua-e2e-realtime-stats-on-${Date.now()}.db`);
  const on = await startServer(dbPath1, STATS_MS);
  try {
    const socket = await activePlayer(on.baseUrl, "a");

    // players 轮：位置一直在变，广播节拍 200ms < 汇总窗口，窗口内必有累计
    const playersLines = await waitFor("players 统计行", async () => {
      const lines = parseStatsLines(on.logs(), "players");
      return lines.length > 0 ? lines : null;
    });
    check(playersLines.length > 0, "players 统计行出现在 stdout", `${playersLines.length} 行`);
    const latest = playersLines[playersLines.length - 1];
    check(latest.rounds > 0, "轮数 > 0（广播出口真的在跑）", `rounds=${latest.rounds}`);
    check(latest.frames > 0, "帧条数 > 0", `frames=${latest.frames}`);
    check(latest.recipients > 0, "收件人次 > 0（这条连接真实收到了帧）", `recipients=${latest.recipients}`);
    check(latest.kb >= 0, "JSON 字节数字段存在（KB）", `kb=${latest.kb}`);
    check(latest.stringifyMs >= 0, "stringify 耗时字段存在", `stringifyMs=${latest.stringifyMs}`);
    check(latest.avgIntervalMs >= 0, "平均轮间隔字段存在", `avgIntervalMs=${latest.avgIntervalMs}`);

    // monster-ai 轮：怪要自己动（出厂游走间隔 4~9s）或追人才有帧；等它，等不到就是 bug
    const aiLines = await waitFor(
      "monster-ai 统计行（等怪的第一次游走/追击）",
      async () => {
        const lines = parseStatsLines(on.logs(), "monster-ai");
        return lines.length > 0 ? lines : null;
      },
      25_000,
    );
    check(aiLines.length > 0, "monster-ai 统计行出现在 stdout");
    check(aiLines[aiLines.length - 1].frames > 0, "monster-ai 帧条数 > 0（只有有内容才发帧）");

    socket.close();
  } finally {
    await stopServer(on, dbPath1);
  }

  //#endregion

  //#region 二、开关关闭：零输出

  group("二、开关关闭（REALTIME_STATS_INTERVAL_MS=0）：同样的活动，一条统计行都没有");
  const dbPath2 = path.join(os.tmpdir(), `olua-e2e-realtime-stats-off-${Date.now()}.db`);
  const off = await startServer(dbPath2, 0);
  try {
    const socket = await activePlayer(off.baseUrl, "b");
    await sleep(1500);
    check(!off.logs().includes(STATS_PREFIX), "关闭时 stdout 里没有任何统计行（钩子全是空操作）");
    socket.close();
  } finally {
    await stopServer(off, dbPath2);
  }

  //#endregion

  //#region 三、默认值钉在源码上

  group("三、默认值守门：兜底 10s、配置键登记过");
  const serviceSrc = fs.readFileSync(path.join(SERVER_DIR, "src", "modules", "realtime", "realtime.service.ts"), "utf8");
  const configSrc = fs.readFileSync(path.join(SERVER_DIR, "src", "config", "configuration.ts"), "utf8");
  check(
    /realtimeStatsIntervalMs"\)\s*\?\?\s*10_000/.test(serviceSrc),
    "statsMs() 的兜底是 10_000（默认打开，issue 口径）",
  );
  check(
    /REALTIME_STATS_INTERVAL_MS\s*\?\?\s*10 \* 1000/.test(configSrc),
    "configuration.ts 登记 REALTIME_STATS_INTERVAL_MS（env 键真实可覆写）",
  );
  checkEqual(
    (serviceSrc.match(/statsIntervalMs = 10_000/g) || []).length,
    1,
    "字段初始值与兜底一致（bootstrap 前的窗口也不会拿错值）",
  );

  //#endregion

  console.log(`\n${failed === 0 ? "✅" : "❌"} 广播统计：${passed} 条通过 / ${failed} 条失败`);
  if (failed > 0) {
    console.log("\n失败项：");
    failures.forEach((item) => console.log(`  - ${item}`));
    process.exitCode = 1;
  }
})();
