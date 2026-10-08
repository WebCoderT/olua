/**
 * 轻量消息总线（不依赖 React）
 *
 * http 层的错误出口是非 React 代码（拦截器），不能直接调组件里的 setState，
 * 所以错误先发到这里，由页面上的 Toast 容器订阅后渲染。
 */
export type ToastType = "info" | "success" | "error";

export interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

type Listener = (item: ToastItem) => void;

const listeners = new Set<Listener>();
let seq = 0;

/** 弹一条提示（任何地方都能调） */
export function toast(message: string, type: ToastType = "info"): void {
  if (!message) return;
  const item: ToastItem = { id: (seq += 1), message, type };
  for (const listener of listeners) listener(item);
}

export const toastSuccess = (message: string) => toast(message, "success");
export const toastError = (message: string) => toast(message, "error");

/** 订阅提示（返回取消订阅函数） */
export function subscribeToast(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
