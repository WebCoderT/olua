import { useCallback, useEffect, useState } from "react";
import { formatTime, moneyItemsApi, MONEY_KIND_LABELS, MONEY_KIND_OPTIONS, PERMISSION } from "../api";
import type { CreateMoneyItem, MoneyItem, MoneyItemPage, UpdateMoneyItem } from "../api";
import { GameIcon } from "../components/GameImage";
import { IconField } from "../components/ImagePicker";
import { anyPickerOpen } from "../components/pickerStack";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import { Pagination } from "../components/Pagination";
import { PageHeader } from "../components/PageHeader";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/**
 * 面值快捷档（出厂 8 档，见服务端 `common/constants/money-items.ts` 的 MONEY_AMOUNTS）
 *
 * 只做新建弹窗的 `<datalist>` 提示 —— **不是白名单**：运营要 8888 面值照样能建，
 * 这个列表只是把最常用的几档点一下就能填上。
 */
const AMOUNT_PRESETS = [10, 50, 100, 200, 500, 1000, 5000, 100000];

/** 弹窗里编辑的字段（新建 / 编辑共用同一个形状；id 只在新建时可填） */
type MoneyForm = {
  id: string;
  label: string;
  description: string;
  icon: string;
  currency: string;
  amount: number;
  maxStack: number;
  sellPrice: number;
  /** 掉落时强制绑定角色（绑定后不可交易）；不勾则由怪物标记 / 掉落参数随机决定 */
  bindOnDrop: boolean;
};

/** 空表单（新建默认落「绑定元宝 100」，最常见的一种，改两下就能建） */
function emptyForm(): MoneyForm {
  return {
    id: "",
    label: "",
    description: "",
    icon: "",
    currency: MONEY_KIND_OPTIONS[0],
    amount: 100,
    maxStack: 999,
    sellPrice: 0,
    bindOnDrop: false,
  };
}

/** 面值带千分位（100000 → 100,000；表里几万面值一眼看得清位数） */
function amountText(amount: number): string {
  return amount.toLocaleString("zh-CN");
}

/**
 * 货币道具配置（#785）
 *
 * 一张表就是「哪种货币的多少面值」：使用后把 `amount` 加进角色存档的 `currency` 字段
 * （收敛后只有 `bindGold`，#843/#844），格子扣 1。**面值与币种都只在服务端算**，客户端
 * 只报「用哪一格」，所以运营在这里改数即时生效（玩家手上的旧道具按新面值入账）。
 *
 * 增删改都在这一页：`id` 是背包引用的键，只在新建时可填（缺省按货币 + 面值派生）；
 * 删除**只删配置行、不碰玩家存档**，背包里还引用它的格子会变成认不出的道具 ——
 * 客户端与结算都只是安静跳过（用不了，也不报错）。
 */
export function MoneyItemsPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [draftKeyword, setDraftKeyword] = useState("");
  const [keyword, setKeyword] = useState("");
  /** 币种筛选（空串 = 全部）；选完即生效，不必点查询 */
  const [currency, setCurrency] = useState("");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(50);
  const [data, setData] = useState<MoneyItemPage | null>(null);
  const [loading, setLoading] = useState(true);
  /** 正在编辑的行（null = 弹窗没开） */
  const [editing, setEditing] = useState<MoneyItem | null>(null);
  /** 正在新建（弹窗没开 = false） */
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<MoneyForm>(emptyForm());
  const [saving, setSaving] = useState(false);
  /** 待删除的行（二次确认弹窗） */
  const [removing, setRemoving] = useState<MoneyItem | null>(null);
  const [removingBusy, setRemovingBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await moneyItemsApi.list({ page, size, keyword: keyword || undefined, currency: currency || undefined }));
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [page, size, keyword, currency]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitSearch = () => {
    setPage(1);
    setKeyword(draftKeyword.trim());
  };

  const resetSearch = () => {
    setDraftKeyword("");
    setKeyword("");
    setCurrency("");
    setPage(1);
  };

  /** 每页条数变化：回第一页再拉（条数变了页码语义也变了） */
  const handleSizeChange = (next: number) => {
    setSize(next);
    setPage(1);
  };

  const openCreate = () => {
    setCreating(true);
    setForm(emptyForm());
  };

  const openEdit = (item: MoneyItem) => {
    setEditing(item);
    setForm({
      id: item.id,
      label: item.label,
      description: item.description,
      icon: item.icon,
      currency: item.currency,
      amount: item.amount,
      maxStack: item.maxStack,
      sellPrice: item.sellPrice,
      bindOnDrop: item.bindOnDrop === true,
    });
  };

  const closeDialog = () => {
    setCreating(false);
    setEditing(null);
  };

  /** 新建：只发有值的字段，空串一律不发（让服务端按「货币 + 面值」派生 id / 名称 / 图标） */
  const submitCreate = async () => {
    const body: CreateMoneyItem = {
      currency: form.currency,
      amount: form.amount,
      maxStack: form.maxStack,
      sellPrice: form.sellPrice,
      bindOnDrop: form.bindOnDrop,
    };
    if (form.id.trim()) body.id = form.id.trim();
    if (form.label.trim()) body.label = form.label.trim();
    if (form.description.trim()) body.description = form.description.trim();
    if (form.icon.trim()) body.icon = form.icon.trim();
    setSaving(true);
    try {
      const created = await moneyItemsApi.create(body);
      toastSuccess(`货币物品「${created.label}」已创建（id：${created.id}）`);
      closeDialog();
      await load();
    } catch {
      /* 失败保持弹窗打开，请求层已统一提示 */
    } finally {
      setSaving(false);
    }
  };

  /** 编辑（部分更新：只发弹窗里有的字段；id 不可改，所以不放进去） */
  const submitEdit = async () => {
    if (!editing) return;
    const body: UpdateMoneyItem = {
      label: form.label,
      description: form.description,
      icon: form.icon,
      currency: form.currency,
      amount: form.amount,
      maxStack: form.maxStack,
      sellPrice: form.sellPrice,
      bindOnDrop: form.bindOnDrop,
    };
    setSaving(true);
    try {
      await moneyItemsApi.update(editing.id, body);
      toastSuccess(`货币物品「${form.label}」已更新`);
      closeDialog();
      await load();
    } catch {
      /* 失败保持弹窗打开，请求层已统一提示 */
    } finally {
      setSaving(false);
    }
  };

  const submitRemove = async () => {
    if (!removing) return;
    setRemovingBusy(true);
    try {
      const result = await moneyItemsApi.delete(removing.id);
      toastSuccess(result.removed > 0 ? `已删除「${removing.label}」` : "这条刚被别人删掉了");
      setRemoving(null);
      await load();
    } catch {
      /* 失败保持弹窗打开，请求层已统一提示 */
    } finally {
      setRemovingBusy(false);
    }
  };

  const dialogOpen = creating || editing !== null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="货币道具"
        description={
          <>
            使用后直接把面值加进对应金钱（绑定元宝，唯一货币），并扣掉 1 个。面值与币种只认服务端这张表 ——
            改这里即时生效，玩家背包里的旧道具按新面值入账。删除只删配置行、不碰玩家存档。
          </>
        }
        actions={
          <Button disabled={!canWrite} onClick={openCreate}>
            新建货币物品
          </Button>
        }
      />

      <Card>
        <div className="flex flex-wrap items-end gap-2">
          <Field width="w-56" label="id / 名称 / 描述">
            <Input
              value={draftKeyword}
              placeholder="支持模糊匹配"
              onChange={(event) => setDraftKeyword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
              }}
            />
          </Field>
          <Field width="w-40" label="货币">
            <Select
              value={currency}
              onChange={(event) => {
                setCurrency(event.target.value);
                setPage(1);
              }}
            >
              <option value="">全部</option>
              {MONEY_KIND_OPTIONS.map((kind) => (
                <option key={kind} value={kind}>
                  {MONEY_KIND_LABELS[kind]}
                </option>
              ))}
            </Select>
          </Field>
          <Button onClick={submitSearch}>查询</Button>
          <Button variant="outline" onClick={resetSearch}>
            重置
          </Button>
        </div>
      </Card>

      <Card title="货币物品列表" actions={loading ? <Spinner /> : null} description={canWrite ? undefined : "当前角色没有「修改养成配置」权限，列表只读。"}>
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>图</th>
                <th className={thClass}>id</th>
                <th className={thClass}>名称</th>
                <th className={thClass}>货币</th>
                <th className={thClass}>面值</th>
                <th className={thClass}>堆叠</th>
                <th className={thClass}>售价</th>
                <th className={thClass}>掉落绑定</th>
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data?.list.map((item) => (
                <tr key={item.id} className="transition hover:bg-slate-800/30">
                  <td className={tdClass}>
                    <GameIcon path={item.icon} alt={item.label} />
                  </td>
                  <td className={`${tdClass} font-mono text-xs text-slate-300`}>{item.id}</td>
                  <td className={tdClass}>
                    <span className="block font-medium text-slate-100">{item.label}</span>
                    <span className="mt-0.5 block max-w-[280px] truncate text-xs text-slate-500" title={item.description}>
                      {item.description || "—"}
                    </span>
                  </td>
                  <td className={tdClass}>
                    <Badge tone="slate">
                      {MONEY_KIND_LABELS[item.currency] ?? item.currency}
                    </Badge>
                  </td>
                  <td className={`${tdClass} font-mono text-sm text-amber-200`}>+{amountText(item.amount)}</td>
                  <td className={tdClass}>{item.maxStack}</td>
                  <td className={tdClass}>{item.sellPrice > 0 ? amountText(item.sellPrice) : "不可出售"}</td>
                  <td className={tdClass}>
                    <Badge tone={item.bindOnDrop ? "amber" : "slate"}>{item.bindOnDrop ? "强制绑定" : "—"}</Badge>
                  </td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{formatTime(item.updatedAt)}</td>
                  <td className={`${tdClass} text-right`}>
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" className="px-2.5 py-1 text-xs" disabled={!canWrite} onClick={() => openEdit(item)}>
                        编辑
                      </Button>
                      <Button variant="danger" className="px-2.5 py-1 text-xs" disabled={!canWrite} onClick={() => setRemoving(item)}>
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!loading && data && data.list.length === 0 ? (
          <EmptyState title="没有匹配的货币物品" description="换个筛选条件，或点右上角「新建货币物品」" />
        ) : null}

        <Pagination page={page} size={size} total={data?.total ?? 0} onChange={setPage} onSizeChange={handleSizeChange} />
      </Card>

      {dialogOpen ? (
        <Modal
          open
          title={creating ? "新建货币物品" : <>编辑货币物品 · {editing?.id}</>}
          hint={
            creating
              ? "只填「货币 + 面值」就能建：id / 名称 / 描述 / 图标留空会按「货币 + 面值」自动派生（如 money_bind_gold_100 / 绑定元宝（100）/ item/currency/bind-gold-100）。"
              : "部分更新：只提交下方字段。id 是背包引用的键，不可修改（改 id 等于换一件物品）。"
          }
          size="md"
          /* Esc 先到编辑弹窗：选择器开着时不能把编辑弹窗一起关掉（改了一半的内容会丢） */
          onClose={() => {
            if (!anyPickerOpen()) closeDialog();
          }}
          footer={
            <>
              <Button variant="outline" onClick={closeDialog} disabled={saving}>
                取消
              </Button>
              <Button
                disabled={saving || form.amount < 1 || (!creating && !form.label.trim())}
                loading={saving}
                onClick={() => void (creating ? submitCreate() : submitEdit())}
              >
                {creating ? "创建" : "保存修改"}
              </Button>
            </>
          }
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="货币" hint="决定加进角色存档的哪个金钱字段">
              <Select value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value })}>
                {MONEY_KIND_OPTIONS.map((kind) => (
                  <option key={kind} value={kind}>
                    {MONEY_KIND_LABELS[kind]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="面值" hint="使用一个加多少（1 ~ 1000000）">
              <Input
                type="number"
                min={1}
                max={1000000}
                list="money-item-amount-presets"
                value={String(form.amount)}
                onChange={(event) => setForm({ ...form, amount: Math.max(1, Math.floor(Number(event.target.value) || 1)) })}
              />
              <datalist id="money-item-amount-presets">
                {AMOUNT_PRESETS.map((preset) => (
                  <option key={preset} value={preset} />
                ))}
              </datalist>
            </Field>
          </div>

          {creating ? (
            <Field label="id" hint="留空 = 按「货币 + 面值」派生（推荐）；小写字母开头，只能用小写字母 / 数字 / 下划线">
              <Input value={form.id} placeholder="留空自动生成，如 money_bind_gold_100" onChange={(event) => setForm({ ...form, id: event.target.value })} />
            </Field>
          ) : (
            <Field label="id" hint="主键，创建后不可修改（背包里按它引用）">
              <Input value={form.id} disabled />
            </Field>
          )}

          <Field label="名称" hint={creating ? "留空 = 「货币中文名（面值）」" : undefined}>
            <Input value={form.label} placeholder={creating ? "留空自动生成，如 绑定元宝（100）" : undefined} onChange={(event) => setForm({ ...form, label: event.target.value })} />
          </Field>
          <Field label="描述" hint={creating ? "留空 = 「使用后获得 N 点…」" : undefined}>
            <Input value={form.description} placeholder={creating ? "留空自动生成" : undefined} onChange={(event) => setForm({ ...form, description: event.target.value })} />
          </Field>
          <IconField
            label="图标"
            hint="resources 相对路径（如 item/currency/bind-gold-100，不带扩展名）；空串 = 不显示图标"
            rootDir="item"
            placeholder="item/currency/bind-gold-100"
            value={form.icon}
            onChange={(path) => setForm({ ...form, icon: path })}
          />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="堆叠上限" hint="背包里最多叠多少个">
              <Input
                type="number"
                min={1}
                max={999}
                value={String(form.maxStack)}
                onChange={(event) => setForm({ ...form, maxStack: Math.min(999, Math.max(1, Math.floor(Number(event.target.value) || 1))) })}
              />
            </Field>
            <Field label="售卖价" hint="0 = 不可出售">
              <Input
                type="number"
                min={0}
                value={String(form.sellPrice)}
                onChange={(event) => setForm({ ...form, sellPrice: Math.max(0, Math.floor(Number(event.target.value) || 0)) })}
              />
            </Field>
          </div>

          <Field label="掉落绑定" hint="掉落时强制绑定角色（绑定后不可交易）—— 与怪物侧的「掉落整体强制绑定」是「或」的关系">
            <Select value={form.bindOnDrop ? "true" : "false"} onChange={(event) => setForm({ ...form, bindOnDrop: event.target.value === "true" })}>
              <option value="false">不强制（按掉落参数随机）</option>
              <option value="true">强制绑定</option>
            </Select>
          </Field>
        </Modal>
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        title="删除货币物品"
        description={
          removing
            ? `确定删除「${removing.label}」（${removing.id}）？只删配置行，玩家背包里还引用它的格子会变成认不出的道具 —— 用不了，也不报错。`
            : undefined
        }
        confirmText="删除"
        loading={removingBusy}
        onConfirm={() => void submitRemove()}
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}
