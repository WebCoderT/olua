import { Vec2 } from "cc";
import { dropRuntime } from "../../../configs/drop";

/**
 * 掉落物散落位置（纯函数模块）
 *
 * 掉落物节点在世界坐标里没有额外缩放（相机为正交 2D），所以「世界坐标里的距离 = 屏幕上看到的距离」，
 * 这里直接按世界坐标铺开即可保证视觉上不重叠。
 *
 * 做法：以落点为圆心，从内向外一圈圈（半径 = 圈数 × minDistance）放点，
 * 每个候选点都要与**所有已放好的点**距离 ≥ minDistance 才采用（贪心铺满最内圈），
 * 因此任意两件掉落物都不会堆在同一个点上，且整体尽量紧凑。
 * 同一次掉落的形状固定（不随机旋转），便于复现问题；位置随怪物死亡点平移。
 */

/**
 * 计算散落偏移（相对落点的坐标，第 0 件总是落在落点本身）
 * @param count 掉落物数量
 * @param minDistance 最小中心间距，缺省 configs/drop.dropRuntime.scatterMinDistance
 * @returns 长度 = count 的偏移数组；count ≤ 0 时返回空数组
 */
export function scatterDropPositions(count: number, minDistance: number = dropRuntime.scatterMinDistance): Vec2[] {
  const total = Math.max(0, Math.floor(count));
  const positions: Vec2[] = [];
  if (!total) return positions;
  positions.push(new Vec2(0, 0));
  const limit = minDistance * minDistance;
  for (let index = 1; index < total; index++) {
    let placed: Vec2 | null = null;
    // 从内圈往外找第一个站得下的位置：半径 k×d 的圆上按细步长取样，取第一个满足最小间距的角度
    for (let ring = 1; ring <= total + 1 && !placed; ring++) {
      const radius = ring * minDistance;
      const steps = Math.max(8, Math.ceil((Math.PI * 2 * radius) / (minDistance * 0.5)));
      for (let step = 0; step < steps; step++) {
        // 每圈错开一点相位，避免所有点排在一条直线上
        const angle = (Math.PI * 2 * step) / steps + ring * 0.7;
        const candidate = new Vec2(Math.cos(angle) * radius, Math.sin(angle) * radius);
        const ok = positions.every((point) => {
          const dx = point.x - candidate.x;
          const dy = point.y - candidate.y;
          return dx * dx + dy * dy >= limit;
        });
        if (ok) {
          placed = candidate;
          break;
        }
      }
    }
    // 理论上 count 个点总能铺下（圈数上限随 count 增长）；真出现兜底时退化为落点堆叠，不影响流程
    positions.push(placed ?? new Vec2(0, 0));
  }
  return positions;
}
