import { Vec3 } from "cc";

// npc接口
export interface NPC {
  // 名称
  label: string;
  // 地址
  src: string;
  // 放大倍率
  scale?: Vec3;
  // 位置
  position?: Vec3;
  // 点击事件
  onClick?: Function;
}

/**
 * NPC 数据条目（configs/npc 的 npcData）
 * id 只做关联（Tiled 对象组里的 id 与它对应），不参与数值计算
 */
export interface NpcData extends NPC {
  /** NPC 编号（唯一） */
  id: string;
}

// 地图编号
export type MapId = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10";

// 地图类型
export enum MapType {
  /** 普通地图 */
  NORMAL = "0",
  /** 等级地图 */
  LEVEL = "1",
  /** 战斗力地图 */
  COMBAT = "2",
  /** 战魂地图 */
  SOUL_OF_WAR = 3,
}

// 地图配置接口
export interface MapConfig {
  // 地图名称
  label: string;
  // 地图地址
  src: string;
  // 地图类型
  type: MapType;
  /** 进入地图所需等级 */
  level: number;
  /** 进入地图所需战斗力 */
  combat: number;
  /** 进入地图所需战魂等级 */
  soulOfWar: number;
}

/**
 * 地图数据条目（configs/map 的 mapData）
 * id 只做关联（Role.onMap / TMX 文件名与它对应），不参与数值计算
 */
export interface MapData extends MapConfig {
  /** 地图编号（唯一） */
  id: MapId;
}
