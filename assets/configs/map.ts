import { MapConfig, MapId, MapType } from "../types/map";

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

export const maps = new Map<MapId, MapConfig>();

maps.set("0", { label: "第一大陆", src: "map/0", type: MapType.NORMAL, level: 0, combat: 0, soulOfWar: 0 });
maps.set("1", { label: "新手地图", src: "map/1", type: MapType.LEVEL, level: 0, combat: 0, soulOfWar: 0 });
maps.set("2", { label: "10级地图", src: "map/2", type: MapType.LEVEL, level: 10, combat: 0, soulOfWar: 0 });

/** 地图类型分组（传送官弹窗按此顺序分组展示；新增类型或调整顺序/标题只需改这里） */
export const mapTypeGroups: Array<{ type: MapType; label: string }> = [
  { type: MapType.NORMAL, label: "普通地图" },
  { type: MapType.LEVEL, label: "等级地图" },
  { type: MapType.COMBAT, label: "战斗力地图" },
  { type: MapType.SOUL_OF_WAR, label: "战魂地图" },
];
