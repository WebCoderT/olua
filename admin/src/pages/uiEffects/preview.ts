/**
 * 特效预览（#594 升级特效以裸模正面站立第一帧为参考；#634 掉落光效以掉落物图标为参考）
 *
 * 复用装备对齐工作台的图集机制（`equipAlign/atlas` 的 plist 解析 + `equipAlign/assets`
 * 的素材读取 —— 那边为什么单开一个文件绕过审计规则，见它的头注释）。
 *
 * 参考层按 key 分两族（`previewKindOf`）：
 *
 * | 族 | key | 图集（两端约定） | 参考层 |
 * |---|---|---|---|
 * | 升级特效 | `upgrade` | `effect/<key>/<key>` | 裸模（脚下 = 原点，画布中心按对齐清单微调） |
 * | 掉落光效 | `light-1`…`light-6` | `effect/light/<key>` | 掉落物图标 40×40（与图标**同心**，光柱画在下层） |
 *
 * 两族的共同口径：**特效节点中心 = 原点 + (offsetX, offsetY)**（y 向上，与客户端
 * `createUpgradeEffect` / `createEquipmentLight` 的摆位语义一致），缩放 / 旋转 / 时长都来自
 * **表单当前值** —— 运营改一个数，预览立刻跟着动，不用先保存。
 */

import type { Atlas, SpriteFrameInfo } from "../equipAlign/atlas";
import { frameNameOf, isBlankFrame } from "../equipAlign/atlas";
import { loadAtlas, loadInAtlas } from "../equipAlign/assets";
import catalogJson from "../../data/equip-align.catalog.json";

/** 对齐清单里男裸模那行（只取它的图集路径与画布中心微调） */
const ROLE_CATALOG = (catalogJson as unknown as {
  role: Array<{ id: string; atlas: string; outPositions: number[][]; outScale: number }>;
}).role;

/** 正面 = 朝向表下标 4（up / right_up / right / right_down / **down** / …，见 equipAlign/model） */
const FRONT_DIRECTION_INDEX = 4;

/** 掉落物图标尺寸（与客户端 `configs/layout/hud.dropItemLayout.iconSize` 一致，只做比例参照） */
const DROP_ICON_SIZE = 40;

/** 预览族：参考层是「人」还是「地上的掉落物」 */
export type PreviewKind = "role" | "dropItem";

/** 一个特效 key 属于哪一族（掉落光效的 key 从 #634 起就是素材名 `light-<编号>`） */
export function previewKindOf(effectKey: string): PreviewKind {
  return effectKey.startsWith("light-") ? "dropItem" : "role";
}

/** 裸模图集路径（对齐清单 role[0] = 男裸模 `role/boy`；资源根由页面传） */
export function roleAtlasPath(): string {
  return ROLE_CATALOG[0]?.atlas ?? "role/boy";
}

/** 裸模画布中心相对脚下原点的微调（outPositions 的正面那项） */
function roleCanvasCenter(): [number, number] {
  const role = ROLE_CATALOG[0];
  const pos = role?.outPositions?.[FRONT_DIRECTION_INDEX];
  return pos && pos.length === 2 ? [pos[0], pos[1]] : [0, 0];
}

/**
 * 特效图集路径（两端约定，路径不在服务端配置里 —— 存了就会有人改它）
 *
 * · 升级特效：`effect/<key>/<key>.plist`（一个特效一个目录）
 * · 掉落光效：`effect/light/<key>.plist`（六档共用 `effect/light` 目录，key 即素材名）
 */
export function effectAtlasPath(key: string): string {
  return previewKindOf(key) === "dropItem" ? `effect/light/${key}` : `effect/${key}/${key}`;
}

/** 一次加载预览要用的图集（参考层 + 特效动画帧；掉落光效不需要裸模） */
export async function loadPreviewAtlases(resRoot: string, effectKey: string): Promise<{ role: Atlas | null; effect: Atlas }> {
  const effect = loadInAtlas(resRoot, effectAtlasPath(effectKey));
  if (previewKindOf(effectKey) === "dropItem") return { role: null, effect: await effect };
  // 裸模是**站立图集**（`role/boy` → `role/boy/stand/stand`，带 stand 子目录），
  // 用 loadAtlas；特效是循环动画图集（无子目录），用 loadInAtlas —— 两种拼法不能混
  const [role, loaded] = await Promise.all([loadAtlas(resRoot, roleAtlasPath()), effect]);
  return { role, effect: loaded };
}

/** 裸模正面站立第一帧（`d4_00.png`；缺帧回退 d0，再没有就 null） */
export function roleFrontFrame(role: Atlas): SpriteFrameInfo | null {
  return role.frames.get(frameNameOf(FRONT_DIRECTION_INDEX, 0)) ?? role.frames.get(frameNameOf(0, 0)) ?? null;
}

/** 特效的帧序列（按帧名末尾数字升序；与客户端 FrameOrder 同一条排序口径；空帧剔除） */
export function effectFrameNames(effect: Atlas): string[] {
  return Array.from(effect.frames.keys())
    .filter((name) => {
      const frame = effect.frames.get(name);
      return !!frame && !isBlankFrame(frame);
    })
    .map((name) => ({ name, index: Number((name.match(/(\d+)\.?[a-zA-Z]*$/) ?? [])[1] ?? 0) }))
    .sort((a, b) => a.index - b.index)
    .map((item) => item.name);
}

export interface PreviewOptions {
  /** 表单当前值（未保存也生效 —— 预览跟着输入走） */
  offsetX: number;
  offsetY: number;
  scaleX: number;
  scaleY: number;
  rotate: number;
  /** 当前播到第几帧（下标进 effectFrameNames 的结果） */
  frameIndex: number;
}

/** 画布尺寸（固定大小：升级特效按裸模 1:1 画，偏移 ±2000 时允许画出界 = 直觉上「甩出去了」） */
export const PREVIEW_SIZE = { width: 360, height: 460 };

/**
 * 掉落光效的画布尺寸：比升级特效大一圈 —— 光柱素材本身就是 400×400 画布，
 * 1:1 铺开才看得出「它相对 40×40 的图标有多大」（这正是运营要调的东西）
 */
export const DROP_PREVIEW_SIZE = { width: 460, height: 520 };

/** 画布尺寸按族取 */
export function previewSizeOf(effectKey: string): { width: number; height: number } {
  return previewKindOf(effectKey) === "dropItem" ? DROP_PREVIEW_SIZE : PREVIEW_SIZE;
}

/** 脚下原点在画布上的位置（居中，脚底留一点边） */
const ORIGIN: [number, number] = [PREVIEW_SIZE.width / 2, PREVIEW_SIZE.height - 60];

/** 掉落光效的原点 = 画布正中心（光柱以它为中心向四周铺开，四周留 60 边看得到溢出） */
const DROP_ORIGIN: [number, number] = [DROP_PREVIEW_SIZE.width / 2, DROP_PREVIEW_SIZE.height / 2];

/**
 * 画一帧预览：按族分发（参考层不同，但特效那一层的变换公式是同一套）
 *
 * @param kind 预览族（由 key 决定，`previewKindOf`）
 * @param role 裸模图集（掉落光效传 null）
 */
export function drawPreview(
  ctx: CanvasRenderingContext2D,
  kind: PreviewKind,
  role: Atlas | null,
  effect: Atlas | null,
  frameNames: string[],
  options: PreviewOptions,
): void {
  if (kind === "dropItem") drawDropLightPreview(ctx, effect, frameNames, options);
  else drawRolePreview(ctx, role, effect, frameNames, options);
}

/**
 * 画一帧升级特效预览：裸模正面站立 + 特效叠放
 *
 * 特效的变换与客户端 `Sprite` 的语义一一对齐：节点中心 = 原点 + 偏移（y 向上）、
 * 缩放按横纵各自乘、旋转顺时针（度）；帧内容按 `spriteOffset` 回到原画布里的位置
 * （与客户端「裁剪帧按 offset 还原」同一套公式，见 equipAlign/model 的 `contentRect`）。
 */
function drawRolePreview(
  ctx: CanvasRenderingContext2D,
  role: Atlas | null,
  effect: Atlas | null,
  frameNames: string[],
  options: PreviewOptions,
): void {
  ctx.clearRect(0, 0, PREVIEW_SIZE.width, PREVIEW_SIZE.height);

  // 地面线（脚下原点的参照，与对齐工作台的 feet 线同一意图）
  ctx.save();
  ctx.strokeStyle = "rgba(148,163,184,0.4)";
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(24, ORIGIN[1] + 0.5);
  ctx.lineTo(PREVIEW_SIZE.width - 24, ORIGIN[1] + 0.5);
  ctx.stroke();
  ctx.restore();

  // 裸模（画布中心按清单微调，脚下贴原点）
  const roleFrame = role ? roleFrontFrame(role) : null;
  if (role && roleFrame) {
    const [cx, cy] = roleCanvasCenter();
    ctx.drawImage(
      role.image,
      roleFrame.rect.x,
      roleFrame.rect.y,
      roleFrame.rect.w,
      roleFrame.rect.h,
      ORIGIN[0] + cx - roleFrame.rect.w / 2,
      ORIGIN[1] - cy - roleFrame.rect.h / 2,
      roleFrame.rect.w,
      roleFrame.rect.h,
    );
  }

  drawEffectFrame(ctx, effect, frameNames, options, ORIGIN);
}

/**
 * 画一帧掉落光效预览：**先画光柱、再画图标占位框** —— 与客户端同一个层级
 * （光柱是掉落物的第一个子节点，画在图标下层，图标始终清晰可辨）
 *
 * 图标用虚线方框占位而不是真素材：这一档要调的是「光柱相对图标多大、偏到哪」，
 * 40×40 的方框足以给出比例，还不用为了一张参考图去拉资源（素材缺失时预览照样能用）。
 */
function drawDropLightPreview(
  ctx: CanvasRenderingContext2D,
  effect: Atlas | null,
  frameNames: string[],
  options: PreviewOptions,
): void {
  ctx.clearRect(0, 0, DROP_PREVIEW_SIZE.width, DROP_PREVIEW_SIZE.height);

  // 地面线：图标下沿（掉落物摆在地面点上，图标中心就是那个点）
  const groundY = DROP_ORIGIN[1] + DROP_ICON_SIZE / 2;
  ctx.save();
  ctx.strokeStyle = "rgba(148,163,184,0.35)";
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(16, groundY + 0.5);
  ctx.lineTo(DROP_PREVIEW_SIZE.width - 16, groundY + 0.5);
  ctx.stroke();
  ctx.restore();

  drawEffectFrame(ctx, effect, frameNames, options, DROP_ORIGIN);

  // 图标占位（画在光柱之上）
  const half = DROP_ICON_SIZE / 2;
  ctx.save();
  ctx.fillStyle = "rgba(15,23,42,0.82)";
  ctx.fillRect(DROP_ORIGIN[0] - half, DROP_ORIGIN[1] - half, DROP_ICON_SIZE, DROP_ICON_SIZE);
  ctx.strokeStyle = "rgba(148,163,184,0.75)";
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.strokeRect(DROP_ORIGIN[0] - half + 0.5, DROP_ORIGIN[1] - half + 0.5, DROP_ICON_SIZE - 1, DROP_ICON_SIZE - 1);
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(148,163,184,0.95)";
  ctx.font = "10px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("图标", DROP_ORIGIN[0], DROP_ORIGIN[1]);
  ctx.restore();
}

/** 特效那一层（两族共用：节点中心 = 原点 + 偏移，缩放 / 旋转 / 帧内容还原同一套公式） */
function drawEffectFrame(
  ctx: CanvasRenderingContext2D,
  effect: Atlas | null,
  frameNames: string[],
  options: PreviewOptions,
  origin: [number, number],
): void {
  if (!effect || frameNames.length === 0) return;
  const name = frameNames[options.frameIndex % frameNames.length];
  const frame = effect.frames.get(name);
  if (!frame) return;
  const centerX = origin[0] + options.offsetX;
  const centerY = origin[1] - options.offsetY;
  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.rotate((options.rotate * Math.PI) / 180);
  ctx.scale(options.scaleX, options.scaleY);
  ctx.drawImage(
    effect.image,
    frame.rect.x,
    frame.rect.y,
    frame.rect.w,
    frame.rect.h,
    frame.offset.x - frame.rect.w / 2,
    -frame.offset.y - frame.rect.h / 2,
    frame.rect.w,
    frame.rect.h,
  );
  ctx.restore();
}
