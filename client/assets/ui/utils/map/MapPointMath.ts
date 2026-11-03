import { Node, Rect, Size, TiledMap } from "cc";

/**
 * 地图坐标换算（纯函数模块）
 *
 * 地图节点的 UITransform 锚点固定 (0,1)，且**恒在世界原点**（`map_layer` 不跟相机走，
 * 只有 UI 层和相机会被 `LayerManager.move` 搬动），于是「节点原点」就是这张图的左上角：
 *
 * | 坐标 | 原点 | y 正向 | 地图占据的范围 |
 * |---|---|---|---|
 * | Tiled（TMX 原文 / Tiled 编辑器里看到的） | 左上角 | **向下** | `x∈[0,W]` `y∈[0,H]` |
 * | 世界（本工程） | 左上角 | 向上 | `x∈[0,W]` `y∈[-H,0]` |
 *
 * 所以**没有半图偏移**：TMX 里量到的数可以直接用，只剩 y 取反（Tiled 向下、引擎向上）。
 * 前提是「地图节点在世界原点」—— 这是整套口径的地基，所以本模块不接收 `map` 参数去叠世界坐标，
 * 也不打算靠运行时再算一遍来兜底：一旦有人移动地图层，这里会整体错位而不是悄悄自我修正。
 *
 * #676 之后这里只剩「整图范围」一件事：Tiled 坐标 → 世界坐标的两个换算函数
 * （`mapPointToWorld` / `mapRectCenterToWorld`）随「读 TMX 对象组」一起下架了 ——
 * 地图文件里已经没有对象组，服务端下发的点位与碰撞盒本来就是世界坐标。
 *
 * 锚点相关的两个引擎坑（少一步就整屏黑 / 偏半图）见 `GameMap.loadMap` 的注释与
 * 技能 `cocos-tiledmap-objectgroup` 的坑 1 / 坑 4。
 */

/** 地图像素尺寸（格数 × 单格尺寸）；只有本模块与需要「整图范围」的调用方用得到 */
function getMapPixelSize(map: Node) {
  const tiledMap = map.getComponent(TiledMap);
  const mapSize = tiledMap.getMapSize();
  const tileSize = tiledMap.getTileSize();
  return new Size(mapSize.width * tileSize.width, mapSize.height * tileSize.height);
}

/**
 * 整张地图的世界矩形（Cocos `Rect` 的 x/y 是**左下角**，原点即左上角 → 左下角 = `(0, -H)`）
 * 小地图底图、地图预览、寻路网格都用它取范围
 */
export function getMapWorldRect(map: Node): Rect {
  const { width, height } = getMapPixelSize(map);
  return new Rect(0, -height, width, height);
}
