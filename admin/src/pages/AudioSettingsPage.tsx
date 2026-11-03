import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PERMISSION, audioSettingsApi } from "../api";
import type { AudioSetting } from "../api";
import { PageHeader } from "../components/PageHeader";
import { Badge, Button, Card, Field, Input, Notice, Select } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";
import { AUDIO_ROOT, DEFAULT_RES_ROOT, audioUrlOf, loadAudioFiles } from "./audioSettings/assets";

/**
 * 音效配置（#680：登录场景背景音 / 登录按钮点击音）
 *
 * ## 管的是什么
 *
 * 四个数：**用哪个文件**（`sounds/xxx.wav`，相对 `client/assets/resources/`）、**多大声**
 * （0~100）、**循环不循环**、**开不开**。音频本体在客户端资源包里，所以「换一首登录曲」
 * 只要新文件已经在资源包中，后台改一个路径就行 —— 这是它和特效管理（图集路径是两端约定、
 * 换美术必须重打包）最大的差别。
 *
 * ## 本轮不接客户端（用户 2026-11-04 明确）
 *
 * 客户端还没有播放代码，所以现在保存**只是落库**，游戏里不会有声音。页头把这件事说明白，
 * 否则运维会按「保存了却没响」去怀疑配置本身。对接时由配置快照下发（服务端已备好 `list()`）。
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
 * 与服务端 `audioPathProblem` 同一条判据的页面副本：空串合法（= 未配置）、必须 `sounds/` 开头、
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
  if (!/^sounds\/[A-Za-z0-9_\-/]+\.[A-Za-z0-9]+$/.test(path)) return "只能用字母、数字、下划线、短横线与斜杠（中文名请先改成英文名）";
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
 * 可选的音频文件清单
 *
 * 实现在 `./audioSettings/assets`：静态素材读取要集中在审计放行的那个文件里
 * （管理端的请求只允许从 `api/http.ts` 发出，素材清单是例外）。
 */

/**
 * 音效配置页
 *
 * 一个音效项一张卡：左边「是什么」（展示名 / key / 状态徽标），右边「怎么配」
 * （文件路径 + 选文件 + 试听 / 音量 / 循环 / 启用 / 保存）。窄屏自动叠成一列。
 *
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
      toastSuccess(`${row.label} 已保存（客户端对接后进游戏生效）`);
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
    if (!form.enabled) return { tone: "slate" as const, text: "已停用" };
    if (!form.filePath.trim()) return { tone: "amber" as const, text: "未配置文件" };
    return { tone: "green" as const, text: "已启用" };
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
   * 资源目录里可能临时放着还没改名的文件（如 `木剑砍击音效.wav`）。把它们列出来再让人选，
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

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="音效配置"
        description="配每个音效用哪个文件、多大声、循环不循环、开不开。音频文件在客户端资源包的 sounds/ 里，服务端只存相对路径 —— 换曲子不必重打客户端包，但文件得先随资源包发出去。本轮只落库，客户端还没有播放代码，游戏里暂时不会响。"
      />

      <Notice tone="slate" title="现在保存只会写库，还不会出声">
        客户端播放代码尚未接入（本轮约定「先配置、后对接」）。保存后可以在本页点<strong>试听</strong>确认路径与文件没问题；
        进游戏里的效果要等客户端接上配置快照之后。
      </Notice>

      <Card className="flex flex-wrap items-end gap-3 p-4">
        <Field
          label="资源根（试听地址前缀，只影响试听）"
          hint="默认 /game-resources；本地要直连游戏站时，填它的 resources 目录地址"
          width="min-w-[280px] flex-1"
        >
          <Input value={resRoot} onChange={(event) => changeResRoot(event.target.value)} placeholder={DEFAULT_RES_ROOT} />
        </Field>
        <p className="text-xs text-slate-500">
          可选的音频文件：
          {usableFiles.length > 0 ? `${usableFiles.length} 个（来自 sounds/ 目录清单）` : "清单读不到 —— 直接手填路径，用试听确认"}
          {skippedFiles > 0 ? ` · 另有 ${skippedFiles} 个文件名不是英文（未列入，改名后重新进页面即可）` : ""}
        </p>
      </Card>

      {loading ? (
        <Card className="p-5 text-sm text-slate-400">加载中…</Card>
      ) : rows.length === 0 ? (
        <Card className="p-5 text-sm text-slate-400">
          还没有音效项（服务端 seed 没有灌出任何一行 —— 检查 AUDIO_DEFAULTS）。
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((row) => {
            const form = forms[row.key] ?? formOf(row);
            const status = statusOf(form);
            const problem = pathProblem(form.filePath);
            const playing = playingKey === row.key;
            const error = playError?.key === row.key ? playError.message : null;
            return (
              <Card key={row.key} className="flex flex-col gap-4 p-5 lg:flex-row lg:items-start">
                {/* 左栏：是什么 */}
                <div className="flex w-full shrink-0 flex-col gap-1.5 lg:w-64">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-100">{row.label}</span>
                    <Badge tone={status.tone}>{status.text}</Badge>
                  </div>
                  <code className="text-xs text-slate-500">{row.key}</code>
                  <p className="text-xs text-slate-600">
                    {row.updatedAt > 0
                      ? `最后修改：${row.updatedBy || "—"} · ${new Date(row.updatedAt).toLocaleString()}`
                      : "仍是出厂值，从未改过"}
                  </p>
                  <p className="text-xs text-slate-600">
                    {form.loop ? "循环播放（背景音）" : "播放一次（点击音）"}
                    {form.volume.trim() === "0" ? " · 音量为 0，等于静音" : ""}
                  </p>
                </div>

                {/* 右栏：怎么配 */}
                <div className="flex min-w-0 flex-1 flex-col gap-3">
                  <div className="flex flex-wrap items-end gap-2">
                    <Field
                      label="音频文件（相对 client/assets/resources/，带扩展名）"
                      hint={`例如 ${AUDIO_ROOT}/login_bg.wav；留空 = 这一项不配置（不会响）`}
                      width="min-w-[320px] flex-1"
                    >
                      <Input
                        value={form.filePath}
                        onChange={(event) => patch(row.key, { filePath: event.target.value })}
                        placeholder={`${AUDIO_ROOT}/login_bg.wav`}
                        disabled={!canWrite}
                        spellCheck={false}
                      />
                    </Field>
                    {usableFiles.length > 0 ? (
                      <Field label="从目录选" width="w-56">
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
                      variant="outline"
                      onClick={() => togglePlay(row, form)}
                      disabled={!form.filePath.trim()}
                      title={form.filePath.trim() ? "按表单当前值试听（含音量与循环）" : "先选一个文件"}
                    >
                      {playing ? "停止" : "试听"}
                    </Button>
                  </div>

                  {problem ? <p className="text-xs text-rose-400">{problem}</p> : null}
                  {error ? <p className="text-xs text-amber-400">{error}</p> : null}
                  {!form.enabled ? (
                    <p className="text-xs text-amber-400">已停用（enabled = false）—— 客户端连文件都不读，与「音量调 0」不是一回事。</p>
                  ) : null}
                  {form.enabled && !form.filePath.trim() ? (
                    <p className="text-xs text-slate-500">还没有选文件 —— 这一项不会响（保存也合法，等文件进资源包再补）。</p>
                  ) : null}

                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label="音量（0~100）" hint="100 = 原始音量">
                      <div className="flex items-center gap-2">
                        <input
                          type="range"
                          min={0}
                          max={100}
                          step={1}
                          value={volumeValueOf(form.volume)}
                          onChange={(event) => patch(row.key, { volume: event.target.value })}
                          disabled={!canWrite}
                          className="h-1.5 flex-1 accent-indigo-500"
                          aria-label={`${row.label} 音量`}
                        />
                        <Input
                          type="number"
                          min={0}
                          max={100}
                          value={form.volume}
                          onChange={(event) => patch(row.key, { volume: event.target.value })}
                          disabled={!canWrite}
                          className="w-20"
                        />
                      </div>
                    </Field>
                    <label className="flex items-end gap-2 pb-2 text-sm text-slate-300">
                      <input
                        type="checkbox"
                        checked={form.loop}
                        onChange={(event) => patch(row.key, { loop: event.target.checked })}
                        disabled={!canWrite}
                        className="size-4 accent-indigo-500"
                      />
                      循环播放
                    </label>
                    <label className="flex items-end gap-2 pb-2 text-sm text-slate-300">
                      <input
                        type="checkbox"
                        checked={form.enabled}
                        onChange={(event) => patch(row.key, { enabled: event.target.checked })}
                        disabled={!canWrite}
                        className="size-4 accent-indigo-500"
                      />
                      启用
                    </label>
                  </div>

                  <div className="flex flex-wrap items-center gap-3 border-t border-slate-800 pt-3">
                    {!canWrite ? <span className="text-xs text-amber-400">当前角色没有 gameConfig:write 权限点，只能看不能改。</span> : null}
                    <div className="ml-auto flex items-center gap-3">
                      {isDirty(form, row) ? <span className="text-xs font-medium text-amber-400">未保存</span> : null}
                      <Button variant="primary" onClick={() => void submit(row)} disabled={!canWrite || !canSave(row) || savingKey === row.key}>
                        {savingKey === row.key ? "保存中…" : "保存"}
                      </Button>
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
