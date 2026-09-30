import { BoxCollider2D, game, Node, Rect, Vec2 } from "cc";

/** 预测步长上限（秒）：卡顿帧按上限估算位移，避免一口气跳过阻挡物 */
const MAX_PREDICT_STEP = 0.05;

/**
 * 移动阻挡（纯函数模块）
 * 「谁能挡住谁」在本项目里的三层关系：
 * - 静态障碍（树/墙/NPC）：静态刚体，物理引擎自带阻挡，角色推不动它
 * - 怪物：运动学刚体 + 传感器碰撞盒（见 addMonsterCollider），物理引擎不产生任何碰撞响应，
 *   因此怪不会把角色顶开、角色也推不动怪（谁都不会推动谁走）
 * - 怪物对角色「不可穿越」这一条由本模块手动补上：角色移动前用碰撞盒做一次位移预测，
 *   会撞上就不允许这一步。因为只是「不允许移动」而不是「把对方挤开」，所以谁都不会被推动；
 *   场上唯一能推动位置的途径是技能击退（见 MonsterAI.push）
 */

/** 取节点碰撞盒的世界包围盒（无碰撞体返回 null；返回的是副本，可安全平移做预测） */
export function getWorldColliderRect(node: Node): Rect | null {
  const aabb = node.getComponent(BoxCollider2D)?.worldAABB;
  return aabb ? new Rect(aabb.x, aabb.y, aabb.width, aabb.height) : null;
}

/** 把包围盒按位移平移，得到「移动后」的包围盒 */
function movedRect(rect: Rect, delta: Vec2): Rect {
  return new Rect(rect.x + delta.x, rect.y + delta.y, rect.width, rect.height);
}

/**
 * 计算被阻挡后的实际位移（分轴滑动）
 * 规则：只挡住「本来没重叠、这一步会重叠」的移动 —— 已经重叠的阻挡物直接放行，
 * 避免怪贴在角色身上时把角色彻底卡死（贴上了也还能走开）
 * 整体位移被挡时依次尝试单轴，让角色能贴着怪物侧滑过去，而不是硬邦邦地停住
 * @param self 自身当前的碰撞盒（世界坐标）
 * @param delta 期望位移（像素）
 * @param blockings 阻挡物的碰撞盒（世界坐标）
 * @returns 实际允许的位移（被完全挡住时为 (0, 0)）
 */
export function resolveBlockedMove(self: Rect, delta: Vec2, blockings: Rect[]): Vec2 {
  if ((delta.x === 0 && delta.y === 0) || !blockings.length) return delta;
  // 已经重叠的阻挡物不参与判定（否则会被永久卡住）
  const active = blockings.filter((rect) => !rect.intersects(self));
  if (!active.length) return delta;
  const isBlocked = (target: Rect) => active.some((rect) => rect.intersects(target));
  // 整体位移
  if (!isBlocked(movedRect(self, delta))) return delta;
  // 整体位移被挡：尝试沿单轴滑动
  const horizontal = new Vec2(delta.x, 0);
  if (horizontal.x !== 0 && !isBlocked(movedRect(self, horizontal))) return horizontal;
  const vertical = new Vec2(0, delta.y);
  if (vertical.y !== 0 && !isBlocked(movedRect(self, vertical))) return vertical;
  return new Vec2();
}

/**
 * 速度驱动型移动的统一入口（角色与怪物共用）
 * 用「速度 × 本帧时长」预估这一步的位移，撞上阻挡物就取消/沿单轴滑开，
 * 再换算回速度交给刚体（位移只用于预测，刚体仍然只接受速度）
 * @param node 移动者（取自身碰撞盒做预测）
 * @param velocity 期望速度（像素/秒）
 * @param blockings 阻挡物的碰撞盒（世界坐标，无阻挡传空数组）
 * @returns 实际允许的速度
 */
export function resolveBlockedVelocity(node: Node, velocity: Vec2, blockings: Rect[]): Vec2 {
  if (!blockings.length || (velocity.x === 0 && velocity.y === 0)) return velocity;
  const self = getWorldColliderRect(node);
  if (!self) return velocity;
  const step = Math.min(game.deltaTime, MAX_PREDICT_STEP);
  if (step <= 0) return velocity;
  const allowed = resolveBlockedMove(self, new Vec2(velocity.x * step, velocity.y * step), blockings);
  return new Vec2(allowed.x / step, allowed.y / step);
}
