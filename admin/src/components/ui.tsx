import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

/**
 * 通用小组件集（表格 / 卡片 / 按钮 / 表单控件的统一样式，页面里不再各写一套 class）
 *
 * ## 视觉口径（legend 设计系统，#946）
 * 单一来源 `design/legend-console/system.html`，色值只活在 `index.css` 的 `@theme`。
 * 这里只做「把 token 组装成控件」这一件事 —— 控件的形状、字阶、描边都在这一层定死，
 * 页面因此**没有能力**把按钮写成别的样子（这是设计系统能落地的关键，不是风格偏好）。
 *
 * 三条不可违反的语义：
 * - 金 = 唯一高光色，只给主操作与选中态；**金底必须配深字**（白字对比度不足）。
 * - 火 = 危险 / 失败；玉 = 在线 / 正常；注意 = 非阻断异常。
 * - 数字一律 `legend-num`（等宽 + tabular），账目列才对得齐。
 */

type ButtonVariant = "primary" | "outline" | "ghost" | "danger";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  /* 金是唯一高光色：主按钮金底必须配深色字（白字对比度不足 2:1），与设计稿一致 */
  primary:
    "border border-gold/70 bg-gradient-to-b from-gold-hi to-gold text-surface-0 hover:to-gold-hi active:translate-y-px",
  outline:
    "border border-line-strong bg-surface-3/40 text-ink-2 hover:border-gold-dim hover:bg-surface-3 hover:text-ink-1 active:translate-y-px",
  ghost: "border border-transparent text-ink-3 hover:bg-surface-3 hover:text-ink-1",
  danger: "border border-ember/60 bg-ember text-ink-1 hover:bg-ember-hi active:translate-y-px",
};

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-gold/40 disabled:cursor-not-allowed disabled:opacity-40";

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
      className={`${BUTTON_BASE} ${BUTTON_VARIANTS[variant]} ${className}`}
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
      <label className={`flex items-center gap-2 whitespace-nowrap ${width ?? "w-40"}`}>
        <span className="shrink-0 text-[11px] tracking-wide text-ink-4">{label}</span>
        <span className="min-w-0 flex-1">{children}</span>
        {hint ? <span className="shrink-0 text-[11px] text-ink-5">{hint}</span> : null}
      </label>
    );
  }
  return (
    <label className={`flex flex-col gap-1 ${width ?? ""}`}>
      <span className="text-[11px] font-medium tracking-wide text-ink-4">{label}</span>
      {children}
      {hint ? <span className="text-[11px] text-ink-5">{hint}</span> : null}
    </label>
  );
}

const CONTROL_CLASS =
  "w-full rounded-md border border-line-strong bg-surface-1/70 px-2.5 py-1.5 text-sm text-ink-1 outline-none transition-colors placeholder:text-ink-6 hover:border-gold-dim focus:border-gold focus:ring-1 focus:ring-gold/30 disabled:cursor-not-allowed disabled:opacity-50";

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
 *
 * 视觉实体是 `.legend-card`（index.css）：金线外框 + 内衬细线 + 上缘微光，
 * 页面里**不许**再自己拼 `border + bg` 造卡片。
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
    <section className={`legend-card ${className}`}>
      {title || actions ? (
        <header
          className={`flex flex-wrap items-center justify-between gap-2 border-b border-gold/10 ${
            dense ? "px-4 py-2.5" : "px-5 py-4"
          }`}
        >
          <div className="min-w-0">
            {title ? <h2 className="text-[13px] font-semibold tracking-[.08em] text-ink-1">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-4">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={dense ? "px-4 py-3" : "p-5"}>{children}</div>
    </section>
  );
}

type BadgeTone = "jade" | "ember" | "muted" | "gold" | "warn";

const BADGE_TONES: Record<BadgeTone, string> = {
  jade: "bg-jade/12 text-jade ring-jade/30",
  ember: "bg-ember/12 text-ember-hi ring-ember/30",
  muted: "bg-ink-5/12 text-ink-3 ring-ink-5/30",
  gold: "bg-gold/12 text-gold ring-gold/30",
  warn: "bg-warn/12 text-warn ring-warn/30",
};

export function Badge({ tone = "muted", children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-sm px-1.5 py-px text-[11px] font-medium ring-1 ring-inset ${BADGE_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

type NoticeTone = "warn" | "ember" | "muted" | "jade";

const NOTICE_TONES: Record<NoticeTone, string> = {
  warn: "border-warn/30 border-l-warn bg-warn/8 text-warn",
  ember: "border-ember/30 border-l-ember bg-ember/8 text-ember-hi",
  muted: "border-line-strong border-l-line-gold bg-surface-3/50 text-ink-3",
  jade: "border-jade/25 border-l-jade bg-jade/8 text-jade",
};

/**
 * 提示条（一行到一段的解释性文字）
 *
 * 为什么抽出来：各页原来自己拼 `rounded-2xl border border-warn/40 bg-warn/10 px-5 py-4`
 * 或者 `rounded-lg border border-ember/40 …`，同为「提醒」却有三种字号与两种圆角。
 *
 * 用途边界：**解释 / 警告**用它，**操作结果**用 toast（`toastSuccess` / `toastError`）——
 * 提示条是页面的一部分（刷新后还在），toast 是一次性反馈。
 *
 * 形状：左缘一道实色竖条（2px）标严重度，其余三边用弱化描边 —— 一屏里多条提示不会抢表格。
 */
export function Notice({
  tone = "warn",
  title,
  children,
}: {
  tone?: NoticeTone;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className={`rounded-sm border border-l-2 px-3 py-2 text-xs leading-relaxed ${NOTICE_TONES[tone]}`}>
      {title ? <p className="font-medium">{title}</p> : null}
      <div className={title ? "mt-1 opacity-90" : ""}>{children}</div>
    </div>
  );
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <span aria-hidden="true" className="text-[10px] tracking-[.4em] text-gold-dim">
        ◆
      </span>
      <p className="text-sm text-ink-3">{title}</p>
      {description ? <p className="text-[11.5px] text-ink-5">{description}</p> : null}
    </div>
  );
}

/**
 * 指标卡（概览页 KPI）
 *
 * 数字用等宽 + tabular：同排几个数字的位数不同，比例字体会让小数点前后错位。
 * `plain` 用于「不需要强调」的次级指标（管理员数这类），金色留给要看的四个主指标。
 */
export function StatCard({
  label,
  value,
  hint,
  plain = false,
}: {
  label: string;
  value: number | string;
  hint?: string;
  plain?: boolean;
}) {
  return (
    <div className="legend-card px-4 py-3">
      <p className="font-mono text-[9.5px] uppercase tracking-[.18em] text-ink-4">{label}</p>
      <p className={`legend-num mt-2 text-[26px] font-medium leading-none ${plain ? "text-ink-1" : "text-gold-hi"}`}>
        {typeof value === "number" ? value.toLocaleString("zh-CN") : value}
      </p>
      {hint ? <p className="mt-2 text-[11px] text-ink-4">{hint}</p> : null}
    </div>
  );
}

/** 表格统一样式（页面里直接拼这些 class，避免每个表各写一套） */
export const tableClass = "w-full min-w-[720px] border-collapse text-sm";
export const theadClass = "text-left";
export const thClass =
  "whitespace-nowrap border-b border-line px-3 py-2 font-mono text-[10px] font-medium uppercase tracking-[.14em] text-ink-5";
export const tdClass = "whitespace-nowrap border-b border-line/60 px-3 py-2 text-ink-3";
