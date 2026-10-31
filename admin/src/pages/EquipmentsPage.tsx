import { useCallback, useEffect, useMemo, useState } from "react";
import { equipmentsApi, formatTime, PERMISSION, slotLabel } from "../api";
import type { ConfigAttributes, Equipment, PageResult } from "../api";
import { AttributesGrid, crossedRangeKeys } from "../components/AttributesEditor";
import { Pagination } from "../components/Pagination";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { EQUIPMENT_SLOTS } from "../api/gameData";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/** 属性摘要（列表列太窄，只报几个关键数；完整数值在编辑弹窗里） */
function attributeSummary(item: Equipment): string {
  const a = item.attributes;
  return `生命 ${a.maxHp} · 物攻 ${a.physicalAttack.min}~${a.physicalAttack.max} · 物防 ${a.physicalDefense.min}~${a.physicalDefense.max}`;
}

/** 部位下拉的选项（id + 中文名；EQUIPMENT_SLOTS 派生，含暂无装备的 other1/other2 也无妨） */
const SLOT_OPTIONS = Object.entries(EQUIPMENT_SLOTS);

/**
 * 装备基础件编辑弹窗（#252）
 *
 * 与称号 / 战魂 / 军衔弹窗不同构到不值得共用：这里**没有名称 / 描述 / 动画 / 渠道**，
 * 只开放「等级需求 + 售卖价 + 八项属性」—— 装备的部位结构与文案属客户端资源约定。
 * 属性**整份提交、整份替换**（服务端口径），八项全部展示、全部回填。
 * 校验分工：min ≤ max 在这里做即时提示，权威在服务端（DTO 校验 + 50016/40000）。
 */
function EquipmentEditDialog({
  open,
  initial,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  initial: Equipment | null;
  onCancel: () => void;
  onSubmit: (value: { level: number; sellPrice: number; attributes: ConfigAttributes }) => Promise<boolean>;
}) {
  const [level, setLevel] = useState("1");
  const [sellPrice, setSellPrice] = useState("0");
  const [attributes, setAttributes] = useState<ConfigAttributes | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLevel(initial ? String(initial.level) : "1");
    setSellPrice(initial ? String(initial.sellPrice) : "0");
    setAttributes(initial?.attributes ? { ...initial.attributes } : null);
    setSubmitting(false);
  }, [open, initial]);

  /** 区间交叉（min > max）的键集合；空 = 合法 */
  const crossedKeys = useMemo(() => (attributes ? crossedRangeKeys(attributes) : []), [attributes]);

  if (!open || !attributes || !initial) return null;

  const levelValid = Number.isInteger(Number(level)) && Number(level) >= 1;
  const priceValid = Number.isInteger(Number(sellPrice)) && Number(sellPrice) >= 0;
  const canSubmit = levelValid && priceValid && crossedKeys.length === 0 && !submitting;

  const submit = async () => {
    setSubmitting(true);
    const ok = await onSubmit({ level: Number(level), sellPrice: Number(sellPrice), attributes });
    setSubmitting(false);
    if (!ok) return;
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
        <h3 className="text-base font-semibold text-slate-100">
          编辑装备 · {initial.id}
        </h3>
        <p className="mt-1 text-xs text-slate-500">
          部位 {slotLabel(initial.slot)} · 名称「{initial.label}」（文案与部位不可改）。变体属性 = 这里的基础属性 × 前后缀倍率，改基础件即改全部 15 个变体。
        </p>

        <div className="mt-5 flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="穿戴需求等级" hint="装备定强的锚点；等级变了属性不会自动重算（这里改的是快照值）">
              <Input
                type="number"
                min={1}
                value={level}
                onChange={(event) => setLevel(event.target.value)}
              />
            </Field>
            <Field label="售卖价" hint="0 = 不可售卖；商城售价归「商城定价」管理，不在这里">
              <Input
                type="number"
                min={0}
                value={sellPrice}
                onChange={(event) => setSellPrice(event.target.value)}
              />
            </Field>
          </div>

          <AttributesGrid attributes={attributes} onChange={setAttributes} header="基础属性（整份替换）" crossed={crossedKeys} />

          {!levelValid || !priceValid ? (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              等级需为 ≥1 的整数，售卖价需为 ≥0 的整数。
            </p>
          ) : null}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" disabled={submitting} onClick={onCancel}>
            取消
          </Button>
          <Button disabled={!canSubmit} loading={submitting} onClick={() => void submit()}>
            保存修改
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * 装备配置管理（#252，养成配置第四页）
 *
 * **只收基础件**（普通的·人级，37 件）：变体（_pXsY）是基础件乘前后缀倍率展开的，
 * 运营只改基础件这一份。id / 部位结构固定 —— **没有「新建」「删除」**，只有「编辑」，
 * 且部位 / 名称不开放编辑（属客户端资源约定）。按部位 / 等级段筛选定位。
 * 商城售价不在这里（唯一写入口归商城定价 issue）。写操作要 `gameConfig:write`。
 */
export function EquipmentsPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [draft, setDraft] = useState({ keyword: "", slot: "", minLevel: "", maxLevel: "" });
  const [query, setQuery] = useState({ keyword: "", slot: "", minLevel: "", maxLevel: "" });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [data, setData] = useState<PageResult<Equipment> | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Equipment | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(
        await equipmentsApi.list({
          page,
          size,
          keyword: query.keyword || undefined,
          slot: query.slot || undefined,
          minLevel: query.minLevel === "" ? undefined : Number(query.minLevel),
          maxLevel: query.maxLevel === "" ? undefined : Number(query.maxLevel),
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

  const submitSearch = () => {
    setPage(1);
    setQuery({ keyword: draft.keyword.trim(), slot: draft.slot, minLevel: draft.minLevel.trim(), maxLevel: draft.maxLevel.trim() });
  };

  const resetSearch = () => {
    setDraft({ keyword: "", slot: "", minLevel: "", maxLevel: "" });
    setPage(1);
    setQuery({ keyword: "", slot: "", minLevel: "", maxLevel: "" });
  };

  /** 每页条数变化：回第一页再拉（条数变了页码语义也变了） */
  const handleSizeChange = (next: number) => {
    setSize(next);
    setPage(1);
  };

  /** 编辑弹窗提交（部分更新：只发弹窗里有的字段；属性整份替换） */
  const submitDialog = async (value: { level: number; sellPrice: number; attributes: ConfigAttributes }): Promise<boolean> => {
    if (!editing) return false;
    try {
      await equipmentsApi.update(editing.id, value);
      toastSuccess(`装备「${editing.label}」已更新`);
      setDialogOpen(false);
      setEditing(null);
      await load();
      return true;
    } catch {
      return false;
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-50">装备配置</h1>
        <p className="mt-1 text-xs text-slate-500">
          只收基础件（普通的·人级），变体是基础件乘前后缀倍率展开的 —— 改基础件即改全部 15 个变体。
          id / 部位结构固定，只可编辑、不可新增 / 删除；商城售价归「商城定价」管理，不在这里。
        </p>
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">id / 名称</span>
            <Input
              value={draft.keyword}
              placeholder="支持模糊匹配"
              onChange={(event) => setDraft({ ...draft, keyword: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
              }}
            />
          </div>
          <div className="w-36">
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
          <div className="w-28">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">等级 ≥</span>
            <Input
              type="number"
              min={1}
              value={draft.minLevel}
              onChange={(event) => setDraft({ ...draft, minLevel: event.target.value })}
            />
          </div>
          <div className="w-28">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">等级 ≤</span>
            <Input
              type="number"
              min={1}
              value={draft.maxLevel}
              onChange={(event) => setDraft({ ...draft, maxLevel: event.target.value })}
            />
          </div>
          <Button onClick={submitSearch}>查询</Button>
          <Button variant="outline" onClick={resetSearch}>
            重置
          </Button>
        </div>
      </Card>

      <Card
        title="装备基础件列表"
        actions={loading ? <Spinner /> : null}
        description={canWrite ? undefined : "当前角色没有「修改养成配置」权限，列表只读。"}
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>id</th>
                <th className={thClass}>部位</th>
                <th className={thClass}>名称</th>
                <th className={thClass}>等级</th>
                <th className={thClass}>售卖价</th>
                <th className={thClass}>属性摘要</th>
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data?.list.map((item) => (
                <tr key={item.id} className="transition hover:bg-slate-800/30">
                  <td className={`${tdClass} font-mono text-xs text-slate-300`}>{item.id}</td>
                  <td className={tdClass}>
                    <Badge tone="slate">{slotLabel(item.slot)}</Badge>
                  </td>
                  <td className={`${tdClass} font-medium text-slate-100`}>{item.label}</td>
                  <td className={tdClass}>{item.level}</td>
                  <td className={tdClass}>{item.sellPrice}</td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{attributeSummary(item)}</td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{formatTime(item.updatedAt)}</td>
                  <td className={`${tdClass} text-right`}>
                    <Button
                      variant="outline"
                      className="px-2.5 py-1 text-xs"
                      disabled={!canWrite}
                      onClick={() => {
                        setEditing(item);
                        setDialogOpen(true);
                      }}
                    >
                      编辑
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!loading && data && data.list.length === 0 ? <EmptyState title="没有匹配的装备" description="换个筛选条件试试" /> : null}

        <Pagination page={page} size={size} total={data?.total ?? 0} onChange={setPage} onSizeChange={handleSizeChange} />
      </Card>

      <EquipmentEditDialog
        open={dialogOpen}
        initial={editing}
        onCancel={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
        onSubmit={submitDialog}
      />
    </div>
  );
}
