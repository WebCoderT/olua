import { BoxCollider2D, Node, Rect } from "cc";

/**
 * 碰撞盒查询（纯函数模块，#1139 移动收权后的残部）
 *
 * 角色与怪物都不再跑本地物理/阻挡预测：位置是服务端帧的纯演出，穿墙与否由服务端的
 * 位移校验（`MovementGuardService`）与滑行步进说了算。这里只剩一条查询 ——
 * 怪物碰撞盒的世界包围盒，供自动战斗的寻路网格把「怪物占着的格子」标成不可走
 * （见 MonsterManager.getBlockingRects）。
 */

/** 取节点碰撞盒的世界包围盒（无碰撞体返回 null；返回的是副本，可安全平移做预测） */
export function getWorldColliderRect(node: Node): Rect | null {
  const aabb = node.getComponent(BoxCollider2D)?.worldAABB;
  return aabb ? new Rect(aabb.x, aabb.y, aabb.width, aabb.height) : null;
}
