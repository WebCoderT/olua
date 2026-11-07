import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ensureGameData,
  equipmentMetaApi,
  equipmentSlotKeys,
  equipmentVariantsApi,
  formatTime,
  occupationLabel,
  PERMISSION,
  sexLabel,
  slotLabel,
} from "../api";
import type { ConfigAttributes, EquipmentVariant, PageResult } from "../api";
import { AttributesGrid, crossedRangeKeys } from "../components/AttributesEditor";
import { FrameAnimation } from "../components/FrameAnimation";
import { GameIcon } from "../components/GameImage";
import { Modal } from "../components/Modal";
import { Pagination } from "../components/Pagination";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";
import { PageHeader } from "../components/PageHeader";

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

/** 排序可选字段（对应服务端 `EQUIPMENT_VARIANT_SORT` 的白名单；默认基础件序） */
const SORT_OPTIONS = [
  { value: "baseId", label: "基础件序" },
  { value: "level", label: "等级" },
  { value: "sellPrice", label: "回收价" },
  { value: "updatedAt", label: "更新时间" },
  { value: "id", label: "变体 id" },
];

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
 * 装备页只给「生命 / 物攻 / 物防」三项摘要，变体页把它铺满八项。排列按**元素成对**
 * （物攻 / 物防、魔攻 / 魔防、道攻 / 道防）而不是「三攻在前、三防在后」：两列网格里
 * 一行的左右两格是同一元素，扫一眼就能比攻防；区间型在两数相等时只写一个数（出厂件就是
 * 固定值，写成 `30~30` 只是噪音），全 0 的项压暗 —— #777 批量生成的那批占位件一眼看得出来。
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
          <span className="shrink-0 text-slate-500">{cell.label}</span>
          <span className={cell.zero ? "text-slate-600" : "text-slate-200"}>{cell.text}</span>
        </span>
      ))}
    </div>
  );
}

/** 只读一行（弹窗里「跟着基础件」那一段：标签 + 值） */
function ReadonlyRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2 text-xs leading-relaxed">
      <span className="w-16 shrink-0 text-slate-500">{label}</span>
      <span className="min-w-0 flex-1 break-all text-slate-300">{children}</span>
    </div>
  );
}

/**
 * 装备变体逐件配置（#655；#779 列表补全字段）
 *
 * 每件基础件展开 5 前缀 × 3 后缀 = 15 行，**每行都是最终值**。
 * 以前变体是「基础件 × 前后缀倍率」在运行时现算的，改一个基础件会连带 15 个变体一起变，
 * 运营想「只把某一件的 +4 前缀调强一点」做不到。现在每行独立可改。
 *
 * ## 列表口径：与「装备配置」页看齐，再多给几列
 * 装备页只列「图 / id / 部位 / 名称 / 等级 / 售价 / 属性摘要」。变体页是**逐行定价、逐行配属性**
 * 的地方，所以列表把变体行自己的值全部摊开：完整名称（按前后缀染色）/ 品质（文案 + 合计倍率）/
 * 部位 / 等级 / 回收价 / **八项属性全量** / 职业性别限制 / 更新时间；「全部字段」再补上
 * 基础件、标签、描述、三个资源路径。想看外观与几何（图标 / 图集 / 缩放 / 锚点 / 8 向位置）
 * 在「编辑」弹窗下半段，这些字段跟着基础件走、这里只读。
 *
 * ## 为什么筛选要多三个
 * #777 之后全库上万行（685 基础件 × 15），只靠关键字翻不动；`slot` 按部位筛、`minLevel` /
 * `maxLevel` 取等级段，排序可选等级 / 回收价 / 更新时间 —— 找「某个部位的高等级件是不是都配了值」
 * 这种问题才不用导出到表格里做。
 *
 * ## 品质文案为什么从装备规则里取
 * 前后缀的中文名（普通的 / 精良…）住在 `equipment_meta`（「装备设置」页可改），
 * 变体表只存序号 —— 文案改一次全场跟着变，不需要逐行改。
 *
 * ## 为什么不能新建 / 删除
 * 变体 id 由「基础件 × 前后缀」确定（`cloth_1_p3s2`）；删掉一行会让背包里已存在的
 * 那件装备查不到配置（客户端建表时直接缺项）。要「关掉」一件，改数值即可。
 */
export function EquipmentVariantsPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [searchParams, setSearchParams] = useSearchParams();
  /** 从「装备配置」页跳过来的 `?baseId=cloth_1` 直接落成筛选条件 */
  const initialBaseId = searchParams.get("baseId") ?? "";
  const [draft, setDraft] = useState({
    keyword: "",
    baseId: initialBaseId,
    slot: "",
    minLevel: "",
    maxLevel: "",
    sort: "baseId",
    order: "asc" as "asc" | "desc",
  });
  const [query, setQuery] = useState(draft);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [data, setData] = useState<PageResult<EquipmentVariant> | null>(null);
  const [loading, setLoading] = useState(true);
  const [quality, setQuality] = useState<QualityMeta>(EMPTY_QUALITY);
  /** 「全部字段」：多显示基础件 / 标签 / 描述 / 资源路径四列（默认关，保持一屏放得下） */
  const [wide, setWide] = useState(false);
  const [slotOptions, setSlotOptions] = useState<string[]>([]);
  const [editing, setEditing] = useState<EquipmentVariant | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(
        await equipmentVariantsApi.list({
          page,
          size,
          keyword: query.keyword || undefined,
          baseId: query.baseId || undefined,
          slot: query.slot || undefined,
          minLevel: query.minLevel === "" ? undefined : Number(query.minLevel),
          maxLevel: query.maxLevel === "" ? undefined : Number(query.maxLevel),
          sort: query.sort || undefined,
          order: query.order,
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

  /** 前端只带 `?baseId=` 一种意图；读进筛选条之后就把它从地址栏摘掉，免得刷新时覆盖手改的条件 */
  useEffect(() => {
    if (!searchParams.has("baseId")) return;
    const next = new URLSearchParams(searchParams);
    next.delete("baseId");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

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
        /* 取不到只影响文案与颜色，不影响改数值 */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /** 部位下拉的候选（顺序 = 槽位表 `sort_order`，与装备页页签同一份） */
  useEffect(() => {
    let alive = true;
    void ensureGameData().then(() => {
      if (alive) setSlotOptions(equipmentSlotKeys());
    });
    return () => {
      alive = false;
    };
  }, []);

  const submitSearch = () => {
    setPage(1);
    setQuery(draft);
  };

  const resetSearch = () => {
    const blank = { keyword: "", baseId: "", slot: "", minLevel: "", maxLevel: "", sort: "baseId", order: "asc" as const };
    setDraft(blank);
    setPage(1);
    setQuery(blank);
  };

  /** 排序是「立即生效」的：选完不用再点查询（它是列表的读法，不是筛选条件） */
  const changeSort = (sort: string) => {
    setDraft((current) => ({ ...current, sort }));
    setQuery((current) => ({ ...current, sort }));
    setPage(1);
  };

  /**
   * 部位也是「立即生效」（与装备页的部位页签同手感）：它是**收窄范围**的单选，
   * 上万行时最常用；只把 `slot` 合进已生效的条件，输入框里还没提交的关键字不跟着生效。
   */
  const changeSlot = (slot: string) => {
    setDraft((current) => ({ ...current, slot }));
    setQuery((current) => ({ ...current, slot }));
    setPage(1);
  };

  const toggleOrder = () => {
    const order = draft.order === "asc" ? "desc" : "asc";
    setDraft((current) => ({ ...current, order }));
    setQuery((current) => ({ ...current, order }));
    setPage(1);
  };

  const slotOptionsWithLabels = useMemo(
    () => slotOptions.map((slot) => ({ slot, label: slotLabel(slot) })),
    [slotOptions],
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="装备变体"
        description={
          <>
            每件基础件 15 行（5 前缀 × 3 后缀），每行都是最终数值（#655）。列表把变体行自己的全部字段摊开
            （八项属性 / 职业性别 / 品质倍率），外观与几何跟着基础件走、在「编辑」弹窗下半段只读展示。
            改哪一件就只影响哪一件；保存后服务端下一笔结算即按新值，玩家下次进游戏拉配置后同步。
          </>
        }
      />

      <Card>
        <div className="flex flex-wrap items-end gap-2">
          <Field width="w-52" label="变体 id / 名称">
            <Input
              value={draft.keyword}
              placeholder="支持模糊匹配"
              onChange={(event) => setDraft({ ...draft, keyword: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
              }}
            />
          </Field>
          <Field width="w-36" label="只看某个基础件">
            <Input
              value={draft.baseId}
              placeholder="如 cloth_1"
              onChange={(event) => setDraft({ ...draft, baseId: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
              }}
            />
          </Field>
          <Field width="w-32" label="部位">
            <Select value={draft.slot} onChange={(event) => changeSlot(event.target.value)}>
              <option value="">全部部位</option>
              {slotOptionsWithLabels.map((row) => (
                <option key={row.slot} value={row.slot}>
                  {row.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field width="w-24" label="等级 ≥">
            <Input
              type="number"
              min={1}
              value={draft.minLevel}
              onChange={(event) => setDraft({ ...draft, minLevel: event.target.value })}
            />
          </Field>
          <Field width="w-24" label="等级 ≤">
            <Input
              type="number"
              min={1}
              value={draft.maxLevel}
              onChange={(event) => setDraft({ ...draft, maxLevel: event.target.value })}
            />
          </Field>
          <Field width="w-32" label="排序">
            <Select value={draft.sort} onChange={(event) => changeSort(event.target.value)}>
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <Button variant="outline" onClick={toggleOrder} title="切换升降序（立即生效）">
            {draft.order === "asc" ? "升序 ↑" : "降序 ↓"}
          </Button>
          <Button onClick={submitSearch}>查询</Button>
          <Button variant="outline" onClick={resetSearch}>
            重置
          </Button>
          <Button variant={wide ? "primary" : "outline"} onClick={() => setWide((current) => !current)}>
            {wide ? "精简列" : "全部字段"}
          </Button>
        </div>
      </Card>

      <Card
        title="变体列表"
        actions={loading ? <Spinner /> : null}
        description={
          <span>
            共 {data?.total ?? 0} 行
            {query.slot ? ` · 部位 ${slotLabel(query.slot)}` : ""}
            {query.minLevel || query.maxLevel ? ` · 等级 ${query.minLevel || "1"}~${query.maxLevel || "∞"}` : ""}
            {canWrite ? "。「前缀 / 后缀」的中文名在「装备设置」页统一维护，这里按序号显示出文案。" : "。当前角色没有「修改养成配置」权限，列表只读。"}
          </span>
        }
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>外观</th>
                <th className={thClass}>变体 id</th>
                <th className={thClass}>名称</th>
                <th className={thClass}>品质</th>
                <th className={thClass}>部位</th>
                <th className={thClass}>等级</th>
                <th className={thClass}>回收价</th>
                <th className={thClass}>八项属性</th>
                <th className={thClass}>限制</th>
                {wide ? <th className={thClass}>标签</th> : null}
                {wide ? <th className={thClass}>描述</th> : null}
                {wide ? <th className={thClass}>资源路径</th> : null}
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data?.list.map((item) => {
                const itemQuality = qualityOf(quality, item);
                return (
                  <tr key={item.id} className="transition hover:bg-slate-800/30">
                    <td className={tdClass}>
                      {item.outAtlas ? (
                        // 外观站立动画筛 d0（8 方向挤一张表）；没配外观的装备退回静态图标
                        <FrameAnimation atlas={`${item.outAtlas}/stand`} alt={item.label} framePrefix="d0" />
                      ) : (
                        <GameIcon path={item.icon ?? ""} alt={item.label} />
                      )}
                    </td>
                    <td className={`${tdClass} font-mono text-xs text-slate-300`}>
                      <div>{item.id}</div>
                      {/* 基础件 id 可点：一键把筛选收窄到这件的 15 行（比手打 id 靠谱） */}
                      <button
                        type="button"
                        title="只看这件基础件的全部变体"
                        className="text-[11px] text-slate-500 hover:text-indigo-300"
                        onClick={() => {
                          const next = { ...draft, baseId: item.baseId };
                          setDraft(next);
                          setQuery(next);
                          setPage(1);
                        }}
                      >
                        {item.baseId}
                      </button>
                    </td>
                    <td className={`${tdClass} font-medium text-slate-100`}>
                      <VariantName item={item} quality={itemQuality} />
                    </td>
                    <td className={tdClass}>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge tone="indigo">{itemQuality.prefixLabel}</Badge>
                        <Badge tone="slate">{itemQuality.suffixLabel}</Badge>
                        <span className="text-[11px] text-slate-500">×{itemQuality.rate}</span>
                      </div>
                    </td>
                    <td className={tdClass}>
                      <Badge tone="slate">{slotLabel(item.slot)}</Badge>
                    </td>
                    <td className={tdClass}>{item.level}</td>
                    <td className={tdClass}>{item.sellPrice}</td>
                    <td className={tdClass}>
                      <AttributesCell attributes={item.attributes} />
                    </td>
                    <td className={tdClass}>
                      <div className="flex flex-wrap gap-1">
                        <Badge tone={item.occupation === OCCUPATION_ANY ? "slate" : "amber"}>{occupationLabel(item.occupation)}</Badge>
                        <Badge tone={item.sex === SEX_ANY ? "slate" : "amber"}>{sexLabel(item.sex)}</Badge>
                      </div>
                    </td>
                    {wide ? (
                      <td className={`${tdClass} text-xs`}>
                        {item.tags?.length ? (
                          <div className="flex flex-wrap gap-1">
                            {item.tags.map((tag) => (
                              <span key={tag} className="rounded bg-slate-800/80 px-1.5 py-0.5 text-[11px] text-slate-300">
                                {tag}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </td>
                    ) : null}
                    {wide ? (
                      <td className={`${tdClass} whitespace-normal`}>
                        <p
                          className="line-clamp-2 max-w-56 text-[11px] leading-snug text-slate-400"
                          title={item.description || undefined}
                        >
                          {item.description || <span className="text-slate-600">—</span>}
                        </p>
                      </td>
                    ) : null}
                    {wide ? (
                      <td className={`${tdClass} font-mono text-[11px] text-slate-400`}>
                        <div className="flex flex-col gap-0.5">
                          {[
                            { label: "图", path: item.icon },
                            { label: "内", path: item.inAtlas },
                            { label: "外", path: item.outAtlas },
                          ].map((row) => (
                            <span key={row.label} className="flex gap-1">
                              <span className="text-slate-600">{row.label}</span>
                              <span className="max-w-52 truncate" title={row.path || undefined}>
                                {row.path || "—"}
                              </span>
                            </span>
                          ))}
                        </div>
                      </td>
                    ) : null}
                    <td className={`${tdClass} text-xs text-slate-400`}>{formatTime(item.updatedAt)}</td>
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

        {!loading && data && data.list.length === 0 ? (
          <EmptyState title="没有匹配的变体" description="换个筛选条件试试（基础件 id 形如 cloth_1，部位可选）" />
        ) : null}

        <Pagination
          page={page}
          size={size}
          total={data?.total ?? 0}
          onChange={setPage}
          onSizeChange={(next) => {
            setSize(next);
            setPage(1);
          }}
        />
      </Card>

      {editing ? (
        <VariantEditDialog
          row={editing}
          quality={quality}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * 变体编辑弹窗
 *
 * 上半段**可改**：`label` / `level` / `sellPrice` / 八项属性（= 服务端 `UpdateEquipmentVariantDto`
 * 的全部字段）。下半段**只读**：图标 / 图集 / 几何 / 职业性别 / 标签 / 描述 —— 这些跟着基础件走，
 * 同一件装备的 15 个变体外观相同，在这里逐个改会立刻产生 15 份不一致。装备页那次改才是入口。
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
          编辑变体 · <span className="font-mono text-sm text-slate-400">{row.id}</span>
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
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">变体数值（可改）</h3>
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

      <section className="mt-4 flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">跟着基础件（只读）</h3>
          <span className="text-[11px] text-slate-500">同款 15 个变体共用这些值，要改去「装备配置」页</span>
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
            {row.tags?.length ? row.tags.join("、") : <span className="text-slate-600">—</span>}
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
              <span className="font-mono text-[11px] text-slate-400">{row.icon || "—"}</span>
            </span>
          </ReadonlyRow>
          <ReadonlyRow label="内观图集">
            <span className="font-mono text-[11px] text-slate-400">{row.inAtlas || "—"}</span>
          </ReadonlyRow>
          <ReadonlyRow label="外观图集">
            <span className="font-mono text-[11px] text-slate-400">{row.outAtlas || "—"}</span>
          </ReadonlyRow>
        </div>
        <ReadonlyRow label="8 向位置">
          <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-400">
            {POSITION_DIRECTIONS.map((direction, index) => (
              <span key={direction}>
                <span className="text-slate-500">{direction}</span> ({positions[index]?.x ?? 0}, {positions[index]?.y ?? 0})
              </span>
            ))}
          </span>
        </ReadonlyRow>
        <ReadonlyRow label="描述">
          {row.description?.trim() ? row.description : <span className="text-slate-600">—</span>}
        </ReadonlyRow>
      </section>

      {error ? (
        <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</p>
      ) : null}
    </Modal>
  );
}
