import { Button } from "./ui";

/**
 * 二次确认弹窗
 *
 * 删除类操作（删角色 / 删账号）一律先过它 —— 这些操作在服务端不可恢复。
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmText = "确认",
  danger = true,
  loading = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmText?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
        <h3 className="text-base font-semibold text-slate-100">{title}</h3>
        {description ? <p className="mt-2 text-sm text-slate-400">{description}</p> : null}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel} disabled={loading}>
            取消
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} loading={loading}>
            {confirmText}
          </Button>
        </div>
      </div>
    </div>
  );
}
