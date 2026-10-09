import { BoxCollider2D, ERigidBody2DType, Node, RigidBody2D, UITransform } from "cc";

/**
 * 怪物碰撞体
 * 怪物要能被 AI 驱动位移（追击玩家、原地随机走动、被技能击退），因此做成运动学刚体（Kinematic）：
 * - 由线速度驱动移动（与主角同一套做法，见 RoleDisplay），不会像静态体那样"挪不动"
 * - 碰撞盒一律是传感器（sensor = true）：只保留形状，不产生任何碰撞响应。
 *   这样怪撞上角色时不会把角色顶开，角色也推不动怪 —— 谁都不会推动谁走
 * - 形状本身仍有两处用途：攻击距离/朝向判定读 worldAABB（见 BattleMath）、调试范围显示读 size
 * - 怪与角色之间"不可穿越"由 MoveBlocking 手动补上（只取消移动，不挤开对方）；
 *   场上唯一能推动位置的途径是技能击退（见 MonsterAI.push）
 * 碰撞范围与节点尺寸一致，与静态障碍（addObstacleCollider）区分开
 */
export function addMonsterCollider(node: Node) {
  const rigidBody = node.addComponent(RigidBody2D);
  rigidBody.type = ERigidBody2DType.Kinematic;
  const collider = node.addComponent(BoxCollider2D);
  collider.size = node.getComponent(UITransform).contentSize;
  collider.sensor = true;
}
