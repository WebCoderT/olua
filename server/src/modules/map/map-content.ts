/**
 * 地图内容（`maps.content` 列 JSON 的形状；#655）
 *
 * 这是**客户端资源视图**，不是运营数据：坐标保持 Tiled 原始口径（左上角原点、y 向下），
 * 对象属性原样保留（刷怪区的 id / min / max 等），服务端不在这里解释含义。
 *
 * 以前它是 `shared/map-content.generated.ts` 里的一张大常量（TMX 扫描产物），现在只是
 * `maps` 表一列的 JSON —— 写入方是 `tools/import-map-resources.cjs`，读方是管理端详情页
 * （让人能对着 Tiled 核对「资源里到底有什么」）。
 */
export interface MapLayerInfo {
  /** 图层名（Tiled 里的图层名） */
  name: string;
  /** 横向格数 */
  width: number;
  /** 纵向格数 */
  height: number;
}

export interface MapObjectInfo {
  /** 对象 id（图内唯一，Tiled 的 nextobjectid 序列） */
  id: number;
  /** 对象名（如「1号怪物」「复活点」） */
  name: string;
  /** 对象类（Tiled 的 type / class；空串 = 普通矩形） */
  klass: string;
  /** Tiled 坐标 x（左上角原点，y 向下） */
  x: number;
  /** Tiled 坐标 y（左上角原点，y 向下） */
  y: number;
  /** 矩形宽（点对象为 0） */
  width: number;
  /** 矩形高（点对象为 0） */
  height: number;
  /** 自定义属性（原样：刷怪区的 id / min / max 等） */
  properties: Record<string, string>;
}

export interface MapGroupInfo {
  /** 对象组名（npc / monster / collision / 早期 objects） */
  name: string;
  objects: MapObjectInfo[];
}

export interface MapContent {
  layers: MapLayerInfo[];
  groups: MapGroupInfo[];
}

/** 一条地图行的几何视图（`maps` 表的七列，与 `spawnAreaInBounds` 需要的形状一致） */
export interface MapPixelSize {
  /** 横向格数 */
  cols: number;
  /** 纵向格数 */
  rows: number;
  /** 单格宽（像素） */
  tileWidth: number;
  /** 单格高（像素） */
  tileHeight: number;
  /** 地图像素宽 */
  width: number;
  /** 地图像素高 */
  height: number;
}

/** 空内容（行里的 JSON 坏了 / 老库还没补）—— 让列表页空着，而不是 500 */
export const EMPTY_MAP_CONTENT: MapContent = { layers: [], groups: [] };

/** 空几何（同上）：越界判定会算成「全部越界」，正好把问题暴露在页面上 */
export const EMPTY_MAP_PIXEL_SIZE: MapPixelSize = {
  cols: 0,
  rows: 0,
  tileWidth: 0,
  tileHeight: 0,
  width: 0,
  height: 0,
};
