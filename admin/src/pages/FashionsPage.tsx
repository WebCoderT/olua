import { useCallback, useEffect, useMemo, useState } from "react";
import { ACQUIRE_CHANNEL, fashionsApi, formatTime, PERMISSION } from "../api";
import type { ConfigAttributes, Fashion, FashionQuery, PageResult } from "../api";
import { AttributesGrid, crossedRangeKeys } from "../components/AttributesEditor";
import { Pagination } from "../components/Pagination";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/**
 * 获得渠道中文名（#257）
 *
 * 渠道**取值域**复用称号的 AcquireChannel（upgrade / grant / unavailable，同一套
 * 服务端常量），但中文名按时装语境另配 —— 「称号升级」对时装说不通。这里只管显示，
 * 不是第二个取值来源（值域仍在 ACQUIRE_CHANNEL）。
 */
const FASHION_CHANNEL_LABELS: Record<string, string> = {
  [ACQUIRE_CHANNEL.UPGRADE]: "商城购买",
  [ACQUIRE_CHANNEL.GRANT]: "系统赠送",
  [ACQUIRE_CHANNEL.UNAVAILABLE]: "无法获取",
};
const CHANNEL_OPTIONS = Object.entries(FASHION_CHANNEL_LABELS);
const CHANNEL_TONE: Record<string, "green" | "indigo" | "slate"> = {
  [ACQUIRE_CHANNEL.UPGRADE]: "green",
  [ACQUIRE_CHANNEL.GRANT]: "indigo",
  [ACQUIRE_CHANNEL.UNAVAILABLE]: "slate",
};

/** 属性摘要（列表列太窄，只报几个关键数；完整数值在编辑弹窗里） */
function attributeSummary(item: Fashion): string {
  const a = item.attributes;
  return `生命 ${a.maxHp} · 物攻 ${a.physicalAttack.min}~${a.physicalAttack.max} · 物防 ${a.physicalDefense.min}~${a.physicalDefense.max}`;
}

/**
 * 时装编辑弹窗（#257）
 *
 * 开放「名称 + 描述 + 售卖价 + 获得渠道 + 八项属性」；`icon` / `inRes` / `outRes`
 * 不开放编辑（资源路径是表现层，染色 / 外观资源仍在客户端）。属性**整份提交、
 * 整份替换**（服务端口径）。校验分工：min ≤ max 在这里做即时提示，权威在服务端。
 */
function FashionEditDialog({
  open,
  initial,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  initial: Fashion | null;
  onCancel: () => void;
  onSubmit: (value: { label: string; description: string; sellPrice: number; acquireChannel: string; attributes: ConfigAttributes }) => Promise<boolean>;
}) {
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [sellPrice, setSellPrice] = useState("0");
  const [channel, setChannel] = useState<string>(ACQUIRE_CHANNEL.UNAVAILABLE);
  const [attributes, setAttributes] = useState<ConfigAttributes | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLabel(initial?.label ?? "");
    setDescription(initial?.description ?? "");
    setSellPrice(initial ? String(initial.sellPrice) : "0");
    setChannel(initial?.acquireChannel ?? ACQUIRE_CHANNEL.UNAVAILABLE);
    setAttributes(initial?.attributes ? { ...initial.attributes } : null);
    setSubmitting(false);
  }, [open, initial]);

  /** 区间交叉（min > max）的键集合；空 = 合法 */
  const crossedKeys = useMemo(() => (attributes ? crossedRangeKeys(attributes) : []), [attributes]);

  if (!open || !attributes || !initial) return null;

  const labelValid = label.trim().length > 0 && label.trim().length <= 50;
  const descriptionValid = description.length <= 500;
  const priceValid = Number.isInteger(Number(sellPrice)) && Number(sellPrice) >= 0 && Number(sellPrice) <= 100_000_000;
  const canSubmit = labelValid && descriptionValid && priceValid && crossedKeys.length === 0 && !submitting;

  const submit = async () => {
    setSubmitting(true);
    await onSubmit({ label: label.trim(), description: description.trim(), sellPrice: Number(sellPrice), acquireChannel: channel, attributes });
    setSubmitting(false);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
        <h3 className="text-base font-semibold text-slate-100">编辑时装 · {initial.id}</h3>
        <p className="mt-1 text-xs text-slate-500">
          图标 / 内观 / 外观资源路径不可改（外观资源仍在客户端）。获得渠道语义与称号一致；
          属性当前配置全为 0 加成，需要强化属性时在这里改。
        </p>

        <div className="mt-5 flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="名称">
              <Input value={label} onChange={(event) => setLabel(event.target.value)} />
            </Field>
            <Field label="售卖价（绑定元宝）">
              <Input type="number" min={0} value={sellPrice} onChange={(event) => setSellPrice(event.target.value)} />
            </Field>
          </div>

          <Field label="描述文案">
            <textarea
              className="min-h-[64px] w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-sky-500"
              maxLength={500}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>

          <Field label="获得渠道">
            <Select value={channel} onChange={(event) => setChannel(event.target.value)}>
              {CHANNEL_OPTIONS.map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </Select>
          </Field>

          <AttributesGrid attributes={attributes} onChange={setAttributes} header="八项属性（整份替换）" crossed={crossedKeys} />

          {!labelValid || !descriptionValid || !priceValid ? (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              名称需为 1~50 字、描述 ≤500 字、售卖价需为 0~1 亿的整数。
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
 * 时装配置管理（#257，养成配置第八页）
 *
 * id 清单固定（configs/fashionClothes 的 20 套，启动时 seed 落库）——
 * **没有「新建」「删除」**，只有「编辑」；资源路径不开放编辑。
 * 获得渠道 seed 默认「无法获取」，由运营逐个开放（与称号同一手法）。
 * 写操作要 `gameConfig:write`。
 */
export function FashionsPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [draft, setDraft] = useState({ keyword: "", channel: "" });
  const [query, setQuery] = useState({ keyword: "", channel: "" });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [data, setData] = useState<PageResult<Fashion> | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Fashion | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fashionsApi.list({ page, size, keyword: query.keyword || undefined, acquireChannel: (query.channel || undefined) as FashionQuery["acquireChannel"] }));
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
    setQuery({ keyword: draft.keyword.trim(), channel: draft.channel });
  };

  const resetSearch = () => {
    setDraft({ keyword: "", channel: "" });
    setPage(1);
    setQuery({ keyword: "", channel: "" });
  };

  /** 每页条数变化：回第一页再拉（条数变了页码语义也变了） */
  const handleSizeChange = (next: number) => {
    setSize(next);
    setPage(1);
  };

  /** 编辑弹窗提交（部分更新：只发弹窗里有的字段；属性整份替换） */
  const submitDialog = async (value: { label: string; description: string; sellPrice: number; acquireChannel: string; attributes: ConfigAttributes }): Promise<boolean> => {
    if (!editing) return false;
    try {
      await fashionsApi.update(editing.id, { ...value, acquireChannel: value.acquireChannel as Fashion["acquireChannel"] });
      toastSuccess(`时装「${value.label}」已更新`);
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
        <h1 className="text-lg font-semibold text-slate-50">时装配置</h1>
        <p className="mt-1 text-xs text-slate-500">
          id 清单固定（configs/fashionClothes 的 20 套），只可编辑、不可新增 / 删除；图标与外观资源路径不开放编辑。
          获得渠道 seed 默认「无法获取」，由运营逐个开放；属性 seed 全 0，可按运营需要调整。
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
          <div className="w-32">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">获得渠道</span>
            <Select value={draft.channel} onChange={(event) => setDraft({ ...draft, channel: event.target.value })}>
              <option value="">全部</option>
              {CHANNEL_OPTIONS.map(([value, text]) => (
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
        title="时装列表"
        actions={loading ? <Spinner /> : null}
        description={canWrite ? undefined : "当前角色没有「修改养成配置」权限，列表只读。"}
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>id</th>
                <th className={thClass}>名称</th>
                <th className={thClass}>获得渠道</th>
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
                  <td className={`${tdClass} font-medium text-slate-100`}>{item.label}</td>
                  <td className={tdClass}>
                    <Badge tone={CHANNEL_TONE[item.acquireChannel] ?? "slate"}>
                      {FASHION_CHANNEL_LABELS[item.acquireChannel] ?? item.acquireChannel}
                    </Badge>
                  </td>
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

        {!loading && data && data.list.length === 0 ? <EmptyState title="没有匹配的时装" description="换个筛选条件试试" /> : null}

        <Pagination page={page} size={size} total={data?.total ?? 0} onChange={setPage} onSizeChange={handleSizeChange} />
      </Card>

      <FashionEditDialog
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
