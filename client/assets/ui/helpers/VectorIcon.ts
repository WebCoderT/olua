import { Color, Graphics, Node, Size } from "cc";

/**
 * 矢量图标（#1075 尾批：HUD 里的描边小图标）
 *
 * 图标数据是 **design/olua-ui 里 24×24 内联 SVG 的原始路径**（`fill="none"` + `stroke` 描边风格），
 * 见 `configs/layout/icons.ts`。这里只做一件事：把 SVG path 的 `d` 画到 Cocos 的 Graphics 上。
 *
 * 口径：
 * - 视图 24×24，圆心在 (12,12)；SVG 的 y 轴向下、Cocos 向上，绘制时统一翻成 `(x-12, 12-y)`
 * - 只描边不填充（与稿一致），线宽按图标实际像素尺寸等比放大
 * - 支持的 path 指令：M/L/H/V/C/S/Q/T/A/Z（大小写均支持，含隐式重复参数）。
 *   椭圆弧 A 用「端点参数 → 圆心参数」换算后采样折线（Graphics 只有正圆 arc）
 */
export interface VectorIconShape {
  /** `<circle cx cy r>`，单位是 24 视图 */
  circles?: [number, number, number][];
  /** `<rect x y width height rx>`，单位是 24 视图 */
  rects?: [number, number, number, number, number][];
  /** `<path d="...">` 的原始 d */
  paths?: string[];
}

/** 视图边长（SVG viewBox 0 0 24 24） */
const VIEW = 24;
/** 椭圆弧 / 曲线采样段数（18px 图标下足够平滑） */
const ARC_STEPS = 24;

const NUMBER_RE = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;
const TOKEN_RE = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;

/**
 * 把一条 SVG path 画进 Graphics（只描边）
 * @param g 目标 Graphics（调用方负责设置 lineWidth / strokeColor）
 * @param d SVG path 数据
 * @param scale 视图单位 → 像素
 */
export function strokeSvgPath(g: Graphics, d: string, scale: number): void {
  let cx = 0;
  let cy = 0; // SVG 坐标下的当前点
  let startX = 0;
  let startY = 0;
  let lastCtrlX = 0;
  let lastCtrlY = 0;
  let prevCmd = "";
  let started = false;

  const px = (x: number) => (x - VIEW / 2) * scale;
  const py = (y: number) => (VIEW / 2 - y) * scale;
  const lineTo = (x: number, y: number) => {
    if (!started) {
      g.moveTo(px(x), py(y));
      started = true;
    } else {
      g.lineTo(px(x), py(y));
    }
    cx = x;
    cy = y;
  };

  const tokens = d.match(TOKEN_RE) ?? [];
  for (const token of tokens) {
    const cmd = token[0];
    const nums = (token.slice(1).match(NUMBER_RE) ?? []).map(Number);
    const rel = cmd === cmd.toLowerCase();
    const up = cmd.toUpperCase();
    let i = 0;

    switch (up) {
      case "M":
        // 后续参数按 L 处理（SVG 规范）
        while (i + 1 < nums.length) {
          const x = rel ? cx + nums[i] : nums[i];
          const y = rel ? cy + nums[i + 1] : nums[i + 1];
          if (i === 0) {
            g.moveTo(px(x), py(y));
            started = true;
            startX = x;
            startY = y;
            cx = x;
            cy = y;
          } else lineTo(x, y);
          i += 2;
        }
        break;
      case "L":
        while (i + 1 < nums.length) {
          lineTo(rel ? cx + nums[i] : nums[i], rel ? cy + nums[i + 1] : nums[i + 1]);
          i += 2;
        }
        break;
      case "H":
        while (i < nums.length) {
          lineTo(rel ? cx + nums[i] : nums[i], cy);
          i += 1;
        }
        break;
      case "V":
        while (i < nums.length) {
          lineTo(cx, rel ? cy + nums[i] : nums[i]);
          i += 1;
        }
        break;
      case "C":
        while (i + 5 < nums.length) {
          const x1 = rel ? cx + nums[i] : nums[i];
          const y1 = rel ? cy + nums[i + 1] : nums[i + 1];
          const x2 = rel ? cx + nums[i + 2] : nums[i + 2];
          const y2 = rel ? cy + nums[i + 3] : nums[i + 3];
          const x = rel ? cx + nums[i + 4] : nums[i + 4];
          const y = rel ? cy + nums[i + 5] : nums[i + 5];
          g.bezierCurveTo(px(x1), py(y1), px(x2), py(y2), px(x), py(y));
          lastCtrlX = x2;
          lastCtrlY = y2;
          cx = x;
          cy = y;
          started = true;
          i += 6;
        }
        break;
      case "S":
        while (i + 3 < nums.length) {
          // 第一控制点 = 上一段第二控制点关于当前点的对称点
          const reflect = /[CcSs]/.test(prevCmd);
          const x1 = reflect ? 2 * cx - lastCtrlX : cx;
          const y1 = reflect ? 2 * cy - lastCtrlY : cy;
          const x2 = rel ? cx + nums[i] : nums[i];
          const y2 = rel ? cy + nums[i + 1] : nums[i + 1];
          const x = rel ? cx + nums[i + 2] : nums[i + 2];
          const y = rel ? cy + nums[i + 3] : nums[i + 3];
          g.bezierCurveTo(px(x1), py(y1), px(x2), py(y2), px(x), py(y));
          lastCtrlX = x2;
          lastCtrlY = y2;
          cx = x;
          cy = y;
          started = true;
          i += 4;
        }
        break;
      case "Q":
        while (i + 3 < nums.length) {
          const x1 = rel ? cx + nums[i] : nums[i];
          const y1 = rel ? cy + nums[i + 1] : nums[i + 1];
          const x = rel ? cx + nums[i + 2] : nums[i + 2];
          const y = rel ? cy + nums[i + 3] : nums[i + 3];
          g.quadraticCurveTo(px(x1), py(y1), px(x), py(y));
          lastCtrlX = x1;
          lastCtrlY = y1;
          cx = x;
          cy = y;
          started = true;
          i += 4;
        }
        break;
      case "T":
        while (i + 1 < nums.length) {
          const reflect = /[QqTt]/.test(prevCmd);
          const x1 = reflect ? 2 * cx - lastCtrlX : cx;
          const y1 = reflect ? 2 * cy - lastCtrlY : cy;
          const x = rel ? cx + nums[i] : nums[i];
          const y = rel ? cy + nums[i + 1] : nums[i + 1];
          g.quadraticCurveTo(px(x1), py(y1), px(x), py(y));
          lastCtrlX = x1;
          lastCtrlY = y1;
          cx = x;
          cy = y;
          started = true;
          i += 2;
        }
        break;
      case "A":
        while (i + 6 < nums.length) {
          const rx = nums[i];
          const ry = nums[i + 1];
          const rot = nums[i + 2];
          const largeArc = nums[i + 3] !== 0;
          const sweep = nums[i + 4] !== 0;
          const x = rel ? cx + nums[i + 5] : nums[i + 5];
          const y = rel ? cy + nums[i + 6] : nums[i + 6];
          sampleArc(g, cx, cy, rx, ry, rot, largeArc, sweep, x, y, px, py);
          cx = x;
          cy = y;
          started = true;
          i += 7;
        }
        break;
      case "Z":
        g.close();
        cx = startX;
        cy = startY;
        started = true;
        break;
      default:
        break;
    }
    prevCmd = up;
  }
}

/**
 * SVG 椭圆弧采样（端点参数 → 圆心参数，再按角度切片折线）
 * 公式见 SVG 1.1 附录 F.6.5
 */
function sampleArc(
  g: Graphics,
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  rotDeg: number,
  largeArc: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
  px: (x: number) => number,
  py: (y: number) => number,
): void {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) {
    g.lineTo(px(x2), py(y2));
    return;
  }
  const phi = (rotDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;
  // 半径不足以连接两端点时按规范等比放大
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  const coef = (largeArc === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * (rx * y1p)) / ry;
  const cyp = (coef * -(ry * x1p)) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;
  const angleOf = (ux: number, uy: number) => Math.atan2(uy, ux);
  const startAngle = angleOf((x1p - cxp) / rx, (y1p - cyp) / ry);
  const endAngle = angleOf((-x1p - cxp) / rx, (-y1p - cyp) / ry);
  let delta = endAngle - startAngle;
  if (!sweep && delta > 0) delta -= Math.PI * 2;
  else if (sweep && delta < 0) delta += Math.PI * 2;

  for (let i = 1; i <= ARC_STEPS; i++) {
    const t = startAngle + (delta * i) / ARC_STEPS;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    g.lineTo(px(cx + cosPhi * ex - sinPhi * ey), py(cy + sinPhi * ex + cosPhi * ey));
  }
}

/**
 * 在节点上画一枚图标（直角视图 24×24 → size 像素）
 * @param node 目标节点（调用方已设好 UITransform 尺寸）
 * @param shape 图标数据（configs/layout/icons.ts）
 * @param size 图标实际边长（像素）
 * @param color 描边色
 * @param stroke 描边线宽（24 视图下的值，默认 1.7，与稿一致）
 */
export function drawVectorIcon(node: Node, shape: VectorIconShape, size: Size, color: Color, stroke = 1.7): Graphics {
  const g = node.getComponent(Graphics) ?? node.addComponent(Graphics);
  const scale = size.width / VIEW;
  g.clear();
  // 线宽下限 1.5px：16~18px 图标按 1.7/24 折算只有 1.1px，Graphics 抗锯齿后每颗像素只染到
  // 四成颜色，实机上看着是「暗棕色糊块」而不是金线（2026-11-17 实机核对）。宁可略粗，也别糊
  g.lineWidth = Math.max(stroke * scale, 1.5);
  g.strokeColor = color;
  for (const [cx, cy, r] of shape.circles ?? []) {
    g.circle((cx - VIEW / 2) * scale, (VIEW / 2 - cy) * scale, r * scale);
  }
  for (const [x, y, w, h, r] of shape.rects ?? []) {
    const left = (x - VIEW / 2) * scale;
    const top = (VIEW / 2 - y) * scale;
    const width = w * scale;
    const height = h * scale;
    if (r > 0) g.roundRect(left, top - height, width, height, r * scale);
    else g.rect(left, top - height, width, height);
  }
  for (const d of shape.paths ?? []) strokeSvgPath(g, d, scale);
  // 一次性描边：Cocos 的 Graphics 会把所有子路径累积在同一个 impl 上，
  // 中途 stroke() 会把已有几何再描一遍（线条发糊），所以只在这里收口
  g.stroke();
  return g;
}
