/**
 * 特效预览（#594：升级特效以裸模正面站立第一帧为参考）
 *
 * 复用装备对齐工作台的图集机制（`equipAlign/atlas` 的 plist 解析 + `equipAlign/assets`
 * 的素材读取 —— 那边为什么单开一个文件绕过审计规则，见它的头注释）。
 *
 * 预览的两层关系与对齐工作台同一条口径：
 * - **裸模站在宿主原点上**（脚下 = 原点，画布中心按对齐清单的 `outPositions` 微调 ——
 *   「画布中心不是脚下」，全 0 会让身体沉到地下）；
 * - **特效节点中心 = 原点 + (offsetX, offsetY)**（y 向上，与客户端
 *   `createUpgradeEffect` 的摆位语义一致），缩放 / 旋转 / 时长都来自**表单当前值** ——
 *   运营改一个数，预览立刻跟着动，不用先保存。
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

/** 裸模图集路径（对齐清单 role[0] = 男裸模 `role/1`；资源根由页面传） */
export function roleAtlasPath(): string {
  return ROLE_CATALOG[0]?.atlas ?? "role/1";
}

/** 裸模画布中心相对脚下原点的微调（outPositions 的正面那项） */
function roleCanvasCenter(): [number, number] {
  const role = ROLE_CATALOG[0];
  const pos = role?.outPositions?.[FRONT_DIRECTION_INDEX];
  return pos && pos.length === 2 ? [pos[0], pos[1]] : [0, 0];
}

/** 特效图集路径（两端约定：`effect/<key>/<key>.plist`，路径不在配置里） */
export function effectAtlasPath(key: string): string {
  return `effect/${key}/${key}`;
}

/** 一次加载预览要用的两张图集（裸模站立 + 特效动画帧） */
export async function loadPreviewAtlases(resRoot: string, effectKey: string): Promise<{ role: Atlas; effect: Atlas }> {
  // 裸模是**站立图集**（`role/1` → `role/1/stand/stand`，带 stand 子目录），
  // 用 loadAtlas；特效是循环动画图集（无子目录），用 loadInAtlas —— 两种拼法不能混
  const [role, effect] = await Promise.all([
    loadAtlas(resRoot, roleAtlasPath()),
    loadInAtlas(resRoot, effectAtlasPath(effectKey)),
  ]);
  return { role, effect };
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

/** 画布尺寸（固定大小，裸模按 1:1 画，特效偏移 ±2000 时允许画出界 = 直觉上「甩出去了」） */
export const PREVIEW_SIZE = { width: 360, height: 460 };

/** 脚下原点在画布上的位置（居中，脚底留一点边） */
const ORIGIN: [number, number] = [PREVIEW_SIZE.width / 2, PREVIEW_SIZE.height - 60];

/**
 * 画一帧预览：裸模正面站立 + 特效叠放
 *
 * 特效的变换与客户端 `Sprite` 的语义一一对齐：节点中心 = 原点 + 偏移（y 向上）、
 * 缩放按横纵各自乘、旋转顺时针（度）；帧内容按 `spriteOffset` 回到原画布里的位置
 * （与客户端「裁剪帧按 offset 还原」同一套公式，见 equipAlign/model 的 `contentRect`）。
 */
export function drawPreview(
  ctx: CanvasRenderingContext2D,
  role: Atlas,
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
  const roleFrame = roleFrontFrame(role);
  if (roleFrame) {
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

  // 特效（帧内容按 spriteOffset 还原到节点画布里，再整体缩放 / 旋转）
  if (!effect || frameNames.length === 0) return;
  const name = frameNames[options.frameIndex % frameNames.length];
  const frame = effect.frames.get(name);
  if (!frame) return;
  const centerX = ORIGIN[0] + options.offsetX;
  const centerY = ORIGIN[1] - options.offsetY;
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
