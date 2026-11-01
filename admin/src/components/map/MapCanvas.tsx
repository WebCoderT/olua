import { useState } from "react";
import { mapPreview } from "../../api";
import type { MapDetail, MapObject, MapSpawnArea } from "../../api";
import { gameResUrl } from "../GameImage";
import { overflowText } from "./bounds";

/**
 * 地图可视化（预览图 + SVG 叠加层）
 *
 * ## 为什么在图上画，而不是再看一张表
 *
 * 这一页的判断几乎都是空间判断：「刷怪区是不是摆到了墙外」「NPC 是不是站在出生点旁边」
 * 「11 张图的区域有没有互相压住」。对着 `(3968, -704) 5888×896` 这种数字在脑子里构图，
 * 看十行就会放弃 —— 而放弃的表现通常是「看起来挺对」，不是报错。
 *
 * ## 两套坐标必须同时画出来（否则等于没核对）
 *
 * - **刷怪区**（服务端 `map_spawn_areas`）：`cx/cy` 是**世界坐标**（原点左上、y 向上，所以 cy 为负）。
 *   画到图上要反算回 Tiled 口径：`x = cx - w/2`、`y = -cy - h/2`。
 * - **Tiled 原始矩形**（`groups.monster`）：本来就是左上原点、y 向下，直接画。
 *
 * 两者用实线 / 虚线叠在一起：**对得上就是重合，对不上就是一眼能看见的错位**。
 * 只在表里比对「中心数值」也能验，但那要求读者自己记住两组数字 —— 图上不需要记。
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
  /** Tiled 里的 monster 矩形（原始坐标，虚线；与刷怪区重合才是对的） */
  tiled: boolean;
  /** NPC 点位 */
  npc: boolean;
  /** 复活点 */
  revive: boolean;
  /** 碰撞盒（数量大，默认关） */
  collision: boolean;
}

const COLOR = {
  spawn: "#818cf8", // indigo-400
  /** 越界区域：换成警示色，否则「被裁掉的那块」看起来跟「本来就没有」一模一样 */
  spawnOutside: "#f43f5e", // rose-500
  tiled: "#fbbf24", // amber-400
  npc: "#38bdf8", // sky-400
  revive: "#34d399", // emerald-400
  collision: "#fb7185", // rose-400
};

/** 点对象的命中半径（按图宽的比例算：8192 的图上约 46，缩到 700px 宽约 4px） */
const DOT_RADIUS_RATIO = 1 / 175;
/** 标签字号（同上：8192 的图约 136 单位，缩到 620px 宽约 10px —— 再小就看不清，再大会互相压住） */
const LABEL_RATIO = 1 / 60;

export function MapCanvas({
  detail,
  visible,
  onPickArea,
  onPickNpc,
  maxWidth = "min(100%, 62vh)",
}: {
  detail: MapDetail;
  visible: MapLayerVisibility;
  /** 点击刷怪区：打开刷怪区弹窗并定位到那一行 */
  onPickArea: (area: MapSpawnArea) => void;
  /** 点击 NPC / 复活点：打开点位弹窗并定位到那一行 */
  onPickNpc: (object: MapObject) => void;
  /** 宽度上限：页面上按视口高度限（一屏能同时看到配置与地图），放大镜里给 100% */
  maxWidth?: string;
}) {
  const [imageFailed, setImageFailed] = useState(false);

  // 所有地图的预览图都是 TMX 的等比缩小（实测 2048 vs 8192），容器按 TMX 宽高比留位，
  // 图片 object-contain 正好铺满 —— 不写死 8192，也不假设正方形。
  const ratio = detail.height > 0 ? detail.width / detail.height : 1;
  const dotRadius = Math.max(8, detail.width * DOT_RADIUS_RATIO);
  const labelSize = Math.max(20, detail.width * LABEL_RATIO);
  const collisionObjects = collisionOf(detail);
  const tiledMonsterObjects = groupOf(detail, "monster");

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
        viewBox={`0 0 ${detail.width} ${detail.height}`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full"
        role="img"
        aria-label={`${detail.label} 的刷怪区与点位`}
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

        {/* Tiled 原始矩形（虚）：与服务端刷怪区重合才说明导入没算错 */}
        {visible.tiled &&
          tiledMonsterObjects.map((object) => (
            <rect
              key={`tiled-${object.id}`}
              x={object.x}
              y={object.y}
              width={object.width}
              height={object.height}
              fill="none"
              stroke={COLOR.tiled}
              strokeWidth={1.5}
              strokeDasharray={`${labelSize * 0.5} ${labelSize * 0.3}`}
              vectorEffect="non-scaling-stroke"
            >
              <title>{`Tiled 原始区域「${object.name || object.id}」 (${object.x}, ${object.y}) ${object.width}×${object.height}`}</title>
            </rect>
          ))}

        {/* 服务端刷怪区（实）：click 打开弹窗，点击区域就在表里选中它 */}
        {visible.spawn &&
          detail.spawnAreas.map((area) => {
            const box = tiledBoxOf(area);
            // 越界区域描警示色：容器 overflow-hidden 会把越出 viewBox 的部分裁掉，
            // 也就是「区域在图外」在画面上表现为「这块区域不见了」—— 只有颜色能提示。
            const color = area.inBounds ? COLOR.spawn : COLOR.spawnOutside;
            return (
              <g key={`spawn-${area.id}`} className="cursor-pointer" onClick={() => onPickArea(area)}>
                <rect
                  x={box.x}
                  y={box.y}
                  width={box.width}
                  height={box.height}
                  fill={color}
                  fillOpacity={area.inBounds ? 0.14 : 0.24}
                  stroke={color}
                  strokeWidth={area.inBounds ? 2 : 3}
                  strokeDasharray={area.inBounds ? undefined : `${labelSize * 0.45} ${labelSize * 0.25}`}
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
            <g key={`revive-${object.id}`} className="cursor-pointer" onClick={() => onPickNpc(object)}>
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
            <g key={`npc-${object.id}`} className="cursor-pointer" onClick={() => onPickNpc(object)}>
              <circle cx={object.x} cy={object.y} r={dotRadius} fill={COLOR.npc} fillOpacity={0.4} stroke={COLOR.npc} strokeWidth={2} vectorEffect="non-scaling-stroke">
                <title>{`NPC「${object.name || object.id}」 (${object.x}, ${object.y})${object.properties.id ? ` · id=${object.properties.id}` : ""}`}</title>
              </circle>
              <text x={object.x + dotRadius} y={object.y + labelSize / 3} fontSize={labelSize} fill={COLOR.npc} stroke="#0f172a" strokeWidth={labelSize / 24} paintOrder="stroke" pointerEvents="none">
                {object.name || `NPC ${object.id}`}
              </text>
            </g>
          ))}
      </svg>

      <div className="pointer-events-none absolute bottom-1 right-1 rounded bg-slate-950/70 px-1.5 py-0.5 text-[10px] text-slate-500">
        {detail.width} × {detail.height} px · {detail.cols}×{detail.rows} 格
      </div>
    </div>
  );
}

/** 世界坐标的刷怪区 → Tiled 口径的矩形（`cy = -(y + h/2)` 的反函数） */
export function tiledBoxOf(area: MapSpawnArea): { x: number; y: number; width: number; height: number } {
  return { x: area.cx - area.w / 2, y: -area.cy - area.h / 2, width: area.w, height: area.h };
}

/** 取一个对象组（不存在给空数组：地图不一定有 collision / monster 组） */
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
