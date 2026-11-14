import { useCallback, useEffect, useMemo, useState } from "react";
import { formatTime, localInputToMs, msToLocalInput, PERMISSION, zonesApi } from "../api";
import type { AdminZone, MergePrecheck, MergeReport } from "../api";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Notice,
  Select,
  Spinner,
  tableClass,
  tdClass,
  thClass,
  theadClass,
} from "../components/ui";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";
import { PageHeader } from "../components/PageHeader";

/**
 * 区服运营（#314 / #295 阶段二 / #961）
 *
 * 页面四件事：**看清单**（含聚合列：账号 / 角色 / 在线 / 实例 / 帮会 / 待重载）、
 * **开新区**（名字 + 开服时间 + 排序 + 推荐 + 备注）、**改状态**（open ⇄ maintenance →
 * closed）、**合区向导**（先预检、再确认、出报告）。
 *
 * ## 状态机的三条硬规矩（`ZoneService.setStatus`）
 * - `closed` 是终点：关掉就不能再开回来 —— 所以「关闭」单独一个确认框，文案写明不可逆；
 * - 维护中的区**照常跑世界**，只是新人进不来；在线的人收到 60 秒倒计时后断开；
 * - 已合并的区不能再改状态（它是历史行）。
 *
 * ## 合并为什么分两步
 * 合并是**搬玩家数据**：一个事务里搬角色（同账号同名自动改名）、搬帮会、重排世界发牌、
 * 作废源区待执行重载、清监控与位置投影、只作废参与的两个区的世界内存。点下去就没有
 * 后悔药，所以先 `merge/precheck` 把「会动多少东西」摆出来，运营看过再点确认；
 * 完成后把 `MergeReport` 摊开（改名的角色逐个列出）—— 那是事后对账的唯一凭据。
 */
export function ZonesPage() {
  const canWrite = hasPermission(PERMISSION.ZONE_WRITE);
  const [zones, setZones] = useState<AdminZone[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // 开新区表单
  const [name, setName] = useState("");
  const [openedAt, setOpenedAt] = useState("");
  const [sort, setSort] = useState("0");
  const [recommended, setRecommended] = useState(false);
  const [note, setNote] = useState("");

  // 编辑运营字段
  const [editing, setEditing] = useState<AdminZone | null>(null);
  const [editSort, setEditSort] = useState("0");
  const [editOpenedAt, setEditOpenedAt] = useState("");
  const [editRecommended, setEditRecommended] = useState(false);
  const [editNote, setEditNote] = useState("");

  // 改状态
  const [statusTarget, setStatusTarget] = useState<AdminZone | null>(null);
  const [nextStatus, setNextStatus] = useState<"open" | "maintenance" | "closed">("open");
  const [statusReason, setStatusReason] = useState("");
  // 关闭不可逆：单独过一道确认
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);

  // 合区向导
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [precheck, setPrecheck] = useState<MergePrecheck | null>(null);
  const [prechecking, setPrechecking] = useState(false);
  const [mergeConfirmOpen, setMergeConfirmOpen] = useState(false);
  const [report, setReport] = useState<MergeReport | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setZones(await zonesApi.list());
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 活区 = 还没被合并的（开区 / 合并的下拉都只列它们） */
  const liveZones = useMemo(() => (zones ?? []).filter((zone) => zone.mergedInto === null), [zones]);
  /** 能参与合区的 = 活区且 open（维护中 / 已关闭的要先恢复，预检也会挡） */
  const mergeableZones = useMemo(() => liveZones.filter((zone) => zone.status === "open"), [liveZones]);

  const fromZone = liveZones.find((zone) => String(zone.id) === fromId) ?? null;
  const toZone = liveZones.find((zone) => String(zone.id) === toId) ?? null;
  const nameValid = name.trim().length >= 1 && name.trim().length <= 20;
  const mergePicked = fromZone !== null && toZone !== null && fromZone.id !== toZone.id;
  /** 区 id → 区名（已合并的区在列表里显示去哪了，没有这张表就只剩一个数字） */
  const zoneNameOf = (id: number) => zones?.find((zone) => zone.id === id)?.name ?? `区 ${id}`;

  /** 换源区 / 目标区就把上一轮的预检作废 —— 留着会让人以为「这一对已经验过了」 */
  const pickFrom = (value: string) => {
    setFromId(value);
    setPrecheck(null);
  };
  const pickTo = (value: string) => {
    setToId(value);
    setPrecheck(null);
  };

  const submitCreate = async () => {
    setSubmitting(true);
    try {
      const created = await zonesApi.create({
        name: name.trim(),
        openedAt: localInputToMs(openedAt),
        sort: Number(sort) || 0,
        recommended,
        note: note.trim() || undefined,
      });
      toastSuccess(`区服「${created.name}」已开设，注册侧立即可选`);
      setName("");
      setOpenedAt("");
      setSort("0");
      setRecommended(false);
      setNote("");
      await load();
    } catch {
      /* 失败请求层已统一提示（重名 50027 等） */
    } finally {
      setSubmitting(false);
    }
  };

  const openEdit = (zone: AdminZone) => {
    setEditing(zone);
    setEditSort(String(zone.sort));
    setEditOpenedAt(msToLocalInput(zone.openedAt));
    setEditRecommended(zone.recommended);
    setEditNote(zone.note ?? "");
  };

  const submitEdit = async () => {
    if (!editing) return;
    setSubmitting(true);
    try {
      await zonesApi.update(String(editing.id), {
        sort: Number(editSort) || 0,
        openedAt: localInputToMs(editOpenedAt),
        recommended: editRecommended,
        note: editNote.trim(),
      });
      toastSuccess(`区服「${editing.name}」的运营字段已保存`);
      setEditing(null);
      await load();
    } catch {
      /* 请求层已提示（已合并的区 50026） */
    } finally {
      setSubmitting(false);
    }
  };

  const openStatus = (zone: AdminZone) => {
    setStatusTarget(zone);
    // 默认给「与当前相反的那个安全动作」：正常区 → 维护；维护区 → 恢复
    setNextStatus(zone.status === "open" ? "maintenance" : "open");
    setStatusReason("");
  };

  const submitStatus = async () => {
    if (!statusTarget) return;
    setSubmitting(true);
    try {
      await zonesApi.setStatus(String(statusTarget.id), { status: nextStatus, reason: statusReason.trim() || undefined });
      toastSuccess(`区服「${statusTarget.name}」已转为 ${nextStatus}`);
      setStatusTarget(null);
      setCloseConfirmOpen(false);
      await load();
    } catch {
      /* 请求层已提示（50031 非法迁移 / 50030 状态不可用） */
    } finally {
      setSubmitting(false);
    }
  };

  const runPrecheck = async () => {
    if (!fromZone || !toZone) return;
    setPrechecking(true);
    setPrecheck(null);
    try {
      setPrecheck(await zonesApi.mergePrecheck({ fromZoneId: fromZone.id, toZoneId: toZone.id }));
    } catch {
      /* 请求层已提示 */
    } finally {
      setPrechecking(false);
    }
  };

  const submitMerge = async () => {
    if (!fromZone || !toZone) return;
    setSubmitting(true);
    try {
      const merged = await zonesApi.merge({ fromZoneId: fromZone.id, toZoneId: toZone.id });
      setMergeConfirmOpen(false);
      setReport(merged);
      setFromId("");
      setToId("");
      setPrecheck(null);
      await load();
    } catch {
      /* 失败保持弹窗打开，请求层已统一提示（50025 / 50026 / 50028 / 50032 等） */
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="区服运营"
        description="区是玩家归属（角色属于区，账号不属于）；世界按区独立播种。开区 / 改状态 / 合区都在这里，合区不可逆。"
      />

      <Card title="区服列表" actions={loading ? <Spinner /> : null} description="账号数按「在本区有角色的去重账号」算（与账号列表同源）。">
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>id</th>
                <th className={thClass}>区名</th>
                <th className={thClass}>状态</th>
                <th className={thClass}>排序</th>
                <th className={thClass}>账号</th>
                <th className={thClass}>角色</th>
                <th className={thClass}>在线</th>
                <th className={thClass}>世界实例</th>
                <th className={thClass}>帮会</th>
                <th className={thClass}>待重载</th>
                <th className={thClass}>开服时间</th>
                <th className={thClass}>备注</th>
                <th className={thClass}>操作</th>
              </tr>
            </thead>
            <tbody>
              {(zones ?? []).map((zone) => (
                <tr key={zone.id} className="transition hover:bg-surface-4/30">
                  <td className={`${tdClass} font-mono text-xs text-ink-3`}>{zone.id}</td>
                  <td className={`${tdClass} font-medium text-ink-1`}>
                    {zone.name}
                    {zone.recommended ? (
                      <span className="ml-2">
                        <Badge tone="gold">推荐</Badge>
                      </span>
                    ) : null}
                  </td>
                  <td className={tdClass}>
                    <StatusBadge zone={zone} mergedName={zone.mergedInto === null ? null : zoneNameOf(zone.mergedInto)} />
                  </td>
                  <td className={tdClass}>{zone.sort}</td>
                  <td className={tdClass}>{zone.accountCount}</td>
                  <td className={tdClass}>{zone.roleCount}</td>
                  <td className={tdClass}>{zone.onlineCount}</td>
                  <td className={tdClass}>{zone.monsterCount}</td>
                  <td className={tdClass}>{zone.guildCount}</td>
                  <td className={tdClass}>{zone.pendingReloads}</td>
                  <td className={`${tdClass} text-xs text-ink-4`}>{formatTime(zone.openedAt) || "—"}</td>
                  <td className={`${tdClass} max-w-48 truncate text-xs text-ink-4`} title={zone.note ?? ""}>
                    {zone.note || "—"}
                  </td>
                  <td className={tdClass}>
                    {zone.mergedInto !== null ? (
                      <span className="text-xs text-ink-5">已归档</span>
                    ) : (
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" disabled={!canWrite} onClick={() => openEdit(zone)}>
                          编辑
                        </Button>
                        <Button variant="ghost" disabled={!canWrite} onClick={() => openStatus(zone)}>
                          状态
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && zones && zones.length === 0 ? <EmptyState title="还没有任何区服" description="先在下方开一个区" /> : null}
        {!canWrite ? <p className="mt-3 text-xs text-warn-hi">当前角色没有「区服写」权限，只能查看清单。</p> : null}
      </Card>

      <Card title="开新区" description="名字 1~20 字、全服唯一；开完注册下拉立即可选（排序小的在前）。">
        <div className="flex flex-wrap items-end gap-2">
          <Field width="w-48" label="区服名">
            <Input
              value={name}
              placeholder="如：三区"
              maxLength={20}
              disabled={!canWrite}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field width="w-56" label="开服时间" hint="不填 = 现在">
            <Input type="datetime-local" value={openedAt} disabled={!canWrite} onChange={(event) => setOpenedAt(event.target.value)} />
          </Field>
          <Field width="w-24" label="排序">
            <Input type="number" value={sort} disabled={!canWrite} onChange={(event) => setSort(event.target.value)} />
          </Field>
          <Field width="w-64" label="运营备注" hint="仅后台可见">
            <Input value={note} maxLength={200} placeholder="如：新区冲级活动" disabled={!canWrite} onChange={(event) => setNote(event.target.value)} />
          </Field>
          <label className="flex items-center gap-2 pb-1.5 text-xs text-ink-3">
            <input
              type="checkbox"
              checked={recommended}
              disabled={!canWrite}
              onChange={(event) => setRecommended(event.target.checked)}
              className="size-3.5 accent-gold"
            />
            标记为推荐区
          </label>
          <Button disabled={!canWrite || !nameValid || submitting} loading={submitting} onClick={() => void submitCreate()}>
            开新区
          </Button>
        </div>
      </Card>

      <Card
        title="合区向导"
        description="把源区整体并入目标区：角色与帮会改挂目标区（同账号同名自动改名）、世界实例重排续序、源区残留清理。先预检再合并。"
        actions={
          <Button variant="ghost" disabled={!canWrite || !mergePicked || prechecking} loading={prechecking} onClick={() => void runPrecheck()}>
            预检
          </Button>
        }
      >
        <div className="flex flex-wrap items-end gap-2">
          <Field width="w-56" label="被并入的区（源区）">
            <Select value={fromId} disabled={!canWrite} onChange={(event) => pickFrom(event.target.value)}>
              <option value="">选择源区</option>
              {mergeableZones.map((zone) => (
                <option key={zone.id} value={zone.id}>
                  {zone.name}（{zone.accountCount} 账号）
                </option>
              ))}
            </Select>
          </Field>
          <Field width="w-56" label="并入的目标区">
            <Select value={toId} disabled={!canWrite} onChange={(event) => pickTo(event.target.value)}>
              <option value="">选择目标区</option>
              {mergeableZones.map((zone) => (
                <option key={zone.id} value={zone.id}>
                  {zone.name}（{zone.accountCount} 账号）
                </option>
              ))}
            </Select>
          </Field>
          <Button variant="danger" disabled={!canWrite || !mergePicked || !precheck?.ok || submitting} onClick={() => setMergeConfirmOpen(true)}>
            合并区
          </Button>
          {fromZone && toZone && fromZone.id === toZone.id ? <span className="pb-2 text-xs text-ember-hi">源区与目标区不能是同一个。</span> : null}
        </div>

        {mergeableZones.length < 2 ? (
          <p className="mt-3 text-xs text-ink-4">合区需要至少两个 open 状态的区；维护中 / 已关闭的区要先恢复。</p>
        ) : null}

        {precheck ? (
          <div className="mt-3 flex flex-col gap-2">
            {precheck.ok ? (
              <Notice tone="jade" title="预检通过">
                可以合并。下面这些数据会被搬走或清理，确认后一个事务内完成。
              </Notice>
            ) : (
              <Notice tone="warn" title="预检不通过，不能合并">
                <ul className="mt-1 list-disc pl-4">
                  {precheck.blockers.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </Notice>
            )}
            <div className="grid grid-cols-2 gap-2 text-xs text-ink-3 sm:grid-cols-3 lg:grid-cols-6">
              <PrecheckCell label="账号" value={precheck.accountCount} />
              <PrecheckCell label="角色" value={precheck.roleCount} />
              <PrecheckCell label="在线（会断开）" value={precheck.onlineCount} />
              <PrecheckCell label="世界实例" value={precheck.monsterCount} />
              <PrecheckCell label="帮会" value={precheck.guildCount} />
              <PrecheckCell label="待重载（会作废）" value={precheck.pendingReloads} />
            </div>
          </div>
        ) : null}
      </Card>

      {/* 编辑运营字段 */}
      <Modal
        open={editing !== null}
        title={`编辑「${editing?.name ?? ""}」`}
        hint="改名不提供：已发出去的公告与客服话术会对不上。"
        size="md"
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button loading={submitting} disabled={!canWrite} onClick={() => void submitEdit()}>
              保存
            </Button>
          </>
        }
      >
        <div className="flex flex-wrap items-end gap-3">
          <Field width="w-56" label="开服时间">
            <Input type="datetime-local" value={editOpenedAt} disabled={!canWrite} onChange={(event) => setEditOpenedAt(event.target.value)} />
          </Field>
          <Field width="w-24" label="排序">
            <Input type="number" value={editSort} disabled={!canWrite} onChange={(event) => setEditSort(event.target.value)} />
          </Field>
          <label className="flex items-center gap-2 pb-1.5 text-xs text-ink-3">
            <input
              type="checkbox"
              checked={editRecommended}
              disabled={!canWrite}
              onChange={(event) => setEditRecommended(event.target.checked)}
              className="size-3.5 accent-gold"
            />
            推荐区
          </label>
          <Field width="w-full" label="运营备注" hint="≤200 字；清空 = 删除备注">
            <Input value={editNote} maxLength={200} disabled={!canWrite} onChange={(event) => setEditNote(event.target.value)} />
          </Field>
        </div>
      </Modal>

      {/* 改状态 */}
      <Modal
        open={statusTarget !== null}
        title={`改「${statusTarget?.name ?? ""}」的状态`}
        hint={`当前：${statusText(statusTarget?.status)}`}
        size="md"
        onClose={() => setStatusTarget(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setStatusTarget(null)}>
              取消
            </Button>
            {nextStatus === "closed" ? (
              <Button variant="danger" loading={submitting} onClick={() => setCloseConfirmOpen(true)}>
                关闭该区
              </Button>
            ) : (
              <Button loading={submitting} disabled={!canWrite} onClick={() => void submitStatus()}>
                确认
              </Button>
            )}
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field width="w-56" label="目标状态">
            <Select
              value={nextStatus}
              disabled={!canWrite || statusTarget?.status === "closed"}
              onChange={(event) => setNextStatus(event.target.value as "open" | "maintenance" | "closed")}
            >
              <option value="open">open（正常）</option>
              <option value="maintenance">maintenance（维护中）</option>
              <option value="closed">closed（关闭，不可逆）</option>
            </Select>
          </Field>
          <Field width="w-full" label="变更原因" hint="写进操作日志，≤200 字">
            <Input value={statusReason} maxLength={200} disabled={!canWrite} onChange={(event) => setStatusReason(event.target.value)} />
          </Field>
          {nextStatus === "maintenance" ? (
            <Notice tone="warn" title="转维护会发生什么">
              该区立刻停止注册与选服；在线玩家收到倒计时（出厂 60 秒）后被断开。世界照常运行，状态不丢。
            </Notice>
          ) : null}
          {nextStatus === "open" ? <Notice tone="jade" title="恢复后">注册与选服立刻恢复；已经断开的人需要重新登录。</Notice> : null}
          {nextStatus === "closed" ? (
            <Notice tone="ember" title="关闭不可逆">
              关闭后该区不再出现在注册与选服里，也不能再开回来（避免把一批老玩家拉回一个世界很久没落盘的区）。
              真要重开只能开新区 + 合区。
            </Notice>
          ) : null}
        </div>
      </Modal>

      <ConfirmDialog
        open={closeConfirmOpen && statusTarget !== null}
        title={`确认关闭「${statusTarget?.name ?? ""}」？`}
        description="这一步不可逆：关闭之后这个区不能再开回来，玩家也选不到、进不去。数据仍在（客服可查历史）。"
        confirmText="确认关闭"
        danger
        loading={submitting}
        onConfirm={() => void submitStatus()}
        onCancel={() => setCloseConfirmOpen(false)}
      />

      <ConfirmDialog
        open={mergeConfirmOpen && fromZone !== null && toZone !== null}
        title={`确认把「${fromZone?.name ?? ""}」并入「${toZone?.name ?? ""}」？`}
        description={
          `源区 ${precheck?.accountCount ?? 0} 个账号 / ${precheck?.roleCount ?? 0} 个角色 / ${precheck?.guildCount ?? 0} 个帮会搬进目标区，` +
          `${precheck?.monsterCount ?? 0} 个世界实例重排发牌；源区 ${precheck?.pendingReloads ?? 0} 条待执行重载会作废、` +
          `${precheck?.onlineCount ?? 0} 名在线玩家会被断开（客户端收到「本区已并入 X 区」后回登录页）。` +
          "源区从此标记为已合并，无法再开回来。"
        }
        confirmText="确认合并"
        danger
        loading={submitting}
        onConfirm={() => void submitMerge()}
        onCancel={() => setMergeConfirmOpen(false)}
      />

      {/* 合并报告 */}
      <Modal
        open={report !== null}
        title="合并完成"
        hint={report ? `${report.fromName} → ${report.toName}` : undefined}
        size="lg"
        onClose={() => setReport(null)}
      >
        {report ? (
          <div className="flex flex-col gap-3">
            <Notice tone="jade" title="已搬迁">
              账号 {report.accountCount} 个、角色 {report.roleCount} 个、帮会 {report.guildCount} 个、世界实例 {report.monsterCount} 个；
              断开在线连接 {report.onlineDisconnected} 条。
            </Notice>
            <div className="grid grid-cols-2 gap-2 text-xs text-ink-3 sm:grid-cols-4">
              <PrecheckCell label="作废重载" value={report.failedReloads} />
              <PrecheckCell label="清监控快照" value={report.removedMonitorStates} />
              <PrecheckCell label="清监控事件" value={report.removedMonitorEvents} />
              <PrecheckCell label="清位置行" value={report.removedPositions} />
            </div>
            {report.renamedRoles.length > 0 ? (
              <div>
                <p className="mb-1 text-[11px] tracking-wide text-ink-4">被系统改名的角色（同账号在两个区同名）</p>
                <div className="overflow-x-auto">
                  <table className={tableClass}>
                    <thead className={theadClass}>
                      <tr>
                        <th className={thClass}>原名</th>
                        <th className={thClass}>改为</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.renamedRoles.map((row) => (
                        <tr key={row.id}>
                          <td className={tdClass}>{row.name}</td>
                          <td className={`${tdClass} text-ink-1`}>{row.renamed}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <p className="text-xs text-ink-4">没有角色需要改名。</p>
            )}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

/** 状态徽标（已合并的区优先显示去向，比「已关闭」信息量大） */
function StatusBadge({ zone, mergedName }: { zone: AdminZone; mergedName: string | null }) {
  if (mergedName !== null) {
    return <Badge tone="muted">已并入 {mergedName}</Badge>;
  }
  if (zone.status === "open") return <Badge tone="jade">正常</Badge>;
  if (zone.status === "maintenance") return <Badge tone="warn">维护中</Badge>;
  return <Badge tone="ember">已关闭</Badge>;
}

function statusText(status: AdminZone["status"] | undefined): string {
  if (status === "open") return "正常";
  if (status === "maintenance") return "维护中";
  if (status === "closed") return "已关闭";
  return "—";
}

/** 预检 / 报告里的小格子：标签 + 数字（同一套版式，两处都用） */
function PrecheckCell({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-line/60 bg-surface-1/50 px-2 py-1.5">
      <div className="text-[11px] text-ink-4">{label}</div>
      <div className="font-mono text-sm text-ink-1">{value}</div>
    </div>
  );
}
