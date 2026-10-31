import { useCallback, useEffect, useMemo, useState } from "react";
import { formatTime, monstersApi, PERMISSION, skillsApi } from "../api";
import type { Monster, MonsterAttributes, PageResult, Skill } from "../api";
import { AttributesGrid, crossedRangeKeys } from "../components/AttributesEditor";
import { Pagination } from "../components/Pagination";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/** 定位中文名（configs/monster 的 tier） */
const TIER_LABELS: Record<string, string> = { normal: "普通", elite: "精英", boss: "首领" };
const TIER_OPTIONS = Object.entries(TIER_LABELS);

/** 属性摘要（列表列太窄，只报几个关键数；完整数值在编辑弹窗里） */
function attributeSummary(item: Monster): string {
  const a = item.attributes;
  return `生命 ${item.maxHp} · 物攻 ${a.physicalAttack.min}~${a.physicalAttack.max} · 物防 ${a.physicalDefense.min}~${a.physicalDefense.max}`;
}

/**
 * 怪物基础数据编辑弹窗（#258）
 *
 * 开放「名称 + 等级 + 生命上限 + 六项攻防区间」；`tier` 不开放编辑（已展开数值才是
 * 结算依据）。属性**整份提交、整份替换**（服务端口径），六项全部展示、全部回填。
 * 改完即时生效：世界播种与伤害结算直读 monsters 表。
 * 校验分工：min ≤ max 在这里做即时提示，权威在服务端（DTO 校验 + 50019/40000）。
 */
function MonsterEditDialog({
  open,
  initial,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  initial: Monster | null;
  onCancel: () => void;
  onSubmit: (value: { label: string; level: number; maxHp: number; attributes: MonsterAttributes }) => Promise<boolean>;
}) {
  const [label, setLabel] = useState("");
  const [level, setLevel] = useState("1");
  const [maxHp, setMaxHp] = useState("1");
  const [attributes, setAttributes] = useState<MonsterAttributes | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLabel(initial?.label ?? "");
    setLevel(initial ? String(initial.level) : "1");
    setMaxHp(initial ? String(initial.maxHp) : "1");
    setAttributes(initial?.attributes ? { ...initial.attributes } : null);
    setSubmitting(false);
  }, [open, initial]);

  /** 区间交叉（min > max）的键集合；空 = 合法 */
  const crossedKeys = useMemo(() => (attributes ? crossedRangeKeys(attributes) : []), [attributes]);

  if (!open || !attributes || !initial) return null;

  const levelValid = Number.isInteger(Number(level)) && Number(level) >= 1;
  const maxHpValid = Number.isInteger(Number(maxHp)) && Number(maxHp) >= 1;
  const canSubmit = label.trim().length > 0 && levelValid && maxHpValid && crossedKeys.length === 0 && !submitting;

  const submit = async () => {
    setSubmitting(true);
    await onSubmit({ label: label.trim(), level: Number(level), maxHp: Number(maxHp), attributes });
    setSubmitting(false);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
        <h3 className="text-base font-semibold text-slate-100">编辑怪物 · {initial.id}</h3>
        <p className="mt-1 text-xs text-slate-500">
          定位 {TIER_LABELS[initial.tier] ?? initial.tier}（不可改）。改完即时生效：世界播种与伤害结算直读 monsters 表；
          已活着的世界实例血量上限沿用出生时的值，重生后用新值。
        </p>

        <div className="mt-5 flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="名称">
              <Input value={label} onChange={(event) => setLabel(event.target.value)} />
            </Field>
            <Field label="等级" hint="显示用元数据；改它不会重算战斗数值">
              <Input type="number" min={1} value={level} onChange={(event) => setLevel(event.target.value)} />
            </Field>
            <Field label="生命上限">
              <Input type="number" min={1} value={maxHp} onChange={(event) => setMaxHp(event.target.value)} />
            </Field>
          </div>

          <AttributesGrid attributes={attributes} onChange={setAttributes} header="六项攻防区间（整份替换）" crossed={crossedKeys} />

          {!levelValid || !maxHpValid ? (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              等级与生命上限需为 ≥1 的整数。
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
 * 怪物技能挂载弹窗（#372）
 *
 * 一行的语义：**这只怪会放哪些技能、按什么顺序放**。挂载独立于技能表 ——
 * 一个技能可被多只怪共用，挂在技能行上会变成复制两份并必然漂移。
 *
 * 提交是**整份替换**（PUT）：这份清单就是全部，删掉一行等于解绑。
 * 顺序说明：服务端尝试顺序 = 状态型整体先于伤害型 → priority 升序 → skillId 升序；
 * 这里的列表只按 priority 展示，不代替服务端的确定性排序。
 * 可选池 = 技能表里 `owner=monster` 的行（角色技能挂给怪没有释放路径）。
 */
function MonsterSkillsDialog({
  open,
  monster,
  onClose,
  onSaved,
}: {
  open: boolean;
  monster: Monster | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  /** 编辑中的挂载行（数字字段以字符串承载，空串 = 用技能自身冷却） */
  type Row = { skillId: string; priority: string; cooldown: string };
  const [rows, setRows] = useState<Row[]>([]);
  const [pool, setPool] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !monster) return;
    let alive = true;
    setLoading(true);
    setSaving(false);
    void (async () => {
      try {
        const [list, skills] = await Promise.all([
          monstersApi.listSkills(monster.id),
          skillsApi.list({ page: 1, size: 100, owner: "monster" }),
        ]);
        if (!alive) return;
        setRows(
          list.list.map((item) => ({
            skillId: item.skillId,
            priority: String(item.priority),
            cooldown: typeof item.cooldown === "number" ? String(item.cooldown) : "",
          })),
        );
        setPool(skills.list);
      } catch {
        /* 错误已由请求层统一提示 */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, monster]);

  if (!open || !monster) return null;

  const labelOf = (skillId: string) => pool.find((item) => item.id === skillId)?.label ?? "（未知技能）";
  /** 还没挂上的怪物技能（可选池减已挂） */
  const addable = pool.filter((item) => !rows.some((row) => row.skillId === item.id));

  const problems: string[] = [];
  for (const row of rows) {
    if (!/^\d+$/.test(row.priority.trim())) problems.push(`技能「${labelOf(row.skillId)}」的优先级必须是非负整数`);
    if (row.cooldown.trim() !== "") {
      const value = Number(row.cooldown);
      if (!Number.isFinite(value) || value < 0 || value > 3600) problems.push(`技能「${labelOf(row.skillId)}」的冷却需在 0~3600 秒之间`);
    }
  }
  if (rows.length > 0 && pool.length === 0) problems.push("挂载引用的技能不在技能表里，先去「技能配置」补上再保存");

  const save = async () => {
    setSaving(true);
    try {
      await monstersApi.replaceSkills(monster.id, {
        skills: rows.map((row) => ({
          skillId: row.skillId,
          priority: Number(row.priority.trim()),
          // 空串 = 不传（服务端回落到技能自身的 cooldown）
          ...(row.cooldown.trim() === "" ? {} : { cooldown: Number(row.cooldown) }),
        })),
      });
      toastSuccess(`怪物「${monster.label}」的技能挂载已保存（最多 1 秒后生效）`);
      onSaved();
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
        <h3 className="text-base font-semibold text-slate-100">技能挂载 · {monster.label}</h3>
        <p className="mt-1 text-xs text-slate-500">
          服务端 AI 先用状态型（强化自身），再用伤害型；同类型内按优先级升序，同优先级按技能 id。
          冷却留空 = 用技能自身的冷却。整份保存，删行等于解绑。
        </p>

        {loading ? (
          <div className="mt-6 flex justify-center">
            <Spinner />
          </div>
        ) : (
          <>
            <div className="mt-5 flex flex-col gap-2">
              {rows.length === 0 ? (
                <p className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-500">
                  这只怪不放技能，只普攻。
                </p>
              ) : null}
              {rows.map((row, index) => (
                <div key={row.skillId} className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                  <span className="min-w-[140px] flex-1 text-xs text-slate-200">
                    <span className="font-mono text-slate-500">{row.skillId}</span> · {labelOf(row.skillId)}
                  </span>
                  <label className="flex items-center gap-1 text-xs text-slate-400">
                    优先级
                    <Input
                      className="w-16"
                      aria-label={`${row.skillId} 优先级`}
                      value={row.priority}
                      onChange={(event) => setRows(rows.map((entry, i) => (i === index ? { ...entry, priority: event.target.value } : entry)))}
                    />
                  </label>
                  <label className="flex items-center gap-1 text-xs text-slate-400">
                    冷却
                    <Input
                      className="w-20"
                      placeholder="跟技能"
                      aria-label={`${row.skillId} 冷却`}
                      value={row.cooldown}
                      onChange={(event) => setRows(rows.map((entry, i) => (i === index ? { ...entry, cooldown: event.target.value } : entry)))}
                    />
                  </label>
                  <Button
                    variant="ghost"
                    className="px-2 py-1 text-xs text-rose-300"
                    onClick={() => setRows(rows.filter((_, i) => i !== index))}
                  >
                    移除
                  </Button>
                </div>
              ))}
            </div>

            <div className="mt-3 flex flex-wrap items-end gap-2">
              <div className="min-w-[200px] flex-1">
                <span className="mb-1.5 block text-xs font-medium text-slate-400">添加技能</span>
                <Select
                  value=""
                  disabled={addable.length === 0}
                  onChange={(event) => {
                    const skillId = event.target.value;
                    if (!skillId) return;
                    setRows([...rows, { skillId, priority: String(rows.length + 1), cooldown: "" }]);
                  }}
                >
                  <option value="">{addable.length === 0 ? "（没有可添加的怪物技能）" : "选一个怪物技能…"}</option>
                  {addable.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.id} · {item.label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            {problems.length > 0 ? (
              <ul className="mt-4 space-y-1 rounded-lg border border-amber-900/50 bg-amber-950/20 p-3 text-xs text-amber-300">
                {problems.map((message) => (
                  <li key={message}>· {message}</li>
                ))}
              </ul>
            ) : null}
          </>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" disabled={saving} onClick={onClose}>
            取消
          </Button>
          <Button disabled={loading || saving || problems.length > 0} loading={saving} onClick={() => void save()}>
            保存挂载
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * 怪物配置管理（#258，养成配置第六页）
 *
 * key 清单固定（被地图刷怪点 / 掉落表 / 技能引用，启动时 seed 落库）——
 * **没有「新建」「删除」**，只有「编辑」；tier 不开放编辑。按关键字 / 定位筛选。
 * 战斗数值是客户端 monsterStats 打底 + 条目覆盖的展开结果，改这里即时生效。
 * 技能挂载（#372）单独一个弹窗，整份替换 —— 掉落表归「掉落配置」管理。
 * 写操作要 `gameConfig:write`。
 */
export function MonstersPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [draft, setDraft] = useState({ keyword: "", tier: "" });
  const [query, setQuery] = useState({ keyword: "", tier: "" });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [data, setData] = useState<PageResult<Monster> | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Monster | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  /** 技能挂载弹窗的目标怪（= null 表示关闭） */
  const [skillTarget, setSkillTarget] = useState<Monster | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await monstersApi.list({ page, size, keyword: query.keyword || undefined, tier: query.tier || undefined }));
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
    setQuery({ keyword: draft.keyword.trim(), tier: draft.tier });
  };

  const resetSearch = () => {
    setDraft({ keyword: "", tier: "" });
    setPage(1);
    setQuery({ keyword: "", tier: "" });
  };

  /** 每页条数变化：回第一页再拉（条数变了页码语义也变了） */
  const handleSizeChange = (next: number) => {
    setSize(next);
    setPage(1);
  };

  /** 编辑弹窗提交（部分更新：只发弹窗里有的字段；属性整份替换） */
  const submitDialog = async (value: { label: string; level: number; maxHp: number; attributes: MonsterAttributes }): Promise<boolean> => {
    if (!editing) return false;
    try {
      await monstersApi.update(editing.id, value);
      toastSuccess(`怪物「${value.label}」已更新`);
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
        <h1 className="text-lg font-semibold text-slate-50">怪物配置</h1>
        <p className="mt-1 text-xs text-slate-500">
          key 清单固定（被地图刷怪点 / 掉落表 / 技能引用），只可编辑、不可新增 / 删除；定位不开放编辑。
          改名称与战斗数值即时生效（世界播种与伤害结算直读 monsters 表）。掉落表归「掉落配置」管理。
        </p>
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">key / 名称</span>
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
            <span className="mb-1.5 block text-xs font-medium text-slate-400">定位</span>
            <Select value={draft.tier} onChange={(event) => setDraft({ ...draft, tier: event.target.value })}>
              <option value="">全部</option>
              {TIER_OPTIONS.map(([value, text]) => (
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
        title="怪物列表"
        actions={loading ? <Spinner /> : null}
        description={canWrite ? undefined : "当前角色没有「修改养成配置」权限，列表只读。"}
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>key</th>
                <th className={thClass}>名称</th>
                <th className={thClass}>定位</th>
                <th className={thClass}>等级</th>
                <th className={thClass}>生命</th>
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
                    <Badge tone={item.tier === "boss" ? "red" : item.tier === "elite" ? "amber" : "slate"}>{TIER_LABELS[item.tier] ?? item.tier}</Badge>
                  </td>
                  <td className={tdClass}>{item.level}</td>
                  <td className={tdClass}>{item.maxHp}</td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{attributeSummary(item)}</td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{formatTime(item.updatedAt)}</td>
                  <td className={`${tdClass} text-right`}>
                    <div className="flex justify-end gap-2">
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
                      <Button variant="outline" className="px-2.5 py-1 text-xs" onClick={() => setSkillTarget(item)}>
                        技能
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!loading && data && data.list.length === 0 ? <EmptyState title="没有匹配的怪物" description="换个筛选条件试试" /> : null}

        <Pagination page={page} size={size} total={data?.total ?? 0} onChange={setPage} onSizeChange={handleSizeChange} />
      </Card>

      <MonsterEditDialog
        open={dialogOpen}
        initial={editing}
        onCancel={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
        onSubmit={submitDialog}
      />

      <MonsterSkillsDialog
        open={skillTarget !== null}
        monster={skillTarget}
        onClose={() => setSkillTarget(null)}
        onSaved={() => {
          setSkillTarget(null);
          void load();
        }}
      />
    </div>
  );
}
