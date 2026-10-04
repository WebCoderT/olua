import { Node, UITransform, Vec2, isValid } from "cc";
import { ensureMouseHitTestable, HAS_MOUSE, releaseWorldPress, trackUiPress } from "./Pointer";

/**
 * 命中检测（界面层 / 世界侧可交互对象）
 * 判断屏幕坐标点是否落在某个根节点（含整棵子树）的范围里：
 * · isPointOnUi 传 UI 根节点（LayerManager.UILayer）——「点 UI 不影响世界操作」的依据；
 * · isPointOnWorldInteractive 传世界侧容器（LayerManager.MapLayer）——NPC 这类**不在 UI 层、
 *   但点一下有自己反应**的对象，按下它不做「按住走路」、点它不改选中目标。
 *
 * 为什么需要它：引擎的全局输入监听（`input.on(Input.EventType.MOUSE_UP)` 等）**不会**因为点到了 UI 元素
 * 就自动屏蔽——节点事件与全局监听是两条独立通道（见引擎 pointer-event-dispatcher 的派发仲裁：
 * 只有事件注册在节点上、且该节点被点中时才吞掉事件、不再派发给全局监听）。
 * 项目里的按钮走 Button 组件（只注册 TOUCH_END 等），鼠标事件不会因此被吞掉，
 * 所以「点 UI 不影响世界操作」只能由全局监听这一侧自己判断。
 *
 * 判定顺序：同屏重叠时后绘制的在上，因此先判子节点（倒序，后加的先判）、再判自身；
 * 命中任一节点即视为命中。未激活（activeInHierarchy=false）的节点不参与判定。
 * 标记为「点击穿透」的节点（见 markClickThrough）及其整棵子树都不参与判定；
 * 反过来，UI 上的点击元素用 blockClickThrough 把鼠标事件通道也登记上，避免点击穿透到下层元素
 * （登记的同时还要把抬起的结束交还世界侧，否则按住走路会收不到抬起，见 blockClickThrough 的说明）。
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

/** 已在鼠标事件通道上登记过拦截的节点（节点销毁后自动回收，这里只用于防重复注册） */
const clickBlockedNodes = new WeakSet<Node>();

/**
 * 让节点在「鼠标事件通道」上也参与命中拦截——UI 点击不再穿透到下层元素
 *
 * 为什么必须做：引擎的输入派发按事件通道各走一套、互不影响（见引擎 2d/event/pointer-event-dispatcher）——
 * · touch 通道只派发给「注册过 TOUCH_* 监听的节点」，且 TOUCH_START 命中的那个节点独占本次触摸；
 * · mouse 通道只派发给「注册过 MOUSE_* 监听的节点」，按渲染优先级从上到下逐个命中测试，命中即中断。
 * 项目里的按钮是 Button 组件（内部只注册 TOUCH_*），于是它在 mouse 通道上**完全不可见**：
 * 一次鼠标点击会被派发两次——TOUCH_END 关掉弹窗，MOUSE_UP 继续往下找到小地图自己的 MOUSE_UP 监听，
 * 又把小地图弹窗打开（"点关闭按钮反而打开了小地图"就是这么来的）。
 *
 * 所以凡是 UI 上的点击元素（按钮/勾选/弹窗面板…），都在 mouse 通道上补登记一次监听：
 * 命中即中断，下层元素再也收不到这次点击。回调本身不做任何事——点击逻辑始终走元素自己的通道，
 * 这里只借「命中即中断」把 mouse 通道补齐。
 *
 * 只登记 MOUSE_UP，**故意不登记 MOUSE_DOWN / MOUSE_MOVE**：
 * · MOUSE_MOVE 是全局监听在用的（CursorInput 追踪指针位置 → CursorManager 判定指针样式、
 *   RolePointerInput 按住期间实时改走路方向），节点一旦命中就会吞掉它，指针移到按钮上时样式与拖动方向都会卡住；
 * · MOUSE_DOWN 不用登记也能拦住（引擎的 `_handleMouseDown` 只要命中测试通过就中断派发，
 *   与节点有没有 MOUSE_DOWN 监听无关），这里只额外让 trackUiPress 借它记一次「按压起点」
 *   （写的是引擎给的命中目标，各登记点写的都是同一个值，不会互相覆盖，见 Pointer.trackUiPress）。
 *
 * 独占的代价必须还回去：世界侧的「按住走路」以按下为开始、以抬起为结束，
 * 抬起一旦从这里被吞掉，世界侧的全局监听就再也收不到它——按住状态不解除，角色一直走
 * （点 NPC 弹出弹窗后角色一直走就是这么来的）。所以抬起处理里固定调 releaseWorldPress()
 * 把这次按压的结束交还世界侧（见 utils/input/Pointer 的「按压归属」）。
 *
 * 触屏环境（没有 mouse 通道）不登记：touch 通道本身只把 TOUCH_START 交给最上层命中的那个节点，
 * 不存在穿透，多登记只是多一份无用监听。
 *
 * 节点必须有 UITransform（否则鼠标事件既命不中、又会让引擎在整理监听列表时抛空指针，
 * 见 Pointer.ensureMouseHitTestable），没有就直接跳过注册。
 */
export function blockClickThrough(node: Node) {
  if (!HAS_MOUSE) return;
  if (clickBlockedNodes.has(node)) return;
  if (!ensureMouseHitTestable(node, "blockClickThrough")) return;
  clickBlockedNodes.add(node);
  // 本节点在鼠标通道上有监听，就要顺手把「按压起点」记上（见 Pointer.trackUiPress）
  trackUiPress(node);
  node.on(
    Node.EventType.MOUSE_UP,
    () => {
      // 这次抬起被本节点独占（引擎命中即中断）：世界侧据此收尾，否则按住走路会一直走
      releaseWorldPress();
    },
    node,
  );
}

/**
 * 点是否落在 UI 上
 * @param root UI 根节点（项目里传 LayerManager.UILayer）
 * @param screenPoint 屏幕坐标点（EventMouse.getLocation()）
 */
export function isPointOnUi(root: Node, screenPoint: Vec2): boolean {
  if (!isValid(root)) return false;
  return hitNode(root, screenPoint, () => true);
}

/**
 * 「世界侧可交互对象」标记（NPC 这类：节点上有自己的点击行为，只是不在 UI 层）
 *
 * 用途：按下它属于交互（点开对话/传送），世界侧不该把它接管成「按住走路」，
 * 点它也不该改变世界侧的选中目标（见 RolePointerInput / ScreenClickInput）。
 * 标记要打在**注册了点击监听的节点**上：判定范围与它的点击范围天然一致。
 */
const worldInteractiveNodes = new WeakSet<Node>();

/** 标记为「世界侧可交互对象」（挂在注册点击监听的节点上） */
export function markWorldInteractive(node: Node) {
  worldInteractiveNodes.add(node);
}

/**
 * 点是否落在某个「世界侧可交互对象」上
 * @param root 世界侧容器（项目里传 LayerManager.MapLayer）
 * @param screenPoint 屏幕坐标点（EventMouse.getLocation()）
 */
export function isPointOnWorldInteractive(root: Node, screenPoint: Vec2): boolean {
  if (!isValid(root)) return false;
  return hitNode(root, screenPoint, (node) => worldInteractiveNodes.has(node));
}

/** 递归命中检测（子节点倒序优先，命中即返回）；isTarget 决定哪些节点算「命中目标」 */
function hitNode(node: Node, screenPoint: Vec2, isTarget: (node: Node) => boolean): boolean {
  if (!node.activeInHierarchy || clickThroughNodes.has(node)) return false;
  const children = node.children;
  for (let i = children.length - 1; i >= 0; i--) {
    if (hitNode(children[i], screenPoint, isTarget)) return true;
  }
  if (!isTarget(node)) return false;
  const transform = node.getComponent(UITransform);
  return !!transform && transform.hitTest(screenPoint);
}
