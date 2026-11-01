import type { KeyboardEvent } from "react";
import { EntityImage } from "./EntityImage";
import type { EntityImage as EntityImageData } from "./catalog";

/**
 * 实体卡（可视化格子的最小单元）
 *
 * 用途：装备槽、背包格、技能行、称号档位 —— 长得都是「图 + 名字 + 一行说明」。
 * 没值时显示虚线框与占位文案（「空」/「未穿」），让「这里能放东西」一眼看得出来；
 * 有值时右上角给清除按钮（卸下 / 移除）。
 *
 * 为什么不直接用 `<button>` 包整块：里面还有清除按钮，按钮不能嵌套按钮。
 * 所以外层是 `role="button"` 的 div，键盘用 Enter / Space 触发。
 */
export function EntityCard({
  label,
  note,
  image,
  placeholder,
  badge,
  disabled = false,
  size = 40,
  onClick,
  onClear,
  clearTitle = "清除",
}: {
  label: string;
  note?: string;
  image: EntityImageData;
  /** 没有值时显示的文案（如「空」「未穿」） */
  placeholder: string;
  /** 角标：槽位名 / 序号（有值时也显示，便于对照布局） */
  badge?: string;
  disabled?: boolean;
  size?: number;
  onClick?: () => void;
  onClear?: () => void;
  clearTitle?: string;
}) {
  const empty = !label;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || !onClick) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onClick();
  };

  return (
    <div
      role={onClick ? "button" : undefined}
      tabIndex={onClick && !disabled ? 0 : undefined}
      aria-label={empty ? placeholder : label}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      onKeyDown={onKeyDown}
      className={`relative flex items-center gap-2.5 rounded-xl border p-2 text-left transition ${
        empty ? "border-dashed border-slate-700 bg-slate-900/30" : "border-slate-700 bg-slate-900/70"
      } ${disabled || !onClick ? "" : "cursor-pointer hover:border-indigo-500/70 hover:bg-slate-800/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60"}`}
    >
      {/* 空槽不画图标：`NoImage` 那种「无图」占位看着像「缺资源」，而这里本来就是空的 */}
      {empty ? (
        <span
          aria-hidden="true"
          className="rounded border border-dashed border-slate-800 bg-slate-950/40"
          style={{ width: size, height: size }}
        />
      ) : (
        <EntityImage image={image} alt={label} size={size} />
      )}
      <div className="min-w-0 flex-1">
        {badge ? <p className="text-[10px] leading-tight text-slate-500">{badge}</p> : null}
        <p className={`truncate text-xs font-medium ${empty ? "text-slate-600" : "text-slate-100"}`}>
          {empty ? placeholder : label}
        </p>
        {!empty && note ? <p className="truncate text-[10px] text-slate-500">{note}</p> : null}
      </div>
      {!empty && onClear ? (
        <button
          type="button"
          title={clearTitle}
          aria-label={clearTitle}
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation();
            onClear();
          }}
          className="absolute right-1 top-1 rounded px-1 text-xs leading-none text-slate-500 transition hover:bg-slate-800 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-40"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
