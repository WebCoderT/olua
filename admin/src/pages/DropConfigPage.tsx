import { useCallback, useEffect, useState } from "react";
import { dropApi, formatTime, PERMISSION } from "../api";
import type { DropEntry, DropTable } from "../api";
import { Modal } from "../components/Modal";
import { Button, Card, EmptyState, Field, Input, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { anyPickerOpen } from "../components/pickerStack";
import {
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
          <Input value={id} disabled={!creating} className="font-mono text-xs" placeholder="如 event_bind_gold" onChange={(event) => setId(event.target.value)} />
        </Field>
        <PicksEditor draft={picks} onChange={setPicks} />
      </div>
      <EntriesEditor drafts={drafts} onChange={setDrafts} />
      {!idValid ? <p className="rounded-lg border border-ember/40 bg-ember/10 px-3 py-2 text-xs text-ember-hi">表 id 只能是小写字母开头的字母 / 数字 / 下划线（≤50 字符）。</p> : null}
      {picksValue === undefined ? <p className="rounded-lg border border-ember/40 bg-ember/10 px-3 py-2 text-xs text-ember-hi">抽取件数需为 ≥1 的整数（或 1 ≤ 下限 ≤ 上限）。</p> : null}
      {errors.length > 0 ? <p className="rounded-lg border border-ember/40 bg-ember/10 px-3 py-2 text-xs text-ember-hi">{errors.join("；")}。</p> : null}
    </Modal>
  );
}

/**
 * 掉落（模版）配置（#254 / #661）
 *
 * 本页只做**掉落模版**：具名掉落表卡片组（完整 CRUD，被引用中的表拒绝删除）。
 *
 * 「每怪掉落」不在这里 —— 怪物列表（`MonstersPage`）里每只怪自己有一行「掉落」，
 * 打开就是同一个弹窗（引用模版 / 内联条目 / 清空走兜底）。两处各放一份列表的话，
 * 同一份数据在两张表里各显示一次，改了一边还得跑去另一边核对。
 *
 * 条目物品名走 gameData 查表；写操作要 `gameConfig:write`。
 */
export function DropConfigPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [tables, setTables] = useState<DropTable[] | null>(null);
  const [tablesLoading, setTablesLoading] = useState(true);
  const [tableDialogOpen, setTableDialogOpen] = useState(false);
  const [tableCreating, setTableCreating] = useState(false);
  const [editingTable, setEditingTable] = useState<DropTable | null>(null);

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

  useEffect(() => {
    void loadTables();
  }, [loadTables]);

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

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="掉落配置"
        description={<>这一页只维护掉落模版：具名掉落表可被多怪复用（可新建 / 删除，被引用中的拒绝删）。
            每只怪引用哪张模版、或给它写一份内联条目，都在「怪物列表」里那一行「掉落」上改 —— 本页不再重复列一遍。
            改完即时生效（服务端掉落结算直读表，无需客户端更新）。</>}
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
                <tr key={table.id} className="transition hover:bg-surface-4/30">
                  <td className={`${tdClass} font-mono text-xs text-ink-3`}>{table.id}</td>
                  <td className={`${tdClass} font-mono text-xs`}>{picksText(table.picks)}</td>
                  <td className={tdClass}>{table.entries.length}</td>
                  <td className={`${tdClass} text-xs text-ink-4`}>{formatTime(table.updatedAt)}</td>
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
                      <Button variant="outline" className="px-2.5 py-1 text-xs text-ember-hi" disabled={!canWrite} onClick={() => void removeTable(table)}>
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
    </div>
  );
}
