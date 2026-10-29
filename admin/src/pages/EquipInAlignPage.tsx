import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { Button, Field, Input, Spinner } from "../components/ui";
import catalogJson from "../data/equip-align.catalog.json";
import type { Atlas } from "./equipAlign/atlas";
import { firstFrameName, measureSolid } from "./equipAlign/atlas";
import { loadInAtlas, probeInAtlas } from "./equipAlign/assets";
import type { InGeometry, Vec2 } from "./equipAlignIn/model";
import {
  boxToScreen,
  contentBox,
  fitWeaponToBody,
  handAnchorOf,
  isDirty,
  itemsFromCatalog,
  nudge as nudgeGeometry,
  round2,
  scaleBy,
  snapFeetToPlate,
  viewOfBackground,
} from "./equipAlignIn/model";
import type { InGuides, InLayer } from "./equipAlignIn/render";
import { drawInShow, layerSolid } from "./equipAlignIn/render";
import { useInAlignStore } from "./equipAlignIn/saved";

/**
 * 内观对齐工作台（#523）
 *
 * ===========================================================================
 * 这个页面解决什么
 * ===========================================================================
 * 角色信息弹窗里的那套内观（衣服 + 武器站在圆盘上）只有两种摆法，都不准：
 * 衣服的 `inPosition` 是手写常量（画布 212×375 ~ 420×420，写死一个值只能对上一件）；
 * 武器的 `inPosition` 干脆是死字段 —— `RoleInShowView` 每次按**当前穿的衣服**现算，
 * 换件衣服武器就换落点。
 *
 * 所以这里把判断权交回人眼，并且**规定了两个基准**（这是用户定的，不是实现挑的）：
 * - **衣服对着圆盘调**：底图就是弹窗背景（`common/personal-information-bg`），圆盘中心
 *   就是「脚该踩的地方」；
 * - **武器对着第一件衣服调**：参照系固定为清单里的第一件衣服（`inShow.baseClothKey`），
 *   19 把武器共用同一个参照，不跟当前选中的衣服漂 —— 这样运行时它们才不会跟着换装跳动。
 *
 * ===========================================================================
 * 与外观工作台的关系
 * ===========================================================================
 * 同一套路（三份真相 + 保存直连服务端）：
 *   页面临时改动（localStorage）> 服务端已保存 > catalog.json（出厂值）
 * 但**数据与接口完全独立**（`equip_in_aligns` 表 / `adminEquipInAlign`）：
 * 重置内观不该顺手把外观也清掉。
 *
 * 内观**没有导出 / 导入 JSON**：全表 31 行、每行三个数，定稿时手工抄进
 * `configs/equipments.ts` 比维护一条导入链路更直接（外观那边 8×33 个数字才需要脚本）。
 */

interface CatalogInShow {
  background: { image: string; position: Vec2; size: [number, number] };
  plate: { center: Vec2; radius: number };
  baseClothKey: string;
}

interface Catalog {
  generatedBy: string;
  directions: string[];
  inShow: CatalogInShow;
  clothes: { key: string; label: string; in?: string; inScale: [number, number]; inPosition: Vec2 }[];
  weapons: { key: string; label: string; in?: string; inScale: [number, number]; inPosition: Vec2 }[];
}

const CATALOG = catalogJson as unknown as Catalog;
const IN_SHOW = CATALOG.inShow;

/**
 * 条目：衣服与武器的 `manual` 缺省值不同（衣服恒为绝对位置，武器出厂是「自动算」），
 * 所以分两次生成，不能一次生成后按 kind 改。
 */
const CLOTH_ITEMS = itemsFromCatalog({ clothes: CATALOG.clothes, weapons: [] }, true).clothes;
const WEAPON_ITEMS = itemsFromCatalog({ clothes: [], weapons: CATALOG.weapons }, false).weapons;
const ITEMS_BY_KIND = { cloth: CLOTH_ITEMS, weapon: WEAPON_ITEMS } as const;
const ALL_ITEMS = [...CLOTH_ITEMS, ...WEAPON_ITEMS];

/** 参照衣服：清单里的第一件（找不到就退回「第一件有内观素材的衣服」） */
const BASE_CLOTH =
  ITEMS_BY_KIND.cloth.find((item) => item.key === IN_SHOW.baseClothKey) ?? ITEMS_BY_KIND.cloth[0] ?? null;

const KIND_LABELS = { cloth: "衣服", weapon: "武器" } as const;
type Kind = keyof typeof KIND_LABELS;

const DRAFT_KEY = "olua.equipInAlign.drafts.v1";
const PREFS_KEY = "olua.equipInAlign.prefs.v1";

const DEFAULT_GUIDES: InGuides = {
  background: true,
  plate: true,
  canvas: false,
  content: false,
  solid: true,
  hands: true,
  origin: false,
};

interface Prefs {
  resRoot: string;
  guides: InGuides;
}

const DEFAULT_PREFS: Prefs = { resRoot: "/game-resources", guides: DEFAULT_GUIDES };

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as T) };
  } catch {
    return fallback;
  }
}

/** 内观图集缓存（Atlas 是几 MB 的 Image，不进 React state；用 version 触发重绘） */
function useInAtlases(resRoot: string) {
  const cache = useRef(new Map<string, Atlas>());
  const pending = useRef(new Map<string, Promise<void>>());
  const [version, setVersion] = useState(0);
  const [failed, setFailed] = useState<Record<string, string>>({});

  useEffect(() => {
    cache.current.clear();
    pending.current.clear();
    setFailed({});
    setVersion((value) => value + 1);
  }, [resRoot]);

  const request = useCallback(
    (inPath: string | null): Atlas | null => {
      if (!inPath) return null;
      const key = `${resRoot}|${inPath}`;
      const hit = cache.current.get(key);
      if (hit) return hit;
      if (!pending.current.has(key)) {
        const task = loadInAtlas(resRoot, inPath)
          .then((atlas) => {
            cache.current.set(key, atlas);
          })
          .catch((error: unknown) => {
            setFailed((prev) => ({ ...prev, [key]: error instanceof Error ? error.message : String(error) }));
          })
          .then(() => {
            pending.current.delete(key);
            setVersion((value) => value + 1);
          });
        pending.current.set(key, task);
      }
      return null;
    },
    [resRoot],
  );

  return { request, version, failed };
}

/** 弹窗背景图（一张大图，单独缓存；路径拼法与内观图集一致） */
function useBackgroundImage(resRoot: string, image: string): HTMLImageElement | null {
  const url = image ? `${resRoot.replace(/\/+$/, "")}/${image.replace(/^\/+/, "")}.png` : "";
  const [loaded, setLoaded] = useState<{ url: string; image: HTMLImageElement } | null>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setLoaded({ url, image: img });
    };
    img.onerror = () => {
      if (!cancelled) setLoaded(null);
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [url]);
  return loaded && loaded.url === url ? loaded.image : null;
}

export function EquipInAlignPage() {
  const [prefs, setPrefs] = useState<Prefs>(() => readJson(PREFS_KEY, DEFAULT_PREFS));
  const [drafts, setDrafts] = useState<Record<string, InGeometry>>(() => readJson(DRAFT_KEY, {} as Record<string, InGeometry>));
  const [kind, setKind] = useState<Kind>("cloth");
  const [activeId, setActiveId] = useState<string>(() => ALL_ITEMS[0]?.id ?? "");
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");

  const {
    saved,
    loading: loadingSaved,
    error: savedError,
    pending,
    save: saveAlign,
    reset: resetAlign,
    reload: reloadSaved,
    clearError,
  } = useInAlignStore();

  const { request, version, failed } = useInAtlases(prefs.resRoot);
  const backgroundImage = useBackgroundImage(prefs.resRoot, IN_SHOW.background.image);

  /** 「缺素材」只在列表上打标记：`resources/` 是 gitignore 的，不能写进生成的清单 */
  const [missing, setMissing] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    let cancelled = false;
    setMissing(new Set());
    const paths = [...new Set(ALL_ITEMS.map((item) => item.inPath).filter(Boolean))];
    void (async () => {
      const gone: string[] = [];
      for (const inPath of paths) {
        if (cancelled) return;
        if (!(await probeInAtlas(prefs.resRoot, inPath))) gone.push(inPath);
      }
      if (!cancelled) setMissing(new Set(gone));
    })();
    return () => {
      cancelled = true;
    };
  }, [prefs.resRoot]);

  // ---- 持久化 ----
  useEffect(() => {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  }, [prefs]);
  useEffect(() => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts));
  }, [drafts]);

  const items = ITEMS_BY_KIND[kind];
  const visibleItems = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return items;
    return items.filter((item) => item.key.toLowerCase().includes(keyword) || item.label.toLowerCase().includes(keyword));
  }, [items, search]);

  const activeItem = useMemo(() => ALL_ITEMS.find((item) => item.id === activeId) ?? ALL_ITEMS[0], [activeId]);

  /** 基线：服务端存过就用服务端的，否则用 catalog 的出厂值 */
  const baseOf = useCallback((item: (typeof ALL_ITEMS)[number]): InGeometry => saved[item.id] ?? item.base, [saved]);

  const geometry = drafts[activeItem.id] ?? baseOf(activeItem);
  const unsaved = isDirty(geometry, baseOf(activeItem));

  const baseGeometry = BASE_CLOTH ? drafts[BASE_CLOTH.id] ?? baseOf(BASE_CLOTH) : null;
  const itemAtlas = request(activeItem.inPath);
  const baseAtlas = BASE_CLOTH ? request(BASE_CLOTH.inPath) : null;

  const dirtyCount = useMemo(
    () => ALL_ITEMS.filter((item) => isDirty(drafts[item.id] ?? saved[item.id] ?? item.base, item.base)).length,
    [drafts, saved],
  );
  const unsavedIds = useMemo(
    () => ALL_ITEMS.filter((item) => isDirty(drafts[item.id] ?? saved[item.id] ?? item.base, saved[item.id] ?? item.base)).map((item) => item.id),
    [drafts, saved],
  );

  const patchGeometry = useCallback(
    (updater: (current: InGeometry) => InGeometry) => {
      setDrafts((prev) => {
        const current = prev[activeItem.id] ?? baseOf(activeItem);
        return { ...prev, [activeItem.id]: updater(current) };
      });
      clearError();
    },
    [activeItem, baseOf, clearError],
  );

  /**
   * 人动过 = 你在给**绝对值**：武器顺手把「手调」打开
   *
   * 不这么做的话，拖完点保存，服务端存下的是一份**客户端根本不会读**的数字 ——
   * `inManual = false` 时 `RoleInShowView.alignWeapon()` 仍按当前衣服的内容 bbox 现算，
   * 症状就是「保存了但内观没动」，而且从页面到接口都看不出哪里错（#527 的起因）。
   * 衣服没有运行时算法，`manual` 对它无意义，所以只对武器生效。
   */
  const patchUserGeometry = useCallback(
    (updater: (current: InGeometry) => InGeometry) => {
      patchGeometry((current) => {
        const next = updater(current);
        return activeItem.kind === "weapon" && next.manual !== true ? { ...next, manual: true } : next;
      });
    },
    [patchGeometry, activeItem.kind],
  );

  // ---- 画布 ----
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = useState(720);
  const drag = useRef<{ startX: number; startY: number; pos: Vec2 } | null>(null);

  useLayoutEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node);
    setWidth(node.clientWidth);
    return () => observer.disconnect();
  }, []);

  const view = useMemo(() => viewOfBackground(IN_SHOW.background), []);
  /** 1 游戏单位 = 多少像素（视图宽度铺满容器） */
  const k = width / view.width;
  const canvasHeight = view.height * k;

  const itemFrameName = useMemo(() => (itemAtlas ? firstFrameName(itemAtlas) : ""), [itemAtlas]);
  const baseFrameName = useMemo(() => (baseAtlas ? firstFrameName(baseAtlas) : ""), [baseAtlas]);

  const itemLayer: InLayer | null = useMemo(
    () => (itemAtlas && itemFrameName ? { atlas: itemAtlas, frameName: itemFrameName, geometry } : null),
    [itemAtlas, itemFrameName, geometry],
  );
  const baseLayer: InLayer | null = useMemo(
    () =>
      activeItem.kind === "weapon" && baseAtlas && baseFrameName && baseGeometry
        ? { atlas: baseAtlas, frameName: baseFrameName, geometry: baseGeometry, alpha: 0.5 }
        : null,
    [activeItem.kind, baseAtlas, baseFrameName, baseGeometry],
  );

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(canvasHeight * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${canvasHeight}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, canvasHeight);
    // 像素风素材：放大时不要平滑，边缘才锐利（也更容易看出位移）
    ctx.imageSmoothingEnabled = false;

    drawInShow({
      ctx,
      width,
      height: canvasHeight,
      view,
      k,
      backgroundImage,
      background: IN_SHOW.background,
      plate: IN_SHOW.plate,
      guides: prefs.guides,
      base: baseLayer,
      item: itemLayer,
    });
  }, [width, canvasHeight, view, k, backgroundImage, prefs.guides, baseLayer, itemLayer, version]);

  /** 屏幕坐标（相对 canvas） */
  const localPoint = (event: { clientX: number; clientY: number }): Vec2 => {
    const canvas = canvasRef.current;
    if (!canvas) return [0, 0];
    const box = canvas.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  };

  /** 当前对象的内容框（屏幕矩形）—— 拖动只从这里开始，避免整块画布都能拖 */
  const itemContentRect = useMemo(() => {
    if (!itemAtlas || !itemFrameName) return null;
    const frame = itemAtlas.frames.get(itemFrameName);
    if (!frame) return null;
    return boxToScreen(view, k, contentBox(frame, geometry));
  }, [itemAtlas, itemFrameName, geometry, view, k]);

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = localPoint(event);
    const content = itemContentRect;
    if (!content) return;
    const inside = point[0] >= content.x && point[0] <= content.x + content.w && point[1] >= content.y && point[1] <= content.y + content.h;
    if (!inside) return;
    drag.current = { startX: point[0], startY: point[1], pos: [geometry.inPosition[0], geometry.inPosition[1]] };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const active = drag.current;
    if (!active) return;
    const point = localPoint(event);
    const dx = (point[0] - active.startX) / k;
    const dy = (point[1] - active.startY) / k;
    patchUserGeometry((current) => ({
      ...current,
      inPosition: [round2(active.pos[0] + dx), round2(active.pos[1] - dy)],
    }));
  };

  const endDrag = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drag.current) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    patchUserGeometry((current) => scaleBy(current, -Math.sign(event.deltaY) * 0.02));
  };

  // ---- 键盘 ----
  const stepItem = useCallback(
    (delta: number) => {
      const index = ALL_ITEMS.findIndex((item) => item.id === activeItem.id);
      const next = ALL_ITEMS[(index + delta + ALL_ITEMS.length) % ALL_ITEMS.length];
      setActiveId(next.id);
      setKind(next.kind);
    },
    [activeItem.id],
  );

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      const step = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
      const actions: Record<string, () => void> = {
        ArrowLeft: () => patchUserGeometry((current) => nudgeGeometry(current, -step, 0)),
        ArrowRight: () => patchUserGeometry((current) => nudgeGeometry(current, step, 0)),
        ArrowUp: () => patchUserGeometry((current) => nudgeGeometry(current, 0, step)),
        ArrowDown: () => patchUserGeometry((current) => nudgeGeometry(current, 0, -step)),
        "[": () => stepItem(-1),
        "]": () => stepItem(1),
        "-": () => patchUserGeometry((current) => scaleBy(current, -0.02)),
        "=": () => patchUserGeometry((current) => scaleBy(current, 0.02)),
      };
      const action = actions[event.key];
      if (action) {
        action();
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [patchUserGeometry, stepItem]);

  // ---- 操作 ----
  const dropDraft = (id: string) => {
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const saveActive = async () => {
    if (pending) return;
    const ok = await saveAlign(activeItem.id, geometry);
    if (!ok) return;
    dropDraft(activeItem.id);
    setNotice(`已保存「${activeItem.label}」—— 客户端重开角色信息弹窗即生效`);
  };

  /**
   * 还原本件：先删服务端、再清本地
   *
   * 顺序不能反 —— 反过来会有一瞬间「本地没了但服务端还在」，刷新页面那件又跳回旧位置。
   */
  const resetItem = async () => {
    if (pending) return;
    if (saved[activeItem.id]) {
      const ok = await resetAlign(activeItem.id);
      if (!ok) return;
    }
    dropDraft(activeItem.id);
    setNotice(`已把「${activeItem.label}」还原成出厂值`);
  };

  const saveAll = async () => {
    if (pending || !unsavedIds.length) return;
    let done = 0;
    const failed: string[] = [];
    for (const id of unsavedIds) {
      const item = ALL_ITEMS.find((entry) => entry.id === id);
      if (!item) continue;
      const ok = await saveAlign(id, drafts[id] ?? baseOf(item));
      if (ok) {
        done += 1;
        dropDraft(id);
      } else {
        failed.push(id);
      }
    }
    setNotice(failed.length ? `已保存 ${done} 件，失败 ${failed.length} 件：${failed.join("、")}` : `已保存 ${done} 件`);
  };

  /** 衣服：把可见轮廓的底边中点按到圆盘中心（换素材 / 改缩放后按一下，比手算靠谱） */
  const snapToPlate = () => {
    if (!itemLayer) return;
    const solid = layerSolid(itemLayer);
    if (!solid) {
      setNotice("量不到轮廓（素材缺帧？）");
      return;
    }
    patchGeometry((current) => {
      const box = layerSolid({ ...itemLayer, geometry: current });
      return box ? snapFeetToPlate(current, box, IN_SHOW.plate.center) : current;
    });
    setNotice("已把轮廓底边按到圆盘中心，再微调到顺眼");
  };

  /**
   * 武器：按**第一件衣服**的轮廓给一个初值（缩放到它高度的 1.15 倍、贴到左手位）
   *
   * 与客户端 `placeInShowWeapon` 同口径，但用轮廓而不是裁剪框（影子不参与）。
   * 这是「对着第一件衣服调」的起点，剩下的靠人眼收；同时把 `manual` 打开 ——
   * 不打开的话运行时还是自动算，这三步就白调了。
   */
  const fitToBaseCloth = () => {
    if (!itemAtlas || !itemFrameName) return;
    const frame = itemAtlas.frames.get(itemFrameName);
    const solid = measureSolid(itemAtlas, itemFrameName);
    if (!frame || !solid) {
      setNotice("量不到武器轮廓（素材缺帧？）");
      return;
    }
    if (!baseLayer) {
      setNotice("没有参照衣服（清单里第一件衣服缺内观素材），先补素材");
      return;
    }
    const bodySolid = layerSolid(baseLayer);
    if (!bodySolid) {
      setNotice("量不到参照衣服的轮廓（素材缺帧？）");
      return;
    }
    const fitted = fitWeaponToBody(bodySolid, frame, solid, true);
    patchGeometry((current) => ({ ...current, ...fitted, manual: true }));
    setNotice("已按第一件衣服给出初值（并打开手调），再微调到顺眼");
  };

  /** 当前对象的轮廓底边相对圆盘中心的偏移（正 = 悬空，负 = 陷进盘里） */
  const feetDelta = useMemo(() => {
    if (!itemLayer) return null;
    const solid = layerSolid(itemLayer);
    return solid ? solid.cy - solid.h / 2 - IN_SHOW.plate.center[1] : null;
  }, [itemLayer]);

  const handPoint = useMemo(() => {
    const layer = baseLayer ?? itemLayer;
    if (!layer) return null;
    const solid = layerSolid(layer);
    return solid ? handAnchorOf(solid, true) : null;
  }, [baseLayer, itemLayer]);

  const failures = Object.values(failed);
  const currentPos = geometry.inPosition;

  return (
    <div className="flex flex-col gap-4">
      {/* 顶部：资源根 + 基准 + 保存 */}
      <section className="flex flex-wrap items-end gap-3 rounded-2xl border border-slate-800 bg-slate-900/40 px-5 py-4">
        <Field label="资源根（指向游戏站的 resources）">
          <Input
            className="w-64"
            value={prefs.resRoot}
            onChange={(event) => setPrefs((prev) => ({ ...prev, resRoot: event.target.value }))}
            placeholder="/game-resources"
          />
        </Field>
        <Field label="衣服基准">
          <div className="rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm text-slate-300">
            弹窗圆盘（背景图）
          </div>
        </Field>
        <Field label="武器基准">
          <div className="rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm text-slate-300">
            第一件衣服 · {BASE_CLOTH ? BASE_CLOTH.label : "（缺素材）"}
          </div>
        </Field>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-500">
            已保存 {Object.keys(saved).length} 件 · 调过 {dirtyCount} / {ALL_ITEMS.length}
            {unsavedIds.length ? <span className="ml-1 text-amber-400">· {unsavedIds.length} 件未保存</span> : null}
          </span>
          <Button variant="primary" onClick={saveAll} loading={Boolean(pending)} disabled={!unsavedIds.length || loadingSaved}>
            {`保存全部${unsavedIds.length ? `（${unsavedIds.length}）` : ""}`}
          </Button>
          <Button variant="outline" onClick={reloadSaved} disabled={loadingSaved || Boolean(pending)}>
            重新读取
          </Button>
        </div>
      </section>

      {savedError ? (
        <div className="flex items-start gap-3 rounded-xl border border-rose-900/60 bg-rose-950/30 px-4 py-3 text-xs text-rose-300">
          <span className="flex-1">{savedError}</span>
          <button className="shrink-0 underline" onClick={clearError}>
            知道了
          </button>
        </div>
      ) : null}

      {loadingSaved ? (
        <div className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-2 text-xs text-slate-400">
          <Spinner className="h-3 w-3" /> 正在读取服务端已保存的内观几何…
        </div>
      ) : null}

      {failures.length ? (
        <div className="rounded-xl border border-rose-900/60 bg-rose-950/30 px-4 py-3 text-xs text-rose-300">
          {failures.slice(0, 3).map((message) => (
            <div key={message}>{message}</div>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-3 xl:flex-row">
        {/* 左栏：条目 */}
        <aside className="w-full shrink-0 xl:w-52">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-3">
            <div className="mb-2 flex gap-1">
              {(["cloth", "weapon"] as Kind[]).map((value) => (
                <button
                  key={value}
                  onClick={() => {
                    setKind(value);
                    const first = ITEMS_BY_KIND[value][0];
                    if (first) setActiveId(first.id);
                  }}
                  className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-medium transition ${
                    kind === value ? "bg-indigo-600 text-white" : "bg-slate-800/60 text-slate-300 hover:bg-slate-800"
                  }`}
                >
                  {KIND_LABELS[value]}
                </button>
              ))}
            </div>
            <Input placeholder="搜索名称 / key" value={search} onChange={(event) => setSearch(event.target.value)} />
            <div className="mt-2 max-h-[560px] overflow-auto">
              {visibleItems.map((item) => {
                const base = saved[item.id] ?? item.base;
                const geo = drafts[item.id] ?? base;
                const active = item.id === activeItem.id;
                const dirtyLocal = isDirty(geo, base);
                return (
                  <button
                    key={item.id}
                    onClick={() => setActiveId(item.id)}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition ${
                      active ? "bg-indigo-600/20 text-indigo-200" : "text-slate-300 hover:bg-slate-800/60"
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {item.label}
                      <span className="ml-1 text-slate-500">{item.key}</span>
                    </span>
                    {missing.has(item.inPath) ? <span className="text-amber-400">缺素材</span> : null}
                    {dirtyLocal ? <span className="text-amber-400" title="有未保存的改动">●</span> : null}
                    {isDirty(geo, item.base) ? <span className="text-emerald-400">调过</span> : null}
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        {/* 中间：弹窗视图 */}
        <div className="min-w-0 flex-1">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <span className="font-medium text-slate-200">
                {KIND_LABELS[activeItem.kind]} · {activeItem.label}
              </span>
              <span className="text-slate-500">{activeItem.inPath}</span>
              {!itemAtlas ? (
                <span className="flex items-center gap-1 text-amber-400">
                  <Spinner className="h-3 w-3" /> 素材加载中
                </span>
              ) : null}
              <span className="ml-auto">拖动 / 方向键微调 / 滚轮改缩放 / [ ] 切件</span>
            </div>
            <div ref={wrapRef} className="w-full">
              <canvas
                ref={canvasRef}
                className="block w-full cursor-grab touch-none rounded-xl bg-[#12141a] active:cursor-grabbing"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onWheel={onWheel}
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-500">
              {(["background", "plate", "canvas", "content", "solid", "hands", "origin"] as (keyof InGuides)[]).map((key) => (
                <label key={key} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={prefs.guides[key]}
                    onChange={(event) => setPrefs((prev) => ({ ...prev, guides: { ...prev.guides, [key]: event.target.checked } }))}
                  />
                  {{
                    background: "背景 / 圆盘图",
                    plate: "圆盘参考",
                    canvas: "画布框",
                    content: "裁剪框",
                    solid: "轮廓框",
                    hands: "手位",
                    origin: "弹窗原点",
                  }[key]}
                </label>
              ))}
            </div>
          </div>
        </div>

        {/* 右栏：数值 */}
        <aside className="w-full shrink-0 xl:w-64">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
            <div className="mb-3 text-sm font-semibold text-slate-100">
              {KIND_LABELS[activeItem.kind]} · {activeItem.label}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="X">
                <Input
                  aria-label="内观X"
                  type="number"
                  step="0.1"
                  value={currentPos[0]}
                  onChange={(event) =>
                    patchUserGeometry((current) => ({ ...current, inPosition: [Number(event.target.value) || 0, current.inPosition[1]] }))
                  }
                />
              </Field>
              <Field label="Y">
                <Input
                  aria-label="内观Y"
                  type="number"
                  step="0.1"
                  value={currentPos[1]}
                  onChange={(event) =>
                    patchUserGeometry((current) => ({ ...current, inPosition: [current.inPosition[0], Number(event.target.value) || 0] }))
                  }
                />
              </Field>
              <Field label="缩放 X">
                <Input
                  aria-label="内观缩放X"
                  type="number"
                  step="0.02"
                  value={geometry.inScaleX}
                  onChange={(event) =>
                    patchUserGeometry((current) => ({ ...current, inScaleX: Math.max(0.05, Number(event.target.value) || 1) }))
                  }
                />
              </Field>
              <Field label="缩放 Y">
                <Input
                  aria-label="内观缩放Y"
                  type="number"
                  step="0.02"
                  value={geometry.inScaleY}
                  onChange={(event) =>
                    patchUserGeometry((current) => ({ ...current, inScaleY: Math.max(0.05, Number(event.target.value) || 1) }))
                  }
                />
              </Field>
            </div>

            <div className="mt-2 text-[11px] leading-relaxed text-slate-500">
              脚底相对圆盘中心：
              <span className={feetDelta != null && Math.abs(feetDelta) > 2 ? "text-amber-400" : "text-slate-300"}>
                {feetDelta == null ? "量不到轮廓" : `${feetDelta > 0 ? "+" : ""}${feetDelta.toFixed(1)}`}
              </span>
              {feetDelta != null ? <span className="ml-1">（正 = 悬空、负 = 陷进盘里）</span> : null}
              {handPoint ? <div>手位（参照衣服）：{handPoint[0].toFixed(1)}, {handPoint[1].toFixed(1)}</div> : null}
            </div>

            {activeItem.kind === "weapon" ? (
              <label className="mt-3 flex items-start gap-2 rounded-lg bg-slate-800/40 p-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={geometry.manual}
                  onChange={(event) => patchGeometry((current) => ({ ...current, manual: event.target.checked }))}
                />
                <span>
                  使用手调的绝对位置
                  <span className="block text-slate-500">
                    拖动 / 改数值会自动勾上。没勾时客户端按当前衣服的内容 bbox 自动算 —— 这里的位置不生效（保存也会按手调存）。
                  </span>
                  <span className="block text-slate-500">
                    想彻底回到自动算：用「还原本件」删掉这行，别只把勾去掉。
                  </span>
                </span>
              </label>
            ) : null}

            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="primary" onClick={saveActive} loading={pending === activeItem.id} disabled={Boolean(pending) || loadingSaved}>
                保存本件{unsaved ? " ●" : ""}
              </Button>
              {activeItem.kind === "cloth" ? (
                <Button variant="outline" onClick={snapToPlate}>
                  脚踩圆盘
                </Button>
              ) : (
                <Button variant="outline" onClick={fitToBaseCloth}>
                  按第一件衣服给初值
                </Button>
              )}
              <Button variant="outline" onClick={resetItem} disabled={Boolean(pending) || loadingSaved}>
                还原本件
              </Button>
            </div>

            <div className="mt-2 text-[11px] leading-relaxed text-slate-500">
              {unsaved ? "有未保存的改动 —— 按「保存本件」才写进服务端。" : "已与服务端一致；改动会实时存浏览器，刷新不丢。"}
            </div>

            {notice ? <div className="mt-3 rounded-lg bg-emerald-500/10 px-2 py-1.5 text-[11px] text-emerald-300">{notice}</div> : null}
          </div>
        </aside>
      </div>
    </div>
  );
}
