import { useCallback, useEffect, useMemo, useState } from "react";
import { formatTime, PERMISSION, zonesApi } from "../api";
import type { AdminZone } from "../api";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/**
 * 区服管理（#314，#295 阶段二的运营页面）
 *
 * 区是账号归属的分身：注册时选定，平时不变 —— 归属区只在「合并区」时变。
 * 页面三件事：看清单（含已合并与账号分布）、开新区、合并区。
 *
 * **合并是重操作**：一个事务里搬走源区全部账号、世界怪物重排发牌（续序不重号），
 * 同时实时进程的世界内存按代际作废 —— 合并瞬间各图未落盘的几秒伤害会被丢弃。
 * 所以合并必须过二次确认，弹窗里把代价写明白。
 */
export function ZonesPage() {
  const canWrite = hasPermission(PERMISSION.ZONE_WRITE);
  const [zones, setZones] = useState<AdminZone[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // 开新区表单
  const [name, setName] = useState("");
  // 合并区表单（from / to 都选活区 id，用字符串存方便 Select）
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  // 合并二次确认
  const [mergeConfirmOpen, setMergeConfirmOpen] = useState(false);

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

  const fromZone = liveZones.find((zone) => String(zone.id) === fromId) ?? null;
  const toZone = liveZones.find((zone) => String(zone.id) === toId) ?? null;
  const nameValid = name.trim().length >= 1 && name.trim().length <= 20;
  const mergeValid = fromZone !== null && toZone !== null && fromZone.id !== toZone.id;

  const submitCreate = async () => {
    setSubmitting(true);
    try {
      const created = await zonesApi.create({ name: name.trim() });
      toastSuccess(`区服「${created.name}」已开设，注册侧立即可选`);
      setName("");
      await load();
    } catch {
      /* 失败请求层已统一提示（重名 50027 等） */
    } finally {
      setSubmitting(false);
    }
  };

  const openMergeConfirm = () => {
    setMergeConfirmOpen(true);
  };

  const submitMerge = async () => {
    if (!fromZone || !toZone) return;
    setSubmitting(true);
    try {
      const merged = await zonesApi.merge({ fromZoneId: fromZone.id, toZoneId: toZone.id });
      toastSuccess(`区服「${merged.name}」已并入「${toZone.name}」，账号与世界实例已搬迁`);
      setMergeConfirmOpen(false);
      setFromId("");
      setToId("");
      await load();
    } catch {
      /* 失败保持弹窗打开，请求层已统一提示（50025 / 50026 / 50028 等） */
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-50">区服管理</h1>
        <p className="mt-1 text-xs text-slate-500">
          区是账号归属（注册时选定）；世界怪物按区独立播种。合并把源区整体搬进目标区，玩家自己换不了区。
        </p>
      </div>

      <Card title="开新区" description="名字 1~20 字、全服唯一；开完注册侧下拉立即可选。">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-56">
            <Field label="区服名">
              <Input
                value={name}
                placeholder="如：三区"
                maxLength={20}
                disabled={!canWrite}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && canWrite && nameValid && !submitting) void submitCreate();
                }}
              />
            </Field>
          </div>
          <Button disabled={!canWrite || !nameValid || submitting} loading={submitting} onClick={() => void submitCreate()}>
            开新区
          </Button>
        </div>
        {!canWrite ? <p className="mt-3 text-xs text-amber-300">当前角色没有「开区 / 合并区」权限，只能查看清单。</p> : null}
      </Card>

      <Card title="合并区" description="把源区并入目标区：源区账号全部搬走、世界实例重排续序、源区标记为已合并（不可逆）。">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-48">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">被并入的区（源区）</span>
            <Select value={fromId} disabled={!canWrite} onChange={(event) => setFromId(event.target.value)}>
              <option value="">选择源区</option>
              {liveZones.map((zone) => (
                <option key={zone.id} value={zone.id}>
                  {zone.name}（id {zone.id}，{zone.accountCount} 账号）
                </option>
              ))}
            </Select>
          </div>
          <div className="w-48">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">并入的目标区</span>
            <Select value={toId} disabled={!canWrite} onChange={(event) => setToId(event.target.value)}>
              <option value="">选择目标区</option>
              {liveZones.map((zone) => (
                <option key={zone.id} value={zone.id}>
                  {zone.name}（id {zone.id}，{zone.accountCount} 账号）
                </option>
              ))}
            </Select>
          </div>
          <Button variant="danger" disabled={!canWrite || !mergeValid || submitting} onClick={openMergeConfirm}>
            合并区
          </Button>
          {fromZone && toZone && fromZone.id === toZone.id ? (
            <span className="pb-2 text-xs text-red-300">源区与目标区不能是同一个。</span>
          ) : null}
        </div>
      </Card>

      <Card title="区服列表" actions={loading ? <Spinner /> : null} description={canWrite ? undefined : "当前角色没有「开区 / 合并区」权限，列表只读。"}>
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>id</th>
                <th className={thClass}>名称</th>
                <th className={thClass}>状态</th>
                <th className={thClass}>账号数</th>
                <th className={thClass}>创建时间</th>
                <th className={thClass}>更新时间</th>
              </tr>
            </thead>
            <tbody>
              {(zones ?? []).map((zone) => (
                <tr key={zone.id} className="transition hover:bg-slate-800/30">
                  <td className={`${tdClass} font-mono text-xs text-slate-300`}>{zone.id}</td>
                  <td className={`${tdClass} font-medium text-slate-100`}>{zone.name}</td>
                  <td className={tdClass}>
                    {zone.mergedInto === null ? (
                      <Badge tone="green">活区</Badge>
                    ) : (
                      <Badge tone="slate">已并入 {zones?.find((z) => z.id === zone.mergedInto)?.name ?? `区 ${zone.mergedInto}`}</Badge>
                    )}
                  </td>
                  <td className={tdClass}>{zone.accountCount}</td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{formatTime(zone.createdAt)}</td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{formatTime(zone.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!loading && zones && zones.length === 0 ? <EmptyState title="还没有任何区服" description="先在上方开一个区" /> : null}
      </Card>

      <ConfirmDialog
        open={mergeConfirmOpen && fromZone !== null && toZone !== null}
        title={`确认把「${fromZone?.name ?? ""}」并入「${toZone?.name ?? ""}」？`}
        description={
          "这一步不可逆：源区全部账号搬进目标区（归属区变更，玩家无感）；源区世界实例重排续序；" +
          "实时进程的世界内存按代际作废，合并瞬间各图未落盘的几秒伤害会被丢弃。源区从此标记为已合并，无法再开回来。"
        }
        confirmText="确认合并"
        danger
        loading={submitting}
        onConfirm={() => void submitMerge()}
        onCancel={() => setMergeConfirmOpen(false)}
      />
    </div>
  );
}
