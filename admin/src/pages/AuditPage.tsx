import { useCallback, useEffect, useState } from "react";
import {
  adminRoleLabel,
  auditActionLabel,
  auditApi,
  auditTargetLabel,
  AUDIT_TARGET_LABELS,
  formatTimeFull,
  localInputToMs,
  PERMISSION,
} from "../api";
import type { AuditLog, AuditQuery, PageResult } from "../api";
import { Pagination } from "../components/Pagination";
import { Badge, Button, Card, EmptyState, Input, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";

const PAGE_SIZE = 20;

/** 空筛选条件（重置时复用同一个对象，避免每次渲染都造新引用把请求打飞） */
const EMPTY_QUERY = { keyword: "", action: "", targetType: "", targetId: "", success: "", from: "", to: "" };

type Draft = typeof EMPTY_QUERY;

/**
 * 操作日志
 *
 * 读的是服务端自动记下来的写操作（含登录成功 / 失败、改口令），**动作清单也从服务端拉**
 * （`/admin/audit-logs/actions`）—— 界面不写死接口清单，新加的管理端写接口会自动出现在筛选里，
 * 中文名只是 `api/types` 里的一张展示字典，没登记的动作原样显示标识符。
 *
 * 时间范围用 `<input type="datetime-local">`（本地时间），提交前换算成毫秒时间戳。
 */
export function AuditPage() {
  const canRead = hasPermission(PERMISSION.AUDIT_READ);
  const [draft, setDraft] = useState<Draft>(EMPTY_QUERY);
  const [query, setQuery] = useState<Draft>(EMPTY_QUERY);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(PAGE_SIZE);
  const [data, setData] = useState<PageResult<AuditLog> | null>(null);
  const [actions, setActions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [rangeError, setRangeError] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(
        await auditApi.list({
          page,
          size,
          keyword: query.keyword || undefined,
          action: query.action || undefined,
          targetType: (query.targetType || undefined) as AuditQuery["targetType"],
          targetId: query.targetId || undefined,
          success: (query.success || undefined) as AuditQuery["success"],
          from: localInputToMs(query.from),
          to: localInputToMs(query.to),
        }),
      );
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [page, size, query]);

  useEffect(() => {
    void load();
  }, [load]);

  // 动作清单：出现过的动作（不写死）；拉失败不影响列表，下拉里就只有「全部」
  useEffect(() => {
    if (!canRead) return;
    auditApi
      .actions()
      .then((result) => setActions(result.actions))
      .catch(() => {
        /* 忽略：筛选下拉少几个选项而已 */
      });
  }, [canRead]);

  const submitSearch = () => {
    const from = localInputToMs(draft.from);
    const to = localInputToMs(draft.to);
    if (from !== undefined && to !== undefined && from > to) {
      setRangeError("起始时间不能晚于结束时间");
      return;
    }
    setRangeError("");
    setPage(1);
    setQuery({ ...draft });
  };

  const resetSearch = () => {
    setDraft(EMPTY_QUERY);
    setRangeError("");
    setPage(1);
    setQuery(EMPTY_QUERY);
  };

  const toggleDetail = (id: string) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-50">操作日志</h1>
        <p className="mt-1 text-xs text-slate-500">
          管理端的<strong className="text-slate-400">写</strong>操作自动留痕（读接口不记，否则一页列表就能把日志刷满）。口令一类字段落库前已打码；日志超过上限时自动清理最旧的。
        </p>
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">关键字</span>
            <Input
              value={draft.keyword}
              placeholder="操作人 / 动作 / 目标 id / 请求路径"
              onChange={(event) => setDraft({ ...draft, keyword: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
              }}
            />
          </div>
          <div className="w-52">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">动作</span>
            <Select value={draft.action} onChange={(event) => setDraft({ ...draft, action: event.target.value })}>
              <option value="">全部</option>
              {actions.map((item) => (
                <option key={item} value={item}>
                  {auditActionLabel(item)}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-36">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">目标类型</span>
            <Select value={draft.targetType} onChange={(event) => setDraft({ ...draft, targetType: event.target.value })}>
              <option value="">全部</option>
              {Object.entries(AUDIT_TARGET_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-32">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">结果</span>
            <Select value={draft.success} onChange={(event) => setDraft({ ...draft, success: event.target.value })}>
              <option value="">全部</option>
              <option value="true">只看成功</option>
              <option value="false">只看失败</option>
            </Select>
          </div>
          <div className="w-48">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">起始时间</span>
            <Input type="datetime-local" value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} />
          </div>
          <div className="w-48">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">结束时间</span>
            <Input type="datetime-local" value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} />
          </div>
          <div className="min-w-[180px] flex-1">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">目标 id</span>
            <Input
              value={draft.targetId}
              placeholder="精确匹配某条记录的 id"
              onChange={(event) => setDraft({ ...draft, targetId: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
              }}
            />
          </div>
          <Button onClick={submitSearch}>查询</Button>
          <Button variant="outline" onClick={resetSearch}>
            重置
          </Button>
        </div>
        {rangeError ? <p className="mt-3 rounded-lg border border-rose-500/40 bg-rose-950/50 px-3 py-2 text-xs text-rose-200">{rangeError}</p> : null}
      </Card>

      <Card title="日志" actions={loading ? <Spinner /> : null}>
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>时间</th>
                <th className={thClass}>操作人</th>
                <th className={thClass}>动作</th>
                <th className={thClass}>目标</th>
                <th className={thClass}>结果</th>
                <th className={thClass}>来源 IP</th>
                <th className={`${thClass} text-right`}>请求</th>
              </tr>
            </thead>
            <tbody>
              {data?.list.map((item) => (
                <LogRow key={item.id} item={item} open={Boolean(expanded[item.id])} onToggle={() => toggleDetail(item.id)} />
              ))}
            </tbody>
          </table>
        </div>

        {!loading && data && data.list.length === 0 ? <EmptyState title="没有匹配的日志" description="换个条件或重置筛选试试" /> : null}

        <Pagination
          page={page}
          size={size}
          total={data?.total ?? 0}
          onChange={setPage}
          onSizeChange={(value) => {
            setSize(value);
            setPage(1);
          }}
        />
      </Card>

      <p className="text-xs text-slate-500">
        时间范围按本地时区解释；「目标 id」是精确匹配（想按名字找用关键字）。日志只记管理端的写操作，玩家自己的存档推送不在这里。
      </p>
    </div>
  );
}

/** 一行日志 +（展开时）一行上下文详情 */
function LogRow({ item, open, onToggle }: { item: AuditLog; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className="transition hover:bg-slate-800/30">
        <td className={tdClass}>{formatTimeFull(item.createdAt)}</td>
        <td className={tdClass}>
          {item.actorName ? (
            <span className="flex items-center gap-2">
              <span className="text-slate-100">{item.actorName}</span>
              {item.actorRole ? <span className="text-xs text-slate-500">{adminRoleLabel(item.actorRole)}</span> : null}
            </span>
          ) : (
            <span className="text-slate-500">—（未登录）</span>
          )}
        </td>
        <td className={tdClass}>
          <span className="text-slate-200">{auditActionLabel(item.action)}</span>
          <span className="ml-2 font-mono text-xs text-slate-500">{item.action}</span>
        </td>
        <td className={tdClass}>
          {item.targetType ? (
            <span className="flex flex-col">
              <span className="text-slate-200">{item.targetName ?? "（已删除）"}</span>
              <span className="text-xs text-slate-500">
                {auditTargetLabel(item.targetType)} · {item.targetId ?? "—"}
              </span>
            </span>
          ) : (
            <span className="text-slate-500">—</span>
          )}
        </td>
        <td className={tdClass}>
          {item.success ? (
            <Badge tone="green">成功</Badge>
          ) : (
            <span className="flex flex-col gap-1">
              <Badge tone="red">失败</Badge>
              <span className="text-xs text-slate-500">
                {item.errorCode ?? item.statusCode ?? "—"}
                {item.errorMessage ? ` ${item.errorMessage}` : ""}
              </span>
            </span>
          )}
        </td>
        <td className={tdClass}>{item.ip ?? "—"}</td>
        <td className={`${tdClass} text-right`}>
          <Button variant="ghost" className="px-2.5 py-1 text-xs" onClick={onToggle}>
            {open ? "收起" : "详情"}
          </Button>
        </td>
      </tr>
      {open ? (
        <tr className="bg-slate-900/40">
          <td className={tdClass} colSpan={7}>
            <div className="flex flex-col gap-2 py-1">
              <p className="text-xs text-slate-400">
                请求：<span className="font-mono text-slate-300">{item.method ?? "—"}</span> <span className="font-mono text-slate-300">{item.path ?? "—"}</span>
                {item.statusCode !== null ? <span className="ml-2 text-slate-500">HTTP {item.statusCode}</span> : null}
              </p>
              <pre className="max-h-64 overflow-auto rounded-lg border border-slate-800 bg-slate-950/60 p-3 font-mono text-xs text-slate-300">
                {item.detail ? JSON.stringify(item.detail, null, 2) : "（无请求体）"}
              </pre>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
