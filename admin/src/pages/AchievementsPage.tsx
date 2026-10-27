import { useCallback, useEffect, useState } from "react";
import { achievementsApi, formatTime, PERMISSION } from "../api";
import type { Achievement, AchievementQuery, PageResult } from "../api";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { Pagination } from "../components/Pagination";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/** 分类的中文名（与 achievement-data 的 category 同值） */
const CATEGORY_LABELS: Record<string, string> = {
  battle: "战斗",
  growth: "成长",
  explore: "探索",
};

/** 条件类型的中文名 + 一句「它靠什么推进」 */
const CONDITION_LABELS: Record<string, string> = {
  kill: "累计击杀",
  quest: "累计交付任务",
  level: "等级达到",
  combat: "战力达到",
  collect: "持有物品",
};

/** 累计型条件（进度靠事件记账；其余是查询现算） */
const CUMULATIVE = new Set(["kill", "quest"]);

/** 分类与条件类型的枚举（与 DTO 同值；写成联合类型是为了让保存时的 payload 直接通过类型检查） */
type Category = "battle" | "growth" | "explore";
type ConditionType = "kill" | "quest" | "level" | "combat" | "collect";

/** 编辑 / 新建表单的草稿形状（奖励物品用「id:数量, id:数量」这一行文本，保存时解析） */
interface Draft {
  id: string;
  category: Category;
  label: string;
  description: string;
  conditionType: ConditionType;
  conditionTarget: string;
  conditionCount: number;
  gold: number;
  exp: number;
  itemsText: string;
  sortOrder: number;
  hidden: boolean;
}

/** 一条成就 → 草稿 */
function toDraft(item: Achievement): Draft {
  return {
    id: item.id,
    category: item.category as Category,
    label: item.label,
    description: item.description,
    conditionType: item.condition.type as ConditionType,
    conditionTarget: item.condition.target,
    conditionCount: item.condition.count,
    gold: item.rewards.gold,
    exp: item.rewards.exp,
    itemsText: item.rewards.items.map((entry) => `${entry.goodId}:${entry.count}`).join(", "),
    sortOrder: item.sortOrder,
    hidden: item.hidden,
  };
}

/** 空草稿（新建用；默认给一条「击杀任意怪 10 只」的骨架，运营改两个数就能用） */
function emptyDraft(): Draft {
  return {
    id: "",
    category: "battle",
    label: "",
    description: "",
    conditionType: "kill",
    conditionTarget: "*",
    conditionCount: 10,
    gold: 0,
    exp: 0,
    itemsText: "",
    sortOrder: 0,
    hidden: false,
  };
}

/** 奖励物品文本 → DTO 数组（格式错直接抛，交给上层提示） */
function parseItems(text: string): Array<{ goodId: string; count: number }> {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return trimmed.split(",").map((piece) => {
    const [goodId, count] = piece.split(":");
    const id = (goodId ?? "").trim();
    const amount = Number((count ?? "").trim());
    if (!id) throw new Error("奖励物品格式应为「物品id:数量」");
    if (!Number.isInteger(amount) || amount <= 0) throw new Error(`物品 ${id} 的数量必须是正整数`);
    return { goodId: id, count: amount };
  });
}

/** 条件的一句人话（列表里给运营看的） */
function conditionSummary(item: Achievement): string {
  const label = CONDITION_LABELS[item.condition.type] ?? item.condition.type;
  if (item.condition.type === "kill") {
    const target = item.condition.target === "*" ? "任意怪" : `怪物 ${item.condition.target}`;
    return `${label}：${target} × ${item.condition.count}`;
  }
  if (item.condition.type === "collect") return `${label}：${item.condition.target} × ${item.condition.count}`;
  if (item.condition.type === "quest") return `${label}：${item.condition.count} 个`;
  return `${label}：${item.condition.count}`;
}

/**
 * 成就配置管理（#401）
 *
 * 与「任务配置」同一取向：**允许动态增删**（成就是运营内容），但删除有一条守卫 ——
 * 有玩家成就记录时会被拒绝，删除前先清记录。
 *
 * 页面上把「累计型 / 状态型」标出来，是因为这两类的**进度来源不同**：
 * 累计型（击杀 / 交付任务）由事件流记账，改门槛只影响「还要再做多少次」；
 * 状态型（等级 / 战力 / 持有）是每次查询按角色当前状态现算，改门槛会立刻改变
 * 所有人的达成状态（把 10 级改成 1 级，所有角色立刻可领）。
 */
export function AchievementsPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [draftFilter, setDraftFilter] = useState({ keyword: "", category: "" });
  const [query, setQuery] = useState({ keyword: "", category: "" });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [data, setData] = useState<PageResult<Achievement> | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<Draft | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(
        await achievementsApi.list({
          page,
          size,
          keyword: query.keyword || undefined,
          category: (query.category || undefined) as AchievementQuery["category"],
        }),
      );
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
    setQuery({ keyword: draftFilter.keyword.trim(), category: draftFilter.category });
  };

  const resetSearch = () => {
    setDraftFilter({ keyword: "", category: "" });
    setPage(1);
    setQuery({ keyword: "", category: "" });
  };

  const handleSizeChange = (next: number) => {
    setSize(next);
    setPage(1);
  };

  /** 保存（新建走 create，编辑走部分更新） */
  const save = async () => {
    if (!form) return;
    let items: Array<{ goodId: string; count: number }>;
    try {
      items = parseItems(form.itemsText);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "奖励物品格式不对");
      return;
    }
    const payload = {
      category: form.category,
      label: form.label.trim(),
      description: form.description.trim(),
      condition: { type: form.conditionType, target: form.conditionTarget.trim(), count: form.conditionCount },
      rewards: { gold: form.gold, exp: form.exp, items },
      sortOrder: form.sortOrder,
      hidden: form.hidden,
    };
    setSaving(true);
    try {
      if (creating) {
        await achievementsApi.create({ id: form.id.trim(), ...payload });
        toastSuccess(`成就「${form.label}」已创建`);
      } else {
        await achievementsApi.update(form.id, payload);
        toastSuccess(`成就「${form.label}」已更新`);
      }
      setForm(null);
      setCreating(false);
      await load();
    } catch {
      /* 错误已由请求层统一提示（目标键不存在 / 重复 id / 奖励物品不存在都走这条） */
    } finally {
      setSaving(false);
    }
  };

  const remove = async (item: Achievement) => {
    if (!window.confirm(`确定删除成就「${item.label}」（${item.id}）？仍有玩家成就记录时会被拒绝。`)) return;
    try {
      await achievementsApi.remove(item.id);
      toastSuccess(`成就「${item.label}」已删除`);
      await load();
    } catch {
      /* 错误已由请求层统一提示 */
    }
  };

  const cumulative = form ? CUMULATIVE.has(form.conditionType) : false;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-50">成就配置</h1>
          <p className="mt-1 text-xs text-slate-500">
            seed 自客户端 <code>configs/achievement-data</code>，可动态增删。累计型（击杀 / 交付任务）的进度由事件流记账；
            状态型（等级 / 战力 / 持有物品）每次查询按角色当前状态现算 —— 改状态型的门槛会**立刻**改变所有人的达成状态。
          </p>
        </div>
        <Button
          disabled={!canWrite}
          onClick={() => {
            setCreating(true);
            setForm(emptyDraft());
          }}
        >
          新建成就
        </Button>
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">id / 名称</span>
            <Input
              value={draftFilter.keyword}
              placeholder="支持模糊匹配"
              onChange={(event) => setDraftFilter({ ...draftFilter, keyword: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
              }}
            />
          </div>
          <div className="w-[140px]">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">分类</span>
            <Select value={draftFilter.category} onChange={(event) => setDraftFilter({ ...draftFilter, category: event.target.value })}>
              <option value="">全部</option>
              <option value="battle">战斗</option>
              <option value="growth">成长</option>
              <option value="explore">探索</option>
            </Select>
          </div>
          <Button onClick={submitSearch}>查询</Button>
          <Button variant="outline" onClick={resetSearch}>
            重置
          </Button>
        </div>
      </Card>

      {form ? (
        <Card
          title={creating ? "新建成就" : `编辑成就：${form.id}`}
          description={
            cumulative
              ? "累计型条件：进度由事件流 +1 记账，改门槛只影响「还要再做多少次」。"
              : "状态型条件：进度按角色当前状态现算，改门槛会立刻改变所有人的达成状态。"
          }
          actions={saving ? <Spinner /> : null}
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="成就 id" hint={creating ? "语义串，如 ach_kill_10（创建后不可改）" : "主键，不可修改"}>
              <Input
                value={form.id}
                disabled={!creating}
                placeholder="ach_kill_10"
                onChange={(event) => setForm({ ...form, id: event.target.value })}
              />
            </Field>
            <Field label="分类">
              <Select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value as Category })}>
                <option value="battle">战斗</option>
                <option value="growth">成长</option>
                <option value="explore">探索</option>
              </Select>
            </Field>
            <Field label="名称">
              <Input value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} />
            </Field>
            <Field label="分类内顺序" hint="小的在前">
              <Input
                type="number"
                value={form.sortOrder}
                onChange={(event) => setForm({ ...form, sortOrder: Number(event.target.value) || 0 })}
              />
            </Field>
            <div className="md:col-span-2">
              <Field label="描述" hint="达成条件的人话说明（客户端成就墙显示）">
                <Input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
              </Field>
            </div>
            <Field label="条件类型">
              <Select
                value={form.conditionType}
                onChange={(event) => setForm({ ...form, conditionType: event.target.value as ConditionType })}
              >
                <option value="kill">累计击杀（事件）</option>
                <option value="quest">累计交付任务（事件）</option>
                <option value="level">等级达到（现算）</option>
                <option value="combat">战力达到（现算）</option>
                <option value="collect">持有物品（现算）</option>
              </Select>
            </Field>
            <Field
              label="条件目标"
              hint={
                form.conditionType === "kill"
                  ? "怪物 key，或 * 表示任意怪"
                  : form.conditionType === "collect"
                    ? "物品 id"
                    : "这两类不看目标，留空即可"
              }
            >
              <Input
                value={form.conditionTarget}
                onChange={(event) => setForm({ ...form, conditionTarget: event.target.value })}
              />
            </Field>
            <Field label="门槛值" hint={cumulative ? "需要累计多少次" : "需要达到多少"}>
              <Input
                type="number"
                value={form.conditionCount}
                onChange={(event) => setForm({ ...form, conditionCount: Number(event.target.value) || 1 })}
              />
            </Field>
            <Field label="未达成时隐藏" hint="客户端折叠、不剧透条件">
              <Select value={form.hidden ? "1" : "0"} onChange={(event) => setForm({ ...form, hidden: event.target.value === "1" })}>
                <option value="0">不隐藏</option>
                <option value="1">隐藏</option>
              </Select>
            </Field>
            <Field label="奖励金币">
              <Input type="number" value={form.gold} onChange={(event) => setForm({ ...form, gold: Number(event.target.value) || 0 })} />
            </Field>
            <Field label="奖励经验">
              <Input type="number" value={form.exp} onChange={(event) => setForm({ ...form, exp: Number(event.target.value) || 0 })} />
            </Field>
            <div className="md:col-span-2">
              <Field label="奖励物品" hint="格式：material_iron:2, material_gem:1（留空表示不给物品）">
                <Input value={form.itemsText} onChange={(event) => setForm({ ...form, itemsText: event.target.value })} />
              </Field>
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <Button disabled={saving || !canWrite} onClick={() => void save()}>
              保存
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setForm(null);
                setCreating(false);
              }}
            >
              取消
            </Button>
          </div>
        </Card>
      ) : null}

      <Card
        title="成就列表"
        actions={loading ? <Spinner /> : null}
        description={canWrite ? undefined : "当前角色没有「修改养成配置」权限，列表只读。"}
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>id</th>
                <th className={thClass}>分类</th>
                <th className={thClass}>名称 / 描述</th>
                <th className={thClass}>条件</th>
                <th className={thClass}>奖励</th>
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data?.list.map((item) => (
                <tr key={item.id} className="transition hover:bg-slate-800/30">
                  <td className={`${tdClass} font-mono text-xs text-slate-400`}>{item.id}</td>
                  <td className={tdClass}>
                    <Badge tone="slate">{CATEGORY_LABELS[item.category] ?? item.category}</Badge>
                  </td>
                  <td className={tdClass}>
                    <span className="block font-medium text-slate-100">
                      {item.label}
                      {item.hidden ? <span className="ml-1 text-xs text-amber-400/80">（隐藏）</span> : null}
                    </span>
                    <span className="mt-0.5 block max-w-[260px] truncate text-xs text-slate-500" title={item.description}>
                      {item.description}
                    </span>
                  </td>
                  <td className={tdClass}>
                    <span className="block text-xs text-slate-300">{conditionSummary(item)}</span>
                    <span className="mt-0.5 block text-[11px] text-slate-500">
                      {CUMULATIVE.has(item.condition.type) ? "事件记账" : "查询现算"}
                    </span>
                  </td>
                  <td className={`${tdClass} text-xs text-slate-400`}>
                    {item.rewards.gold} 金 / {item.rewards.exp} 经验
                    {item.rewards.items.length > 0 ? ` / ${item.rewards.items.length} 件物品` : ""}
                  </td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{formatTime(item.updatedAt)}</td>
                  <td className={`${tdClass} text-right`}>
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        className="px-2.5 py-1 text-xs"
                        disabled={!canWrite}
                        onClick={() => {
                          setCreating(false);
                          setForm(toDraft(item));
                        }}
                      >
                        编辑
                      </Button>
                      <Button
                        variant="outline"
                        className="px-2.5 py-1 text-xs"
                        disabled={!canWrite}
                        onClick={() => void remove(item)}
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

        {!loading && data && data.list.length === 0 ? (
          <EmptyState title="没有匹配的成就" description="换个筛选条件，或新建一条" />
        ) : null}

        <Pagination page={page} size={size} total={data?.total ?? 0} onChange={setPage} onSizeChange={handleSizeChange} />
      </Card>
    </div>
  );
}
