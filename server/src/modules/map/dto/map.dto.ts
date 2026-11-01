import { ApiProperty } from "@nestjs/swagger";

/**
 * 地图管理（#571）的只读 DTO
 *
 * 这个模块**只有读**：地图本体是客户端资源（TMX），服务端存的是对它整理出来的东西
 * （尺寸 / 刷怪区 / 场上怪物），管理端只是把两边摆在一起看。所以这里没有任何
 * `CreateXxx` / `UpdateXxx` 入参 —— 少写一个 DTO 比写一个「永远没人调」的写接口更诚实。
 *
 * 来源分三类，详情里的 `sources` 会把每一块标出来（页面上也是按这个分栏的）：
 * - `config`：客户端配置 `configs/map.ts`（名称 / 类型 / 进入条件 / 资源路径）；
 * - `snapshot`：服务端代码里的生成快照（TMX 尺寸、图层、对象组 —— 随仓库提交，随版本发布）；
 * - `db`：服务端库表（`map_spawn_areas` 刷怪区、`world_monsters` 场上实例）。
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
 * 刷怪区（**服务端库表** `map_spawn_areas` 的一行）
 *
 * 与上面 `groups` 里的 monster 对象不是同一份数据：那一个是 Tiled 原始矩形，
 * 这一个是导入后按世界坐标整理过的区域 —— 管理端两栏并排显示，就是为了让人能核对
 * 「资源里的矩形」和「服务端真正在用的区域」是否对得上。
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

  @ApiProperty({ description: "来源类别：config 客户端配置 / snapshot 服务端生成快照 / db 服务端库表" })
  origin: "config" | "snapshot" | "db";

  @ApiProperty({ description: "具体文件或表名（config / snapshot 给路径，db 给表名）" })
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

  @ApiProperty({ description: "NPC 对象数（客户端资源 npc 组里 klass=npc 的对象）" })
  npcCount: number;

  @ApiProperty({ description: "刷怪区对象数（客户端资源 monster 组的矩形数）" })
  monsterAreaCount: number;

  @ApiProperty({ description: "碰撞矩形数（客户端资源 collision 组的对象数）" })
  collisionCount: number;

  @ApiProperty({ description: "复活点数（客户端资源里 klass=revive 的对象）" })
  reviveCount: number;

  @ApiProperty({ description: "服务端刷怪区行数（map_spawn_areas）" })
  spawnAreaCount: number;

  @ApiProperty({ description: "服务端场上怪物实例数（world_monsters，全部区合计）" })
  worldMonsterCount: number;
}

/** 地图列表（11 张图，不分页） */
export class MapListDto {
  @ApiProperty({ description: "地图总数" })
  total: number;

  @ApiProperty({ description: "地图列表（按 id 数字升序）", type: [MapSummaryDto] })
  list: MapSummaryDto[];
}

/** 地图详情：列表字段 + 图层 / 对象组 / 刷怪区 / 场上怪物 / 来源说明 */
export class MapDetailDto extends MapSummaryDto {
  @ApiProperty({ description: "图层（服务端生成快照，源自 TMX）", type: [MapLayerDto] })
  layers: MapLayerDto[];

  @ApiProperty({ description: "对象组（Tiled 原始坐标，服务端生成快照）", type: [MapGroupDto] })
  groups: MapGroupDto[];

  @ApiProperty({ description: "刷怪区（服务端库表，世界坐标）", type: [MapSpawnAreaDto] })
  spawnAreas: MapSpawnAreaDto[];

  @ApiProperty({ description: "场上怪物（按区分组；进程未启动过世界时为空）", type: [MapWorldMonsterDto] })
  worldMonsters: MapWorldMonsterDto[];

  @ApiProperty({ description: "每一块数据的来源（页面按它渲染徽标）", type: [MapSourceDto] })
  sources: MapSourceDto[];
}
