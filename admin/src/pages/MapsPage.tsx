import { useCallback, useEffect, useState } from "react";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { Badge, Button, Card, EmptyState, Field as FormField, Input, Select, Spinner } from "../components/ui";
import { MapCanvas, worldBoxOf, type CanvasMode, type DrawBox, type DrawPoint, type MapLayerVisibility } from "../components/map/MapCanvas";
import { CollisionFormDialog } from "../components/map/CollisionForm";
import { MapMonitorDialog } from "../components/map/MapMonitor";
import { MapRulesDialog, ReloadWorldDialog } from "../components/map/MapOps";
import { MapInstancesDialog } from "../components/map/MapInstances";
import { NpcPointFormDialog } from "../components/map/NpcPointForm";
import { outOfBoundsCount, pointsOutOfBounds } from "../components/map/bounds";
import { SpawnAreaFormDialog } from "../components/map/SpawnAreaForm";
import {
  CollisionsDialog,
  LayersDialog,
  NpcPointsDialog,
  SourcesDialog,
  SpawnAreasDialog,
  WorldMonstersDialog,
} from "../components/map/MapDialogs";
import { mapsApi, refreshMapCatalog } from "../api";
import type { MapCollision, MapDetail, MapNpc, MapSpawnArea, MapSummary, MapTypeGroup, SaveMapConfig } from "../api";
import { toastError, toastSuccess } from "../store/toast";

/** 类型码（服务端生成的字面量联合："0" 安全 / "1" 野外；#1177 收敛） */
type MapTypeCode = SaveMapConfig["type"];

/**
 * 画布暂存的一笔改动（#1221）
 *
 * 拖拽挪位 / 改尺寸 / 碰撞顶点增删挪 / 设清复活点**不再松手即请求**：先记成一笔暂存
 * （画布本地即时反映），点「保存改动」才逐项提交。同一个对象连续改多笔只保留最后一笔
 * （key 覆盖），所以暂存数 ≤ 改过的对象数；复活点是单值，set / clear 互相覆盖。
 */
type PendingOp =
  | { kind: "npc"; id: number; npcId: string; cx: number; cy: number }
  | {
      kind: "area";
      id: number;
      name: string;
      monsterKey: string;
      count: number;
      densityPeak?: number;
      densityOff?: number;
      peakHours?: string;
      cx: number;
      cy: number;
      w: number;
      h: number;
    }
  | { kind: "collision"; id: number; points: number[][] }
  | { kind: "revive-set"; cx: number; cy: number }
  | { kind: "revive-clear" };

/** 复活点在暂存里的固定 key（一张图只有一个复活点，set / clear 后写的覆盖前写的） */
const REVIVE_OP_KEY = "revive";

/** 暂存改动的一行短标签（保存失败的提示里点名哪一项没存上） */
function opLabel(op: PendingOp): string {
  switch (op.kind) {
    case "npc":
      return `NPC 点位 #${op.id}`;
    case "area":
      return `刷怪区 #${op.id}「${op.name}」`;
    case "collision":
      return `碰撞多边形 #${op.id}`;
    case "revive-set":
    case "revive-clear":
      return "复活点";
  }
}

/** 编辑表单的形状（= 服务端 `SaveMapConfigDto` 的三个字段；门槛只剩等级，#1177） */
interface MapForm {
  label: string;
  type: MapTypeCode;
  level: string;
}

/**
 * 列表筛选（#1179）：62 张图全量在前端，纯客户端过滤、输入即生效。
 * 有 / 无 三态字段用 "yes" / "no" / "all"，与下拉选项一一对应。
 */
interface MapFilters {
  /** 名称 / id 模糊匹配（空 = 不过滤） */
  keyword: string;
  /** 类型码；"all" = 全部 */
  type: string;
  /** 进入门槛：none 无门槛 / level 等级 / all（#1177 后只剩等级一项门槛） */
  gate: "all" | "none" | "level";
  spawn: "all" | "yes" | "no";
  npc: "all" | "yes" | "no";
  revive: "all" | "yes" | "no";
  collision: "all" | "yes" | "no";
}

const EMPTY_FILTERS: MapFilters = { keyword: "", type: "all", gate: "all", spawn: "all", npc: "all", revive: "all", collision: "all" };

/** 有 / 无 两态下拉的公共选项（刷怪区 / NPC / 复活点 / 碰撞盒四列共用） */
const HAS_OPTIONS: Array<{ value: MapFilters["spawn"]; label: string }> = [
  { value: "all", label: "全部" },
  { value: "yes", label: "有" },
  { value: "no", label: "无" },
];

/** 打开中的观测弹窗（页面主视图只留配置 + 地图，其余按需打开） */
type DialogKey =
  | "layers"
  | "points"
  | "spawn"
  | "collisions"
  | "monsters"
  | "sources"
  | "monitor"
  | "reload"
  | "rules"
  | "instances"
  | null;

/** 叠加层的默认开关：碰撞盒数量大（每图上百个），默认关；其余默认开 */
const DEFAULT_LAYERS: MapLayerVisibility = { spawn: true, npc: true, revive: true, collision: false };

/**
 * 地图管理（#571 观测台 / #573 玩法配置可改 / #580 可视化 + 弹窗）
 *
 * ## 这一页能改什么、不能改什么
 *
 * 按三端边界（用户 2026-11-01 口径）：
 * - **客户端**只保存资源的真实对象 —— TMX 瓦片、底图、预览图；
 * - **服务端**存「对这份资源的整理结果」；
 * - **管理端**可视化地改服务端的整理结果。
 *
 * | 块 | 能不能改 | 改了怎么生效 |
 * |---|---|---|
 * | 名称 / 类型 / 进入等级 | **能改**（`PATCH /admin/maps/:id`；门槛只剩等级，#1177） | 点「保存」立即生效（服务端进图校验读同一张表；客户端下次进游戏拉快照） |
 * | 刷怪区 / NPC 点位 / 复活点 / 碰撞盒 | **能改**（图上拖框 / 点放 / 拖拽微调） | 画布微调先**本地暂存**（#1221），点「保存改动」批量入库；客户端下次进游戏拉快照 |
 * | 图层 / 场上怪物 | 只读 | 改 TMX → 跑导入工具 → 重打包客户端 |
 *
 * #676 起 TMX 里**一个对象组都没有**（`tools/strip-map-objects.cjs` 整组删除），
 * 地图文件 = 瓦片 + 图层，只负责显示。所以「对象组」那块视图也一起下架了。
 *
 * ## 为什么观测数据都在弹窗里
 *
 * 这一页的主任务是「看这张图对不对」，而看的方式是**地图**，不是六个表格。表格平铺在页面上
 * 会把地图挤到需要滚动才能看见的位置 —— 地图页看不到地图，等于没有地图页。
 *
 * ## 两套坐标在图上同时画（页面里最容易看错的地方）
 *
 * | 展示块 | 口径 | 来源 |
 * |---|---|---|
 * | 刷怪区 / NPC 点位 / 复活点 / 碰撞盒 | **世界坐标**（原点 = 地图左上角、y 轴向上，故 cy 为负） | 各自的库表 |
 *
 * 画布是 Tiled 口径（左上角、y 向下），所以「读库 → 画」只做一次 `y = -cy`、提交时反过来。
 * 换算只在 `MapCanvas` 的 `tiledBoxOf` / `worldBoxOf` 两处，别在页面里再手算一遍。
 */
export function MapsPage() {
  const [list, setList] = useState<MapSummary[]>([]);
  const [types, setTypes] = useState<MapTypeGroup[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [detail, setDetail] = useState<MapDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [form, setForm] = useState<MapForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [layers, setLayers] = useState<MapLayerVisibility>(DEFAULT_LAYERS);
  const [dialog, setDialog] = useState<DialogKey>(null);
  const [focusArea, setFocusArea] = useState<number | undefined>(undefined);
  const [focusNpc, setFocusNpc] = useState<number | undefined>(undefined);
  const [focusCollision, setFocusCollision] = useState<number | undefined>(undefined);
  /** 放大地图（密集的图在 620px 宽下标签会挤，这里给到 1024） */
  const [zoomed, setZoomed] = useState(false);
  /** 画布模式：看 / 画刷怪区 / 放 NPC / 设复活点（#672 从「绘制开关」扩成四态） */
  const [mode, setMode] = useState<CanvasMode>("view");
  /** 刚画出来的框（Tiled 口径）—— 有它就打开新建刷怪区表单 */
  const [draft, setDraft] = useState<DrawBox | null>(null);
  /** 正在编辑的刷怪区（有它就打开编辑表单）；与 draft 互斥 */
  const [editArea, setEditArea] = useState<MapSpawnArea | null>(null);
  /** 刚点出来的 NPC 落点（Tiled 口径）—— 有它就打开「放哪个 NPC」表单 */
  const [npcDraft, setNpcDraft] = useState<DrawPoint | null>(null);
  /** 正在编辑的 NPC 点位；与 npcDraft 互斥 */
  const [editNpc, setEditNpc] = useState<MapNpc | null>(null);
  /** 刚点绘封闭的碰撞多边形（Tiled 口径顶点）—— 有它就打开新建表单 */
  const [collisionDraft, setCollisionDraft] = useState<DrawPoint[] | null>(null);
  /** 正在编辑的碰撞多边形；与 collisionDraft 互斥 */
  const [editCollision, setEditCollision] = useState<MapCollision | null>(null);
  /** 画布暂存改动（key → op，#1221）：保存前不发请求，画布本地即时反映 */
  const [pending, setPending] = useState<Map<string, PendingOp>>(new Map());
  /** 「保存改动」批量提交中 */
  const [savingEdits, setSavingEdits] = useState(false);

  /** 列表筛选条件（#1179，形状见 MapFilters） */
  const [filters, setFilters] = useState<MapFilters>(EMPTY_FILTERS);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const data = await mapsApi.list();
      setList(data.list);
      setTypes(data.types ?? []);
      setSelected((current) => current || data.list[0]?.id || "");
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setDetailLoading(true);
    // 换图 = 丢弃上一张图的画布暂存（入口 pickMap 已弹过确认；这里兜住程序化的切图路径）
    setPending(new Map());
    mapsApi
      .detail(selected)
      .then((data) => {
        if (cancelled) return;
        setDetail(data);
        setForm(formOf(data));
      })
      .catch(() => {
        /* 错误已由请求层统一提示 */
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  /**
   * 左列表点一张图（#1221）：画布上有未保存改动时先弹确认——
   * 暂存只改了本地（库里没动过），确认切图 = 丢弃本地暂存。
   */
  const pickMap = (id: string) => {
    if (id !== selected && pending.size > 0 && !window.confirm(`这张图有 ${pending.size} 项未保存的画布改动，切换将丢弃，确定吗？`)) return;
    setSelected(id);
  };

  /** 保存玩法配置（整份覆盖；只提交这五个字段） */
  const save = async () => {
    if (!form || !detail || saving) return;
    setSaving(true);
    try {
      const saved = await mapsApi.save(detail.id, {
        label: form.label.trim(),
        type: form.type,
        level: toInt(form.level),
      });
      // 服务端返回的是保存后那一行（含计数）—— 直接铺回列表与详情，不额外再拉一次
      setList((prev) => prev.map((item) => (item.id === saved.id ? { ...item, ...saved } : item)));
      setDetail((prev) => (prev ? { ...prev, ...saved } : prev));
      setForm(formOf(saved));
      // 类型改成安全地图之后不能再画刷怪区（#1157）：保存成功就把绘制模式退掉，
      // 免得画布还停在「拖框 = 建区」的状态、拖一下换一个服务端 400
      if (saved.type === "0" && mode === "spawn") setMode("view");
      // 角色详情 / 实体选择器读的是本地名录缓存，保存成功要让它重新拉一次
      void refreshMapCatalog();
      toastSuccess(`「${saved.label}」的玩法配置已保存（服务端立即生效，客户端下次进游戏拉取）`);
    } catch {
      /* 错误已由请求层统一提示（400 的字段级消息也在里面） */
    } finally {
      setSaving(false);
    }
  };

  /** 切换画布模式（再点一次同一个模式 = 回到查看；换模式时把上一个模式的草稿清掉） */
  const switchMode = (next: CanvasMode) => {
    // 安全地图不允许配怪（#1157）：「绘制刷怪区」按钮已置灰，这里再兜一层
    // （同一个入口将来若被快捷键 / 脚本调到，也不该绕过）
    if (next === "spawn" && detail?.type === "0") return;
    setMode((current) => (current === next ? "view" : next));
    setDraft(null);
    setEditArea(null);
    setNpcDraft(null);
    setEditNpc(null);
    setCollisionDraft(null);
    setEditCollision(null);
    // 进碰撞模式顺手点亮碰撞层（#1196）：该层默认关是「数量大不糊图」的取舍，
    // 但「点绘封闭 → 保存 → 图上没有」会被当成没存上 —— 回显必须跟着模式走。
    // 只在「进模式」这一次开：用户手动关掉之后切出去再切回来仍会再亮，
    // 想保持关闭看数据走列表弹窗，图上勾选随时可再关。
    if (next === "collision") setLayers((current) => ({ ...current, collision: true }));
  };

  /** 从图上点刷怪区 → 直接打开编辑表单（列表弹窗仍然保留，用来总览与删） */
  const openArea = (area: MapSpawnArea) => {
    setDraft(null);
    setEditArea(area);
  };

  /** 画布上拖完一个框 → 打开新建表单（框已经带位置尺寸，只差「刷什么、几只」） */
  const onDrawBox = (box: DrawBox) => {
    setEditArea(null);
    setDraft(box);
  };

  /** `npc` 模式点空白 → 打开「放哪个 NPC」（落点已定，只差「是谁」） */
  const onPlaceNpc = (point: DrawPoint) => {
    setEditNpc(null);
    setNpcDraft(point);
  };

  /** 把一笔改动记进暂存（#1221；同一对象后写覆盖前写，所以暂存数 ≤ 改过的对象数） */
  const stage = (key: string, op: PendingOp) =>
    setPending((prev) => {
      const next = new Map(prev);
      next.set(key, op);
      return next;
    });

  /** 画布微调的本地落地（#1221）：只改 detail 让画布即时反映，不发请求；越界标记按本地口径重算，保存后以服务端拉回为准 */
  const applyDetail = (updater: (d: MapDetail) => MapDetail) => setDetail((prev) => (prev ? updater(prev) : prev));

  /**
   * `npc` 模式拖完一个已有的点 → 暂存新落点（#1221）
   *
   * 保存时 `npcId` 原样带回（只改坐标）；画布立刻挪到位，不弹提示不刷新。
   */
  const onMoveNpc = (point: MapNpc, to: DrawPoint) => {
    const cx = round2(to.x);
    const cy = round2(-to.y);
    stage(`npc:${point.id}`, { kind: "npc", id: point.id, npcId: point.npcId, cx, cy });
    applyDetail((d) => ({
      ...d,
      npcPoints: d.npcPoints.map((n) => (n.id === point.id ? { ...n, cx, cy, inBounds: pointInBounds(d, cx, cy) } : n)),
    }));
  };

  /** `spawn` 模式拖完已有区域（挪位 / 改尺寸共用）→ 暂存新框；其余字段原样保留（接口是整份覆盖） */
  const stageAreaBox = (area: MapSpawnArea, box: { cx: number; cy: number; w: number; h: number }) => {
    stage(`area:${area.id}`, {
      kind: "area",
      id: area.id,
      name: area.name,
      monsterKey: area.monsterKey,
      count: area.max,
      densityPeak: area.densityPeak ?? undefined,
      densityOff: area.densityOff ?? undefined,
      peakHours: area.peakHours ?? undefined,
      ...box,
    });
    applyDetail((d) => ({
      ...d,
      spawnAreas: d.spawnAreas.map((a) => (a.id === area.id ? { ...a, ...box, ...areaBounds(d, box) } : a)),
    }));
  };

  /**
   * `spawn` 模式拖完一个已有区域 → 暂存新中心（#1219 的拖拽挪位，#1221 起先暂存）
   */
  const onMoveArea = (area: MapSpawnArea, to: DrawPoint) => stageAreaBox(area, { cx: round2(to.x), cy: round2(-to.y), w: area.w, h: area.h });

  /**
   * `spawn` 模式拖完四角手柄 → 暂存新尺寸（#1219；#1221 起先暂存）
   *
   * 手柄给出的是 Tiled 口径的新框，`worldBoxOf` 换算回世界坐标（页面不手算几何，
   * 换算只在 MapCanvas 的 tiled/world 两兄弟函数里）。
   */
  const onResizeArea = (area: MapSpawnArea, box: DrawBox) => stageAreaBox(area, worldBoxOf(box));

  /** `collision` 模式点绘封闭 → 打开新建表单（顶点已带坐标，只差确认 / 微调） */
  const onDrawCollisionPolygon = (points: DrawPoint[]) => {
    setEditCollision(null);
    setCollisionDraft(points);
  };

  /** `collision` 模式顶点增删挪的公共暂存：整份记录新顶点序列（id 不变） */
  const stageCollisionPoints = (box: MapCollision, points: number[][]) => {
    stage(`collision:${box.id}`, { kind: "collision", id: box.id, points });
    applyDetail((d) => ({
      ...d,
      collisions: d.collisions.map((c) => (c.id === box.id ? { ...c, points, fullyOutside: polygonFullyOutside(d, points) } : c)),
    }));
  };

  /** `collision` 模式拖完一个顶点 → 暂存新顶点序列 */
  const onMoveCollisionVertex = (box: MapCollision, index: number, to: DrawPoint) =>
    stageCollisionPoints(
      box,
      box.points.map(([x, y], i) => (i === index ? [round2(to.x), round2(-to.y)] : [x, y])),
    );

  /** `collision` 模式双击一条边 → 在它的中点插一个顶点（暂存） */
  const onInsertCollisionVertex = (box: MapCollision, edgeIndex: number) => {
    const a = box.points[edgeIndex];
    const b = box.points[(edgeIndex + 1) % box.points.length];
    const mid: number[] = [round2((a[0] + b[0]) / 2), round2((a[1] + b[1]) / 2)];
    stageCollisionPoints(box, [...box.points.slice(0, edgeIndex + 1), mid, ...box.points.slice(edgeIndex + 1)]);
  };

  /** `collision` 模式双击一个顶点 → 删掉它（画布已保底 ≥3 点，暂存） */
  const onDeleteCollisionVertex = (box: MapCollision, index: number) => {
    if (box.points.length <= 3) return;
    stageCollisionPoints(box, box.points.filter((_, i) => i !== index));
  };

  /** `revive` 模式点空白 → 暂存新复活点（不需要表单：位置就是全部信息） */
  const onPlaceRevive = (point: DrawPoint) => {
    const cx = round2(point.x);
    const cy = round2(-point.y);
    stage(REVIVE_OP_KEY, { kind: "revive-set", cx, cy });
    applyDetail((d) => ({ ...d, revivePoint: { cx, cy, inBounds: pointInBounds(d, cx, cy) } }));
  };

  /** 清掉复活点（暂存；入库后玩家死在这张图会退回上一处——保存前随时可「放弃」还原） */
  const clearRevivePoint = () => {
    stage(REVIVE_OP_KEY, { kind: "revive-clear" });
    applyDetail((d) => ({ ...d, revivePoint: null }));
  };

  /** 点图上已有的碰撞多边形 → 打开编辑表单（多边形没有名字，靠画布高亮认人） */
  const openCollision = (box: MapCollision) => {
    setCollisionDraft(null);
    setEditCollision(box);
  };

  /**
   * 只刷新当前这张图（#1221）：详情重拉 + 左列表该行计数本地更新。
   * 不再 `loadList` 全刷——别的图的计数没变，62 张图没必要陪着一起转。
   * 故意不动玩法配置表单 `form`：画布改动与名称/类型/等级无关，重拉不该覆盖还没保存的输入。
   */
  const refreshDetail = useCallback(() => {
    if (!selected) return Promise.resolve();
    return mapsApi
      .detail(selected)
      .then((data) => {
        setDetail(data);
        // 左列表该行的计数跟着新详情走（字段与 MapSummary 同名，只铺计数块，别整份覆盖丢列）
        setList((prev) => prev.map((item) => (item.id === data.id ? { ...item, ...countsOf(data) } : item)));
      })
      .catch(() => {
        /* 错误已由请求层统一提示 */
      });
  }, [selected]);

  /** 放弃全部画布暂存：本地还原到服务端最后确认的状态（只拉当前图，不动列表） */
  const discardEdits = () => {
    setPending(new Map());
    void refreshDetail();
  };

  /**
   * 「保存改动」：把暂存逐项提交（#1221）
   *
   * 失败项保留在暂存里（可再点保存重试），成功项清掉；无论成败都重拉当前图——
   * 入库后的 `inBounds` / 计数以服务端为准，本地预览口径让位。逐条串行而不是并发：
   * 同一张图的写接口幂等且互不依赖，串行只是让失败名单和提交顺序一致，量级（≤ 改过的对象数）撑得住。
   */
  const saveEdits = async () => {
    if (!detail || pending.size === 0 || savingEdits) return;
    setSavingEdits(true);
    const ops = [...pending.values()];
    const failed: PendingOp[] = [];
    for (const op of ops) {
      try {
        switch (op.kind) {
          case "npc":
            await mapsApi.updateNpc(detail.id, String(op.id), { npcId: op.npcId, cx: op.cx, cy: op.cy });
            break;
          case "area":
            await mapsApi.updateSpawnArea(detail.id, String(op.id), {
              name: op.name,
              monsterKey: op.monsterKey,
              count: op.count,
              densityPeak: op.densityPeak,
              densityOff: op.densityOff,
              peakHours: op.peakHours,
              cx: op.cx,
              cy: op.cy,
              w: op.w,
              h: op.h,
            });
            break;
          case "collision":
            await mapsApi.updateCollision(detail.id, String(op.id), { points: op.points });
            break;
          case "revive-set":
            await mapsApi.setRevivePoint(detail.id, { cx: op.cx, cy: op.cy });
            break;
          case "revive-clear":
            await mapsApi.clearRevivePoint(detail.id);
            break;
        }
      } catch {
        failed.push(op);
      }
    }
    setPending(new Map(failed.map((op) => [keyOf(op), op])));
    setSavingEdits(false);
    await refreshDetail();
    if (failed.length === 0) toastSuccess(`${ops.length} 项画布改动已保存`);
    else toastError(`${failed.length} 项没存上：${failed.map(opLabel).join("、")}（已保留在暂存里，可再点「保存改动」重试）`);
  };

  /** 从图上点 NPC → 打开该点位的编辑表单 */
  const openNpc = (point: MapNpc) => {
    setNpcDraft(null);
    setEditNpc(point);
    // 顺手记下焦点：之后打开点位清单时那一行会被高亮（从图上认人 → 去表里核对的路径）
    setFocusNpc(point.id);
  };

  /**
   * 查看模式点复活点 → 切到复活点模式
   *
   * 复活点没有表单可填（位置就是全部信息），所以「点它」的下一步应该是「能拖它」，
   * 而不是弹一个只有两个数字的框再让人关掉。
   */
  const openRevive = () => {
    setMode("revive");
    setDraft(null);
    setEditArea(null);
    setNpcDraft(null);
    setEditNpc(null);
    setCollisionDraft(null);
    setEditCollision(null);
  };

  const dirty = !!form && !!detail && !sameForm(form, formOf(detail));
  /** 越界数（区域 + 点位；服务端判，0 时页面保持安静，>0 才出红色徽标） */
  const outOfBounds = detail ? outOfBoundsCount(detail.spawnAreas) + pointsOutOfBounds(detail) : 0;

  /**
   * 筛选后的列表（#1179）。纯前端过滤：清单本来就一次全量下发，62 条不值得发请求；
   * 门槛二选一互相独立（level > 0 = 配了等级门槛），与类型筛选可叠加。
   */
  const filteredList = list.filter((item) => {
    const keyword = filters.keyword.trim().toLowerCase();
    if (keyword && !item.label.toLowerCase().includes(keyword) && !item.id.includes(keyword)) return false;
    if (filters.type !== "all" && item.type !== filters.type) return false;
    if (filters.gate === "none" && item.level > 0) return false;
    if (filters.gate === "level" && item.level <= 0) return false;
    if (filters.spawn !== "all" && (item.spawnAreaCount > 0) !== (filters.spawn === "yes")) return false;
    if (filters.npc !== "all" && (item.npcPointCount > 0) !== (filters.npc === "yes")) return false;
    if (filters.revive !== "all" && item.hasRevivePoint !== (filters.revive === "yes")) return false;
    if (filters.collision !== "all" && (item.collisionCount > 0) !== (filters.collision === "yes")) return false;
    return true;
  });

  /** 有条件在生效（决定「清空」按钮与标题里的 `n/m` 计数样式） */
  const filterActive = JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS);

  /** 一键回到「不筛选」 */
  const clearFilters = () => setFilters(EMPTY_FILTERS);

  /** 有 / 无 三态下拉的统一 onChange（key 限定在四个 has 类字段上） */
  const setHasFilter = (key: "spawn" | "npc" | "revive" | "collision", value: string) =>
    setFilters({ ...filters, [key]: value as MapFilters["spawn"] });

  return (
    <div className="space-y-3">
      <PageHeader
        title="地图管理"
        description="玩法配置、刷怪区、NPC、复活点与碰撞盒都在这里改，保存即生效；地图文件只剩瓦片（底图与预览图是资源）。"
        actions={
          <>
            <Badge tone="gold">可编辑玩法配置</Badge>
            <Button variant="ghost" onClick={() => void loadList()}>
              刷新
            </Button>
          </>
        }
      />

      {/* 列表筛选（#1179）：清单全量在前端，输入即过滤，所以没有「查询」按钮，只有清空 */}
      {!loading ? (
        <Card>
          <div className="flex flex-wrap items-end gap-2">
            <FormField width="w-44" label="名称 / id">
              <Input
                value={filters.keyword}
                placeholder="模糊匹配"
                onChange={(event) => setFilters({ ...filters, keyword: event.target.value })}
              />
            </FormField>
            <FormField width="w-36" label="类型">
              <Select value={filters.type} onChange={(event) => setFilters({ ...filters, type: event.target.value })}>
                <option value="all">全部</option>
                {types.map((group) => (
                  <option key={group.type} value={group.type}>
                    {group.label}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField width="w-36" label="进入门槛">
              <Select value={filters.gate} onChange={(event) => setFilters({ ...filters, gate: event.target.value as MapFilters["gate"] })}>
                <option value="all">全部</option>
                <option value="none">无门槛</option>
                <option value="level">有等级门槛</option>
              </Select>
            </FormField>
            <FormField width="w-28" label="刷怪区">
              <Select value={filters.spawn} onChange={(event) => setHasFilter("spawn", event.target.value)}>
                {HAS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField width="w-28" label="NPC 点位">
              <Select value={filters.npc} onChange={(event) => setHasFilter("npc", event.target.value)}>
                {HAS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField width="w-28" label="复活点">
              <Select value={filters.revive} onChange={(event) => setHasFilter("revive", event.target.value)}>
                {HAS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField width="w-28" label="碰撞盒">
              <Select value={filters.collision} onChange={(event) => setHasFilter("collision", event.target.value)}>
                {HAS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </FormField>
            {filterActive ? (
              <Button variant="outline" onClick={clearFilters}>
                清空筛选
              </Button>
            ) : null}
          </div>
        </Card>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 py-10 text-xs text-ink-5">
          <Spinner /> 加载地图清单…
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[260px_minmax(0,1fr)]">
          {/*
            左卡与右列等高、列表在卡内滚（#1151，#1168 修「等高没生效」）：
            - 关键：grid 行高 = 两列**内容自然高度的最大值**。62 张地图的左列表远比右列高，
              行被左列撑到几千 px，`h-full` 等来的只是「等高等于巨行」——滚动落到了整页上。
              所以左卡必须在 lg 上**脱离文档流**（外层 relative + 卡 absolute inset-0）：
              绝对定位不参与行高计算，行高才真正由右列（配置卡 + 地图卡）决定。
            - `Card` 的正文是裸 `<div>`（ui.tsx 没开 className 口子），用任意子选择器把它转成
              flex 的滚动区：`min-h-0` 是 flex 子项能触发 `overflow-y-auto` 的前提，
              缺了它正文会被内容撑到自然高度、整卡跟着长高（与「明明写了 overflow 还是在滚整页」同一个根因）；
            - header 不参与滚动（它是 `<header>`，选择器只命中正文 div）。
            窄屏单列：absolute 不生效，卡回到文档流、随内容自然长，与原行为一致。
          */}
          <div className="lg:relative">
            <Card
              title={`地图（${filteredList.length}${filterActive ? `/${list.length}` : ""}）`}
              description="按 id 升序，点一行看详情；列表超出卡体时在卡内滚动"
              className="flex flex-col overflow-hidden lg:absolute lg:inset-0 [&>div]:min-h-0 [&>div]:flex-1 [&>div]:overflow-y-auto"
            >
              <ul className="space-y-1">
                {filteredList.map((item) => {
                  const active = item.id === selected;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => pickMap(item.id)}
                        className={`w-full rounded-lg border px-2.5 py-2 text-left transition ${
                          active ? "border-gold/50 bg-gold/10" : "border-line bg-surface-2/40 hover:border-line-strong"
                        }`}
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-sm text-ink-1">{item.label || `（未命名 #${item.id}）`}</span>
                          <span className="shrink-0 text-xs text-ink-5">#{item.id}</span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-5">
                          <span>{item.typeLabel}</span>
                          <span>·</span>
                          <span>
                            {item.cols}×{item.rows}
                          </span>
                          <span>·</span>
                          <span>刷怪区 {item.spawnAreaCount}</span>
                          <span>·</span>
                          <span>NPC {item.npcPointCount}</span>
                          <span>·</span>
                          <span>碰撞 {item.collisionCount}</span>
                          {/* 复活点只有「有 / 没有」两种状态：没有时不必占位，写出来反而像少了一个 */}
                          {item.hasRevivePoint ? <span className="text-jade/70">· 复活点</span> : null}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {filteredList.length === 0 ? (
                <p className="py-6 text-center text-xs text-ink-5">没有匹配的地图，换个筛选条件试试</p>
              ) : null}
            </Card>
          </div>

          <div className="space-y-3">
            {detailLoading && !detail ? (
              <Card>
                <div className="flex items-center gap-2 py-10 text-xs text-ink-5">
                  <Spinner /> 加载地图详情…
                </div>
              </Card>
            ) : !detail || !form ? (
              <Card>
                <EmptyState title="选一张地图" description="左侧列表里点一张图，这里显示它的玩法配置与地图" />
              </Card>
            ) : (
              <>
                <Card
                  title={`${detail.label || `（未命名 #${detail.id}）`}（#${detail.id}）· 玩法配置`}
                  description="保存即生效：服务端进图校验读这张表，客户端下次进游戏拉取新配置"
                  actions={
                    <div className="flex items-center gap-2">
                      {dirty && <Badge tone="warn">未保存</Badge>}
                      <Button variant="ghost" onClick={() => setForm(formOf(detail))} disabled={!dirty || saving}>
                        还原
                      </Button>
                      <Button onClick={() => void save()} disabled={!dirty || saving || !form.label.trim()}>
                        {saving ? "保存中…" : "保存"}
                      </Button>
                    </div>
                  }
                >
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    <FormField label="地图名称">
                      <Input value={form.label} maxLength={24} placeholder="如：卧龙城" onChange={(event) => setForm({ ...form, label: event.target.value })} />
                    </FormField>
                    <FormField label="类型（决定传送弹窗分组）">
                      <Select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value as MapTypeCode })}>
                        {types.map((type) => (
                          <option key={type.type} value={type.type}>
                            {type.label}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                    <FormField label="进入等级（0 = 不限）">
                      <Input type="number" min={0} max={200} value={form.level} onChange={(event) => setForm({ ...form, level: event.target.value })} />
                    </FormField>
                  </div>
                  <p className="mt-2 text-[11px] text-ink-5">
                    数值 <code className="text-ink-4">0</code> 表示<b>不限制</b>（安全地图就是 0）。门槛只剩等级一项（#1177 删了战斗力 / 战魂阶）；已经在图里的玩家不受影响，新门槛从下一次进游戏开始生效。
                    <br />
                    类型选<b>安全地图</b>的图<b>不允许配刷怪区</b>（服务端会拒）：要在这张图上刷怪，类型必须是野外地图；反过来，图里还有刷怪区时也改不回安全地图。
                  </p>
                </Card>

                <Card
                  title="地图"
                  description={
                    <>
                      刷怪区、NPC、复活点、碰撞盒都在**这张图上改**（#667 / #672 / #676 起 TMX 不再是它们的来源）：
                      拖框 / 点放建新对象在表单里确认即入库；**拖拽挪位、改尺寸、碰撞顶点微调、设清复活点先暂存在画布上**，
                      攒完点右上「保存改动」一次入库（#1221），保存前后都只刷新这张图。
                      <br />
                      区域与点位必须落在图内：越界的那块会被画布裁掉，所以越界的区域描成红色虚线、越界的点位画成红圈虚线 —— 新建时越界会被服务端直接拒。
                      **碰撞盒例外**：四面围墙本来就画在图外，允许越界，只有「整块在图外」会标红。
                      <br />
                      资源 {detail.src || "—"} · {detail.cols}×{detail.rows} 格（{detail.width}×{detail.height} px）· 图层 {detail.layerCount} · NPC{" "}
                      {detail.npcPoints.length} · 复活点 {detail.revivePoint ? "已设" : "未设"} · 刷怪区 {detail.spawnAreaCount} · 碰撞盒{" "}
                      {detail.collisions.length} · 场上怪物 {detail.worldMonsterCount}
                    </>
                  }
                  actions={
                    <>
                      {/* 只在有越界时出现：0 越界是常态，天天挂一个绿徽标等于没有徽标 */}
                      {outOfBounds > 0 && <Badge tone="ember">越界 {outOfBounds}</Badge>}
                      {/* 画布暂存（#1221）：有改动才出现，保存 / 放弃都在这一排 */}
                      {pending.size > 0 && <Badge tone="warn">画布改动 {pending.size} 未保存</Badge>}
                      {pending.size > 0 && (
                        <Button variant="ghost" onClick={discardEdits} disabled={savingEdits}>
                          放弃改动
                        </Button>
                      )}
                      {pending.size > 0 && (
                        <Button onClick={() => void saveEdits()} disabled={savingEdits}>
                          {savingEdits ? "保存中…" : "保存改动"}
                        </Button>
                      )}
                      <Button variant="ghost" onClick={() => setZoomed(true)}>
                        放大
                      </Button>
                      <Button variant="ghost" onClick={() => setLayers(DEFAULT_LAYERS)}>
                        重置图层
                      </Button>
                    </>
                  }
                >
                  <LayerLegend visible={layers} onChange={setLayers} />
                  <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-ink-5">
                    <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm border-2 border-dashed" style={{ borderColor: "var(--color-ember)" }} />
                    红色虚线 = 越出地图边界的区域 / 点位（超出部分被画布裁掉，图上只剩缺角）；碰撞盒不参与越界计数（围墙本来就画在图外）
                  </p>
                  <div className="mt-2">
                    <MapCanvas
                      detail={detail}
                      visible={layers}
                      onPickArea={openArea}
                      onPickNpc={openNpc}
                      onPickRevive={openRevive}
                      mode={mode}
                      selectedAreaId={editArea?.id}
                      selectedNpcId={editNpc?.id}
                      selectedCollisionId={editCollision?.id}
                      onDrawBox={onDrawBox}
                      onDrawCollisionPolygon={onDrawCollisionPolygon}
                      onPickCollision={openCollision}
                      onMoveCollisionVertex={onMoveCollisionVertex}
                      onInsertCollisionVertex={onInsertCollisionVertex}
                      onDeleteCollisionVertex={onDeleteCollisionVertex}
                      onPlaceNpc={onPlaceNpc}
                      onMoveNpc={onMoveNpc}
                      onPlaceRevive={onPlaceRevive}
                      onMoveArea={onMoveArea}
                      onResizeArea={onResizeArea}
                    />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <ModeSwitch mode={mode} onChange={switchMode} spawnBlocked={detail.type === "0"} />
                    {/* 安全地图不刷怪（#1157）：按钮置灰，旁边再说一句「怎么才能画」 */}
                    {detail.type === "0" ? (
                      <span className="text-[11px] text-warn-hi">安全地图不刷怪：要画刷怪区，先把上面的「类型」改成野外地图</span>
                    ) : null}
                    {/* 复活点是单值：有就允许清，没有就不显示（一个点了没反应的按钮比没有更糟） */}
                    {detail.revivePoint ? (
                      <Button variant="ghost" onClick={clearRevivePoint}>
                        清除复活点
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setFocusArea(undefined);
                        setDialog("spawn");
                      }}
                    >
                      刷怪区（{detail.spawnAreas.length}）
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setFocusNpc(undefined);
                        setDialog("points");
                      }}
                    >
                      NPC / 复活点（{detail.npcPoints.length + (detail.revivePoint ? 1 : 0)}）
                    </Button>
                    <Button variant="ghost" onClick={() => setDialog("monsters")}>
                      场上怪物（{detail.worldMonsterCount}）
                    </Button>
                    <Button variant="ghost" onClick={() => setDialog("monitor")}>
                      实时监控
                    </Button>
                    <Button variant="ghost" onClick={() => setDialog("reload")}>
                      重载世界
                    </Button>
                    <Button variant="ghost" onClick={() => setDialog("rules")}>
                      玩法规则
                    </Button>
                    <Button variant="ghost" onClick={() => setDialog("instances")}>
                      副本
                    </Button>
                    <Button variant="ghost" onClick={() => setDialog("layers")}>
                      图层（{detail.layerCount}）
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setFocusCollision(undefined);
                        setDialog("collisions");
                      }}
                    >
                      碰撞盒（{detail.collisions.length}）
                    </Button>
                    <Button variant="ghost" onClick={() => setDialog("sources")}>
                      数据来源
                    </Button>
                  </div>
                </Card>
              </>
            )}
          </div>
        </div>
      )}

      <Modal
        open={zoomed}
        title={`${detail?.label ?? ""}（#${detail?.id ?? ""}）· 放大地图`}
        hint="与页面上是同一份数据，只是画得更大；密集的图在这里看标签与区域边界"
        size="xl"
        onClose={() => setZoomed(false)}
      >
        {detail ? (
          <MapCanvas
            detail={detail}
            visible={layers}
            maxWidth="min(100%, 72vh)"
            onPickArea={() => undefined}
            onPickNpc={() => undefined}
          />
        ) : null}
      </Modal>

      {detail ? (
        <SpawnAreaFormDialog
          open={!!draft || !!editArea}
          mapId={detail.id}
          detail={detail}
          area={editArea}
          draft={draft}
          onClose={() => {
            setDraft(null);
            setEditArea(null);
          }}
          onSaved={() => void refreshDetail()}
        />
      ) : null}
      {detail ? (
        <CollisionFormDialog
          open={!!collisionDraft || !!editCollision}
          mapId={detail.id}
          detail={detail}
          box={editCollision}
          draft={collisionDraft}
          onClose={() => {
            setCollisionDraft(null);
            setEditCollision(null);
          }}
          onSaved={() => void refreshDetail()}
        />
      ) : null}
      {detail ? (
        <NpcPointFormDialog
          open={!!npcDraft || !!editNpc}
          mapId={detail.id}
          detail={detail}
          point={editNpc}
          draft={npcDraft}
          onClose={() => {
            setNpcDraft(null);
            setEditNpc(null);
          }}
          onSaved={() => void refreshDetail()}
        />
      ) : null}
      <SpawnAreasDialog
        open={dialog === "spawn"}
        detail={detail}
        focusId={focusArea}
        onEdit={(area) => {
          setDialog(null);
          openArea(area);
        }}
        onClose={() => setDialog(null)}
      />
      <NpcPointsDialog
        open={dialog === "points"}
        detail={detail}
        focusId={focusNpc}
        onEdit={(point) => {
          setDialog(null);
          openNpc(point);
        }}
        onEditRevive={() => {
          setDialog(null);
          setMode("revive");
        }}
        onClose={() => setDialog(null)}
      />
      <WorldMonstersDialog open={dialog === "monsters"} detail={detail} onClose={() => setDialog(null)} />
      {detail ? (
        <MapMonitorDialog
          open={dialog === "monitor"}
          mapId={detail.id}
          mapLabel={detail.label}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {detail ? (
        <ReloadWorldDialog
          open={dialog === "reload"}
          mapId={detail.id}
          mapLabel={detail.label}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {detail ? (
        <MapRulesDialog
          open={dialog === "rules"}
          mapId={detail.id}
          mapLabel={detail.label}
          mapType={detail.type}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {detail ? (
        <MapInstancesDialog
          open={dialog === "instances"}
          mapId={detail.id}
          mapLabel={detail.label}
          onClose={() => setDialog(null)}
        />
      ) : null}
      <LayersDialog open={dialog === "layers"} detail={detail} onClose={() => setDialog(null)} />
      <CollisionsDialog
        open={dialog === "collisions"}
        detail={detail}
        focusId={focusCollision}
        onEdit={(box) => {
          setDialog(null);
          openCollision(box);
        }}
        onClose={() => setDialog(null)}
      />
      <SourcesDialog open={dialog === "sources"} detail={detail} onClose={() => setDialog(null)} />
    </div>
  );
}

/**
 * 模式切换（查看 / 画刷怪区 / 放 NPC / 设复活点）
 *
 * 四个分段按钮而不是四个独立按钮：它们是**互斥状态**，用互斥的样式说出来（当前那个高亮）。
 * 再点一次当前模式 = 回查看 —— 编辑态是「临时借用的画布」，用完该能一键还回去。
 *
 * `spawnBlocked`：安全地图（类型 = 安全地图）不允许配怪（#1157），「绘制刷怪区」直接置灰。
 * 服务端也会拒（权威在那儿），这里只是让他在拖框之前就知道为什么不行。
 */
function ModeSwitch({
  mode,
  onChange,
  spawnBlocked,
}: {
  mode: CanvasMode;
  onChange: (next: CanvasMode) => void;
  spawnBlocked: boolean;
}) {
  const items: Array<{ key: CanvasMode; label: string; active: string; disabled?: boolean; hint?: string }> = [
    {
      key: "spawn",
      label: "绘制刷怪区",
      active: "bg-warn/20 text-warn-hi",
      disabled: spawnBlocked,
      hint: "安全地图不刷怪：先把上面的「类型」改成野外地图",
    },
    { key: "collision", label: "绘制碰撞多边形", active: "bg-ember/20 text-ember-hi" },
    { key: "npc", label: "放置 NPC", active: "bg-gold/20 text-gold-hi" },
    { key: "revive", label: "设复活点", active: "bg-jade/20 text-jade-hi" },
  ];
  return (
    <div className="flex overflow-hidden rounded-lg border border-line">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          disabled={item.disabled}
          onClick={() => onChange(item.key)}
          className={`px-2.5 py-1.5 text-xs font-medium transition ${
            item.disabled
              ? "cursor-not-allowed text-ink-5 opacity-50"
              : mode === item.key
                ? item.active
                : "text-ink-3 hover:bg-surface-4/60"
          }`}
          // 再点一次退出：提示写在 title 里，不给按钮换字（换字会让四个按钮宽度跳变）
          title={item.disabled ? item.hint : mode === item.key ? "再点一次退出该模式" : undefined}
        >
          {item.label}
        </button>
      ))}
      {mode !== "view" ? (
        <button
          type="button"
          onClick={() => onChange("view")}
          className="border-l border-line px-2.5 py-1.5 text-xs text-ink-4 transition hover:bg-surface-4/60"
        >
          退出
        </button>
      ) : null}
    </div>
  );
}

/** 叠加层图例 + 开关（色块与 MapCanvas 的描边同一套颜色，靠 label 对上而不是靠记忆） */
function LayerLegend({ visible, onChange }: { visible: MapLayerVisibility; onChange: (next: MapLayerVisibility) => void }) {
  const items: Array<{ key: keyof MapLayerVisibility; label: string; color: string; dash?: boolean }> = [
    { key: "spawn", label: "刷怪区（服务端）", color: "var(--color-gold)" },
    { key: "npc", label: "NPC", color: "var(--color-jade)" },
    { key: "revive", label: "复活点", color: "var(--color-warn)" },
    { key: "collision", label: "碰撞盒", color: "var(--color-ember-hi)" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {items.map((item) => (
        <label key={item.key} className="flex cursor-pointer items-center gap-1.5 text-[11px] text-ink-4">
          <input
            type="checkbox"
            checked={visible[item.key]}
            onChange={(event) => onChange({ ...visible, [item.key]: event.target.checked })}
            className="h-3 w-3 accent-gold"
          />
          <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: item.dash ? "transparent" : item.color, border: `2px ${item.dash ? "dashed" : "solid"} ${item.color}` }} />
          {item.label}
        </label>
      ))}
    </div>
  );
}

/** 详情 → 表单（数字转字符串：输入框里「0」与空串是两件事） */
function formOf(row: MapSummary): MapForm {
  return {
    label: row.label,
    type: row.type as MapTypeCode,
    level: String(row.level),
  };
}

/** 表单 → 整数（空串 / 非法值按 0 = 不限制；服务端还会再校验一次范围） */
function toInt(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/** 两份表单是否等价（数字按数值比：`"10"` 与 `"010"` 存进去是同一个值） */
function sameForm(a: MapForm, b: MapForm): boolean {
  return a.label.trim() === b.label.trim() && a.type === b.type && toInt(a.level) === toInt(b.level);
}

/** 与画布像素对齐到两位小数（拖动 / 点按算出来的 1234.5678 进库没有意义，也让 e2e 能直接对数字） */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 暂存改动 → Map key（stage 与保存后「只留失败项」用同一把钥匙，才覆盖得到同一笔） */
function keyOf(op: PendingOp): string {
  switch (op.kind) {
    case "npc":
      return `npc:${op.id}`;
    case "area":
      return `area:${op.id}`;
    case "collision":
      return `collision:${op.id}`;
    case "revive-set":
    case "revive-clear":
      return REVIVE_OP_KEY;
  }
}

/** 新详情 → 左列表行要更新的计数块（字段与 MapSummary 同名；只铺计数，别整份覆盖丢了别的列） */
function countsOf(
  data: MapDetail,
): Pick<MapSummary, "npcPointCount" | "hasRevivePoint" | "collisionCount" | "spawnAreaCount" | "worldMonsterCount"> {
  return {
    npcPointCount: data.npcPointCount,
    hasRevivePoint: data.hasRevivePoint,
    collisionCount: data.collisionCount,
    spawnAreaCount: data.spawnAreaCount,
    worldMonsterCount: data.worldMonsterCount,
  };
}

/**
 * 本地越界判定（#1221 暂存预览专用）
 *
 * `bounds.ts` 的口径是「判据不在管理端」——那说的是**库里那行的红绿**。画布上还没保存的
 * 拖拽没有服务端行可读，只能本地粗判一遍让红虚线跟着挪；容差取 1px 与服务端一致，
 * 保存（或放弃）之后 detail 重新从服务端拉，这里的结果即被权威值覆盖。
 */
const LOCAL_EDGE_TOLERANCE = 1;

/** 点位（NPC / 复活点）是否在图内：世界坐标 `[0, W] × [-H, 0]`，容差 1px */
function pointInBounds(detail: MapDetail, cx: number, cy: number): boolean {
  return (
    cx >= -LOCAL_EDGE_TOLERANCE && cx <= detail.width + LOCAL_EDGE_TOLERANCE && cy <= LOCAL_EDGE_TOLERANCE && cy >= -detail.height - LOCAL_EDGE_TOLERANCE
  );
}

/** 区域框的本地越界标记（inBounds + 四边超出量，口径同上） */
function areaBounds(detail: MapDetail, box: { cx: number; cy: number; w: number; h: number }): Pick<MapSpawnArea, "inBounds" | "overflow"> {
  const overflow = {
    left: overEdge(-(box.cx - box.w / 2)),
    right: overEdge(box.cx + box.w / 2 - detail.width),
    top: overEdge(box.cy + box.h / 2),
    bottom: overEdge(-box.cy - box.h / 2 - detail.height),
  };
  return { inBounds: overflow.left === 0 && overflow.right === 0 && overflow.top === 0 && overflow.bottom === 0, overflow };
}

/** 单边超出量：容差内算 0（四舍五入成整数，与列表里的红字宽度读法一致） */
function overEdge(amount: number): number {
  return amount > LOCAL_EDGE_TOLERANCE ? Math.round(amount) : 0;
}

/** 碰撞多边形是否整块在图外（暂存预览的粗判：所有顶点都在同一侧外）；保存后以服务端为准 */
function polygonFullyOutside(detail: MapDetail, points: number[][]): boolean {
  if (points.length === 0) return false;
  const sides: Array<(p: number[]) => boolean> = [
    (p) => p[0] < 0,
    (p) => p[0] > detail.width,
    (p) => p[1] > 0,
    (p) => p[1] < -detail.height,
  ];
  return sides.some((side) => points.every(side));
}
