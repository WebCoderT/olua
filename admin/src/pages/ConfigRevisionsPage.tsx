import { useCallback, useEffect, useState } from "react";
import { configApi, formatBytes, formatTime, formatTimeFull, PERMISSION } from "../api";
import type { ConfigRevision, ConfigRevisionDiff } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { PageHeader } from "../components/PageHeader";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Notice,
  Select,
  Spinner,
  tableClass,
  tdClass,
  thClass,
  theadClass,
} from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/**
 * 配置版本（#882 / J2）
 *
 * 运营改一次配置（任意带 `gameConfig:write` 的写接口成功）→ 服务端 +1 版本，并把**当时
 * 全量 38 张配置表**存成一层历史。这一页就是那串历史的读口：看改了什么、差在哪、退回去。
 *
 * ## 为什么是「全量层」而不是「改了什么」
 * 配置表之间有外键（装备 → 部位、掉落 → 怪物），只存 diff 的话回滚要做到「按逆序撤销
 * 半年的增删改」，任何一条对不上就卡在半途。全量层的代价只是磁盘（一层几百 KB~几 MB，
 * 保留 20 层），换来的是回滚 = 一次 `DELETE` + `INSERT`，一个事务里做完。
 *
 * ## 页面上三个动作的边界
 * - **看差异**：`GET .../diff/{from}/{to}`，只到**行级**（哪张表多了几行、少了几行）——
 *   值改一行会显示成「一删一加」，所以这里是「这张表动过」，不是字段级 diff；
 * - **回滚**：`POST .../revisions/:v/restore`，**全服**覆盖成那一版的内容；
 * - **刷新**：版本号与列表都用同一个 `config_version` 计数，刷新拿到的一定是同一次快照。
 *
 * ## 两处刻意的「不给」
 * - **不给「删某一层」**：删掉中间层会让「相邻两版」的语义断掉（差分会跨过被删的那层），
 *   而且它本来就会被 20 层滚动淘汰；
 * - **不给「回滚到出厂」**：出厂内容在 `server/data/config-sync.sql`，那条路是
 *   `make config-import`（会写库、要人盯），不该是一个按钮。
 */
export function ConfigRevisionsPage() {
  const canRead = hasPermission(PERMISSION.CONFIG_READ);
  const canRestore = hasPermission(PERMISSION.CONFIG_RESTORE);

  const [version, setVersion] = useState<number | null>(null);
  const [list, setList] = useState<ConfigRevision[]>([]);
  const [loading, setLoading] = useState(true);

  const [diffFrom, setDiffFrom] = useState("");
  const [diffTo, setDiffTo] = useState("");
  const [diff, setDiff] = useState<ConfigRevisionDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  const [restoreTarget, setRestoreTarget] = useState<ConfigRevision | null>(null);
  const [restoring, setRestoring] = useState(false);

  const load = useCallback(async (notify = false) => {
    setLoading(true);
    try {
      const [current, revisions] = await Promise.all([configApi.version(), configApi.revisions({ limit: 20 })]);
      setVersion(current.version);
      setList(revisions.list);
      // 默认比「最近两层」：运营打开这页八成是想知道「我刚才那一改动了什么」
      if (revisions.list.length >= 2) {
        setDiffTo((prev) => prev || String(revisions.list[0].version));
        setDiffFrom((prev) => prev || String(revisions.list[1].version));
      }
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

  const compare = async (from = diffFrom, to = diffTo) => {
    if (!from || !to) return;
    if (from === to) {
      setDiff(null);
      return;
    }
    setDiffLoading(true);
    try {
      setDiff(await configApi.diff(from, to));
    } catch {
      setDiff(null);
    } finally {
      setDiffLoading(false);
    }
  };

  /** 行内「看差异」：固定拿它和**列表里下一条**（更早那层）比 */
  const compareWithPrevious = (index: number) => {
    const older = list[index + 1];
    if (!older) return;
    setDiffFrom(String(older.version));
    setDiffTo(String(list[index].version));
    void compare(String(older.version), String(list[index].version));
  };

  const restore = async () => {
    if (!restoreTarget) return;
    setRestoring(true);
    try {
      const result = await configApi.restore(String(restoreTarget.version));
      const skipped = result.skipped.length > 0 ? `，跳过 ${result.skipped.length} 张库中不存在的表` : "";
      toastSuccess(`已回滚到第 ${result.restoredFrom} 版：恢复 ${result.tables} 张表 / ${result.rows} 行${skipped}`);
      setRestoreTarget(null);
      setDiff(null);
      // 清掉对比选择，让 load() 重新默认成「最新两层」（回滚后版本号整体前移了）
      setDiffFrom("");
      setDiffTo("");
      await load();
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setRestoring(false);
    }
  };

  if (!canRead) {
    return <EmptyState title="没有访问权限" description="当前管理员角色无法查看配置版本历史，请联系超级管理员。" />;
  }

  if (loading && version === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-4">
        <Spinner /> 正在读取配置版本…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="配置版本"
        description={
          <>
            当前第 <span className="text-ink-3">{version ?? "—"}</span> 版 ·
            每次「改配置」的写接口成功后 +1，并留一层全量快照（滚动保留 20 层）
          </>
        }
        actions={
          <Button variant="outline" loading={loading} onClick={() => void load(true)}>
            刷新
          </Button>
        }
      />

      <Notice tone="muted">
        「改动」列是那次写操作的接口名（如 <code>adminSkill.update</code>），与操作日志里的
        「动作」同一个字符串 —— 想知道谁在什么时候改的，去操作日志按它筛。
        同一人 10 秒内的连点会合并成一层（避免拖一次数值刷出十层历史）。
      </Notice>

      <Card
        title="版本历史"
        description={`${list.length} 层 · 越靠上越新`}
        actions={
          <>
            <Select value={diffFrom} onChange={(event) => setDiffFrom(event.target.value)} className="w-28">
              <option value="">起始版</option>
              {list.map((item) => (
                <option key={item.version} value={item.version}>
                  v{item.version}
                </option>
              ))}
            </Select>
            <Select value={diffTo} onChange={(event) => setDiffTo(event.target.value)} className="w-28">
              <option value="">目标版</option>
              {list.map((item) => (
                <option key={item.version} value={item.version}>
                  v{item.version}
                </option>
              ))}
            </Select>
            <Button
              variant="outline"
              loading={diffLoading}
              disabled={!diffFrom || !diffTo || diffFrom === diffTo}
              onClick={() => void compare()}
            >
              看差异
            </Button>
          </>
        }
      >
        {list.length === 0 ? (
          <EmptyState
            title="还没有任何版本"
            description="改一次配置（任意配置页保存一次）就会出现第一层历史。"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead className={theadClass}>
                <tr>
                  <th className={thClass}>版本</th>
                  <th className={thClass}>改动</th>
                  <th className={thClass}>操作人</th>
                  <th className={thClass}>时间</th>
                  <th className={thClass}>体积</th>
                  <th className={thClass}>表 / 行</th>
                  <th className={thClass}>操作</th>
                </tr>
              </thead>
              <tbody>
                {list.map((item, index) => {
                  const isCurrent = item.version === version;
                  return (
                    <tr key={item.version}>
                      <td className={tdClass}>
                        <span className="font-medium text-ink-1">v{item.version}</span>
                        {isCurrent ? (
                          <span className="ml-1">
                            <Badge tone="jade">当前</Badge>
                          </span>
                        ) : null}
                      </td>
                      <td className={tdClass}>
                        <code className="rounded bg-surface-4/70 px-1.5 py-0.5 text-xs text-ink-3">
                          {item.label || "—"}
                        </code>
                      </td>
                      <td className={tdClass}>{item.createdBy || "—"}</td>
                      <td className={tdClass} title={formatTimeFull(item.createdAt)}>
                        {formatTime(item.createdAt)}
                      </td>
                      <td className={tdClass}>{formatBytes(item.byteSize)}</td>
                      <td className={tdClass}>
                        {item.tableCount} / {item.rowCount}
                      </td>
                      <td className={tdClass}>
                        <div className="flex items-center gap-1.5">
                          <Button
                            variant="ghost"
                            disabled={index === list.length - 1}
                            title={index === list.length - 1 ? "这是最早的一层，没有更早的可比" : "与更早一层对比"}
                            onClick={() => compareWithPrevious(index)}
                          >
                            看差异
                          </Button>
                          {canRestore ? (
                            <Button
                              variant="ghost"
                              disabled={isCurrent}
                              title={isCurrent ? "已经是当前版本" : "把全服配置覆盖成这一版的内容"}
                              onClick={() => setRestoreTarget(item)}
                            >
                              回滚
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {diff ? (
        <Card
          title={`v${diff.from} → v${diff.to}`}
          description={
            diff.changed === 0
              ? "这两层内容完全一样（可能只是那次写操作没实际改动数据）"
              : `${diff.changed} 张表有变化 · 行级口径：改一行会显示成「一删一加」`
          }
          actions={
            <Button variant="ghost" onClick={() => setDiff(null)}>
              收起
            </Button>
          }
        >
          {diff.tables.length === 0 ? (
            <EmptyState title="没有差异" />
          ) : (
            <div className="overflow-x-auto">
              <table className={tableClass}>
                <thead className={theadClass}>
                  <tr>
                    <th className={thClass}>表</th>
                    <th className={thClass}>旧行数</th>
                    <th className={thClass}>新行数</th>
                    <th className={thClass}>新增</th>
                    <th className={thClass}>删除</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.tables.map((row) => (
                    <tr key={row.table}>
                      <td className={tdClass}>
                        <code className="text-xs text-ink-3">{row.table}</code>
                      </td>
                      <td className={tdClass}>{row.from}</td>
                      <td className={tdClass}>{row.to}</td>
                      <td className={tdClass}>{row.added > 0 ? <Badge tone="jade">+{row.added}</Badge> : "—"}</td>
                      <td className={tdClass}>{row.removed > 0 ? <Badge tone="ember">−{row.removed}</Badge> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      <ConfirmDialog
        open={restoreTarget !== null}
        title={`回滚到第 ${restoreTarget?.version ?? "—"} 版？`}
        description={
          `会把全服配置（38 张表）整体覆盖成第 ${restoreTarget?.version} 版的内容 —— ` +
          `这一版之后的改动（包括别人的）都会被盖掉。` +
          `回滚本身也会生成新的一层（第 ${(version ?? 0) + 1} 版），历史不删，所以退错了还能再退回来。`
        }
        confirmText="确认回滚"
        loading={restoring}
        onConfirm={() => void restore()}
        onCancel={() => setRestoreTarget(null)}
      />
    </div>
  );
}
