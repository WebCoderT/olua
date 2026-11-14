import { Fragment, useCallback, useEffect, useState } from "react";
import { formatTime, reportsApi } from "../api";
import type { Report, ReportQuery } from "../api";
import { Pagination } from "../components/Pagination";
import { FilterBar } from "../components/FilterBar";
import { PageHeader } from "../components/PageHeader";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Select,
  Spinner,
  tableClass,
  tdClass,
  thClass,
  theadClass,  Field,
} from "../components/ui";

const PAGE_SIZE = 20;

/** 类别中文名（与服务端 REPORT_CATEGORY_LABELS 同源；这里只用它做下拉选项） */
const CATEGORY_LABELS: Array<[string, string]> = [
  ["abuse", "骚扰辱骂"],
  ["cheat", "外挂刷资源"],
  ["name", "名字违规"],
  ["other", "其他"],
];

/** 状态中文名与配色（v1 只会出现 pending，另两种是后续刀的落脚点） */
const STATUS_META: Record<string, { label: string; tone: "muted" | "jade" | "ember" }> = {
  pending: { label: "待处理", tone: "muted" },
  handled: { label: "已处理", tone: "jade" },
  dismissed: { label: "已驳回", tone: "ember" },
};

/**
 * 玩家举报（#398，只读）
 *
 * ## 这一页为什么只有「看」
 * 举报的处理需要一整套东西：谁改的状态、凭什么改、被举报的人能不能申诉、处罚落到哪。
 * 半成品的处置按钮比没有更糟（点一下「已处理」而什么都没发生，运营会以为处理完了）。
 * 所以这一刀只把举报**摆出来**，处置是后续一整刀（issue #398 的边界）。
 *
 * ## 名字是「现在」的名字
 * 双方角色名由服务端在查询时关联出来：角色改名后这里跟着变；角色被删了显示 id ——
 * 举报记录本身不随人消失，这与审计日志同一套口径（冗余与关联各有代价，这里选关联）。
 */
export function ReportsPage() {
  const [draft, setDraft] = useState({ keyword: "", category: "", status: "" });
  const [query, setQuery] = useState({ keyword: "", category: "", status: "" });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(PAGE_SIZE);
  const [data, setData] = useState<{ list: Report[]; total: number; page: number; size: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(
        await reportsApi.list({
          page,
          size,
          keyword: query.keyword || undefined,
          category: (query.category || undefined) as ReportQuery["category"],
          status: (query.status || undefined) as ReportQuery["status"],
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

  const submitSearch = () => {
    setPage(1);
    setQuery(draft);
  };

  const resetSearch = () => {
    setDraft({ keyword: "", category: "", status: "" });
    setPage(1);
    setQuery({ keyword: "", category: "", status: "" });
  };

  const toggle = (id: string) => setExpanded((current) => ({ ...current, [id]: !current[id] }));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="玩家举报"
        description="这一版只把举报摆出来，不做处置：半成品的「已处理」按钮比没有更糟。双方角色名取查询时的现名，角色被删后显示 id。"
      />

      <FilterBar onSearch={submitSearch} onReset={resetSearch}>
        <Field width="w-56" label="角色名 / 角色 id">
          <Input
            value={draft.keyword}
            placeholder="举报人或被举报人"
            onChange={(event) => setDraft({ ...draft, keyword: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitSearch();
            }}
          />
        </Field>
        <Field width="w-40" label="类别">
          <Select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })}>
            <option value="">全部</option>
            {CATEGORY_LABELS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field width="w-32" label="状态">
          <Select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}>
            <option value="">全部</option>
            {Object.entries(STATUS_META).map(([value, meta]) => (
              <option key={value} value={value}>
                {meta.label}
              </option>
            ))}
          </Select>
        </Field>
      </FilterBar>

      <Card
        title="举报记录"
        actions={loading ? <Spinner /> : null}
        description="按举报时间倒序。这一页只读：处置（改状态 / 处罚）是后续刀，避免出现「点了没反应」的假入口。"
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>时间</th>
                <th className={thClass}>举报人</th>
                <th className={thClass}>被举报人</th>
                <th className={thClass}>类别</th>
                <th className={thClass}>说明</th>
                <th className={thClass}>状态</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data?.list.map((item) => {
                const meta = STATUS_META[item.status] ?? { label: item.status, tone: "muted" as const };
                const open = Boolean(expanded[item.id]);
                return (
                  <Fragment key={item.id}>
                    <tr className="transition hover:bg-surface-4/30">
                      <td className={tdClass}>{formatTime(item.createdAt)}</td>
                      <td className={tdClass}>
                        <span className="text-ink-2">{item.roleName ?? "（已删除）"}</span>
                        <span className="ml-2 font-mono text-xs text-ink-5">{item.roleId}</span>
                      </td>
                      <td className={tdClass}>
                        <span className="text-ink-2">{item.targetName ?? "（已删除）"}</span>
                        <span className="ml-2 font-mono text-xs text-ink-5">{item.targetRoleId}</span>
                      </td>
                      <td className={tdClass}>{item.categoryLabel}</td>
                      <td className={`${tdClass} max-w-[280px] truncate`} title={item.reason || undefined}>
                        {item.reason || <span className="text-ink-5">—</span>}
                      </td>
                      <td className={tdClass}>
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                      </td>
                      <td className={`${tdClass} text-right`}>
                        <Button variant="ghost" className="px-2.5 py-1 text-xs" onClick={() => toggle(item.id)}>
                          {open ? "收起" : "详情"}
                        </Button>
                      </td>
                    </tr>
                    {open ? (
                      <tr className="bg-surface-2/40">
                        <td className={tdClass} colSpan={7}>
                          <div className="flex flex-col gap-1 py-1 text-xs text-ink-3">
                            <p>
                              举报 id：<span className="font-mono text-ink-4">{item.id}</span>
                            </p>
                            <p>
                              类别：{item.categoryLabel}（<span className="font-mono">{item.category}</span>）
                            </p>
                            <p>说明：{item.reason || "（未填写）"}</p>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        {!loading && data && data.list.length === 0 ? (
          <EmptyState title="没有匹配的举报" description="换个条件或重置筛选试试；没有举报也是好消息" />
        ) : null}

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

      <p className="text-xs text-ink-5">
        举报只落库、不自动处罚：是否需要处置由人判断。被举报人不会收到任何通知 —— 通知等于把举报人卖了。
      </p>
    </div>
  );
}
