import { useCallback, useEffect, useState } from "react";
import { formatTime, PERMISSION, SKILL_OWNER_LABELS, SKILL_OWNER_OPTIONS, STATUS_KIND_LABELS, STATUS_SOURCE_LABELS, statusesApi } from "../api";
import type { PageResult, Status, StatusCombat, UpdateStatus } from "../api";
import { Modal } from "../components/Modal";
import { Pagination } from "../components/Pagination";
import { GameIcon } from "../components/GameImage";
import { IconField } from "../components/ImagePicker";
import { anyPickerOpen } from "../components/pickerStack";
import { DescriptionField, FormFooter, ProblemList } from "../components/form-bits";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";
import { PageHeader } from "../components/PageHeader";

/** 弹窗表单值：三个修正维度以字符串承载，空串 = 该维度不参与（不是 0） */
interface StatusForm {
  label: string;
  icon: string;
  duration: string;
  source: string;
  effect: string;
  effectHoldLast: boolean;
  description: string;
  blockChance: string;
  blockFactor: string;
  defenseMultiplier: string;
  /** 分类（#826 第三批）：只用于分组，行为看 tickMs 与 controlFlags */
  kind: string;
  /** 最大层数（1 = 不叠） */
  maxStacks: string;
  /** 周期触发间隔（毫秒，0 = 无周期） */
  tickMs: string;
  /** 每拍的四个修正维度（空串 = 不参与） */
  tickHp: string;
  tickMp: string;
  tickHpPercent: string;
  tickMpPercent: string;
  /** 控制标记 */
  stun: boolean;
  root: boolean;
  silence: boolean;
}

function toForm(item: Status): StatusForm {
  const tick = item.tickEffect ?? {};
  const control = item.controlFlags ?? { stun: false, root: false, silence: false };
  return {
    label: item.label,
    icon: item.icon,
    duration: String(item.duration),
    source: item.source,
    effect: item.effect,
    effectHoldLast: item.effectHoldLast,
    description: item.description,
    blockChance: item.combat.blockChance === undefined ? "" : String(item.combat.blockChance),
    blockFactor: item.combat.blockFactor === undefined ? "" : String(item.combat.blockFactor),
    defenseMultiplier: item.combat.defenseMultiplier === undefined ? "" : String(item.combat.defenseMultiplier),
    kind: item.kind || "buff",
    maxStacks: String(item.maxStacks ?? 1),
    tickMs: String(item.tickMs ?? 0),
    tickHp: tick.hp === undefined ? "" : String(tick.hp),
    tickMp: tick.mp === undefined ? "" : String(tick.mp),
    tickHpPercent: tick.hpPercent === undefined ? "" : String(tick.hpPercent),
    tickMpPercent: tick.mpPercent === undefined ? "" : String(tick.mpPercent),
    stun: control.stun === true,
    root: control.root === true,
    silence: control.silence === true,
  };
}

/** 数字字段校验（空串由调用方决定是「不设置」还是「必填」） */
function checkNumber(text: string, options: { min: number; max: number; name: string }): string | null {
  const value = Number(text);
  if (!Number.isFinite(value)) return `${options.name}必须是数字`;
  if (value < options.min) return `${options.name}不能小于 ${options.min}`;
  if (value > options.max) return `${options.name}不能大于 ${options.max}`;
  return null;
}

/**
 * 状态配置编辑弹窗（#367）
 *
 * 状态 = 一段持续效果：图标 + 身上特效 + **战斗数值修正**。修正只有三个维度
 * （格挡概率 / 格挡系数 / 防御倍率），由客户端的 `BattleMath` 纯函数消费 ——
 * 这里存的是什么，战斗里就按什么算；加新维度要同时改 BattleMath，否则存了也不生效。
 *
 * 三个维度**留空 = 不参与**（不是 0）：全部留空即「纯表现状态」（只显示图标与特效）。
 * `owner` / `id` 是行身份，不可改；状态 id 被技能 `statusId` 引用，删行会让引用方变隐形状态。
 */
function StatusEditDialog({
  open,
  initial,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  initial: Status | null;
  onCancel: () => void;
  onSubmit: (value: UpdateStatus) => Promise<boolean>;
}) {
  const [form, setForm] = useState<StatusForm | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open || !initial) return;
    setForm(toForm(initial));
    setSubmitting(false);
  }, [open, initial]);

  if (!open || !form || !initial) return null;

  const set = <K extends keyof StatusForm>(key: K, value: StatusForm[K]) => setForm({ ...form, [key]: value });

  const problems: string[] = [];
  if (!form.label.trim()) problems.push("状态名不能为空");
  const durationProblem = checkNumber(form.duration, { name: "持续时间", min: 0, max: 86400 });
  if (durationProblem) problems.push(durationProblem);
  for (const [key, name] of [
    ["blockChance", "格挡概率"],
    ["blockFactor", "格挡系数"],
  ] as const) {
    if (form[key].trim() === "") continue;
    const message = checkNumber(form[key], { name, min: 0, max: 1 });
    if (message) problems.push(message);
  }
  if (form.defenseMultiplier.trim() !== "") {
    const message = checkNumber(form.defenseMultiplier, { name: "防御倍率", min: 0, max: 10 });
    if (message) problems.push(message);
  }
  const maxStacksProblem = checkNumber(form.maxStacks, { name: "最大层数", min: 1, max: 99 });
  if (maxStacksProblem) problems.push(maxStacksProblem);
  const tickProblem = checkNumber(form.tickMs, { name: "周期间隔", min: 0, max: 600_000 });
  if (tickProblem) problems.push(tickProblem);
  for (const [key, name] of [
    ["tickHp", "每拍生命变化"],
    ["tickMp", "每拍法力变化"],
    ["tickHpPercent", "每拍生命百分比"],
    ["tickMpPercent", "每拍法力百分比"],
  ] as const) {
    if (form[key].trim() === "") continue;
    const message = checkNumber(form[key], { name, min: -1, max: 1_000_000 });
    if (message) problems.push(message);
  }
  if (Number(form.tickMs) > 0) {
    const anyTick =
      form.tickHp.trim() !== "" || form.tickMp.trim() !== "" || form.tickHpPercent.trim() !== "" || form.tickMpPercent.trim() !== "";
    // 配了间隔却没有任何每拍效果 = 每秒白跑一次扫描（服务端只 warn，运营看不见）
    if (!anyTick) problems.push("配了周期间隔，但每一拍什么都不做（补一个每拍效果，或把间隔改成 0）");
  }

  const canSubmit = problems.length === 0 && !submitting;

  const submit = async () => {
    // 整份替换：留空的维度不写键（= 不参与），全空就是 {}
    const combat: StatusCombat = {};
    if (form.blockChance.trim() !== "") combat.blockChance = Number(form.blockChance);
    if (form.blockFactor.trim() !== "") combat.blockFactor = Number(form.blockFactor);
    if (form.defenseMultiplier.trim() !== "") combat.defenseMultiplier = Number(form.defenseMultiplier);

    // 周期效果：留空 = 这一项不参与（不是 0）—— 0 会被当成「配了但恒等于 0」，
    // 而服务端的每拍结算对 0 与缺省的处理是一样的，区别只在导出后看得见
    const tickEffect: NonNullable<UpdateStatus["tickEffect"]> = {};
    if (form.tickHp.trim() !== "") tickEffect.hp = Number(form.tickHp);
    if (form.tickMp.trim() !== "") tickEffect.mp = Number(form.tickMp);
    if (form.tickHpPercent.trim() !== "") tickEffect.hpPercent = Number(form.tickHpPercent);
    if (form.tickMpPercent.trim() !== "") tickEffect.mpPercent = Number(form.tickMpPercent);

    setSubmitting(true);
    await onSubmit({
      label: form.label.trim(),
      icon: form.icon.trim(),
      duration: Number(form.duration),
      source: form.source as UpdateStatus["source"],
      effect: form.effect.trim(),
      effectHoldLast: form.effectHoldLast,
      description: form.description.trim(),
      combat,
      kind: form.kind as UpdateStatus["kind"],
      maxStacks: Number(form.maxStacks),
      tickMs: Number(form.tickMs),
      tickEffect,
      controlFlags: { stun: form.stun, root: form.root, silence: form.silence },
    });
    setSubmitting(false);
  };

  return (
    <Modal
      open
      title={
        <>
          编辑状态 · {initial.id}
          <span className="ml-2 text-xs font-normal text-slate-500">
            {SKILL_OWNER_LABELS[initial.owner] ?? initial.owner}归属
          </span>
        </>
      }
      hint="归属与 id 是行身份，不可改。状态 id 被技能的「挂载状态」引用，改名不影响引用，改 id 不行（没有改 id 的入口）。"
      size="md"
      /* Esc 先到编辑弹窗：图片选择器开着时不能让弹窗一起关（改了一半的内容会丢） */
      onClose={() => {
        if (!anyPickerOpen()) onCancel();
      }}
      footer={
        <FormFooter submitting={submitting} canSubmit={canSubmit} onCancel={onCancel} onSubmit={() => void submit()} />
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="状态名">
          <Input value={form.label} onChange={(event) => set("label", event.target.value)} />
        </Field>
        <Field label="来源">
          <Select value={form.source} onChange={(event) => set("source", event.target.value)}>
            {Object.entries(STATUS_SOURCE_LABELS).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="持续（秒）" hint="重复获得从获得时刻重新计时，不叠层">
          <Input type="number" min={0} max={86400} value={form.duration} onChange={(event) => set("duration", event.target.value)} />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <IconField
          label="图标路径"
          hint="resources 相对路径，不含扩展名"
          rootDir="skill/icon"
          placeholder="skill/icon/2009"
          value={form.icon}
          onChange={(path) => set("icon", path)}
        />
        <IconField
          label="身上特效"
          hint="特效图集（一套动画）；空 = 只在图标栏显示"
          mode="atlas"
          rootDir="effect/status"
          placeholder="effect/status/2004@0"
          value={form.effect}
          onChange={(path) => set("effect", path)}
        />
      </div>
      <label className="flex items-center gap-2 text-xs text-slate-300">
        <input type="checkbox" checked={form.effectHoldLast} onChange={(event) => set("effectHoldLast", event.target.checked)} />
        身上特效只播一遍并停在尾帧（脉冲类特效勾上）
      </label>
      <div>
        <span className="mb-2 block text-xs font-medium text-slate-400">战斗数值修正（整份替换；留空 = 该维度不参与，全空 = 纯表现状态）</span>
        <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-800 bg-slate-950/40 p-4 sm:grid-cols-3">
          <Field label="格挡概率" hint="0~1，如 0.2">
            <Input
              type="number"
              min={0}
              max={1}
              step={0.05}
              placeholder="不参与"
              value={form.blockChance}
              onChange={(event) => set("blockChance", event.target.value)}
            />
          </Field>
          <Field label="格挡系数" hint="0~1，0.5 = 本次伤害减半">
            <Input
              type="number"
              min={0}
              max={1}
              step={0.05}
              placeholder="不参与"
              value={form.blockFactor}
              onChange={(event) => set("blockFactor", event.target.value)}
            />
          </Field>
          <Field label="防御倍率" hint="≥1，1.5 = 防御 ×1.5">
            <Input
              type="number"
              min={0}
              max={10}
              step={0.05}
              placeholder="不参与"
              value={form.defenseMultiplier}
              onChange={(event) => set("defenseMultiplier", event.target.value)}
            />
          </Field>
        </div>
      </div>
      <div>
        <span className="mb-2 block text-xs font-medium text-slate-400">层数与周期（#826 第三批）</span>
        <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-800 bg-slate-950/40 p-4 sm:grid-cols-3">
          <Field label="分类" hint="只用于分组；真正生效的是下面的「周期间隔」与「控制标记」">
            <Select value={form.kind} onChange={(event) => set("kind", event.target.value)}>
              {Object.entries(STATUS_KIND_LABELS).map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="最大层数" hint="1 = 不叠；同 id 再加一层 → +1 并刷新持续时间，到期按整层消失">
            <Input type="number" min={1} max={99} value={form.maxStacks} onChange={(event) => set("maxStacks", event.target.value)} />
          </Field>
          <Field label="周期间隔（毫秒）" hint="0 = 无周期；1000 = 每秒结算一次（层数乘在每拍总量上）">
            <Input type="number" min={0} step={100} value={form.tickMs} onChange={(event) => set("tickMs", event.target.value)} />
          </Field>
          <Field label="每拍生命变化" hint="负数扣血（-50）、正数治疗；留空 = 不参与">
            <Input
              type="number"
              step={1}
              placeholder="不参与"
              value={form.tickHp}
              onChange={(event) => set("tickHp", event.target.value)}
            />
          </Field>
          <Field label="每拍生命百分比" hint="-0.02 = 每拍掉 2% 最大生命；留空 = 不参与">
            <Input
              type="number"
              step={0.01}
              placeholder="不参与"
              value={form.tickHpPercent}
              onChange={(event) => set("tickHpPercent", event.target.value)}
            />
          </Field>
          <Field label="每拍法力变化" hint="负数扣蓝、正数回蓝；留空 = 不参与">
            <Input
              type="number"
              step={1}
              placeholder="不参与"
              value={form.tickMp}
              onChange={(event) => set("tickMp", event.target.value)}
            />
          </Field>
          <Field label="每拍法力百分比" hint="-0.05 = 每拍掉 5% 最大法力；留空 = 不参与">
            <Input
              type="number"
              step={0.01}
              placeholder="不参与"
              value={form.tickMpPercent}
              onChange={(event) => set("tickMpPercent", event.target.value)}
            />
          </Field>
        </div>
      </div>
      <div>
        <span className="mb-2 block text-xs font-medium text-slate-400">控制标记（勾上即生效；眩晕与麻痹在服务端是同一条判据）</span>
        <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-800 bg-slate-950/40 p-4 sm:grid-cols-3">
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={form.stun} onChange={(event) => set("stun", event.target.checked)} />
            眩晕 / 麻痹（禁止移动与出手）
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={form.root} onChange={(event) => set("root", event.target.checked)} />
            定身（只禁止移动）
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={form.silence} onChange={(event) => set("silence", event.target.checked)} />
            沉默（只禁止出手）
          </label>
        </div>
      </div>
      <DescriptionField value={form.description} onChange={(value) => set("description", value)} />
      <ProblemList problems={problems} />
    </Modal>
  );
}

/** 战斗修正的列表摘要（空 = 纯表现状态） */
function combatSummary(combat: StatusCombat): string {
  const parts: string[] = [];
  if (combat.blockChance !== undefined) parts.push(`格挡 ${combat.blockChance}`);
  if (combat.blockFactor !== undefined) parts.push(`格挡系数 ${combat.blockFactor}`);
  if (combat.defenseMultiplier !== undefined) parts.push(`防御 ×${combat.defenseMultiplier}`);
  return parts.join(" · ");
}

/**
 * 层数 / 周期 / 控制的列表摘要（#826 第三批）
 *
 * 与 `combatSummary` 分开一列：那三个维度是「受击时怎么算」，这三个是「挂着的这段时间
 * 会发生什么」—— 混在一格里，运营看不出「这个状态到底每秒做了什么」。
 */
function behaviourSummary(status: Status): string {
  const parts: string[] = [];
  if (status.maxStacks > 1) parts.push(`最多 ${status.maxStacks} 层`);
  if (status.tickMs > 0) parts.push(`每 ${Math.round(status.tickMs / 100) / 10}s 结算`);
  const control = status.controlFlags ?? { stun: false, root: false, silence: false };
  if (control.stun) parts.push("眩晕");
  else if (control.root) parts.push("定身");
  else if (control.silence) parts.push("沉默");
  return parts.join(" · ");
}

/**
 * 状态配置管理（#367，养成配置第十页）
 *
 * 与技能同一张表的姊妹页：**角色与怪物同表**（`owner` 区分），只可编辑、不可新增 / 删除
 * （状态 id 被技能 `statusId` 引用）。战斗修正三件套由客户端 `BattleMath` 消费，
 * 改完随快照下发即生效。
 */
export function StatusesPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [draft, setDraft] = useState({ keyword: "", owner: "" });
  const [query, setQuery] = useState({ keyword: "", owner: "" });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [data, setData] = useState<PageResult<Status> | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Status | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await statusesApi.list({ page, size, keyword: query.keyword || undefined, owner: (query.owner || undefined) as "role" | "monster" | undefined }));
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
    setQuery({ keyword: draft.keyword.trim(), owner: draft.owner });
  };

  const resetSearch = () => {
    setDraft({ keyword: "", owner: "" });
    setPage(1);
    setQuery({ keyword: "", owner: "" });
  };

  /** 每页条数变化：回第一页再拉（条数变了页码语义也变了） */
  const handleSizeChange = (next: number) => {
    setSize(next);
    setPage(1);
  };

  const submitDialog = async (value: UpdateStatus): Promise<boolean> => {
    if (!editing) return false;
    try {
      await statusesApi.update(editing.id, value);
      toastSuccess(`状态「${value.label ?? editing.label}」已更新`);
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
      <PageHeader
        title="状态配置"
        description={<>角色与怪物同一张表（归属区分），只可编辑、不可新增 / 删除；状态 id 被技能的「挂载状态」引用。
            战斗修正只声明「这个状态在数值上意味着什么」，公式在客户端 BattleMath；留空 = 该维度不参与。</>}
      />

      <Card>
        <div className="flex flex-wrap items-end gap-2">
          <Field width="w-56" label="id / 状态名">
              <Input
                value={draft.keyword}
                placeholder="支持模糊匹配"
                onChange={(event) => setDraft({ ...draft, keyword: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submitSearch();
                }}
              />
            </Field>
          <Field width="w-36" label="归属">
              <Select value={draft.owner} onChange={(event) => setDraft({ ...draft, owner: event.target.value })}>
                <option value="">全部</option>
                {SKILL_OWNER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
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

      <Card
        title="状态列表"
        actions={loading ? <Spinner /> : null}
        description={canWrite ? undefined : "当前角色没有「修改养成配置」权限，列表只读。"}
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>图</th>
                <th className={thClass}>id</th>
                <th className={thClass}>状态名</th>
                <th className={thClass}>归属</th>
                <th className={thClass}>来源</th>
                <th className={thClass}>持续</th>
                <th className={thClass}>战斗修正</th>
                <th className={thClass}>特效</th>
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data?.list.map((item) => {
                const summary = combatSummary(item.combat);
                return (
                  <tr key={item.id} className="transition hover:bg-slate-800/30">
                    <td className={tdClass}>
                      <GameIcon path={item.icon} alt={item.label} />
                    </td>
                    <td className={`${tdClass} font-mono text-xs text-slate-300`}>{item.id}</td>
                    <td className={`${tdClass} font-medium text-slate-100`}>{item.label}</td>
                    <td className={tdClass}>
                      <Badge tone={item.owner === "monster" ? "amber" : "indigo"}>{SKILL_OWNER_LABELS[item.owner] ?? item.owner}</Badge>
                    </td>
                    <td className={tdClass}>{STATUS_SOURCE_LABELS[item.source] ?? item.source}</td>
                    <td className={`${tdClass} text-xs text-slate-400`}>{item.duration}s</td>
                    <td className={`${tdClass} text-xs text-slate-400`}>{summary || <span className="text-slate-600">（纯表现）</span>}</td>
                    <td className={`${tdClass} text-xs text-slate-400`}>{behaviourSummary(item)}</td>
                    <td className={`${tdClass} max-w-[220px] truncate text-xs text-slate-400`} title={item.effect}>
                      {item.effect ? (
                        <>
                          {item.effect}
                          {item.effectHoldLast ? <span className="ml-1 text-slate-500">（停尾帧）</span> : null}
                        </>
                      ) : (
                        <span className="text-slate-600">（仅图标）</span>
                      )}
                    </td>
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
                );
              })}
            </tbody>
          </table>
        </div>

        {!loading && data && data.list.length === 0 ? <EmptyState title="没有匹配的状态" description="换个筛选条件试试" /> : null}

        <Pagination page={page} size={size} total={data?.total ?? 0} onChange={setPage} onSizeChange={handleSizeChange} />
      </Card>

      <StatusEditDialog
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
