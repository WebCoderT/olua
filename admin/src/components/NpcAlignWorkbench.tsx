import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { loadFirstFrame } from "./GameImage";
import type { FirstFrame } from "./GameImage";
import { Field, Input } from "./ui";

/**
 * NPC 对齐工作台（#1335）：以素材**第一帧**为基准，拖拽调偏移、输入调缩放
 *
 * 与「显示效果工作台」同一套交互取向（画布 + 拖拽 + 数值联动），但基准不是一张外框图，
 * 而是复刻客户端 `createNpcNode` 的嵌套结构（`ui/helpers/parts/monster-parts.ts`）：
 * - `npcNode` = flexCol 100×170，锚点 0.5/0.5（`createNode` 默认）—— **地图点位 = 容器中心**
 *   （`MapObjectSpawner` 对它 `setWorldPosition`）；
 * - 竖排：名字条 100×20 在顶（中心在容器中心上方 75px），精灵区 100×150 在下
 *   （中心在容器中心下方 10px）；
 * - 精灵 = RAW 原始纹理尺寸、锚点中心，位置 `(posX, posY)` 相对**精灵区中心**，
 *   缩放 `(scaleX, scaleY)`；精灵不被精灵区裁剪（无 mask），可以画出界。
 *
 * 画布 y 向下、引擎 y 向上，画和拖的时候翻转 —— 与显示效果工作台同坑。
 * 画布上看到的 = 客户端会摆出的相对关系（同一套口径），只是不带游戏里的动画。
 */

/** 客户端节点尺寸（游戏像素，与 createNpcNode 字面量一致） */
const CONTAINER_W = 100;
const LABEL_H = 20;
const SPRITE_W = 100;
const SPRITE_H = 150;
/** 名字条中心相对容器中心的纵向距离（引擎 y 向上）：85 - 20/2 = 75 */
const LABEL_CENTER_Y = 75;
/** 精灵区中心相对容器中心的纵向距离（引擎 y 向上，负 = 在下方）：85 - 20 - 150/2 = -10 */
const SPRITE_CENTER_Y = -10;

/**
 * NPC 障碍碰撞盒（#1339，与客户端 `MapObjectSpawner.NPC_COLLIDER_SIZE / NPC_COLLIDER_OFFSET` 同值）：
 * 100×100、中心在容器中心下方 35px（底边贴容器底边 y=-85）。画进画布供比对。
 */
const COLLIDER_W = 100;
const COLLIDER_H = 100;
const COLLIDER_CENTER_Y = -35;

/** 数值限界（与服务端 UpdateNpcDto 同口径；UI 先拦、服务端再校验） */
const SCALE_MIN = 0.1;
const SCALE_MAX = 10;
const OFFSET_MAX = 4000;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export type NpcAlignValue = { scaleX: number; scaleY: number; posX: number; posY: number };

export function NpcAlignWorkbench(props: {
  /** 素材目录（Npc.src 同口径；空串 = 精灵不画，只看骨架） */
  src: string;
  /** NPC 名称（画进名字条，所见即所得） */
  label: string;
  value: NpcAlignValue;
  onChange: (next: NpcAlignValue) => void;
  /** 游戏像素 → 画布像素的放大倍数 */
  zoom?: number;
}) {
  const zoom = props.zoom ?? 2;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<FirstFrame | null>(null);
  const [failed, setFailed] = useState(false);
  const dragRef = useRef<{ lastX: number; lastY: number } | null>(null);

  const margin = 90; // 画布四周留白（画布像素）：偏移拖出容器框的部分落在这里
  const canvasW = Math.round(CONTAINER_W * zoom) + margin * 2;
  const canvasH = Math.round((LABEL_H + SPRITE_H) * zoom) + margin * 2;

  useEffect(() => {
    let cancelled = false;
    if (!props.src) {
      frameRef.current = null;
      setFailed(false);
      draw();
      return;
    }
    setFailed(false);
    loadFirstFrame(props.src).then((frame) => {
      if (cancelled) return;
      frameRef.current = frame;
      if (!frame) setFailed(true);
      draw();
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.src]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = canvasW;
    canvas.height = canvasH;
    // NPC 是像素素材，保持最近邻采样 —— 与列表缩略图（FrameAnimation pixelated）一致，#1312 口径
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvasW, canvasH);

    const cx = canvasW / 2;
    const cy = canvasH / 2;
    const z = zoom;

    // —— 骨架参考（虚线框不参与计算，只给眼睛对位置）：容器 100×170、名字条、精灵区 ——
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = "rgba(96,165,250,0.8)";
    ctx.strokeRect(cx - (CONTAINER_W * z) / 2, cy - (LABEL_H + SPRITE_H) * z / 2, CONTAINER_W * z, (LABEL_H + SPRITE_H) * z);
    ctx.strokeStyle = "rgba(100,116,139,0.6)";
    // 名字条（画布 y 向下：引擎 +75 → 画布 -75）
    ctx.strokeRect(cx - (SPRITE_W * z) / 2, cy - LABEL_CENTER_Y * z - (LABEL_H * z) / 2, SPRITE_W * z, LABEL_H * z);
    // 精灵区
    ctx.strokeRect(cx - (SPRITE_W * z) / 2, cy - SPRITE_CENTER_Y * z - (SPRITE_H * z) / 2, SPRITE_W * z, SPRITE_H * z);
    ctx.restore();
    // 名字条里的真实名称
    ctx.save();
    ctx.fillStyle = "rgba(148,163,184,0.9)";
    ctx.font = `${Math.max(10, Math.round(12 * z / 2))}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(props.label || "（未命名）", cx, cy - LABEL_CENTER_Y * z);
    ctx.restore();
    // 地图点位十字（容器中心，加粗一点区别于普通参考线）
    ctx.save();
    ctx.strokeStyle = "rgba(224,180,90,0.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - 10, cy);
    ctx.lineTo(cx + 10, cy);
    ctx.moveTo(cx, cy - 10);
    ctx.lineTo(cx, cy + 10);
    ctx.stroke();
    ctx.restore();

    // —— NPC 障碍碰撞盒（#1339）：红色实感框（客户端调试显示的障碍配色 rgba(255,64,64)），比对精灵脚下与挡位范围 ——
    ctx.save();
    ctx.setLineDash([8, 4]);
    ctx.strokeStyle = "rgba(255,64,64,0.85)";
    ctx.fillStyle = "rgba(255,64,64,0.08)";
    const colliderX = cx - (COLLIDER_W * z) / 2;
    const colliderY = cy - COLLIDER_CENTER_Y * z - (COLLIDER_H * z) / 2;
    ctx.fillRect(colliderX, colliderY, COLLIDER_W * z, COLLIDER_H * z);
    ctx.strokeRect(colliderX, colliderY, COLLIDER_W * z, COLLIDER_H * z);
    ctx.restore();

    // —— 精灵：原始纹理尺寸 × scale，中心 = 精灵区中心 + (posX, posY)（引擎 y 向上 → 画布翻转） ——
    const frame = frameRef.current;
    if (!frame) return;
    const spriteW = frame.rotated ? frame.h : frame.w;
    const spriteH = frame.rotated ? frame.w : frame.h;
    if (!spriteW || !spriteH) return;
    const frameW = spriteW * props.value.scaleX * z;
    const frameH = spriteH * props.value.scaleY * z;
    const centerX = cx + props.value.posX * z;
    const centerY = cy - (SPRITE_CENTER_Y + props.value.posY) * z;
    const rw = frame.rotated ? frameH : frameW;
    const rh = frame.rotated ? frameW : frameH;
    ctx.save();
    ctx.translate(centerX, centerY);
    if (frame.rotated) {
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(frame.image, frame.x, frame.y, frame.w, frame.h, -rh / 2, -rw / 2, rh, rw);
    } else {
      ctx.drawImage(frame.image, frame.x, frame.y, frame.w, frame.h, -rw / 2, -rh / 2, rw, rh);
    }
    ctx.restore();
  }, [canvasW, canvasH, props.label, props.value, zoom]);

  useEffect(() => {
    draw();
  }, [draw]);

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { lastX: event.clientX, lastY: event.clientY };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = (event.clientX - drag.lastX) / zoom;
    const dy = -(event.clientY - drag.lastY) / zoom;
    dragRef.current = { lastX: event.clientX, lastY: event.clientY };
    props.onChange({
      ...props.value,
      posX: clamp(Math.round(props.value.posX + dx), -OFFSET_MAX, OFFSET_MAX),
      posY: clamp(Math.round(props.value.posY + dy), -OFFSET_MAX, OFFSET_MAX),
    });
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-center rounded border border-line-strong/60 bg-surface-2/40 p-2">
        {failed ? (
          <p className="py-16 text-sm text-ink-5">首帧加载失败（素材目录指向的图集不存在？）。</p>
        ) : (
          <canvas
            ref={canvasRef}
            className="cursor-move touch-none rounded bg-surface-0/80"
            style={{ imageRendering: "pixelated", maxWidth: "100%" }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="横向缩放" hint="1 = 原尺寸（0.1~10）">
          <Input
            type="number"
            step="0.1"
            min={SCALE_MIN}
            max={SCALE_MAX}
            value={props.value.scaleX}
            onChange={(event) => props.onChange({ ...props.value, scaleX: clamp(Number(event.target.value) || SCALE_MIN, SCALE_MIN, SCALE_MAX) })}
          />
        </Field>
        <Field label="纵向缩放" hint="1 = 原尺寸（0.1~10）">
          <Input
            type="number"
            step="0.1"
            min={SCALE_MIN}
            max={SCALE_MAX}
            value={props.value.scaleY}
            onChange={(event) => props.onChange({ ...props.value, scaleY: clamp(Number(event.target.value) || SCALE_MIN, SCALE_MIN, SCALE_MAX) })}
          />
        </Field>
      </div>
      <p className="text-xs text-ink-5">
        蓝虚线 = 客户端节点容器（100×170）；灰虚线 = 名字条 / 精灵区；橙色十字 = 地图点位（碰撞与交互的圆心）；
        红框 = NPC 障碍碰撞盒（100×100 贴容器底，玩家站不进这块）。在画布上拖拽 = 调横向 / 纵向偏移；缩放改数字。
        对齐时让精灵的「脚」落进红框即可。画布上看到的相对关系 = 游戏里摆出来的。
      </p>
    </div>
  );
}
