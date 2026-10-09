import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { formatBytes, formatTime, formatTimeFull, PERMISSION, systemApi } from "../api";
import type { SystemInfo } from "../api";
import { Badge, Button, Card, EmptyState, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/** 「标签 + 值」的一格（运行时信息用它排成网格，值可能很长所以允许折行） */
function InfoItem({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 break-all text-sm text-slate-100">{value}</p>
    </div>
  );
}

/**
 * 系统信息（运维自查）
 *
 * 只读一页：版本 / 运行时长 / 内存 / 数据文件体积与各表行数 / 脱敏配置快照。
 * 数据全部来自 `GET /admin/system` 一次请求 —— 这里**不做任何本地推导**（比如别自己算
 * 「还剩几天清理」），阈值口径只应该有一处。
 *
 * 配置快照是**白名单**：服务端没登记的配置项这一页根本看不到，密钥类只报「已配置 /
 * 仍是默认值」。所以这里有 `sensitive` 与 `warning` 两个标记要分别显示 ——
 * 「脱敏」是「值不是原文」，「需注意」是「运维该去改」。
 */
export function SystemPage() {
  const canRead = hasPermission(PERMISSION.SYSTEM_READ);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (notify = false) => {
    setLoading(true);
    try {
      const result = await systemApi.info();
      setInfo(result);
      if (notify) toastSuccess("已刷新");
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canRead) return;
    void load();
  }, [canRead, load]);

  if (!canRead) {
    return <EmptyState title="没有访问权限" description="当前管理员角色无法查看系统信息，请联系超级管理员。" />;
  }

  if (loading && !info) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-400">
        <Spinner /> 正在读取系统信息…
      </div>
    );
  }

  if (!info) {
    return <EmptyState title="读取失败" description="没能拿到系统信息，可点「刷新」重试。" />;
  }

  const { runtime, database, config } = info;
  // 需要运维注意的项（如仍是内置 JWT 密钥、CORS 全开）—— 全放在页面最上面，不用往下翻
  const warnings = config.filter((item) => item.warning);
  const tableRows = database.tables.reduce((sum, item) => sum + item.rows, 0);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">系统信息</h1>
          <p className="mt-1 text-xs text-slate-500">
            采集于 {formatTimeFull(info.time)} · 只读页面，每次打开实时读一次
          </p>
        </div>
        <Button variant="outline" loading={loading} onClick={() => void load(true)}>
          刷新
        </Button>
      </div>

      {warnings.length > 0 ? (
        <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 px-5 py-4">
          <p className="text-sm font-medium text-amber-200">
            有 {warnings.length} 项配置需要运维注意
          </p>
          <p className="mt-1 break-all text-xs text-amber-200/80">
            {warnings.map((item) => item.key).join("、")} —— 详见下方「配置快照」
          </p>
        </div>
      ) : null}

      <Card
        title="运行时"
        description="进程自报的版本、时长与内存；平台信息来自 Node 的 os 模块"
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <InfoItem label="服务端版本" value={runtime.version} />
          <InfoItem label="运行环境（NODE_ENV）" value={runtime.env} />
          <InfoItem label="已运行" value={runtime.uptimeText} />
          <InfoItem label="启动时刻" value={formatTime(runtime.startedAt)} />
          <InfoItem label="Node 版本" value={runtime.nodeVersion} />
          <InfoItem label="进程 id" value={String(runtime.pid)} />
          <InfoItem label="操作系统" value={`${runtime.platform} ${runtime.platformRelease}`} />
          <InfoItem label="CPU 架构" value={runtime.arch} />
          <InfoItem label="常驻内存" value={formatBytes(runtime.memoryRssBytes)} />
          <InfoItem label="堆已用" value={formatBytes(runtime.memoryHeapUsedBytes)} />
        </div>
      </Card>

      <Card
        title="数据库"
        description="SQLite 单文件；表清单由服务端动态枚举，加表后这一页会自动多一行"
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <InfoItem
            label="数据文件"
            value={database.path === ":memory:" ? "内存库（无文件，重启即清空）" : database.path}
          />
          <InfoItem label="文件体积" value={formatBytes(database.sizeBytes)} />
          <InfoItem label="最后写入" value={formatTime(database.modifiedAt)} />
        </div>

        <div className="mt-5 overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>表</th>
                <th className={thClass}>行数</th>
              </tr>
            </thead>
            <tbody>
              {database.tables.map((item) => (
                <tr key={item.table}>
                  <td className={`${tdClass} font-mono text-slate-200`}>{item.table}</td>
                  <td className={tdClass}>{item.rows}</td>
                </tr>
              ))}
              {database.tables.length > 0 ? (
                <tr>
                  <td className={`${tdClass} font-medium text-slate-400`}>合计（{database.tables.length} 张表）</td>
                  <td className={`${tdClass} font-medium text-slate-200`}>{tableRows}</td>
                </tr>
              ) : (
                <tr>
                  <td className={tdClass} colSpan={2}>
                    还没建表
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="配置快照"
        description="白名单：只有服务端登记过的项会出现，将来新增的密钥默认不暴露；带「脱敏」的值不是原文"
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>配置项</th>
                <th className={thClass}>值</th>
                <th className={thClass}>标记</th>
              </tr>
            </thead>
            <tbody>
              {config.map((item) => (
                <tr key={item.key}>
                  <td className={`${tdClass} font-mono text-slate-200`}>{item.key}</td>
                  <td className={tdClass}>{item.value}</td>
                  <td className={tdClass}>
                    <div className="flex gap-1.5">
                      {item.warning ? <Badge tone="amber">需注意</Badge> : null}
                      {item.sensitive ? <Badge tone="slate">脱敏</Badge> : null}
                      {!item.warning && !item.sensitive ? <span className="text-slate-600">—</span> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
