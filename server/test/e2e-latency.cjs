#!/usr/bin/env node
/**
 * 服务端 e2e：端到端延迟探针（#1043 / epic #772 的收口件）
 *
 * ## 这一套在干什么
 *
 * `#772`（415ms → 200ms）五个子项全关了，但 epic 一直关不掉：完成标志要「延迟数字」，
 * 而 `docs/28` §七验收表最后一行至今写着**「人工：用 #767 的测量脚本量端到端延迟」**。
 * 人工观测不可复现、也不进任何门禁 —— 这一套把它换成一条能随时重跑的命令。
 *
 * 量两段真实链路（两个 WS 连接、同一张图、同一个世界进程，全程 loopback）：
 *
 * | 指标 | 起点 | 终点 |
 * |---|---|---|
 * | **位移广播** | A 发 `pos` 帧的那一刻 | B 收到含 A 某个坐标的 `players` 广播帧 |
 * | **出手回执** | A 发 `cast` 帧 | A 收到带同一个 `castId` 的 `settle` 帧 |
 *
 * 位移那段**刻意把「等下一拍广播」算进去**：10Hz 的广播节拍本来就会贡献 0~100ms，
 * 玩家体感到的正是这个合计数，把它减掉就成了自欺欺人的数字。
 *
 * ## 断言的边界（2026-11-15 用户拍板：数字只给人看）
 *
 * - **不设阈值、不断言毫秒数**：宿主机负载、CI 分片并发都会让数字漂；`docs/28` 的
 *   「< 200ms」是体验目标，不是回归判据。写进断言只会变成「机器一忙就红」的假失败；
 * - 断言只落在**结构与尺子本身**：分位数函数的行为（纯函数自检）、每个采样点都到达、
 *   收到的是谁的条目、`castId` 一一对上、`p50 ≤ p95 ≤ max`；
 * - 分位数打印给人看，并排一列「目标 200ms」——**是否达标由人判断，不由 CI 判断**。
 *
 * ## 为什么要预热
 *
 * 前几个采样点会撞上首帧建 AOI、JIT、连接缓冲这些一次性开销（本机实测首帧常在 200ms+）。
 * 所以前 `WARMUP` 个样本**单独打一行、不并入分位数** —— 混进去只会让 p95 变成
 * 「第一次跑得有多冷」的度量，而不是稳态延迟。
 *
 * 用法：npm run test:e2e:latency（前置 `npm run build`，e2e 跑 dist/）
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { placeRolesAt } = require("./lib/place-role.cjs");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/**
 * 被测地图：图 3（雪域高原）
 *
 * 选它有两个具体的理由，都跟「测量不许被别的东西打断」有关：
 * 1. 图 3 有 2394 血的怪 —— 二十发打不死，回执样本不会被 `target_dead` 提前截断；
 *    图 1 的怪只有 65 血，一发一只，而全图只有 12 只（两片刷怪区各 max 6）。
 * 2. 站位可以选在**所有刷怪区之外**（见 SPOT），两个角色全程不挨打 ——
 *    否则「被怪打死」会让后续采样全部失效，那就不是在量延迟了。
 */
const MAP_ID = "3";
/** 管理端请求所在的区（#960 惯例：一个 e2e 进程一个区，与其它套件同值） */
const ADMIN_ZONE = 1;
/**
 * 站桩点：图 3 左下角空地
 *
 * 离最近的刷怪区（中心 1339,-5338，半高约 612）还有 1900px 以上，
 * 超出 AOI 半径（3×3 格 = 1536px），怪看不见我们、也就不会来打。
 * 两人重合站（AOI 内才互相看得见）。
 */
const SPOT = { x: 1000, y: -7900 };
/** 上报血量：够高，全程不被打死（死了会触发复活重定位，干扰位移样本） */
const HP = 5000;

/** 位移采样：个数 / 预热（不并入分位数）/ 间隔 / 备用点（抵掉偶发的「两拍并一拍」） */
const POS_SAMPLES = 30;
const POS_WARMUP = 5;
/**
 * 备用采样点
 *
 * 服务端的广播是「按拍读当前坐标」，两次上报若刚好落进同一拍（事件循环卡一下就会），
 * 前一个坐标永远不会被广播出去 —— 这不是延迟，是采样的固有损耗。多发几个备用点，
 * 让「稳态样本数够 30」成为可满足的要求，而不是赌机器不抖。
 */
const POS_SPARE = 6;

/**
 * 位移采样间隔
 *
 * 必须**明显大于一个广播拍**（10Hz = 100ms）：两个坐标落进同一拍时，服务端只会广播后一个，
 * 前一个采样点就永远等不到 —— 那是采样设计的问题，不是链路的延迟。250ms 留了两拍半余量。
 */
const POS_GAP_MS = 250;
/** 相邻采样点的 x 间距：4px（1px 太密，收到 ±1 的取整就分不清是哪一点了） */
const POS_STEP_X = 4;

/** 出手采样：个数 / 间隔（有效冷却 = 250ms，400ms 保证大多数能真的打进去） */
const CAST_SAMPLES = 20;
const CAST_GAP_MS = 400;

//#region 断言与工具（与其余 e2e 同款口径）

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

function group(label) {
  console.log(`\n▶ ${label}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (label, predicate, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(25);
  }
  check(false, `${label}（等待超时）`);
  return last;
};

/**
 * 单调时钟（毫秒，带小数）
 *
 * 不用 `Date.now()`：它会被 NTP 校时往回拨，而这里量的是几十毫秒级的差值，
 * 一次回拨就能把样本变成负数。
 */
const nowMs = () => Number(process.hrtime.bigint()) / 1e6;

//#endregion

//#region 分位数（纯函数，本套唯一的"尺子"）

/**
 * 线性插值分位数（与 Excel `PERCENTILE.INC` / numpy 默认同口径）
 *
 * 为什么不用「排序后取第 k 个」：30 个样本时 p95 会退化成 max，看不出尾部趋势。
 * 插值口径下 p95 落在最后两个样本之间，抖动才看得见。
 *
 * @param {number[]} sorted 已升序排列的样本
 * @param {number} q 0~100
 * @returns {number|null} 空数组返回 null（不是 0 —— 0 会被误读成"延迟为零"）
 */
function percentile(sorted, q) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = (sorted.length - 1) * (q / 100);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

/** 一份样本的汇总（p50 / p95 / max 与样本数） */
function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.length ? sorted[sorted.length - 1] : null,
    min: sorted.length ? sorted[0] : null,
  };
}

const formatMs = (value) => (value === null || value === undefined ? "-" : `${value.toFixed(1)}ms`);

/** 一行汇总（`n=30 p50=52.1ms p95=98.4ms max=104.2ms`） */
const summaryLine = (summary) =>
  `n=${summary.n} p50=${formatMs(summary.p50)} p95=${formatMs(summary.p95)} max=${formatMs(summary.max)}`;

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

/**
 * 起一台服务
 *
 * **不覆盖任何节拍参数** —— 这一套量的就是出厂节拍下的端到端延迟，
 * 把 `WORLD_TICK_MS` 调小等于测一个线上不存在的配置。
 * 只关掉两件会打扰采样的事：重生（会重置世界）、地图闲置卸载（会把广播停掉）。
 */
async function startServer(dbPath) {
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
      JWT_SECRET: "e2e-latency-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      ADMIN_REGISTER_CODE: "latency-admin",
      // 采样期间别让世界被重置（重生 / 闲置卸载都会把广播打断）
      WORLD_RESPAWN_MS: "600000",
      WORLD_MAP_IDLE_MS: "0",
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
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** 一条会话化 WS 连接（只记 world 帧与 settle 帧；位置帧由探针旁挂监听） */
function connect(url, accountId) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    accountId,
    opened: false,
    worlds: [],
    seq: 0,
    sendPos(x, y) {
      socket.send(JSON.stringify({ type: "pos", data: { mapId: MAP_ID, x, y, hp: HP } }));
    },
    /** 发一发，返回它的 castId（不等待） */
    fire(body) {
      session.seq += 1;
      const castId = session.seq;
      socket.send(JSON.stringify({ type: "cast", data: { castId, ...body } }));
      return castId;
    },
    async joinWorld(mapId = MAP_ID, timeoutMs = 10_000) {
      const before = session.worlds.length;
      socket.send(JSON.stringify({ type: "worldJoin", data: { mapId } }));
      return waitFor(
        `mapId=${mapId} 的 world 帧`,
        async () => {
          const hits = session.worlds.slice(before).filter((frame) => frame.mapId === mapId);
          return hits.length > 0 ? hits[hits.length - 1] : null;
        },
        timeoutMs,
      );
    },
    /** 把位置报过去并等到服务端确实记住了（靠自己的条目回显；位移闸出厂 log 档，大跳也接受） */
    async moveTo(x, y, timeoutMs = 8_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        session.sendPos(x, y);
        await sleep(120);
        const self = selfPos.get(accountId);
        if (self && Math.abs(self.x - x) <= 1 && Math.abs(self.y - y) <= 1) return true;
      }
      return false;
    },
  };
  /** 自己最新一条位置（探针与 moveTo 共用一份，避免挂两个监听） */
  const selfPos = new Map();

  socket.on("open", () => {
    session.opened = true;
  });
  socket.on("message", (raw) => {
    let frame;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!frame || !frame.data) return;
    if (frame.type === "world") session.worlds.push(frame.data);
    if (frame.type === "players") {
      for (const player of frame.data.players || []) {
        if (player.a === accountId) selfPos.set(accountId, player);
      }
    }
  });
  socket.on("error", () => {});
  return session;
}

/**
 * 旁挂一个位移探针在**观察者**连接上
 *
 * 判据是「收到的 `players` 帧里出现了我发过的那个坐标」：x 在每个采样点唯一，
 * 所以不需要任何额外字段（也就不会为了测试改协议）。
 *
 * @param session 观察者连接
 * @param subjectId 被观察者的账号 id（`players` 条目里的 `a`）
 * @param probe `{ sentAt: Map<x, {at, index}>, samples: Array<{index, ms}>, foreign: number }`
 */
function attachPosProbe(session, subjectId, probe) {
  session.socket.on("message", (raw) => {
    let frame;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!frame || frame.type !== "players" || !frame.data) return;
    for (const player of frame.data.players || []) {
      const sent = probe.sentAt.get(player.x);
      if (sent === undefined) continue;
      if (player.a !== subjectId) {
        // 同一个坐标出现在别人的条目上：理论上不可能（采样点是唯一值），
        // 真出现就说明匹配逻辑错了，不能静默算进样本
        probe.foreign += 1;
        continue;
      }
      probe.sentAt.delete(player.x);
      probe.samples.push({ index: sent.index, ms: nowMs() - sent.at });
    }
  });
}

/**
 * 旁挂一个出手探针在**施法者**连接上
 *
 * 按 `castId` 配对：服务端对每一发都会回 `settle`（ok 或 rejected 都有），
 * 所以「配对成功数 == 发送数」就是「回执链路没有丢帧」的结构判据。
 *
 * @param probe `{ sentAt: Map<castId, 时刻>, samples: Array<{ ms, ok, rejected }> }`
 */
function attachSettleProbe(session, probe) {
  session.socket.on("message", (raw) => {
    let frame;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!frame || frame.type !== "settle" || !frame.data) return;
    const castId = frame.data.castId;
    const sentAt = probe.sentAt.get(castId);
    if (sentAt === undefined) return;
    probe.sentAt.delete(castId);
    probe.samples.push({ ms: nowMs() - sentAt, ok: frame.data.ok === true, rejected: frame.data.rejected || null });
  });
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-latency-${Date.now()}.db`);
  const server = await startServer(dbPath);
  const { baseUrl } = server;
  try {
    //#region 一、尺子本身（纯函数）

    group("一、分位数口径（先证明尺子是对的，再拿它量东西）");
    check(percentile([], 50) === null, "空样本返回 null（不是 0 —— 0 会被读成「零延迟」）");
    check(percentile([7], 50) === 7, "单样本 p50 就是它自己", String(percentile([7], 50)));
    check(percentile([1, 2, 3, 4], 50) === 2.5, "偶数个样本的中位数取中间两个的均值（线性插值）", String(percentile([1, 2, 3, 4], 50)));
    check(
      Math.abs(percentile([1, 2, 3, 4], 95) - 3.85) < 1e-9,
      "p95 落在最后两个样本之间（不是直接取 max：30 个样本时取 max 会看不出尾部）",
      String(percentile([1, 2, 3, 4], 95)),
    );
    check(percentile([10, 20], 0) === 10 && percentile([10, 20], 100) === 20, "0 与 100 分位分别等于最小与最大");
    const shape = summarize([30, 10, 20]);
    check(
      shape.n === 3 && shape.min === 10 && shape.max === 30 && shape.p50 <= shape.p95 && shape.p95 <= shape.max,
      "汇总：n 对、p50 ≤ p95 ≤ max（分位数必然同序，反了就说明排序丢了）",
      summaryLine(shape),
    );
    check(summarize([5]).p95 === 5, "单样本时 p95 也是那个值（不是 null）", String(summarize([5]).p95));

    //#endregion

    //#region 准备：两个账号 / 角色 / 连接

    // #1084 重排后图 3 不再有出厂刷怪区（全部 220 区在图 0）：出手回执段要一只
    // 「二十发打不死的满血靶子」，起服后直接给图 3 播种一只 60 级 boss（27 万血，
    // 1 级角色的伤害被等级压制压到 0，样本全落在同一只身上）——必须在玩家进图
    // （房间创建）之前灌进去，房才会在播种时读到它
    const latencyAdminReg = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "latency_admin", password: "Latency#1", registerCode: "latency-admin" },
    });
    const latencyAdminToken = latencyAdminReg.data && latencyAdminReg.data.token;
    check(!!latencyAdminToken, "准备：管理员已登录（给图 3 播种靶子用）", latencyAdminReg.message);
    const bossSeed = await api(baseUrl, "POST", `admin/maps/${MAP_ID}/spawn-areas`, {
      token: latencyAdminToken,
      zoneId: ADMIN_ZONE,
      body: { name: "延迟靶子区", monsterKey: "220", count: 1, cx: 3000, cy: -3000, w: 200, h: 200 },
    });
    check(bossSeed.status === 201 || bossSeed.code === 0, "准备：图 3 已播种 60 级 boss（满血靶子）", JSON.stringify(bossSeed.body ?? bossSeed.data ?? bossSeed));

    group("准备：两个账号、两条实时连接、同一间房");
    const accounts = [];
    for (const name of ["latency_mover", "latency_observer"]) {
      const registered = await api(baseUrl, "POST", "auth/register", { body: { username: name, password: "pass1234" } });
      accounts.push({ token: registered.data && registered.data.token, accountId: registered.data && registered.data.account && registered.data.account.id });
    }
    check(accounts.every((one) => one.token && one.accountId), "准备：两个玩家账号已注册");
    for (const [index, one] of accounts.entries()) {
      await api(baseUrl, "POST", "roles", { token: one.token, body: { name: `延迟${index + 1}`, occupation: "1", sex: "1" } });
    }
    // #859 起没有位置记录的角色只准进新手村：先把位置写进存档（等价管理端 PATCH onMap）
    placeRolesAt(dbPath, MAP_ID);

    const connectAs = async (one, label) => {
      const ticket = await api(baseUrl, "POST", "realtime/ticket", { token: one.token });
      const session = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`, one.accountId);
      await waitFor(`${label} 握手成功`, async () => (session.opened ? session : null));
      return session;
    };
    const mover = await connectAs(accounts[0], "A（发位移 / 出手）");
    const observer = await connectAs(accounts[1], "B（看 A 的位移）");
    check(mover.opened && observer.opened, "准备：两条实时连接已建立");

    const worldMover = await mover.joinWorld(MAP_ID);
    const worldObserver = await observer.joinWorld(MAP_ID);
    check(!!worldMover && !!worldObserver, "准备：两个角色都在同一张图里");
    check(await mover.moveTo(SPOT.x, SPOT.y), `准备：A 站到 (${SPOT.x}, ${SPOT.y})`);
    check(await observer.moveTo(SPOT.x, SPOT.y), `准备：B 站到同一点（AOI 内才互相看得见）`);
    // 让 AOI 与广播都进入稳态：首拍要建视野、第二拍才开始稳定发同一条目
    await sleep(600);

    //#endregion

    //#region 二、位移广播延迟

    group("二、位移广播：A 发 pos → B 收到含该坐标的 players 帧");
    const posProbe = { sentAt: new Map(), samples: [], foreign: 0 };
    attachPosProbe(observer, mover.accountId, posProbe);

    const totalPosSamples = POS_WARMUP + POS_SAMPLES + POS_SPARE;
    for (let index = 0; index < totalPosSamples; index += 1) {
      const x = SPOT.x + index * POS_STEP_X;
      posProbe.sentAt.set(x, { at: nowMs(), index });
      mover.sendPos(x, SPOT.y);
      await sleep(POS_GAP_MS);
    }
    // 判据是「够不够量」而不是「一个都不能掉」：偶发的两拍并一拍是采样损耗（见 POS_SPARE），
    // 拿它判红只会变成「机器一忙就红」
    await waitFor("稳态样本攒够", async () => (posProbe.samples.filter((sample) => sample.index >= POS_WARMUP).length >= POS_SAMPLES ? true : null), 8_000);
    await sleep(150);

    const arrived = totalPosSamples - posProbe.sentAt.size;
    const steadyAll = posProbe.samples.filter((sample) => sample.index >= POS_WARMUP);
    const warmAll = posProbe.samples.filter((sample) => sample.index < POS_WARMUP);
    check(posProbe.foreign === 0, "B 收到的都是 A 的条目（同坐标出现在别人身上算匹配写错）", `foreign=${posProbe.foreign}`);
    check(
      new Set(posProbe.samples.map((sample) => sample.index)).size === posProbe.samples.length,
      "每个采样点最多计一次（不重复计数）",
      `样本 ${posProbe.samples.length} / 去重 ${new Set(posProbe.samples.map((sample) => sample.index)).size}`,
    );
    check(steadyAll.length >= POS_SAMPLES, `稳态样本攒够 ${POS_SAMPLES} 个（多发 ${POS_SPARE} 个备用点抵掉并拍损耗）`, `到达 ${arrived} / ${totalPosSamples}，其中稳态 ${steadyAll.length}`);
    console.log(`  采样：发送 ${totalPosSamples} / 落地 ${arrived}（掉 ${totalPosSamples - arrived} 个，被同一拍并掉的不算延迟）`);

    const posWarm = summarize(warmAll.map((sample) => sample.ms));
    const posSteady = summarize(steadyAll.map((sample) => sample.ms));
    check(posSteady.p50 <= posSteady.p95 && posSteady.p95 <= posSteady.max, "位移分位数同序（p50 ≤ p95 ≤ max）", summaryLine(posSteady));
    console.log(`  预热（不并入分位数）：${summaryLine(posWarm)}`);
    console.log(`  位移广播：${summaryLine(posSteady)}`);

    //#endregion

    //#region 三、出手回执延迟

    group("三、出手回执：A 发 cast → A 收到带同一 castId 的 settle 帧");
    /**
     * 现拉一只血最厚的满血靶子（图 3 上那只 2394 血的血牛）
     *
     * 为什么不每发都换一只：图 1 的怪一发就死、全图只有 12 只，换着打只能凑 12 个样本；
     * 图 3 的血牛二十发都打不死（1 级角色打它伤害被等级差压到 0），二十个样本落在同一只身上，
     * 量的才是同一条链路。每 5 发重挑一次只是兜底：万一它真被打死了，立刻换下一只满血的。
     */
    const pickTarget = async () => {
      const snapshot = await mover.joinWorld(MAP_ID);
      const alive = ((snapshot && snapshot.monsters) || []).filter((monster) => monster.alive && monster.hp === monster.maxHp);
      return alive.slice().sort((left, right) => right.maxHp - left.maxHp)[0] || null;
    };
    let target = await pickTarget();
    check(!!target, "准备：图里有满血的靶子可打", target ? `${target.instanceId}/${target.maxHp}血` : "无");

    const castProbe = { sentAt: new Map(), samples: [] };
    attachSettleProbe(mover, castProbe);
    let fired = 0;
    for (let index = 0; index < CAST_SAMPLES; index += 1) {
      if (!target) break; // 一只满血靶子都找不到：下面按实际发出的发数断言，不硬凑 20
      if (index > 0 && index % 5 === 0) target = (await pickTarget()) || target;
      const castId = mover.fire({ skillId: "1000", targetId: target.instanceId, monsterKey: target.monsterKey });
      castProbe.sentAt.set(castId, nowMs());
      fired += 1;
      await sleep(CAST_GAP_MS);
    }
    check(fired === CAST_SAMPLES, `${CAST_SAMPLES} 发都发出去了（靶子够用）`, `发出 ${fired}`);
    await waitFor("出手回执全部配对", async () => (castProbe.sentAt.size === 0 ? true : null), 3_000);
    await sleep(150);

    const settled = fired - castProbe.sentAt.size;
    check(settled === fired && fired > 0, `每一发都收到了回执（castId 一一对上）`, `配对 ${settled} / ${fired}`);
    const okCount = castProbe.samples.filter((sample) => sample.ok).length;
    // 「至少有一发真的结算成功」：全是 rejected 的话，量到的是判定链早退的往返，
    // 不是「打到怪身上再回来」的那条路 —— 那样这份数字会好看但没意义
    check(okCount > 0, "至少有一发真的结算成功（量的不是判定链早退的往返）", `ok ${okCount} / ${castProbe.samples.length}`);
    const castSummary = summarize(castProbe.samples.map((sample) => sample.ms));
    check(castSummary.p50 <= castSummary.p95 && castSummary.p95 <= castSummary.max, "回执分位数同序（p50 ≤ p95 ≤ max）", summaryLine(castSummary));
    // 驳回原因两代字段都读（`rejected` 是现行、`code` 是老客户端兼容位）
    const rejections = castProbe.samples.filter((sample) => !sample.ok).map((sample) => sample.rejected || sample.code || "unknown");
    const rejectionBreakdown = rejections.length ? ` / 驳回 ${rejections.length}（${[...new Set(rejections)].join(",")}）` : " / 全部结算成功";
    console.log(`  出手回执：${summaryLine(castSummary)}（ok ${okCount}${rejectionBreakdown}）`);

    //#endregion

    //#region 四、给人看的结论（**不判阈值**）

    group("四、两段延迟一览（目标 200ms，是否达标由人判断）");
    const target200 = 200;
    const verdictOf = (value) => (value === null ? "样本不足" : value <= target200 ? "达标" : "超目标");
    console.log(`  位移广播（含 10Hz 广播节拍）  p50 ${formatMs(posSteady.p50)}  p95 ${formatMs(posSteady.p95)}  max ${formatMs(posSteady.max)}  → p95 ${verdictOf(posSteady.p95)}`);
    console.log(`  出手回执（cast → settle）    p50 ${formatMs(castSummary.p50)}  p95 ${formatMs(castSummary.p95)}  max ${formatMs(castSummary.max)}  → p95 ${verdictOf(castSummary.p95)}`);
    console.log("  （数字随宿主机负载浮动，只作参考；本套不设阈值，见文件头「断言的边界」）");
    check(posSteady.n > 0 && castSummary.n > 0, "两段都有有效样本（没样本的汇总不许当成「延迟为零」）", `位移 ${posSteady.n} / 出手 ${castSummary.n}`);

    //#endregion
  } finally {
    server.child.kill("SIGTERM");
    try {
      require("node:fs").rmSync(dbPath, { force: true });
      require("node:fs").rmSync(`${dbPath}-wal`, { force: true });
      require("node:fs").rmSync(`${dbPath}-shm`, { force: true });
    } catch {
      /* 临时文件清不掉不影响结论 */
    }
  }

  console.log(`\n${failed === 0 ? "✅" : "FAIL："} 端到端延迟探针（#1043）：${passed} 条通过 / ${failed} 条失败`);
  if (failed > 0) {
    console.log("失败项：");
    for (const item of failures) console.log(`- ${item}`);
    process.exit(1);
  }
})();
