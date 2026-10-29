/**
 * 8 宫格画布渲染
 *
 * 每个格子 = 一个朝向：裸模站在宿主原点上，当前装备叠上去。
 * 绘制的几何全部来自 `model.ts`（与游戏同一套语义），这里只负责把矩形画出来。
 *
 * 两个容易画错、但直接影响判断的细节：
 *   1. **遮挡顺序**：背对观众的朝向下武器在身体后面（客户端 `CLOTH_ON_TOP_DIRECTIONS` 同一张表）；
 *   2. **参考框画在图像之上**：画在下面会被不透明的身体完全盖住，等于没有。
 */

import type { Atlas, SolidBox, SpriteFrameInfo } from "./atlas";
import { frameNameOf } from "./atlas";
import type { Geometry, ScreenRect, Vec2 } from "./model";
import { contentRect, DIRECTIONS, nodeRect, solidScreenRect } from "./model";

/** 这些朝向下身体在武器上方（武器在身后）——与客户端 `RoleAppearance.CLOTH_ON_TOP_DIRECTIONS` 一致 */
const BODY_ON_TOP = new Set(["left", "left_up", "up", "left_down"]);

/** 参考框开关 */
export interface Guides {
  /** 裸模画布框（节点框，虚线） */
  canvas: boolean;
  /** 裁剪框（内容框，细线） */
  content: boolean;
  /** 真实轮廓（alpha>200，亮绿） */
  solid: boolean;
  /**
   * 地面线（宿主原点 y = 0）
   *
   * **画在原点，不画在裸模自己的轮廓底边**：轮廓底边跟着裸模的几何走，裸模一旦沉下去，
   * 「脚底线」就跟着沉下去 —— 那条线本来是用来判断「有没有沉」的，跟着跑就等于没有。
   */
  feet: boolean;
  /** 左右手位十字 */
  hands: boolean;
  /** 格子中心十字（宿主原点） */
  origin: boolean;
  /**
   * 碰撞盒（= 客户端 `debug.colliderRange` 画的那个框，尺寸取 `configs/role.roleBody`）
   *
   * 这是「身体到底踩在脚下没有」的唯一硬判据：盒子是从原点往上 `colliderHeight`，
   * 角色脚底应该正好落在盒子的下边缘。
   */
  frame: boolean;
}

/** 角色体型 / 碰撞盒（来自 catalog.body，与客户端 roleBody 同一份） */
export interface BodyBox {
  colliderWidth: number;
  colliderHeight: number;
  /** 相对脚下的偏移（角色锚点在脚下，所以盒子要往上抬身高的一半） */
  colliderOffset: Vec2;
}

/** 一格的绘制数据 */
export interface CellSpec {
  /** 在第几格（0~7，与 directions 下标一致） */
  index: number;
  rect: ScreenRect;
  /** 格子内宿主原点的屏幕坐标 */
  origin: Vec2;
  /** 1 游戏单位 = k 像素 */
  k: number;
  roleAtlas: Atlas;
  roleGeometry: Geometry;
  itemAtlas: Atlas | null;
  itemGeometry: Geometry | null;
  selected: boolean;
  hovered: boolean;
  /**
   * 基准裸模的不透明度。默认 1；调裸模自身时降到 0.35 —— 那时基准与对象是同一张图，
   * 半透明的「原点位置」正好当参照，能直接看出偏移了多少。
   */
  roleAlpha?: number;
  /** 角色体型 / 碰撞盒（画「碰撞盒」参考框用；清单没给就画不出来，其余照旧） */
  body?: BodyBox;
}

const COLORS = {
  bg: "#12141a",
  cell: "#171a21",
  cellBorder: "#2b313b",
  cellSelected: "#4da6ff",
  cellHover: "#3d4856",
  grid: "rgba(120,140,170,0.07)",
  text: "#9aa4b2",
  textActive: "#e6ecf5",
  canvasBox: "rgba(150,170,200,0.35)",
  contentBox: "rgba(150,170,200,0.18)",
  solid: "rgba(110,232,110,0.75)",
  hand: "rgba(255,90,90,0.9)",
  originCross: "rgba(120,160,220,0.5)",
  itemBox: "rgba(120,200,255,0.5)",
  collider: "rgba(90,200,255,0.45)",
  ground: "rgba(255,182,72,0.9)",
  feetOk: "rgba(150,164,180,0.9)",
  feetBad: "rgba(255,120,120,0.95)",
  /** 位置已飞出格子（这一格里看不到东西，只有数字能说明它在哪） */
  textWarn: "rgba(255,182,72,0.95)",
};

function frameOf(atlas: Atlas, direction: number): SpriteFrameInfo | null {
  return atlas.frames.get(frameNameOf(direction, 0)) ?? null;
}

/** 画一张精灵（按裁剪区还原到内容矩形） */
function drawSprite(ctx: CanvasRenderingContext2D, atlas: Atlas, frame: SpriteFrameInfo, rect: ScreenRect) {
  ctx.drawImage(atlas.image, frame.rect.x, frame.rect.y, frame.rect.w, frame.rect.h, rect.x, rect.y, rect.w, rect.h);
}

function strokeRect(ctx: CanvasRenderingContext2D, rect: ScreenRect, color: string, dash: number[] = [], width = 1) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w, rect.h);
  ctx.restore();
}

function cross(ctx: CanvasRenderingContext2D, point: Vec2, color: string, size = 5, width = 1) {
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

/** 轮廓（屏幕矩形）；素材缺帧时返回 null */
export function solidOf(solid: SolidBox | null, frame: SpriteFrameInfo, origin: Vec2, position: Vec2, scale: number, k: number): ScreenRect | null {
  if (!solid) return null;
  const content = contentRect(frame, origin, position, scale, k);
  return solidScreenRect(solid, content, scale * k);
}

/** 画一格 */
export function drawCell(ctx: CanvasRenderingContext2D, spec: CellSpec, guides: Guides, solidOfRole: SolidBox | null, solidOfItem: SolidBox | null) {
  const { rect, origin, k } = spec;
  const dirName = DIRECTIONS[spec.index] ?? "down";

  // 格子底 + 网格
  ctx.fillStyle = COLORS.cell;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();

  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  const step = 25 * k;
  for (let x = origin[0] % step; x < rect.x + rect.w; x += step) {
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, rect.y);
    ctx.lineTo(Math.round(x) + 0.5, rect.y + rect.h);
    ctx.stroke();
  }
  for (let y = origin[1] % step; y < rect.y + rect.h; y += step) {
    ctx.beginPath();
    ctx.moveTo(rect.x, Math.round(y) + 0.5);
    ctx.lineTo(rect.x + rect.w, Math.round(y) + 0.5);
    ctx.stroke();
  }

  const roleFrame = frameOf(spec.roleAtlas, spec.index);
  const itemFrame = spec.itemAtlas ? frameOf(spec.itemAtlas, spec.index) : null;
  const rolePos = spec.roleGeometry.outPositions[spec.index] ?? [0, 0];
  const itemPos = spec.itemGeometry?.outPositions[spec.index] ?? [0, 0];

  const roleContent = roleFrame ? contentRect(roleFrame, origin, rolePos, spec.roleGeometry.outScale, k) : null;
  const roleSolidRect = roleFrame ? solidOf(solidOfRole, roleFrame, origin, rolePos, spec.roleGeometry.outScale, k) : null;
  const itemContent = itemFrame && spec.itemGeometry ? contentRect(itemFrame, origin, itemPos, spec.itemGeometry.outScale, k) : null;

  // 身体 / 装备的绘制顺序（背对时武器在身后）
  const bodyOnTop = BODY_ON_TOP.has(dirName);
  const drawBody = () => {
    if (roleFrame && roleContent) {
      const alpha = spec.roleAlpha ?? 1;
      ctx.save();
      if (alpha < 1) ctx.globalAlpha = alpha;
      drawSprite(ctx, spec.roleAtlas, roleFrame, roleContent);
      ctx.restore();
      if (guides.canvas) strokeRect(ctx, nodeRect(roleFrame, origin, rolePos, spec.roleGeometry.outScale, k), COLORS.canvasBox, [4, 3]);
      if (guides.content) strokeRect(ctx, roleContent, COLORS.contentBox, []);
      if (guides.solid && roleSolidRect) strokeRect(ctx, roleSolidRect, COLORS.solid, [], 1.5);
    }
  };
  const drawItem = () => {
    if (!itemFrame || !spec.itemAtlas || !itemContent || !spec.itemGeometry) return;
    drawSprite(ctx, spec.itemAtlas!, itemFrame, itemContent);
    if (guides.content) strokeRect(ctx, itemContent, COLORS.itemBox, [2, 2]);
  };

  if (bodyOnTop) {
    drawItem();
    drawBody();
  } else {
    drawBody();
    drawItem();
  }

  // 参考标记（画在图像之上，否则会被身体盖住）
  //
  // 地面线画在**宿主原点**上：原点就是角色脚下（`RoleDisplay` 把宿主 UITransform 的锚点设成
  // 0.5/0），所以「轮廓底边和这条线重合」= 站得住。以前这条线跟着裸模自己的轮廓底边走，
  // 裸模沉下去时线也沉，等于把判据交回给被测对象。
  if (guides.feet) {
    ctx.save();
    ctx.strokeStyle = COLORS.ground;
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(rect.x, Math.round(origin[1]) + 0.5);
    ctx.lineTo(rect.x + rect.w, Math.round(origin[1]) + 0.5);
    ctx.stroke();
    ctx.restore();
  }
  if (guides.frame && spec.body && spec.body.colliderWidth > 0) {
    const { colliderWidth, colliderHeight, colliderOffset } = spec.body;
    strokeRect(
      ctx,
      {
        x: origin[0] + (colliderOffset[0] - colliderWidth / 2) * k,
        y: origin[1] - (colliderOffset[1] + colliderHeight / 2) * k,
        w: colliderWidth * k,
        h: colliderHeight * k,
      },
      COLORS.collider,
      [],
      1.5,
    );
  }
  if (guides.hands && roleSolidRect) {
    const hx = roleSolidRect.w * 0.1;
    cross(ctx, [roleSolidRect.x + hx, roleSolidRect.y + roleSolidRect.h * 0.48], COLORS.hand, 6, 1.5);
    cross(ctx, [roleSolidRect.x + roleSolidRect.w - hx, roleSolidRect.y + roleSolidRect.h * 0.48], COLORS.hand, 6, 1.5);
  }
  if (guides.origin) cross(ctx, origin, COLORS.originCross, 8, 1);
  if (solidOfItem && itemFrame && spec.itemGeometry) {
    // 装备自身轮廓（很淡），方便看「柄在哪、刃朝哪」
    const box = solidOf(solidOfItem, itemFrame, origin, itemPos, spec.itemGeometry.outScale, k);
    if (box) strokeRect(ctx, box, "rgba(120,200,255,0.28)", [3, 3]);
  }

  ctx.restore();

  // 边框（选中态在格子外沿，避免被 clip 掉一半）
  strokeRect(ctx, rect, spec.selected ? COLORS.cellSelected : spec.hovered ? COLORS.cellHover : COLORS.cellBorder, [], spec.selected ? 2 : 1);

  // 方向名 + 当前位置
  ctx.save();
  ctx.font = "12px -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif";
  ctx.textBaseline = "top";
  ctx.fillStyle = spec.selected ? COLORS.textActive : COLORS.text;
  ctx.fillText(`${spec.index + 1} · ${dirName}`, rect.x + 8, rect.y + 6);
  if (spec.itemGeometry) {
    const pos = spec.itemGeometry.outPositions[spec.index] ?? [0, 0];
    /**
     * 位置超出「一格的可见范围」时标琥珀：那意味着这一格里的东西已经跑到格子外面
     * （`up` 方向曾存着 `y = 199.7`，格子里是空的，看起来像「这一格没有裸模」）。
     * 数字是唯一能把这件事说清楚的地方 —— 画面上它就是不在，没有别的线索。
     */
    const span = rect.w / k;
    const offGrid = Math.abs(pos[0]) > span || Math.abs(pos[1]) > span;
    ctx.fillStyle = offGrid ? COLORS.textWarn : "rgba(150,164,180,0.75)";
    ctx.textAlign = "right";
    ctx.fillText(offGrid ? `${pos[0].toFixed(1)}, ${pos[1].toFixed(1)} 出格` : `${pos[0].toFixed(1)}, ${pos[1].toFixed(1)}`, rect.x + rect.w - 8, rect.y + 6);
    ctx.textAlign = "left";
  }
  // 裸模脚底离地面多少（正 = 悬空，负 = 陷进地里）
  //
  // 这是「锚点在脚下没有」的数字化判据：0 附近才对，差 30 就是这一格整件沉了半个身子。
  if (roleSolidRect) {
    const delta = (origin[1] - (roleSolidRect.y + roleSolidRect.h)) / k;
    ctx.textBaseline = "bottom";
    ctx.fillStyle = Math.abs(delta) > 2 ? COLORS.feetBad : COLORS.feetOk;
    ctx.fillText(`脚底 ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}`, rect.x + 8, rect.y + rect.h - 6);
  }
  ctx.restore();
}

/**
 * 计算 8 宫格布局
 *
 * 4 列 × 2 行，格子正方形、随容器宽度自适应；返回每格的矩形与宿主原点。
 * 宿主原点放在格子中线偏下（角色的脚在下方，偏上会顶到格子边）。
 */
export function layoutCells(width: number, gap = 8, padding = 10): { cells: ScreenRect[]; cellSize: number; height: number } {
  const usable = width - padding * 2 - gap * 3;
  const cellSize = Math.max(120, Math.floor(usable / 4));
  const cellH = cellSize;
  const height = padding * 2 + cellH * 2 + gap;
  const cells: ScreenRect[] = [];
  for (let index = 0; index < 8; index++) {
    const col = index % 4;
    const row = Math.floor(index / 4);
    cells.push({
      x: padding + col * (cellSize + gap),
      y: padding + row * (cellH + gap),
      w: cellSize,
      h: cellH,
    });
  }
  return { cells, cellSize, height };
}

/**
 * 格子内的宿主原点（中线偏下）
 *
 * 0.56 是按「身体以画布中心压着原点」定的老位置；现在裸模真的**站在**原点上，
 * 头顶到地面有 71 个单位、举起来的武器还能再高 20，原点再往下挪一点才不至于顶到格子边。
 * 这一处只影响构图，拖动与命中都读同一个函数，不会错位。
 */
export function originOfCell(cell: ScreenRect): Vec2 {
  return [cell.x + cell.w / 2, cell.y + cell.h * 0.62];
}
