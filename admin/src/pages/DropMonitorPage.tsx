import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  dropApi,
  formatTimeFull,
  itemIconOf,
  mapIds,
  mapText,
  monsterInfo,
  PERMISSION,
} from "../api";
import type { DropClearRequestView, DropClearResult, DropGround, DropGroundQuery, DropGroundSummary, PageResult } from "../api";
import { FilterBar } from "../components/FilterBar";
import { GameIcon } from "../components/GameImage";
import { Modal } from "../components/Modal";
import { Pagination } from "../components/Pagination";
import { PageHeader } from "../components/PageHeader";
import { Badge, Button, Card, EmptyState, Field, Input, Notice, Select, Spinner, StatCard, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/**
 * 掉落监控（当前地面）
 *
 * 回答的是「**现在地上有什么**」：读的是实时进程 100ms 批量刷新的投影表，所以看到的最多
 * 差一拍（约 1 秒）—— 页面措辞不承诺毫秒级精确，也不拿它做「是否已捡走」的判定（那是流水的事）。
 *
 * 3 秒轮询，**页面切到后台就停**（`document.hidden`）：这一页没人看的时候再刷只是白烧 CPU 和
 * 数据库。回到前台立刻补一次，免得盯着一张 10 分钟前的表。
 *
 * 「清空本图地面」是不可逆的写操作（会删掉玩家还没捡的东西），所以这里是**三重门槛**：
 * 先选一张具体的图 → 勾「我确认」→ 再手输这张图的 id。少一步按钮就是灰的。
 *
 * ```
 * __UI_CAPTURE__（截图清单 —— 截图工具按 id 逐状态出图，供人眼审；纪律：显示效果不写断言）
 *   loading      初始加载：Spinner 可见，概况卡为 0
 *   empty        这张图地上没有掉落物：EmptyState 文案完整
 *   filled       有数据：概况卡四格 + 表格行 + 剩余时间进度条
 *   clear-dialog 清空确认弹窗（勾选 + 输入地图 id 才可点）
 *   no-perm      只读账号：没有「清空」按钮
 * ```
 */

/** 轮询间隔：与地图监控页同频（3 秒）。掉落的生命周期以秒计，再快也看不出差别 */
const POLL_MS = 3_000;

/** 默认每页条数：这页是「扫一眼」的重表格，比配置页的 20 大 */
const PAGE_SIZE = 50;

const EMPTY_QUERY = { mapId: "", keyword: "", ownerName: "" };

type Draft = typeof EMPTY_QUERY;

export function DropMonitorPage() {
  const canRead = hasPermission(PERMISSION.DROP_READ);
  const canClear = hasPermission(PERMISSION.DROP_CLEAR);

  const [draft, setDraft] = useState<Draft>(EMPTY_QUERY);
  const [query, setQuery] = useState<Draft>(EMPTY_QUERY);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(PAGE_SIZE);
  const [data, setData] = useState<PageResult<DropGround> | null>(null);
  const [summary, setSummary] = useState<DropGroundSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [clearOpen, setClearOpen] = useState(false);

  const maps = useMemo(() => mapIds(), []);

  const queryParams = useCallback(
    (): DropGroundQuery => ({
      mapId: query.mapId || undefined,
      keyword: query.keyword || undefined,
      ownerName: query.ownerName || undefined,
    }),
    [query],
  );

  /** 列表 + 概况一起拉：两个数字不同源的话，「合计 8 件」和表格里的 6 行会打架 */
  const load = useCallback(
    async (quiet = false) => {
      if (!canRead) return;
      if (!quiet) setLoading(true);
      try {
        const [list, stats] = await Promise.all([
          dropApi.groundList({ ...queryParams(), page, size }),
          dropApi.groundSummary(queryParams()),
        ]);
        setData(list);
        setSummary(stats);
      } catch {
        /* 错误已由请求层统一提示 */
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [canRead, page, size, queryParams],
  );

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 3 秒轮询（页面隐藏时跳过）
   *
   * 用 `setInterval` 而不是递归 `setTimeout`：请求慢的时候会有几次重叠，但这一页的请求
   * 都是只读且很轻，重叠一次不会累积（下一次 interval 到了照样发）。递归写法在「一次请求
   * 卡死」时会让整页永远停在旧数据上，反而更糟。
   */
  useEffect(() => {
    if (!canRead) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void load(true);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [canRead, load]);

  /** 回到前台补一次：离开的那段时间可能刚好有东西掉下来 / 被捡走 */
  useEffect(() => {
    if (!canRead) return;
    const onVisible = () => {
      if (!document.hidden) void load(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [canRead, load]);

  const submitSearch = () => {
    setPage(1);
    setQuery({ ...draft });
  };

  const resetSearch = () => {
    setDraft(EMPTY_QUERY);
    setPage(1);
    setQuery(EMPTY_QUERY);
  };

  if (!canRead) {
    return (
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4">
        <PageHeader title="掉落监控" description="当前地面上的掉落物（实时）。" />
        <Notice tone="warn" title="没有权限">
          当前账号没有「查看掉落记录」（`drop:read`）权限。
        </Notice>
      </div>
    );
  }

  const rows = data?.list ?? [];

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4">
      <PageHeader
        title="掉落监控"
        description={
          <>
            当前地面上还没被捡走的东西（读实时进程 100ms 批量刷新的投影表，<strong className="text-ink-4">最多差一拍</strong>）。
            按过期时刻升序：最先消失的排在最上面。页面每 3 秒刷新，切到后台自动暂停。
          </>
        }
        actions={
          <>
            <Button variant="outline" onClick={() => void load()} loading={loading}>
              刷新
            </Button>
            {canClear ? (
              <Button variant="danger" onClick={() => setClearOpen(true)} disabled={!query.mapId}>
                清空本图地面
              </Button>
            ) : null}
          </>
        }
      />

      <FilterBar
        loading={loading}
        onSearch={submitSearch}
        onReset={resetSearch}
        hint={
          canClear && !query.mapId
            ? "「清空本图地面」要先在筛选里选一张具体的地图 —— 清空的永远是一张图，不是整个区。"
            : undefined
        }
      >
        <Field label="地图" width="w-52">
          <Select value={draft.mapId} onChange={(event) => setDraft({ ...draft, mapId: event.target.value })}>
            <option value="">全部地图</option>
            {maps.map((id) => (
              <option key={id} value={id}>
                {mapText(id)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="物品 id" width="w-52">
          <Input
            value={draft.keyword}
            placeholder="模糊匹配（如 drug_hp）"
            onChange={(event) => setDraft({ ...draft, keyword: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitSearch();
            }}
          />
        </Field>
        <Field label="归属者" width="w-44">
          <Input
            value={draft.ownerName}
            placeholder="角色名（模糊）"
            onChange={(event) => setDraft({ ...draft, ownerName: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitSearch();
            }}
          />
        </Field>
      </FilterBar>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="当前地面" value={summary?.total ?? 0} hint="这个区地上还没被捡走的件数" />
        <StatCard label="保护中" value={summary?.protectedTotal ?? 0} hint="保护期内只有归属者与队友能捡" plain />
        <StatCard
          label="即将过期"
          value={summary?.expiringTotal ?? 0}
          hint={`${Math.round((summary?.expiringWindowMs ?? 60_000) / 1000)} 秒内会消失`}
          plain
        />
        <StatCard
          label="单图上限"
          value={summary?.capPerMap ?? 0}
          hint={waterHint(summary)}
          plain
        />
      </div>

      <Card
        title="当前地面"
        actions={loading ? <Spinner /> : null}
        description={
          <>
            共 <span className="legend-num text-ink-2">{data?.total ?? 0}</span> 件（当前筛选）。
            服务端清空的执行状态也在这一页看：点完「清空本图地面」会显示进度。
          </>
        }
      >
        <ClearProgress clears={summary?.clears ?? []} />

        {loading && data === null ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="这里现在地上没有掉落物"
            description="掉落只在玩家击杀时产生；被捡走 / 过期 / 被挤掉之后就从这张表消失。"
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className={tableClass}>
                <thead className={theadClass}>
                  <tr>
                    <th className={thClass}>物品</th>
                    <th className={`${thClass} text-right`}>数量</th>
                    <th className={thClass}>归属者</th>
                    <th className={thClass}>来源怪物</th>
                    <th className={thClass}>地图 / 落点</th>
                    <th className="w-44">剩余</th>
                    <th className={thClass}>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <GroundRow key={row.dropId} row={row} />
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
        物品名与图标按**当前**配置查（配置改过以后，地上那件东西不会跟着变）；查不到就显示原 id。
        「绑定」是掉落那一刻的判定结果，之后改配置不影响已经掉出来的东西。
      </p>

      <ClearGroundDialog
        open={clearOpen}
        maps={maps}
        defaultMapId={query.mapId}
        onClose={() => setClearOpen(false)}
        onDone={() => void load(true)}
      />
    </div>
  );
}

/** 概况卡第四格的说明：把「最容易满的那张图」的水位说出来，比一个孤零零的上限有用 */
function waterHint(summary: DropGroundSummary | null): string {
  if (!summary || summary.byMap.length === 0) return "每张图最多留这么多件，超了挤掉最旧的";
  const fullest = summary.byMap.reduce((left, right) => (right.total > left.total ? right : left));
  return `${mapText(fullest.mapId)} 现在 ${fullest.total}/${fullest.cap}`;
}

/** 清空请求的执行进度（跨进程：点了不是立刻清完，要看这里） */
function ClearProgress({ clears }: { clears: DropClearRequestView[] }) {
  const latest = clears[0];
  if (!latest) return null;
  // 只关心「最近这一条」：连点两下会合并成同一个 id，所以列表最上面那条就是刚点的那次
  if (latest.doneAt === null) {
    const waited = Date.now() - latest.requestedAt;
    if (waited < 10_000) {
      return (
        <Notice tone="muted" title="清空请求已提交">
          正在等实时进程执行（{mapText(latest.mapId)}，已等 {Math.round(waited / 1000)} 秒）……
        </Notice>
      );
    }
    return (
      <Notice tone="warn" title="清空请求还没被执行">
        {mapText(latest.mapId)} 的请求提交了 {Math.round(waited / 1000)} 秒还没完成 —— 实时进程（3101）可能没起来。
        请求留在库里，那个进程下次起来会补做。
      </Notice>
    );
  }
  return (
    <Notice tone="jade" title="上一次清空已完成">
      {mapText(latest.mapId)} 清掉 <span className="legend-num">{latest.cleared}</span> 件（
      {formatTimeFull(latest.doneAt)}）。每件都在「掉落流水」里留了一条 `overflow / manual_clear`。
    </Notice>
  );
}

/** 一行地面掉落 */
function GroundRow({ row }: { row: DropGround }) {
  const total = Math.max(1, row.totalMs);
  const left = Math.max(0, Math.min(total, row.remainMs));
  const pct = Math.round((left / total) * 100);
  // 剩不到 1/4 才变色：一直金黄会让人分不清「刚掉的」和「快没了」
  const barTone = pct <= 25 ? "bg-ember" : "bg-gold";
  return (
    <tr className="transition hover:bg-surface-4/30">
      <td className={tdClass}>
        <span className="flex items-center gap-2">
          <GameIcon path={itemIconOf(row.goodId)} alt={row.goodLabel} size={28} zoomable={false} />
          <span className="flex flex-col">
            <span className="text-ink-1">{row.goodLabel}</span>
            <span className="font-mono text-xs text-ink-5">{row.goodId}</span>
          </span>
          {row.bound ? <Badge tone="warn">绑定</Badge> : null}
        </span>
      </td>
      <td className={`${tdClass} legend-num text-right text-ink-1`}>{row.count}</td>
      <td className={tdClass}>{row.ownerName || <span className="text-ink-5">—</span>}</td>
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
          <span className="text-ink-3">{mapText(row.mapId)}</span>
          <span className="font-mono text-xs text-ink-5">
            ({row.x}, {row.y})
          </span>
        </span>
      </td>
      <td className={tdClass}>
        <span className="flex flex-col gap-1">
          <span className="legend-num text-xs text-ink-3">
            {Math.ceil(left / 1000)}s / {Math.round(total / 1000)}s
          </span>
          <span className="h-1.5 w-full overflow-hidden rounded-sm bg-surface-4">
            <span className={`block h-full ${barTone}`} style={{ width: `${pct}%` }} />
          </span>
        </span>
      </td>
      <td className={tdClass}>
        {row.protecting ? <Badge tone="gold">保护中</Badge> : <Badge tone="jade">可拾</Badge>}
      </td>
    </tr>
  );
}

/**
 * 清空本图地面的确认弹窗
 *
 * 三重门槛（都要过，按钮才亮）：选了具体地图 → 勾「我确认这次不可逆」→ 手输这张图的 id。
 * 为什么还要手输：勾选框点一下就有了，**手输是唯一能让人看清「我清的是哪张图」的动作**；
 * 这一页的地图筛选可以停在「全部地图」，误点的代价是玩家包里的东西凭空消失。
 */
function ClearGroundDialog({
  open,
  maps,
  defaultMapId,
  onClose,
  onDone,
}: {
  open: boolean;
  maps: string[];
  defaultMapId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [mapId, setMapId] = useState(defaultMapId);
  const [confirmed, setConfirmed] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DropClearResult | null>(null);
  // 弹窗每次打开都从当前筛选重置：上一次留在里面的 mapId 会让人清错图
  const openedOnce = useRef(false);
  useEffect(() => {
    if (!open) {
      openedOnce.current = false;
      return;
    }
    if (openedOnce.current) return;
    openedOnce.current = true;
    setMapId(defaultMapId);
    setConfirmed(false);
    setTyped("");
    setResult(null);
  }, [open, defaultMapId]);

  const canSubmit = Boolean(mapId) && confirmed && typed.trim() === mapId && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const accepted = await dropApi.clear({ mapId, confirm: true });
      setResult(accepted);
      toastSuccess(
        accepted.merged
          ? `这张图已经有一个在排队的清空请求（#${accepted.requestId}），不重复提交`
          : `已受理（#${accepted.requestId}）：提交时地上约 ${accepted.groundTotal} 件`,
      );
      onDone();
    } catch {
      /* 错误已由请求层统一提示（服务端文案） */
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="清空本图地面"
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            关闭
          </Button>
          <Button variant="danger" onClick={() => void submit()} loading={busy} disabled={!canSubmit}>
            确认清空
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Notice tone="warn" title="这一步不可逆">
          这张图上玩家还没捡起来的东西会全部消失。每件都会在「掉落流水」里留一条
          <span className="font-mono"> overflow / manual_clear </span>
          记录，东西本身不会还回去。
        </Notice>

        <Field label="要清空的地图">
          <Select value={mapId} onChange={(event) => setMapId(event.target.value)}>
            <option value="">选一张图</option>
            {maps.map((id) => (
              <option key={id} value={id}>
                {mapText(id)}（{id}）
              </option>
            ))}
          </Select>
        </Field>

        <label className="flex items-start gap-2 text-xs text-ink-3">
          <input
            type="checkbox"
            className="mt-0.5 accent-gold"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <span>我确认要清空上面这张图的地面掉落，知道这个操作不可撤销。</span>
        </label>

        <Field label={`再输一次地图 id（${mapId || "先选地图"}）`}>
          <Input
            value={typed}
            placeholder={mapId || "地图 id"}
            disabled={!mapId}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
          />
        </Field>

        {result ? (
          <Notice tone="jade" title="请求已受理">
            请求 #{result.requestId}：提交时地上约 {result.groundTotal} 件。
            真正清掉多少要看实时进程回写的 `cleared`（页面顶部的进度条，最多等几秒）。
          </Notice>
        ) : null}
      </div>
    </Modal>
  );
}
