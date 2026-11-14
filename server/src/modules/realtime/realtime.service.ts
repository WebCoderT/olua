import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HttpAdapterHost } from "@nestjs/core";
import { randomBytes } from "node:crypto";
import { STATUS_CODES, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { BizCode } from "../../common/constants/biz-code";
import { EVENT_TYPE } from "../../common/constants/event-type";
import type { ApiEnvelope, AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { AccountRepository } from "../../database/repositories/account.repository";
import type { RoleRow } from "../../database/rows";
import { WorldService } from "../world/world.service";
import { roomKey } from "../../common/utils/room-key.util";
import { MapService, START_MAP_ID, type MapEnterReject } from "../map/map.service";
import { roleAttributeSourceOf, summarizeRoleAttributes } from "../combat/role-attributes";
import { RuntimeConfigService } from "../game-config/runtime-config.service";
import { RolesService } from "../roles/roles.service";
import { decodeStoredRoleData } from "../roles/role-data.util";
import { skillPointsOf } from "../../common/utils/skill-upgrade.util";
import { attrAllocationOf, attrPointsOf } from "../../common/utils/attr-points.util";
import { RealtimeTicketDto } from "./dto/realtime.dto";
import { BlockService } from "./block.service";
import { PartyService } from "../party/party.service";
import { EventLogService } from "../event-log/event-log.service";
import { ChatService } from "./chat.service";
import { CombatSettlementService } from "./combat-settlement.service";
import { MonsterAiService } from "./monster-ai.service";
import { PlayerPresenceService } from "./player-presence.service";
import { PathService } from "./path.service";
import { QuestService } from "../quest/quest.service";
import {
  CHAT_CHANNELS,
  REALTIME_CLOSE,
  REALTIME_PATH,
  type ChatChannel,
  type RealtimeChatBroadcast,
  type RealtimeChatMessage,
  type RealtimeIdentity,
  type RealtimeMapEnterResultMessage,
  type RealtimePickedMessage,
  type RealtimeRoleUpdateMessage,
  type RealtimePlayerAction,
  type RealtimePlayerEntry,
  type RealtimePlayersMessage,
  type RealtimePosCorrectMessage,
  type RealtimePathMessage,
  type RealtimeQuestMessage,
  type RealtimeServerMessage,
  type RealtimeSettleMessage,
  type RealtimeStatusMessage,
  type RealtimeWorldMessage,
  type RealtimeWorldReloadMessage,
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
  /**
   * 上一轮角色快照推送时看到的行签名（`revision:updated_at`，见 syncRoles）。
   * `undefined` = 还没推过（建连后的首次推送会补上）。
   */
  roleSyncSignature?: string;
  /** 上一次寻路请求的时刻（#811 防刷节流；挂在连接上，断开即随对象一起回收） */
  lastPathFindAt?: number;
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
 * 广播统计的口径（#767：同步延迟测量基线，先有数字再决定砍哪一段）
 *
 * 只量**三条广播出口**（世界 / 怪物 AI / 玩家互见），私聊 / 队伍 / 状态推送这类
 * 定向小帧不进统计 —— 它们不在「20 人同图时服务端每轮花多久」这个问题上。
 * 每轮记：收件人数 / 帧条数 / JSON 字节数 / stringify 耗时 / 实际间隔，
 * 按 `REALTIME_STATS_INTERVAL_MS` 汇总各打一行日志。
 */
type StatsKind = "world" | "monster-ai" | "players";

/** 一轮广播的原始计数（`statsRun` 的起止之间） */
interface StatsRound {
  /** 轮起点（`performance.now()`；实际间隔按它与上一轮起点比） */
  startedAt: number;
  /** 本轮产生的逻辑帧数（world / players / monster-ai 目前都是一次调用一帧） */
  frames: number;
  /** 实际送达的连接数（连接不在了 / readyState 不对的不算） */
  recipients: number;
  /** 本轮 JSON.stringify 的次数（#768 序列化缓存后应远小于收件人次） */
  stringifies: number;
  /** JSON.stringify 的累计耗时（毫秒） */
  stringifyMs: number;
  /** 实际写出的 JSON 字节数（UTF-8 计） */
  bytes: number;
  /** 距上一轮起点的间隔（本轮是这一类广播的第一轮时为 null，不进平均值） */
  intervalMs: number | null;
}

/** 一个汇总窗口内某类广播的累计（flushStats 打完日志即清） */
interface StatsAccum {
  rounds: number;
  frames: number;
  recipients: number;
  stringifies: number;
  bytes: number;
  stringifyMs: number;
  /** 用于算平均轮间隔（首轮没有间隔，不计入） */
  intervals: number;
  intervalCount: number;
}

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
  /** 角色快照轮询定时器（见 syncRoles；0 = 关闭推送） */
  private roleSyncTimer: NodeJS.Timeout | null = null;
  /** 运营配置定期重装定时器（见 configRefreshMs；0 = 关闭重装） */
  private configRefreshTimer: NodeJS.Timeout | null = null;
  /** 握手路径（`/<API_PREFIX>/realtime`），bootstrap 时按前缀算出来 */
  private path = `/${REALTIME_PATH}`;
  private closing = false;

  /** 广播统计开关（bootstrap 按 `realtimeStatsIntervalMs` 决定；false = 所有统计钩子空操作，零开销） */
  private statsOn = false;
  /** 统计汇总间隔（毫秒），bootstrap 时定死；改它要重启进程（统计不该有运行时开关的复杂度） */
  private statsIntervalMs = 10_000;
  private statsTimer: NodeJS.Timeout | null = null;
  /** 进行中的一轮（send() 按 `statsCurrentKind` 把 stringify 耗时与字节记进来） */
  private statsCurrentKind: StatsKind | null = null;
  private readonly statsRounds = new Map<StatsKind, StatsRound>();
  /** 各类广播上一轮的起点（算实际间隔用） */
  private readonly statsLastRoundAt = new Map<StatsKind, number>();
  private readonly statsAccum = new Map<StatsKind, StatsAccum>();

  constructor(
    private readonly config: ConfigService,
    private readonly adapterHost: HttpAdapterHost,
    private readonly combat: CombatSettlementService,
    private readonly monsterAi: MonsterAiService,
    private readonly presence: PlayerPresenceService,
    private readonly chat: ChatService,
    private readonly blocks: BlockService,
    private readonly party: PartyService,
    private readonly quests: QuestService,
    private readonly world: WorldService,
    private readonly maps: MapService,
    private readonly accounts: AccountRepository,
    private readonly roles: RolesService,
    private readonly runtimeConfig: RuntimeConfigService,
    private readonly eventLogs: EventLogService,
    private readonly paths: PathService,
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
    const roleSyncMs = this.roleSyncPollMs();
    if (roleSyncMs > 0) {
      // 角色权威快照轮询（#541）：属性 / 战斗力 / 货币的写点分散在两个进程，
      // 轮询库变更才推（见 syncRoles）—— 这是玩家面板「实时」的全部来源
      this.roleSyncTimer = setInterval(() => this.syncRoles(), roleSyncMs).unref();
    }
    const configRefreshMs = this.configRefreshMs();
    if (configRefreshMs > 0) {
      // 运营配置定期重装（#732）：管理端写操作后的 refreshAll 是**进程内**的，跨不到本进程 ——
      // 不重装的话本进程永远按启动时的旧值现算属性与战斗力，roleUpdate 帧与操作应答各执
      // 一份值，客户端战斗力显示在两个数之间来回翻。表都很小，全量重装很轻；静默（不刷装载日志）
      this.configRefreshTimer = setInterval(() => this.runtimeConfig.refreshAll({ silent: true }), configRefreshMs).unref();
    }
    // 广播统计（#767）：默认 10000ms 汇总一行；0 = 整套统计关闭（钩子全空操作）
    const statsMs = this.statsMs();
    if (statsMs > 0) {
      this.statsOn = true;
      this.statsIntervalMs = statsMs;
      this.statsTimer = setInterval(() => this.flushStats(), statsMs).unref();
    }
    // 世界状态变化（重生等）由世界层通知，这里补上广播出口（世界层不知道连接的存在）。
    // #809 起回调按**房间**（`zone:map:slot`）传参：分线之后「一张图」不等于「一份世界」
    this.world.onWorldChanged = (roomId) => this.broadcastWorld(roomId);
    // 单图热重载完成（#809）：只给**那间房**的人发一帧 `world.reload`，客户端重建怪物并飘字。
    // 不重发整份 world 帧：刷新怪物由客户端收到这一帧后自己再 worldJoin 一次（复用既有链路）
    this.world.onRoomReloaded = (result) => {
      const frame: RealtimeWorldReloadMessage = {
        type: "world.reload",
        data: { roomId: result.roomId, mapId: result.mapId, slot: result.slot, forced: result.forced },
      };
      // #768：同一帧只 stringify 一次（不在统计轮里，sendToViewers 的记账分支自动跳过）
      this.sendToViewers(this.world.viewersOf(result.roomId), frame);
    };
    // 怪物 AI 广播（#323）：AI 服务攒好一帧，这里按观看者集合发出去。
    // #768 序列化缓存：帧对观看者相同，只 stringify 一次（sendToViewers）
    this.monsterAi.onBroadcast = (roomId, data) => {
      // 每次回调 = 一帧（一間房的增量）。统计（#767）只包住发送，不碰攒帧逻辑
      this.statsRun("monster-ai", 1, () => {
        this.sendToViewers(this.world.viewersOf(roomId), { type: "monster-ai", data });
      });
    };
    // 状态推送（#826 第三批）：怪物把眩晕 / 灼烧挂到某个玩家身上时，整份快照推给他本人。
    // 不推的话他要等到下一次出手被 `stunned` 拒了才知道自己被控 —— 血条莫名其妙掉一截同理。
    this.monsterAi.onStatuses = (accountId, statuses) => {
      const socket = this.connections.get(accountId);
      if (socket) this.send(socket, { type: "statuses", data: { statuses } } satisfies RealtimeStatusMessage);
    };
    // 玩家互见广播（#324）：在场表攒好一帧，这里按观看者集合发出去；
    // 屏蔽（#398）在这里逐观看者剔一次 —— 一个帧发给多人时，收件人的过滤条件各不相同，
    // 「谁能看谁」只能由持有连接与身份的通道来判（在场表只认识「谁在哪张图」）。
    // #768 序列化缓存：没拉黑任何人的观看者（绝大多数）全图共用一份序列化结果，
    // 只有真的滤掉了条目的观看者才各出一份
    this.presence.onBroadcast = (roomId, data) => {
      this.statsRun("players", 1, () => {
        const round = this.currentRound();
        let sharedJson: string | null = null;
        let sharedBytes = 0;
        for (const accountId of this.world.viewersOf(roomId)) {
          const socket = this.connections.get(accountId);
          if (!socket || socket.readyState !== WebSocket.OPEN) continue;
          const filtered = this.visiblePlayers(accountId, data);
          if (filtered === data) {
            // 快路径：这个观看者没有任何条目被滤（visiblePlayers 原样返回入参）
            if (sharedJson === null) {
              const t0 = round ? performance.now() : 0;
              const frame: RealtimePlayersMessage = { type: "players", data };
              sharedJson = JSON.stringify(frame);
              sharedBytes = Buffer.byteLength(sharedJson);
              if (round) {
                round.stringifyMs += performance.now() - t0;
                round.stringifies += 1;
              }
            }
            this.sendPrebuilt(socket, sharedJson, sharedBytes);
          } else {
            // 慢路径：有屏蔽，过滤结果因人而异，只能各序列化一份
            this.send(socket, { type: "players", data: filtered } satisfies RealtimePlayersMessage);
          }
        }
      });
    };
    // 快照兜底的定向发送（full 帧只给刚进图的连接自己）：同样过一次屏蔽过滤
    this.presence.onSendTo = (accountId, data) => {
      const socket = this.connections.get(accountId);
      if (socket) {
        this.send(socket, { type: "players", data: this.visiblePlayers(accountId, data) } satisfies RealtimePlayersMessage);
      }
    };
    // 聊天投递（#395）：ChatService 选好收件人列表，这里对着连接表发；
    // from.accountId 在 ChatService 侧已组好，帧到这里就是成品
    this.chat.onDeliver = (accountIds, entry) => {
      const frame: RealtimeChatBroadcast = { type: "chat", data: entry };
      // #768：同一帧只 stringify 一次（低频路径，纯一致性收益）
      this.sendToViewers(new Set(accountIds), frame);
    };
    // 聊天拒绝：走通用 error 帧（低频操作，明确告知比悄悄丢弃好）
    this.chat.onReject = (accountId, message) => {
      const socket = this.connections.get(accountId);
      if (socket) this.send(socket, { type: "error", data: { message } });
    };
    // 私聊的在线判据：连接表是本服务的私产，给 ChatService 一个布尔答案就够
    this.chat.isConnected = (accountId) => this.connections.has(accountId);
    // 队伍（#399）：三根线 —— 发帧、查在线位置、查屏蔽。
    // 队伍态在库里、缓存在 PartyService，但「谁在线 / 在线的人在哪张图」只有通道知道。
    this.party.sendTo = (accountId, frame) => {
      const socket = this.connections.get(accountId);
      if (socket) this.send(socket, frame);
    };
    this.party.locationOf = (roleId) => this.presence.locateRole(roleId);
    this.party.blockedFrom = (aRoleId, bRoleId) => this.blocks.hiddenFor(aRoleId, bRoleId);
    // 在场表的队伍标记：组队 / 退队要立刻反映到别人的屏幕上（金色名字 + 队标），
    // 所以每个广播节拍现查一次内存索引，而不是等外观懒刷新（5 秒）
    this.presence.partyOfRole = (roleId) => this.party.partyIdOfRole(roleId);
    // 任务进度帧（#396）：只推给本人连接（击杀是唯一发生在 HTTP 之外的进度变化）
    this.quests.onProgress = (accountId, data) => {
      const socket = this.connections.get(accountId);
      if (socket) this.send(socket, { type: "quest", data } satisfies RealtimeQuestMessage);
    };
    // 位置修正（#811）：`enforce` 档下判定位移不可信时，定向把权威坐标推回本人。
    // 走连接表而不是广播：别人本来就只看到权威位置，没有偏差可纠
    this.presence.onCorrect = (accountId, data) => {
      const socket = this.connections.get(accountId);
      if (socket) this.send(socket, { type: "posCorrect", data } satisfies RealtimePosCorrectMessage);
    };

    this.logger.log(
      `实时通道已挂载：${this.path}（存活探测 ${heartbeatMs}ms / 在线心跳宽限 ${this.onlineStaleMs() > 0 ? `${this.onlineStaleMs()}ms` : "关"} / 票据有效期 ${this.ticketTtlMs()}ms / 踢下线巡检 ${kickPollMs > 0 ? `${kickPollMs}ms` : "关"}）`,
    );
  }

  /** 踢下线巡检间隔（毫秒；0 = 关闭） */
  private kickPollMs(): number {
    return Math.max(0, Number(this.config.get<number>("realtimeKickPollMs") ?? 3000));
  }

  /** 角色快照轮询间隔（毫秒；0 = 关闭 roleUpdate 推送） */
  private roleSyncPollMs(): number {
    return Math.max(0, Number(this.config.get<number>("realtimeRoleSyncMs") ?? 1000));
  }

  /** 运营配置定期重装间隔（毫秒；0 = 关闭重装） */
  private configRefreshMs(): number {
    return Math.max(0, Number(this.config.get<number>("realtimeConfigRefreshMs") ?? 10_000));
  }

  /** 广播统计汇总间隔（毫秒；0 = 关闭统计。改它要重启进程，统计没有运行时开关） */
  private statsMs(): number {
    return Math.max(0, Number(this.config.get<number>("realtimeStatsIntervalMs") ?? 10_000));
  }

  //#endregion

  //#region 广播统计（#767：同步延迟测量基线）

  /**
   * 量一轮广播：起点 / 间隔记好 → 跑发送 → 收进累计
   *
   * 统计关闭时**只跑 fn**（连对象都不建），开销为零；开着时也只是同步的几条赋值，
   * 广播路径里没有任何 await / setTimeout（issue 的硬边界：统计不能改变时序）。
   */
  private statsRun(kind: StatsKind, frames: number, fn: () => void): void {
    if (!this.statsOn) {
      fn();
      return;
    }
    const startedAt = performance.now();
    const last = this.statsLastRoundAt.get(kind);
    const round: StatsRound = {
      startedAt,
      frames,
      recipients: 0,
      stringifies: 0,
      stringifyMs: 0,
      bytes: 0,
      intervalMs: last === undefined ? null : startedAt - last,
    };
    this.statsLastRoundAt.set(kind, startedAt);
    this.statsRounds.set(kind, round);
    const previousKind = this.statsCurrentKind;
    this.statsCurrentKind = kind;
    try {
      fn();
    } finally {
      this.statsCurrentKind = previousKind;
      this.statsRounds.delete(kind);
      this.statsAccumulate(kind, round);
    }
  }

  private statsAccumulate(kind: StatsKind, round: StatsRound): void {
    const acc = this.statsAccum.get(kind) ?? { rounds: 0, frames: 0, recipients: 0, stringifies: 0, bytes: 0, stringifyMs: 0, intervals: 0, intervalCount: 0 };
    acc.rounds += 1;
    acc.frames += round.frames;
    acc.recipients += round.recipients;
    acc.stringifies += round.stringifies;
    acc.bytes += round.bytes;
    acc.stringifyMs += round.stringifyMs;
    if (round.intervalMs !== null) {
      acc.intervals += round.intervalMs;
      acc.intervalCount += 1;
    }
    this.statsAccum.set(kind, acc);
  }

  /** 汇总窗口到点：每类有活动的广播打一行（没活动的类不打 —— 日志要留给有用的信息） */
  private flushStats(): void {
    for (const [kind, acc] of this.statsAccum) {
      const avgInterval = acc.intervalCount > 0 ? Math.round(acc.intervals / acc.intervalCount) : 0;
      this.logger.log(
        `广播统计[${kind}] ${Math.round(this.statsIntervalMs / 1000)}s 内：${acc.rounds} 轮 / 帧 ${acc.frames} / ` +
          `收件 ${acc.recipients} 人次 / stringify ${acc.stringifies} 次 ${acc.stringifyMs.toFixed(1)}ms / ` +
          `${(acc.bytes / 1024).toFixed(1)}KB / 平均轮间隔 ${avgInterval}ms`,
      );
    }
    this.statsAccum.clear();
  }

  //#endregion

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
    for (const timer of [this.heartbeatTimer, this.ticketSweepTimer, this.kickPollTimer, this.roleSyncTimer, this.configRefreshTimer, this.statsTimer]) if (timer) clearInterval(timer);
    this.heartbeatTimer = null;
    this.ticketSweepTimer = null;
    this.kickPollTimer = null;
    this.configRefreshTimer = null;
    this.roleSyncTimer = null;
    this.statsTimer = null;
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
        this.chat.dropAccount(identity.id);
        // 离线不保留 buff（#822 / docs/22 §5）：状态会改结算（防御倍率 / 格挡），
        // 挂在离线角色身上等于「回来白拿 buff」。断线即清，重连后要重新放 ——
        // 与「离线不保留 buff」的网络游戏惯例一致。
        this.roles.clearStatusesOf(identity.id);
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
    // 建连即推一次权威基线（#541）：客户端登入拿到的角色存档里，属性/战斗力可能是
    // 旧口径的存量值，这一帧把它当场纠正，不用等第一次轮询节拍
    this.pushRoleUpdate(socket);
  }

  /**
   * 角色权威快照轮询（#541）
   *
   * 每 `realtimeRoleSyncMs` 跑一遍在线连接：取账号当前在线角色行，`revision:updated_at`
   * 没变就跳过（绝大多数轮询都停在这里，查行是唯一开销）；变了就重算属性组一帧
   * `roleUpdate` 推给本人。签名记在 socket 上，连接断开即随之消失，无需额外清理。
   *
   * 覆盖的写点：客户端存档（PUT /roles）、任务 / 成就 / 邮件发奖、商城 / 回收 / 成长线 / 用药、
   * 实时侧的升级与拾取、管理端后台改角色 —— **全部**经由「行变了」这一处汇合，
   * 不需要每个写点各发一次通知（也发不了：写点跨进程，事件总线过不去）。
   */
  private syncRoles(): void {
    if (this.closing || this.connections.size === 0) return;
    for (const socket of this.connections.values()) {
      const row = this.roles.onlineRoleRow(socket.identity.id);
      if (!row) continue; // 没有在线角色：踢下线巡检会处理连接，这里无事可推
      const signature = `${row.revision}:${row.updated_at}`;
      if (socket.roleSyncSignature === signature) continue;
      socket.roleSyncSignature = signature;
      const frame = this.buildRoleUpdate(row);
      if (frame) this.send(socket, frame);
    }
  }

  /** 给一条连接推当前角色的权威快照（签名一并记下，避免下一轮重复推） */
  private pushRoleUpdate(socket: TrackedSocket): void {
    const row = this.roles.onlineRoleRow(socket.identity.id);
    if (!row) return;
    socket.roleSyncSignature = `${row.revision}:${row.updated_at}`;
    const frame = this.buildRoleUpdate(row);
    if (frame) this.send(socket, frame);
  }

  /**
   * 由角色行组一帧 roleUpdate：属性与战斗力**现算**（不信任存档里客户端报的旧值），
   * 货币 / 等级 / 血蓝 / 经验取行内权威字段
   */
  private buildRoleUpdate(row: RoleRow): RealtimeRoleUpdateMessage | null {
    const data = decodeStoredRoleData(row.data);
    const summary = summarizeRoleAttributes(roleAttributeSourceOf(row.level, data));
    return {
      type: "roleUpdate",
      data: {
        level: row.level,
        exp: Math.max(0, Math.floor(Number(data.exp) || 0)),
        expNeed: this.roles.expNeedAt(row.level),
        hp: Math.max(0, Math.floor(Number(data.hp) || 0)),
        mp: Math.max(0, Math.floor(Number(data.mp) || 0)),
        bindGold: Math.max(0, Math.floor(Number(data.bindGold) || 0)),
        combat: summary?.combat ?? Math.max(0, Math.floor(Number(data.combat) || 0)),
        // 成长线阶位（#551）：后台改完不重进也能看到。三者都归服务端，取文档里的当前值
        title: Math.max(0, Math.floor(Number(data.title) || 0)),
        soulOfWar: Math.max(0, Math.floor(Number(data.soulOfWar) || 0)),
        rank: Math.max(0, Math.floor(Number(data.rank) || 0)),
        // 技能点（#828）：升级在本进程结算，帧不带的活面板会停在旧点数
        skillPoints: skillPointsOf(data.skillPoints),
        // 属性点与四维（#833）：同上 —— 升级给点、另一台设备加点，两件事都得让这一端看见
        attrPoints: attrPointsOf(data.attrPoints),
        attrs: attrAllocationOf(data.attrs),
        // 体验状态（#596 换设备云同步）：归客户端书写、服务端存证，帧带回让另一台设备 /
        // 后台改动不用重新选角就能看到。形状由客户端配置定义，这里只认「存在且形状对」
        ...(Array.isArray(data.shortcutKeys) ? { shortcutKeys: data.shortcutKeys } : {}),
        ...(data.guide && typeof data.guide === "object" ? { guide: data.guide as { step: number; done: boolean; skipped: boolean } } : {}),
        ...(typeof data.soulShow === "boolean" ? { soulShow: data.soulShow } : {}),
        // 时装（#596）：穿着态与拥有清单都归服务端 —— 购买 / 后台发放后不重进也看得见
        ...(typeof data.fashionCloth === "string" || data.fashionCloth === null ? { fashionCloth: data.fashionCloth as string | null } : {}),
        ...(Array.isArray(data.fashionsOwned) ? { fashionsOwned: data.fashionsOwned } : {}),
        ...(summary
          ? {
              maxHp: summary.maxHp,
              hpRecover: summary.hpRecover,
              maxMp: summary.maxMp,
              physicalAttack: summary.physicalAttack,
              magicAttack: summary.magicAttack,
              taoistAttack: summary.taoistAttack,
              physicalDefense: summary.physicalDefense,
              magicDefense: summary.magicDefense,
              taoistDefense: summary.taoistDefense,
            }
          : {}),
        revision: row.revision,
      },
    };
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
      // 突进类技能的落点免检额度（#811）：**结算成功之后**才给 —— 给在结算之前等于
      // 「报个远点就换一次瞬移」，连冷却都没过就能反复要（见 grantCastDisplacement）
      if (data.ok) this.grantCastDisplacement(socket.identity.id, parsed.data);
      const frame: RealtimeSettleMessage = { type: "settle", data };
      this.send(socket, frame);
      return;
    }
    if (parsed?.type === "targetsReset") {
      this.combat.resetTargets(socket.identity.id);
      return;
    }
    if (parsed?.type === "pick") {
      // 拾取（#325）：按结算侧的掉落账本格子级入包，结果以 picked 帧发回。
      // 格式不对回 error 帧（低频操作，值得一次明确告知而不是悄悄丢弃）
      const request = parsePick(parsed.data);
      if (!request) {
        this.send(socket, { type: "error", data: { message: "pick 消息缺 castId / index" } });
        return;
      }
      const data = this.combat.pickDrop(socket.identity.id, request.castId, request.index);
      const frame: RealtimePickedMessage = { type: "picked", data };
      this.send(socket, frame);
      return;
    }
    if (parsed?.type === "chat") {
      // 聊天（#395）：格式不对回 error 帧（低频操作，值得一次明确告知而不是悄悄丢弃）
      const request = parseChat(parsed.data);
      if (!request) {
        this.send(socket, { type: "error", data: { message: "chat 消息缺 channel / text" } });
        return;
      }
      this.chat.say(socket.identity.id, request);
      return;
    }
    if (parsed?.type === "party") {
      // 队伍（#399）：全部七个动作走同一条帧。身份取在场表（还没进图的人没有角色 / 地图，
      // 组队对他就没有意义 —— 队伍要的「同图」和名字都依赖进图后的身份）
      if (!parsed.data || typeof parsed.data !== "object") {
        this.send(socket, { type: "error", data: { message: "party 消息缺 data" } });
        return;
      }
      const identity = this.presence.identityOf(socket.identity.id);
      if (!identity || !identity.roleId) {
        this.send(socket, { type: "error", data: { message: "还没进图，先进入游戏地图再组队" } });
        return;
      }
      const data = parsed.data as { action?: unknown; roleId?: unknown };
      this.party.handle(
        {
          accountId: socket.identity.id,
          roleId: identity.roleId,
          name: identity.username,
          mapId: identity.mapId,
        },
        data.action,
        data.roleId,
      );
      return;
    }
    if (parsed?.type === "pos") {
      // 位置上报（#323 AI 目标检测输入 + #324 玩家互见数据源）：格式不对就丢掉这条（高频帧，不值得回 error 刷屏）
      const position = parsePosition(parsed.data);
      if (!position) return;
      const zoneId = this.accounts.findById(socket.identity.id)?.zone_id ?? 1;
      // 只喂在场表（#855）：它仲裁之后的那份坐标就是 AI 索敌与互见广播的唯一来源，
      // 以前这里还同时喂怪物 AI 一份原始坐标 —— 一份伪造的 pos 骗两边，仲裁形同虚设
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
    if (parsed?.type === "pathFind") {
      // 寻路请求（#811 第三道）：起点用**在场表里被接受的**坐标（自报起点能让路点算进墙里），
      // 目标点由客户端给。高频帧（客户端每次重寻路一条），格式不对就静默丢弃，不回 error
      const request = parsePathFind(parsed.data);
      if (!request) return;
      const now = Date.now();
      // 节流：重寻路的节奏在客户端（repathInterval 400ms），这里只防刷 ——
      // 一条连接 100ms 内重复请求直接丢，回执也就不发了（客户端自己会超时重发）
      if (typeof socket.lastPathFindAt === "number" && now - socket.lastPathFindAt < PATH_FIND_MIN_INTERVAL_MS) return;
      socket.lastPathFindAt = now;
      this.send(socket, this.pathFrameOf(socket.identity.id, request));
      return;
    }
    if (parsed?.type === "mapEnter") {
      // 换图意图（#606）：**只回答「能不能去」**，不播种、不登记观看者、不改位置 ——
      // 客户端拿到 ok 才切场景。这条存在的意义是「被拒的人不进那张空图」：
      // 切场景是不可逆的，先问一句就不用回滚（详见协议里 RealtimeMapEnterMessage 的注释）
      const intent = parseMapEnter(parsed.data);
      if (!intent) {
        this.send(socket, { type: "error", data: { message: "mapEnter 消息缺 mapId" } });
        return;
      }
      this.send(socket, this.mapEnterResultOf(socket.identity.id, intent.mapId));
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
      // 进图门槛（#606）：这一处是**权威**，`mapEnter` 只是提前问一遍。
      // 目标图 == 服务端记下的位置（`data.mapAt`）时一律放行 —— 登录不是换图，
      // 运营事后调高门槛不能把已经站在图里的人锁在门外（#573 的教训）。
      // 被拒就回一帧 mapEnterResult（ok=false）并且**不登记观看者**：
      // 绕过 mapEnter 直发 worldJoin 的改包走的就是这条。
      const reject = this.mapEnterRejectOf(socket.identity.id, join.mapId);
      if (reject) {
        this.send(socket, this.mapEnterResultOf(socket.identity.id, join.mapId));
        return;
      }
      const zoneId = this.accounts.findById(socket.identity.id)?.zone_id ?? 1;
      // 房号（#809）：本刀只产出公共线（`slot="0"`）；分线 / 副本的选线留给第④刀，
      // 键先一次到位 —— 那时这里只多一个「选哪个 slot」的决策，下面整条链路不用动
      const roomId = roomKey(zoneId, join.mapId);
      // 快照里的坐标按 AI 实时位置覆盖（#670）：出生点不是「他现在在哪」，见 withLiveMonsterPositions
      const snapshot = this.withLiveMonsterPositions(this.world.join(roomId, socket.identity.id));
      // 位置以「被接受的 join」为准写回存档（#606）：客户端报 OnMap 是客户端的事，
      // 服务端只记自己放行过的图 —— 下次登录拿它当「他本来就在这」的判据
      this.roles.setMapAt(socket.identity.id, join.mapId);
      // 换图即清掉落账本与幂等账（#817）：**必须由服务端自己清**，不能指望客户端发
      // `targetsReset` —— 那是一条客户端消息，改包不发就能把上一张图的地面掉落吸进包。
      // 世界状态不受影响（怪物的血量与位置是共享的，不随谁换图而重置）
      this.combat.resetTargets(socket.identity.id);
      const frame: RealtimeWorldMessage = { type: "world", data: snapshot };
      this.send(socket, frame);
      // 玩家互见（#324）：随 world 应答发一份同图全量快照（增量帮不上「刚进图的人」）
      this.presence.join(socket.identity.id, roomId);
      // 队伍（#399）：快照只在变化时发，重连 / 换图的人错过了那些变化 —— 进图补一份。
      // 角色 id 取**账号行**的在线角色（不是在场表）：进图这一刻 pos 帧可能还没到，
      // 而在场表里没条目就查不到「这个角色挂在谁的连接上」，队伍状态会假死到下一次变化
      const onlineRoleId = this.accounts.findById(socket.identity.id)?.online_role_id ?? "";
      if (onlineRoleId) this.party.pushSnapshotToAccount(socket.identity.id, onlineRoleId, join.mapId);
      // 进图流水（#886）：记的是「**真的站进去了**」这一步，不是 `mapEnter` 的意图 ——
      // 被门槛拒的那次上面已经 return，改包绕过 mapEnter 直发 worldJoin 的也走不到这里
      const enterRole = onlineRoleId ? this.roles.onlineRoleRow(socket.identity.id) : null;
      this.eventLogs.record({
        type: EVENT_TYPE.ENTER_MAP,
        accountId: socket.identity.id,
        roleId: onlineRoleId || null,
        roleName: enterRole?.name ?? null,
        zoneId,
        mapId: join.mapId,
      });
      return;
    }
    this.send(socket, { type: "error", data: { message: `不认识的消息类型：${String(parsed?.type)}` } });
  }

  //#region 进图门槛（#606）

  /**
   * 这次换图该不该被拒（`null` = 放行）
   *
   * 判据只有一条：**目标图 == 服务端记下的位置（`data.mapAt`）就放行**，其余交给
   * `MapService.enterRejectOf`（等级 / 战斗力 / 战魂，与客户端提示同一套顺序）。
   *
   * 为什么要「同一个位置就放行」而不是「登录一律放行」：位置是服务端记的，
   * 玩家在哪就该在哪；把「这条连接第一次 join」当登录会让改包靠一次重连跳过门槛。
   * 反过来，「运营刚把门槛调高、人还站在里面」这种事故也由这条挡住 —— 他所在的位置
   * 与目标一致，放行，不会黑屏。
   *
   * 位置记录还没有（`mapAt` 缺失：刚建号 / 老档第一次上线）时**只准进新手村**（#859）：
   * 以前是一律放行 —— 那一刻客户端说在哪就在哪，于是「新号直接落到任意图」成了门槛的
   * 永久后门（并且 `setMapAt` 会把这次放行记下来，下一次就按新位置判了）。
   * 限制成新手村不会挡住任何人：新号本来就在那儿，客户端默认位置也是 `0`。
   */
  private mapEnterRejectOf(accountId: string, mapId: string): MapEnterReject | null {
    const row = this.roles.onlineRoleRow(accountId);
    // 没有在线角色：踢下线巡检会处理这条连接，这里不判（判也判不出等级）
    if (!row) return null;
    const data = decodeStoredRoleData(row.data);
    const current = typeof data.mapAt === "string" ? data.mapAt : "";
    // 不认识的图直接拒（#859），且排在「只准进新手村」之前：拼错 id / 地图被删都该报
    // `unknown`（「没有这张图」），而不是 `start`（「你不在新手村」）—— 后者会把人往错的方向引
    if (!this.maps.exists(mapId)) return { field: "unknown", need: 0, mapLabel: mapId };
    // 还没有位置记录：只准进新手村（#859）。这一点比「按门槛判」更严 —— 新号 1 级本来也
    // 只够进 0 图 / 3 图，但那两张不值得开先例：位置从哪来只能由服务端记
    if (!current) {
      if (mapId === START_MAP_ID) return null;
      return { field: "start", need: 0, mapLabel: this.maps.labelOf(mapId) };
    }
    if (current === mapId) return null;
    // 战斗力按服务端口径现算（与 roleUpdate 帧同一个函数）：存档里的 combat 可能落后一帧。
    // 等级在成长曲线之外算不出来（理论上到不了，曲线改坏才会）→ 用存档里那份：
    // 它同样是服务端写进去的（`applyAuthoritativeAttributes`），不是客户端自报
    const attributes = summarizeRoleAttributes(roleAttributeSourceOf(row.level, data));
    return this.maps.enterRejectOf(mapId, {
      level: row.level,
      combat: attributes?.combat ?? Math.max(0, Number(data.combat) || 0),
      soulOfWar: Math.max(0, Number(data.soulOfWar) || 0),
    });
  }

  /** 组一帧 `mapEnterResult`（放行与被拒同形，客户端只看 `ok`） */
  private mapEnterResultOf(accountId: string, mapId: string): RealtimeMapEnterResultMessage {
    const reject = this.mapEnterRejectOf(accountId, mapId);
    if (!reject) return { type: "mapEnterResult", data: { mapId, ok: true } };
    return { type: "mapEnterResult", data: { mapId, ok: false, ...reject } };
  }

  //#endregion

  /**
   * 把**一间房**的权威状态广播给正在看它的人（重生等世界变化时由世界层触发）
   *
   * 拿不到快照（房间已被卸载）就不发 —— 那只可能发生在观看者集合与世界状态不同步的瞬间，
   * 而观看者下一个 worldJoin 会拿到全量。
   */
  private broadcastWorld(roomId: string): void {
    const snapshot = this.world.snapshot(roomId);
    if (!snapshot) return;
    const frame: RealtimeWorldMessage = { type: "world", data: this.withLiveMonsterPositions(snapshot) };
    // 一次回调 = 一帧全量（world 帧是事件驱动的，重生 / 代际变化才发，不在固定节拍上）
    // #768 序列化缓存：同一帧只 stringify 一次（sendToViewers）
    this.statsRun("world", 1, () => {
      this.sendToViewers(this.world.viewersOf(roomId), frame);
    });
  }

  /**
   * 把怪物 AI 的实时坐标并进 world 快照（#670）
   *
   * world 帧里的 `x/y` 是**出生点** —— 世界层只管生死与血量，怪的走动归 AI 运行时
   * （边界见 world.service 的类注释）。这对「一直在图里的人」没影响（他跟着 monster-ai 帧走），
   * 对**晚进图 / 重连**的人却是致命的：他拿到的是一群站在出生点的怪，而 AI 帧只发**有变化的**
   * 怪 —— 一直在原地站着的那只永远不发，于是两个人屏幕上同一只怪在两个地方。
   *
   * 所以这里补一刀：快照照旧由世界层出，坐标按 AI 运行时覆盖。没有运行时的怪（图刚被第一个
   * 人加载 / 刚重生的怪）保持出生点 —— 那一刻两者本来就相等，AI tick 下一拍会建出来。
   *
   * 就地改而不是复制：world 每次调用都新建对象（`snapshotOf` 逐只 new），改返回值的字段安全。
   */
  private withLiveMonsterPositions<T extends { monsters: Array<{ instanceId: string; x: number; y: number }> }>(data: T): T {
    for (const entry of data.monsters) {
      const live = this.monsterAi.livePositionOf(entry.instanceId);
      if (!live) continue;
      entry.x = live.x;
      entry.y = live.y;
    }
    return data;
  }

  /**
   * 按观看者的屏蔽关系过滤一帧互见数据（#398）
   *
   * **不滤 `left`**：离开事件是「他走了」，漏发反而会把一个已经不在场的人留在屏幕上。
   * 多看一条无用的 left 什么也不会坏（客户端删一个不存在的节点是空操作），
   * 少发一条就会留一个幽灵。
   *
   * `full` 快照同样要滤：刚进图的人拿着全量，里面不该有他拉黑的人
   * （否则「拉黑后消失」在重进图的那一刻又冒出来）。
   */
  private visiblePlayers(
    viewerAccountId: string,
    data: { mapId: string; full: boolean; players: RealtimePlayerEntry[]; left: string[]; actions: RealtimePlayerAction[] },
  ): { mapId: string; full: boolean; players: RealtimePlayerEntry[]; left: string[]; actions: RealtimePlayerAction[] } {
    const viewerRoleId = this.presence.identityOf(viewerAccountId)?.roleId ?? "";
    if (!viewerRoleId) return data;
    const players = data.players.filter((entry) => !this.blocks.hiddenFor(viewerRoleId, entry.r ?? ""));
    // 动作事件与 players 同口径（#693）：拉黑的人出手的动画也不该出现在我的屏幕上
    const actions = data.actions.filter((action) => {
      const actorRoleId = this.presence.identityOf(action.a)?.roleId ?? "";
      return !this.blocks.hiddenFor(viewerRoleId, actorRoleId);
    });
    // 没有要滤掉的条目时原样返回：这条路径每 200ms 跑一遍，能少建一个对象就少建一个
    return players.length === data.players.length && actions.length === data.actions.length ? data : { ...data, players, actions };
  }

  //#endregion

  //#region 存活探测

  /**
   * 存活探测（每 `realtimeHeartbeatMs` 跑一次）
   *
   * socket 层**不会**自己发现对端已经没了（拔网线、进程被杀、NAT 表过期都会留下一条「看起来还在」的
   * 连接）。所以：上一轮 ping 没还 pong 的直接拆掉，还了的再 ping 一次。
   * 也就是说最坏情况下一条死连接会多留一个周期 —— 这是刻意的（宁可晚一点，也不要因为一次网络抖动误杀）。
   *
   * 同一节拍顺带两件事（#547 在线心跳，都只对库说话）：
   * - **续约**：这轮确认还活着的连接，其账号的在线心跳垫到现在 —— 「标记还在且心跳新鲜」是在线可信的形态；
   * - **清算**：宽限期（`realtimeOnlineStaleMs`，下限两个探测周期）内没有续约的在线标记判为下线
   *   （心跳与标记一起清）。玩家崩溃 / 断网后没人清标记，这里是唯一的兜底；清掉之后
   *   残留连接由踢下线巡检按既有的「从有到无」收尾，本方法不碰连接。
   */
  private sweep(): void {
    const now = Date.now();
    const alive: string[] = [];
    for (const socket of this.connections.values()) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
      alive.push(socket.identity.id);
    }
    this.accounts.touchHeartbeats(alive, now);
    const staleMs = this.onlineStaleMs();
    if (staleMs > 0) {
      const cleared = this.accounts.clearStaleOnline(now - staleMs, now);
      if (cleared > 0) {
        this.logger.warn(`在线心跳清算：${cleared} 个账号的在线标记心跳过期（超过 ${staleMs}ms 未续约），判为下线`);
      }
    }
  }

  /**
   * 在线心跳的宽限期（毫秒；0 = 关闭清算）
   *
   * 配置值不小于**两个存活探测周期**：活连接最迟每拍续约一次，更短的宽限期会把一次
   * 网络抖动误判成下线（与「死连接多留一个周期」同一个取舍：宁可晚判，不误杀）。
   */
  private onlineStaleMs(): number {
    const configured = Math.max(0, Number(this.config.get<number>("realtimeOnlineStaleMs") ?? 90_000));
    if (configured === 0) return 0;
    return Math.max(configured, this.heartbeatMs() * 2);
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
      this.chat.dropAccount(accountId);
      this.roles.clearStatusesOf(accountId);
    }
  }

  /** 建连时查一次在线角色，给巡检当基线（查不到 = 账号不存在，交给心跳自然收尾） */
  private loadKickBaseline(socket: TrackedSocket, accountId: string): void {
    const account = this.accounts.findById(accountId);
    if (this.connections.get(accountId) !== socket) return; // 还没等查完连接就被顶掉了
    socket.baselineOnlineRoleId = account?.online_role_id ?? null;
  }

  //#endregion

  //#region 移动（#811）

  /**
   * 组一帧 `path` 回执
   *
   * 起点取在场表里**被接受的**坐标：客户端自报起点能让它把路算到墙里去（「从 (0,0) 出发」），
   * 而这条路的用途是「让他走过去」，起点错了整条路都是错的。
   *
   * 位置还没有（刚进图 pos 未到）或图对不上时回 `unreachable`：客户端此刻本来就在那张图上
   * 自己走，拿到「不可达」会放弃自动寻路，比给一条从错起点出发的路安全。
   */
  private pathFrameOf(accountId: string, request: { mapId: string; to: { x: number; y: number }; seq: number }): RealtimePathMessage {
    const from = this.presence.positionOf(accountId);
    if (!from || from.mapId !== request.mapId) {
      return { type: "path", data: { seq: request.seq, mapId: request.mapId, points: [], unreachable: true, snapped: false } };
    }
    const result = this.paths.pathOf(request.mapId, { x: from.x, y: from.y }, request.to);
    return {
      type: "path",
      data: {
        seq: request.seq,
        mapId: request.mapId,
        points: result.points,
        unreachable: result.unreachable,
        snapped: result.snapped,
      },
    };
  }

  /**
   * 突进类技能的落点免检额度（#811）
   *
   * 十步一杀这类技能是**瞬移**（客户端 `setWorldPositionByTransfer`），落点随施法帧一起
   * 上报（`cast.data.x/y`，也就是服务端给区域技能夹射程用的那个点）。不给额度的话，
   * `enforce` 档会把每一次突进都判成超速再拉回原地 —— 表现为「放技能人弹回去」。
   *
   * 额度夹在 `CAST_DISPLACEMENT_MAX` 内，且由在场表按「一次性」消费，攒不起来。
   *
   * **只在结算成功之后调用**（调用点在 `onMessage` 的 cast 分支里，判 `data.ok`）：
   * 若给在结算之前，一个有冷却的技能被拒也能换到额度 → 「连点施法键 = 每帧瞬移 320px」。
   */
  private grantCastDisplacement(accountId: string, raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const data = raw as Record<string, unknown>;
    const x = Number(data.x);
    const y = Number(data.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const from = this.presence.positionOf(accountId);
    if (!from) return;
    const distance = Math.hypot(x - from.x, y - from.y);
    this.presence.noteDisplacement(accountId, Math.min(distance, CAST_DISPLACEMENT_MAX));
  }

  //#endregion

  //#region 工具

  /** 进行中的一轮（广播出口的 fn 里拿它记账；不在轮里返回 null） */
  private currentRound(): StatsRound | null {
    if (!this.statsOn || this.statsCurrentKind === null) return null;
    return this.statsRounds.get(this.statsCurrentKind) ?? null;
  }

  /**
   * 预序列化发送（#768 序列化缓存）：帧已经 stringify 过，这里只做写出与统计记账
   *
   * 字节照旧按「每收件人写出长度」累计（这是真正的下行流量），但不再各自付一次 stringify ——
   * 20 人同图时 JSON.parse/​stringify 从每拍 20 次降到 1 次，这是这刀收益的主体。
   */
  private sendPrebuilt(socket: TrackedSocket, json: string, byteLen: number): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    const round = this.currentRound();
    if (round) {
      round.bytes += byteLen;
      round.recipients += 1;
    }
    socket.send(json);
  }

  /**
   * 同一帧发给一批观看者（#768 序列化缓存）：**只 stringify 一次**，逐 socket 写出
   *
   * 三条广播出口（world / monster-ai）的帧对观看者完全相同，逐个 `send()` 的话
   * 每收件人都要各 stringify 一次 —— 量的是同一份数据。这里挪到循环外做一次。
   * 定向帧（私聊 / 队伍 / 状态推送 / 应答）不走这里，仍走 `send()`。
   */
  private sendToViewers(accountIds: Iterable<string>, frame: RealtimeServerMessage): void {
    const round = this.currentRound();
    let json: string | null = null;
    let byteLen = 0;
    for (const accountId of accountIds) {
      const socket = this.connections.get(accountId);
      if (!socket || socket.readyState !== WebSocket.OPEN) continue;
      if (json === null) {
        const t0 = round ? performance.now() : 0;
        json = JSON.stringify(frame);
        byteLen = Buffer.byteLength(json);
        if (round) {
          round.stringifyMs += performance.now() - t0;
          round.stringifies += 1;
        }
      }
      this.sendPrebuilt(socket, json, byteLen);
    }
  }

  private send(socket: TrackedSocket, message: RealtimeServerMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    // 统计开着且有广播轮正在进行（#767）：量 stringify 耗时与字节数。定向帧（私聊 /
    // 队伍 / 状态推送）不在轮里，走原路径 —— 统计代码不改变任何时序，只是多算一次
    const round = this.currentRound();
    if (round) {
      const t0 = performance.now();
      const json = JSON.stringify(message);
      round.stringifyMs += performance.now() - t0;
      round.stringifies += 1;
      round.bytes += Buffer.byteLength(json);
      round.recipients += 1;
      socket.send(json);
      return;
    }
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

/**
 * mapEnter.data 与 worldJoin 同形（#606：都只有一个目标 mapId）
 *
 * 不另写一份解析：两条消息要判的是同一件事（哪张图），形状漂了也必须一起漂。
 */
const parseMapEnter = parseWorldJoin;

/** pick.data 的解析结果（#325：格式不对回 error 帧，低频操作值得明确告知） */
interface ParsedPick {
  castId: number;
  index: number;
}

function parsePick(raw: unknown): ParsedPick | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const castId = data.castId;
  const index = data.index;
  if (typeof castId !== "number" || !Number.isFinite(castId)) return null;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return null;
  return { castId, index };
}

/** chat.data 的解析结果（#395：格式不对回 error 帧，低频操作值得明确告知） */
function parseChat(raw: unknown): RealtimeChatMessage["data"] | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.channel !== "string") return null;
  if (!(CHAT_CHANNELS as readonly string[]).includes(data.channel)) return null;
  if (typeof data.text !== "string") return null;
  const toRoleId = typeof data.toRoleId === "string" ? data.toRoleId : undefined;
  return {
    channel: data.channel as ChatChannel,
    text: data.text,
    toRoleId,
  };
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

/**
 * 一条连接两次寻路请求的最小间隔（毫秒，#811）
 *
 * 客户端重寻路的节奏是 `autoBattle.repathInterval`（出厂 400ms），这里只防刷：
 * 真有实现要更密的节奏（比如边走边修路），先改这个常量，而不是让服务端裸奔。
 */
const PATH_FIND_MIN_INTERVAL_MS = 100;

/**
 * 突进类技能落点的免检额度上界（像素，#811）
 *
 * 现网最远的突进是 200px（十步一杀 `skills.distance`），留一倍余量。
 * **不能省这条夹逼**：`cast.data.x/y` 是客户端给的，没有上界就等于「报个远点换一次瞬移」。
 */
const CAST_DISPLACEMENT_MAX = 320;

/** 解析一条 `pathFind` 帧（字段不全 / 非有限数一律当垃圾帧丢掉） */
function parsePathFind(raw: unknown): { mapId: string; to: { x: number; y: number }; seq: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.mapId !== "string" || !data.mapId) return null;
  const to = data.to as Record<string, unknown> | undefined;
  if (!to || typeof to !== "object") return null;
  const x = Number(to.x);
  const y = Number(to.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const seq = Number(data.seq);
  return { mapId: data.mapId, to: { x, y }, seq: Number.isFinite(seq) ? seq : 0 };
}

//#endregion
