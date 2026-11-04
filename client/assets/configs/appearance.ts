import type { AppearanceEffect } from "../types/appearance";
export type { AppearanceEffect };

/**
 * 装备外观的显示效果（#700）：解析与缺省值（边框 / 背景两份配置表共用）
 *
 * 服务端 DTO 已按数值范围校验过一遍，这里只防「手改库 / 旧数据」：
 * effect 缺省（undefined / null）= 没调过，返回 undefined（调用方用缺省效果）；
 * 字段坏了（不是数字 / 越界）返回 undefined 并 warn —— **只丢效果不丢映射**，
 * 那条「组合 → key」本身还是好的。
 */

/** 缺省效果（与「没有 effect 字段」完全等价） */
export const DEFAULT_APPEARANCE_EFFECT: AppearanceEffect = { x: 0, y: 0, scale: 1 };

/** 数值限界（与服务端 APPEARANCE_EFFECT_LIMITS 同口径；防手改库，正常下发不会越界） */
const OFFSET_MAX = 2000;
const SCALE_MIN = 0.1;
const SCALE_MAX = 10;

/**
 * 解析一条数据的 effect 字段
 *
 * @param raw 条目上原样的 effect 值（可缺省）
 * @param warn 告警出口（边框 / 背景各自的日志前缀由调用方给）
 * @returns 合法效果；缺省或坏数据返回 undefined（调用方回落缺省效果）
 */
export function parseAppearanceEffect(raw: unknown, warn: (message: string) => void): AppearanceEffect | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") {
    warn(`effect 不是对象（${String(raw)}），回落默认效果`);
    return undefined;
  }
  const source = raw as Record<string, unknown>;
  const x = Number(source.x);
  const y = Number(source.y);
  const scale = Number(source.scale);
  if (!Number.isFinite(x) || Math.abs(x) > OFFSET_MAX || !Number.isFinite(y) || Math.abs(y) > OFFSET_MAX) {
    warn(`effect 偏移越界（x=${String(source.x)}, y=${String(source.y)}），回落默认效果`);
    return undefined;
  }
  if (!Number.isFinite(scale) || scale < SCALE_MIN || scale > SCALE_MAX) {
    warn(`effect 倍率越界（scale=${String(source.scale)}），回落默认效果`);
    return undefined;
  }
  return { x, y, scale };
}
