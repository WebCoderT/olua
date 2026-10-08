import { Button } from "./ui";

/** 分页控件（服务端分页：只上报页码，翻页由页面重新拉数据） */
export function Pagination({ page, size, total, onChange }: { page: number; size: number; total: number; onChange: (page: number) => void }) {
  const pageCount = Math.max(1, Math.ceil(total / size));
  const from = total === 0 ? 0 : (page - 1) * size + 1;
  const to = Math.min(total, page * size);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-1 py-3 text-xs text-slate-400">
      <span>
        共 {total} 条{total > 0 ? `，当前 ${from}–${to}` : ""}
      </span>
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
  );
}
