import { useCallback, useState } from "react";
import { thClass } from "./ui";

/** 排序方向（与服务端 PageQueryDto.order 的取值一致） */
export type SortOrder = "asc" | "desc";

/** 当前排序状态（空对象 = 用服务端默认排序） */
export interface SortState {
  sort?: string;
  order?: SortOrder;
}

/**
 * 列表排序状态
 *
 * 排序**由服务端做**（列表是分页的，只在当前页排会得到「这页里最大的一条」这种假结果），
 * 所以这里只维护「字段 + 方向」两个值，交给页面拼进查询参数。
 *
 * 点同一列来回切方向，点别的列用该列的首选方向：文本/数字默认升序，
 * 时间默认降序（看最新的）—— 由调用方在 `defaultOrder` 里声明。
 *
 * `onChange` 用于「换了排序就回到第 1 页」：停在第 5 页换排序，看到的仍是中间一段，
 * 感觉像列表坏了。
 */
export function useSort(options: { initial?: SortState; onChange?: () => void } = {}) {
  const [state, setState] = useState<SortState>(options.initial ?? {});
  const onChange = options.onChange;

  const toggle = useCallback(
    (field: string, defaultOrder: SortOrder = "asc") => {
      setState((previous) =>
        previous.sort === field ? { sort: field, order: previous.order === "asc" ? "desc" : "asc" } : { sort: field, order: defaultOrder },
      );
      onChange?.();
    },
    [onChange],
  );

  /** 恢复服务端默认排序（「重置」按钮用） */
  const clear = useCallback(() => {
    setState(options.initial ?? {});
    onChange?.();
  }, [onChange, options.initial]);

  return { sort: state.sort, order: state.order, toggle, clear };
}

/**
 * 可排序的表头格
 *
 * 未选中时显示淡色双向箭头（提示可点），选中时显示方向箭头并高亮 ——
 * 只有当前排序列才有方向，避免一排箭头让人分不清到底按哪列排的。
 */
export function SortableTh({
  label,
  field,
  sort,
  order,
  onToggle,
  defaultOrder = "asc",
  className = "",
}: {
  label: string;
  field: string;
  sort?: string;
  order?: SortOrder;
  onToggle: (field: string, defaultOrder?: SortOrder) => void;
  defaultOrder?: SortOrder;
  className?: string;
}) {
  const active = sort === field;
  const nextOrder: SortOrder = active ? (order === "asc" ? "desc" : "asc") : defaultOrder;

  return (
    <th className={`${thClass} ${className}`} aria-sort={active ? (order === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        className="inline-flex items-center gap-1 transition hover:text-slate-200"
        title={`按「${label}」排序（${nextOrder === "asc" ? "升序" : "降序"}）`}
        onClick={() => onToggle(field, defaultOrder)}
      >
        {label}
        <span className={active ? "text-indigo-300" : "text-slate-600"} aria-hidden="true">
          {active ? (order === "asc" ? "▲" : "▼") : "⇅"}
        </span>
      </button>
    </th>
  );
}
