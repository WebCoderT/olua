import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GuildRepository } from "../../database/repositories/guild.repository";
import { roleAttributeSourceOf, summarizeRoleAttributes } from "../combat/role-attributes";
import { START_MAP_ID } from "../map/map.service";
import { RolesService } from "../roles/roles.service";
import type { RealtimePlayerAction, RealtimePlayerAppearance, RealtimePlayerEntry } from "./realtime.protocol";

/**
 * 一名在线玩家的在场信息（#324：玩家互见的数据源）
 *
 * **内存态、不落盘、不权威**：位置是客户端自报的最近一次上报（4Hz 节流），
 * 服务端只做「转发给同图的其他人」这一件事 —— 移动预测仍在各自客户端，
 * 广播的坐标本质上是「他客户端眼里的位置」的延迟样本。
 */
interface PresenceEntry {
  zoneId: number;
  mapId: string;
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
   * 位置可信度基线（#596 最小仲裁）：上次**被接受**的上报坐标与时刻、连续异常计数。
   * 只影响 x/y 是否进在场表，hp / moving 不参与 —— 血量有权威落账链路，不在这一层管。
   */
  trustedX: number;
  trustedY: number;
  trustedAt: number;
  posRejects: number;
}

function worldKey(zoneId: number, mapId: string): string {
  return `${zoneId}:${mapId}`;
}

/**
 * 位置仲裁的「连续异常才跟随」阈值（#596 最小仲裁）
 *
 * 低于它：瞬移帧被整体屏蔽（别人的屏幕上不出现跳变）；达到它：视为合法重定位
 * （复活 / 传送 / 客户端纠偏），接受并把速度基线挪过去。1 次太敏感（正常网络乱序
 * 也可能造成一次大距离差），2 次起才有「持续性」可言。
 */
const POS_TRUST_STREAK = 2;

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
 * - **不落盘**：位置是几秒钟的表现层状态，持久真相仍在各自存档的出生定位；
 * - **不做视野裁剪**：单图人数上限远小于「同图观看者」规模，按 mapId 分组已足够
 *   （真实裁剪是四叉树 / AOI 的事，等有需求再说）；
 * - **不做插值补偿**：服务端拿到什么就发什么，平滑是各客户端自己的表现层职责。
 */
@Injectable()
export class PlayerPresenceService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PlayerPresenceService.name);

  /** 账号 → 在场信息（连接断开即删） */
  private readonly entries = new Map<string, PresenceEntry>();
  /** 账号名缓存（互见帧里顺手带上，省得客户端再查） */
  private readonly usernames = new Map<string, string>();
  /** `zone:mapId` → 攒下的离开账号（断线 / 换图时写入，广播时发出并清空） */
  private readonly pendingLeaves = new Map<string, string[]>();
  /** `zone:mapId` → 攒下的玩家动作事件（#693：结算路径写入，广播时发出并清空） */
  private readonly pendingActions = new Map<string, RealtimePlayerAction[]>();
  private broadcastTimer: NodeJS.Timeout | null = null;

  /**
   * 广播出口（发给谁、怎么发是通道的事）。RealtimeService 启动时接线；
   * 未接线时照常维护在场表，只是没人收到帧。
   */
  onBroadcast: ((zoneId: number, mapId: string, data: { mapId: string; full: boolean; players: RealtimePlayerEntry[]; left: string[]; actions: RealtimePlayerAction[] }) => void) | null = null;

  /**
   * 定向发送出口（快照兜底只发给刚进图的连接自己）。
   * 与 onBroadcast 分开：广播的收件人是「观看者集合」，这里是指定账号。
   */
  onSendTo: ((accountId: string, data: { mapId: string; full: boolean; players: RealtimePlayerEntry[]; left: string[]; actions: RealtimePlayerAction[] }) => void) | null = null;

  /**
   * 队伍查询出口（#399，RealtimeService 启动时接线到 `PartyService.partyIdOfRole`）
   *
   * 用函数而不是注入 PartyService：`RealtimeModule` 依赖 `PartyModule`，
   * 反过来注入就成环。这里要的只是「一次内存查询」，函数足够。
   */
  partyOfRole: ((roleId: string) => string) | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly roles: RolesService,
    private readonly guilds: GuildRepository,
  ) {}

  onApplicationBootstrap(): void {
    this.broadcastTimer = setInterval(() => this.broadcast(), this.broadcastMs()).unref();
    this.logger.log(`玩家互见已启动（广播 ${this.broadcastMs()}ms / 位置超时 ${this.posStaleMs()}ms）`);
  }

  onApplicationShutdown(): void {
    if (this.broadcastTimer) clearInterval(this.broadcastTimer);
    this.broadcastTimer = null;
  }

  //#region 输入（通道侧调用）

  /**
   * 记一条玩家动作事件（#693：结算路径在新结算成功后调用）
   *
   * 只攒不判：出手者在不在观看者的场上、有没有拉黑，都是**广播侧**的事
   * （visiblePlayers 统一过滤）—— 这里只负责按分域攒起来，随下一个互见广播节拍发出。
   * 幂等重发在结算入口就早退了，不会走到这里，天然不会重复广播。
   */
  recordAction(zoneId: number, mapId: string, action: RealtimePlayerAction): void {
    const key = worldKey(zoneId, mapId);
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
   * x/y 先过最小仲裁（#596）：非有限数直接丢；单帧速度超过 `posMaxSpeed()` 视作瞬移，
   * 连续不足 `POS_TRUST_STREAK` 次就丢帧（别人的屏幕上不出现跳变），连续达到则接受并
   * 重置基线 —— 复活 / 传送这类合法重定位是持续上报，短暂瞬移（作弊）是一次性的，
   * 用「持续异常才跟随」把两边都兜住。hp 只夹有限与非负（上限不夹：maxHp 懒刷新有滞后，
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
        posRejects: 0,
      });
      return;
    }
    // 换图必须经 worldJoin（#861）：自报的图与登记的不一致 → 整帧丢弃。
    // 连 `updatedAt` 都不刷 —— 否则伪造帧能让一个「其实不在那张图」的人永远不掉线
    if (existed.zoneId !== zoneId || existed.mapId !== mapId) return;
    existed.updatedAt = Date.now();
    // —— 位置仲裁（#596）：坐标可信才动 x/y，其余字段照旧 ——
    if (this.acceptPosition(existed, x, y)) {
      existed.x = x;
      existed.y = y;
    }
    existed.hp = Number.isFinite(hp) ? Math.max(0, hp) : 0;
    existed.moving = moving;
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
   * 位置最小仲裁（#596）：返回这帧坐标能不能进在场表
   *
   * 非有限数视为垃圾帧；单帧速度（对**上次被接受的**上报）超过 `posMaxSpeed()` 视作瞬移。
   * 拒绝的帧只加计数：连续达到 `POS_TRUST_STREAK` 次说明客户端真的重定位了（复活/传送），
   * 跟随并把基线挪过去，让后续帧恢复正常仲裁 —— 持续异常才跟随，短暂瞬移被整体屏蔽。
   */
  private acceptPosition(entry: PresenceEntry, x: number, y: number): boolean {
    // 非有限数是协议垃圾（不是「客户端重定位」），永不接受、也不计入跟随计数 ——
    // 不然连续两帧 Infinity 会被下面的宽容分支放行，垃圾坐标广播出去就是 NaN 血条
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const dt = Math.max(0, (entry.updatedAt - entry.trustedAt) / 1000);
    const dist = Math.hypot(x - entry.trustedX, y - entry.trustedY);
    const plausible = dist <= this.posMaxSpeed() * dt;
    if (plausible || entry.posRejects + 1 >= POS_TRUST_STREAK) {
      entry.trustedX = x;
      entry.trustedY = y;
      entry.trustedAt = entry.updatedAt;
      entry.posRejects = 0;
      return true;
    }
    entry.posRejects += 1;
    return false;
  }

  /**
   * 进图登记（worldJoin 应答后由通道调用）：给刚进图的连接发一份同图全量快照
   *
   * 换图也走这里 —— 旧图的同伴会在下一个广播节拍里收到 left：该账号的条目已换成新图，
   * 旧图的增量帧不再包含它，但「不再出现」不等于「已离开」（可能只是站桩不动），
   * 必须显式广播离开，客户端才会拆掉旧节点。
   */
  join(accountId: string, zoneId: number, mapId: string): void {
    const existed = this.entries.get(accountId);
    if (existed) {
      const movedMap = existed.zoneId !== zoneId || existed.mapId !== mapId;
      if (movedMap) this.queueLeave(existed.zoneId, existed.mapId, accountId);
      // 换图或原地重进都刷新新鲜度：刚登记就因上报迟到被当离场清掉，快照与增量就对不上了
      existed.updatedAt = Date.now();
      if (movedMap) {
        existed.zoneId = zoneId;
        existed.mapId = mapId;
        // 换图顺带重置位置仲裁基线（#861）：基线还是上一张图的坐标，跨图距离必然超限，
        // 不重置的话新图的第一帧上报会被当成瞬移拒掉几帧（看起来是「进图后愣半秒」）。
        // 换图这件事本身是服务端放行的，坐标该整体接受
        existed.trustedX = existed.x;
        existed.trustedY = existed.y;
        existed.trustedAt = Date.now();
        existed.posRejects = 0;
      }
    }
    const players: RealtimePlayerEntry[] = [];
    for (const [otherId, entry] of this.entries) {
      if (otherId === accountId) continue;
      if (entry.zoneId !== zoneId || entry.mapId !== mapId) continue;
      if (Date.now() - entry.updatedAt > this.posStaleMs()) continue;
      players.push(this.toEntry(otherId, entry));
    }
    this.onSendTo?.(accountId, { mapId, full: true, players, left: [], actions: [] });
  }

  /**
   * 连接断开 / 被踢：在场信息作废，并立即向同图观看者广播离开
   *
   * 立即（不等广播节拍）：离开是低频事件，玩家掉线后同伴多等几百毫秒没有收益。
   */
  dropAccount(accountId: string): void {
    const entry = this.entries.get(accountId);
    if (!entry) return;
    this.entries.delete(accountId);
    this.broadcastLeave(entry.zoneId, entry.mapId, accountId);
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
  positionOf(accountId: string): { zoneId: number; mapId: string; x: number; y: number; hp: number; at: number } | null {
    const entry = this.entries.get(accountId);
    if (!entry) return null;
    return { zoneId: entry.zoneId, mapId: entry.mapId, x: entry.x, y: entry.y, hp: entry.hp, at: entry.updatedAt };
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
  aiTargetsOn(zoneId: number, mapId: string): Array<{ accountId: string; x: number; y: number; hp: number; at: number }> {
    const now = Date.now();
    const staleMs = this.posStaleMs();
    const rows: Array<{ accountId: string; x: number; y: number; hp: number; at: number }> = [];
    for (const [accountId, entry] of this.entries) {
      if (entry.zoneId !== zoneId || entry.mapId !== mapId) continue;
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
   * 全服此刻所有「进过图」的账号 id（#876 世界频道的收件人口径）
   *
   * 在场表本身就是这张名单：worldJoin 进、断线/超时出，不需要另维护一张
   * 「全服在线」索引 —— 那又是一个要在四条路径上同步的东西。聊天是限频后的
   * 低频操作，全量拷贝一份 keys 完全不贵。
   *
   * 只读：不改在场表、不触发广播。
   */
  presentAccountIds(): string[] {
    return Array.from(this.entries.keys());
  }

  /**
   * 按角色找在线连接（#399：队伍快照的「在线 / 同图」与队友经验分成的「同图才分」都要它）
   *
   * 线性扫一遍在线表：队伍最多 4 人、每次击杀查一次，这个规模上完全够。
   * 为它维护一张反向索引，就得在「首见 / 换图 / 断线 / 超时」四条路径上同步 ——
   * 多出来的只是漂移的机会。
   *
   * 返回 null = 这个角色此刻不在线（没进图 / 断线 / 位置超时被清）。
   */
  locateRole(roleId: string): { accountId: string; mapId: string } | null {
    if (!roleId) return null;
    for (const [accountId, entry] of this.entries) {
      if (entry.roleId === roleId) return { accountId, mapId: entry.mapId };
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
  playersOn(zoneId: number, mapId: string): Array<{
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
      if (entry.zoneId !== zoneId || entry.mapId !== mapId) continue;
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
    if (this.onBroadcast === null && this.onSendTo === null) return;
    const now = Date.now();
    const staleMs = this.posStaleMs();
    // 按图分组的玩家增量（观看者以图为单位，分组后每个图最多发一帧）
    const changed = new Map<string, RealtimePlayerEntry[]>();
    for (const [accountId, entry] of this.entries) {
      // 超时视作离场：进 left、条目删除（重新上报后会作为新变化再次出现）
      if (now - entry.updatedAt > staleMs) {
        this.entries.delete(accountId);
        this.queueLeave(entry.zoneId, entry.mapId, accountId);
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
      const key = worldKey(entry.zoneId, entry.mapId);
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
    for (const key of keys) {
      const at = key.indexOf(":");
      const zoneId = Number(key.slice(0, at));
      const mapId = key.slice(at + 1);
      const left = this.pendingLeaves.get(key) ?? [];
      this.pendingLeaves.delete(key);
      this.onBroadcast?.(zoneId, mapId, {
        mapId,
        full: false,
        players: changed.get(key) ?? [],
        left,
        actions: actionsBy.get(key) ?? [],
      });
    }
  }

  /** 立即广播一次离开（断线 / 被踢走这条；超时离场走广播节拍，见 broadcast） */
  private broadcastLeave(zoneId: number, mapId: string, accountId: string): void {
    this.onBroadcast?.(zoneId, mapId, { mapId, full: false, players: [], left: [accountId], actions: [] });
  }

  /** 超时离场先进队列（与增量同节拍发出，避免超时清算一轮就广播 N 帧） */
  private queueLeave(zoneId: number, mapId: string, accountId: string): void {
    const key = worldKey(zoneId, mapId);
    const list = this.pendingLeaves.get(key) ?? [];
    list.push(accountId);
    this.pendingLeaves.set(key, list);
  }

  /** 广播条目形状 */
  private toEntry(accountId: string, entry: PresenceEntry): RealtimePlayerEntry {
    return {
      accountId,
      username: this.usernameOf(accountId),
      roleId: entry.roleId,
      guildId: entry.guildId,
      guildName: entry.guildName,
      partyId: entry.partyId,
      x: Math.round(entry.x * 100) / 100,
      y: Math.round(entry.y * 100) / 100,
      hp: entry.hp,
      maxHp: entry.maxHp,
      moving: entry.moving,
      // 复制一份再发：在场表里的那份会被下一次懒刷新整份替换，别让广播出去的对象跟着变
      appearance: { ...entry.appearance },
    };
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
      sex: typeof sex === "string" ? sex : typeof sex === "number" ? String(sex) : "1",
      cloth: wornId("cloth"),
      weapon: wornId("weapon"),
      // 时装历史形状是 number（从没人写过），只认字符串；数字一律当没穿
      fashion: typeof data.fashionCloth === "string" ? data.fashionCloth : "",
    };
  }

  /** 外观比较键（增量广播判据：四个字段拼一串，字符串比较比逐字段比省事） */
  private appearanceKey(appearance: RealtimePlayerAppearance): string {
    return `${appearance.sex}|${appearance.cloth}|${appearance.weapon}|${appearance.fashion}`;
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
    return Math.max(50, Number(this.config.get<number>("playerSyncBroadcastMs") ?? 200));
  }

  private posStaleMs(): number {
    return Math.max(500, Number(this.config.get<number>("monsterAiPosStaleMs") ?? 3000));
  }

  /**
   * 位置仲裁的速度上限（像素 / 秒，#596 最小仲裁）
   *
   * 取 1000 的理由：这是「荒谬级」阈值，不是贴着真实移速的钳制 —— 客户端跑步速度
   * 经物理刚体换算后在百像素/秒量级，1000 已经是它的近 10 倍，正常移动（含卡顿后的
   * 大步追帧）碰不到；而作弊瞬移通常一步跨出生点半径，单帧距离远超 1000 / 0.25s。
   * 定宽阈值的好处是不依赖各单位（物理 PTM / Tiled 像素）的换算口径，先上线挡住
   * 「零成本瞬移刷怪」，精确钳制等移速权威进属性汇总后再说。
   */
  private posMaxSpeed(): number {
    return Math.max(100, Number(this.config.get<number>("playerPosMaxSpeed") ?? 1000));
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
