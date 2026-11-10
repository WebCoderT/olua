import { useCallback, useEffect, useState } from "react";
import { equipmentMetaApi, equipmentSlotKeys, formatTime, mallApi, PERMISSION, slotLabel } from "../api";
import type { MallCatalogItem, MallCatalogPage, MallCategory, MallGoodItem, MallGoodPage } from "../api";
import { GameIcon } from "../components/GameImage";
import { Modal } from "../components/Modal";
import { Pagination } from "../components/Pagination";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";
import { PageHeader } from "../components/PageHeader";

const MALL_PRICE_MAX = 100_000_000;
const MALL_LEVEL_MAX = 10_000;
/** 每日限购上限（服务端 MALL_DAILY_LIMIT_MAX 同一口径；0 = 不限购） */
const MALL_DAILY_LIMIT_MAX = 100_000;
/** 库存上限（服务端 MALL_STOCK_MAX 同一口径）；-1 = 不限量，0 = 售罄停售 */
const MALL_STOCK_MAX = 100_000_000;
const MALL_STOCK_UNLIMITED = -1;
/** 上架弹窗「物品分类」下拉里表示药品的那一项（服务端同一取值，见 MALL_CATEGORY_DRUG） */
const DRUG_CATEGORY = "drug";
/** 上架弹窗候选列表每页条数（566 件装备 + 11 种药，必须分页） */
const CATALOG_PAGE_SIZE = 8;
/** 新建分类缺省排序值的哨兵（>= 这个值就是「排到最后」，服务端建行时同一个口径） */
const AUTO_SORT = 900_000_000;

/** 分类管理弹窗里一行的草稿（名称 + 排序；排序空串 = 新建时排到最后 / 修改时不改） */
interface CategoryDraft {
  label: string;
  sortOrder: string;
}

const sortOrderTextOf = (row: MallCategory) => (row.sortOrder >= AUTO_SORT ? "" : String(row.sortOrder));

/** 分类列表 → 弹窗里的可编辑草稿（每次读写分类后重建，草稿不跨请求残留） */
function draftsOf(list: MallCategory[]): Record<string, CategoryDraft> {
  const drafts: Record<string, CategoryDraft> = {};
  list.forEach((row) => {
    drafts[row.id] = { label: row.label, sortOrder: sortOrderTextOf(row) };
  });
  return drafts;
}

/**
 * 草稿字符串 → 提交值（#846 每日限购 / 库存）
 *
 * 空串按默认值算：限购 0（不限购）、库存 -1（不限量）。运营清空输入框的意思通常是
 * 「这条规则不要了」，不是「卖 0 件」—— 真要停售是把库存填 0，那个写法在提示里说了。
 * 负数（库存）与非数字一律按默认值：宁可少一条限制，也不要把商品配成买不了。
 */
const dailyLimitOf = (text: string): number => {
  const value = Math.floor(Number(text));
  if (text.trim() === "" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, MALL_DAILY_LIMIT_MAX);
};

const stockOf = (text: string): number => {
  const value = Math.floor(Number(text));
  if (text.trim() === "" || !Number.isFinite(value) || value < 0) return MALL_STOCK_UNLIMITED;
  return Math.min(value, MALL_STOCK_MAX);
};

/**
 * 商城管理（#251 / #758 / #763 / #765，运营陈列页）
 *
 * 两件事分开管：
 * - **分类**是商城的**陈列分组**（与物品自己的分类 —— 武器 / 衣服 / 药品 —— 无关），
 *   在「管理分类」弹窗里增删改：改名、调排序（值小者在先）、删空分类（非空 409 `50028`）。
 * - **商品**是**关联数据**：从可上架目录（装备变体 + 药品）里挑一件挂到某个商城分类下，
 *   之后只许改商城自己的字段 —— 所属分类 / 售价 / 购买等级 / 每日限购 / 库存；名称 / 图标 / 部位 / 等级
 *   归各自的配置页管。下架 = 删行，本体不受影响。
 *
 * 主界面就是一张商品表 + 一条检索条（商城分类 / 物品等级 / 名称或 id），
 * 客户端陈列与购买以服务端为准。写操作要 `gameConfig:write`。
 */
export function MallPricingPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);

  // —— 分类（管理弹窗里增删改；主界面只用一个下拉筛） ——
  const [categories, setCategories] = useState<MallCategory[]>([]);
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [categoryDrafts, setCategoryDrafts] = useState<Record<string, CategoryDraft>>({});
  const [newCategoryLabel, setNewCategoryLabel] = useState("");
  const [categoryBusy, setCategoryBusy] = useState(false);

  // —— 商品检索（分类 / 等级 / 名称） ——
  /** 商城分类筛选：空串 = 全部分类 */
  const [filterCategoryId, setFilterCategoryId] = useState("");
  /** 物品等级筛选：空串 = 全部等级 */
  const [filterLevel, setFilterLevel] = useState("");
  /** 输入框草稿与已提交的关键字（点搜索 / 回车才生效） */
  const [keywordDraft, setKeywordDraft] = useState("");
  const [keyword, setKeyword] = useState("");
  /** 当前分类范围内出现过的物品等级（服务端回，供等级下拉） */
  const [levels, setLevels] = useState<number[]>([]);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [goods, setGoods] = useState<MallGoodPage | null>(null);
  const [loading, setLoading] = useState(true);

  // —— 商品编辑 / 上架 ——
  const [editing, setEditing] = useState<MallGoodItem | null>(null);
  const [editPrice, setEditPrice] = useState("0");
  const [editLevel, setEditLevel] = useState("0");
  /** 每日限购 / 库存（#846）：草稿是字符串，空串按默认值（不限购 / 不限量）提交 */
  const [editDailyLimit, setEditDailyLimit] = useState("0");
  const [editStock, setEditStock] = useState("-1");
  /** 编辑弹窗里选中的**商城分类**（= 陈列分组，与物品自己的分类无关） */
  const [editCategoryId, setEditCategoryId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createPrice, setCreatePrice] = useState("0");
  const [createLevel, setCreateLevel] = useState("0");
  const [createDailyLimit, setCreateDailyLimit] = useState("0");
  const [createStock, setCreateStock] = useState("-1");
  /** 上架弹窗里选中的**商城分类**（缺省 = 主界面正在筛的那个） */
  const [createCategoryId, setCreateCategoryId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  /** 前后缀中文名（住在 `equipment_meta`，「装备设置」页可改；这里只取来显示） */
  const [tierLabels, setTierLabels] = useState<{ prefix: string[]; suffix: string[] }>({ prefix: [], suffix: [] });

  // —— 上架弹窗的候选目录（装备 + 药品） ——
  const [variantKeyword, setVariantKeyword] = useState("");
  const [catalogKeyword, setCatalogKeyword] = useState("");
  /** 物品分类：空串 = 全部；部位 key；DRUG_CATEGORY = 药品 */
  const [catalogCategory, setCatalogCategory] = useState("");
  const [catalogLevel, setCatalogLevel] = useState("");
  const [catalogLevels, setCatalogLevels] = useState<number[]>([]);
  const [catalogPage, setCatalogPage] = useState(1);
  const [catalog, setCatalog] = useState<MallCatalogPage | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [pickedVariant, setPickedVariant] = useState<MallCatalogItem | null>(null);

  const loadCategories = useCallback(async () => {
    const list = await mallApi.listCategories();
    setCategories(list);
    setCategoryDrafts(draftsOf(list));
    // 正在筛的分类被删了 → 回到「全部分类」
    setFilterCategoryId((current) => (current && !list.some((row) => row.id === current) ? "" : current));
    return list;
  }, []);

  const loadGoods = useCallback(async () => {
    setLoading(true);
    try {
      const result = await mallApi.listGoods({
        categoryId: filterCategoryId || undefined,
        level: filterLevel === "" ? undefined : Number(filterLevel),
        keyword: keyword || undefined,
        page,
        size,
      });
      setGoods(result);
      setLevels(result.levels ?? []);
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [filterCategoryId, filterLevel, keyword, page, size]);

  useEffect(() => {
    void loadCategories().catch(() => undefined);
  }, [loadCategories]);

  useEffect(() => {
    void loadGoods();
  }, [loadGoods]);

  /** 品质文案只拉一次（改文案在「装备设置」页；同一件装备 15 个变体同名，只能靠前后缀分辨） */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const meta = await equipmentMetaApi.get();
        if (alive) setTierLabels({ prefix: meta.prefixLabels ?? [], suffix: meta.suffixLabels ?? [] });
      } catch {
        /* 文案取不到不影响上架与改价，列表回落「前缀 N / 后缀 N」 */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  //#region 分类管理（弹窗）

  const createCategory = async () => {
    setCategoryBusy(true);
    try {
      await mallApi.createCategory({ label: newCategoryLabel.trim() });
      toastSuccess(`分类「${newCategoryLabel.trim()}」已创建`);
      setNewCategoryLabel("");
      await loadCategories();
    } catch {
      /* 失败请求层已统一提示 */
    } finally {
      setCategoryBusy(false);
    }
  };

  /** 保存一行的草稿（名称 / 排序）：排序留空 = 不改（新建时留空才是「排到最后」） */
  const saveCategory = async (row: MallCategory) => {
    const draft = categoryDrafts[row.id];
    if (!draft) return;
    setCategoryBusy(true);
    try {
      await mallApi.updateCategory(row.id, {
        label: draft.label.trim(),
        sortOrder: draft.sortOrder === "" ? undefined : Number(draft.sortOrder),
      });
      toastSuccess(`分类「${draft.label.trim()}」已保存`);
      await loadCategories();
    } catch {
      /* 失败保持弹窗打开 */
    } finally {
      setCategoryBusy(false);
    }
  };

  /** 删分类：服务端拒删非空分类（409 50028），运营先把商品挪到别的分类或下架 */
  const removeCategory = async (row: MallCategory) => {
    if (!window.confirm(`删除分类「${row.label}」？（分类下不能还有商品）`)) return;
    try {
      await mallApi.deleteCategory(row.id);
      toastSuccess(`分类「${row.label}」已删除`);
      await loadCategories();
    } catch {
      /* 失败请求层已统一提示 */
    }
  };

  const categoryDirtyOf = (row: MallCategory) => {
    const draft = categoryDrafts[row.id];
    if (!draft) return false;
    return draft.label.trim() !== row.label || draft.sortOrder !== sortOrderTextOf(row);
  };

  //#endregion

  //#region 商品操作

  /** 打开上架弹窗：清空筛选与已选，回到「全部分类 / 全部等级」的第一页 */
  const openCreate = () => {
    setPickedVariant(null);
    setVariantKeyword("");
    setCatalogKeyword("");
    setCatalogCategory("");
    setCatalogLevel("");
    setCatalogLevels([]);
    setCatalogPage(1);
    setCreatePrice("0");
    setCreateLevel("0");
    // 缺省挂到主界面正在筛的分类（全部分类时取第一个），运营可以在这里改
    setCreateCategoryId(filterCategoryId || categories[0]?.id || "");
    setCreating(true);
  };

  /**
   * 拉候选目录（装备 + 药品）：分类 / 等级 / 关键字 / 页码任一变化都重查
   *
   * 服务端回 `levels`（当前分类下出现过的等级），等级下拉照它列 —— 运营不用猜有哪些档。
   */
  useEffect(() => {
    if (!creating) return;
    let alive = true;
    setCatalogLoading(true);
    void (async () => {
      try {
        const result = await mallApi.listCatalog({
          category: catalogCategory || undefined,
          level: catalogLevel === "" ? undefined : Number(catalogLevel),
          keyword: catalogKeyword || undefined,
          page: catalogPage,
          size: CATALOG_PAGE_SIZE,
        });
        if (!alive) return;
        setCatalog(result);
        setCatalogLevels(result.levels ?? []);
      } catch {
        /* 失败请求层已统一提示 */
      } finally {
        if (alive) setCatalogLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [creating, catalogCategory, catalogLevel, catalogKeyword, catalogPage]);

  /** 换物品分类：等级与页码一起归位（不同分类的等级档不一样，留着旧值会筛出空表） */
  const switchCatalogCategory = (category: string) => {
    setCatalogCategory(category);
    setCatalogLevel("");
    setCatalogPage(1);
  };

  /** 上架：商品 id / 分类 / 重复上架服务端都会校验（404 50021/50025、409 50026） */
  const submitCreate = async () => {
    if (!pickedVariant || !createCategoryId) return;
    setSubmitting(true);
    try {
      await mallApi.createGood({
        id: pickedVariant.id,
        categoryId: createCategoryId,
        price: Math.max(0, Math.floor(Number(createPrice) || 0)),
        requiredLevel: Math.max(0, Math.floor(Number(createLevel) || 0)),
        dailyLimit: dailyLimitOf(createDailyLimit),
        stock: stockOf(createStock),
      });
      toastSuccess(`商品「${pickedVariant.label}」已上架`);
      setCreating(false);
      // 上到别的分类时把筛选切过去 —— 否则刚上架的商品立刻被筛掉，看着像没成功
      setFilterCategoryId(createCategoryId);
      setPage(1);
      await loadGoods();
      await loadCategories();
    } catch {
      /* 失败保持弹窗打开 */
    } finally {
      setSubmitting(false);
    }
  };

  const openEdit = (item: MallGoodItem) => {
    setEditing(item);
    setEditPrice(String(item.price));
    setEditLevel(String(item.requiredLevel));
    setEditDailyLimit(String(item.dailyLimit));
    setEditStock(String(item.stock));
    setEditCategoryId(item.categoryId);
    setSubmitting(false);
  };

  const closeEdit = () => setEditing(null);

  /** 只提交商城自己的三个字段（分类 / 售价 / 购买等级；本体字段接口不接受改） */
  const submitEdit = async () => {
    if (!editing || !editCategoryId) return;
    setSubmitting(true);
    try {
      await mallApi.updateGood(editing.id, {
        categoryId: editCategoryId,
        price: Math.max(0, Math.floor(Number(editPrice) || 0)),
        requiredLevel: Math.max(0, Math.floor(Number(editLevel) || 0)),
        dailyLimit: dailyLimitOf(editDailyLimit),
        stock: stockOf(editStock),
      });
      toastSuccess(`商品「${editing.label}」已更新`);
      closeEdit();
      await loadGoods();
      await loadCategories();
    } catch {
      /* 失败保持弹窗打开 */
    } finally {
      setSubmitting(false);
    }
  };

  const removeGood = async (item: MallGoodItem) => {
    if (!window.confirm(`下架商品「${item.label}」？（本体不受影响，随时可重新上架）`)) return;
    try {
      await mallApi.deleteGood(item.id);
      toastSuccess(`商品「${item.label}」已下架`);
      await loadGoods();
      await loadCategories();
    } catch {
      /* 失败请求层已统一提示 */
    }
  };

  /** 重置库存（#846）：已售清零，总库存不变 —— 限量款补货用这个，别靠把 stock 改大 */
  const resetStock = async (item: MallGoodItem) => {
    if (!window.confirm(`把「${item.label}」的已售 ${item.sold} 件清零？（总库存 ${item.stock} 不变，商品重新可买）`)) return;
    try {
      await mallApi.resetStock(item.id);
      toastSuccess(`「${item.label}」库存已重置`);
      await loadGoods();
    } catch {
      /* 失败请求层已统一提示 */
    }
  };

  //#endregion

  /**
   * 前后缀序号 → 中文名（`equipment_meta` 里改文案，这里跟着变；序号越界照实报序号）
   *
   * 序号本身缺失 = 后端还是不带 `prefix` / `suffix` 的旧版本，这时显示「—」：
   * 宁可空着，也不要把「前缀 undefined」摆给运营看。
   */
  const prefixLabelOf = (index: number) => (typeof index === "number" ? (tierLabels.prefix[index] ?? `前缀 ${index}`) : "—");
  const suffixLabelOf = (index: number) => (typeof index === "number" ? (tierLabels.suffix[index] ?? `后缀 ${index}`) : "—");
  /** 分类 id → 显示名（列表里挂个「商城分类」列，筛选到全部分类时才知道这行摆在哪） */
  const categoryLabelOf = (id: string) => categories.find((row) => row.id === id)?.label ?? id;

  const priceOk = (value: string) => Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= MALL_PRICE_MAX;
  const levelOk = (value: string) => Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= MALL_LEVEL_MAX;
  /** 留空 = 不限（0 / -1），填了就必须是区间内的整数 —— 与 `dailyLimitOf` / `stockOf` 同一口径 */
  const dailyOk = (value: string) =>
    value.trim() === "" || (Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= MALL_DAILY_LIMIT_MAX);
  const stockOk = (value: string) =>
    value.trim() === "" ||
    (Number.isInteger(Number(value)) && Number(value) >= MALL_STOCK_UNLIMITED && Number(value) <= MALL_STOCK_MAX);
  const categoryValid = newCategoryLabel.trim().length > 0 && newCategoryLabel.trim().length <= 20;
  const editValid = Boolean(editCategoryId) && priceOk(editPrice) && levelOk(editLevel) && dailyOk(editDailyLimit) && stockOk(editStock);
  const createValid =
    Boolean(pickedVariant) && Boolean(createCategoryId) && priceOk(createPrice) && levelOk(createLevel) && dailyOk(createDailyLimit) && stockOk(createStock);

  /** 检索条里是否有生效条件（决定要不要给「重置」按钮） */
  const filtering = Boolean(filterCategoryId) || filterLevel !== "" || Boolean(keyword);
  const applyKeyword = () => {
    setKeyword(keywordDraft.trim());
    setPage(1);
  };
  const resetFilters = () => {
    setFilterCategoryId("");
    setFilterLevel("");
    setKeywordDraft("");
    setKeyword("");
    setPage(1);
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="商城"
        description={
          <>
            分类是<strong>商城自己的陈列分组</strong>（与物品的武器/衣服/药品分类无关），在「管理分类」里增删改；
            商品从<strong>装备变体 / 药品</strong>目录里挑一件上架，只能改<strong>所属分类 / 售价 / 购买等级</strong>
            （名称、图标、部位、等级归各自的配置页管）。购买等级不足的玩家，客户端按钮置灰、服务端拒绝成交。
          </>
        }
      />

      <Card
        title="商品"
        actions={loading ? <Spinner /> : null}
        description={canWrite ? "按商城分类 / 物品等级 / 名称检索；「上架」把装备或药品挂到选定的分类下。" : "当前角色没有「修改养成配置」权限，列表只读。"}
      >
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <Field width="w-40" label="商城分类">
            <Select
              value={filterCategoryId}
              onChange={(event) => {
                setFilterCategoryId(event.target.value);
                setPage(1);
              }}
            >
              <option value="">全部分类</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field width="w-32" label="物品等级">
            <Select
              value={filterLevel}
              disabled={levels.length === 0}
              onChange={(event) => {
                setFilterLevel(event.target.value);
                setPage(1);
              }}
            >
              <option value="">全部等级</option>
              {levels.map((level) => (
                <option key={level} value={String(level)}>
                  Lv.{level}
                </option>
              ))}
            </Select>
          </Field>
          <Field width="w-72" label="名称 / id">
            <div className="flex gap-2">
              <Input
                value={keywordDraft}
                placeholder="如 重甲 / cloth / 金创药"
                onChange={(event) => setKeywordDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") applyKeyword();
                }}
              />
              <Button variant="outline" onClick={applyKeyword}>搜索</Button>
            </div>
          </Field>
          {filtering ? (
            <Button variant="ghost" onClick={resetFilters}>重置</Button>
          ) : null}
          <div className="ml-auto flex gap-2">
            <Button variant="outline" onClick={() => setCategoryDialogOpen(true)}>
              管理分类
              <Badge tone="slate">{categories.length}</Badge>
            </Button>
            <Button disabled={!canWrite || categories.length === 0} title={categories.length === 0 ? "先建一个分类" : undefined} onClick={openCreate}>
              上架商品
            </Button>
          </div>
        </div>

        {categories.length === 0 ? (
          <EmptyState title="还没有分类" description="分类是商城的陈列分组，先点「管理分类」建一个，再上架商品" />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className={tableClass}>
                <thead className={theadClass}>
                  <tr>
                    <th className={thClass}>图</th>
                    <th className={thClass}>商品 id</th>
                    <th className={thClass}>名称</th>
                    <th className={thClass}>商城分类</th>
                    <th className={thClass}>部位</th>
                    <th className={thClass}>品质（前缀 / 后缀）</th>
                    <th className={thClass}>物品等级</th>
                    <th className={thClass}>售价</th>
                    <th className={thClass}>购买等级</th>
                    <th className={thClass}>限购 / 库存</th>
                    <th className={thClass}>更新时间</th>
                    <th className={`${thClass} text-right`}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {goods?.list.map((item) => (
                    <tr key={item.id} className="transition hover:bg-slate-800/30">
                      <td className={tdClass}>
                        <GameIcon path={item.icon} alt={item.label} />
                      </td>
                      <td className={`${tdClass} font-mono text-xs text-slate-300`}>{item.id}</td>
                      <td className={`${tdClass} max-w-[220px] truncate font-medium text-slate-100`} title={item.label}>
                        {item.label}
                      </td>
                      <td className={tdClass}>
                        <Badge tone="indigo">{categoryLabelOf(item.categoryId)}</Badge>
                      </td>
                      <td className={tdClass}>
                        {item.kind === DRUG_CATEGORY ? (
                          <Badge tone="amber">药品</Badge>
                        ) : (
                          <Badge tone="slate">{item.slot ? slotLabel(item.slot) : "—"}</Badge>
                        )}
                      </td>
                      <td className={tdClass}>
                        {item.kind === DRUG_CATEGORY ? (
                          <span className="text-xs text-slate-500">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            <Badge tone="indigo">{prefixLabelOf(item.prefix)}</Badge>
                            <Badge tone="slate">{suffixLabelOf(item.suffix)}</Badge>
                          </div>
                        )}
                      </td>
                      <td className={`${tdClass} text-slate-400`}>{item.level}</td>
                      <td className={`${tdClass} font-medium text-emerald-300`}>{item.price}</td>
                      <td className={tdClass}>{item.requiredLevel > 0 ? `Lv.${item.requiredLevel}` : "—"}</td>
                      <td className={tdClass}>
                        <div className="flex flex-col gap-1 text-xs">
                          <span className={item.dailyLimit > 0 ? "text-amber-300" : "text-slate-500"}>
                            {item.dailyLimit > 0 ? `限购 ${item.dailyLimit}/日` : "不限购"}
                          </span>
                          <span className={item.stock >= 0 ? (item.sold >= item.stock ? "text-rose-300" : "text-emerald-300") : "text-slate-500"}>
                            {item.stock >= 0 ? `${item.sold}/${item.stock} 已售` : "不限量"}
                          </span>
                        </div>
                      </td>
                      <td className={`${tdClass} text-xs text-slate-400`}>{formatTime(item.updatedAt)}</td>
                      <td className={`${tdClass} text-right`}>
                        <div className="flex justify-end gap-2">
                          <Button variant="outline" className="px-2.5 py-1 text-xs" disabled={!canWrite} onClick={() => openEdit(item)}>
                            编辑
                          </Button>
                          {item.stock >= 0 ? (
                            <Button
                              variant="outline"
                              className="px-2.5 py-1 text-xs"
                              disabled={!canWrite || item.sold === 0}
                              onClick={() => void resetStock(item)}
                            >
                              重置库存
                            </Button>
                          ) : null}
                          <Button variant="outline" className="px-2.5 py-1 text-xs" disabled={!canWrite} onClick={() => void removeGood(item)}>
                            下架
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {!loading && goods && goods.list.length === 0 ? (
              <EmptyState
                title={filtering ? "没有符合条件的商品" : "商城还没有商品"}
                description={filtering ? "换个分类 / 等级，或清空关键字再试" : "点「上架商品」从装备与药品里挑一件"}
              />
            ) : null}

            <Pagination
              page={page}
              size={size}
              total={goods?.total ?? 0}
              onChange={setPage}
              onSizeChange={(next) => {
                setSize(next);
                setPage(1);
              }}
            />
          </>
        )}
      </Card>

      {/* —— 分类管理弹窗（#765：分类不再平铺在页面上，增删改都在这里） —— */}
      {categoryDialogOpen ? (
        <Modal
          open
          title="管理分类"
          hint="分类只管陈列顺序：客户端商城按这里从上到下排页签。排序值小者在先，留空 = 排在最后；分类下还有商品时不能删。"
          size="lg"
          onClose={() => setCategoryDialogOpen(false)}
          footer={<Button variant="outline" onClick={() => setCategoryDialogOpen(false)}>关闭</Button>}
        >
          <div className="mt-4 flex flex-wrap items-end gap-2">
            <Field width="w-56" label="新分类名（1~20 字）">
              <Input
                value={newCategoryLabel}
                placeholder="如：热卖推荐"
                disabled={!canWrite}
                onChange={(event) => setNewCategoryLabel(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && canWrite && categoryValid) void createCategory();
                }}
              />
            </Field>
            <Button disabled={!canWrite || !categoryValid || categoryBusy} loading={categoryBusy} onClick={() => void createCategory()}>
              新建分类
            </Button>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className={tableClass}>
              <thead className={theadClass}>
                <tr>
                  <th className={thClass}>分类名</th>
                  <th className={thClass}>排序</th>
                  <th className={thClass}>商品数</th>
                  <th className={thClass}>更新时间</th>
                  <th className={`${thClass} text-right`}>操作</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((category) => {
                  const draft = categoryDrafts[category.id] ?? { label: category.label, sortOrder: sortOrderTextOf(category) };
                  const dirty = categoryDirtyOf(category);
                  const draftValid = draft.label.trim().length > 0 && draft.label.trim().length <= 20;
                  return (
                    <tr key={category.id} className="transition hover:bg-slate-800/30">
                      <td className={tdClass}>
                        <Input
                          className="w-44"
                          value={draft.label}
                          disabled={!canWrite}
                          onChange={(event) =>
                            setCategoryDrafts((current) => ({ ...current, [category.id]: { ...draft, label: event.target.value } }))
                          }
                        />
                      </td>
                      <td className={tdClass}>
                        <Input
                          className="w-24"
                          type="number"
                          placeholder="自动"
                          value={draft.sortOrder}
                          disabled={!canWrite}
                          onChange={(event) =>
                            setCategoryDrafts((current) => ({ ...current, [category.id]: { ...draft, sortOrder: event.target.value } }))
                          }
                        />
                      </td>
                      <td className={tdClass}>
                        {category.goodCount > 0 ? <Badge tone="indigo">{category.goodCount}</Badge> : <span className="text-xs text-slate-500">0</span>}
                      </td>
                      <td className={`${tdClass} text-xs text-slate-400`}>{formatTime(category.updatedAt)}</td>
                      <td className={`${tdClass} text-right`}>
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="outline"
                            className="px-2.5 py-1 text-xs"
                            disabled={!canWrite || !dirty || !draftValid || categoryBusy}
                            onClick={() => void saveCategory(category)}
                          >
                            保存
                          </Button>
                          <Button variant="outline" className="px-2.5 py-1 text-xs" disabled={!canWrite} onClick={() => void removeCategory(category)}>
                            删除
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {categories.length === 0 ? <EmptyState title="还没有分类" description="在上方输入分类名，回车即可创建" /> : null}
        </Modal>
      ) : null}

      {creating ? (
        <Modal
          open
          title="上架商品"
          hint="上半部分是「挑哪件」（按物品自己的分类与等级缩小范围），下半部分是「挂到商城的哪个分类、卖多少钱」。"
          size="md"
          onClose={() => setCreating(false)}
          footer={<>
            <Button variant="outline" disabled={submitting} onClick={() => setCreating(false)}>取消</Button>
            <Button disabled={!createValid || submitting} loading={submitting} onClick={() => void submitCreate()}>上架</Button>
          </>}
        >
          <div className="mt-5 flex flex-col gap-4">
            <div className="flex flex-wrap gap-3">
              <Field width="w-40" label="物品分类（它自己的）">
                <Select value={catalogCategory} onChange={(event) => switchCatalogCategory(event.target.value)}>
                  <option value="">全部分类</option>
                  <option value={DRUG_CATEGORY}>药品</option>
                  {equipmentSlotKeys().map((slot) => (
                    <option key={slot} value={slot}>
                      {slotLabel(slot)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field width="w-32" label="物品等级">
                <Select
                  value={catalogLevel}
                  disabled={catalogLevels.length === 0}
                  onChange={(event) => {
                    setCatalogLevel(event.target.value);
                    setCatalogPage(1);
                  }}
                >
                  <option value="">全部等级</option>
                  {catalogLevels.map((level) => (
                    <option key={level} value={String(level)}>
                      Lv.{level}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field width="w-56" label="关键字（id / 名称）">
                <div className="flex gap-2">
                  <Input
                    value={variantKeyword}
                    placeholder="如 cloth / 重甲 / 金创药"
                    onChange={(event) => setVariantKeyword(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      setCatalogKeyword(variantKeyword.trim());
                      setCatalogPage(1);
                    }}
                  />
                  <Button
                    variant="outline"
                    onClick={() => {
                      setCatalogKeyword(variantKeyword.trim());
                      setCatalogPage(1);
                    }}
                  >
                    搜索
                  </Button>
                </div>
              </Field>
            </div>

            <Field
              label="候选物品（点选一件）"
              hint="同一件装备有 15 个变体（名称相同），认准「部位 + 前后缀」；带「已上架」的不能再挂第二行。"
            >
              <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-800">
                {catalogLoading ? (
                  <p className="px-3 py-3 text-xs text-slate-500">查询中…</p>
                ) : !catalog || catalog.list.length === 0 ? (
                  <p className="px-3 py-3 text-xs text-slate-500">这个分类与等级下没有物品，换个条件试试</p>
                ) : (
                  catalog.list.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      disabled={item.listed}
                      title={item.listed ? `${item.id} 已在商城上架（想换分类直接编辑那件商品）` : item.id}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition ${item.listed ? "cursor-not-allowed opacity-40" : "hover:bg-slate-800/60"} ${pickedVariant?.id === item.id ? "bg-slate-800/80" : ""}`}
                      onClick={() => setPickedVariant(item)}
                    >
                      <GameIcon path={item.icon} alt={item.label} size={24} zoomable={false} />
                      <span className="shrink-0 font-mono text-slate-400">{item.id}</span>
                      <span className="truncate text-slate-100" title={item.label}>{item.label}</span>
                      <span className="ml-auto flex shrink-0 items-center gap-1">
                        {item.kind === DRUG_CATEGORY ? (
                          <Badge tone="amber">药品</Badge>
                        ) : (
                          <>
                            <Badge tone="slate">{item.slot ? slotLabel(item.slot) : "部位未知"}</Badge>
                            <Badge tone="indigo">{prefixLabelOf(item.prefix)}</Badge>
                            <Badge tone="slate">{suffixLabelOf(item.suffix)}</Badge>
                          </>
                        )}
                        <span className="text-slate-500">Lv.{item.level}</span>
                        {item.listed ? <Badge tone="amber">已上架</Badge> : null}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </Field>
            <Pagination
              page={catalogPage}
              size={CATALOG_PAGE_SIZE}
              total={catalog?.total ?? 0}
              onChange={setCatalogPage}
            />
            <div className="flex flex-wrap gap-3 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-3">
              <Field width="w-44" label="挂到商城分类">
                <Select value={createCategoryId} onChange={(event) => setCreateCategoryId(event.target.value)}>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field width="w-40" label="售价（绑定元宝/件）" hint="至少 1（0 会被拒：免费商品 = 印钞）">
                <Input type="number" min={0} value={createPrice} onChange={(event) => setCreatePrice(event.target.value)} />
              </Field>
              <Field width="w-40" label="购买等级" hint="0 = 不限等级">
                <Input type="number" min={0} value={createLevel} onChange={(event) => setCreateLevel(event.target.value)} />
              </Field>
              <Field width="w-36" label="每日限购" hint="每个角色每天几件；0 / 留空 = 不限购">
                <Input type="number" min={0} value={createDailyLimit} onChange={(event) => setCreateDailyLimit(event.target.value)} />
              </Field>
              <Field width="w-36" label="全服库存" hint="-1 / 留空 = 不限量；0 = 售罄停售">
                <Input type="number" min={-1} value={createStock} onChange={(event) => setCreateStock(event.target.value)} />
              </Field>
            </div>
            {!createValid ? (
              <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                先选一件物品与商城分类；售价 / 购买等级 / 每日限购 / 库存需为合法整数（限购 0 与库存 -1 表示不限）。
              </p>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {editing ? (
        <Modal
          open
          title={<>编辑商品 · {editing.label}</>}
          hint={<>{editing.label}（{editing.id}）。商品本体是关联数据，这里只改商城字段：所在分类 / 售价 / 购买等级 / 每日限购 / 库存，改完立即对购买生效。</>}
          size="md"
          onClose={closeEdit}
          footer={<>
            <Button variant="outline" disabled={submitting} onClick={closeEdit}>取消</Button>
            <Button disabled={!editValid || submitting} loading={submitting} onClick={() => void submitEdit()}>保存</Button>
          </>}
        >
          <div className="mt-5 flex flex-wrap gap-3">
            <Field width="w-44" label="商城分类" hint="换分类 = 在陈列里挪个位置">
              <Select value={editCategoryId} onChange={(event) => setEditCategoryId(event.target.value)}>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field width="w-40" label="售价（绑定元宝/件）" hint="至少 1（0 会被拒：免费商品 = 印钞）">
              <Input type="number" min={0} value={editPrice} onChange={(event) => setEditPrice(event.target.value)} />
            </Field>
            <Field width="w-40" label="购买等级" hint="角色等级不足时禁购">
              <Input type="number" min={0} value={editLevel} onChange={(event) => setEditLevel(event.target.value)} />
            </Field>
            <Field width="w-36" label="每日限购" hint="每个角色每天几件；0 / 留空 = 不限购">
              <Input type="number" min={0} value={editDailyLimit} onChange={(event) => setEditDailyLimit(event.target.value)} />
            </Field>
            <Field width="w-36" label="全服库存" hint={`-1 / 留空 = 不限量；0 = 售罄。已售 ${editing.sold} 件，卖完要补货用「重置库存」`}>
              <Input type="number" min={-1} value={editStock} onChange={(event) => setEditStock(event.target.value)} />
            </Field>
          </div>
          {!editValid ? (
            <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              售价 / 购买等级 / 每日限购 / 库存需为合法整数（限购 0 与库存 -1 表示不限），且必须选一个商城分类。
            </p>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}
