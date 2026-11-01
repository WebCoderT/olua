import { useEffect } from "react";
import { Button } from "../ui";
import { EntityPickerList } from "./EntityPickerList";
import type { EntityOption } from "./catalog";

/**
 * 实体选择弹窗：受控开合，选中即回调并关闭
 *
 * 全管理端的「挑一个装备 / 技能 / 物品 / 时装 / 称号档」都走它 —— 调用方只要把
 * `catalog.entityOptions(kind)`（必要时先过滤）传进来，不需要写搜索框、分组、网格、分页。
 *
 * 每次打开都重置搜索与分组（`resetKey` = open）：否则上一次挑装备的「武器」分组会
 * 带到下一次选技能里，界面上看起来像「没有可选的东西」。
 */
export function EntityPicker({
  open,
  title,
  hint,
  options,
  current,
  emptyHint,
  onSelect,
  onClose,
}: {
  open: boolean;
  title: string;
  hint?: string;
  options: EntityOption[];
  current?: string;
  /** 列表为空时的说明（不同调用方的「为什么没有」不一样） */
  emptyHint?: string;
  onSelect: (id: string) => void;
  onClose: () => void;
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
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-3xl flex-col rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-slate-100">{title}</h3>
            <p className="mt-1 text-xs text-slate-500">点一项即选中；列表为空说明客户端配置里没有这一类数据。</p>
          </div>
          <Button variant="ghost" className="px-2 py-1 text-xs" onClick={onClose}>
            关闭
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <EntityPickerList
            options={options}
            current={current}
            hint={hint}
            emptyHint={emptyHint}
            resetKey={open}
            onPick={(id) => {
              onSelect(id);
              onClose();
            }}
          />
        </div>
      </div>
    </div>
  );
}
