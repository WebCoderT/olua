import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { equipmentMetaApi, equipmentVariantsApi, formatTime, occupationLabel, PERMISSION, sexLabel, slotLabel } from "../api";
import type { ConfigAttributes, Equipment, EquipmentVariant } from "../api";
import { AttributesGrid, crossedRangeKeys } from "./AttributesEditor";
import { GameIcon } from "./GameImage";
import { Modal } from "./Modal";
import { Badge, Button, EmptyState, Field, Input, Spinner, tableClass, tdClass, thClass, theadClass } from "./ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/**
 * 前后缀的文案 / 颜色 / 倍率（「装备设置」页维护的单行表）
 *
 * 变体行只存**序号**（`prefix` / `suffix`），这几个数组按下标对齐 —— 文案改一次全场跟着变，
 * 不需要逐行改 15 个变体。列表里的「品质」列与「名称」列都按这份数据渲染，颜色也照客户端的
 * 口径分别作用在前缀段与后缀段上（`getEquipmentNameParts`）。
 */
type QualityMeta = {
  prefixLabels: string[];
  suffixLabels: string[];
  prefixColors: string[];
  suffixColors: string[];
  prefixRates: number[];
  suffixRates: number[];
};

const EMPTY_QUALITY: QualityMeta = {
  prefixLabels: [],
  suffixLabels: [],
  prefixColors: [],
  suffixColors: [],
  prefixRates: [],
  suffixRates: [],
};

/** 合法 hex 才上色（与客户端 `isHexColor` 同一判据；坏了就当没配） */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** 职业 / 性别的「不限」取值（与 `CreateEquipmentDto` 的缺省一致：职业 4 / 性别 3） */
const OCCUPATION_ANY = "4";
const SEX_ANY = "3";

/** 外观 8 向位置的显示名（与服务端 `EQUIPMENT_DIRECTIONS` 同序） */
const POSITION_DIRECTIONS = ["上", "右上", "右", "右下", "下", "左下", "左", "左上"];

/** 三种元素的属性列名前缀（`physical` → 物攻 / 物防，与客户端 `ConfigAttributes` 的键一一对应） */
const ELEMENTS = [
  { key: "physical", label: "物" },
  { key: "magic", label: "魔" },
  { key: "taoist", label: "道" },
] as const;

/** 一条变体在「品质」维度上的全部派生量（文案 / 两段颜色 / 合计倍率） */
function qualityOf(meta: QualityMeta, item: EquipmentVariant) {
  const prefixColor = meta.prefixColors[item.prefix];
  const suffixColor = meta.suffixColors[item.suffix];
  const rate = (meta.prefixRates[item.prefix] ?? 1) * (meta.suffixRates[item.suffix] ?? 1);
  return {
    prefixLabel: meta.prefixLabels[item.prefix] ?? `前缀 ${item.prefix}`,
    suffixLabel: meta.suffixLabels[item.suffix] ?? `后缀 ${item.suffix}`,
    prefixColor: prefixColor && HEX_COLOR.test(prefixColor) ? prefixColor : undefined,
    suffixColor: suffixColor && HEX_COLOR.test(suffixColor) ? suffixColor : undefined,
    /** 前后缀合计倍率（客户端展开时的乘数；变体行自己已是最终值，这里只作「贵在哪」的参照） */
    rate: Math.round(rate * 100) / 100,
  };
}

/** 名称按客户端口径分两段着色：前缀段（前缀 + 名称）= 前缀色，后缀段 = 后缀色 */
function VariantName({ item, quality }: { item: EquipmentVariant; quality: ReturnType<typeof qualityOf> }) {
  return (
    <span title={`${quality.prefixLabel}${item.label}${quality.suffixLabel}`}>
      <span style={quality.prefixColor ? { color: quality.prefixColor } : undefined}>
        {quality.prefixLabel}
        {item.label}
      </span>
      <span style={quality.suffixColor ? { color: quality.suffixColor } : undefined}>{quality.suffixLabel}</span>
    </span>
  );
}

/**
 * 八项属性（紧凑两列）
 *
 * 装备列表只给「生命 / 物攻 / 物防」三项摘要，变体弹窗把它铺满八项。排列按**元素成对**
 * （物攻 / 物防、魔攻 / 魔防、道攻 / 道防）而不是「三攻在前、三防在后」：两列网格里
 * 一行的左右两格是同一元素，扫一眼就能比攻防；区间型在两数相等时只写一个数（出厂件就是
 * 固定值，写成 `30~30` 只是噪音）。全 0 的项压暗 —— 一眼就能看出「这份数值还没配」。
 */
function AttributesCell({ attributes }: { attributes: ConfigAttributes }) {
  const range = (value: { min: number; max: number }) => ({
    text: value.min === value.max ? String(value.min) : `${value.min}~${value.max}`,
    zero: value.min === 0 && value.max === 0,
  });
  const cells = [
    { label: "生命", text: String(attributes.maxHp), zero: attributes.maxHp === 0 },
    { label: "回血", text: String(attributes.hpRecover), zero: attributes.hpRecover === 0 },
    ...ELEMENTS.flatMap((element) => [
      { label: `${element.label}攻`, ...range(attributes[`${element.key}Attack`]) },
      { label: `${element.label}防`, ...range(attributes[`${element.key}Defense`]) },
    ]),
  ];
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] leading-tight">
      {cells.map((cell) => (
        <span key={cell.label} className="flex items-baseline gap-1">
          <span className="shrink-0 text-ink-5">{cell.label}</span>
          <span className={cell.zero ? "text-ink-6" : "text-ink-2"}>{cell.text}</span>
        </span>
      ))}
    </div>
  );
}

/** 只读一行（弹窗里「跟着基础件」那一段：标签 + 值） */
function ReadonlyRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2 text-xs leading-relaxed">
      <span className="w-16 shrink-0 text-ink-5">{label}</span>
      <span className="min-w-0 flex-1 break-all text-ink-3">{children}</span>
    </div>
  );
}

/**
 * 一件装备的全部变体（#781：从「装备变体」独立页改成弹窗）
 *
 * 以前变体是单独一页，进那一页要先想「我要看哪个部位、哪个等级段」，再从上万行里翻；
 * 实际用法几乎总是「这件装备的 15 档长什么样」。所以入口收回到装备列表：列表上显示
 * 「N 个变体」，点开就是这个弹窗 —— 一整页的筛选/分页/排序都不需要了，15 行一屏看完。
 *
 * 变体仍是**逐行独立**的最终值（#655）：改哪一行只影响那一行，不是「基础件 × 倍率」现算。
 * 外观 / 图集 / 几何 / 职业性别这些跟着基础件走的字段不在这里改（同一件装备的 15 个变体
 * 共用一份，逐个改只会产生 15 份不一致），编辑弹窗里只读展示。
 */
export function EquipmentVariantsDialog({
  equipment,
  onClose,
  onChanged,
}: {
  /** null = 关闭；给哪件就显示哪件的变体 */
  equipment: Equipment | null;
  onClose: () => void;
  /** 改完任一变体后通知外层刷新列表（列表上的「属性摘要」取自基础件，通常不用刷，留着给以后用） */
  onChanged?: () => void;
}) {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [rows, setRows] = useState<EquipmentVariant[]>([]);
  /** 变体总数（服务端报的；一页放得下时与 rows.length 相等） */
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [quality, setQuality] = useState<QualityMeta>(EMPTY_QUALITY);
  const [editing, setEditing] = useState<EquipmentVariant | null>(null);

  /** 品质文案 / 颜色 / 倍率：一次拉齐（改文案在「装备设置」页） */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const meta = await equipmentMetaApi.get();
        if (!alive) return;
        setQuality({
          prefixLabels: meta.prefixLabels ?? [],
          suffixLabels: meta.suffixLabels ?? [],
          prefixColors: meta.prefixColors ?? [],
          suffixColors: meta.suffixColors ?? [],
          prefixRates: meta.prefixRates ?? [],
          suffixRates: meta.suffixRates ?? [],
        });
      } catch {
        /* 取不到只影响文案与颜色，不影响看数值 */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!equipment) return;
    setLoading(true);
    try {
      // 一件基础件的变体行数 = 前缀档数 × 后缀档数（出厂 15）；上限给到接口允许的最大页
      // （100），量产档位下也够一屏看完 —— 分页在「15 行」的量级上纯属噪音
      const page = await equipmentVariantsApi.list({ baseId: equipment.id, size: 100 });
      setRows(page.list);
      setTotal(page.total);
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [equipment]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 关弹窗时顺手清掉编辑态：下次点开别的装备不该带着上一件的编辑框 */
  useEffect(() => {
    if (!equipment) setEditing(null);
  }, [equipment]);

  if (!equipment) return null;

  const zeroCount = rows.filter((row) => isAllZero(row.attributes)).length;

  return (
    <>
      <Modal
        open
        size="xl"
        title={
          <>
            变体 · {equipment.label}
            <span className="ml-2 font-mono text-xs text-ink-5">{equipment.id}</span>
          </>
        }
        hint={
          <>
            部位 {slotLabel(equipment.slot)} · 共 {total} 个变体
            {total > rows.length ? `（列表只显示前 ${rows.length} 条）` : ""}
            {zeroCount > 0 ? `（其中 ${zeroCount} 个八项属性还是 0，待配）` : ""}。
            每个变体都是**最终值**，改哪一行只影响那一行；品质文案在「装备设置」页统一维护。
          </>
        }
        /* 编辑某个变体时 Esc 只关里面那层（改成在这里拦一下，Modal 自己只管 Keydown） */
        onClose={() => {
          if (!editing) onClose();
        }}
        footer={
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        }
      >
        <div className="max-h-[60vh] overflow-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>变体 id</th>
                <th className={thClass}>名称</th>
                <th className={thClass}>品质</th>
                <th className={thClass}>等级</th>
                <th className={thClass}>回收价</th>
                <th className={thClass}>八项属性</th>
                <th className={thClass}>限制</th>
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => {
                const itemQuality = qualityOf(quality, item);
                return (
                  <tr key={item.id} className="transition hover:bg-surface-4/30">
                    <td className={`${tdClass} font-mono text-xs text-ink-3`}>{item.id}</td>
                    <td className={`${tdClass} font-medium text-ink-1`}>
                      <VariantName item={item} quality={itemQuality} />
                    </td>
                    <td className={tdClass}>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge tone="gold">{itemQuality.prefixLabel}</Badge>
                        <Badge tone="muted">{itemQuality.suffixLabel}</Badge>
                        <span className="text-[11px] text-ink-5">×{itemQuality.rate}</span>
                      </div>
                    </td>
                    <td className={tdClass}>{item.level}</td>
                    <td className={tdClass}>{item.sellPrice}</td>
                    <td className={tdClass}>
                      <AttributesCell attributes={item.attributes} />
                    </td>
                    <td className={tdClass}>
                      <div className="flex flex-wrap gap-1">
                        <Badge tone={item.occupation === OCCUPATION_ANY ? "muted" : "warn"}>{occupationLabel(item.occupation)}</Badge>
                        <Badge tone={item.sex === SEX_ANY ? "muted" : "warn"}>{sexLabel(item.sex)}</Badge>
                      </div>
                    </td>
                    <td className={`${tdClass} text-xs text-ink-4`}>{formatTime(item.updatedAt)}</td>
                    <td className={`${tdClass} text-right`}>
                      <Button
                        variant="outline"
                        className="px-2.5 py-1 text-xs"
                        disabled={!canWrite}
                        onClick={() => setEditing(item)}
                      >
                        编辑
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {loading ? (
          <div className="flex justify-center py-4">
            <Spinner />
          </div>
        ) : null}
        {!loading && rows.length === 0 ? (
          <EmptyState
            title="这件装备还没有变体"
            description="变体是客户端真正认得的东西。去「装备配置」页点「重新生成变体」，或在「装备设置」里检查前后缀档数。"
          />
        ) : null}
      </Modal>

      {editing ? (
        <VariantEditDialog
          row={editing}
          quality={quality}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
            onChanged?.();
          }}
        />
      ) : null}
    </>
  );
}

/** 八项属性是否全 0（#777 批量生成的那批占位件；列表上给个提示，避免以为「没有属性这一栏」） */
function isAllZero(attributes: ConfigAttributes): boolean {
  const ranges = [attributes.physicalAttack, attributes.physicalDefense, attributes.magicAttack, attributes.magicDefense, attributes.taoistAttack, attributes.taoistDefense];
  return attributes.maxHp === 0 && attributes.hpRecover === 0 && ranges.every((range) => range.min === 0 && range.max === 0);
}

/**
 * 变体编辑弹窗
 *
 * 上半段**可改**：`label` / `level` / `sellPrice` / 八项属性（= 服务端 `UpdateEquipmentVariantDto`
 * 的全部字段）。下半段**只读**：图标 / 图集 / 几何 / 职业性别 / 标签 / 描述 —— 这些跟着基础件走，
 * 同一件装备的 15 个变体外观相同，在这里逐个改会立刻产生 15 份不一致。装备配置页那次改才是入口。
 */
function VariantEditDialog({
  row,
  quality: meta,
  onClose,
  onSaved,
}: {
  row: EquipmentVariant;
  quality: QualityMeta;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(row.label);
  const [level, setLevel] = useState(String(row.level));
  const [sellPrice, setSellPrice] = useState(String(row.sellPrice));
  const [attributes, setAttributes] = useState<ConfigAttributes>({ ...row.attributes });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const crossed = useMemo(() => crossedRangeKeys(attributes), [attributes]);
  const quality = qualityOf(meta, row);
  const fullName = `${quality.prefixLabel}${label.trim() || row.label}${quality.suffixLabel}`;
  const positions = row.outPositions ?? [];

  const levelValid = /^\d+$/.test(level.trim()) && Number(level) >= 1;
  const priceValid = /^\d+$/.test(sellPrice.trim()) && Number(sellPrice) >= 0;
  const labelValid = label.trim().length > 0 && label.trim().length <= 50;
  const canSave = labelValid && levelValid && priceValid && crossed.length === 0 && !saving;

  const save = async () => {
    if (!canSave) {
      setError("名称需为 1~50 字、等级 ≥ 1、回收价 ≥ 0 的整数，且六项区间下限不能大于上限。");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await equipmentVariantsApi.update(row.id, {
        label: label.trim(),
        level: Number(level),
        sellPrice: Number(sellPrice),
        attributes,
      });
      toastSuccess(`变体「${label.trim()}」已保存（服务端下一笔结算即按新值；玩家下次进游戏拉配置后同步）`);
      onSaved();
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      size="lg"
      title={
        <>
          编辑变体 · <span className="font-mono text-sm text-ink-4">{row.id}</span>
        </>
      }
      hint={
        <>
          完整名称：{fullName}（{quality.prefixLabel} ×{meta.prefixRates[row.prefix] ?? 1} ·{" "}
          {quality.suffixLabel} ×{meta.suffixRates[row.suffix] ?? 1}）。品质文案在「装备设置」页改；
          图标 / 图集 / 几何 / 职业性别跟着基础件 {row.baseId} 走，在「装备配置」页改。
        </>
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            取消
          </Button>
          <Button disabled={!canSave} loading={saving} onClick={() => void save()}>
            保存修改
          </Button>
        </>
      }
    >
      <section className="flex flex-col gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-4">变体数值（可改）</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="名称" hint="基础名，不含前后缀文案">
            <Input value={label} onChange={(event) => setLabel(event.target.value)} />
          </Field>
          <Field label="穿戴需求等级">
            <Input value={level} inputMode="numeric" onChange={(event) => setLevel(event.target.value)} />
          </Field>
          <Field label="回收价（绑定元宝）">
            <Input value={sellPrice} inputMode="numeric" onChange={(event) => setSellPrice(event.target.value)} />
          </Field>
        </div>
        <AttributesGrid attributes={attributes} onChange={setAttributes} header="八项属性（整份替换）" crossed={crossed} />
      </section>

      <section className="mt-4 flex flex-col gap-2 rounded-xl border border-line bg-surface-2/40 px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-4">跟着基础件（只读）</h3>
          <span className="text-[11px] text-ink-5">同款变体共用这些值，要改去「装备配置」页</span>
        </div>
        <div className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
          <ReadonlyRow label="部位">{slotLabel(row.slot)}</ReadonlyRow>
          <ReadonlyRow label="所属基础件">
            <span className="font-mono">{row.baseId}</span>
          </ReadonlyRow>
          <ReadonlyRow label="职业 / 性别">
            {occupationLabel(row.occupation)} · {sexLabel(row.sex)}
          </ReadonlyRow>
          <ReadonlyRow label="品质">
            {quality.prefixLabel} · {quality.suffixLabel}（合计 ×{quality.rate}）
          </ReadonlyRow>
          <ReadonlyRow label="标签">
            {row.tags?.length ? row.tags.join("、") : <span className="text-ink-6">—</span>}
          </ReadonlyRow>
          <ReadonlyRow label="缩放 / 旋转">
            外观 ×{row.outScale} · 内观 ×{row.inScaleX} / ×{row.inScaleY} · 旋转 {row.inRotate}°
          </ReadonlyRow>
          <ReadonlyRow label="内观锚点">
            ({row.inPosX}, {row.inPosY})
          </ReadonlyRow>
          <ReadonlyRow label="图标">
            <span className="flex items-center gap-2">
              <GameIcon path={row.icon ?? ""} alt={row.label} size={28} />
              <span className="font-mono text-[11px] text-ink-4">{row.icon || "—"}</span>
            </span>
          </ReadonlyRow>
          <ReadonlyRow label="内观图集">
            <span className="font-mono text-[11px] text-ink-4">{row.inAtlas || "—"}</span>
          </ReadonlyRow>
          <ReadonlyRow label="外观图集">
            <span className="font-mono text-[11px] text-ink-4">{row.outAtlas || "—"}</span>
          </ReadonlyRow>
        </div>
        <ReadonlyRow label="8 向位置">
          <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-ink-4">
            {POSITION_DIRECTIONS.map((direction, index) => (
              <span key={direction}>
                <span className="text-ink-5">{direction}</span> ({positions[index]?.x ?? 0}, {positions[index]?.y ?? 0})
              </span>
            ))}
          </span>
        </ReadonlyRow>
        <ReadonlyRow label="描述">
          {row.description?.trim() ? row.description : <span className="text-ink-6">—</span>}
        </ReadonlyRow>
      </section>

      {error ? (
        <p className="mt-3 rounded-lg border border-ember/40 bg-ember/10 px-3 py-2 text-xs text-ember-hi">{error}</p>
      ) : null}
    </Modal>
  );
}
