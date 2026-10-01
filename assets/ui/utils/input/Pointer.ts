import { EventMouse, Node, sys, Vec2 } from "cc";

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

/**
 * 为节点绑定指针操作
 * 鼠标环境监听 MOUSE_UP 并按左右键回调（中键等忽略）；触屏环境监听 TOUCH_END 固定回调左键
 * @param node 绑定的节点（需有 UITransform 才能命中）
 * @param handler 操作回调
 * @param target 回调的 this 绑定（一般传调用方，便于 targetOff 统一解绑）
 */
export function bindPointerAction(node: Node, handler: (button: PointerButton) => void, target?: unknown) {
  if (!HAS_MOUSE) {
    node.on(Node.EventType.TOUCH_END, () => handler("left"), target);
    return;
  }
  node.on(
    Node.EventType.MOUSE_UP,
    (event: EventMouse) => {
      const button = getPointerButton(event);
      if (button) handler(button);
    },
    target,
  );
}
