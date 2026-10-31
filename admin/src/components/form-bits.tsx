import { Button, Field } from "./ui";

/**
 * 编辑表单的三个公共零件（技能 / 状态 / 任务等「字段多、校验多」的弹窗表单共用）
 *
 * 只收「长得一模一样」的部分；各表单的差异（提示语、可用条件、按钮文案）全部走 props。
 */

/** 描述文案（统一 ≤500 字上限，textarea 样式三处同款） */
export function DescriptionField({
  value,
  onChange,
  hint = "≤500 字",
}: {
  value: string;
  onChange: (value: string) => void;
  hint?: string;
}) {
  return (
    <Field label="描述文案" hint={hint}>
      <textarea
        className="min-h-[80px] w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-emerald-500"
        maxLength={500}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

/** 校验问题清单（即时提示；权威在服务端）。红色 = 编辑弹窗内嵌，琥珀 = 创建弹窗底部 */
export function ProblemList({ problems, tone = "red" }: { problems: string[]; tone?: "red" | "amber" }) {
  if (problems.length === 0) return null;
  return (
    <ul
      className={
        tone === "red"
          ? "flex flex-col gap-1 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200"
          : "mt-4 space-y-1 rounded-lg border border-amber-900/50 bg-amber-950/20 p-3 text-xs text-amber-300"
      }
    >
      {problems.map((message) => (
        <li key={message}>· {message}</li>
      ))}
    </ul>
  );
}

/** 弹窗底部按钮条：取消 + 提交（文案与可用条件由调用方给） */
export function FormFooter({
  submitting,
  canSubmit,
  onCancel,
  onSubmit,
  label = "保存修改",
}: {
  submitting: boolean;
  canSubmit: boolean;
  onCancel: () => void;
  onSubmit: () => void;
  label?: string;
}) {
  return (
    <div className="mt-6 flex justify-end gap-2">
      <Button variant="outline" disabled={submitting} onClick={onCancel}>
        取消
      </Button>
      <Button disabled={!canSubmit} loading={submitting} onClick={onSubmit}>
        {label}
      </Button>
    </div>
  );
}
