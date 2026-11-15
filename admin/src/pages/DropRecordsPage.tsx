import { useCallback, useEffect, useMemo, useState } from "react";
import { dropApi, formatTimeFull, itemIconOf, itemText, mapIds, mapText, monsterInfo, PERMISSION } from "../api";
import type { DropRecord, DropRecordQuery, DropRecordSummary, PageResult } from "../api";
import { FilterBar } from "../components/FilterBar";
import { GameIcon } from "../components/GameImage";
import { Pagination } from "../components/Pagination";
import { PageHeader } from "../components/PageHeader";
import { Badge, Button, Card, EmptyState, Field, Input, Notice, Select, Spinner, StatCard, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";

/**
 * 掉落流水（#805）
 *
 * 回答的是「**这件东西最后去哪了**」：`drop_records` 是 append-only 的终态流水，一件掉落
 * 离开地面时写一行，之后不再改 —— 所以这一页可以慢、可以旧，但不能少。与「掉落监控」
 * 不是一回事：那边看投影（现在地上有什么），这边看历史（已经结束的那些）。
 *
 * 三个容易踩的点，页面措辞都照着写：
 * - **同 `dropId` 可能有多行**：`dropId` 里的序号每区自增，进程重启后从 1 重来 —— 两次生命
 *   周期可能撞号。所以一律按自增 `id` 翻页排序，**不按 `dropId` 去重**；
 * - **默认只看近 1 小时**：这张表一天就能长很大（每件掉落一行），不限时间的第一页没有意义；
 * - **概况卡不吃 `result` 筛选**（服务端刻意如此）：选了「只看过期」时，四格仍显示各终态的
 *   真实分布，否则只剩一格。
 *
 * 结果色沿用 legend 的四族语义（不是「涨红跌绿」那套）：`picked` 玉（正常结束）/ `expired`
 * 灰（什么都没发生）/ `overflow` 琥珀（被淘汰，属于正常损耗）/ `restart_lost` 火（事故）。
 *
 * ```
 * __UI_CAPTURE__（截图清单 —— 截图工具按 id 逐状态出图，供人眼审；纪律：显示效果不写断言）
 *   loading      初始加载：Spinner 可见，概况卡为 0
 *   empty        筛选窗口内没有流水：EmptyState 文案完整
 *   filled       有数据：概况卡四格 + 表格行 + 四种结果色
 *   filtered     只看「被挤掉」：概况卡不变，表格只剩 overflow 行
 *   no-perm      只读账号（无 drop:read）：整页换成权限提示
 * ```
 */

/** 每页条数：这页是「扫时间线」的重表格，比配置页的 20 大 */
const PAGE_SIZE = 50;

/** 时间范围预设（默认近 1 小时）。`all` 不给 `from`/`to`，等于全表倒序翻 */
const RANGE_OPTIONS = [
  { value: "15m", label: "近 15 分钟", ms: 15 * 60_000 },
  { value: "1h", label: "近 1 小时", ms: 60 * 60_000 },
  { value: "6h", label: "近 6 小时", ms: 6 * 60 * 60_000 },
  { value: "24h", label: "近 24 小时", ms: 24 * 60 * 60_000 },
  { value: "7d", label: "近 7 天", ms: 7 * 24 * 60 * 60_000 },
  { value: "all", label: "不限时间", ms: 0 },
] as const;

type RangeValue = (typeof RANGE_OPTIONS)[number]["value"];

/** 排序白名单里的三项（服务端 `DROP_RECORD_SORT`）；方向固定倒序 —— 「最近 / 最久」才是运营要的 */
const SORT_OPTIONS = [
  { value: "resolvedAt", label: "终态时刻" },
  { value: "createdAt", label: "落地时刻" },
  { value: "livedMs", label: "存活时长" },
] as const;

const EMPTY_DRAFT = {
  range: "1h" as RangeValue,
  mapId: "",
  monsterKey: "",
  ownerName: "",
  pickedName: "",
  goodId: "",
  result: "",
  sort: "resolvedAt",
};

type Draft = typeof EMPTY_DRAFT;

/** 概况还没回来时的结果下拉占位：免得下拉框在首屏短暂没有选项 */
const DEFAULT_RESULTS = [
  { result: "picked", resultLabel: "已被拾取", total: 0 },
  { result: "expired", resultLabel: "自然过期", total: 0 },
  { result: "overflow", resultLabel: "被挤掉", total: 0 },
  { result: "restart_lost", resultLabel: "重启丢失", total: 0 },
];

export function DropRecordsPage() {
  const canRead = hasPermission(PERMISSION.DROP_READ);

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [query, setQuery] = useState<Draft>(EMPTY_DRAFT);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(PAGE_SIZE);
  const [data, setData] = useState<PageResult<DropRecord> | null>(null);
  const [summary, setSummary] = useState<DropRecordSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const maps = useMemo(() => mapIds(), []);

  /**
   * 筛选 → 查询参数
   *
   * 时间窗**每次请求现算**（`to` = 此刻）：停在「近 1 小时」的页面上，新发生的流水也要
   * 刷得出来。把窗口冻在点「查询」那一刻的话，页面看着在刷新，实际一直停在旧窗口里。
   */
  const queryParams = useCallback((): DropRecordQuery => {
    const span = RANGE_OPTIONS.find((item) => item.value === query.range)?.ms ?? 0;
    const now = Date.now();
    return {
      mapId: query.mapId || undefined,
      monsterKey: query.monsterKey || undefined,
      ownerName: query.ownerName || undefined,
      pickedName: query.pickedName || undefined,
      goodId: query.goodId || undefined,
      result: (query.result || undefined) as DropRecordQuery["result"],
      from: span ? now - span : undefined,
      to: span ? now : undefined,
      sort: query.sort,
      order: "desc",
    };
  }, [query]);

  /** 列表 + 概况一起拉：两个数字不同源的话，「共 N 条」和概况卡加起来会打架 */
  const load = useCallback(async () => {
    if (!canRead) return;
    setLoading(true);
    try {
      const params = queryParams();
      const [list, stats] = await Promise.all([
        dropApi.recordList({ ...params, page, size }),
        dropApi.recordSummary(params),
      ]);
      setData(list);
      setSummary(stats);
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [canRead, page, size, queryParams]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitSearch = () => {
    setPage(1);
    setQuery({ ...draft });
  };

  const resetSearch = () => {
    setDraft(EMPTY_DRAFT);
    setPage(1);
    setQuery(EMPTY_DRAFT);
  };

  if (!canRead) {
    return (
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4">
        <PageHeader title="掉落流水" description="已经结束的掉落记录（谁打的、谁捡走的）。" />
        <Notice tone="warn" title="没有权限">
          当前账号没有「查看掉落记录」（`drop:read`）权限。
        </Notice>
      </div>
    );
  }

  const rows = data?.list ?? [];
  const total = summary?.total ?? 0;
  const countOf = (result: string) => summary?.items.find((item) => item.result === result)?.total ?? 0;

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4">
      <PageHeader
        title="掉落流水"
        description={
          <>
            每件掉落离开地面时写一行（
            <strong className="text-ink-4">append-only，之后不再改</strong>
            ），默认只看近 1 小时。同一条 `dropId` 可能有多行 —— 序号进程重启后会从头开始，翻页一律按自增 id。
          </>
        }
        actions={
          <Button variant="outline" onClick={() => void load()} loading={loading}>
            刷新
          </Button>
        }
      />

      <FilterBar
        loading={loading}
        onSearch={submitSearch}
        onReset={resetSearch}
        hint="条件之间是「与」。名字类条件都是模糊匹配（`_` / `%` 会被转义，不会被当成通配符）。"
      >
        <Field label="时间范围" width="w-32">
          <Select value={draft.range} onChange={(event) => setDraft({ ...draft, range: event.target.value as RangeValue })}>
            {RANGE_OPTIONS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="地图" width="w-44">
          <Select value={draft.mapId} onChange={(event) => setDraft({ ...draft, mapId: event.target.value })}>
            <option value="">全部地图</option>
            {maps.map((id) => (
              <option key={id} value={id}>
                {mapText(id)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="怪物" width="w-40">
          <Input
            value={draft.monsterKey}
            placeholder="key 或名字"
            onChange={(event) => setDraft({ ...draft, monsterKey: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitSearch();
            }}
          />
        </Field>
        <Field label="物品 id" width="w-40">
          <Input
            value={draft.goodId}
            placeholder="精确（如 drug_hp）"
            onChange={(event) => setDraft({ ...draft, goodId: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitSearch();
            }}
          />
        </Field>
        <Field label="归属者" width="w-36">
          <Input
            value={draft.ownerName}
            placeholder="角色名"
            onChange={(event) => setDraft({ ...draft, ownerName: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitSearch();
            }}
          />
        </Field>
        <Field label="拾取者" width="w-36">
          <Input
            value={draft.pickedName}
            placeholder="角色名"
            onChange={(event) => setDraft({ ...draft, pickedName: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitSearch();
            }}
          />
        </Field>
        <Field label="结果" width="w-32">
          <Select value={draft.result} onChange={(event) => setDraft({ ...draft, result: event.target.value })}>
            <option value="">全部结果</option>
            {(summary?.items ?? DEFAULT_RESULTS).map((item) => (
              <option key={item.result} value={item.result}>
                {item.resultLabel}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="排序" width="w-32">
          <Select value={draft.sort} onChange={(event) => setDraft({ ...draft, sort: event.target.value })}>
            {SORT_OPTIONS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </Select>
        </Field>
      </FilterBar>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={resultLabelOf(summary, "picked")} value={countOf("picked")} hint={shareHint(countOf("picked"), total)} />
        <StatCard label={resultLabelOf(summary, "expired")} value={countOf("expired")} hint={shareHint(countOf("expired"), total)} plain />
        <StatCard label={resultLabelOf(summary, "overflow")} value={countOf("overflow")} hint={shareHint(countOf("overflow"), total)} plain />
        <StatCard label={resultLabelOf(summary, "restart_lost")} value={countOf("restart_lost")} hint={shareHint(countOf("restart_lost"), total)} plain />
      </div>

      <Card
        title="流水"
        actions={loading ? <Spinner /> : null}
        description={
          <>
            当前筛选共 <span className="legend-num text-ink-2">{data?.total ?? 0}</span> 条；概况统计{" "}
            <span className="legend-num">{total}</span> 条（不含「结果」这一项筛选）。
          </>
        }
      >
        {loading && data === null ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="这个窗口里没有掉落记录"
            description="掉落只在玩家击杀时产生；把时间范围放宽，或清掉筛选条件再看。老记录也可能被保留策略挤掉了。"
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className={tableClass}>
                <thead className={theadClass}>
                  <tr>
                    <th className={thClass}>时间</th>
                    <th className={thClass}>物品</th>
                    <th className={`${thClass} text-right`}>数量</th>
                    <th className={thClass}>来源怪物</th>
                    <th className={thClass}>归属者</th>
                    <th className={thClass}>结果</th>
                    <th className={thClass}>拾取者 / 原因</th>
                    <th className={`${thClass} text-right`}>存活</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <RecordRow key={row.id} row={row} />
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={page}
              size={size}
              total={data?.total ?? 0}
              onChange={setPage}
              onSizeChange={(next) => {
                setSize(next);
                setPage(1);
              }}
            />
          </>
        )}
      </Card>

      <p className="text-xs text-ink-5">
        物品名 / 怪物名是**掉落那一刻的快照**：配置后来改了或删了，这里仍显示当时的名字（查不到就显示 id）。
        这张表有两道保留闸（每图条数 + 保留天数，先到先删）—— 查不到更早的记录大多是这两道闸干的。
      </p>
    </div>
  );
}

/** 终态中文名：以服务端概况为准（它是 `DROP_RESULT_LABELS` 的唯一来源），没回来时用占位 */
function resultLabelOf(summary: DropRecordSummary | null, result: string): string {
  return (
    summary?.items.find((item) => item.result === result)?.resultLabel ??
    DEFAULT_RESULTS.find((item) => item.result === result)?.resultLabel ??
    result
  );
}

/** 概况卡第二行：占比。合计为 0 时说「还没有记录」，不显示 0% */
function shareHint(count: number, total: number): string {
  if (total <= 0) return "还没有记录";
  return `占 ${Math.round((count / total) * 100)}%`;
}

/** 一行流水 */
function RecordRow({ row }: { row: DropRecord }) {
  return (
    <tr className="transition hover:bg-surface-4/30">
      <td className={tdClass}>
        <span className="flex flex-col">
          <span className="legend-num text-ink-2">{formatTimeFull(row.resolvedAt)}</span>
          <span className="legend-num text-xs text-ink-5">落 {formatTimeFull(row.createdAt)}</span>
        </span>
      </td>
      <td className={tdClass}>
        <span className="flex items-center gap-2">
          <GameIcon path={itemIconOf(row.goodId)} alt={row.goodLabel ?? row.goodId} size={28} zoomable={false} />
          <span className="flex flex-col">
            <span className="text-ink-1">{row.goodLabel ?? itemText(row.goodId)}</span>
            <span className="font-mono text-xs text-ink-5">{row.goodId}</span>
          </span>
          {row.bound ? <Badge tone="warn">绑定</Badge> : null}
        </span>
      </td>
      <td className={`${tdClass} legend-num text-right text-ink-1`}>{row.count}</td>
      <td className={tdClass}>
        <span className="flex flex-col">
          <span className="text-ink-3">{row.monsterLabel ?? monsterInfo(row.monsterKey)?.label ?? row.monsterKey}</span>
          <span className="font-mono text-xs text-ink-5">
            {row.monsterKey} · #{row.monsterInstanceId}
          </span>
        </span>
      </td>
      <td className={tdClass}>
        <span className="flex flex-col">
          <span className="text-ink-3">{row.ownerName || "—"}</span>
          <span className="font-mono text-xs text-ink-5">{row.ownerRoleId}</span>
        </span>
      </td>
      <td className={tdClass}>
        <span className="flex flex-col items-start gap-1">
          <Badge tone={RESULT_TONES[row.result] ?? "muted"}>{row.resultLabel}</Badge>
          {row.reason ? <span className="text-xs text-ink-5">{reasonText(row.reason)}</span> : null}
        </span>
      </td>
      <td className={tdClass}>
        {row.pickedName ? (
          <span className="flex flex-col">
            <span className="text-ink-3">{row.pickedName}</span>
            <span className="font-mono text-xs text-ink-5">{row.pickedRoleId}</span>
          </span>
        ) : (
          <span className="text-ink-5">{reasonText(row.reason) ?? notPickedText(row.result)}</span>
        )}
      </td>
      <td className={`${tdClass} legend-num text-right text-ink-3`}>{livedText(row.livedMs)}</td>
    </tr>
  );
}

/**
 * 终态 → 徽章色（四族语义，不是「涨红跌绿」）
 *
 * `overflow` 用琥珀而不是火色：被单图上限挤掉是**正常损耗**（#803 的淘汰策略），
 * 把它染成红色会让运营以为出事故。真正的「事故」只有 `restart_lost`。
 */
const RESULT_TONES: Record<string, "jade" | "muted" | "warn" | "ember"> = {
  picked: "jade",
  expired: "muted",
  overflow: "warn",
  restart_lost: "ember",
};

/** `overflow` 的细分（服务端只给这两个值） */
function reasonText(reason: string | null): string | null {
  if (!reason) return null;
  if (reason === "auto") return "超单图上限";
  if (reason === "manual_clear") return "管理端清空";
  return reason;
}

/** 「不是被捡走」的那几种：给「拾取者」列一个说得过去的说明 */
function notPickedText(result: DropRecord["result"]): string {
  if (result === "expired") return "没人捡，到点消失";
  if (result === "restart_lost") return "进程重启，地面清空";
  if (result === "overflow") return "被挤掉";
  return "—";
}

/**
 * 存活时长（`livedMs`）→ 人读
 *
 * 不复用 `formatDuration`：那个按分钟起步（掉落在地上往往只有几十秒），
 * 「1 分钟」会把 8 秒和 55 秒显示成同一个值。
 */
function livedText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes ? `${hours}h${String(restMinutes).padStart(2, "0")}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24}h`;
}
