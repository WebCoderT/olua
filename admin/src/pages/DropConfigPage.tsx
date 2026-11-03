import { useCallback, useEffect, useState } from "react";
import { dropApi, formatTime, PERMISSION } from "../api";
import type { DropEntry, DropTable, MonsterDrop, PageResult } from "../api";
import { Modal } from "../components/Modal";
import { Pagination } from "../components/Pagination";
import { Badge, Button, Card, EmptyState, Field, Input, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { MonsterDropDialog } from "../components/drop/MonsterDropDialog";
import { anyPickerOpen } from "../components/pickerStack";
import {
  DROP_SOURCE_LABELS,
  DROP_SOURCE_TONE,
  EntriesEditor,
  type EntryDraft,
  PicksEditor,
  type PicksDraft,
  emptyEntryDraft,
  entriesFrom,
  entriesOf,
  entryErrors,
  picksFrom,
  picksOf,
  picksText,
} from "../components/drop/DropEditors";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";
import { PageHeader } from "../components/PageHeader";

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
    const rows = entriesOf(initial?.entries ?? null);
    setDrafts(rows.length > 0 ? rows : [emptyEntryDraft()]);
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
    <Modal
      open
      title={<>{creating ? "新建具名掉落表" : `编辑具名掉落表 · ${initial?.id}`}</>}
      hint="表可被多只怪复用；被引用中的表不能删。改表即时生效（服务端掉落结算直读表）。"
      size="lg"
      onClose={() => {
        // 物品选择器叠在本弹窗上（条目行里那个按钮）：关选择器不该把这份表一起关掉
        if (!anyPickerOpen()) onCancel();
      }}
      footer={<>
        <Button variant="outline" disabled={submitting} onClick={onCancel}>
          取消
        </Button>
        <Button disabled={!canSubmit} loading={submitting} onClick={() => void submit()}>
          保存
        </Button>
      </>}
    >
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
    </Modal>
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
  /** 正在编辑掉落的怪物 key（null = 弹窗关闭） */
  const [dropKey, setDropKey] = useState<string | null>(null);

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

  /** 每怪：弹窗自己按 key 拉数据并保存（#584 起与怪物列表共用同一个弹窗） */

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="掉落配置"
        description={<>具名掉落表可被多怪复用（可新建 / 删除，被引用中的拒绝删）；每怪掉落与怪物一一对应，只可整份替换
            （引用具名表 / 内联条目池 / 清空走兜底）。改完即时生效（服务端掉落结算直读表，无需客户端更新）。</>}
      />

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
                  <td className={`${tdClass} font-mono text-xs`}>{picksText(table.picks)}</td>
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
        <div className="flex flex-wrap items-end gap-2">
          <Field width="w-56" label="怪物 key">
              <Input
                value={draftKeyword}
                placeholder="支持模糊匹配"
                onChange={(event) => setDraftKeyword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submitSearch();
                }}
              />
            </Field>
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
                    <Badge tone={DROP_SOURCE_TONE[item.source] ?? "slate"}>{DROP_SOURCE_LABELS[item.source] ?? item.source}</Badge>
                  </td>
                  <td className={`${tdClass} font-mono text-xs`}>
                    {item.source === "table"
                      ? `${item.tableId ?? ""}${item.picks !== null ? ` · ${picksText(item.picks)}` : ""}`
                      : picksText(item.picks) || "—"}
                  </td>
                  <td className={tdClass}>{item.entries?.length ?? "-"}</td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{formatTime(item.updatedAt)}</td>
                  <td className={`${tdClass} text-right`}>
                    <Button
                      variant="outline"
                      className="px-2.5 py-1 text-xs"
                      disabled={!canWrite}
                      onClick={() => setDropKey(item.monsterKey)}
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
        monsterKey={dropKey}
        onClose={() => setDropKey(null)}
        onSaved={() => {
          setDropKey(null);
          void load();
        }}
      />
    </div>
  );
}
