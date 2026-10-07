import { MapConfig, MapData, MapId, MapType } from "../types/map";

/** Tiled 对象组名称（地图文件与游戏代码之间的约定，改名只需改这里） */
export const tiledGroupNames = {
  /** NPC 与复活点 */
  npc: "npc",
  /** 兼容早期地图：NPC 与复活点画在 objects 组 */
  legacyObjects: "objects",
  /** 刷怪区域 */
  monster: "monster",
  /** 碰撞区域 */
  collision: "collision",
};

/** Tiled 对象的自定义属性名（地图文件与游戏代码之间的约定） */
export const tiledPropertyNames = {
  /** 编号（NPC 编号 / 怪物编号） */
  id: "id",
  /** 刷怪区域允许的最少怪物数 */
  min: "min",
  /** 刷怪区域允许的最多怪物数 */
  max: "max",
};

/** Tiled 对象的对象类取值（对象标签上的 class/type） */
export const tiledObjectClasses = {
  /** NPC（有外观点位） */
  npc: "npc",
  /** 复活点（只是坐标，没有外观） */
  revive: "revive",
};

/**
 * 地图数据表
 * id 只做关联（Role.onMap / resources/map/<id> 与它对应），不参与数值计算。
 * 想新增地图就往 mapData 里加一条（记得同步 MapId 联合类型与 resources/map 目录）。
 */
const mapData: MapData[] = [
  { id: "0", label: "新手村", src: "map/0/0", type: MapType.NORMAL, level: 0, combat: 0, soulOfWar: 0 },
  { id: "1", label: "卧龙城", src: "map/1/1", type: MapType.NORMAL, level: 0, combat: 0, soulOfWar: 0 },
  { id: "2", label: "王城", src: "map/2/2", type: MapType.NORMAL, level: 0, combat: 0, soulOfWar: 0 },
  { id: "3", label: "雪域高原", src: "map/3/3", type: MapType.LEVEL, level: 1, combat: 0, soulOfWar: 0 },
  { id: "4", label: "漠北草原", src: "map/4/4", type: MapType.LEVEL, level: 1, combat: 0, soulOfWar: 0 },
  { id: "5", label: "大漠戈壁", src: "map/5/5", type: MapType.LEVEL, level: 1, combat: 0, soulOfWar: 0 },
  { id: "6", label: "破碎神庙", src: "map/6/6", type: MapType.LEVEL, level: 1, combat: 0, soulOfWar: 0 },
  { id: "7", label: "灼烧之地", src: "map/7/7", type: MapType.LEVEL, level: 1, combat: 0, soulOfWar: 0 },
  { id: "8", label: "石林峡谷", src: "map/8/8", type: MapType.LEVEL, level: 1, combat: 0, soulOfWar: 0 },
  { id: "9", label: "水乡泽国", src: "map/9/9", type: MapType.LEVEL, level: 1, combat: 0, soulOfWar: 0 },
  { id: "10", label: "桃花源溪", src: "map/10/10", type: MapType.LEVEL, level: 1, combat: 0, soulOfWar: 0 },
];

/** 地图配置（id → 配置）：由 mapData 统一构建，消费方照旧 maps.get(id) */
export const maps = new Map<MapId, MapConfig>();
for (const map of mapData) {
  maps.set(map.id, map);
}

/** 地图类型分组（传送官弹窗按此顺序分组展示；新增类型或调整顺序/标题只需改这里） */
export const mapTypeGroups: Array<{ type: MapType; label: string }> = [
  { type: MapType.NORMAL, label: "安全地图" },
  { type: MapType.LEVEL, label: "等级地图" },
  { type: MapType.COMBAT, label: "战斗力地图" },
  { type: MapType.SOUL_OF_WAR, label: "战魂地图" },
];
