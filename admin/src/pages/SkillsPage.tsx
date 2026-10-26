import { useCallback, useEffect, useState } from "react";
import {
  formatTime,
  PERMISSION,
  SKILL_CATEGORY_LABELS,
  SKILL_OWNER_LABELS,
  SKILL_OWNER_OPTIONS,
  SKILL_TARGET_TYPE_LABELS,
  skillsApi,
  statusesApi,
} from "../api";
import type { DamageCoefficient, PageResult, Skill, Status, UpdateSkill } from "../api";
import { Pagination } from "../components/Pagination";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/**
 * 伤害系数的收益基数（**与服务端 `DAMAGE_BASE_TYPES` 同集合**：
 * `COMBAT_SINGLE_KEYS + COMBAT_RANGE_KEYS` —— 顺序按「八项属性」的习惯排法，
 * 只是下拉框的展示顺序；真正会被结算读取的是技能配置里存下的 baseType 字符串）
 */
const DAMAGE_BASE_OPTIONS = [
  { value: "physicalAttack", label: "物攻" },
  { value: "magicAttack", label: "魔攻" },
  { value: "taoistAttack", label: "道攻" },
  { value: "physicalDefense", label: "物防" },
  { value: "magicDefense", label: "魔防" },
  { value: "taoistDefense", label: "道防" },
  { value: "maxHp", label: "生命上限" },
  { value: "hpRecover", label: "生命恢复" },
] as const;

/** 基数 key → 中文名（配置里可能存了没登记过的 key，原样显示） */
function damageBaseLabel(key: string): string {
  return DAMAGE_BASE_OPTIONS.find((item) => item.value === key)?.label ?? key;
}

/** 伤害系数最多 20 级（下标 = 技能等级 - 1，与服务端 `ArrayMaxSize(20)` 对齐） */
const COEFFICIENT_MAX_LEVELS = 20;

/** 弹窗表单值：数字字段一律以字符串承载（空串 / 非法输入不静默变 0），提交前统一校验 */
interface SkillForm {
  label: string;
  icon: string;
  category: string;
  targetType: string;
  action: string;
  effect: string;
  effectOnSelf: boolean;
  cooldown: string;
  mpCost: string;
  distance: string;
  levelReq: string;
  castLockMs: string;
  requireTarget: boolean;
  canAuto: boolean;
  statusId: string;
  description: string;
  coefficients: DamageCoefficient[];
}

/** 由一条技能配置展开成表单 */
function toForm(item: Skill): SkillForm {
  return {
    label: item.label,
    icon: item.icon,
    category: item.category,
    targetType: item.targetType,
    action: item.action,
    effect: item.effect,
    effectOnSelf: item.effectOnSelf,
    cooldown: String(item.cooldown),
    mpCost: String(item.mpCost),
    distance: String(item.distance),
    levelReq: String(item.levelReq),
    castLockMs: String(item.castLockMs),
    requireTarget: item.requireTarget,
    canAuto: item.canAuto,
    statusId: item.statusId,
    description: item.description,
    coefficients: item.damageCoefficients.map((entry) => ({ ...entry })),
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

/**
 * 技能配置编辑弹窗（#367）
 *
 * 一次展示**整条技能配置**：表现（图标 / 动作 / 特效）、释放限制（冷却 / 耗蓝 / 距离 /
 * 等级 / 动作锁 / 是否要求目标 / 是否可自动）、结算（伤害系数）与挂载状态。
 * 部分更新只是协议形态，这里按「整份提交」处理 —— 少一个回填字段就会出现
 * 「以为只改了冷却结果把倍率清零」这类事故。
 *
 * 校验分工：跨字段约束（状态型技能必须有状态、主动技能至少一条倍率）在这里做**即时提示**，
 * 权威在服务端（`assertSkillConsistency`：40000）。`owner` / `id` 是行身份，不可改。
 */
function SkillEditDialog({
  open,
  initial,
  statusOptions,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  initial: Skill | null;
  /** 可挂载的状态（来自状态表；只列角色归属，怪物状态等 #12 主体那一刀） */
  statusOptions: Status[];
  onCancel: () => void;
  onSubmit: (value: UpdateSkill) => Promise<boolean>;
}) {
  const [form, setForm] = useState<SkillForm | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open || !initial) return;
    setForm(toForm(initial));
    setSubmitting(false);
  }, [open, initial]);

  if (!open || !form || !initial) return null;

  const set = <K extends keyof SkillForm>(key: K, value: SkillForm[K]) => setForm({ ...form, [key]: value });

  const setCoefficient = (index: number, patch: Partial<DamageCoefficient>) => {
    setForm({
      ...form,
      coefficients: form.coefficients.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
    });
  };

  /** 全部校验项（空数组 = 可提交）；宁可多报一句，也不让服务端 400 打回 */
  const problems: string[] = [];
  if (!form.label.trim()) problems.push("技能名不能为空");
  const numberChecks: (string | null)[] = [
    checkNumber(form.cooldown, { name: "冷却", min: 0, max: 3600 }),
    checkNumber(form.mpCost, { name: "耗蓝", min: 0, max: 1_000_000, int: true }),
    checkNumber(form.distance, { name: "施法距离", min: 0, max: 100_000 }),
    checkNumber(form.levelReq, { name: "等级需求", min: 1, max: 200, int: true }),
    checkNumber(form.castLockMs, { name: "动作锁", min: 0, max: 10_000, int: true }),
  ];
  for (const message of numberChecks) {
    if (message) problems.push(message);
  }
  if (form.category === "2" && !form.statusId) problems.push("状态型技能必须指定要挂载的状态");
  if (form.category !== "2" && form.coefficients.length === 0) problems.push("主动 / 回复类技能至少要有一条伤害系数");
  form.coefficients.forEach((entry, index) => {
    if (!entry.baseType) problems.push(`第 ${index + 1} 级的收益基数没选`);
    const message = checkNumber(String(entry.baseTypeRate), { name: `第 ${index + 1} 级的倍率`, min: 0, max: 100 });
    if (message) problems.push(message);
  });

  const canSubmit = problems.length === 0 && !submitting;

  const submit = async () => {
    setSubmitting(true);
    await onSubmit({
      label: form.label.trim(),
      icon: form.icon.trim(),
      category: form.category as UpdateSkill["category"],
      targetType: form.targetType as UpdateSkill["targetType"],
      action: form.action.trim(),
      effect: form.effect.trim(),
      effectOnSelf: form.effectOnSelf,
      cooldown: Number(form.cooldown),
      mpCost: Number(form.mpCost),
      distance: Number(form.distance),
      levelReq: Number(form.levelReq),
      castLockMs: Number(form.castLockMs),
      requireTarget: form.requireTarget,
      canAuto: form.canAuto,
      statusId: form.statusId,
      description: form.description.trim(),
      damageCoefficients: form.coefficients.map((entry) => ({ baseType: entry.baseType, baseTypeRate: entry.baseTypeRate })),
    });
    setSubmitting(false);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
        <h3 className="text-base font-semibold text-slate-100">
          编辑技能 · {initial.id}
          <span className="ml-2 text-xs font-normal text-slate-500">{SKILL_OWNER_LABELS[initial.owner] ?? initial.owner}归属</span>
        </h3>
        <p className="mt-1 text-xs text-slate-500">
          归属与 id 是行身份，不可改。保存后随配置快照下发客户端；角色技能即时生效，怪物技能等 #12 主体那一刀接上释放。
        </p>

        <div className="mt-5 flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="技能名">
              <Input value={form.label} onChange={(event) => set("label", event.target.value)} />
            </Field>
            <Field label="分类" hint="决定释放后做什么">
              <Select value={form.category} onChange={(event) => set("category", event.target.value)}>
                {Object.entries(SKILL_CATEGORY_LABELS).map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="目标类型">
              <Select value={form.targetType} onChange={(event) => set("targetType", event.target.value)}>
                {Object.entries(SKILL_TARGET_TYPE_LABELS).map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="图标路径" hint="resources 相对路径，不含扩展名；空 = 不显示">
              <Input value={form.icon} onChange={(event) => set("icon", event.target.value)} />
            </Field>
            <Field label="施法动作" hint="客户端动画动作键（如 attack_near）；空 = 不播动作">
              <Input value={form.action} onChange={(event) => set("action", event.target.value)} />
            </Field>
            <Field label="技能特效" hint="图集路径；空 = 无特效">
              <Input value={form.effect} onChange={(event) => set("effect", event.target.value)} />
            </Field>
            <Field label="挂载状态" hint="释放成功后给自身挂的状态；状态型技能必填">
              <Select value={form.statusId} onChange={(event) => set("statusId", event.target.value)}>
                <option value="">（不挂状态）</option>
                {statusOptions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.id} · {item.label}
                  </option>
                ))}
                {/* 配置里引用了不在列表里的状态（跨归属 / 已被清理）：保留原值，避免保存时被悄悄清空 */}
                {form.statusId && !statusOptions.some((item) => item.id === form.statusId) ? (
                  <option value={form.statusId}>{form.statusId}（未在状态表中）</option>
                ) : null}
              </Select>
            </Field>
          </div>

          <div>
            <span className="mb-2 block text-xs font-medium text-slate-400">释放限制（动作锁同时锁移动与再次出手）</span>
            <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-800 bg-slate-950/40 p-4 sm:grid-cols-3">
              <Field label="冷却（秒）" hint="0 = 不限制">
                <Input type="number" min={0} step={0.1} value={form.cooldown} onChange={(event) => set("cooldown", event.target.value)} />
              </Field>
              <Field label="耗蓝" hint="0 = 不消耗">
                <Input type="number" min={0} value={form.mpCost} onChange={(event) => set("mpCost", event.target.value)} />
              </Field>
              <Field label="施法距离" hint="0 = 不限">
                <Input type="number" min={0} value={form.distance} onChange={(event) => set("distance", event.target.value)} />
              </Field>
              <Field label="等级需求">
                <Input type="number" min={1} value={form.levelReq} onChange={(event) => set("levelReq", event.target.value)} />
              </Field>
              <Field label="动作锁（毫秒）" hint="0 = 跟动画时长走">
                <Input type="number" min={0} value={form.castLockMs} onChange={(event) => set("castLockMs", event.target.value)} />
              </Field>
              <div className="flex flex-col justify-center gap-2">
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input type="checkbox" checked={form.requireTarget} onChange={(event) => set("requireTarget", event.target.checked)} />
                  要求有合法目标
                </label>
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input type="checkbox" checked={form.effectOnSelf} onChange={(event) => set("effectOnSelf", event.target.checked)} />
                  特效播在自己身上
                </label>
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input type="checkbox" checked={form.canAuto} onChange={(event) => set("canAuto", event.target.checked)} />
                  可被自动战斗释放
                </label>
              </div>
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-slate-400">伤害系数（下标 = 技能等级 - 1，整份替换）</span>
              <Button
                variant="outline"
                className="px-2.5 py-1 text-xs"
                disabled={form.coefficients.length >= COEFFICIENT_MAX_LEVELS}
                onClick={() => set("coefficients", [...form.coefficients, { baseType: "physicalAttack", baseTypeRate: 1 }])}
              >
                加一级
              </Button>
            </div>
            <div className="flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
              {form.coefficients.length === 0 ? (
                <p className="text-xs text-slate-500">没有配置倍率：状态型技能可以为空，主动 / 回复类技能至少一条。</p>
              ) : null}
              {form.coefficients.map((entry, index) => (
                <div key={index} className="flex items-center gap-2">
                  <span className="w-12 shrink-0 text-xs text-slate-500">Lv.{index + 1}</span>
                  <Select
                    className="w-32"
                    value={entry.baseType}
                    onChange={(event) => setCoefficient(index, { baseType: event.target.value })}
                  >
                    {DAMAGE_BASE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                  <span className="text-xs text-slate-600">×</span>
                  <Input
                    type="number"
                    min={0}
                    step={0.05}
                    className="w-24"
                    aria-label={`第 ${index + 1} 级倍率`}
                    value={entry.baseTypeRate}
                    onChange={(event) => setCoefficient(index, { baseTypeRate: Number(event.target.value) || 0 })}
                  />
                  <Button
                    variant="ghost"
                    className="px-2 py-1 text-xs text-rose-300"
                    onClick={() => set("coefficients", form.coefficients.filter((_, i) => i !== index))}
                  >
                    删除
                  </Button>
                </div>
              ))}
            </div>
          </div>

          <Field label="描述文案" hint="≤500 字">
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
            保存修改
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * 技能配置管理（#367，养成配置第九页）
 *
 * **角色与怪物同一张表**（`owner` 区分）：技能对两边完全同构 —— 一个动作 + 一套倍率，
 * 或一段状态；分表只会让「同一个技能既给人又给怪」变成复制两份并必然漂移。
 *
 * 与称号 / 装备 / 怪物同一取向：**没有「新建」「删除」**，只有「编辑」（角色技能 id
 * 被技能栏 / 快捷键 / 角色存档引用，行清单固定）；怪物技能的增删随 #12 主体开。
 * 写操作要 `gameConfig:write`。
 */
export function SkillsPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [draft, setDraft] = useState({ keyword: "", owner: "" });
  const [query, setQuery] = useState({ keyword: "", owner: "" });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [data, setData] = useState<PageResult<Skill> | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Skill | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  /** 可挂载的状态清单（挂载状态下拉用；状态数量很少，一次拉满） */
  const [statusOptions, setStatusOptions] = useState<Status[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await skillsApi.list({ page, size, keyword: query.keyword || undefined, owner: (query.owner || undefined) as "role" | "monster" | undefined }));
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
    statusesApi
      .list({ page: 1, size: 100, owner: "role" })
      .then((result) => {
        if (alive) setStatusOptions(result.list);
      })
      .catch(() => {
        /* 挂载状态下拉拉不到不影响主流程：编辑时保留原值即可 */
      });
    return () => {
      alive = false;
    };
  }, []);

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

  const submitDialog = async (value: UpdateSkill): Promise<boolean> => {
    if (!editing) return false;
    try {
      await skillsApi.update(editing.id, value);
      toastSuccess(`技能「${value.label ?? editing.label}」已更新`);
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
        <h1 className="text-lg font-semibold text-slate-50">技能配置</h1>
        <p className="mt-1 text-xs text-slate-500">
          角色与怪物同一张表（归属区分），只可编辑、不可新增 / 删除；保存后随配置快照下发客户端。
          释放限制里的动作锁同时锁移动与再次出手；状态型技能必须指定要挂载的状态。
        </p>
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">id / 技能名</span>
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
            <span className="mb-1.5 block text-xs font-medium text-slate-400">归属</span>
            <Select value={draft.owner} onChange={(event) => setDraft({ ...draft, owner: event.target.value })}>
              <option value="">全部</option>
              {SKILL_OWNER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
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
        title="技能列表"
        actions={loading ? <Spinner /> : null}
        description={canWrite ? undefined : "当前角色没有「修改养成配置」权限，列表只读。"}
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>id</th>
                <th className={thClass}>技能名</th>
                <th className={thClass}>归属</th>
                <th className={thClass}>分类</th>
                <th className={thClass}>目标</th>
                <th className={thClass}>消耗</th>
                <th className={thClass}>倍率</th>
                <th className={thClass}>动作锁</th>
                <th className={thClass}>挂载状态</th>
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data?.list.map((item) => {
                const first = item.damageCoefficients[0];
                return (
                  <tr key={item.id} className="transition hover:bg-slate-800/30">
                    <td className={`${tdClass} font-mono text-xs text-slate-300`}>{item.id}</td>
                    <td className={`${tdClass} font-medium text-slate-100`}>{item.label}</td>
                    <td className={tdClass}>
                      <Badge tone={item.owner === "monster" ? "amber" : "indigo"}>{SKILL_OWNER_LABELS[item.owner] ?? item.owner}</Badge>
                    </td>
                    <td className={tdClass}>{SKILL_CATEGORY_LABELS[item.category] ?? item.category}</td>
                    <td className={tdClass}>{SKILL_TARGET_TYPE_LABELS[item.targetType] ?? item.targetType}</td>
                    <td className={`${tdClass} text-xs text-slate-400`}>
                      冷却 {item.cooldown}s · 蓝 {item.mpCost}
                      {item.distance > 0 ? ` · 距离 ${item.distance}` : ""}
                    </td>
                    <td className={`${tdClass} text-xs text-slate-400`}>
                      {first ? `${damageBaseLabel(first.baseType)}×${first.baseTypeRate}（共 ${item.damageCoefficients.length} 级）` : "—"}
                    </td>
                    <td className={`${tdClass} text-xs text-slate-400`}>{item.castLockMs > 0 ? `${item.castLockMs}ms` : "跟动画"}</td>
                    <td className={`${tdClass} text-xs text-slate-400`}>
                      {item.statusId ? item.statusId : <span className="text-slate-600">（不挂）</span>}
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

        {!loading && data && data.list.length === 0 ? <EmptyState title="没有匹配的技能" description="换个筛选条件试试" /> : null}

        <Pagination page={page} size={size} total={data?.total ?? 0} onChange={setPage} onSizeChange={handleSizeChange} />
      </Card>

      <SkillEditDialog
        open={dialogOpen}
        initial={editing}
        statusOptions={statusOptions}
        onCancel={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
        onSubmit={submitDialog}
      />
    </div>
  );
}
