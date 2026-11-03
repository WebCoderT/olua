import { useCallback, useEffect, useMemo, useState } from "react";
import { formatTime, guideStepsApi, PERMISSION } from "../api";
import type { GuideStep, GuideSteps, UpdateGuideSteps } from "../api";
import { Button, Card, Field, Input, Select, Spinner } from "../components/ui";
import { PageHeader } from "../components/PageHeader";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/**
 * 新手引导步骤（#605）
 *
 * 引导的**推进逻辑**在客户端（走几步存在角色存档里），服务端只存这张表。这一页改的是
 * 「新玩家的第一屏体验」：几步、按什么顺序、每步说什么、高亮哪里、什么动作算过。
 *
 * ## 整份保存，不是逐行保存
 * 步骤表是**有序的一小张表**（出厂 6 步、上限 64 步），顺序本身就是要改的内容之一 ——
 * 逐行保存会让「上移 / 下移」变成多次请求且中间态可被别人看见。整份 PATCH 一次落库，
 * 要么全对要么不动（服务端任何一步不合法就 40000 且整份不落库）。
 *
 * ## id 是给日志与单测用的
 * 玩家存档里只存「走到第几步」，不存 id —— 所以**可以**改 id，但改了之后日志里的历史
 * 就对不上了。文案随便改，id 只在真的重构步骤时才动。
 *
 * ## 生效时机
 * 玩家下次进游戏拉配置快照（`guideSteps` 段）时整表替换。已经在引导里的玩家进度不受
 * 影响：他接着走同一下标的那一步（所以**在中间插一步**等于把后面所有人的进度往后推一格）。
 */
export function GuideStepsPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [saved, setSaved] = useState<GuideSteps | null>(null);
  const [draft, setDraft] = useState<DraftRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await guideStepsApi.get();
      setSaved(data);
      setDraft(data.steps.map(toDraft));
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setField = (index: number, key: keyof DraftRow, value: string) => {
    setDraft((current) => (current ? current.map((row, i) => (i === index ? { ...row, [key]: value } : row)) : current));
  };

  const move = (index: number, delta: number) => {
    setDraft((current) => {
      if (!current) return current;
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = current.slice();
      const [row] = next.splice(index, 1);
      next.splice(target, 0, row);
      return next;
    });
  };

  const remove = (index: number) => {
    setDraft((current) => (current ? current.filter((_, i) => i !== index) : current));
  };

  const append = () => {
    setDraft((current) => {
      const rows = current ?? [];
      if (rows.length >= STEP_MAX) return rows;
      // 新行的 id 先给个不撞的兜底值，运营想改就改（id 只进日志与单测）
      let index = rows.length + 1;
      while (rows.some((row) => row.id === `step${index}`)) index += 1;
      return [
        ...rows,
        { id: `step${index}`, title: "", desc: "", spot: GUIDE_SPOTS[0].value, trigger: GUIDE_EVENTS[0].value },
      ];
    });
  };

  /** 逐行体检：空白 / id 重复 / id 格式 —— 服务端也会拒，但先在这里把按钮拦住 */
  const invalid = useMemo(() => describeInvalid(draft), [draft]);

  const save = async () => {
    if (!draft) return;
    const payload = buildPayload(draft);
    if (!payload) return;
    setSaving(true);
    try {
      const data = await guideStepsApi.update(payload);
      setSaved(data);
      setDraft(data.steps.map(toDraft));
      toastSuccess("引导步骤已保存（玩家下次进游戏拉配置后生效）");
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="新手引导"
        description={
          <>
            这张表以前写在客户端源码里（改一句文案要重打客户端包）。现在运营可改：几步、顺序、文案、高亮哪里、
            什么动作算过。玩家下次进游戏拉配置时整表替换；<b>引导进度不受影响</b>
            （存档里存的是「走到第几步」，所以在中间插一步会把后面所有人的进度往后推一格）。
            {saved ? <span className="ml-1 text-slate-500">上次修改：{formatTime(saved.updatedAt)}</span> : null}
          </>
        }
      />

      <Card
        title={`步骤表${draft ? `（${draft.length} 步）` : ""}`}
        actions={
          loading ? (
            <Spinner />
          ) : canWrite ? (
            <div className="flex items-center gap-2">
              <Button variant="ghost" disabled={!draft || saving || (draft?.length ?? 0) >= STEP_MAX} onClick={append}>
                添加一步
              </Button>
              <Button disabled={!draft || saving || invalid !== null} loading={saving} onClick={() => void save()}>
                保存步骤表
              </Button>
            </div>
          ) : null
        }
        description={
          canWrite
            ? `顺序即体验顺序（上限 ${STEP_MAX} 步）。高亮位与推进事件是客户端能力的白名单：新增一种高亮目标或一种推进事件都要改客户端，所以只能从这两组里选。`
            : "当前角色没有「修改养成配置」权限，本页只读。"
        }
      >
        {draft ? (
          <div className="flex flex-col gap-3">
            {invalid ? <p className="text-xs text-amber-400">{invalid}</p> : null}
            {draft.length === 0 ? <p className="text-sm text-slate-400">还没有步骤。点右上角「添加一步」开始。</p> : null}
            {draft.map((row, index) => (
              <div key={`${row.id}-${index}`} className="rounded border border-slate-700/60 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-300">第 {index + 1} 步</span>
                  {canWrite ? (
                    <div className="flex items-center gap-2">
                      <Button variant="ghost" disabled={index === 0} onClick={() => move(index, -1)}>
                        上移
                      </Button>
                      <Button variant="ghost" disabled={index === draft.length - 1} onClick={() => move(index, 1)}>
                        下移
                      </Button>
                      <Button variant="ghost" onClick={() => remove(index)}>
                        删除
                      </Button>
                    </div>
                  ) : null}
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label="标识" hint="小写字母开头，只含字母数字；日志与单测用它">
                    <Input value={row.id} disabled={!canWrite} onChange={(event) => setField(index, "id", event.target.value)} />
                  </Field>
                  <Field label="标题" hint="气泡第一行">
                    <Input value={row.title} disabled={!canWrite} onChange={(event) => setField(index, "title", event.target.value)} />
                  </Field>
                  <Field label="高亮目标" hint="取不到节点时只显示气泡">
                    <Select value={row.spot} disabled={!canWrite} onChange={(event) => setField(index, "spot", event.target.value)}>
                      {GUIDE_SPOTS.map((spot) => (
                        <option key={spot.value} value={spot.value}>
                          {spot.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="推进事件" hint="当前步收到它才前进，别的事件不越级">
                    <Select value={row.trigger} disabled={!canWrite} onChange={(event) => setField(index, "trigger", event.target.value)}>
                      {GUIDE_EVENTS.map((event) => (
                        <option key={event.value} value={event.value}>
                          {event.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <div className="sm:col-span-2 lg:col-span-2">
                    <Field label="正文" hint="一句话说清做什么">
                      <Input value={row.desc} disabled={!canWrite} onChange={(event) => setField(index, "desc", event.target.value)} />
                    </Field>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </Card>
    </div>
  );
}

//#region 字段描述与白名单

/** 步数上限（与服务端 `shared/guide-seed.GUIDE_STEP_MAX` 一致） */
const STEP_MAX = 64;

/** 高亮语义位（与客户端 `types/guide.GUIDE_SPOT` 逐值一致；标签是给人看的） */
const GUIDE_SPOTS: { value: string; label: string }[] = [
  { value: "joystick", label: "左下角摇杆" },
  { value: "nav:bag", label: "底部栏 · 背包" },
  { value: "nav:skill", label: "底部栏 · 技能" },
  { value: "nav:chat", label: "底部栏 · 聊天" },
  { value: "shortcut", label: "技能快捷栏" },
];

/** 推进事件（与客户端 `types/guide.GUIDE_EVENT` 逐值一致） */
const GUIDE_EVENTS: { value: string; label: string }[] = [
  { value: "move", label: "走动（累计位移超阈值）" },
  { value: "kill", label: "击杀怪物" },
  { value: "pickup", label: "拾取掉落" },
  { value: "openBag", label: "打开背包" },
  { value: "openSkill", label: "打开技能列表" },
  { value: "openChat", label: "打开聊天" },
];

//#endregion

//#region 草稿 ↔ 提交体

type DraftRow = { id: string; title: string; desc: string; spot: string; trigger: string };

function toDraft(step: GuideStep): DraftRow {
  return { id: step.id, title: step.title, desc: step.desc, spot: step.spot, trigger: step.trigger };
}

/** 返回第一条问题（null = 没问题）。服务端也会校验，这里只是让按钮先别让人白点 */
function describeInvalid(draft: DraftRow[] | null): string | null {
  if (!draft) return null;
  if (draft.length === 0) return "至少保留一步（想关掉引导是让玩家走完，而不是清空配置）。";
  if (draft.length > STEP_MAX) return `最多 ${STEP_MAX} 步（当前 ${draft.length} 步）。`;
  const seen = new Set<string>();
  for (const [index, row] of draft.entries()) {
    if (!row.id.trim()) return `第 ${index + 1} 步没有标识。`;
    if (!/^[a-z][a-zA-Z0-9]{0,31}$/.test(row.id)) return `第 ${index + 1} 步的标识要以小写字母开头、只含字母数字、最长 32 字符。`;
    if (seen.has(row.id)) return `第 ${index + 1} 步的标识「${row.id}」与前面重复了。`;
    seen.add(row.id);
    if (!row.title.trim()) return `第 ${index + 1} 步没有标题。`;
    if (row.title.length > 20) return `第 ${index + 1} 步的标题超过 20 字。`;
    if (!row.desc.trim()) return `第 ${index + 1} 步没有正文。`;
    if (row.desc.length > 200) return `第 ${index + 1} 步的正文超过 200 字。`;
  }
  return null;
}

/**
 * 草稿 → 提交体
 *
 * **逐字段显式列**而不是把草稿对象直接传出去：多带一个键会被服务端的白名单静默剥掉，
 * 结果就是「保存成功但没生效」。显式列出来，拼错在类型层就红。
 */
function buildPayload(draft: DraftRow[]): UpdateGuideSteps | null {
  // 草稿里 spot / trigger 是普通字符串（下拉框的值），提交时收窄到生成物里的联合类型 ——
  // 选项本来就是从白名单渲染出来的，走不到别的值
  const steps: GuideStep[] = draft.map((row) => ({
    id: row.id,
    title: row.title,
    desc: row.desc,
    spot: row.spot as GuideStep["spot"],
    trigger: row.trigger as GuideStep["trigger"],
  }));
  return { steps };
}

//#endregion
