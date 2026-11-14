import { useMemo, useState } from "react";
import type { DropEntry, DropTable, MonsterDropSummary } from "../../api";
import { EntityImage } from "../entity/EntityImage";
import { EntityPickButton } from "../entity/EntityPickButton";
import { EntityPicker } from "../entity/EntityPicker";
import { dropItemOptions, entityImage, entityLabel } from "../entity/catalog";
import { Button, Field, Input } from "../ui";

/**
 * 掉落编辑的共用零件（具名表弹窗与每怪掉落弹窗共用一份）
 *
 * 为什么抽出来：`DropConfigPage`（掉落配置页）与 `MonstersPage`（怪物列表里改掉落，#584）
 * 改的是同一份数据、同一套三选一语义 —— 两处各写一份编辑器，迟早在「picks 留空 = 用表自己的」
 * 这种细节上分叉。这里只放**纯编辑零件与形状转换**，弹窗本身各自组装。
 */

/**
 * 条目行的列宽（序 / 物品 / 权重 / 概率 / 数量 / 删）
 *
 * 列头与每一行共用同一串类名 —— 两处各写一份 `grid-cols-[…]`，改宽度时必定漏一处，
 * 列头就会和下面的输入框错半格。
 */
const ENTRY_GRID = "grid grid-cols-[1.75rem_minmax(0,1fr)_4.5rem_5.5rem_7.5rem_1.75rem] items-center gap-2";

/** 来源中文名（语义标注：引用具名表 / 内联条目 / 未配置走兜底） */
export const DROP_SOURCE_LABELS: Record<string, string> = { table: "具名表", entries: "内联", none: "兜底" };
export const DROP_SOURCE_TONE: Record<string, "gold" | "jade" | "muted"> = {
  table: "gold",
  entries: "jade",
  none: "muted",
};

/** picks 的编辑形态：两个输入，max 留空 = 固定件数（min），都填 = [min, max] */
export type PicksDraft = { min: string; max: string };

export function picksOf(value: unknown): PicksDraft {
  if (Array.isArray(value)) return { min: String(value[0]), max: String(value[1]) };
  return { min: String(value ?? 1), max: "" };
}

/** PicksDraft → 服务端形状（max 空 = 数字；非法返回 undefined 由调用方拦） */
export function picksFrom(draft: PicksDraft): number | [number, number] | undefined {
  const min = Number(draft.min);
  if (!Number.isInteger(min) || min < 1) return undefined;
  if (draft.max.trim() === "") return min;
  const max = Number(draft.max);
  if (!Number.isInteger(max) || max < min) return undefined;
  return [min, max];
}

/** 抽取次数的展示文本（`3` / `2~5` / 空 = 用表自己的） */
export function picksText(picks: unknown): string {
  if (picks === null || picks === undefined) return "";
  return Array.isArray(picks) ? `${picks[0]}~${picks[1]}` : String(picks);
}

/**
 * 条目行（编辑器内的可变形状：数字输入都是字符串）
 *
 * 概率那一格是**百分比**（`chancePct`，0~100），不是服务端存的 0~1 —— 后台是给运营看的，
 * 「5%」比「0.05」少一次心算；落库时除以 100（见 `entriesFrom`）。
 */
export type EntryDraft = { goodId: string; weight: string; chancePct: string; countMin: string; countMax: string };

/** 概率 0~1 → 百分比输入值（去掉尾随零：`1 → 100`、`0.5 → 50`、`0.0333 → 3.33`） */
function pctOfChance(chance: number): string {
  const pct = Math.round(chance * 1_000_000) / 10_000;
  return Number.isFinite(pct) ? String(pct) : "100";
}

export function entriesOf(entries: DropEntry[] | null): EntryDraft[] {
  return (entries ?? []).map((entry) => ({
    goodId: entry.goodId,
    weight: String(entry.weight ?? 1),
    chancePct: pctOfChance(entry.chance ?? 1),
    countMin: String(entry.count?.[0] ?? 1),
    countMax: String(entry.count?.[1] ?? 1),
  }));
}

export function entriesFrom(drafts: EntryDraft[]): DropEntry[] {
  return drafts.map((draft) => {
    // 概率留空 = 必掉（服务端 `chance ?? 1` 的同一口径）；写 0 才是「永不掉落」
    const pct = Number(draft.chancePct);
    return {
      goodId: draft.goodId.trim(),
      weight: Number(draft.weight) || 0,
      chance: Number.isFinite(pct) && draft.chancePct.trim() !== "" ? pct / 100 : 1,
      count: [Number(draft.countMin) || 1, Number(draft.countMax) || 1],
    };
  });
}

/** 空行（新建条目 / 内联模式初值） */
export function emptyEntryDraft(): EntryDraft {
  return { goodId: "", weight: "1", chancePct: "100", countMin: "1", countMax: "1" };
}

/** 条目草稿的即时校验（显示层拦截；权威在服务端：goodId 存在性 / count min ≤ max） */
export function entryErrors(drafts: EntryDraft[]): string[] {
  const errors: string[] = [];
  drafts.forEach((draft, index) => {
    const where = `条目 ${index + 1}`;
    if (!draft.goodId.trim()) errors.push(`${where} 还没挑物品`);
    const pct = Number(draft.chancePct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) errors.push(`${where} 的概率要在 0~100 之间`);
    if (Number(draft.countMin) > Number(draft.countMax)) errors.push(`${where} 的数量下限大于上限`);
  });
  return errors;
}

/**
 * 条目池编辑器（具名表与每怪内联共用一份）
 *
 * 版式对齐过的原因：以前是 `flex flex-wrap items-end` 一串**没有标签**的数字框 ——
 * 权重 / 概率 / 数量三组输入长得一模一样，只能靠记住「第三、四个框是什么」；
 * 换行时机还取决于物品名长短，两行的框对不齐。现在是一个**固定列宽的栅格**
 * （序 / 物品 / 权重 / 概率 / 数量 / 删），列头写一次标签，每行只填值：
 *
 * - 权重：抽到哪一条的**相对占比**（同一池内归一化，0 = 永不抽到）；
 * - 概率：抽中之后**实际掉出来**的几率，按百分比填（服务端存 0~1，这里 ÷100）；
 * - 数量：掉出来的件数区间（相等即固定）。
 *
 * 物品从 #648 起不再是文本框：现在是「图标 + 名字 + 一行说明」的按钮，点开就是可掉落的
 * 物品（**装备只列基础件** + 药品 + 材料），候选集与服务端校验同一份（`ITEM_LABELS` →
 * `dropItemOptions()`），能选出来的必定能存进去。
 *
 * 「批量添加」走多选：一次勾十几种材料比开十几次弹窗快得多。装备的变体不在这里逐件点名 ——
 * 掉出来是哪一档由变体表决定，候选里没有 `xxx_p2s1` 这种行。
 */
export function EntriesEditor({ drafts, onChange }: { drafts: EntryDraft[]; onChange: (next: EntryDraft[]) => void }) {
  // 2200 多条的清单由 catalog 缓存；掉落口径的过滤（去变体）也只算一次
  const itemOptions = useMemo(() => dropItemOptions(), []);
  const [bulkOpen, setBulkOpen] = useState(false);

  const update = (index: number, patch: Partial<EntryDraft>) => {
    onChange(drafts.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)));
  };
  const remove = (index: number) => onChange(drafts.filter((_, i) => i !== index));
  const add = () => onChange([...drafts, emptyEntryDraft()]);

  /** 多选结果 → 追加成新行（已在条目池里的跳过：同一件东西配两条只会互相摊薄权重） */
  const addMany = (ids: string[]) => {
    const existing = new Set(drafts.map((draft) => draft.goodId.trim()).filter(Boolean));
    const rows = ids.filter((id) => !existing.has(id)).map((id) => ({ ...emptyEntryDraft(), goodId: id }));
    if (rows.length > 0) onChange([...drafts, ...rows]);
  };

  // 权重合计：算「占比」用（0 权重的条目不会进 total 之外的任何分母）
  const totalWeight = drafts.reduce((sum, draft) => sum + Math.max(0, Number(draft.weight) || 0), 0);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-ink-4">
          条目池
          <span className="ml-1.5 font-normal text-ink-5">
            共 {drafts.length} 条{totalWeight > 0 ? ` · 权重合计 ${totalWeight}` : ""}
          </span>
        </span>
        <div className="flex items-center gap-1.5">
          <Button variant="outline" className="px-2.5 py-1 text-xs" onClick={() => setBulkOpen(true)}>
            批量添加
          </Button>
          <Button variant="outline" className="px-2.5 py-1 text-xs" onClick={add}>
            加一条
          </Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-line bg-surface-0/40">
        <div className={`${ENTRY_GRID} border-b border-line bg-surface-2/40 px-2 py-1.5 text-[11px] text-ink-5`}>
          <span className="text-center">序</span>
          <span>物品</span>
          <span className="text-center" title="抽到哪一条的相对占比（同一池内归一化；0 = 永不抽到）">
            权重
          </span>
          <span className="text-center" title="抽中之后实际掉出来的几率，按百分比填">
            概率
          </span>
          <span className="text-center" title="掉出来的件数区间（相等即固定）">
            数量
          </span>
          <span aria-hidden="true" />
        </div>

        {drafts.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-ink-5">
            还没有条目 —— 用「批量添加」一次挑多件，或「加一条」逐条配。
          </p>
        ) : (
          <div className="divide-y divide-line/60">
            {drafts.map((draft, index) => {
              const weight = Math.max(0, Number(draft.weight) || 0);
              const share = totalWeight > 0 ? (weight / totalWeight) * 100 : 0;
              return (
                <div key={index} className={`${ENTRY_GRID} px-2 py-1.5 transition hover:bg-surface-2/50`}>
                  <span className="text-center font-mono text-[11px] text-ink-5">{index + 1}</span>
                  <EntityPickButton
                    value={draft.goodId}
                    options={itemOptions}
                    kind="item"
                    pickerTitle={`选择条目 ${index + 1} 的物品`}
                    hint="装备只列基础件（掉出来是哪一档前后缀由变体表决定）/ 药品 / 材料；挑中即存它的 id。"
                    emptyHint="物品总表是空的 —— 先确认服务端配置已灌入（make config-import）"
                    onChange={(goodId) => update(index, { goodId })}
                  />
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    className="text-center"
                    aria-label={`条目 ${index + 1} 权重`}
                    title={weight > 0 ? `占本池 ${share.toFixed(share < 10 ? 1 : 0)}%` : "权重 0 = 这条永远不会被抽到"}
                    value={draft.weight}
                    onChange={(event) => update(index, { weight: event.target.value })}
                  />
                  {/* `%` 放在输入框外面：塞进框里要 `pr-*`，而 `Input` 自带的 `px-2.5` 不保证被覆盖 */}
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      step={0.1}
                      className="text-center"
                      aria-label={`条目 ${index + 1} 概率（百分比）`}
                      title="抽中之后实际掉出来的几率"
                      value={draft.chancePct}
                      onChange={(event) => update(index, { chancePct: event.target.value })}
                    />
                    <span className="shrink-0 text-[10px] text-ink-5">%</span>
                  </div>
                  <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1">
                    <Input
                      type="number"
                      min={0}
                      className="text-center"
                      aria-label={`条目 ${index + 1} 数量下限`}
                      value={draft.countMin}
                      onChange={(event) => update(index, { countMin: event.target.value })}
                    />
                    <span className="text-[10px] text-ink-6">~</span>
                    <Input
                      type="number"
                      min={0}
                      className="text-center"
                      aria-label={`条目 ${index + 1} 数量上限`}
                      value={draft.countMax}
                      onChange={(event) => update(index, { countMax: event.target.value })}
                    />
                  </div>
                  {/*
                    删除用原生按钮而不是 `Button`：这一格只有 1.75rem 宽，`Button` 自带的
                    `px-3` 会把 28px 撑成 40px，栅格右边的列就错位了（类名覆盖在 Tailwind 里
                    不按书写顺序生效，别赌）。
                  */}
                  <button
                    type="button"
                    className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-5 transition hover:bg-ember/10 hover:text-ember-hi disabled:cursor-not-allowed disabled:opacity-40"
                    title="删除这一条"
                    aria-label={`删除条目 ${index + 1}`}
                    disabled={drafts.length <= 1}
                    onClick={() => remove(index)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <p className="mt-1.5 text-[11px] text-ink-5">
        抽取顺序：按权重决定抽到哪一条 → 过概率 → 取件数；权重为 0 的条目永远不会被抽到。
      </p>

      {bulkOpen ? (
        <EntityPicker
          open
          multiple
          title="批量添加掉落物品"
          hint="勾选若干项后点「加入」—— 每条按权重 1 / 概率 100% / 数量 1~1 追加，之后逐行改数值即可。"
          options={itemOptions}
          emptyHint="物品总表是空的 —— 先确认服务端配置已灌入（make config-import）"
          onSelectMany={addMany}
          onClose={() => setBulkOpen(false)}
        />
      ) : null}
    </div>
  );
}

/** picks 编辑（max 空 = 固定件数） */
export function PicksEditor({ draft, onChange }: { draft: PicksDraft; onChange: (next: PicksDraft) => void }) {
  return (
    <div className="flex items-end gap-2">
      <Field label="抽取件数下限">
        <div className="w-24"><Input type="number" min={1} value={draft.min} onChange={(event) => onChange({ ...draft, min: event.target.value })} /></div>
      </Field>
      <Field label="上限（留空 = 固定）">
        <div className="w-24"><Input type="number" min={1} value={draft.max} onChange={(event) => onChange({ ...draft, max: event.target.value })} /></div>
      </Field>
    </div>
  );
}

/**
 * 条目池的「长什么样」预览（引用具名表时用）
 *
 * 选中一张共用表后，运营最需要知道的是「这张表里到底是什么」—— 只看 `12 条` 这个数字就点保存，
 * 等于把不可见的改动广播给所有引用它的怪。这里按图标 + 名字 + 数量铺成一行，
 * 与条目池编辑器同一套取图 / 取名口径（`entityImage` / `entityLabel`）。
 */
export function EntriesPreview({ entries, max = 12 }: { entries: DropEntry[]; max?: number }) {
  if (entries.length === 0) {
    return <p className="text-xs text-warn-hi/90">这张表没有条目 —— 抽出来会是空的（服务端不放行空表，存不进去）。</p>;
  }
  const shown = entries.slice(0, max);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {shown.map((entry, index) => {
        const label = entityLabel("item", entry.goodId) || entry.goodId;
        const [low, high] = entry.count ?? [1, 1];
        return (
          <span
            key={`${entry.goodId}-${index}`}
            title={`${label}（${entry.goodId}）· 权重 ${entry.weight} · 概率 ${pctOfChance(entry.chance ?? 1)}%`}
            className="flex items-center gap-1 rounded-lg border border-line bg-surface-2/60 py-0.5 pl-0.5 pr-1.5"
          >
            <EntityImage image={entityImage("item", entry.goodId)} alt={label} size={20} />
            <span className="max-w-[120px] truncate text-[11px] text-ink-3">{label}</span>
            <span className="font-mono text-[10px] text-ink-5">×{low === high ? low : `${low}~${high}`}</span>
          </span>
        );
      })}
      {entries.length > shown.length ? (
        <span className="text-[11px] text-ink-5">还有 {entries.length - shown.length} 条…</span>
      ) : null}
    </div>
  );
}

/**
 * 掉落摘要的展示文本（怪物列表用；**徽标已经写了来源，这里不再重复「内联 / 兜底」**）
 *
 * - 引用具名表 → `common · 2~5 件 · 12 条`（件数是行内覆盖；没覆盖就写表自己的）
 * - 内联 → `3 条 · 抽 1~2`
 * - 兜底 → `default`
 * 摘要为空（还没有这一行）时按兜底展示 —— 服务端播种后不该出现，但页面不因此显示空白。
 */
export function dropSummaryText(drop: MonsterDropSummary | null, tablesById: Map<string, DropTable>): string {
  if (!drop || drop.source === "none") return "default";
  if (drop.source === "table") {
    const table = drop.tableId ? tablesById.get(drop.tableId) : undefined;
    const picks = picksText(drop.picks) || picksText(table?.picks);
    const count = table ? `${table.entries.length} 条` : "表缺失";
    return `${drop.tableId ?? "（未选表）"}${picks ? ` · ${picks} 件` : ""} · ${count}`;
  }
  return `${drop.entryCount} 条${drop.picks === null ? "" : ` · 抽 ${picksText(drop.picks)}`}`;
}
