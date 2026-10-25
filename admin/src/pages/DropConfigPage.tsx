import { useCallback, useEffect, useState } from "react";
import { dropApi, formatTime, itemText, PERMISSION } from "../api";
import type { DropEntry, DropTable, MonsterDrop, PageResult } from "../api";
import { Pagination } from "../components/Pagination";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/** 来源中文名（语义标注：引用具名表 / 内联条目 / 未配置走兜底） */
const SOURCE_LABELS: Record<string, string> = { table: "具名表", entries: "内联", none: "兜底" };
const SOURCE_TONE: Record<string, "indigo" | "green" | "slate"> = { table: "indigo", entries: "green", none: "slate" };

/** picks 的编辑形态：两个输入，max 留空 = 固定件数（min），都填 = [min, max] */
type PicksDraft = { min: string; max: string };

function picksOf(value: unknown): PicksDraft {
  if (Array.isArray(value)) return { min: String(value[0]), max: String(value[1]) };
  return { min: String(value ?? 1), max: "" };
}

/** PicksDraft → 服务端形状（max 空 = 数字；非法返回 undefined 由调用方拦） */
function picksFrom(draft: PicksDraft): number | [number, number] | undefined {
  const min = Number(draft.min);
  if (!Number.isInteger(min) || min < 1) return undefined;
  if (draft.max.trim() === "") return min;
  const max = Number(draft.max);
  if (!Number.isInteger(max) || max < min) return undefined;
  return [min, max];
}

/** 条目行（编辑器内的可变形状：数字输入都是字符串） */
type EntryDraft = { goodId: string; weight: string; chance: string; countMin: string; countMax: string };

function entriesOf(entries: DropEntry[] | null): EntryDraft[] {
  return (entries ?? []).map((entry) => ({
    goodId: entry.goodId,
    weight: String(entry.weight ?? 1),
    chance: String(entry.chance ?? 1),
    countMin: String(entry.count?.[0] ?? 1),
    countMax: String(entry.count?.[1] ?? 1),
  }));
}

function entriesFrom(drafts: EntryDraft[]): DropEntry[] | undefined {
  return drafts.map((draft) => ({
    goodId: draft.goodId.trim(),
    weight: Number(draft.weight) || 0,
    chance: Number(draft.chance),
    count: [Number(draft.countMin) || 1, Number(draft.countMax) || 1],
  }));
}

/** 条目草稿的即时校验（显示层拦截；权威在服务端：goodId 存在性 / count min ≤ max） */
function entryErrors(drafts: EntryDraft[]): string[] {
  const errors: string[] = [];
  drafts.forEach((draft, index) => {
    const where = `条目 ${index + 1}`;
    if (!draft.goodId.trim()) errors.push(`${where} 的物品 id 为空`);
    if (Number(draft.chance) < 0 || Number(draft.chance) > 1) errors.push(`${where} 的概率要在 0~1 之间`);
    if (Number(draft.countMin) > Number(draft.countMax)) errors.push(`${where} 的数量下限大于上限`);
  });
  return errors;
}

/**
 * 条目池编辑器（具名表与每怪内联共用一份）
 *
 * 每行：物品 id + 物品名提示 + 权重 + 概率 + 数量区间；可增删行。
 * 物品名走 gameData 查表（ITEM_LABELS = 装备全量变体 + 药品 + 材料，与服务端校验同一来源）。
 */
function EntriesEditor({ drafts, onChange }: { drafts: EntryDraft[]; onChange: (next: EntryDraft[]) => void }) {
  const update = (index: number, patch: Partial<EntryDraft>) => {
    onChange(drafts.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)));
  };
  const remove = (index: number) => onChange(drafts.filter((_, i) => i !== index));
  const add = () => onChange([...drafts, { goodId: "", weight: "1", chance: "1", countMin: "1", countMax: "1" }]);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-slate-400">条目池（weight 权重 / chance 概率 0~1 / count 数量区间）</span>
        <Button variant="outline" className="px-2.5 py-1 text-xs" onClick={add}>
          加一条
        </Button>
      </div>
      <div className="flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
        {drafts.map((draft, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <div className="min-w-[180px] flex-1">
              <Input
                value={draft.goodId}
                placeholder="物品 id（如 drug_hp_1 / weapon_1_p0s1）"
                className="font-mono text-xs"
                onChange={(event) => update(index, { goodId: event.target.value })}
              />
              <span className="mt-0.5 block truncate text-[10px] text-slate-500">{itemText(draft.goodId)}</span>
            </div>
            <Input type="number" min={0} step="0.01" className="w-20" aria-label="权重" value={draft.weight} onChange={(event) => update(index, { weight: event.target.value })} />
            <Input type="number" min={0} max={1} step="0.01" className="w-20" aria-label="概率" value={draft.chance} onChange={(event) => update(index, { chance: event.target.value })} />
            <div className="flex items-center gap-1">
              <Input type="number" min={0} className="w-16" aria-label="数量下限" value={draft.countMin} onChange={(event) => update(index, { countMin: event.target.value })} />
              <span className="text-xs text-slate-600">~</span>
              <Input type="number" min={0} className="w-16" aria-label="数量上限" value={draft.countMax} onChange={(event) => update(index, { countMax: event.target.value })} />
            </div>
            <Button variant="outline" className="px-2 py-1 text-xs" disabled={drafts.length <= 1} onClick={() => remove(index)}>
              删
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** picks 编辑（max 空 = 固定件数） */
function PicksEditor({ draft, onChange }: { draft: PicksDraft; onChange: (next: PicksDraft) => void }) {
  return (
    <div className="flex items-end gap-2">
      <Field label="抽取件数下限">
        <Input type="number" min={1} className="w-24" value={draft.min} onChange={(event) => onChange({ ...draft, min: event.target.value })} />
      </Field>
      <Field label="上限（留空 = 固定）">
        <Input type="number" min={1} className="w-24" value={draft.max} onChange={(event) => onChange({ ...draft, max: event.target.value })} />
      </Field>
    </div>
  );
}

/**
 * 具名表编辑弹窗（新建 / 编辑共用；id 只在创建时可填）
 */
function DropTableDialog({
  open,
  creating,
  initial,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  creating: boolean;
  initial: DropTable | null;
  onCancel: () => void;
  onSubmit: (value: { id: string; picks: number | [number, number]; entries: DropEntry[] }) => Promise<boolean>;
}) {
  const [id, setId] = useState("");
  const [picks, setPicks] = useState<PicksDraft>({ min: "1", max: "" });
  const [drafts, setDrafts] = useState<EntryDraft[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setId(initial?.id ?? "");
    setPicks(picksOf(initial?.picks));
    setDrafts(entriesOf(initial?.entries ?? null).length > 0 ? entriesOf(initial?.entries ?? null) : [{ goodId: "", weight: "1", chance: "1", countMin: "1", countMax: "1" }]);
    setSubmitting(false);
  }, [open, initial]);

  if (!open) return null;

  const idValid = creating ? /^[a-z][a-z0-9_]{0,49}$/.test(id.trim()) : true;
  const picksValue = picksFrom(picks);
  const errors = entryErrors(drafts);
  const canSubmit = idValid && picksValue !== undefined && drafts.length > 0 && errors.length === 0 && drafts.every((d) => d.goodId.trim()) && !submitting;

  const submit = async () => {
    if (picksValue === undefined) return;
    setSubmitting(true);
    await onSubmit({ id: id.trim(), picks: picksValue, entries: entriesFrom(drafts)! });
    setSubmitting(false);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
        <h3 className="text-base font-semibold text-slate-100">{creating ? "新建具名掉落表" : `编辑具名掉落表 · ${initial?.id}`}</h3>
        <p className="mt-1 text-xs text-slate-500">表可被多只怪复用；被引用中的表不能删。改表即时生效（服务端掉落结算直读表）。</p>

        <div className="mt-5 flex flex-col gap-4">
          <div className="flex items-end gap-4">
            <Field label="表 id">
              <Input value={id} disabled={!creating} className="font-mono text-xs" placeholder="如 event_gold" onChange={(event) => setId(event.target.value)} />
            </Field>
            <PicksEditor draft={picks} onChange={setPicks} />
          </div>

          <EntriesEditor drafts={drafts} onChange={setDrafts} />

          {!idValid ? <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">表 id 只能是小写字母开头的字母 / 数字 / 下划线（≤50 字符）。</p> : null}
          {picksValue === undefined ? <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">抽取件数需为 ≥1 的整数（或 1 ≤ 下限 ≤ 上限）。</p> : null}
          {errors.length > 0 ? <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">{errors.join("；")}。</p> : null}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" disabled={submitting} onClick={onCancel}>
            取消
          </Button>
          <Button disabled={!canSubmit} loading={submitting} onClick={() => void submit()}>
            保存
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * 每怪掉落编辑弹窗（三选一：引用具名表 / 内联条目池 / 清空走兜底）
 */
function MonsterDropDialog({
  open,
  initial,
  tableIds,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  initial: MonsterDrop | null;
  tableIds: string[];
  onCancel: () => void;
  onSubmit: (value: { tableId: string | null; picks?: number | [number, number]; entries?: DropEntry[] }) => Promise<boolean>;
}) {
  /** mode：table = 引用具名表；inline = 内联条目池；none = 清空 */
  const [mode, setMode] = useState<"table" | "inline" | "none">("inline");
  const [tableId, setTableId] = useState("");
  const [picks, setPicks] = useState<PicksDraft>({ min: "1", max: "" });
  const [drafts, setDrafts] = useState<EntryDraft[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open || !initial) return;
    if (initial.source === "table") {
      setMode("table");
      setTableId(initial.tableId ?? "");
      setPicks(initial.picks !== null ? picksOf(initial.picks) : { min: "", max: "" });
    } else if (initial.source === "entries") {
      setMode("inline");
      setTableId("");
      setPicks(picksOf(initial.picks));
    } else {
      setMode("none");
      setTableId("");
      setPicks({ min: "1", max: "" });
    }
    setDrafts(entriesOf(initial.entries).length > 0 ? entriesOf(initial.entries) : [{ goodId: "", weight: "1", chance: "1", countMin: "1", countMax: "1" }]);
    setSubmitting(false);
  }, [open, initial]);

  if (!open || !initial) return null;

  const picksValue = picksFrom(picks);
  const errors = mode === "inline" ? entryErrors(drafts) : [];
  const inlineValid = picksValue !== undefined && drafts.length > 0 && drafts.every((d) => d.goodId.trim()) && errors.length === 0;
  const tableValid = mode !== "table" || (tableId !== "" && (picks.min.trim() === "" || picksValue !== undefined));
  const canSubmit = !submitting && (mode === "none" || (mode === "inline" ? inlineValid : tableValid));

  const submit = async () => {
    setSubmitting(true);
    const value: { tableId: string | null; picks?: number | [number, number]; entries?: DropEntry[] } = { tableId: null };
    if (mode === "table") {
      value.tableId = tableId;
      if (picks.min.trim() !== "") value.picks = picksValue;
    } else if (mode === "inline") {
      value.picks = picksValue;
      value.entries = entriesFrom(drafts);
    }
    const ok = await onSubmit(value);
    setSubmitting(false);
    void ok;
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
        <h3 className="text-base font-semibold text-slate-100">编辑怪物掉落 · key {initial.monsterKey}</h3>
        <p className="mt-1 text-xs text-slate-500">整份替换：引用具名表 / 内联条目池 / 清空走兜底，三选一。改完即时生效。</p>

        <div className="mt-5 flex flex-col gap-4">
          <div className="flex gap-2">
            {(
              [
                ["table", "引用具名表"],
                ["inline", "内联条目池"],
                ["none", "清空（走兜底）"],
              ] as const
            ).map(([value, label]) => (
              <Button key={value} variant={mode === value ? "primary" : "outline"} className="px-3 py-1.5 text-xs" onClick={() => setMode(value)}>
                {label}
              </Button>
            ))}
          </div>

          {mode === "table" ? (
            <div className="flex items-end gap-4">
              <Field label="具名掉落表">
                <Select value={tableId} onChange={(event) => setTableId(event.target.value)}>
                  <option value="">选一张表…</option>
                  {tableIds.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </Select>
              </Field>
              <PicksEditor draft={picks} onChange={setPicks} />
            </div>
          ) : null}

          {mode === "inline" ? (
            <div className="flex flex-col gap-4">
              <PicksEditor draft={picks} onChange={setPicks} />
              <EntriesEditor drafts={drafts} onChange={setDrafts} />
            </div>
          ) : null}

          {mode === "none" ? <p className="rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-xs text-slate-400">清空后这只怪没有独立掉落配置，将走兜底表（default）。</p> : null}

          {picksValue === undefined && (mode === "inline" || (mode === "table" && picks.min.trim() !== "")) ? (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">抽取件数需为 ≥1 的整数（或 1 ≤ 下限 ≤ 上限）。</p>
          ) : null}
          {errors.length > 0 ? <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">{errors.join("；")}。</p> : null}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" disabled={submitting} onClick={onCancel}>
            取消
          </Button>
          <Button disabled={!canSubmit} loading={submitting} onClick={() => void submit()}>
            保存
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * 掉落配置管理（#254）
 *
 * 上：具名掉落表卡片组（完整 CRUD，被引用中的表拒绝删除）；
 * 下：每怪掉落列表（检索 + 分页 + 编辑弹窗，三选一整份替换）。
 * 条目物品名走 gameData 查表；写操作要 `gameConfig:write`。
 */
export function DropConfigPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [tables, setTables] = useState<DropTable[] | null>(null);
  const [tablesLoading, setTablesLoading] = useState(true);
  const [tableDialogOpen, setTableDialogOpen] = useState(false);
  const [tableCreating, setTableCreating] = useState(false);
  const [editingTable, setEditingTable] = useState<DropTable | null>(null);

  const [draftKeyword, setDraftKeyword] = useState("");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [data, setData] = useState<PageResult<MonsterDrop> | null>(null);
  const [loading, setLoading] = useState(true);
  const [dropDialogOpen, setDropDialogOpen] = useState(false);
  const [editingDrop, setEditingDrop] = useState<MonsterDrop | null>(null);

  const loadTables = useCallback(async () => {
    setTablesLoading(true);
    try {
      setTables((await dropApi.listTables()).list);
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setTablesLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await dropApi.listMonsterDrops({ page, size, keyword: keyword || undefined }));
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [page, size, keyword]);

  useEffect(() => {
    void loadTables();
  }, [loadTables]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitSearch = () => {
    setPage(1);
    setKeyword(draftKeyword.trim());
  };

  const resetSearch = () => {
    setDraftKeyword("");
    setPage(1);
    setKeyword("");
  };

  const handleSizeChange = (next: number) => {
    setSize(next);
    setPage(1);
  };

  /** 具名表：创建 / 更新（弹窗双用） */
  const submitTable = async (value: { id: string; picks: number | [number, number]; entries: DropEntry[] }): Promise<boolean> => {
    try {
      if (tableCreating) {
        await dropApi.createTable(value);
        toastSuccess(`掉落表「${value.id}」已创建`);
      } else if (editingTable) {
        await dropApi.updateTable(editingTable.id, { picks: value.picks, entries: value.entries });
        toastSuccess(`掉落表「${value.id}」已更新`);
      }
      setTableDialogOpen(false);
      setEditingTable(null);
      await loadTables();
      return true;
    } catch {
      return false;
    }
  };

  const removeTable = async (table: DropTable) => {
    if (!window.confirm(`确定删除掉落表「${table.id}」？被引用中的表会被拒绝。`)) return;
    try {
      await dropApi.removeTable(table.id);
      toastSuccess(`掉落表「${table.id}」已删除`);
      await loadTables();
    } catch {
      /* 错误已由请求层统一提示 */
    }
  };

  /** 每怪：整份替换（三选一） */
  const submitMonsterDrop = async (value: { tableId: string | null; picks?: number | [number, number]; entries?: DropEntry[] }): Promise<boolean> => {
    if (!editingDrop) return false;
    try {
      await dropApi.updateMonsterDrop(editingDrop.monsterKey, value);
      toastSuccess(`怪物 ${editingDrop.monsterKey} 的掉落配置已更新`);
      setDropDialogOpen(false);
      setEditingDrop(null);
      await load();
      return true;
    } catch {
      return false;
    }
  };

  const tableIds = tables?.map((table) => table.id) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-50">掉落配置</h1>
        <p className="mt-1 text-xs text-slate-500">
          具名掉落表可被多怪复用（可新建 / 删除，被引用中的拒绝删）；每怪掉落与怪物一一对应，只可整份替换
          （引用具名表 / 内联条目池 / 清空走兜底）。改完即时生效（服务端掉落结算直读表，无需客户端更新）。
        </p>
      </div>

      <Card
        title="具名掉落表"
        actions={
          <div className="flex items-center gap-2">
            {tablesLoading ? <Spinner /> : null}
            <Button
              className="px-2.5 py-1 text-xs"
              disabled={!canWrite}
              onClick={() => {
                setTableCreating(true);
                setEditingTable(null);
                setTableDialogOpen(true);
              }}
            >
              新建表
            </Button>
          </div>
        }
        description={canWrite ? undefined : "当前角色没有「修改养成配置」权限，列表只读。"}
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>id</th>
                <th className={thClass}>抽取件数</th>
                <th className={thClass}>条目数</th>
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {tables?.map((table) => (
                <tr key={table.id} className="transition hover:bg-slate-800/30">
                  <td className={`${tdClass} font-mono text-xs text-slate-300`}>{table.id}</td>
                  <td className={`${tdClass} font-mono text-xs`}>{Array.isArray(table.picks) ? `${table.picks[0]}~${table.picks[1]}` : String(table.picks)}</td>
                  <td className={tdClass}>{table.entries.length}</td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{formatTime(table.updatedAt)}</td>
                  <td className={`${tdClass} text-right`}>
                    <div className="flex justify-end gap-1.5">
                      <Button
                        variant="outline"
                        className="px-2.5 py-1 text-xs"
                        disabled={!canWrite}
                        onClick={() => {
                          setTableCreating(false);
                          setEditingTable(table);
                          setTableDialogOpen(true);
                        }}
                      >
                        编辑
                      </Button>
                      <Button variant="outline" className="px-2.5 py-1 text-xs text-red-300" disabled={!canWrite} onClick={() => void removeTable(table)}>
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!tablesLoading && tables && tables.length === 0 ? <EmptyState title="还没有具名掉落表" description="点「新建表」建一张" /> : null}
      </Card>

      <Card title="每怪掉落">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">怪物 key</span>
            <Input
              value={draftKeyword}
              placeholder="支持模糊匹配"
              onChange={(event) => setDraftKeyword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
              }}
            />
          </div>
          <Button onClick={submitSearch}>查询</Button>
          <Button variant="outline" onClick={resetSearch}>
            重置
          </Button>
        </div>
      </Card>

      <Card title="怪物掉落列表" actions={loading ? <Spinner /> : null} description={canWrite ? undefined : "当前角色没有「修改养成配置」权限，列表只读。"}>
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>key</th>
                <th className={thClass}>来源</th>
                <th className={thClass}>具名表 / 抽取件数</th>
                <th className={thClass}>条目数</th>
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data?.list.map((item) => (
                <tr key={item.monsterKey} className="transition hover:bg-slate-800/30">
                  <td className={`${tdClass} font-mono text-xs text-slate-300`}>{item.monsterKey}</td>
                  <td className={tdClass}>
                    <Badge tone={SOURCE_TONE[item.source] ?? "slate"}>{SOURCE_LABELS[item.source] ?? item.source}</Badge>
                  </td>
                  <td className={`${tdClass} font-mono text-xs`}>
                    {item.source === "table" ? item.tableId : ""}
                    {item.picks !== null && !Array.isArray(item.picks) ? String(item.picks) : ""}
                    {Array.isArray(item.picks) ? `${item.picks[0]}~${item.picks[1]}` : ""}
                  </td>
                  <td className={tdClass}>{item.entries?.length ?? "-"}</td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{formatTime(item.updatedAt)}</td>
                  <td className={`${tdClass} text-right`}>
                    <Button
                      variant="outline"
                      className="px-2.5 py-1 text-xs"
                      disabled={!canWrite}
                      onClick={() => {
                        setEditingDrop(item);
                        setDropDialogOpen(true);
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

        {!loading && data && data.list.length === 0 ? <EmptyState title="没有匹配的怪物" description="换个筛选条件试试" /> : null}

        <Pagination page={page} size={size} total={data?.total ?? 0} onChange={setPage} onSizeChange={handleSizeChange} />
      </Card>

      <DropTableDialog
        open={tableDialogOpen}
        creating={tableCreating}
        initial={editingTable}
        onCancel={() => {
          setTableDialogOpen(false);
          setEditingTable(null);
        }}
        onSubmit={submitTable}
      />

      <MonsterDropDialog
        open={dropDialogOpen}
        initial={editingDrop}
        tableIds={tableIds}
        onCancel={() => {
          setDropDialogOpen(false);
          setEditingDrop(null);
        }}
        onSubmit={submitMonsterDrop}
      />
    </div>
  );
}
