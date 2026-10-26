import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { summarizeRoleAttributes } from "../combat/role-attributes";
import { RolesService } from "../roles/roles.service";
import type { RealtimePlayerAppearance, RealtimePlayerEntry } from "./realtime.protocol";

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
  /** 血条分母（首次见到该玩家时查一次在线角色缓存住；查不到按 1 兜底，血条不炸） */
  maxHp: number;
  /** 上报时刻是否在移动（客户端自报） */
  moving: boolean;
  updatedAt: number;
  /** 外观（#383：首见读一次，之后按 appearanceRefreshMs 懒刷新 —— 换装最多这么多秒被别人看到） */
  appearance: RealtimePlayerAppearance;
  /** 上次读外观的时刻（懒刷新判据） */
  appearanceAt: number;
  /** 上次广播出去的外观（增量广播的判据；空串保证首帧一定带上） */
  sentAppearance: string;
  /** 上次广播出去的位置 / 移动标记 / 血量（增量广播的判据） */
  sentX: number;
  sentY: number;
  sentMoving: boolean;
  sentHp: number;
}

function worldKey(zoneId: number, mapId: string): string {
  return `${zoneId}:${mapId}`;
}

/**
 * 玩家互见（#324：同图玩家的位置 / 血量 / 移动标记互见）
 *
 * ===========================================================================
 * 服务端做什么
 * ===========================================================================
 * 维护一张「谁在哪」的在场表（数据来自客户端的 `pos` 帧，与怪物 AI 共用同一输入、
 * 各自持有 —— AI 关心的是目标检测，这里关心的是转发；字段语义不同，不共表）：
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
  private broadcastTimer: NodeJS.Timeout | null = null;

  /**
   * 广播出口（发给谁、怎么发是通道的事）。RealtimeService 启动时接线；
   * 未接线时照常维护在场表，只是没人收到帧。
   */
  onBroadcast: ((zoneId: number, mapId: string, data: { mapId: string; full: boolean; players: RealtimePlayerEntry[]; left: string[] }) => void) | null = null;

  /**
   * 定向发送出口（快照兜底只发给刚进图的连接自己）。
   * 与 onBroadcast 分开：广播的收件人是「观看者集合」，这里是指定账号。
   */
  onSendTo: ((accountId: string, data: { mapId: string; full: boolean; players: RealtimePlayerEntry[]; left: string[] }) => void) | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly roles: RolesService,
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
   * 记录一次玩家位置上报（不校验图是否加载：上报先到、worldJoin 后到是正常时序）
   *
   * maxHp / 账号名 / 外观只在首次见到该玩家时查一次库（都不常变，不值得每帧查）；
   * 外观另有按 `appearanceRefreshMs` 的懒刷新（#383，换装后要能被别人看到）。
   */
  updatePosition(accountId: string, username: string, zoneId: number, mapId: string, x: number, y: number, hp: number, moving: boolean): void {
    const existed = this.entries.get(accountId);
    if (!existed) {
      const role = this.roles.online(accountId);
      const summary = role ? summarizeRoleAttributes(role) : null;
      const maxHp = summary && summary.maxHp > 0 ? summary.maxHp : Math.max(1, hp);
      // 显示名：角色名优先（互见看到的是「那个角色」，不是登录账号），缺省回落账号名
      const roleName = typeof role?.data?.name === "string" ? role.data.name : "";
      this.usernames.set(accountId, roleName || username);
      this.entries.set(accountId, {
        zoneId,
        mapId,
        x,
        y,
        hp,
        maxHp,
        moving,
        updatedAt: Date.now(),
        appearance: this.readAppearance(role),
        appearanceAt: Date.now(),
        sentAppearance: "",
        sentX: NaN,
        sentY: NaN,
        sentMoving: !moving,
        sentHp: -1,
      });
      return;
    }
    existed.zoneId = zoneId;
    existed.mapId = mapId;
    existed.x = x;
    existed.y = y;
    existed.hp = hp;
    existed.moving = moving;
    existed.updatedAt = Date.now();
    // 外观懒刷新（#383）：换装是低频事件，不值得每个 pos 帧查一次库（roles.online 是 DB 读）
    if (existed.updatedAt - existed.appearanceAt > this.appearanceRefreshMs()) {
      existed.appearance = this.readAppearance(this.roles.online(accountId));
      existed.appearanceAt = existed.updatedAt;
    }
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
      }
    }
    const players: RealtimePlayerEntry[] = [];
    for (const [otherId, entry] of this.entries) {
      if (otherId === accountId) continue;
      if (entry.zoneId !== zoneId || entry.mapId !== mapId) continue;
      if (Date.now() - entry.updatedAt > this.posStaleMs()) continue;
      players.push(this.toEntry(otherId, entry));
    }
    this.onSendTo?.(accountId, { mapId, full: true, players, left: [] });
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

  //#endregion

  //#region 广播

  private broadcast(): void {
    if (this.onBroadcast === null && this.onSendTo === null) return;
    const now = Date.now();
    const staleMs = this.posStaleMs();
    // 按 mapKey 分组增量（观看者以图为单位，分组后每个图最多发一帧）
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
      if (!moved && !turned && !hurt && !redressed) continue;
      const key = worldKey(entry.zoneId, entry.mapId);
      const list = changed.get(key) ?? [];
      list.push(this.toEntry(accountId, entry));
      changed.set(key, list);
      entry.sentX = entry.x;
      entry.sentY = entry.y;
      entry.sentMoving = entry.moving;
      entry.sentHp = entry.hp;
      entry.sentAppearance = this.appearanceKey(entry.appearance);
    }
    for (const [key, players] of changed) {
      const at = key.indexOf(":");
      const zoneId = Number(key.slice(0, at));
      const mapId = key.slice(at + 1);
      this.onBroadcast?.(zoneId, mapId, { mapId, full: false, players, left: [] });
    }
    // 攒下的离开事件按图广播
    for (const [key, left] of this.pendingLeaves) {
      this.pendingLeaves.delete(key);
      const at = key.indexOf(":");
      const zoneId = Number(key.slice(0, at));
      const mapId = key.slice(at + 1);
      this.onBroadcast?.(zoneId, mapId, { mapId, full: false, players: [], left });
    }
  }

  /** 立即广播一次离开（断线 / 被踢走这条；超时离场走广播节拍，见 broadcast） */
  private broadcastLeave(zoneId: number, mapId: string, accountId: string): void {
    this.onBroadcast?.(zoneId, mapId, { mapId, full: false, players: [], left: [accountId] });
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
   * 从在线角色数据里取出外观（#383）
   *
   * `data` 是不透明文档（客户端 entities/Role 的 JSON 快照，历史形状不一定听话），
   * 这里逐个收窄：类型不对一律回落默认值 —— 一个人的外观字段脏了不该让整帧广播失败。
   */
  private readAppearance(role: { data?: Record<string, unknown> } | null): RealtimePlayerAppearance {
    const data = (role?.data ?? {}) as Record<string, unknown>;
    const equipments = (data.equipments ?? {}) as Record<string, unknown>;
    // 性别：客户端 SEX 是字符串枚举（"1" 男 / "2" 女），但历史存档里也见过数字 —— 两种都收
    const sex = data.sex;
    return {
      sex: typeof sex === "string" ? sex : typeof sex === "number" ? String(sex) : "1",
      cloth: typeof equipments.cloth === "string" ? equipments.cloth : "",
      weapon: typeof equipments.weapon === "string" ? equipments.weapon : "",
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
