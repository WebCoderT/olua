import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { accountsApi, auditActionLabel, auditTargetLabel, formatTimeFull, OCCUPATION_LABELS, SEX_LABELS, statsApi } from "../api";
import type { AdminStats, StatsBreakdown, StatsRecentItem, StatsTrend } from "../api";
import { BarList, LineChart, SERIES_COLORS } from "../components/charts";
import { Badge, Button, Card, EmptyState, Spinner, StatCard } from "../components/ui";

/** 趋势可选天数（服务端上限 90，这里只放三档最常用的） */
const TREND_RANGES = [7, 14, 30];

/** 最近动态取几条 */
const RECENT_LIMIT = 8;

/** 等级档展示名（服务端给的 key 是区间起点，如 "1" → 1-10 级） */
function levelLabel(key: string): string {
  const from = Number(key);
  return Number.isFinite(from) ? `${from}-${from + 9} 级` : key;
}

/**
 * 地图展示名
 *
 * 只显示编号：地图名的权威定义在客户端 `configs/map`，服务端刻意不复制一份
 * （复制了就会两边漂移），所以界面这里也只能给通用格式。
 */
function mapLabel(key: string): string {
  return key === "" ? "未知" : `地图 ${key}`;
}

/** 概览：运营看板（总量 / 趋势 / 分布 / 最近动态） */
export function DashboardPage() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [trend, setTrend] = useState<StatsTrend | null>(null);
  const [breakdown, setBreakdown] = useState<StatsBreakdown | null>(null);
  const [recent, setRecent] = useState<StatsRecentItem[] | null>(null);
  const [days, setDays] = useState(TREND_RANGES[0]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // 四个请求一起发：看板是一屏整体刷新，串行会让空白期变成四倍
      const [nextStats, nextTrend, nextBreakdown, nextRecent] = await Promise.all([
        accountsApi.stats(),
        statsApi.trend({ days }),
        statsApi.breakdown(),
        statsApi.recent({ limit: RECENT_LIMIT }),
      ]);
      setStats(nextStats);
      setTrend(nextTrend);
      setBreakdown(nextBreakdown);
      setRecent(nextRecent);
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-50">概览</h1>
          <p className="mt-1 text-xs text-slate-500">
            数据实时来自服务端；封禁、改角色等操作在对应页面进行。
          </p>
        </div>
        <Button variant="outline" className="px-3 py-1 text-xs" loading={loading} onClick={() => void load()}>
          刷新
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="账号总数" value={stats?.accountCount ?? 0} />
        <StatCard label="角色总数" value={stats?.roleCount ?? 0} />
        <StatCard label="在线账号" value={stats?.onlineAccountCount ?? 0} hint="已选中在线角色" />
        <StatCard label="封禁中" value={stats?.bannedAccountCount ?? 0} hint="含永久与未到期的临时封禁" />
        <StatCard label="今日新增账号" value={stats?.todayNewAccountCount ?? 0} />
        <StatCard label="今日新增角色" value={stats?.todayNewRoleCount ?? 0} />
        <StatCard label="管理员" value={stats?.adminCount ?? 0} />
      </div>

      <Card
        title="增长趋势"
        description={trend ? `近 ${trend.days} 天：新增账号 ${trend.totalNewAccounts} · 新增角色 ${trend.totalNewRoles}` : undefined}
        actions={
          <div className="flex gap-1">
            {TREND_RANGES.map((range) => (
              <Button
                key={range}
                variant={range === days ? "primary" : "outline"}
                className="px-2.5 py-1 text-xs"
                onClick={() => setDays(range)}
              >
                {range} 天
              </Button>
            ))}
          </div>
        }
      >
        {trend ? (
          <LineChart
            labels={trend.points.map((point) => point.day.slice(5))}
            series={[
              { name: "新增账号", color: SERIES_COLORS.accounts, values: trend.points.map((point) => point.newAccounts) },
              { name: "新增角色", color: SERIES_COLORS.roles, values: trend.points.map((point) => point.newRoles) },
            ]}
          />
        ) : (
          <div className="flex items-center gap-2 py-6 text-sm text-slate-400">
            <Spinner /> 加载中…
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="等级分布" description="每 10 级一档">
          <BarList items={(breakdown?.levels ?? []).map((item) => ({ label: levelLabel(item.key), value: item.count }))} />
        </Card>
        <Card title="职业分布" description="职业名取自客户端配置">
          <BarList
            tone="emerald"
            items={(breakdown?.occupations ?? []).map((item) => ({ label: OCCUPATION_LABELS[item.key] ?? `职业 ${item.key}`, value: item.count }))}
          />
        </Card>
        <Card title="性别分布">
          <BarList items={(breakdown?.sexes ?? []).map((item) => ({ label: SEX_LABELS[item.key] ?? `性别 ${item.key}`, value: item.count }))} />
        </Card>
        <Card title="所在地图" description="地图名以客户端 configs/map 为准，这里只显示编号">
          <BarList tone="amber" items={(breakdown?.maps ?? []).map((item) => ({ label: mapLabel(item.key), value: item.count }))} />
        </Card>
      </div>

      <Card
        title="最近动态"
        description="最近的写操作（与「操作日志」同一张表）"
        actions={
          <Link to="/audit-logs" className="text-xs text-indigo-300 transition hover:text-indigo-200">
            查看全部 →
          </Link>
        }
      >
        {recent === null ? (
          <div className="flex items-center gap-2 py-6 text-sm text-slate-400">
            <Spinner /> 加载中…
          </div>
        ) : recent.length === 0 ? (
          <EmptyState title="还没有操作记录" description="管理员做过写操作后会出现在这里" />
        ) : (
          <ul className="flex flex-col divide-y divide-slate-800/60">
            {recent.map((item, index) => (
              <li key={`${item.createdAt}-${index}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-xs">
                <span className="w-36 shrink-0 tabular-nums text-slate-500">{formatTimeFull(item.createdAt)}</span>
                <span className="text-slate-300">{item.actorName ?? "系统"}</span>
                <span className="text-slate-400">{auditActionLabel(item.action)}</span>
                {item.targetType ? (
                  <span className="text-slate-500">
                    {auditTargetLabel(item.targetType)} {item.targetId?.slice(0, 8) ?? ""}
                  </span>
                ) : null}
                {item.success ? null : <Badge tone="red">失败</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
