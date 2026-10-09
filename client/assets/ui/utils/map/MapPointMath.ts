import { Node, Size, TiledMap, Vec3, view } from "cc";

/**
 * 地图坐标换算（纯函数模块）
 * Tiled 的坐标原点在地图左上角且 y 轴向下，地图节点本地坐标以地图中心为原点且 y 轴向上，
 * 本模块负责两者的互转；点、矩形区域、世界坐标三种入口都在这里，调用方不用再自行翻转 y
 */

/** 地图像素尺寸（横向格数 x 单格宽、纵向格数 x 单格高） */
export function getMapPixelSize(map: Node) {
  const tiledMap = map.getComponent(TiledMap);
  const mapSize = tiledMap.getMapSize();
  const tileSize = tiledMap.getTileSize();
  return new Size(mapSize.width * tileSize.width, mapSize.height * tileSize.height);
}

// 获取地图上尺寸偏移
export function getMapOffset(map: TiledMap) {
  const width = map.getMapSize().width * map.getTileSize().width;
  const screenWidth = view.getDesignResolutionSize().width;
  return new Vec3((width - screenWidth) / 2, 0);
}

/**
 * 获取地图上点的世界坐标（Tiled 对象坐标 -> 地图节点本地坐标 -> 世界坐标）
 * 地图节点可能不在原点，故在本地坐标上叠加地图节点的世界坐标
 */
export function getMapPointPositionOnWorld(position: Vec3, map: Node) {
  const mapWorldPosition = map.getWorldPosition();
  const localPosition = getMapPointPosition(position, map);
  return new Vec3(localPosition.x + mapWorldPosition.x, localPosition.y + mapWorldPosition.y);
}

/**
 * 获取地图上点的坐标（Tiled 对象坐标 -> 地图节点本地坐标）
 * Tiled 的对象坐标原点在地图左上角且 y 轴向下，地图节点本地坐标以地图中心为原点且 y 轴向上，
 * 故 x 减去地图半宽、y 用「地图半高 - y」翻转。
 * 入参必须是 **Tiled 原始坐标**：引擎 getObjects() 给出的 y 已被 TiledObjectGroup._init
 * 翻转过一次（y = 地图像素高 - y），直接用会再翻一次造成南北镜像，
 * 所以读取对象组一律走 TiledObjects（它取的是 object.offset 里的原始值）
 */
export function getMapPointPosition(position: Vec3, map: Node) {
  const { width, height } = getMapPixelSize(map);
  return new Vec3(position.x - width / 2, height / 2 - position.y);
}

/**
 * 获取地图上矩形区域中心的坐标（Tiled 矩形 -> 地图节点本地坐标）
 * Tiled 矩形对象的 x/y 是左上角坐标，故先取几何中心再按点坐标换算
 * @param x 矩形左上角 x（Tiled 坐标）
 * @param y 矩形左上角 y（Tiled 坐标，y 轴向下）
 * @param width 矩形宽
 * @param height 矩形高
 */
export function getMapRectCenterPosition(x: number, y: number, width: number, height: number, map: Node) {
  return getMapPointPosition(new Vec3(x + width / 2, y + height / 2), map);
}

/**
 * 获取地图上矩形区域中心的世界坐标（Tiled 矩形 -> 世界坐标）
 * 与 getMapRectCenterPosition 的区别只在于多叠加了地图节点的世界坐标，
 * 供那些直接吃世界坐标的调用方使用（如按区域生成怪物、区域调试显示）
 */
export function getMapRectCenterPositionOnWorld(x: number, y: number, width: number, height: number, map: Node) {
  return getMapPointPositionOnWorld(new Vec3(x + width / 2, y + height / 2), map);
}
