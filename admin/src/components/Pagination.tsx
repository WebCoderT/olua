import { Button, Select } from "./ui";

/** 可选每页条数（与服务端 1~100 的上限对齐，取的都是常用档） */
export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

/**
 * 分页控件（服务端分页：只上报页码与每页条数，翻页由页面重新拉数据）
 *
 * 传了 `onSizeChange` 才显示「每页」下拉 —— 只读页面可以不接（默认不显示）。
 */
export function Pagination({
  page,
  size,
  total,
  onChange,
  onSizeChange,
}: {
  page: number;
  size: number;
  total: number;
  onChange: (page: number) => void;
  onSizeChange?: (size: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / size));
  const from = total === 0 ? 0 : (page - 1) * size + 1;
  const to = Math.min(total, page * size);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-1 py-3 text-xs text-slate-400">
      <span>
        共 {total} 条{total > 0 ? `，当前 ${from}–${to}` : ""}
      </span>
      <div className="flex flex-wrap items-center gap-4">
        {onSizeChange ? (
          <label className="flex items-center gap-2">
            <span>每页</span>
            <span className="w-20">
              <Select
                className="px-2 py-1 text-xs"
                value={size}
                aria-label="每页条数"
                onChange={(event) => onSizeChange(Number(event.target.value))}
              >
                {PAGE_SIZE_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </span>
          </label>
        ) : null}
        <div className="flex items-center gap-2">
          <Button variant="outline" className="px-2.5 py-1 text-xs" disabled={page <= 1} onClick={() => onChange(page - 1)}>
            上一页
          </Button>
          <span className="tabular-nums">
            {page} / {pageCount}
          </span>
          <Button variant="outline" className="px-2.5 py-1 text-xs" disabled={page >= pageCount} onClick={() => onChange(page + 1)}>
            下一页
          </Button>
        </div>
      </div>
    </div>
  );
}
