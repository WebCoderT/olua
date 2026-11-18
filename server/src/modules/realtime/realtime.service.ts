import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HttpAdapterHost } from "@nestjs/core";
import { STATUS_CODES, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { BizCode } from "../../common/constants/biz-code";
import { EVENT_TYPE } from "../../common/constants/event-type";
import { ZONE_STATUS } from "../../common/constants/zone-status";
import type { ApiEnvelope, AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { AccountRepository } from "../../database/repositories/account.repository";
import { ZoneRepository } from "../../database/repositories/zone.repository";
import type { MapInstanceRow, RoleRow } from "../../database/rows";
import { WorldService } from "../world/world.service";
import { INSTANCE_EMPTY_GRACE_MS, MapInstanceService, roomKeyOf } from "../world/map-instance.service";
import type { InstanceCloseReason } from "../world/map-instance.service";
import { worldMonsterSnapshotOf } from "../world/world-monster";
import { isInstanceSlot, roomKey, splitRoomKey } from "../../common/utils/room-key.util";
import { ownsZone, shardCountOf, shardOf, shardSegment } from "../../common/utils/shard.util";
import { newTicketNonce, sealTicket, openTicket } from "./realtime-ticket.util";
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
import { CastGuardService } from "./cast-guard.service";
import { CombatSettlementService } from "./combat-settlement.service";
import { MonsterAiService } from "./monster-ai.service";
import { DropService } from "./drop.service";
import { PlayerPresenceService } from "./player-presence.service";
import { AoiService } from "./aoi.service";
import { MONSTER_ENTITY, PLAYER_ENTITY, monsterEntityOf, playerEntityOf } from "./aoi-math";
import { PathService } from "./path.service";
import { TransferGuardService } from "./transfer-guard.service";
import { QuestService } from "../quest/quest.service";
import {
  CHAT_CHANNELS,
  REALTIME_CLOSE,
  REALTIME_PATH,
  type ChatChannel,
  type RealtimeChatBroadcast,
  type RealtimeChatMessage,
  type RealtimeEntityEnterMessage,
  type RealtimeEntityLeaveMessage,
  type RealtimeIdentity,
  type RealtimeInstanceClosingMessage,
  type RealtimeInstanceEnterResultMessage,
  type RealtimeMapEnterResultMessage,
  type RealtimeMonsterAiMessage,
  type RealtimePickedMessage,
  type RealtimeRoleUpdateMessage,
  type RealtimePlayerEntry,
  type RealtimePlayersMessage,
  type RealtimePosCorrectMessage,
  type RealtimePathMessage,
  type RealtimeQuestMessage,
  type RealtimeServerMessage,
  type RealtimeSettleMessage,
  type RealtimeStatusMessage,
  type RealtimeWorldMessage,
  type RealtimeWorldMonster,
  type RealtimeWorldReloadMessage,
  type RealtimeZoneMaintenanceMessage,
  type RealtimeZoneMergedMessage,
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
  /**
   * 上一次寻路请求的时刻（#811 防刷节流；挂在连接上，断开即随对象一起回收）
   */
  lastPathFindAt?: number;
  /**
   * 他被放行进的**哪个区的世界**（#961 维护倒计时 / 合并踢线用）
   *
   * 不用在场表（`presence`）判：那张表是**报过位置**才有条目的，刚登录进图站着不动的人
   * 不在里面 —— 维护时他既收不到倒计时、也不会被断，等于一个漏网的在线玩家。这条字段在
   * `worldJoin` 放行时写一次，随连接一起回收，比每次巡检回查库便宜，也比在场表准。
   * `undefined` = 还没进过图（留在选角页 / 只在登录页），不在维护踢线的范围内。
   */
  worldZoneId?: number;
}

/**
 * 取票据的结果
 *
 * 分五种失败，给客户端的码不一样（**但客户端只需要认三种动作**）：
 * - 无效 / 已用过 → 重新取票；
 * - 过期 → 重新取票（可能还要先回登录）；
 * - **连错分片** → 重新取票（票里会带新的 `shard`），不要弹错给玩家。
 * `shard` 只在「连错分片」时给：它是给日志与人看的，浏览器拿不到失败握手的响应体。
 */
type TicketResult =
  | { ok: true; identity: RealtimeIdentity }
  | { ok: false; code: number; message: string; shard?: number };

/**
 * 用过的票据 nonce 保留多久（毫秒，至少一分钟）
 *
 * 分片之后票据是**无状态加密票**，「用过即焚」只剩「本进程记住这个 nonce」这一层。
 * 保留期刻意比票据有效期长（清理慢一点），理由同改造前：清理与判过期跑得一样勤，
 * 同一张过期票就会一会儿报「已过期」一会儿报「无效」。
 */
const TICKET_SWEEP_MIN_MS = 60_000;

/**
 * 副本扫地的间隔（毫秒；#1001 第二刀）
 *
 * 1 秒与 `WORLD_TICK_MS` 的出厂值同量级：收场广播要「限时前差不多 30 秒」，
 * 超时与空房宽限到期也该按秒收口。**刻意不配成 env** —— 它读的是一张几十字节的登记表，
 * 而为它多开一个键，只会让「本地与线上节拍不同」多一种假红来源。
 */
const INSTANCE_SWEEP_MS = 1000;

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
 * players 帧的 data（三条出口共用的形状：互见广播 / 进图快照 / AOI 裁剪）
 *
 * 提成别名是因为 #810 之后要在「裁一刀」的两个阶段之间传它，而它原本是内联在
 * `visiblePlayers` 参数里的匿名类型 —— 匿名类型写在两处就会各改各的，最后漂成两个形状。
 */
type PlayersFrameData = RealtimePlayersMessage["data"];

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
 * - 票据是**加密串**（#770 起：AES-256-GCM，密钥由 `JWT_SECRET` 派生），自带
 *   「账号 / 区 / 过期时刻」，任何一个实时进程都能独立解开，而 URL 里读不出内容；
 *   默认 30 秒过期，用过的 nonce 本进程记 30 秒（见 `usedTicketNonces`）；
 * - 握手时只是**取 AuthGuard 已经得出的结论**。令牌不在这条路径上出现第二次，
 *   也就不存在「两套校验各自漂移」这件事（#33 明确要求的）。
 *
 * ## 分片（#770 按区分片）
 * 「连接在哪个进程」由**区**决定：`shardOf(zoneId) % N`。取票时算好写进票里，
 * 客户端连 `…/realtime/s<k>`，nginx 按路径段分流到对应进程。所以：
 * - 连接与房间仍然是**进程内内存**（不需要共享存储、不需要跨进程广播）；
 * - 但票据不能再只活在一个进程的内存里 —— 取票与握手会落在不同进程上，
 *   这是票据从「随机字节 + 内存 Map」改成「无状态加密票」的唯一原因；
 * - 一个区只在一个进程里，所以「同区所有人都在同一个事件循环」这条**没有变**，
 *   世界频道 / 帮会频道 / 公告仍然是一进程内遍历连接。
 *
 * 跨进程只剩「踢下线感知」「区状态变化」两件难事，都由巡检轮询库标记解决
 * （`sweepKicked` / `sweepZoneStatus`）。
 */
@Injectable()
export class RealtimeService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name);
  /**
   * 用过的票据 nonce → 过期时刻（#770 分片后票据改无状态加密票，「用过即焚」只剩这一层）
   *
   * 只需要记**本进程**见过的：票里带区，一张票只可能落在**一个**分片上
   * （`shardOf(zoneId)`），别的分片收到它本来就会被「连错分片」拒掉。
   */
  private readonly usedTicketNonces = new Map<string, number>();
  /** 账号 → 当前那条连接（**一个账号只留一条**，见 adopt 的替换规则） */
  private readonly connections = new Map<string, TrackedSocket>();
  private server: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private ticketSweepTimer: NodeJS.Timeout | null = null;
  /** 踢下线巡检定时器（见 sweepKicked；0 = 关闭巡检） */
  private kickPollTimer: NodeJS.Timeout | null = null;
  /** 区状态巡检定时器（#961：维护倒计时 / 合并踢线；0 = 关闭巡检） */
  private zoneStatusTimer: NodeJS.Timeout | null = null;
  /**
   * 已经广播过维护倒计时的区（区 id → 广播时刻）
   *
   * 只放内存：进程重启后重新广播一次倒计时没有坏处（维护本来就是持续状态），
   * 而落库要多一张表 + 清理逻辑，不值。
   */
  private readonly maintenanceAnnounced = new Map<number, number>();
  /** 角色快照轮询定时器（见 syncRoles；0 = 关闭推送） */
  private roleSyncTimer: NodeJS.Timeout | null = null;
  /** 副本扫地定时器（#1001 第二刀：收场广播 + 超时 / 空房 / 世界丢失的收场） */
  private instanceTimer: NodeJS.Timeout | null = null;
  /**
   * 每个人「进副本之前在哪张图」（#1001 第二刀；散场往回送）
   *
   * 为什么按**账号**记而不是记在副本行上：一队人可能从不同的图进同一个本，
   * 「送回进副本前那张图」是个**人的属性**，不是这一场的属性。行上的 `origin_map_id`
   * 只是兜底（这个 map 里没有记录时用它 —— 比如进副本那一刻 `mapAt` 还是空的）。
   *
   * 只在内存：副本本身也不跨进程重启（`started_at` 非空但房间不在 = 世界丢了，直接收场），
   * 所以这份记录与它服务的对象同生共死。**落回任何非副本房间就删**（`attachToRoom`），
   * 收场送人时也删 —— 两个理由一样：这份记录只在「他正待在副本里」时才有意义。
   */
  private readonly instanceOrigins = new Map<string, string>();
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
    private readonly castGuard: CastGuardService,
    private readonly aoi: AoiService,
    private readonly chat: ChatService,
    private readonly blocks: BlockService,
    private readonly party: PartyService,
    private readonly quests: QuestService,
    private readonly world: WorldService,
    private readonly maps: MapService,
    private readonly accounts: AccountRepository,
    private readonly zones: ZoneRepository,
    private readonly roles: RolesService,
    private readonly runtimeConfig: RuntimeConfigService,
    private readonly eventLogs: EventLogService,
    private readonly paths: PathService,
    /** 传送代价（#1001）：按角色记冷却、判「算不算战斗中」。进程内内存态 */
    private readonly transfers: TransferGuardService,
    /** 副本生命周期（#1001 第二刀）：判「能不能进、几时收场」，效果（广播 / 送人）在本服务里 */
    private readonly instanceService: MapInstanceService,
    /** 地面掉落物的世界权威（#802）：进图快照、拾取、广播都走它 */
    private readonly drops: DropService,
  ) {
    // 广播出口：掉落是**图级**的（`world_drops` 还按「区 + 图」存），所以发给这张图
    // **所有线**的观看者 —— 只发公共线的话，分线的人看不见别人丢下的东西（#1000）。
    // 等 #805 把掉落搬进 Room，这里换成按房号找人即可（其余不动）
    this.drops.onBroadcast = (zoneId, mapId, frame) => {
      for (const accountId of this.world.viewersOfMap(zoneId, mapId)) {
        const socket = this.connections.get(accountId);
        if (socket) this.send(socket, frame);
      }
    };
    // 稀有掉落公告（#802）：全服一条，遍历全部连接 —— 实时进程持有所有 WS 连接，不需要跨进程
    this.drops.onAnnounce = (frame) => {
      for (const socket of this.connections.values()) this.send(socket, frame);
    };
  }

  //#region 取票据（HTTP 接口调用）

  /**
   * 签发一张连接票据
   *
   * 调用方必须是**已经过 AuthGuard** 的请求 —— 传进来的就是那份结论，这里不再校验任何东西。
   *
   * 票据里多带一样东西：**这个账号现在应该在哪个区**（#770 分片要用它算分片号）。
   * 取 `RolesService.zoneOf`：进图之后角色是权威（`roles.zone_id`），还没选角色时
   * 退回账号的「当前浏览区」—— 这也是 `worldJoin` 里算区的那同一个入口（不另写一份）。
   */
  issueTicket(user: AuthenticatedUser): RealtimeTicketDto {
    this.dropExpiredTickets();
    const ttl = this.ticketTtlMs();
    const zoneId = this.roles.zoneOf(user.id);
    const ticket = sealTicket(
      { a: user.id, u: user.username, z: zoneId, n: newTicketNonce(), e: Date.now() + ttl },
      this.ticketSecret(),
    );
    return RealtimeTicketDto.of(ticket, ttl, shardOf(zoneId, this.shardCount()));
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
    const zonePollMs = this.zoneStatusPollMs();
    if (zonePollMs > 0) {
      // 区状态巡检（#961）：维护倒计时 + 合并踢线。管理端在存档进程改 `zones.status`，
      // 连接在实时进程 —— SQLite 不做通知，轮询是唯一办法（与踢下线同一套理由）
      this.zoneStatusTimer = setInterval(() => this.sweepZoneStatus(), zonePollMs).unref();
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
    // 副本扫地（#1001 第二刀）：1 秒一拍 —— 收场广播要「差不多准」（限时前 30 秒），
    // 超时与空房宽限到期也要按秒收口。**不可配**：它读的是登记表（几十字节），
    // 而为它多开一个 env 键只是让「本地与线上节拍不同」多一种假红来源
    this.instanceTimer = setInterval(() => this.sweepInstances(), INSTANCE_SWEEP_MS).unref();
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
    // #810：出口按格子裁剪 —— 每个观看者只收「自己 3×3 格内」的怪与发生在它们身上的事件；
    // 同一格的观看者拿到的内容完全相同，所以按格分组、每组只序列化一次
    this.monsterAi.onBroadcast = (roomId, data) => {
      // 每次回调 = 一帧（一間房的增量）。统计（#767）只包住发送，不碰攒帧逻辑
      this.statsRun("monster-ai", 1, () => this.broadcastMonsterAi(roomId, data));
    };
    // 状态推送（#826 第三批）：怪物把眩晕 / 灼烧挂到某个玩家身上时，整份快照推给他本人。
    // 不推的话他要等到下一次出手被 `stunned` 拒了才知道自己被控 —— 血条莫名其妙掉一截同理。
    this.monsterAi.onStatuses = (accountId, statuses) => {
      const socket = this.connections.get(accountId);
      if (socket) this.send(socket, { type: "statuses", data: { statuses } } satisfies RealtimeStatusMessage);
    };
    // 玩家互见广播（#324）：在场表攒好一帧，这里按观看者集合发出去。
    // 两道过滤叠加：**AOI**（#810：只看 3×3 格内的人）与**屏蔽**（#398：拉黑的人不出现在屏幕上）。
    // 前者按格（同格的人结果相同、可共用序列化），后者因人而异（只有真的滤掉了的才各出一份）
    this.presence.onBroadcast = (roomId, data) => {
      this.statsRun("players", 1, () => this.broadcastPlayers(roomId, data));
    };
    // AOI 的驱动源（#810）：互见节拍（10Hz）每拍都会跑，哪怕没有任何变化 ——
    // 怪物可能正在走进某人的视野，那件事不会在玩家的增量里体现
    this.presence.onTick = () => this.aoiTick();
    // 快照兜底的定向发送（full 帧只给刚进图的连接自己）：同样过一次屏蔽过滤。
    // #810：这份快照**不按 AOI 裁** —— 刚进图的人服务端还不知道他在哪，先给全量；
    // 第一拍 AOI 会把 3×3 格外的实体 leave 掉（基线在 worldJoin 里 seed 成同一批 id）
    this.presence.onSendTo = (accountId, data) => {
      const socket = this.connections.get(accountId);
      if (!socket) return;
      const filtered = this.visiblePlayers(accountId, data);
      // 全被拉黑 = 什么都不剩：不发空帧（客户端本来就没有这些人）
      if (!filtered) return;
      this.send(socket, { type: "players", data: filtered } satisfies RealtimePlayersMessage);
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

    const shards = this.shardCount();
    this.logger.log(
      `实时通道已挂载：${this.path}${shards > 1 ? `（本进程是第 ${this.shardIndex()}/${shards} 片，路径 ${this.path}/${shardSegment(this.shardIndex())}）` : ""}（存活探测 ${heartbeatMs}ms / 在线心跳宽限 ${this.onlineStaleMs() > 0 ? `${this.onlineStaleMs()}ms` : "关"} / 票据有效期 ${this.ticketTtlMs()}ms / 踢下线巡检 ${kickPollMs > 0 ? `${kickPollMs}ms` : "关"}）`,
    );
    // 分片时把「我管哪几个区」明着打出来：出问题第一件事就是确认某个区到底该在谁身上，
    // 而这条信息只由「区清单 × 分片数」决定，现算一次比让人去翻配置强
    if (shards > 1) {
      const mine = this.zones.listStates().filter((state) => this.owns(state.id));
      this.logger.log(
        `本片负责 ${mine.length} 个区：${mine.map((state) => `${state.id}(${state.name})`).join(" / ") || "（暂无）"}`,
      );
    }
  }

  /** 踢下线巡检间隔（毫秒；0 = 关闭） */
  private kickPollMs(): number {
    return Math.max(0, Number(this.config.get<number>("realtimeKickPollMs") ?? 3000));
  }

  /** 区状态巡检间隔（毫秒；0 = 关闭 —— 关掉之后维护 / 合并都不会主动踢线） */
  private zoneStatusPollMs(): number {
    return Math.max(0, Number(this.config.get<number>("zoneStatusPollMs") ?? 5000));
  }

  /** 维护倒计时时长（毫秒；0 = 立刻断） */
  private zoneMaintenanceKickMs(): number {
    return Math.max(0, Number(this.config.get<number>("zoneMaintenanceKickMs") ?? 60_000));
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

  /**
   * 副本「人走光之后」的宽限期（毫秒；#1001 第二刀）
   *
   * 现读配置而不是 `bootstrap` 时定死：只在扫地那一拍用一次，而它正是 e2e 会压到几秒
   * 的那个旋钮（压不到就只能干等 30 秒才验得到 `emptied`）。
   */
  private instanceEmptyGraceMs(): number {
    return Math.max(0, Number(this.config.get<number>("worldInstanceEmptyGraceMs") ?? INSTANCE_EMPTY_GRACE_MS));
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
    for (const timer of [this.heartbeatTimer, this.ticketSweepTimer, this.kickPollTimer, this.zoneStatusTimer, this.roleSyncTimer, this.configRefreshTimer, this.statsTimer, this.instanceTimer]) if (timer) clearInterval(timer);
    this.heartbeatTimer = null;
    this.ticketSweepTimer = null;
    this.kickPollTimer = null;
    this.zoneStatusTimer = null;
    this.configRefreshTimer = null;
    this.roleSyncTimer = null;
    this.statsTimer = null;
    this.instanceTimer = null;
    this.usedTicketNonces.clear();

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

    const requestedShard = this.shardOfPath(pathname);
    if (requestedShard === undefined) {
      this.refuse(socket, 404, BizCode.NOT_FOUND, "接口不存在");
      return;
    }
    // 路径上点名了别的分片（#770）：这不是「接口不存在」，而是「这条路径归别的进程」。
    // 客户端拿不到失败握手的响应体（浏览器不给），所以它只会走「重新取票 → 按新票的
    // shard 重连」这一步；这里的 421 是给日志、e2e 与人看的。
    // **不给 `data.shard`**：握手时还没解析票，这里根本不知道是哪个区，硬填一个「该去的片」
    // 只会是猜的（`data.shard` 在票那一支的含义是「这个区该在的片」，一处一个意思就够了）。
    if (requestedShard !== null && requestedShard !== this.shardIndex()) {
      this.refuse(
        socket,
        421,
        BizCode.REALTIME_WRONG_SHARD,
        `本进程是第 ${this.shardIndex()} 片，不接 ${this.path}/${shardSegment(requestedShard)}`,
      );
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
      // 连错分片要单独给 421 + shard（理由同上）；其余仍是 401（凭证类问题）
      if (result.shard !== undefined) this.refuse(socket, 421, result.code, result.message, { shard: result.shard });
      else this.refuse(socket, 401, result.code, result.message);
      return;
    }

    this.server?.handleUpgrade(request, socket, head, (client) => {
      this.adopt(client as TrackedSocket, result.identity);
    });
  };

  /**
   * 握手路径里的分片段（#770）
   *
   * 三种返回：
   * - `undefined` —— 不是实时通道的路径（404）；
   * - `null` —— 是实时通道，但**没写分片**（老地址 `…/realtime`）：按「票说了算」处理，
   *   也就是「这个区的票落在哪个片就归哪个片」。不分片的部署（`N=1`）完全靠这条兼容，
   *   旧客户端零改动；
   * - 数字 —— 路径上点名了分片（`…/realtime/s2`）。
   */
  private shardOfPath(pathname: string): number | null | undefined {
    if (pathname === this.path) return null;
    const prefix = `${this.path}/`;
    if (!pathname.startsWith(prefix)) return undefined;
    const segment = pathname.slice(prefix.length);
    if (!segment.startsWith("s")) return undefined;
    const index = Number(segment.slice(1));
    return Number.isInteger(index) && index >= 0 ? index : undefined;
  }

  /**
   * 验收一张票据（#770 起是**无状态加密票**：解票 → 判过期 → 判分片 → 判重放）
   *
   * 顺序有讲究：
   * - 解票排第一：解不开的东西连「过期没有」都不该告诉它（伪造票不该从报错里学到东西）；
   * - 分片判断排在「判重放」之前：连错片不该消耗掉这张票 —— 客户端重连到正确的分片时
   *   还得用它（30 秒的票不该被一次连错就作废）；
   * - 重放判断只在本进程内（理由见 `usedTicketNonces`）。
   */
  private consumeTicket(ticket: string): TicketResult {
    const payload = openTicket(ticket, this.ticketSecret());
    if (!payload) return { ok: false, code: BizCode.TOKEN_INVALID, message: "连接票据无效或已被使用，请重新获取" };
    if (payload.e <= Date.now()) return { ok: false, code: BizCode.TOKEN_EXPIRED, message: "连接票据已过期，请重新获取" };

    const shard = shardOf(payload.z, this.shardCount());
    if (shard !== this.shardIndex()) {
      return {
        ok: false,
        code: BizCode.REALTIME_WRONG_SHARD,
        message: `这个区（${payload.z}）的实时通道在分片 ${shard} 上，请重新取票`,
        shard,
      };
    }

    if (this.usedTicketNonces.has(payload.n)) {
      return { ok: false, code: BizCode.TOKEN_INVALID, message: "连接票据无效或已被使用，请重新获取" };
    }
    // 记到「票据自己的过期时刻」为止：比票据有效期长一点，同一张票在这段时间里都算用过
    this.usedTicketNonces.set(payload.n, payload.e);

    return { ok: true, identity: { id: payload.a, username: payload.u } };
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
        // AOI 的观看者状态（#810）：断线即丢。留着它没有意义 —— seen 基线对应的是
        // 一个已经不存在的客户端，下次进图会重新 seed
        this.aoi.dropViewer(identity.id);
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
        // 冷却表（#1137 批次 2）：仍在冷却的技能 → 剩余毫秒，客户端冷却显示的存量来源
        // （进图 / 重连靠它拿到完整状态；settle-ok 只覆盖刚放的那一发）。空表不带。
        ...(() => {
          const cooldowns = this.castGuard.cooldownSnapshotOf(row.account_id, data);
          return Object.keys(cooldowns).length > 0 ? { cooldowns } : {};
        })(),
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
      // 突进类技能的落点收权（#1138）：**结算成功之后**才落位 —— 落位在结算之前等于
      // 「报个远点就换一次瞬移」，连冷却都没过就能反复要。落点由服务端算
      // （沿施法帧的落点方向夹 `CAST_DISPLACEMENT_MAX`，撞墙不挪，见 `teleportTo`）
      if (data.ok) this.placeCastDisplacement(socket.identity.id, parsed.data);
      const frame: RealtimeSettleMessage = { type: "settle", data };
      this.send(socket, frame);
      return;
    }
    if (parsed?.type === "targetsReset") {
      this.combat.resetTargets(socket.identity.id);
      return;
    }
    if (parsed?.type === "pick") {
      // 拾取（#802）：按**世界实体 id** 定位，校验与入包全在 DropService，结果以 picked 帧发回。
      // 格式不对回 error 帧（低频操作，值得一次明确告知而不是悄悄丢弃）
      const request = parsePick(parsed.data);
      if (!request) {
        this.send(socket, { type: "error", data: { message: "pick 消息缺 dropId" } });
        return;
      }
      const data = this.drops.pick(socket.identity.id, request.dropId);
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
          // #958：组队的第一道门槛 —— 队员只能来自本区（区从在场表来，不是账号浏览区）
          zoneId: identity.zoneId,
        },
        data.action,
        data.roleId,
      );
      return;
    }
    if (parsed?.type === "moveIntent") {
      // 移动意图（#1138 移动收权）：客户端只报「往哪走」，步进与碰撞在服务端。
      // 高频帧（换方向 / 换走跑都重发），格式不对静默丢弃，不回 error 刷屏
      const intent = parseMoveIntent(parsed.data);
      if (intent) this.presence.setIntent(socket.identity.id, intent.seq, intent);
      return;
    }
    if (parsed?.type === "moveStop") {
      this.presence.clearIntent(socket.identity.id);
      return;
    }
    if (parsed?.type === "pos") {
      // 位置上报（#323 AI 目标检测输入 + #324 玩家互见数据源）：格式不对就丢掉这条（高频帧，不值得回 error 刷屏）
      const position = parsePosition(parsed.data);
      if (!position) return;
      // #957：区按在线角色算（accounts 那一列只是「当前浏览区」）
      const zoneId = this.roles.zoneOf(socket.identity.id);
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
    if (parsed?.type === "instanceEnter") {
      // 进副本（#1001 第二刀）：与 worldJoin 分开是一条消息 —— 副本有「哪一场」这个维度，
      // 塞进 worldJoin 会让「进图」同时承担两套语义（选线 vs 指名某一场）
      const request = parseInstanceEnter(parsed.data);
      if (!request) {
        this.send(socket, { type: "error", data: { message: "instanceEnter 消息缺 instanceId" } });
        return;
      }
      this.enterInstance(socket, request.instanceId);
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
      // #957：区按在线角色算（accounts 那一列只是「当前浏览区」）
      const zoneId = this.roles.zoneOf(socket.identity.id);
      // 分片归属（#770）：这条连接必须落在「这个区的实时进程」上。
      // 票是 30 秒前的结论，取票之后换过区、或运维改了分片数，都会让它过时 ——
      // 所以这里用**角色现在的区**再复核一次，不归本进程就断开并让客户端重新取票。
      if (!this.owns(zoneId)) {
        this.send(socket, {
          type: "error",
          data: { message: `这个区的实时通道在分片 ${shardOf(zoneId, this.shardCount())} 上，正在重新连接` },
        });
        this.closeAccount(socket.identity.id, socket, REALTIME_CLOSE.WRONG_SHARD, "连接落在错误的分片上");
        return;
      }
      // 区状态闸门（#961）：维护中 / 已关闭 / 已合并的区不许进图。
      // 这一条是**权威**（改包绕过 mapEnter 直发 worldJoin 走的就是这里）；
      // `mapEnterResultOf` 里还有同一判据的「提前问一遍」版本，给客户端即时反馈。
      const zoneState = this.zones.stateOf(zoneId);
      if (!zoneState || zoneState.merged_into !== null || zoneState.status !== ZONE_STATUS.OPEN) {
        const zoneReject: RealtimeMapEnterResultMessage = {
          type: "mapEnterResult",
          data: { mapId: join.mapId, ok: false, field: "zone", need: 0, mapLabel: zoneState?.name ?? `区 ${zoneId}` },
        };
        this.send(socket, zoneReject);
        return;
      }
      // 选线 + 容量闸门（#1000）：判据在世界层（只有它数得清每间房几个人），这里只拿结论。
      // 「他本来就在这张图」一律放行并塞进最空的那条线 —— 登录 / 断线重连 / 运营把容量
      // 调小之后，站在图里的人不该被自己那张图的容量锁在门外（同 #573 的教训）。
      const returning = this.roles.mapAtOfOnlineRole(socket.identity.id) === join.mapId;
      const pick = this.world.pickRoom(zoneId, join.mapId, join.preferChannel);
      if (pick.full && !returning) {
        // 所有线都满：回 mapEnterResult（`field = "full"`）并且**不登记观看者** ——
        // 与门槛拒绝同一条路，客户端只认这一帧（改包绕过 mapEnter 直发的也挡在这里）
        this.send(socket, this.mapEnterResultOf(socket.identity.id, join.mapId));
        return;
      }
      // 传送代价（#1001）：**落地这一刻才是权威** —— `mapEnter` 那次只是提前问，
      // 改包绕过它直发 worldJoin 的走的就是这里，所以判据、扣钱、记冷却都必须在这条路上。
      // 顺序与 `mapEnterResultOf` 一致（门槛 → 容量 → 代价），否则「提前问」会与「落地」打架。
      const transfer = this.transferOf(socket.identity.id, join.mapId);
      const blocked = this.transferBlockOf(transfer, socket.identity.id);
      if (blocked) {
        this.send(socket, { type: "mapEnterResult", data: { mapId: join.mapId, ok: false, ...blocked } });
        return;
      }
      if (transfer && transfer.cost > 0) {
        // 扣钱走存档的既有口径（与商城 / 建帮同一个方法）：现读余额、乐观锁写回、余额不足抛 20011
        try {
          this.roles.spendBindGold(socket.identity.id, transfer.cost, "传送");
        } catch {
          // 余额在 `mapEnter` 之后被别处花掉了（商城 / 建帮 / 另一条连接）：按 money 拒，
          // 把人留在原地。**不能**吞掉异常继续进图 —— 免费传送比一条错误提示严重得多
          this.send(socket, this.mapEnterResultOf(socket.identity.id, join.mapId));
          return;
        }
      }
      // 冷却从「真的走了」那一刻起算（被拒的那次上面已经 return，不吃冷却）。
      // **只有目标图配了冷却才记**：去一张 `transfer_cooldown_ms = 0` 的图不该在
      // 下一个目的地那边变成「刚才传送过」—— 冷却属于「配了冷却的那些图」这件事本身。
      if (transfer && transfer.cooldownMs > 0) this.transfers.record(transfer.roleId);
      const roomId = roomKey(zoneId, join.mapId, pick.slot);
      this.attachToRoom(socket, { zoneId, mapId: join.mapId, slot: pick.slot, roomId });
      return;
    }
    if (parsed?.type === "changeChannel") {
      // 换线（#1000）：**不换图**、不重进场景、不动位置、不走等级门槛 ——
      // 只是把观看者从旧房间挪到新房间，回一份新的 `world` 帧让客户端就地重建。
      // 传送代价（钱 / 冷却 / 战斗中禁换）归 #1001；这一刀换线免费且无冷却。
      const request = parseChangeChannel(parsed.data);
      if (!request) {
        this.send(socket, { type: "error", data: { message: "changeChannel 消息缺 channel" } });
        return;
      }
      const accountId = socket.identity.id;
      const current = this.world.currentRoomOf(accountId);
      if (!current) {
        // 没进图就没有「换线」这回事：这是客户端状态错乱或改包，不该静默吞掉
        this.send(socket, { type: "error", data: { message: "changeChannel 需要先 worldJoin" } });
        return;
      }
      // 失败一律回原来的那条线：客户端据此把选中态改回去（服务端不生产面向玩家的句子）
      const fail = (field: "full" | "unknown" | "zone", extra?: { suggestChannel?: number; need?: number }): void => {
        this.send(socket, {
          type: "changeChannelResult",
          data: { ok: false, channel: current.channel, mapId: current.mapId, field, ...extra },
        });
      };
      // 区状态闸门（#961）：维护中 / 已合并的区不许再换线（这条连接马上要被踢）
      const zoneState = this.zones.stateOf(current.zoneId);
      if (!zoneState || zoneState.merged_into !== null || zoneState.status !== ZONE_STATUS.OPEN) {
        fail("zone");
        return;
      }
      // 「换到我现在这条线」= 幂等空操作：什么都不重建，但**也要回帧**（客户端靠它停「切换中」）。
      // 这一条必须排在容量判断之前 —— 他就站在里面，不该被自己那条线的容量拒掉
      if (request.channel === current.channel) {
        this.send(socket, {
          type: "changeChannelResult",
          data: { ok: true, channel: current.channel, mapId: current.mapId },
        });
        return;
      }
      const pick = this.world.pickRoom(current.zoneId, current.mapId, request.channel);
      // 「拿到的是不是想要的那条」只能比对返回的 channel —— `pickRoom` 在满的时候会退而求其次
      if (pick.channel !== request.channel) {
        // 线号越界 = 这张图没有这条线（`max_channels = 1` 时点「2 线」就是这种）
        if (request.channel >= pick.maxChannels) fail("unknown");
        else fail("full", { suggestChannel: pick.full ? undefined : pick.channel, need: pick.capacity });
        return;
      }
      if (pick.full) {
        // 目标线就是满的（`pickRoom` 没得退，说明所有线都满了）
        fail("full", { need: pick.capacity });
        return;
      }
      const roomId = roomKey(current.zoneId, current.mapId, pick.slot);
      // 世界层负责「退旧房 → 登记新房 → 给全量怪」（`join` 内部先 leave 再 ensure）
      const snapshot = this.withLiveMonsterPositions(this.world.join(roomId, accountId));
      this.send(socket, {
        type: "changeChannelResult",
        data: { ok: true, channel: pick.channel, mapId: current.mapId },
      });
      // 掉落快照照旧按「区 + 图」取（#805 才把掉落搬进 Room）：现在两条线共用一份地面掉落，
      // 所以这里给的是全量而不是「新房的那一份」—— 客户端按 id upsert，重复给不会出错
      this.send(socket, {
        type: "world",
        data: { ...snapshot, drops: this.drops.snapshotOf(current.zoneId, current.mapId) },
      });
      // 互见（#324）：`join` 内部会向旧房排一次 left、给本人发一份新房全量 ——
      // 不跨线可见这件事由在场表按房号（三段）分组保证，这里不用额外过滤
      this.presence.join(accountId, roomId);
      // AOI 基线（#810）：与进图同一套 —— 客户端手上的全量就是新房的那一份，别把
      // 旧房残留的实体当成「已经发过」，否则它们会永久留在画面上
      this.aoi.seed(roomId, accountId, [
        ...snapshot.monsters.map((monster) => monsterEntityOf(monster.instanceId)),
        ...this.presence.positionsOn(roomId).map((player) => playerEntityOf(player.accountId)),
      ]);
      // 旧房的目标与幂等账作废（#34）：同一张图的另一条线上那只怪不在这里，
      // 留着它等于让「打一半换线」继续对着旧房的实例结算
      this.combat.resetTargets(accountId);
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

  /**
   * 容量闸门（#1000）：这张图所有线都满了就该被拒（`null` = 还能进）
   *
   * **已经是他的图就放行**：登录 / 断线重连 / 运营把容量调小，都不该把人锁在门外
   * （与上面「同一个位置就放行」同一条理由）。真进来时塞进最空的那条线，最多超出 1 个人 ——
   * 比「玩家在自己的图外被弹回」轻得多。
   */
  private roomFullRejectOf(accountId: string, mapId: string): { field: "full"; need: number; mapLabel: string } | null {
    if (!this.maps.exists(mapId)) return null; // 不认识的图不归容量管（`mapEnterRejectOf` 已报 unknown）
    const pick = this.world.pickRoom(this.roles.zoneOf(accountId), mapId);
    // `full` 是「**所有**线都满了」，所以这里没有可推荐的线；`need` 给的是单线容量
    if (!pick.full) return null;
    if (this.roles.mapAtOfOnlineRole(accountId) === mapId) return null;
    return { field: "full", need: pick.capacity, mapLabel: this.maps.labelOf(mapId) };
  }

  /** 组一帧 `mapEnterResult`（放行与被拒同形，客户端只看 `ok`） */
  private mapEnterResultOf(accountId: string, mapId: string): RealtimeMapEnterResultMessage {
    // 区状态先判（#961）：维护中连「能不能去」都不该回 ok —— 否则客户端会先切场景、
    // 再在 worldJoin 那一步被拒，玩家看到的是黑屏 + 退回，而不是一句「本服维护中」
    const zoneState = this.zones.stateOf(this.roles.zoneOf(accountId));
    if (!zoneState || zoneState.merged_into !== null || zoneState.status !== ZONE_STATUS.OPEN) {
      return {
        type: "mapEnterResult",
        data: { mapId, ok: false, field: "zone", need: 0, mapLabel: zoneState?.name ?? "本区" },
      };
    }
    const reject = this.mapEnterRejectOf(accountId, mapId);
    if (reject) return { type: "mapEnterResult", data: { mapId, ok: false, ...reject } };
    // 门槛过了才看容量（#1000）：等级不够的人不该看到「本图已满」——那会把人往错的方向引
    const full = this.roomFullRejectOf(accountId, mapId);
    if (full) return { type: "mapEnterResult", data: { mapId, ok: false, ...full } };
    // 代价最后判（#1001）：去不了的图不该先告诉你「要 200 元宝」。
    // 顺序与 `worldJoin` 完全一致（门槛 → 容量 → 代价），否则「提前问」与「落地」会互相打脸
    const transfer = this.transferOf(accountId, mapId);
    const blocked = this.transferBlockOf(transfer, accountId);
    if (blocked) return { type: "mapEnterResult", data: { mapId, ok: false, ...blocked } };
    return { type: "mapEnterResult", data: { mapId, ok: true } };
  }

  //#region 传送代价（#1001）

  /**
   * 这张图的传送代价（`null` = 这一趟不算换图，不收钱也不吃冷却）
   *
   * **不算换图的三种情况**：目标图 == 服务端记下的位置（登录 / 断线重连 / 就站在里面）、
   * 还没有位置记录（首次进图）、没有在线角色（随后由踢下线巡检处理）。
   * 与 `roomFullRejectOf` 的「回来的人放行」是同一条理由：代价是「去别的地方」的价，
   * 不是「回到你已经待着的地方」的价 —— 否则一次断线重连就白扣一次钱。
   *
   * 读**目标图**的规则：`transfer_*` 三列描述的是「进这张图要付什么」，
   * 所以 `transferCostMoney` 是这张图的票价，不是离开上一张图的过路费。
   * 现读库（`rulesConfigOf`）：运营改完下一次换图就生效，不需要重载房间。
   */
  private transferOf(accountId: string, mapId: string): TransferCost | null {
    const row = this.roles.onlineRoleRow(accountId);
    if (!row) return null;
    const data = decodeStoredRoleData(row.data);
    const current = typeof data.mapAt === "string" ? data.mapAt : "";
    if (!current || current === mapId) return null;
    const rules = this.maps.rulesConfigOf(mapId);
    return {
      roleId: row.id,
      cost: Math.max(0, Math.trunc(rules.transferCostMoney)),
      cooldownMs: Math.max(0, Math.trunc(rules.transferCooldownMs)),
      denyInCombat: rules.denyTransferInCombat,
      bindGold: Math.max(0, Math.floor(Number(data.bindGold) || 0)),
      mapLabel: this.maps.labelOf(mapId),
    };
  }

  /**
   * 这一趟能不能走（`null` = 能走）
   *
   * 判据顺序 = 玩家看到的顺序：**战斗 → 冷却 → 钱**。「你正在打架」比「你还差 30 元宝」
   * 更该先说 —— 钱的问题等他打完再说，而不是让人先去凑钱再被告诉打不完不能走。
   *
   * 只读，不写任何东西：真正的扣钱与记冷却在 `worldJoin` 落地时做（那里才是权威）。
   */
  private transferBlockOf(
    transfer: TransferCost | null,
    accountId: string,
  ): { field: "in_combat" | "cooldown" | "money"; need: number; mapLabel: string } | null {
    if (!transfer) return null;
    if (transfer.denyInCombat && this.transfers.inCombatOf(accountId)) {
      return { field: "in_combat", need: 0, mapLabel: transfer.mapLabel };
    }
    const remainMs = this.transfers.remainMsOf(transfer.roleId, transfer.cooldownMs);
    if (remainMs > 0) return { field: "cooldown", need: remainMs, mapLabel: transfer.mapLabel };
    // `need` 给的是**还差多少**而不是票价：客户端要显示「还差 120」，票价它从配置快照里自己就有
    if (transfer.cost > 0 && transfer.bindGold < transfer.cost) {
      return { field: "money", need: transfer.cost - transfer.bindGold, mapLabel: transfer.mapLabel };
    }
    return null;
  }

  //#endregion

  //#region 副本（#1001 第二刀）

  /**
   * 落地进一间房（`worldJoin` / `instanceEnter` / 副本散场共用）
   *
   * **抽出来是为了「进图之后该做的事」只有一份**：写位置、清掉落账本、发 world 帧、
   * 登记互见、AOI 基线、队伍快照、进图流水。以前这些全在 `worldJoin` 里，副本再抄一份
   * 必然漂移（最典型的漏项是 `combat.resetTargets`：漏了就能靠改包把上一张图的掉落吸进包）。
   *
   * `mapId` 与 `slot` 分开传：副本的 `mapId` 是底图、`slot` 是 `i<n>`。`setMapAt` 记的是
   * **底图**（不是副本 id）—— 下次登录他落在底图的公共线上，而不是回到一场可能已经收场的副本。
   *
   * 参数名刻意是 `dest` 而不是 `input`：这里的 `zoneId` 是**服务端算出来的**
   * （`roles.zoneOf` / 副本行上的 `zone_id`），不是请求参数 —— 换个名字既少一次误读，
   * 也不让「区入参」那条静态守点把它当客户端传来的区（**参数名不等于来源**）。
   */
  private attachToRoom(
    socket: TrackedSocket,
    dest: { zoneId: number; mapId: string; slot: string; roomId: string },
  ): void {
    const accountId = socket.identity.id;
    // 记住「他在哪个区玩」（#961 维护 / 合并踢线的名单来源；见 TrackedSocket.worldZoneId）
    socket.worldZoneId = dest.zoneId;
    // 落到**非副本**房间 = 他已经离开副本了，那份「进副本前那张图」的记账作废
    // （下次进本按当时的 `mapAt` 重新记 —— 不删的话两场副本之间会串用上一次的原图）
    if (!isInstanceSlot(dest.slot)) this.instanceOrigins.delete(accountId);
    // 快照里的坐标按 AI 实时位置覆盖（#670）：出生点不是「他现在在哪」，见 withLiveMonsterPositions
    const snapshot = this.withLiveMonsterPositions(this.world.join(dest.roomId, accountId));
    // 位置以「被接受的 join」为准写回存档（#606）：客户端报 OnMap 是客户端的事，
    // 服务端只记自己放行过的图 —— 下次登录拿它当「他本来就在这」的判据
    this.roles.setMapAt(accountId, dest.mapId);
    // 换图即清掉落账本与幂等账（#817）：**必须由服务端自己清**，不能指望客户端发
    // `targetsReset` —— 那是一条客户端消息，改包不发就能把上一张图的地面掉落吸进包。
    // 世界状态不受影响（怪物的血量与位置是共享的，不随谁换图而重置）
    this.combat.resetTargets(accountId);
    // 地面掉落物的全量随 world 帧下发（#802）：增量广播帮不上「刚进图的人」，
    // 而图卸载**不**清掉落（生命周期只由 expireAt 决定），所以逛一圈回来还能看到原地的东西
    const frame: RealtimeWorldMessage = {
      type: "world",
      data: { ...snapshot, drops: this.drops.snapshotOf(dest.zoneId, dest.mapId) },
    };
    this.send(socket, frame);
    // 玩家互见（#324）：随 world 应答发一份同图全量快照（增量帮不上「刚进图的人」）
    this.presence.join(accountId, dest.roomId);
    // AOI 基线（#810）：进图这一刻还不知道他在哪（pos 帧随后才到），所以上面给的是
    // **全量**；这里把基线对齐成「客户端手上现有的东西」，第一拍 AOI 就只做一件事 ——
    // 把 3×3 格外的实体 leave 掉（不 seed 的话那些域外实体会永久留在他的画面上）
    this.aoi.seed(dest.roomId, accountId, [
      ...snapshot.monsters.map((monster) => monsterEntityOf(monster.instanceId)),
      ...this.presence.positionsOn(dest.roomId).map((player) => playerEntityOf(player.accountId)),
    ]);
    // 队伍（#399）：快照只在变化时发，重连 / 换图的人错过了那些变化 —— 进图补一份。
    // 角色 id 取**账号行**的在线角色（不是在场表）：进图这一刻 pos 帧可能还没到，
    // 而在场表里没条目就查不到「这个角色挂在谁的连接上」，队伍状态会假死到下一次变化
    const onlineRoleId = this.accounts.findById(accountId)?.online_role_id ?? "";
    if (onlineRoleId) this.party.pushSnapshotToAccount(accountId, onlineRoleId, dest.mapId);
    // 进图流水（#886）：记的是「**真的站进去了**」这一步，不是 `mapEnter` 的意图 ——
    // 被门槛拒的那次上面已经 return，改包绕过 mapEnter 直发 worldJoin 的也走不到这里
    const enterRole = onlineRoleId ? this.roles.onlineRoleRow(accountId) : null;
    this.eventLogs.record({
      type: EVENT_TYPE.ENTER_MAP,
      accountId,
      roleId: onlineRoleId || null,
      roleName: enterRole?.name ?? null,
      zoneId: dest.zoneId,
      mapId: dest.mapId,
    });
  }

  /** 拒绝一次进副本（服务端不生产面向玩家的句子，只给 field / need） */
  private rejectInstance(socket: TrackedSocket, data: RealtimeInstanceEnterResultMessage["data"]): void {
    this.send(socket, { type: "instanceEnterResult", data } satisfies RealtimeInstanceEnterResultMessage);
  }

  /**
   * 进副本（#1001 第二刀）
   *
   * 判据全在 `MapInstanceService`（它读 `map_instances` 与房间状态），这里只做三件事：
   * 1. 补通道才知道的判据（这条连接所在的区、区状态）；
   * 2. 判定说「这一场早该收了」时先收场（超时 / 世界丢了）；
   * 3. 放行时落地 + 首次进场标 `started_at`。
   *
   * **区按在线角色算**（与 `worldJoin` 同一个入口）：副本行里的 `zone_id` 必须等于它，
   * 否则就是拿别的区的副本 id 来串场 —— 拒绝，不去猜他想干什么。
   */
  private enterInstance(socket: TrackedSocket, instanceId: string): void {
    const accountId = socket.identity.id;
    const now = Date.now();
    const ref = splitRoomKey(instanceId);
    const row = isInstanceSlot(ref.slot) ? this.instanceService.findRow(ref.zoneId, ref.mapId, ref.slot) : null;
    const mapLabel = row ? this.maps.labelOf(row.map_id) : "";
    const base = { instanceId, mapId: row?.map_id ?? ref.mapId, mapLabel };
    if (!row) {
      this.rejectInstance(socket, { ...base, ok: false, field: "unknown" });
      return;
    }
    // 区闸门（#961）：维护中 / 已合并的区不许进；另外「这场不归本进程」也走同一个 field ——
    // 客户端看到的都是「现在进不去，换个时候」，具体原因看服务端日志
    const zoneId = this.roles.zoneOf(accountId);
    const zoneState = this.zones.stateOf(zoneId);
    if (
      zoneId !== row.zone_id ||
      !this.owns(zoneId) ||
      !zoneState ||
      zoneState.merged_into !== null ||
      zoneState.status !== ZONE_STATUS.OPEN
    ) {
      this.rejectInstance(socket, { ...base, ok: false, field: "zone", originMapId: row.origin_map_id });
      return;
    }
    const roleId = this.roles.onlineRoleRow(accountId)?.id ?? "";
    const verdict = this.instanceService.entryOfRoom({ roomId: roomKeyOf(row), accountId, roleId, now });
    if (!verdict.ok) {
      // 判定顺带说「这一场该收了」：先收（把人送回原图、清残留行）再回拒绝帧。
      // 不收的话下一拍扫地又会判一次，而「进不去的那一行」会一直挂在那儿
      if (verdict.settleReason) this.settleInstance(row, verdict.settleReason, now, socket);
      this.rejectInstance(socket, {
        ...base,
        ok: false,
        field: verdict.field,
        ...(verdict.field === "full" ? { need: row.max_players } : {}),
        originMapId: row.origin_map_id,
      });
      return;
    }
    // 「进副本前那张图」：**必须在 attachToRoom 之前读** —— 它会把人 `setMapAt` 成副本底图，
    // 之后再读就只能读到副本自己了（那样散场永远回到底图的公共线）。
    // **已经在里面的人（重进 / 断线重连）不覆盖**：他这会儿的 `mapAt` 已经是副本底图，
    // 覆盖了就等于「散场把他扔到这张图的公共线」，一队人从不同图来的信息就丢了。
    if (!this.instanceOrigins.has(accountId)) {
      const before = this.roles.mapAtOfOnlineRole(accountId);
      if (before) this.instanceOrigins.set(accountId, before);
    }
    this.attachToRoom(socket, { zoneId: row.zone_id, mapId: row.map_id, slot: row.slot, roomId: roomKeyOf(row) });
    // 首次进场才标：`started_at` 非空 = 这场已经开过，之后房间不在内存就说明世界丢了
    this.instanceService.markStarted(row, now);
  }

  /**
   * 副本扫地（每秒一次；#1001 第二刀）
   *
   * 「该广播谁、该收谁」由 `MapInstanceService.sweep` 判，这里只做效果：
   * - `closing` → 给这一场里的每个人发一帧 `instanceClosing`（限时前的一次提醒）；
   * - `settle` → 把人**送回 `originMapId`**（进副本前那张图），再销毁房间、标记收场。
   *
   * 顺序不能反：先送人再销毁房间 —— 反过来的话 `attachToRoom` 会对着一个已经被摘掉的
   * 房间找人，`world.join` 会当场按刷怪区给它重新播种一份（副本的世界就这么被复活了）。
   */
  private sweepInstances(): void {
    if (this.closing) return;
    const now = Date.now();
    for (const decision of this.instanceService.sweep(now, this.instanceEmptyGraceMs())) {
      const row = decision.row;
      if (decision.kind === "closing") {
        // 一人一帧（不是 `sendToViewers`）：`originMapId` 是**他自己**进场前那张图，
        // 一队人可能来自不同图。这一帧一次生命周期只发一次、房内最多几个人，
        // 多序列化几次比「给三个人显示同一个错误的回城点」便宜得多
        for (const accountId of this.world.viewersOf(roomKeyOf(row))) {
          const socket = this.connections.get(accountId);
          if (!socket) continue;
          const origin = this.instanceOrigins.get(accountId) ?? row.origin_map_id;
          const frame: RealtimeInstanceClosingMessage = {
            type: "instanceClosing",
            data: {
              instanceId: roomKeyOf(row),
              mapId: row.map_id,
              inMs: decision.inMs,
              originMapId: origin,
              mapLabel: this.maps.labelOf(row.map_id),
              originMapLabel: this.maps.labelOf(origin),
            },
          };
          this.send(socket, frame);
        }
        continue;
      }
      this.settleInstance(row, decision.reason, now);
    }
  }

  /**
   * 收一场副本：把里面的人送回原图 → 销毁房间（含库行）→ 标记收场
   *
   * `except` 是「正在这个请求里被判定的那个人」：他不是被散场送走的，而是本该收到
   * 一帧拒绝（比如他拿着过期的 id 硬要进）—— 把他一起送回原图会让客户端莫名其妙换一次图。
   */
  private settleInstance(row: MapInstanceRow, reason: InstanceCloseReason, now: number, except?: TrackedSocket): void {
    const roomId = roomKeyOf(row);
    const inside = [...this.world.viewersOf(roomId)];
    for (const accountId of inside) {
      const socket = this.connections.get(accountId);
      if (!socket || socket === except) continue;
      // 回**他自己**进场前那张图；没有记录（进副本那一刻 mapAt 还是空的）才退回行上的兜底
      this.relocateTo(socket, this.instanceOrigins.get(accountId) ?? row.origin_map_id);
    }
    for (const accountId of inside) this.instanceOrigins.delete(accountId);
    const removed = this.world.destroyInstanceRoom(roomId);
    this.instanceService.markClosed(row, reason, now);
    this.logger.log(`副本 ${roomId} 收场（${reason}）：送走 ${inside.length} 人、清掉 ${removed} 只实例`);
  }

  /**
   * 把一个人送进某张图的公共线（副本散场用）
   *
   * **不判容量**：散场是「你必须离开这里」，满了也得给人一个落脚点 ——
   * `pickRoom` 在全满时仍返回最空的那条线（`full: true`），这里刻意不读 `full`。
   * 也不收传送代价：他不是主动要去那张图，是被送回去的。
   */
  private relocateTo(socket: TrackedSocket, mapId: string): void {
    const zoneId = socket.worldZoneId ?? this.roles.zoneOf(socket.identity.id);
    const pick = this.world.pickRoom(zoneId, mapId);
    this.attachToRoom(socket, {
      zoneId,
      mapId,
      slot: pick.slot,
      roomId: roomKey(zoneId, mapId, pick.slot),
    });
  }

  //#endregion

  /**
   * 把**一间房**的权威状态广播给正在看它的人（重生等世界变化时由世界层触发）
   *
   * 拿不到快照（房间已被卸载）就不发 —— 那只可能发生在观看者集合与世界状态不同步的瞬间，
   * 而观看者下一个 worldJoin 会拿到全量。
   *
   * #810：这条出口也按格裁剪。world 帧是「客户端按它重建怪物集合」的权威帧 —— 不裁的话
   * 每次有人重生（每 30 秒一波）全图 145 只都会回到每个人的画面上，下一拍 AOI 再把域外的
   * 清掉，表现为「远处的怪每半分钟闪一下」。裁剪之后同格的人共用一份序列化结果。
   */
  private broadcastWorld(roomId: string): void {
    const snapshot = this.world.snapshot(roomId);
    if (!snapshot) return;
    const full = this.withLiveMonsterPositions(snapshot);
    // 索引先对齐：裁剪的依据是「他在哪、怪在哪」，用的是刚同步完的坐标
    this.syncAoiRoom(roomId);
    // 一次回调 = 一帧全量（world 帧是事件驱动的，重生 / 代际变化才发，不在固定节拍上）
    this.statsRun("world", 1, () => {
      const groups = new Map<string | null, string[]>();
      for (const accountId of this.world.viewersOf(roomId)) {
        const socket = this.connections.get(accountId);
        if (!socket || socket.readyState !== WebSocket.OPEN) continue;
        // null = 位置未知（刚进图 / 换图途中）：不裁，整份发给他
        const cell = this.aoi.viewerCellOf(accountId);
        const list = groups.get(cell) ?? [];
        list.push(accountId);
        groups.set(cell, list);
      }
      for (const [cell, accountIds] of groups) {
        const visible = cell === null ? null : this.aoi.visibleInCell(roomId, cell);
        const monsters = visible === null ? full.monsters : full.monsters.filter((monster) => visible.has(monsterEntityOf(monster.instanceId)));
        // 客户端收到 world 帧会按它重建怪物集合 —— 基线必须对齐到「这一帧里实际有的」
        for (const accountId of accountIds) {
          this.aoi.seedMonsters(
            roomId,
            accountId,
            monsters.map((monster) => monsterEntityOf(monster.instanceId)),
          );
        }
        const frame: RealtimeWorldMessage = { type: "world", data: monsters === full.monsters ? full : { ...full, monsters } };
        this.sendToViewers(accountIds, frame);
      }
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
   *
   * 返回 `null` = 滤完什么都不剩（#810：这一格本来就没看到这些人）—— 调用方据此跳过
   * 整帧，而不是发一条空帧让客户端白解析一次。
   */
  private visiblePlayers(viewerAccountId: string, data: PlayersFrameData): PlayersFrameData | null {
    const viewerRoleId = this.presence.identityOf(viewerAccountId)?.roleId ?? "";
    if (!viewerRoleId) return data;
    const players = data.players.filter((entry) => !this.blocks.hiddenFor(viewerRoleId, entry.r ?? ""));
    // 动作事件与 players 同口径（#693）：拉黑的人出手的动画也不该出现在我的屏幕上
    const actions = data.actions.filter((action) => {
      const actorRoleId = this.presence.identityOf(action.a)?.roleId ?? "";
      return !this.blocks.hiddenFor(viewerRoleId, actorRoleId);
    });
    if (players.length === 0 && actions.length === 0 && data.left.length === 0) return null;
    // 没有要滤掉的条目时原样返回：这条路径每 100ms 跑一遍，能少建一个对象就少建一个
    return players.length === data.players.length && actions.length === data.actions.length ? data : { ...data, players, actions };
  }

  //#endregion

  //#region AOI（#810：广播按格子裁剪，进出走 entityEnter / entityLeave）

  /**
   * AOI 一拍（挂在互见节拍上，10Hz）
   *
   * 顺序是固定的三件事：**先同步索引**（怪按 AI 实时坐标、玩家按在场表）、**再逐个观看者
   * 算进出**、**最后清理已经不在内存的房**。第一件事必须在第二件之前 —— 索引空着的时候
   * 算出来的「可见集合」是空集，会把客户端手里刚拿到的一整图怪全部 leave 掉。
   */
  private aoiTick(): void {
    if (this.closing) return;
    const now = Date.now();
    const active = new Set<string>();
    for (const room of this.world.viewedRooms()) {
      active.add(room.roomId);
      this.syncAoiRoom(room.roomId);
      for (const accountId of room.viewers) this.syncViewerAoi(room.roomId, room.mapId, accountId, now);
    }
    // 房间卸载（没人看满 worldMapIdleMs）不会通知本服务：每拍按「有人看的房」对一遍，
    // 不在里面的索引与观看者状态一并丢掉
    this.aoi.pruneRooms(active);
  }

  /**
   * 把一间房的权威状态同步进格子索引
   *
   * 怪的位置**优先取 AI 运行时**（世界层记的是出生点，怪被拉着走了半张图，出生点就不代表
   * 「它现在在哪」）；死掉的怪没有运行时，退回世界层的坐标 —— 它虽然不会在客户端建节点，
   * 但「在哪死」仍然影响「谁看得见这次死亡」，位置不能凭空丢。
   */
  private syncAoiRoom(roomId: string): void {
    const live = this.monsterAi.liveRuntimesOf(roomId);
    const monsterIds = new Set<string>();
    for (const monster of this.world.monstersOf(roomId)) {
      const entityId = monsterEntityOf(monster.instanceId);
      monsterIds.add(entityId);
      const runtime = live.get(monster.instanceId);
      this.aoi.index(roomId, entityId, runtime?.x ?? monster.x, runtime?.y ?? monster.y);
    }
    // 重载换过一批实例（id 全变）/ 合并区搬走：旧 id 必须从索引里掉出来，
    // 否则它会作为「可见实体」一直算进别人视野，成为一个发不出去的幽灵
    this.aoi.retain(roomId, MONSTER_ENTITY, monsterIds);

    const playerIds = new Set<string>();
    for (const player of this.presence.positionsOn(roomId)) {
      const entityId = playerEntityOf(player.accountId);
      playerIds.add(entityId);
      this.aoi.index(roomId, entityId, player.x, player.y);
    }
    this.aoi.retain(roomId, PLAYER_ENTITY, playerIds);
  }

  /**
   * 算一个观看者这一拍的进出，并把增量帧发给他
   *
   * 参数只带 `roomId` / `mapId` 两个字符串，不带整个世界域的 `Room` 对象：跨域的边
   * （`audit-server-boundaries`）只放行了 world 的**公开服务**与怪物实例契约，房间内部结构
   * 属于世界域私事 —— 这里需要的只是「哪间房」与「帧里的 mapId」。
   */
  private syncViewerAoi(roomId: string, mapId: string, accountId: string, now: number): void {
    const at = this.presence.positionOf(accountId);
    // 位置未知（刚进图 pos 还没到 / 换图途中）→ 这一拍不裁：裁剪的依据就是「他在哪」，
    // 没有就等下一拍。此时他手里是进图时那份全量，不会有错，只是暂时没被裁
    if (!at || at.roomId !== roomId) return;
    const { enters, leaves } = this.aoi.diff(roomId, accountId, at.x, at.y, now);
    const socket = this.connections.get(accountId);
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (enters.length > 0) this.sendEntityEnter(socket, roomId, mapId, accountId, enters);
    if (leaves.length > 0) this.sendEntityLeave(socket, mapId, leaves);
  }

  /** 组一帧 `entityEnter`（怪：世界层快照 + AI 实时坐标；玩家：在场表条目） */
  private sendEntityEnter(socket: TrackedSocket, roomId: string, mapId: string, accountId: string, entityIds: string[]): void {
    const monsters: RealtimeWorldMonster[] = [];
    const players: RealtimePlayerEntry[] = [];
    for (const entityId of entityIds) {
      if (entityId.startsWith(MONSTER_ENTITY)) {
        const snapshot = this.monsterSnapshotOf(roomId, entityId.slice(MONSTER_ENTITY.length));
        if (snapshot) monsters.push(snapshot);
        continue;
      }
      // 自己的条目不发（客户端本来就有自己），AOI 那边也不会把它算进 enters
      const entry = this.presence.entryOf(entityId.slice(PLAYER_ENTITY.length));
      if (entry) players.push(entry);
    }
    if (monsters.length === 0 && players.length === 0) return;
    const frame: RealtimeEntityEnterMessage = { type: "entityEnter", data: { mapId, monsters, players } };
    this.send(socket, frame);
  }

  /** 组一帧 `entityLeave`（只有 id：客户端按 id 拆节点，别的都不需要） */
  private sendEntityLeave(socket: TrackedSocket, mapId: string, entityIds: string[]): void {
    const monsters: string[] = [];
    const players: string[] = [];
    for (const entityId of entityIds) {
      if (entityId.startsWith(MONSTER_ENTITY)) monsters.push(entityId.slice(MONSTER_ENTITY.length));
      else players.push(entityId.slice(PLAYER_ENTITY.length));
    }
    const frame: RealtimeEntityLeaveMessage = { type: "entityLeave", data: { mapId, monsters, players } };
    this.send(socket, frame);
  }

  /** 一只怪的快照（世界层权威血量 / 存活 + AI 实时坐标） */
  private monsterSnapshotOf(roomId: string, instanceId: string): RealtimeWorldMonster | null {
    const monster = this.world.monsterOf(roomId, instanceId);
    if (!monster) return null;
    const snapshot = worldMonsterSnapshotOf(monster);
    const live = this.monsterAi.liveRuntimesOf(roomId).get(instanceId);
    if (!live) return snapshot;
    snapshot.x = live.x;
    snapshot.y = live.y;
    return snapshot;
  }

  /**
   * 怪物 AI 出口（#810）：按格裁剪，**同一格只序列化一次**
   *
   * 一帧里可能同时有位置变化、命中、施法、击杀四路负载，全部按「那只怪在不在你的视野里」
   * 过滤。命中事件同样按怪的可见性判：怪打得到你时它必然在你的视野内（普攻距离远小于
   * 一格），所以不需要为「自己挨打」单开例外。
   */
  private broadcastMonsterAi(roomId: string, data: RealtimeMonsterAiMessage["data"]): void {
    const groups = new Map<string | null, string[]>();
    for (const accountId of this.world.viewersOf(roomId)) {
      const socket = this.connections.get(accountId);
      if (!socket || socket.readyState !== WebSocket.OPEN) continue;
      // null = 位置未知：不裁（刚进图那几十毫秒）
      const cell = this.aoi.viewerCellOf(accountId);
      const list = groups.get(cell) ?? [];
      list.push(accountId);
      groups.set(cell, list);
    }
    for (const [cell, accountIds] of groups) {
      const frame: RealtimeMonsterAiMessage | null =
        cell === null ? { type: "monster-ai", data } : this.monsterAiFrameIn(roomId, cell, data);
      // 这一格什么都看不到 → 不发空帧（人多了之后这是常态：大多数格没有变化）
      if (!frame) continue;
      this.sendToViewers(accountIds, frame);
    }
  }

  /** 裁剪一帧 monster-ai：只留这个格子里看得见的怪与发生在它们身上的事 */
  private monsterAiFrameIn(roomId: string, cell: string, data: RealtimeMonsterAiMessage["data"]): RealtimeMonsterAiMessage | null {
    const visible = this.aoi.visibleInCell(roomId, cell);
    const monsters = data.monsters.filter((entry) => visible.has(monsterEntityOf(entry.i)));
    const hits = data.hits.filter((hit) => visible.has(monsterEntityOf(hit.i)));
    const casts = data.casts.filter((cast) => visible.has(monsterEntityOf(cast.i)));
    const kills = data.kills.filter((kill) => visible.has(monsterEntityOf(kill.i)));
    if (monsters.length === 0 && hits.length === 0 && casts.length === 0 && kills.length === 0) return null;
    // t 原样带上（#769）：裁剪只删条目，不该改时间基准 —— 同一拍的各格共用同一份 data 的 t
    return { type: "monster-ai", data: { mapId: data.mapId, t: data.t, monsters, hits, casts, kills } };
  }

  /**
   * 玩家互见出口（#810）：AOI 裁剪 + 屏蔽过滤，**同一格只序列化一次**
   *
   * 两道过滤的差别决定了怎么复用序列化：AOI 的裁剪结果只取决于「你在哪一格」（同格相同），
   * 屏蔽的结果因人而异。所以先按格算一份「裁剪后」的基线，没拉黑任何人的观看者共用它
   * （以及它的 JSON），拉黑了人的那几个再各自过滤一份（少数派，与 #768 的处理一致）。
   */
  private broadcastPlayers(roomId: string, data: PlayersFrameData): void {
    const groups = new Map<string | null, { accounts: string[]; base: PlayersFrameData | null }>();
    const custom: Array<{ accountId: string; data: PlayersFrameData }> = [];
    for (const accountId of this.world.viewersOf(roomId)) {
      const socket = this.connections.get(accountId);
      if (!socket || socket.readyState !== WebSocket.OPEN) continue;
      const cell = this.aoi.viewerCellOf(accountId);
      let group = groups.get(cell);
      if (!group) {
        group = { accounts: [], base: this.cropPlayersData(roomId, cell, data) };
        groups.set(cell, group);
      }
      // 这一格看不到这批变化（同格没有这些人）→ 这一帧对他没有意义
      if (!group.base) continue;
      const filtered = this.visiblePlayers(accountId, group.base);
      if (!filtered) continue;
      if (filtered === group.base) group.accounts.push(accountId);
      else custom.push({ accountId, data: filtered });
    }
    for (const group of groups.values()) {
      if (group.base && group.accounts.length > 0) {
        this.sendToViewers(group.accounts, { type: "players", data: group.base } satisfies RealtimePlayersMessage);
      }
    }
    for (const one of custom) {
      const socket = this.connections.get(one.accountId);
      if (socket) this.send(socket, { type: "players", data: one.data } satisfies RealtimePlayersMessage);
    }
  }

  /**
   * 按 AOI 裁剪一帧互见数据（不含屏蔽过滤）
   *
   * `left` 不过滤：它是「这个人不在图里了」，必须让所有收件人拆节点 —— 与屏蔽那边
   * 的同一条理由（漏发留幽灵，多发是空操作）。
   */
  private cropPlayersData(roomId: string, cell: string | null, data: PlayersFrameData): PlayersFrameData | null {
    if (cell === null) return data;
    const visible = this.aoi.visibleInCell(roomId, cell);
    const players = data.players.filter((entry) => visible.has(playerEntityOf(entry.a)));
    const actions = data.actions.filter((action) => visible.has(playerEntityOf(action.a)));
    if (players.length === 0 && actions.length === 0 && data.left.length === 0) return null;
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
      this.closeAccount(accountId, socket, REALTIME_CLOSE.REPLACED, "登录状态已变更（被踢下线或已登出），请重新选角");
    }
  }

  /**
   * 区状态巡检（#961：维护倒计时 / 合并踢线）
   *
   * 两件事，都是「管理端在存档进程写库、连接在实时进程」这一形态逼出来的：
   *
   * 1. **维护**：某个区转 `maintenance` 后，先给区里的人广播一次 `zoneMaintenance`
   *    （带倒计时），到点再断。倒计时只广播一次 —— 每拍重发等于把客户端计时器
   *    每秒归零一次。
   * 2. **合并**：某个区 `merged_into` 非空 → 发 `zoneMerged` 并**立即**断。合并之后
   *    这个区号已经不存在了，让他继续待在旧世界里看到的全是半小时前的状态。
   *
   * 只看**连接上记的那个区**（`socket.worldZoneId`，`worldJoin` 放行时写的）：还没进过图的
   * 连接不踢 —— 他本来就还没进游戏，回登录页重新选服即可。不用在场表（`presence`）：
   * 那张表要报过位置才有条目，刚进图站着不动的人会被漏掉（既收不到倒计时也不会被断）。
   */
  private sweepZoneStatus(): void {
    if (this.closing) return;
    const now = Date.now();
    const states = this.zones.listStates();
    const byId = new Map(states.map((state) => [state.id, state]));

    for (const state of states) {
      // 只处理本进程负责的区（#770）：别的区的连接不在这个进程里，遍历它们纯属白跑，
      // 而且「维护倒计时按区记在内存里」那份表会白白涨到全区数
      if (!this.owns(state.id)) continue;
      // —— 已合并：发帧 + 立即断 ——
      if (state.merged_into !== null) {
        const accounts = this.accountsInWorldOf(state.id);
        if (accounts.length === 0) continue;
        const target = byId.get(state.merged_into);
        for (const accountId of accounts) {
          const socket = this.connections.get(accountId);
          if (!socket) continue;
          const frame: RealtimeZoneMergedMessage = {
            type: "zoneMerged",
            data: {
              zoneId: state.id,
              zoneName: state.name,
              mergedInto: state.merged_into,
              mergedIntoName: target?.name ?? `区 ${state.merged_into}`,
            },
          };
          this.send(socket, frame);
          this.logger.log(`账号 ${accountId} 所在区「${state.name}」已合并，断开其实时连接`);
          this.closeAccount(accountId, socket, REALTIME_CLOSE.ZONE_MERGED, `本区已并入「${frame.data.mergedIntoName}」，请重新选择区服`);
        }
        this.maintenanceAnnounced.delete(state.id);
        continue;
      }

      // —— 维护：先倒计时，到点断 ——
      if (state.status !== ZONE_STATUS.MAINTENANCE) {
        // 恢复了就忘了这次维护，下次再转维护要重新广播
        this.maintenanceAnnounced.delete(state.id);
        continue;
      }
      const accounts = this.accountsInWorldOf(state.id);
      if (accounts.length === 0) continue;
      const kickMs = this.zoneMaintenanceKickMs();
      const announcedAt = this.maintenanceAnnounced.get(state.id);
      if (announcedAt === undefined) {
        this.maintenanceAnnounced.set(state.id, now);
        for (const accountId of accounts) {
          const socket = this.connections.get(accountId);
          if (!socket) continue;
          const frame: RealtimeZoneMaintenanceMessage = {
            type: "zoneMaintenance",
            data: { zoneId: state.id, zoneName: state.name, inMs: kickMs },
          };
          this.send(socket, frame);
        }
        this.logger.warn(`区服「${state.name}」进入维护：已向 ${accounts.length} 名在线玩家广播 ${Math.round(kickMs / 1000)} 秒倒计时`);
        continue;
      }
      if (now - announcedAt < kickMs) continue;
      for (const accountId of accounts) {
        const socket = this.connections.get(accountId);
        if (!socket) continue;
        this.closeAccount(accountId, socket, REALTIME_CLOSE.MAINTENANCE, `本区（${state.name}）正在维护，请稍后再进`);
      }
      this.maintenanceAnnounced.delete(state.id);
      this.logger.log(`区服「${state.name}」维护倒计时结束，已断开该区全部在线连接`);
    }
  }

  /**
   * 这个区里此刻有哪些账号的实时连接（#961 维护 / 合并踢线用）
   *
   * 判据是**连接上记的那个区**，不是在场表：见 `TrackedSocket.worldZoneId` 的注释。
   * 线性扫一遍连接表（在线量级是几百，巡检每秒一次，够用）。
   */
  private accountsInWorldOf(zoneId: number): string[] {
    const ids: string[] = [];
    for (const [accountId, socket] of this.connections) {
      if (socket.worldZoneId === zoneId) ids.push(accountId);
    }
    return ids;
  }

  /**
   * 断开一条连接并清干净它在各服务里的痕迹
   *
   * 抽出来是因为三条路径要一模一样地收尾（踢下线巡检 / 维护到期 / 区被合并）：
   * 少清一处就是「人走了但还挂在这间房里」—— 那间房的 AI 照跑、监控照采样、
   * 世界频道还往一个不在的人身上投递（#821 踩过）。
   */
  private closeAccount(accountId: string, socket: TrackedSocket, code: number, reason: string): void {
    socket.close(code, reason);
    this.connections.delete(accountId);
    // 与 close 事件的清理同口径：退观看者、清幂等账、清位置上报（世界状态是共享的，不清）
    this.combat.dropAccount(accountId);
    this.presence.dropAccount(accountId);
    this.aoi.dropViewer(accountId);
    this.world.leave(accountId);
    this.chat.dropAccount(accountId);
    this.roles.clearStatusesOf(accountId);
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
   * 突进类技能的服务端落位（#1138 收权）
   *
   * 十步一杀这类技能是**瞬移**（客户端 `setWorldPositionByTransfer`），施法帧带着落点
   * （`cast.data.x/y`，服务端给区域技能夹射程用的同一个点）。旧做法是给免检额度等客户端
   * 上报落点 —— 本质还是「相信客户端的坐标」。收权后：结算成功就由服务端把人挪过去
   * （方向与距离按施法帧的落点算，夹在 `CAST_DISPLACEMENT_MAX` 内；撞墙 / 出图不挪）。
   *
   * **只在结算成功之后调用**（调用点在 `onMessage` 的 cast 分支里，判 `data.ok`）：
   * 若落在结算之前，一个有冷却的技能被拒也能换到一次瞬移。
   */
  private placeCastDisplacement(accountId: string, raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const data = raw as Record<string, unknown>;
    const x = Number(data.x);
    const y = Number(data.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.presence.teleportTo(accountId, x, y, CAST_DISPLACEMENT_MAX);
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
  private refuse(socket: Duplex, status: number, code: number, message: string, data: unknown = null): void {
    const body = JSON.stringify({
      code,
      message,
      data,
      timestamp: Date.now(),
    } satisfies ApiEnvelope<unknown>);
    socket.end(
      `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Error"}\r\n` +
        "Connection: close\r\n" +
        "Content-Type: application/json; charset=utf-8\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        "\r\n" +
        body,
    );
  }

  /** 清掉已经过期的 nonce（兜底：防「取一堆票再也不来」把这张表撑起来） */
  private dropExpiredTickets(): void {
    const now = Date.now();
    for (const [nonce, expiresAt] of this.usedTicketNonces) if (expiresAt <= now) this.usedTicketNonces.delete(nonce);
  }

  private ticketTtlMs(): number {
    return this.config.get<number>("realtimeTicketTtlMs") ?? 30_000;
  }

  /**
   * 票据密钥的**来源**（实际密钥在 `realtime-ticket.util` 里由它哈希成 32 字节）
   *
   * 复用 `JWT_SECRET`：两个实时进程必须用同一把（同一份 `.env` 已经保证了这件事），
   * 而**不新开一个**密钥的理由是「少一个必须对齐的部署变量」。安全上够用 ——
   * 票 30 秒过期、只给握手用、泄漏了也只影响一次连接。
   */
  private ticketSecret(): string {
    return this.config.get<string>("jwtSecret") ?? "";
  }

  /** 分片数（每次现读配置；它是启动期常量，这里只是省一个字段） */
  private shardCount(): number {
    const count = shardCountOf(this.config.get<number>("realtimeShardCount") ?? 1);
    // 内嵌形态（`REALTIME_EMBEDDED=true`，本地开发与全部既有 e2e 的默认）只有一个进程，
    // 分片无从谈起 —— 强行按 1 处理，否则「配了 2 片」会让一半的区连不上（进程只认自己是 0 片）
    if (count > 1 && (this.config.get<boolean>("realtimeEmbedded") ?? true)) return 1;
    return count;
  }

  /** 本进程的分片号（越界按 0，与 `ownsZone` 同一口径） */
  shardIndex(): number {
    const count = this.shardCount();
    const index = Number(this.config.get<number>("realtimeShardIndex") ?? 0);
    return Number.isInteger(index) && index >= 0 && index < count ? index : 0;
  }

  /** 这个区归不归本进程管（#770 准入与进图复核共用这一处） */
  owns(zoneId: number): boolean {
    return ownsZone(zoneId, this.shardCount(), this.shardIndex());
  }

  private heartbeatMs(): number {
    return this.config.get<number>("realtimeHeartbeatMs") ?? 30_000;
  }

  //#endregion
}

//#region 消息解析（小工具）

/** worldJoin.data 的解析结果（#295 起只带 mapId，播种完全在服务端；#1000 加可选的偏好线） */
interface ParsedWorldJoin {
  mapId: string;
  /** 想进几线（不合法就当没提 —— 越界的线号不值得回 error，服务端自己会兜） */
  preferChannel?: number;
}

function parseWorldJoin(raw: unknown): ParsedWorldJoin | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.mapId !== "string" || !data.mapId) return null;
  const preferChannel = toChannel(data.preferChannel);
  return preferChannel === undefined ? { mapId: data.mapId } : { mapId: data.mapId, preferChannel };
}

/**
 * mapEnter.data 与 worldJoin 同形（#606：都只有一个目标 mapId）
 *
 * 不另写一份解析：两条消息要判的是同一件事（哪张图），形状漂了也必须一起漂。
 * `preferChannel` 对 `mapEnter` 无意义（它只回答「能不能去这张图」），多带也不会被读。
 */
const parseMapEnter = parseWorldJoin;

/** 线号：非负整数才算（浮点 / 负数 / 字符串一律当没提） */
function toChannel(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) return undefined;
  return raw;
}

/** changeChannel.data 的解析结果（#1000：只带目标线号） */
interface ParsedChangeChannel {
  channel: number;
}

function parseChangeChannel(raw: unknown): ParsedChangeChannel | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const channel = toChannel(data.channel);
  if (channel === undefined) return null;
  return { channel };
}

/**
 * instanceEnter.data 的解析（#1001 第二刀）
 *
 * `instanceId` 就是房间键（`1:3:i7`），长度上限按房间键的量级给 —— 它不是自由文本，
 * 拼错 / 超长的直接当格式错误（回 error 帧），不浪费一次库查询。
 */
function parseInstanceEnter(raw: unknown): { instanceId: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const instanceId = data.instanceId;
  if (typeof instanceId !== "string" || instanceId.length === 0 || instanceId.length > 64) return null;
  return { instanceId };
}

/** pick.data 的解析结果（#325：格式不对回 error 帧，低频操作值得明确告知） */
interface ParsedPick {
  /** 地面实体的 id（#802 起按它定位，不再用 castId + 下标） */
  dropId: string;
}

function parsePick(raw: unknown): ParsedPick | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const dropId = data.dropId;
  if (typeof dropId !== "string" || dropId.length === 0 || dropId.length > 64) return null;
  return { dropId };
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

/** moveIntent.data 的解析结果（#1138：格式不对整条丢弃，高频帧不回 error） */
interface ParsedMoveIntent {
  seq: number;
  kind: "dir" | "target";
  /** kind = dir：方向向量（是否单位向量交给 guard 归一化） */
  dx: number;
  dy: number;
  /** kind = target：目标点 */
  tx: number;
  ty: number;
  run: boolean;
}

function parseMoveIntent(raw: unknown): ParsedMoveIntent | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const seq = Number(data.seq);
  const kind = data.kind;
  const run = data.run === true;
  if (kind === "dir") {
    const dx = Number(data.dx);
    const dy = Number(data.dy);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
    return { seq, kind, dx, dy, tx: 0, ty: 0, run };
  }
  if (kind === "target") {
    const tx = Number(data.tx);
    const ty = Number(data.ty);
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) return null;
    return { seq, kind, dx: 0, dy: 0, tx, ty, run };
  }
  return null;
}

/**
 * 一条连接两次寻路请求的最小间隔（毫秒，#811）
 *
 * 客户端重寻路的节奏是 `autoBattle.repathInterval`（出厂 400ms），这里只防刷：
 * 真有实现要更密的节奏（比如边走边修路），先改这个常量，而不是让服务端裸奔。
 */
const PATH_FIND_MIN_INTERVAL_MS = 100;

/**
 * 突进类技能服务端落位的距离上界（像素，#811 定值 / #1138 改作落位夹逼）
 *
 * 现网最远的突进是 200px（十步一杀 `skills.distance`），留一倍余量。
 * **不能省这条夹逼**：`cast.data.x/y` 是客户端给的，没有上界就等于「报个远点换一次瞬移」。
 */
const CAST_DISPLACEMENT_MAX = 320;

/**
 * 一次换图的传送代价（#1001；`transferOf` 的产物，判据与扣款共用这一份读数）
 *
 * 读一次库、判两次（`mapEnter` 的提前问 + `worldJoin` 的落地）—— 两处各自读一遍会多两次
 * 存档解析，而且「提前问说够钱、落地又说不够」的窗口还会被放大。
 */
interface TransferCost {
  /** 谁的冷却（按角色记：同账号换角色不继承上一个角色的冷却） */
  roleId: string;
  /** 票价（绑定元宝；0 = 免费） */
  cost: number;
  /** 冷却（毫秒；0 = 无冷却） */
  cooldownMs: number;
  /** 战斗中是否禁止换图（`map_rules.deny_transfer_in_combat`） */
  denyInCombat: boolean;
  /** 当前余额（只用于判够不够；真正扣钱由 `spendBindGold` 现读，两者之间还有一道乐观锁） */
  bindGold: number;
  /** 图名（提示里要用） */
  mapLabel: string;
}

/** 解析一条 `pathFind` 帧（字段不全 / 非有限数一律当垃圾帧丢掉） */
function parsePathFind(raw: unknown): { mapId: string; to: { x: number; y: number }; seq: number } | null {  if (!raw || typeof raw !== "object") return null;
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
