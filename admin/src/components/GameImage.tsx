import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * 游戏资源缩略图（列表页「图」列用）
 *
 * 两类素材两种渲染：
 * - **单图图标**（`icon` 字段：装备 / 药品 / 物品 / 怪物 / 技能 / 状态 / 时装）→ `<img>` 直出；
 * - **图集动画**（称号 / 战魂的 `animation`、NPC 的 `src`：目录 + 同名 .plist/.png）→
 *   解析 plist 取**第一帧**画到 canvas 上。
 *
 * URL 根与装备对齐工作台同源（dev 由 vite 中间件直读 client/assets/resources，
 * prod 由 nginx 反代 game 容器），页面代码不为环境分支。
 * 图片路径一律查 `game-data.generated.ts`（与页面上的名字同一来源），加载失败或不
 * 存在该字段就给「无图」占位 —— 不让一格 404 把整张表撑破。
 */

export const GAME_RES_ROOT = "/game-resources";

/** resources 相对路径（不含扩展名）→ 同源 PNG 地址 */
export function gameResUrl(path: string): string {
  return `${GAME_RES_ROOT.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}.png`;
}

/** 「无图」占位：浅格线 + 灰字，宽高与真图一致，列表不跳动 */
function NoImage({ size }: { size: number }) {
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

const imgClass = "rounded border border-slate-800 bg-slate-900/60 object-contain";

/**
 * 点击缩略图放大查看的灯箱
 *
 * portal 到 body：列表页的表格/侧栏都有自己的 overflow 裁剪，留在原处会被裁掉。
 * 点遮罩或按 Esc 关闭（管理端没有移动端诉求，不做的手势）。
 */
function Lightbox({ alt, onClose, children }: { alt?: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt ? `${alt}（放大查看）` : "放大查看"}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-8"
      onClick={onClose}
    >
      <div
        className="flex max-h-full max-w-full flex-col items-center rounded-lg border border-slate-700 bg-slate-900 p-4 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        {children}
        {alt ? <p className="mt-3 max-w-[60vmin] break-all text-center text-sm text-slate-300">{alt}</p> : null}
      </div>
    </div>,
    document.body,
  );
}

/** 包住缩略图的按钮：点开放大；stopPropagation 防止触发行/表格上的其它点击行为 */
function Zoomable({
  alt,
  onZoom,
  children,
}: {
  alt?: string;
  onZoom: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title="点击放大"
      aria-label={alt ? `放大查看 ${alt}` : "放大查看"}
      className="cursor-zoom-in transition hover:ring-2 hover:ring-indigo-400/60"
      onClick={(event) => {
        event.stopPropagation();
        onZoom();
      }}
    >
      {children}
    </button>
  );
}

/** 单图图标：path 为空或 404 时显示占位 */
export function GameIcon({ path, alt, size = 40 }: { path: string; alt?: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(false);
  useEffect(() => setFailed(false), [path]);
  if (!path || failed) return <NoImage size={size} />;
  return (
    <>
      <Zoomable alt={alt} onZoom={() => setZoom(true)}>
        <img
          src={gameResUrl(path)}
          alt={alt ?? ""}
          loading="lazy"
          onError={() => setFailed(true)}
          className={imgClass}
          style={{ width: size, height: size, imageRendering: "pixelated" }}
        />
      </Zoomable>
      {zoom ? (
        <Lightbox alt={alt} onClose={() => setZoom(false)}>
          <img
            src={gameResUrl(path)}
            alt={alt ?? ""}
            className="max-h-[60vmin] max-w-[60vmin] object-contain"
            style={{ imageRendering: "pixelated" }}
          />
        </Lightbox>
      ) : null}
    </>
  );
}

/** 图集第一帧的裁剪信息（rect 是图集里的打包区域；rotated = 打包时转了 90°） */
type FirstFrame = { image: HTMLImageElement; x: number; y: number; w: number; h: number; rotated: boolean };

const frameCache = new Map<string, Promise<FirstFrame | null>>();

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`读取 ${url} 失败`));
    img.src = url;
  });
}

/** "{{x,y},{w,h}" 里抠出数字（后面可能还有第三段 {dx,dy}，只取前四个用） */
function rectNumbers(text: string): number[] {
  return (text.match(/-?\d+/g) ?? []).slice(0, 4).map(Number);
}

/**
 * 从 plist（TexturePacker format 2 / 3 两套方言）里取**文档序第一帧**：
 * format 3 读 textureRect/textureRotated（NPC），format 2 读 frame/rotated（称号 / 战魂）。
 * 第一帧通常没转，但转了也要画对。
 */
function parseFirstFrame(xml: string): { x: number; y: number; w: number; h: number; rotated: boolean } | null {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const root = doc.getElementsByTagName("dict")[0];
  if (!root) return null;
  // plist dict 的子节点是 key/value 交替：value 可能是 <dict>（frames）也可能是 <string>（帧属性）
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
  /** 帧属性取值：紧跟 key 的那个兄弟节点就是值（<string>），不能跳着找 dict */
  const valueOf = (parent: Element, name: string): string => {
    for (const child of Array.from(parent.children)) {
      if (child.tagName === "key" && child.textContent === name) {
        return child.nextElementSibling?.textContent ?? "";
      }
    }
    return "";
  };
  const frames = subDict(root, "frames");
  if (!frames) return null;
  const first = Array.from(frames.children).find((el) => el.tagName === "dict");
  if (!first) return null;
  const text = (d: Element, key: string) => valueOf(d, key);
  const rotated = text(first, "textureRotated") === "true" || text(first, "rotated") === "true";
  let rect = rectNumbers(text(first, "textureRect"));
  if (rect.length < 4) rect = rectNumbers(text(first, "frame"));
  if (rect.length < 4 || rect[2] <= 0 || rect[3] <= 0) return null;
  return { x: rect[0], y: rect[1], w: rect[2], h: rect[3], rotated };
}

/**
 * 图集首帧加载（模块级缓存：列表一屏几十行，同目录只解析一次）。
 * 路径拼法两级尝试：`目录/同名`（titles/sfx_13009 → titles/sfx_13009/sfx_13009.png）
 * 优先，退回「路径即基名」（clothes/in/005 → clothes/in/005.png）；plist 都没有
 * 就当单图整张缩放 —— 称号 / 战魂 / NPC 三种来源都罩得住。
 */
function loadFirstFrame(atlasPath: string): Promise<FirstFrame | null> {
  const base = atlasPath.replace(/^\/+|\/+$/g, "");
  const cached = frameCache.get(base);
  if (cached) return cached;
  const name = base.split("/").pop() ?? base;
  const task = (async () => {
    for (const candidate of [`${base}/${name}`, base]) {
      try {
        const response = await fetch(`${GAME_RES_ROOT}/${candidate}.plist`, { cache: "force-cache" });
        if (!response.ok) continue;
        const rect = parseFirstFrame(await response.text());
        const image = await loadImage(`${GAME_RES_ROOT}/${candidate}.png`);
        if (rect) return { image, ...rect };
        // plist 解析不出帧：退成整图
        return { image, x: 0, y: 0, w: image.naturalWidth, h: image.naturalHeight, rotated: false };
      } catch {
        /* 这个候选不行，试下一个 */
      }
    }
    try {
      const image = await loadImage(`${GAME_RES_ROOT}/${base}.png`);
      return { image, x: 0, y: 0, w: image.naturalWidth, h: image.naturalHeight, rotated: false };
    } catch {
      return null;
    }
  })();
  frameCache.set(base, task);
  return task;
}

/**
 * 把首帧画到画布上，缩到 target 以内（像素风不平滑，与对齐工作台同口径）。
 * 缩略图和灯箱大图共用：传入的 target 不同而已。
 */
function drawFrameTo(canvas: HTMLCanvasElement, frame: FirstFrame, target: number): void {
  const spriteW = frame.rotated ? frame.h : frame.w;
  const spriteH = frame.rotated ? frame.w : frame.h;
  const fit = Math.min(target / spriteW, target / spriteH);
  const k = Number.isFinite(fit) && fit > 0 ? fit : 1;
  canvas.width = Math.max(1, Math.round(spriteW * k));
  canvas.height = Math.max(1, Math.round(spriteH * k));
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const rw = Math.max(1, Math.round(frame.w * k));
  const rh = Math.max(1, Math.round(frame.h * k));
  if (frame.rotated) {
    // 打包时转了 90°：先把画布坐标系转回去再画打包区域
    ctx.translate(canvas.width, 0);
    ctx.rotate(Math.PI / 2);
  }
  ctx.drawImage(frame.image, frame.x, frame.y, frame.w, frame.h, 0, 0, rw, rh);
}

/**
 * 图集首帧缩略图：atlas 是 resources 相对目录（称号 / 战魂的 animation、NPC 的 src）。
 * 点击可放大查看（大图用同一份缓存首帧重画，不是把 40px 的小画布拉大）。
 */
export function GameFrame({ atlas, alt, size = 40 }: { atlas: string; alt?: string; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    loadFirstFrame(atlas).then((frame) => {
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!frame || !canvas) {
        if (!frame) setFailed(true);
        return;
      }
      // 缩到 size 以内（首帧比格子大很多，超出会撑破表格行高）
      drawFrameTo(canvas, frame, size);
    });
    return () => {
      cancelled = true;
    };
  }, [atlas, size]);
  if (!atlas || failed) return <NoImage size={size} />;
  return (
    <>
      <Zoomable alt={alt} onZoom={() => setZoom(true)}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={alt ?? ""}
          className="rounded border border-slate-800 bg-slate-900/60"
          style={{ imageRendering: "pixelated" }}
        />
      </Zoomable>
      {zoom ? <FrameLightbox atlas={atlas} alt={alt} onClose={() => setZoom(false)} /> : null}
    </>
  );
}

/** 灯箱里的大图：打开时用缓存的首帧按 60vmin 重画一张 */
function FrameLightbox({ atlas, alt, onClose }: { atlas: string; alt?: string; onClose: () => void }) {
  const bigRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadFirstFrame(atlas).then((frame) => {
      if (cancelled || !frame) return;
      const canvas = bigRef.current;
      if (canvas) drawFrameTo(canvas, frame, 640);
    });
    return () => {
      cancelled = true;
    };
  }, [atlas]);
  return (
    <Lightbox alt={alt} onClose={onClose}>
      <canvas
        ref={bigRef}
        role="img"
        aria-label={alt ?? ""}
        className="max-h-[60vmin] max-w-[60vmin] rounded border border-slate-700 bg-slate-900/60"
        style={{ imageRendering: "pixelated" }}
      />
    </Lightbox>
  );
}
