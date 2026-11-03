import { useEffect, useMemo, useState } from "react";
import { GAME_RES_ROOT, GameFrame, GameIcon } from "./GameImage";
import { Modal } from "./Modal";
import { usePickerStackEntry } from "./pickerStack";
import { Button, Field, Input, Spinner } from "./ui";

/**
 * 图片选择器：可视化挑一张 resources 里的图
 *
 * 为什么要它：图标字段（药品 / 装备 / 物品 / 技能…）在库里存的是 resources 相对路径
 * （如 `item/fs_2`）。手填路径的代价是「改完资源还要记得名字」—— 素材一更新，
 * 运营就得去翻目录、拼路径、祈祷别打错。这里把「有哪些图」摊成网格，点一下就选中。
 *
 * ## 清单从哪来（两个来源，同一个 JSON 形状）
 * - **开发**（`npm run dev`）：vite 中间件的 `GET /game-resources/__list` 直接扫
 *   `client/assets/resources` —— 素材一放进来就能选，不需要任何额外步骤；
 * - **生产**：nginx 只是静态反代，没有目录列表能力 → 读落盘清单
 *   `resources/image-manifest.json`（`make image-manifest` 生成，随素材包分发）。
 *
 * 两个来源都给 `{ images: string[] }`（相对 resources 根、posix、**不带扩展名**），
 * 所以下面这段解析代码只有一条路径，不存在「本地调好了、部署上去没得选」。
 *
 * ## 文件 vs 目录（清单只列图片，但候选未必是图片）
 * 动画模式的「一套」有两种磁盘形态：`clothes/in/001` 是**文件**（`001.png` + `001.plist`），
 * `clothes/out/001` 是**目录**（里面再分 `stand` / `run` / 八方向子目录，本体没有单张封面）。
 * 清单里没有目录项，所以目录集由图片路径的各级父目录反推（`indexCatalog`），
 * 判定见 `kindOf`：能出缩略图的（自身是图 / 目录里有同名图集本体）照旧画首帧，
 * 纯目录画**文件夹图标** —— 别让「图集目录」长得像「素材缺失」。
 *
 * ## 与 EntityPicker 的分工
 * 那个挑的是**游戏数据行**（装备 / 技能 / 物品的 id，带名字与说明）；
 * 这个挑的是**素材文件**（路径本身就是要存的值，没有名字可显示）。两者都复用 `Modal`，
 * 关闭行为（Esc / 点遮罩）不会各写一套。
 */

type ImageCatalog = { images: string[]; source: "list" | "manifest"; index: CatalogIndex };

/**
 * 挑什么：
 * - `image`：一张**图**（`icon` / `effect` / 底图 —— 存的就是这张图的路径）；
 * - `atlas`：一套**动画资源**（`animation` / 内观 / 外观 / NPC `src`）。
 *
 * ## 动画模式怎么定「一套」
 * 动画在磁盘上有三种形态，但**对运营来说都是「这个角色 / 称号的那一套」**：
 * - `titles/sfx_13009/sfx_13009.png`（Cocos 图集目录约定）；
 * - `clothes/in/001.png` + `.plist`（路径即基名）；
 * - `clothes/out/001/a1/a1.png`（外观按动作分子目录，一个动作一套图集）。
 *
 * 所以要靠清单反推「一套」得写三种规则 —— 不如直接用**调用方给的锚点**：
 * `rootDir` 之下的**第一段**就是一套（`clothes/out` + `001` → `clothes/out/001`）。
 * 一条规则覆盖三种形态，也不会把 `001/a1` 这种内部动作目录漏给运营去选。
 * 因此动画模式下 `rootDir` 是必填的（没有锚点就无从切段，退化成图标模式的行为）。
 */
export type ImagePickMode = "image" | "atlas";

/** 相对 rootDir 的第一段（动画模式用它当「一套」的标识） */
function firstSegmentOf(relative: string): string {
  const slash = relative.indexOf("/");
  return slash > 0 ? relative.slice(0, slash) : relative;
}

/** 清单索引：文件集 + 目录集（后者由图片路径的各级父目录反推，清单本身不含目录项） */
type CatalogIndex = { files: Set<string>; dirs: Set<string> };

function indexCatalog(images: string[]): CatalogIndex {
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const path of images) {
    files.add(path);
    let slash = path.lastIndexOf("/");
    while (slash > 0) {
      dirs.add(path.slice(0, slash));
      slash = path.lastIndexOf("/", slash - 1);
    }
  }
  return { files, dirs };
}

/**
 * 这个值在磁盘上是什么：一张图 / 一个目录 / 清单里根本没有
 *
 * - `files.has(value)`：路径本身就是图（`clothes/in/001` → `clothes/in/001.png`）；
 * - `files.has(value/同名)`：目录里放着**同名**图集本体（`titles/sfx_13009/sfx_13009.png`、
 *   `npc/npc_2108/npc_2108.png`）—— 那张就是封面，按「图」处理；
 * - 目录里只有子目录（`clothes/out/001` 的 `stand` / `run` / 八方向）→ 目录；
 * - 连目录都不是（库里留着已删素材的路径）→ missing，交给 `GameFrame` 显示「无图」。
 */
type PathKind = "file" | "folder" | "missing";

function kindOf(value: string, index: CatalogIndex): PathKind {
  if (index.files.has(value)) return "file";
  const name = value.slice(value.lastIndexOf("/") + 1);
  if (index.files.has(`${value}/${name}`)) return "file";
  return index.dirs.has(value) ? "folder" : "missing";
}

/** 清单缓存（一次会话只拉一次；失败不缓存，下次打开重试） */
let catalogTask: Promise<ImageCatalog> | null = null;

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return response.json();
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** 拉图片清单：先问 dev 的目录接口，不在（生产）就退到落盘清单 */
export function loadImageCatalog(): Promise<ImageCatalog> {
  if (catalogTask) return catalogTask;
  const plain = (async (): Promise<{ images: string[]; source: ImageCatalog["source"] }> => {
    try {
      const listed = (await fetchJson(`${GAME_RES_ROOT}/__list`)) as { images?: unknown };
      if (isStringArray(listed.images)) return { images: listed.images, source: "list" };
    } catch {
      /* dev 中间件不在 → 走清单文件（生产） */
    }
    const manifest = (await fetchJson(`${GAME_RES_ROOT}/image-manifest.json`)) as { images?: unknown };
    if (!isStringArray(manifest.images)) {
      throw new Error("图片清单格式不对（images 不是字符串数组）");
    }
    return { images: manifest.images, source: "manifest" };
  })();
  catalogTask = plain
    // 目录集跟着清单一起建好：几万条路径也只扫一遍，选择器与字段预览共用
    .then((data) => ({ ...data, index: indexCatalog(data.images) }))
    .catch((error: unknown) => {
      // 失败丢弃缓存：dev server 刚重启完 / 素材目录刚拉到，再打开一次应该能成功
      catalogTask = null;
      throw error;
    });
  return catalogTask;
}

/** 清缓存（素材刚更新、不想重启 dev server 时点「重新扫描」） */
export function invalidateImageCatalog(): void {
  catalogTask = null;
}

/** 去掉首尾斜杠，统一成「目录前缀」（不带尾斜杠） */
function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

/**
 * 候选网格（搜索 + 分组 + 缩略图）—— 没有弹窗外壳
 *
 * 分组 = 相对 `rootDir` 的第一段目录（如 rootDir=`item` 时，`item/potion/xxx` 归到 `potion`）；
 * 平铺目录（全部直接躺在 rootDir 下）没有分组条 —— 一条「全部」的筛选栏只是噪音。
 *
 * 每一项带 `thumb`：能不能出缩略图。不能 = 纯目录（外观那种「只有动作子目录」的一套），
 * 画文件夹图标并标出里面的文件数 —— 让「图集目录」和「素材缺失」一眼可分。
 */
function ImagePickerList({
  images,
  index,
  rootDir,
  mode,
  current,
  onPick,
  max = 240,
}: {
  images: string[];
  /** 清单索引（文件集 / 目录集），由 `loadImageCatalog` 一并建好 */
  index: CatalogIndex;
  /** 只看这个目录下的图（空 = 全部） */
  rootDir?: string;
  mode: ImagePickMode;
  current?: string;
  onPick: (path: string) => void;
  /** 渲染上限：素材目录动辄几万张，一次性铺完会卡住主线程 */
  max?: number;
}) {
  const [keyword, setKeyword] = useState("");
  const [group, setGroup] = useState<string | null>(null);

  const prefix = rootDir ? `${trimSlashes(rootDir)}/` : "";

  /**
   * 候选集
   *
   * - 图标模式：一项 = 一个清单项，选中值就是它；
   * - 动画模式：一项 = `rootDir` 下的一套（按第一段归并、去重），选中值是**锚点 + 第一段**。
   *   归并是必须的 —— 否则外观 `clothes/out/001` 会铺出几十个动作目录（`001/a1`、
   *   `001/attack_far` …）让运营以为要挑其中一个。
   */
  const candidates = useMemo(() => {
    const scoped = prefix ? images.filter((path) => path.startsWith(prefix)) : images;
    if (mode === "image" || !prefix) {
      return scoped.map((path) => ({
        path,
        value: path,
        name: path.slice(path.lastIndexOf("/") + 1),
        thumb: true,
        files: 1,
      }));
    }
    const seen = new Set<string>();
    const counts = new Map<string, number>();
    const rows: { path: string; value: string; name: string; thumb: boolean; files: number }[] = [];
    for (const path of scoped) {
      const segment = firstSegmentOf(path.slice(prefix.length));
      const value = `${trimSlashes(rootDir ?? "")}/${segment}`;
      counts.set(value, (counts.get(value) ?? 0) + 1);
      if (seen.has(value)) continue;
      seen.add(value);
      rows.push({ path, value, name: segment, thumb: kindOf(value, index) === "file", files: 0 });
    }
    // 文件数要等整目录扫完才知道：第二遍补上（只补「一套」的行，量级是个位数）
    for (const row of rows) row.files = counts.get(row.value) ?? row.files;
    return rows;
    // index 与 images 是一份清单的两半，同进同出
  }, [images, index, prefix, mode, rootDir]);

  /** 相对 rootDir 的路径（分组用） */
  const relativeOf = (path: string): string => (prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path);

  // atlas 模式不分组：每套动画就是一个目录，按目录分组等于「每组一项」，筛选栏只会比列表更长
  const groups = useMemo(() => {
    if (mode === "atlas") return [];
    const names = new Set<string>();
    for (const { path } of candidates) {
      const relative = relativeOf(path);
      const slash = relative.indexOf("/");
      if (slash > 0) names.add(relative.slice(0, slash));
    }
    return Array.from(names).sort();
    // relativeOf 依赖 prefix，prefix 已在依赖里
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates, prefix, mode]);

  const filtered = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    return candidates.filter(({ path }) => {
      const relative = relativeOf(path);
      if (group && !relative.startsWith(`${group}/`)) return false;
      if (needle && !path.toLowerCase().includes(needle)) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates, keyword, group, prefix]);

  const shown = filtered.slice(0, max);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          autoFocus
          value={keyword}
          placeholder={prefix ? `在 ${trimSlashes(rootDir ?? "")}/ 里搜路径…` : "搜路径…"}
          aria-label="搜索图片"
          onChange={(event) => setKeyword(event.target.value)}
        />
        {groups.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            <GroupChip active={group === null} onClick={() => setGroup(null)}>
              全部 {candidates.length}
            </GroupChip>
            {groups.map((name) => (
              <GroupChip key={name} active={group === name} onClick={() => setGroup(name)}>
                {name}
              </GroupChip>
            ))}
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <p className="py-8 text-center text-xs text-slate-500">
            {candidates.length === 0
              ? mode === "atlas"
                ? "这个目录下没有动画资源"
                : "这个目录下没有图片"
              : "没有匹配的图片"}
          </p>
        ) : (
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
            {shown.map(({ path, value, name, thumb, files }) => {
              const active = current === value;
              return (
                <button
                  key={path}
                  type="button"
                  title={thumb ? value : `${value}/ （目录 · ${files} 个文件）`}
                  onClick={() => onPick(value)}
                  className={`flex flex-col items-center gap-1 rounded-lg border p-1.5 transition ${
                    active
                      ? "border-indigo-500 bg-indigo-500/10"
                      : "border-slate-800 bg-slate-900/60 hover:border-slate-600 hover:bg-slate-800/60"
                  }`}
                >
                  {/*
                    能出缩略图的画图（图集取首帧：它可能就是一张整张拼图，直接 <img> 看不出是什么）；
                    纯目录画文件夹 —— 外观那种一套八个方向子目录、本体没有单张封面，
                    以前会显示灰字「无图」，看起来像素材缺了。
                  */}
                  {!thumb ? (
                    <FolderGlyph size={44} />
                  ) : mode === "atlas" ? (
                    <GameFrame atlas={value} alt={name} size={44} zoomable={false} />
                  ) : (
                    <GameIcon path={value} alt={name} size={44} zoomable={false} />
                  )}
                  <span className="w-full truncate text-center text-[10px] text-slate-400">{name}</span>
                  {!thumb ? <span className="text-[9px] text-amber-300/70">{files} 个文件</span> : null}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <p className="text-[11px] text-slate-600">
        共 {filtered.length} 项
        {filtered.length > max ? `，只画了前 ${shown.length} 项 —— 用搜索或分组缩小范围` : ""}
      </p>
    </div>
  );
}

function GroupChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-2 py-1 text-[11px] transition ${
        active ? "bg-indigo-500 text-white" : "bg-slate-800/70 text-slate-300 hover:bg-slate-700"
      }`}
    >
      {children}
    </button>
  );
}

/** 目录占位：一套图集是**目录**，本体没有单张封面 —— 画文件夹比画一格「无图」诚实 */
function FolderGlyph({ size = 44 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex items-center justify-center rounded border border-slate-800 bg-slate-900/60 text-amber-300/75"
      style={{ width: size, height: size }}
    >
      <svg
        viewBox="0 0 24 24"
        width={size * 0.52}
        height={size * 0.52}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3.5 7.6a2 2 0 0 1 2-2h3.1c.55 0 1.07.23 1.45.63l1.05 1.12h6.4a2 2 0 0 1 2 2v6.05a2 2 0 0 1-2 2h-12a2 2 0 0 1-2-2V7.6Z" />
      </svg>
    </span>
  );
}

/**
 * 动画模式下这个值在磁盘上是什么（`null` = 还没问到清单 —— 先按原行为画缩略图）
 *
 * 清单拉不到 / 不是动画模式时返回 `null`：不该因为接口挂了，字段预览就全变成文件夹。
 */
function usePathKind(value: string, mode: ImagePickMode): PathKind | null {
  const [kind, setKind] = useState<PathKind | null>(null);
  useEffect(() => {
    if (!value || mode !== "atlas") {
      setKind(null);
      return;
    }
    let cancelled = false;
    loadImageCatalog()
      .then((catalog) => {
        if (!cancelled) setKind(kindOf(value, catalog.index));
      })
      .catch(() => {
        /* 清单拿不到就维持原行为 */
      });
    return () => {
      cancelled = true;
    };
  }, [value, mode]);
  return kind;
}

/**
 * 图片选择弹窗：受控开合，选中即回调并关闭
 *
 * `value` 传当前值（高亮用），`onSelect` 收到的是 resources 相对路径（不带扩展名）——
 * 正是数据库 `icon` 字段要存的东西。`mode="atlas"` 时收到的是**图集目录**（`animation` /
 * 内观 / 外观 / NPC `src` 的存法）。清空不在这里做：调用方保留输入框，清空就是删掉路径。
 */
export function ImagePicker({
  open,
  title,
  hint,
  rootDir,
  mode = "image",
  value,
  onSelect,
  onClose,
}: {
  open: boolean;
  title: string;
  hint?: string;
  /** 只看这个目录下的图（如药品图标传 `item`） */
  rootDir?: string;
  /** 挑一张图还是一个图集目录（默认一张图） */
  mode?: ImagePickMode;
  /** 当前值（高亮） */
  value?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [catalog, setCatalog] = useState<ImageCatalog | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // 每次打开 / 点「重新扫描」都重新拉（素材可能在两次打开之间更新过）
  const [reloadKey, setReloadKey] = useState(0);

  // 开着的选择器数量（`pickerStack`）：编辑弹窗靠 `anyPickerOpen()` 判断「Esc 该不该放行」
  usePickerStackEntry(open);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    // 每次打开都重新拉：运营的典型动作是「往 resources 里放完图，回来挑」——
    // 缓存住上一次的清单就会看不到新图，还得记得点「重新扫描」（契约上不要求人记得）
    invalidateImageCatalog();
    loadImageCatalog()
      .then((data) => {
        if (!cancelled) setCatalog(data);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, reloadKey]);

  const refresh = () => {
    invalidateImageCatalog();
    setReloadKey((key) => key + 1);
  };

  return (
    <Modal
      open={open}
      title={title}
      hint={
        hint ??
        (mode === "atlas"
          ? "点一套即选中（存的是图集**目录**）。来源是客户端素材目录（开发直读 client/assets/resources；生产读 image-manifest.json）。"
          : "点一张即选中。来源是客户端素材目录（开发直读 client/assets/resources；生产读 image-manifest.json）。")
      }
      size="xl"
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-[11px] text-slate-500">
            {catalog
              ? catalog.source === "list"
                ? "开发模式：直接扫本地素材目录"
                : "生产模式：读落盘清单（素材更新后跑 make image-manifest）"
              : ""}
          </span>
          <Button variant="outline" onClick={refresh} loading={loading}>
            重新扫描
          </Button>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
        </>
      }
    >
      {error ? (
        <div className="rounded-lg border border-amber-700/50 bg-amber-500/10 p-3 text-xs text-amber-200">
          <p className="font-medium">拿不到图片清单：{error}</p>
          <p className="mt-1 text-amber-200/80">
            开发环境确认 <code className="font-mono">client/assets/resources</code> 已就位（README 的「资源同步」）；
            生产环境确认素材包里带了 <code className="font-mono">image-manifest.json</code>（make image-manifest）。
          </p>
        </div>
      ) : loading && !catalog ? (
        <div className="flex items-center justify-center py-12">
          <Spinner />
        </div>
      ) : catalog ? (
        <ImagePickerList
          images={catalog.images}
          index={catalog.index}
          rootDir={rootDir}
          mode={mode}
          current={value}
          onPick={(path) => {
            onSelect(path);
            onClose();
          }}
        />
      ) : null}
    </Modal>
  );
}

/**
 * 图标 / 动画资源字段：缩略预览 + 路径输入 + 「选择图片」按钮（选择器内嵌，不用父级接线）
 *
 * 为什么要这么一层：管理端有十来处「填一个 resources 路径」的字段（物品、装备、技能、状态、
 * NPC、部位底图、称号 / 战魂 / 军衔动画、时装…）。每处都手写「预览 + 输入框 + 按钮 + 弹窗 +
 * Esc 放行」的话，第一个漏写的页面就是「运营点不开选择器」或者「选完把编辑弹窗一起关了」。
 * 这里做一次，调用方只留 `<IconField …/>`。
 *
 * 手填路径仍然保留（输入框就在那儿）：素材还没进客户端时可以先填上，或者粘贴一批同目录的值。
 */
export function IconField({
  label,
  hint,
  value,
  onChange,
  rootDir,
  mode = "image",
  placeholder,
  pickerTitle,
  disabled = false,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (path: string) => void;
  /** 只看这个目录（图标填 `item`；动画填锚点，如 `clothes/out`） */
  rootDir?: string;
  /** 挑一张图还是一套动画资源（见 `ImagePickMode`） */
  mode?: ImagePickMode;
  placeholder?: string;
  /** 选择器标题（默认「选择<label>」） */
  pickerTitle?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const kind = usePathKind(value, mode);
  return (
    <>
      <Field label={label} hint={hint}>
        <div className="flex items-center gap-2">
          {/*
            预览随模式走：图标看这张图；动画看首帧。有图集本体的（`titles/x/x.png`）出首帧，
            纯目录的（外观那种「按动作 / 方向分子目录」）画文件夹 —— 以前这里显示「无图」，
            看着像素材丢了。清单还没问到 / 拉不到时按原行为走，不硬改。
          */}
          {mode === "atlas" && kind === "folder" ? (
            <FolderGlyph size={36} />
          ) : mode === "atlas" ? (
            <GameFrame atlas={value} alt={label} size={36} zoomable={false} />
          ) : (
            <GameIcon path={value} alt={label} size={36} zoomable={false} />
          )}
          <Input
            className="flex-1"
            value={value}
            placeholder={placeholder ?? (mode === "atlas" ? "图集资源基名" : "path/to/image")}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
          <Button variant="outline" className="shrink-0" disabled={disabled} onClick={() => setOpen(true)}>
            选择图片
          </Button>
        </div>
      </Field>
      {open ? (
        <ImagePicker
          open
          title={pickerTitle ?? `选择${label}`}
          rootDir={rootDir}
          mode={mode}
          value={value}
          onSelect={onChange}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
