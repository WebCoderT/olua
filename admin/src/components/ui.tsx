import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

/** 通用小组件集（表格 / 卡片 / 按钮 / 表单控件的统一样式，页面里不再各写一套 class） */

type ButtonVariant = "primary" | "outline" | "ghost" | "danger";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  /* 金是唯一高光色：主按钮金底必须配深色字（白字对比度不足 2:1），与设计稿一致 */
  primary: "bg-gold text-surface-0 hover:bg-gold-hi",
  outline: "border border-line-strong text-ink-2 hover:border-gold-dim hover:bg-surface-3/60",
  ghost: "text-ink-3 hover:bg-surface-3/60",
  danger: "bg-ember text-ink-1 hover:bg-ember-hi",
};

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Button({
  variant = "primary",
  loading = false,
  className = "",
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON_VARIANTS[variant]} ${className}`}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}

/**
 * 字段（标签 + 控件）
 *
 * **默认就是上下结构**（标签在上、控件在下）：筛选条里一排若干个这样的块，每个块内部
 * 上下两行、整组排成一行 —— 标签左置会把「标签 + 控件」挤成一行，输入框反而更窄。
 *
 * `inline` 只留给**真的没有标签位置**的地方（如弹窗里一行两三个短字段），别在筛选条里用。
 * `width` 给块定宽：`Input` / `Select` 自带 `w-full`，宽度只能由外层给。
 */
export function Field({
  label,
  hint,
  inline = false,
  width,
  children,
}: {
  label: string;
  hint?: string;
  inline?: boolean;
  /** 控件（或整块）宽度，如 `w-56` */
  width?: string;
  children: ReactNode;
}) {
  if (inline) {
    return (
      <label className={`flex items-center gap-1.5 whitespace-nowrap ${width ?? "w-40"}`}>
        <span className="shrink-0 text-xs text-ink-4">{label}</span>
        <span className="min-w-0 flex-1">{children}</span>
        {hint ? <span className="shrink-0 text-xs text-ink-5">{hint}</span> : null}
      </label>
    );
  }
  return (
    <label className={`flex flex-col gap-1 ${width ?? ""}`}>
      <span className="text-xs font-medium text-ink-4">{label}</span>
      {children}
      {hint ? <span className="text-xs text-ink-5">{hint}</span> : null}
    </label>
  );
}

const CONTROL_CLASS =
  "w-full rounded-lg border border-line-strong bg-surface-2/70 px-2.5 py-1.5 text-sm text-ink-1 outline-none transition placeholder:text-ink-5 focus:border-gold focus:ring-2 focus:ring-gold/30 disabled:opacity-60";

export function Input({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={`${CONTROL_CLASS} ${className}`} />;
}

export function Select({ className = "", children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={`${CONTROL_CLASS} ${className}`}>
      {children}
    </select>
  );
}

/**
 * 卡片外壳
 *
 * **默认就是紧凑的**（2026-11-01 用户口径：「全局使用紧凑布局」）：同一屏里放得下更多行，
 * 后台最常见的动作是「扫一遍列表」，多出来的内边距只会让人多滚两次。
 *
 * `dense` 只压内边距，标题 / 说明 / 内容一概不少。要恢复原来的呼吸感传 `dense={false}`
 * （目前只有登录壳与少数展板类页面用得上）。
 */
export function Card({
  title,
  description,
  actions,
  children,
  className = "",
  dense = true,
}: {
  title?: string;
  /** 说明：允许富文本（多段、内联 code）—— 有的卡片要在一行里说清「口径 + 计数」，纯字符串写不下 */
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  dense?: boolean;
}) {
  return (
    <section className={`rounded-2xl border border-line bg-surface-2/60 shadow-lg shadow-black/20 ${className}`}>
      {title || actions ? (
        <header
          className={`flex flex-wrap items-center justify-between gap-2 border-b border-line ${
            dense ? "px-3.5 py-2" : "px-5 py-4"
          }`}
        >
          <div className="min-w-0">
            {title ? <h2 className="text-sm font-semibold text-ink-1">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-xs text-ink-5">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={dense ? "px-3.5 py-3" : "p-5"}>{children}</div>
    </section>
  );
}

type BadgeTone = "green" | "red" | "slate" | "indigo" | "amber";

const BADGE_TONES: Record<BadgeTone, string> = {
  green: "bg-jade/15 text-jade ring-jade/30",
  red: "bg-ember/15 text-ember-hi ring-ember/30",
  slate: "bg-ink-5/15 text-ink-3 ring-ink-5/40",
  indigo: "bg-gold/15 text-gold ring-gold/30",
  amber: "bg-warn/15 text-warn ring-warn/30",
};

export function Badge({ tone = "slate", children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${BADGE_TONES[tone]}`}>{children}</span>;
}

type NoticeTone = "amber" | "red" | "slate" | "emerald";

const NOTICE_TONES: Record<NoticeTone, string> = {
  amber: "border-warn/40 bg-warn/10 text-warn",
  red: "border-ember/40 bg-ember/10 text-ember-hi",
  slate: "border-line-strong bg-surface-3/50 text-ink-3",
  emerald: "border-jade/30 bg-jade/10 text-jade",
};

/**
 * 提示条（一行到一段的解释性文字）
 *
 * 为什么抽出来：各页原来自己拼 `rounded-2xl border border-amber-500/40 bg-warn/10 px-5 py-4`
 * 或者 `rounded-lg border border-red-500/30 …`，同为「提醒」却有三种字号与两种圆角。
 *
 * 用途边界：**解释 / 警告**用它，**操作结果**用 toast（`toastSuccess` / `toastError`）——
 * 提示条是页面的一部分（刷新后还在），toast 是一次性反馈。
 */
export function Notice({
  tone = "amber",
  title,
  children,
}: {
  tone?: NoticeTone;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className={`rounded-xl border px-3 py-2 text-xs leading-relaxed ${NOTICE_TONES[tone]}`}>
      {title ? <p className="font-medium">{title}</p> : null}
      <div className={title ? "mt-1 opacity-90" : ""}>{children}</div>
    </div>
  );
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-12 text-center">
      <p className="text-sm text-ink-3">{title}</p>
      {description ? <p className="text-xs text-ink-5">{description}</p> : null}
    </div>
  );
}

export function StatCard({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface-2/60 px-4 py-3">
      <p className="text-xs text-ink-5">{label}</p>
      <p className="mt-1 text-xl font-semibold text-ink-1">{value}</p>
      {hint ? <p className="mt-1 text-xs text-ink-5">{hint}</p> : null}
    </div>
  );
}

/** 表格统一样式（页面里直接拼这些 class，避免每个表各写一套） */
export const tableClass = "w-full min-w-[720px] border-collapse text-sm";
export const theadClass = "text-left text-xs uppercase tracking-wide text-ink-5";
export const thClass = "whitespace-nowrap border-b border-line px-3 py-2 font-medium";
export const tdClass = "whitespace-nowrap border-b border-line/60 px-3 py-2 text-ink-3";
