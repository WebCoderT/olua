import { HAS_MOUSE, ensureMouseHitTestable, trackUiPress } from "./Pointer";
import { Node } from "cc";
import LayerManager from "../../core/LayerManager";

/**
 * 「点中弹窗即浮到其它弹窗之上」的行为接线（#1386 从 dialog-builder 移入）
 *
 * 同屏多弹窗的层级直觉：最近点过的那个在最上层。从 createDialog 的骨架组件
 * （DialogFrame）与自建面板弹窗（确认框 / 举报 / 商城网格等）共用。
 *
 * @param node 弹窗根，或弹窗内的任意节点（后者由 LayerManager 沿祖先找到所属弹窗）——
 *   那些**把触摸收住、不让事件冒泡到弹窗根**的手势区域（如背包网格，见 BagGridView.setupTouchOwnership）
 *   必须自己挂一次，否则在它里面按下时弹窗不会浮上来
 *
 * 两条输入通道都要接管（引擎的两条通道各自独立派发，见 utils/input/UiHit 的说明）：
 * · 触摸通道：TOUCH_START 冒泡到弹窗根 —— 点到弹窗内任何位置（含子按钮、子列表）都会走到这里；
 * · 鼠标通道：MOUSE_DOWN 同样沿祖先链冒泡（引擎命中测试后 `event.bubbles = true`，见 utils/input/Pointer）；
 *   只登记 MOUSE_DOWN —— **不登记 MOUSE_MOVE**：节点一旦命中就会吞掉它，指针样式与按住走路都会卡住。
 *
 * 提层只是改兄弟序号，不影响本次触摸/鼠标的归属（触摸通道在 TOUCH_START 已把整段触摸判给命中节点，
 * 拖动弹窗照旧），也不改变遮挡关系：模态遮罩命中时事件不会冒泡到它下面的弹窗（兄弟不在冒泡链上）。
 */
export function bindDialogRaiseOnPress(node: Node) {
  node.on(Node.EventType.TOUCH_START, () => LayerManager.raiseDialog(node));
  if (!HAS_MOUSE) return;
  if (!ensureMouseHitTestable(node, "bindDialogRaiseOnPress")) return;
  // 本节点也注册了鼠标事件，顺手登记「按压起点」（本节点通常已由 blockClickThrough 登记过，幂等）
  trackUiPress(node);
  node.on(Node.EventType.MOUSE_DOWN, () => LayerManager.raiseDialog(node));
}
