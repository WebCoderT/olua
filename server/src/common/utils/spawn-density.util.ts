import { MapPixelRect, SpawnAreaRect } from "./spawn-area-bounds.util";

/**
 * 投放密度与落点几何（#852 / docs/27 §2.2.1、§2.2.2 的 E2）
 *
 * 这些是**纯函数**，世界进程的 tick 与世界服务之外的读者（管理端地图页要显示「此刻目标
 * 几只」）用的是同一份实现 —— 各写一遍的话，页面上的目标数迟早和场上实际刷的数字对不上。
 *
 * 公式（docs/27 已定）：
 *
 * ```
 * target = clamp(round(max × 时段系数 × 人数系数), min, max × density_peak)
 * 时段系数 = peak_hours 为空 ? 1 : (在窗口内 ? density_peak : density_off)
 * 人数系数 = 1 + min(0.5, (本图在线人数 - 1) × 0.1)
 * ```
 *
 * 为什么是「系数」而不是「每人配几只」：系数可空、默认 1.0，不配时行为与加字段前一模一样，
 * 运营可以逐图灰度。
 */

/**
 * 一个刷怪区当前该有几只
 *
 * @param online 这张图的观看者数（不是全服在线：全服人数会让冷门图跟着热门图一起涨）
 * @param now    判定峰谷的时刻（毫秒）
 */
export function spawnTargetOf(
  area: {
    min: number;
    max: number;
    density_peak: number | null;
    density_off: number | null;
    peak_hours: string | null;
  },
  online: number,
  now: number,
): number {
  const max = Math.max(0, Math.floor(area.max));
  const peak = Math.max(0, area.density_peak ?? 1);
  const off = Math.max(0, area.density_off ?? 1);
  const window = parsePeakHours(area.peak_hours);
  const factor = window === null ? 1 : inPeakWindow(window, now) ? peak : off;
  const crowd = 1 + Math.min(0.5, Math.max(0, online - 1) * 0.1);
  const ceiling = Math.max(max, Math.round(max * peak));
  const floor = Math.min(ceiling, Math.max(0, Math.floor(area.min)));
  return Math.min(ceiling, Math.max(floor, Math.round(max * factor * crowd)));
}

/**
 * 解析 `"19:00-23:00"`（分钟数）
 *
 * 空 / 写错 / 小时越界一律返回 null = 无峰谷：一个错字不该把整张图的密度打到 0。
 * 时区按**服务进程所在时区**（运营和服务器同区，不引入时区配置）。
 */
export function parsePeakHours(text: string | null): { from: number; to: number } | null {
  if (!text) return null;
  const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const hours = [Number(match[1]), Number(match[3])];
  const minutes = [Number(match[2]), Number(match[4])];
  if (minutes.some((value) => value >= 60) || hours[0] >= 24 || hours[1] > 24) return null;
  if (hours[1] === 24 && minutes[1] !== 0) return null;
  return { from: hours[0] * 60 + minutes[0], to: hours[1] * 60 + minutes[1] };
}

/** 此刻是否在高峰窗口内（支持跨零点 `"22:00-02:00"`；起止相同按全天算） */
function inPeakWindow(window: { from: number; to: number }, now: number): boolean {
  if (window.from === window.to) return true;
  const at = new Date(now);
  const minutes = at.getHours() * 60 + at.getMinutes();
  return window.from < window.to
    ? minutes >= window.from && minutes < window.to
    : minutes >= window.from || minutes < window.to;
}

/**
 * 把区域矩形裁进地图范围（#850：越界的区域不再把怪刷到图外）
 *
 * 返回 null = 整块在图外（调用方退回原区域取点再 `clampPointToMap`，不让这区消失）。
 * 用「区域 ∩ 地图」而不是「把每只怪钳到边界上」：后者会把一整区的怪摞在图边一条线上，
 * 看着比刷在图外更怪。
 */
export function clampRectToMap(area: SpawnAreaRect, map: MapPixelRect): SpawnAreaRect | null {
  const left = Math.max(0, area.cx - area.w / 2);
  const right = Math.min(map.width, area.cx + area.w / 2);
  const bottom = Math.max(-map.height, area.cy - area.h / 2);
  const top = Math.min(0, area.cy + area.h / 2);
  if (right <= left || top <= bottom) return null;
  return { cx: (left + right) / 2, cy: (top + bottom) / 2, w: right - left, h: top - bottom };
}

/**
 * 把一个落点钳进地图范围（#850 的最后一道保险）
 *
 * 区域整个在图外、或区域是零面积的「点状区」时，`clampRectToMap` 给不出可用矩形，
 * 这里保证**落点**仍然在图内：宁可让这一区贴着图边站，也不让它凭空消失。
 */
export function clampPointToMap(point: { x: number; y: number }, map: MapPixelRect): { x: number; y: number } {
  return {
    x: Math.min(Math.max(point.x, 0), map.width),
    y: Math.min(Math.max(point.y, -map.height), 0),
  };
}

/** 一个点落在哪个刷怪区里（老档反查归属用；重叠时取先建的那个 —— 与播种顺序一致） */
export function findAreaAt<T extends SpawnAreaRect>(areas: T[], x: number, y: number): T | null {
  for (const area of areas) {
    if (x >= area.cx - area.w / 2 && x <= area.cx + area.w / 2 && y >= area.cy - area.h / 2 && y <= area.cy + area.h / 2) {
      return area;
    }
  }
  return null;
}
