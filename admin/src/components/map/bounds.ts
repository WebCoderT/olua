import type { MapNpc, MapRevivePoint, MapSpawnArea } from "../../api";

/**
 * 刷怪区越界的显示辅助（#586）
 *
 * ## 判据不在这里
 *
 * 「在不在图内」由**服务端**按 `MAP_PIXEL_SIZES` 算好（`inBounds` / `overflow`），
 * 管理端只负责翻译成人话。页面自己拿 `cx/w` 再判一遍看起来无害，但那会变成第二个口径：
 * 服务端改了容差，页面还按老规则画绿 —— 这类「两个地方各判一次」的分叉，最后没人说得清哪个对。
 *
 * ## 为什么越界必须显式标出来（地图上能看出来也不行）
 *
 * 地图容器是 `overflow-hidden` 的（`MapCanvas`），越出 viewBox 的部分**会被裁掉** ——
 * 也就是说「区域摆到了图外」在图上表现为「这块区域不存在」，而不是「这块区域超出去了」。
 * 所以越界只能靠描边颜色 + 列表里的红字来表达，不能指望眼睛从图上发现。
 */

/** 越界（四边各越多少）→ 一行短文本，如 `右 96 / 下 24`；在图内给空串 */
export function overflowText(area: MapSpawnArea): string {
  const overflow = area.overflow;
  const parts: string[] = [];
  if (overflow.left > 0) parts.push(`左 ${overflow.left}`);
  if (overflow.right > 0) parts.push(`右 ${overflow.right}`);
  if (overflow.top > 0) parts.push(`上 ${overflow.top}`);
  if (overflow.bottom > 0) parts.push(`下 ${overflow.bottom}`);
  return parts.join(" / ");
}

/** 越界的完整解释（`title` 提示：越界量 + 该区域的四边坐标，避免再去表里换算） */
export function overflowTitle(area: MapSpawnArea): string {
  const left = area.cx - area.w / 2;
  const right = area.cx + area.w / 2;
  const top = area.cy + area.h / 2;
  const bottom = area.cy - area.h / 2;
  return [
    `「${area.name}」越出地图边界：${overflowText(area) || "（无）"} 像素`,
    `区域四边 x ∈ [${left}, ${right}]、y ∈ [${bottom}, ${top}]（世界坐标）`,
    "超出图外的怪不会出现在画面上；在地图管理页把这块区域重画一遍即恢复（越界区域在新建/修改时会被服务端直接拒）",
  ].join("\n");
}

/** 这张图有几处越界（0 = 一切正常，页面此时不该有红字） */
export function outOfBoundsCount(areas: MapSpawnArea[]): number {
  return areas.filter((area) => !area.inBounds).length;
}

/**
 * 点位越界数（NPC 点位 + 复活点，#672）
 *
 * 点位没有 `overflow` 量（一个点谈不上"越出多少"），只有服务端给的 `inBounds` 是非。
 * 所以这里只数个数 —— 与区域的 `outOfBoundsCount` 一起进页面右上角那个红徽标，
 * 于是「图上有个点跑到图外了」不需要打开任何弹窗才会被发现。
 */
export function pointsOutOfBounds(detail: { npcPoints: MapNpc[]; revivePoint: MapRevivePoint | null }): number {
  const npc = detail.npcPoints.filter((point) => !point.inBounds).length;
  const revive = detail.revivePoint && !detail.revivePoint.inBounds ? 1 : 0;
  return npc + revive;
}
