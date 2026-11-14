import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PERMISSION, audioSettingsApi } from "../api";
import type { AudioSetting } from "../api";
import { PageHeader } from "../components/PageHeader";
import { Badge, Button, Card, EmptyState, Field, Input, Notice, Select, StatCard } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";
import { AUDIO_ROOT, DEFAULT_RES_ROOT, audioUrlOf, loadAudioFiles } from "./audioSettings/assets";

/**
 * 音效配置（#680 配置 / #683 接客户端 + 分类）
 *
 * ## 管的是什么
 *
 * 四个数：**用哪个文件**（`audio/xxx.wav`，相对 `client/assets/resources/`）、**多大声**
 * （0~100）、**循环不循环**、**开不开**。音频本体在客户端资源包里，所以「换一首登录曲」
 * 只要新文件已经在资源包中，后台改一个路径就行 —— 这是它和特效管理（图集路径是两端约定、
 * 换美术必须重打包）最大的差别。
 *
 * ## 分类来自服务端，页面不写死
 *
 * 每行带 `category` + `categoryLabel`（服务端 `AUDIO_DEFAULTS` 的唯一书写处）。
 * tab 栏按**行的出现顺序**分组，所以加一个音效项 / 加一个分类都只改服务端常量，
 * 这个页面自动多一个 tab —— 不用回来改前端，也不会出现「前端有个空 tab」。
 *
 * ## 试听是这个页面的核心，不是装饰
 *
 * 服务端**不检查文件是否存在**（资源包不在服务端，查了会掩盖「本地有、线上没有」）。
 * 那这条链路的唯一验证手段就是：在页面上点一下试听 —— 能播 = 路径对、MIME 对、文件在。
 * 所以试听按钮按表单**当前值**播（未保存也生效），音量 / 循环也跟着表单走。
 *
 * ## 路径校验为什么在页面上再写一遍
 *
 * 服务端是权威（`audioPathProblem`，400 + 人话提示）。页面这层只为了「边输边提示」，
 * 规则与服务端逐条对齐；不一致时以服务端为准（保存失败会弹它的提示）。
 */

/** 资源根偏好（只影响试听，不影响保存） */
const RES_ROOT_PREF_KEY = "olua.audio.resRoot.v1";

/** 允许的音频扩展名（与服务端 AUDIO_LIMITS.extensions 一致） */
const AUDIO_EXTS = [".wav", ".mp3", ".ogg", ".m4a"];

/** 「全部」tab 的 key（真实分类不会叫这个 —— 服务端的分类 key 是英文标识符） */
const ALL_TAB = "__all__";

/**
 * 分类配色（只影响装饰：tab 圆点、卡片左侧色条）
 *
 * 按分类 key 取，未知分类落到 indigo —— 服务端加一个新分类时页面不会花，只是没有专属色。
 * 类名必须写成完整字面量：Tailwind 只识别源码里出现过的类，拼出来的串会被摇掉。
 */
const CATEGORY_ACCENTS: Record<string, { dot: string; bar: string; tab: string }> = {
  login: { dot: "bg-gold-hi", bar: "border-l-indigo-500/60", tab: "bg-gold/15 text-gold-hi ring-gold/40" },
  combat: { dot: "bg-ember-hi", bar: "border-l-rose-500/60", tab: "bg-ember/15 text-ember-hi ring-ember/40" },
  item: { dot: "bg-warn-hi", bar: "border-l-amber-500/60", tab: "bg-warn/15 text-warn-hi ring-warn/40" },
  growth: { dot: "bg-jade-hi", bar: "border-l-emerald-500/60", tab: "bg-jade/15 text-jade-hi ring-jade/40" },
};

const accentOf = (category: string) => CATEGORY_ACCENTS[category] ?? CATEGORY_ACCENTS.login;

/** 表单状态（音量用字符串存，保存时再转数字 —— 与其它页面同一套「边界统一转换」） */
interface AudioForm {
  filePath: string;
  volume: string;
  loop: boolean;
  enabled: boolean;
}

const formOf = (row: AudioSetting): AudioForm => ({
  filePath: row.filePath,
  volume: String(row.volume),
  loop: row.loop,
  enabled: row.enabled,
});

const isDirty = (form: AudioForm, row: AudioSetting) =>
  form.filePath.trim() !== row.filePath || form.volume.trim() !== String(row.volume) || form.loop !== row.loop || form.enabled !== row.enabled;

/**
 * 路径预检（返回人话；null = 通过）
 *
 * 与服务端 `audioPathProblem` 同一条判据的页面副本：空串合法（= 未配置）、必须 `audio/` 开头、
 * 扩展名在白名单、不许 `..` / 绝对路径、文件名只允许英文（用户 2026-11-04 定：资源目录里临时放的
 * 中文名要先改成英文名再配 —— 选择器会把不合规的文件名挡在列表外）。
 */
function pathProblem(rawPath: string): string | null {
  const path = rawPath.trim().replace(/\\/g, "/");
  if (path === "") return null;
  if (path.startsWith("/")) return "不要以 / 开头（相对 client/assets/resources/ 的路径）";
  if (path.split("/").some((segment) => segment === ".." || segment === ".")) return "路径里不许出现 . 或 ..";
  if (!path.startsWith(`${AUDIO_ROOT}/`)) return `只能选 ${AUDIO_ROOT}/ 下的文件`;
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (!path.includes(".") || !AUDIO_EXTS.includes(ext)) return `只支持 ${AUDIO_EXTS.join(" / ")}`;
  if (!/^audio\/[A-Za-z0-9_\-/]+\.[A-Za-z0-9]+$/.test(path)) return "只能用字母、数字、下划线、短横线与斜杠（中文名请先改成英文名）";
  return null;
}

/** 读资源根偏好（与特效管理同一个默认值；只影响试听） */
function readResRoot(): string {
  try {
    const raw = localStorage.getItem(RES_ROOT_PREF_KEY);
    return raw?.trim() || DEFAULT_RES_ROOT;
  } catch {
    return DEFAULT_RES_ROOT;
  }
}

/**
 * 音效配置页
 *
 * 版面分四层：页头 → 概览（四个数字 + 资源根）→ 分类 tab → 音效卡列表。
 * 权限点 `gameConfig:read`（看）/ `gameConfig:write`（改）—— 界面显隐只是体验，
 * 服务端守卫才是权威。
 */
export function AudioSettingsPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [rows, setRows] = useState<AudioSetting[]>([]);
  const [forms, setForms] = useState<Record<string, AudioForm>>({});
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [resRoot, setResRoot] = useState<string>(readResRoot);
  /** 当前 tab（`ALL_TAB` 或分类 key） */
  const [activeTab, setActiveTab] = useState<string>(ALL_TAB);
  /** 正在试听的 key（同一时刻只播一个） */
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  /** 试听失败的那一行 + 人话原因 */
  const [playError, setPlayError] = useState<{ key: string; message: string } | null>(null);
  const playerRef = useRef<HTMLAudioElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await audioSettingsApi.list();
      setRows(list.list);
      setForms(Object.fromEntries(list.list.map((row) => [row.key, formOf(row)])));
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadAudioFiles().then(setFiles);
  }, [load]);

  /** 停止试听（切页 / 换行 / 卸载都要停，否则声音会在别的页面继续响） */
  const stopPlay = useCallback(() => {
    playerRef.current?.pause();
    playerRef.current = null;
    setPlayingKey(null);
  }, []);

  useEffect(() => stopPlay, [stopPlay]);

  const patch = (key: string, part: Partial<AudioForm>) => {
    setForms((prev) => ({ ...prev, [key]: { ...prev[key], ...part } }));
  };

  /**
   * 试听：按**表单当前值**播（未保存也生效）
   *
   * 音量与循环都取表单值 —— 试听就是「保存后会是什么样」的预演，两处不一致就失去意义。
   */
  const togglePlay = (row: AudioSetting, form: AudioForm) => {
    if (playingKey === row.key) {
      stopPlay();
      return;
    }
    const path = form.filePath.trim();
    if (!path) return;
    stopPlay();
    const audio = new Audio(audioUrlOf(resRoot, path));
    audio.loop = form.loop;
    audio.volume = Math.min(1, Math.max(0, (Number(form.volume) || 0) / 100));
    audio.onended = () => setPlayingKey(null);
    audio.onerror = () => {
      setPlayingKey(null);
      setPlayError({ key: row.key, message: `读不到 ${resRoot}/${path} —— 文件不在资源包里，或资源根填错了（保存不受影响）` });
    };
    playerRef.current = audio;
    setPlayError(null);
    setPlayingKey(row.key);
    void audio.play().catch((error: unknown) => {
      setPlayingKey(null);
      setPlayError({
        key: row.key,
        message: `浏览器拒绝了播放（${error instanceof Error ? error.message : "未知原因"}）—— 先点一下页面任意位置再试`,
      });
    });
  };

  const submit = async (row: AudioSetting) => {
    const form = forms[row.key];
    if (!form) return;
    setSavingKey(row.key);
    try {
      const saved = await audioSettingsApi.save(row.key, {
        filePath: form.filePath.trim(),
        volume: Math.round(Number(form.volume)),
        loop: form.loop,
        enabled: form.enabled,
      });
      setRows((prev) => prev.map((item) => (item.key === row.key ? saved : item)));
      setForms((prev) => ({ ...prev, [row.key]: formOf(saved) }));
      toastSuccess(`${row.label} 已保存（下次进游戏生效）`);
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setSavingKey(null);
    }
  };

  const changeResRoot = (value: string) => {
    setResRoot(value);
    try {
      localStorage.setItem(RES_ROOT_PREF_KEY, value);
    } catch {
      /* 隐私模式存不了就算了：本次会话内仍然生效 */
    }
  };

  /** 未配置 = 路径为空（这一项不会响）；已停用 = enabled = false */
  const statusOf = (form: AudioForm) => {
    if (!form.enabled) return { tone: "muted" as const, text: "已停用" };
    if (!form.filePath.trim()) return { tone: "warn" as const, text: "未配置文件" };
    return { tone: "jade" as const, text: "已启用" };
  };

  const volumeValueOf = (text: string) => {
    const value = Number(text);
    return Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 0;
  };

  /** 文件下拉的选项：清单里没有当前值也要留一项，否则输入框里的值会被下拉「改掉」 */
  const fileOptionsOf = (list: string[], current: string) => {
    const options = list.slice();
    if (current && !options.includes(current)) options.unshift(current);
    return options;
  };

  /**
   * 只列**能存**的文件名（中文 / 空格的不进下拉）
   *
   * 资源目录里可能临时放着还没改名的文件。把它们列出来再让人选，
   * 结果是「选完保存 400」—— 不如直接不列，并在旁边说清为什么少了几个。
   */
  const usableFiles = useMemo(() => files.filter((file) => pathProblem(file) === null), [files]);
  const skippedFiles = files.length - usableFiles.length;

  const canSave = useMemo(
    () => (row: AudioSetting) => {
      const form = forms[row.key];
      if (!form) return false;
      return isDirty(form, row) && !pathProblem(form.filePath) && Number.isFinite(Number(form.volume));
    },
    [forms],
  );

  /** 分类 tab：按**行的出现顺序**分组（服务端 `AUDIO_KEYS` 的顺序），不按字典序 */
  const tabs = useMemo(() => {
    const groups: { key: string; label: string; count: number }[] = [];
    for (const row of rows) {
      const found = groups.find((group) => group.key === row.category);
      if (found) {
        found.count += 1;
        continue;
      }
      groups.push({ key: row.category, label: row.categoryLabel, count: 1 });
    }
    return groups;
  }, [rows]);

  const visibleRows = useMemo(
    () => (activeTab === ALL_TAB ? rows : rows.filter((row) => row.category === activeTab)),
    [rows, activeTab],
  );

  /** 概览：启用数 / 未配文件数 / 待保存数（`row` 与表单比，才是「这台机器上还没存」） */
  const dirtyCount = useMemo(
    () => rows.filter((row) => forms[row.key] && isDirty(forms[row.key], row)).length,
    [rows, forms],
  );
  const enabledCount = useMemo(() => rows.filter((row) => forms[row.key]?.enabled).length, [rows, forms]);
  const unsetCount = useMemo(() => rows.filter((row) => forms[row.key]?.enabled && !forms[row.key]?.filePath.trim()).length, [rows, forms]);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="音效配置"
        description="11 个音效项，按分类分组。配的是「用哪个文件 / 多大声 / 循环不循环 / 开不开」—— 文件在客户端资源包 audio/ 里，服务端只存相对路径，所以换曲子不用重打客户端包。"
        actions={
          <>
            {dirtyCount > 0 ? <Badge tone="warn">{dirtyCount} 项未保存</Badge> : null}
            <Button variant="outline" onClick={() => void load()} loading={loading}>
              刷新
            </Button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="音效项" value={rows.length} hint="由服务端清单决定，不能在这里增删" />
        <StatCard label="已启用" value={enabledCount} hint="停用的项客户端连文件都不读" />
        <StatCard label="缺少文件" value={unsetCount} hint="启用了但没填路径 —— 这一项不会响" />
        <StatCard label="未保存" value={dirtyCount} hint="改过还没点保存的项数" />
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field
            label="资源根（试听地址前缀，只影响试听）"
            hint="默认 /game-resources；本地要直连游戏站时，填它的 resources 目录地址"
            width="min-w-[280px] flex-1"
          >
            <Input value={resRoot} onChange={(event) => changeResRoot(event.target.value)} placeholder={DEFAULT_RES_ROOT} />
          </Field>
          <p className="pb-1 text-xs text-ink-5">
            可选的音频文件：
            {usableFiles.length > 0 ? `${usableFiles.length} 个（来自 audio/ 目录清单）` : "清单读不到 —— 直接手填路径，用试听确认"}
            {skippedFiles > 0 ? ` · 另有 ${skippedFiles} 个文件名不是英文（未列入，改名后重新进页面即可）` : ""}
          </p>
        </div>
      </Card>

      {/* 分类 tab：`role=tablist` 让读屏与键盘可用；计数直接标在 tab 上，不用逐个点开看 */}
      <div role="tablist" aria-label="音效分类" className="flex flex-wrap items-center gap-1.5 rounded-xl border border-line bg-surface-2/40 p-1.5">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === ALL_TAB}
          onClick={() => setActiveTab(ALL_TAB)}
          className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium ring-1 ring-inset transition ${
            activeTab === ALL_TAB ? "bg-ink-1/10 text-ink-1 ring-ink-5/50" : "text-ink-4 ring-transparent hover:text-ink-2"
          }`}
        >
          全部
          <span className="rounded bg-surface-4 px-1.5 py-0.5 text-[11px] text-ink-3">{rows.length}</span>
        </button>
        {tabs.map((tab) => {
          const accent = accentOf(tab.key);
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTab(tab.key)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium ring-1 ring-inset transition ${
                active ? accent.tab : "text-ink-4 ring-transparent hover:text-ink-2"
              }`}
            >
              <span aria-hidden="true" className={`size-1.5 rounded-full ${accent.dot}`} />
              {tab.label}
              <span className="rounded bg-surface-4 px-1.5 py-0.5 text-[11px] text-ink-3">{tab.count}</span>
            </button>
          );
        })}
      </div>

      {loading ? (
        <Card className="p-5 text-sm text-ink-4">加载中…</Card>
      ) : rows.length === 0 ? (
        <Card className="p-5">
          <EmptyState title="还没有音效项" description="服务端 seed 没有灌出任何一行 —— 检查 AUDIO_DEFAULTS。" />
        </Card>
      ) : visibleRows.length === 0 ? (
        <Card className="p-5">
          <EmptyState title="这一类没有音效项" description="分类来自服务端清单，切回「全部」可以看到其它项。" />
        </Card>
      ) : (
        <div className="flex flex-col gap-2.5">
          {visibleRows.map((row) => {
            const form = forms[row.key] ?? formOf(row);
            const status = statusOf(form);
            const problem = pathProblem(form.filePath);
            const playing = playingKey === row.key;
            const error = playError?.key === row.key ? playError.message : null;
            const dirty = isDirty(form, row);
            const accent = accentOf(row.category);
            return (
              <section
                key={row.key}
                className={`rounded-2xl border border-line border-l-2 bg-surface-2/40 shadow-lg shadow-surface-0/40 ${accent.bar} ${
                  dirty ? "ring-1 ring-warn/20" : ""
                }`}
              >
                <div className="flex flex-col gap-3 px-3.5 py-3 lg:flex-row lg:items-start">
                  {/* 左栏：是什么 */}
                  <div className="flex w-full shrink-0 flex-col gap-1 lg:w-64">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-ink-1">{row.label}</span>
                      <Badge tone={status.tone}>{status.text}</Badge>
                      {dirty ? <span className="text-[11px] font-medium text-warn">未保存</span> : null}
                    </div>
                    <code className="truncate text-[11px] text-ink-5" title={row.key}>
                      {row.key}
                    </code>
                    <p className="text-[11px] leading-relaxed text-ink-5">
                      {form.loop ? "循环播放" : "播放一次"}
                      {form.volume.trim() === "0" ? " · 音量为 0（等于静音）" : ""}
                      {" · "}
                      {row.updatedAt > 0 ? `最后修改 ${row.updatedBy || "—"} · ${new Date(row.updatedAt).toLocaleString()}` : "仍是出厂值"}
                    </p>
                  </div>

                  {/* 右栏：怎么配 */}
                  <div className="flex min-w-0 flex-1 flex-col gap-2.5">
                    <div className="flex flex-wrap items-end gap-2">
                      <Field
                        label="音频文件（相对 client/assets/resources/，带扩展名）"
                        hint={`例如 ${AUDIO_ROOT}/login_bg.wav；留空 = 这一项不配置（不会响）`}
                        width="min-w-[280px] flex-1"
                      >
                        <Input
                          value={form.filePath}
                          onChange={(event) => patch(row.key, { filePath: event.target.value })}
                          placeholder={`${AUDIO_ROOT}/login_bg.wav`}
                          disabled={!canWrite}
                          spellCheck={false}
                          className="font-mono text-xs"
                        />
                      </Field>
                      {usableFiles.length > 0 ? (
                        <Field label="从目录选" width="w-52">
                          <Select
                            value={usableFiles.includes(form.filePath.trim()) ? form.filePath.trim() : ""}
                            onChange={(event) => patch(row.key, { filePath: event.target.value })}
                            disabled={!canWrite}
                            aria-label={`为 ${row.label} 选择音频文件`}
                          >
                            <option value="">（保持手填 / 未选）</option>
                            {fileOptionsOf(usableFiles, form.filePath.trim()).map((file) => (
                              <option key={file} value={file}>
                                {file.replace(`${AUDIO_ROOT}/`, "")}
                              </option>
                            ))}
                          </Select>
                        </Field>
                      ) : null}
                      <Button
                        variant={playing ? "primary" : "outline"}
                        onClick={() => togglePlay(row, form)}
                        disabled={!form.filePath.trim()}
                        title={form.filePath.trim() ? "按表单当前值试听（含音量与循环）" : "先选一个文件"}
                      >
                        {playing ? "◼ 停止" : "▶ 试听"}
                      </Button>
                    </div>

                    {problem ? <p className="text-xs text-ember-hi">{problem}</p> : null}
                    {error ? <p className="text-xs text-warn">{error}</p> : null}
                    {!form.enabled ? (
                      <p className="text-xs text-warn">已停用 —— 客户端连文件都不读，与「音量调 0」不是一回事。</p>
                    ) : null}
                    {form.enabled && !form.filePath.trim() ? (
                      <p className="text-xs text-ink-5">还没有选文件 —— 这一项不会响（保存也合法，等文件进资源包再补）。</p>
                    ) : null}

                    <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
                      <Field label="音量" hint="100 = 原始音量" width="w-64">
                        <div className="flex items-center gap-2">
                          <input
                            type="range"
                            min={0}
                            max={100}
                            step={1}
                            value={volumeValueOf(form.volume)}
                            onChange={(event) => patch(row.key, { volume: event.target.value })}
                            disabled={!canWrite}
                            className="h-1.5 flex-1 accent-gold"
                            aria-label={`${row.label} 音量`}
                          />
                          <Input
                            type="number"
                            min={0}
                            max={100}
                            value={form.volume}
                            onChange={(event) => patch(row.key, { volume: event.target.value })}
                            disabled={!canWrite}
                            className="w-16 py-1 text-xs"
                          />
                        </div>
                      </Field>
                      <label className="flex items-center gap-2 pb-1.5 text-xs text-ink-3">
                        <input
                          type="checkbox"
                          checked={form.loop}
                          onChange={(event) => patch(row.key, { loop: event.target.checked })}
                          disabled={!canWrite}
                          className="size-3.5 accent-gold"
                        />
                        循环播放
                      </label>
                      <label className="flex items-center gap-2 pb-1.5 text-xs text-ink-3">
                        <input
                          type="checkbox"
                          checked={form.enabled}
                          onChange={(event) => patch(row.key, { enabled: event.target.checked })}
                          disabled={!canWrite}
                          className="size-3.5 accent-gold"
                        />
                        启用
                      </label>
                      <div className="ml-auto flex items-center gap-2 pb-0.5">
                        {!canWrite ? <span className="text-xs text-warn">没有 gameConfig:write 权限，只能看</span> : null}
                        <Button
                          variant="primary"
                          onClick={() => void submit(row)}
                          disabled={!canWrite || !canSave(row) || savingKey === row.key}
                          title={isDirty(form, row) ? "保存这一项（整份覆盖四个值）" : "没有改动"}
                        >
                          {savingKey === row.key ? "保存中…" : "保存"}
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}

      <Notice tone="muted" title="路径规则与「为什么只能试听」">
        只能填 <code className="text-ink-2">audio/</code> 下的文件，带扩展名（{AUDIO_EXTS.join(" / ")}），文件名只允许英文、数字、下划线、短横线。
        服务端**不检查文件是否存在** —— 资源包不在服务器上，查了只会掩盖「本机有、线上没有」；
        所以每次改完路径请点一次<strong>试听</strong>，那就是这条链路唯一的验证手段。
      </Notice>
    </div>
  );
}
