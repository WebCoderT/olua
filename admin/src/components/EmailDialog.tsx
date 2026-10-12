import { useEffect, useState } from "react";
import { Button, Input } from "./ui";

/**
 * 补录 / 修改玩家邮箱弹窗
 *
 * 与「重置口令」同一套模态结构，但更简单：一个邮箱输入框 + 一个「清空」动作。
 * - 输入非空串 → 保存为补录 / 改成的新邮箱
 * - 点「清空邮箱」→ 提交空串，账号回到「未填写邮箱」状态
 *
 * 邮箱格式 / 去重（同一邮箱只能绑一个账号）都由服务端校验，前端只管把值交出去、
 * 把失败提示交给统一的请求层。
 */
export function EmailDialog({
  open,
  targetName,
  currentEmail,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  /** 被操作的账号名（用于文案） */
  targetName: string;
  /** 当前已填写的邮箱（用于文案与「清空」提示）；未填写为 null */
  currentEmail: string | null;
  onCancel: () => void;
  /** 提交一次邮箱（空串 = 清空）；返回是否成功（失败时请求层已弹过提示） */
  onSubmit: (email: string) => Promise<boolean>;
}) {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEmail(currentEmail ?? "");
    setSubmitting(false);
  }, [open, currentEmail]);

  if (!open) return null;

  const submit = async (value: string) => {
    setSubmitting(true);
    const ok = await onSubmit(value);
    setSubmitting(false);
    if (ok) onCancel();
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
        <h3 className="text-base font-semibold text-slate-100">补录 / 修改玩家邮箱</h3>
        <p className="mt-2 text-sm text-slate-400">
          为玩家「{targetName}」设置邮箱（个人信息，仅持 account:email 权限的管理员可见）。
        </p>

        {currentEmail ? (
          <p className="mt-3 rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-xs text-slate-400">
            当前邮箱：<span className="text-slate-200">{currentEmail}</span>
          </p>
        ) : null}

        <div className="mt-3">
          <span className="mb-1.5 block text-xs font-medium text-slate-400">新邮箱（留空点「清空邮箱」即删除）</span>
          <Input
            type="email"
            value={email}
            disabled={submitting}
            placeholder="player@example.com"
            onChange={(event) => setEmail(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !submitting) void submit(email);
            }}
          />
        </div>

        <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          同一邮箱只能绑定一个账号（大小写不敏感）。格式或冲突错误由服务端即时返回。
        </p>

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <Button variant="outline" disabled={submitting} onClick={() => void submit("")}>
            清空邮箱
          </Button>
          <Button variant="outline" disabled={submitting} onClick={onCancel}>
            取消
          </Button>
          <Button loading={submitting} onClick={() => void submit(email)}>
            保存
          </Button>
        </div>
      </div>
    </div>
  );
}
