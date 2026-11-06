import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { dropApi, formatTime, MONSTER_TIER_LABELS, monsterIcon, monstersApi, PERMISSION, skillsApi } from "../api";
import type { AdminMonster, DropTable, Monster, MonsterAttributes, PageResult, Skill, UpdateMonster } from "../api";
import { AttributesGrid, crossedRangeKeys } from "../components/AttributesEditor";
import { GameIcon } from "../components/GameImage";
import { Modal } from "../components/Modal";
import { Pagination } from "../components/Pagination";
import { Badge, Button, Card, EmptyState, Field, Input, Notice, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { MonsterDropDialog } from "../components/drop/MonsterDropDialog";
import { DROP_SOURCE_LABELS, DROP_SOURCE_TONE, dropSummaryText } from "../components/drop/DropEditors";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";
import { PageHeader } from "../components/PageHeader";

/**
 * 定位中文名：与选择器分组共用一份（`api/gameData` 的 `MONSTER_TIER_LABELS`）
 *
 * 再声明成 `Record<string, string>` 是因为接口里的 `tier` 是 `string` ——
 * 直接拿种子那个强类型常量索引会 TS7053（键可能是任何字符串，得先收窄）。
 */
const TIER_LABELS: Record<string, string> = MONSTER_TIER_LABELS;
const TIER_OPTIONS = Object.entries(TIER_LABELS);

/** 属性摘要（列表列太窄，只报几个关键数；完整数值在编辑弹窗里） */
function attributeSummary(item: Monster): string {
  const a = item.attributes;
  return `生命 ${item.maxHp} · 物攻 ${a.physicalAttack.min}~${a.physicalAttack.max} · 物防 ${a.physicalDefense.min}~${a.physicalDefense.max}`;
}

/**
 * 可以覆盖播放速度的动作（#751）
 *
 * 与服务端 `MONSTER_ACTION_KEYS` / 客户端 `monsterActionSpecs` 逐字一致：怪物素材只有这五个
 * 动作有帧，其余动作（攻击 / 技能 / 测试动作）播放时回退待机 —— 所以界面只给这五个输入框。
 */
const ACTION_SPEED_KEYS: { key: string; label: string }[] = [
  { key: "stand", label: "待机" },
  { key: "walk", label: "行走" },
  { key: "run", label: "奔跑" },
  { key: "injured", label: "受击" },
  { key: "die", label: "死亡" },
];

/** 动作速度覆盖的合法区间（与服务端 MONSTER_SPEED_RATE_MIN/MAX 同一口径） */
const SPEED_RATE_MIN = 0.1;
const SPEED_RATE_MAX = 10;

/** 弹窗里的一节（基础 / 行为 / 资源）：分隔线 + 标题 + 一句限定说明 */
function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="mt-4 border-t border-slate-800 pt-4 first:mt-0 first:border-0 first:pt-0">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <span className="text-xs font-semibold tracking-wide text-slate-200">{title}</span>
        {note ? <span className="text-xs text-slate-500">{note}</span> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * 怪物编辑弹窗（#258 / #751）
 *
 * 一张怪的数据分两处，**弹窗里都摆出来**：
 * - `monsters`（基础）：名称 / 定位 / 等级 / 生命上限 / 六项攻防 —— 属性**整份提交、整份替换**；
 * - `monster_presentation`（行为）：主动攻击 / 检测范围 / 移动速度 / 动作速度覆盖；
 * - 同一张表里的**几何**（icon / out / 偏移 / 身体尺寸）是素材实测值，只读展示 ——
 *   改了图就对不上，只能重跑 `client/tools/gen-monster-config.cjs`。
 *
 * 生效时间三档写进 hint：基础数值即时、行为参数 ≤1 秒（AI 缓存 TTL）、画面表现要重进地图。
 * 校验分工：区间交叉 / 数值区间在这里做即时提示，权威在服务端（DTO 校验 + 40000 / 50019 / 50038）。
 */
function MonsterEditDialog({
  open,
  initial,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  initial: AdminMonster | null;
  onCancel: () => void;
  onSubmit: (value: UpdateMonster) => Promise<boolean>;
}) {
  const [label, setLabel] = useState("");
  const [tier, setTier] = useState<string>("normal");
  const [level, setLevel] = useState("1");
  const [maxHp, setMaxHp] = useState("1");
  const [attributes, setAttributes] = useState<MonsterAttributes | null>(null);
  const [aggressive, setAggressive] = useState(false);
  const [detectRange, setDetectRange] = useState("0");
  const [moveSpeed, setMoveSpeed] = useState("0");
  /** 动作键 → 输入框里的字符串（空串 = 不覆盖，用客户端默认） */
  const [speedRates, setSpeedRates] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLabel(initial?.label ?? "");
    setTier(initial?.tier ?? "normal");
    setLevel(initial ? String(initial.level) : "1");
    setMaxHp(initial ? String(initial.maxHp) : "1");
    setAttributes(initial?.attributes ? { ...initial.attributes } : null);
    const presentation = initial?.presentation ?? null;
    setAggressive(presentation?.aggressive ?? false);
    setDetectRange(String(presentation?.detectRange ?? 0));
    setMoveSpeed(String(presentation?.moveSpeed ?? 0));
    const rates: Record<string, string> = {};
    for (const { key } of ACTION_SPEED_KEYS) {
      const value = presentation?.speedRate?.[key];
      rates[key] = typeof value === "number" ? String(value) : "";
    }
    setSpeedRates(rates);
    setSubmitting(false);
  }, [open, initial]);

  /** 区间交叉（min > max）的键集合；空 = 合法 */
  const crossedKeys = useMemo(() => (attributes ? crossedRangeKeys(attributes) : []), [attributes]);

  if (!open || !attributes || !initial) return null;

  /** 表现行缺失 = 这只怪还没量过素材：行为参数没有落点（服务端 50038），整段禁用 */
  const presentation = initial.presentation;
  const behaviorEditable = presentation !== null;

  const levelValid = Number.isInteger(Number(level)) && Number(level) >= 1;
  const maxHpValid = Number.isInteger(Number(maxHp)) && Number(maxHp) >= 1;
  const detectValid = /^\d+$/.test(detectRange.trim());
  const moveValid = Number.isFinite(Number(moveSpeed)) && Number(moveSpeed) >= 0;
  const rateProblems = ACTION_SPEED_KEYS.filter(({ key }) => {
    const raw = (speedRates[key] ?? "").trim();
    if (raw === "") return false;
    const value = Number(raw);
    return !Number.isFinite(value) || value < SPEED_RATE_MIN || value > SPEED_RATE_MAX;
  }).map(({ label: actionLabel }) => actionLabel);

  const canSubmit =
    label.trim().length > 0 &&
    levelValid &&
    maxHpValid &&
    crossedKeys.length === 0 &&
    (!behaviorEditable || (detectValid && moveValid && rateProblems.length === 0)) &&
    !submitting;

  const submit = async () => {
    setSubmitting(true);
    /** 只把填了的动作写进覆盖表；一个都没填 = 空对象 = 清空回客户端默认 */
    const speedRate: Record<string, number> = {};
    for (const { key } of ACTION_SPEED_KEYS) {
      const raw = (speedRates[key] ?? "").trim();
      if (raw !== "") speedRate[key] = Number(raw);
    }
    const value: UpdateMonster = {
      label: label.trim(),
      tier,
      level: Number(level),
      maxHp: Number(maxHp),
      attributes,
    };
    if (behaviorEditable) {
      value.presentation = {
        aggressive,
        detectRange: Number(detectRange),
        moveSpeed: Number(moveSpeed),
        speedRate,
      };
    }
    await onSubmit(value);
    setSubmitting(false);
  };

  return (
    <Modal
      open
      title={<>编辑怪物 · {initial.id}</>}
      hint={
        <>
          三档生效时间：<span className="text-slate-300">基础数值即时</span>（世界播种与伤害结算直读库，
          已活着的实例血量上限沿用出生值、重生后生效）· <span className="text-slate-300">行为参数 ≤1 秒</span>
          （实时进程的 AI 缓存）· <span className="text-slate-300">画面表现要重进地图</span>（客户端重拉快照）。
        </>
      }
      size="lg"
      onClose={onCancel}
      footer={
        <>
          <Button variant="outline" disabled={submitting} onClick={onCancel}>
            取消
          </Button>
          <Button disabled={!canSubmit} loading={submitting} onClick={() => void submit()}>
            保存修改
          </Button>
        </>
      }
    >
      <Section title="基础数值" note="改完即时生效">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label="名称" width="col-span-2">
            <Input value={label} onChange={(event) => setLabel(event.target.value)} />
          </Field>
          <Field label="定位" hint="不重算数值">
            <Select value={tier} onChange={(event) => setTier(event.target.value)}>
              {TIER_OPTIONS.map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="等级" hint="显示用元数据">
            <Input type="number" min={1} value={level} onChange={(event) => setLevel(event.target.value)} />
          </Field>
          <Field label="生命上限" width="col-span-2">
            <Input type="number" min={1} value={maxHp} onChange={(event) => setMaxHp(event.target.value)} />
          </Field>
        </div>
        <div className="mt-4">
          <AttributesGrid
            attributes={attributes}
            onChange={setAttributes}
            header="六项攻防区间（整份替换）"
            crossed={crossedKeys}
          />
        </div>
        <p className="mt-2 text-xs text-slate-500">
          改定位不重算已展开的血量 / 攻防，但会改变 BOSS 判定（击杀 BOSS 才发的邮件）；掉落看「掉落」弹窗，不随定位变。
        </p>
      </Section>

      <Section title="行为参数" note="服务端 AI ≤1 秒生效；画面表现要客户端重进地图">
        {behaviorEditable ? (
          <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
            <label className="flex items-center gap-2 text-xs text-slate-200">
              <input
                type="checkbox"
                className="h-4 w-4 accent-indigo-500"
                checked={aggressive}
                onChange={(event) => setAggressive(event.target.checked)}
              />
              主动攻击玩家（关掉后只游走，被打才记恨）
            </label>
            <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="检测范围" hint="像素半径；主动怪在这个距离内发现玩家">
                <Input
                  type="number"
                  min={0}
                  value={detectRange}
                  onChange={(event) => setDetectRange(event.target.value)}
                />
              </Field>
              <Field label="移动速度" hint="刚体线速度单位；出厂 2，与角色步行同口径">
                <Input
                  type="number"
                  min={0}
                  step={0.1}
                  value={moveSpeed}
                  onChange={(event) => setMoveSpeed(event.target.value)}
                />
              </Field>
            </div>
            <div className="mt-3">
              <span className="mb-1 block text-xs font-medium text-slate-400">
                动作速度覆盖（每秒循环数，留空 = 用客户端默认）
              </span>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                {ACTION_SPEED_KEYS.map(({ key, label: actionLabel }) => (
                  <Field key={key} label={actionLabel} hint={key}>
                    <Input
                      type="number"
                      min={SPEED_RATE_MIN}
                      max={SPEED_RATE_MAX}
                      step={0.1}
                      placeholder="默认"
                      aria-label={`${actionLabel}速度`}
                      value={speedRates[key] ?? ""}
                      onChange={(event) => setSpeedRates({ ...speedRates, [key]: event.target.value })}
                    />
                  </Field>
                ))}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                只有这五个动作有帧；攻击 / 技能动作在素材里没有帧，播放时回退待机，所以不给入口。
              </p>
            </div>
          </div>
        ) : (
          <Notice tone="amber" title="这只怪还没有资源表现行">
            行为参数存在 `monster_presentation` 表里，行由几何生成器按图集建。先跑
            <code className="mx-1 text-slate-200">node client/tools/gen-monster-config.cjs</code>
            把几何量出来，再回来改行为。
          </Notice>
        )}
      </Section>

      <Section title="资源与几何（只读）" note="素材实测值，改了图要重跑几何生成器">
        {presentation ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-xl border border-slate-800 bg-slate-950/40 p-3 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-slate-500">图标</dt>
              <dd className="break-all font-mono text-slate-300">{presentation.icon}</dd>
            </div>
            <div>
              <dt className="text-slate-500">外观图集</dt>
              <dd className="break-all font-mono text-slate-300">{presentation.out}</dd>
            </div>
            <div>
              <dt className="text-slate-500">摆放偏移</dt>
              <dd className="font-mono text-slate-300">
                {presentation.outOffset.x}, {presentation.outOffset.y}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">身体尺寸</dt>
              <dd className="font-mono text-slate-300">
                {presentation.contentSize.width} × {presentation.contentSize.height}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-500">
            没有资源表现行（地图上这只怪会画不出来，直到跑几何生成器）。
          </p>
        )}
      </Section>

      {!levelValid || !maxHpValid ? (
        <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          等级与生命上限需为 ≥1 的整数。
        </p>
      ) : null}
      {behaviorEditable && !detectValid ? (
        <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          检测范围需为 ≥0 的整数（像素半径）。
        </p>
      ) : null}
      {behaviorEditable && !moveValid ? (
        <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          移动速度需为 ≥0 的数字。
        </p>
      ) : null}
      {behaviorEditable && rateProblems.length > 0 ? (
        <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          动作速度需在 {SPEED_RATE_MIN}~{SPEED_RATE_MAX} 之间：{rateProblems.join(" / ")}。
        </p>
      ) : null}
    </Modal>
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
    <Modal
      open
      title={<>技能挂载 · {monster.label}</>}
      hint={<>服务端 AI 先用状态型（强化自身），再用伤害型；同类型内按优先级升序，同优先级按技能 id。
          冷却留空 = 用技能自身的冷却。整份保存，删行等于解绑。</>}
      size="md"
      onClose={onClose}
      footer={<>
        <Button variant="outline" disabled={saving} onClick={onClose}>
          取消
        </Button>
        <Button disabled={loading || saving || problems.length > 0} loading={saving} onClick={() => void save()}>
          保存挂载
        </Button>
      </>}
    >
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
                  <div className="w-16">
                    <Input
                      aria-label={`${row.skillId} 优先级`}
                      value={row.priority}
                      onChange={(event) => setRows(rows.map((entry, i) => (i === index ? { ...entry, priority: event.target.value } : entry)))}
                    />
                  </div>
                </label>
                <label className="flex items-center gap-1 text-xs text-slate-400">
                  冷却
                  <div className="w-20">
                    <Input
                      placeholder="跟技能"
                      aria-label={`${row.skillId} 冷却`}
                      value={row.cooldown}
                      onChange={(event) => setRows(rows.map((entry, i) => (i === index ? { ...entry, cooldown: event.target.value } : entry)))}
                    />
                  </div>
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
            <Field width="w-56" label="添加技能">
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
              </Field>
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
    </Modal>
  );
}

/**
 * 怪物配置管理（#258 / #751）
 *
 * key 清单固定（被地图刷怪点 / 掉落表 / 技能引用，启动时 seed 落库）——
 * **没有「新建」「删除」**，只有「编辑」。按关键字 / 定位筛选。
 * 一张怪的数据分两处：`monsters`（数值 / 定位 / 名称，改完即时生效）与
 * `monster_presentation`（几何只读 + 行为可改，服务端 AI ≤1 秒生效）；两段都在编辑弹窗里。
 * 技能挂载（#372）与每怪掉落（#584）各一个弹窗，都是整份替换 —— 掉落在这一页就能改，
 * 不需要再去「掉落配置」页对着 key 找同一只怪。
 * 写操作要 `gameConfig:write`。
 */
export function MonstersPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [draft, setDraft] = useState({ keyword: "", tier: "" });
  const [query, setQuery] = useState({ keyword: "", tier: "" });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [data, setData] = useState<PageResult<AdminMonster> | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AdminMonster | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  /** 技能挂载弹窗的目标怪（= null 表示关闭） */
  const [skillTarget, setSkillTarget] = useState<AdminMonster | null>(null);
  /** 掉落弹窗的目标怪（= null 表示关闭） */
  const [dropTarget, setDropTarget] = useState<AdminMonster | null>(null);
  /** 具名掉落表（只为把摘要里的 tableId 写成「common · 12 条」） */
  const [tables, setTables] = useState<DropTable[]>([]);
  const tablesById = useMemo(() => new Map(tables.map((table) => [table.id, table])), [tables]);

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

  /** 具名表清单：摘要里要显示「表 id + 条目数」，失败不影响怪物列表（摘要退化成只写表 id） */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await dropApi.listTables();
        if (alive) setTables(list.list);
      } catch {
        /* 错误已由请求层统一提示 */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

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
  const submitDialog = async (value: UpdateMonster): Promise<boolean> => {
    if (!editing) return false;
    try {
      await monstersApi.update(editing.id, value);
      toastSuccess(`怪物「${value.label ?? editing.label}」已更新`);
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
        title="怪物配置"
        description={<>key 清单固定（被地图刷怪点 / 掉落表 / 技能引用），只可编辑、不可新增 / 删除。
            数值与定位改完即时生效；<span className="text-slate-300">是否主动攻击 / 检测范围 / 移动速度 / 动作速度</span>
            也在编辑弹窗里（服务端 AI ≤1 秒生效，画面表现要重进地图）。资源几何是素材实测值，只读。<span className="text-slate-300">死后掉什么就在这一页改</span>（
            引用具名表 / 内联条目池 / 清空走兜底，三选一，服务端抽表并入包）。</>}
      />

      <Card>
        <div className="flex flex-wrap items-end gap-2">
          <Field width="w-56" label="key / 名称">
              <Input
                value={draft.keyword}
                placeholder="支持模糊匹配"
                onChange={(event) => setDraft({ ...draft, keyword: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submitSearch();
                }}
              />
            </Field>
          <Field width="w-32" label="定位">
              <Select value={draft.tier} onChange={(event) => setDraft({ ...draft, tier: event.target.value })}>
                <option value="">全部</option>
                {TIER_OPTIONS.map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
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
        title="怪物列表"
        actions={loading ? <Spinner /> : null}
        description={canWrite ? undefined : "当前角色没有「修改养成配置」权限，列表只读。"}
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>图</th>
                <th className={thClass}>key</th>
                <th className={thClass}>名称</th>
                <th className={thClass}>定位</th>
                <th className={thClass}>等级</th>
                <th className={thClass}>生命</th>
                <th className={thClass}>属性摘要</th>
                <th className={thClass}>掉落</th>
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data?.list.map((item) => (
                <tr key={item.id} className="transition hover:bg-slate-800/30">
                  <td className={tdClass}>
                    <GameIcon path={monsterIcon(item.id)} alt={item.label} />
                  </td>
                  <td className={`${tdClass} font-mono text-xs text-slate-300`}>{item.id}</td>
                  <td className={`${tdClass} font-medium text-slate-100`}>{item.label}</td>
                  <td className={tdClass}>
                    <div className="flex items-center gap-1.5 whitespace-nowrap">
                      <Badge tone={item.tier === "boss" ? "red" : item.tier === "elite" ? "amber" : "slate"}>
                        {TIER_LABELS[item.tier] ?? item.tier}
                      </Badge>
                      {item.presentation ? (
                        <Badge tone={item.presentation.aggressive ? "red" : "slate"}>
                          {item.presentation.aggressive ? "主动" : "被动"}
                        </Badge>
                      ) : (
                        <span className="text-xs text-slate-500">无表现行</span>
                      )}
                    </div>
                  </td>
                  <td className={tdClass}>{item.level}</td>
                  <td className={tdClass}>{item.maxHp}</td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{attributeSummary(item)}</td>
                  <td className={tdClass}>
                    <div className="flex items-center gap-1.5 whitespace-nowrap">
                      <Badge tone={DROP_SOURCE_TONE[item.drop?.source ?? "none"] ?? "slate"}>
                        {DROP_SOURCE_LABELS[item.drop?.source ?? "none"] ?? "兜底"}
                      </Badge>
                      <span className="text-xs text-slate-400">{dropSummaryText(item.drop, tablesById)}</span>
                    </div>
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
                          setDialogOpen(true);
                        }}
                      >
                        编辑
                      </Button>
                      <Button variant="outline" className="px-2.5 py-1 text-xs" onClick={() => setSkillTarget(item)}>
                        技能
                      </Button>
                      <Button variant="outline" className="px-2.5 py-1 text-xs" onClick={() => setDropTarget(item)}>
                        掉落
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

      <MonsterDropDialog
        monsterKey={dropTarget?.id ?? null}
        monsterLabel={dropTarget?.label}
        onClose={() => setDropTarget(null)}
        onSaved={() => {
          setDropTarget(null);
          // 列表里的摘要要跟着变，所以保存后重拉这一页
          void load();
        }}
      />
    </div>
  );
}
