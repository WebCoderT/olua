import { networkConfig } from "../../../configs/network";
import { ApiRoutes } from "./ApiRoutes";
import { RealtimeApi } from "./Api";
import ApiError from "./ApiError";
import { REALTIME_CLOSE } from "./ApiCodes";
import Session from "./Session";

/**
 * 实时通道的客户端一半（服务端那一半见 `server/src/modules/realtime`，验收在 #33）
 *
 * 只做「把管子接上并养活着」：取票据 → 建连 → **应用层**心跳 → 指数退避重连。
 * 通道上跑什么业务消息（战斗指令 / 结算结果）是 #34 的事，这里不认识它们的形状。
 *
 * ## 为什么是「先取票据再连」
 * WS 握手没有 `Authorization` 头的便利。把能用 7 天的访问令牌塞进 URL query 是明确的坏做法
 * （代理日志、浏览器历史、Referer 都会留痕），所以服务端在中间放了一张**一次性票据**：
 * 取票走普通的 `POST /realtime/ticket`（令牌由请求层统一注入），票据默认 30 秒过期、用掉即删。
 *
 * ## 两种「连不上」必须分开处理（这是本类的主要逻辑）
 * 1. **令牌失效**（`401` / `40100` 系）—— 请求层已经把人送回登录场景了，重连没有意义：停。
 * 2. **票据过期 / 网络抖动** —— 票据是一次性的、只活几十秒，重连失败大多是因为它过期了；
 *    此时**只需重新取一张票**，绝不能把玩家踢回登录页（他什么都没做错）。
 *
 * ## 被顶掉（close 4000）不抢回来
 * 服务端一个账号只留一条连接（新连接把旧的关掉）。被顶掉的那条**不该立刻重连**，
 * 否则两个客户端会互相踢、来回刷。所以收到 `4000` 就停在这里，等下次进游戏再说。
 *
 * ## 心跳为什么是应用层的
 * 浏览器拿不到协议层的 ping/pong 帧（那是 `ws` 自己处理的），客户端要量往返、要判断
 * 「多久没响应算掉线」，只能自己发。间隔以服务端 `welcome` 给的 `heartbeatMs` 为准 ——
 * 服务端改间隔不必跟着改客户端（见 configs/network.realtime 的说明）。
 */

/** 实时通道的连接状态 */
export enum RealtimeStatus {
  /** 未启动，或已主动停止 */
  Idle = "idle",
  /** 正在取票据 / 建连 / 退避等待中 */
  Connecting = "connecting",
  /** 已连上（收到过 welcome） */
  Connected = "connected",
  /** 掉线了 */
  Disconnected = "disconnected",
}

/**
 * 状态变化的说明
 *
 * 三个布尔各管一件事，接线方（ui/Game）据此决定提示哪一句 —— 都在这里判完，
 * RealtimeClient 自己不弹提示（它不认识界面）。
 */
export interface RealtimeStatusChange {
  status: RealtimeStatus;
  /** 断开之后是否还会自动重连（false = 已放弃：被别处顶掉 / 令牌失效 / 主动停止） */
  willRetry: boolean;
  /** 进入 `Connected` 时：这次是「断线之后又连回来」（首次连上为 false） */
  reconnected: boolean;
  /**
   * 进入 `Disconnected` 时：这次是「**本来连着**、刚掉」
   *
   * 重连失败（压根没连上过）不算 —— 否则服务端挂掉的期间会提示刷屏。
   */
  lost: boolean;
  /** 断开的说明（服务端的 close reason 或关闭码），只用于日志与排查 */
  reason?: string;
}

/** `WebSocket.OPEN` 的取值（协议固定为 1；不直接用 `WebSocket.OPEN` 是为了在没有全局构造器的环境里也能判） */
const SOCKET_OPEN = 1;

/**
 * 实时通道的握手路径
 *
 * 服务端把网关挂在**取票据接口的同一段路径**下（`realtime.protocol.ts` 的 `REALTIME_PATH`
 * 同时给 HTTP 路由与 WS 升级路径用），所以这里从**生成的路由**去掉末段取到 ——
 * 客户端不再写第二份路径字面量（`tools/audit-api-hardcode.cjs` 守着「路径只来自生成物」）。
 * 生成物改了写法（比如票据路由不再挂在网关下）时，`test-realtime.cjs` 会当场报出来。
 */
export function realtimePath(): string {
  const ticketRoute = ApiRoutes.realtime.ticket;
  const cut = ticketRoute.lastIndexOf("/");
  return cut > 0 ? ticketRoute.slice(0, cut) : ticketRoute;
}

/**
 * 把 `configs/network.baseUrl` 换成 ws 形态的根地址
 *
 * `http→ws` / `https→wss`（换成 wss 是硬要求：https 页面里连 ws 会被浏览器直接拦掉）。
 * 线上 baseUrl 是**同源相对地址**（`/api`），这种形态没有协议与主机，得借当前页面的补上。
 */
function wsOriginOf(baseUrl: string): string {
  if (/^https:\/\//.test(baseUrl)) return baseUrl.replace(/^https:\/\//, "wss://");
  if (/^http:\/\//.test(baseUrl)) return baseUrl.replace(/^http:\/\//, "ws://");
  const scope = globalThis as unknown as { location?: { protocol?: string; host?: string } };
  const scheme = scope.location?.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${scope.location?.host ?? ""}${baseUrl}`;
}

/** 拼一条完整的实时连接地址（主机与路径都从 configs/network.baseUrl 推出来） */
export function buildRealtimeUrl(ticket: string): string {
  const base = networkConfig.baseUrl.replace(/\/+$/, "");
  return `${wsOriginOf(base)}${realtimePath()}?ticket=${encodeURIComponent(ticket)}`;
}

/** 服务端会发过来的帧（只声明本类要认的字段，多出来的原样忽略） */
interface ServerFrame {
  type?: string;
  data?: { heartbeatMs?: unknown; userId?: unknown };
}

export default class RealtimeClient {
  private static socket: WebSocket | null = null;
  private static currentStatus: RealtimeStatus = RealtimeStatus.Idle;
  /** true = 已停（不在跑）。初始为 true，start() 才置 false */
  private static stopped = true;
  /** 本次会话有没有连上过（用于区分「首次连上」与「断线后连回来」） */
  private static everConnected = false;
  /** 连续失败次数（退避用；连上即清零） */
  private static attempts = 0;
  private static userId: string | null = null;
  private static handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private static pingTimer: ReturnType<typeof setInterval> | null = null;
  private static pongTimer: ReturnType<typeof setTimeout> | null = null;
  private static retryTimer: ReturnType<typeof setTimeout> | null = null;

  /** 状态变化出口（接线方在这里提示玩家；不接也能跑，只是没人看见） */
  static onStatusChange: ((change: RealtimeStatusChange) => void) | null = null;

  /** 当前状态 */
  static get status(): RealtimeStatus {
    return this.currentStatus;
  }

  /** 当前连接代表的账号 id（没连上为 null） */
  static get onlineUserId(): string | null {
    return this.userId;
  }

  /**
   * 开始连接（幂等：已经在跑就直接返回）
   *
   * 调用时机：进入游戏场景（`ui/Game.start`）。**没登录就别连** —— 那只会拿到 401，
   * 而请求层对 401 的处理是把人送回登录场景（从一个没登录的地方被拽走很奇怪）。
   */
  static start(): void {
    if (!this.stopped) return;
    if (!Session.isLoggedIn) {
      console.info("[realtime] 未登录，不建立实时连接");
      return;
    }
    this.stopped = false;
    this.attempts = 0;
    void this.open();
  }

  /**
   * 停止连接并收尾（幂等）
   *
   * 调用时机：离开游戏场景（`ui/Game.onDestroy`）。这里**先摘回调再 close**：
   * 否则这条自己发起的 close 会被 onClose 当成掉线，又安排一次重连。
   */
  static stop(): void {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    this.userId = null;
    this.everConnected = false;
    this.attempts = 0;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close(1000);
      } catch {
        // 已经关了 / 还没连上：没有需要收尾的东西
      }
    }
    this.emit(RealtimeStatus.Idle, {});
  }

  //#region 建连

  /** 取一张票据，然后建连；失败按退避重试 */
  private static async open(): Promise<void> {
    if (this.stopped) return;
    this.emit(RealtimeStatus.Connecting, {});
    let ticket: string;
    try {
      // 静默：重连是后台自己跑的，失败提示由 onStatusChange 统一发一条，不能让请求层每次都弹
      const result = await RealtimeApi.ticket({ silent: true });
      ticket = result.ticket;
    } catch (error) {
      console.warn(`[realtime] 取连接票据失败：${error instanceof ApiError ? error.describe() : String(error)}`);
      // 令牌失效：请求层已经把人送回登录场景了，再连也取不到票 —— 停在这里
      if (error instanceof ApiError && error.needRelogin) {
        this.stop();
        return;
      }
      this.scheduleRetry();
      return;
    }
    if (this.stopped) return;
    this.connect(ticket);
  }

  /** 拿票据去建连（地址由 configs/network.baseUrl 推出来，客户端不写第二份地址） */
  private static connect(ticket: string): void {
    let socket: WebSocket;
    try {
      socket = new WebSocket(buildRealtimeUrl(ticket));
    } catch (error) {
      // 地址拼不出来 / 环境没有 WebSocket：按网络抖动处理，退避之后再试
      console.warn(`[realtime] 建立连接失败：${String(error)}`);
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => this.armHandshakeTimeout();
    socket.onmessage = (event: MessageEvent) => this.onFrame(event.data);
    // onerror 之后紧跟一条 close（浏览器不给细节），统一在 onClose 里处理，这里只记一笔
    socket.onerror = () => console.warn("[realtime] 连接出错");
    socket.onclose = (event: CloseEvent) => this.onClose(event.code, event.reason);
  }

  /**
   * 握手超时兜底
   *
   * 连上了却没等到 `welcome`（半开的连接、卡在中途的代理）不会自己变成失败 ——
   * 不定时收掉的话这条连接会一直占着，而客户端还以为自己在「连接中」。
   */
  private static armHandshakeTimeout(): void {
    this.clearHandshakeTimer();
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      console.warn("[realtime] 握手超时（没等到 welcome），重建连接");
      this.closeSocket();
    }, networkConfig.realtime.handshakeTimeout);
  }

  //#endregion

  //#region 收帧与心跳

  private static onFrame(raw: unknown): void {
    const frame = this.parseFrame(raw);
    if (!frame) return;
    if (frame.type === "welcome") {
      // 先取「这次是首次连上还是断线回来」，再更新标记
      const reconnected = this.everConnected;
      this.everConnected = true;
      this.attempts = 0;
      const heartbeatMs = this.heartbeatMsOf(frame.data?.heartbeatMs);
      this.userId = typeof frame.data?.userId === "string" ? frame.data.userId : null;
      this.clearHandshakeTimer();
      this.clearPongTimer();
      this.armPing(heartbeatMs);
      console.info(`[realtime] 已连接（账号 ${this.userId ?? "?"}，心跳 ${heartbeatMs}ms）`);
      this.emit(RealtimeStatus.Connected, { reconnected });
      return;
    }
    // pong 是心跳应答、error 说明对端还在说话 —— 两种都算「这条连接活着」，撤掉超时判据
    this.clearPongTimer();
  }

  /**
   * 起心跳定时器（间隔取服务端 welcome 给的值，兜底见 configs/network.realtime）
   *
   * 定时器只负责「按节拍去 ping」，掉线判定在 ping 里挂的应答超时上（见 ping 的说明）。
   */
  private static armPing(interval: number): void {
    this.clearPingTimer();
    this.pingTimer = setInterval(() => this.ping(), interval);
  }

  /**
   * 发一次心跳
   *
   * **上一发还没回音时不发第二发**，也不重置判据 —— 否则心跳间隔比应答超时短时
   * （服务端给的 `heartbeatMs` 可能就是这样），每发一次都把超时判据往后推，
   * 「一直没人应」就永远等不到判据触发（这个坑是 test-realtime 的 E 组抓出来的）。
   */
  private static ping(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) return;
    if (this.pongTimer) return;
    socket.send(JSON.stringify({ type: "ping" }));
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      // socket 层不会自己发现对端没了（拔网线 / NAT 表过期都会留下一条「看起来还在」的连接）
      console.warn("[realtime] 心跳无应答，判为掉线");
      this.closeSocket();
    }, networkConfig.realtime.pongTimeout);
  }

  private static parseFrame(raw: unknown): ServerFrame | null {
    if (typeof raw !== "string") return null;
    try {
      const parsed = JSON.parse(raw) as ServerFrame;
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      // 不认识的帧不该让连接断掉（协议里也是这个口径：不认识的消息回 error 帧、不断开）
      console.warn("[realtime] 收到不是合法 JSON 的帧");
      return null;
    }
  }

  private static heartbeatMsOf(fromServer: unknown): number {
    if (typeof fromServer === "number" && fromServer > 0) return fromServer;
    return networkConfig.realtime.pingInterval;
  }

  //#endregion

  //#region 掉线与重连

  private static onClose(code: number, reason: string): void {
    const wasConnected = this.currentStatus === RealtimeStatus.Connected;
    this.clearTimers();
    this.socket = null;
    this.userId = null;
    // 自己停的（stop）已经在 stop() 里收过尾，onClose 不会被走到；这里兜一层
    if (this.stopped) return;

    if (code === REALTIME_CLOSE.REPLACED) {
      // 别处已经连上了：抢回来只会互相踢。停在这里，等下次进游戏再连
      this.stopped = true;
      console.warn("[realtime] 本连接已被顶掉（账号已在别处连接），不再重连");
      this.emit(RealtimeStatus.Disconnected, { lost: wasConnected, willRetry: false, reason: reason || `close=${code}` });
      return;
    }

    console.warn(`[realtime] 连接断开（${reason || `close=${code}`}），退避后重连`);
    this.emit(RealtimeStatus.Disconnected, { lost: wasConnected, willRetry: true, reason: reason || `close=${code}` });
    this.scheduleRetry();
  }

  /**
   * 安排一次重连：指数退避（首个间隔取自配置，此后每失败一次翻倍，封顶见配置）
   *
   * 退避是必须的：服务端重启 / 网络断掉时，不打退避的重连会变成每秒几十次的空转，
   * 而客户端自己就成了把服务端拖住的那只手。
   */
  private static scheduleRetry(): void {
    if (this.stopped) return;
    this.clearRetryTimer();
    const { reconnectBaseDelay, reconnectMaxDelay } = networkConfig.realtime;
    const delay = Math.min(reconnectBaseDelay * Math.pow(2, this.attempts), reconnectMaxDelay);
    this.attempts += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.open();
    }, delay);
  }

  /** 主动收掉当前连接（之后的 onClose 会统一安排重连） */
  private static closeSocket(): void {
    const socket = this.socket;
    if (!socket) return;
    try {
      socket.close();
    } catch {
      // 已经关了：close 事件的回调仍会到，不用在这里补
    }
  }

  //#endregion

  //#region 工具

  private static emit(status: RealtimeStatus, extra: { reconnected?: boolean; lost?: boolean; willRetry?: boolean; reason?: string }): void {
    this.currentStatus = status;
    this.onStatusChange?.({
      status,
      willRetry: extra.willRetry ?? false,
      reconnected: extra.reconnected ?? false,
      lost: extra.lost ?? false,
      reason: extra.reason,
    });
  }

  private static clearHandshakeTimer(): void {
    if (!this.handshakeTimer) return;
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  private static clearPingTimer(): void {
    if (!this.pingTimer) return;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private static clearPongTimer(): void {
    if (!this.pongTimer) return;
    clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  private static clearRetryTimer(): void {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private static clearTimers(): void {
    this.clearHandshakeTimer();
    this.clearPingTimer();
    this.clearPongTimer();
    this.clearRetryTimer();
  }

  //#endregion
}
