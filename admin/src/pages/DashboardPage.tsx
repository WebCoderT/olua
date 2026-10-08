import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { accountsApi } from "../api";
import type { AdminStats } from "../api";
import { StatCard } from "../components/ui";

/** 概览：账号 / 角色总量与今日新增 */
export function DashboardPage() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    accountsApi
      .stats()
      .then((data) => {
        if (alive) setStats(data);
      })
      .catch(() => {
        /* 错误已由请求层统一提示 */
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-50">概览</h1>
        <p className="mt-1 text-xs text-slate-500">数据实时来自服务端；封禁、改角色等操作在对应页面进行。</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label="账号总数" value={loading ? "—" : (stats?.accountCount ?? 0)} />
        <StatCard label="角色总数" value={loading ? "—" : (stats?.roleCount ?? 0)} />
        <StatCard label="已选在线角色的账号" value={loading ? "—" : (stats?.onlineAccountCount ?? 0)} />
        <StatCard label="今日新增账号" value={loading ? "—" : (stats?.todayNewAccountCount ?? 0)} />
        <StatCard label="管理员数量" value={loading ? "—" : (stats?.adminCount ?? 0)} />
      </div>

      <div className="flex flex-wrap gap-3 text-sm">
        <Link to="/accounts" className="rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-3 text-slate-300 transition hover:border-slate-600 hover:text-slate-100">
          去账号管理 →
        </Link>
        <Link to="/roles" className="rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-3 text-slate-300 transition hover:border-slate-600 hover:text-slate-100">
          去角色管理 →
        </Link>
      </div>
    </div>
  );
}
