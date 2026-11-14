import { useCallback, useEffect, useRef, useState } from "react";
import { PERMISSION, uiEffectsApi } from "../api";
import type { UiEffect } from "../api";
import { PageHeader } from "../components/PageHeader";
import { Button, Card, Field, Input, Select } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";
import type { Atlas } from "./equipAlign/atlas";
import {
  drawPreview,
  effectAtlasPath,
  effectFrameNames,
  loadPreviewAtlases,
  previewKindOf,
  previewSizeOf,
  roleAtlasPath,
} from "./uiEffects/preview";

/**
 * 特效 key → 页面展示名（key 的唯一来源在服务端 UI_EFFECT_KEYS；新特效登记后这里补一行中文名）
 *
 * 掉落光效六个 key 共用一个页签，档位在页签内用下拉框选（#634）：六张图集是六份美术，
 * 但「同一件事的六个档」，并排七个页签反而把升级特效挤没了。
 * 1~5 号按装备前缀强度升序（普通的 → 超神的），6 号留给特殊装备（`configs/light` 的自定义表）。
 */
const EFFECT_LABELS: Record<string, string> = {
  upgrade: "升级特效",
  "light-1": "掉落光效 1 号",
  "light-2": "掉落光效 2 号",
  "light-3": "掉落光效 3 号",
  "light-4": "掉落光效 4 号",
  "light-5": "掉落光效 5 号",
  "light-6": "掉落光效 6 号（预留）",
};

/** 页签（一族一个）：掉落光效六档不各占一个页签，档位在页内容里选 */
type EffectTab = "upgrade" | "drop";

/** 页签展示名与顺序（升级特效在前 —— 它是这个页面最初的用户） */
const TAB_ORDER: EffectTab[] = ["upgrade", "drop"];
const TAB_LABELS: Record<EffectTab, string> = { upgrade: "升级特效", drop: "掉落光效" };

/** key 归哪个页签（判据与预览参考层同一条：掉落光效 = `light-*`） */
const tabOf = (key: string): EffectTab => (previewKindOf(key) === "dropItem" ? "drop" : "upgrade");

const PREVIEW_PREFS_KEY = "olua.uiEffects.prefs.v1";

/** 表单状态（全部字符串，保存时统一转数字 —— 与服务端 DTO 的边界一起校验） */
interface EffectForm {
  offsetX: string;
  offsetY: string;
  scaleX: string;
  scaleY: string;
  rotate: string;
  durationMs: string;
  enabled: boolean;
}

const formOf = (row: UiEffect): EffectForm => ({
  offsetX: String(row.offsetX),
  offsetY: String(row.offsetY),
  scaleX: String(row.scaleX),
  scaleY: String(row.scaleY),
  rotate: String(row.rotate),
  durationMs: String(row.durationMs),
  enabled: row.enabled,
});

/** 编辑过的字段是否与库里不一致（有差异就点亮「未保存」并放行保存按钮） */
const isDirty = (form: EffectForm, row: UiEffect) =>
  form.offsetX.trim() !== String(row.offsetX) ||
  form.offsetY.trim() !== String(row.offsetY) ||
  form.scaleX.trim() !== String(row.scaleX) ||
  form.scaleY.trim() !== String(row.scaleY) ||
  form.rotate.trim() !== String(row.rotate) ||
  form.durationMs.trim() !== String(row.durationMs) ||
  form.enabled !== row.enabled;

/** 读资源根偏好（与装备对齐工作台同一个默认值；改了存本地，下次进来还在） */
function readResRoot(): string {
  try {
    const raw = localStorage.getItem(PREVIEW_PREFS_KEY);
    const parsed = raw ? (JSON.parse(raw) as { resRoot?: string }) : null;
    return parsed?.resRoot?.trim() || "/game-resources";
  } catch {
    return "/game-resources";
  }
}

/**
 * 特效预览画布：参考层按族取（升级特效 = 裸模正面站立第一帧；掉落光效 = 掉落物图标 40×40），
 * 特效按表单当前值叠放并逐帧播放
 *
 * 素材经 `resRoot` 读（同装备对齐工作台）：裸模 = `role/boy/stand/stand` 的正面第一帧，
 * 特效 = `upgrade` 的 `effect/<key>/<key>`、掉落光效的 `effect/light/<key>`。读不到素材就给一句
 * 人话提示，不渲染半个残影（掉落光效的图标是画出来的占位框，没有素材依赖）。
 */
function EffectPreview({
  resRoot,
  effectKey,
  form,
}: {
  resRoot: string;
  effectKey: string;
  form: EffectForm;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const kind = previewKindOf(effectKey);
  const size = previewSizeOf(effectKey);
  const [state, setState] = useState<
    | { phase: "loading" }
    | { phase: "ready"; role: Atlas | null; effect: Atlas | null; frameNames: string[] }
    | { phase: "error"; message: string }
  >({ phase: "loading" });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });
    loadPreviewAtlases(resRoot, effectKey)
      .then(({ role, effect }) => {
        if (cancelled) return;
        const frameNames = effectFrameNames(effect);
        setState({ phase: "ready", role, effect, frameNames });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const sources = [kind === "role" ? roleAtlasPath() : null, effectAtlasPath(effectKey)].filter(Boolean).join(" 或 ");
        setState({
          phase: "error",
          message: `读不到预览素材（${sources}）—— 检查上方「资源根」是否指到游戏站的 resources。表单照常可用，保存不受影响。`,
        });
        void error;
      });
    return () => {
      cancelled = true;
    };
  }, [resRoot, effectKey, kind]);

  // 播放循环：帧率 = 帧数 ÷ 时长（表单当前值，未保存也生效）
  const durationMs = Math.max(100, Math.floor(Number(form.durationMs)) || 1000);
  useEffect(() => {
    if (state.phase !== "ready" || state.frameNames.length <= 1) return;
    const perFrame = Math.max(30, Math.floor(durationMs / state.frameNames.length));
    const timer = window.setInterval(() => setTick((value) => value + 1), perFrame);
    return () => window.clearInterval(timer);
  }, [state, durationMs]);

  useEffect(() => {
    if (state.phase !== "ready") return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const numeric = (text: string, fallback: number) => {
      const value = Number(text);
      return Number.isFinite(value) ? value : fallback;
    };
    drawPreview(ctx, kind, state.role, state.effect, state.frameNames, {
      offsetX: numeric(form.offsetX, 0),
      offsetY: numeric(form.offsetY, 0),
      scaleX: numeric(form.scaleX, 1),
      scaleY: numeric(form.scaleY, 1),
      rotate: numeric(form.rotate, 0),
      frameIndex: tick,
    });
  }, [state, form, tick, kind]);

  if (state.phase === "loading") {
    // 不套 Card：外层（左栏）已经是一张卡片，这里只要占住画布的坑
    return (
      <div className="flex items-center justify-center rounded-lg border border-line bg-surface-0 py-24 text-sm text-ink-4">
        预览素材加载中…
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <div className="rounded-lg border border-warn/40 bg-warn/10 p-4 text-xs leading-relaxed text-warn">
        {state.message}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-2">
      <canvas
        ref={canvasRef}
        width={size.width}
        height={size.height}
        className="max-w-full rounded-lg border border-line bg-surface-0"
      />
      <p className="text-xs text-ink-6">
        {kind === "dropItem"
          ? `参考：掉落物图标 ${40}×40（虚线框）· 虚线 = 地面 · 光柱画在图标下层 · 按表单当前值实时叠放（未保存也生效）`
          : `参考：裸模正面站立第一帧（${roleAtlasPath()}）· 虚线 = 脚下原点 · 特效按表单当前值实时叠放（未保存也生效）`}
      </p>
    </div>
  );
}

/**
 * 特效管理（#594 升级特效 / #634 掉落光效）
 *
 * 页面按「一族一个页签」组织：升级特效一个页签，掉落光效一个页签 —— 掉落光效的六个档位
 * （`light-1`…`light-6`）在页内容顶部的下拉框里选，选中哪档就改哪档、看哪档的预览。
 * 一档一个页签会排到七个，把「升级特效」挤到最右边，与「同一件事的六个档」这个事实也不符。
 *
 * 页签与下拉项都来自服务端 seed 出来的行：新登记一个 key，这里自动多一项，页面结构不用动。
 *
 * 管的是特效的**表现参数**（摆位 / 缩放 / 旋转 / 时长 / 开关），与武器外观同一套取向 ——
 * 调一次摆位不用重打客户端包。图集本体在客户端资源包里（升级特效 `effect/<key>/<key>.plist`、
 * 掉落光效 `effect/light/<key>.plist`），后台改不了，所以这里**没有新建 / 删除**：行由服务端
 * 启动 seed 决定，一个 key 存在的前提是客户端有这个特效的消费代码。
 *
 * 预览的参考层按族取：升级特效是裸模（看摆位），掉落光效是掉落物图标 40×40 的占位框
 * （看「光柱相对图标多大、偏到哪」，光柱按客户端层级画在图标下层）。
 *
 * 内容分左右两栏：**左栏只管看**（预览画布 + 素材地址），**右栏只管改**（档位 / 参数 / 启用 / 保存）——
 * 调参数时眼睛不用在「表单在上、预览在下」之间来回滚，改一个数左栏立刻重画。窄屏自动叠成一列（先看后改）。
 *
 * 每档的表单各自独立存在 `forms` 里，所以下拉框切档、页签切族都不会丢未保存的改动
 * （页签上带未保存计数，下拉项后缀「未保存」）。
 *
 * 权限点 `gameConfig:read`（看）/ `gameConfig:write`（改）：界面按权限显隐只是体验，服务端守卫才是权威。
 */
export function UiEffectsPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [rows, setRows] = useState<UiEffect[]>([]);
  const [forms, setForms] = useState<Record<string, EffectForm>>({});
  /** 当前页签（一族一个）；掉落光效再记一个「选中的档位」 */
  const [activeTab, setActiveTab] = useState<EffectTab>("upgrade");
  const [activeLightKey, setActiveLightKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [resRoot, setResRoot] = useState<string>(readResRoot);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await uiEffectsApi.list();
      setRows(list.list);
      setForms(Object.fromEntries(list.list.map((row) => [row.key, formOf(row)])));
      // 刷新后停在原处：页签还在就留着，档位还在就留着（被删掉的 key 回落到第一个）
      setActiveTab((prev) => (list.list.some((row) => tabOf(row.key) === prev) ? prev : tabOf(list.list[0]?.key ?? "upgrade")));
      setActiveLightKey((prev) =>
        prev && list.list.some((row) => tabOf(row.key) === "drop" && row.key === prev)
          ? prev
          : (list.list.find((row) => tabOf(row.key) === "drop")?.key ?? null),
      );
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = (key: string, part: Partial<EffectForm>) => {
    setForms((prev) => ({ ...prev, [key]: { ...prev[key], ...part } }));
  };

  const submit = async (key: string) => {
    const form = forms[key];
    if (!form) return;
    setSavingKey(key);
    try {
      const saved = await uiEffectsApi.save(key, {
        offsetX: Math.floor(Number(form.offsetX)),
        offsetY: Math.floor(Number(form.offsetY)),
        scaleX: Number(form.scaleX),
        scaleY: Number(form.scaleY),
        rotate: Math.floor(Number(form.rotate)),
        durationMs: Math.floor(Number(form.durationMs)),
        enabled: form.enabled,
      });
      setRows((prev) => prev.map((row) => (row.key === key ? saved : row)));
      setForms((prev) => ({ ...prev, [key]: formOf(saved) }));
      toastSuccess(`${EFFECT_LABELS[key] ?? key} 已保存，玩家下次触发即按新参数演`);
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setSavingKey(null);
    }
  };

  const changeResRoot = (value: string) => {
    setResRoot(value);
    try {
      localStorage.setItem(PREVIEW_PREFS_KEY, JSON.stringify({ resRoot: value }));
    } catch {
      /* 隐私模式存不了就算了：本次会话内仍然生效 */
    }
  };

  const upgradeRow = rows.find((row) => tabOf(row.key) === "upgrade") ?? null;
  const lightRows = rows.filter((row) => tabOf(row.key) === "drop");
  /** 当前正在改的 key：升级页签 = 唯一那行；掉落页签 = 下拉框选中的档 */
  const activeKey = activeTab === "drop" ? activeLightKey : (upgradeRow?.key ?? null);
  const activeRow = rows.find((row) => row.key === activeKey) ?? null;
  const activeForm = activeKey ? forms[activeKey] : null;
  const numeric = (text: string) => text.trim() !== "" && Number.isFinite(Number(text));
  /** 当前页签属于哪一族（决定预览参考层与几条提示的措辞） */
  const activeKind = activeRow ? previewKindOf(activeRow.key) : "role";
  /** 某一行有没有未保存的改动（`forms` 里没有这行 = 还没渲染过，按未改处理） */
  const isDirtyRow = (row: UiEffect) => {
    const form = forms[row.key];
    return form ? isDirty(form, row) : false;
  };
  /** 某个页签下有几处未保存（页签上的角标；切档 / 切族不会丢改动，得让人看得见） */
  const dirtyCountOf = (tab: EffectTab) => rows.filter((row) => tabOf(row.key) === tab && isDirtyRow(row)).length;
  /** 页签只展示有行的族（服务端 seed 少了哪族，页签就不出现） */
  const tabs = TAB_ORDER.filter((tab) => rows.some((row) => tabOf(row.key) === tab));

  return (
    /* 不加 max-w：与其它页面一致吃满内容区（同一套 layout 内边距），免得这个页面显得比别人窄一圈 */
    <div className="flex flex-col gap-4">
      <PageHeader
        title="特效管理"
        description="特效的表现参数（摆位 / 缩放 / 旋转 / 时长 / 开关），改完点保存、玩家下次触发即生效，不用重打客户端包。升级特效以裸模正面站立第一帧为参考；掉落光效以掉落物图标 40×40 为参考（光柱画在图标下层）。图集本体在客户端资源包里，后台改不了，所以没有新建 / 删除 —— 一个特效在不在，由客户端的消费代码决定。"
      />

      {loading ? (
        <Card className="p-5 text-sm text-ink-4">加载中…</Card>
      ) : rows.length === 0 ? (
        <Card className="p-5 text-sm text-ink-4">还没有特效（服务端 seed 没有灌出任何一行 —— 检查 UI_EFFECT_DEFAULTS）。</Card>
      ) : (
        <>
          {/* 页签栏：一族一个（升级特效 / 掉落光效）；掉落光效的六个档位在页内容里用下拉框选，
              不再一档一个页签 —— 七个页签会把「升级特效」挤到最右边 */}
          <div className="flex flex-wrap items-center gap-1 border-b border-line" role="tablist">
            {tabs.map((tab) => {
              const active = tab === activeTab;
              const dirtyCount = dirtyCountOf(tab);
              return (
                <button
                  key={tab}
                  role="tab"
                  aria-selected={active}
                  onClick={() => setActiveTab(tab)}
                  className={`-mb-px rounded-t-lg border border-b-0 px-4 py-2 text-sm transition-colors ${
                    active
                      ? "border-line bg-surface-2 font-medium text-ink-1"
                      : "border-transparent text-ink-4 hover:text-ink-2"
                  }`}
                >
                  {TAB_LABELS[tab]}
                  {dirtyCount > 0 ? (
                    <span
                      className="ml-1.5 inline-block size-1.5 rounded-full bg-warn-hi align-middle"
                      aria-label={`${dirtyCount} 处未保存`}
                      title={`${dirtyCount} 处未保存`}
                    />
                  ) : null}
                </button>
              );
            })}
          </div>

          {activeRow && activeForm ? (
            /* 内容分左右：左栏只管「看」（预览 + 素材地址），右栏只管「改」（参数 + 保存）。
               窄屏（< lg）自动叠成一列，顺序仍是先看后改 */
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
              {/* 左栏：预览。宽度留给画布（460 + 卡片左右内边距），窄了 canvas 会被压变形 */}
              <div className="w-full shrink-0 lg:w-[520px]">
                <Card className="flex flex-col gap-3 p-5">
                  <EffectPreview resRoot={resRoot} effectKey={activeRow.key} form={activeForm} />

                  <Field
                    label="资源根（预览素材地址，只影响预览，不影响保存）"
                    hint="默认 /game-resources；本地开发指向游戏站 resources 时改这里"
                  >
                    <Input value={resRoot} onChange={(event) => changeResRoot(event.target.value)} placeholder="/game-resources" />
                  </Field>
                </Card>
              </div>

              {/* 右栏：参数表单。改这里 → 左栏按新值立刻重画（未保存也生效） */}
              <Card className="flex min-w-0 flex-1 flex-col gap-4 p-5">
                {activeTab === "drop" && lightRows.length > 0 ? (
                  <Field
                    label="档位"
                    width="w-72"
                    hint="装备前缀越强，光柱越高档：1 号 普通 … 5 号 超神；6 号留给特殊装备（预留）"
                  >
                    <Select
                      value={activeLightKey ?? ""}
                      onChange={(event) => setActiveLightKey(event.target.value)}
                      aria-label="选择要调的光柱档位"
                    >
                      {lightRows.map((row) => (
                        <option key={row.key} value={row.key}>
                          {EFFECT_LABELS[row.key] ?? row.key}
                          {isDirtyRow(row) ? "（未保存）" : ""}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : null}

                {!activeForm.enabled ? (
                  <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
                    {activeKind === "dropItem"
                      ? "光效已停用（enabled = false）—— 游戏里这件掉落物不再显示光柱（照常拾取），预览仍按参数显示供调整。"
                      : "特效已停用（enabled = false）—— 游戏里升级不再播特效，预览仍按参数显示供调整。"}
                  </p>
                ) : null}

                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  <Field
                    label="偏移 X"
                    hint={activeKind === "dropItem" ? "像素，右为正（相对掉落物图标中心）" : "像素，右为正（相对脚下原点）"}
                  >
                    <Input type="number" value={activeForm.offsetX} onChange={(e) => patch(activeRow.key, { offsetX: e.target.value })} disabled={!canWrite} />
                  </Field>
                  <Field label="偏移 Y" hint={activeKind === "dropItem" ? "像素，上为正（相对图标中心）" : "像素，上为正"}>
                    <Input type="number" value={activeForm.offsetY} onChange={(e) => patch(activeRow.key, { offsetY: e.target.value })} disabled={!canWrite} />
                  </Field>
                  <Field label="横向缩放" hint="1 = 原始尺寸">
                    <Input type="number" step="0.1" value={activeForm.scaleX} onChange={(e) => patch(activeRow.key, { scaleX: e.target.value })} disabled={!canWrite} />
                  </Field>
                  <Field label="纵向缩放" hint="1 = 原始尺寸">
                    <Input type="number" step="0.1" value={activeForm.scaleY} onChange={(e) => patch(activeRow.key, { scaleY: e.target.value })} disabled={!canWrite} />
                  </Field>
                  <Field label="旋转" hint="度，顺时针">
                    <Input type="number" value={activeForm.rotate} onChange={(e) => patch(activeRow.key, { rotate: e.target.value })} disabled={!canWrite} />
                  </Field>
                  <Field label="一轮时长（毫秒）" hint="帧率 = 帧数 ÷ 时长">
                    <Input type="number" step="100" value={activeForm.durationMs} onChange={(e) => patch(activeRow.key, { durationMs: e.target.value })} disabled={!canWrite} />
                  </Field>
                </div>

                {/* 底部：启用开关 + 追账 + 保存（右栏不拉伸到左栏高度，这里紧跟参数，不靠 mt-auto 撑） */}
                <div className="flex flex-col gap-3 border-t border-line pt-4">
                  <label className="flex items-center gap-2 text-sm text-ink-3">
                    <input
                      type="checkbox"
                      checked={activeForm.enabled}
                      onChange={(e) => patch(activeRow.key, { enabled: e.target.checked })}
                      disabled={!canWrite}
                      className="size-4 accent-gold"
                    />
                    {activeKind === "dropItem" ? "启用光柱" : "启用特效"}
                  </label>

                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-xs text-ink-6">
                      {activeRow.updatedAt > 0
                        ? `最后修改：${activeRow.updatedBy || "—"} · ${new Date(activeRow.updatedAt).toLocaleString()}`
                        : "仍是出厂值，从未改过"}
                    </span>

                    <div className="ml-auto flex items-center gap-3">
                      {isDirty(activeForm, activeRow) ? <span className="text-xs font-medium text-warn">未保存</span> : null}
                      <Button
                        variant="primary"
                        onClick={() => void submit(activeRow.key)}
                        disabled={
                          !canWrite ||
                          !isDirty(activeForm, activeRow) ||
                          !(
                            numeric(activeForm.offsetX) &&
                            numeric(activeForm.offsetY) &&
                            numeric(activeForm.scaleX) &&
                            numeric(activeForm.scaleY) &&
                            numeric(activeForm.rotate) &&
                            numeric(activeForm.durationMs) &&
                            Number(activeForm.scaleX) > 0 &&
                            Number(activeForm.scaleY) > 0 &&
                            Number(activeForm.durationMs) >= 100
                          ) ||
                          savingKey === activeRow.key
                        }
                      >
                        {savingKey === activeRow.key ? "保存中…" : "保存"}
                      </Button>
                    </div>
                  </div>

                  {!canWrite ? <p className="text-xs text-warn">当前管理员角色没有 gameConfig:write 权限点，只能看不能改。</p> : null}
                </div>
              </Card>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
