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
export type MapId = "0" | "1";

// 地图类型
export enum MapType {
  // 安全
  SAFE = "0",
  // 测试
  TEST = "9999",
}

// 地图配置接口
export interface MapConfig {
  // 地图名称
  label: string;
  // 地图地址
  src: string;
  // 地图类型
  type: MapType;
}
