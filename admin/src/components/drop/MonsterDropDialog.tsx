import { useEffect, useState } from "react";
import type { DropEntry, DropTable } from "../../api";
import { dropApi, PERMISSION } from "../../api";
import { hasPermission } from "../../store/session";
import { toastSuccess } from "../../store/toast";
import { Modal } from "../Modal";
import { anyPickerOpen } from "../pickerStack";
import { Button, Field, Select, Spinner } from "../ui";
import {
  EntriesEditor,
  EntriesPreview,
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
} from "./DropEditors";

/**
 * 每怪掉落编辑弹窗（#254 的三选一；#584 起怪物列表也用它）
 *
 * **自己按 key 拉数据**（`GET /admin/monster-drops/:key` + 具名表列表）：页面只管「打开哪只怪」，
 * 不必先在列表里塞一份完整条目池 —— 一页 20 只怪带出上千条条目没有意义。
 * 写入只有 `PATCH /admin/monster-drops/:key` 一条路（服务端整份替换）。
 *
 * 三选一语义（服务端定义，这里只负责别让用户提交出自相矛盾的组合）：
 * - 引用具名表：`tableId` 非空，`entries` 不传，`picks` 可覆盖件数（留空 = 用表自己的）；
 * - 内联条目池：`tableId = null` + `entries` 非空，`picks` 必填；
 * - 清空：`tableId = null` + `entries = null`（走兜底表 default）。
 */
export function MonsterDropDialog({
  monsterKey,
  monsterLabel,
  onClose,
  onSaved,
}: {
  monsterKey: string | null;
  monsterLabel?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  /** mode：table = 引用具名表；inline = 内联条目池；none = 清空走兜底 */
  const [mode, setMode] = useState<"table" | "inline" | "none">("inline");
  const [tableId, setTableId] = useState("");
  const [picks, setPicks] = useState<PicksDraft>({ min: "1", max: "" });
  const [drafts, setDrafts] = useState<EntryDraft[]>([emptyEntryDraft()]);
  const [tables, setTables] = useState<DropTable[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!monsterKey) return;
    let alive = true;
    setLoading(true);
    setSaving(false);
    void (async () => {
      try {
        const [detail, tableList] = await Promise.all([dropApi.getMonsterDrop(monsterKey), dropApi.listTables()]);
        if (!alive) return;
        setTables(tableList.list);
        if (detail.source === "table") {
          setMode("table");
          setTableId(detail.tableId ?? "");
          setPicks(detail.picks !== null ? picksOf(detail.picks) : { min: "", max: "" });
        } else if (detail.source === "entries") {
          setMode("inline");
          setTableId("");
          setPicks(picksOf(detail.picks));
        } else {
          setMode("none");
          setTableId("");
          setPicks({ min: "1", max: "" });
        }
        const rows = entriesOf(detail.entries);
        setDrafts(rows.length > 0 ? rows : [emptyEntryDraft()]);
      } catch {
        /* 错误已由请求层统一提示；弹窗保持上次的状态，用户可关掉重开 */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [monsterKey]);

  if (!monsterKey) return null;

  const picksValue = picksFrom(picks);
  const errors = mode === "inline" ? entryErrors(drafts) : [];
  const inlineValid = picksValue !== undefined && drafts.length > 0 && drafts.every((row) => row.goodId.trim()) && errors.length === 0;
  /** 引用具名表时 picks 留空合法（= 用表自己的件数） */
  const tableValid = tableId !== "" && (picks.min.trim() === "" || picksValue !== undefined);
  const canSubmit = !loading && !saving && canWrite && (mode === "none" || (mode === "inline" ? inlineValid : tableValid));
  const selectedTable = tables.find((table) => table.id === tableId);

  const submit = async () => {
    setSaving(true);
    const body: { tableId: string | null; picks?: number | [number, number]; entries?: DropEntry[] } = { tableId: null };
    if (mode === "table") {
      body.tableId = tableId;
      if (picks.min.trim() !== "") body.picks = picksValue;
    } else if (mode === "inline") {
      body.picks = picksValue;
      body.entries = entriesFrom(drafts);
    }
    try {
      await dropApi.updateMonsterDrop(monsterKey, body);
      toastSuccess(`怪物 ${monsterLabel ? `「${monsterLabel}」` : monsterKey} 的掉落已保存`);
      onSaved();
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      title={<>掉落 · {monsterLabel ?? `key ${monsterKey}`}</>}
      hint={<>整份替换：引用具名表 / 内联条目池 / 清空走兜底，三选一。掉落由服务端抽取并入包，改完即时生效（客户端不参与结算）。</>}
      size="lg"
      onClose={() => {
        // 物品选择器叠在本弹窗上：关选择器不该顺手把这份改了一半的掉落一起关掉
        if (!anyPickerOpen()) onClose();
      }}
      footer={<>
        <Button variant="outline" disabled={saving} onClick={onClose}>
          取消
        </Button>
        <Button disabled={!canSubmit} loading={saving} onClick={() => void submit()}>
          保存改动
        </Button>
      </>}
    >
      {loading ? (
        <div className="mt-6 flex justify-center">
          <Spinner />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
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
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-end gap-4">
                <Field label="具名掉落表" hint="改这张表会影响所有引用它的怪">
                  <Select value={tableId} onChange={(event) => setTableId(event.target.value)}>
                    <option value="">选一张表…</option>
                    {tables.map((table) => (
                      <option key={table.id} value={table.id}>
                        {table.id}（{table.entries.length} 条 · 抽 {picksText(table.picks)}）
                      </option>
                    ))}
                  </Select>
                </Field>
                <PicksEditor draft={picks} onChange={setPicks} />
              </div>
              {selectedTable ? (
                <div className="flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
                  <p className="text-xs text-slate-400">
                    这张表自己的件数是 <span className="font-mono text-slate-200">{picksText(selectedTable.picks)}</span>；
                    上面留空就用它，填了就只对这只怪生效。
                  </p>
                  {/* 「这张表里到底是什么」——共用表一改影响所有引用它的怪，别只看条数就点保存 */}
                  <EntriesPreview entries={selectedTable.entries} />
                </div>
              ) : null}
            </div>
          ) : null}

          {mode === "inline" ? (
            <div className="flex flex-col gap-4">
              <PicksEditor draft={picks} onChange={setPicks} />
              <EntriesEditor drafts={drafts} onChange={setDrafts} />
            </div>
          ) : null}

          {mode === "none" ? (
            <p className="rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-xs text-slate-400">
              清空后这只怪没有独立掉落配置，将走兜底表（default）。
            </p>
          ) : null}

          {!canWrite ? (
            <p className="rounded-lg border border-amber-900/50 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
              当前角色没有「修改养成配置」权限，只能看不能存。
            </p>
          ) : null}
          {mode === "table" && tableId === "" ? (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">引用具名表要先选一张表。</p>
          ) : null}
          {picksValue === undefined && (mode === "inline" || (mode === "table" && picks.min.trim() !== "")) ? (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">抽取件数需为 ≥1 的整数（或 1 ≤ 下限 ≤ 上限）。</p>
          ) : null}
          {errors.length > 0 ? <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">{errors.join("；")}。</p> : null}
        </>
      )}
    </Modal>
  );
}
