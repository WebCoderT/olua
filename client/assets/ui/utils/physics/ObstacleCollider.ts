import { BoxCollider2D, ERigidBody2DType, Node, PolygonCollider2D, RigidBody2D, UITransform, Vec2 } from "cc";

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

/**
 * 静态障碍物碰撞体（多边形版，#1190）
 *
 * 与盒版同一套做法（静态刚体 + 与几何一致的碰撞体），差别只在形状：
 * `points` 是**相对节点原点**的顶点序列（PolygonCollider2D 的口径），首尾自动闭合。
 * 调用方负责把节点摆在多边形包围盒中心、顶点换算成相对坐标 —— 服务端快照里
 * 存的是世界坐标，两边「中心怎么取」必须用同一个公式（包围盒中心）。
 */
export function addPolygonObstacleCollider(node: Node, points: Vec2[]) {
  const rigidBody = node.addComponent(RigidBody2D);
  rigidBody.type = ERigidBody2DType.Static;
  const collider = node.addComponent(PolygonCollider2D);
  collider.points = points;
}
