/** @generated 由 tools/import-spawn-areas.cjs 从客户端 Tiled 地图（client/assets/resources/map）的 <map> 头生成，勿手改
 *  世界坐标口径（#566）：地图节点原点 = 地图左上角，y 轴向上 ⇒ 地图在世界里占
 *  x ∈ [0, width]、y ∈ [-height, 0]。
 */
export interface MapPixelSize {
  /** 横向格数 */
  cols: number;
  /** 纵向格数 */
  rows: number;
  /** 单格宽（像素） */
  tileWidth: number;
  /** 单格高（像素） */
  tileHeight: number;
  /** 地图像素宽（cols × tileWidth） */
  width: number;
  /** 地图像素高（rows × tileHeight） */
  height: number;
}

/** mapId → 地图像素尺寸 */
export const MAP_PIXEL_SIZES: Record<string, MapPixelSize> = {
  "0": { cols: 64, rows: 64, tileWidth: 128, tileHeight: 128, width: 8192, height: 8192 },
  "1": { cols: 64, rows: 64, tileWidth: 128, tileHeight: 128, width: 8192, height: 8192 },
  "2": { cols: 64, rows: 64, tileWidth: 128, tileHeight: 128, width: 8192, height: 8192 },
  "3": { cols: 64, rows: 64, tileWidth: 128, tileHeight: 128, width: 8192, height: 8192 },
  "4": { cols: 64, rows: 64, tileWidth: 128, tileHeight: 128, width: 8192, height: 8192 },
  "5": { cols: 64, rows: 64, tileWidth: 128, tileHeight: 128, width: 8192, height: 8192 },
  "6": { cols: 64, rows: 64, tileWidth: 128, tileHeight: 128, width: 8192, height: 8192 },
  "7": { cols: 64, rows: 64, tileWidth: 128, tileHeight: 128, width: 8192, height: 8192 },
  "8": { cols: 64, rows: 64, tileWidth: 128, tileHeight: 128, width: 8192, height: 8192 },
  "9": { cols: 64, rows: 64, tileWidth: 128, tileHeight: 128, width: 8192, height: 8192 },
  "10": { cols: 64, rows: 64, tileWidth: 128, tileHeight: 128, width: 8192, height: 8192 },
};
