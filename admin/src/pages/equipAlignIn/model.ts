/**
 * 内观对齐工作台的几何模型（#523）
 *
 * 与外观（`equipAlign/model.ts`）的区别只有一处：**只有一个朝向**。
 * 所以这里没有「格子 × 8 方向」，而是一个「弹窗坐标系」的视图 —— 页面画的每一个像素
 * 都能直接换算成游戏里的弹窗坐标，改出来的数字就是 `inPosition` / `inScaleX` / `inScaleY`。
 *
 * 坐标约定（与 Cocos 一致）：
 *   - 弹窗坐标：原点 = 弹窗中心，y **向上**；内观节点的 position 就是这套坐标；
 *   - 节点框 = 画布尺寸（`spriteSourceSize`）× 两轴缩放，锚点在**画布中心**；
 *   - 内容中心 = 节点中心 + `spriteOffset`（y 向上，两轴各自乘缩放）；
 *   - 屏幕坐标 y 向下，所以只在最后一步 `toScreen` 取反 —— 中间计算全在弹窗坐标里做，
 *     这样「拖动 1 像素 = 改多少游戏单位」不必到处翻符号。
 */

import type { SolidBox, SpriteFrameInfo } from "../equipAlign/atlas";
import { round2, snap } from "../equipAlign/model";

/** 吸附与取整是跨两个工作台同一个口径，直接从这里再导出，页面不用记它在哪个文件 */
export { round2, snap } from "../equipAlign/model";

export type Vec2 = [number, number];

/** 内观几何（= 客户端 `Equipment` 的 `inPosition` / `inScaleX` / `inScaleY` / `inManual`） */
export interface InGeometry {
  inScaleX: number;
  inScaleY: number;
  inPosition: Vec2;
  /**
   * 武器是否用手调的绝对值：false = 客户端按当前衣服的内容 bbox 自动算（此时本页改的数字
   * 只在「按第一件衣服给初值」时被用到，运行时并不读）。衣服恒为 true。
   */
  manual: boolean;
}

/** 弹窗坐标里的矩形（以中心 + 尺寸表示，y 向上） */
export interface Box {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/** 屏幕矩形（y 向下，单位像素） */
export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 视图窗口（弹窗坐标）
 *
 * `left` / `top` 是窗口的**左边界 / 上边界**（top 是 y 的正向边界），
 * 与 canvas 的「左上角」对应 —— 换算时只需要这两个数。
 */
export interface ViewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 内观条目（清单里的衣服 / 武器） */
export interface InItem {
  id: string;
  kind: "cloth" | "weapon";
  key: string;
  label: string;
  /** 内观图集路径（`clothes/in/005`），为空 = 没有内观素材 */
  inPath: string;
  base: InGeometry;
}

/** 清单 → 条目（`in` 为空时不列出来：没有内观素材的东西摆不上圆盘） */
export function itemsFromCatalog(
  catalog: { clothes: CatalogLike[]; weapons: CatalogLike[] },
  fallbackManual: boolean,
): { clothes: InItem[]; weapons: InItem[] } {
  const map = (list: CatalogLike[], kind: "cloth" | "weapon"): InItem[] =>
    list
      .filter((entry) => Boolean(entry.in))
      .map((entry) => ({
        id: `${kind}:${entry.key}`,
        kind,
        key: entry.key,
        label: entry.label,
        inPath: entry.in ?? "",
        base: {
          inScaleX: entry.inScale[0] > 0 ? entry.inScale[0] : 1,
          inScaleY: entry.inScale[1] > 0 ? entry.inScale[1] : 1,
          inPosition: [Number(entry.inPosition[0]) || 0, Number(entry.inPosition[1]) || 0],
          manual: fallbackManual,
        },
      }));
  return { clothes: map(catalog.clothes, "cloth"), weapons: map(catalog.weapons, "weapon") };
}

/** 清单条目的形状（只声明这里用到的字段，避免把整个 JSON 的类型抄一遍） */
export interface CatalogLike {
  key: string;
  label: string;
  in?: string;
  inScale: [number, number];
  inPosition: Vec2;
}

/** 节点框（弹窗坐标）：中心 = inPosition，尺寸 = 画布 × 两轴缩放 */
export function frameBox(frame: SpriteFrameInfo, geo: InGeometry): Box {
  return {
    cx: geo.inPosition[0],
    cy: geo.inPosition[1],
    w: frame.canvas.w * geo.inScaleX,
    h: frame.canvas.h * geo.inScaleY,
  };
}

/** 内容（裁剪区）框：中心 = 节点中心 + offset × 缩放（offset 的 y 向上） */
export function contentBox(frame: SpriteFrameInfo, geo: InGeometry): Box {
  return {
    cx: geo.inPosition[0] + frame.offset.x * geo.inScaleX,
    cy: geo.inPosition[1] + frame.offset.y * geo.inScaleY,
    w: frame.rect.w * geo.inScaleX,
    h: frame.rect.h * geo.inScaleY,
  };
}

/**
 * 不透明轮廓框
 *
 * `solid` 是相对**内容左上角**的像素框，内容框在弹窗坐标里是中心表示、y 向上 ——
 * 所以纵向要反过来算（`内容上边 - (solid.y + solid.h)`）。用裁剪框代替它会让
 * 「脚踩圆盘」差出影子的高度（外观那边踩过这个坑，见 #517）。
 */
export function solidBox(solid: SolidBox, content: Box, geo: InGeometry): Box {
  const sx = geo.inScaleX;
  const sy = geo.inScaleY;
  return {
    cx: content.cx - content.w / 2 + (solid.x + solid.w / 2) * sx,
    cy: content.cy + content.h / 2 - (solid.y + solid.h / 2) * sy,
    w: solid.w * sx,
    h: solid.h * sy,
  };
}

/** 弹窗坐标 → 屏幕坐标 */
export function toScreen(view: ViewRect, k: number, point: Vec2): Vec2 {
  return [(point[0] - view.left) * k, (view.top - point[1]) * k];
}

/** 屏幕坐标 → 弹窗坐标（拖动时用） */
export function fromScreen(view: ViewRect, k: number, point: Vec2): Vec2 {
  return [view.left + point[0] / k, view.top - point[1] / k];
}

/** 弹窗坐标的框 → 屏幕矩形 */
export function boxToScreen(view: ViewRect, k: number, box: Box): ScreenRect {
  const w = box.w * k;
  const h = box.h * k;
  const [cx, cy] = toScreen(view, k, [box.cx, box.cy]);
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** 视图窗口：以背景图为准加一圈边距（页面「所见 = 弹窗那片区域」） */
export function viewOfBackground(background: { position: Vec2; size: [number, number] }, margin = 18): ViewRect {
  const w = background.size[0];
  const h = background.size[1];
  return {
    left: background.position[0] - w / 2 - margin,
    top: background.position[1] + h / 2 + margin,
    width: w + margin * 2,
    height: h + margin * 2,
  };
}

/** 握持点（与客户端 `configs/equipAlign.handAnchor` 同口径，只是这里用轮廓框） */
export const HAND_SIDE_RATIO = 0.52;
export const HAND_HEIGHT_RATIO = 0.52;
export const IN_WEAPON_HEIGHT_RATIO = 1.15;

export function handAnchorOf(solid: Box, onLeft = true): Vec2 {
  const side = onLeft ? -1 : 1;
  return [solid.cx + side * (solid.w / 2) * HAND_SIDE_RATIO, solid.cy - solid.h / 2 + solid.h * HAND_HEIGHT_RATIO];
}

/**
 * 按「第一件衣服」给武器一个初值（与客户端 `placeInShowWeapon` 同口径）
 *
 * 客户端算法是「武器内容高度 = 身体内容高度 × 1.15，内容中心贴到握持点」，它只对**身体**
 * 生效；这里用**轮廓**算握持点（影子不参与），所以结果会比自动算法更贴手一点 ——
 * 这只是初值，剩下的靠人眼收。
 *
 * 返回的两轴缩放相同（武器没有「横向拉宽」的素材），位置是节点中心。
 */
export function fitWeaponToBody(
  bodySolid: Box,
  frame: SpriteFrameInfo,
  solid: SolidBox,
  onLeft = true,
): { inScaleX: number; inScaleY: number; inPosition: Vec2 } {
  const scale = (bodySolid.h * IN_WEAPON_HEIGHT_RATIO) / solid.h;
  const hand = handAnchorOf(bodySolid, onLeft);
  // 轮廓中心相对节点中心的偏移（弹窗坐标，y 向上）：内容中心偏移 + 轮廓中心在内容里的偏移
  const solidDx = solid.x + solid.w / 2 - frame.rect.w / 2;
  const solidDy = frame.rect.h / 2 - (solid.y + solid.h / 2);
  const offsetX = (frame.offset.x + solidDx) * scale;
  const offsetY = (frame.offset.y + solidDy) * scale;
  return {
    inScaleX: round2(scale),
    inScaleY: round2(scale),
    inPosition: [round2(hand[0] - offsetX), round2(hand[1] - offsetY)],
  };
}

/** 把轮廓的底边中点对到圆盘中心（衣服「脚踩圆盘」） */
export function snapFeetToPlate(geo: InGeometry, solid: Box, plateCenter: Vec2): InGeometry {
  const deltaX = plateCenter[0] - solid.cx;
  const deltaY = plateCenter[1] - (solid.cy - solid.h / 2);
  return {
    ...geo,
    inPosition: [round2(geo.inPosition[0] + deltaX), round2(geo.inPosition[1] + deltaY)],
  };
}

/** 轮廓底边相对圆盘中心的偏移（正 = 悬空，负 = 陷进盘里） */
export function feetDeltaOf(solid: Box | null, plateCenter: Vec2): number | null {
  if (!solid) return null;
  return solid.cy - solid.h / 2 - plateCenter[1];
}

/** 某件是否调过（与基线不同） */
export function isDirty(draft: InGeometry, base: InGeometry): boolean {
  return (
    Math.abs(draft.inScaleX - base.inScaleX) > 1e-6 ||
    Math.abs(draft.inScaleY - base.inScaleY) > 1e-6 ||
    Math.abs(draft.inPosition[0] - base.inPosition[0]) > 1e-6 ||
    Math.abs(draft.inPosition[1] - base.inPosition[1]) > 1e-6
  );
}

/** 坐标吸附（配置精度 0.1） */
export function nudge(geo: InGeometry, dx: number, dy: number): InGeometry {
  return {
    ...geo,
    inPosition: [snap(geo.inPosition[0] + dx), snap(geo.inPosition[1] + dy)],
  };
}

/** 等比缩放（滚轮 / 输入框用；两轴各自有值时也按比例一起动） */
export function scaleBy(geo: InGeometry, delta: number): InGeometry {
  const nextX = round2(Math.min(4, Math.max(0.2, geo.inScaleX + delta)));
  const nextY = round2(Math.min(4, Math.max(0.2, geo.inScaleY + delta)));
  return { ...geo, inScaleX: nextX, inScaleY: nextY };
}
