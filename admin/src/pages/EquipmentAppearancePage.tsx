import { useCallback, useEffect, useMemo, useState } from "react";
import { equipmentAppearanceApi, equipmentMetaApi, formatTime, PERMISSION } from "../api";
import type { CustomAppearance, EquipmentAppearance, EquipmentMeta, UpdateEquipmentAppearance } from "../api";
import { Button, Card, Field, Input, Spinner } from "../components/ui";
import { PageHeader } from "../components/PageHeader";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/**
 * 装备外观（#695）：装备边框 + 详情背景的「谁用哪个 key」
 *
 * 这两张表以前写在客户端源码里（`configs/border` / `configs/background` 的 15 组映射 +
 * 特殊装备自定义表），运营想换某个品质的光效、给某件神装单独配边框，都要重打客户端包。
 * 现在整份搬到服务端，玩家下次进游戏拉配置快照时生效。
 *
 * ## 边框 / 背景 key 是什么
 * 客户端资源包里的素材编号：边框 = `resources/borders/sfx_<编号>_0` 图集（长什么样见客户端
 * `tools/border-preview.png` 编号索引图），背景 = `resources/backgrounds/sfx_<编号>` 帧序列目录。
 * 服务端只存 key 字符串，**不校验素材存在** —— 填了资源包里没有的编号，客户端会安静跳过
 * （那个品质没有边框 / 详情弹窗保持静态底图），不会报错也不会白屏。
 *
 * ## 前后缀映射是「档数棋盘」
 * 行 = 后缀档、列 = 前缀档（#697 起档位可在「装备配置」页增删，棋盘大小跟着 equipment_meta
 * 走，不再写死 5×3），每一格都必须有值（缺哪格哪个品质就没光效），保存时服务端会整份校验。
 * 特殊装备自定义是可增删的小表：装备填变体 id（如 `weapon_20_p4s2`）只影响那一个变体，
 * 填基础件 key（如 `weapon_20`）影响它的全部前后缀变体，且优先于棋盘。
 */
export function EquipmentAppearancePage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [saved, setSaved] = useState<EquipmentAppearance | null>(null);
  const [meta, setMeta] = useState<EquipmentMeta | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  /** 档位标签（棋盘的行列头）；meta 没拉到时按空清单渲染（loading 态会兜住） */
  const prefixLabels = meta?.prefixLabels ?? [];
  const suffixLabels = meta?.suffixLabels ?? [];

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [data, metaRow] = await Promise.all([equipmentAppearanceApi.get(), equipmentMetaApi.get()]);
      setSaved(data);
      setMeta(metaRow);
      setDraft(toDraft(data, metaRow.prefixLabels.length, metaRow.suffixLabels.length));
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 棋盘格：15 组合按「后缀档 → 前缀」排布 */
  const setCombo = (kind: "borders" | "backgrounds", comboIndex: number, key: string) => {
    setDraft((current) => {
      if (!current) return current;
      const next = { ...current, [kind]: current[kind].slice() } as Draft;
      next[kind][comboIndex] = key;
      return next;
    });
  };

  const setCustom = (kind: "customBorders" | "customBackgrounds", index: number, field: keyof CustomAppearance, value: string) => {
    setDraft((current) => {
      if (!current) return current;
      const rows = current[kind].slice();
      rows[index] = { ...rows[index], [field]: value };
      return { ...current, [kind]: rows } as Draft;
    });
  };

  const appendCustom = (kind: "customBorders" | "customBackgrounds") => {
    setDraft((current) => (current ? ({ ...current, [kind]: [...current[kind], { equipment: "", key: "" }] } as Draft) : current));
  };

  const removeCustom = (kind: "customBorders" | "customBackgrounds", index: number) => {
    setDraft((current) => (current ? ({ ...current, [kind]: current[kind].filter((_, i) => i !== index) } as Draft) : current));
  };

  /** 逐项体检：key 格式 / 自定义装备唯一 —— 服务端也会拒，但先在这里把按钮拦住 */
  const invalid = useMemo(() => describeInvalid(draft, prefixLabels.length), [draft, prefixLabels.length]);

  const save = async () => {
    if (!draft || !meta) return;
    const payload = buildPayload(draft, meta.prefixLabels.length);
    if (!payload) return;
    setSaving(true);
    try {
      const data = await equipmentAppearanceApi.update(payload);
      setSaved(data);
      setDraft(toDraft(data, meta.prefixLabels.length, meta.suffixLabels.length));
      toastSuccess("装备外观已保存（玩家下次进游戏拉配置后生效）");
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="装备外观"
        description={
          <>
            装备边框（背包格子上的品质光效框）与详情背景（物品详情弹窗的品质背景动画）的「谁用哪个」。
            素材本体在客户端资源包里，这里只改映射：换某个品质的光效、给特殊装备单独配光效，都不用重打客户端包。
            {saved ? <span className="ml-1 text-slate-500">上次修改：{formatTime(saved.updatedAt)}</span> : null}
          </>
        }
      />

      <Card
        title={`前后缀品质映射（${prefixLabels.length * suffixLabels.length} 格棋盘）`}
        actions={
          loading ? (
            <Spinner />
          ) : canWrite ? (
            <Button disabled={!draft || saving || invalid !== null} loading={saving} onClick={() => void save()}>
              保存全部
            </Button>
          ) : null
        }
        description={
          canWrite
            ? `行 = 后缀（${suffixLabels.join(" / ") || "—"}），列 = 前缀（${prefixLabels.join(" → ") || "—"}）。每格都必须有 key：缺哪格，哪个品质就没有边框 / 背景。保存是整份替换（棋盘 + 两张自定义表一起提交）。档位在「装备配置」页的前后缀弹窗里增删。`
            : "当前角色没有「修改养成配置」权限，本页只读。"
        }
      >
        {draft ? (
          <div className="flex flex-col gap-6">
            {invalid ? <p className="text-xs text-amber-400">{invalid}</p> : null}
            <ComboGrid
              label="装备边框"
              hint="resources/borders 下的图集名，如 sfx_30123_0"
              placeholder="sfx_30123_0"
              prefixLabels={prefixLabels}
              suffixLabels={suffixLabels}
              values={draft.borders}
              disabled={!canWrite}
              onChange={(combo, key) => setCombo("borders", combo, key)}
            />
            <ComboGrid
              label="详情背景"
              hint="resources/backgrounds 下的帧序列目录名，如 sfx_16000"
              placeholder="sfx_16000"
              prefixLabels={prefixLabels}
              suffixLabels={suffixLabels}
              values={draft.backgrounds}
              disabled={!canWrite}
              onChange={(combo, key) => setCombo("backgrounds", combo, key)}
            />
          </div>
        ) : null}
      </Card>

      {draft ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <CustomList
            title="特殊装备 · 边框"
            description="优先于棋盘。装备填变体 id（weapon_20_p4s2）只影响那个变体；填基础件 key（weapon_20）影响全部变体。"
            rows={draft.customBorders}
            keyPlaceholder="sfx_30206_0"
            disabled={!canWrite}
            onChange={(index, field, value) => setCustom("customBorders", index, field, value)}
            onAppend={() => appendCustom("customBorders")}
            onRemove={(index) => removeCustom("customBorders", index)}
          />
          <CustomList
            title="特殊装备 · 详情背景"
            description="优先于棋盘。写给特殊装备的专属弹窗背景（剩余未分配的背景编号都可以用在这里）。"
            rows={draft.customBackgrounds}
            keyPlaceholder="sfx_16040"
            disabled={!canWrite}
            onChange={(index, field, value) => setCustom("customBackgrounds", index, field, value)}
            onAppend={() => appendCustom("customBackgrounds")}
            onRemove={(index) => removeCustom("customBackgrounds", index)}
          />
        </div>
      ) : null}
    </div>
  );
}

//#region 棋盘与自定义表

/** combo 下标（后缀档优先，档内前缀递增）—— 与服务端出厂值的展开顺序一致 */
const comboIndex = (prefix: number, suffix: number, prefixCount: number) => suffix * prefixCount + prefix;

function ComboGrid(props: {
  label: string;
  hint: string;
  placeholder: string;
  /** 前缀列头（档位文案，来自 equipment_meta；#697 起档数可配） */
  prefixLabels: string[];
  /** 后缀行头 */
  suffixLabels: string[];
  values: string[];
  disabled: boolean;
  onChange: (combo: number, key: string) => void;
}) {
  const prefixCount = Math.max(props.prefixLabels.length, 1);
  return (
    <div>
      <h3 className="mb-1 text-sm font-medium text-slate-300">{props.label}</h3>
      <p className="mb-2 text-xs text-slate-500">{props.hint}</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-separate border-spacing-1">
          <thead>
            <tr>
              <th className="w-16 text-xs font-normal text-slate-500">后缀 \ 前缀</th>
              {props.prefixLabels.map((prefix) => (
                <th key={prefix} className="text-xs font-normal text-slate-400">
                  {prefix}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {props.suffixLabels.map((suffix, s) => (
              <tr key={suffix}>
                <td className="text-xs text-slate-400">{suffix}</td>
                {props.prefixLabels.map((_, p) => {
                  const combo = comboIndex(p, s, prefixCount);
                  return (
                    <td key={combo}>
                      <Input
                        value={props.values[combo] ?? ""}
                        placeholder={props.placeholder}
                        disabled={props.disabled}
                        onChange={(event) => props.onChange(combo, event.target.value)}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CustomList(props: {
  title: string;
  description: string;
  rows: CustomAppearance[];
  keyPlaceholder: string;
  disabled: boolean;
  onChange: (index: number, field: keyof CustomAppearance, value: string) => void;
  onAppend: () => void;
  onRemove: (index: number) => void;
}) {
  return (
    <Card
      title={`${props.title}（${props.rows.length} 条）`}
      description={props.description}
      actions={
        props.disabled ? null : (
          <Button variant="ghost" onClick={props.onAppend}>
            添加一条
          </Button>
        )
      }
    >
      {props.rows.length === 0 ? <p className="text-sm text-slate-400">还没有自定义条目（所有装备走上面的棋盘）。</p> : null}
      <div className="flex flex-col gap-3">
        {props.rows.map((row, index) => (
          <div key={index} className="grid grid-cols-1 items-end gap-3 rounded border border-slate-700/60 p-3 sm:grid-cols-[2fr_2fr_auto]">
            <Field label="装备标识" hint="变体 id 或基础件 key">
              <Input value={row.equipment} disabled={props.disabled} onChange={(event) => props.onChange(index, "equipment", event.target.value)} />
            </Field>
            <Field label="key" hint={props.keyPlaceholder}>
              <Input value={row.key} placeholder={props.keyPlaceholder} disabled={props.disabled} onChange={(event) => props.onChange(index, "key", event.target.value)} />
            </Field>
            {props.disabled ? null : (
              <Button variant="ghost" onClick={() => props.onRemove(index)}>
                删除
              </Button>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

//#endregion

//#region 草稿 ↔ 提交体

type Draft = {
  borders: string[];
  backgrounds: string[];
  customBorders: CustomAppearance[];
  customBackgrounds: CustomAppearance[];
};

/** 服务端顺序（prefix,suffix 升序）→ 棋盘顺序（后缀档优先）；服务端顺序与 comboIndex 一致，直接映射 */
function toDraft(data: EquipmentAppearance, prefixCount: number, suffixCount: number): Draft {
  const byCombo = (rows: { prefix: number; suffix: number; key: string }[]) => {
    const values = Array.from({ length: prefixCount * suffixCount }, () => "");
    for (const row of rows) {
      const p = Number(row.prefix);
      const s = Number(row.suffix);
      if (p >= 0 && p < prefixCount && s >= 0 && s < suffixCount) values[comboIndex(p, s, prefixCount)] = row.key;
    }
    return values;
  };
  return {
    borders: byCombo(data.borders ?? []),
    backgrounds: byCombo(data.backgrounds ?? []),
    customBorders: data.customBorders ?? [],
    customBackgrounds: data.customBackgrounds ?? [],
  };
}

const BORDER_KEY = /^sfx_\d+_0$/;
const BACKGROUND_KEY = /^sfx_\d+$/;
const EQUIPMENT_ID = /^[A-Za-z0-9_\-]+$/;

/** 返回第一条问题（null = 没问题）。服务端也会校验，这里只是让按钮先别让人白点 */
function describeInvalid(draft: Draft | null, prefixCount: number): string | null {
  if (!draft) return null;
  const where = (combo: number) => `第 ${Math.floor(combo / prefixCount) + 1} 行第 ${(combo % prefixCount) + 1} 列`;
  const seenCombos = new Set<number>();
  for (const [combo, key] of draft.borders.entries()) {
    if (seenCombos.has(combo)) return `边框棋盘第 ${combo + 1} 格重复登记（不应发生，请刷新页面）`;
    seenCombos.add(combo);
    if (!key.trim()) return `边框棋盘有一格空着（${where(combo)}）—— 缺哪格哪个品质就没边框。`;
    if (!BORDER_KEY.test(key.trim())) return `边框棋盘${where(combo)}的 key「${key}」格式不对（应为 sfx_30123_0 这样的图集名）。`;
  }
  for (const [combo, key] of draft.backgrounds.entries()) {
    if (!key.trim()) return `背景棋盘有一格空着（${where(combo)}）—— 缺哪格哪个品质就没背景。`;
    if (!BACKGROUND_KEY.test(key.trim())) return `背景棋盘${where(combo)}的 key「${key}」格式不对（应为 sfx_16000 这样的目录名）。`;
  }
  const checkCustoms = (rows: CustomAppearance[], label: string) => {
    const seen = new Set<string>();
    for (const [index, row] of rows.entries()) {
      if (!row.equipment.trim()) return `${label}第 ${index + 1} 条没有填装备标识。`;
      if (!EQUIPMENT_ID.test(row.equipment.trim())) return `${label}第 ${index + 1} 条的装备标识「${row.equipment}」只能用字母、数字、下划线与短横线。`;
      if (seen.has(row.equipment.trim())) return `${label}第 ${index + 1} 条的装备「${row.equipment}」重复了。`;
      seen.add(row.equipment.trim());
      if (!row.key.trim()) return `${label}第 ${index + 1} 条没有填 key。`;
    }
    return null;
  };
  return checkCustoms(draft.customBorders, "边框自定义表") ?? checkCustoms(draft.customBackgrounds, "背景自定义表");
}

/**
 * 草稿 → 提交体（**逐字段显式列**：多带的键会被服务端白名单剥掉，显式列拼错在类型层就红）
 *
 * 棋盘格的 trim 在这里做（输入框里贴进来带空格是常态）；格式校验交给 describeInvalid 拦按钮。
 */
function buildPayload(draft: Draft, prefixCount: number): UpdateEquipmentAppearance | null {
  const toCombos = (values: string[]) =>
    values.map((key, combo) => ({ prefix: combo % prefixCount, suffix: Math.floor(combo / prefixCount), key: key.trim() }));
  const toCustoms = (rows: CustomAppearance[]) =>
    rows.map((row) => ({ equipment: row.equipment.trim(), key: row.key.trim() }));
  return {
    borders: toCombos(draft.borders),
    backgrounds: toCombos(draft.backgrounds),
    customBorders: toCustoms(draft.customBorders),
    customBackgrounds: toCustoms(draft.customBackgrounds),
  };
}

//#endregion
