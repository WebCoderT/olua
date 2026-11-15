/**
 * 掉落物散落坐标（纯函数模块，#802 从客户端 `client/assets/ui/utils/drop/DropScatter.ts` 搬来）
 *
 * ## 为什么要搬到服务端
 *
 * 掉落物现在是**世界级实体**（同图所有人看到同一堆），落点必须由服务端算一次下发。
 * 让每个客户端自己散落会出现两件事：两个人的屏幕上同一堆东西摆的位置不一样；服务端的
 * 拾取距离校验（`pickRange`）与画面上的位置对不上 —— 看着就在脚边，服务端却判 `too_far`。
 *
 * 算法本身与客户端那份一字不差（同心环贪心 + 每圈错相位），这里只是去掉了 `cc.Vec2`
 * 依赖。客户端那份在 #804 删除。
 */

/** 相对落点的偏移（世界坐标；第 0 件恒为 (0,0)） */
export interface ScatterOffset {
  x: number;
  y: number;
}

/**
 * 计算散落偏移（相对落点的坐标，第 0 件总是落在落点本身）
 *
 * 以落点为圆心从内向外一圈圈放点：半径 = 圈数 × `minDistance`，每个候选点都要与**所有
 * 已放好的点**距离 ≥ `minDistance` 才采用，所以任意两件不会堆在同一个点上，整体尽量紧凑。
 * 同一次掉落的形状固定（不随机旋转），便于复现问题；位置随怪物死亡点平移。
 */
export function scatterDropPositions(count: number, minDistance: number): ScatterOffset[] {
  const total = Math.max(0, Math.floor(count));
  const positions: ScatterOffset[] = [];
  if (!total) return positions;
  positions.push({ x: 0, y: 0 });
  const limit = minDistance * minDistance;
  for (let index = 1; index < total; index += 1) {
    let placed: ScatterOffset | null = null;
    // 从内圈往外找第一个站得下的位置：半径 k×d 的圆上按细步长取样，取第一个满足最小间距的角度
    for (let ring = 1; ring <= total + 1 && !placed; ring += 1) {
      const radius = ring * minDistance;
      const steps = Math.max(8, Math.ceil((Math.PI * 2 * radius) / (minDistance * 0.5)));
      for (let step = 0; step < steps; step += 1) {
        // 每圈错开一点相位，避免所有点排在一条直线上
        const angle = (Math.PI * 2 * step) / steps + ring * 0.7;
        const candidate = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
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
    // 理论上 count 个点总能铺下（圈数上限随 count 增长）；真出现兜底时退化为落点堆叠
    positions.push(placed ?? { x: 0, y: 0 });
  }
  return positions;
}

/**
 * 把一个新的落点从**该图已有掉落**旁边推开（docs/18 §5.2「跨击杀的重叠」）
 *
 * 单次击杀内部的散落已经由 `scatterDropPositions` 保证互不重叠，但两次击杀挨得很近时
 * （刷怪密集处连杀）两堆东西会叠在一起 —— 屏幕上像是一件，点拾取时永远只捡到其中一件。
 *
 * 做法：距离已有落点 < `minDistance / 2` 时，沿「背离最近那件」的径向推一圈，最多试 8 次；
 * 还冲突就接受重叠（不能为了摆位把掉落弄丢）。
 */
export function avoidOverlap(
  spot: { x: number; y: number },
  taken: Array<{ x: number; y: number }>,
  minDistance: number,
): { x: number; y: number } {
  if (taken.length === 0) return spot;
  const threshold = Math.max(1, minDistance / 2);
  let current = { x: spot.x, y: spot.y };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let nearest: { x: number; y: number } | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const other of taken) {
      const distance = Math.hypot(other.x - current.x, other.y - current.y);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = other;
      }
    }
    if (!nearest || nearestDistance >= threshold) return current;
    // 完全重合时没有方向可取 —— 用一个随尝试次数转动的角度，避免永远往同一个方向推
    const angle = nearestDistance > 0.01
      ? Math.atan2(current.y - nearest.y, current.x - nearest.x)
      : attempt * (Math.PI / 4);
    current = {
      x: nearest.x + Math.cos(angle) * threshold,
      y: nearest.y + Math.sin(angle) * threshold,
    };
  }
  return current;
}
