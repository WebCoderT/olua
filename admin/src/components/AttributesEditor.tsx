import { Input } from "./ui";

/** 区间型属性的六项（与 ConfigAttributes / MonsterAttributes 的区间字段一一对应；展示名在这里） */
export const RANGE_FIELDS = [
  { key: "physicalAttack", label: "物攻" },
  { key: "magicAttack", label: "魔攻" },
  { key: "taoistAttack", label: "道攻" },
  { key: "physicalDefense", label: "物防" },
  { key: "magicDefense", label: "魔防" },
  { key: "taoistDefense", label: "道防" },
] as const;

export type RangeKey = (typeof RANGE_FIELDS)[number]["key"];

/** 区间交叉（min > max）的键集合；空 = 合法（即时提示用，权威在服务端 DTO） */
export function crossedRangeKeys(attributes: Record<RangeKey, { min: number; max: number }>): string[] {
  return RANGE_FIELDS.filter(({ key }) => attributes[key].min > attributes[key].max).map(({ key }) => key);
}

/** 数值输入统一口径：非负整数 */
const toCount = (value: string) => Math.max(0, Math.floor(Number(value) || 0));

/** 标量行（有 maxHp 字段的配置才显示；怪物属性只有六项区间） */
const SCALAR_ROWS: ReadonlyArray<{ key: "maxHp" | "hpRecover"; label: string }> = [
  { key: "maxHp", label: "生命上限" },
  { key: "hpRecover", label: "每 5 秒回血" },
];

/**
 * 属性编辑网格（称号 / 战魂 / 军衔 / 装备 / 时装 / 怪物六处编辑表单共用）
 *
 * 通用形状：标题 + 网格（可选 maxHp / hpRecover 两行 + 六项攻防区间）+ 越界提示。
 * 属性一律**整份提交、整份替换**（服务端口径），所以八项全部展示、全部回填。
 * `onChange` 收整份新对象；越界集合由调用方算好传入（canSubmit 也要用同一份）。
 */
export function AttributesGrid<A extends { maxHp?: number; hpRecover?: number } & Record<RangeKey, { min: number; max: number }>>({
  attributes,
  onChange,
  header,
  crossed,
}: {
  attributes: A;
  onChange: (next: A) => void;
  /** 网格上方的说明标题（各表单措辞不同：属性加成 / 基础属性 / 六项攻防区间…） */
  header: string;
  /** 越界（min > max）的属性键集合，非空时在网格下标红 */
  crossed: string[];
}) {
  const setRange = (key: RangeKey, side: "min" | "max", value: string) => {
    const parsed = toCount(value);
    onChange({ ...attributes, [key]: { ...attributes[key], [side]: parsed } });
  };

  return (
    <div>
      <span className="mb-2 block text-xs font-medium text-slate-400">{header}</span>
      <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-800 bg-slate-950/40 p-4 sm:grid-cols-2">
        {"maxHp" in attributes
          ? SCALAR_ROWS.map(({ key, label }) => (
              <div key={key} className="flex items-center justify-between gap-2">
                <span className="text-xs text-slate-400">{label}</span>
                <Input
                  type="number"
                  min={0}
                  className="w-28"
                  value={attributes[key] ?? 0}
                  onChange={(event) => onChange({ ...attributes, [key]: toCount(event.target.value) })}
                />
              </div>
            ))
          : null}
        {RANGE_FIELDS.map(({ key, label: fieldLabel }) => (
          <div key={key} className="flex items-center justify-between gap-2">
            <span className="text-xs text-slate-400">{fieldLabel}</span>
            <div className="flex items-center gap-1">
              <Input
                type="number"
                min={0}
                className="w-20"
                aria-label={`${fieldLabel}下限`}
                value={attributes[key].min}
                onChange={(event) => setRange(key, "min", event.target.value)}
              />
              <span className="text-xs text-slate-600">~</span>
              <Input
                type="number"
                min={0}
                className="w-20"
                aria-label={`${fieldLabel}上限`}
                value={attributes[key].max}
                onChange={(event) => setRange(key, "max", event.target.value)}
              />
            </div>
          </div>
        ))}
      </div>

      {crossed.length > 0 ? (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          以下属性的下限不能大于上限：{crossed.join("、")}。
        </p>
      ) : null}
    </div>
  );
}
