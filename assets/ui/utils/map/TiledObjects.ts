import { Node, TiledMap } from "cc";

/**
 * Tiled 对象组读取（纯函数模块）
 * 把 TiledMap 对象组的原始记录收敛成统一的 TiledObject（坐标保持 Tiled 原样：
 * 原点在地图左上角、y 轴向下，换算交给 MapPointMath），并对"地图没画该对象组"做空安全处理
 */

/** Tiled 对象（只保留地图生成器用到的字段） */
export interface TiledObject {
  /** 对象名称（Tiled 里给点位起的名字） */
  name: string;
  /** 对象 x（Tiled 坐标） */
  x: number;
  /** 对象 y（Tiled 坐标，y 轴向下） */
  y: number;
  /** 对象宽（点对象为 0） */
  width: number;
  /** 对象高（点对象为 0） */
  height: number;
  /** 自定义属性（Tiled 里给对象加的 properties） */
  properties: Record<string, unknown>;
}

/**
 * 读取 TiledMap 对象组中的全部对象
 * 地图没有画该对象组时返回空数组，调用方不必自行判空
 * @param map 地图节点（自身挂有 TiledMap 组件）
 * @param groupName 对象组名称
 */
export function getTiledObjects(map: Node, groupName: string): TiledObject[] {
  const group = map.getComponent(TiledMap).getObjectGroup(groupName);
  if (!group) return [];
  return group.getObjects().map((object) => ({
    name: object.name ?? "",
    x: object.x,
    y: object.y,
    width: object.width ?? 0,
    height: object.height ?? 0,
    properties: (object.properties ?? {}) as Record<string, unknown>,
  }));
}

/**
 * 读取多个候选对象组中第一个有内容的组（兼容同名不同叫法的地图）
 * 从前往后取第一个非空结果，全部为空时返回空数组
 */
export function getTiledObjectsFrom(map: Node, ...groupNames: string[]): TiledObject[] {
  for (const groupName of groupNames) {
    const objects = getTiledObjects(map, groupName);
    if (objects.length) return objects;
  }
  return [];
}
