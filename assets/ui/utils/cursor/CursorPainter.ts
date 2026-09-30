import { sys } from "cc";
import { CursorShape, CursorStyle } from "../../../configs/cursor";

/**
 * 指针形状栅格化工具
 * 自定义鼠标指针在 Web 端只能通过 CSS `cursor: url(...)` 提供图片，
 * 这里用离屏 canvas 按配置把形状画成 PNG data URI（结果按「形状+颜色+尺寸」缓存），
 * 因此换颜色/换尺寸不需要任何美术资源，改 configs/cursor 即可
 * 原生平台（sys.isNative）没有 DOM，整体降级为「不接管指针」
 */

/** 形状的绘制基准尺寸（configs 里的 size 是最终像素尺寸，形状按该基准等比缩放） */
const BASE_SIZE = 32;
/** 箭头外描边宽度（基准坐标系） */
const ARROW_LINE_WIDTH = 1.6;
/** 栅格化结果缓存：形状|主色|描边色|尺寸 -> PNG data URI */
const cache = new Map<string, string>();

/** 各形状在兜底（图片不可用）时使用的系统光标关键字 */
const FALLBACK_CURSORS: Record<CursorShape, string> = {
  arrow: "default",
  attack: "crosshair",
  crosshair: "crosshair",
};

/** 当前环境能否使用 DOM（原生平台 / 无 document 环境不可用） */
export function canPaintCursor() {
  return !sys.isNative && typeof document !== "undefined";
}

/** 把指针样式栅格化成图片数据（供 CSS cursor 使用）；不可用环境返回 null */
export function paintCursor(style: CursorStyle): string | null {
  if (!canPaintCursor()) return null;
  const key = `${style.shape}|${style.color}|${style.outlineColor}|${style.size}`;
  const cached = cache.get(key);
  if (cached) return cached;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = style.size;
    canvas.height = style.size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // 在 32 基准坐标系里画，再缩放到目标尺寸
    ctx.scale(style.size / BASE_SIZE, style.size / BASE_SIZE);
    ctx.fillStyle = style.color;
    ctx.strokeStyle = style.outlineColor;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    drawShape(ctx, style.shape);
    const data = canvas.toDataURL("image/png");
    cache.set(key, data);
    return data;
  } catch (error) {
    // 少数受限环境（如跨域 iframe、指纹保护）取不到 data URI，降级为系统光标
    console.warn("[CursorPainter] 指针图片生成失败，改用系统光标", error);
    return null;
  }
}

/** 生成 CSS cursor 取值：图片 + 热点 + 兜底关键字（图片不可用时只用兜底关键字） */
export function buildCursorCss(style: CursorStyle): string {
  const fallback = FALLBACK_CURSORS[style.shape] ?? "default";
  const data = paintCursor(style);
  if (!data) return fallback;
  return `url("${data}") ${style.hotspotX} ${style.hotspotY}, ${fallback}`;
}

/** 按形状名称绘制（热区左上角对齐箭头尖端，见 configs/cursor 的 hotspot） */
function drawShape(ctx: CanvasRenderingContext2D, shape: CursorShape) {
  switch (shape) {
    case "crosshair":
      drawTargetRing(ctx, 16, 16, 8);
      return;
    case "attack":
      // 箭头 + 右上角目标环：既保留下按习惯的箭头指针，又一眼能看出是攻击
      drawArrow(ctx);
      drawTargetRing(ctx, 22.5, 9.5, 5);
      return;
    case "arrow":
    default:
      drawArrow(ctx);
      return;
  }
}

/** 常规箭头（尖端在基准坐标系 (3, 2) 附近） */
function drawArrow(ctx: CanvasRenderingContext2D) {
  ctx.lineWidth = ARROW_LINE_WIDTH;
  ctx.beginPath();
  ctx.moveTo(3, 2);
  ctx.lineTo(3, 24);
  ctx.lineTo(8.5, 19);
  ctx.lineTo(12, 27.5);
  ctx.lineTo(15.5, 26);
  ctx.lineTo(12, 17.6);
  ctx.lineTo(19, 17.6);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

/** 目标环：圆环 + 四向刻度 + 中心点（用当前 fillStyle/strokeStyle 绘制） */
function drawTargetRing(ctx: CanvasRenderingContext2D, centerX: number, centerY: number, radius: number) {
  const lineWidth = Math.max(1.4, radius * 0.4);
  const tickInner = radius + lineWidth * 0.4;
  const tickOuter = radius + lineWidth * 1.6;
  ctx.lineWidth = lineWidth;
  // 圆环
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.stroke();
  // 四向刻度
  ctx.beginPath();
  const directions = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  directions.forEach(([dx, dy]) => {
    ctx.moveTo(centerX + dx * tickInner, centerY + dy * tickInner);
    ctx.lineTo(centerX + dx * tickOuter, centerY + dy * tickOuter);
  });
  ctx.stroke();
  // 中心点
  ctx.beginPath();
  ctx.arc(centerX, centerY, Math.max(1, radius * 0.3), 0, Math.PI * 2);
  ctx.fill();
}
