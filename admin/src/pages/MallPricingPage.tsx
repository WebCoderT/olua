import { useCallback, useEffect, useState } from "react";
import { equipmentIcon, formatTime, mallApi, PERMISSION, slotLabel } from "../api";
import type { EquipmentVariant, MallCategory, MallGoodItem, PageResult } from "../api";
import { equipmentVariantsApi } from "../api";
import { GameIcon } from "../components/GameImage";
import { Modal } from "../components/Modal";
import { Pagination } from "../components/Pagination";
import { Badge, Button, Card, EmptyState, Field, Input, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";
import { PageHeader } from "../components/PageHeader";

const MALL_PRICE_MAX = 100_000_000;
const MALL_LEVEL_MAX = 10_000;

/**
 * 商城管理（#251 / #758，运营陈列页）
 *
 * **先建分类，再在分类下上架商品**：分类是自建的陈列分组（POST 建行 / PATCH 改名与
 * 排序 / DELETE 删空分类）；商品是**关联数据** —— 上架时选一件装备变体，之后只许改
 * 售价与购买等级（名称/图标/部位归装备管理管）。客户端陈列与购买以服务端为准。
 * 写操作要 `gameConfig:write`。
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
  const [variantKeyword, setVariantKeyword] = useState("");
  const [variantOptions, setVariantOptions] = useState<EquipmentVariant[]>([]);
  const [pickedVariant, setPickedVariant] = useState<EquipmentVariant | null>(null);
  const [submitting, setSubmitting] = useState(false);

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

  /** 打开上架弹窗：变体选项按关键字现查（555 件全量下拉太长，搜索着挑） */
  const openCreate = async () => {
    setPickedVariant(null);
    setVariantKeyword("");
    setCreatePrice("0");
    setCreateLevel("0");
    setCreating(true);
    await searchVariants("");
  };

  const searchVariants = async (keyword: string) => {
    try {
      const result = await equipmentVariantsApi.list({ page: 1, size: 20, keyword: keyword || undefined });
      setVariantOptions(result.list);
    } catch {
      /* 失败请求层已统一提示 */
    }
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
            先建分类，再在分类下上架商品。商品是关联数据 —— 从装备变体里挑一件上架，
            只能改<strong>售价</strong>与<strong>购买等级</strong>（名称/图标/部位归装备管理管）；
            下架 = 删行，装备本体不受影响。购买等级不足的玩家，客户端按钮置灰、服务端拒绝成交。
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
        description={canWrite ? "点商品名所在行查看；「上架」把装备变体挂进当前分类。" : "当前角色没有「修改养成配置」权限，列表只读。"}
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
                        <GameIcon path={equipmentIcon(item.id)} alt={item.label} />
                      </td>
                      <td className={`${tdClass} font-mono text-xs text-slate-300`}>{item.id}</td>
                      <td className={`${tdClass} max-w-[240px] truncate font-medium text-slate-100`} title={item.label}>
                        {item.label}
                      </td>
                      <td className={tdClass}>
                        <Badge tone="slate">{item.slot ? slotLabel(item.slot) : "—"}</Badge>
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
              <EmptyState title="这个分类还没有商品" description="点「上架商品」从装备变体里挑一件" />
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
          hint="从装备变体里挑一件挂进当前分类；售价 0 = 免费，购买等级 0 = 不限等级。"
          size="md"
          onClose={() => setCreating(false)}
          footer={<>
            <Button variant="outline" disabled={submitting} onClick={() => setCreating(false)}>取消</Button>
            <Button disabled={!createValid || submitting} loading={submitting} onClick={() => void submitCreate()}>上架</Button>
          </>}
        >
          <div className="mt-5 flex flex-col gap-4">
            <Field label="选装备（按 id / 名称搜索）">
              <div className="flex gap-2">
                <Input
                  value={variantKeyword}
                  placeholder="如 cloth / 重甲"
                  onChange={(event) => setVariantKeyword(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void searchVariants(variantKeyword.trim());
                  }}
                />
                <Button variant="outline" onClick={() => void searchVariants(variantKeyword.trim())}>搜索</Button>
              </div>
            </Field>
            <Field label="搜索结果（点选一件）">
              <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-800">
                {variantOptions.length === 0 ? (
                  <p className="px-3 py-3 text-xs text-slate-500">没有匹配的装备变体，换个关键字</p>
                ) : (
                  variantOptions.map((variant) => (
                    <button
                      key={variant.id}
                      type="button"
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition hover:bg-slate-800/60 ${pickedVariant?.id === variant.id ? "bg-slate-800/80" : ""}`}
                      onClick={() => setPickedVariant(variant)}
                    >
                      <GameIcon path={equipmentIcon(variant.id)} alt={variant.label} size={24} />
                      <span className="font-mono text-slate-400">{variant.id}</span>
                      <span className="text-slate-100">{variant.label}</span>
                      <span className="ml-auto text-slate-500">Lv.{variant.level}</span>
                    </button>
                  ))
                )}
              </div>
            </Field>
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
                先选一件装备；售价 / 购买等级需为 0~{MALL_PRICE_MAX} 的整数。
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
