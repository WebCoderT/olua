import { useEffect, useState } from "react";
import { subscribeToast } from "../store/toast";
import type { ToastItem } from "../store/toast";

/** 提示容器（订阅 store/toast 的消息，3 秒自动消失） */
export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    return subscribeToast((item) => {
      setItems((prev) => [...prev.slice(-4), item]);
      setTimeout(() => setItems((prev) => prev.filter((current) => current.id !== item.id)), 3600);
    });
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-5 top-5 z-50 flex w-80 flex-col gap-2">
      {items.map((item) => (
        <div
          key={item.id}
          className={`pointer-events-auto rounded-sm border border-l-2 px-4 py-3 text-sm shadow-lg shadow-black/40 backdrop-blur ${
            item.type === "error"
              ? "border-ember/35 border-l-ember bg-surface-2/95 text-ember-hi"
              : item.type === "success"
                ? "border-jade/30 border-l-jade bg-surface-2/95 text-jade"
                : "border-line-strong border-l-line-gold bg-surface-2/95 text-ink-2"
          }`}
        >
          {item.message}
        </div>
      ))}
    </div>
  );
}
