import { useEffect, useMemo, useState } from "react";
import { GAME_RES_ROOT, GameIcon } from "./GameImage";
import { Modal } from "./Modal";
import { Button, Input, Spinner } from "./ui";

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
 * ## 与 EntityPicker 的分工
 * 那个挑的是**游戏数据行**（装备 / 技能 / 物品的 id，带名字与说明）；
 * 这个挑的是**素材文件**（路径本身就是要存的值，没有名字可显示）。两者都复用 `Modal`，
 * 关闭行为（Esc / 点遮罩）不会各写一套。
 */

type ImageCatalog = { images: string[]; source: "list" | "manifest" };

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
  catalogTask = (async (): Promise<ImageCatalog> => {
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
  })().catch((error: unknown) => {
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
 */
function ImagePickerList({
  images,
  rootDir,
  current,
  onPick,
  max = 240,
}: {
  images: string[];
  /** 只看这个目录下的图（空 = 全部） */
  rootDir?: string;
  current?: string;
  onPick: (path: string) => void;
  /** 渲染上限：素材目录动辄几万张，一次性铺完会卡住主线程 */
  max?: number;
}) {
  const [keyword, setKeyword] = useState("");
  const [group, setGroup] = useState<string | null>(null);

  const prefix = rootDir ? `${trimSlashes(rootDir)}/` : "";

  const scoped = useMemo(
    () => (prefix ? images.filter((path) => path.startsWith(prefix)) : images),
    [images, prefix],
  );

  /** 相对 rootDir 的路径（分组与显示名都用它） */
  const relativeOf = (path: string): string => (prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path);

  const groups = useMemo(() => {
    const names = new Set<string>();
    for (const path of scoped) {
      const relative = relativeOf(path);
      const slash = relative.indexOf("/");
      if (slash > 0) names.add(relative.slice(0, slash));
    }
    return Array.from(names).sort();
    // relativeOf 依赖 prefix，prefix 已在依赖里
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoped, prefix]);

  const filtered = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    return scoped.filter((path) => {
      const relative = relativeOf(path);
      if (group && !relative.startsWith(`${group}/`)) return false;
      if (needle && !path.toLowerCase().includes(needle)) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoped, keyword, group, prefix]);

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
              全部 {scoped.length}
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
            {scoped.length === 0 ? "这个目录下没有图片" : "没有匹配的图片"}
          </p>
        ) : (
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
            {shown.map((path) => {
              const active = current === path;
              const name = relativeOf(path).split("/").pop() ?? path;
              return (
                <button
                  key={path}
                  type="button"
                  title={path}
                  onClick={() => onPick(path)}
                  className={`flex flex-col items-center gap-1 rounded-lg border p-1.5 transition ${
                    active
                      ? "border-indigo-500 bg-indigo-500/10"
                      : "border-slate-800 bg-slate-900/60 hover:border-slate-600 hover:bg-slate-800/60"
                  }`}
                >
                  <GameIcon path={path} alt={name} size={44} zoomable={false} />
                  <span className="w-full truncate text-center text-[10px] text-slate-400">{name}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <p className="text-[11px] text-slate-600">
        共 {filtered.length} 项
        {filtered.length > shown.length ? `，只画了前 ${shown.length} 项 —— 用搜索或分组缩小范围` : ""}
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

/**
 * 图片选择弹窗：受控开合，选中即回调并关闭
 *
 * `value` 传当前值（高亮用），`onSelect` 收到的是 resources 相对路径（不带扩展名）——
 * 正是数据库 `icon` 字段要存的东西。清空不在这里做：调用方保留输入框，清空就是删掉路径。
 */
export function ImagePicker({
  open,
  title,
  hint,
  rootDir,
  value,
  onSelect,
  onClose,
}: {
  open: boolean;
  title: string;
  hint?: string;
  /** 只看这个目录下的图（如药品图标传 `item`） */
  rootDir?: string;
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
        "点一张即选中。来源是客户端素材目录（开发直读 client/assets/resources；生产读 image-manifest.json）。"
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
          rootDir={rootDir}
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
