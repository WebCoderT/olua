import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { configSnapshotApi, formatBytes, formatTime, formatTimeFull, PERMISSION, systemApi } from "../api";
import { ApiError } from "../api";
import type { SystemInfo } from "../api";
import { Badge, Button, Card, EmptyState, Notice, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";
import { PageHeader } from "../components/PageHeader";

/** 「标签 + 值」的一格（运行时信息用它排成网格，值可能很长所以允许折行） */
function InfoItem({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface-2/40 px-4 py-3">
      <p className="text-xs text-ink-5">{label}</p>
      <p className="mt-1 break-all text-sm text-ink-1">{value}</p>
    </div>
  );
}

/**
 * 配置快照的版本闸特征串（服务端 CLI 报错原文）
 *
 * 服务端导入失败时把 CLI 的中文报错透传回来；这里只认「文件比目标库旧」这一种
 * 业务分支（它值得一个「确认回退」入口），其余失败一律原样展示、不提供重试开关。
 */
const VERSION_GATE_MARK = "文件比目标库旧";

/**
 * 配置快照导入 / 导出（#1266）
 *
 * 导出 = 当前库全部配置表序列化成 config-sync.sql（内容与 `make config-export` 完全一致），
 * 下载留档；导入 = 上传一份 config-sync.sql 整表替换配置表（账号与存档不动），
 * 语义全部继承 `make config-import` 的同一份脚本：导入前自动留档、版本闸、逐字节读回校验。
 *
 * 导入是全服生效的大操作，交互上三道确认：
 * 1. 选文件后要点「开始导入」并过 `window.confirm`；
 * 2. 版本闸拒绝（文件比库旧）→ 显示原文报错，用户勾「确认回退」才会带 force 重试；
 * 3. 成功后 toast + 报告面板都提醒「重启服务端」—— 进程内存里的配置覆盖层不会自动刷新。
 */
function ConfigSnapshotCard() {
  const canImport = hasPermission(PERMISSION.SYSTEM_WRITE);
  const [exporting, setExporting] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = async () => {
    setExporting(true);
    try {
      const result = await systemApi.exportConfigSnapshot();
      const blob = new Blob([result.sql], { type: "application/sql" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `config-sync-v${result.version}-${new Date().toISOString().slice(0, 19).replaceAll(":", "")}.sql`;
      anchor.click();
      URL.revokeObjectURL(url);
      toastSuccess(`已导出：${result.tables} 张配置表 / ${result.rows} 行 / 第 ${result.version} 版`);
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setExporting(false);
    }
  };

  const runImport = async (rollback: boolean) => {
    if (!file) return;
    setImporting(true);
    setImportError(null);
    try {
      const result = await configSnapshotApi.importRaw(await file.text(), rollback);
      setReport(result.report);
      setFile(null);
      setConfirmRollback(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      toastSuccess("导入成功 —— 请尽快重启服务端，让内存里的配置与新库一致");
    } catch (error) {
      // silent 的自展示错误：版本闸拒绝要转成「确认回退」入口，不能只弹一次性 toast
      setImportError(error instanceof ApiError ? error.message : "导入失败，请稍后重试");
    } finally {
      setImporting(false);
    }
  };

  const handleImport = () => {
    if (!file) return;
    if (
      !window.confirm(
        `确认导入「${file.name}」？\n\n` +
          "将整表替换全部配置表（账号与角色存档不受影响），导入前的配置会自动留档。\n" +
          "导入成功后需要重启服务端才完全生效。",
      )
    ) {
      return;
    }
    void runImport(false);
  };

  return (
    <Card
      title="配置数据导入 / 导出"
      description="导出的文件与 make config-export 的产物完全一致（config-sync.sql）；导入整表替换全部配置表，导入前自动留档"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" loading={exporting} onClick={() => void handleExport()}>
          导出当前配置
        </Button>
        <span className="text-xs text-ink-5">
          下载 config-sync.sql 留档备份，或传到另一台机器批量替换
        </span>
      </div>

      <div className="mt-5 border-t border-line pt-5">
        {canImport ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <input
                ref={fileInputRef}
                type="file"
                accept=".sql,text/plain"
                className="hidden"
                onChange={(event) => {
                  setImportError(null);
                  setConfirmRollback(false);
                  setFile(event.target.files?.[0] ?? null);
                }}
              />
              <Button variant="outline" onClick={() => fileInputRef.current?.click()} disabled={importing}>
                选择 config-sync.sql…
              </Button>
              {file ? (
                <span className="text-xs text-ink-3">
                  {file.name}（{formatBytes(file.size)}）
                </span>
              ) : (
                <span className="text-xs text-ink-5">尚未选择文件</span>
              )}
              {file ? (
                <Button variant="primary" loading={importing} onClick={handleImport}>
                  开始导入
                </Button>
              ) : null}
            </div>

            <Notice tone="warn" title="导入会整表替换全部配置表">
              只动配置表：账号、角色存档、审计日志不受影响。导入成功后<strong>必须重启服务端</strong>
              （API 与实时两个进程），内存里已装载的配置才会与库一致。文件里的配置版本比库里旧时会被拒绝 ——
              确认要回退的话，界面上会给出「确认回退」入口。
            </Notice>

            {importError ? (
              <Notice tone="ember" title="导入失败">
                <p className="whitespace-pre-wrap">{importError}</p>
                {importError.includes(VERSION_GATE_MARK) ? (
                  <label className="mt-2 flex items-start gap-2 text-ink-2">
                    <input
                      type="checkbox"
                      checked={confirmRollback}
                      onChange={(event) => setConfirmRollback(event.target.checked)}
                    />
                    <span>我确认要回退：用这份旧文件覆盖当前全部配置（导入前会自动留档，配置版本号只升不降）</span>
                  </label>
                ) : null}
                {importError.includes(VERSION_GATE_MARK) && confirmRollback ? (
                  <div className="mt-2">
                    <Button variant="primary" loading={importing} onClick={() => void runImport(true)}>
                      确认回退并导入
                    </Button>
                  </div>
                ) : null}
              </Notice>
            ) : null}

            {report ? (
              <details className="rounded-xl border border-line bg-surface-2/40 px-4 py-3">
                <summary className="cursor-pointer text-xs font-medium text-ink-2">
                  上一次导入的报告（来自导入脚本，含留档路径）
                </summary>
                <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-ink-3">{report}</pre>
              </details>
            ) : null}
          </div>
        ) : (
          <Notice tone="muted">
            导入需要「导入配置快照」权限（system:write，管理员 / 超级管理员持有）。当前账号只能导出备份。
          </Notice>
        )}
      </div>
    </Card>
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
      <div className="flex items-center gap-2 text-sm text-ink-4">
        <Spinner /> 正在读取系统信息…
      </div>
    );
  }

  if (!info) {
    return <EmptyState title="读取失败" description="没能拿到系统信息，可点「刷新」重试。" />;
  }

  const { runtime, database, config, backup } = info;
  // 需要运维注意的项（如仍是内置 JWT 密钥、CORS 全开）—— 全放在页面最上面，不用往下翻
  const warnings = config.filter((item) => item.warning);
  const tableRows = database.tables.reduce((sum, item) => sum + item.rows, 0);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="系统信息"
        description={<>采集于 {formatTimeFull(info.time)} · 只读页面，每次打开实时读一次</>}
        actions={<>
          <Button variant="outline" loading={loading} onClick={() => void load(true)}>
            刷新
          </Button>
        </>}
      />

      {warnings.length > 0 ? (
        <div className="rounded-2xl border border-warn/40 bg-warn/10 px-5 py-4">
          <p className="text-sm font-medium text-warn-hi">
            有 {warnings.length} 项配置需要运维注意
          </p>
          <p className="mt-1 break-all text-xs text-warn-hi/80">
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
                  <td className={`${tdClass} font-mono text-ink-2`}>{item.table}</td>
                  <td className={tdClass}>{item.rows}</td>
                </tr>
              ))}
              {database.tables.length > 0 ? (
                <tr>
                  <td className={`${tdClass} font-medium text-ink-4`}>合计（{database.tables.length} 张表）</td>
                  <td className={`${tdClass} font-medium text-ink-2`}>{tableRows}</td>
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
        title="自动备份"
        description="服务端按 BACKUP_INTERVAL_HOURS 自己跑 VACUUM INTO；失败也会留在这里（失败 ≠ 没显示），不用登机器就能看出它有没有在跑、上一次跑成没跑成"
      >
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {backup.enabled ? (
            <Badge tone="jade">已启用</Badge>
          ) : (
            <Badge tone="muted">未启用</Badge>
          )}
          {backup.enabled ? (
            <span className="text-xs text-ink-5">
              {backup.intervalText}
              {" · 保留 "}
              {backup.keepCount > 0 ? `${backup.keepCount} 份` : "不限份数"}
              {backup.retentionDays > 0 ? ` / ${backup.retentionDays} 天` : ""}
            </span>
          ) : (
            <span className="text-xs text-ink-5">{backup.reason}</span>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <InfoItem label="备份目录" value={backup.dir ?? "—"} />
          <InfoItem label="目录里备份" value={`${backup.count} 份`} />
          <InfoItem label="下次备份" value={formatTime(backup.nextAt)} />
          <InfoItem label="上次尝试" value={formatTime(backup.lastAttemptAt)} />
          <InfoItem label="上次成功" value={formatTime(backup.lastSuccessAt)} />
          <InfoItem
            label="最近一次结果"
            value={
              backup.lastOk === null ? (
                "还没跑过"
              ) : backup.lastOk ? (
                <Badge tone="jade">成功</Badge>
              ) : (
                <Badge tone="ember">失败</Badge>
              )
            }
          />
          <InfoItem label="最近产出文件" value={backup.lastFile ?? "—"} />
          <InfoItem label="产出体积" value={formatBytes(backup.lastSizeBytes)} />
          <InfoItem label="耗时" value={backup.lastDurationMs === null ? "—" : `${backup.lastDurationMs} ms`} />
        </div>

        {backup.lastOk === false ? (
          <div className="mt-4 rounded-xl border border-ember/50 bg-ember/10 px-4 py-3 text-xs text-ember-hi">
            上次备份失败：{backup.lastError}
          </div>
        ) : null}
      </Card>

      <ConfigSnapshotCard />

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
                  <td className={`${tdClass} font-mono text-ink-2`}>{item.key}</td>
                  <td className={tdClass}>{item.value}</td>
                  <td className={tdClass}>
                    <div className="flex gap-1.5">
                      {item.warning ? <Badge tone="warn">需注意</Badge> : null}
                      {item.sensitive ? <Badge tone="muted">脱敏</Badge> : null}
                      {!item.warning && !item.sensitive ? <span className="text-ink-6">—</span> : null}
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
