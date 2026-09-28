import { BoxCollider2D, ERigidBody2DType, Node, RigidBody2D, UITransform } from "cc";

/** 添加碰撞 */
export function addObstacleCollider(node: Node) {
  const rigidBody = node.addComponent(RigidBody2D);
  rigidBody.type = ERigidBody2DType.Static;
  const collider = node.addComponent(BoxCollider2D);
  collider.size = node.getComponent(UITransform).contentSize;
}
