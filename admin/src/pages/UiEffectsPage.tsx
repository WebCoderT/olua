import { useCallback, useEffect, useRef, useState } from "react";
import { PERMISSION, uiEffectsApi } from "../api";
import type { UiEffect } from "../api";
import { PageHeader } from "../components/PageHeader";
import { Button, Card, Field, Input } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";
import type { Atlas } from "./equipAlign/atlas";
import {
  PREVIEW_SIZE,
  drawPreview,
  effectAtlasPath,
  effectFrameNames,
  loadPreviewAtlases,
  roleAtlasPath,
} from "./uiEffects/preview";

/** 特效 key → 页面展示名（key 的唯一来源在服务端 UI_EFFECT_KEYS；新特效登记后这里补一行中文名） */
const EFFECT_LABELS: Record<string, string> = { upgrade: "升级特效" };

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
 * 特效预览画布：裸模正面站立第一帧为参考，特效按表单当前值叠放并逐帧播放
 *
 * 素材经 `resRoot` 读（同装备对齐工作台）：裸模 = `role/1/stand/stand` 的正面第一帧，
 * 特效 = `effect/<key>/<key>.plist`。读不到素材就给一句人话提示，不渲染半个残影。
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
  const [state, setState] = useState<
    | { phase: "loading" }
    | { phase: "ready"; role: Atlas; effect: Atlas | null; frameNames: string[] }
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
        setState({
          phase: "error",
          message: `读不到预览素材（${roleAtlasPath()} 或 ${effectAtlasPath(effectKey)}）—— 检查上方「资源根」是否指到游戏站的 resources。表单照常可用，保存不受影响。`,
        });
        void error;
      });
    return () => {
      cancelled = true;
    };
  }, [resRoot, effectKey]);

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
    drawPreview(ctx, state.role, state.effect, state.frameNames, {
      offsetX: numeric(form.offsetX, 0),
      offsetY: numeric(form.offsetY, 0),
      scaleX: numeric(form.scaleX, 1),
      scaleY: numeric(form.scaleY, 1),
      rotate: numeric(form.rotate, 0),
      frameIndex: tick,
    });
  }, [state, form, tick]);

  if (state.phase === "loading") {
    return <Card className="flex items-center justify-center p-6 text-sm text-slate-400">预览素材加载中…</Card>;
  }
  if (state.phase === "error") {
    return <Card className="p-5 text-xs leading-relaxed text-amber-400">{state.message}</Card>;
  }
  return (
    <div className="flex flex-col items-center gap-2">
      <canvas
        ref={canvasRef}
        width={PREVIEW_SIZE.width}
        height={PREVIEW_SIZE.height}
        className="max-w-full rounded-lg border border-slate-800 bg-slate-950"
      />
      <p className="text-xs text-slate-600">
        参考：裸模正面站立第一帧（{roleAtlasPath()}）· 虚线 = 脚下原点 · 特效按表单当前值实时叠放（未保存也生效）
      </p>
    </div>
  );
}

/**
 * 特效管理（#594：升级特效的表现参数归服务端）
 *
 * 页面按「一个特效一个页签」组织（用户要求：先有升级特效，后面还会加更多，
 * 比如物品掉落在地图上的特效）—— 页签即服务端 seed 出来的 key，新特效登记后
 * 这里自动多一个页签，页面结构不用动。
 *
 * 管的是特效的**表现参数**（摆位 / 缩放 / 旋转 / 时长 / 开关），与武器外观同一套取向 ——
 * 调一次摆位不用重打客户端包。图集本体在客户端资源包里（`effect/<key>/<key>.plist`），
 * 后台改不了，所以这里**没有新建 / 删除**：行由服务端启动 seed 决定，
 * 一个 key 存在的前提是客户端有这个特效的消费代码。
 *
 * 权限点 `gameConfig:read`（看）/ `gameConfig:write`（改）：界面按权限显隐只是体验，服务端守卫才是权威。
 */
export function UiEffectsPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [rows, setRows] = useState<UiEffect[]>([]);
  const [forms, setForms] = useState<Record<string, EffectForm>>({});
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [resRoot, setResRoot] = useState<string>(readResRoot);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await uiEffectsApi.list();
      setRows(list.list);
      setForms(Object.fromEntries(list.list.map((row) => [row.key, formOf(row)])));
      setActiveKey((prev) => prev && list.list.some((row) => row.key === prev) ? prev : (list.list[0]?.key ?? null));
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
      toastSuccess(`特效 ${key} 已保存，玩家下次触发即按新参数演`);
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

  const activeRow = rows.find((row) => row.key === activeKey) ?? null;
  const activeForm = activeKey ? forms[activeKey] : null;
  const numeric = (text: string) => text.trim() !== "" && Number.isFinite(Number(text));

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <PageHeader
        title="特效管理"
        description="界面特效的表现参数（摆位 / 缩放 / 旋转 / 时长 / 开关），以裸模正面站立第一帧为参考实时预览；保存后玩家下次触发即生效，不用重打客户端包。图集本体在客户端资源包里，后台改不了，所以没有新建 / 删除 —— 一个特效在不在，由客户端的消费代码决定。"
      />

      {loading ? (
        <Card className="p-5 text-sm text-slate-400">加载中…</Card>
      ) : rows.length === 0 ? (
        <Card className="p-5 text-sm text-slate-400">还没有界面特效（服务端 seed 没有灌出任何一行 —— 检查 UI_EFFECT_DEFAULTS）。</Card>
      ) : (
        <>
          {/* 页签栏：一个特效一个页签；新 key 登记后自动多一个，页面结构不用动 */}
          <div className="flex items-center gap-1 border-b border-slate-800" role="tablist">
            {rows.map((row) => {
              const active = row.key === activeKey;
              const dirty = forms[row.key] ? isDirty(forms[row.key], row) : false;
              return (
                <button
                  key={row.key}
                  role="tab"
                  aria-selected={active}
                  onClick={() => setActiveKey(row.key)}
                  className={`-mb-px rounded-t-lg border border-b-0 px-4 py-2 text-sm transition-colors ${
                    active
                      ? "border-slate-800 bg-slate-900 font-medium text-slate-100"
                      : "border-transparent text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {EFFECT_LABELS[row.key] ?? row.key}
                  {dirty ? <span className="ml-1.5 inline-block size-1.5 rounded-full bg-amber-400 align-middle" aria-label="未保存" /> : null}
                </button>
              );
            })}
          </div>

          {activeRow && activeForm ? (
            <Card className="flex flex-col gap-4 p-5">
              <EffectPreview resRoot={resRoot} effectKey={activeRow.key} form={activeForm} />

              <Field label="资源根（预览素材地址，只影响预览，不影响保存）" hint="默认 /game-resources；本地开发指向游戏站 resources 时改这里">
                <Input value={resRoot} onChange={(event) => changeResRoot(event.target.value)} placeholder="/game-resources" />
              </Field>

              {!activeForm.enabled ? (
                <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
                  特效已停用（enabled = false）—— 游戏里升级不再播特效，预览仍按参数显示供调整。
                </p>
              ) : null}

              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="偏移 X" hint="像素，右为正（相对脚下原点）">
                  <Input type="number" value={activeForm.offsetX} onChange={(e) => patch(activeRow.key, { offsetX: e.target.value })} disabled={!canWrite} />
                </Field>
                <Field label="偏移 Y" hint="像素，上为正">
                  <Input type="number" value={activeForm.offsetY} onChange={(e) => patch(activeRow.key, { offsetY: e.target.value })} disabled={!canWrite} />
                </Field>
                <Field label="旋转" hint="度，顺时针">
                  <Input type="number" value={activeForm.rotate} onChange={(e) => patch(activeRow.key, { rotate: e.target.value })} disabled={!canWrite} />
                </Field>
                <Field label="横向缩放" hint="1 = 原始尺寸">
                  <Input type="number" step="0.1" value={activeForm.scaleX} onChange={(e) => patch(activeRow.key, { scaleX: e.target.value })} disabled={!canWrite} />
                </Field>
                <Field label="纵向缩放" hint="1 = 原始尺寸">
                  <Input type="number" step="0.1" value={activeForm.scaleY} onChange={(e) => patch(activeRow.key, { scaleY: e.target.value })} disabled={!canWrite} />
                </Field>
                <Field label="一轮时长（毫秒）" hint="帧率 = 帧数 ÷ 时长">
                  <Input type="number" step="100" value={activeForm.durationMs} onChange={(e) => patch(activeRow.key, { durationMs: e.target.value })} disabled={!canWrite} />
                </Field>
              </div>

              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={activeForm.enabled}
                    onChange={(e) => patch(activeRow.key, { enabled: e.target.checked })}
                    disabled={!canWrite}
                    className="size-4 accent-indigo-500"
                  />
                  启用特效
                </label>

                <span className="text-xs text-slate-600">
                  {activeRow.updatedAt > 0 ? `最后修改：${activeRow.updatedBy || "—"} · ${new Date(activeRow.updatedAt).toLocaleString()}` : "仍是出厂值，从未改过"}
                </span>

                <div className="ml-auto flex items-center gap-3">
                  {isDirty(activeForm, activeRow) ? <span className="text-xs font-medium text-amber-400">未保存</span> : null}
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

              {!canWrite ? <p className="text-xs text-amber-400">当前管理员角色没有 gameConfig:write 权限点，只能看不能改。</p> : null}
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}
