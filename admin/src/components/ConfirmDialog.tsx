import { Modal } from "./Modal";
import { Button } from "./ui";

/**
 * 二次确认弹窗
 *
 * 删除类操作（删角色 / 删账号）一律先过它 —— 这些操作在服务端不可恢复。
 *
 * 外壳走 `Modal`（`sm` 档）：Esc、点遮罩关闭、按钮固定底部，与其他弹窗一致。
 * 自己再写一层遮罩的代价是「这个能按 Esc、那个不能」，用户记不住哪个是哪个。
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
  return (
    <Modal
      open={open}
      title={title}
      size="sm"
      onClose={onCancel}
      footer={
        <>
          <Button variant="outline" onClick={onCancel} disabled={loading}>
            取消
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} loading={loading}>
            {confirmText}
          </Button>
        </>
      }
    >
      {description ? <p className="text-sm leading-relaxed text-slate-400">{description}</p> : null}
    </Modal>
  );
}
