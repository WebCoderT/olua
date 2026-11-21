import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GuildRepository } from "../../database/repositories/guild.repository";
import { RolePositionRepository } from "../../database/repositories/role-position.repository";
import { roleAttributeSourceOf, summarizeRoleAttributes } from "../combat/role-attributes";
import { START_MAP_ID } from "../map/map.service";
import { RolesService } from "../roles/roles.service";
import { MapGeometryService, slideStep } from "./map-geometry.service";
import { MovementGuardService, MovementRejectReason, MoveIntent } from "./movement-guard.service";
import { PUBLIC_SLOT, roomKey, splitRoomKey } from "../../common/utils/room-key.util";
import type { RoomRef } from "../../common/utils/room-key.util";
import type { RealtimePlayerAction, RealtimePlayerAppearance, RealtimePlayerEntry } from "./realtime.protocol";

/**
 * 一名在线玩家的在场信息（#324：玩家互见的数据源）
 *
 * **内存态、不落盘**：位置在 #1138 移动收权后是**服务端步进出来的**（10Hz，见
 * `stepIntents`）—— 兼容期没有激活意图的账号仍按客户端自报仲裁（#811 的闸还在），
 * 但意图一激活坐标就只由服务端写。血量在批次 4 之前仍由 pos 帧带来（权威落账在
 * `applyMonsterHit`，这里只是副本）。
 */
interface PresenceEntry {
  zoneId: number;
  mapId: string;
  /** 线（#809：'0' 公共线；第④刀起会有 '1'.. 与 'i<seq>'）—— 与区 + 图一起决定房间 */
  slot: string;
  x: number;
  y: number;
  hp: number;
  /** 血条分母（首见时算一次；之后随外观懒刷新一起对齐 —— 换装 / 升级 / 晋升都会改它） */
  maxHp: number;
  /** 上报时刻是否在移动（客户端自报） */
  moving: boolean;
  updatedAt: number;
  /** 角色 id（#389：社交关系按角色记，首见时定下，角色换了连接也换了） */
  roleId: string;
  /** 所属帮会 id / 名字（#389：空串 = 无帮会；入帮退帮随外观懒刷新一起对齐） */
  guildId: string;
  guildName: string;
  /**
   * 所属队伍 id（#399；空串 = 没队伍）
   *
   * 与帮会不同，它**每个广播节拍现算**（`partyOfRole` 是一次内存 Map 查询）：
   * 组队 / 退队 / 被踢要立刻反映到别人的屏幕上（队友是金色的），等 5 秒的外观懒刷新
   * 会让「刚组队却还是白名」变成常态。
   */
  partyId: string;
  /** 外观（#383：首见读一次，之后按 appearanceRefreshMs 懒刷新 —— 换装最多这么多秒被别人看到） */
  appearance: RealtimePlayerAppearance;
  /** 上次读外观的时刻（懒刷新判据） */
  appearanceAt: number;
  /** 上次广播出去的外观（增量广播的判据；空串保证首帧一定带上） */
  sentAppearance: string;
  /** 上次广播出去的帮会（#389 的增量判据：入帮 / 退帮 / 帮会改名都要重发） */
  sentGuild: string;
  /** 上次广播出去的队伍（#399 的增量判据：组队 / 退队 / 换队都要重发） */
  sentParty: string;
  /** 上次广播出去的位置 / 移动标记 / 血量 / 血条分母（增量广播的判据） */
  sentX: number;
  sentY: number;
  sentMoving: boolean;
  sentHp: number;
  sentMaxHp: number;
  /**
   * 位置可信度基线（#596 最小仲裁 / #811 三道校验）：上次**被接受**的上报坐标与时刻。
   * 只影响 x/y 是否进在场表，hp / moving 不参与 —— 血量有权威落账链路，不在这一层管。
   */
  trustedX: number;
  trustedY: number;
  trustedAt: number;
  /**
   * 当前移动意图（#1138 移动收权；null = 没在走）
   *
   * 意图激活期间坐标由服务端 10Hz 步进（见 `stepIntents`），`pos` 帧的坐标与移动标记
   * **不再被采纳**（兼容期客户端还带着本地物理，两边的绕障路径本来就不一致 ——
   * 采纳哪一份都会打架）。到点（target 类）、`moveStop`、换图、被控转不锁都会清。
   */
  intent: MoveIntent | null;
  /** 最近一次被接受的意图序号（`moveIntent.seq`，挡明显倒退的乱序帧） */
  intentSeq: number;
  /** 上次步进时刻（10Hz 步进的 Δt 基准） */
  lastStepAt: number;
  /** 上次发 `posCorrect` 的时刻（节流判据，见 `movement.correctIntervalMs`） */
  correctedAt: number;
  /**
   * 上一份写进 `role_positions` 的坐标指纹（`mapId:x:y`；空串 = 还没写过）
   *
   * 用「指纹 + 时刻」两个字段而不是存一份坐标副本：落盘的判据只有一条
   * 「和上次写进去的不一样」，改了哪个分量都算不一样（含换图）。
   */
  persisted: string;
  persistedAt: number;
}

/**
 * 一个账号此刻的在场信息（`entries` 的值）
 *
 * `zoneId` / `mapId` / `slot` 三者一起决定**他在哪间房**（#809）。老代码只有前两个，
 * 于是「同图不同线」在分线之后会互相看见 —— 键一次带到 slot，第④刀做分线时这里不用再动。
 */
function entryRoomKey(entry: { zoneId: number; mapId: string; slot: string }): string {
  return roomKey(entry.zoneId, entry.mapId, entry.slot);
}

/**
 * 玩家互见（#324：同图玩家的位置 / 血量 / 移动标记互见）
 *
 * ===========================================================================
 * 服务端做什么
 * ===========================================================================
 * 维护一张「谁在哪」的在场表（数据来自客户端的 `pos` 帧），**它是位置的唯一副本**：
 * 怪物 AI 的索敌 / 追击直接读这张表（#855 —— AI 曾经自己存过一份原始坐标，一份 `pos`
 * 骗两边的洞就出在那儿）。这里负责仲裁与转发，AI 只读，谁也不许再存第二份：
 * - **增量广播**：按 `PLAYER_SYNC_BROADCAST_MS` 节流，只发「位置 / 移动标记 / 血量变了」
 *   的玩家，按观看者集合发给同图的人 —— 与 monster-ai 帧同一套分发模式；
 * - **快照兜底**：worldJoin 应答之后立刻发给刚进图的连接一份全量（`full = true`），
 *   增量帮不上「刚进来的人对全图一无所知」；
 * - **离开广播**：断线 / 被踢立即广播 left；超时没上报（网络抖动）按广播节拍进 left，
 *   重新上报后会作为「新变化」再次出现 —— 消失与重现都是显式事件，客户端不做猜测。
 *
 * ===========================================================================
 * 刻意不做的
 * ===========================================================================
 * - **不算关系**（#389）：好友 / 敌人 / 同帮这些判定放客户端。服务端要为每个观看者
 *   各算一遍「他对我是什么关系」是 O(n²)，而原料（我的社交快照 + 他的 roleId / guildId）
 *   本来就在两端各有一份 —— 服务端只负责把原料发全，怎么上色是表现层的事；
 * - **不落盘（权威不落盘）**：位置是几秒钟的表现层状态，持久真相仍在各自存档的出生定位。
 *   #862/#863 起额外把**一份带时刻的快照**节流写进 `role_positions`，但那是给存档进程
 *   做「有没有隔着半张图点 NPC」的判定用的投影：内存这份才是权威，快照随时可以过期
 *   （见 `flushPositions`）；
 * - **不做视野裁剪**：单图人数上限远小于「同图观看者」规模，按 mapId 分组已足够
 *   （真实裁剪是四叉树 / AOI 的事，等有需求再说）；
 * - **不做插值补偿**：服务端拿到什么就发什么，平滑是各客户端自己的表现层职责。
 */
@Injectable()
export class PlayerPresenceService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PlayerPresenceService.name);

  /** 账号 → 在场信息（连接断开即删） */
  private readonly entries = new Map<string, PresenceEntry>();
  /**
   * 账号 → 最后一次 `join` 的房间（#1000）
   *
   * 在场条目会**过期删除**（位置超时），而条目里带着 `slot`；条目没了之后第一条 `pos`
   * 上报会重建条目 —— 没有这份记录就只能拿公共线（`PUBLIC_SLOT`）当默认值，
   * 于是「站在 2 线发呆超过超时窗」的人会掉进公共线的在场表里（跨线可见 + 容量算错）。
   * 断线（`dropAccount`）才清。
   */
  private readonly lastRooms = new Map<string, RoomRef>();
  /** 账号名缓存（互见帧里顺手带上，省得客户端再查） */
  private readonly usernames = new Map<string, string>();
  /** `zone:mapId` → 攒下的离开账号（断线 / 换图时写入，广播时发出并清空） */
  private readonly pendingLeaves = new Map<string, string[]>();
  /** `zone:mapId` → 攒下的玩家动作事件（#693：结算路径写入，广播时发出并清空） */
  private readonly pendingActions = new Map<string, Array<RealtimePlayerAction>>();
  /**
   * 控制状态的短缓存（#826 第三批）：账号 → `{ at, locked }`
   *
   * pos 帧是 4Hz、在线几十人，每帧查一次 `role_status` 是几百次/秒的 SQL。控制状态是
   * 「秒钟级」的事实（状态最短也持续 1 秒），200ms 的缓存不会漏判，而把它压到 5Hz。
   */
  private readonly controlCache = new Map<string, { at: number; locked: boolean }>();
  private broadcastTimer: NodeJS.Timeout | null = null;
  /** 玩家步进定时器（#1138；10Hz 固定） */
  private stepTimer: NodeJS.Timeout | null = null;

  /**
   * 广播出口（发给谁、怎么发是通道的事）。RealtimeService 启动时接线；
   * 未接线时照常维护在场表，只是没人收到帧。
   */
  onBroadcast: ((roomId: string, data: { mapId: string; t: number; full: boolean; players: RealtimePlayerEntry[]; left: string[]; actions: RealtimePlayerAction[] }) => void) | null = null;

  /**
   * 定向发送出口（快照兜底只发给刚进图的连接自己）。
   * 与 onBroadcast 分开：广播的收件人是「观看者集合」，这里是指定账号。
   */
  onSendTo: ((accountId: string, data: { mapId: string; t: number; full: boolean; players: RealtimePlayerEntry[]; left: string[]; actions: RealtimePlayerAction[] }) => void) | null = null;

  /**
   * 队伍查询出口（#399，RealtimeService 启动时接线到 `PartyService.partyIdOfRole`）
   *
   * 用函数而不是注入 PartyService：`RealtimeModule` 依赖 `PartyModule`，
   * 反过来注入就成环。这里要的只是「一次内存查询」，函数足够。
   */
  partyOfRole: ((roleId: string) => string) | null = null;

  /**
   * 位置修正出口（#811：`posCorrect` 定向发给本人；RealtimeService 启动时接线）
   *
   * 与 `onBroadcast` 分开：这是**只给一个人**的帧，而且它不是「世界状态」的一部分 ——
   * 别人的屏幕上看不到这次修正（他们本来就只看到权威位置）。
   */
  onCorrect: ((accountId: string, data: { x: number; y: number; reason: MovementRejectReason; mapId: string }) => void) | null = null;

  /**
   * 每个广播拍都会跑一次（#810：AOI 的驱动源）
   *
   * 为什么挂在互见的节拍上，而不是自己再起一个定时器：实体进出视野只由**两种变化**引起
   * —— 玩家自己移动（这一拍就在这里）与怪物移动（AI 广播那一拍）。同频（都是 10Hz）
   * 且对齐，裁出来的结果才与发出去的帧一致；两个独立定时器会各错半拍，「这一帧里
   * 有一只已经该离开视野的怪」这类缝隙永远修不干净。
   *
   * 刻意**不受「有没有任何变化」限制**：没人动的时候也得跑（怪物可能在走进来），
   * 所以它在下面 `broadcast()` 的提前返回之前调用。
   */
  onTick: (() => void) | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly roles: RolesService,
    private readonly guilds: GuildRepository,
    private readonly positions: RolePositionRepository,
    private readonly guard: MovementGuardService,
    private readonly geometry: MapGeometryService,
  ) {}

  onApplicationBootstrap(): void {
    this.broadcastTimer = setInterval(() => this.broadcast(), this.broadcastMs()).unref();
    // 玩家步进（#1138 移动收权）：固定 10Hz，与互见广播（`broadcastMs`）分开 ——
    // 广播频率是「表现层节流」可运营调整，步进是模拟精度，不该被一根配置绳拴在一起
    this.stepTimer = setInterval(() => this.stepIntents(), this.stepMs()).unref();
    this.logger.log(`玩家互见已启动（广播 ${this.broadcastMs()}ms / 位置超时 ${this.posStaleMs()}ms / 玩家步进 ${this.stepMs()}ms）`);
  }

  onApplicationShutdown(): void {
    if (this.broadcastTimer) clearInterval(this.broadcastTimer);
    this.broadcastTimer = null;
    if (this.stepTimer) clearInterval(this.stepTimer);
    this.stepTimer = null;
  }

  //#region 输入（通道侧调用）

  /**
   * 记一条玩家动作事件（#693：结算路径在新结算成功后调用）
   *
   * 只攒不判：出手者在不在观看者的场上、有没有拉黑，都是**广播侧**的事
   * （visiblePlayers 统一过滤）—— 这里只负责按分域攒起来，随下一个互见广播节拍发出。
   * 幂等重发在结算入口就早退了，不会走到这里，天然不会重复广播。
   */
  recordAction(roomId: string, action: RealtimePlayerAction): void {
    const key = roomId;
    const list = this.pendingActions.get(key);
    if (list) list.push(action);
    else this.pendingActions.set(key, [action]);
  }

  /**
   * 记录一次玩家位置上报
   *
   * 图的校验（#861）：**条目里的图只由 `join()` 写**（worldJoin 时），所以这帧自报的
   * `mapId` 与登记的不一致，说明他并没有经 worldJoin 进过那张图 —— 整帧丢弃。
   * 以前这里会「换图就整份接受」，于是改个包就能把自己搬到任意图：注入幽灵玩家、
   * 被那张图的怪选中、跨图发世界聊天。
   *
   * 首帧（还没有条目）也要对齐「服务端记的位置」（`data.mapAt`，见下面 `mapAtOfOnlineRole`）：
   * 上报先到、worldJoin 后到是正常时序，所以不能要求「一定进过图」，但也不能按上报的图
   * 建条目 —— 条目过期（几秒不上报）之后再发一帧伪造的图，照样能把人注入到别的图。
   * 位置还没记下来时只认新手村，与 `worldJoin` 的放行口径一致；代价是「上报先到」那一帧
   * 会被丢，下个节拍（4Hz）就补回来了。
   *
   * maxHp / 账号名 / 外观只在首次见到该玩家时查一次库（都不常变，不值得每帧查）；
   * 外观另有按 `appearanceRefreshMs` 的懒刷新（#383，换装后要能被别人看到）。
   *
   * x/y 先过位移校验（#811 三道里的前两道，见 `MovementGuardService`）：非有限数直接丢；
   * 单帧位移超过「速度上限 × 容差 × 实际 Δt + 抖动 + 免检额度」判超速；没超速再判有没有
   * 穿过碰撞盒（swept-AABB）。判失败就丢这一帧，`enforce` 档还会定向回一帧 `posCorrect`
   * 把客户端拉回权威位置。合法的大位移各有出口：换图（`join` 重置基线）、复活（血从 ≤0
   * 变 >0）。hp 只夹有限与非负（上限不夹：maxHp 懒刷新有滞后，
   * 夹上限会把刚升级玩家的合理血量抹成旧分母）。
   */
  updatePosition(accountId: string, username: string, zoneId: number, mapId: string, x: number, y: number, hp: number, moving: boolean): void {
    const existed = this.entries.get(accountId);
    if (!existed) {
      // 首帧也要对齐「服务端记的位置」（#861）：条目过期（几秒不报）之后再来一帧伪造的图，
      // 否则又能把人注入到别的图 —— 丢弃只挡得住「条目还在」的那些帧。
      // 位置还没记下来（刚建号）时只认新手村，与 worldJoin 的放行口径一致。
      // 代价是「上报先到、worldJoin 后到」那一帧会被丢：下个节拍（4Hz）就补回来了，
      // 换图瞬间最多闪一下 —— 拿它换「幽灵玩家」这条通道很值。
      const registered = this.roles.mapAtOfOnlineRole(accountId);
      if (registered ? registered !== mapId : mapId !== START_MAP_ID) return;
      const role = this.roles.online(accountId);
      const summary = role ? summarizeRoleAttributes(roleAttributeSourceOf(role.level, role.data)) : null;
      const maxHp = summary && summary.maxHp > 0 ? summary.maxHp : Math.max(1, hp);
      // 显示名：角色名优先（互见看到的是「那个角色」，不是登录账号），缺省回落账号名
      const roleName = typeof role?.data?.name === "string" ? role.data.name : "";
      this.usernames.set(accountId, roleName || username);
      const roleId = role?.id ?? "";
      const guild = this.readGuild(roleId);
      const now = Date.now();
      this.entries.set(accountId, {
        zoneId,
        mapId,
        // 线按「最后一次 join 的房间」还原（#1000）：首帧上报先于 worldJoin 时只可能是公共线
        // （分线进图必须先过 worldJoin 才能改图，见 #861），但**条目过期重建**时他还在原来那条线
        slot: this.slotOfLastRoom(accountId, zoneId, mapId),
        x,
        y,
        hp,
        maxHp,
        moving,
        updatedAt: now,
        roleId,
        guildId: guild.guildId,
        guildName: guild.guildName,
        partyId: this.partyOfRole?.(roleId) ?? "",
        appearance: this.readAppearance(role),
        appearanceAt: now,
        sentAppearance: "",
        sentGuild: "",
        sentParty: "",
        sentX: NaN,
        sentY: NaN,
        sentMoving: !moving,
        sentHp: -1,
        sentMaxHp: -1,
        trustedX: x,
        trustedY: y,
        trustedAt: now,
        intent: null,
        intentSeq: 0,
        lastStepAt: now,
        correctedAt: 0,
        persisted: "",
        persistedAt: 0,
      });
      return;
    }
    // 换图必须经 worldJoin（#861）：自报的图与登记的不一致 → 整帧丢弃。
    // 连 `updatedAt` 都不刷 —— 否则伪造帧能让一个「其实不在那张图」的人永远不掉线
    if (existed.zoneId !== zoneId || existed.mapId !== mapId) return;
    existed.updatedAt = Date.now();
    // —— 控制期间不接受位移（#826 第三批）——
    // 眩晕 / 麻痹 / 定身时坐标一律不采纳，**连仲裁基线也不动**：基线一动，解除控制后的
    // 第一帧就会被判成瞬移（人还在原地，基线却被拽到了「被控期间客户端自己预测的位置」）。
    // `updatedAt` 上面已经刷过 —— 心跳照旧，不然「站着不能动的人」会被当成掉线。
    // 客户端本地也停输入（表现层双保险），所以正常玩法下这条只是兜住改包的。
    if (this.movementLocked(accountId)) {
      existed.hp = Number.isFinite(hp) ? Math.max(0, hp) : 0;
      existed.moving = false;
      return;
    }
    // —— 复活是合法重定位：血从「死」变「活」的这帧先清掉旧意图（死了不可能还在走），
    //    坐标走下面的兼容仲裁收下（客户端本地瞬移到复活点后上报的落点）
    if (existed.hp <= 0 && Number.isFinite(hp) && hp > 0) existed.intent = null;
    if (existed.intent === null) {
      // 兼容期（#1138）：没有激活意图时 pos 帧坐标照旧仲裁 —— 存量客户端 / e2e 摆位
      // 仍走 #811 的速度 + 穿墙校验；批次 4 客户端删掉本地物理后这条路径自然退役
      if (this.acceptPosition(accountId, existed, x, y, hp)) {
        existed.x = x;
        existed.y = y;
      }
      existed.moving = moving;
    }
    // 意图激活期间：坐标与移动标记都是服务端步进的事，pos 帧只消费 hp（心跳已在上面刷过）
    existed.hp = Number.isFinite(hp) ? Math.max(0, hp) : 0;
    // 外观 + 血条分母懒刷新（#383）：换装是低频事件，不值得每个 pos 帧查一次库（roles.online 是 DB 读）。
    // 分母顺带对齐的理由：换装 / 升级 / 晋升都会改 maxHp，而它只在首见时算过一次 ——
    // 不同步的话「换了新衣服，别人看到你的血条分母还是旧的」（最多迟一个刷新间隔）
    // 帮会（#389）搭同一趟车：入帮 / 退帮 / 被踢都走 HTTP 存档，实时进程不会被告知，
    // 而「同帮的人名字是蓝的」判定要靠他这一份 guildId —— 不刷新就永远停在他首见时的帮会。
    if (existed.updatedAt - existed.appearanceAt > this.appearanceRefreshMs()) {
      const role = this.roles.online(accountId);
      existed.appearance = this.readAppearance(role);
      const summary = role ? summarizeRoleAttributes(roleAttributeSourceOf(role.level, role.data)) : null;
      existed.maxHp = summary && summary.maxHp > 0 ? summary.maxHp : Math.max(1, existed.hp);
      const guild = this.readGuild(role?.id ?? existed.roleId);
      existed.guildId = guild.guildId;
      existed.guildName = guild.guildName;
      existed.appearanceAt = existed.updatedAt;
    }
  }

  /**
   * 这个账号最后一条线（#1000；区 / 图对不上或从没 join 过 = 公共线）
   *
   * 只在「条目不存在、要凭一帧 `pos` 重建」时用：网络抖一下把人从 2 线挪到公共线的
   * 在场表里，代价是跨线可见 + 那条线的容量白算一个人。
   */
  private slotOfLastRoom(accountId: string, zoneId: number, mapId: string): string {
    const last = this.lastRooms.get(accountId);
    if (!last || last.zoneId !== zoneId || last.mapId !== mapId) return PUBLIC_SLOT;
    return last.slot;
  }

  /**
   * 这个账号此刻是否被定住（#826 第三批）：眩晕 / 麻痹 / 定身都算，沉默不算
   *
   * 200ms 缓存见 `controlCache` 的注释。缓存的是「锁定」这一个布尔，不是完整的控制对象：
   * 这里只回答「能不能动」，出手那条路自己问 `controlOf`（它要看 silenced）。
   */
  private movementLocked(accountId: string): boolean {
    const now = Date.now();
    const cached = this.controlCache.get(accountId);
    if (cached && now - cached.at < 200) return cached.locked;
    const control = this.roles.controlOf(accountId);
    const locked = control.rooted || control.stunned;
    this.controlCache.set(accountId, { at: now, locked });
    return locked;
  }

  /**
   * 位移裁决（#811）：返回这帧坐标能不能进在场表
   *
   * 与 #596 的差别是**删掉了「连续 2 帧异常即信任」那条宽容分支**（B44）：那条规则让
   * 「改个包、连发两帧」就等于合法重定位（约 250ms），闸门形同虚设。现在：
   *
   * - **单帧即判**，失败就丢这一帧、基线不动（不再攒计数）；
   * - `enforce` 档下失败还会**立刻**回一帧 `posCorrect`（把客户端拉回权威位置），
   *   因为客户端此刻以为自己住在那里，不拉就会一直往那边走、一直失败、无限不同步；
   * - 合法的大位移各有各的出口，不靠「连发两帧」兜：换图在 `join()` 重置基线、
   *   复活用「血从 ≤0 变 >0」这一条判据（突进的落点在 #1138 起改由服务端直接落位，
   *   `teleportTo`，不再需要免检额度）。
   *
   * 非有限数是协议垃圾（不是「客户端重定位」），永不接受、也不回帧 —— 垃圾坐标广播出去
   * 就是 NaN 血条，而给它回 `posCorrect` 只会喂给刷帧的人一个免费出口。
   */
  private acceptPosition(accountId: string, entry: PresenceEntry, x: number, y: number, hp: number): boolean {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const now = entry.updatedAt;
    // 复活（#596 的合法重定位之一）：血从「死」变成「活」的这一帧一律接受并把基线挪过去。
    // 复活走的是存档进程的 HTTP 接口（`POST /roles/:id/revive`），实时进程不会被告知 ——
    // 客户端本地瞬移到复活点之后上报的坐标必然超出速度上限，不认这一条就会把人拉回尸体上
    if (entry.hp <= 0 && Number.isFinite(hp) && hp > 0) {
      this.resetBaseline(entry, x, y, now);
      return true;
    }
    const verdict = this.guard.judge({
      mapId: entry.mapId,
      from: { x: entry.trustedX, y: entry.trustedY },
      to: { x, y },
      dtMs: now - entry.trustedAt,
    });
    if (verdict.accept) {
      this.resetBaseline(entry, x, y, now);
      return true;
    }
    this.correctPosition(accountId, entry, verdict.reason, now);
    return false;
  }

  /** 把基线挪到「这一帧被接受的坐标」（换图 / 复活 / 正常接受都走这一处） */
  private resetBaseline(entry: PresenceEntry, x: number, y: number, at: number): void {
    entry.trustedX = x;
    entry.trustedY = y;
    entry.trustedAt = at;
  }

  /**
   * 把客户端拉回权威位置（#811）
   *
   * 只在 `enforce` 档发（`log` 档照旧接受，见 `MovementGuardService` 顶部）；
   * 节流到 `movement.correctIntervalMs`（出厂 500ms）：4Hz 上报下每帧都可能是拒绝帧，
   * 不节流等于给刷帧的人一个稳定出口。
   *
   * 回的是 `entry.x / entry.y`（**上一次被接受的**坐标），不是「把这一帧夹到上限」——
   * 夹出来的点可能在墙里，而且会让作弊者「每帧推进一点点」白赚距离。
   */
  private correctPosition(accountId: string, entry: PresenceEntry, reason: MovementRejectReason | null, now: number): void {
    if (reason === null || this.onCorrect === null) return;
    const interval = this.guard.params().correctIntervalMs;
    if (now - entry.correctedAt < interval) return;
    entry.correctedAt = now;
    this.guard.noteCorrected();
    this.onCorrect(accountId, { x: entry.x, y: entry.y, reason, mapId: entry.mapId });
  }

  /**
   * 记一份移动意图（#1138 移动收权）
   *
   * 校验走 `MovementGuardService.judgeIntent`（三档：off 不判 / log 记账放行 / enforce
   * 拒收 + `posCorrect`）。形状垃圾（NaN / 零向量）无论档位都不收 —— 收了会把人步进没；
   * 这种帧静默丢弃，与 pos 帧的 NaN 同一口径（高频帧不回 error）。
   *
   * 意图是状态：同方向重复发只是覆盖；序号明显倒退的帧丢弃（乱序容忍靠「倒退才挡」，
   * 不做严格排序 —— 掉线重连的 seq 归零不该被当成垃圾）。
   */
  setIntent(accountId: string, seq: number, raw: MoveIntent): void {
    const entry = this.entries.get(accountId);
    if (!entry) return;
    if (Number.isFinite(seq) && seq < entry.intentSeq) return;
    const verdict = this.guard.judgeIntent(entry.mapId, raw);
    if (verdict.reason === "bad") return;
    if (!verdict.accept) {
      // enforce 档拒收（wall）：意图不生效 + 拉回权威位置（节流与 pos 帧共用一条）
      this.correctPosition(accountId, entry, "wall", Date.now());
      return;
    }
    entry.intent = verdict.intent;
    entry.intentSeq = Number.isFinite(seq) ? seq : entry.intentSeq;
    entry.lastStepAt = Date.now();
    // 意图帧本身就是「人还在」的证据：刷一下新鲜度，挂机走位的人不该被超时清场
    entry.updatedAt = entry.lastStepAt;
  }

  /** 停止移动（#1138 `moveStop`）：清掉意图，下一拍移动标记自然落下 */
  clearIntent(accountId: string): void {
    const entry = this.entries.get(accountId);
    if (!entry) return;
    entry.intent = null;
    entry.moving = false;
    entry.updatedAt = Date.now();
  }

  /**
   * 服务端直接落位（#1138：突进类技能的落点收权）
   *
   * 结算成功后由通道调用（替代旧的 `posCredit` 免检额度 —— 免检的本质是「相信客户端
   * 报的落点」，收权后落点由服务端算）：按施法帧带的目标方向把人挪过去，距离夹在
   * `maxDistance` 内；落点撞墙 / 出图则**原地不动**（宁可不瞬移，也不把人塞进墙里）。
   *
   * 落位同步仲裁基线：兼容期 pos 仲裁以它为起点，否则下一帧 pos 会被判成超速。
   */
  teleportTo(accountId: string, x: number, y: number, maxDistance: number): void {
    const entry = this.entries.get(accountId);
    if (!entry) return;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(maxDistance > 0)) return;
    const offsetX = x - entry.x;
    const offsetY = y - entry.y;
    const distance = Math.hypot(offsetX, offsetY);
    if (distance > maxDistance) {
      const scale = maxDistance / distance;
      x = entry.x + offsetX * scale;
      y = entry.y + offsetY * scale;
    }
    const geo = this.geometry.geometryOf(entry.mapId);
    if (geo !== null) {
      // 出图或落点在墙里：不挪。几何缺失（导入工具没跑）时不判，与步进同一口径
      if (x < 0 || x > geo.width || y > 0 || y < -geo.height) return;
      if (this.geometry.blockedIn(geo, x, y)) return;
    }
    const now = Date.now();
    entry.x = x;
    entry.y = y;
    entry.updatedAt = now;
    this.resetBaseline(entry, x, y, now);
  }

  /**
   * 10Hz 玩家步进（#1138 移动收权的核心一拍）
   *
   * 每个带意图的在场条目按 `playerMove` 的走 / 跑速走一步：碰撞用 `slideStep`
   * （与怪物 AI 同一份滑行算法），Δt 用**实际间隔**（定时器漂移不掉步子，掉帧不瞬移）。
   * 步进结果直接写在场表 —— 互见广播、AOI、怪物 AI 索敌、位置快照落库读的都是它，
   * 谁也不需要知道「这一步是步进出来的」。
   *
   * 被控（眩晕 / 麻痹 / 定身）与死亡时不步进但**保留意图**：解除控制 / 复活后客户端
   * 大概率还按着方向，接着走才是正确行为（被控期间的 pos 帧也不动基线，同一哲学）。
   *
   * 兼容期基线同步：步进落点同时推进仲裁基线 —— 意图停下后，下一帧 pos 仲裁
   * 从服务端位置起算，不会把「服务端刚走出来的路」判成瞬移。
   */
  private stepIntents(): void {
    const now = Date.now();
    const speeds = this.guard.playerMove();
    for (const [accountId, entry] of this.entries) {
      const intent = entry.intent;
      if (!intent) continue;
      const dtMs = Math.min(500, Math.max(0, now - entry.lastStepAt));
      entry.lastStepAt = now;
      entry.updatedAt = now;
      // 死人 / 被控的人不走，但意图保留（见方法注释）
      if (entry.hp <= 0 || this.movementLocked(accountId)) {
        entry.moving = false;
        continue;
      }
      const speed = intent.run ? speeds.runSpeedPxPerS : speeds.walkSpeedPxPerS;
      // 本拍步长（像素）：Δt 用实际间隔（见方法注释）
      const stepLength = (speed * dtMs) / 1000;
      let stepX: number;
      let stepY: number;
      if (intent.kind === "dir") {
        // 方向已归一化（judgeIntent 出口保证），步长直接乘上去
        stepX = intent.dx * stepLength;
        stepY = intent.dy * stepLength;
      } else {
        const offsetX = intent.tx - entry.x;
        const offsetY = intent.ty - entry.y;
        const distance = Math.hypot(offsetX, offsetY);
        // 到点：意图清掉，广播下一拍把「停下」发给同图的人
        if (distance <= 0.01) {
          entry.intent = null;
          entry.moving = false;
          continue;
        }
        // 一步不跨过目标点（否则会在目标两侧来回跳）
        const capped = Math.min(distance, stepLength);
        stepX = (offsetX / distance) * capped;
        stepY = (offsetY / distance) * capped;
      }
      const geo = this.geometry.geometryOf(entry.mapId);
      const result = slideStep(geo, entry, stepX, stepY);
      entry.x = result.x;
      entry.y = result.y;
      entry.moving = result.moved >= 0.01;
      // 兼容期基线同步：pos 仲裁以服务端位置为起点（见方法注释）
      this.resetBaseline(entry, entry.x, entry.y, now);
      // target 类到点了：意图清掉
      if (intent.kind === "target" && Math.hypot(intent.tx - entry.x, intent.ty - entry.y) <= 0.01) {
        entry.intent = null;
        entry.moving = false;
      }
    }
  }

  /** 步进节拍（毫秒；固定 10Hz，下限 20ms 防呆） */
  private stepMs(): number {
    return Math.max(20, Number(this.config.get<number>("playerMoveTickMs") ?? 100));
  }

  /**
   * 进图登记（worldJoin 应答后由通道调用）：给刚进图的连接发一份同图全量快照
   *
   * 换图也走这里 —— 旧图的同伴会在下一个广播节拍里收到 left：该账号的条目已换成新图，
   * 旧图的增量帧不再包含它，但「不再出现」不等于「已离开」（可能只是站桩不动），
   * 必须显式广播离开，客户端才会拆掉旧节点。
   */
  join(accountId: string, roomId: string): void {
    const room = splitRoomKey(roomId);
    const zoneId = room.zoneId;
    const mapId = room.mapId;
    // 记住「他注册在哪条线」（#1000）：条目过期后重建时靠它还原 slot，不靠默认值
    this.lastRooms.set(accountId, room);
    const existed = this.entries.get(accountId);
    if (existed) {
      const movedMap = existed.zoneId !== zoneId || existed.mapId !== mapId || existed.slot !== room.slot;
      if (movedMap) this.queueLeave(entryRoomKey(existed), accountId);
      // 换图或原地重进都刷新新鲜度：刚登记就因上报迟到被当离场清掉，快照与增量就对不上了
      existed.updatedAt = Date.now();
      if (movedMap) {
        existed.zoneId = zoneId;
        existed.mapId = mapId;
        existed.slot = room.slot;
        // 换图顺带重置位移基线（#861 / #811）：基线还是上一张图的坐标，跨图距离必然超限，
        // 不重置的话新图的第一帧上报会被当成瞬移（看起来是「进图后愣半秒」，`enforce` 档下
        // 还会白挨一帧 `posCorrect`）。换图这件事本身是服务端放行的，坐标该整体接受
        existed.trustedX = existed.x;
        existed.trustedY = existed.y;
        existed.trustedAt = Date.now();
        existed.correctedAt = 0;
        // 旧图的移动意图在新图没有意义（#1138）：目标点 / 方向语义都变了，一律清掉
        existed.intent = null;
        existed.intentSeq = 0;
        existed.lastStepAt = Date.now();
      }
    }
    const players: RealtimePlayerEntry[] = [];
    for (const [otherId, entry] of this.entries) {
      if (otherId === accountId) continue;
      // 房号三键都要比（#1000）：只比「区 + 图」时，同图另一条线上的人会出现在这份全量里，
      // 而后续增量按房号分桶 —— 于是「分线的人看见彼此」只在进图那一帧发生，之后就 ghost 掉
      if (entry.zoneId !== zoneId || entry.mapId !== mapId || entry.slot !== room.slot) continue;
      if (Date.now() - entry.updatedAt > this.posStaleMs()) continue;
      players.push(this.toEntry(otherId, entry));
    }
    // t = 这一份快照的时刻（#769）：全量帧同样要带 —— 客户端拿它当插值基准的第一个样本，
    // 没有 t 的话刚进图那几帧只能退回「收帧时刻」，开局就会抖一下
    this.onSendTo?.(accountId, { mapId, t: Date.now(), full: true, players, left: [], actions: [] });
    // 进图立刻落一次位置快照（#862/#863）：不写的话「刚进图那一秒点 NPC」会被判成
    // 「不知道你在哪」，玩家看到的是「走过去了却接不了任务」。
    const current = this.entries.get(accountId);
    if (current) this.persistPosition(current, Date.now());
  }

  /**
   * 连接断开 / 被踢：在场信息作废，并立即向同图观看者广播离开
   *
   * 立即（不等广播节拍）：离开是低频事件，玩家掉线后同伴多等几百毫秒没有收益。
   */
  dropAccount(accountId: string): void {
    const entry = this.entries.get(accountId);
    // 控制缓存跟着会话一起清（#826 第三批）：人走了不该还留着「他被定住」的结论，
    // 下次登录如果恰好 200ms 内又开始报位置，那一条会被旧缓存挡掉一帧
    this.controlCache.delete(accountId);
    // 断线才清「最后一条线」（#1000）：条目过期重建还要用它，连接没了就没意义了
    this.lastRooms.delete(accountId);
    if (!entry) return;
    this.entries.delete(accountId);
    this.broadcastLeave(entryRoomKey(entry), entry.mapId, accountId);
    // 位置快照跟着下线一起删（#862/#863）：留着只会让「他其实已经走了」的一行
    // 在新鲜窗口内继续放行 NPC 交互
    if (entry.roleId) {
      try {
        this.positions.remove(entry.roleId);
      } catch (error) {
        this.logger.warn(`角色位置快照删除失败（${entry.roleId}）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * 一个账号当前的身份快照（#395 聊天用；不修改任何状态）
   *
   * 返回 null = 这条连接还没进过图（worldJoin 之前）：聊天对它不可用 ——
   * 连自己在哪张图都不知道，谈不上「广播给同图的人」。
   * 帮会身份读的是缓存值（最多滞后一个懒刷新周期）：频道准入**不**用这个值
   * （ChatService 自己查库），这里只填展示用的 guildName。
   */
  identityOf(accountId: string): {
    zoneId: number;
    mapId: string;
    /** 房号（`zone:map:slot`）—— 同图频道与经验分成都按它比，别自己拿 zone+map 拼（#958） */
    roomId: string;
    roleId: string;
    guildId: string;
    guildName: string;
    username: string;
  } | null {
    const entry = this.entries.get(accountId);
    if (!entry) return null;
    return {
      zoneId: entry.zoneId,
      mapId: entry.mapId,
      roomId: entryRoomKey(entry),
      roleId: entry.roleId,
      guildId: entry.guildId,
      guildName: entry.guildName,
      username: this.usernameOf(accountId),
    };
  }

  /**
   * 这个账号最近一次**被接受**的坐标（#813 距离闸的输入；不修改任何状态）
   *
   * 与 `identityOf` 分开：聊天只要「在哪张图」，距离闸要的是「离怪多远」，而坐标只有
   * 真的上报过才有（`worldJoin` 本身不带坐标）。返回 null = 还没收到过 pos 帧 ——
   * 调用方**不能**把 null 当原点，那会把刚进图的玩家判成「隔着整张图出手」。
   *
   * 坐标是客户端自报 + 最小仲裁（#596）的结果，**不是权威**：谎报仍可绕过距离闸，
   * 那是 #811（位置源收口）要解决的事，这里的职责只是「明显不合理的拒绝掉」。
   */
  positionOf(accountId: string): {
    roomId: string;
    zoneId: number;
    mapId: string;
    slot: string;
    x: number;
    y: number;
    hp: number;
    at: number;
  } | null {
    const entry = this.entries.get(accountId);
    if (!entry) return null;
    return {
      roomId: entryRoomKey(entry),
      zoneId: entry.zoneId,
      mapId: entry.mapId,
      slot: entry.slot,
      x: entry.x,
      y: entry.y,
      hp: entry.hp,
      at: entry.updatedAt,
    };
  }

  /**
   * 一张图上「此刻还能当目标」的玩家（#855：怪物 AI 的目标候选**唯一来源**）
   *
   * 与 `playersOn`（#665 监控用）的三点差别，都是 AI 的语义而不是监控的：
   * - 位置超时（`monsterAiPosStaleMs`，与 AI 的时效口径同一个配置键）的不算 ——
   *   人可能已经掉线，怪不该对着一具「几秒前的位置」追；
   * - 血量 <= 0 的不算 —— 尸体不该被选成目标（#670 的老问题）；
   * - 不带名字与移动标记（AI 不用，省一次用户名查表）。
   *
   * 只读：不改在场表、不触发广播。
   */
  aiTargetsOn(roomId: string): Array<{ accountId: string; x: number; y: number; hp: number; at: number }> {
    const now = Date.now();
    const staleMs = this.posStaleMs();
    const rows: Array<{ accountId: string; x: number; y: number; hp: number; at: number }> = [];
    for (const [accountId, entry] of this.entries) {
      if (entryRoomKey(entry) !== roomId) continue;
      if (entry.hp <= 0) continue;
      if (now - entry.updatedAt > staleMs) continue;
      rows.push({ accountId, x: entry.x, y: entry.y, hp: entry.hp, at: entry.updatedAt });
    }
    return rows;
  }

  /**
   * 回填一次**权威**血量（怪物打中玩家之后由 AI 调；#670 的目标作废判据）
   *
   * 为什么这一层可以写 hp：血量本来就有自己的权威链路（`RolesService.applyMonsterHit`
   * 落账），在场表只是它的副本 —— 这里不仲裁任何东西，只是让副本立刻跟上权威值。
   * 不写的话，怪物把玩家打到 0 血之后还要等客户端下一帧 `pos` 上报才「发现」人死了，
   * 中间那几拍会继续对着尸体放技能（#670 复发）。
   *
   * 不刷新 `updatedAt`：这不是一次位置上报，不该让一个「位置其实已经超时」的人续命。
   */
  markHp(accountId: string, hp: number): void {
    const entry = this.entries.get(accountId);
    if (!entry) return;
    entry.hp = Number.isFinite(hp) ? Math.max(0, hp) : 0;
  }

  /**
   * **某个区**此刻所有「进过图」的账号 id（#876 世界频道的收件人口径，#958 收成「本区」）
   *
   * 世界频道从「全服」收成「本区」：合区之前每个区是独立服，1 区的人不该看见 2 区的
   * 叫卖与对骂 —— 那是两套经济、两套帮会、两套排行榜。收件人按在场条目的 `zoneId`
   * 现筛，不另维护「区 → 在线」的索引（又一份要在四条路径上同步的东西）。
   *
   * 只读：不改在场表、不触发广播。
   */
  presentAccountIdsOf(zoneId: number): string[] {
    const ids: string[] = [];
    for (const [accountId, entry] of this.entries) {
      if (entry.zoneId === zoneId) ids.push(accountId);
    }
    return ids;
  }

  /**
   * 按角色找在线连接（#399：队伍快照的「在线 / 同图」与队友经验分成的「同房才分」都要它）
   *
   * 线性扫一遍在线表：队伍最多 4 人、每次击杀查一次，这个规模上完全够。
   * 为它维护一张反向索引，就得在「首见 / 换图 / 断线 / 超时」四条路径上同步 ——
   * 多出来的只是漂移的机会。
   *
   * `roomId` 是 `zone:map:slot` 三键（#809）：**区与线都要比**。只比 `mapId` 时，两个区
   * 同在「3 图」的队友会互相分到经验（#958 修的就是这一条），分线之后同理。
   *
   * 返回 null = 这个角色此刻不在线（没进图 / 断线 / 位置超时被清）。
   */
  locateRole(roleId: string): { accountId: string; mapId: string; roomId: string } | null {
    if (!roleId) return null;
    for (const [accountId, entry] of this.entries) {
      if (entry.roleId === roleId) return { accountId, mapId: entry.mapId, roomId: entryRoomKey(entry) };
    }
    return null;
  }

  /**
   * 一张图上此刻有哪些玩家、各在哪（#665 实时地图监控用）
   *
   * 与 `broadcast()` 的收件人口径不同：那个是「发给谁」，这个是「谁在图里」——
   * 监控页要的是后者。数据就是互见帧的原料（位置 / 血量 / 移动标记），**不做任何加工**：
   * 位置仲裁（#596）的结果已经在 `entry.x/y` 里，这里不再二次判定。
   *
   * 只读：不改变在场表、不触发广播。
   */
  playersOn(roomId: string): Array<{
    accountId: string;
    name: string;
    x: number;
    y: number;
    hp: number;
    maxHp: number;
    moving: boolean;
  }> {
    const rows: Array<{ accountId: string; name: string; x: number; y: number; hp: number; maxHp: number; moving: boolean }> = [];
    for (const [accountId, entry] of this.entries) {
      if (entryRoomKey(entry) !== roomId) continue;
      rows.push({
        accountId,
        name: this.usernameOf(accountId),
        x: entry.x,
        y: entry.y,
        hp: entry.hp,
        maxHp: entry.maxHp,
        moving: entry.moving,
      });
    }
    // 名字排序：同图同帧的多个玩家在监控里顺序稳定，不会因为 Map 迭代顺序抖动
    return rows.sort((left, right) => left.name.localeCompare(right.name));
  }

  //#endregion

  //#region 广播

  private broadcast(): void {
    // 位置快照先于「有没有人订阅广播」的判断：即便本进程没接任何广播出口
    // （理论上不会），存档进程的 NPC 交互仍然得能看到位置
    const now = Date.now();
    this.flushPositions(now);
    // AOI（#810）先于「有没有人订阅广播」的判断：它算的是「谁该看见谁」，与有没有增量无关
    this.onTick?.();
    if (this.onBroadcast === null && this.onSendTo === null) return;
    const staleMs = this.posStaleMs();
    // 按图分组的玩家增量（观看者以图为单位，分组后每个图最多发一帧）
    const changed = new Map<string, RealtimePlayerEntry[]>();
    for (const [accountId, entry] of this.entries) {
      // 超时视作离场：进 left、条目删除（重新上报后会作为新变化再次出现）
      if (now - entry.updatedAt > staleMs) {
        this.entries.delete(accountId);
        this.queueLeave(entryRoomKey(entry), accountId);
        continue;
      }
      const moved = entry.x !== entry.sentX || entry.y !== entry.sentY;
      const turned = entry.moving !== entry.sentMoving;
      const hurt = entry.hp !== entry.sentHp;
      // 换装也要广播（#383）：原地站着不动换一身衣服，坐标 / 血量 / 移动标记全没变，
      // 不带这条判据别人就得等他动一下才看得见新外观
      const redressed = this.appearanceKey(entry.appearance) !== entry.sentAppearance;
      // 血条分母变了也要广播（#383 顺带修的）：换装 / 升级改了 maxHp 而血量还没动时，
      // 不带这条判据别人的血条分母会一直冻在他首见你的那一刻
      const maxHpChanged = entry.maxHp !== entry.sentMaxHp;
      // 帮会变了也要广播（#389）：入帮 / 退帮的瞬间名字颜色要变（同帮是蓝的），
      // 而他大概率正站着不动 —— 不带这条判据别人得等他动一下才看见颜色变回来
      const guildChanged = this.guildKey(entry) !== entry.sentGuild;
      // 队伍变了也要广播（#399）：组队 / 退队 / 被踢的瞬间名字颜色与队标要变，
      // 而他大概率正站着不动 —— 不带这条判据就得等他动一下才看得见
      const partyId = this.partyOfRole?.(entry.roleId) ?? "";
      const partyChanged = partyId !== entry.sentParty;
      entry.partyId = partyId;
      if (!moved && !turned && !hurt && !redressed && !maxHpChanged && !guildChanged && !partyChanged) continue;
      const key = entryRoomKey(entry);
      const list = changed.get(key) ?? [];
      list.push(this.toEntry(accountId, entry));
      changed.set(key, list);
      entry.sentX = entry.x;
      entry.sentY = entry.y;
      entry.sentMoving = entry.moving;
      entry.sentHp = entry.hp;
      entry.sentMaxHp = entry.maxHp;
      entry.sentAppearance = this.appearanceKey(entry.appearance);
      entry.sentGuild = this.guildKey(entry);
      entry.sentParty = entry.partyId;
    }
    // 攒下的动作事件（#693）按图取出：key 集要并入下面的发送循环 ——
    // 站着不动的人出手，玩家增量里没有他，只按 changed 发帧动作就永远到不了
    const actionsBy = new Map<string, RealtimePlayerAction[]>();
    for (const [key, list] of this.pendingActions) {
      this.pendingActions.delete(key);
      actionsBy.set(key, list);
    }
    // 三路负载（玩家增量 / 动作事件 / 离开）按图合并成一帧发出
    const keys = new Set<string>([...changed.keys(), ...actionsBy.keys(), ...this.pendingLeaves.keys()]);
    // 这一拍的时刻（#769）：一次节拍里各图各发一帧，但时间基准只该有一个 ——
    // 每间房各取一次 Date.now() 会让同一拍的不同图差出几毫秒，跨图比较时就对不上了
    const tickAt = Date.now();
    for (const key of keys) {
      // key 现在是房号（三段）：帧里只带图 id（客户端只认图），从房号解析出来
      const mapId = splitRoomKey(key).mapId;
      const left = this.pendingLeaves.get(key) ?? [];
      this.pendingLeaves.delete(key);
      this.onBroadcast?.(key, {
        mapId,
        t: tickAt,
        full: false,
        players: changed.get(key) ?? [],
        left,
        actions: actionsBy.get(key) ?? [],
      });
    }
  }

  /**
   * 把「坐标有变化」的在场条目节流落库（#862/#863）
   *
   * 存档进程要做「玩家离 NPC 多远」的判定，而两个进程之间只有 SQLite 一条路 ——
   * 这条通道同时是 #817（拾取校验距离）的底座。
   *
   * 三条判据缺一不可：
   * - **节流**（`rolePositionPersistMs`，默认 1 秒/角色）：4Hz 上报照抄进库就是每人每秒 4 次写，
   *   而 NPC 交互只关心「1 秒前你在哪」；
   * - **坐标真变了才写**：站桩的玩家一分钱写放大都不产生（挂机的人可能占在线的一半）；
   * - **写失败只告警不抛**：位置是辅助信息，不能因为它把互见广播的节拍搞崩。
   */
  private flushPositions(now: number): void {
    const interval = this.positionPersistMs();
    for (const entry of this.entries.values()) {
      if (!entry.roleId) continue;
      if (now - entry.persistedAt < interval) continue;
      if (entry.persisted === this.positionKey(entry)) continue;
      this.persistPosition(entry, now);
    }
  }

  /** 写一行位置快照（`role_positions`；失败只记日志，不影响广播） */
  private persistPosition(entry: PresenceEntry, now: number): void {
    const key = this.positionKey(entry);
    try {
      this.positions.upsert({ role_id: entry.roleId, map_id: entry.mapId, x: entry.x, y: entry.y, updated_at: now });
      entry.persisted = key;
      entry.persistedAt = now;
    } catch (error) {
      // 连失败时刻一起记：不然每个节拍都会重试同一行、日志刷屏
      entry.persistedAt = now;
      this.logger.warn(`角色位置快照写入失败（${entry.roleId}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private positionKey(entry: PresenceEntry): string {
    return `${entry.mapId}:${entry.x}:${entry.y}`;
  }

  /** 立即广播一次离开（断线 / 被踢走这条；超时离场走广播节拍，见 broadcast） */
  private broadcastLeave(roomId: string, mapId: string, accountId: string): void {
    // 离开帧里没有任何坐标，t 只是形状上的必需字段（取广播时刻，别为它另算时间）
    this.onBroadcast?.(roomId, { mapId, t: Date.now(), full: false, players: [], left: [accountId], actions: [] });
  }

  /** 超时离场先进队列（与增量同节拍发出，避免超时清算一轮就广播 N 帧） */
  private queueLeave(roomId: string, accountId: string): void {
    const key = roomId;
    const list = this.pendingLeaves.get(key) ?? [];
    list.push(accountId);
    this.pendingLeaves.set(key, list);
  }

  /** 广播条目形状（字段缩写见 RealtimePlayerEntry，#768 帧瘦身） */
  private toEntry(accountId: string, entry: PresenceEntry): RealtimePlayerEntry {
    return {
      a: accountId,
      n: this.usernameOf(accountId),
      r: entry.roleId,
      g: entry.guildId,
      gn: entry.guildName,
      p: entry.partyId,
      // #768 坐标整数化：广播出整数像素（客户端上报已是整数，这里再取整兜住服务端仲裁的浮点）
      x: Math.round(entry.x),
      y: Math.round(entry.y),
      hp: entry.hp,
      m: entry.maxHp,
      mv: entry.moving,
      // 复制一份再发：在场表里的那份会被下一次懒刷新整份替换，别让广播出去的对象跟着变
      ap: { ...entry.appearance },
    };
  }

  /**
   * 一个在线玩家此刻的互见条目（#810：`entityEnter` 用它把「刚进视野的人」整份给客户端）
   *
   * 与广播那条路的形状完全一致（同一个 `toEntry`）：客户端收到 enter 之后走的建人逻辑，
   * 与收到 players 增量时走的是同一段，不需要为「首次」再写一套。
   *
   * 不在场（已断线 / 位置超时被清）返回 null —— AOI 那一拍算出来的集合可能比在场表晚
   * 几十毫秒，宁可少发一条，也不发一个已经不在的人。
   */
  entryOf(accountId: string): RealtimePlayerEntry | null {
    const entry = this.entries.get(accountId);
    return entry ? this.toEntry(accountId, entry) : null;
  }

  /**
   * 一间房里所有玩家的坐标（#810：AOI 每拍同步索引用）
   *
   * 比 `playersOn` 轻一档：不查名字、不排序 —— 索引只认「谁在哪」，名字与外观是发帧时
   * 才需要的东西（那一步用 `entryOf`）。每 100ms × 房间数跑一次的东西，不该顺手做
   * `localeCompare` 排序。
   */
  positionsOn(roomId: string): Array<{ accountId: string; x: number; y: number }> {
    const rows: Array<{ accountId: string; x: number; y: number }> = [];
    for (const [accountId, entry] of this.entries) {
      if (entryRoomKey(entry) !== roomId) continue;
      rows.push({ accountId, x: entry.x, y: entry.y });
    }
    return rows;
  }

  /**
   * 读角色所属帮会（#389）
   *
   * 与外观同一档频率调用（首见 + 懒刷新），不每帧查 —— `guildOfRole` 是一次 join 读库，
   * 4Hz × 同图人数 立刻就是每秒几十次。无角色 / 无帮会统一用空串（客户端据此判「没帮会」）。
   */
  private readGuild(roleId: string): { guildId: string; guildName: string } {
    if (!roleId) return { guildId: "", guildName: "" };
    const guild = this.guilds.guildOfRole(roleId);
    return { guildId: guild?.id ?? "", guildName: guild?.name ?? "" };
  }

  /** 帮会比较键（增量广播判据：帮会改名也要重发，所以 id 与名字都进键） */
  private guildKey(entry: PresenceEntry): string {
    return `${entry.guildId}|${entry.guildName}`;
  }

  /**
   * 从在线角色数据里取出外观（#383）
   *
   * `data` 是不透明文档（客户端 entities/Role 的 JSON 快照，历史形状不一定听话），
   * 这里逐个收窄：类型不对一律回落默认值 —— 一个人的外观字段脏了不该让整帧广播失败。
   */
  private readAppearance(role: { data?: Record<string, unknown> } | null): RealtimePlayerAppearance {
    const data = (role?.data ?? {}) as Record<string, unknown>;
    const equipments = (data.equipments ?? {}) as Record<string, unknown>;
    // 槽位值（#816 起是 `{ id }` 对象；迁移前的老档是裸 id —— 这里两种都收，
    // 外观不该因为存档形状而变成光着身子）
    const wornId = (slot: string): string => {
      const entry = equipments[slot];
      const id = entry && typeof entry === "object" ? (entry as Record<string, unknown>).id : entry;
      return typeof id === "string" ? id : "";
    };
    // 性别：客户端 SEX 是字符串枚举（"1" 男 / "2" 女），但历史存档里也见过数字 —— 两种都收
    const sex = data.sex;
    return {
      sx: typeof sex === "string" ? sex : typeof sex === "number" ? String(sex) : "1",
      c: wornId("cloth"),
      w: wornId("weapon"),
      // 时装历史形状是 number（从没人写过），只认字符串；数字一律当没穿
      f: typeof data.fashionCloth === "string" ? data.fashionCloth : "",
    };
  }

  /** 外观比较键（增量广播判据：四个字段拼一串，字符串比较比逐字段比省事） */
  private appearanceKey(appearance: RealtimePlayerAppearance): string {
    return `${appearance.sx}|${appearance.c}|${appearance.w}|${appearance.f}`;
  }

  private usernameOf(accountId: string): string {
    let username = this.usernames.get(accountId);
    if (username === undefined) {
      const role = this.roles.online(accountId);
      username = typeof role?.data?.name === "string" ? role.data.name : "";
      this.usernames.set(accountId, username);
    }
    return username;
  }

  //#endregion

  //#region 配置

  private broadcastMs(): number {
    // #768 提频：默认 10Hz（与客户端上报节拍对齐），配置可覆写，下限 50ms 不变
    return Math.max(50, Number(this.config.get<number>("playerSyncBroadcastMs") ?? 100));
  }

  private posStaleMs(): number {
    return Math.max(500, Number(this.config.get<number>("monsterAiPosStaleMs") ?? 3000));
  }

  /**
   * 位置快照的落库间隔（毫秒/角色，#862/#863）
   *
   * 取 1 秒：NPC 交互只关心「1 秒前在哪」，再密就是白写（4Hz 上报照抄 = 每人每秒 4 次）。
   * 下限 200ms 是防呆 —— 配成 0 会把「每个广播节拍都写一行」打开。
   */
  private positionPersistMs(): number {
    return Math.max(200, Number(this.config.get<number>("rolePositionPersistMs") ?? 1000));
  }

  /**
   * 外观懒刷新间隔（毫秒，#383）
   *
   * 换装 / 换武器 / 换时装都走存档（HTTP 那侧），实时进程的在场表不会自己知道 ——
   * 所以按这个间隔重读一次在线角色。取 5 秒的理由：换装是低频操作，迟 5 秒被别人看到
   * 完全无感；而每帧重读（4Hz × 同图人数）立刻就是每秒几十次 DB 读。
   */
  private appearanceRefreshMs(): number {
    return Math.max(1000, Number(this.config.get<number>("playerAppearanceRefreshMs") ?? 5000));
  }

  //#endregion
}
