import { Node, Rect, Size, TiledMap, Vec3 } from "cc";

/**
 * 地图坐标换算（纯函数模块）
 *
 * ## 坐标系（#566 起：原点 = 地图左上角）
 * 地图节点的 UITransform 锚点固定在 **(0, 1)**（见 `GameMap.loadMap`），于是「节点原点」正好落在这张图的
 * 左上角，本地坐标与 Tiled 的原生坐标只差一个 y 方向：
 *
 * | 坐标 | 原点 | x 正向 | y 正向 | 地图占据的范围 |
 * |---|---|---|---|---|
 * | Tiled（TMX 原文 / Tiled 编辑器里看到的） | 左上角 | 向右 | **向下** | `x∈[0,W]` `y∈[0,H]` |
 * | 地图节点本地 / 世界（本工程） | 左上角 | 向右 | **向上** | `x∈[0,W]` `y∈[-H,0]` |
 *
 * 换算因此只有一步 `(x, y) → (x, -y)`：**没有半图偏移**，TMX 里量出来的数值可以直接写进代码，
 * 也能直接和别的 TMX 对坐标（旧口径是「中心为原点」，每接一张新图都要在脑子里减半个地图）。
 *
 * 为什么锚点能决定这件事（引擎 3.8.7 源码）：`tiled-map.ts` 的 `_buildLayerAndGroup()` 把节点
 * contentSize 设成地图像素尺寸后调 `_syncAnchorPoint()`，按 `anchorPoint` 同步每个图层节点的锚点并重设
 * 对象组/图片层位置；装配器 `assembler/simple.ts` 再用 `left = col*tw - w*anchorX`、
 * `bottom = rowY - h*anchorY` 平移顶点。锚点取 (0,1) 即顶点从 `(0, -H)` 铺到 `(W, 0)`。
 *
 * ## 入参一律是 **Tiled 原始坐标**
 * 引擎 `getObjects()` 给出的 y 已被 `TiledObjectGroup._init` 翻转过一次（`y = 地图像素高 - y`），
 * 不能直接喂进来；读取对象组一律走 `TiledObjects`（它取的是 object.offset 里的原始值）。
 */

/** 地图像素尺寸（横向格数 x 单格宽、纵向格数 x 单格高） */
export function getMapPixelSize(map: Node) {
  const tiledMap = map.getComponent(TiledMap);
  const mapSize = tiledMap.getMapSize();
  const tileSize = tiledMap.getTileSize();
  return new Size(mapSize.width * tileSize.width, mapSize.height * tileSize.height);
}

/**
 * 地图在世界里的矩形（Cocos `Rect` 的 x/y 是**左下角**）
 * 地图原点即左上角，所以左下角 = 原点 - (0, 地图像素高)。
 * 小地图底图、地图预览、寻路网格都用它，免得各自再拼一次「半图」的算式。
 */
export function getMapWorldRect(map: Node): Rect {
  const origin = map.getWorldPosition();
  const { width, height } = getMapPixelSize(map);
  return new Rect(origin.x, origin.y - height, width, height);
}

/**
 * Tiled 坐标 -> 地图节点本地坐标
 * 两者原点相同（左上角），只有 y 轴方向相反：`(x, y) -> (x, -y)`
 * @param x Tiled x（自左边缘向右量）
 * @param y Tiled y（自上边缘向下量）
 */
export function getMapPointPosition(x: number, y: number) {
  return new Vec3(x, -y);
}

/**
 * Tiled 坐标 -> 世界坐标
 * 地图节点可能不在世界原点，故在本地坐标上叠加地图节点的世界坐标
 * （地图节点无旋转 / 缩放，本地坐标与世界的差就是一个平移）
 */
export function getMapPointPositionOnWorld(x: number, y: number, map: Node) {
  const mapWorldPosition = map.getWorldPosition();
  const localPosition = getMapPointPosition(x, y);
  return new Vec3(localPosition.x + mapWorldPosition.x, localPosition.y + mapWorldPosition.y);
}

/**
 * Tiled 矩形区域中心 -> 地图节点本地坐标
 * Tiled 矩形的 x/y 是**左上角**，故先取几何中心再按点坐标换算
 * @param x 矩形左上角 x（Tiled 坐标）
 * @param y 矩形左上角 y（Tiled 坐标，y 轴向下）
 * @param width 矩形宽
 * @param height 矩形高
 */
export function getMapRectCenterPosition(x: number, y: number, width: number, height: number) {
  return getMapPointPosition(x + width / 2, y + height / 2);
}

/**
 * Tiled 矩形区域中心 -> 世界坐标
 * 供那些直接吃世界坐标的调用方使用（如按区域刷怪、区域调试显示）
 */
export function getMapRectCenterPositionOnWorld(x: number, y: number, width: number, height: number, map: Node) {
  return getMapPointPositionOnWorld(x + width / 2, y + height / 2, map);
}
