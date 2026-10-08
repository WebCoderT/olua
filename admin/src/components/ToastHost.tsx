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
          className={`pointer-events-auto rounded-xl border px-4 py-3 text-sm shadow-lg shadow-black/30 backdrop-blur ${
            item.type === "error"
              ? "border-rose-500/40 bg-rose-950/80 text-rose-100"
              : item.type === "success"
                ? "border-emerald-500/40 bg-emerald-950/80 text-emerald-100"
                : "border-slate-700 bg-slate-900/90 text-slate-100"
          }`}
        >
          {item.message}
        </div>
      ))}
    </div>
  );
}
