import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

/** 通用小组件集（表格 / 卡片 / 按钮 / 表单控件的统一样式，页面里不再各写一套 class） */

type ButtonVariant = "primary" | "outline" | "ghost" | "danger";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-indigo-500 text-white hover:bg-indigo-400",
  outline: "border border-slate-700 text-slate-200 hover:border-slate-500 hover:bg-slate-800/60",
  ghost: "text-slate-300 hover:bg-slate-800/60",
  danger: "bg-rose-600 text-white hover:bg-rose-500",
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
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON_VARIANTS[variant]} ${className}`}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-slate-400">{label}</span>
      {children}
      {hint ? <span className="text-xs text-slate-500">{hint}</span> : null}
    </label>
  );
}

const CONTROL_CLASS =
  "w-full rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 disabled:opacity-60";

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

export function Card({ title, description, actions, children, className = "" }: { title?: string; description?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-slate-800 bg-slate-900/40 shadow-lg shadow-black/20 ${className}`}>
      {title || actions ? (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-4">
          <div>
            {title ? <h2 className="text-sm font-semibold text-slate-100">{title}</h2> : null}
            {description ? <p className="mt-1 text-xs text-slate-500">{description}</p> : null}
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className="p-5">{children}</div>
    </section>
  );
}

type BadgeTone = "green" | "red" | "slate" | "indigo" | "amber";

const BADGE_TONES: Record<BadgeTone, string> = {
  green: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  red: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
  slate: "bg-slate-500/15 text-slate-300 ring-slate-500/30",
  indigo: "bg-indigo-500/15 text-indigo-300 ring-indigo-500/30",
  amber: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
};

export function Badge({ tone = "slate", children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${BADGE_TONES[tone]}`}>{children}</span>;
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-12 text-center">
      <p className="text-sm text-slate-300">{title}</p>
      {description ? <p className="text-xs text-slate-500">{description}</p> : null}
    </div>
  );
}

export function StatCard({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-slate-50">{value}</p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

/** 表格统一样式（页面里直接拼这些 class，避免每个表各写一套） */
export const tableClass = "w-full min-w-[720px] border-collapse text-sm";
export const theadClass = "text-left text-xs uppercase tracking-wide text-slate-500";
export const thClass = "whitespace-nowrap border-b border-slate-800 px-4 py-3 font-medium";
export const tdClass = "whitespace-nowrap border-b border-slate-800/60 px-4 py-3 text-slate-300";
