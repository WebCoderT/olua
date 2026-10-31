import { useCallback, useEffect, useState } from "react";
import { equipmentIcon, formatTime, mallApi, PERMISSION } from "../api";
import type { MallPriceItem, MallSettings, PageResult } from "../api";
import { EQUIPMENT_SLOTS } from "../api/gameData";
import { GameIcon } from "../components/GameImage";
import { Pagination } from "../components/Pagination";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/** 部位下拉的选项（id + 中文名；生成物 EQUIPMENT_SLOTS 派生） */
const SLOT_OPTIONS = Object.entries(EQUIPMENT_SLOTS);

/**
 * 商城定价管理（#251，运营定价页）
 *
 * **与配置页方向相反**：商品清单来自生成物（装备全量变体），价格才是服务端数据 ——
 * 特殊价行动态增删（PUT upsert / DELETE 回统一价），未定价高亮「走统一价」。
 * 统一价在顶部卡片单改。写操作要 `gameConfig:write`。
 */
export function MallPricingPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [settings, setSettings] = useState<MallSettings | null>(null);
  const [draft, setDraft] = useState({ keyword: "", slot: "", priced: "" });
  const [query, setQuery] = useState({ keyword: "", slot: "", priced: "" });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [data, setData] = useState<PageResult<MallPriceItem> | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<MallPriceItem | null>(null);
  const [price, setPrice] = useState("0");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, settingsRow] = await Promise.all([
        mallApi.listPrices({
          page,
          size,
          keyword: query.keyword || undefined,
          slot: query.slot || undefined,
          priced: query.priced === "" ? undefined : query.priced,
        }),
        mallApi.getSettings(),
      ]);
      setData(list);
      setSettings(settingsRow);
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
    setQuery({ keyword: draft.keyword.trim(), slot: draft.slot, priced: draft.priced });
  };

  const resetSearch = () => {
    setDraft({ keyword: "", slot: "", priced: "" });
    setPage(1);
    setQuery({ keyword: "", slot: "", priced: "" });
  };

  /** 每页条数变化：回第一页再拉（条数变了页码语义也变了） */
  const handleSizeChange = (next: number) => {
    setSize(next);
    setPage(1);
  };

  /** 统一价行内保存（顶部卡片） */
  const saveSettings = async () => {
    if (!settings) return;
    setSubmitting(true);
    try {
      await mallApi.updateSettings({ defaultPrice: Math.max(0, Math.floor(Number(settings.defaultPrice) || 0)) });
      toastSuccess("统一价已更新");
      await load();
    } catch {
      /* 失败请求层已统一提示 */
    } finally {
      setSubmitting(false);
    }
  };

  const openEdit = (item: MallPriceItem) => {
    setEditing(item);
    setPrice(item.price === null ? String(settings?.defaultPrice ?? 0) : String(item.price));
    setSubmitting(false);
  };

  const closeEdit = () => {
    setEditing(null);
  };

  /** 特殊价弹窗提交（PUT upsert） */
  const submitEdit = async () => {
    if (!editing) return;
    setSubmitting(true);
    try {
      await mallApi.putPrice(editing.id, { price: Math.max(0, Math.floor(Number(price) || 0)) });
      toastSuccess(`商品「${editing.id}」定价已更新`);
      closeEdit();
      await load();
    } catch {
      /* 失败保持弹窗打开 */
    } finally {
      setSubmitting(false);
    }
  };

  /** 删除特殊价（回到统一价） */
  const removeSpecial = async (item: MallPriceItem) => {
    try {
      await mallApi.deletePrice(item.id);
      toastSuccess(`商品「${item.id}」已回到统一价`);
      await load();
    } catch {
      /* 失败请求层已统一提示 */
    }
  };

  const priceValid = Number.isInteger(Number(price)) && Number(price) >= 0;
  const settingsValid = Number.isInteger(Number(settings?.defaultPrice)) && Number(settings?.defaultPrice) >= 0;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-50">商城定价</h1>
        <p className="mt-1 text-xs text-slate-500">
          商品 = 装备全量变体（清单来自生成物，不归这里管）；特殊价行动态增删，未定价的商品走统一价。
          客户端购买以服务端复核价为准（对接等后续 issue）。
        </p>
      </div>

      <Card title="统一价" description="全场默认售价（绑定元宝/件）；特殊价优先于它。">
        {settings ? (
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-44">
              <Field label="统一价">
                <Input
                  type="number"
                  min={0}
                  disabled={!canWrite}
                  value={String(settings.defaultPrice)}
                  onChange={(event) => setSettings({ ...settings, defaultPrice: Math.max(0, Math.floor(Number(event.target.value) || 0)) })}
                />
              </Field>
            </div>
            <Button disabled={!canWrite || !settingsValid || submitting} loading={submitting} onClick={() => void saveSettings()}>
              保存统一价
            </Button>
            <span className="pb-2 text-xs text-slate-500">最近更新：{formatTime(settings.updatedAt)}</span>
          </div>
        ) : (
          <Spinner />
        )}
      </Card>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">商品 id / 显示名</span>
            <Input
              value={draft.keyword}
              placeholder="支持模糊匹配"
              onChange={(event) => setDraft({ ...draft, keyword: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
              }}
            />
          </div>
          <div className="w-32">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">部位</span>
            <Select value={draft.slot} onChange={(event) => setDraft({ ...draft, slot: event.target.value })}>
              <option value="">全部</option>
              {SLOT_OPTIONS.map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-36">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">定价状态</span>
            <Select value={draft.priced} onChange={(event) => setDraft({ ...draft, priced: event.target.value })}>
              <option value="">全部</option>
              <option value="true">已设特殊价</option>
              <option value="false">未定价（统一价）</option>
            </Select>
          </div>
          <Button onClick={submitSearch}>查询</Button>
          <Button variant="outline" onClick={resetSearch}>
            重置
          </Button>
        </div>
      </Card>

      <Card
        title="商品定价列表"
        actions={loading ? <Spinner /> : null}
        description={canWrite ? undefined : "当前角色没有「修改养成配置」权限，列表只读。"}
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>图</th>
                <th className={thClass}>商品 id</th>
                <th className={thClass}>名称</th>
                <th className={thClass}>部位</th>
                <th className={thClass}>等级</th>
                <th className={thClass}>售价</th>
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data?.list.map((item) => (
                <tr key={item.id} className="transition hover:bg-slate-800/30">
                  <td className={tdClass}>
                    <GameIcon path={equipmentIcon(item.id)} alt={item.label} />
                  </td>
                  <td className={`${tdClass} font-mono text-xs text-slate-300`}>{item.id}</td>
                  <td className={`${tdClass} max-w-[240px] truncate font-medium text-slate-100`} title={item.label}>
                    {item.label}
                  </td>
                  <td className={tdClass}>
                    <Badge tone="slate">{SLOT_OPTIONS.find(([value]) => value === item.slot)?.[1] ?? item.slot}</Badge>
                  </td>
                  <td className={tdClass}>{item.level}</td>
                  <td className={tdClass}>
                    {item.price === null ? (
                      <span className="text-xs text-amber-300">统一价 {settings?.defaultPrice ?? "—"}</span>
                    ) : (
                      <span className="font-medium text-emerald-300">{item.price}</span>
                    )}
                  </td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{item.updatedAt === null ? "—" : formatTime(item.updatedAt)}</td>
                  <td className={`${tdClass} text-right`}>
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" className="px-2.5 py-1 text-xs" disabled={!canWrite} onClick={() => openEdit(item)}>
                        {item.price === null ? "定价" : "改价"}
                      </Button>
                      {item.price !== null ? (
                        <Button variant="outline" className="px-2.5 py-1 text-xs" disabled={!canWrite} onClick={() => void removeSpecial(item)}>
                          回统一价
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!loading && data && data.list.length === 0 ? <EmptyState title="没有匹配的商品" description="换个筛选条件试试" /> : null}

        <Pagination page={page} size={size} total={data?.total ?? 0} onChange={setPage} onSizeChange={handleSizeChange} />
      </Card>

      {editing ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
            <h3 className="text-base font-semibold text-slate-100">设置特殊价 · {editing.id}</h3>
            <p className="mt-1 text-xs text-slate-500">
              {editing.label}。特殊价只影响这一件商品（品质变体各自定价）；「回统一价」在列表行操作里。
            </p>

            <div className="mt-5">
              <Field label="特殊售价（绑定元宝/件）" hint="0 = 免费领取也合法">
                <Input type="number" min={0} value={price} onChange={(event) => setPrice(event.target.value)} />
              </Field>
            </div>
            {!priceValid ? (
              <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">售价需为 ≥0 的整数。</p>
            ) : null}

            <div className="mt-6 flex justify-end gap-2">
              <Button variant="outline" disabled={submitting} onClick={closeEdit}>
                取消
              </Button>
              <Button disabled={!priceValid || submitting} loading={submitting} onClick={() => void submitEdit()}>
                保存定价
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
