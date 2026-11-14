import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { accountsApi, auditActionLabel, auditTargetLabel, formatTimeFull, OCCUPATION_LABELS, SEX_LABELS, statsApi } from "../api";
import type { AdminStats, StatsBreakdown, StatsRecentItem, StatsTrend } from "../api";
import { BarList, DonutChart, LineChart, SERIES_COLORS } from "../components/charts";
import { Badge, Button, Card, EmptyState, Spinner, StatCard } from "../components/ui";
import { PageHeader } from "../components/PageHeader";

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

/** 加载占位（三处复用，保持同一行高，避免加载完成时页面跳一下） */
function LoadingRow() {
  return (
    <div className="flex items-center gap-2 py-10 text-xs text-ink-4">
      <Spinner /> 加载中…
    </div>
  );
}

/**
 * 概览：运营看板（总量 / 趋势 / 分布 / 最近动态）
 *
 * 版面按 legend 设计稿的 12 栅格：主指标一排四张（金色数字），趋势占 8 列、职业分布占 4 列，
 * 下面等级与地图对半、性别与动态 4/8 —— 视线从「总量」走到「今天的增量」，再到「谁在做什么」。
 * 这里只做布局与取值，卡片/图表/徽章全部来自组件层（页面不写颜色）。
 */
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

  const occupationItems = (breakdown?.occupations ?? []).map((item) => ({
    label: OCCUPATION_LABELS[item.key] ?? `职业 ${item.key}`,
    value: item.count,
  }));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="概览"
        description="数据实时来自服务端；封禁、改角色等操作在对应页面进行。"
        actions={
          <Button variant="outline" loading={loading} onClick={() => void load()}>
            刷新
          </Button>
        }
      />

      {/* 主指标：金色数字只给「总量与风险」四个，其余走下面的次级条 */}
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="账号总数" value={stats?.accountCount ?? 0} hint={`今日新增 ${stats?.todayNewAccountCount ?? 0}`} />
        <StatCard label="角色总数" value={stats?.roleCount ?? 0} hint={`今日新增 ${stats?.todayNewRoleCount ?? 0}`} />
        <StatCard label="在线账号" value={stats?.onlineAccountCount ?? 0} hint="已选中在线角色" />
        <StatCard label="封禁中" value={stats?.bannedAccountCount ?? 0} hint="含永久与未到期临时封禁" />
      </div>

      <div className="grid grid-cols-12 gap-3.5">
        <div className="col-span-12 xl:col-span-8">
          <Card
            title="增长趋势"
            description={trend ? `近 ${trend.days} 天：新增账号 ${trend.totalNewAccounts} · 新增角色 ${trend.totalNewRoles}` : undefined}
            actions={
              <div className="inline-flex overflow-hidden rounded-sm border border-line">
                {TREND_RANGES.map((range, index) => (
                  <button
                    key={range}
                    type="button"
                    onClick={() => setDays(range)}
                    className={`legend-num px-2.5 py-1 text-[11px] transition-colors ${
                      index > 0 ? "border-l border-line" : ""
                    } ${
                      range === days
                        ? "bg-gradient-to-b from-gold-hi to-gold font-semibold text-surface-0"
                        : "text-ink-4 hover:bg-gold-veil hover:text-ink-2"
                    }`}
                  >
                    {range} 天
                  </button>
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
              <LoadingRow />
            )}
          </Card>
        </div>

        <div className="col-span-12 xl:col-span-4">
          <Card title="职业分布" description="职业名取自客户端配置">
            {occupationItems.length > 0 ? (
              <DonutChart items={occupationItems} centerLabel="角色" />
            ) : (
              <p className="py-10 text-center text-[11.5px] text-ink-5">暂无数据</p>
            )}
          </Card>
        </div>

        <div className="col-span-12 lg:col-span-6">
          <Card title="等级分布" description="每 10 级一档">
            <BarList items={(breakdown?.levels ?? []).map((item) => ({ label: levelLabel(item.key), value: item.count }))} />
          </Card>
        </div>

        <div className="col-span-12 lg:col-span-6">
          <Card title="所在地图" description="地图名以客户端 configs/map 为准，这里只显示编号">
            <BarList
              tone="amber"
              items={(breakdown?.maps ?? []).map((item) => ({ label: mapLabel(item.key), value: item.count }))}
            />
          </Card>
        </div>

        <div className="col-span-12 lg:col-span-4">
          <Card title="性别分布">
            <BarList
              tone="emerald"
              items={(breakdown?.sexes ?? []).map((item) => ({ label: SEX_LABELS[item.key] ?? `性别 ${item.key}`, value: item.count }))}
            />
          </Card>
        </div>

        <div className="col-span-12 lg:col-span-8">
          <Card
            title="最近动态"
            description="最近的写操作（与「操作日志」同一张表）"
            actions={
              <Link to="/audit-logs" className="font-mono text-[10.5px] tracking-[.08em] text-gold transition-colors hover:text-gold-hi">
                查看全部 →
              </Link>
            }
          >
            {recent === null ? (
              <LoadingRow />
            ) : recent.length === 0 ? (
              <EmptyState title="还没有操作记录" description="管理员做过写操作后会出现在这里" />
            ) : (
              <ul className="flex flex-col">
                {recent.map((item, index) => (
                  <li
                    key={`${item.createdAt}-${index}`}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line/50 py-2 text-xs last:border-0"
                  >
                    <span className="h-1 w-1 shrink-0 rounded-full bg-gold-dim" aria-hidden="true" />
                    <span className="legend-num w-32 shrink-0 text-[11px] text-ink-5">{formatTimeFull(item.createdAt)}</span>
                    <span className="text-ink-2">{item.actorName ?? "系统"}</span>
                    <span className="text-ink-3">{auditActionLabel(item.action)}</span>
                    {item.targetType ? (
                      <span className="text-ink-4">
                        {auditTargetLabel(item.targetType)} <span className="legend-num">{item.targetId?.slice(0, 8) ?? ""}</span>
                      </span>
                    ) : null}
                    {item.success ? null : <Badge tone="red">失败</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
