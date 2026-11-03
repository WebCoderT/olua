import { useCallback, useEffect, useRef, useState } from "react";
import { mapPreview } from "../../api";
import type { MapDetail, MapObject, MapSpawnArea } from "../../api";
import { gameResUrl } from "../GameImage";
import { overflowText } from "./bounds";

/**
 * 地图可视化（预览图 + SVG 叠加层 + **刷怪区绘制**）
 *
 * ## 为什么在图上画，而不是再看一张表
 *
 * 这一页的判断几乎都是空间判断：「刷怪区是不是摆到了墙外」「NPC 是不是站在出生点旁边」
 * 「11 张图的区域有没有互相压住」。对着 `(3968, -704) 5888×896` 这种数字在脑子里构图，
 * 看十行就会放弃 —— 而放弃的表现通常是「看起来挺对」，不是报错。
 *
 * ## 两套坐标（页面里最容易看错的地方）
 *
 * - **画布 / 用户看到的是 Tiled 口径**：左上角原点、y 向下，`viewBox` 就是 TMX 像素。
 * - **库里存的是世界坐标**：原点同样是左上角，但 y 轴向上（`cy` 为负）。
 *
 * 换算只有两条式子，且只在提交那一刻发生（`worldBoxOf`）：
 * `cx = x + w/2`、`cy = -(y + h/2)`；反算是 `tiledBoxOf`。
 * 读回来的区域用 `tiledBoxOf` 画，画出去的新框用 `worldBoxOf` 存 —— 一处进、一处出。
 *
 * ## 绘制模式（#667）
 *
 * 打开后指针在图上拖出矩形，松手回调 `onDrawBox`（Tiled 口径）。三条约束都是「防手滑」：
 * 太小的框不提交（`MIN_DRAW_PX`，服务端也会拒）、拖拽期间区域不再响应点击（否则一按就弹窗）、
 * `Esc` 取消并把草稿清掉。`touchAction: none` 是为了拖拽时别触发页面滚动。
 *
 * ## 坐标系之外的两个约定
 *
 * - 线宽用 `vectorEffect="non-scaling-stroke"`：viewBox 是 TMX 像素（8192），容器只有几百像素，
 *   按 viewBox 缩放的 2px 描边会变成 0.03px 看不见。
 * - 点标记的半径 / 字号必须按 `detail.width` 算（不能写死）：写死 40 在 8192 的图上是 1 像素。
 *
 * ## 越界为什么必须换颜色（#586）
 *
 * 容器是 `overflow-hidden` 的：越出 viewBox 的那部分矩形**会被裁掉**。所以「区域摆到了图外」
 * 在画面上表现为「这块区域不存在」—— 跟「这张图本来没有这个区域」一模一样。
 * 判据（`inBounds`）由服务端按地图尺寸算，这里只负责把它变成肉眼可见的东西：描边转警示色 + 虚线。
 */
export interface MapLayerVisibility {
  /** 刷怪区（服务端世界坐标，实线） */
  spawn: boolean;
  /** NPC 点位 */
  npc: boolean;
  /** 复活点 */
  revive: boolean;
  /** 碰撞盒（数量大，默认关） */
  collision: boolean;
}

/** 画布上拖出来的矩形（**Tiled 口径**：左上角原点、y 向下；可直接对应 `viewBox`） */
export interface DrawBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const COLOR = {
  spawn: "#818cf8", // indigo-400
  /** 越界区域：换成警示色，否则「被裁掉的那块」看起来跟「本来就没有」一模一样 */
  spawnOutside: "#f43f5e", // rose-500
  /** 正在编辑的那一块 */
  spawnActive: "#a78bfa", // violet-400
  npc: "#38bdf8", // sky-400
  revive: "#34d399", // emerald-400
  collision: "#fb7185", // rose-400
};

/** 点对象的命中半径（按图宽的比例算：8192 的图上约 46，缩到 700px 宽约 4px） */
const DOT_RADIUS_RATIO = 1 / 175;
/** 标签字号（同上：8192 的图约 136 单位，缩到 620px 宽约 10px —— 再小就看不清，再大会互相压住） */
const LABEL_RATIO = 1 / 60;
/** 拖出来的框小于这个像素（TMX 单位）就当没画 —— 与 `SPAWN_AREA_LIMITS.minSize` 同一口径 */
export const MIN_DRAW_PX = 16;

export function MapCanvas({
  detail,
  visible,
  onPickArea,
  onPickNpc,
  drawMode = false,
  selectedAreaId,
  onDrawBox,
  maxWidth = "min(100%, 62vh)",
}: {
  detail: MapDetail;
  visible: MapLayerVisibility;
  /** 点击刷怪区：打开编辑弹窗 */
  onPickArea: (area: MapSpawnArea) => void;
  /** 点击 NPC / 复活点：打开点位弹窗并定位到那一行 */
  onPickNpc: (object: MapObject) => void;
  /** 绘制模式：指针在图上拖矩形，松手回调 `onDrawBox` */
  drawMode?: boolean;
  /** 正在编辑的区域：描边加粗 + 换色（从列表/图上点进来时能一眼找到） */
  selectedAreaId?: number;
  /** 画完一个矩形（Tiled 口径）；由上层换算成世界坐标并打开表单 */
  onDrawBox?: (box: DrawBox) => void;
  /** 宽度上限：页面上按视口高度限（一屏能同时看到配置与地图），放大镜里给 100% */
  maxWidth?: string;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  /** 拖拽中的草稿（两个角，未必有序） */
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  // 所有地图的预览图都是 TMX 的等比缩小（实测 2048 vs 8192），容器按 TMX 宽高比留位，
  // 图片 object-contain 正好铺满 —— 不写死 8192，也不假设正方形。
  const ratio = detail.height > 0 ? detail.width / detail.height : 1;
  const dotRadius = Math.max(8, detail.width * DOT_RADIUS_RATIO);
  const labelSize = Math.max(20, detail.width * LABEL_RATIO);
  const collisionObjects = collisionOf(detail);

  /** 屏幕坐标 → viewBox 坐标（`preserveAspectRatio="none"` + 容器等比，x/y 各自按比例换算） */
  const pointOf = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
      const x = ((event.clientX - rect.left) / rect.width) * detail.width;
      const y = ((event.clientY - rect.top) / rect.height) * detail.height;
      return {
        x: Math.min(Math.max(x, 0), detail.width),
        y: Math.min(Math.max(y, 0), detail.height),
      };
    },
    [detail.width, detail.height],
  );

  // Esc 取消草稿：拖到一半发现画错了，不用松手再删一个区域
  useEffect(() => {
    if (!drawMode) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDraft(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawMode]);

  // 退出绘制模式时清掉草稿，否则下次进来还挂着上一次的半个框
  useEffect(() => {
    if (!drawMode) setDraft(null);
  }, [drawMode]);

  const draftBox = draft ? normalizeBox(draft) : null;

  return (
    <div
      className="relative mx-auto w-full overflow-hidden rounded-xl border border-slate-800 bg-slate-950"
      // 限高而不是限宽：11 张图都是正方形，宽度顶到 62vh 时高度也就 62vh ——
      // 一屏能同时看到「配置改了什么」和「地图变成什么样」，不被一张大图挤走。
      // 放大镜里传 100%（那里只有一个目的：把标签看大）
      style={{ aspectRatio: `${ratio}`, maxWidth }}
    >
      {imageFailed ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-[11px] text-slate-600">
          <span>预览图加载失败（map/{detail.id}/preview.jpg）</span>
          <span>叠加层照常显示，可以对着坐标核位置</span>
        </div>
      ) : (
        <img
          alt={`${detail.label} 预览`}
          src={gameResUrl(mapPreview(detail.id), "jpg")}
          onError={() => setImageFailed(true)}
          className="absolute inset-0 h-full w-full object-contain"
          // 底图只是参照物：拖选 / 右键另存都不该发生（这一层是「纸」，不是内容）
          draggable={false}
        />
      )}

      <svg
        ref={svgRef}
        viewBox={`0 0 ${detail.width} ${detail.height}`}
        preserveAspectRatio="none"
        className={`absolute inset-0 h-full w-full ${drawMode ? "cursor-crosshair" : ""}`}
        style={drawMode ? { touchAction: "none" } : undefined}
        role="img"
        aria-label={`${detail.label} 的刷怪区与点位`}
        onPointerDown={(event) => {
          if (!drawMode || event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          const point = pointOf(event);
          setDraft({ x0: point.x, y0: point.y, x1: point.x, y1: point.y });
        }}
        onPointerMove={(event) => {
          if (!drawMode || !draft) return;
          const point = pointOf(event);
          setDraft({ ...draft, x1: point.x, y1: point.y });
        }}
        onPointerUp={(event) => {
          if (!drawMode || !draft) return;
          const box = normalizeBox({ ...draft, x1: pointOf(event).x, y1: pointOf(event).y });
          setDraft(null);
          // 太小的框当没画：手抖点一下会得到一个 1×1 的区域，那种区域能刷但不能用
          if (box.width < MIN_DRAW_PX || box.height < MIN_DRAW_PX) return;
          onDrawBox?.(box);
        }}
        onPointerCancel={() => setDraft(null)}
      >
        {/* 碰撞盒：垫在最底层，只给轮廓（填充会糊住底图，反而看不出刷怪区压在什么地形上） */}
        {visible.collision &&
          collisionObjects.map((object) => (
            <rect
              key={`collision-${object.id}`}
              x={object.x}
              y={object.y}
              width={object.width}
              height={object.height}
              fill={COLOR.collision}
              fillOpacity={0.16}
              stroke={COLOR.collision}
              strokeOpacity={0.65}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}

        {/* 服务端刷怪区（实）：click 打开编辑弹窗。绘制模式下不响应点击（否则一按就弹窗） */}
        {visible.spawn &&
          detail.spawnAreas.map((area) => {
            const box = tiledBoxOf(area);
            const active = area.id === selectedAreaId;
            // 越界区域描警示色：容器 overflow-hidden 会把越出 viewBox 的部分裁掉，
            // 也就是「区域在图外」在画面上表现为「这块区域不见了」—— 只有颜色能提示。
            const color = active ? COLOR.spawnActive : area.inBounds ? COLOR.spawn : COLOR.spawnOutside;
            return (
              <g
                key={`spawn-${area.id}`}
                className={drawMode ? undefined : "cursor-pointer"}
                pointerEvents={drawMode ? "none" : undefined}
                onClick={() => onPickArea(area)}
              >
                <rect
                  x={box.x}
                  y={box.y}
                  width={box.width}
                  height={box.height}
                  fill={color}
                  fillOpacity={active ? 0.26 : area.inBounds ? 0.14 : 0.24}
                  stroke={color}
                  strokeWidth={active ? 3.5 : area.inBounds ? 2 : 3}
                  strokeDasharray={area.inBounds && !active ? undefined : `${labelSize * 0.45} ${labelSize * 0.25}`}
                  vectorEffect="non-scaling-stroke"
                >
                  <title>{`#${area.id} ${area.name} · ${area.monsterLabel}(${area.monsterKey}) ${area.min}~${area.max} 只\n世界坐标 (${area.cx}, ${area.cy}) ${area.w}×${area.h}${area.inBounds ? "" : `\n⚠ 越出地图边界（${overflowText(area)}），超出的部分在画面上看不到`}`}</title>
                </rect>
                <text
                  x={box.x + box.width / 2}
                  y={box.y + box.height / 2 + labelSize / 3}
                  textAnchor="middle"
                  fontSize={labelSize}
                  fill="#e2e8f0"
                  stroke="#0f172a"
                  strokeWidth={labelSize / 22}
                  paintOrder="stroke"
                  pointerEvents="none"
                >
                  {box.width / detail.width >= 0.12 ? `#${area.id} ${area.monsterLabel} ${area.min}~${area.max}` : `#${area.id}`}
                </text>
              </g>
            );
          })}

        {/* NPC / 复活点：点对象（width/height 为 0），坐标就是点本身 */}
        {visible.revive &&
          npcObjectsOf(detail, "revive").map((object) => (
            <g key={`revive-${object.id}`} className="cursor-pointer" pointerEvents={drawMode ? "none" : undefined} onClick={() => onPickNpc(object)}>
              <circle cx={object.x} cy={object.y} r={dotRadius * 0.8} fill={COLOR.revive} fillOpacity={0.35} stroke={COLOR.revive} strokeWidth={2} vectorEffect="non-scaling-stroke">
                <title>{`复活点「${object.name || object.id}」 (${object.x}, ${object.y})`}</title>
              </circle>
              <text x={object.x + dotRadius} y={object.y + labelSize / 3} fontSize={labelSize * 0.9} fill={COLOR.revive} stroke="#0f172a" strokeWidth={labelSize / 24} paintOrder="stroke" pointerEvents="none">
                {object.name || "复活点"}
              </text>
            </g>
          ))}

        {visible.npc &&
          npcObjectsOf(detail, "npc").map((object) => (
            <g key={`npc-${object.id}`} className="cursor-pointer" pointerEvents={drawMode ? "none" : undefined} onClick={() => onPickNpc(object)}>
              <circle cx={object.x} cy={object.y} r={dotRadius} fill={COLOR.npc} fillOpacity={0.4} stroke={COLOR.npc} strokeWidth={2} vectorEffect="non-scaling-stroke">
                <title>{`NPC「${object.name || object.id}」 (${object.x}, ${object.y})${object.properties.id ? ` · id=${object.properties.id}` : ""}`}</title>
              </circle>
              <text x={object.x + dotRadius} y={object.y + labelSize / 3} fontSize={labelSize} fill={COLOR.npc} stroke="#0f172a" strokeWidth={labelSize / 24} paintOrder="stroke" pointerEvents="none">
                {object.name || `NPC ${object.id}`}
              </text>
            </g>
          ))}

        {/* 拖拽预览：虚线框 + 实时尺寸。pointerEvents none —— 它出现在光标下面，不能吃掉 move 事件 */}
        {draftBox ? (
          <g pointerEvents="none">
            <rect
              x={draftBox.x}
              y={draftBox.y}
              width={draftBox.width}
              height={draftBox.height}
              fill={COLOR.spawnActive}
              fillOpacity={0.2}
              stroke={COLOR.spawnActive}
              strokeWidth={2}
              strokeDasharray={`${labelSize * 0.4} ${labelSize * 0.25}`}
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={draftBox.x + draftBox.width / 2}
              y={draftBox.y + draftBox.height / 2 + labelSize / 3}
              textAnchor="middle"
              fontSize={labelSize}
              fill="#f5f3ff"
              stroke="#0f172a"
              strokeWidth={labelSize / 22}
              paintOrder="stroke"
            >
              {Math.round(draftBox.width)} × {Math.round(draftBox.height)}
            </text>
          </g>
        ) : null}
      </svg>

      {drawMode ? (
        <div className="pointer-events-none absolute left-1 top-1 rounded bg-slate-950/80 px-2 py-1 text-[11px] text-violet-200">
          在图上拖出一个矩形 = 新建刷怪区 · Esc 取消
        </div>
      ) : null}

      <div className="pointer-events-none absolute bottom-1 right-1 rounded bg-slate-950/70 px-1.5 py-0.5 text-[10px] text-slate-500">
        {detail.width} × {detail.height} px · {detail.cols}×{detail.rows} 格
      </div>
    </div>
  );
}

/** 两个任意角 → 有正宽高的矩形（用户可以从右下往左上拖） */
function normalizeBox(box: { x0: number; y0: number; x1: number; y1: number }): DrawBox {
  return {
    x: Math.min(box.x0, box.x1),
    y: Math.min(box.y0, box.y1),
    width: Math.abs(box.x1 - box.x0),
    height: Math.abs(box.y1 - box.y0),
  };
}

/** 世界坐标的刷怪区 → Tiled 口径的矩形（`cy = -(y + h/2)` 的反函数） */
export function tiledBoxOf(area: MapSpawnArea): { x: number; y: number; width: number; height: number } {
  return { x: area.cx - area.w / 2, y: -area.cy - area.h / 2, width: area.w, height: area.h };
}

/** Tiled 口径的矩形 → 提交给服务端的世界坐标（`cx = x + w/2`、`cy = -(y + h/2)`） */
export function worldBoxOf(box: DrawBox): { cx: number; cy: number; w: number; h: number } {
  return {
    cx: round2(box.x + box.width / 2),
    cy: round2(-(box.y + box.height / 2)),
    w: round2(box.width),
    h: round2(box.height),
  };
}

/** 与画布像素对齐到两位小数：拖出来的 1234.5678 进库没有意义，也让 e2e 能直接对数字 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 取一个对象组（不存在给空数组：地图不一定有 collision 组） */
function groupOf(detail: MapDetail, name: string): MapObject[] {
  return detail.groups.find((group) => group.name === name)?.objects ?? [];
}

/** 碰撞盒（对象组 collision） */
export function collisionOf(detail: MapDetail): MapObject[] {
  return groupOf(detail, "collision");
}

/**
 * 某一类的点位对象（`klass` = Tiled 的 type 字段）
 *
 * 实测 11 张图：`npc` 对象组里恰好每张 1 个 `klass=npc` + 1 个 `klass=revive`，
 * 全部带类型 —— 所以按 klass 过滤就够，不用再猜「组名 + 空类型」那种兜底
 * （兜底规则一旦写进来，下次多一个 `klass=npc` 的传送点会被它算进复活点）。
 */
export function npcObjectsOf(detail: MapDetail, klass: "npc" | "revive"): MapObject[] {
  return detail.groups.flatMap((group) => group.objects).filter((object) => object.klass === klass);
}
