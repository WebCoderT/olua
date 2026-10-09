import { useEffect, useState } from "react";
import { Button, Input } from "./ui";
import { toastError, toastSuccess } from "../store/toast";

/**
 * 随机口令用的字符集
 *
 * 刻意去掉了 `0 / O / o`、`1 / l / I` 这类「念给玩家时容易听错、抄错」的字符 ——
 * 重置口令的场景是线下（客服在电话 / 群里念给玩家），口令本身又是**只显示一次的**，
 * 抄错一位就得再来一次。
 */
const PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** 口令长度（服务端要求 6~32 位） */
const PASSWORD_LENGTH = 10;

/** 生成一个随机口令（用密码学随机源，不要 Math.random） */
export function generatePassword(length = PASSWORD_LENGTH): string {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  let text = "";
  for (const value of bytes) text += PASSWORD_ALPHABET[value % PASSWORD_ALPHABET.length];
  return text;
}

/** 复制到剪贴板（非 HTTPS / 老浏览器下 navigator.clipboard 可能没有 → 提示手动复制） */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toastSuccess("已复制到剪贴板");
  } catch {
    toastError("复制失败，请手动选中复制");
  }
}

/**
 * 重置口令弹窗（玩家账号 / 管理员共用）
 *
 * 两个阶段：
 * 1. **确认**：先给一个前端生成好的随机口令（可「换一个」），说明这次操作会让对方现有令牌失效；
 * 2. **结果**：重置成功后把口令**显示一次**并提示复制 —— 服务端只存哈希，关掉这个框就再也查不到了。
 *
 * 口令的生成放在前端而不是服务端：服务端只负责「把哈希存进去」，也就不需要把口令
 * 从响应里带回来（少一处明文过网）。
 */
export function ResetPasswordDialog({
  open,
  targetName,
  targetKind,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  /** 被重置的对象名（用于文案） */
  targetName: string;
  /** 对象种类（决定文案里写「玩家」还是「管理员」） */
  targetKind: "account" | "admin";
  onCancel: () => void;
  /** 提交一次重置；返回是否成功（失败时请求层已弹过提示，这里只决定要不要进「结果」阶段） */
  onSubmit: (password: string) => Promise<boolean>;
}) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPassword(generatePassword());
    setSubmitting(false);
    setDone(false);
  }, [open]);

  if (!open) return null;

  const kindText = targetKind === "account" ? "玩家" : "管理员";

  const submit = async () => {
    setSubmitting(true);
    const ok = await onSubmit(password);
    setSubmitting(false);
    if (ok) setDone(true);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
        {done ? (
          <>
            <h3 className="text-base font-semibold text-slate-100">口令已重置</h3>
            <p className="mt-2 text-sm text-slate-400">
              {kindText}「{targetName}」的新口令如下，请<strong className="text-slate-200">现在</strong>告知本人。
            </p>
            <p className="mt-4 select-all rounded-lg border border-slate-700 bg-slate-950/70 px-4 py-3 text-center font-mono text-xl tracking-wider text-amber-300">{password}</p>
            <p className="mt-3 text-xs text-slate-500">
              服务端只保存口令的哈希，关掉这个框之后就再也查不到了（忘了只能再重置一次）。对方此前的令牌已全部失效，需要用它重新登录。
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="outline" onClick={() => void copyText(password)}>
                复制口令
              </Button>
              <Button onClick={onCancel}>完成</Button>
            </div>
          </>
        ) : (
          <>
            <h3 className="text-base font-semibold text-slate-100">重置口令</h3>
            <p className="mt-2 text-sm text-slate-400">
              将为{kindText}「{targetName}」设置一个新口令：
            </p>
            <div className="mt-3 flex items-center gap-2">
              <Input value={password} readOnly className="font-mono" />
              <Button variant="outline" className="shrink-0" onClick={() => setPassword(generatePassword())}>
                换一个
              </Button>
            </div>
            <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              重置后，该{kindText}此前签发的令牌会<strong>全部作废</strong>（在线的话下一次操作就被送回登录页）。请确认能联系上本人再操作。
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="outline" disabled={submitting} onClick={onCancel}>
                取消
              </Button>
              <Button loading={submitting} onClick={() => void submit()}>
                确认重置
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
