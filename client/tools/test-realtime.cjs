#!/usr/bin/env node
/**
 * 客户端实时通道（ui/utils/net/RealtimeClient）的自动化验证
 *
 * 跑的是**真实代码**：client/tools/lib/net-sandbox.cjs 把 ui/utils/net/* 与 configs/network 编进沙箱；
 * `XMLHttpRequest`（取票据）与 `WebSocket`（建连）都由本测试注入，
 * 于是「票据怎么取、地址怎么拼、心跳发没发、断开之后退避多久」全是真跑的，不是复刻。
 *
 * 盯的不变量：
 * · 地址只由 configs/network.baseUrl 推导（http→ws / https→wss；线上同源相对地址借 location 补全），
 *   握手路径从生成的路由派生（不写第二份路径字面量）
 * · 取票据成功才建连；令牌失效回登录场景并**停止重连**；握手被拒（票据过期之类）只重新取票、不踢玩家
 * · 心跳间隔以服务端 welcome 的 heartbeatMs 为准（没给才用 configs 的兜底）
 * · 心跳无应答 / 握手超时都判掉线（socket 层不会自己发现对端没了）
 * · 重连指数退避且封顶；连上即清零
 * · 被别处顶掉（close 4000）**不**抢回来（否则两个客户端互相踢）
 * · 状态变化按「首次连上 / 掉线 / 重连回来 / 被顶掉」分开报（接线方据此只提示一次，不刷屏）
 *
 * 用法：node client/tools/test-realtime.cjs
 * 找不到 tsc 时可用环境变量指定：TSC=/path/to/typescript/bin/tsc node client/tools/test-realtime.cjs
 */
const fs = require("fs");
const path = require("path");
const { prepareNet } = require("./lib/net-sandbox.cjs");
const { PROJECT_ROOT, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const ASSETS = path.join(PROJECT_ROOT, "assets");
const read = (rel) => fs.readFileSync(path.join(ASSETS, rel), "utf8");

let net;
try {
  net = prepareNet("olua-realtime");
} catch (error) {
  fail(`沙箱准备失败：${error.message}`);
  return;
}

const {
  RealtimeClient,
  RealtimeStatus,
  buildRealtimeUrl,
  realtimePath,
  REALTIME_CLOSE,
  ApiRoutes,
  HttpClient,
  networkConfig,
  Session,
} = net;

//#region 替身：XHR（取票据）与 WebSocket（建连）

/** 造一个统一响应包裹 */
const envelope = (code, message, data) => JSON.stringify({ code, message, data, timestamp: Date.now() });

/** 本次用例里服务端收到过的票据请求（每次用例前清空） */
const requests = [];
/** 当前「服务端」怎么回答取票请求（由用例改写） */
let responder = () => ({ status: 200, text: envelope(0, "请求成功", { ticket: "TK", expiresIn: 30000 }) });

class FakeXHR {
  constructor() {
    this.method = "";
    this.url = "";
    this.headers = {};
    this.body = null;
    this.status = 0;
    this.responseText = "";
  }
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(key, value) {
    this.headers[key] = value;
  }
  send(body) {
    this.body = body;
    requests.push(this);
    const reply = responder(this);
    if (reply.kind === "error") {
      this.status = 0;
      setTimeout(() => this.onerror && this.onerror(), 0);
      return;
    }
    this.status = reply.status;
    this.responseText = reply.text;
    setTimeout(() => this.onload && this.onload(), 0);
  }
}
global.XMLHttpRequest = FakeXHR;

/** 记下「需要重新登录」被触发了几次（令牌失效必须回登录，票据过期绝不能） */
const relogins = [];
HttpClient.setUnauthorizedHandler(() => relogins.push(1));

/** 本次用例创建过的全部连接（每次用例前清空） */
const sockets = [];

/**
 * 假 WebSocket
 *
 * 只实现本类用到的东西：url / readyState / send / close / 四个回调。
 * 另外三个方法模拟服务端的动作：accept（握手完成并发 welcome）、deliver（推一帧）、
 * serverClose（服务端断开）—— 对应真实世界里的三种事件。
 */
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closed = null;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    sockets.push(this);
  }
  send(data) {
    this.sent.push(data);
  }
  close(code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closed = { code: code ?? 1000, reason: reason ?? "", by: "client" };
    // 真实 WebSocket 的 close 回调是异步的
    setTimeout(() => this.onclose && this.onclose({ code: this.closed.code, reason: this.closed.reason }), 0);
  }
  /** 模拟：握手完成（服务端若有 welcome，随后就推过来） */
  accept(welcome) {
    this.readyState = 1;
    if (this.onopen) this.onopen();
    if (welcome) this.deliver(welcome);
  }
  /** 模拟：服务端推一帧（对象会 JSON 序列化；传字符串则原样发，用来试坏帧） */
  deliver(frame) {
    if (this.onmessage) this.onmessage({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }
  /** 模拟：服务端主动断开（带关闭码，如 1001 / 4000） */
  serverClose(code, reason) {
    this.readyState = 3;
    this.closed = { code, reason, by: "server" };
    if (this.onclose) this.onclose({ code, reason });
  }
  /** 模拟：握手被拒 / 连不上 —— 浏览器只给一条 error，紧跟一条没有原因的 1006 */
  reject() {
    this.readyState = 3;
    this.closed = { code: 1006, reason: "", by: "peer" };
    if (this.onerror) this.onerror({});
    if (this.onclose) this.onclose({ code: 1006, reason: "" });
  }
}
global.WebSocket = FakeSocket;

//#endregion

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等到条件成立（超时则返回最后一次结果）—— 不用固定 sleep 卡时序，慢机器上也不会偶红 */
async function waitFor(predicate, timeoutMs = 3000, step = 5) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(step);
  }
  return predicate();
}

/** 记下所有 setTimeout 的延迟（退避的断言用它：只要求「安排过」，不必真等那么久） */
const realSetTimeout = global.setTimeout;
const scheduledDelays = [];
global.setTimeout = (fn, ms, ...rest) => {
  if (typeof ms === "number") scheduledDelays.push(ms);
  return realSetTimeout(fn, ms, ...rest);
};

const welcomeFrame = (heartbeatMs) => ({
  type: "welcome",
  data: { userId: "acc_1", username: "tester", heartbeatMs, serverTime: Date.now() },
});

/** 临时改 configs/network.realtime 的几项，返回还原函数（as const 只是类型层面，运行期可写） */
function tuneRealtime(overrides) {
  const saved = { ...networkConfig.realtime };
  Object.assign(networkConfig.realtime, overrides);
  return () => Object.assign(networkConfig.realtime, saved);
}

/** 每次用例前的清场 */
let changes = [];
function reset() {
  RealtimeClient.stop();
  sockets.length = 0;
  requests.length = 0;
  relogins.length = 0;
  scheduledDelays.length = 0;
  changes = [];
  RealtimeClient.onStatusChange = (change) => changes.push(change);
  responder = () => ({ status: 200, text: envelope(0, "请求成功", { ticket: "TK", expiresIn: 30000 }) });
  Session.save("tk_test", { id: "acc_1", username: "tester", status: "active", onlineRoleId: null, createdAt: 0, lastLoginAt: null });
}

const lastChange = () => changes[changes.length - 1];
const statusOf = () => changes.map((c) => c.status).join(" → ");
/** 退避安排的间隔（把与重连无关的定时器滤掉：握手/应答超时是几十秒，测试自己的轮询是几毫秒） */
const retryDelays = (min, max) => scheduledDelays.filter((ms) => ms >= min && ms <= max);

/** 走完「取票据 → 建连 → welcome」这条正常链路（默认给一个很大的心跳间隔，避免干扰时序断言） */
async function connectOk(heartbeatMs = 600000) {
  RealtimeClient.start();
  await waitFor(() => sockets.length > 0);
  const socket = sockets[sockets.length - 1];
  socket.accept(welcomeFrame(heartbeatMs));
  await delay(0);
  return socket;
}

(async () => {
  console.log("— A. 地址拼装：只由 configs/network.baseUrl 推导 —");

  check(
    realtimePath() === "/realtime" && ApiRoutes.realtime.ticket === "/realtime/ticket",
    "握手路径从生成的路由派生（取票据路由的父段，客户端不写第二份路径字面量）",
    `${realtimePath()} ← ${ApiRoutes.realtime.ticket}`,
  );

  const savedBaseUrl = networkConfig.baseUrl;

  networkConfig.baseUrl = "http://localhost:3100/api";
  check(buildRealtimeUrl("TK") === "ws://localhost:3100/api/realtime?ticket=TK", "http 地址 → ws（本地开发形态）", buildRealtimeUrl("TK"));

  networkConfig.baseUrl = "https://game.example.com/api";
  check(buildRealtimeUrl("TK") === "wss://game.example.com/api/realtime?ticket=TK", "https 地址 → wss（https 页面里连 ws 会被浏览器直接拦掉）", buildRealtimeUrl("TK"));

  globalThis.location = { protocol: "https:", host: "game.example.com" };
  networkConfig.baseUrl = "/api";
  check(buildRealtimeUrl("TK") === "wss://game.example.com/api/realtime?ticket=TK", "线上同源相对地址（/api）借当前页面的协议与主机补全", buildRealtimeUrl("TK"));

  globalThis.location = { protocol: "http:", host: "192.168.1.10:8080" };
  check(buildRealtimeUrl("TK") === "ws://192.168.1.10:8080/api/realtime?ticket=TK", "同源 + http 页面 → ws（局域网调试）", buildRealtimeUrl("TK"));

  check(buildRealtimeUrl("a b/c").indexOf("?ticket=a%20b%2Fc") > 0, "票据进 query 前做 encodeURIComponent", buildRealtimeUrl("a b/c"));

  globalThis.location = undefined;
  networkConfig.baseUrl = savedBaseUrl;

  console.log("\n— B. 未登录不连 —");

  reset();
  Session.clear();
  RealtimeClient.start();
  await delay(30);
  check(requests.length === 0 && sockets.length === 0 && RealtimeClient.status === RealtimeStatus.Idle, "没登录就不建连（否则只会拿到 401，被请求层拽回登录页）", statusOf());

  console.log("\n— C. 正常链路：取票据 → 建连 → welcome —");

  reset();
  const socket = await connectOk();
  check(requests.length === 1 && requests[0].method === "POST" && requests[0].url === `${networkConfig.baseUrl}/realtime/ticket`, "先取票据（POST，路径来自生成的路由）", requests[0] && requests[0].url);
  check(requests[0].headers.Authorization === "Bearer tk_test", "取票据带令牌（请求层统一注入，业务层不自己拼）");
  check(socket.url === buildRealtimeUrl("TK"), "建连地址 = baseUrl 推导出的 ws 地址 + 一次性票据", socket.url);
  check(RealtimeClient.status === RealtimeStatus.Connected && RealtimeClient.onlineUserId === "acc_1", "收到 welcome 才算连上（身份来自服务端的 welcome）", statusOf());
  check(changes.length === 2 && changes[0].status === RealtimeStatus.Connecting && changes[1].status === RealtimeStatus.Connected, "状态先 Connecting 再 Connected");
  check(changes[1].reconnected === false && changes[1].lost === false, "首次连上不算「重连回来」，也不报掉线");
  RealtimeClient.stop();

  console.log("\n— D. 应用层心跳：间隔取自 welcome，且被应答时一直活着 —");

  reset();
  let restore = tuneRealtime({ pongTimeout: 60, reconnectBaseDelay: 600000 });
  const live = await connectOk(20);
  await waitFor(() => live.sent.length > 0, 500);
  check(live.sent[0] === JSON.stringify({ type: "ping" }), "按 welcome 给的 heartbeatMs 发心跳（不是把间隔写死在客户端）", live.sent[0]);
  // 连续应答：应答超时是 60ms，低于它就一定会被判掉线 —— 活着即说明 pong 确实撤掉了判据
  const reply = setInterval(() => live.deliver({ type: "pong", data: { serverTime: Date.now() } }), 20);
  await delay(240);
  clearInterval(reply);
  check(RealtimeClient.status === RealtimeStatus.Connected, "心跳一直有人应 → 连接一直活着（pong 撤掉了应答超时）", statusOf());
  restore();
  RealtimeClient.stop();

  console.log("\n— E. 心跳无应答 = 掉线（socket 层不会自己发现对端没了） —");

  reset();
  restore = tuneRealtime({ pongTimeout: 30, reconnectBaseDelay: 600000 });
  const silent = await connectOk(10);
  // 等状态落地（socket.close() 的 close 回调是异步的，只看 closed 标记会早一步）
  await waitFor(() => RealtimeClient.status === RealtimeStatus.Disconnected, 900);
  check(silent.closed && silent.closed.by === "client", "发 ping 后一直没回音 → 主动关掉这条连接");
  check(RealtimeClient.status === RealtimeStatus.Disconnected, "状态落到 Disconnected", statusOf());
  check(lastChange().lost === true && lastChange().willRetry === true, "「本来连着、刚掉」标成 lost，并说明会重连", JSON.stringify(lastChange()));
  restore();
  RealtimeClient.stop();

  console.log("\n— F. 握手超时：连上了却等不到 welcome —");

  reset();
  restore = tuneRealtime({ handshakeTimeout: 30, reconnectBaseDelay: 600000 });
  RealtimeClient.start();
  await waitFor(() => sockets.length > 0);
  const halfOpen = sockets[sockets.length - 1];
  halfOpen.readyState = 1;
  if (halfOpen.onopen) halfOpen.onopen();
  await waitFor(() => RealtimeClient.status === RealtimeStatus.Disconnected, 900);
  check(halfOpen.closed !== null, "等不到 welcome 的连接会被定时收掉（半开的连接不会自己变成失败）");
  check(RealtimeClient.status === RealtimeStatus.Disconnected && lastChange().lost === false, "从没连上过的断开不标 lost（否则服务端挂了会提示刷屏）", JSON.stringify(lastChange()));
  restore();
  RealtimeClient.stop();

  console.log("\n— G. 取票据失败 → 指数退避重连，且连上即清零 —");

  reset();
  restore = tuneRealtime({ reconnectBaseDelay: 40, reconnectMaxDelay: 120 });
  responder = () => ({ kind: "error", status: 0, text: "" });
  RealtimeClient.start();
  await waitFor(() => retryDelays(40, 120).length >= 3, 3000);
  const delays = retryDelays(40, 120);
  check(delays.length >= 3, "失败之后一直在安排重连", `已安排 ${delays.length} 次`);
  check(delays[0] === 40 && delays[1] === 80 && delays[2] === 120, "退避指数翻倍并封顶（40 → 80 → 封顶 120）", delays.slice(0, 4).join(", "));
  check(sockets.length === 0, "票据都没取到就不建连");

  responder = () => ({ status: 200, text: envelope(0, "请求成功", { ticket: "TK", expiresIn: 30000 }) });
  await waitFor(() => sockets.length > 0, 3000);
  sockets[sockets.length - 1].accept(welcomeFrame());
  await delay(0);
  scheduledDelays.length = 0;
  sockets[sockets.length - 1].serverClose(1006, "网络中断");
  await waitFor(() => retryDelays(40, 120).length >= 1, 1000);
  check(retryDelays(40, 120)[0] === 40, "连上过之后再断，退避从头开始（welcome 把连续失败次数清零）");
  restore();
  RealtimeClient.stop();

  console.log("\n— H. 握手被拒（票据过期之类）：重新取票，不踢玩家回登录页 —");

  reset();
  restore = tuneRealtime({ reconnectBaseDelay: 20 });
  RealtimeClient.start();
  await waitFor(() => sockets.length > 0);
  sockets[0].reject();
  await waitFor(() => requests.length >= 2 && sockets.length >= 2, 1500);
  check(requests.length >= 2 && sockets.length >= 2, "握手被拒 → 重新取一张票再连（票据是一次性的，重连本来就要重取）", `取票 ${requests.length} 次 / 建连 ${sockets.length} 次`);
  check(relogins.length === 0, "这不是令牌失效：**没有**触发「回登录场景」", `relogins=${relogins.length}`);
  check(RealtimeClient.status !== RealtimeStatus.Idle, "连接还在继续（没有停在 Idle）", statusOf());
  restore();
  RealtimeClient.stop();

  console.log("\n— I. 令牌失效：回登录场景并停止重连 —");

  reset();
  restore = tuneRealtime({ reconnectBaseDelay: 20 });
  responder = () => ({ status: 401, text: envelope(40102, "令牌已过期，请重新登录", null) });
  RealtimeClient.start();
  await waitFor(() => RealtimeClient.status === RealtimeStatus.Idle, 1000);
  check(relogins.length === 1, "令牌失效触发了「需要重新登录」（请求层据此清会话回登录场景）", `relogins=${relogins.length}`);
  check(RealtimeClient.status === RealtimeStatus.Idle, "并停止重连（重连也取不到票）", statusOf());
  const requestsOnAuthFail = requests.length;
  await delay(150);
  check(requests.length === requestsOnAuthFail, "不会拿着一张永远取不到的票反复重试", `取票请求 ${requests.length} 次`);
  restore();

  console.log("\n— J. 被别处顶掉（close 4000）：不抢回来 —");

  reset();
  restore = tuneRealtime({ reconnectBaseDelay: 20 });
  const taken = await connectOk();
  taken.serverClose(REALTIME_CLOSE.REPLACED, "已在别处建立新的连接");
  await delay(0);
  check(RealtimeClient.status === RealtimeStatus.Disconnected, "被顶掉 → 断开", statusOf());
  check(lastChange().willRetry === false && lastChange().lost === true, "明确「不会重连」（抢回来只会让两个客户端互相踢）", JSON.stringify(lastChange()));
  const requestsAtDrop = requests.length;
  await delay(150);
  check(requests.length === requestsAtDrop && sockets.length === 1, "确实没有再取票 / 没有再建连", `取票请求仍为 ${requests.length} 次`);
  restore();

  console.log("\n— K. 不认识的帧 / 坏帧不该搞断连接 —");

  reset();
  const tolerant = await connectOk();
  tolerant.deliver({ type: "error", data: { message: "不认识的消息类型：x" } });
  tolerant.deliver("这不是 JSON");
  tolerant.deliver({ type: "将来的业务消息", data: {} });
  await delay(0);
  check(RealtimeClient.status === RealtimeStatus.Connected && tolerant.closed === null, "服务端的 error 帧 / 坏帧 / 将来的业务帧都不该把连接搞断");
  RealtimeClient.stop();

  console.log("\n— L. 停止：断开、不重连、幂等 —");

  reset();
  restore = tuneRealtime({ reconnectBaseDelay: 20 });
  const stoppable = await connectOk();
  RealtimeClient.stop();
  await delay(0);
  check(stoppable.closed && stoppable.closed.code === 1000 && stoppable.closed.by === "client", "stop 主动关（正常关闭码 1000）", JSON.stringify(stoppable.closed));
  check(RealtimeClient.status === RealtimeStatus.Idle, "状态回到 Idle");
  const requestsAtStop = requests.length;
  await delay(150);
  check(requests.length === requestsAtStop, "停止之后不再重连（离开场景就得断干净）");
  RealtimeClient.stop();
  check(RealtimeClient.status === RealtimeStatus.Idle, "stop 幂等（离开场景可能被调多次）");
  restore();

  console.log("\n— M. 进图早于连接：worldJoin 在首次 welcome 补发（#493） —");

  {
    // 真实时序：Game.onLoad 里 RealtimeClient.start() 要取票据 + 握手，建图（spawnAll）常常先跑完，
    // 那时通道还没连上。旧实现只在 `active` 时才登记图 id，于是 lastJoin 永远是空的，
    // welcome 里「只在重连时补发」永远发不出 —— 玩家一直不在世界里（发言被拒、无互见、怪物走本地口径）。
    const { CombatChannel } = net;
    reset();
    // 1) 未连接时登记图 id：只记账，不能抛也不能发
    CombatChannel.sendWorldJoin("map_newbie");
    check(sockets.length === 0, "未连接时登记图 id 不建连（只是记账）");
    // 2) 首次建连（不是重连）→ welcome 后应把这条 worldJoin 补发出去
    const lateSocket = await connectOk();
    await delay(0);
    const frames = lateSocket.sent.map((raw) => {
      try {
        return JSON.parse(raw);
      } catch (e) {
        return { type: "unparsable" };
      }
    });
    const joins = frames.filter((frame) => frame.type === "worldJoin");
    check(joins.length === 1, "首次 welcome 补发进图登记（这条时序下才有救）", `发了 ${joins.length} 条 worldJoin`);
    check(joins.length === 1 && joins[0].data && joins[0].data.mapId === "map_newbie", "补发的就是先前登记的那张图");
    check(changes[changes.length - 1].reconnected === false, "这次仍是「首连」而不是重连（补发不再依赖 reconnected）");
    RealtimeClient.stop();
  }

  console.log("\n— N. 源码断言：接线齐、参数不进代码 —");

  const game = read("ui/Game.ts");
  check(/RealtimeClient\.start\(\)/.test(game) && /RealtimeClient\.stop\(\)/.test(game), "游戏场景进出各接一次（进游戏才连、离开就断）");
  check(/RealtimeClient\.onStatusChange\s*=\s*null/.test(game), "场景卸载时先摘掉状态回调（否则收尾时又提示一句）");
  check(/realtime_disconnected_tip/.test(game) && /realtime_reconnected_tip/.test(game) && /realtime_replaced_tip/.test(game), "断线 / 重连 / 被顶掉三种提示都接了文案 key");

  const source = read("ui/utils/net/RealtimeClient.ts");
  check(!/new XMLHttpRequest/.test(source) && /networkConfig\.baseUrl/.test(source), "用请求层的票据接口（不自己发 HTTP），ws 地址从 configs/network.baseUrl 推");
  check(/networkConfig\.realtime\./.test(source) && !/(setTimeout|setInterval)\s*\([^,]+,\s*\d/.test(source), "时间参数一律取自 configs/network.realtime（不在代码里写可调的数）");

  const codes = read("ui/utils/net/ApiCodes.ts");
  check(/export const REALTIME_CLOSE/.test(codes) && /REPLACED:\s*4000/.test(codes), "关闭码登记在 ApiCodes（服务端常量的手写镜像，跨端逐键比对见 audit-shared-data）");

  // #493：建图时**无条件**登记图 id（连接可能比进图晚，登记要早于 active 判断）
  const spawner = read("ui/components/map/MonsterAreaSpawner.ts");
  check(
    /CombatChannel\.sendWorldJoin\(this\.mapId\);[\s\S]{0,600}?if \(CombatChannel\.active\)/.test(spawner),
    "spawnAll 先无条件 sendWorldJoin 再判 active（否则进图早于连接时 lastJoin 永远是空的）",
  );

  finish("全部通过：取票 / 建连 / 心跳 / 退避 / 顶替处理都符合预期");
})();
