import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { loadFirstFrame } from "./GameImage";
import type { FirstFrame } from "./GameImage";
import { Button, Field, Input } from "./ui";

/**
 * 显示效果工作台（#700）：以素材**第一帧**为基准，拖拽调位置、输入 / 滑杆调尺寸
 *
 * 与「装备对齐」工作台同一套交互取向（画布 + 拖拽 + 数值联动），两种适配口径（fit）：
 * - `contain`（边框）：第一帧 contain 缩进基准框居中，scale 乘在缩进结果上，x/y 相对基准框中心；
 * - `width-top`（详情背景）：**宽度 = 基准框宽 × scale、高度按帧原始比例自适应、顶边贴基准框顶**，
 *   x/y 相对「顶边中点」偏移（y 向上，与引擎同口径；画布 y 向下，画和拖的时候翻转）。
 *
 * 画布上看到的 = 客户端会摆出的相对关系（同为第一帧基准、同一套口径），
 * 只是不带游戏里的动画与周边 UI —— 这是「页面上看到的就是游戏里看到的」的最小实现。
 */

/** effect 数值限界（与服务端 APPEARANCE_EFFECT_LIMITS 同口径；UI 先拦、服务端再校验） */
const OFFSET_MAX = 2000;
const SCALE_MIN = 0.1;
const SCALE_MAX = 10;

export type AppearanceEffectValue = { x: number; y: number; scale: number };

export const DEFAULT_EFFECT: AppearanceEffectValue = { x: 0, y: 0, scale: 1 };

export function isDefaultEffect(effect: AppearanceEffectValue | undefined | null): boolean {
  if (!effect) return true;
  return effect.x === 0 && effect.y === 0 && effect.scale === 1;
}

/** effect 摘要（列表 / 棋盘格里的单行说明；默认效果显示「默认」） */
export function describeEffect(effect: AppearanceEffectValue | undefined | null): string {
  if (!effect || isDefaultEffect(effect)) return "默认";
  const parts: string[] = [];
  if (effect.x !== 0) parts.push(`x ${effect.x > 0 ? "+" : ""}${effect.x}`);
  if (effect.y !== 0) parts.push(`y ${effect.y > 0 ? "+" : ""}${effect.y}`);
  if (effect.scale !== 1) parts.push(`×${effect.scale}`);
  return parts.join(" ");
}

export function AppearanceEffectWorkbench(props: {
  /** 图集路径（GameFrame 同口径：borders/sfx_x 或 backgrounds/sfx_x，两级尝试自动命中） */
  atlas: string;
  /** 基准外框（游戏像素）：边框 = 56×56 外框 / 背景 = 详情弹窗面板 */
  box: { width: number; height: number };
  /** 适配口径：contain（边框，默认）= 缩进基准框居中；width-top（背景）= 宽度贴框、顶边对齐 */
  fit?: "contain" | "width-top";
  /** 参考内框（只画虚线给眼晴对位置用，不参与计算），如边框场景的 40×40 图标 */
  innerBox?: { width: number; height: number } | null;
  value: AppearanceEffectValue;
  onChange: (next: AppearanceEffectValue) => void;
  /** 游戏像素 → 画布像素的放大倍数（边框素材小，放大画才好拖） */
  zoom: number;
  hint?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<FirstFrame | null>(null);
  const [failed, setFailed] = useState(false);
  const dragRef = useRef<{ lastX: number; lastY: number } | null>(null);

  const margin = 90; // 画布四周留白（画布像素）：偏移拖出基准框的部分落在这里
  const canvasW = Math.round(props.box.width * props.zoom) + margin * 2;
  const canvasH = Math.round(props.box.height * props.zoom) + margin * 2;

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    loadFirstFrame(props.atlas).then((frame) => {
      if (cancelled) return;
      frameRef.current = frame;
      if (!frame) setFailed(true);
      draw();
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.atlas]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const frame = frameRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = canvasW;
    canvas.height = canvasH;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvasW, canvasH);

    const cx = canvasW / 2;
    const cy = canvasH / 2;
    const z = props.zoom;

    // —— 基准外框（ dashed 蓝灰）与参考内框（dashed 更暗） ——
    const drawDashedRect = (w: number, h: number, color: string) => {
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = color;
      ctx.strokeRect(cx - (w * z) / 2, cy - (h * z) / 2, w * z, h * z);
      ctx.restore();
    };
    drawDashedRect(props.box.width, props.box.height, "rgba(96,165,250,0.8)");
    if (props.innerBox) drawDashedRect(props.innerBox.width, props.innerBox.height, "rgba(100,116,139,0.6)");
    // 中心十字
    ctx.save();
    ctx.strokeStyle = "rgba(148,163,184,0.5)";
    ctx.beginPath();
    ctx.moveTo(cx - 8, cy);
    ctx.lineTo(cx + 8, cy);
    ctx.moveTo(cx, cy - 8);
    ctx.lineTo(cx, cy + 8);
    ctx.stroke();
    ctx.restore();

    if (!frame) return;
    // —— 第一帧 → 乘 scale → 加偏移（画布 y 向下，effect.y 向上要翻转） ——
    const spriteW = frame.rotated ? frame.h : frame.w;
    const spriteH = frame.rotated ? frame.w : frame.h;
    if (!spriteW || !spriteH) return;
    let frameW: number;
    let frameH: number;
    let centerX: number;
    let centerY: number;
    if (props.fit === "width-top") {
      // 背景口径：宽度 = 基准框宽 × scale，高度按帧原始比例，顶边贴基准框顶（x/y 相对顶边中点）
      frameW = props.box.width * props.value.scale * z;
      frameH = frameW * (spriteH / spriteW);
      centerX = cx + props.value.x * z;
      centerY = cy - (props.box.height * z) / 2 + frameH / 2 - props.value.y * z;
    } else {
      // 边框口径：contain 缩进基准框居中，scale 乘在缩进结果上（x/y 相对基准框中心）
      const fit = Math.min(props.box.width / spriteW, props.box.height / spriteH);
      frameW = spriteW * fit * props.value.scale * z;
      frameH = spriteH * fit * props.value.scale * z;
      centerX = cx + props.value.x * z;
      centerY = cy - props.value.y * z;
    }
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
  }, [canvasW, canvasH, props.box, props.fit, props.innerBox, props.value, props.zoom]);

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
    const dx = (event.clientX - drag.lastX) / props.zoom;
    const dy = -(event.clientY - drag.lastY) / props.zoom;
    dragRef.current = { lastX: event.clientX, lastY: event.clientY };
    props.onChange({
      x: clampOffset(Math.round(props.value.x + dx)),
      y: clampOffset(Math.round(props.value.y + dy)),
      scale: props.value.scale,
    });
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const effectSummary = useMemo(() => describeEffect(props.value), [props.value]);

  return (
    <div className="flex flex-col gap-3">
      {props.hint ? <p className="text-xs text-slate-500">{props.hint}</p> : null}
      <div className="flex justify-center rounded border border-slate-700/60 bg-slate-900/40 p-2">
        {failed ? (
          <p className="py-16 text-sm text-slate-500">首帧加载失败（key 指向的图集不存在？先确认 key 再调效果）。</p>
        ) : (
          <canvas
            ref={canvasRef}
            className="cursor-move touch-none rounded bg-slate-950/80"
            style={{ imageRendering: "pixelated", maxWidth: "100%" }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
        )}
      </div>
      <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_1fr_1.4fr_auto]">
        <Field label="水平偏移 x（像素）">
          <Input
            type="number"
            value={String(props.value.x)}
            onChange={(event) => props.onChange({ ...props.value, x: clampOffset(Number(event.target.value) || 0) })}
          />
        </Field>
        <Field label="垂直偏移 y（像素，上为正）">
          <Input
            type="number"
            value={String(props.value.y)}
            onChange={(event) => props.onChange({ ...props.value, y: clampOffset(Number(event.target.value) || 0) })}
          />
        </Field>
        <Field label={`尺寸倍率 scale（${effectSummary}）`}>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={SCALE_MIN}
              max={3}
              step={0.05}
              value={Math.min(props.value.scale, 3)}
              className="h-1 w-full accent-blue-500"
              onChange={(event) => props.onChange({ ...props.value, scale: round2(Number(event.target.value)) })}
            />
            <Input
              type="number"
              className="w-20"
              min={SCALE_MIN}
              max={SCALE_MAX}
              step={0.05}
              value={String(props.value.scale)}
              onChange={(event) => props.onChange({ ...props.value, scale: clampScale(Number(event.target.value) || 1) })}
            />
          </div>
        </Field>
        <Button variant="ghost" disabled={isDefaultEffect(props.value)} onClick={() => props.onChange({ ...DEFAULT_EFFECT })}>
          重置
        </Button>
      </div>
    </div>
  );
}

const clampOffset = (value: number): number => Math.min(Math.max(Math.round(value), -OFFSET_MAX), OFFSET_MAX);
const clampScale = (value: number): number => Math.min(Math.max(round2(value), SCALE_MIN), SCALE_MAX);
const round2 = (value: number): number => Math.round(value * 100) / 100;
