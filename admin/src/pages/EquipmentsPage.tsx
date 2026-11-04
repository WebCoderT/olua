import { useCallback, useEffect, useMemo, useState } from "react";
import { equipmentsApi, equipmentMetaApi, equipmentSlotKeys, equipmentVariantsApi, formatTime, OCCUPATION_LABELS, PERMISSION, SEX_LABELS, slotLabel } from "../api";
import type { ConfigAttributes, Equipment, EquipmentVariantRebuildResult, PageResult } from "../api";
import { AttributesGrid, crossedRangeKeys } from "../components/AttributesEditor";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { GameIcon } from "../components/GameImage";
import { IconField } from "../components/ImagePicker";
import { anyPickerOpen } from "../components/pickerStack";
import { Modal } from "../components/Modal";
import { Pagination } from "../components/Pagination";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";
import { PageHeader } from "../components/PageHeader";

/** 属性摘要（列表列太窄，只报几个关键数；完整数值在编辑弹窗里） */
function attributeSummary(item: Equipment): string {
  const a = item.attributes;
  return `生命 ${a.maxHp} · 物攻 ${a.physicalAttack.min}~${a.physicalAttack.max} · 物防 ${a.physicalDefense.min}~${a.physicalDefense.max}`;
}

/**
 * 部位下拉的选项（id + 中文名）
 *
 * 部位清单与名字都在 `equipment_slots` 表（#655 起代码里不再有第二份），所以**渲染时**才算 ——
 * 模块级那时字典还没拉回来。含暂无装备的 other1 / other2 也无妨（后端也认这两个位）。
 */
function slotOptions(): [string, string][] {
  return equipmentSlotKeys().map((key) => [key, slotLabel(key)]);
}

/**
 * 装备基础件编辑弹窗（#252 起；#603 第九域扩到「全部显示字段」）
 *
 * 三段：
 * 1. **文案与限制** —— 名称 / 描述 / 职业 / 性别 / 等级 / 售卖价；
 * 2. **资源与几何** —— 图标 / 内观图集 / 外观图集 / 标签 / 两轴缩放 / 内观锚点与旋转 /
 *    外观 8 向位置（出厂值，实际效果以「装备对齐」工作台为准）；
 * 3. **八项基础属性** —— 整份提交、整份替换。
 *
 * 校验分工：可解析性（数字 / 8 个方向 / min ≤ max）在这里做即时提示，权威在服务端
 * （DTO 校验 + 400 错误码）。资源路径只校验「非空 / 长度」，**不校验文件是否存在** ——
 * 素材归属远程发布包，管理端不该按本地文件判存在性。
 */
type EquipmentDraft = {
  label: string;
  description: string;
  occupation: string;
  sex: string;
  level: string;
  sellPrice: string;
  icon: string;
  inAtlas: string;
  outAtlas: string;
  tags: string;
  outScale: string;
  inScaleX: string;
  inScaleY: string;
  inRotate: string;
  inPosX: string;
  inPosY: string;
  outPositions: Array<{ x: string; y: string }>;
  attributes: ConfigAttributes;
};

/** 与服务端 `EQUIPMENT_DIRECTIONS` 同序：up / right_up / right / right_down / down / left_down / left / left_up */
const POSITION_DIRECTIONS = ["上", "右上", "右", "右下", "下", "左下", "左", "左上"];

/** 8 向位置缺省补齐（老行可能只有 4 个或空数组） */
function padPositions(points: Equipment["outPositions"] | undefined): Array<{ x: string; y: string }> {
  return Array.from({ length: POSITION_DIRECTIONS.length }, (_, index) => {
    const point = points?.[index];
    return { x: String(point?.x ?? 0), y: String(point?.y ?? 0) };
  });
}

function toDraft(item: Equipment): EquipmentDraft {
  return {
    label: item.label,
    description: item.description ?? "",
    occupation: item.occupation,
    sex: item.sex,
    level: String(item.level),
    sellPrice: String(item.sellPrice),
    icon: item.icon ?? "",
    inAtlas: item.inAtlas ?? "",
    outAtlas: item.outAtlas ?? "",
    tags: (item.tags ?? []).join("、"),
    outScale: String(item.outScale ?? 1),
    inScaleX: String(item.inScaleX ?? 1),
    inScaleY: String(item.inScaleY ?? 1),
    inRotate: String(item.inRotate ?? 0),
    inPosX: String(item.inPosX ?? 0),
    inPosY: String(item.inPosY ?? 0),
    outPositions: padPositions(item.outPositions),
    attributes: { ...item.attributes },
  };
}

/** 数字输入统一按「空 = 0」以外的语义处理：非数字算非法，避免静默写 0 */
const isNumber = (value: string): boolean => value.trim() !== "" && Number.isFinite(Number(value));

function EquipmentEditDialog({
  open,
  initial,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  initial: Equipment | null;
  onCancel: () => void;
  onSubmit: (value: {
    label: string;
    description: string;
    occupation: string;
    sex: string;
    icon: string;
    inAtlas: string;
    outAtlas: string;
    tags: string[];
    outScale: number;
    inScaleX: number;
    inScaleY: number;
    inRotate: number;
    inPosX: number;
    inPosY: number;
    outPositions: Array<{ x: number; y: number }>;
    level: number;
    sellPrice: number;
    attributes: ConfigAttributes;
  }) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<EquipmentDraft | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open || !initial) return;
    setDraft(toDraft(initial));
    setSubmitting(false);
  }, [open, initial]);

  /** 区间交叉（min > max）的键集合；空 = 合法 */
  const crossedKeys = useMemo(() => (draft ? crossedRangeKeys(draft.attributes) : []), [draft]);

  if (!open || !draft || !initial) return null;

  const patch = (next: Partial<EquipmentDraft>) => setDraft({ ...draft, ...next });
  const numbers = [draft.level, draft.sellPrice, draft.outScale, draft.inScaleX, draft.inScaleY, draft.inRotate, draft.inPosX, draft.inPosY];
  const positionsOk = draft.outPositions.length === POSITION_DIRECTIONS.length && draft.outPositions.every((point) => isNumber(point.x) && isNumber(point.y));
  const levelValid = Number.isInteger(Number(draft.level)) && Number(draft.level) >= 1;
  const priceValid = Number.isInteger(Number(draft.sellPrice)) && Number(draft.sellPrice) >= 0;
  const canSubmit = numbers.every(isNumber) && positionsOk && levelValid && priceValid && crossedKeys.length === 0 && !submitting;

  const submit = async () => {
    setSubmitting(true);
    const ok = await onSubmit({
      label: draft.label.trim(),
      description: draft.description.trim(),
      occupation: draft.occupation,
      sex: draft.sex,
      icon: draft.icon.trim(),
      inAtlas: draft.inAtlas.trim(),
      outAtlas: draft.outAtlas.trim(),
      // 标签用顿号 / 逗号 / 空格分隔都收（运营从表格里粘过来常见半角逗号）
      tags: draft.tags
        .split(/[、,，\s]+/)
        .map((tag) => tag.trim())
        .filter(Boolean),
      outScale: Number(draft.outScale),
      inScaleX: Number(draft.inScaleX),
      inScaleY: Number(draft.inScaleY),
      inRotate: Number(draft.inRotate),
      inPosX: Number(draft.inPosX),
      inPosY: Number(draft.inPosY),
      outPositions: draft.outPositions.map((point) => ({ x: Number(point.x), y: Number(point.y) })),
      level: Number(draft.level),
      sellPrice: Number(draft.sellPrice),
      attributes: draft.attributes,
    });
    setSubmitting(false);
    if (!ok) return;
  };

  return (
    <Modal
      open
      title={<>编辑装备 · {initial.id}</>}
      hint={
        <>
          部位 {slotLabel(initial.slot)}（不可改）· 变体属性 = 这里的基础属性 × 前后缀倍率，改基础件即改全部 15 个变体。
          资源路径与几何是**出厂值**：工作台（装备对齐 / 内观对齐）调过的装备，实际效果以工作台为准、每次进图另发。
        </>
      }
      size="lg"
      /* Esc 先到编辑弹窗：图片选择器开着时不能让编辑弹窗一起关（改了一半的内容会丢） */
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
      <section className="flex flex-col gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">文案与限制</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="名称" hint="≤50 字；前后缀由客户端拼在名字前后">
            <Input value={draft.label} onChange={(event) => patch({ label: event.target.value })} />
          </Field>
          <Field label="标签" hint="顿号或逗号分隔，最多 8 个（如「第一大陆」）；详情弹窗展示，无逻辑含义">
            <Input value={draft.tags} onChange={(event) => patch({ tags: event.target.value })} />
          </Field>
          <Field label="职业限制">
            <Select value={draft.occupation} onChange={(event) => patch({ occupation: event.target.value })}>
              {Object.entries(OCCUPATION_LABELS).map(([code, text]) => (
                <option key={code} value={code}>
                  {text}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="性别限制">
            <Select value={draft.sex} onChange={(event) => patch({ sex: event.target.value })}>
              {Object.entries(SEX_LABELS).map(([code, text]) => (
                <option key={code} value={code}>
                  {text}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="穿戴需求等级" hint="装备定强的锚点；属性是存档值，改等级不会自动重算">
            <Input type="number" min={1} value={draft.level} onChange={(event) => patch({ level: event.target.value })} />
          </Field>
          <Field label="售卖价" hint="0 = 不可售卖；商城售价归「商城定价」管理，不在这里">
            <Input type="number" min={0} value={draft.sellPrice} onChange={(event) => patch({ sellPrice: event.target.value })} />
          </Field>
        </div>
        <Field label="描述" hint="≤500 字；空 = 清空（详情弹窗正文）">
          <textarea
            className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500"
            rows={3}
            value={draft.description}
            onChange={(event) => patch({ description: event.target.value })}
          />
        </Field>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">资源与几何</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <IconField
            label="图标"
            hint="resources 相对路径（不含扩展名），如 clothes/icon/005"
            placeholder="clothes/icon/005"
            value={draft.icon}
            onChange={(path) => patch({ icon: path })}
          />
          <IconField
            label="内观图集"
            hint="角色弹窗里穿在身上的那套"
            mode="atlas"
            rootDir="clothes/in"
            placeholder="clothes/in/005"
            value={draft.inAtlas}
            onChange={(path) => patch({ inAtlas: path })}
          />
          <IconField
            label="外观图集"
            hint="场景里跟着角色走的那个（整套动作图集，没有单张封面）"
            mode="atlas"
            rootDir="clothes/out"
            placeholder="clothes/out/005"
            value={draft.outAtlas}
            onChange={(path) => patch({ outAtlas: path })}
          />
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label="外观缩放" hint="1 = 原尺寸">
            <Input type="number" step="0.01" value={draft.outScale} onChange={(event) => patch({ outScale: event.target.value })} />
          </Field>
          <Field label="内观 X 缩放">
            <Input type="number" step="0.01" value={draft.inScaleX} onChange={(event) => patch({ inScaleX: event.target.value })} />
          </Field>
          <Field label="内观 Y 缩放">
            <Input type="number" step="0.01" value={draft.inScaleY} onChange={(event) => patch({ inScaleY: event.target.value })} />
          </Field>
          <Field label="内观旋转" hint="度，0 = 不转">
            <Input type="number" step="1" value={draft.inRotate} onChange={(event) => patch({ inRotate: event.target.value })} />
          </Field>
          <Field label="内观锚点 X" hint="弹窗中心为原点">
            <Input type="number" step="0.5" value={draft.inPosX} onChange={(event) => patch({ inPosX: event.target.value })} />
          </Field>
          <Field label="内观锚点 Y" hint="y 向上为正">
            <Input type="number" step="0.5" value={draft.inPosY} onChange={(event) => patch({ inPosY: event.target.value })} />
          </Field>
        </div>
        <div>
          <p className="mb-2 text-xs text-slate-400">
            外观 8 向位置（相对角色脚底锚点，y 向上）—— 出厂值；工作台保存过的装备以工作台为准
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {POSITION_DIRECTIONS.map((direction, index) => (
              <div key={direction} className="rounded-lg border border-slate-700/60 bg-slate-900/40 p-2">
                <p className="mb-1 text-[11px] text-slate-400">{direction}</p>
                <div className="flex gap-1">
                  <Input
                    type="number"
                    step="0.5"
                    className="px-2 py-1 text-xs"
                    value={draft.outPositions[index]?.x ?? "0"}
                    onChange={(event) => {
                      const next = draft.outPositions.slice();
                      next[index] = { x: event.target.value, y: next[index]?.y ?? "0" };
                      patch({ outPositions: next });
                    }}
                  />
                  <Input
                    type="number"
                    step="0.5"
                    className="px-2 py-1 text-xs"
                    value={draft.outPositions[index]?.y ?? "0"}
                    onChange={(event) => {
                      const next = draft.outPositions.slice();
                      next[index] = { x: next[index]?.x ?? "0", y: event.target.value };
                      patch({ outPositions: next });
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">基础属性（整份替换）</h3>
        <AttributesGrid
          attributes={draft.attributes}
          onChange={(attributes) => patch({ attributes })}
          header=""
          crossed={crossedKeys}
        />
      </section>
      {!levelValid || !priceValid || !positionsOk || !numbers.every(isNumber) ? (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          等级需为 ≥1 的整数、售卖价需为 ≥0 的整数；缩放 / 旋转 / 锚点与 8 向位置都要能解析成数字（8 个方向缺一不可）。
        </p>
      ) : null}
    </Modal>
  );
}

//#region 前后缀档位管理弹窗（#697）

/** 一档 = 一条文案 + 一个倍率（输入态都是字符串，提交时再解析） */
type TierDraft = { label: string; rate: string };

const TIER_LIMITS = { min: 1, max: 10, maxRate: 1000, maxLabelLength: 10 };

/** 一组档位的就地体检（返回第一条问题；null = 合法） */
function tierProblem(tiers: TierDraft[], kind: string): string | null {
  if (tiers.length < TIER_LIMITS.min) return `${kind}至少要留 ${TIER_LIMITS.min} 档`;
  if (tiers.length > TIER_LIMITS.max) return `${kind}最多 ${TIER_LIMITS.max} 档`;
  const seen = new Set<string>();
  for (const [index, tier] of tiers.entries()) {
    const label = tier.label.trim();
    if (!label) return `${kind}第 ${index + 1} 档没有填文案`;
    if (label.length > TIER_LIMITS.maxLabelLength) return `${kind}第 ${index + 1} 档的文案超过 ${TIER_LIMITS.maxLabelLength} 个字`;
    if (seen.has(label)) return `${kind}第 ${index + 1} 档的文案「${label}」重复了`;
    seen.add(label);
    if (!isNumber(tier.rate)) return `${kind}第 ${index + 1} 档的倍率不是数字`;
    if (Number(tier.rate) <= 0) return `${kind}第 ${index + 1} 档的倍率必须大于 0`;
    if (Number(tier.rate) > TIER_LIMITS.maxRate) return `${kind}第 ${index + 1} 档的倍率超出防御性上限（${TIER_LIMITS.maxRate}）`;
  }
  return null;
}

/**
 * 前后缀档位管理弹窗（#697）：文案 + 倍率的增删改查
 *
 * 档位住在 `equipment_meta` 单行表（文案 / 倍率两条平行数组，整份替换）。
 * **这里只改「档位定义」** —— 已展开的装备变体行不动；增删档位后要回本页点
 * 「重新生成变体」才会按新档数重建（弹窗里反复讲这件事，因为「改了档位但属性
 * 没变」是最容易发生的误用）。删除档位在重建后会让该档变体行消失。
 */
function TiersDialog({ open, onCancel }: { open: boolean; onCancel: () => void }) {
  const [prefixTiers, setPrefixTiers] = useState<TierDraft[] | null>(null);
  const [suffixTiers, setSuffixTiers] = useState<TierDraft[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    equipmentMetaApi
      .get()
      .then((row) => {
        if (cancelled) return;
        setPrefixTiers(row.prefixLabels.map((label, index) => ({ label, rate: String(row.prefixRates[index] ?? 1) })));
        setSuffixTiers(row.suffixLabels.map((label, index) => ({ label, rate: String(row.suffixRates[index] ?? 1) })));
      })
      .catch(() => {
        /* 错误已由请求层统一提示；弹窗留在空态，关掉重开再试 */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  const problem = prefixTiers && suffixTiers ? tierProblem(prefixTiers, "前缀") ?? tierProblem(suffixTiers, "后缀") : "加载中";
  const patchTier = (kind: "prefix" | "suffix", index: number, next: Partial<TierDraft>) => {
    const setter = kind === "prefix" ? setPrefixTiers : setSuffixTiers;
    setter((current) => (current ?? []).map((tier, i) => (i === index ? { ...tier, ...next } : tier)));
  };
  const appendTier = (kind: "prefix" | "suffix") => {
    const setter = kind === "prefix" ? setPrefixTiers : setSuffixTiers;
    setter((current) => [...(current ?? []), { label: "新档", rate: "1" }]);
  };
  const removeTier = (kind: "prefix" | "suffix", index: number) => {
    const setter = kind === "prefix" ? setPrefixTiers : setSuffixTiers;
    setter((current) => (current ?? []).filter((_, i) => i !== index));
  };

  const submit = async () => {
    if (!prefixTiers || !suffixTiers || problem) return;
    setSaving(true);
    try {
      await equipmentMetaApi.update({
        prefixLabels: prefixTiers.map((tier) => tier.label.trim()),
        prefixRates: prefixTiers.map((tier) => Number(tier.rate)),
        suffixLabels: suffixTiers.map((tier) => tier.label.trim()),
        suffixRates: suffixTiers.map((tier) => Number(tier.rate)),
      });
      toastSuccess("前后缀档位已保存（档位定义即改即生效；装备变体要回本页点「重新生成变体」才会按新档数重建）");
      onCancel();
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setSaving(false);
    }
  };

  const renderTiers = (kind: "prefix" | "suffix", tiers: TierDraft[] | null) => {
    const kindLabel = kind === "prefix" ? "前缀" : "后缀";
    return (
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            {kindLabel}档位（{tiers?.length ?? 0} 档，序号即档位 id）
          </h3>
          <Button
            variant="ghost"
            disabled={!tiers || tiers.length >= TIER_LIMITS.max}
            onClick={() => appendTier(kind)}
          >
            添加一档
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] border-separate border-spacing-1">
            <thead>
              <tr>
                <th className="w-12 text-xs font-normal text-slate-500">序号</th>
                <th className="text-xs font-normal text-slate-400">文案</th>
                <th className="w-28 text-xs font-normal text-slate-400">属性倍率</th>
                <th className="w-16 text-right text-xs font-normal text-slate-400">操作</th>
              </tr>
            </thead>
            <tbody>
              {(tiers ?? []).map((tier, index) => (
                <tr key={index}>
                  <td className="text-center text-xs text-slate-500">{index}</td>
                  <td>
                    <Input value={tier.label} onChange={(event) => patchTier(kind, index, { label: event.target.value })} />
                  </td>
                  <td>
                    <Input
                      type="number"
                      step="0.01"
                      min={0.01}
                      value={tier.rate}
                      onChange={(event) => patchTier(kind, index, { rate: event.target.value })}
                    />
                  </td>
                  <td className="text-right">
                    <Button variant="ghost" disabled={(tiers?.length ?? 0) <= TIER_LIMITS.min} onClick={() => removeTier(kind, index)}>
                      删除
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  };

  return (
    <Modal
      open
      title="前后缀档位管理"
      hint="档位文案用于客户端拼品质名（如「精良的·天级」），倍率用于「重新生成变体」时算属性。保存即改档位定义，但已展开的装备变体行不变。"
      size="lg"
      onClose={onCancel}
      footer={
        <>
          <Button variant="outline" disabled={saving} onClick={onCancel}>
            取消
          </Button>
          <Button disabled={Boolean(problem) || loading} loading={saving} onClick={() => void submit()}>
            保存档位
          </Button>
        </>
      }
    >
      {loading || !prefixTiers || !suffixTiers ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {renderTiers("prefix", prefixTiers)}
          {renderTiers("suffix", suffixTiers)}
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200">
            <p>· 增删档位只改「档位定义」，已展开的装备变体行不变 —— 保存后请回本页点「重新生成变体」。</p>
            <p>· 扩档后重建会新增变体行（新组合的卖价按公式垫底，可再逐条调）；缩档后重建会删掉该档变体 —— 身上还穿 / 背包还放的该档装备会变成无效引用（属性查不到、名字回落基础件）。</p>
            <p>· 装备外观（品质棋盘）跟着档数走：扩档后那一格先按公式外推 key，客户端资源包里没有对应素材前先没光效，去「装备边框」/「装备详情背景」页填真实 key 即可。</p>
          </div>
          {problem ? <p className="text-xs text-red-300">{problem}</p> : null}
        </div>
      )}
    </Modal>
  );
}

//#endregion

/**
 * 装备配置管理（#252，养成配置第四页）
 *
 * **只收基础件**（普通的·人级，37 件）：变体（_pXsY）是基础件乘前后缀倍率展开的，
 * 运营只改基础件这一份。id / 部位结构固定 —— **没有「新建」「删除」**，只有「编辑」，
 * 且部位 / 名称不开放编辑（属客户端资源约定）。按部位 / 等级段筛选定位。
 * 商城售价不在这里（唯一写入口归商城定价 issue）。写操作要 `gameConfig:write`。
 */
export function EquipmentsPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [draft, setDraft] = useState({ keyword: "", slot: "", minLevel: "", maxLevel: "" });
  const [query, setQuery] = useState({ keyword: "", slot: "", minLevel: "", maxLevel: "" });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [data, setData] = useState<PageResult<Equipment> | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Equipment | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [tiersOpen, setTiersOpen] = useState(false);
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(
        await equipmentsApi.list({
          page,
          size,
          keyword: query.keyword || undefined,
          slot: query.slot || undefined,
          minLevel: query.minLevel === "" ? undefined : Number(query.minLevel),
          maxLevel: query.maxLevel === "" ? undefined : Number(query.maxLevel),
        }),
      );
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [page, size, query]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitSearch = () => {
    setPage(1);
    setQuery({ keyword: draft.keyword.trim(), slot: draft.slot, minLevel: draft.minLevel.trim(), maxLevel: draft.maxLevel.trim() });
  };

  const resetSearch = () => {
    setDraft({ keyword: "", slot: "", minLevel: "", maxLevel: "" });
    setPage(1);
    setQuery({ keyword: "", slot: "", minLevel: "", maxLevel: "" });
  };

  /** 每页条数变化：回第一页再拉（条数变了页码语义也变了） */
  const handleSizeChange = (next: number) => {
    setSize(next);
    setPage(1);
  };

  /** 编辑弹窗提交（整份提交：弹窗里所有显示字段 + 属性；服务端逐字段校验） */
  const submitDialog = async (value: {
    label: string;
    description: string;
    occupation: string;
    sex: string;
    icon: string;
    inAtlas: string;
    outAtlas: string;
    tags: string[];
    outScale: number;
    inScaleX: number;
    inScaleY: number;
    inRotate: number;
    inPosX: number;
    inPosY: number;
    outPositions: Array<{ x: number; y: number }>;
    level: number;
    sellPrice: number;
    attributes: ConfigAttributes;
  }): Promise<boolean> => {
    if (!editing) return false;
    try {
      await equipmentsApi.update(editing.id, value);
      toastSuccess(`装备「${editing.label}」已更新`);
      setDialogOpen(false);
      setEditing(null);
      await load();
      return true;
    } catch {
      return false;
    }
  };

  /** 重建全部装备变体（#697）：按当前前后缀倍率整批重算；卖价保留、属性 / 名称 / 等级覆盖 */
  const submitRebuild = async () => {
    setRebuilding(true);
    try {
      const result: EquipmentVariantRebuildResult = await equipmentVariantsApi.rebuild();
      toastSuccess(`已重建 ${result.variants} 个装备变体（${result.bases} 基础件 × ${result.combos} 组合）`);
      setRebuildOpen(false);
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setRebuilding(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="装备配置"
        actions={
          canWrite ? (
            <>
              <Button variant="outline" onClick={() => setTiersOpen(true)}>
                前后缀档位
              </Button>
              <Button disabled={rebuilding} onClick={() => setRebuildOpen(true)}>
                重新生成变体
              </Button>
            </>
          ) : null
        }
        description={<>只收基础件（普通的·人级），变体是基础件乘前后缀倍率展开的 —— 改基础件即改全部 15 个变体。
            名称 / 描述 / 职业性别 / 图标与图集 / 标签 / 缩放 / 内观锚点 / 外观 8 向位置都在编辑弹窗里（#603 从客户端源码搬来）；
            id 与部位结构固定，只可编辑、不可新增 / 删除；商城售价归「商城定价」管理，不在这里。
            前后缀档位与变体整体重建见右上角两个入口（#697）。</>}
      />

      <Card>
        <div className="flex flex-wrap items-end gap-2">
          <Field width="w-56" label="id / 名称">
              <Input
                value={draft.keyword}
                placeholder="支持模糊匹配"
                onChange={(event) => setDraft({ ...draft, keyword: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submitSearch();
                }}
              />
            </Field>
          <Field width="w-36" label="部位">
              <Select value={draft.slot} onChange={(event) => setDraft({ ...draft, slot: event.target.value })}>
                <option value="">全部</option>
                {slotOptions().map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </Select>
            </Field>
          <Field width="w-28" label="等级 ≥">
              <Input
                type="number"
                min={1}
                value={draft.minLevel}
                onChange={(event) => setDraft({ ...draft, minLevel: event.target.value })}
              />
            </Field>
          <Field width="w-28" label="等级 ≤">
              <Input
                type="number"
                min={1}
                value={draft.maxLevel}
                onChange={(event) => setDraft({ ...draft, maxLevel: event.target.value })}
              />
            </Field>
          <Button onClick={submitSearch}>查询</Button>
          <Button variant="outline" onClick={resetSearch}>
            重置
          </Button>
        </div>
      </Card>

      <Card
        title="装备基础件列表"
        actions={loading ? <Spinner /> : null}
        description={canWrite ? undefined : "当前角色没有「修改养成配置」权限，列表只读。"}
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>图</th>
                <th className={thClass}>id</th>
                <th className={thClass}>部位</th>
                <th className={thClass}>名称</th>
                <th className={thClass}>等级</th>
                <th className={thClass}>售卖价</th>
                <th className={thClass}>属性摘要</th>
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data?.list.map((item) => (
                <tr key={item.id} className="transition hover:bg-slate-800/30">
                  <td className={tdClass}>
                    <GameIcon path={item.icon ?? ""} alt={item.label} />
                  </td>
                  <td className={`${tdClass} font-mono text-xs text-slate-300`}>{item.id}</td>
                  <td className={tdClass}>
                    <Badge tone="slate">{slotLabel(item.slot)}</Badge>
                  </td>
                  <td className={`${tdClass} font-medium text-slate-100`}>{item.label}</td>
                  <td className={tdClass}>{item.level}</td>
                  <td className={tdClass}>{item.sellPrice}</td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{attributeSummary(item)}</td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{formatTime(item.updatedAt)}</td>
                  <td className={`${tdClass} text-right`}>
                    <Button
                      variant="outline"
                      className="px-2.5 py-1 text-xs"
                      disabled={!canWrite}
                      onClick={() => {
                        setEditing(item);
                        setDialogOpen(true);
                      }}
                    >
                      编辑
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!loading && data && data.list.length === 0 ? <EmptyState title="没有匹配的装备" description="换个筛选条件试试" /> : null}

        <Pagination page={page} size={size} total={data?.total ?? 0} onChange={setPage} onSizeChange={handleSizeChange} />
      </Card>

      <EquipmentEditDialog
        open={dialogOpen}
        initial={editing}
        onCancel={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
        onSubmit={submitDialog}
      />

      <TiersDialog open={tiersOpen} onCancel={() => setTiersOpen(false)} />

      <ConfirmDialog
        open={rebuildOpen}
        title="重新生成全部装备变体？"
        description="按当前前后缀倍率整批重算：属性 / 名称 / 穿戴等级会被覆盖；卖价保留原值（新增组合按公式垫底）。档位缩小后，被删档的变体行会消失 —— 身上还穿 / 背包还放的该档装备会变成无效引用。服务端即时生效，客户端下次拉配置生效。"
        confirmText="重新生成"
        loading={rebuilding}
        onConfirm={() => void submitRebuild()}
        onCancel={() => setRebuildOpen(false)}
      />
    </div>
  );
}
