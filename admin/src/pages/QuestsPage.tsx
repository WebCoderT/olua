import { useCallback, useEffect, useMemo, useState } from "react";
import { formatTime, itemsApi, monstersApi, npcsApi, PERMISSION, questsApi } from "../api";
import type { CreateQuest, Item, Monster, Npc, PageResult, Quest, QuestRewardItem, UpdateQuest } from "../api";
import { Pagination } from "../components/Pagination";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/** 任务类型（与服务端口径一致：main 一次性 / daily 领奖后可重接） */
const QUEST_KIND_LABELS: Record<string, string> = { main: "主线", daily: "日常" };

/** 目标类型 → 中文（决定「目标」下拉框用哪张表） */
const OBJECTIVE_TYPE_LABELS: Record<string, string> = { kill: "击杀怪物", talk: "与 NPC 对话", collect: "收集物品" };

/** 目标类型 → 目标键取自哪张表（下拉框的候选来源） */
const OBJECTIVE_TARGET_SOURCE: Record<string, "monster" | "npc" | "item"> = {
  kill: "monster",
  talk: "npc",
  collect: "item",
};

/** 奖励物品最多 20 条（与服务端 `ArrayMaxSize(20)` 对齐） */
const REWARD_ITEMS_MAX = 20;

/** 弹窗表单值：数字字段一律以字符串承载（空串 / 非法输入不静默变 0），提交前统一校验 */
interface QuestForm {
  kind: string;
  label: string;
  description: string;
  prevQuestId: string;
  minLevel: string;
  npcId: string;
  objectiveType: string;
  objectiveTarget: string;
  objectiveCount: string;
  gold: string;
  exp: string;
  items: QuestRewardItem[];
}

/** 由一条任务配置展开成表单 */
function toForm(item: Quest): QuestForm {
  return {
    kind: item.kind,
    label: item.label,
    description: item.description,
    prevQuestId: item.prevQuestId,
    minLevel: String(item.minLevel),
    npcId: item.npcId,
    objectiveType: item.objective.type,
    objectiveTarget: item.objective.target,
    objectiveCount: String(item.objective.count),
    gold: String(item.rewards.gold),
    exp: String(item.rewards.exp),
    items: item.rewards.items.map((entry) => ({ ...entry })),
  };
}

/** 新建表单的初值（主线链默认挂在 8000 段；具体 id 自己填） */
function emptyForm(): QuestForm {
  return {
    kind: "main",
    label: "",
    description: "",
    prevQuestId: "",
    minLevel: "1",
    npcId: "",
    objectiveType: "kill",
    objectiveTarget: "",
    objectiveCount: "1",
    gold: "0",
    exp: "0",
    items: [],
  };
}

/** 数字字段的校验结果（返回 null = 合法） */
function checkNumber(text: string, options: { min: number; max: number; int?: boolean; name: string }): string | null {
  const value = Number(text);
  if (text.trim() === "" || !Number.isFinite(value)) return `${options.name}必须是数字`;
  if (options.int && !Number.isInteger(value)) return `${options.name}必须是整数`;
  if (value < options.min) return `${options.name}不能小于 ${options.min}`;
  if (value > options.max) return `${options.name}不能大于 ${options.max}`;
  return null;
}

/** 目标键 → 可读名字（表里查不到就原样显示键，不让它看起来像丢了数据） */
function targetLabel(key: string, names: Map<string, string>): string {
  const name = names.get(key);
  return name ? `${name}（${key}）` : key;
}

/**
 * 任务编辑 / 新建弹窗（#396）
 *
 * 一次展示**整条任务配置**：身份（id / 类型 / 名称）、接取条件（前置 / 等级 / 发布 NPC）、
 * 单目标（类型 / 目标键 / 数量）与奖励（金币 / 经验 / 物品）。
 * 部分更新只是协议形态，这里按「整份提交」处理 —— `objective` / `rewards` 传了就整份替换，
 * 少回填一个字段就会出现「只改了数量结果把奖励清零」这类事故。
 *
 * 校验分工：跨字段约束（链不能成环、目标键必须真实存在、奖励物品必须存在）服务端权威
 * （`assertQuestConsistency` → 40000），这里只做即时提示。
 */
function QuestDialog({
  open,
  creating,
  initial,
  monsterOptions,
  npcOptions,
  itemOptions,
  questOptions,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  /** true = 新建（id 可填），false = 编辑（id 是行身份，不可改） */
  creating: boolean;
  initial: Quest | null;
  monsterOptions: Monster[];
  npcOptions: Npc[];
  itemOptions: Item[];
  /** 可当前置的任务（含自己，自己那项在下拉里禁用） */
  questOptions: Quest[];
  onCancel: () => void;
  onSubmit: (value: UpdateQuest | CreateQuest) => Promise<boolean>;
}) {
  const [id, setId] = useState("");
  const [form, setForm] = useState<QuestForm | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setId(creating ? "" : (initial?.id ?? ""));
    setForm(creating ? emptyForm() : initial ? toForm(initial) : null);
    setSubmitting(false);
  }, [open, creating, initial]);

  /** 目标键的候选表：跟目标类型走 */
  const targetOptions = useMemo(() => {
    const type = form?.objectiveType ?? "kill";
    const source = OBJECTIVE_TARGET_SOURCE[type];
    if (source === "monster") return monsterOptions.map((row) => ({ id: row.id, label: row.label }));
    if (source === "npc") return npcOptions.map((row) => ({ id: row.id, label: row.label }));
    return itemOptions.map((row) => ({ id: row.id, label: row.label }));
  }, [form?.objectiveType, monsterOptions, npcOptions, itemOptions]);

  if (!open || !form) return null;

  const set = <K extends keyof QuestForm>(key: K, value: QuestForm[K]) => setForm({ ...form, [key]: value });

  const setItem = (index: number, patch: Partial<QuestRewardItem>) => {
    setForm({ ...form, items: form.items.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)) });
  };

  /** 切目标类型时把目标键清空：上一种类型留下的键在另一种类型里几乎必然无效 */
  const switchObjectiveType = (next: string) => {
    setForm({ ...form, objectiveType: next, objectiveTarget: "" });
  };

  /** 全部校验项（空数组 = 可提交）；宁可多报一句，也不让服务端 400 打回 */
  const problems: string[] = [];
  if (creating && !id.trim()) problems.push("任务 id 不能为空");
  if (!form.label.trim()) problems.push("任务名称不能为空");
  for (const message of [
    checkNumber(form.minLevel, { name: "接取等级", min: 1, max: 999, int: true }),
    checkNumber(form.objectiveCount, { name: "目标数量", min: 1, max: 9999, int: true }),
    checkNumber(form.gold, { name: "金币奖励", min: 0, max: 999_999_999, int: true }),
    checkNumber(form.exp, { name: "经验奖励", min: 0, max: 999_999_999, int: true }),
  ]) {
    if (message) problems.push(message);
  }
  if (!form.objectiveTarget.trim()) problems.push(`目标${OBJECTIVE_TYPE_LABELS[form.objectiveType] ?? form.objectiveType}没选具体对象`);
  if (!form.npcId) problems.push("必须指定发布 NPC（NPC 头顶要靠它挂可接 / 可交付标记）");
  if (form.prevQuestId && form.prevQuestId === id.trim()) problems.push("前置任务不能是自己");
  form.items.forEach((entry, index) => {
    if (!entry.goodId) problems.push(`第 ${index + 1} 条奖励物品没选物品`);
    const message = checkNumber(String(entry.count), { name: `第 ${index + 1} 条奖励数量`, min: 1, max: 9999, int: true });
    if (message) problems.push(message);
  });

  const canSubmit = problems.length === 0 && !submitting;

  const submit = async () => {
    setSubmitting(true);
    const payload: UpdateQuest = {
      kind: form.kind as UpdateQuest["kind"],
      label: form.label.trim(),
      description: form.description.trim(),
      prevQuestId: form.prevQuestId,
      minLevel: Number(form.minLevel),
      npcId: form.npcId,
      objective: {
        type: form.objectiveType as "kill" | "talk" | "collect",
        target: form.objectiveTarget.trim(),
        count: Number(form.objectiveCount),
      },
      rewards: {
        gold: Number(form.gold),
        exp: Number(form.exp),
        items: form.items.map((entry) => ({ goodId: entry.goodId, count: Number(entry.count) })),
      },
    };
    await onSubmit(creating ? { ...payload, id: id.trim() } : payload);
    setSubmitting(false);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
        <h3 className="text-base font-semibold text-slate-100">{creating ? "新增任务" : `编辑任务 · ${initial?.id ?? ""}`}</h3>
        <p className="mt-1 text-xs text-slate-500">
          {creating
            ? "id 建议主线用 8000 段、日常用 8100 段（与生成物里的既有任务同一动线）。建成后随配置快照下发客户端。"
            : "id 是行身份，不可改。保存后随配置快照下发客户端；正在进行的玩家进度不受影响（进度记的是 quest id）。"}
        </p>

        <div className="mt-5 flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {creating ? (
              <Field label="任务 id" hint="唯一，≤32 字">
                <Input value={id} onChange={(event) => setId(event.target.value)} />
              </Field>
            ) : (
              <Field label="任务 id">
                <Input value={id} disabled />
              </Field>
            )}
            <Field label="类型">
              <Select value={form.kind} onChange={(event) => set("kind", event.target.value)}>
                {Object.entries(QUEST_KIND_LABELS).map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="名称" hint="≤50 字">
              <Input value={form.label} onChange={(event) => set("label", event.target.value)} maxLength={50} />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="前置任务" hint="主线链门控：前置未领奖则不可接">
              <Select value={form.prevQuestId} onChange={(event) => set("prevQuestId", event.target.value)}>
                <option value="">（无前置）</option>
                {questOptions.map((item) => (
                  <option key={item.id} value={item.id} disabled={item.id === id.trim()}>
                    {item.id} · {item.label}
                  </option>
                ))}
                {/* 配置里引用了不在列表里的前置（已删 / 分页外）：保留原值，避免保存时被悄悄清空 */}
                {form.prevQuestId && !questOptions.some((item) => item.id === form.prevQuestId) ? (
                  <option value={form.prevQuestId}>{form.prevQuestId}（未在任务表中）</option>
                ) : null}
              </Select>
            </Field>
            <Field label="接取等级" hint="1~999">
              <Input type="number" min={1} max={999} value={form.minLevel} onChange={(event) => set("minLevel", event.target.value)} />
            </Field>
            <Field label="发布 NPC" hint="决定玩家在谁那里接 / 交">
              <Select value={form.npcId} onChange={(event) => set("npcId", event.target.value)}>
                <option value="">（请选择）</option>
                {npcOptions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.id} · {item.label}
                  </option>
                ))}
                {form.npcId && !npcOptions.some((item) => item.id === form.npcId) ? (
                  <option value={form.npcId}>{form.npcId}（未在 NPC 表中）</option>
                ) : null}
              </Select>
            </Field>
          </div>

          <div>
            <span className="mb-2 block text-xs font-medium text-slate-400">目标（单目标，v1 边界）</span>
            <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-800 bg-slate-950/40 p-4 sm:grid-cols-3">
              <Field label="目标类型" hint="决定推进方式">
                <Select value={form.objectiveType} onChange={(event) => switchObjectiveType(event.target.value)}>
                  {Object.entries(OBJECTIVE_TYPE_LABELS).map(([value, text]) => (
                    <option key={value} value={value}>
                      {text}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="目标对象">
                <Select value={form.objectiveTarget} onChange={(event) => set("objectiveTarget", event.target.value)}>
                  <option value="">（请选择）</option>
                  {targetOptions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.id} · {item.label}
                    </option>
                  ))}
                  {form.objectiveTarget && !targetOptions.some((item) => item.id === form.objectiveTarget) ? (
                    <option value={form.objectiveTarget}>{form.objectiveTarget}（未在当前表里）</option>
                  ) : null}
                </Select>
              </Field>
              <Field label="目标数量" hint="1~9999">
                <Input
                  type="number"
                  min={1}
                  max={9999}
                  value={form.objectiveCount}
                  onChange={(event) => set("objectiveCount", event.target.value)}
                />
              </Field>
            </div>
            <p className="mt-1.5 text-xs text-slate-600">
              kill 的进度在服务端击杀结算时推进（实时进程直写库）；talk 在玩家与 NPC 对话时推进；
              collect 在交付时按背包实有数量判定，不需要额外钩子。
            </p>
          </div>

          <div>
            <span className="mb-2 block text-xs font-medium text-slate-400">奖励（交付时直接入包，整份放不下会被拒绝）</span>
            <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-800 bg-slate-950/40 p-4 sm:grid-cols-2">
              <Field label="金币">
                <Input type="number" min={0} value={form.gold} onChange={(event) => set("gold", event.target.value)} />
              </Field>
              <Field label="经验">
                <Input type="number" min={0} value={form.exp} onChange={(event) => set("exp", event.target.value)} />
              </Field>
            </div>

            <div className="mt-2 flex items-center justify-between">
              <span className="text-xs text-slate-500">奖励物品（最多 {REWARD_ITEMS_MAX} 条）</span>
              <Button
                variant="outline"
                className="px-2.5 py-1 text-xs"
                disabled={form.items.length >= REWARD_ITEMS_MAX}
                onClick={() => set("items", [...form.items, { goodId: "", count: 1 }])}
              >
                加一条
              </Button>
            </div>
            <div className="mt-2 flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
              {form.items.length === 0 ? <p className="text-xs text-slate-500">没有物品奖励：只发金币与经验。</p> : null}
              {form.items.map((entry, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Select
                    className="flex-1"
                    value={entry.goodId}
                    onChange={(event) => setItem(index, { goodId: event.target.value })}
                  >
                    <option value="">（请选择物品）</option>
                    {itemOptions.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.id} · {item.label}
                      </option>
                    ))}
                    {entry.goodId && !itemOptions.some((item) => item.id === entry.goodId) ? (
                      <option value={entry.goodId}>{entry.goodId}（未在物品表中）</option>
                    ) : null}
                  </Select>
                  <span className="text-xs text-slate-600">×</span>
                  <Input
                    type="number"
                    min={1}
                    max={9999}
                    className="w-24"
                    aria-label={`第 ${index + 1} 条奖励数量`}
                    value={entry.count}
                    onChange={(event) => setItem(index, { count: Number(event.target.value) || 0 })}
                  />
                  <Button
                    variant="ghost"
                    className="px-2 py-1 text-xs text-rose-300"
                    onClick={() => set("items", form.items.filter((_, i) => i !== index))}
                  >
                    删除
                  </Button>
                </div>
              ))}
            </div>
          </div>

          <Field label="描述文案" hint="客户端任务详情里显示；≤500 字">
            <textarea
              className="min-h-[80px] w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-emerald-500"
              maxLength={500}
              value={form.description}
              onChange={(event) => set("description", event.target.value)}
            />
          </Field>

          {problems.length > 0 ? (
            <ul className="flex flex-col gap-1 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              {problems.map((message) => (
                <li key={message}>· {message}</li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" disabled={submitting} onClick={onCancel}>
            取消
          </Button>
          <Button disabled={!canSubmit} loading={submitting} onClick={() => void submit()}>
            {creating ? "创建" : "保存修改"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * 任务配置管理（#396，epic #394 第二刀，养成配置第十页）
 *
 * 服务端是唯一权威：接取门控（前置 / 等级）、进度推进（击杀由实时进程直写）、
 * 交付发奖（扣材料 + 发奖励 + 升级一次落库）都在服务端。这里只改「配置」，
 * 改完随配置快照下发客户端（NPC 头顶标记、任务列表、追踪栏都读它）。
 *
 * 两条纪律：
 * - **任务与玩家进度分开**：删任务不影响已存在的进度行？——会，所以被进度引用中的行服务端拒删（40000）；
 * - **主线链不能成环**：`prevQuestId` 的环检测在服务端（`assertQuestConsistency`），
 *   页面只拦「自己是自己前置」这一种最明显的错。
 */
export function QuestsPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [draft, setDraft] = useState({ keyword: "", kind: "" });
  const [query, setQuery] = useState({ keyword: "", kind: "" });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [data, setData] = useState<PageResult<Quest> | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Quest | null>(null);
  /** 删除中的任务 id（行内按钮 loading，防重复点） */
  const [removingId, setRemovingId] = useState<string | null>(null);
  /** 三张候选表 + 任务全集：都只有几十行，一次拉满给下拉框用 */
  const [monsterOptions, setMonsterOptions] = useState<Monster[]>([]);
  const [npcOptions, setNpcOptions] = useState<Npc[]>([]);
  const [itemOptions, setItemOptions] = useState<Item[]>([]);
  const [questOptions, setQuestOptions] = useState<Quest[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await questsApi.list({ page, size, keyword: query.keyword || undefined, kind: (query.kind || undefined) as "main" | "daily" | undefined }));
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [page, size, query]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let alive = true;
    // 候选表拉不到不影响主流程：编辑时保留原值即可（下拉里会显示成「未在当前表里」）
    void Promise.all([
      monstersApi.list({ page: 1, size: 100 }),
      npcsApi.list({ page: 1, size: 100 }),
      itemsApi.list({ page: 1, size: 100 }),
      questsApi.list({ page: 1, size: 100 }),
    ])
      .then(([monsters, npcs, items, quests]) => {
        if (!alive) return;
        setMonsterOptions(monsters.list);
        setNpcOptions(npcs.list);
        setItemOptions(items.list);
        setQuestOptions(quests.list);
      })
      .catch(() => {
        /* 同上：候选缺失只影响下拉体验 */
      });
    return () => {
      alive = false;
    };
  }, []);

  /** 名称查找表：表格里把「键」渲染成「名字（键）」 */
  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of monsterOptions) map.set(item.id, item.label);
    for (const item of npcOptions) map.set(item.id, item.label);
    for (const item of itemOptions) map.set(item.id, item.label);
    return map;
  }, [monsterOptions, npcOptions, itemOptions]);

  const submitSearch = () => {
    setPage(1);
    setQuery({ keyword: draft.keyword.trim(), kind: draft.kind });
  };

  const resetSearch = () => {
    setDraft({ keyword: "", kind: "" });
    setPage(1);
    setQuery({ keyword: "", kind: "" });
  };

  /** 每页条数变化：回第一页再拉（条数变了页码语义也变了） */
  const handleSizeChange = (next: number) => {
    setSize(next);
    setPage(1);
  };

  const submitDialog = async (value: UpdateQuest | CreateQuest): Promise<boolean> => {
    try {
      if (creating) {
        const created = await questsApi.create(value as CreateQuest);
        toastSuccess(`任务「${created.label}」已创建，随配置快照下发客户端`);
      } else {
        if (!editing) return false;
        const updated = await questsApi.update(editing.id, value as UpdateQuest);
        toastSuccess(`任务「${updated.label}」已更新`);
      }
      setDialogOpen(false);
      setEditing(null);
      setCreating(false);
      await load();
      // 新建 / 改名都会影响「前置任务」下拉与自身列表，刷新候选集
      const quests = await questsApi.list({ page: 1, size: 100 });
      setQuestOptions(quests.list);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * 删除任务
   *
   * 两种拒绝由服务端给出（仍有玩家进度引用 / 仍被别的任务当前置），这里只做一次二次确认 ——
   * 删掉后客户端快照里就没了，NPC 头顶的标记也会跟着消失。
   */
  const removeQuest = async (item: Quest) => {
    if (!window.confirm(`确定删除任务「${item.label}」（${item.id}）？仍有玩家进度或仍被别的任务当前置时会被拒绝。`)) return;
    setRemovingId(item.id);
    try {
      await questsApi.remove(item.id);
      toastSuccess(`任务「${item.label}」已删除`);
      await load();
      const quests = await questsApi.list({ page: 1, size: 100 });
      setQuestOptions(quests.list);
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-50">任务配置</h1>
        <p className="mt-1 text-xs text-slate-500">
          主线（一次性）与日常（领奖后可重接）。每个任务一个目标：击杀怪物 / 与 NPC 对话 / 收集物品。
          进度与发奖都在服务端结算，客户端只显示；改完随配置快照下发，NPC 头顶标记也跟着变。
        </p>
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">id / 任务名</span>
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
            <span className="mb-1.5 block text-xs font-medium text-slate-400">类型</span>
            <Select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value })}>
              <option value="">全部</option>
              {Object.entries(QUEST_KIND_LABELS).map(([value, text]) => (
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
        title="任务列表"
        actions={
          <>
            {loading ? <Spinner /> : null}
            <Button
              className="px-2.5 py-1 text-xs"
              disabled={!canWrite}
              onClick={() => {
                setCreating(true);
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              新增任务
            </Button>
          </>
        }
        description={canWrite ? undefined : "当前角色没有「修改养成配置」权限，列表只读。"}
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>id</th>
                <th className={thClass}>任务名</th>
                <th className={thClass}>类型</th>
                <th className={thClass}>前置</th>
                <th className={thClass}>等级</th>
                <th className={thClass}>发布 NPC</th>
                <th className={thClass}>目标</th>
                <th className={thClass}>奖励</th>
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
                    <Badge tone={item.kind === "daily" ? "amber" : "indigo"}>{QUEST_KIND_LABELS[item.kind] ?? item.kind}</Badge>
                  </td>
                  <td className={`${tdClass} text-xs text-slate-400`}>
                    {item.prevQuestId ? <span className="font-mono">{item.prevQuestId}</span> : <span className="text-slate-600">—</span>}
                  </td>
                  <td className={`${tdClass} text-xs text-slate-400`}>Lv.{item.minLevel}</td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{targetLabel(item.npcId, names)}</td>
                  <td className={`${tdClass} text-xs text-slate-400`}>
                    {OBJECTIVE_TYPE_LABELS[item.objective.type] ?? item.objective.type} · {targetLabel(item.objective.target, names)} ×
                    {item.objective.count}
                  </td>
                  <td className={`${tdClass} text-xs text-slate-400`}>
                    金币 {item.rewards.gold} · 经验 {item.rewards.exp}
                    {item.rewards.items.length > 0
                      ? ` · ${item.rewards.items.map((entry) => `${names.get(entry.goodId) ?? entry.goodId}×${entry.count}`).join("、")}`
                      : ""}
                  </td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{formatTime(item.updatedAt)}</td>
                  <td className={`${tdClass} text-right`}>
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        className="px-2.5 py-1 text-xs"
                        disabled={!canWrite}
                        onClick={() => {
                          setEditing(item);
                          setCreating(false);
                          setDialogOpen(true);
                        }}
                      >
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        className="px-2.5 py-1 text-xs text-rose-300"
                        disabled={!canWrite || removingId === item.id}
                        loading={removingId === item.id}
                        onClick={() => void removeQuest(item)}
                      >
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!loading && data && data.list.length === 0 ? <EmptyState title="没有匹配的任务" description="换个筛选条件试试" /> : null}

        <Pagination page={page} size={size} total={data?.total ?? 0} onChange={setPage} onSizeChange={handleSizeChange} />
      </Card>

      <QuestDialog
        open={dialogOpen}
        creating={creating}
        initial={editing}
        monsterOptions={monsterOptions}
        npcOptions={npcOptions}
        itemOptions={itemOptions}
        questOptions={questOptions}
        onCancel={() => {
          setDialogOpen(false);
          setEditing(null);
          setCreating(false);
        }}
        onSubmit={submitDialog}
      />
    </div>
  );
}
