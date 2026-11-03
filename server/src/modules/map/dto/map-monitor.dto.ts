import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, Max, Min } from "class-validator";

/**
 * 实时地图监控的 DTO（#665）
 *
 * ## 数据从哪来（页面上会按这个画「新鲜度」）
 *
 * 全部来自实时进程每秒写进库的两张投影表（`map_monitor_state` / `map_monitor_events`）：
 * - `sampledAt` / `updatedAt` / `staleMs` 三个时间戳是**必须**发的 —— 没人在那张图里时
 *   采集器不采样，快照会停在最后一帧。页面据此显示「最后采样 N 秒前」，
 *   而不是把一张十小时前的图当成「现在没人、怪也都不在」；
 * - 事件带自增 `cursor`：页面按 `since` 增量拉，不会每次都把 300 条重画一遍。
 *
 * ## 坐标口径
 *
 * `x` / `y` 全是**世界坐标**（原点 = 地图左上角、y 轴向上，与刷怪区同一套）。
 * 画到图上要 `tiledY = -worldY`，与 `MapCanvas` 里刷怪区的换算完全一致。
 */

/** 掉落物一条（落点 = 击杀点：客户端以死亡坐标为中心铺开，服务端不逐件记坐标） */
export class MapMonitorDropDto {
  @ApiProperty({ description: "物品 id" })
  goodId: string;

  @ApiProperty({ description: "物品名（服务端从表现取；取不到为空串）" })
  label: string;

  @ApiProperty({ description: "数量" })
  count: number;

  @ApiProperty({ description: "落点 x（世界坐标）= 击杀点" })
  x: number;

  @ApiProperty({ description: "落点 y（世界坐标）= 击杀点" })
  y: number;
}

/** 快照里的一只怪 */
export class MapMonitorMonsterDto {
  @ApiProperty({ description: "实例 id（服务端发牌，如 m1_z1_3）" })
  instanceId: string;

  @ApiProperty({ description: "怪物 key（monsters 表主键）" })
  monsterKey: string;

  @ApiProperty({ description: "怪物名" })
  label: string;

  @ApiProperty({ description: "当前 x（世界坐标）：活怪是 AI 模拟位置，死怪是死亡点" })
  x: number;

  @ApiProperty({ description: "当前 y（世界坐标）" })
  y: number;

  @ApiProperty({ description: "当前血量" })
  hp: number;

  @ApiProperty({ description: "血量上限" })
  maxHp: number;

  @ApiProperty({ description: "是否存活（false = 死亡等重生）" })
  alive: boolean;

  @ApiProperty({ description: "距重生还剩多少毫秒（存活时为 null）", type: Number, nullable: true })
  respawnInMs: number | null;

  @ApiProperty({ description: "预定重生时刻（毫秒时间戳；存活时为 null）", type: Number, nullable: true })
  respawnAt: number | null;
}

/** 快照里的一个玩家（位置来自客户端 pos 帧，经服务端最小仲裁） */
export class MapMonitorPlayerDto {
  @ApiProperty({ description: "账号 id" })
  accountId: string;

  @ApiProperty({ description: "角色名（取不到回落账号名）" })
  name: string;

  @ApiProperty({ description: "x（世界坐标）" })
  x: number;

  @ApiProperty({ description: "y（世界坐标）" })
  y: number;

  @ApiProperty({ description: "当前血量" })
  hp: number;

  @ApiProperty({ description: "血量上限" })
  maxHp: number;

  @ApiProperty({ description: "是否在移动" })
  moving: boolean;
}

/**
 * 文字流里的一条
 *
 * `kind` 决定页面上那句话的样子：`kill` 有掉落列表与自己被杀的地点，`respawn` 只有刷新点。
 * 掉落 / 击杀者这两栏在 `respawn` 上是空数组 / 空串（不是缺字段 —— 让前端少一堆可选判断）。
 */
export class MapMonitorEventDto {
  @ApiProperty({ description: "自增 id（即翻页游标）" })
  id: number;

  @ApiProperty({ description: "事件时刻（毫秒时间戳）" })
  at: number;

  @ApiProperty({ description: "事件类型：kill 击杀 / respawn 刷新" })
  kind: "kill" | "respawn";

  @ApiProperty({ description: "怪物实例 id" })
  instanceId: string;

  @ApiProperty({ description: "怪物 key" })
  monsterKey: string;

  @ApiProperty({ description: "怪物名" })
  label: string;

  @ApiProperty({ description: "发生地点 x（世界坐标）：击杀 = 死亡点，刷新 = 出生点" })
  x: number;

  @ApiProperty({ description: "发生地点 y（世界坐标）" })
  y: number;

  @ApiProperty({ description: "击杀者角色名（刷新事件为空串）" })
  killer: string;

  @ApiProperty({ description: "掉落（刷新事件为空数组）", type: [MapMonitorDropDto] })
  drops: MapMonitorDropDto[];

  @ApiProperty({ description: "这只怪下次刷新时刻（毫秒时间戳；刷新事件为 0）" })
  respawnAt: number;
}

/** 一帧监控数据 */
export class MapMonitorDto {
  @ApiProperty({ description: "地图 id" })
  mapId: string;

  @ApiProperty({ description: "地图名" })
  mapLabel: string;

  @ApiProperty({ description: "地图像素宽（画布 viewBox 用）" })
  width: number;

  @ApiProperty({ description: "地图像素高" })
  height: number;

  @ApiProperty({ description: "这一帧是哪个区的世界（同一张图各区各有一份）" })
  zoneId: number;

  @ApiProperty({ description: "这张图有哪些区留下过快照（页面据此切换区）", type: [Number] })
  zones: number[];

  @ApiProperty({ description: "快照采样时刻（毫秒）；null = 这张图从没被采样过", type: Number, nullable: true })
  sampledAt: number | null;

  @ApiProperty({ description: "快照写入时刻（毫秒）；null = 没有快照", type: Number, nullable: true })
  updatedAt: number | null;

  @ApiProperty({ description: "快照距今多少毫秒（null = 没有快照；大 = 那张图没人看，数据已停）", type: Number, nullable: true })
  staleMs: number | null;

  @ApiProperty({ description: "怪物（含死亡等重生的实例）", type: [MapMonitorMonsterDto] })
  monsters: MapMonitorMonsterDto[];

  @ApiProperty({ description: "玩家（同区同图）", type: [MapMonitorPlayerDto] })
  players: MapMonitorPlayerDto[];

  @ApiProperty({ description: "文字事件（按时间升序）", type: [MapMonitorEventDto] })
  events: MapMonitorEventDto[];

  @ApiProperty({ description: "下一次请求带上的游标（本次返回的最大事件 id；没有事件时原样回传 since）" })
  cursor: number;
}

/** 监控查询参数 */
export class MapMonitorQueryDto {
  @ApiProperty({ description: "区服 id（不传 = 用该图最新的那份快照所在区）", required: false })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "区服 id 必须是整数" })
  @Min(1, { message: "区服 id 必须 ≥ 1" })
  zone?: number;

  @ApiProperty({ description: "事件游标：只取 id 大于它的事件（0 / 不传 = 最新若干条）", required: false })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "游标必须是整数" })
  @Min(0, { message: "游标不能为负" })
  since?: number;

  @ApiProperty({ description: "本次最多取多少条事件（默认 60，上限 200）", required: false })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "条数必须是整数" })
  @Min(1, { message: "条数必须 ≥ 1" })
  @Max(200, { message: "条数上限 200（再多就该去查运维日志）" })
  limit?: number;
}
