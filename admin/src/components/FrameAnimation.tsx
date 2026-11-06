import { useEffect, useRef, useState } from "react";
import { GAME_RES_ROOT, Lightbox, Zoomable, loadImage } from "./GameImage";

/**
 * 帧动画播放（#732）
 *
 * 与 `GameFrame`（首帧缩略图）同一套素材口径：`/game-resources` 同源直读
 * `目录/同名.plist + .png`（TexturePacker format 2 / 3 两套方言），区别是这里解析
 * **全部帧**并循环播放 —— 装备边框 / 详情背景这类动画素材，看首帧判断不了动起来的效果。
 *
 * ## 与客户端播放口径对齐（管理端预览要播得跟游戏里一致）
 * - **帧序 = plist 文档序**：Cocos `SpriteAtlas.getSpriteFrames()` 就是这个顺序，
 *   客户端 `loadFramesFromAtlas` 不重排；帧名里的 `_0000` 序号保证文档序即播放序；
 * - **空帧过滤**：裁剪面积 ≤ 4 px² 的占位空图跳过（与客户端 `BLANK_FRAME_MAX_AREA` 同阈值，
 *   不过滤会夹空白闪帧）；
 * - **帧率 10 fps**：与 `equipmentBorderLayout` / `equipmentDetailBackgroundLayout` 同档；
 * - **trim 偏移**：帧按 `spriteSourceSize`（在原始画布里的位置）摆放，画布取全帧最大
 *   原始尺寸 —— 裁剪过的帧不会左右抖（当前边框 / 背景素材没有裁剪，属防御性实现）。
 *
 * ## 性能
 * 一屏最多 20 个播放器（清单分页），不各起一条 `requestAnimationFrame`：
 * 模块级一个共享节拍器，组件挂载订阅、卸载退订，最后一个退订时停表。
 * 素材按路径缓存（plist 解析 + 图片解码只做一次，列表翻页来回不打网络）。
 */

/** 空帧判据（与客户端 configs/animation.BLANK_FRAME_MAX_AREA 同值）：裁剪面积不超过它的帧是占位空图 */
const BLANK_FRAME_MAX_AREA = 4;

/** 一帧：图集里的打包区域 + 摆放信息（rotated = 打包时转了 90°） */
export type AtlasFrame = {
  x: number;
  y: number;
  w: number;
  h: number;
  rotated: boolean;
  /** 裁剪帧在原始画布里的位置（未裁剪 = 0,0；y 向下，与 plist 口径一致） */
  ox: number;
  oy: number;
  /** 原始画布尺寸（未裁剪 = 打包区域尺寸） */
  sw: number;
  sh: number;
};

export type AtlasAnimation = { image: HTMLImageElement; frames: AtlasFrame[] };

const animationCache = new Map<string, Promise<AtlasAnimation | null>>();

/** plist dict 的取值小工具（与 GameImage.parseFirstFrame 同一套遍历方式，见那里的注释） */
function plistHelpers() {
  const subDict = (parent: Element, name: string): Element | null => {
    for (const child of Array.from(parent.children)) {
      if (child.tagName === "key" && child.textContent === name) {
        let el = child.nextElementSibling;
        while (el && el.tagName !== "dict") el = el.nextElementSibling;
        return el;
      }
    }
    return null;
  };
  const valueOf = (parent: Element, name: string): string => {
    for (const child of Array.from(parent.children)) {
      if (child.tagName === "key" && child.textContent === name) {
        return child.nextElementSibling?.textContent ?? "";
      }
    }
    return "";
  };
  return { subDict, valueOf };
}

/** "{{x,y},{w,h}" 里抠出数字 */
function rectNumbers(text: string): number[] {
  return (text.match(/-?\d+/g) ?? []).slice(0, 4).map(Number);
}

/**
 * 解析 plist 里的**全部帧**（文档序）：format 3 读 textureRect/textureRotated，
 * format 2 读 frame/rotated；trim 信息读 spriteSourceSize（缺省按未裁剪处理）。
 * 解析不出任何帧返回 null（调用方落「无图」占位）。
 */
export function parseAtlasFrames(xml: string): AtlasFrame[] | null {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const root = doc.getElementsByTagName("dict")[0];
  if (!root) return null;
  const { subDict, valueOf } = plistHelpers();
  const framesDict = subDict(root, "frames");
  if (!framesDict) return null;
  const frames: AtlasFrame[] = [];
  for (const node of Array.from(framesDict.children)) {
    if (node.tagName !== "dict") continue; // key 与 dict 交替，只处理 dict（即按文档序取帧）
    const rotated = valueOf(node, "textureRotated") === "true" || valueOf(node, "rotated") === "true";
    let rect = rectNumbers(valueOf(node, "textureRect"));
    if (rect.length < 4) rect = rectNumbers(valueOf(node, "frame"));
    if (rect.length < 4 || rect[2] <= 0 || rect[3] <= 0) continue;
    // trim：spriteSourceSize 是裁剪区域在原始画布里的位置与尺寸；老图集没有这组字段 = 未裁剪
    let placed = rectNumbers(valueOf(node, "spriteSourceSize"));
    if (placed.length < 4) placed = [0, 0, rect[2], rect[3]];
    let source = rectNumbers(valueOf(node, "sourceSize"));
    if (source.length < 2) source = [placed[2], placed[3]];
    frames.push({
      x: rect[0],
      y: rect[1],
      w: rect[2],
      h: rect[3],
      rotated,
      ox: placed[0],
      oy: placed[1],
      sw: source[0],
      sh: source[1],
    });
  }
  // 空帧过滤（与客户端同口径）：占位空图 1×1 / 2×2 进了图集，不滤会闪帧
  const solid = frames.filter((frame) => frame.w * frame.h > BLANK_FRAME_MAX_AREA);
  return solid.length > 0 ? solid : null;
}

/**
 * 载入一份图集动画（模块级缓存）：路径拼法两级尝试（`目录/同名` 优先、退回「路径即基名」），
 * 与 `GameFrame.loadFirstFrame` 同一套 —— 边框 `effect/border/border-30123` 与背景
 * `effect/background/bg-16000` 都是「`目录/同名` 优先、退回「路径即基名」」两级尝试。全都不存在返回 null。
 */
export function loadAtlasAnimation(atlasPath: string): Promise<AtlasAnimation | null> {
  const base = atlasPath.replace(/^\/+|\/+$/g, "");
  const cached = animationCache.get(base);
  if (cached) return cached;
  const name = base.split("/").pop() ?? base;
  const task = (async () => {
    for (const candidate of [`${base}/${name}`, base]) {
      try {
        const response = await fetch(`${GAME_RES_ROOT}/${candidate}.plist`, { cache: "force-cache" });
        if (!response.ok) continue;
        const frames = parseAtlasFrames(await response.text());
        if (!frames) continue;
        const image = await loadImage(`${GAME_RES_ROOT}/${candidate}.png`);
        return { image, frames };
      } catch {
        /* 这个候选不行，试下一个 */
      }
    }
    return null;
  })();
  animationCache.set(base, task);
  return task;
}

//#region 共享节拍器（一个 rAF 派发全部播放器）

type Tick = (now: number) => void;
const subscribers = new Set<Tick>();
let rafId = 0;

function onFrame(now: number): void {
  rafId = 0;
  for (const tick of subscribers) tick(now);
  if (subscribers.size > 0) rafId = requestAnimationFrame(onFrame);
}

function subscribe(tick: Tick): () => void {
  subscribers.add(tick);
  if (!rafId) rafId = requestAnimationFrame(onFrame);
  return () => {
    subscribers.delete(tick);
    if (subscribers.size === 0 && rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  };
}

//#endregion

/**
 * 把一帧画上画布：contain 缩进 canvas（k 已由调用方按全帧最大原始尺寸算好），
 * 裁剪帧摆到 (ox, oy)。像素风不平滑，与缩略图同口径。
 */
function drawFrame(canvas: HTMLCanvasElement, image: HTMLImageElement, frame: AtlasFrame, k: number): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const dw = Math.max(1, Math.round(frame.w * k));
  const dh = Math.max(1, Math.round(frame.h * k));
  if (frame.rotated) {
    // 打包时转了 90°：先把画布坐标系转回去再画（转后坐标系里 x 沿原 y 轴，trim 偏移随之互换；
    // 当前素材没有 rotated + trim 的组合，这里按整块区域画，偏移沿用 GameFrame 的处理）
    ctx.translate(canvas.width, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(image, frame.x, frame.y, frame.w, frame.h, 0, 0, dw, dh);
  } else {
    ctx.drawImage(image, frame.x, frame.y, frame.w, frame.h, frame.ox * k, frame.oy * k, dw, dh);
  }
}

/**
 * 帧动画播放器：atlas 是 resources 相对目录（同 GameFrame 的 atlas 入参）。
 * 默认自动循环播放；点击可在灯箱里播大图（同一份缓存帧，不是把小画布拉大）。
 */
export function FrameAnimation({
  atlas,
  alt,
  size = 40,
  frameRate = 10,
  zoomable = true,
}: {
  atlas: string;
  alt?: string;
  /** 显示方框边长（contain；多帧尺寸不一致时画布取全帧最大者，不跳画布） */
  size?: number;
  /** 每秒帧数（与客户端同素材的播放帧率保持一致，边框 / 背景都是 10） */
  frameRate?: number;
  zoomable?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    let animation: AtlasAnimation | null = null;
    let unsubscribe: (() => void) | null = null;
    let lastSlot = -1;
    void loadAtlasAnimation(atlas).then((loaded) => {
      if (cancelled) return;
      if (!loaded) {
        setFailed(true);
        return;
      }
      animation = loaded;
      const canvas = canvasRef.current;
      if (!canvas) return;
      // 画布按全帧最大原始尺寸 contain 缩进方框：不同帧尺寸有差异时节点不跳
      const maxW = Math.max(...loaded.frames.map((frame) => (frame.rotated ? frame.sh : frame.sw)));
      const maxH = Math.max(...loaded.frames.map((frame) => (frame.rotated ? frame.sw : frame.sh)));
      const k = Math.min(size / maxW, size / maxH);
      canvas.width = Math.max(1, Math.round(maxW * k));
      canvas.height = Math.max(1, Math.round(maxH * k));
      const frameMs = Math.max(1, 1000 / Math.max(1, frameRate));
      const tick: Tick = (now: number) => {
        if (!animation) return;
        const slot = Math.floor(now / frameMs) % animation.frames.length;
        if (slot === lastSlot) return; // 帧没换就不重画（一屏 20 个播放器时省一大半绘制）
        lastSlot = slot;
        drawFrame(canvas, animation.image, animation.frames[slot], k);
      };
      unsubscribe = subscribe(tick);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [atlas, size, frameRate]);

  if (!atlas || failed) {
    return (
      <span
        aria-hidden="true"
        className="inline-flex items-center justify-center rounded border border-slate-800 bg-slate-900/60 text-[10px] text-slate-600"
        style={{ width: size, height: size }}
      >
        无图
      </span>
    );
  }

  const canvas = (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={alt ?? ""}
      className="rounded border border-slate-800 bg-slate-900/60"
      style={{ imageRendering: "pixelated" }}
    />
  );
  if (!zoomable) return canvas;
  return (
    <>
      <Zoomable alt={alt} onZoom={() => setZoom(true)}>
        {canvas}
      </Zoomable>
      {zoom ? <AnimationLightbox atlas={atlas} alt={alt} frameRate={frameRate} onClose={() => setZoom(false)} /> : null}
    </>
  );
}

/** 灯箱里的大图动画：同一份缓存帧按 60vmin 方框重播（打开时才建播放器，关掉即退订） */
function AnimationLightbox({
  atlas,
  alt,
  frameRate,
  onClose,
}: {
  atlas: string;
  alt?: string;
  frameRate: number;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    let lastSlot = -1;
    void loadAtlasAnimation(atlas).then((loaded) => {
      if (cancelled || !loaded) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const maxW = Math.max(...loaded.frames.map((frame) => (frame.rotated ? frame.sh : frame.sw)));
      const maxH = Math.max(...loaded.frames.map((frame) => (frame.rotated ? frame.sw : frame.sh)));
      const k = Math.min(640 / maxW, 640 / maxH, 3);
      canvas.width = Math.max(1, Math.round(maxW * k));
      canvas.height = Math.max(1, Math.round(maxH * k));
      const frameMs = Math.max(1, 1000 / Math.max(1, frameRate));
      const tick = (now: number) => {
        if (!canvas) return;
        const slot = Math.floor(now / frameMs) % loaded.frames.length;
        if (slot === lastSlot) return;
        lastSlot = slot;
        drawFrame(canvas, loaded.image, loaded.frames[slot], k);
      };
      unsubscribe = subscribe(tick);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [atlas, frameRate]);
  return (
    <Lightbox alt={alt} onClose={onClose}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={alt ?? ""}
        className="max-h-[60vmin] max-w-[60vmin] rounded border border-slate-700 bg-slate-900/60"
        style={{ imageRendering: "pixelated" }}
      />
    </Lightbox>
  );
}
