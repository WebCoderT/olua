import { useEffect } from "react";
import { Button } from "./ui";

/**
 * 通用弹窗外壳（标题 + 滚动内容区 + 底部操作条）
 *
 * 为什么要它：角色详情的「装备 / 技能 / 背包」都不该把页面撑成一条长龙 ——
 * 大块内容（技能列表、7×11 格子）进弹窗，页面本身留在一屏内。
 *
 * ## 宽度只有四档，页面不许自己传 `max-w-*`
 * 手写弹窗年代每个页面各挑一个宽度（`max-w-2xl` / `max-w-3xl` / `max-w-4xl` 混着用），
 * 同一类表单在不同页里宽窄不一，看着像两套后台。档位按**内容形态**选，不按习惯：
 * - `sm`：确认、单字段、重置口令；
 * - `md`：普通编辑表单；
 * - `lg`：长表单 / 列表型编辑（技能、状态、任务、掉落）；
 * - `xl`：表格型工作台（装备对齐）。
 *
 * ## 行为统一由这里提供
 * Esc 关闭、点遮罩关闭、内容区独立滚动、footer 固定在底部、`role="dialog"`。
 * 手写遮罩最常见的三个毛病就是「只能点取消」「遮罩点了没反应」「列表长出去把按钮压走」，
 * 都在这层一次性解决。
 *
 * 与 `EntityPicker` 的分工：那个是「挑一项就完成」的选择器（自带列表与搜索）；
 * 这个是给**任意内容**用的壳子（技能列表 + 数量输入、背包网格 + 清空…）。
 */
export type ModalSize = "sm" | "md" | "lg" | "xl";

const MODAL_SIZES: Record<ModalSize, string> = {
  sm: "max-w-md",
  md: "max-w-2xl",
  lg: "max-w-3xl",
  xl: "max-w-5xl",
};

export function Modal({
  open,
  title,
  hint,
  size = "md",
  footer,
  onClose,
  children,
}: {
  open: boolean;
  /** 标题：可以是字符串，也可以带徽标 / 编号（`<>{name}<Badge/></>`） */
  title: React.ReactNode;
  hint?: React.ReactNode;
  /** 宽度档（见上面四档说明） */
  size?: ModalSize;
  /** 底部操作条（按钮由调用方给；不传则只有一个「关闭」） */
  footer?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === "string" ? title : undefined}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className={`flex max-h-[85vh] w-full ${MODAL_SIZES[size]} flex-col rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-2xl`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3 border-b border-slate-800 pb-3">
          <div>
            <h3 className="text-base font-semibold text-slate-100">{title}</h3>
            {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
          </div>
          <Button variant="ghost" className="px-2 py-1 text-xs" onClick={onClose}>
            关闭
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">{children}</div>
        {footer ? <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-slate-800 pt-3">{footer}</div> : null}
      </div>
    </div>
  );
}
