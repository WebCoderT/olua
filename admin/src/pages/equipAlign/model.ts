/**
 * 对齐工作台的几何模型
 *
 * 这里只放**纯计算**（不碰 DOM、不碰 React）：给定一帧的几何与一组偏移，
 * 算出它在屏幕上的矩形。页面、单元测试、离线合成器都读同一份，
 * 免得「页面上看着对、游戏里不对」。
 *
 * 坐标约定（与 Cocos 一致）：
 *   - 节点位置 = `outPositions[方向]`，相对**角色宿主原点**（= 格子中心），y 向上；
 *   - 节点框 = 画布尺寸（spriteSourceSize），锚点居中；
 *   - 内容中心 = 节点中心 + `spriteOffset`（y 向上）；
 *   - 屏幕坐标 y 向下，所以 y 方向处处取反。
 */

import type { SolidBox, SpriteFrameInfo } from "./atlas";

/** `[x, y]`（y 向上，与配置里的 Vec2 一致） */
export type Vec2 = [number, number];

/** 一件装备/裸模在 8 个方向上的外观几何 */
export interface Geometry {
  outScale: number;
  /** 8 项，顺序 = catalog.directions（up / right_up / right / …） */
  outPositions: Vec2[];
  /**
   * 武器的位置语义：false = 客户端运行时按身体帧自动算（#505 的算法），
   * true = `outPositions` 当绝对位置。衣服与裸模恒为 true（它们一直就是绝对位置）。
   *
   * **武器默认也是 true**（#541）：本页对武器的编辑与预览全是绝对位置语义
   * （render.ts 画格子从不看这个标记），默认 false 时「页面上看着对、游戏里不对」——
   * 客户端把同一份坐标当微调叠在自动算法上。想走「自动 + 微调」再手动取消勾选。
   */
  manual: boolean;
}

export interface CatalogGeometry {
  outScale: number;
  outPositions: Vec2[];
  manual: boolean;
  inScale: [number, number];
  inPosition: Vec2;
}

/** 屏幕矩形（y 向下，单位像素） */
export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const DIRECTIONS = ["up", "right_up", "right", "right_down", "down", "left_down", "left", "left_up"] as const;

/** 方向中文名（工具里标格子用；与客户端 DIRECTION 的语义一致） */
export const DIRECTION_LABELS: Record<string, string> = {
  up: "上",
  right_up: "右上",
  right: "右",
  right_down: "右下",
  down: "下",
  left_down: "左下",
  left: "左",
  left_up: "左上",
};

/** 这些朝向下角色是**背对**观众的（武器在身体另一侧） */
export const BACK_DIRECTIONS = new Set(["up", "left_up", "right_up"]);

/**
 * 节点框在屏幕上的矩形
 *
 * @param cx 宿主原点的屏幕坐标
 * @param k  缩放（1 游戏单位 = k 像素）
 */
export function nodeRect(frame: SpriteFrameInfo, origin: Vec2, position: Vec2, scale: number, k: number): ScreenRect {
  const w = frame.canvas.w * scale * k;
  const h = frame.canvas.h * scale * k;
  return { x: origin[0] + position[0] * k - w / 2, y: origin[1] - position[1] * k - h / 2, w, h };
}

/**
 * 帧内容（裁剪区）在屏幕上的矩形
 *
 * 内容中心 = 节点中心 + offset（y 向上）；节点中心 = 宿主原点 + position（y 向上）。
 * 化简后就是下面两行 —— 注意 offset 的 y 在屏幕坐标里是**减**。
 */
export function contentRect(frame: SpriteFrameInfo, origin: Vec2, position: Vec2, scale: number, k: number): ScreenRect {
  const w = frame.rect.w * scale * k;
  const h = frame.rect.h * scale * k;
  const centerX = origin[0] + (position[0] + frame.offset.x * scale) * k;
  const centerY = origin[1] - (position[1] + frame.offset.y * scale) * k;
  return { x: centerX - w / 2, y: centerY - h / 2, w, h };
}

/**
 * 轮廓在屏幕上的矩形
 *
 * @param unit 内容矩形的一像素对应多少屏幕像素（= 缩放 × k）
 */
export function solidScreenRect(solid: SolidBox, content: ScreenRect, unit: number): ScreenRect {
  return { x: content.x + solid.x * unit, y: content.y + solid.y * unit, w: solid.w * unit, h: solid.h * unit };
}

/**
 * 握持点（屏幕坐标）
 *
 * 站在**轮廓**上算，不用裁剪框：轮廓之外大半是影子和光晕。
 *   - 横向：从轮廓侧边往里收 `inset`（手臂有厚度，贴边会看起来悬空）；
 *   - 纵向：从脚底往上 `heightRatio`（0.52 ≈ 手自然下垂的位置）。
 */
export function handAnchor(solid: ScreenRect, onLeft: boolean, inset = 0.1, heightRatio = 0.52): Vec2 {
  const x = onLeft ? solid.x + solid.w * inset : solid.x + solid.w * (1 - inset);
  const y = solid.y + solid.h * (1 - heightRatio);
  return [x, y];
}

/** 浮点吸附（配置里的数值精度是 0.1，页面上别产出 12.300000000000001） */
export function snap(value: number, step = 0.1): number {
  return Math.round(value / step) * step;
}

/**
 * 把位置夹在「一屏可见范围」内（防止一次拖动把物品甩出格子）
 *
 * 为什么需要：`up` 方向曾经存着 `y = 199.7`（脚底悬空 +168.7）—— 那次拖动时指针移出画布，
 * 位移按 `(指针 - 起点) / zoom` 一路累计，松手时人已经飞到格子外面。之后在画布上**抓不到它**
 * （拖动要求点中内容矩形），只能在右栏一格一格按方向键挪回来，于是看起来像「改不了」。
 * 夹紧的代价只是「不能把东西拖到格子外」，而格子外本来也没法用肉眼判断。
 */
export function clampPosition(value: number, limit: number): number {
  return Math.min(limit, Math.max(-limit, value));
}

/** 把浮点规整到 2 位小数（导出的 JSON 才好看） */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 让 `outPositions` 补齐到 8 项（配置缺项时页面不能崩） */
export function normalizePositions(positions: Vec2[] | undefined): Vec2[] {
  const list = (positions ?? []).map((item) => [Number(item[0]) || 0, Number(item[1]) || 0] as Vec2);
  while (list.length < 8) list.push(list[0] ? [list[0][0], list[0][1]] : [0, 0]);
  return list.slice(0, 8);
}

/** 一条清单条目 → 可编辑几何 */
export function geometryFromCatalog(item: { outScale: number; outPositions: Vec2[]; manual: boolean }, fallbackManual: boolean): Geometry {
  return {
    outScale: item.outScale || 1,
    outPositions: normalizePositions(item.outPositions),
    manual: item.manual || fallbackManual,
  };
}

/** 判断某件是否「调过」（与配置值不同） */
export function isDirty(draft: Geometry, base: Geometry): boolean {
  if (Math.abs(draft.outScale - base.outScale) > 1e-6) return true;
  return draft.outPositions.some((pos, index) => {
    const ref = base.outPositions[index] ?? [0, 0];
    return Math.abs(pos[0] - ref[0]) > 1e-6 || Math.abs(pos[1] - ref[1]) > 1e-6;
  });
}

/** 该件已调过的方向数（列表上的进度） */
export function adjustedDirections(draft: Geometry, base: Geometry): number {
  let count = 0;
  for (let index = 0; index < 8; index++) {
    const a = draft.outPositions[index] ?? [0, 0];
    const b = base.outPositions[index] ?? [0, 0];
    if (Math.abs(a[0] - b[0]) > 1e-6 || Math.abs(a[1] - b[1]) > 1e-6) count++;
  }
  return count;
}
