/**
 * 内观视图的绘制（#523）
 *
 * 一个视图、四层：**弹窗背景（含圆盘）→ 圆盘参考 → 参照衣服 → 当前编辑对象**。
 * 与外观工作台（8 宫格）最大的不同是没有「每个方向一格」—— 内观只有一个朝向，
 * 所以这里把整块弹窗区域 1:1 画出来：页面上看到的就是玩家打开角色信息弹窗看到的那一幕。
 *
 * 所有几何都在**弹窗坐标**里算（见 model.ts），这里只负责把框转成屏幕矩形再描边 / 贴图。
 */

import type { Atlas } from "../equipAlign/atlas";
import { measureSolid } from "../equipAlign/atlas";
import type { Box, InGeometry, ScreenRect, Vec2, ViewRect } from "./model";
import { boxToScreen, contentBox, frameBox, handAnchorOf, solidBox, toScreen } from "./model";

/** 参考框开关 */
export interface InGuides {
  /** 弹窗背景（含圆盘）—— 关掉看纯几何 */
  background: boolean;
  /** 圆盘参考环 + 中心十字 + 脚底线 */
  plate: boolean;
  /** 画布框（节点框，虚线） */
  canvas: boolean;
  /** 裁剪框（内容框，细线） */
  content: boolean;
  /** 真实轮廓（alpha>200，亮绿） */
  solid: boolean;
  /** 手位十字（按参照衣服的轮廓算） */
  hands: boolean;
  /** 弹窗原点十字 */
  origin: boolean;
}

export const IN_COLORS = {
  canvasBox: "rgba(150,170,200,0.35)",
  contentBox: "rgba(150,170,200,0.18)",
  solid: "rgba(110,232,110,0.75)",
  plate: "rgba(255,196,92,0.85)",
  plateFill: "rgba(255,196,92,0.06)",
  hand: "rgba(255,90,90,0.9)",
  originCross: "rgba(120,160,220,0.5)",
  baseGhost: "rgba(150,200,255,0.45)",
  selected: "rgba(129,140,248,0.9)",
};

/** 一层内观（当前对象 / 参照衣服都走这个结构） */
export interface InLayer {
  atlas: Atlas;
  frameName: string;
  geometry: InGeometry;
  /** 0~1，参照衣服画得淡一点 */
  alpha?: number;
  /** 画参考框（参照衣服只画轮廓与手位，不画框，免得盖住对象） */
  drawGuides?: boolean;
}

export interface InScene {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  view: ViewRect;
  /** 1 游戏单位 = 多少像素 */
  k: number;
  /** 弹窗背景图（没加载好时 null，先画几何） */
  backgroundImage: HTMLImageElement | null;
  background: { position: Vec2; size: [number, number] };
  plate: { center: Vec2; radius: number };
  guides: InGuides;
  /** 参照衣服（调武器时是第一件衣服；调衣服时为 null —— 衣服的基准是圆盘） */
  base: InLayer | null;
  item: InLayer | null;
}

/** 画一帧的内观：内容区按帧裁剪后铺到「内容框」上（不是节点框 —— 裁剪留白不在图像里） */
function drawLayer(scene: InScene, layer: InLayer, alpha: number): Box | null {
  const frame = layer.atlas.frames.get(layer.frameName);
  if (!frame) return null;
  const content = contentBox(frame, layer.geometry);
  const rect = boxToScreen(scene.view, scene.k, content);
  const { ctx } = scene;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(
    layer.atlas.image,
    frame.rect.x,
    frame.rect.y,
    frame.rect.w,
    frame.rect.h,
    rect.x,
    rect.y,
    rect.w,
    rect.h,
  );
  ctx.restore();
  return content;
}

/** 某层的轮廓框（弹窗坐标；量不到时 null） */
export function layerSolid(layer: InLayer): Box | null {
  const frame = layer.atlas.frames.get(layer.frameName);
  if (!frame) return null;
  const solid = measureSolid(layer.atlas, layer.frameName);
  if (!solid) return null;
  return solidBox(solid, contentBox(frame, layer.geometry), layer.geometry);
}

function strokeRect(ctx: CanvasRenderingContext2D, rect: ScreenRect, color: string, dash: number[] = [], width = 1) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.strokeRect(Math.round(rect.x) + 0.5, Math.round(rect.y) + 0.5, Math.round(rect.w), Math.round(rect.h));
  ctx.restore();
}

function cross(ctx: CanvasRenderingContext2D, point: Vec2, color: string, size = 6, width = 1) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(point[0] - size, point[1]);
  ctx.lineTo(point[0] + size, point[1]);
  ctx.moveTo(point[0], point[1] - size);
  ctx.lineTo(point[0], point[1] + size);
  ctx.stroke();
  ctx.restore();
}

/** 画整个内观视图 */
export function drawInShow(scene: InScene): void {
  const { ctx, view, k, guides } = scene;

  // ---- 1. 弹窗背景（含圆盘）----
  if (guides.background && scene.backgroundImage) {
    const rect = boxToScreen(view, k, {
      cx: scene.background.position[0],
      cy: scene.background.position[1],
      w: scene.background.size[0],
      h: scene.background.size[1],
    });
    ctx.drawImage(scene.backgroundImage, rect.x, rect.y, rect.w, rect.h);
  }

  // ---- 2. 圆盘参考（衣服的基准）----
  if (guides.plate) {
    const [cx, cy] = toScreen(view, k, scene.plate.center);
    const radius = scene.plate.radius * k;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = IN_COLORS.plateFill;
    ctx.fill();
    ctx.strokeStyle = IN_COLORS.plate;
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.restore();
    // 中心十字 + 脚底线（圆盘中心就是「脚该踩的地方」）
    cross(ctx, [cx, cy], IN_COLORS.plate, 8, 1.5);
    ctx.save();
    ctx.strokeStyle = IN_COLORS.plate;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(cx - radius, Math.round(cy) + 0.5);
    ctx.lineTo(cx + radius, Math.round(cy) + 0.5);
    ctx.stroke();
    ctx.restore();
  }

  // ---- 3. 参照衣服（调武器时的「第一件衣服」）----
  if (scene.base) {
    drawLayer(scene, scene.base, scene.base.alpha ?? 0.55);
    const solid = layerSolid(scene.base);
    if (solid) {
      if (guides.solid) strokeRect(ctx, boxToScreen(view, k, solid), IN_COLORS.baseGhost, [5, 4], 1);
      if (guides.hands) {
        const hand = handAnchorOf(solid, true);
        cross(ctx, toScreen(view, k, hand), IN_COLORS.hand, 7, 1.5);
      }
    }
  }

  // ---- 4. 当前编辑对象 ----
  if (scene.item) {
    const content = drawLayer(scene, scene.item, scene.item.alpha ?? 1);
    const solid = layerSolid(scene.item);
    const frame = scene.item.atlas.frames.get(scene.item.frameName);
    if (frame && content) {
      if (guides.canvas) {
        strokeRect(ctx, boxToScreen(view, k, frameBox(frame, scene.item.geometry)), IN_COLORS.canvasBox, [4, 4]);
      }
      if (guides.content) strokeRect(ctx, boxToScreen(view, k, content), IN_COLORS.contentBox);
      if (guides.solid && solid) strokeRect(ctx, boxToScreen(view, k, solid), IN_COLORS.solid, [], 1.5);
      if (guides.hands && solid) cross(ctx, toScreen(view, k, handAnchorOf(solid, true)), IN_COLORS.hand, 7, 1.5);
    }
  }

  // ---- 5. 弹窗原点（理解坐标用）----
  if (guides.origin) cross(ctx, toScreen(view, k, [0, 0]), IN_COLORS.originCross, 10, 1);
}
