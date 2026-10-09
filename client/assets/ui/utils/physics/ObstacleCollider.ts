import { BoxCollider2D, ERigidBody2DType, Node, RigidBody2D, UITransform } from "cc";

/**
 * 静态障碍物碰撞体
 * 把节点做成不可穿越的障碍：静态刚体 + 与节点尺寸一致的盒碰撞体
 * NPC 与 Tiled 碰撞区域共用这一套做法
 */
export function addObstacleCollider(node: Node) {
  const rigidBody = node.addComponent(RigidBody2D);
  rigidBody.type = ERigidBody2DType.Static;
  const collider = node.addComponent(BoxCollider2D);
  collider.size = node.getComponent(UITransform).contentSize;
}
