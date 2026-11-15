#!/usr/bin/env node
/**
 * 位置插值单测（client/tools/test-interpolation.cjs，issue #769）
 *
 * 盯的不变量（改同步 / 插值 / 协议时间戳之后必须全绿）：
 * A. **插值器本身**（真代码，喂固定时间序列断言中间点）：边界钳制、线性插值、同 t 覆盖、
 *    乱序丢弃、容量裁剪、丢帧外插上限、moving 取后一帧
 * B. **服务端时钟**：welcome 粗校准、pong 用「发出时刻 + 半程」细校准、渲染时刻 = 此刻 - 延迟
 * C. **两端接线**：帧级 `t` 在协议两侧同形、两个生产点都写了、裁剪后原样带上、
 *    玩家与怪物共用同一个插值器（第二份手写插值 = 迟早漂移成两套手感）
 *
 * 手感参数（renderDelay / 缓冲深度 / 外插上限）**不进断言** —— 它们是调的，不是规矩。
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");
/** PROJECT_ROOT 是 client/ 目录，服务端与根目录下的文件要往上走一层 */
const readRepo = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, "..", rel), "utf8");

const CLIENT_INTERP = "assets/ui/core/SnapshotInterpolator.ts";
const CLIENT_CLOCK = "assets/ui/utils/net/ServerClock.ts";
const CLIENT_OTHER = "assets/ui/core/OtherPlayerManager.ts";
const CLIENT_MONSTER_AI = "assets/ui/core/MonsterAI.ts";
const CLIENT_MONSTER = "assets/ui/core/MonsterManager.ts";
const CLIENT_CHANNEL = "assets/ui/utils/net/CombatChannel.ts";
const CLIENT_REALTIME = "assets/ui/utils/net/RealtimeClient.ts";
const CLIENT_NETWORK = "assets/configs/network.ts";
const SERVER_PROTOCOL = "server/src/modules/realtime/realtime.protocol.ts";
const SERVER_PRESENCE = "server/src/modules/realtime/player-presence.service.ts";
const SERVER_AI = "server/src/modules/realtime/monster-ai.service.ts";
const SERVER_REALTIME = "server/src/modules/realtime/realtime.service.ts";

let sandbox;
try {
  sandbox = prepare("olua-interpolation", ["ui/core/SnapshotInterpolator.ts", "ui/utils/net/ServerClock.ts"]);
} catch (error) {
  fail(`沙箱准备失败：${error.message}`);
  process.exitCode = 1;
}

if (sandbox) {
  const interpModule = require(path.join(sandbox, "ui/core/SnapshotInterpolator.js"));
  const SnapshotInterpolator = interpModule.default ?? interpModule;
  const clockModule = require(path.join(sandbox, "ui/utils/net/ServerClock.js"));
  const ServerClock = clockModule.default ?? clockModule;

  console.log("\n== 一、插值器：边界与线性插值（喂固定时间序列） ==");
  {
    const interp = new SnapshotInterpolator();
    check(interp.sample(1000) === null, "空缓冲返回 null（调用方据此「原地等第一帧」，不造一个原点上的假人）");

    interp.push(1000, 10, 20, false);
    const only = interp.sample(9999);
    check(!!only && only.x === 10 && only.y === 20 && only.moving === false, "只有一条快照：任何渲染时刻都返回它（首次吸附）");

    interp.push(1100, 110, 20, true);
    const mid = interp.sample(1050);
    check(!!mid && mid.x === 60, `两条之间取中点（期望 60，实得 ${mid && mid.x}）`);
    check(!!mid && mid.moving === true, "moving 取**后一帧**的口径（布尔插值没有意义）");

    const exact = interp.sample(1100);
    check(!!exact && exact.x === 110, "正好落在快照时刻上时取该快照的位置（不产生浮点漂移）");

    const early = interp.sample(10);
    check(!!early && early.x === 10, "渲染时刻早于所有快照：钳到最旧那条（别把刚进视野的人画在原点）");
  }

  console.log("\n== 二、插值器：缓冲生命周期（同 t / 乱序 / 容量 / 外插） ==");
  {
    const interp = new SnapshotInterpolator(4, 100);
    interp.push(1000, 0, 0, false);
    interp.push(1000, 50, 0, false);
    check(interp.sample(1000).x === 50, "同一个 t 再压一次是**覆盖**（否则缓冲里出现零长度段，速度算出 Infinity）");

    interp.push(900, -999, -999, false);
    check(interp.newest.t === 1000 && interp.sample(1000).x === 50, "比最后一条还旧的快照被丢弃（缓冲必须按 t 单调）");

    // 容量 4：压 5 条，最旧的应当被挤掉
    const ring = new SnapshotInterpolator(4, 100);
    for (let i = 0; i < 5; i += 1) ring.push(1000 + i * 100, i * 10, 0, true);
    check(ring.sample(1000).x === 10, `超出容量从最旧的丢（渲染时刻 1000 应拿到第二条的 10，实得 ${ring.sample(1000).x}）`);
    check(ring.newest.t === 1400, "最新的那条永远留着");

    // 丢帧：渲染时刻跑到最后一帧之后 —— 沿最后一段速度外插，但最多 maxExtrapolate
    const gap = new SnapshotInterpolator(4, 100);
    gap.push(1000, 0, 0, true);
    gap.push(1100, 100, 0, true);
    check(gap.sample(1180).x === 180, `外插未到上限时按最后一段速度推（期望 180，实得 ${gap.sample(1180).x}）`);
    check(gap.sample(5000).x === 200, `外插到上限就停住，不无限往前（期望 200，实得 ${gap.sample(5000).x}）`);
    check(gap.sample(5000).x === gap.sample(99999).x, "停在同一个点上：渲染时刻再老也不动（表现为「站着等新帧」，不是瞬移）");
  }

  console.log("\n== 三、服务端时钟：粗校准 / 细校准 / 渲染时刻 ==");
  {
    ServerClock.reset();
    check(ServerClock.skew === 0 && ServerClock.now(1000) === 1000, "未校准时偏差 0、now 就是本地时刻（两端都是 epoch 毫秒，偏差不大也能跑）");

    // welcome：服务端说 100000，本地收到时是 90000 → 本地慢 10 秒
    ServerClock.sync(100000, null, 90000);
    check(ServerClock.now(90000) === 100000, "welcome 只给服务端时刻：偏差 = 服务端时刻 - 本地收帧时刻");

    // pong：本地 99000 发出、99500 收到，服务端处理时是 100000
    // 服务端那一刻发生在我方发出后半程 → 此刻服务端 = 100000 + 250 = 100250
    ServerClock.sync(100000, 99000, 99500);
    check(ServerClock.now(99500) === 100250, `pong 扣掉半程时延再校准（期望 100250，实得 ${ServerClock.now(99500)}）`);
    check(ServerClock.renderTime(120, 99500) === 100130, "渲染时刻 = 服务端此刻 - 渲染延迟");

    ServerClock.reset();
    check(ServerClock.skew === 0, "reset 归零（换账号 / 换服务器时用）");
  }

  console.log("\n== 四、协议：帧级时间戳两端同形 ==");
  {
    const serverProtocol = readRepo(SERVER_PROTOCOL);
    const clientChannel = read(CLIENT_CHANNEL);
    const playersBlock = /export interface RealtimePlayersMessage \{[\s\S]*?\n\}/.exec(serverProtocol);
    const aiBlock = /export interface RealtimeMonsterAiMessage \{[\s\S]*?\n\}/.exec(serverProtocol);
    check(!!playersBlock && /^ {4}t: number;/m.test(playersBlock[0]), "服务端 players 帧带帧级 t（毫秒）");
    check(!!aiBlock && /^ {4}t: number;/m.test(aiBlock[0]), "服务端 monster-ai 帧带帧级 t（与 players 同口径）");

    const clientPlayers = /export interface PlayersFrame \{[\s\S]*?\n\}/.exec(clientChannel);
    const clientAi = /export interface MonsterAiFrame \{[\s\S]*?\n\}/.exec(clientChannel);
    check(!!clientPlayers && /^ {2}t: number;/m.test(clientPlayers[0]), "客户端 PlayersFrame 同形（t 必填 —— 协议同批发）");
    check(!!clientAi && /^ {2}t: number;/m.test(clientAi[0]), "客户端 MonsterAiFrame 同形");
  }

  console.log("\n== 五、服务端生产点：三个写 t 的口子 + 裁剪保留 ==");
  {
    const presence = readRepo(SERVER_PRESENCE);
    const ai = readRepo(SERVER_AI);
    const realtime = readRepo(SERVER_REALTIME);
    check((presence.match(/t: tickAt/g) || []).length === 1, "增量帧用**一拍一个** tickAt（各图各取 Date.now() 会差出几毫秒）");
    check(/t: Date\.now\(\), full: true/.test(presence), "全量快照帧也带 t（刚进图那几帧要能当插值基准）");
    check(/t: Date\.now\(\), full: false/.test(presence), "离开帧带 t（没有坐标，但形状上必须齐）");
    check(/t: Date\.now\(\), monsters/.test(ai), "怪物帧在广播出口写 t");
    check(/t: data\.t/.test(realtime), "按格裁剪后**原样带上** t（丢了客户端只能退回收帧时刻）");
  }

  console.log("\n== 六、客户端接线：两个远端实体共用同一个插值器 ==");
  {
    const other = read(CLIENT_OTHER);
    const monsterAi = read(CLIENT_MONSTER_AI);
    const monster = read(CLIENT_MONSTER);
    const realtime = read(CLIENT_REALTIME);
    const network = read(CLIENT_NETWORK);

    check(/import SnapshotInterpolator from "\.\/SnapshotInterpolator"/.test(other), "远端玩家用 SnapshotInterpolator");
    check(/import SnapshotInterpolator from "\.\/SnapshotInterpolator"/.test(monsterAi), "怪物用**同一个** SnapshotInterpolator（不写第二份插值）");
    check(!/SERVER_CATCHUP_SECONDS/.test(monsterAi), "旧「同速追击 + 追赶时长」已退役（它永远差最后几像素）");
    check(!/const factor = Math\.min\(1, \(deltaTime \/ 0\.15\)/.test(other), "旧的指数逼近系数已删（每帧走一半 = 渐近到不了 + 延迟随帧率抖）");
    check((other.match(/ServerClock\.renderTime\(/g) || []).length === 1, "玩家的渲染时刻**一帧取一次**（各算各的会让同一帧的人互相错开）");
    check(/ServerClock\.renderTime\(/.test(monsterAi), "怪物同样按服务端时间回放");
    check(/applyServerState\(node, entry\.x, entry\.y, entry\.mv, data\.t\)/.test(monster), "MonsterManager 把帧级 t 传进插值器");
    check(/positions\.push\(t, entry\.x, entry\.y, entry\.mv\)/.test(other), "玩家快照按帧 t 压入（不是本地收帧时刻）");
    check(/positions\.push\(t, x, y, moving\)/.test(monsterAi), "怪物快照按帧 t 压入");

    check(/ServerClock\.sync\(data\.serverTime\)/.test(realtime), "welcome 粗校准（没有 RTT 补偿）");
    check(/ServerClock\.sync\(data\.serverTime, this\.pingSentAt\)/.test(realtime), "pong 用发出时刻细校准（扣掉半程时延）");
    check(/this\.pingSentAt = Date\.now\(\);/.test(realtime), "ping 一律记发出时刻（RTT 入账仍由诊断开关控制，校准不依赖它）");

    check(/interpolation: \{[\s\S]*?renderDelay: \d+/.test(network), "插值参数（渲染延迟 / 缓冲深度 / 外插上限）集中在 configs/network");
  }

  finish("PASS：插值器行为 / 服务端时钟 / 两端 t 同形 / 玩家与怪物共用插值器全部通过。");
}
