import { Node } from "cc";

/**
 * 节点树工具（纯函数）
 * 承载「节点层级结构」相关的通用操作，与 UI 样式无关
 */

/**
 * 清空节点下的全部子节点（真正销毁）
 * 注意引擎的 removeAllChildren 只把子节点从父节点摘下（实现只有 parent = null），并不会销毁它们，
 * 重建式刷新的容器（背包格子、装备槽、属性列表）一律用本方法，避免每次刷新都留下未销毁的残留节点，
 * 也让依赖 NODE_DESTROYED 收尾的逻辑（如物品悬停详情弹窗）能正常触发
 * @param node 目标节点
 */
export function clearChildren(node: Node) {
  // 先摘除（立刻不再渲染、不再参与命中判定），再销毁（销毁延迟到帧末执行，所以顺序不能反）
  const children = node.children.slice();
  node.removeAllChildren();
  children.forEach((child) => child.destroy());
}
