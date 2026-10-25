import { useCallback, useEffect, useState } from "react";
import { itemsApi, formatTime, PERMISSION } from "../api";
import type { Item, PageResult } from "../api";
import { Pagination } from "../components/Pagination";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/** 物品大类 → 中文名（与客户端 GOOD_TYPE 的语义对应；type 是结构字段不参与编辑） */
const TYPE_LABELS: Record<string, string> = { equipment: "装备", drug: "药品", material: "材料", other: "其他" };

const TYPE_OPTIONS = Object.entries(TYPE_LABELS);

/**
 * 物品与材料配置管理（#255，养成配置第六页）
 *
 * **只收 MATERIAL / OTHER 大类**（装备 / 药品字段形态不同，各有自己的表与页面）；
 * **没有「新建」「删除」**：物品 id 清单固定（被掉落表与脚本引用，启动时 seed 落库）；
 * `type` / `level` 不开放编辑（大类与等级属客户端结构约定）。
 * 商城售价不在这里（唯一写入口归商城定价 issue）。写操作要 `gameConfig:write`。
 */
export function ItemsPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [draft, setDraft] = useState({ keyword: "", type: "" });
  const [query, setQuery] = useState({ keyword: "", type: "" });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [data, setData] = useState<PageResult<Item> | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Item | null>(null);
  const [form, setForm] = useState<Item | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await itemsApi.list({ page, size, keyword: query.keyword || undefined, type: query.type || undefined }));
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
    setQuery({ keyword: draft.keyword.trim(), type: draft.type });
  };

  const resetSearch = () => {
    setDraft({ keyword: "", type: "" });
    setPage(1);
    setQuery({ keyword: "", type: "" });
  };

  /** 每页条数变化：回第一页再拉（条数变了页码语义也变了） */
  const handleSizeChange = (next: number) => {
    setSize(next);
    setPage(1);
  };

  const openEdit = (item: Item) => {
    setEditing(item);
    setForm({ ...item });
  };

  const closeEdit = () => {
    setEditing(null);
    setForm(null);
  };

  /** 编辑弹窗提交（部分更新：只发弹窗里有的字段） */
  const submitEdit = async () => {
    if (!editing || !form) return;
    try {
      await itemsApi.update(editing.id, {
        label: form.label,
        description: form.description,
        sellPrice: form.sellPrice,
        maxStack: form.maxStack,
      });
      toastSuccess(`物品「${form.label}」已更新`);
      closeEdit();
      await load();
    } catch {
      /* 失败保持弹窗打开，请求层已统一提示 */
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-50">物品配置</h1>
        <p className="mt-1 text-xs text-slate-500">
          只收材料与其他大类（装备 / 药品各有自己的配置页）；id 清单固定（被掉落表与脚本引用），
          只可编辑、不可新增 / 删除；大类与等级需求不开放编辑。商城售价归「商城定价」管理，不在这里。
        </p>
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">id / 名称 / 描述</span>
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
            <span className="mb-1.5 block text-xs font-medium text-slate-400">大类</span>
            <Select value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value })}>
              <option value="">全部</option>
              {TYPE_OPTIONS.map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </Select>
          </div>
          <Button onClick={submitSearch}>查询</Button>
          <Button variant="outline" onClick={resetSearch}>
            重置
          </Button>
        </div>
      </Card>

      <Card
        title="物品列表"
        actions={loading ? <Spinner /> : null}
        description={canWrite ? undefined : "当前角色没有「修改养成配置」权限，列表只读。"}
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>id</th>
                <th className={thClass}>大类</th>
                <th className={thClass}>名称 / 描述</th>
                <th className={thClass}>等级</th>
                <th className={thClass}>售价</th>
                <th className={thClass}>堆叠</th>
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data?.list.map((item) => (
                <tr key={item.id} className="transition hover:bg-slate-800/30">
                  <td className={`${tdClass} font-mono text-xs text-slate-300`}>{item.id}</td>
                  <td className={tdClass}>
                    <Badge tone="slate">{TYPE_LABELS[item.type] ?? item.type}</Badge>
                  </td>
                  <td className={tdClass}>
                    <span className="block font-medium text-slate-100">{item.label}</span>
                    <span className="mt-0.5 block max-w-[240px] truncate text-xs text-slate-500" title={item.description}>
                      {item.description}
                    </span>
                  </td>
                  <td className={tdClass}>{item.level}</td>
                  <td className={tdClass}>{item.sellPrice}</td>
                  <td className={tdClass}>
                    <Badge tone="slate">{item.maxStack}</Badge>
                  </td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{formatTime(item.updatedAt)}</td>
                  <td className={`${tdClass} text-right`}>
                    <Button variant="outline" className="px-2.5 py-1 text-xs" disabled={!canWrite} onClick={() => openEdit(item)}>
                      编辑
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!loading && data && data.list.length === 0 ? <EmptyState title="没有匹配的物品" description="换个筛选条件试试" /> : null}

        <Pagination page={page} size={size} total={data?.total ?? 0} onChange={setPage} onSizeChange={handleSizeChange} />
      </Card>

      {form ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
            <h3 className="text-base font-semibold text-slate-100">编辑物品 · {editing?.id}</h3>
            <p className="mt-1 text-xs text-slate-500">
              部分更新：只提交下方字段；大类与等级需求不开放编辑。
            </p>

            <div className="mt-5 flex flex-col gap-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="名称">
                  <Input value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} />
                </Field>
                <Field label="售卖价" hint="0 = 不可售卖；商城售价归「商城定价」管理">
                  <Input
                    type="number"
                    min={0}
                    value={String(form.sellPrice)}
                    onChange={(event) => setForm({ ...form, sellPrice: Math.max(0, Math.floor(Number(event.target.value) || 0)) })}
                  />
                </Field>
              </div>

              <Field label="描述">
                <Input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
              </Field>

              <Field label="堆叠上限" hint="背包里最多叠多少个">
                <Input
                  type="number"
                  min={1}
                  max={9999}
                  value={String(form.maxStack)}
                  onChange={(event) => setForm({ ...form, maxStack: Math.max(1, Math.floor(Number(event.target.value) || 1)) })}
                />
              </Field>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <Button variant="outline" onClick={closeEdit}>
                取消
              </Button>
              <Button disabled={!form.label.trim()} onClick={() => void submitEdit()}>
                保存修改
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
