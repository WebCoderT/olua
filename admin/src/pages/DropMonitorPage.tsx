import { useCallback, useEffect, useRef, useState } from "react";
import { dropApi, itemText, mapIds, mapText, monsterInfo } from "../api";
import type { DropGround, DropGroundPage, DropGroundSummary } from "../api";
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

/** 轮询间隔：地面掉落是「现在」的状态，3 秒够用（服务端投影本身就落后 100ms 一拍） */
const POLL_MS = 3000;

/** 默认每页条数（与接口默认一致） */
const PAGE_SIZE = 50;

const EMPTY_DRAFT = { mapId: "", keyword: "", ownerName: "" };

type Draft = typeof EMPTY_DRAFT;

/**
 * 掉落监控（#805）—— 「现在地上有什么」
 *
 * 数据来自 `world_drops` **投影**（实时进程 100ms 批量刷一次），所以本页与真实地面
 * **最多差一拍**：看到的东西可能下一拍已经被捡走了。要追「这件东西最后去哪了」看
 * 「掉落流水」页；要追「谁掉的」看「怪物掉落」页。
 *
 * 两个不做的事，都是刻意的：
 * - **不做本地倒计时**：剩余秒数用最近一次拉取的 `remainMs`，随 3 秒轮询刷新。自己跑
 *   一个 `setInterval` 每秒减一会与本机的时钟/休眠打架，反而让「还剩 0 秒但还在」变成常态。
 * - **不自己判到期**：东西什么时候消失由服务端说了算（过期 / 被捡 / 被挤），页面只展示。
 *
 * ```
 * __UI_CAPTURE__（截图清单 —— 截图工具按 id 逐状态出图，供人眼审；纪律：显示效果不写断言）
 *   loading      初始加载：表格区域 Spinner
 *   empty        地上没有掉落：EmptyState 两句文案
 *   filled       有数据：四格概况 + 表格行（含剩余进度条与状态徽章）
 *   protected    有保护中的掉落：状态列出现「保护中」金色徽章
 *   filtered     按地图 / 物品 / 归属者筛选后的结果
 * ```
 */
export function DropMonitorPage() {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [query, setQuery] = useState<Draft>(EMPTY_DRAFT);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(PAGE_SIZE);
  const [data, setData] = useState<DropGroundPage | null>(null);
  const [summary, setSummary] = useState<DropGroundSummary | null>(null);
  const [loading, setLoading] = useState(true);
  /** 上一次拉取成功时刻（本地时钟）：只用来在轮询间隙里把 `remainMs` 往回拨，不做倒计时 */
  const fetchedAtRef = useRef<number>(0);

  const load = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!options?.silent) setLoading(true);
      try {
        const params = {
          mapId: query.mapId || undefined,
          keyword: query.keyword || undefined,
          ownerName: query.ownerName || undefined,
        };
        const [listResult, summaryResult] = await Promise.all([
          dropApi.groundList({ ...params, page, size }),
          dropApi.groundSummary(params),
        ]);
        setData(listResult);
        setSummary(summaryResult);
        fetchedAtRef.current = Date.now();
      } catch {
        /* 错误已由请求层统一提示 */
      } finally {
        setLoading(false);
      }
    },
    [page, size, query],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // 3 秒轮询：切到后台就跳过这一拍（回来时立刻补一次，不留空窗）
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.hidden) return;
      void load({ silent: true });
    }, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void load({ silent: true });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const rows = data?.list ?? [];
  /**
   * 单图水位：取「占用率最高」的那张图，页面据此提示哪张图快满了
   *
   * `cap` 为 `null`（读不到配置）或 0 的图直接跳过 —— 没有上限就没有水位，
   * 拿 0 当分母会算出 Infinity，页面就会显示「1 / 0」。
   */
  const busiest = (summary?.byMap ?? []).reduce<{ mapId: string; total: number; cap: number } | null>(
    (worst, item) => {
      if (item.cap === null || item.cap <= 0) return worst;
      const hit = { mapId: item.mapId, total: item.total, cap: item.cap };
      if (!worst) return hit;
      return hit.total / hit.cap > worst.total / worst.cap ? hit : worst;
    },
    null,
  );

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4">
      <PageHeader
        title="掉落监控"
        description="当前区地面上还没被捡走的东西（最多差一拍：实时进程 100ms 批量写一次投影）"
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="当前地面" value={summary?.total ?? 0} hint="件" plain />
        <StatCard label="保护中" value={summary?.protectedTotal ?? 0} hint="只有归属者与队友能捡" />
        <StatCard
          label="即将过期"
          value={summary?.expiringTotal ?? 0}
          hint={summary ? `${Math.round(summary.expiringWindowMs / 1000)} 秒内消失` : ""}
        />
        <StatCard
          label="最高单图水位"
          value={
            busiest
              ? `${busiest.total} / ${busiest.cap}`
              : summary && summary.capPerMap === null
                ? "上限未知"
                : "—"
          }
          hint={busiest ? mapText(busiest.mapId) : "按图分组后没有占用"}
          plain
        />
      </div>

      <FilterBar
        onSearch={() => {
          setQuery(draft);
          setPage(1);
        }}
        onReset={() => {
          setDraft(EMPTY_DRAFT);
          setQuery(EMPTY_DRAFT);
          setPage(1);
        }}
        loading={loading}
      >
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
        <Field label="物品 id" width="w-56">
          <Input
            value={draft.keyword}
            onChange={(event) => setDraft({ ...draft, keyword: event.target.value })}
            placeholder="模糊匹配，如 drug_hp"
          />
        </Field>
        <Field label="归属者" width="w-48">
          <Input
            value={draft.ownerName}
            onChange={(event) => setDraft({ ...draft, ownerName: event.target.value })}
            placeholder="角色名"
          />
        </Field>
      </FilterBar>

      <Card
        title="地面掉落"
        actions={loading ? <Spinner /> : null}
        description={`默认按过期时刻升序：最先消失的排在最上面。每 ${POLL_MS / 1000} 秒自动刷新，页面切到后台就暂停。`}
      >
        {loading && data === null ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="现在地上没有掉落物"
            description="掉落只在玩家击杀时产生；捡走、过期、被挤掉都会立刻从这张表消失（并进「掉落流水」留一行终态）"
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className={tableClass}>
                <thead className={theadClass}>
                  <tr>
                    <th className={thClass}>物品</th>
                    <th className={thClass}>数量</th>
                    <th className={thClass}>归属者</th>
                    <th className={thClass}>来源怪物</th>
                    <th className={thClass}>落点</th>
                    <th className={thClass}>剩余</th>
                    <th className={thClass}>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.dropId} className="transition hover:bg-surface-4/30">
                      <td className={`${tdClass} font-medium text-ink-1`}>
                        {itemText(row.goodId)}
                        <span className="ml-2 font-mono text-[11px] text-ink-5">{row.goodId}</span>
                      </td>
                      <td className={`${tdClass} legend-num`}>{row.count}</td>
                      <td className={tdClass}>{row.ownerName || "—"}</td>
                      <td className={tdClass}>{monsterInfo(row.monsterKey)?.label ?? row.monsterLabel ?? row.monsterKey}</td>
                      <td className={`${tdClass} legend-num text-ink-4`}>
                        {Math.round(row.x)}, {Math.round(row.y)}
                        <span className="ml-2 text-ink-5">{mapText(row.mapId)}</span>
                      </td>
                      <td className={tdClass}>
                        <RemainBar row={row} fetchedAt={fetchedAtRef.current} />
                      </td>
                      <td className={tdClass}>
                        {row.protecting ? <Badge tone="gold">保护中</Badge> : <Badge tone="jade">可拾取</Badge>}
                      </td>
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
    </div>
  );
}

/**
 * 剩余时间：一条细进度条 + 秒数
 *
 * 宽度 = 剩余 / 总存活时长（分母是服务端给的 `totalMs`，**不写死 180 秒** —— 那是配置值，
 * 改一次运行参数就会漂）。超过一半给金色、不到 1/5 给警告色，扫一眼就知道该去看哪几行。
 */
function RemainBar({ row, fetchedAt }: { row: DropGround; fetchedAt: number }) {
  // 轮询间隙里按本地流逝时间往回拨（3 秒误差内），只影响观感，不影响服务端的到期判定
  const elapsed = fetchedAt > 0 ? Date.now() - fetchedAt : 0;
  const remainMs = Math.max(0, row.remainMs - elapsed);
  const ratio = Math.min(1, Math.max(0, remainMs / Math.max(1, row.totalMs)));
  const seconds = Math.ceil(remainMs / 1000);
  const tone = ratio > 0.5 ? "bg-jade" : ratio > 0.2 ? "bg-gold" : "bg-warn";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-sm bg-ink-5/20">
        <div className={`h-full rounded-sm ${tone}`} style={{ width: `${Math.round(ratio * 100)}%` }} />
      </div>
      <span className="legend-num w-10 text-right text-[11px] text-ink-4">{seconds}s</span>
    </div>
  );
}
