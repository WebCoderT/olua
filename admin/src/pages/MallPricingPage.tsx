import { useCallback, useEffect, useState } from "react";
import { equipmentMetaApi, equipmentSlotKeys, formatTime, mallApi, PERMISSION, slotLabel } from "../api";
import type { MallCatalogItem, MallCategory, MallGoodItem, PageResult } from "../api";
import { GameIcon } from "../components/GameImage";
import { Modal } from "../components/Modal";
import { Pagination } from "../components/Pagination";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";
import { PageHeader } from "../components/PageHeader";

const MALL_PRICE_MAX = 100_000_000;
const MALL_LEVEL_MAX = 10_000;
/** 上架弹窗里「分类」下拉表示药品的那一项（服务端同一取值，见 MALL_CATEGORY_DRUG） */
const DRUG_CATEGORY = "drug";
/** 上架弹窗候选列表每页条数（566 件装备 + 11 种药，必须分页） */
const CATALOG_PAGE_SIZE = 8;

/**
 * 商城管理（#251 / #758 / #763，运营陈列页）
 *
 * **先建分类，再在分类下上架商品**：分类是自建的陈列分组（POST 建行 / PATCH 改名与
 * 排序 / DELETE 删空分类）；商品是**关联数据** —— 上架时从「可上架目录」（装备变体 + 药品）
 * 里按**物品自己的分类与等级**挑一件，之后只许改售价与购买等级（名称/图标/部位归各自的
 * 配置页管）。客户端陈列与购买以服务端为准。写操作要 `gameConfig:write`。
 */
export function MallPricingPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);

  // —— 分类 ——
  const [categories, setCategories] = useState<MallCategory[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState("");
  const [newCategoryLabel, setNewCategoryLabel] = useState("");
  const [renaming, setRenaming] = useState<MallCategory | null>(null);
  const [renameLabel, setRenameLabel] = useState("");
  const [categoryBusy, setCategoryBusy] = useState(false);

  // —— 商品（当前分类下） ——
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [goods, setGoods] = useState<PageResult<MallGoodItem> | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<MallGoodItem | null>(null);
  const [editPrice, setEditPrice] = useState("0");
  const [editLevel, setEditLevel] = useState("0");
  const [creating, setCreating] = useState(false);
  const [createPrice, setCreatePrice] = useState("0");
  const [createLevel, setCreateLevel] = useState("0");
  const [submitting, setSubmitting] = useState(false);
  /** 前后缀中文名（住在 `equipment_meta`，「装备设置」页可改；这里只取来显示） */
  const [tierLabels, setTierLabels] = useState<{ prefix: string[]; suffix: string[] }>({ prefix: [], suffix: [] });

  // —— 上架弹窗的候选目录（装备 + 药品） ——
  const [variantKeyword, setVariantKeyword] = useState("");
  /** 已提交的关键字（输入框是草稿，点搜索/回车才生效） */
  const [catalogKeyword, setCatalogKeyword] = useState("");
  /** 物品分类：空串 = 全部；部位 key；DRUG_CATEGORY = 药品 */
  const [catalogCategory, setCatalogCategory] = useState("");
  /** 等级：空串 = 全部 */
  const [catalogLevel, setCatalogLevel] = useState("");
  /** 当前分类下出现过的等级（服务端回，供等级下拉） */
  const [catalogLevels, setCatalogLevels] = useState<number[]>([]);
  const [catalogPage, setCatalogPage] = useState(1);
  const [catalog, setCatalog] = useState<PageResult<MallCatalogItem> | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [pickedVariant, setPickedVariant] = useState<MallCatalogItem | null>(null);

  const loadCategories = useCallback(async () => {
    const list = await mallApi.listCategories();
    setCategories(list);
    // 当前选中的分类被删了（或还没选）→ 落到第一个
    setSelectedCategoryId((current) => (list.some((row) => row.id === current) ? current : (list[0]?.id ?? "")));
    return list;
  }, []);

  const loadGoods = useCallback(async () => {
    if (!selectedCategoryId) {
      setGoods({ list: [], total: 0, page: 1, size });
      return;
    }
    setLoading(true);
    try {
      setGoods(await mallApi.listGoods({ categoryId: selectedCategoryId, page, size }));
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [selectedCategoryId, page, size]);

  useEffect(() => {
    void loadCategories().catch(() => undefined);
  }, [loadCategories]);

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

  useEffect(() => {
    void loadGoods();
  }, [loadGoods]);

  //#region 分类操作

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

  const submitRename = async () => {
    if (!renaming) return;
    setCategoryBusy(true);
    try {
      await mallApi.updateCategory(renaming.id, { label: renameLabel.trim() });
      toastSuccess("分类已改名");
      setRenaming(null);
      await loadCategories();
    } catch {
      /* 失败保持弹窗打开 */
    } finally {
      setCategoryBusy(false);
    }
  };

  /** 删分类：服务端拒删非空分类（409 50028），运营先移走或下架商品 */
  const removeCategory = async (category: MallCategory) => {
    if (!window.confirm(`删除分类「${category.label}」？（分类下不能还有商品）`)) return;
    try {
      await mallApi.deleteCategory(category.id);
      toastSuccess(`分类「${category.label}」已删除`);
      await loadCategories();
    } catch {
      /* 失败请求层已统一提示 */
    }
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

  /** 换分类：等级与页码一起归位（不同分类的等级档不一样，留着旧值会筛出空表） */
  const switchCatalogCategory = (category: string) => {
    setCatalogCategory(category);
    setCatalogLevel("");
    setCatalogPage(1);
  };

  /** 上架：商品 id / 分类 / 重复上架服务端都会校验（404 50021/50025、409 50026） */
  const submitCreate = async () => {
    if (!pickedVariant) return;
    setSubmitting(true);
    try {
      await mallApi.createGood({
        id: pickedVariant.id,
        categoryId: selectedCategoryId,
        price: Math.max(0, Math.floor(Number(createPrice) || 0)),
        requiredLevel: Math.max(0, Math.floor(Number(createLevel) || 0)),
      });
      toastSuccess(`商品「${pickedVariant.label}」已上架`);
      setCreating(false);
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
    setSubmitting(false);
  };

  const closeEdit = () => setEditing(null);

  /** 只提交售价与购买等级两个字段（商品本体是装备数据，接口不接受改） */
  const submitEdit = async () => {
    if (!editing) return;
    setSubmitting(true);
    try {
      await mallApi.updateGood(editing.id, {
        price: Math.max(0, Math.floor(Number(editPrice) || 0)),
        requiredLevel: Math.max(0, Math.floor(Number(editLevel) || 0)),
      });
      toastSuccess(`商品「${editing.label}」已更新`);
      closeEdit();
      await loadGoods();
    } catch {
      /* 失败保持弹窗打开 */
    } finally {
      setSubmitting(false);
    }
  };

  const removeGood = async (item: MallGoodItem) => {
    if (!window.confirm(`下架商品「${item.label}」？（装备本体不受影响，随时可重新上架）`)) return;
    try {
      await mallApi.deleteGood(item.id);
      toastSuccess(`商品「${item.label}」已下架`);
      await loadGoods();
      await loadCategories();
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

  const categoryValid = newCategoryLabel.trim().length > 0 && newCategoryLabel.trim().length <= 20;
  const renameValid = renameLabel.trim().length > 0 && renameLabel.trim().length <= 20;
  const editValid =
    Number.isInteger(Number(editPrice)) && Number(editPrice) >= 0 && Number(editPrice) <= MALL_PRICE_MAX &&
    Number.isInteger(Number(editLevel)) && Number(editLevel) >= 0 && Number(editLevel) <= MALL_LEVEL_MAX;
  const createValid =
    Boolean(pickedVariant) &&
    Number.isInteger(Number(createPrice)) && Number(createPrice) >= 0 && Number(createPrice) <= MALL_PRICE_MAX &&
    Number.isInteger(Number(createLevel)) && Number(createLevel) >= 0 && Number(createLevel) <= MALL_LEVEL_MAX;
  const selectedCategory = categories.find((row) => row.id === selectedCategoryId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="商城"
        description={
          <>
            先建分类，再在分类下上架商品。商品是关联数据 —— 从<strong>装备变体 / 药品</strong>里挑一件上架，
            只能改<strong>售价</strong>与<strong>购买等级</strong>（名称/图标/部位归各自的配置页管）；
            下架 = 删行，本体不受影响。购买等级不足的玩家，客户端按钮置灰、服务端拒绝成交。
          </>
        }
      />

      <Card
        title="分类"
        description="陈列分组，排序值小者在先；删除前分类下不能还有商品。"
        actions={categories.length === 0 ? <Badge tone="amber">还没有分类，先建一个</Badge> : null}
      >
        <div className="flex flex-wrap items-end gap-2">
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
                <th className={thClass}>分类</th>
                <th className={thClass}>排序</th>
                <th className={thClass}>商品数</th>
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((category) => (
                <tr
                  key={category.id}
                  className={`transition hover:bg-slate-800/30 ${category.id === selectedCategoryId ? "bg-slate-800/50" : ""}`}
                >
                  <td className={tdClass}>
                    <button
                      type="button"
                      className="font-medium text-sky-300 hover:underline"
                      onClick={() => {
                        setSelectedCategoryId(category.id);
                        setPage(1);
                      }}
                    >
                      {category.label}
                      {category.id === selectedCategoryId ? <span className="ml-1 text-xs text-slate-400">（当前）</span> : null}
                    </button>
                  </td>
                  <td className={tdClass}>{category.sortOrder >= 900000000 ? "—" : category.sortOrder}</td>
                  <td className={tdClass}>{category.goodCount}</td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{formatTime(category.updatedAt)}</td>
                  <td className={`${tdClass} text-right`}>
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        className="px-2.5 py-1 text-xs"
                        disabled={!canWrite}
                        onClick={() => {
                          setRenaming(category);
                          setRenameLabel(category.label);
                        }}
                      >
                        改名
                      </Button>
                      <Button variant="outline" className="px-2.5 py-1 text-xs" disabled={!canWrite} onClick={() => void removeCategory(category)}>
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {categories.length === 0 ? <EmptyState title="没有分类" description="先在上方新建一个分类，商品要挂在分类下" /> : null}
      </Card>

      <Card
        title={selectedCategory ? `商品 · ${selectedCategory.label}` : "商品"}
        actions={loading ? <Spinner /> : null}
        description={canWrite ? "点商品名所在行查看；「上架」把装备或药品挂进当前分类。" : "当前角色没有「修改养成配置」权限，列表只读。"}
      >
        {!selectedCategory ? (
          <EmptyState title="先选择一个分类" description="左侧分类表里点分类名切换" />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-end gap-2">
              <Button disabled={!canWrite} onClick={() => void openCreate()}>上架商品</Button>
            </div>
            <div className="overflow-x-auto">
              <table className={tableClass}>
                <thead className={theadClass}>
                  <tr>
                    <th className={thClass}>图</th>
                    <th className={thClass}>商品 id</th>
                    <th className={thClass}>名称</th>
                    <th className={thClass}>部位</th>
                    <th className={thClass}>品质（前缀 / 后缀）</th>
                    <th className={thClass}>装备等级</th>
                    <th className={thClass}>售价</th>
                    <th className={thClass}>购买等级</th>
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
                      <td className={`${tdClass} max-w-[240px] truncate font-medium text-slate-100`} title={item.label}>
                        {item.label}
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
                      <td className={`${tdClass} text-xs text-slate-400`}>{formatTime(item.updatedAt)}</td>
                      <td className={`${tdClass} text-right`}>
                        <div className="flex justify-end gap-2">
                          <Button variant="outline" className="px-2.5 py-1 text-xs" disabled={!canWrite} onClick={() => openEdit(item)}>
                            改售价/等级
                          </Button>
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
              <EmptyState title="这个分类还没有商品" description="点「上架商品」按分类与等级挑一件" />
            ) : null}

            <Pagination page={page} size={size} total={goods?.total ?? 0} onChange={setPage} onSizeChange={(next) => { setSize(next); setPage(1); }} />
          </>
        )}
      </Card>

      {renaming ? (
        <Modal
          open
          title={<>改分类名 · {renaming.label}</>}
          size="md"
          onClose={() => setRenaming(null)}
          footer={<>
            <Button variant="outline" disabled={categoryBusy} onClick={() => setRenaming(null)}>取消</Button>
            <Button disabled={!renameValid || categoryBusy} loading={categoryBusy} onClick={() => void submitRename()}>保存</Button>
          </>}
        >
          <div className="mt-5">
            <Field label="分类名（1~20 字）">
              <Input value={renameLabel} onChange={(event) => setRenameLabel(event.target.value)} />
            </Field>
          </div>
        </Modal>
      ) : null}

      {creating ? (
        <Modal
          open
          title="上架商品"
          hint="先选物品自己的分类与等级缩小范围，再从候选里挑一件挂进当前分类；售价 0 = 免费，购买等级 0 = 不限等级。"
          size="md"
          onClose={() => setCreating(false)}
          footer={<>
            <Button variant="outline" disabled={submitting} onClick={() => setCreating(false)}>取消</Button>
            <Button disabled={!createValid || submitting} loading={submitting} onClick={() => void submitCreate()}>上架</Button>
          </>}
        >
          <div className="mt-5 flex flex-col gap-4">
            <div className="flex flex-wrap gap-3">
              <Field width="w-40" label="分类（物品自己的）">
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
              <Field width="w-32" label="等级">
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
                      title={item.listed ? `${item.id} 已在商城上架（换分类先下架）` : item.id}
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
            <div className="flex gap-3">
              <Field width="w-40" label="售价（绑定元宝/件）">
                <Input type="number" min={0} value={createPrice} onChange={(event) => setCreatePrice(event.target.value)} />
              </Field>
              <Field width="w-40" label="购买等级">
                <Input type="number" min={0} value={createLevel} onChange={(event) => setCreateLevel(event.target.value)} />
              </Field>
            </div>
            {!createValid ? (
              <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                先选一件物品；售价 / 购买等级需为 0~{MALL_PRICE_MAX} 的整数。
              </p>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {editing ? (
        <Modal
          open
          title={<>改售价/等级 · {editing.label}</>}
          hint={<>{editing.label}（{editing.id}）。商品本体是装备数据，这里只改售价与购买等级；改完立即对购买生效。</>}
          size="md"
          onClose={closeEdit}
          footer={<>
            <Button variant="outline" disabled={submitting} onClick={closeEdit}>取消</Button>
            <Button disabled={!editValid || submitting} loading={submitting} onClick={() => void submitEdit()}>保存</Button>
          </>}
        >
          <div className="mt-5 flex gap-3">
            <Field width="w-40" label="售价（绑定元宝/件）" hint="0 = 免费">
              <Input type="number" min={0} value={editPrice} onChange={(event) => setEditPrice(event.target.value)} />
            </Field>
            <Field width="w-40" label="购买等级" hint="角色等级不足时禁购">
              <Input type="number" min={0} value={editLevel} onChange={(event) => setEditLevel(event.target.value)} />
            </Field>
          </div>
          {!editValid ? (
            <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">售价与购买等级需为 ≥0 的整数。</p>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}
