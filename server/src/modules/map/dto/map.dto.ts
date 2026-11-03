import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsNumber, IsString, Length, Max, Min } from "class-validator";
import {
  MAP_ENTER_LIMITS,
  MAP_LABEL_MAX_LENGTH,
  MAP_TYPE_LABELS,
  MAP_TYPE_VALUES,
  MapTypeValue,
  SPAWN_AREA_LIMITS,
} from "../../../common/constants/map-config";

/**
 * 地图管理的 DTO（#571 只读观测 / #573 玩法配置可改）
 *
 * 地图分两半，**边界就在这两个名字之间**：
 * - **资源本体**（TMX / 底图 / 预览图）在客户端资源包里 —— 服务端一个字段都改不了；
 * - **整理结果**（名称 / 类型 / 进入条件 / 尺寸 / 刷怪区 / 场上怪物）归服务端，管理端可视化地改。
 *
 * 所以这里能写的只有 `SaveMapConfigDto` 那五个字段 —— 没有「新建地图」的入参：
 * 一张图存不存在由客户端的 TMX 决定（行由启动 seed 按资源清单补出来）。
 *
 * 来源分两类，详情里的 `sources` 会把每一块标出来（页面上也是按这个分栏的）：
 * - `config`：客户端资源包（TMX / 底图 / 预览图）—— 服务端一个字段都改不了；
 * - `db`：服务端库表（`maps` 的名称 / 类型 / 进入条件 / 尺寸 / 图层 / 对象组、
 *   `map_spawn_areas` 刷怪区、`world_monsters` 场上实例）。
 *
 * #655 之前还有第三类 `snapshot`（尺寸 / 图层 / 对象组是仓库里的生成快照），
 * 那些列落库之后就没有「代码里的第二份」了 —— 所以现在只剩两类。
 */

/** 图层（只取结构；瓦片数据在客户端，管理端不需要） */
export class MapLayerDto {
  @ApiProperty({ description: "图层名（Tiled 里的图层名，如 ground / wall）" })
  name: string;

  @ApiProperty({ description: "横向格数" })
  width: number;

  @ApiProperty({ description: "纵向格数" })
  height: number;
}

/**
 * 对象组里的一个对象
 *
 * 坐标是 **Tiled 原始口径**（左上角原点、y 向下），与编辑器里看到的一致：
 * 这一块是「对着 Tiled 核对资源内容」用的，不做世界坐标换算。
 */
export class MapObjectDto {
  @ApiProperty({ description: "对象 id（图内唯一）" })
  id: number;

  @ApiProperty({ description: "对象名（如「1号怪物」「复活点」；可空）" })
  name: string;

  @ApiProperty({ description: "对象类（Tiled 的 type / class；空串 = 普通矩形）" })
  klass: string;

  @ApiProperty({ description: "Tiled 坐标 x（左上角原点）" })
  x: number;

  @ApiProperty({ description: "Tiled 坐标 y（左上角原点、y 向下）" })
  y: number;

  @ApiProperty({ description: "矩形宽（点对象为 0）" })
  width: number;

  @ApiProperty({ description: "矩形高（点对象为 0）" })
  height: number;

  @ApiProperty({
    description: "自定义属性原件（刷怪区的 id / min / max 等，键值都是字符串）",
    type: "object",
    additionalProperties: { type: "string" },
  })
  properties: Record<string, string>;
}

/** 一个对象组（monster / npc / collision / 早期 objects） */
export class MapGroupDto {
  @ApiProperty({ description: "对象组名（TMX 里的名字）" })
  name: string;

  @ApiProperty({ description: "组内对象（按 TMX 内的出现顺序）", type: [MapObjectDto] })
  objects: MapObjectDto[];
}

/**
 * 刷怪区越界量（#586）
 *
 * 四个数都是「越出多少」（图内的一侧为 0），不是坐标。分开给四边而不是给一个布尔：
 * 「越界了」只能让人去翻数据，而「右边多了 96」可以直接判断是贴错了图还是口径错了。
 */
export class MapSpawnAreaOverflowDto {
  @ApiProperty({ description: "矩形左边超出图左边界多少（0 = 在图内）" })
  left: number;

  @ApiProperty({ description: "矩形右边超出图右边界多少（0 = 在图内）" })
  right: number;

  @ApiProperty({ description: "矩形上边超出图顶边多少（0 = 在图内；y 轴向上，图的顶边是 y = 0）" })
  top: number;

  @ApiProperty({ description: "矩形下边超出图底边多少（0 = 在图内）" })
  bottom: number;
}

/**
 * 刷怪区（**服务端库表** `map_spawn_areas` 的一行）
 *
 * #667 起这张表由**管理端绘制**写入，TMX 的 `monster` 对象组不再是它的来源
 * （导入工具也不写它了）。所以这里只剩一套坐标：世界坐标。
 *
 * `inBounds` / `overflow` **由服务端按地图尺寸判**（`spawn-area-bounds.util.ts`），
 * 页面只显示结论：运行时刷怪读的是这张表，越界判定必须落在跑得起来的链路上 ——
 * 新建 / 修改时同样是这个判据，越界直接拒（不是告警）。
 */
export class MapSpawnAreaDto {
  @ApiProperty({ description: "行 id（导入顺序，发牌可复现）" })
  id: number;

  @ApiProperty({ description: "区域名（Tiled 对象名）" })
  name: string;

  @ApiProperty({ description: "怪物 key（configs/monster 的关联键）" })
  monsterKey: string;

  @ApiProperty({ description: "怪物名（查不到配置时回落成 key）" })
  monsterLabel: string;

  @ApiProperty({ description: "区域允许的最少怪物数" })
  min: number;

  @ApiProperty({ description: "区域允许的最多怪物数（播种按它展开）" })
  max: number;

  @ApiProperty({ description: "区域中心 x（世界坐标；原点 = 地图左上角）" })
  cx: number;

  @ApiProperty({ description: "区域中心 y（世界坐标；y 轴向上，故为负）" })
  cy: number;

  @ApiProperty({ description: "区域宽" })
  w: number;

  @ApiProperty({ description: "区域高" })
  h: number;

  @ApiProperty({
    description: "是否整体落在图内（世界坐标 `[0, W] × [-H, 0]`，容差 1px）；false = 坐标口径错了或区域摆到了图外",
  })
  inBounds: boolean;

  @ApiProperty({ description: "四边越界量（inBounds 时全 0）", type: MapSpawnAreaOverflowDto })
  overflow: MapSpawnAreaOverflowDto;
}

/**
 * NPC 点位（**服务端库表** `map_npcs` 的一行；#672 起由管理端放置）
 *
 * 与刷怪区同口径：坐标是世界坐标（原点 = 地图左上角、y 轴向上，`cy` 为负），
 * 由服务端按地图尺寸判 `inBounds` —— 管理端只显示结论，不自己再算一遍。
 *
 * `npcId` 关联 `npcs` 表（外观 / 名字 / 点击行为都在那边或客户端），
 * 这张表只管「谁站在哪」。
 */
export class MapNpcDto {
  @ApiProperty({ description: "点位行 id（改 / 删用它定位；换 NPC 时 id 不变）" })
  id: number;

  @ApiProperty({ description: "NPC id（npcs 表主键；客户端据此查外观与点击行为）" })
  npcId: string;

  @ApiProperty({ description: "NPC 名（查不到 npcs 行时回落成 id）" })
  npcLabel: string;

  @ApiProperty({ description: "世界坐标 x（原点 = 地图左上角）" })
  cx: number;

  @ApiProperty({ description: "世界坐标 y（y 轴向上，故为负）" })
  cy: number;

  @ApiProperty({ description: "是否落在图内（`[0, W] × [-H, 0]`，容差 1px）" })
  inBounds: boolean;
}

/** 一个世界坐标点（下发客户端用；字段名就是 `Vec3` 的 x/y） */
export class MapPositionDto {
  @ApiProperty({ description: "世界坐标 x（原点 = 地图左上角）" })
  x: number;

  @ApiProperty({ description: "世界坐标 y（y 轴向上，故为负）" })
  y: number;
}

/**
 * 复活点（**服务端库表** `maps.revive_cx/cy`；#672 起由管理端点选）
 *
 * 管理端这一份用 `cx/cy`（与刷怪区、NPC 点位同一套字段名）；下发客户端那一份是
 * `MapPositionDto`（`x/y`，直接塞 `Vec3`）—— 两份字段名不同是刻意的：改名字的那次提交
 * 会同时改到两端，而「谁在哪一边」不用猜。
 */
export class MapRevivePointDto {
  @ApiProperty({ description: "世界坐标 x（原点 = 地图左上角）" })
  cx: number;

  @ApiProperty({ description: "世界坐标 y（y 轴向上，故为负）" })
  cy: number;

  @ApiProperty({ description: "是否落在图内（`[0, W] × [-H, 0]`，容差 1px）" })
  inBounds: boolean;
}

/**
 * 新建 / 修改一个 NPC 点位
 *
 * 整份提交（`npcId` + 坐标）：换 NPC 与挪位置在页面上是同一次动作，分字段更新只会留下
 * 「NPC 换了、坐标还是旧的」这种半成品。`npcId` 可以不等于原来的 —— 那就是换人，
 * service 会按「同图同 NPC 唯一」重新查重。
 */
export class SaveMapNpcDto {
  @ApiProperty({ description: "NPC id（必须在 npcs 表里存在）", example: "0002" })
  @IsString({ message: "NPC id 必须是字符串" })
  @Length(1, 64, { message: "NPC id 不能为空" })
  npcId: string;

  @ApiProperty({ description: "世界坐标 x（原点 = 地图左上角）" })
  @Type(() => Number)
  @IsNumber({}, { message: "cx 必须是数字" })
  cx: number;

  @ApiProperty({ description: "世界坐标 y（y 轴向上，故为负）" })
  @Type(() => Number)
  @IsNumber({}, { message: "cy 必须是数字" })
  cy: number;
}

/** 设 / 挪复活点（每张图只有一个，`PUT` 即覆盖） */
export class SaveRevivePointDto {
  @ApiProperty({ description: "世界坐标 x（原点 = 地图左上角）" })
  @Type(() => Number)
  @IsNumber({}, { message: "cx 必须是数字" })
  cx: number;

  @ApiProperty({ description: "世界坐标 y（y 轴向上，故为负）" })
  @Type(() => Number)
  @IsNumber({}, { message: "cy 必须是数字" })
  cy: number;
}

/** 删除 NPC 点位的结果（不留 204 空响应：前端要拿到 id 才能从本地列表里摘掉那一行） */
export class MapNpcDeletedDto {
  @ApiProperty({ description: "恒为 true（失败会抛 404，不会有 false）" })
  deleted: boolean;

  @ApiProperty({ description: "被删掉的点位行 id" })
  id: number;
}

/** 清掉复活点的结果 */
export class MapRevivePointClearedDto {
  @ApiProperty({ description: "恒为 true（本来就没有复活点时也返回 true —— 清空是幂等的）" })
  cleared: boolean;
}

/**
 * 刷怪区中心点（**下发客户端用**）
 *
 * 客户端只需要「在哪画一个「怪物区域名」标签」，所以只给怪物 key 与中心点，
 * 不给尺寸与数量 —— 少发的字段不会漂，多发的字段迟早有人拿去当判据。
 */
export class MapSpawnAreaPointDto {
  @ApiProperty({ description: "怪物 key（客户端据此查名字与动画）" })
  monsterKey: string;

  @ApiProperty({ description: "区域中心 x（世界坐标）" })
  cx: number;

  @ApiProperty({ description: "区域中心 y（世界坐标，为负）" })
  cy: number;
}

/** NPC 点位（下发客户端用：只有「谁」和「在哪」） */
export class MapNpcPointDto {
  @ApiProperty({ description: "NPC id（npcs 表主键）" })
  npcId: string;

  @ApiProperty({ description: "世界坐标 x" })
  x: number;

  @ApiProperty({ description: "世界坐标 y（为负）" })
  y: number;
}

/** 场上怪物汇总（按区；**服务端库表** `world_monsters`） */
export class MapWorldMonsterDto {
  @ApiProperty({ description: "区服 id" })
  zoneId: number;

  @ApiProperty({ description: "该区这张图的实例总数" })
  total: number;

  @ApiProperty({ description: "其中存活只数" })
  alive: number;
}

/**
 * 一块数据的来源
 *
 * 页面按它渲染徽标 —— 「这个数字是谁的」不能只写在文档里，接口自己要说清楚，
 * 否则下一页界面又会把客户端资源当成服务端数据。
 */
export class MapSourceDto {
  @ApiProperty({ description: "对应的字段块（layers / groups / spawnAreas / worldMonsters / config / size）" })
  section: string;

  @ApiProperty({ description: "给人看的名字" })
  label: string;

  @ApiProperty({ description: "来源类别：config 客户端资源 / db 服务端库表" })
  origin: "config" | "db";

  @ApiProperty({ description: "具体文件路径（config）或表名（db）" })
  ref: string;

  @ApiProperty({ description: "一句话说明这块能不能改、改了怎么生效" })
  note: string;
}

/** 列表里的一行 */
export class MapSummaryDto {
  @ApiProperty({ description: "地图 id（= resources/map 下的目录名，也是角色 onMap 存的值）" })
  id: string;

  @ApiProperty({ description: "地图名" })
  label: string;

  @ApiProperty({ description: "类型码（0 安全 / 1 等级 / 2 战斗力 / 3 战魂）" })
  type: string;

  @ApiProperty({ description: "类型名（安全地图 / 等级地图 / 战斗力地图 / 战魂地图）" })
  typeLabel: string;

  @ApiProperty({ description: "进入所需等级（0 = 不限）" })
  level: number;

  @ApiProperty({ description: "进入所需战斗力（0 = 不限）" })
  combat: number;

  @ApiProperty({ description: "进入所需战魂阶（0 = 不限）" })
  soulOfWar: number;

  @ApiProperty({ description: "客户端资源路径（如 map/0/0）" })
  src: string;

  @ApiProperty({ description: "横向格数" })
  cols: number;

  @ApiProperty({ description: "纵向格数" })
  rows: number;

  @ApiProperty({ description: "单格宽（像素）" })
  tileWidth: number;

  @ApiProperty({ description: "单格高（像素）" })
  tileHeight: number;

  @ApiProperty({ description: "地图像素宽" })
  width: number;

  @ApiProperty({ description: "地图像素高" })
  height: number;

  @ApiProperty({ description: "图层数" })
  layerCount: number;

  @ApiProperty({ description: "NPC 对象数（**客户端资源对照**：TMX npc 组里 klass=npc 的对象，不再有消费方）" })
  npcCount: number;

  @ApiProperty({ description: "服务端 NPC 点位数（map_npcs；#672 起点位归后台）" })
  npcPointCount: number;

  @ApiProperty({ description: "服务端是否设了复活点（maps.revive_cx/cy 非空）" })
  hasRevivePoint: boolean;

  @ApiProperty({ description: "刷怪区对象数（客户端资源 monster 组的矩形数）" })
  monsterAreaCount: number;

  @ApiProperty({ description: "碰撞矩形数（客户端资源 collision 组的对象数）" })
  collisionCount: number;

  @ApiProperty({ description: "复活点数（**客户端资源对照**：TMX 里 klass=revive 的对象，不再有消费方）" })
  reviveCount: number;

  @ApiProperty({ description: "服务端刷怪区行数（map_spawn_areas）" })
  spawnAreaCount: number;

  @ApiProperty({ description: "服务端场上怪物实例数（world_monsters，全部区合计）" })
  worldMonsterCount: number;
}

/**
 * 地图玩法配置的精简行（**下发客户端的那一份**）
 *
 * 与 `MapSummaryDto` 的区别只有「不带计数与尺寸」：客户端进游戏需要的是「这张图叫什么、
 * 属于哪一类、进去要什么条件」，TMX 里的对象数它自己就能数。少发的字段不会漂，
 * 多发的字段迟早有人拿去当判据。
 *
 * #672 起多带三样**点位**（NPC / 复活点 / 刷怪区中心）：这三样以前客户端是从 TMX 的
 * 对象组里读的，现在归后台了 —— 客户端不再有任何「问你 TMX 在哪」的路径。
 */
export class MapConfigDto {
  @ApiProperty({ description: "地图 id（= 角色 onMap 存的值 = resources/map 下的目录名）" })
  id: string;

  @ApiProperty({ description: "地图名" })
  label: string;

  @ApiProperty({ description: "类型码（0 安全 / 1 等级 / 2 战斗力 / 3 战魂）" })
  type: string;

  @ApiProperty({ description: "类型名" })
  typeLabel: string;

  @ApiProperty({ description: "进入所需等级（0 = 不限）" })
  level: number;

  @ApiProperty({ description: "进入所需战斗力（0 = 不限）" })
  combat: number;

  @ApiProperty({ description: "进入所需战魂阶（0 = 不限）" })
  soulOfWar: number;

  @ApiProperty({
    description: "NPC 点位（#672 起由后台放置；坐标已是世界坐标，客户端直接摆节点）",
    type: [MapNpcPointDto],
  })
  npcs: MapNpcPointDto[];

  @ApiProperty({
    description: "复活点（null = 这张图没有复活点：客户端不进图定位、不回点复活）",
    type: MapPositionDto,
    nullable: true,
  })
  revive: MapPositionDto | null;

  @ApiProperty({
    description: "刷怪区中心点（只给「在哪画怪物区域名标签」，尺寸与数量不下发）",
    type: [MapSpawnAreaPointDto],
  })
  spawnAreas: MapSpawnAreaPointDto[];
}

/** 地图类型分组（顺序 = 传送弹窗的分组顺序；文案的唯一来源在服务端） */
export class MapTypeGroupDto {
  @ApiProperty({ description: "类型码" })
  type: string;

  @ApiProperty({ description: "类型名（安全地图 / 等级地图 / 战斗力地图 / 战魂地图）" })
  label: string;
}

/** 地图列表（全部图，不分页） */
export class MapListDto {
  @ApiProperty({ description: "地图总数" })
  total: number;

  @ApiProperty({ description: "地图列表（按 id 数字升序）", type: [MapSummaryDto] })
  list: MapSummaryDto[];

  @ApiProperty({
    description: "全部地图类型（管理端编辑下拉用；含当前没有地图使用的类型，顺序即传送弹窗分组顺序）",
    type: [MapTypeGroupDto],
  })
  types: MapTypeGroupDto[];
}

/** 地图详情：列表字段 + 图层 / 对象组 / 刷怪区 / 场上怪物 / 来源说明 */
export class MapDetailDto extends MapSummaryDto {
  @ApiProperty({ description: "图层（服务端生成快照，源自 TMX）", type: [MapLayerDto] })
  layers: MapLayerDto[];

  @ApiProperty({ description: "对象组（Tiled 原始坐标，服务端生成快照）", type: [MapGroupDto] })
  groups: MapGroupDto[];

  @ApiProperty({ description: "刷怪区（服务端库表，世界坐标）", type: [MapSpawnAreaDto] })
  spawnAreas: MapSpawnAreaDto[];

  @ApiProperty({ description: "NPC 点位（服务端库表，世界坐标）", type: [MapNpcDto] })
  npcPoints: MapNpcDto[];

  @ApiProperty({
    description: "复活点（服务端库表；null = 这张图没有复活点）",
    type: MapRevivePointDto,
    nullable: true,
  })
  revivePoint: MapRevivePointDto | null;

  @ApiProperty({ description: "场上怪物（按区分组；进程未启动过世界时为空）", type: [MapWorldMonsterDto] })
  worldMonsters: MapWorldMonsterDto[];

  @ApiProperty({ description: "每一块数据的来源（页面按它渲染徽标）", type: [MapSourceDto] })
  sources: MapSourceDto[];
}

/**
 * 保存一张图的玩法配置（**整份覆盖**这五个字段）
 *
 * 为什么是整份而不是部分更新：这五项在页面上是一张表单、一次提交，
 * 分字段更新只会让「两个管理员同时开两个标签页」变成互相覆盖一半 —— 整份提交至少是
 * 最后一次写入说了算，页面刷新就能看出来。
 *
 * 名称之外的四个字段都允许 0：**0 = 不限制**（安全地图就是「等级 0 / 战力 0 / 战魂 0」，
 * 而不是「等级 1」—— 后者会把 1 级新号挡在新手村外面）。
 */
export class SaveMapConfigDto {
  @ApiProperty({ description: "地图名称（显示在传送弹窗 / 小地图 / 公告里）", maxLength: MAP_LABEL_MAX_LENGTH })
  @IsString({ message: "地图名称必须是字符串" })
  @Length(1, MAP_LABEL_MAX_LENGTH, { message: `地图名称不能为空且不超过 ${MAP_LABEL_MAX_LENGTH} 个字` })
  label: string;

  @ApiProperty({
    description: `地图类型（${MAP_TYPE_VALUES.map((type) => `${type} ${MAP_TYPE_LABELS[type as MapTypeValue]}`).join(" / ")}）`,
    enum: MAP_TYPE_VALUES,
  })
  @IsIn(MAP_TYPE_VALUES, { message: `地图类型只能是 ${MAP_TYPE_VALUES.join(" / ")}` })
  type: string;

  @ApiProperty({
    description: "进入所需等级（0 = 不限）",
    minimum: MAP_ENTER_LIMITS.level.min,
    maximum: MAP_ENTER_LIMITS.level.max,
  })
  @IsInt({ message: "进入等级必须是整数" })
  @Min(MAP_ENTER_LIMITS.level.min, { message: `进入等级不能小于 ${MAP_ENTER_LIMITS.level.min}` })
  @Max(MAP_ENTER_LIMITS.level.max, { message: `进入等级不能大于 ${MAP_ENTER_LIMITS.level.max}` })
  level: number;

  @ApiProperty({
    description: "进入所需战斗力（0 = 不限）",
    minimum: MAP_ENTER_LIMITS.combat.min,
    maximum: MAP_ENTER_LIMITS.combat.max,
  })
  @IsInt({ message: "进入战斗力必须是整数" })
  @Min(MAP_ENTER_LIMITS.combat.min, { message: `进入战斗力不能小于 ${MAP_ENTER_LIMITS.combat.min}` })
  @Max(MAP_ENTER_LIMITS.combat.max, { message: `进入战斗力不能大于 ${MAP_ENTER_LIMITS.combat.max}` })
  combat: number;

  @ApiProperty({
    description: "进入所需战魂阶（0 = 不限）",
    minimum: MAP_ENTER_LIMITS.soulOfWar.min,
    maximum: MAP_ENTER_LIMITS.soulOfWar.max,
  })
  @IsInt({ message: "进入战魂阶必须是整数" })
  @Min(MAP_ENTER_LIMITS.soulOfWar.min, { message: `进入战魂阶不能小于 ${MAP_ENTER_LIMITS.soulOfWar.min}` })
  @Max(MAP_ENTER_LIMITS.soulOfWar.max, { message: `进入战魂阶不能大于 ${MAP_ENTER_LIMITS.soulOfWar.max}` })
  soulOfWar: number;
}

/**
 * 新建 / 修改一个刷怪区（#667：后台直接画）
 *
 * ## 为什么入参是世界坐标，不是 Tiled 矩形
 *
 * 写进来的东西和读出去的东西必须同构：`MapSpawnAreaDto` 给的是 `cx/cy/w/h`（世界坐标），
 * 表里存的也是这四列。如果入参换一套口径（Tiled 左上角），那服务里就要多一次换算，
 * 而管理端读回来还得再换一次 —— 两处换算、两处可能错，而且 e2e 无法直接对照「写了什么、读到什么」。
 *
 * 管理端画布本来就是 Tiled 口径（底图坐标），它负责换算：
 * `cx = x + w/2`、`cy = -(y + h/2)`（#566 后的口径，没有半图偏移）。
 *
 * ## `count` 为什么只有一个数
 *
 * 表里是 `min` / `max` 两列，但播种一直只按 `max` 展开、`min` 从没被读过（留给将来的
 * 「维持最少 N 只」）。表单上摆两个数字只会让人问「min 填了为什么没反应」，
 * 所以接口只收 `count`，落库时 `min = max = count` —— 想用 min 时再加字段，不提前占位。
 */
export class SaveSpawnAreaDto {
  @ApiProperty({
    description: `区域名（同一张图内唯一，运营自己起，如「1号刷怪区」）`,
    minLength: SPAWN_AREA_LIMITS.name.min,
    maxLength: SPAWN_AREA_LIMITS.name.max,
  })
  @IsString({ message: "区域名必须是字符串" })
  @Length(SPAWN_AREA_LIMITS.name.min, SPAWN_AREA_LIMITS.name.max, {
    message: `区域名不能为空且不超过 ${SPAWN_AREA_LIMITS.name.max} 个字`,
  })
  name: string;

  @ApiProperty({ description: "怪物 key（monsters 表的 id，必须存在）", example: "1" })
  @IsString({ message: "怪物 key 必须是字符串" })
  @Length(1, 64, { message: "怪物 key 不能为空" })
  monsterKey: string;

  @ApiProperty({
    description: "这一区维持多少只（1~200，播种按它展开）",
    minimum: SPAWN_AREA_LIMITS.count.min,
    maximum: SPAWN_AREA_LIMITS.count.max,
  })
  @Type(() => Number)
  @IsInt({ message: "数量必须是整数" })
  @Min(SPAWN_AREA_LIMITS.count.min, { message: `数量不能小于 ${SPAWN_AREA_LIMITS.count.min}` })
  @Max(SPAWN_AREA_LIMITS.count.max, { message: `数量不能大于 ${SPAWN_AREA_LIMITS.count.max}` })
  count: number;

  @ApiProperty({ description: "区域中心 x（世界坐标；原点 = 地图左上角）" })
  @Type(() => Number)
  @IsNumber({}, { message: "cx 必须是数字" })
  cx: number;

  @ApiProperty({ description: "区域中心 y（世界坐标；y 轴向上，故为负）" })
  @Type(() => Number)
  @IsNumber({}, { message: "cy 必须是数字" })
  cy: number;

  @ApiProperty({ description: `区域宽（像素，至少 ${SPAWN_AREA_LIMITS.minSize}）` })
  @Type(() => Number)
  @IsNumber({}, { message: "区域宽必须是数字" })
  w: number;

  @ApiProperty({ description: `区域高（像素，至少 ${SPAWN_AREA_LIMITS.minSize}）` })
  @Type(() => Number)
  @IsNumber({}, { message: "区域高必须是数字" })
  h: number;
}

/** 删除刷怪区的结果（不留 204 空响应：前端要拿到 id 才能从本地列表里摘掉那一行） */
export class MapSpawnAreaDeletedDto {
  @ApiProperty({ description: "恒为 true（失败会抛 404，不会有 false）" })
  deleted: boolean;

  @ApiProperty({ description: "被删掉的行 id" })
  id: number;
}
