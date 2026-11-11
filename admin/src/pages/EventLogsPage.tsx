import { useCallback, useEffect, useState } from "react";
import {
  eventsApi,
  formatTimeFull,
  itemText,
  localInputToMs,
  mapText,
  monsterInfo,
  PERMISSION,
} from "../api";
import type { EventLog, EventLogQuery, EventType, PageResult } from "../api";
import { Pagination } from "../components/Pagination";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { PageHeader } from "../components/PageHeader";

const PAGE_SIZE = 20;

/** 空筛选条件（重置时复用同一个对象，避免每次渲染都造新引用把请求打飞） */
const EMPTY_QUERY = { keyword: "", type: "", roleId: "", accountId: "", mapId: "", success: "", from: "", to: "" };

type Draft = typeof EMPTY_QUERY;

/**
 * 玩家行为流水（#886）
 *
 * 与「操作日志」是两回事：那一页记的是**管理员**点了哪个接口（谁改了什么配置、成没成），
 * 这一页记的是**玩家角色**做了什么（在哪张图杀了什么、捡了什么、花了多少）。
 * 分表分页分开授权，所以两边的筛选条件也完全不同 —— 别指望在这里找某个管理员的操作。
 *
 * 排序固定「时间倒序」：这张表是按时间写的账，换排序只会让人误以为在查别的（服务端也
 * 只认这一种顺序，界面就不摆一排点了没反应的箭头）。
 */
export function EventLogsPage() {
  const canRead = hasPermission(PERMISSION.EVENT_READ);
  const [draft, setDraft] = useState<Draft>(EMPTY_QUERY);
  const [query, setQuery] = useState<Draft>(EMPTY_QUERY);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(PAGE_SIZE);
  const [data, setData] = useState<PageResult<EventLog> | null>(null);
  const [types, setTypes] = useState<EventType[]>([]);
  const [loading, setLoading] = useState(true);
  const [rangeError, setRangeError] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const queryParams = useCallback(
    (): EventLogQuery => ({
      keyword: query.keyword || undefined,
      type: query.type || undefined,
      roleId: query.roleId || undefined,
      accountId: query.accountId || undefined,
      mapId: query.mapId || undefined,
      success: (query.success || undefined) as EventLogQuery["success"],
      from: localInputToMs(query.from),
      to: localInputToMs(query.to),
    }),
    [query],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await eventsApi.list({ ...queryParams(), page, size }));
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [page, size, queryParams]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 类型清单（字典 ∪ 库内出现过的）
   *
   * 这里**必须**用服务端给的清单而不是前端写死：`trade` / `enhance` 这类暂时放置的类型
   * 会以 `total = 0` 出现，界面上一眼就能看出「字典里有、就是还没埋上」。
   * 拉失败不影响列表，下拉里就只有「全部」。
   */
  useEffect(() => {
    if (!canRead) return;
    eventsApi
      .types()
      .then((result) => setTypes(result.types))
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
      <PageHeader
        title="玩家行为流水"
        description={
          <>
            玩家侧的行为记录（登录 / 进图 / 击杀 / 拾取 / 获得 / 消耗 / 邮件 / 任务）。
            <strong className="text-slate-400">与「操作日志」不同</strong>：那一页记管理员的写操作，这一页记玩家角色做了什么。
            超过保留天数或条数上限时自动清理最旧的。
          </>
        }
      />

      <Card>
        <div className="flex flex-wrap items-end gap-2">
          <Field width="w-56" label="关键字">
            <Input
              value={draft.keyword}
              placeholder="角色名 / 对象 id / 载荷内容"
              onChange={(event) => setDraft({ ...draft, keyword: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
              }}
            />
          </Field>
          <Field width="w-48" label="事件类型">
            <Select value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value })}>
              <option value="">全部</option>
              {types.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}（{item.total}）
                </option>
              ))}
            </Select>
          </Field>
          <Field width="w-32" label="结果">
            <Select value={draft.success} onChange={(event) => setDraft({ ...draft, success: event.target.value })}>
              <option value="">全部</option>
              <option value="true">只看成功</option>
              <option value="false">只看失败</option>
            </Select>
          </Field>
          <Field width="w-40" label="地图">
            <Input
              value={draft.mapId}
              placeholder="地图 id（精确）"
              onChange={(event) => setDraft({ ...draft, mapId: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
              }}
            />
          </Field>
          <Field width="w-44" label="角色 id">
            <Input
              value={draft.roleId}
              placeholder="精确匹配"
              onChange={(event) => setDraft({ ...draft, roleId: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
              }}
            />
          </Field>
          <Field width="w-44" label="账号 id">
            <Input
              value={draft.accountId}
              placeholder="精确匹配"
              onChange={(event) => setDraft({ ...draft, accountId: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
              }}
            />
          </Field>
          <Field width="w-48" label="起始时间">
            <Input type="datetime-local" value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} />
          </Field>
          <Field width="w-48" label="结束时间">
            <Input type="datetime-local" value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} />
          </Field>
          <Button onClick={submitSearch}>查询</Button>
          <Button variant="outline" onClick={resetSearch}>
            重置
          </Button>
        </div>
        {rangeError ? <p className="mt-3 rounded-lg border border-rose-500/40 bg-rose-950/50 px-3 py-2 text-xs text-rose-200">{rangeError}</p> : null}
      </Card>

      <Card
        title="流水"
        actions={loading ? <Spinner /> : null}
        description="按发生时间倒序（这张表是账本，不做自定义排序）。点「详情」看这一条记了什么。"
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>时间</th>
                <th className={thClass}>类型</th>
                <th className={thClass}>角色</th>
                <th className={thClass}>地图</th>
                <th className={thClass}>对象 / 数量</th>
                <th className={thClass}>来源 IP</th>
                <th className={`${thClass} text-right`}>详情</th>
              </tr>
            </thead>
            <tbody>
              {data?.list.map((item) => (
                <EventRow key={item.id} item={item} open={Boolean(expanded[item.id])} onToggle={() => toggleDetail(item.id)} />
              ))}
            </tbody>
          </table>
        </div>

        {!loading && data && data.list.length === 0 ? <EmptyState title="没有匹配的流水" description="换个条件或重置筛选试试" /> : null}

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
        时间范围按本地时区解释；角色 / 账号 / 地图都是精确匹配（想按名字找用关键字）。地图名来自地图名录，名录里没有的显示原 id。
        登录失败的记录没有账号 id（那是「尝试登录的用户名」写在详情里）—— 详情里能看到。
      </p>
    </div>
  );
}

/** 一行流水 +（展开时）一行上下文详情 */
function EventRow({ item, open, onToggle }: { item: EventLog; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className="transition hover:bg-slate-800/30">
        <td className={tdClass}>{formatTimeFull(item.createdAt)}</td>
        <td className={tdClass}>
          <span className="flex items-center gap-2">
            <span className="text-slate-200">{item.typeLabel}</span>
            {item.success ? null : <Badge tone="red">失败</Badge>}
          </span>
          <span className="font-mono text-xs text-slate-500">{item.type}</span>
        </td>
        <td className={tdClass}>
          {item.roleName || item.roleId ? (
            <span className="flex flex-col">
              <span className="text-slate-100">{item.roleName ?? "（角色已删）"}</span>
              <span className="font-mono text-xs text-slate-500">{item.roleId ?? "—"}</span>
            </span>
          ) : (
            <span className="text-slate-500">—</span>
          )}
        </td>
        <td className={tdClass}>{item.mapId ? mapText(item.mapId) : "—"}</td>
        <td className={tdClass}>
          <TargetCell item={item} />
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
                账号：<span className="font-mono text-slate-300">{item.accountId ?? "—"}</span>
                <span className="ml-3">区服：</span>
                <span className="font-mono text-slate-300">{item.zoneId ?? "—"}</span>
                <span className="ml-3">地图：</span>
                <span className="font-mono text-slate-300">{item.mapId ?? "—"}</span>
                <span className="ml-3">流水 id：</span>
                <span className="font-mono text-slate-300">{item.id}</span>
              </p>
              <pre className="max-h-64 overflow-auto rounded-lg border border-slate-800 bg-slate-950/60 p-3 font-mono text-xs text-slate-300">
                {item.detail ? JSON.stringify(item.detail, null, 2) : "（无附加上下文）"}
              </pre>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * 「对象 / 数量」这一列
 *
 * `target` 的含义随类型变（怪物 key / 物品 id / 任务 id / 邮件 id），所以名字要查各自的表，
 * 查不到就原样显示 id —— 宁可显示 `mon_101` 也不显示「未知」，否则日志里丢了 id 就再也追不回来。
 */
function TargetCell({ item }: { item: EventLog }) {
  if (!item.target) return <span className="text-slate-500">—</span>;
  const name = targetNameOf(item);
  return (
    <span className="flex flex-col">
      <span className="text-slate-200">
        {name}
        {item.amount !== null ? <span className="ml-2 tabular-nums text-amber-300">×{item.amount}</span> : null}
      </span>
      {name !== item.target ? <span className="font-mono text-xs text-slate-500">{item.target}</span> : null}
    </span>
  );
}

function targetNameOf(item: EventLog): string {
  const target = item.target!;
  switch (item.type) {
    case "kill":
      return monsterInfo(target)?.label ?? target;
    case "pick":
    case "gain":
    case "consume":
      // 货币没有物品行，直接给中文（bindGold 是唯一货币；旧流水里的 gold 同样读作绑定元宝）；其余走物品名录
      return target === "gold" || target === "bindGold" ? "绑定元宝" : itemText(target);
    case "mail":
      // 邮件 id 本身没有可读名，标题在载荷里
      return typeof item.detail?.title === "string" ? `${item.detail.title}` : target;
    default:
      return target;
  }
}
