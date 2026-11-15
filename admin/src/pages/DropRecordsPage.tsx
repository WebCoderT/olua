import { useCallback, useEffect, useState } from "react";
import { dropApi, itemText, localInputToMs, mapIds, mapText, monsterInfo } from "../api";
import type { DropRecord, DropRecordPage, DropRecordSummary } from "../api";
import {
  Badge,
  Card,
  EmptyState,
  Field,
  Input,
  Select,
  Spinner,
  StatCard,
  tableClass,
  tdClass,
  thClass,
  theadClass,
} from "../components/ui";
import { FilterBar } from "../components/FilterBar";
import { Pagination } from "../components/Pagination";
import { PageHeader } from "../components/PageHeader";

const PAGE_SIZE = 50;

/** 空筛选（重置时复用同一个对象，避免每次渲染造新引用把请求打飞） */
const EMPTY_DRAFT = { mapId: "", goodId: "", ownerName: "", result: "", from: "", to: "" };

type Draft = typeof EMPTY_DRAFT;

/**
 * 终态 → 徽章色调
 *
 * `picked` 是好事（青）、`expired` 是自然损耗（灰）、`overflow` 是「产出大于消耗」的信号（金，
 * 该调产出或加人数）、`restart_lost` 是事故（赤，进程重启把地上的东西丢了）。
 * 这是**语义色**，与仓库「涨红跌绿」的行情口径无关 —— 别拿品牌红当「坏」。
 */
const RESULT_TONE: Record<string, "jade" | "muted" | "gold" | "ember"> = {
  picked: "jade",
  expired: "muted",
  overflow: "gold",
  restart_lost: "ember",
};

/** `overflow` 的细分原因（服务端只给这两个值） */
const REASON_LABEL: Record<string, string> = {
  auto: "超单图上限被挤掉",
  manual_clear: "管理端清空",
};

/**
 * 掉落流水（#803 / 页面 #805）—— 「这件东西最后去哪了」
 *
 * 一件掉落的一生只有一行（`drop_records` append-only）：落地时刻、在地上待了多久、
 * 最后被谁捡走 / 怎么消失的。与「掉落监控」是两回事：那边是**现在**，这边是**结果**。
 *
 * 两个坑写在前面：
 * - **同 `dropId` 可能有多行**：序号每区自增、进程重启后从 1 重新开始，所以翻页与排序
 *   一律按自增 `id`，**页面不按 `dropId` 去重**（docs/18 §3.5）；
 * - **查不到更早的记录不一定是 bug**：每区每图只留最近 N 条 + 只留最近 N 天，两道闸取先到
 *   （N 在部署配置里，页面不写死数字）。
 *
 * ```
 * __UI_CAPTURE__（截图清单 —— 截图工具按 id 逐状态出图，供人眼审；纪律：显示效果不写断言）
 *   loading      初始加载：Spinner 可见
 *   empty        空数据：EmptyState 文案完整
 *   filled       有数据：四态概况 + 表格行（含结果徽章）
 *   filtered     按结果 / 时间 / 地图筛选后的结果
 * ```
 */
export function DropRecordsPage() {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [query, setQuery] = useState<Draft>(EMPTY_DRAFT);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(PAGE_SIZE);
  const [data, setData] = useState<DropRecordPage | null>(null);
  const [summary, setSummary] = useState<DropRecordSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [rangeError, setRangeError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {
        mapId: query.mapId || undefined,
        goodId: query.goodId || undefined,
        ownerName: query.ownerName || undefined,
        result: (query.result || undefined) as DropRecord["result"] | undefined,
        from: localInputToMs(query.from),
        to: localInputToMs(query.to),
      };
      const [listResult, summaryResult] = await Promise.all([
        dropApi.recordList({ ...params, page, size }),
        dropApi.recordSummary(params),
      ]);
      setData(listResult);
      setSummary(summaryResult);
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [page, size, query]);

  useEffect(() => {
    void load();
  }, [load]);

  const search = () => {
    const from = localInputToMs(draft.from);
    const to = localInputToMs(draft.to);
    if (from !== undefined && to !== undefined && from > to) {
      setRangeError("起始时间不能晚于结束时间");
      return;
    }
    setRangeError("");
    setQuery(draft);
    setPage(1);
  };

  const rows = data?.list ?? [];

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4">
      <PageHeader
        title="掉落流水"
        description="每件掉落只留一行终态：被谁捡走 / 过期 / 被挤掉 / 重启丢失（append-only，不重复不覆盖）"
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="合计" value={summary?.total ?? 0} hint="当前筛选条件下" plain />
        {(summary?.items ?? []).map((item) => (
          <StatCard key={item.result} label={item.resultLabel} value={item.total} plain />
        ))}
      </div>

      <FilterBar
        onSearch={search}
        onReset={() => {
          setDraft(EMPTY_DRAFT);
          setQuery(EMPTY_DRAFT);
          setRangeError("");
          setPage(1);
        }}
        loading={loading}
      >
        <Field label="结果">
          <Select value={draft.result} onChange={(event) => setDraft({ ...draft, result: event.target.value })}>
            <option value="">全部结果</option>
            {(summary?.items ?? []).map((item) => (
              <option key={item.result} value={item.result}>
                {item.resultLabel}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="地图">
          <Select value={draft.mapId} onChange={(event) => setDraft({ ...draft, mapId: event.target.value })}>
            <option value="">全部地图</option>
            {mapIds().map((id) => (
              <option key={id} value={id}>
                {mapText(id)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="物品 id" width="w-44">
          <Input
            value={draft.goodId}
            onChange={(event) => setDraft({ ...draft, goodId: event.target.value })}
            placeholder="精确匹配"
          />
        </Field>
        <Field label="归属者" width="w-40">
          <Input
            value={draft.ownerName}
            onChange={(event) => setDraft({ ...draft, ownerName: event.target.value })}
            placeholder="角色名"
          />
        </Field>
        <Field label="从">
          <Input
            type="datetime-local"
            value={draft.from}
            onChange={(event) => setDraft({ ...draft, from: event.target.value })}
          />
        </Field>
        <Field label="到">
          <Input
            type="datetime-local"
            value={draft.to}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          />
        </Field>
      </FilterBar>
      {rangeError ? <p className="text-[12px] text-warn">{rangeError}</p> : null}

      <Card
        title="终态流水"
        actions={loading ? <Spinner /> : null}
        description="默认按终态时刻倒序。同一 dropId 可能出现多行（序号每区自增、进程重启后从 1 重来），所以排序翻页一律按自增 id。"
      >
        {loading && data === null ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="这段时间没有掉落记录"
            description="换个时间范围看看；另外每张图只保留最近若干条、最多若干天，太早的记录会被自动裁掉"
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className={tableClass}>
                <thead className={theadClass}>
                  <tr>
                    <th className={thClass}>终态时刻</th>
                    <th className={thClass}>物品</th>
                    <th className={thClass}>数量</th>
                    <th className={thClass}>来源怪物</th>
                    <th className={thClass}>归属者</th>
                    <th className={thClass}>结果</th>
                    <th className={thClass}>拾取者 / 原因</th>
                    <th className={thClass}>存活</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="transition hover:bg-surface-4/30">
                      <td className={`${tdClass} legend-num text-ink-4`}>{formatTime(row.resolvedAt)}</td>
                      <td className={`${tdClass} font-medium text-ink-1`}>
                        {row.goodLabel || itemText(row.goodId)}
                        <span className="ml-2 font-mono text-[11px] text-ink-5">{row.goodId}</span>
                      </td>
                      <td className={`${tdClass} legend-num`}>
                        {row.count}
                        {row.bound ? <span className="ml-1 text-[11px] text-gold">绑</span> : null}
                      </td>
                      <td className={tdClass}>
                        {row.monsterLabel ?? monsterInfo(row.monsterKey)?.label ?? row.monsterKey}
                        <span className="ml-2 text-[11px] text-ink-5">{mapText(row.mapId)}</span>
                      </td>
                      <td className={tdClass}>{row.ownerName || "—"}</td>
                      <td className={tdClass}>
                        <Badge tone={RESULT_TONE[row.result] ?? "muted"}>{row.resultLabel}</Badge>
                      </td>
                      <td className={tdClass}>
                        {row.result === "picked"
                          ? row.pickedName || "—"
                          : row.reason
                            ? (REASON_LABEL[row.reason] ?? row.reason)
                            : "—"}
                      </td>
                      <td className={`${tdClass} legend-num text-ink-4`}>{formatLived(row.livedMs)}</td>
                    </tr>
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
      <p className="text-[11px] text-ink-5">
        查不到更早的记录不一定是故障：每区每图只留最近若干条 + 最多若干天（两道闸取先到），阈值在部署配置里。
      </p>
    </div>
  );
}

/** 毫秒时间戳 → `MM-DD HH:mm:ss`（这一页要的是「什么时候」，年份用不上） */
function formatTime(ms: number): string {
  if (!ms) return "—";
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 存活时长：不足 1 分钟给秒，超过给「分秒」（排查「有人守着不捡」看的就是它） */
function formatLived(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}
