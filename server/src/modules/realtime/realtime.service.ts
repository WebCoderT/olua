import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HttpAdapterHost } from "@nestjs/core";
import { randomBytes } from "node:crypto";
import { STATUS_CODES, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { BizCode } from "../../common/constants/biz-code";
import type { ApiEnvelope, AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { AccountRepository } from "../../database/repositories/account.repository";
import { WorldService } from "../world/world.service";
import { RealtimeTicketDto } from "./dto/realtime.dto";
import { CombatSettlementService } from "./combat-settlement.service";
import { MonsterAiService } from "./monster-ai.service";
import { PlayerPresenceService } from "./player-presence.service";
import {
  REALTIME_CLOSE,
  REALTIME_PATH,
  type RealtimeIdentity,
  type RealtimeMonsterAiMessage,
  type RealtimePlayersMessage,
  type RealtimeServerMessage,
  type RealtimeSettleMessage,
  type RealtimeWorldMessage,
} from "./realtime.protocol";

/** 一条已经过鉴权的连接（两个字段由本服务自己维护） */
interface TrackedSocket extends WebSocket {
  /** 上一轮存活探测有没有还 `pong`（还了才算活着，见 sweep） */
  isAlive: boolean;
  /** 这张票据换来的身份 */
  identity: RealtimeIdentity;
  /**
   * 建连那一刻账号的在线角色快照（踢下线巡检的基线）。
   * `undefined` = 还没查到（异步加载中，巡检跳过）；`null` = 建连时账号本就没有在线角色
   * （巡检对它永不生效 —— 没有在线角色的账号谈不上「被踢」）。
   */
  baselineOnlineRoleId?: string | null;
}

/** 一张还没被用掉的票据 */
interface PendingTicket {
  identity: RealtimeIdentity;
  /** 过期时刻（毫秒时间戳） */
  expiresAt: number;
}

/** 取票据的结果：区分「没这张票 / 已用过」与「过期了」，两者给调用方的码不一样 */
type TicketResult = { ok: true; identity: RealtimeIdentity } | { ok: false; code: number; message: string };

/**
 * 票据清理的兜底周期（毫秒，至少一分钟）
 *
 * 刻意**不与票据有效期绑在一起**：清理只是兜底（防「取一堆票就再也不来」把内存撑起来），
 * 而「这张票过期了」这个判断发生在握手那一刻 —— 要是清理跑得跟有效期一样勤，
 * 同一张过期票就有机会先被清掉，于是同一个现象一会儿报「已过期」一会儿报「无效」。
 * 拿不准的事别让调用方去猜：清理慢一点，判断就永远只有一处。
 */
const TICKET_SWEEP_MIN_MS = 60_000;

/** 关闭时留给对端回 close 帧的宽限期（毫秒），到点还没走完的直接强拆 */
const SHUTDOWN_GRACE_MS = 1000;

/**
 * 实时通道（服务端侧）
 *
 * 只做三件事：发票据、按票据建连、把连接养活着。业务消息见 #34。
 *
 * ## 为什么是「票据」而不是「直接拿令牌连」
 * WS 握手没有 `Authorization` 头的便利，而把能用 7 天的访问令牌塞进 URL query 是明确的坏做法
 * （代理日志、浏览器历史、Referer 都会留痕）。所以中间放一层**一次性票据**：
 * - 取票走 `POST /api/realtime/ticket`，那是**普通 HTTP 接口**，全局 AuthGuard 照常生效
 *   —— 令牌校验、回查库、封禁判定、`token_version` 比对一处都没有另写；
 * - 票据是随机字节，与账号的对应关系只存在本进程的内存里，用掉即删、默认 30 秒过期；
 * - 握手时只是**取 AuthGuard 已经得出的结论**。令牌不在这条路径上出现第二次，
 *   也就不存在「两套校验各自漂移」这件事（#33 明确要求的）。
 *
 * ## 单实例
 * 票据与连接都在本进程内存里，所以这是**单实例**的能力。#37 拆进程后本模块整体
 * 搬进 `main.realtime.ts` 的实时进程（仍是单实例，只是换了进程）：取票接口与 WS
 * 走同一个 `/api/realtime*` 路径前缀，nginx 按路径反代，票据不必跨进程共享；
 * 跨进程只剩「踢下线感知」一件难事，由巡检（sweepKicked）轮询库标记解决。
 */
@Injectable()
export class RealtimeService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name);
  /** 未使用的票据：票据 → 身份 + 过期时刻（用过即删） */
  private readonly tickets = new Map<string, PendingTicket>();
  /** 账号 → 当前那条连接（**一个账号只留一条**，见 adopt 的替换规则） */
  private readonly connections = new Map<string, TrackedSocket>();
  private server: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private ticketSweepTimer: NodeJS.Timeout | null = null;
  /** 踢下线巡检定时器（见 sweepKicked；0 = 关闭巡检） */
  private kickPollTimer: NodeJS.Timeout | null = null;
  /** 握手路径（`/<API_PREFIX>/realtime`），bootstrap 时按前缀算出来 */
  private path = `/${REALTIME_PATH}`;
  private closing = false;

  constructor(
    private readonly config: ConfigService,
    private readonly adapterHost: HttpAdapterHost,
    private readonly combat: CombatSettlementService,
    private readonly monsterAi: MonsterAiService,
    private readonly presence: PlayerPresenceService,
    private readonly world: WorldService,
    private readonly accounts: AccountRepository,
  ) {}

  //#region 取票据（HTTP 接口调用）

  /**
   * 签发一张连接票据
   *
   * 调用方必须是**已经过 AuthGuard** 的请求 —— 传进来的就是那份结论，这里不再校验任何东西。
   */
  issueTicket(user: AuthenticatedUser): RealtimeTicketDto {
    this.dropExpiredTickets();
    const ttl = this.ticketTtlMs();
    const ticket = randomBytes(24).toString("base64url");
    this.tickets.set(ticket, { identity: { id: user.id, username: user.username }, expiresAt: Date.now() + ttl });
    return RealtimeTicketDto.of(ticket, ttl);
  }

  //#endregion

  //#region 生命周期

  onApplicationBootstrap(): void {
    const httpServer = this.adapterHost.httpAdapter?.getHttpServer() as HttpServer | undefined;
    if (!httpServer) {
      // 正常不会发生；真发生了要喊出来，而不是让实时通道静默消失（客户端只会看到连不上）
      this.logger.warn("拿不到 HTTP server，实时通道未挂载");
      return;
    }

    const prefix = this.config.get<string>("apiPrefix") ?? "api";
    this.path = `/${prefix}/${REALTIME_PATH}`;
    this.httpServer = httpServer;
    this.server = new WebSocketServer({ noServer: true });
    // 自己接 Upgrade 而不用 @WebSocketGateway：那套会带来第二套「守卫 / 异常」语义，
    // 而这里要的恰恰是「鉴权只有既有那一条路」。自己接还能在拒连时回一个**正常的 HTTP 响应**。
    httpServer.on("upgrade", this.handleUpgrade);

    const heartbeatMs = this.heartbeatMs();
    if (heartbeatMs > 0) {
      // unref：这个定时器不该成为「进程退不出去」的理由
      this.heartbeatTimer = setInterval(() => this.sweep(), heartbeatMs).unref();
    }
    const sweepMs = this.ticketTtlMs();
    if (sweepMs > 0) {
      // 票据的清理有两道：取票时顺手清一次（对付「一直取票」），再加这个兜底（对付「取一堆就停」）
      this.ticketSweepTimer = setInterval(() => this.dropExpiredTickets(), Math.max(sweepMs, TICKET_SWEEP_MIN_MS)).unref();
    }
    const kickPollMs = this.kickPollMs();
    if (kickPollMs > 0) {
      // 踢下线巡检：跨进程形态下（#37）管理端在本进程之外清在线角色标记，
      // 这里轮询库把「已被踢 / 已登出」的连接断掉；内嵌形态下它同样生效
      // （把「踢下线只清标记、连接要等下一次操作才被拒」的欠账一并补上）
      this.kickPollTimer = setInterval(() => this.sweepKicked(), kickPollMs).unref();
    }
    // 世界状态变化（重生等）由世界层通知，这里补上广播出口（世界层不知道连接的存在）
    this.world.onWorldChanged = (zoneId, mapId) => this.broadcastWorld(zoneId, mapId);
    // 怪物 AI 广播（#323）：AI 服务攒好一帧，这里按观看者集合发出去
    this.monsterAi.onBroadcast = (zoneId, mapId, data) => {
      const frame: RealtimeMonsterAiMessage = { type: "monster-ai", data };
      for (const accountId of this.world.viewersOf(zoneId, mapId)) {
        const socket = this.connections.get(accountId);
        if (socket) this.send(socket, frame);
      }
    };
    // 玩家互见广播（#324）：在场表攒好一帧，这里按观看者集合发出去
    this.presence.onBroadcast = (zoneId, mapId, data) => {
      const frame: RealtimePlayersMessage = { type: "players", data };
      for (const accountId of this.world.viewersOf(zoneId, mapId)) {
        const socket = this.connections.get(accountId);
        if (socket) this.send(socket, frame);
      }
    };
    // 快照兜底的定向发送（full 帧只给刚进图的连接自己）
    this.presence.onSendTo = (accountId, data) => {
      const socket = this.connections.get(accountId);
      if (socket) this.send(socket, { type: "players", data } satisfies RealtimePlayersMessage);
    };

    this.logger.log(
      `实时通道已挂载：${this.path}（存活探测 ${heartbeatMs}ms / 票据有效期 ${this.ticketTtlMs()}ms / 踢下线巡检 ${kickPollMs > 0 ? `${kickPollMs}ms` : "关"}）`,
    );
  }

  /** 踢下线巡检间隔（毫秒；0 = 关闭） */
  private kickPollMs(): number {
    return Math.max(0, Number(this.config.get<number>("realtimeKickPollMs") ?? 3000));
  }

  /**
   * 关掉通道（**在 `onModuleDestroy` 而不是 `onApplicationShutdown` 里**）
   *
   * 这里有个必须踩过一次才知道的顺序问题：Nest 的关闭序列是
   * `onModuleDestroy` → `dispose()`（**关 HTTP server，并等所有连接结束**）→ `onApplicationShutdown`。
   * 也就是说，**收连接这件事必须发生在 `dispose()` 之前**：WS 连接是从 HTTP server 上
   * Upgrade 上来的，只要它还开着，`httpServer.close()` 就永远不返回 ——
   * 写在 `onApplicationShutdown` 里就成了「等自己把连接关掉，可自己排在关连接之后」的死锁，
   * 进程只能靠外部超时强杀（`kill -9`），数据库也不会有机会好好收尾。
   *
   * 收的时候讲两遍礼貌：先发 `1001`（对端能知道「是服务端要走」，可以据此重连），
   * 宽限期内没走完的直接 `terminate()` —— 不能让一条不回 close 帧的连接把整个进程拖住。
   */
  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    for (const timer of [this.heartbeatTimer, this.ticketSweepTimer, this.kickPollTimer]) if (timer) clearInterval(timer);
    this.heartbeatTimer = null;
    this.ticketSweepTimer = null;
    this.kickPollTimer = null;
    this.tickets.clear();

    const sockets = [...this.connections.values()];
    this.connections.clear();
    this.httpServer?.off("upgrade", this.handleUpgrade);
    this.httpServer = null;
    this.server?.close();
    this.server = null;

    if (sockets.length > 0) {
      const closed = Promise.all(
        sockets.map(
          (socket) =>
            new Promise<void>((resolve) => {
              socket.once("close", () => resolve());
              socket.close(REALTIME_CLOSE.GOING_AWAY, "服务端正在关闭");
            }),
        ),
      );
      const grace = new Promise<void>((resolve) => {
        // unref：这一步只是兜底，不该成为「进程退不出去」的第二个理由
        setTimeout(resolve, SHUTDOWN_GRACE_MS).unref();
      });
      await Promise.race([closed, grace]);
      for (const socket of sockets) socket.terminate();
    }

    this.logger.log(`实时通道已关闭（断开 ${sockets.length} 条连接）`);
  }

  //#endregion

  //#region 握手

  /**
   * 处理 Upgrade 请求
   *
   * 用箭头属性而不是方法：它要以回调形式交给 `httpServer.on`，`this` 必须绑住。
   */
  private readonly handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // 请求行里的 target 是相对形式（`/api/realtime?ticket=…`），拿 `new URL` 解析得先编一个
    // base 出来 —— 那个 base 就是一个写死在代码里的地址字面量，`tools/audit-api-hardcode.cjs`
    // 会（正确地）把它拦下来。这里要的只是「路径」与「一个查询参数」，手拆更直接也更好读。
    const target = request.url ?? "/";
    const queryAt = target.indexOf("?");
    const pathname = queryAt === -1 ? target : target.slice(0, queryAt);
    const search = queryAt === -1 ? "" : target.slice(queryAt + 1);

    if (pathname !== this.path) {
      this.refuse(socket, 404, BizCode.NOT_FOUND, "接口不存在");
      return;
    }
    if (this.closing) {
      // 已经在关了就别再收新的；否则这条连接刚建好就要被拆掉，对端只会看到一个莫名其妙的断开
      this.refuse(socket, 503, BizCode.INTERNAL, "服务正在关闭，请稍后重试");
      return;
    }

    const ticket = new URLSearchParams(search).get("ticket");
    const result = ticket ? this.consumeTicket(ticket) : { ok: false as const, code: BizCode.TOKEN_INVALID, message: "缺少连接票据" };
    if (!result.ok) {
      this.refuse(socket, 401, result.code, result.message);
      return;
    }

    this.server?.handleUpgrade(request, socket, head, (client) => {
      this.adopt(client as TrackedSocket, result.identity);
    });
  };

  /**
   * 验收一张票据（**用掉即删**）
   *
   * 删了之后第二次拿同一张票来连只会得到「无效或已被使用」—— 票据是一次性的，
   * 这也是它能安全地出现在 URL 里的前提之一。
   */
  private consumeTicket(ticket: string): TicketResult {
    const pending = this.tickets.get(ticket);
    if (!pending) return { ok: false, code: BizCode.TOKEN_INVALID, message: "连接票据无效或已被使用，请重新获取" };
    this.tickets.delete(ticket);
    if (pending.expiresAt <= Date.now()) {
      return { ok: false, code: BizCode.TOKEN_EXPIRED, message: "连接票据已过期，请重新获取" };
    }
    return { ok: true, identity: pending.identity };
  }

  /**
   * 收下一条已过鉴权的连接
   *
   * **一个账号只留一条连接**：新连接上线就把旧的顶掉（旧连接收到 `4000`）。
   * 这样「踢下线」（后面要用）有一个明确的口 —— 清掉 `online_role_id` 之后顺势断掉这条连接即可，
   * 不需要再维护「哪些连接属于谁」的额外状态。被顶掉的那条**不该立刻抢回来**，
   * 否则两条连接会互相踢、来回刷（`4000` 与 `1001` 分开正是为了让客户端能区分这两件事）。
   */
  private adopt(socket: TrackedSocket, identity: RealtimeIdentity): void {
    socket.isAlive = true;
    socket.identity = identity;

    const previous = this.connections.get(identity.id);
    if (previous) {
      this.logger.log(`账号 ${identity.id} 建立了新连接，顶掉原来那条`);
      previous.close(REALTIME_CLOSE.REPLACED, "已在别处建立新的连接");
    }
    this.connections.set(identity.id, socket);
    // 踢下线巡检的基线：建连那一刻账号有没有在线角色（异步查库，查到前巡检跳过这条）
    void this.loadKickBaseline(socket, identity.id);

    socket.on("pong", () => {
      socket.isAlive = true;
    });
    socket.on("message", (raw) => this.onMessage(socket, raw));
    socket.on("error", (error) => this.logger.warn(`实时连接出错（账号 ${identity.id}）：${error.message}`));
    socket.on("close", () => {
      // 只清自己那条：被顶掉的旧连接稍后才走到这里，那时 map 里已经换成新连接了
      if (this.connections.get(identity.id) === socket) {
        this.connections.delete(identity.id);
        // 断开即清结算的幂等账（重连后客户端会重新计数）；世界状态是共享的，不随连接断开而清，
        // 只把「观看者」退掉（空闲回收的依据）。被顶掉的旧连接**不能**清 —— map 里已经是新连接的天下
        this.combat.dropAccount(identity.id);
        this.presence.dropAccount(identity.id);
        this.world.leave(identity.id);
        this.monsterAi.dropAccount(identity.id);
      }
    });

    this.send(socket, {
      type: "welcome",
      data: {
        userId: identity.id,
        username: identity.username,
        heartbeatMs: this.heartbeatMs(),
        serverTime: Date.now(),
      },
    });
  }

  /**
   * 收到一条消息
   *
   * 心跳照旧；战斗指令交给结算服务，结果以 `settle` 帧发回（#34）。
   * **不认识的消息只回 error 帧，不断开连接** —— 通道刚上线时，客户端版本比服务端新
   * （或者反过来）是常态，为一条对不上的消息把玩家的连接掐了太粗暴。
   */
  private onMessage(socket: TrackedSocket, raw: RawData): void {
    let parsed: { type?: unknown; data?: unknown };
    try {
      parsed = JSON.parse(raw.toString()) as { type?: unknown; data?: unknown };
    } catch {
      this.send(socket, { type: "error", data: { message: "消息不是合法的 JSON" } });
      return;
    }
    if (parsed?.type === "ping") {
      this.send(socket, { type: "pong", data: { serverTime: Date.now() } });
      return;
    }
    if (parsed?.type === "cast") {
      const data = this.combat.settle(socket.identity.id, parsed.data);
      const frame: RealtimeSettleMessage = { type: "settle", data };
      this.send(socket, frame);
      return;
    }
    if (parsed?.type === "targetsReset") {
      this.combat.resetTargets(socket.identity.id);
      return;
    }
    if (parsed?.type === "pos") {
      // 位置上报（#323 AI 目标检测输入 + #324 玩家互见数据源）：格式不对就丢掉这条（高频帧，不值得回 error 刷屏）
      const position = parsePosition(parsed.data);
      if (!position) return;
      const zoneId = this.accounts.findById(socket.identity.id)?.zone_id ?? 1;
      this.monsterAi.updatePosition(socket.identity.id, zoneId, position.mapId, position.x, position.y, position.hp);
      this.presence.updatePosition(
        socket.identity.id,
        socket.identity.username,
        zoneId,
        position.mapId,
        position.x,
        position.y,
        position.hp,
        position.moving,
      );
      return;
    }
    if (parsed?.type === "worldJoin") {
      // 进图登记（播种 / 恢复 / 换图都走这里），应答一张权威快照。
      // 区号从账号行现查（#295 阶段二）：账号归哪个区就进哪个区的世界；
      // 合并区后同一连接不改区，下一次 worldJoin 才按新账号行落位。
      const join = parseWorldJoin(parsed.data);
      if (!join) {
        this.send(socket, { type: "error", data: { message: "worldJoin 消息缺 mapId" } });
        return;
      }
      const zoneId = this.accounts.findById(socket.identity.id)?.zone_id ?? 1;
      const snapshot = this.world.join(zoneId, socket.identity.id, join.mapId);
      const frame: RealtimeWorldMessage = { type: "world", data: snapshot };
      this.send(socket, frame);
      // 玩家互见（#324）：随 world 应答发一份同图全量快照（增量帮不上「刚进图的人」）
      this.presence.join(socket.identity.id, zoneId, join.mapId);
      return;
    }
    this.send(socket, { type: "error", data: { message: `不认识的消息类型：${String(parsed?.type)}` } });
  }

  /**
   * 把一张图的权威状态广播给正在看它的人（重生等世界变化时由世界层触发）
   *
   * 拿不到快照（图已被卸载）就不发 —— 那只可能发生在观看者集合与世界状态不同步的瞬间，
   * 而观看者下一个 worldJoin 会拿到全量。
   */
  private broadcastWorld(zoneId: number, mapId: string): void {
    const snapshot = this.world.snapshot(zoneId, mapId);
    if (!snapshot) return;
    const frame: RealtimeWorldMessage = { type: "world", data: snapshot };
    for (const accountId of this.world.viewersOf(zoneId, mapId)) {
      const socket = this.connections.get(accountId);
      if (socket) this.send(socket, frame);
    }
  }

  //#endregion

  //#region 存活探测

  /**
   * 存活探测（每 `realtimeHeartbeatMs` 跑一次）
   *
   * socket 层**不会**自己发现对端已经没了（拔网线、进程被杀、NAT 表过期都会留下一条「看起来还在」的
   * 连接）。所以：上一轮 ping 没还 pong 的直接拆掉，还了的再 ping 一次。
   * 也就是说最坏情况下一条死连接会多留一个周期 —— 这是刻意的（宁可晚一点，也不要因为一次网络抖动误杀）。
   */
  private sweep(): void {
    for (const socket of this.connections.values()) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }

  /**
   * 踢下线巡检（#37 拆进程的关键拼图）
   *
   * 管理端「踢下线 / 封禁」和玩家「登出」都只写库（清 `online_role_id`），**不会**主动
   * 碰到本进程的连接 —— 单进程时代如此，拆进程后更是隔着进程边界。所以本进程按
   * `REALTIME_KICK_POLL_MS` 轮询一次：连接建连时记下账号当时的在线角色（基线），
   * 巡检发现基线非空、而现在被清空 → 主动断开（复用 4000，客户端的语义正是
   * 「回选角、不要自动重连」）。
   *
   * 刻意**只对「从有到无」生效**：在线角色从 A 换成 B（玩家自己切角色）不断连接 ——
   * 那是玩家自己的操作，客户端会带着新角色重新走完整建连流程；只有「被清空」
   * 才是管理端 / 登出的意志。
   *
   * 顺带补上单进程时代的欠账：此前踢下线只清标记，WS 连接要等玩家下一次操作
   * （存档被 20007 拒）才间接失效 —— 现在巡检一跑，连接立即断。
   */
  private sweepKicked(): void {
    if (this.closing || this.connections.size === 0) return;
    for (const [accountId, socket] of this.connections) {
      // 基线还没查到（建连后的首次查库在途）→ 本轮跳过；基线为 null = 建连时就没有在线角色，谈不上被踢
      if (socket.baselineOnlineRoleId === undefined || socket.baselineOnlineRoleId === null) continue;
      const account = this.accounts.findById(accountId);
      // 账号都没了（被删）同样视作「该走了」；还在但在线角色已被清 → 被踢 / 已登出
      if (account && account.online_role_id !== null) continue;
      this.logger.log(`账号 ${accountId} 的在线角色已被清除，断开其实时连接`);
      socket.close(REALTIME_CLOSE.REPLACED, "登录状态已变更（被踢下线或已登出），请重新选角");
      this.connections.delete(accountId);
      // 与 close 事件的清理同口径：退观看者、清幂等账、清位置上报（世界状态是共享的，不清）
      this.combat.dropAccount(accountId);
      this.presence.dropAccount(accountId);
      this.world.leave(accountId);
      this.monsterAi.dropAccount(accountId);
    }
  }

  /** 建连时查一次在线角色，给巡检当基线（查不到 = 账号不存在，交给心跳自然收尾） */
  private loadKickBaseline(socket: TrackedSocket, accountId: string): void {
    const account = this.accounts.findById(accountId);
    if (this.connections.get(accountId) !== socket) return; // 还没等查完连接就被顶掉了
    socket.baselineOnlineRoleId = account?.online_role_id ?? null;
  }

  //#endregion

  //#region 工具

  private send(socket: TrackedSocket, message: RealtimeServerMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  /**
   * 拒绝一次握手
   *
   * 关键：**不把连接建起来再关**，而是直接把这个 Upgrade 请求当成一次失败的 HTTP 请求回答。
   * 响应体与其余接口**完全同形**（`{ code, message, data, timestamp }`），业务码也复用既有的
   * `TOKEN_*` / `NOT_FOUND` / `INTERNAL` —— 调用方不需要为「WS 的拒连」再学一套口径。
   */
  private refuse(socket: Duplex, status: number, code: number, message: string): void {
    const body = JSON.stringify({
      code,
      message,
      data: null,
      timestamp: Date.now(),
    } satisfies ApiEnvelope<null>);
    socket.end(
      `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Error"}\r\n` +
        "Connection: close\r\n" +
        "Content-Type: application/json; charset=utf-8\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        "\r\n" +
        body,
    );
  }

  private dropExpiredTickets(): void {
    const now = Date.now();
    for (const [ticket, pending] of this.tickets) if (pending.expiresAt <= now) this.tickets.delete(ticket);
  }

  private ticketTtlMs(): number {
    return this.config.get<number>("realtimeTicketTtlMs") ?? 30_000;
  }

  private heartbeatMs(): number {
    return this.config.get<number>("realtimeHeartbeatMs") ?? 30_000;
  }

  //#endregion
}

//#region 消息解析（小工具）

/** worldJoin.data 的解析结果（#295 起只带 mapId，播种完全在服务端） */
interface ParsedWorldJoin {
  mapId: string;
}

function parseWorldJoin(raw: unknown): ParsedWorldJoin | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.mapId !== "string" || !data.mapId) return null;
  return { mapId: data.mapId };
}

/** pos.data 的解析结果（#323：格式不对整条丢弃，高频帧不回 error） */
interface ParsedPosition {
  mapId: string;
  x: number;
  y: number;
  hp: number;
  /** 是否在移动（#324：缺省 false，旧客户端不带这个字段） */
  moving: boolean;
}

function parsePosition(raw: unknown): ParsedPosition | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.mapId !== "string" || !data.mapId) return null;
  if (typeof data.x !== "number" || !Number.isFinite(data.x)) return null;
  if (typeof data.y !== "number" || !Number.isFinite(data.y)) return null;
  if (typeof data.hp !== "number" || !Number.isFinite(data.hp)) return null;
  return { mapId: data.mapId, x: data.x, y: data.y, hp: data.hp, moving: data.moving === true };
}

//#endregion
