import { useCallback, useEffect, useRef, useState } from "react";
import { mapPreview } from "../../api";
import type { MapDetail, MapNpc, MapObject, MapRevivePoint, MapSpawnArea } from "../../api";
import { gameResUrl } from "../GameImage";
import { overflowText } from "./bounds";

/**
 * 地图可视化（预览图 + SVG 叠加层 + **在图上改点位**）
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
 * 换算只有两条式子，且只在「进」和「出」两个口子发生：
 * 进（读库 → 画）：`x = cx`、`y = -cy`（`tiledPointOf`）；矩形再按中心反算（`tiledBoxOf`）。
 * 出（画 → 提交）：`cx = x`、`cy = -y`（`worldPointOf`）；矩形同理（`worldBoxOf`）。
 *
 * ## 四种模式（#672 从「绘制开关」扩成模式）
 *
 * | 模式 | 按下空白 | 按下已有对象 |
 * |---|---|---|
 * | `view` | 什么都不做 | 打开编辑弹窗 |
 * | `spawn` | 拖出矩形 → 新建刷怪区 | 不响应（拖拽期间误触会不停弹窗） |
 * | `npc` | 松手处 = 新 NPC 点位的坐标 | **拖动**，松手即保存；没拖动就算点击 → 打开编辑 |
 * | `revive` | 松手处 = 复活点 | 拖动复活点同理 |
 *
 * 三种编辑模式都有同一个「防手滑」底座：太小的框不提交（`MIN_DRAW_PX`）、
 * `Esc` 取消、`touchAction: none`（拖拽时别让页面跟着滚）。
 *
 * ## 别把点击处理挂在 `<svg>` 上，挂在垫底的那块透明矩形上
 *
 * 早期版本让 `svg` 的 `onPointerDown` 处理「画框」，结果点到已有对象时会**双触发**
 * （子元素的 handler 先跑，父元素的 state 还没更新看不到抑制标记）。现在把「空白处按下」
 * 交给 viewBox 大小的透明 `<rect>`（画在最底层），子元素天然优先 —— 不需要任何 flag。
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

/** 画布模式：看 / 画刷怪区 / 放 NPC / 设复活点 */
export type CanvasMode = "view" | "spawn" | "npc" | "revive";

/** 画布上拖出来的矩形（**Tiled 口径**：左上角原点、y 向下；可直接对应 `viewBox`） */
export interface DrawBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 画布上的一个点（**Tiled 口径**） */
export interface DrawPoint {
  x: number;
  y: number;
}

const COLOR = {
  spawn: "#818cf8", // indigo-400
  /** 越界区域：换成警示色，否则「被裁掉的那块」看起来跟「本来就没有」一模一样 */
  spawnOutside: "#f43f5e", // rose-500
  /** 正在编辑的那一块 */
  spawnActive: "#a78bfa", // violet-400
  npc: "#38bdf8", // sky-400
  npcActive: "#7dd3fc", // sky-300
  revive: "#34d399", // emerald-400
  reviveActive: "#6ee7b7", // emerald-300
  outside: "#f43f5e", // rose-500（越界点位）
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
  onPickRevive,
  onDrawBox,
  onPlaceNpc,
  onMoveNpc,
  onPlaceRevive,
  mode = "view",
  selectedAreaId,
  selectedNpcId,
  maxWidth = "min(100%, 62vh)",
}: {
  detail: MapDetail;
  visible: MapLayerVisibility;
  /** 点击刷怪区：打开编辑弹窗 */
  onPickArea: (area: MapSpawnArea) => void;
  /** 点击 NPC 点：打开编辑弹窗 */
  onPickNpc: (point: MapNpc) => void;
  /** 点击复活点：由上层决定（当前是「切到复活点模式」的提示，见页面） */
  onPickRevive?: (point: MapRevivePoint) => void;
  /** 画完一个矩形（Tiled 口径）；由上层换算成世界坐标并打开表单 */
  onDrawBox?: (box: DrawBox) => void;
  /** `npc` 模式点空白：把落点（Tiled 口径）交给上层打开「放哪个 NPC」的表单 */
  onPlaceNpc?: (point: DrawPoint) => void;
  /** `npc` 模式拖动已有 NPC 点并松手（已经判断过「确实移动了」） */
  onMoveNpc?: (point: MapNpc, to: DrawPoint) => void;
  /** `revive` 模式点空白：直接设 / 挪复活点 */
  onPlaceRevive?: (point: DrawPoint) => void;
  /** 当前模式（默认只看） */
  mode?: CanvasMode;
  /** 正在编辑的区域：描边加粗 + 换色（从列表/图上点进来时能一眼找到） */
  selectedAreaId?: number;
  /** 正在编辑的 NPC 点：圈加粗 + 换色 */
  selectedNpcId?: number;
  /** 宽度上限：页面上按视口高度限（一屏能同时看到配置与地图），放大镜里给 100% */
  maxWidth?: string;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  /** 拖拽中的框草稿（两个角，未必有序） */
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  /** 拖拽中的点（NPC / 复活点）：位置是 Tiled 口径，`moved` 用来区分「点击」与「拖动」 */
  const [drag, setDrag] = useState<{ npc: MapNpc | null; from: DrawPoint; at: DrawPoint; moved: boolean } | null>(null);

  // 所有地图的预览图都是 TMX 的等比缩小（实测 2048 vs 8192），容器按 TMX 宽高比留位，
  // 图片 object-contain 正好铺满 —— 不写死 8192，也不假设正方形。
  const ratio = detail.height > 0 ? detail.width / detail.height : 1;
  const dotRadius = Math.max(8, detail.width * DOT_RADIUS_RATIO);
  const labelSize = Math.max(20, detail.width * LABEL_RATIO);
  const collisionObjects = collisionOf(detail);
  const editing = mode !== "view";

  /**
   * 屏幕坐标 → viewBox 坐标
   *
   * 基准取 **svg 自己的 rect**（不是事件目标的）：点在 `<g>` / `<circle>` 上时，
   * `getBoundingClientRect()` 返回的是那个小圆的包围盒 —— 曾因此把拖动坐标算到图外。
   */
  const pointOf = useCallback(
    (event: { clientX: number; clientY: number }): DrawPoint => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
      const x = ((event.clientX - rect.left) / rect.width) * detail.width;
      const y = ((event.clientY - rect.top) / rect.height) * detail.height;
      return {
        x: Math.min(Math.max(x, 0), detail.width),
        y: Math.min(Math.max(y, 0), detail.height),
      };
    },
    [detail.width, detail.height],
  );

  // Esc 取消：拖到一半发现画错了，不用松手再删一个区域 / 不用再把它拖回去
  useEffect(() => {
    if (!editing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setDraft(null);
      setDrag(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing]);

  // 退出编辑模式时清掉草稿，否则下次进来还挂着上一次的半个框 / 半个点
  useEffect(() => {
    if (!editing) {
      setDraft(null);
      setDrag(null);
    }
  }, [editing]);

  const draftBox = draft ? normalizeBox(draft) : null;

  /**
   * 空白处按下（垫底透明矩形）
   *
   * 三种模式三种含义：画框 / 放 NPC / 设复活点。全都把指针捕获到 `svg` 上 ——
   * 之后 move / up 统一由 `svg` 收，拖到图外也不会丢事件。
   */
  const onBackgroundDown = (event: React.PointerEvent<SVGRectElement>) => {
    if (!editing || event.button !== 0) return;
    event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId);
    const point = pointOf(event);
    if (mode === "spawn") {
      setDraft({ x0: point.x, y0: point.y, x1: point.x, y1: point.y });
      return;
    }
    // 点位模式：按下即落点（松手才提交，见 onPointerUp —— 这样 Esc 还有机会取消）
    setDrag({ npc: null, from: point, at: point, moved: true });
  };

  /** 拖动一个已有的点位（NPC / 复活点） */
  const startDragPoint = (event: React.PointerEvent<SVGElement>, npc: MapNpc | null, at: DrawPoint) => {
    if (mode !== (npc ? "npc" : "revive") || event.button !== 0) return;
    event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId);
    setDrag({ npc, from: at, at, moved: false });
  };

  const movePointer = (event: React.PointerEvent<SVGSVGElement>) => {
    if (draft) {
      const point = pointOf(event);
      setDraft({ ...draft, x1: point.x, y1: point.y });
      return;
    }
    if (!drag) return;
    const point = pointOf(event);
    // 阈值：移动超过「点半径」才算拖动 —— 手抖 1 像素不该把 NPC 挪走，也不该让点击失效
    const moved = drag.moved || Math.hypot(point.x - drag.from.x, point.y - drag.from.y) > dotRadius * 0.5;
    setDrag({ ...drag, at: point, moved });
  };

  const releasePointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const point = pointOf(event);
    if (draft) {
      const box = normalizeBox({ ...draft, x1: point.x, y1: point.y });
      setDraft(null);
      // 太小的框当没画：手抖点一下会得到一个 1×1 的区域，那种区域能刷但不能用
      if (box.width < MIN_DRAW_PX || box.height < MIN_DRAW_PX) return;
      onDrawBox?.(box);
      return;
    }
    if (!drag) return;
    const { npc, moved } = drag;
    setDrag(null);

    // 没拖动 = 点击：打开编辑弹窗（点位模式下也能「点开看看是谁」）
    if (!moved) {
      if (npc) onPickNpc(npc);
      else if (detail.revivePoint) onPickRevive?.(detail.revivePoint);
      return;
    }

    if (mode === "npc") {
      if (npc) onMoveNpc?.(npc, point);
      else onPlaceNpc?.(point);
      return;
    }
    if (mode === "revive") onPlaceRevive?.(point);
  };

  const dragging = drag?.moved ? drag : null;
  /** 复活点：库里的世界坐标 → Tiled 口径；拖动中就画在手下的位置 */
  const reviveOrigin = detail.revivePoint ? tiledPointOf(detail.revivePoint) : null;
  const reviveAt = reviveOrigin ? (dragging && !dragging.npc ? dragging.at : reviveOrigin) : null;

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
        className={`absolute inset-0 h-full w-full ${editing ? "cursor-crosshair" : ""} ${dragging ? "cursor-grabbing" : ""}`}
        style={editing ? { touchAction: "none" } : undefined}
        role="img"
        aria-label={`${detail.label} 的刷怪区与点位`}
        onPointerMove={movePointer}
        onPointerUp={releasePointer}
        onPointerCancel={() => {
          setDraft(null);
          setDrag(null);
        }}
      >
        {/* 空白处的命中层：画在最底层，尺寸 = 整张图。有它就不必在 `<svg>` 上判「是不是点到了对象」 */}
        <rect
          x={0}
          y={0}
          width={detail.width}
          height={detail.height}
          fill="transparent"
          onPointerDown={onBackgroundDown}
        />

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
                className={editing ? undefined : "cursor-pointer"}
                // 编辑点位时整块区域不再吃事件：不然「在刷怪区里点一下放 NPC」会先弹开区域表单
                pointerEvents={editing ? "none" : undefined}
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

        {/* 复活点（服务端 maps.revive_cx/cy，每图最多一个）：点 = 打开，拖动 = 挪位置 */}
        {visible.revive && detail.revivePoint && reviveOrigin && reviveAt ? (
          <PointDot
            cx={reviveAt.x}
            cy={reviveAt.y}
            color={mode === "revive" ? COLOR.reviveActive : COLOR.revive}
            radius={dotRadius * 0.8}
            label="复活点"
            labelSize={labelSize}
            inBounds={detail.revivePoint.inBounds}
            draggable={mode === "revive"}
            openOnClick={mode === "view"}
            onPointerDown={(event) => startDragPoint(event, null, reviveOrigin)}
            onOpen={() => onPickRevive?.(detail.revivePoint!)}
            title={`复活点 (${detail.revivePoint.cx}, ${detail.revivePoint.cy})${detail.revivePoint.inBounds ? "" : " · ⚠ 越出地图边界"}`}
          />
        ) : null}

        {/* NPC 点位（服务端 map_npcs）：点 = 打开编辑，拖动 = 松手即保存 */}
        {visible.npc &&
          detail.npcPoints.map((point) => {
            const origin = tiledPointOf(point);
            const moving = dragging?.npc?.id === point.id;
            const at = moving ? dragging!.at : origin;
            return (
              <PointDot
                key={`npc-${point.id}`}
                cx={at.x}
                cy={at.y}
                color={mode === "npc" && point.id === selectedNpcId ? COLOR.npcActive : COLOR.npc}
                radius={dotRadius}
                label={point.npcLabel}
                labelSize={labelSize}
                inBounds={point.inBounds}
                draggable={mode === "npc"}
                openOnClick={mode === "view"}
                onPointerDown={(event) => startDragPoint(event, point, origin)}
                onOpen={() => onPickNpc(point)}
                title={`NPC「${point.npcLabel}」(#${point.id} npcId=${point.npcId})\n世界坐标 (${point.cx}, ${point.cy})${point.inBounds ? "" : "\n⚠ 越出地图边界，图上看不到这个点"}`}
              />
            );
          })}

        {/* 点位模式下，拖动中的点位画一条「起点 → 当前位置」的虚线，让位移看得见 */}
        {dragging ? (
          <line
            x1={dragging.from.x}
            y1={dragging.from.y}
            x2={dragging.at.x}
            y2={dragging.at.y}
            stroke={COLOR.spawnActive}
            strokeWidth={2}
            strokeDasharray={`${labelSize * 0.35} ${labelSize * 0.25}`}
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
        ) : null}

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

      {MODE_HINT[mode] ? (
        <div
          className="pointer-events-none absolute left-1 top-1 rounded bg-slate-950/80 px-2 py-1 text-[11px]"
          style={{ color: MODE_HINT[mode]!.color }}
        >
          {MODE_HINT[mode]!.text}
        </div>
      ) : null}

      <div className="pointer-events-none absolute bottom-1 right-1 rounded bg-slate-950/70 px-1.5 py-0.5 text-[10px] text-slate-500">
        {detail.width} × {detail.height} px · {detail.cols}×{detail.rows} 格
      </div>
    </div>
  );
}

/** 每种编辑模式左上角那一行提示（`view` 不提示：查看模式不该有常驻横幅） */
const MODE_HINT: Record<CanvasMode, { text: string; color: string } | null> = {
  view: null,
  spawn: { text: "在图上拖出矩形 = 新建刷怪区 · Esc 取消", color: "#ddd6fe" },
  npc: { text: "点空白 = 放一个 NPC（再选是谁）· 拖已有点 = 挪位置 · Esc 取消", color: "#bae6fd" },
  revive: { text: "点哪里 = 复活点就设在哪里 · 拖动已有点 = 挪位置 · Esc 取消", color: "#a7f3d0" },
};

/**
 * 一个点位标记（NPC / 复活点共用）
 *
 * 圆 + 标签 + `title` 三件套必须长得一致，否则「为什么这个能拖那个不能」会变成靠猜。
 * 越界点位换警示色（同刷怪区那条理由：容器裁掉之后画面上什么都没有，只剩颜色能说话）。
 *
 * **拖动与点开是两个开关**（`draggable` / `openOnClick`）：点位模式下「点一下已有点」的语义是
 * 「拖了 0 像素」，由画布在 `pointerup` 里统一发（先判位移、再决定是打开还是提交），
 * 所以这里不能再挂 `onClick` —— 两个入口会各开一次弹窗。查看模式反过来：只有 `onClick`。
 */
function PointDot({
  cx,
  cy,
  color,
  radius,
  label,
  labelSize,
  inBounds,
  draggable,
  openOnClick,
  title,
  onPointerDown,
  onOpen,
}: {
  cx: number;
  cy: number;
  color: string;
  radius: number;
  label: string;
  labelSize: number;
  inBounds: boolean;
  /** 当前模式下这个点能不能拖 */
  draggable: boolean;
  /** 当前模式下「点一下」等于打开编辑（仅查看模式） */
  openOnClick: boolean;
  title: string;
  onPointerDown: (event: React.PointerEvent<SVGCircleElement>) => void;
  onOpen: () => void;
}) {
  const stroke = inBounds ? color : COLOR.outside;
  const hit = draggable || openOnClick;
  return (
    <g className={hit ? "cursor-pointer" : undefined} onClick={openOnClick ? onOpen : undefined}>
      <circle
        cx={cx}
        cy={cy}
        r={radius}
        fill={stroke}
        fillOpacity={0.4}
        stroke={stroke}
        strokeWidth={2}
        strokeDasharray={inBounds ? undefined : `${radius * 0.4} ${radius * 0.25}`}
        vectorEffect="non-scaling-stroke"
        pointerEvents={hit ? "auto" : "none"}
        onPointerDown={onPointerDown}
      >
        <title>{title}</title>
      </circle>
      <text
        x={cx + radius}
        y={cy + labelSize / 3}
        fontSize={labelSize}
        fill={stroke}
        stroke="#0f172a"
        strokeWidth={labelSize / 24}
        paintOrder="stroke"
        pointerEvents="none"
      >
        {label}
      </text>
    </g>
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

/** 世界坐标的点 → Tiled 口径的点（`y = -cy`） */
export function tiledPointOf(point: { cx: number; cy: number }): DrawPoint {
  return { x: point.cx, y: -point.cy };
}

/** Tiled 口径的点 → 提交给服务端的世界坐标（`cx = x`、`cy = -y`） */
export function worldPointOf(point: DrawPoint): { cx: number; cy: number } {
  return { cx: round2(point.x), cy: round2(-point.y) };
}

/** 与画布像素对齐到两位小数：拖出来的 1234.5678 进库没有意义，也让 e2e 能直接对数字 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 取一个对象组（不存在给空数组：地图不一定有 collision 组） */
function groupOf(detail: MapDetail, name: string): MapObject[] {
  return detail.groups.find((group) => group.name === name)?.objects ?? [];
}

/** 碰撞盒（对象组 collision）—— 碰撞不归后台管（它属于 TMX 的瓦片物理），这里只画 */
export function collisionOf(detail: MapDetail): MapObject[] {
  return groupOf(detail, "collision");
}
