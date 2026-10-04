import { Event, EventMouse, Input, input, isValid, Node, sys, UITransform, Vec2 } from "cc";

/** 指针按键（左键同时代表触屏点击） */
export type PointerButton = "left" | "right";

/**
 * 指针操作工具
 * 统一「节点上的鼠标/触摸操作」：鼠标环境区分左右键，触屏环境只回调左键
 *
 * 为什么必须二选一：引擎 input 会在派发 MOUSE_DOWN/MOUSE_UP 时**同时模拟一份 TOUCH_START/TOUCH_END**
 * （input.ts `_registerEvent` 里 `_simulateEventTouch` + `_dispatchEventMouse` 成对调用，且不看按键），
 * 所以同时监听 MOUSE_UP 与 TOUCH_END 会让一次鼠标点击触发两次回调。
 */

/** 是否鼠标环境（有鼠标事件时才存在左右键区分） */
export const HAS_MOUSE = sys.hasFeature(sys.Feature.EVENT_MOUSE);

/**
 * 取「命中检测」统一使用的屏幕坐标
 *
 * 为什么必须统一：`UITransform.hitTest` 内部会把传入的点经 `camera.screenToWorld` 反算到节点空间，
 * 所以它吃的是**屏幕坐标**（`EventMouse.getLocation()`，物理像素）——引擎自己的事件派发
 * （node-event-processor）与 Button 判定用的都是这个；而 `getUILocation()` 是设计分辨率下的 UI 坐标，
 * 只有画布尺寸恰好等于设计分辨率时两者才相等（画布越大差得越多），混用会让命中点整体偏移。
 * 因此「UI 命中、怪物命中、掉落物命中、光标悬停」全部从这里取点（见 utils/input/UiHit 的说明）。
 * @param event 鼠标事件
 * @returns 屏幕坐标（新对象）
 */
export function getHitScreenPoint(event: EventMouse): Vec2 {
  return event.getLocation();
}

/** 取鼠标事件的按键语义（非左右键返回 null） */
export function getPointerButton(event: EventMouse): PointerButton | null {
  if (event.getButton() === EventMouse.BUTTON_LEFT) return "left";
  if (event.getButton() === EventMouse.BUTTON_RIGHT) return "right";
  return null;
}

//#region 按压归属（世界侧 / 界面侧）

/**
 * 一次按压归谁：由**按下那一刻命中的界面元素**决定，抬起只是一次按压的结束
 *
 * 引擎的 touch 通道本来就有这个语义（pointer-event-dispatcher 的 claimedTouchIdList：
 * TOUCH_START 命中的那个节点独占整段触摸，别的节点要等它松手才可能拿到事件）；
 * 鼠标通道却没有——它是**每个事件各自命中测试**：按下点在小地图上、抬起点在按钮上，
 * 就成了小地图收按下、按钮收抬起（指针划过哪里、松在哪，哪里就响应）。
 * 这里把 mouse 通道缺的这半个语义补齐：
 * · 按下的那一刻，把「UI 树上的命中目标」记下来（trackUiPress，见下）；
 * · 抬起到某个界面元素时，只有「起点在我（或我的子树）里」才响应这次点击，否则只当作按压结束；
 * · 按下没有任何界面节点命中 → 全局监听才收得到 MOUSE_DOWN（界面节点命中即中断派发，
 *   见 pointer-event-dispatcher.dispatchEventMouse），于是这里把归属清成「不在界面上」。
 *
 * 为什么非补不可：世界侧的「按住走路」以按下为开始、以抬起为结束（RolePointerInput），
 * 而界面为了让点击不穿透，会在鼠标通道上「命中即独占」（UiHit.blockClickThrough）——
 * 独占的代价是**世界侧的全局监听从此收不到这次抬起**，按住状态永远不解除、角色一直走。
 * 点 NPC 弹出弹窗后角色一直走、按住走路把指针拖到界面元素上松开也会一直走，都是这个原因。
 * 所以：界面侧消费/拦下抬起时，必须 releaseWorldPress() 把这次按压的结束交还世界侧。
 */

/** 本次按压命中的界面元素（按下那一刻 UI 树上的 event.target）；null = 起点不在任何界面元素上 */
let pressTarget: Node | null = null;

/** 已登记「按压起点留痕」的节点（节点销毁后自动回收） */
const pressTrackedNodes = new WeakSet<Node>();

/** 记录起点的监听固定用这个哨兵当 target，免得被调用方的 off/targetOff 顺手摘掉 */
const PRESS_TRACKER = {};

/** 世界侧按住的收尾回调（同一时刻只可能有一个：一个场景一个 RoleDisplay） */
let worldPressRelease: (() => void) | null = null;

// 全局 MOUSE_DOWN 只在「没有任何界面节点命中这次按下」时才会派发到（界面命中即中断），
// 所以收到它就等于「这次按下的起点不在任何界面元素上」，把归属清掉即可
input.on(Input.EventType.MOUSE_DOWN, () => {
  pressTarget = null;
});

/**
 * 在节点上登记「本次按压命中的界面元素」——**凡是在节点上注册了鼠标事件的元素都必须调它**
 * （bindMousePress / UiHit.blockClickThrough 内部已自动调用；
 *  只注册 MOUSE_ENTER/MOUSE_LEAVE 的悬停元素要自己调，例如 ui/components/hud/StatusIconBar 的状态图标）
 *
 * 记的是 `event.target`（引擎给出的命中目标），**不是本节点**：
 * 节点事件是**冒泡**的——引擎 `node-event-processor` 在 `_handleMouseDown` 打完命中测试后
 * `event.bubbles = true; node.dispatchEvent(event)`，事件沿祖先链发给所有注册过 MOUSE_DOWN 的节点
 * （getBubblingTargets 从命中节点一路走到根）；而 `event.target` 只在派发开始时赋值一次
 * （`dispatchEvent` 里 `event.target = owner`），**整个冒泡阶段始终是最初命中的那个节点**。
 * 于是「每个元素各记各的」也不会互相覆盖：所有人都写同一个值（命中目标），
 * 谁先谁后、冒泡到几层都无所谓 —— 这正是前面两版栽的地方：
 * · 第一版让每个元素 `pressOwner = 自己`：祖先在冒泡阶段把内层元素覆盖成自己（由内往外，最后写的是最外层），
 *   内层抬起时匹配不上起点 → 弹窗内所有点击一起失灵（背包穿不上/卸不下、地图弹窗点不动）；
 * · 第二版把起点改到 UI 根统一记一次：逻辑对了，但 UI 根没有 UITransform，
 *   一注册鼠标事件就把引擎打崩（见 ensureMouseHitTestable 的长注释）。
 * 现在两头的坑都避开：登记点是「有 UITransform 的界面元素」，写的是「与顺序无关的命中目标」。
 */
export function trackUiPress(node: Node) {
  if (!HAS_MOUSE) return;
  if (!ensureMouseHitTestable(node, "trackUiPress")) return;
  if (pressTrackedNodes.has(node)) return;
  pressTrackedNodes.add(node);
  node.on(
    Node.EventType.MOUSE_DOWN,
    (event: Event) => {
      pressTarget = event.target ?? null;
    },
    PRESS_TRACKER,
  );
}

/**
 * 注册鼠标事件前的安全检查：节点必须有 UITransform
 *
 * 引擎的硬坑（3.8.7 已核实源码）：pointer-event-dispatcher 在每次鼠标事件前整理监听节点列表，
 * 会把每个节点的「相机优先级」缓存下来 ——
 *   `_sortPointerEventProcessorList()` 里
 *   `const node = processor.node; if (node._uiProps) { const trans = node._getUITransformComp();
 *     processor.cachedCameraPriority = trans!.cameraPriority; }`
 * 而 `node._uiProps` 在 Node 构造函数里就创建了（node.ts `public _uiProps = new NodeUIProperties(this)`），
 * `if (node._uiProps)` 对任何节点都成立；那个 `trans!` 又是非空断言（同一文件 `_sortByPriority` 里
 * 反而老老实实判了 `_getUITransformComp()`）。于是：
 * **只要一个没有 UITransform 的节点注册了任意鼠标事件（含 MOUSE_ENTER/MOUSE_LEAVE），
 * 下一次鼠标移动就会抛 `Cannot read properties of null (reading 'cameraPriority')`**，
 * 而且每个鼠标事件刷一次、整个预览的鼠标交互全部失效。
 * 没有 UITransform 的节点本来也命不中（`_handleMouseDown` 拿不到 comp 直接 return false），
 * 注册鼠标事件毫无意义、纯粹是踩雷。
 *
 * 所以这里统一拦一道：拿不到 UITransform 就不注册，并留下可查的日志（比在引擎里崩掉好诊断）。
 * @param node 目标节点
 * @param api 调用方（写进日志，便于定位是谁在注册）
 * @returns 是否可以安全注册
 */
export function ensureMouseHitTestable(node: Node, api: string): boolean {
  if (isValid(node) && node.getComponent(UITransform)) return true;
  console.warn(`[input] ${api}：节点「${node ? node.name : node}」没有 UITransform，鼠标事件既命不中、又会在引擎排序监听列表时抛 cameraPriority 空指针，已跳过注册`);
  return false;
}

/**
 * 本次按压的起点是否落在本节点（含整棵子树）内 —— 在 MOUSE_UP 处理里调用
 *
 * 为什么判「含子树」而不是「等于本节点」：内层节点自己也会监听鼠标事件——
 * 背包格子/装备槽里的物品图标注册了 MOUSE_ENTER（悬浮物品详情），点它时命中目标是图标而不是格子，
 * 所以判定要认「起点在我或我的子树里」。起点不在这里就不响应这次抬起，
 * 与 touch 通道的语义一致（在小地图上按下、拖到别的按钮上松开，不会误触发那个按钮）。
 *
 * 起点不会「过期」：每一次按下要么被某个界面元素记成命中目标（界面元素在鼠标通道上有监听时，
 * 它自己就是登记点，见 trackUiPress），要么落到全局 MOUSE_DOWN 被清成 null（按下没命中任何界面元素），
 * 所以这里读到的永远是「本次按压」的起点。
 */
export function isUiPressWithin(node: Node): boolean {
  const target = pressTarget;
  if (!target || !isValid(target)) return false;
  return target === node || target.isChildOf(node);
}

/** 世界侧登记「按住怎么收尾」（RolePointerInput；回调必须幂等：没按住时什么也不做） */
export function setWorldPressRelease(release: (() => void) | null) {
  worldPressRelease = release;
}

/** 世界侧注销自己的收尾回调（按引用比对，避免把新场景登记的顶掉） */
export function clearWorldPressRelease(release: () => void) {
  if (worldPressRelease === release) worldPressRelease = null;
}

/** 界面侧把这次抬起交还世界侧收尾（拦下/消费了抬起时必须调用，见本段开头说明） */
export function releaseWorldPress() {
  worldPressRelease?.();
}

//#endregion

/**
 * 为节点绑定「鼠标通道的整段按压」（按下 → 抬起）
 * 鼠标通道专用：触屏环境（没有 mouse 通道）直接返回，触屏走 bindPointerAction 的 TOUCH_END 分支
 * 只有「按下起点在本节点（或其子树）内」的那次抬起才回调 handler（与 touch 通道的 TOUCH_END 语义对齐）；
 * 更上层的界面元素先一步命中时，本节点连抬起都收不到（见 UiHit.blockClickThrough）
 * 抬起无论归不归本节点，都会把这次按压的结束交还世界侧（releaseWorldPress）——
 * 世界侧的按住走路就等着这个抬起，被界面吞掉就会一直走
 * @param node 绑定的节点（需有 UITransform 才能命中）
 * @param handler 抬起回调（带上原始事件，便于取按键与屏幕坐标）
 * @param target 回调的 this 绑定（一般传调用方，便于 targetOff 统一解绑）
 */
export function bindMousePress(node: Node, handler: (event: EventMouse) => void, target?: unknown) {
  if (!HAS_MOUSE) return;
  if (!ensureMouseHitTestable(node, "bindMousePress")) return;
  // 本节点也注册了鼠标事件，就要顺手把「按压起点」记上（见 trackUiPress）；
  // 记的是命中目标而不是本节点，所以与祖先的登记不会互相覆盖
  trackUiPress(node);
  node.on(
    Node.EventType.MOUSE_UP,
    (event: EventMouse) => {
      releaseWorldPress();
      if (!isUiPressWithin(node)) return;
      handler(event);
    },
    target,
  );
}

/**
 * 为节点绑定指针操作
 * 鼠标环境走鼠标通道的整段按压（按下起点在本节点或其子树内才回调，见 bindMousePress）；
 * 触屏环境监听 TOUCH_END 固定回调左键
 * @param node 绑定的节点（需有 UITransform 才能命中）
 * @param handler 操作回调
 * @param target 回调的 this 绑定（一般传调用方，便于 targetOff 统一解绑）
 */
export function bindPointerAction(node: Node, handler: (button: PointerButton) => void, target?: unknown) {
  if (!HAS_MOUSE) {
    node.on(Node.EventType.TOUCH_END, () => handler("left"), target);
    return;
  }
  bindMousePress(
    node,
    (event: EventMouse) => {
      const button = getPointerButton(event);
      if (button) handler(button);
    },
    target,
  );
}
