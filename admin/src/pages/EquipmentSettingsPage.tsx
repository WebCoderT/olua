import { useCallback, useEffect, useState } from "react";
import { equipmentMetaApi, equipmentSlotsApi, formatTime, PERMISSION } from "../api";
import type { EquipmentCurveSegment, EquipmentMeta, EquipmentSlot } from "../api";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";
import { IconField } from "../components/ImagePicker";
import { anyPickerOpen } from "../components/pickerStack";

/** 槽位在角色弹窗里的位置分组（与服务端 `EquipmentSlotSeed.position` 同值域） */
const POSITION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "left", label: "左侧" },
  { value: "right", label: "右侧" },
  { value: "bottom", label: "下方" },
  { value: "custom", label: "自定义" },
];

const isNumber = (value: string): boolean => value.trim() !== "" && Number.isFinite(Number(value));

/**
 * 槽位编辑弹窗
 *
 * **key 不可改**：槽位 key 是 `EQUIPMENT_TYPE` 的枚举值，客户端按它分表与画底图 ——
 * 改 key 等于改代码，所以这里只开放「名称 / 底图 / 位置分组 / 排序」。
 */
function SlotEditDialog({
  slot,
  onCancel,
  onSubmit,
}: {
  slot: EquipmentSlot & { key: string };
  onCancel: () => void;
  onSubmit: (value: { label: string; imageSrc: string; position: string; order: number }) => Promise<boolean>;
}) {
  const [label, setLabel] = useState(slot.label);
  const [imageSrc, setImageSrc] = useState(slot.imageSrc);
  const [position, setPosition] = useState(slot.position);
  const [order, setOrder] = useState(String(slot.order));
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = label.trim() !== "" && imageSrc.trim() !== "" && Number.isInteger(Number(order)) && !submitting;

  const submit = async () => {
    setSubmitting(true);
    const ok = await onSubmit({ label: label.trim(), imageSrc: imageSrc.trim(), position, order: Number(order) });
    setSubmitting(false);
    if (!ok) return;
  };

  return (
    <Modal
      open
      title={<>编辑槽位 · {slot.key}</>}
      hint={<>槽位 key 是客户端的部位枚举值，不可改；名称 / 底图 / 位置分组 / 排序都是运营可调。</>}
      size="md"
      /* Esc 先到编辑弹窗：图片选择器开着时不能让弹窗一起关（改了一半的内容会丢） */
      onClose={() => {
        if (!anyPickerOpen()) onCancel();
      }}
      footer={
        <>
          <Button variant="outline" disabled={submitting} onClick={onCancel}>
            取消
          </Button>
          <Button disabled={!canSubmit} loading={submitting} onClick={() => void submit()}>
            保存修改
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="名称" hint="角色弹窗与背包里的部位名">
          <Input value={label} onChange={(event) => setLabel(event.target.value)} />
        </Field>
        <Field label="排序" hint="从 0 起；也决定背包「一键整理」的部位序">
          <Input type="number" min={0} value={order} onChange={(event) => setOrder(event.target.value)} />
        </Field>
        <IconField
          label="底图"
          hint="resources 相对路径（不含扩展名），如 slots/cloth"
          rootDir="slots"
          placeholder="slots/cloth"
          value={imageSrc}
          onChange={setImageSrc}
        />
        <Field label="位置分组" hint="角色弹窗里这一列画在哪边">
          <Select value={position} onChange={(event) => setPosition(event.target.value)}>
            {POSITION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

/** 规则草稿：所有数字先按字符串收，保存时统一解析（避免半途写 0） */
type MetaDraft = {
  prefixLabels: string[];
  prefixRates: string[];
  suffixLabels: string[];
  suffixRates: string[];
  curve: Array<{ from: string; to: string; start: string; perLevel: string }>;
};

function toMetaDraft(meta: EquipmentMeta): MetaDraft {
  return {
    prefixLabels: meta.prefixLabels.map(String),
    prefixRates: meta.prefixRates.map((rate) => String(rate)),
    suffixLabels: meta.suffixLabels.map(String),
    suffixRates: meta.suffixRates.map((rate) => String(rate)),
    curve: meta.recycleCurve.map((segment) => ({
      from: String(segment.from),
      to: String(segment.to),
      start: String(segment.start),
      perLevel: String(segment.perLevel),
    })),
  };
}

/**
 * 装备槽位与规则（#603 第九域）
 *
 * 这一页收的是「以前写死在客户端源码里的两样东西」：
 * - **槽位表**（13 行）：名称 / 底图 / 位置分组 / 排序 —— 排序同时是背包「一键整理」的部位序；
 * - **装备规则**（单行）：前后缀倍率与文案（展开 15 个变体的依据）、回收价曲线（背包回收的计价依据）。
 *
 * 两个「不能做」的边界写在页面上：槽位不能新增 / 删除（key 是客户端枚举），
 * 倍率不能只改一半（倍率与文案必须等长，服务端会拒）。
 */
export function EquipmentSettingsPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [slots, setSlots] = useState<EquipmentSlot[] | null>(null);
  const [meta, setMeta] = useState<EquipmentMeta | null>(null);
  const [draft, setDraft] = useState<MetaDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<EquipmentSlot | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [slotRows, metaRow] = await Promise.all([equipmentSlotsApi.list(), equipmentMetaApi.get()]);
      setSlots(slotRows);
      setMeta(metaRow);
      setDraft(toMetaDraft(metaRow));
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submitSlot = async (value: { label: string; imageSrc: string; position: string; order: number }): Promise<boolean> => {
    if (!editing) return false;
    try {
      await equipmentSlotsApi.update(editing.key, value);
      toastSuccess(`槽位「${value.label}」已更新`);
      setEditing(null);
      await load();
      return true;
    } catch {
      return false;
    }
  };

  const patch = (next: Partial<MetaDraft>) => setDraft((current) => (current ? { ...current, ...next } : current));

  /** 前缀/后缀逐项改（下标即枚举序号，长度不变） */
  const patchRate = (kind: "prefix" | "suffix", index: number, field: "label" | "rate", value: string) => {
    if (!draft) return;
    const labels = kind === "prefix" ? draft.prefixLabels.slice() : draft.suffixLabels.slice();
    const rates = kind === "prefix" ? draft.prefixRates.slice() : draft.suffixRates.slice();
    if (field === "label") labels[index] = value;
    else rates[index] = value;
    patch(kind === "prefix" ? { prefixLabels: labels, prefixRates: rates } : { suffixLabels: labels, suffixRates: rates });
  };

  const patchCurve = (index: number, field: keyof MetaDraft["curve"][number], value: string) => {
    if (!draft) return;
    const curve = draft.curve.slice();
    curve[index] = { ...curve[index], [field]: value };
    patch({ curve });
  };

  const curveValid =
    !!draft &&
    draft.curve.length > 0 &&
    draft.curve.every((segment) => isNumber(segment.from) && isNumber(segment.to) && isNumber(segment.start) && isNumber(segment.perLevel)) &&
    draft.curve.every((segment) => Number(segment.from) <= Number(segment.to));
  const ratesValid =
    !!draft &&
    draft.prefixRates.length > 0 &&
    draft.prefixRates.every((rate) => isNumber(rate) && Number(rate) > 0) &&
    draft.suffixRates.every((rate) => isNumber(rate) && Number(rate) > 0) &&
    draft.prefixLabels.every((label) => label.trim() !== "") &&
    draft.suffixLabels.every((label) => label.trim() !== "");
  const canSave = !!draft && curveValid && ratesValid && !saving;

  const saveMeta = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const payload = {
        prefixRates: draft.prefixRates.map(Number),
        suffixRates: draft.suffixRates.map(Number),
        prefixLabels: draft.prefixLabels.map((label) => label.trim()),
        suffixLabels: draft.suffixLabels.map((label) => label.trim()),
        recycleCurve: draft.curve.map<EquipmentCurveSegment>((segment) => ({
          from: Number(segment.from),
          to: Number(segment.to),
          start: Number(segment.start),
          perLevel: Number(segment.perLevel),
        })),
      };
      const saved = await equipmentMetaApi.update(payload);
      setMeta(saved);
      setDraft(toMetaDraft(saved));
      toastSuccess("装备规则已保存（客户端下次进游戏生效）");
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="装备槽位与规则"
        description={
          <>
            槽位表与前后缀倍率 / 回收价曲线以前写死在客户端源码里（<span className="font-mono text-xs">configs/equipments</span> 与{" "}
            <span className="font-mono text-xs">configs/growth</span>），#603 起由服务端下发、这里改。槽位不能新增 / 删除（key 是客户端部位枚举）。
          </>
        }
      />

      <Card
        title="装备槽位"
        actions={loading ? <Spinner /> : null}
        description={canWrite ? "排序同时是背包「一键整理」的部位序。" : "当前角色没有「修改养成配置」权限，列表只读。"}
      >
        {slots && slots.length > 0 ? (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead className={theadClass}>
                <tr>
                  <th className={thClass}>排序</th>
                  <th className={thClass}>key</th>
                  <th className={thClass}>名称</th>
                  <th className={thClass}>底图</th>
                  <th className={thClass}>位置分组</th>
                  <th className={thClass}>更新时间</th>
                  <th className={`${thClass} text-right`}>操作</th>
                </tr>
              </thead>
              <tbody>
                {slots.map((slot) => (
                  <tr key={slot.key} className="transition hover:bg-slate-800/30">
                    <td className={tdClass}>{slot.order}</td>
                    <td className={`${tdClass} font-mono text-xs text-slate-300`}>{slot.key}</td>
                    <td className={`${tdClass} font-medium text-slate-100`}>{slot.label}</td>
                    <td className={`${tdClass} font-mono text-xs text-slate-400`}>{slot.imageSrc}</td>
                    <td className={tdClass}>
                      <Badge tone="slate">{POSITION_OPTIONS.find((option) => option.value === slot.position)?.label ?? slot.position}</Badge>
                    </td>
                    <td className={`${tdClass} text-xs text-slate-400`}>{formatTime(slot.updatedAt)}</td>
                    <td className={`${tdClass} text-right`}>
                      <Button variant="outline" className="px-2.5 py-1 text-xs" disabled={!canWrite} onClick={() => setEditing(slot)}>
                        编辑
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {!loading && slots && slots.length === 0 ? <EmptyState title="槽位表为空" description="服务端没 seed 上，先重启一次服务端" /> : null}
      </Card>

      <Card
        title="前后缀倍率与文案"
        actions={loading ? <Spinner /> : null}
        description="变体属性 = 基础件属性 × 前缀倍率 × 后缀倍率（顶配 1.4 × 3 = 4.2 倍）；文案是名称前后缀与品质名。倍率与文案必须等长，服务端会拒不对称的提交。"
      >
        {draft ? (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {(["prefix", "suffix"] as const).map((kind) => {
              const labels = kind === "prefix" ? draft.prefixLabels : draft.suffixLabels;
              const rates = kind === "prefix" ? draft.prefixRates : draft.suffixRates;
              return (
                <div key={kind} className="flex flex-col gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{kind === "prefix" ? "前缀（品质）" : "后缀（阶级）"}</h3>
                  <div className="grid grid-cols-[auto_1fr_7rem] items-center gap-2">
                    <span className="text-[11px] text-slate-500">序</span>
                    <span className="text-[11px] text-slate-500">文案</span>
                    <span className="text-[11px] text-slate-500">倍率</span>
                    {labels.map((label, index) => (
                      <div key={index} className="col-span-3 grid grid-cols-[auto_1fr_7rem] items-center gap-2">
                        <span className="w-4 text-center text-xs text-slate-500">{index}</span>
                        <Input
                          value={label}
                          disabled={!canWrite}
                          onChange={(event) => patchRate(kind, index, "label", event.target.value)}
                        />
                        <Input
                          type="number"
                          step="0.01"
                          value={rates[index] ?? ""}
                          disabled={!canWrite}
                          onChange={(event) => patchRate(kind, index, "rate", event.target.value)}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
        {draft && !ratesValid ? (
          <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            倍率必须都是正数、文案不能为空（下标就是前后缀枚举序号，不能少档）。
          </p>
        ) : null}
      </Card>

      <Card
        title="装备回收价曲线"
        actions={
          <div className="flex items-center gap-2">
            {loading ? <Spinner /> : null}
            <Button
              variant="outline"
              className="px-2.5 py-1 text-xs"
              disabled={!canWrite || !draft}
              onClick={() => draft && patch({ curve: [...draft.curve, { from: "1", to: "1", start: "0", perLevel: "0" }] })}
            >
              添加一段
            </Button>
          </div>
        }
        description="背包「一键回收」的基础价按等级在这条分段线性曲线上取（再乘前后缀倍率）。from ≤ to、start / perLevel ≥ 0；超出最后一段按最后一段斜率外推。"
      >
        {draft ? (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead className={theadClass}>
                <tr>
                  <th className={thClass}>起始等级</th>
                  <th className={thClass}>结束等级</th>
                  <th className={thClass}>起始价</th>
                  <th className={thClass}>每级增量</th>
                  <th className={`${thClass} text-right`}>操作</th>
                </tr>
              </thead>
              <tbody>
                {draft.curve.map((segment, index) => (
                  <tr key={index}>
                    <td className={tdClass}>
                      <Input type="number" value={segment.from} disabled={!canWrite} onChange={(event) => patchCurve(index, "from", event.target.value)} />
                    </td>
                    <td className={tdClass}>
                      <Input type="number" value={segment.to} disabled={!canWrite} onChange={(event) => patchCurve(index, "to", event.target.value)} />
                    </td>
                    <td className={tdClass}>
                      <Input type="number" value={segment.start} disabled={!canWrite} onChange={(event) => patchCurve(index, "start", event.target.value)} />
                    </td>
                    <td className={tdClass}>
                      <Input type="number" value={segment.perLevel} disabled={!canWrite} onChange={(event) => patchCurve(index, "perLevel", event.target.value)} />
                    </td>
                    <td className={`${tdClass} text-right`}>
                      <Button
                        variant="outline"
                        className="px-2.5 py-1 text-xs"
                        disabled={!canWrite || draft.curve.length <= 1}
                        onClick={() => patch({ curve: draft.curve.filter((_, position) => position !== index) })}
                      >
                        删除
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {draft && !curveValid ? (
          <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            曲线至少要有一段；每段的数字都要能解析，且起始等级 ≤ 结束等级。
          </p>
        ) : null}
        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="text-xs text-slate-500">
            {meta ? `上次保存：${formatTime(meta.updatedAt)}` : ""}
          </p>
          <Button disabled={!canWrite || !canSave} loading={saving} onClick={() => void saveMeta()}>
            保存倍率与曲线
          </Button>
        </div>
      </Card>

      {editing ? <SlotEditDialog slot={editing} onCancel={() => setEditing(null)} onSubmit={submitSlot} /> : null}
    </div>
  );
}
