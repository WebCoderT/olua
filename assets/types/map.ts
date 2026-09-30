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

// 地图编号
export type MapId = "0" | "1" | "2";

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
