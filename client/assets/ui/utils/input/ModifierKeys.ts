import { EventKeyboard, Input, input, KeyCode } from "cc";

/**
 * 修饰键状态（Ctrl/Shift/Alt…，当前只有左侧 Ctrl 有消费方）
 *
 * 为什么是全局单例而不是挂在某个节点上：悬停详情弹窗需要「Ctrl 按下/松开」这种
 * 与焦点无关的全局状态（鼠标停在物品上时按键，节点收不到 KEY_DOWN —— 键盘事件
 * 只派发给 input，不经过节点命中），所以像 utils/input/Pointer 一样在模块层常驻监听。
 *
 * 只认**左侧 Ctrl**（KeyCode.CTRL_LEFT）：与 RoleKeyboardInput 的 SHIFT_LEFT 同一口径，
 * 右侧修饰键不触发对比，避免与左手操作（移动 WASD）抢键时误触。
 */

/** Ctrl 当前是否按着 */
let ctrlPressed = false;

/** Ctrl 状态变化的订阅者（悬停中的详情弹窗用它决定「带对比 / 不带对比」重建） */
const ctrlListeners = new Set<() => void>();

function handleKeyEvent(event: EventKeyboard) {
  const pressed = event.keyCode === KeyCode.CTRL_LEFT;
  // 只在状态真变时通知（按住不松会连发 KEY_DOWN，不能让弹窗跟着狂重建）
  if (pressed === ctrlPressed) return;
  ctrlPressed = pressed;
  ctrlListeners.forEach((listener) => listener());
}

input.on(Input.EventType.KEY_DOWN, handleKeyEvent);
input.on(Input.EventType.KEY_UP, handleKeyEvent);

/** 左侧 Ctrl 是否按着（悬停装备详情的对比开关） */
export function isCtrlPressed(): boolean {
  return ctrlPressed;
}

/** 订阅 Ctrl 按下/松开（返回值即取消订阅的函数，悬停关闭时调用，避免弹窗重建已死引用） */
export function onCtrlChange(listener: () => void): () => void {
  ctrlListeners.add(listener);
  return () => ctrlListeners.delete(listener);
}
