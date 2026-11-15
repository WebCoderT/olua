import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BizCode } from "../../common/constants/biz-code";
import {
  DROP_MAX_PER_MAP_DEFAULT,
  DROP_MAX_PER_MAP_RANGE,
  DROP_OVERFLOW_REASON,
  DROP_RESULT,
  DropOverflowReason,
  DropResult,
} from "../../common/constants/drop";
import { BizException } from "../../common/errors/biz.exception";
import { itemLabelOf, itemTypeOf } from "../../common/runtime-config-cache";
import { legacyWorldKey } from "../../common/utils/room-key.util";
import { ownsZone, shardCountOf } from "../../common/utils/shard.util";
import { DropClearRequestRepository } from "../../database/repositories/drop-clear-request.repository";
import { DropRecordInsert, DropRecordRepository } from "../../database/repositories/drop-record.repository";
import { WorldDropRepository } from "../../database/repositories/world-drop.repository";
import type { DropClearRequestRow, WorldDropRow } from "../../database/rows";
import { RuntimeParamsRepository } from "../../database/repositories/runtime-params.repository";
import { RolesService } from "../roles/roles.service";
import { PartyService } from "../party/party.service";
import { PlayerPresenceService } from "./player-presence.service";
import { avoidOverlap, scatterDropPositions } from "./drop-scatter";
import type {
  RealtimeDropNoticeMessage,
  RealtimeDropRemoveMessage,
  RealtimeDropSnapshot,
  RealtimeDropSpawnMessage,
  RealtimePickedData,
  RealtimePickedError,
  RealtimeServerMessage,
} from "./realtime.protocol";

/**
 * 地面掉落物（#802）：从「击杀者的私人账本」升级成**世界实体**
 *
 * ## 这一刀改的是「存哪 / 谁能捡 / 何时消失」
 *
 * 掉落**怎么算出来的**一点没动（`CombatSettlementService.rollDrops` 的权重、概率、绑定判定
 * 全部照旧）。以前算完就写进 `Map<accountId, Map<castId, entry[]>>` —— 别人的客户端只能
 * 「演」掉落，捡不起来；也没有任何一处能回答「这件东西最后去哪了」。现在算完交给这里：
 *
 * - 落点由服务端算（`drop-scatter`），同图所有人拿到**同一份**坐标；
 * - 归属与保护期是实体字段（掉落那一刻的 `partyId` 快照），不是账号账本；
 * - 生命周期只由 `expireAt` 决定 —— **与图实例解耦**：图卸载只停 AI，掉落留着；
 * - 每次状态变化都广播（`dropSpawn` / `dropRemove`），库里的 `world_drops` 只是投影。
 *
 * ## 为什么权威在内存，库只是投影
 *
 * 拾取是每秒都可能发生的操作，走库就是每条 pick 一次事务；而落点、保护期、距离校验
 * 都需要**同一份**内存状态。所以内存是权威，100ms 批量 UPSERT 一次库（写放大从
 * 10~20 行/秒降到 1 次/100ms）。代价：进程被硬杀时最多丢最后一拍的生成记录 —— 这类
 * 掉落本来就会随重启清场，丢了也无所谓（它从没进过库）。
 *
 * ## 重启清场只在本进程做
 *
 * 本服务是 `RealtimeModule` 的 provider，而 `RealtimeModule` 只在
 * `AppModule.register({ realtime: true })` 时装载 —— 存档进程（3100）根本不实例化它。
 * 所以「管理端重启把地上的东西清空」这种事不会发生，不需要再判一次环境变量。
 *
 * ## 终态写一条流水（#803）
 *
 * 地面上的东西每次进终态（`picked` / `expired` / `overflow`）都往 `drop_records` 写**一行**，
 * 连同重启清场作废的那批（`restart_lost`）—— 这张表是 append-only 的历史，回答「这件东西
 * 最后去哪了」。三条纪律：
 *
 * - **不阻塞拾取**：`resolve()` 只把行推进队列，真正的 INSERT 在 100ms 的 `flush()` 里攒成
 *   一批（`insertMany` 一个事务），与投影表的写入同一拍；
 * - **写失败只 warn**：世界状态是权威，少一条流水远比让一次真实的拾取报错要好；
 * - **两道保留闸**：每图条数（攒够一批才裁）+ 天数（独立节拍扫全表）—— 条数闸只在写入时
 *   触发，管不住「这张图从此没人打」的死图，所以天数闸不能省。
 */
@Injectable()
export class DropService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DropService.name);

  /**
   * `zone:mapId` → dropId → 实体（世界权威）
   *
   * 键是**两段**（`legacyWorldKey`，即公共线的 `zone:mapId`）：掉落是**图级**的，
   * 同一张图的各条分线看到的是同一片地面。等 #812 真做分线副本时，这里换成
   * `roomKey(zoneId, mapId, slot)` 即可，其余逻辑不动。
   */
  private readonly ground = new Map<string, Map<string, DropEntity>>();
  /** 全局反查（`pick` 帧只带 dropId，需要 O(1) 找到实体与所属图） */
  private readonly byId = new Map<string, DropEntity>();
  /**
   * 刚结束的实体（终态后保留一小段）
   *
   * 用途只有一个：**应答丢包后的重发**。玩家点了一下，服务端入包成功、`picked` 帧在
   * 网络上丢了，客户端重发同一个 `dropId` —— 这时实体已经从 `byId` 里删了，直接判
   * `unknown_drop` 会让玩家以为没捡到。docs/18 §5.3 第 3 步要求这种重发得到
   * `alreadyPicked: true`，所以终态实体再留 `RESOLVED_RETENTION_MS`。
   *
   * 不进快照、不进广播、不写库，`sweep` 按时间丢 —— 只是一段短命的「回放记忆」。
   */
  private readonly recent = new Map<string, { entity: DropEntity; at: number }>();

  /** 待写库的新增（flush 时批量 UPSERT） */
  private readonly dirty = new Set<DropEntity>();
  /** 待广播的新增（flush 时合并成一帧 dropSpawn） */
  private readonly pendingSpawn = new Map<string, DropEntity[]>();
  /** 待广播的移除（flush 时按（图, 原因）合并） */
  private readonly pendingRemove = new Map<string, { zoneId: number; mapId: string; ids: string[]; reason: DropRemoveReason; byName?: string }>();
  /** 待写流水的终态（flush 时一批 INSERT；不为每件掉落单开事务，也不阻塞拾取路径） */
  private readonly pendingRecords: DropRecordInsert[] = [];
  /** `区:图` → 上次裁剪之后又写了几条（攒够 `dropRecordTrimEvery` 才 DELETE 一次） */
  private readonly pendingTrim = new Map<string, number>();

  /** 每个区一份自增序号（进程重启从 1 开始也没关系：旧 id 已随清场消失） */
  private readonly seqByZone = new Map<number, number>();

  /** 稀有掉落公告的抑制时间戳（全服 30 秒最多一条） */
  private announcedAt = 0;
  /** 上次扫天数闸的时刻（0 = 还没扫过 → 第一次 flush 就补跑一次） */
  private lastPruneAt = 0;
  /** 天数闸「已关闭」的 warn 只打一次（否则每 100ms 一条，日志会被自己刷爆） */
  private pruneDisabledWarned = false;

  private flushTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;

  /** 广播出口（由 `RealtimeService` 接线：遍历该图观看者发帧） */
  onBroadcast?: (zoneId: number, mapId: string, frame: RealtimeServerMessage) => void;
  /** 全服公告出口（同上，遍历全部连接） */
  onAnnounce?: (frame: RealtimeDropNoticeMessage) => void;

  constructor(
    private readonly worldDrops: WorldDropRepository,
    private readonly dropRecords: DropRecordRepository,
    private readonly clearRequests: DropClearRequestRepository,
    private readonly roles: RolesService,
    private readonly presence: PlayerPresenceService,
    private readonly party: PartyService,
    private readonly runtimeParams: RuntimeParamsRepository,
    private readonly config: ConfigService,
  ) {}

  //#region 生命周期

  onApplicationBootstrap(): void {
    this.clearOnRestart();
    this.flushTimer = setInterval(() => this.flush(), DROP_FLUSH_MS);
    this.sweepTimer = setInterval(() => this.sweep(), DROP_SWEEP_MS);
    // 定时器不该拖住进程退出（与 monster-ai / presence 同口径）
    this.flushTimer.unref?.();
    this.sweepTimer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.flushTimer = null;
    this.sweepTimer = null;
    // 退出前把最后一拍写进库：不写也不会错（下次启动会清场），但少一批「凭空消失」
    this.flush();
  }

  /**
   * 重启清场（docs/18 §5.5）
   *
   * 上一进程留下的地面掉落没有意义了 —— 客户端那条连接也断了，重连时拿到的 `world`
   * 快照必须是「地面上什么都没有」，否则屏幕上会立着一堆捡不起来的东西。
   *
   * 清之前先把每一行转成一条 `restart_lost` 流水（#803）：倒过来（先清后记）一旦写库失败，
   * 这批掉落就彻底没有痕迹了 —— 玩家会问「我刚才掉的东西呢」，而库里连它存在过都查不到。
   * 行数上限是 `maxGroundPerMap × 图数`，一次全读 + 一次批量写没有压力。
   */
  private clearOnRestart(): void {
    const leftover = this.worldDrops.listAll();
    if (leftover.length > 0) {
      const now = Date.now();
      this.recordRestartLost(leftover, now);
      this.worldDrops.clearAll();
      this.logger.warn(`重启清场：${leftover.length} 件地面掉落已作废（转成 restart_lost 流水）`);
    }
    this.ground.clear();
    this.byId.clear();
    this.recent.clear();
    this.dirty.clear();
    this.pendingSpawn.clear();
    this.pendingRemove.clear();
    this.pendingRecords.length = 0;
    this.pendingTrim.clear();
  }

  /** 上一进程留下的投影行 → `restart_lost` 流水（写失败只 warn：这些掉落本来就要消失） */
  private recordRestartLost(rows: WorldDropRow[], now: number): void {
    try {
      this.dropRecords.insertMany(rows.map((row) => this.recordOfRow(row, now)));
    } catch (error) {
      this.logger.warn(`重启清场的 ${rows.length} 件掉落没写进流水：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  //#endregion

  //#region 生成

  /**
   * 生成一批掉落实体（一次击杀 / 一次施放打死多只各调一次）
   *
   * 散落坐标在这里算：**落点 = 死亡点 + 同心环偏移**，再与「该图已有的落点」推开
   * （两次击杀挨得近时，两堆东西不会叠成一个点）。返回值按输入顺序给 `dropId`，
   * 调用方拿它回填 `settle.reward.drops`。
   *
   * **区是自己算的**（`roles.zoneOf(归属者)`，权威是 `roles.zone_id`）：掉落属于谁打出来的
   * 那个人所在的区，这件事由服务端定，不接受调用方传一个"看上去对"的区进来 ——
   * 传错只会让两套经济串味（docs/39 §2.4）。
   */
  spawn(input: DropSpawnInput): Array<{ dropId: string; goodId: string; count: number; bound: boolean }> {
    // 只过滤「数量为 0」这种抽取阶段不该产出的形状；**物品是否存在由抽取侧过滤**（docs/18 §5.8），
    // 这里不再二次筛 —— 返回数组与输入严格一一对应，调用方才能按下标回填 dropId
    const drops = input.drops.filter((drop) => drop.count > 0);
    if (drops.length === 0) return [];

    const zoneId = this.roles.zoneOf(input.owner.accountId);
    const now = Date.now();
    const ttl = this.ttlMs();
    const protect = Math.min(this.protectMs(), ttl);
    const scatterMin = this.scatterMinDistance();
    const offsets = scatterDropPositions(drops.length, scatterMin);
    const key = legacyWorldKey(zoneId, input.mapId);
    let field = this.ground.get(key);
    if (!field) {
      field = new Map<string, DropEntity>();
      this.ground.set(key, field);
    }
    const taken = Array.from(field.values()).map((entity) => ({ x: entity.x, y: entity.y }));
    // 归属者的职业 / 性别（#804）：客户端要拿它拼 `ui/avatar/{职业}-{性别}.png` 画归属小头像。
    // 掉落是击杀者打出来的，他此刻必然在线（`online` 取的就是当前选中角色）；取不到就留空，
    // 客户端退化为「只显示『XX的』前缀」（docs/18 §6.7）。
    const ownerRole = this.roles.online(input.owner.accountId);

    const result: Array<{ dropId: string; goodId: string; count: number; bound: boolean }> = [];
    for (let index = 0; index < drops.length; index += 1) {
      const drop = drops[index];
      const offset = offsets[index] ?? { x: 0, y: 0 };
      const rawSpot = avoidOverlap({ x: input.x + offset.x, y: input.y + offset.y }, taken, scatterMin);
      // 落点**存整像素**：内存、库里的投影行、广播帧必须是同一个数（不整的话三处各自四舍五入，
      // 管理端看到的位置会与画面差零点几像素，排查时先怀疑人生）
      const spot = { x: Math.round(rawSpot.x), y: Math.round(rawSpot.y) };
      taken.push(spot);
      const dropId = this.nextDropId(zoneId, input.mapId);
      const entity: DropEntity = {
        dropId,
        zoneId,
        mapId: input.mapId,
        x: spot.x,
        y: spot.y,
        goodId: drop.goodId,
        goodLabel: itemLabelOf(drop.goodId) ?? drop.goodId,
        count: drop.count,
        bound: drop.bound,
        from: itemTypeOf(drop.goodId) === "equipment"
          ? { role: input.owner.name, monster: input.source.monsterKey, at: now }
          : undefined,
        owner: {
          accountId: input.owner.accountId,
          roleId: input.owner.roleId,
          name: input.owner.name,
          ...(ownerRole ? { occupation: ownerRole.occupation, sex: ownerRole.sex } : {}),
        },
        partyId: input.partyId ?? null,
        source: {
          instanceId: input.source.instanceId,
          monsterKey: input.source.monsterKey,
          label: input.source.label,
          tier: input.source.tier ?? "",
        },
        createdAt: now,
        expireAt: now + ttl,
        protectUntil: now + protect,
        status: "ground",
      };
      field.set(dropId, entity);
      this.byId.set(dropId, entity);
      this.dirty.add(entity);
      this.queueSpawn(entity);
      result.push({ dropId, goodId: entity.goodId, count: entity.count, bound: entity.bound });
    }
    this.logger.debug(`掉落生成：${key} ${result.map((item) => `${item.goodId}×${item.count}`).join(" / ")}（归属 ${input.owner.name}）`);
    this.maybeAnnounce(input, result);
    return result;
  }

  /** 一次出招打死多只时，同类物品会散成多堆 —— 让它们各自有 id，不合并（合并是抽取阶段的事） */
  private nextDropId(zoneId: number, mapId: string): string {
    const next = (this.seqByZone.get(zoneId) ?? 0) + 1;
    this.seqByZone.set(zoneId, next);
    return `d_${zoneId}_${mapId}_${next}`;
  }

  //#endregion

  //#region 拾取

  /**
   * 拾取一件掉落物（**唯一入口**：九步校验 + 入包 + 状态迁移 + 广播 + 记录）
   *
   * 校验顺序不能改（docs/18 §5.3）：先判「有没有这件东西」，再判「你在不在那张图」，
   * 再判状态与过期，再判归属，最后才是距离与入包。顺序改了会出现「别人的掉落提示
   * too_far 而不是 protected」这类难解释的应答。
   *
   * **并发安全**：全程同步（Node 单线程 + `node:sqlite` 同步驱动），两个玩家同时点同一件
   * 天然串行，第二个看到 `status=picked` 得到 `already_picked`。以后有人把这里改成 async，
   * 这个前提就破了 —— 那时要显式加锁。
   */
  pick(accountId: string, rawDropId: unknown): RealtimePickedData {
    const dropId = typeof rawDropId === "string" ? rawDropId : "";
    const fail = (
      code: string,
      message: string,
      extra?: { waitMs?: number; ownerName?: string; byName?: string },
    ): RealtimePickedError => ({ dropId, ok: false, code, message, ...(extra ?? {}) });

    // 1. 实体在不在（终态的一小段窗口里还能反查到，供「应答丢包后重发」判幂等）
    const entity = dropId ? this.byId.get(dropId) ?? this.recent.get(dropId)?.entity : undefined;
    if (!entity) return fail("unknown_drop", "这件掉落物已不存在（被人捡走、已过期或刚清过场）");

    // 2. 在不在同一张图（区 + 图；房号里的 slot 不参与 —— 掉落是图级的，#812 分线时才需要复核）
    //
    // 判据用**服务端自己记的**位置（`roles.zone_id` + `data.mapAt`，后者只在「接受一次
    // worldJoin」时写），不是在场表那条缓存 —— 在场条目由客户端 `pos` 帧创建，几秒不上报就
    // 会过期；拿它判图等于「只要不报位置就能隔着图捡东西」。
    const zoneId = this.roles.zoneOf(accountId);
    const mapAt = this.roles.mapAtOfOnlineRole(accountId);
    if (zoneId !== entity.zoneId || mapAt !== entity.mapId) {
      return fail("not_on_map", "这件掉落物不在你当前所在的地图上");
    }

    // 3. 状态
    if (entity.status === "picked") {
      // 自己重传（应答丢包）→ 幂等成功，不重复入包
      if (entity.pickedBy && entity.pickedBy.accountId === accountId) {
        const revision = this.roles.onlineRevision(accountId);
        if (revision === null) return fail("no_role", "当前没有在线角色，无法拾取");
        return {
          dropId,
          ok: true,
          revision,
          placed: [],
          alreadyPicked: true,
          goodId: entity.goodId,
          count: entity.count,
        };
      }
      return fail("already_picked", `这件掉落物已被「${entity.pickedBy?.name ?? "别人"}」拾取`, {
        byName: entity.pickedBy?.name,
      });
    }
    if (entity.status !== "ground") return fail("expired", "这件掉落物已经消失");

    const now = Date.now();
    // 4. 过期（扫描定时器 1 秒一拍，中间这一小段由这里兜住）
    if (now >= entity.expireAt) {
      this.resolve(entity, "expired");
      return fail("expired", "这件掉落物已经过期消失");
    }

    // 5. 归属判定：归属者本人 / 保护期已过 / 掉落时同队的队友（按**掉落那一刻**的 partyId 快照）
    if (entity.owner.accountId !== accountId && now < entity.protectUntil) {
      const identity = this.presence.identityOf(accountId);
      const myParty = identity?.roleId ? this.party.partyIdOfRole(identity.roleId) : "";
      const sameParty = Boolean(entity.partyId) && Boolean(myParty) && entity.partyId === myParty;
      if (!sameParty) {
        return fail("protected", `「${entity.owner.name}」击杀的物品，${Math.ceil((entity.protectUntil - now) / 1000)} 秒后才开放拾取`, {
          waitMs: entity.protectUntil - now,
          ownerName: entity.owner.name,
        });
      }
    }

    // 6. 距离闸（docs/18 §5.3 第 6 步：**位置未知就放行**）
    //    位置来自客户端 4Hz 上报，刚进图的几百毫秒内可能是空；拒绝正常玩家比漏判严重得多。
    //    过期位置同样按「未知」处理（上报被挡住的老客户端不该整片图都捡不起来）。
    const position = this.presence.positionOf(accountId);
    if (position && now - position.at <= PICK_POS_STALE_MS && position.mapId === entity.mapId) {
      const range = this.pickRange();
      const distance = Math.hypot(position.x - entity.x, position.y - entity.y);
      if (range > 0 && distance > range) {
        return fail("too_far", `离掉落物 ${Math.round(distance)}px，超出可拾取距离 ${range}px —— 走近再捡`);
      }
    }

    // 7. 在线角色
    const onlineRole = this.roles.online(accountId);
    if (!onlineRole) return fail("no_role", "当前没有在线角色，无法拾取");

    // 8. 入包（背包满 / 物品被删都在这里）
    try {
      const placed = this.roles.pickDrop(accountId, entity.goodId, entity.count, {
        bound: entity.bound,
        from: entity.from,
      });
      // 9. 成功：状态迁移 + 广播 + 记录
      entity.status = "picked";
      entity.pickedBy = { accountId, roleId: onlineRole.id, name: this.nameOfRole(onlineRole), at: now };
      this.resolve(entity, "picked");
      return {
        dropId,
        ok: true,
        revision: placed.revision,
        placed: placed.placed,
        alreadyPicked: false,
        goodId: entity.goodId,
        count: entity.count,
      };
    } catch (caught) {
      if (!(caught instanceof BizException)) throw caught;
      const error = caught;
      if (error.code === BizCode.ROLE_DATA_INVALID) {
        // 物品配置被删：这件东西**永远**捡不起来，留着只会让人反复点 —— 当场作废
        this.resolve(entity, "expired");
        return fail("item_gone", "这件物品的配置已被删除，无法拾取");
      }
      const code = error.code === BizCode.MALL_BAG_FULL
        ? "bag_full"
        : error.code === BizCode.ROLE_KICKED
          ? "role_kicked"
          : error.code === BizCode.ROLE_NOT_FOUND
            ? "no_role"
            : "pick_failed";
      return fail(code, error.message);
    }
  }

  //#endregion

  //#region 快照 / 清理 / 落库

  /** 一张图的地面全量（进图 / 重连时补快照用；`world` 帧的 `drops` 段） */
  snapshotOf(zoneId: number, mapId: string): RealtimeDropSnapshot[] {
    const field = this.ground.get(legacyWorldKey(zoneId, mapId));
    if (!field) return [];
    const now = Date.now();
    const list: RealtimeDropSnapshot[] = [];
    for (const entity of field.values()) {
      if (entity.status !== "ground" || entity.expireAt <= now) continue;
      list.push(this.snapshotOfEntity(entity, now));
    }
    return list;
  }

  /** 一张图现在的掉落件数（管理端「当前地面」用；也可以直接读库） */
  countOf(zoneId: number, mapId: string): number {
    return this.ground.get(legacyWorldKey(zoneId, mapId))?.size ?? 0;
  }

  /**
   * 过期扫描 + 单图超限裁剪（1 秒一拍）
   *
   * 超限按 `createdAt` 从旧到新挤掉：一张图同时有 200 件掉落已经是「完全没人捡」的极端，
   * 再多会把帧撑大（`dropSpawn` 是批量数组）。挤掉的记 `overflow`，客户端据此移除节点。
   */
  private sweep(): void {
    const now = Date.now();
    // 管理端提交的清空请求也在这个节拍上执行（#805）：两边都按秒级，不需要更快的定时器
    this.applyClearRequests(now);
    const cap = this.maxGroundPerMap();
    // 回放记忆到期就丢（数量上限 = 这段时间内的拾取/过期次数，通常个位数）
    for (const [dropId, entry] of this.recent) {
      if (now - entry.at >= RESOLVED_RETENTION_MS) this.recent.delete(dropId);
    }
    for (const [key, field] of this.ground) {
      for (const entity of Array.from(field.values())) {
        if (entity.status === "ground" && entity.expireAt <= now) this.resolve(entity, "expired");
      }
      const alive = Array.from(field.values()).filter((entity) => entity.status === "ground");
      if (alive.length <= cap) continue;
      alive
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, alive.length - cap)
        .forEach((entity) => {
          this.logger.warn(`单图掉落超上限（${key}）：挤掉最旧的 ${entity.dropId}（${entity.goodId}）`);
          this.resolve(entity, "overflow", DROP_OVERFLOW_REASON.AUTO);
        });
    }
  }

  /**
   * 执行管理端提交的「清空某图地面」请求（#805）
   *
   * 请求是**另一个进程**（管理端 3100）插进 `drop_clear_requests` 的 —— 地面掉落活在本进程
   * 内存里，所以只有这里能真的清掉。三条纪律：
   *
   * 1. **只处理自己分片管的区**：分片形态下别的区的请求既不执行也不回写 —— 回写 `done_at`
   *    会让真正管那个区的进程跳过它，症状是「点了清空没反应」；
   * 2. **读库抛错就下一拍再试**：回写只发生在真清完之后；
   * 3. **清 0 件也要回写**：那张图本来就是空的，不回写页面会一直等到「实时进程可能没起来」。
   */
  private applyClearRequests(now: number): void {
    let pending: DropClearRequestRow[];
    try {
      pending = this.clearRequests.listPending();
    } catch (error) {
      this.logger.warn(`清空请求读取失败（下一拍再试）：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (pending.length === 0) return;
    for (const request of pending) {
      const zoneId = Number(request.zone_id);
      if (!Number.isInteger(zoneId) || !this.managesZone(zoneId)) continue;
      const cleared = this.clearMap(zoneId, request.map_id);
      try {
        this.clearRequests.markDone(request.id, cleared, now);
      } catch (error) {
        this.logger.warn(
          `清空请求 #${request.id} 执行完了但回写失败（下一拍会重清一次，件数会变成 0）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }
      this.logger.log(`管理端清空地面：区 ${zoneId} 图 ${request.map_id} 清掉 ${cleared} 件`);
    }
  }

  /**
   * 清掉一张图地面上的全部掉落，返回实际清掉多少件（#805）
   *
   * 每件都走 `resolve()`：于是**流水照写**（`overflow` + `manual_clear`）、**广播照发**
   * （`dropRemove`）、投影表照删 —— 与「被挤掉」走同一条收尾路径，只是原因不同。
   * 单独写一条「清空专用」的收尾会漏掉其中一两步（漏删投影 = 页面清了又出现）。
   */
  clearMap(zoneId: number, mapId: string): number {
    const field = this.ground.get(legacyWorldKey(zoneId, mapId));
    if (!field) return 0;
    const entities = Array.from(field.values()).filter((entity) => entity.status === "ground");
    for (const entity of entities) this.resolve(entity, "overflow", DROP_OVERFLOW_REASON.MANUAL_CLEAR);
    return entities.length;
  }

  /** 这个区归不归本进程管（分片形态下，别的区的清空请求不能由我们回写，见 applyClearRequests） */
  private managesZone(zoneId: number): boolean {
    const count = shardCountOf(this.config.get<number>("realtimeShardCount") ?? 1);
    const index = this.config.get<number>("realtimeShardIndex") ?? 0;
    return ownsZone(zoneId, count, index);
  }

  /**
   * 把实体推进终态：从内存删、进「短期回放记忆」、排队删库、排队广播、排队写流水
   *
   * @param result 终态（同时也是 `drop_records.result` 的取值）
   * @param detail 只有 `overflow` 用得上：`auto`（超单图上限被挤掉）/ `manual_clear`
   *   （管理端清空，#805）。其余结果传空 —— 细分信息那一列对它们没有意义
   */
  private resolve(entity: DropEntity, result: DropRemoveReason, detail?: DropOverflowSource): void {
    const field = this.ground.get(legacyWorldKey(entity.zoneId, entity.mapId));
    field?.delete(entity.dropId);
    if (field && field.size === 0) this.ground.delete(legacyWorldKey(entity.zoneId, entity.mapId));
    this.byId.delete(entity.dropId);
    this.dirty.delete(entity);
    // 留着让重发的 pick 收回 alreadyPicked（`sweep` 到期丢；不占快照、不写库）
    this.recent.set(entity.dropId, { entity, at: Date.now() });
    this.pendingRecords.push(this.recordOf(entity, result, detail));
    this.queueRemove(entity, result);
  }

  /** 100ms 一拍：批量落流水 + 批量落投影 + 批量广播 */
  private flush(): void {
    // 流水先写：万一这一拍中途出问题，宁可「留一条流水 + 一行没人捡的投影」（下次启动会清场
    // 并再记一条 restart_lost），也不要「投影删了、流水没写」—— 后者是彻底没有痕迹
    this.flushRecords();

    if (this.dirty.size) {
      const rows = Array.from(this.dirty);
      this.dirty.clear();
      for (const entity of rows) this.worldDrops.upsert(this.rowOf(entity));
    }

    if (this.pendingSpawn.size) {
      const batches = Array.from(this.pendingSpawn.entries());
      this.pendingSpawn.clear();
      const now = Date.now();
      for (const [, entities] of batches) {
        const first = entities[0];
        if (!first) continue;
        const frame: RealtimeDropSpawnMessage = {
          type: "dropSpawn",
          data: {
            mapId: first.mapId,
            drops: entities.filter((entity) => entity.status === "ground").map((entity) => this.snapshotOfEntity(entity, now)),
            serverNow: now,
          },
        };
        if (frame.data.drops.length === 0) continue;
        this.onBroadcast?.(first.zoneId, first.mapId, frame);
      }
    }

    if (this.pendingRemove.size) {
      const batches = Array.from(this.pendingRemove.entries());
      this.pendingRemove.clear();
      for (const [, batch] of batches) {
        // 先删库再广播：广播出去就是「屏幕上没有了」，库里留着会让重连的人又看到它
        this.worldDrops.deleteByIds(batch.ids);
        const frame: RealtimeDropRemoveMessage = {
          type: "dropRemove",
          data: {
            mapId: batch.mapId,
            dropIds: batch.ids,
            reason: batch.reason,
            ...(batch.byName ? { byName: batch.byName } : {}),
          },
        };
        this.onBroadcast?.(batch.zoneId, batch.mapId, frame);
      }
    }

    // 天数闸每 `dropRecordPruneMs` 扫一次（挂在 flush 上：这个定时器与有没有掉落无关，恒在跑）
    this.maybePrune();
  }

  /**
   * 把攒下的终态写成流水（一拍一批），并在写完顺手做条数闸
   *
   * 三条刻意的处理：
   * - **写失败只 warn**：流水是历史，世界状态才是权威 —— 一条写不进去不该让这一拍的广播也停掉；
   * - **失败就跳过裁剪**：这一批没进去，按条数裁会把「刚写的那几条还没进库」算错；
   * - **裁剪按图攒批**：每件掉落都 `DELETE` 一次会让 WAL 白涨（与地图监控事件同一口径）。
   */
  private flushRecords(): void {
    if (this.pendingRecords.length === 0) return;
    const batch = this.pendingRecords.splice(0);
    try {
      this.dropRecords.insertMany(batch);
    } catch (error) {
      this.logger.warn(`掉落流水写入失败（${batch.length} 条）：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (const record of batch) this.trimIfNeeded(record.zone_id, record.map_id);
  }

  /** 条数闸：同一张图写够 `dropRecordTrimEvery` 条就裁一次（只留最近 `dropRecordKeepPerMap` 条） */
  private trimIfNeeded(zoneId: number, mapId: string): void {
    const key = `${zoneId}:${mapId}`;
    const pending = (this.pendingTrim.get(key) ?? 0) + 1;
    const every = this.trimEvery();
    if (pending < every) {
      this.pendingTrim.set(key, pending);
      return;
    }
    this.pendingTrim.set(key, 0);
    try {
      const keep = this.keepPerMap();
      const removed = this.dropRecords.trimPerMap(zoneId, mapId, keep);
      if (removed > 0) this.logger.debug(`掉落流水（区 ${zoneId} 图 ${mapId}）裁掉 ${removed} 条（每图保留 ${keep}）`);
    } catch (error) {
      this.logger.warn(`掉落流水裁剪失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 天数闸：删掉超过保留期的流水（#803）
   *
   * 与条数闸是两道独立的闸（取先到）：那一道只在写入时跑，管不住「这张图从此没人打」——
   * 没有写入就没有裁剪。这一道按 `created_at` 扫全表，与有没有人在写都无关。
   *
   * `≤ 0` 视为**关闭**（不是「保留 0 天 = 全删」）：运维想留全量时把它设成 0，
   * 而不是看着它把库清空。
   */
  private maybePrune(): void {
    const now = Date.now();
    if (now - this.lastPruneAt < this.pruneIntervalMs()) return;
    this.lastPruneAt = now;
    const days = this.retentionDays();
    if (days <= 0) {
      if (!this.pruneDisabledWarned) {
        this.logger.warn("DROP_RECORD_RETENTION_DAYS ≤ 0：掉落流水的天数闸已关闭，只按每图条数裁剪");
        this.pruneDisabledWarned = true;
      }
      return;
    }
    try {
      const removed = this.dropRecords.trimOlderThan(now - days * 24 * 60 * 60 * 1000);
      if (removed > 0) this.logger.log(`掉落流水天数闸：删掉 ${removed} 条超过 ${days} 天的旧记录`);
    } catch (error) {
      this.logger.warn(`掉落流水天数闸失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 实体 → 投影行（字段名的唯一映射点：实体是驼峰、库是下划线，别在两处各转一遍） */
  private rowOf(entity: DropEntity): WorldDropRow {
    return {
      drop_id: entity.dropId,
      zone_id: entity.zoneId,
      map_id: entity.mapId,
      good_id: entity.goodId,
      count: entity.count,
      bound: entity.bound ? 1 : 0,
      x: entity.x,
      y: entity.y,
      owner_account_id: entity.owner.accountId,
      owner_role_id: entity.owner.roleId,
      owner_name: entity.owner.name,
      party_id: entity.partyId,
      monster_key: entity.source.monsterKey,
      monster_label: entity.source.label,
      monster_instance_id: entity.source.instanceId,
      origin_role: entity.from?.role ?? null,
      origin_at: entity.from?.at ?? null,
      created_at: entity.createdAt,
      expire_at: entity.expireAt,
      protect_until: entity.protectUntil,
    };
  }

  /**
   * 实体 → 流水行（`drop_records` 的唯一映射点）
   *
   * 与 `rowOf`（投影行）分开而不是复用：两张表的用途不同 —— 投影行答「现在地上有什么」，
   * 流水行答「这件东西最后怎么了」，后者多了结果、拾取人、存活时长，少了坐标与保护期。
   *
   * `resolved_at` 取拾取那一刻（`pickedBy.at`）而不是 `Date.now()`：两者在手感上同一毫秒，
   * 但用它算出来的 `lived_ms` 与「掉落 → 入包」的真实间隔严格一致，不会因为一拍延迟差几毫秒。
   */
  private recordOf(entity: DropEntity, result: DropRecordResult, detail?: DropOverflowSource): DropRecordInsert {
    const resolvedAt = entity.pickedBy?.at ?? Date.now();
    return {
      drop_id: entity.dropId,
      zone_id: entity.zoneId,
      map_id: entity.mapId,
      good_id: entity.goodId,
      good_type: itemTypeOf(entity.goodId),
      good_label: entity.goodLabel,
      count: entity.count,
      bound: entity.bound ? 1 : 0,
      monster_key: entity.source.monsterKey,
      monster_label: entity.source.label,
      monster_instance_id: entity.source.instanceId,
      owner_account_id: entity.owner.accountId,
      owner_role_id: entity.owner.roleId,
      owner_name: entity.owner.name,
      result,
      reason: detail ?? null,
      picked_account_id: entity.pickedBy?.accountId ?? null,
      picked_role_id: entity.pickedBy?.roleId ?? null,
      picked_name: entity.pickedBy?.name ?? null,
      created_at: entity.createdAt,
      resolved_at: resolvedAt,
      lived_ms: resolvedAt - entity.createdAt,
    };
  }

  /**
   * 投影行 → 流水行（只给重启清场用：那批实体已经不在内存里了，只剩库里的行）
   *
   * 少了两样东西，都是**内存里才有的**：`goodLabel`（按当前配置现查，取不到回落 `good_id`）、
   * 拾取人（`restart_lost` 本来就没被谁捡走）。所以这一支永远写 `picked_*` 为 null。
   */
  private recordOfRow(row: WorldDropRow, now: number): DropRecordInsert {
    return {
      drop_id: row.drop_id,
      zone_id: row.zone_id,
      map_id: row.map_id,
      good_id: row.good_id,
      good_type: itemTypeOf(row.good_id),
      good_label: itemLabelOf(row.good_id) ?? row.good_id,
      count: row.count,
      bound: row.bound,
      monster_key: row.monster_key,
      monster_label: row.monster_label,
      monster_instance_id: row.monster_instance_id,
      owner_account_id: row.owner_account_id,
      owner_role_id: row.owner_role_id,
      owner_name: row.owner_name,
      result: DROP_RESULT.RESTART_LOST,
      reason: null,
      picked_account_id: null,
      picked_role_id: null,
      picked_name: null,
      created_at: row.created_at,
      resolved_at: now,
      lived_ms: Math.max(0, now - row.created_at),
    };
  }

  private snapshotOfEntity(entity: DropEntity, now: number): RealtimeDropSnapshot {
    return {
      dropId: entity.dropId,
      goodId: entity.goodId,
      count: entity.count,
      bound: entity.bound,
      // 落点一律整像素（entity 里已经是整数，这里再取整只是防以后有人改成浮点算法）
      x: Math.round(entity.x),
      y: Math.round(entity.y),
      ownerName: entity.owner.name,
      ownerAccountId: entity.owner.accountId,
      // 归属小头像（#804）：两样都齐才下发 —— 缺一样客户端就画不出图，不如让它只留前缀
      ...(entity.owner.occupation && entity.owner.sex
        ? { ownerClass: entity.owner.occupation, ownerSex: entity.owner.sex }
        : {}),
      // 同队可捡的预判依据（#804）：只在下发有队伍时给，空串（无队伍）不占字段
      ...(entity.partyId ? { partyId: entity.partyId } : {}),
      protectUntil: entity.protectUntil,
      expireAt: entity.expireAt,
      expireInMs: Math.max(0, entity.expireAt - now),
      protectInMs: Math.max(0, entity.protectUntil - now),
    };
  }

  private queueSpawn(entity: DropEntity): void {
    const key = legacyWorldKey(entity.zoneId, entity.mapId);
    const list = this.pendingSpawn.get(key);
    if (list) list.push(entity);
    else this.pendingSpawn.set(key, [entity]);
  }

  private queueRemove(entity: DropEntity, reason: DropRemoveReason): void {
    const key = `${legacyWorldKey(entity.zoneId, entity.mapId)}|${reason}`;
    const existing = this.pendingRemove.get(key);
    if (existing) {
      existing.ids.push(entity.dropId);
      return;
    }
    this.pendingRemove.set(key, {
      zoneId: entity.zoneId,
      mapId: entity.mapId,
      ids: [entity.dropId],
      reason,
      ...(reason === "picked" && entity.pickedBy ? { byName: entity.pickedBy.name } : {}),
    });
  }

  //#endregion

  //#region 稀有掉落公告（docs/18 §5.12）

  /**
   * boss 掉落 → 全服一条公告（30 秒最多一条）
   *
   * 只对 `tier='boss'` 的怪生效，且本次掉落里**至少有一件非货币物品**（掉一堆金币不该
   * 上全服公告）。抑制按进程内时间戳做 —— 实时进程持有全部 WS 连接，不需要跨进程。
   */
  private maybeAnnounce(input: DropSpawnInput, result: Array<{ dropId: string; goodId: string; count: number }>): void {
    if (!this.announceBoss()) return;
    if (String(input.source.tier) !== "boss") return;
    const items = result.filter((item) => itemTypeOf(item.goodId) !== "money").slice(0, 3);
    if (items.length === 0) return;
    const now = Date.now();
    if (now - this.announcedAt < ANNOUNCE_MIN_INTERVAL_MS) {
      this.logger.debug(`boss 掉落公告被抑制（30 秒内已播过一条）：${input.owner.name} / ${input.source.label}`);
      return;
    }
    this.announcedAt = now;
    this.onAnnounce?.({
      type: "dropNotice",
      data: {
        killerName: input.owner.name,
        monsterLabel: input.source.label,
        mapId: input.mapId,
        items: items.map((item) => ({ goodId: item.goodId, label: itemLabelOf(item.goodId) ?? item.goodId, count: item.count })),
      },
    });
  }

  //#endregion

  //#region 参数（现读库，改完立即生效）

  private dropParams(): Record<string, unknown> {
    const raw = this.runtimeParams.get()?.drop_params;
    if (!raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /** 读取并夹逼一个数值参数：缺键 / 坏值用默认，越界按范围夹 */
  private numberParam(key: string, fallback: number, min: number, max: number): number {
    const value = Number(this.dropParams()[key]);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  }

  private ttlMs(): number {
    return this.numberParam("ttlMs", DROP_TTL_MS_DEFAULT, 10_000, 300_000);
  }

  /** 保护期不得超过存活时长（否则「永远保护着，然后一起消失」） */
  private protectMs(): number {
    return this.numberParam("protectMs", DROP_PROTECT_MS_DEFAULT, 0, this.ttlMs());
  }

  /**
   * 服务端拾取距离闸（`drop_params.pickAcceptRadius`，#817 起就在用同一个键）
   *
   * **0 = 关闭校验**（排查问题用的开关，与 #817 的老语义一致 —— 别为了「看起来更整齐」
   * 把 0 夹成 40，那会让排查用的开关静默失效）。
   *
   * 与客户端的 `autoPickupRadius`（自动拾取手感）是**两把尺子**，但服务端这一把不能比
   * 自动拾取半径还小 —— 那会让「客户端认为能捡」的动作全部被拒。所以取两者较大值。
   */
  private pickRange(): number {
    const own = this.numberParam("pickAcceptRadius", DROP_PICK_RANGE_DEFAULT, 0, 2_000);
    if (own <= 0) return 0;
    const autoPickup = this.numberParam("autoPickupRadius", 40, 0, 500);
    return Math.max(own, autoPickup);
  }

  private maxGroundPerMap(): number {
    return this.numberParam(
      "maxGroundPerMap",
      DROP_MAX_PER_MAP_DEFAULT,
      DROP_MAX_PER_MAP_RANGE.min,
      DROP_MAX_PER_MAP_RANGE.max,
    );
  }

  private scatterMinDistance(): number {
    return this.numberParam("scatterMinDistance", 52, 1, 500);
  }

  private announceBoss(): boolean {
    const value = this.dropParams().announceBoss;
    return value === undefined ? true : value !== false;
  }

  //#endregion

  //#region 流水保留闸的参数（部署级配置，不是运营参数 —— 改它要重启进程）

  /** 每图保留多少条流水（条数闸；测试把它压小才验得到「超了会裁」） */
  private keepPerMap(): number {
    return this.config.get<number>("dropRecordKeepPerMap") ?? DROP_RECORD_KEEP_PER_MAP_DEFAULT;
  }

  /** 攒够多少条新流水才裁一次（每写一条就 DELETE 会让 WAL 白涨） */
  private trimEvery(): number {
    const value = this.config.get<number>("dropRecordTrimEvery") ?? DROP_RECORD_TRIM_EVERY_DEFAULT;
    // 0 / 负数会让「攒够才裁」退化成「每批都裁」，按 1 处理（= 每次写都裁，但不至于死循环）
    return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
  }

  /** 天数闸的保留期（天；≤ 0 = 关闭） */
  private retentionDays(): number {
    return this.config.get<number>("dropRecordRetentionDays") ?? DROP_RECORD_RETENTION_DAYS_DEFAULT;
  }

  /** 天数闸的扫描间隔（毫秒；配成 ≤ 0 / 坏值时回落默认 —— 别让它变成每 100ms 扫一次全表） */
  private pruneIntervalMs(): number {
    const value = this.config.get<number>("dropRecordPruneMs") ?? DROP_RECORD_PRUNE_MS_DEFAULT;
    return Number.isFinite(value) && value > 0 ? value : DROP_RECORD_PRUNE_MS_DEFAULT;
  }

  //#endregion

  private nameOfRole(role: { data?: Record<string, unknown> }): string {
    const name = role?.data?.name;
    return typeof name === "string" ? name : "";
  }
}

//#region 类型与常量

/** 一件掉落物（内存权威） */
export interface DropEntity {
  dropId: string;
  zoneId: number;
  mapId: string;
  /** 落点（世界坐标，服务端算好） */
  x: number;
  y: number;
  goodId: string;
  /** 物品显示名（写进流水时冗余存一份：物品日后被删，记录仍要能看懂） */
  goodLabel: string;
  count: number;
  bound: boolean;
  /** 溯源，只有装备有（能力与 #789 一致） */
  from?: { role?: string; monster?: string; at?: number };
  owner: {
    accountId: string;
    roleId: string;
    name: string;
    /** 归属者的职业 / 性别（#804：客户端画归属小头像用；取不到就是 undefined） */
    occupation?: string;
    sex?: string;
  };
  /** 掉落那一刻归属者所在的队伍（null = 无队伍）；保护期判定的依据 */
  partyId: string | null;
  source: { instanceId: string; monsterKey: string; label: string; tier: string };
  createdAt: number;
  expireAt: number;
  protectUntil: number;
  status: DropStatus;
  pickedBy?: { accountId: string; roleId: string; name: string; at: number };
}

/** `ground` 是唯一非终态；其余三个都是终态（写进流水后从内存与投影表删除） */
export type DropStatus = "ground" | "picked" | "expired" | "overflow";
export type DropRemoveReason = Extract<DropStatus, "picked" | "expired" | "overflow">;

/**
 * 写进 `drop_records.result` 的取值（唯一来源是 `common/constants/drop`）
 *
 * 三个内存终态 + `restart_lost`（进程重启时地上还没被捡走的那批）。`ground` 不在里面：
 * 它还没结束，没有「结果」可言。这里只是给本文件一个短名字，枚举值本身不在这里定义。
 */
export type DropRecordResult = DropResult;

/** `overflow` 的来源（`auto` = 超上限挤掉 / `manual_clear` = 管理端清空，#805） */
export type DropOverflowSource = DropOverflowReason;

/** `spawn()` 的输入：结算侧算完经验与掉落之后交给这里 */
export interface DropSpawnInput {
  mapId: string;
  /** 死亡点（世界坐标；散落偏移以它为圆心） */
  x: number;
  y: number;
  owner: { accountId: string; roleId: string; name: string };
  /** 掉落那一刻的队伍（保护期内队友可捡）；没队伍给 null */
  partyId: string | null;
  source: { instanceId: string; monsterKey: string; label: string; tier?: string };
  drops: Array<{ goodId: string; count: number; bound: boolean }>;
}

/** 落库频率（代码常量，不进运行时参数：改它要发版，且没人会去调它） */
const DROP_FLUSH_MS = 100;
const DROP_SWEEP_MS = 1_000;
/** 全服公告的抑制窗口（30 秒最多一条） */
const ANNOUNCE_MIN_INTERVAL_MS = 30_000;

const DROP_TTL_MS_DEFAULT = 180_000;
const DROP_PROTECT_MS_DEFAULT = 30_000;
const DROP_PICK_RANGE_DEFAULT = 120;

/**
 * 掉落流水（`drop_records`）的两道保留闸（#803）
 *
 * 与地图监控事件同一口径、同一取值理由：`keepPerMap` 2000 条 ≈ 一个活跃图几小时到几天的
 * 可追溯窗口；`trimEvery` 200 条攒一批裁一次；天数闸 7 天兜住「这张图从此没人打」的死图
 * —— 条数闸只在写入时触发，没有写入就没有裁剪。
 */
const DROP_RECORD_KEEP_PER_MAP_DEFAULT = 2_000;
const DROP_RECORD_TRIM_EVERY_DEFAULT = 200;
const DROP_RECORD_RETENTION_DAYS_DEFAULT = 7;
/** 天数闸的扫描间隔（6 小时：一天几次全表 DELETE 已经足够，流水不是审计） */
const DROP_RECORD_PRUNE_MS_DEFAULT = 6 * 60 * 60 * 1000;

/**
 * 距离校验里「位置算过期」的窗口（毫秒）
 *
 * 客户端每 250ms 上报一次位置，与 `pick` 同一条连接。超过这个窗口的旧位置按「未知」
 * 处理（**放行**，见 `pick` 第 6 步）：上报被挡住的老客户端不该整片图都捡不起来。
 */
const PICK_POS_STALE_MS = 5_000;

/**
 * 终态实体在内存里多留多久（毫秒）
 *
 * 只为接住「入包成功但 picked 帧丢了」的重发。60 秒已经比任何客户端的重试窗口都长，
 * 再长就只是白占内存（且会让「捡走很久之后再点」得到 alreadyPicked 而不是 unknown_drop，
 * 那种应答反而更让人困惑）。
 */
const RESOLVED_RETENTION_MS = 60_000;

//#endregion
