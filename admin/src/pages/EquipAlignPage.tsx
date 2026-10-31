import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { Button, Field, Input, Spinner } from "../components/ui";
import catalogJson from "../data/equip-align.catalog.json";
import type { Atlas } from "./equipAlign/atlas";
import { frameNameOf, measureSolid } from "./equipAlign/atlas";
import { loadAtlas, probeAtlas } from "./equipAlign/assets";
import type { Geometry, ScreenRect, Vec2 } from "./equipAlign/model";
import {
  adjustedDirections,
  clampPosition,
  contentRect,
  DIRECTIONS,
  DIRECTION_LABELS,
  geometryFromCatalog,
  handAnchor,
  isDirty,
  normalizePositions,
  round2,
  snap,
  solidScreenRect,
} from "./equipAlign/model";
import type { Guides } from "./equipAlign/render";
import { drawCell, layoutCells, originOfCell } from "./equipAlign/render";
import { useAlignStore } from "./equipAlign/saved";
import { makeAlignWorkbenchActions } from "./equipAlign/workbench-actions";

/**
 * 装备对齐工作台（#509 / #513）
 *
 * ===========================================================================
 * 这个页面解决什么
 * ===========================================================================
 * 装备位置长期靠「手写一组绝对坐标」+「运行时按身体 bbox 猜」两套混着来，前者只对某一件
 * 身体成立、后者被影子和素材留白带偏（真机逐帧比对见 `.workbuddy/verify/report.md` §9）。
 * 这里把判断权交回人眼：**以裸模为唯一基准**，8 个朝向上把衣服/武器拖到位。
 *
 * ===========================================================================
 * 保存直接落库（#513）
 * ===========================================================================
 * 位置存服务端（`equip_aligns` 表），客户端进游戏时拉一次并覆盖本地几何
 * （`configs/apply-snapshot` 的 `applyEquipAlignRows`）—— 所以流程是
 * **调 → 保存 → 刷新客户端**，不再需要导出 JSON + 在项目根跑脚本 + 重新打包。
 *
 * 三份数据的优先级（少一层就会把上次调好的位置当成没调过）：
 *   页面临时改动（localStorage）> 服务端已保存 > catalog.json（出厂值）
 * 「导出 / 导入 JSON」保留下来只做备份与「把定稿烧进出厂配置」，
 * 那条路仍是 `tools/apply-equip-align.cjs`。
 *
 * ===========================================================================
 * 三条设计约束（都是为了「页面上看到的就是游戏里看到的」）
 * ===========================================================================
 * 1. **几何与游戏同一套语义**：节点框 = 画布、内容中心 = 节点中心 + offset（y 向上），
 *    见 `equipAlign/model.ts`；页面不许自己发明第二种摆法。
 * 2. **基准只有裸模**：衣服与武器都叠在裸模上比，互不引用 —— 否则「武器跟着衣服漂」
 *    这件事会以另一种形式回来。
 * 3. **只做站立**：8 个方向的 `dX_00` 帧。`outPositions` 对所有动作生效，
 *    但站立帧已经把裁剪留白与身体比例定死，其它动作是同一套节点变换。
 */

/** 清单条目（由 tools/gen-equip-align-catalog.cjs 生成） */
interface CatalogEntry {
  key: string;
  label: string;
  slot?: string;
  out: string;
  atlas: string;
  in?: string;
  outScale: number;
  outPositions: Vec2[];
  manual: boolean;
  inScale: [number, number];
  inPosition: Vec2;
}

interface CatalogRole {
  id: string;
  label: string;
  src: string;
  atlas: string;
  outScale: number;
  outPositions: Vec2[];
  manual: boolean;
}

interface Catalog {
  generatedBy: string;
  directions: string[];
  /** 角色体型 / 碰撞盒（工作台画「碰撞盒」参考框用；与客户端 roleBody 同一份） */
  body?: {
    width: number;
    height: number;
    colliderWidth: number;
    colliderHeight: number;
    colliderOffset: Vec2;
  };
  role: CatalogRole[];
  clothes: CatalogEntry[];
  weapons: CatalogEntry[];
}

const CATALOG = catalogJson as unknown as Catalog;

type Kind = "role" | "cloth" | "weapon";

/** 页面上的统一条目（三类合成一种，列表与画布不用各写一套） */
interface WorkItem {
  id: string;
  kind: Kind;
  key: string;
  label: string;
  atlas: string;
  base: Geometry;
}

function itemsOfKind(kind: Kind): WorkItem[] {
  if (kind === "role") {
    return CATALOG.role.map((item) => ({
      id: `role:${item.id}`,
      kind,
      key: item.id,
      label: item.label,
      atlas: item.atlas,
      base: geometryFromCatalog(item, true),
    }));
  }
  const list = kind === "cloth" ? CATALOG.clothes : CATALOG.weapons;
  return list.map((item) => ({
    id: `${kind}:${item.key}`,
    kind,
    key: item.key,
    label: item.label,
    atlas: item.atlas,
    // manual 默认 true：工作台对衣服与武器的整套编辑（拖拽 / 按裸模给初值 / 预览）都是**绝对位置**语义
    // （render.ts 画格子从不看 manual），保存出去就该按绝对位置被客户端读 ——
    // 默认 false 时「页面上看着对、游戏里不对」（客户端把同一份坐标当微调叠在自动算法上，#541）。
    // 想要「自动算法 + 微调」再在右栏把勾去掉。
    base: geometryFromCatalog(item, true),
  }));
}

const ALL_ITEMS: WorkItem[] = [...itemsOfKind("role"), ...itemsOfKind("cloth"), ...itemsOfKind("weapon")];

const KIND_LABELS: Record<Kind, string> = { role: "裸模", cloth: "衣服", weapon: "武器" };

const DRAFT_KEY = "olua.equipAlign.drafts.v1";
const PREFS_KEY = "olua.equipAlign.prefs.v1";

const DEFAULT_GUIDES: Guides = { canvas: true, content: false, solid: true, itemTop: true, feet: true, hands: true, origin: true, frame: true };

interface Prefs {
  resRoot: string;
  baseRoleId: string;
  /** 每格显示多少游戏单位（null = 按格子大小自动，首次进页面就是这个状态） */
  viewSpan: number | null;
  guides: Guides;
}

const DEFAULT_PREFS: Prefs = { resRoot: "/game-resources", baseRoleId: "1", viewSpan: null, guides: DEFAULT_GUIDES };

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as T) };
  } catch {
    return fallback;
  }
}

/**
 * 读偏好
 *
 * `guides` 必须**逐项**与默认值合并：用过这个页面的人 localStorage 里是旧结构，
 * `readJson` 的浅合并会把整个 `guides` 换成旧对象 → 新增的开关读出来是 `undefined`，
 * 表现为「未勾选」且逻辑走 falsy —— 新功能在老浏览器上静默失效，看起来像没做。
 */
function readPrefs(): Prefs {
  const stored = readJson<Partial<Prefs>>(PREFS_KEY, {});
  return {
    ...DEFAULT_PREFS,
    ...stored,
    guides: { ...DEFAULT_GUIDES, ...(stored.guides ?? {}) },
  };
}

/**
 * 图集缓存（按 资源根 + 路径）
 *
 * 不能把 Atlas 塞进 React state：它是几 MB 的 HTMLImageElement，放 state 会参与 diff。
 * 这里用 ref 缓存 + 一个 version 计数触发重绘。
 */
function useAtlases(resRoot: string) {
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
    (atlasPath: string | null): Atlas | null => {
      if (!atlasPath) return null;
      const key = `${resRoot}|${atlasPath}`;
      const hit = cache.current.get(key);
      if (hit) return hit;
      if (!pending.current.has(key)) {
        const task = loadAtlas(resRoot, atlasPath)
          .then((atlas) => {
            cache.current.set(key, atlas);
          })
          .catch((error: unknown) => {
            setFailed((prev) => ({ ...prev, [key]: error instanceof Error ? error.message : String(error) }));
          })
          .finally(() => {
            pending.current.delete(key);
            setVersion((value) => value + 1);
          });
        pending.current.set(key, task);
      }
      return null;
    },
    [resRoot],
  );

  return { request, version, failed, loading: pending.current.size > 0 };
}

/** 下载一个文本文件（导出对齐结果） */
function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function EquipAlignPage() {
  const [prefs, setPrefs] = useState<Prefs>(() => readPrefs());
  const [drafts, setDrafts] = useState<Record<string, Geometry>>(() => readJson(DRAFT_KEY, {} as Record<string, Geometry>));
  const [kind, setKind] = useState<Kind>("cloth");
  const [activeId, setActiveId] = useState<string>("cloth:cloth_1");
  const [direction, setDirection] = useState(4); // down
  const [hovered, setHovered] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");

  /**
   * 服务端已保存的对齐（#513）
   *
   * 页面基线 = `saved[id] ?? catalog.base`。少了 `saved` 这一层，第二次进页面会把上次
   * 调好的位置当成出厂值显示，看起来像「保存没成功」。
   */
  const {
    saved,
    loading: loadingSaved,
    error: savedError,
    pending,
    save: saveAlign,
    reset: resetAlign,
    reload: reloadSaved,
    clearError,
  } = useAlignStore();

  const { request, version, failed } = useAtlases(prefs.resRoot);

  /**
   * 哪些条目「本机上没有素材」——只在列表上打一个标记，不阻塞渲染。
   *
   * 这件事必须**运行时**问（`probeAtlas`），不能写进生成的清单：`client/assets/resources/`
   * 是 gitignore 的，同一份配置在装了素材的机器和 CI 上答案不同，写进清单会让
   * 「重生成 + 逐字节比对」的守点必然假红。探测本身失败也当「有」，不要凭空吓人。
   */
  const [missing, setMissing] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    let cancelled = false;
    setMissing(new Set());
    const paths = [...new Set(ALL_ITEMS.map((item) => item.atlas).filter(Boolean))];
    void (async () => {
      const gone: string[] = [];
      for (const atlasPath of paths) {
        if (cancelled) return;
        if (!(await probeAtlas(prefs.resRoot, atlasPath))) gone.push(atlasPath);
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

  const items = useMemo(() => itemsOfKind(kind), [kind]);
  const visibleItems = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return items;
    return items.filter((item) => item.key.toLowerCase().includes(keyword) || item.label.toLowerCase().includes(keyword));
  }, [items, search]);

  const activeItem = useMemo(() => ALL_ITEMS.find((item) => item.id === activeId) ?? ALL_ITEMS[0], [activeId]);
  const roleItem = useMemo(() => ALL_ITEMS.find((item) => item.id === `role:${prefs.baseRoleId}`) ?? ALL_ITEMS[0], [prefs.baseRoleId]);

  /** 某件的当前基线：服务端存过就用服务端的，否则用 catalog.json 的出厂值 */
  const baseOf = useCallback((item: WorkItem): Geometry => saved[item.id] ?? item.base, [saved]);

  const geometry = drafts[activeItem.id] ?? baseOf(activeItem);
  const baseRoleGeometry = drafts[roleItem.id] ?? baseOf(roleItem);
  /**
   * 基准裸模**已提交**的几何（服务端 > catalog）
   *
   * 调裸模自己时，幽灵不能跟着目标一起走（那样重叠成一张图，看不出挪了多少），也不能像
   * 以前那样硬写 0 —— 画布中心不是脚下，「幽灵在原点」会把人往「位置 0 就对了」上带。
   * 这里让它停在已提交的位置上，地面线（原点）另行画。
   */
  const committedRoleGeometry = baseOf(roleItem);
  /** 当前件相对「服务端那份」有未保存改动 */
  const unsaved = isDirty(geometry, baseOf(activeItem));

  const roleAtlas = request(roleItem.atlas);
  const itemAtlas = request(activeItem.atlas);
  const isRoleTarget = activeItem.kind === "role";

  /** 「已调 N / 全部」按**出厂值**算：用户关心的是这件调过没有，不是它有没有未保存 */
  const dirtyCount = useMemo(
    () => ALL_ITEMS.filter((item) => isDirty(drafts[item.id] ?? saved[item.id] ?? item.base, item.base)).length,
    [drafts, saved],
  );
  /** 未保存的件数（顶部保存按钮上的角标） */
  const unsavedIds = useMemo(
    () => ALL_ITEMS.filter((item) => isDirty(drafts[item.id] ?? saved[item.id] ?? item.base, saved[item.id] ?? item.base)).map((item) => item.id),
    [drafts, saved],
  );

  /** 改当前条目的几何（唯一写入口，保证 8 项长度与吸附一致） */
  const patchGeometry = useCallback(
    (updater: (current: Geometry) => Geometry) => {
      setDrafts((prev) => {
        const current = prev[activeItem.id] ?? baseOf(activeItem);
        const next = updater(current);
        return { ...prev, [activeItem.id]: { ...next, outPositions: normalizePositions(next.outPositions) } };
      });
      clearError();
    },
    [activeItem, baseOf, clearError],
  );

  const setPosition = useCallback(
    (index: number, x: number, y: number) => {
      patchGeometry((current) => {
        const positions = current.outPositions.map((pos) => [...pos] as Vec2);
        positions[index] = [round2(x), round2(y)];
        return { ...current, outPositions: positions };
      });
    },
    [patchGeometry],
  );

  const nudge = useCallback(
    (dx: number, dy: number) => {
      const pos = geometry.outPositions[direction] ?? [0, 0];
      // 与拖动同一个夹紧口径：键盘也不该把东西挪出可见范围（存量里飞天的那格靠它一次拉回）
      const limit = prefs.viewSpan ?? 190;
      setPosition(direction, clampPosition(snap(pos[0] + dx), limit), clampPosition(snap(pos[1] + dy), limit));
    },
    [direction, geometry.outPositions, prefs.viewSpan, setPosition],
  );

  // ---- 画布 ----
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = useState(960);
  const drag = useRef<{ index: number; startX: number; startY: number; pos: Vec2 } | null>(null);

  useLayoutEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node);
    setWidth(node.clientWidth);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(() => layoutCells(width), [width]);
  /**
   * 1 游戏单位 = 多少像素
   *
   * 默认按格子大小自动（一格正好装下 `viewSpan` 个游戏单位），这样窗口变大格子变大、
   * 内容跟着变大，不会出现「格子很大但人物只有一小撮」。用户改了就按用户的来。
   */
  const zoom = layout.cellSize / (prefs.viewSpan ?? 190);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(layout.height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${layout.height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, layout.height);
    // 像素风素材：放大时不要平滑，边缘才锐利（也更容易看出位移）
    ctx.imageSmoothingEnabled = false;

    if (!roleAtlas) return;

    for (let index = 0; index < 8; index++) {
      const cell = layout.cells[index];
      const origin = originOfCell(cell);
      const roleFrame = roleAtlas.frames.get(frameNameOf(index, 0));
      const roleSolid = roleFrame ? measureSolid(roleAtlas, frameNameOf(index, 0)) : null;
      const itemSolid = itemAtlas ? measureSolid(itemAtlas, frameNameOf(index, 0)) : null;

      drawCell(
        ctx,
        {
          index,
          rect: cell,
          origin,
          k: zoom,
          roleAtlas,
          // 调裸模自己时，幽灵停在**已提交**的位置（不是原点，也不是跟着目标一起动）
          roleGeometry: isRoleTarget ? committedRoleGeometry : baseRoleGeometry,
          itemAtlas,
          itemGeometry: itemAtlas ? geometry : null,
          selected: index === direction,
          hovered: hovered === index,
          roleAlpha: isRoleTarget ? 0.32 : 1,
          body: CATALOG.body,
        },
        prefs.guides,
        roleSolid,
        itemSolid,
      );
    }
  }, [width, layout, zoom, roleAtlas, itemAtlas, baseRoleGeometry, committedRoleGeometry, geometry, direction, hovered, prefs.guides, isRoleTarget, version]);

  /** 屏幕坐标（相对 canvas） */
  const localPoint = (event: { clientX: number; clientY: number }): Vec2 => {
    const canvas = canvasRef.current;
    if (!canvas) return [0, 0];
    const box = canvas.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  };

  const hitCell = (point: Vec2): number => {
    for (let index = 0; index < layout.cells.length; index++) {
      const cell = layout.cells[index];
      if (point[0] >= cell.x && point[0] <= cell.x + cell.w && point[1] >= cell.y && point[1] <= cell.y + cell.h) return index;
    }
    return -1;
  };

  /** 装备内容在屏幕上的矩形（拖动命中 + 手位参考） */
  const itemContentAt = useCallback(
    (index: number): ScreenRect | null => {
      if (!itemAtlas) return null;
      const frame = itemAtlas.frames.get(frameNameOf(index, 0));
      if (!frame) return null;
      const cell = layout.cells[index];
      return contentRect(frame, originOfCell(cell), geometry.outPositions[index] ?? [0, 0], geometry.outScale, zoom);
    },
    [itemAtlas, layout, geometry, zoom],
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = localPoint(event);
    const index = hitCell(point);
    if (index < 0) return;
    setDirection(index);
    const content = itemContentAt(index);
    if (!content) return;
    const cell = layout.cells[index];
    const inside = point[0] >= content.x && point[0] <= content.x + content.w && point[1] >= content.y && point[1] <= content.y + content.h;
    /**
     * 内容还看得见（与格子有交集）时必须点中它才拖 —— 格子里空白处误拖不该改数值。
     *
     * **整个飞出格子时反而允许点格子就拖**：那时用户根本点不到它（这正是一次拖太远之后
     * 「再也拖不回来」的原因，见 `clampPosition` 的注释）。此时按住格子任意位置，
     * 位移仍相对它当前的位置算，一拖就把它带回来了。
     */
    const visible =
      content.x < cell.x + cell.w && content.x + content.w > cell.x && content.y < cell.y + cell.h && content.y + content.h > cell.y;
    if (!inside && visible) return;
    const pos = geometry.outPositions[index] ?? [0, 0];
    drag.current = { index, startX: point[0], startY: point[1], pos: [pos[0], pos[1]] };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = localPoint(event);
    const active = drag.current;
    if (!active) {
      const index = hitCell(point);
      if (index !== hovered) setHovered(index >= 0 ? index : null);
      return;
    }
    const dx = (point[0] - active.startX) / zoom;
    const dy = (point[1] - active.startY) / zoom;
    // 夹在一屏可见范围内：指针移出画布时 dx/dy 会一路累加，不夹就会把东西甩到格子外抓不回来
    const limit = prefs.viewSpan ?? 190;
    setPosition(
      active.index,
      clampPosition(snap(active.pos[0] + dx), limit),
      clampPosition(snap(active.pos[1] - dy), limit),
    );
  };

  const endDrag = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drag.current) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const next = Math.min(4, Math.max(0.4, round2(geometry.outScale - Math.sign(event.deltaY) * 0.02)));
    patchGeometry((current) => ({ ...current, outScale: next }));
  };

  // ---- 键盘 ----
  /** 在「裸模 → 衣服 → 武器」的完整序列里前后切换（`[` / `]`） */
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
      const keys: Record<string, () => void> = {
        ArrowLeft: () => nudge(-step, 0),
        ArrowRight: () => nudge(step, 0),
        ArrowUp: () => nudge(0, step),
        ArrowDown: () => nudge(0, -step),
        "[": () => stepItem(-1),
        "]": () => stepItem(1),
        "-": () => patchGeometry((current) => ({ ...current, outScale: Math.max(0.2, round2(current.outScale - 0.02)) })),
        "=": () => patchGeometry((current) => ({ ...current, outScale: Math.min(4, round2(current.outScale + 0.02)) })),
      };
      if (/^[1-8]$/.test(event.key)) {
        setDirection(Number(event.key) - 1);
        event.preventDefault();
        return;
      }
      const action = keys[event.key];
      if (action) {
        action();
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [nudge, patchGeometry, stepItem]);

  /**
   * 某一方向「可见轮廓底边」相对地面（宿主原点）的偏移
   *
   * 正 = 悬空、负 = 陷进地里；0 附近才算「踩在脚下」。量的是 alpha>200 的轮廓而不是裁剪框 ——
   * 裁剪框里混着影子与光晕，按它算永远差几个像素。
   */
  const feetDeltaOf = useCallback(
    (atlas: Atlas | null, geo: Geometry, index: number): number | null => {
      if (!atlas) return null;
      const name = frameNameOf(index, 0);
      const frame = atlas.frames.get(name);
      if (!frame) return null;
      const solid = measureSolid(atlas, name);
      if (!solid) return null;
      const origin = originOfCell(layout.cells[index]);
      const content = contentRect(frame, origin, geo.outPositions[index] ?? [0, 0], geo.outScale, zoom);
      const rect = solidScreenRect(solid, content, geo.outScale * zoom);
      return (origin[1] - (rect.y + rect.h)) / zoom;
    },
    [layout, zoom],
  );

  /**
   * 基准裸模里偏得最狠的那个方向（没有素材时 null）
   *
   * 拿来做顶部提醒：裸模沉下去 30 时，所有「拿它当基准」的判断都跟着偏 30，
   * 但页面上看起来却只是「衣服飘了」—— 这个提示就是防止抓错方向。
   */
  const roleFeetWorst = useMemo(() => {
    let worst: { index: number; delta: number } | null = null;
    for (let index = 0; index < 8; index++) {
      const delta = feetDeltaOf(roleAtlas, baseRoleGeometry, index);
      if (delta == null) continue;
      if (!worst || Math.abs(delta) > Math.abs(worst.delta)) worst = { index, delta };
    }
    return worst;
  }, [feetDeltaOf, roleAtlas, baseRoleGeometry, version]);

  // ---- 操作 ----
  const applyToAll = () => {
    const pos = geometry.outPositions[direction] ?? [0, 0];
    patchGeometry((current) => ({ ...current, outPositions: Array.from({ length: 8 }, () => [pos[0], pos[1]] as Vec2) }));
    setNotice("已把当前方向的位置复制到 8 个方向");
  };

  /**
   * 脚底贴地：把**可见轮廓**的底边按到地面上（8 个方向各算一次）
   *
   * 为什么需要这个按钮：外观节点的锚点是**画布中心**，而美术画布底部留着 25~66 单位不等的
   * 空白 —— 所以「位置 0」并不等于「脚在地上」。裸模就踩过这个坑（全 0 → 身体沉 31，
   * 看起来像「锚点跑到身体正中间」）。换素材、改缩放之后按一下，比手算 y 靠谱。
   *
   * 武器不适用（它挂在手上），所以只在裸模 / 衣服上给这个按钮。
   */
  const snapFeetToGround = () => {
    const positions = geometry.outPositions.map((pos) => [pos[0], pos[1]] as Vec2);
    let moved = 0;
    let missing = 0;
    for (let index = 0; index < 8; index++) {
      const delta = feetDeltaOf(itemAtlas, geometry, index);
      if (delta == null) {
        missing += 1;
        continue;
      }
      if (Math.abs(delta) < 0.05) continue;
      // delta = 轮廓底边相对地面的屏幕位移（正 = 悬空），补偿量取反号
      positions[index] = [positions[index][0], round2(positions[index][1] - delta)];
      moved += 1;
    }
    if (!moved && !missing) {
      setNotice("8 个方向的脚底都已经在地面上");
      return;
    }
    patchGeometry((current) => ({ ...current, outPositions: positions }));
    setNotice(`已把 ${moved} 个方向的脚底贴到地面${missing ? `（${missing} 个方向没有帧，跳过）` : ""}`);
  };

  /**
   * 基准裸模的脚底一键贴地**并存库**（顶部横幅上的动作）
   *
   * 与 `snapFeetToGround` 的区别是「不看当前选中的是谁」：横幅是在提醒**基准**歪了，
   * 而那时用户正在调衣服/武器。原来只把他切到裸模，还得自己再点一次按钮、再点保存 ——
   * 三次操作里任何一次漏掉，看到的都是「基准还是歪的」。这里一次做完。
   */
  const fixBaseRoleFeet = async () => {
    if (!roleAtlas || pending) return;
    const base = drafts[roleItem.id] ?? baseOf(roleItem);
    const positions = base.outPositions.map((pos) => [pos[0], pos[1]] as Vec2);
    let moved = 0;
    for (let index = 0; index < 8; index++) {
      const delta = feetDeltaOf(roleAtlas, base, index);
      if (delta == null || Math.abs(delta) < 0.05) continue;
      positions[index] = [positions[index][0], round2(positions[index][1] - delta)];
      moved += 1;
    }
    if (!moved) {
      setNotice("基准裸模 8 个方向的脚底都已经在地面上");
      return;
    }
    const ok = await saveAlign(roleItem.id, { ...base, outPositions: normalizePositions(positions) });
    if (!ok) return;
    dropDraft(roleItem.id);
    setNotice(`已把基准裸模 ${moved} 个方向的脚底贴回地面并存库`);
  };

  /** 只清掉浏览器里的临时改动（不碰服务端） */
  const dropDraft = (id: string) => {    setDrafts((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  /** 保存 / 还原 / 批量保存（与内观工作台共用的流程，差异只在生效文案与落库 API） */
  const workbench = makeAlignWorkbenchActions<Geometry, WorkItem>({
    pending,
    save: saveAlign,
    reset: resetAlign,
    saved,
    drafts,
    baseOf,
    dropDraft,
    setNotice,
    effectHint: "客户端重进游戏即生效",
  });
  const saveActive = () => workbench.saveActive(activeItem, geometry);
  const resetItem = () => workbench.resetItem(activeItem);
  const saveAll = () => workbench.saveAll(ALL_ITEMS, unsavedIds);

  /**
   * 按裸模自动给一个初值（免费的人工起点）
   *
   * - 武器：把**内容中心**放到裸模轮廓的握持点（与客户端 #505 的算法同口径，但用轮廓而不是裁剪框）；
   * - 衣服：轮廓中心与裸模轮廓中心对齐、底边与裸模脚底对齐。
   * 只是起点 —— 素材的透视（斜向的武器往往画得更长）还得人眼收。
   */
  const autoAlign = () => {
    if (!roleAtlas || !itemAtlas) return;
    const cell = layout.cells[direction];
    const origin = originOfCell(cell);
    const roleFrame = roleAtlas.frames.get(frameNameOf(direction, 0));
    const itemFrame = itemAtlas.frames.get(frameNameOf(direction, 0));
    if (!roleFrame || !itemFrame) return;
    const roleSolid = measureSolid(roleAtlas, frameNameOf(direction, 0));
    if (!roleSolid) {
      setNotice("裸模这一方向量不到轮廓（素材缺帧？）");
      return;
    }
    const roleContent = contentRect(roleFrame, origin, baseRoleGeometry.outPositions[direction] ?? [0, 0], baseRoleGeometry.outScale, zoom);
    const bodyBox = solidScreenRect(roleSolid, roleContent, baseRoleGeometry.outScale * zoom);
    const itemSolid = measureSolid(itemAtlas, frameNameOf(direction, 0));
    const itemContent = contentRect(itemFrame, origin, [0, 0], geometry.outScale, zoom);

    let target: Vec2;
    if (activeItem.kind === "weapon") {
      const onLeft = !["up", "right_up", "right"].includes(DIRECTIONS[direction]);
      target = handAnchor(bodyBox, onLeft);
    } else {
      target = [bodyBox.x + bodyBox.w / 2, bodyBox.y + bodyBox.h];
    }

    // 对象上「要对准的那个点」相对内容框的偏移（没量到轮廓时退化成内容框中心/底边中点）
    const anchorOffset: Vec2 = itemSolid
      ? activeItem.kind === "weapon"
        ? [itemContent.x + (itemSolid.x + itemSolid.w / 2) * geometry.outScale * zoom, itemContent.y + (itemSolid.y + itemSolid.h / 2) * geometry.outScale * zoom]
        : [itemContent.x + (itemSolid.x + itemSolid.w / 2) * geometry.outScale * zoom, itemContent.y + (itemSolid.y + itemSolid.h) * geometry.outScale * zoom]
      : [itemContent.x + itemContent.w / 2, itemContent.y + itemContent.h / 2];

    const current = geometry.outPositions[direction] ?? [0, 0];
    const nextX = snap(current[0] + (target[0] - anchorOffset[0]) / zoom);
    const nextY = snap(current[1] - (target[1] - anchorOffset[1]) / zoom);
    setPosition(direction, nextX, nextY);
    setNotice("已按裸模轮廓给出初值，再微调到顺眼");
  };

  /**
   * 导出成 JSON（**备份用**，不是主流程）
   *
   * 主流程是「保存本件」直接落库；这份导出还留着是因为它还有一个用途：
   * 把定稿烧进出厂配置（`tools/apply-equip-align.cjs` 写 `equipments.ts` / `role.ts`），
   * 这样全新装的客户端即使连不上服务端，位置也是对的。
   */
  const exportJson = () => {
    const entries: Record<string, { outScale: number; outPositions: Vec2[]; manual: boolean }> = {};
    for (const item of ALL_ITEMS) {
      const geo = drafts[item.id] ?? saved[item.id] ?? item.base;
      entries[item.id] = {
        outScale: round2(geo.outScale),
        outPositions: geo.outPositions.map((pos) => [round2(pos[0]), round2(pos[1])] as Vec2),
        manual: geo.manual,
      };
    }
    const payload = { version: 1, generatedBy: "admin/equip-align", generatedAt: new Date().toISOString(), entries };
    download("equip-align.json", `${JSON.stringify(payload, null, 2)}\n`);
    setNotice("已导出 equip-align.json（备份 / 烧进出厂配置：node tools/apply-equip-align.cjs <路径>）");
  };

  const importJson = (file: File) => {
    file
      .text()
      .then((text) => {
        const parsed = JSON.parse(text) as { entries?: Record<string, Geometry> };
        if (!parsed.entries) throw new Error("JSON 里没有 entries");
        setDrafts((prev) => ({ ...prev, ...parsed.entries }));
        setNotice(`已导入 ${Object.keys(parsed.entries).length} 条`);
      })
      .catch((error: unknown) => setNotice(`导入失败：${error instanceof Error ? error.message : String(error)}`));
  };

  const currentPos = geometry.outPositions[direction] ?? [0, 0];
  const failures = Object.values(failed);

  return (
    <div className="flex flex-col gap-4">
      {/* 顶部：资源根 + 基准 + 导出 */}
      <section className="flex flex-wrap items-end gap-3 rounded-2xl border border-slate-800 bg-slate-900/40 px-5 py-4">
        <Field label="资源根（指向游戏站的 resources）">
          <Input
            className="w-72"
            value={prefs.resRoot}
            onChange={(event) => setPrefs((prev) => ({ ...prev, resRoot: event.target.value }))}
            placeholder="/game-resources"
          />
        </Field>
        <Field label="比对基准（裸模）">
          <select
            className="rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm text-slate-100"
            value={prefs.baseRoleId}
            onChange={(event) => setPrefs((prev) => ({ ...prev, baseRoleId: event.target.value }))}
          >
            {CATALOG.role.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="每格视野（游戏单位）">
          <Input
            className="w-28"
            type="number"
            step="10"
            min="60"
            max="600"
            value={prefs.viewSpan ?? 190}
            onChange={(event) =>
              setPrefs((prev) => ({ ...prev, viewSpan: Math.min(600, Math.max(60, Number(event.target.value) || 190)) }))
            }
          />
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
          <Button variant="ghost" onClick={exportJson}>
            导出 JSON
          </Button>
          <label className="cursor-pointer rounded-lg border border-slate-700 px-3.5 py-2 text-sm text-slate-200 hover:border-slate-500">
            导入
            <input
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) importJson(file);
                event.target.value = "";
              }}
            />
          </label>
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
          <Spinner className="h-3 w-3" /> 正在读取服务端已保存的对齐…
        </div>
      ) : null}

      {failures.length ? (
        <div className="rounded-xl border border-rose-900/60 bg-rose-950/30 px-4 py-3 text-xs text-rose-300">
          {failures.slice(0, 3).map((message) => (
            <div key={message}>{message}</div>
          ))}
        </div>
      ) : null}

      {roleFeetWorst && Math.abs(roleFeetWorst.delta) > 2 ? (
        <div className="flex items-start gap-3 rounded-xl border border-amber-900/60 bg-amber-950/30 px-4 py-3 text-xs text-amber-300">
          <span className="flex-1">
            基准裸模「{roleItem.label}」在 {DIRECTION_LABELS[DIRECTIONS[roleFeetWorst.index]]} 方向脚底离地面{" "}
            {roleFeetWorst.delta > 0 ? "+" : ""}
            {roleFeetWorst.delta.toFixed(1)}（正 = 悬空、负 = 陷进地里）—— 拿它当基准的话，所有位置都会跟着偏。
            点「一键贴地并存库」直接修好（不必先切到裸模）。
          </span>
          <button
            className="shrink-0 underline"
            onClick={() => {
              setKind("role");
              setActiveId(roleItem.id);
              setDirection(roleFeetWorst.index);
            }}
          >
            去看那一格
          </button>
          <button className="shrink-0 underline" onClick={fixBaseRoleFeet}>
            一键贴地并存库
          </button>
        </div>
      ) : null}

      <div className="flex flex-col gap-3 xl:flex-row">
        {/* 左栏：条目 */}
        <aside className="w-full shrink-0 xl:w-52">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-3">
            <div className="mb-2 flex gap-1">
              {(["role", "cloth", "weapon"] as Kind[]).map((value) => (
                <button
                  key={value}
                  onClick={() => {
                    setKind(value);
                    const first = itemsOfKind(value)[0];
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
            <div className="mt-2 max-h-[520px] overflow-auto">
              {visibleItems.map((item) => {
                const base = saved[item.id] ?? item.base;
                const geo = drafts[item.id] ?? base;
                const adjusted = adjustedDirections(geo, item.base);
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
                    {missing.has(item.atlas) ? <span className="text-amber-400">缺素材</span> : null}
                    {dirtyLocal ? <span className="text-amber-400" title="有未保存的改动">●</span> : null}
                    {isDirty(geo, item.base) ? <span className="text-emerald-400">{adjusted}/8</span> : null}
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        {/* 中间：8 宫格 */}
        <div className="min-w-0 flex-1">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <span className="font-medium text-slate-200">
                {KIND_LABELS[activeItem.kind]} · {activeItem.label}
              </span>
              <span className="text-slate-500">{activeItem.atlas}</span>
              {!roleAtlas || !itemAtlas ? (
                <span className="flex items-center gap-1 text-amber-400">
                  <Spinner className="h-3 w-3" /> 素材加载中
                </span>
              ) : null}
              <span className="ml-auto">拖动装备 / 方向键微调 / 滚轮改缩放 / [ ] 切件 / 1-8 选方向</span>
            </div>
            <div ref={wrapRef} className="w-full">
              <canvas
                ref={canvasRef}
                className="block w-full cursor-grab touch-none rounded-xl bg-[#12141a] active:cursor-grabbing"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onPointerLeave={() => setHovered(null)}
                onWheel={onWheel}
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-500">
              {(["canvas", "content", "solid", "feet", "frame", "hands", "origin", "itemTop"] as (keyof Guides)[]).map((key) => (
                <label key={key} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={prefs.guides[key]}
                    onChange={(event) => setPrefs((prev) => ({ ...prev, guides: { ...prev.guides, [key]: event.target.checked } }))}
                  />
                  {{
                    canvas: "画布框",
                    content: "裁剪框",
                    solid: "轮廓框",
                    feet: "地面线",
                    frame: "碰撞盒",
                    hands: "手位",
                    origin: "原点",
                    itemTop: "装备置顶",
                  }[key]}
                </label>
              ))}
            </div>
          </div>
        </div>

        {/* 右栏：数值 */}
        <aside className="w-full shrink-0 xl:w-64">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
            <div className="mb-3 text-sm font-semibold text-slate-100">当前方向：{DIRECTION_LABELS[DIRECTIONS[direction]]}（{DIRECTIONS[direction]}）</div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="X">
                <Input
                  aria-label="装备X"
                  type="number"
                  step="0.1"
                  value={currentPos[0]}
                  onChange={(event) => setPosition(direction, Number(event.target.value), currentPos[1])}
                />
              </Field>
              <Field label="Y">
                <Input
                  aria-label="装备Y"
                  type="number"
                  step="0.1"
                  value={currentPos[1]}
                  onChange={(event) => setPosition(direction, currentPos[0], Number(event.target.value))}
                />
              </Field>
            </div>
            <div className="mt-2">
              <Field label="缩放 outScale" hint="对所有方向生效（滚轮也能改）">
                <Input
                  aria-label="装备缩放"
                  type="number"
                  step="0.02"
                  value={geometry.outScale}
                  onChange={(event) => patchGeometry((current) => ({ ...current, outScale: Math.max(0.05, Number(event.target.value) || 1) }))}
                />
              </Field>
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
                  使用手调的绝对位置（#541 起客户端已停用帧算法，恒按绝对位置摆）
                  <span className="block text-slate-500">此开关当前不影响游戏内表现，仅保留数据语义：客户端外观一律把坐标当绝对位置；保存时保持勾选即可。</span>
                </span>
              </label>
            ) : null}

            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="primary" onClick={saveActive} loading={pending === activeItem.id} disabled={Boolean(pending) || loadingSaved}>
                保存本件{unsaved ? " ●" : ""}
              </Button>
              {activeItem.kind !== "weapon" ? (
                <Button variant="outline" onClick={snapFeetToGround}>
                  脚底贴地（8 向）
                </Button>
              ) : null}
              <Button variant="outline" onClick={autoAlign} disabled={activeItem.kind === "role"}>
                按裸模给初值
              </Button>
              <Button variant="outline" onClick={applyToAll}>
                当前方向 → 8 向
              </Button>
              <Button variant="outline" onClick={resetItem} disabled={Boolean(pending) || loadingSaved}>
                还原本件
              </Button>
            </div>

            <div className="mt-2 text-[11px] leading-relaxed text-slate-500">
              {unsaved ? "有未保存的改动 —— 按「保存本件」才写进服务端。" : "已与服务端一致；改动会实时存浏览器，刷新不丢。"}
            </div>

            <div className="mt-4 space-y-1 border-t border-slate-800 pt-3 text-[11px] leading-relaxed text-slate-500">
              <div>8 方向全部列出（点格子或按 1-8 切换方向）：</div>
              <div className="grid grid-cols-2 gap-x-2">
                {DIRECTIONS.map((name, index) => {
                  const pos = geometry.outPositions[index] ?? [0, 0];
                  return (
                    <button
                      key={name}
                      onClick={() => setDirection(index)}
                      className={`flex justify-between rounded px-1 py-0.5 text-left ${
                        index === direction ? "bg-indigo-600/20 text-indigo-200" : "hover:bg-slate-800/60"
                      }`}
                    >
                      <span>{DIRECTION_LABELS[name]}</span>
                      <span className="tabular-nums">
                        {pos[0].toFixed(1)},{pos[1].toFixed(1)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {notice ? <div className="mt-3 rounded-lg bg-emerald-500/10 px-2 py-1.5 text-[11px] text-emerald-300">{notice}</div> : null}
          </div>
        </aside>
      </div>
    </div>
  );
}
