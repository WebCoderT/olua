import { Node, UITransform, Vec2, isValid } from "cc";

/**
 * UI 命中检测
 * 判断屏幕坐标点是否落在某个 UI 根节点（含整棵子树）的元素范围内
 *
 * 为什么需要它：引擎的全局输入监听（`input.on(Input.EventType.MOUSE_UP)` 等）**不会**因为点到了 UI 元素
 * 就自动屏蔽——节点事件与全局监听是两条独立通道（见引擎 pointer-event-dispatcher 的派发仲裁：
 * 只有事件注册在节点上、且该节点被点中时才吞掉事件、不再派发给全局监听）。
 * 项目里的按钮走 Button 组件（只注册 TOUCH_END 等），鼠标事件不会因此被吞掉，
 * 所以「点 UI 不影响世界操作」只能由全局监听这一侧自己判断。
 *
 * 判定顺序：同屏重叠时后绘制的在上，因此先判子节点（倒序，后加的先判）、再判自身；
 * 命中任一节点即视为点中 UI。未激活（activeInHierarchy=false）的节点不参与判定。
 * 标记为「点击穿透」的节点（见 markClickThrough）及其整棵子树都不参与判定。
 *
 * 注意入参必须是**屏幕坐标**（`EventMouse.getLocation()`），不是 UI 坐标（`getUILocation()`）：
 * `UITransform.hitTest` 内部会把屏幕坐标经相机反算到节点本地空间。
 */

/** 点击穿透节点（飘字提示这类临时装饰：视觉上在 UI 层，但不该挡住世界点击） */
const clickThroughNodes = new WeakSet<Node>();

/**
 * 标记节点为「点击穿透」：该节点及其子树都不参与 UI 命中判定（点击穿过它落到世界里）
 * 节点销毁后自动从集合中回收，无需手动清理
 */
export function markClickThrough(node: Node) {
  clickThroughNodes.add(node);
}

/**
 * 点是否落在 UI 上
 * @param root UI 根节点（项目里传 LayerManager.UILayer）
 * @param screenPoint 屏幕坐标点（EventMouse.getLocation()）
 */
export function isPointOnUi(root: Node, screenPoint: Vec2): boolean {
  if (!isValid(root)) return false;
  return hitNode(root, screenPoint);
}

/** 递归命中检测（子节点倒序优先，命中即返回） */
function hitNode(node: Node, screenPoint: Vec2): boolean {
  if (!node.activeInHierarchy || clickThroughNodes.has(node)) return false;
  const children = node.children;
  for (let i = children.length - 1; i >= 0; i--) {
    if (hitNode(children[i], screenPoint)) return true;
  }
  const transform = node.getComponent(UITransform);
  return !!transform && transform.hitTest(screenPoint);
}
