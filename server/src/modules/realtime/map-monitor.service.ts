import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MapMonitorDrop, MapMonitorEvent, MapMonitorMonster, MapMonitorSnapshot } from "../../common/map-monitor";
import { itemLabelOf } from "../../common/runtime-config-cache";
import { MapMonitorRepository } from "../../database/repositories/map-monitor.repository";
import { MonsterRepository } from "../../database/repositories/monster.repository";
import { WorldMonster, WorldService } from "../world/world.service";
import { MonsterAiService } from "./monster-ai.service";
import { PlayerPresenceService } from "./player-presence.service";

/** 一次击杀要记的东西（结算侧在 `applied.killed` 分支调用） */
export interface KillRecord {
  instanceId: string;
  monsterKey: string;
  /** 怪物显示名（monsters 表的 label） */
  label: string;
  zoneId: number;
  mapId: string;
  /** 死亡点（世界坐标） */
  x: number;
  y: number;
  /** 击杀者角色名（取不到给空串） */
  killer: string;
  /** 掉落结果（goodId + count；位置 = 死亡点） */
  drops: Array<{ goodId: string; count: number }>;
  /** 预定重生时刻（毫秒） */
  respawnAt: number;
}

/**
 * 实时地图监控的采集器（#665）—— 住在**实时进程**，只做「把内存里的世界投影到库里」
 *
 * ## 为什么需要它
 *
 * 管理端要看「这张图现在什么样、刚才发生了什么」，而世界状态（怪物血量 / 存活 /
 * AI 模拟坐标 / 重生时刻）和玩家位置都只活在实时进程内存里。管理端接口在存档进程
 * （3100），两个进程之间只有共享 SQLite 这一条路（同 `monster-ai` 顶部那段）。
 *
 * 所以这里把两件事写进库：
 * - `map_monitor_state`：每秒一帧快照（每区每图一行，覆盖写）；
 * - `map_monitor_events`：一次击杀 / 一次刷新一行（按 (区, 图) 裁到上限）。
 *
 * 它是**运行时的投影，不是权威**：删掉这两张表不影响游戏，重启后第一次采样就会补上。
 *
 * ## 采样的三个口径
 *
 * 1. **只采有人看的图**（`world.viewedMaps()`）：没人看的图没有 AI 在跑、也没有广播对象，
 *    采它等于给空气写库；这类图的监控页会显示「最后采样 N 秒前」，那正是事实；
 * 2. **活怪用 AI 实时坐标，死怪用死亡点**：AI 运行时在击杀时就被清掉（重生要回出生点），
 *    所以死怪的位置取「上一次采到的位置」并留到重生 —— 图上那颗灰色残点因此落在
 *    它真正倒下的地方，而不是出生点；
 * 3. **重生事件靠快照差分**：`processRespawns` 在 world 的 tick 里跑，这里不掺和它的
 *    逻辑，只比较「上一帧还 dead、这一帧 alive」—— 少一条跨模块的因果链。
 *
 * ## 事件不落内存环形缓冲的理由
 *
 * 管理端可能「刚打开页面」：它需要知道**它没看见的那几分钟**发生过什么。内存缓冲对
 * 后来的人等于不存在；行数按图裁剪（默认 300 条）就够看一阵，也不会把库撑大。
 */
@Injectable()
export class MapMonitorService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MapMonitorService.name);
  private timer: NodeJS.Timeout | null = null;

  /** `zone:mapId` → 上一帧的存活表（重生差分用） */
  private readonly aliveBefore = new Map<string, Map<string, boolean>>();
  /** `zone:mapId` → 上次采到的坐标（死怪沿用死亡点，重生时清掉） */
  private readonly lastPosition = new Map<string, Map<string, { x: number; y: number }>>();
  /** `zone:mapId` → 距上次裁剪又新增了几条事件（攒够再删，免得每杀一只都 DELETE） */
  private readonly pendingTrim = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly world: WorldService,
    private readonly monsterAi: MonsterAiService,
    private readonly presence: PlayerPresenceService,
    private readonly monsterConfigs: MonsterRepository,
    private readonly monitor: MapMonitorRepository,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => this.sample(), this.intervalMs()).unref();
    this.logger.log(`实时地图监控采集已启动（每 ${this.intervalMs()}ms 采样一次，事件每图保留 ${this.keep()} 条）`);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  //#region 采样（每秒一帧）

  /** 采一遍「有人看的图」，写出快照 + 差分出的刷新事件 */
  private sample(): void {
    const now = Date.now();
    for (const { zoneId, mapId, monsters } of this.world.viewedMaps()) {
      const key = `${zoneId}:${mapId}`;
      try {
        this.sampleMap(key, zoneId, mapId, monsters, now);
      } catch (error) {
        // 单张图采样失败不该让整轮停摆（下个周期再来）；监控本身不是游戏主链路
        this.logger.warn(`地图 ${mapId}（区 ${zoneId}）采样失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private sampleMap(key: string, zoneId: number, mapId: string, monsters: Map<string, WorldMonster>, now: number): void {
    const before = this.aliveBefore.get(key) ?? new Map<string, boolean>();
    const positions = this.lastPosition.get(key) ?? new Map<string, { x: number; y: number }>();
    const rows: MapMonitorMonster[] = [];
    const respawned: Array<{ monster: WorldMonster; x: number; y: number }> = [];

    for (const monster of monsters.values()) {
      const spot = this.resolveSpot(key, monster, positions);
      // 差分：上一帧还是死的、这一帧活了 = 刚刷新（world 的 tick 只给「刷新了几只」，这里补上是谁）
      if (monster.alive && before.get(monster.instanceId) === false) {
        respawned.push({ monster, x: spot.x, y: spot.y });
      }
      rows.push(this.snapshotOf(monster, spot, now));
    }

    this.aliveBefore.set(key, new Map([...monsters.values()].map((monster) => [monster.instanceId, monster.alive])));

    const snapshot: MapMonitorSnapshot = {
      monsters: rows,
      players: this.presence.playersOn(zoneId, mapId),
      sampledAt: now,
    };
    this.monitor.saveState({ zone_id: zoneId, map_id: mapId, payload: JSON.stringify(snapshot), updated_at: now });

    for (const { monster, x, y } of respawned) {
      this.appendEvent(zoneId, mapId, {
        kind: "respawn",
        at: now,
        instanceId: monster.instanceId,
        monsterKey: monster.monsterKey,
        label: this.labelOf(monster.monsterKey),
        x,
        y,
      });
    }
  }

  /**
   * 一只怪此刻该画在哪
   *
   * - 活着：AI 的模拟坐标（刚播种 / AI 还没跑过 → 退回出生点）；同时记进 `lastPosition`；
   * - 死了：上一次记下的位置（= 它倒下的地方）；没有记录才退回出生点（服务重启后的第一帧）。
   */
  private resolveSpot(
    key: string,
    monster: WorldMonster,
    positions: Map<string, { x: number; y: number }>,
  ): { x: number; y: number } {
    if (monster.alive) {
      const live = this.monsterAi.livePositionOf(monster.instanceId);
      const spot = live ? { x: live.x, y: live.y } : { x: monster.x, y: monster.y };
      positions.set(monster.instanceId, spot);
      this.lastPosition.set(key, positions);
      return spot;
    }
    return positions.get(monster.instanceId) ?? { x: monster.x, y: monster.y };
  }

  /** 实例 → 快照里的一行（死亡中的怪带重生倒计时） */
  private snapshotOf(monster: WorldMonster, spot: { x: number; y: number }, now: number): MapMonitorMonster {
    return {
      instanceId: monster.instanceId,
      monsterKey: monster.monsterKey,
      label: this.labelOf(monster.monsterKey),
      x: spot.x,
      y: spot.y,
      hp: monster.hp,
      maxHp: monster.maxHp,
      alive: monster.alive,
      respawnInMs: monster.alive || monster.respawnAt === null ? null : Math.max(0, monster.respawnAt - now),
      respawnAt: monster.alive ? null : monster.respawnAt,
    };
  }

  //#endregion

  //#region 击杀事件（结算侧调用）

  /**
   * 记一次击杀（含掉落与两个坐标）
   *
   * 由 `CombatSettlementService` 在 `applied.killed` 分支调用 —— 那里是**唯一**知道
   * 「谁打死了哪只怪、掉了什么」的地方（经验 / 掉落都在服务端算）。这里只做一件事：
   * 把它变成管理端能读的一行文字。
   */
  recordKill(record: KillRecord): void {
    const drops: MapMonitorDrop[] = record.drops.map((drop) => ({
      goodId: drop.goodId,
      label: itemLabelOf(drop.goodId) ?? "",
      count: drop.count,
      // 掉落物的落点 = 击杀点：客户端 `DropManager.spawnResults` 以怪物死亡坐标为中心铺开，
      // 服务端不逐件记坐标（那会是「表现层坐标的第二个来源」）
      x: record.x,
      y: record.y,
    }));
    const event: MapMonitorEvent = {
      kind: "kill",
      at: Date.now(),
      instanceId: record.instanceId,
      monsterKey: record.monsterKey,
      label: record.label,
      x: record.x,
      y: record.y,
      killer: record.killer,
      drops,
      respawnAt: record.respawnAt,
    };
    this.appendEvent(record.zoneId, record.mapId, event);
  }

  //#endregion

  //#region 事件写入与裁剪

  private appendEvent(zoneId: number, mapId: string, event: MapMonitorEvent): void {
    this.monitor.appendEvent({
      zone_id: zoneId,
      map_id: mapId,
      at: event.at,
      kind: event.kind,
      payload: JSON.stringify(event),
    });
    const key = `${zoneId}:${mapId}`;
    const pending = (this.pendingTrim.get(key) ?? 0) + 1;
    if (pending < this.trimEvery()) {
      this.pendingTrim.set(key, pending);
      return;
    }
    this.pendingTrim.set(key, 0);
    const removed = this.monitor.trimEvents(zoneId, mapId, this.keep());
    if (removed > 0) this.logger.debug(`地图 ${mapId}（区 ${zoneId}）监控事件裁剪：删掉 ${removed} 条旧记录（保留 ${this.keep()}）`);
  }

  //#endregion

  //#region 配置与小工具

  private labelOf(monsterKey: string): string {
    return this.monsterConfigs.findByKey(monsterKey)?.label ?? monsterKey;
  }

  private intervalMs(): number {
    return this.config.get<number>("mapMonitorMs") ?? 1000;
  }

  private keep(): number {
    return this.config.get<number>("mapMonitorEventKeep") ?? 300;
  }

  /** 攒够多少条新事件才裁剪一次（每杀一只都 DELETE 会让 WAL 白涨） */
  private trimEvery(): number {
    return this.config.get<number>("mapMonitorTrimEvery") ?? 25;
  }

  //#endregion
}
