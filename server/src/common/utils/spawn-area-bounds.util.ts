/**
 * 刷怪区的图内判定（#586：怪物按地图的边界约定处理）
 *
 * ## 口径从哪来
 *
 * #566 定下世界坐标 = **地图左上角为原点、y 轴向上**，所以一张图占的区域是
 * `x ∈ [0, W]`、`y ∈ [-H, 0]`（`W/H` 来自 `MAP_PIXEL_SIZES` 的生成快照，
 * 与 TMX 头一致）。刷怪区是轴对齐矩形，中心 `(cx, cy)` + 尺寸 `w × h`，
 * 四边是 `cx ± w/2` 与 `cy ± h/2` —— 全部落在上面那个矩形里才算「在图内」。
 *
 * ## 为什么这件事必须由服务端算
 *
 * 运行时刷怪读的是 `map_spawn_areas` **表**，不是生成快照；而表只在空库时按快照 seed 一次
 * （`WorldService` 的 `countAll() > 0` 短路）。旧口径时期 seed 过的库会一直用旧值刷怪：
 * `tools/audit-map-origin.cjs` 校验的是快照（绿），游戏里怪却刷在图外。
 * 所以判定要落在**跑得起来的这条链路上**，管理端只显示服务端算出来的结论 ——
 * 两边各算一遍，迟早会出现「页面说在图内、实际刷在图外」。
 *
 * ## 容差 1 像素
 *
 * 导入工具从 TMX 的浮点像素算中心，字段是整数列 —— 取整会让一个刚好贴边的区域
 * 报出 0.5~1 的「越界」。既然后果只是「贴边」而不是「跑到图外」，容差取 1，
 * 与 `tools/audit-map-origin.cjs` 第 6 条同口径（那边校验生成快照，这里校验库表）。
 */

/** 一个刷怪区的几何（世界坐标；字段名与 `map_spawn_areas` 列一致） */
export interface SpawnAreaRect {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/** 地图尺寸（只用到像素宽高） */
export interface MapPixelRect {
  width: number;
  height: number;
}

/** 四边各越出多少（0 或负数 = 那一侧在图内；单位与世界坐标一致 = 像素） */
export interface SpawnAreaOverflow {
  /** 矩形左边超出图的左边界（`0 - left`） */
  left: number;
  /** 矩形右边超出图的右边界（`right - W`） */
  right: number;
  /** 矩形上边超出图的顶边（`top - 0`；y 轴向上，顶边是 y = 0） */
  top: number;
  /** 矩形下边超出图的底边（`-H - bottom`） */
  bottom: number;
}

/** 判定容差（像素）：见文件头「容差 1 像素」 */
export const SPAWN_AREA_TOLERANCE = 1;

/**
 * 刷怪区四边各越出多少
 *
 * 返回值为「超出量」，图内的一侧给 0 —— 负数对调用方没有意义（页面要显示的是「越了多少」），
 * 留 0 也让 `inBounds` 可以退化成「四个 0」这一条判据。
 */
export function spawnAreaOverflow(area: SpawnAreaRect, map: MapPixelRect): SpawnAreaOverflow {
  const left = area.cx - area.w / 2;
  const right = area.cx + area.w / 2;
  const top = area.cy + area.h / 2;
  const bottom = area.cy - area.h / 2;
  return {
    left: Math.max(0, Math.round((0 - left - SPAWN_AREA_TOLERANCE) * 100) / 100),
    right: Math.max(0, Math.round((right - map.width - SPAWN_AREA_TOLERANCE) * 100) / 100),
    top: Math.max(0, Math.round((top - 0 - SPAWN_AREA_TOLERANCE) * 100) / 100),
    bottom: Math.max(0, Math.round((-map.height - bottom - SPAWN_AREA_TOLERANCE) * 100) / 100),
  };
}

/** 四边都没越界（= 矩形整体落在 `[0, W] × [-H, 0]` 里） */
export function spawnAreaInBounds(area: SpawnAreaRect, map: MapPixelRect): boolean {
  const overflow = spawnAreaOverflow(area, map);
  return overflow.left === 0 && overflow.right === 0 && overflow.top === 0 && overflow.bottom === 0;
}

/** 越界描述（日志 / 提示用；在图内给空串） */
export function spawnAreaOverflowText(overflow: SpawnAreaOverflow): string {
  const sides: Array<[keyof SpawnAreaOverflow, string]> = [
    ["left", "左"],
    ["right", "右"],
    ["top", "上"],
    ["bottom", "下"],
  ];
  return sides
    .filter(([key]) => overflow[key] > 0)
    .map(([key, label]) => `${label} ${overflow[key]}`)
    .join(" / ");
}
