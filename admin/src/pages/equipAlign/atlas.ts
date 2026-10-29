/**
 * 图集读取：plist 解析 + 帧几何 + 不透明轮廓
 *
 * ===========================================================================
 * 为什么这里要自己解析 plist
 * ===========================================================================
 * 对齐工作台的判据是「这一帧的内容被摆到哪」，而内容的位置**不在 PNG 里**：
 * 图集把每帧裁掉透明边后塞进一张大图，靠 plist 的 `textureRect`（在图集里的位置）、
 * `spriteOffset`（内容中心相对画布中心的偏移）、`spriteSourceSize`（原始画布尺寸）
 * 才能还原。引擎的 `SpriteFrame` 就是这三样，这里照着做一份，页面上画的几何才和游戏里一致。
 *
 * 语义（与 Cocos 一致，已在真机复核过，见 `.workbuddy/verify/report.md`）：
 *   - 节点框 = 画布尺寸（spriteSourceSize），锚点居中；
 *   - 内容中心 = 节点中心 + offset，**offset 的 y 是向上的**；
 *   - 于是屏幕坐标（y 向下）里内容的左上角 = 节点中心 − (内容尺寸/2) + (offsetX, −offsetY)。
 *
 * ===========================================================================
 * 为什么还要读 alpha 轮廓
 * ===========================================================================
 * `textureRect` 的框里混着影子和光晕：`cloth_1` 下向帧的框是 76×85，但 alpha>200 的
 * 真实身体只有 32×78 —— 拿框算手位必然偏到影子边缘。轮廓只能靠读像素得到，
 * 所以这里把 PNG 画到离屏 canvas 上量一遍（同源加载，canvas 不会被污染）。
 */

/** 一帧的几何（全部来自 plist，单位：像素 = 游戏单位） */
export interface SpriteFrameInfo {
  /** 在图集里的裁剪区（textureRect） */
  rect: { x: number; y: number; w: number; h: number };
  /** 原始画布尺寸（spriteSourceSize）：节点框就是这个尺寸 */
  canvas: { w: number; h: number };
  /** 内容中心相对节点中心的偏移（spriteOffset，y 向上） */
  offset: { x: number; y: number };
}

/** 不透明轮廓（相对内容左上角，单位像素） */
export interface SolidBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Atlas {
  image: HTMLImageElement;
  frames: Map<string, SpriteFrameInfo>;
  /** 轮廓缓存：帧名 → 轮廓（null = 整帧透明，等价于空帧） */
  solid: Map<string, SolidBox | null>;
}

/** 判定「不透明」的 alpha 阈值：影子与光晕只有几十，200 以上只剩本体 */
export const OPAQUE_ALPHA = 200;

/** 占位空帧的面积上限（与客户端 `configs/animation.BLANK_FRAME_MAX_AREA` 同口径） */
export const BLANK_FRAME_MAX_AREA = 4;

/** 从 `{a,b}` / `{{a,b},{c,d}}` 这类 plist 字符串里取数字 */
function numbers(value: string | null | undefined): number[] {
  if (!value) return [];
  return (value.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
}

/**
 * 解析 TexturePacker format 3 的 plist
 *
 * 只认 `frames` 一张表、每个帧的四个字段（其余如 aliases / textureRotated 忽略）。
 * 用 DOMParser 而不是正则：帧名里可能有 `.`、`-`，正则切分很容易切错。
 */
export function parseAtlasPlist(xml: string): Map<string, SpriteFrameInfo> {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("plist 解析失败（不是合法 XML）");

  const frames = new Map<string, SpriteFrameInfo>();
  // 顶层 dict 里找 <key>frames</key> 紧跟的那个 dict
  const framesDict = ((): Element | null => {
    for (const key of Array.from(doc.querySelectorAll("key"))) {
      if (key.textContent !== "frames") continue;
      const dict = key.nextElementSibling;
      return dict && dict.tagName === "dict" ? dict : null;
    }
    return null;
  })();
  if (!framesDict) throw new Error("plist 里没有 frames 表");

  // 子节点是 <key>帧名</key><dict>…</dict> 成对出现
  for (const key of Array.from(framesDict.children)) {
    if (key.tagName !== "key") continue;
    const dict = key.nextElementSibling;
    if (!dict || dict.tagName !== "dict") continue;

    const field = (name: string): string | null => {
      for (const child of Array.from(dict.children)) {
        if (child.tagName === "key" && child.textContent === name) return child.nextElementSibling?.textContent ?? null;
      }
      return null;
    };

    const texture = numbers(field("textureRect"));
    // spriteSourceSize 只有两个数（画布宽高），textureRect 是四个（x, y, w, h）——
    // 用同一个「至少四个」的判据会把所有帧都跳过（页面表现为「8 个格子全是空的」）
    const canvas = numbers(field("spriteSourceSize"));
    const offset = numbers(field("spriteOffset"));
    if (texture.length < 4 || canvas.length < 2) continue;

    frames.set(key.textContent ?? "", {
      rect: { x: texture[0], y: texture[1], w: texture[2], h: texture[3] },
      canvas: { w: canvas[0], h: canvas[1] },
      offset: { x: offset[0] ?? 0, y: offset[1] ?? 0 },
    });
  }
  return frames;
}

/** 帧是占位空块（1×1 / 2×2 之类），不参与对齐计算 */
export function isBlankFrame(frame: SpriteFrameInfo): boolean {
  return frame.rect.w * frame.rect.h <= BLANK_FRAME_MAX_AREA;
}

/** 内容在节点框内的左上角（相对节点中心，屏幕坐标 y 向下） */
export function contentTopLeft(frame: SpriteFrameInfo): { x: number; y: number } {
  return {
    x: -frame.rect.w / 2 + frame.offset.x,
    y: -frame.rect.h / 2 - frame.offset.y,
  };
}

/**
 * 量一帧的不透明轮廓
 *
 * 懒加载：只在真正要画参考框/算手位时才量（一屏 8 方向 × 2 层 = 16 帧，每帧几十像素，
 * 全量预量 34 张图 × 32 帧没有意义）。结果按帧名缓存。
 */
export function measureSolid(atlas: Atlas, frameName: string): SolidBox | null {
  if (atlas.solid.has(frameName)) return atlas.solid.get(frameName) ?? null;
  const frame = atlas.frames.get(frameName);
  if (!frame || isBlankFrame(frame)) {
    atlas.solid.set(frameName, null);
    return null;
  }

  const { rect } = frame;
  const canvas = document.createElement("canvas");
  canvas.width = rect.w;
  canvas.height = rect.h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(atlas.image, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, rect.w, rect.h).data;
  } catch {
    // 跨域污染（资源根被改成外域且没带 CORS 头）：不算崩溃，退化成「量不出来」
    atlas.solid.set(frameName, null);
    return null;
  }

  let x0 = rect.w;
  let y0 = rect.h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      if (data[(y * rect.w + x) * 4 + 3] <= OPAQUE_ALPHA) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const box = x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  atlas.solid.set(frameName, box);
  return box;
}

/** 帧名：`d<方向下标>_<帧号>`（客户端 AnimationHelper 同一命名） */
export function frameNameOf(directionIndex: number, frameIndex = 0): string {
  return `d${directionIndex}_${String(frameIndex).padStart(2, "0")}.png`;
}

/**
 * 内观取首帧：图集里按名字排序的第一个**非空**帧（#523）
 *
 * 内观素材是循环动画（`00000.PNG`、`00001.PNG`…，没有方向下标），对齐只需要一帧 ——
 * 同一组图集里各帧的 `spriteSourceSize`（画布）是一样的，所以挑哪一帧都不影响位置语义；
 * 取第一帧是因为它最接近「站定」的姿势，看起来不会像在挥手。
 *
 * 跳过空帧（1×1 占位）：拿它算内容 bbox 会得到 0×0，后面所有「按轮廓对齐」的按钮都会失灵。
 */
export function firstFrameName(atlas: Atlas): string {
  const names = Array.from(atlas.frames.keys()).sort();
  for (const name of names) {
    const frame = atlas.frames.get(name);
    if (frame && !isBlankFrame(frame)) return name;
  }
  return names[0] ?? "";
}
