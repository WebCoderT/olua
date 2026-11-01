import { useCallback, useEffect, useState } from "react";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { Badge, Button, Card, EmptyState, Field as FormField, Input, Notice, Select, Spinner } from "../components/ui";
import { MapCanvas, type MapLayerVisibility } from "../components/map/MapCanvas";
import { outOfBoundsCount } from "../components/map/bounds";
import {
  GroupsDialog,
  LayersDialog,
  NpcPointsDialog,
  SourcesDialog,
  SpawnAreasDialog,
  WorldMonstersDialog,
} from "../components/map/MapDialogs";
import { mapsApi, refreshMapCatalog } from "../api";
import type { MapDetail, MapObject, MapSpawnArea, MapSummary, MapTypeGroup, SaveMapConfig } from "../api";
import { toastSuccess } from "../store/toast";

/** 类型码（服务端生成的字面量联合："0" 安全 / "1" 等级 / "2" 战斗力 / "3" 战魂） */
type MapTypeCode = SaveMapConfig["type"];

/** 编辑表单的形状（= 服务端 `SaveMapConfigDto` 的五个字段） */
interface MapForm {
  label: string;
  type: MapTypeCode;
  level: string;
  combat: string;
  soulOfWar: string;
}

/** 打开中的观测弹窗（页面主视图只留配置 + 地图，其余按需打开） */
type DialogKey = "layers" | "points" | "spawn" | "monsters" | "groups" | "sources" | null;

/** 叠加层的默认开关：碰撞盒数量大（每图上百个），默认关；其余默认开 */
const DEFAULT_LAYERS: MapLayerVisibility = { spawn: true, tiled: true, npc: true, revive: true, collision: false };

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
 * | 名称 / 类型 / 进入等级 / 进入战斗力 / 进入战魂阶 | **能改**（`PATCH /admin/maps/:id`） | 立即（服务端进图校验读同一张表；客户端下次进游戏拉快照） |
 * | 图层 / 对象组 / 刷怪区 / 场上怪物 | 只读 | 改 TMX → 跑导入工具 → 重打包客户端 |
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
 * | 对象组 / NPC / 复活点 | **Tiled 原始坐标**（左上角原点、y 向下） | 服务端生成快照（源自 TMX） |
 * | 刷怪区 | **世界坐标**（原点 = 地图左上角、y 轴向上，故 cy 为负） | `map_spawn_areas` 表 |
 *
 * 同一块区域两条路的数值本来就不同（差一次 y 取反），不是数据不一致 —— 图上让它们重合，
 * 才是「导入没算错」的判据。
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
  /** 放大地图（密集的图在 620px 宽下标签会挤，这里给到 1024） */
  const [zoomed, setZoomed] = useState(false);

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

  /** 保存玩法配置（整份覆盖；只提交这五个字段） */
  const save = async () => {
    if (!form || !detail || saving) return;
    setSaving(true);
    try {
      const saved = await mapsApi.save(detail.id, {
        label: form.label.trim(),
        type: form.type,
        level: toInt(form.level),
        combat: toInt(form.combat),
        soulOfWar: toInt(form.soulOfWar),
      });
      // 服务端返回的是保存后那一行（含计数）—— 直接铺回列表与详情，不额外再拉一次
      setList((prev) => prev.map((item) => (item.id === saved.id ? { ...item, ...saved } : item)));
      setDetail((prev) => (prev ? { ...prev, ...saved } : prev));
      setForm(formOf(saved));
      // 角色详情 / 实体选择器读的是本地名录缓存，保存成功要让它重新拉一次
      void refreshMapCatalog();
      toastSuccess(`「${saved.label}」的玩法配置已保存（服务端立即生效，客户端下次进游戏拉取）`);
    } catch {
      /* 错误已由请求层统一提示（400 的字段级消息也在里面） */
    } finally {
      setSaving(false);
    }
  };

  /** 从图上点刷怪区 → 打开弹窗并定位到那一行 */
  const openArea = (area: MapSpawnArea) => {
    setFocusArea(area.id);
    setDialog("spawn");
  };

  /** 从图上点 NPC / 复活点 → 打开弹窗并定位到那一行 */
  const openNpc = (object: MapObject) => {
    setFocusNpc(object.id);
    setDialog("points");
  };

  const dirty = !!form && !!detail && !sameForm(form, formOf(detail));
  /** 越界区域数（服务端判；0 时页面保持安静，>0 才出红色徽标） */
  const outOfBounds = detail ? outOfBoundsCount(detail.spawnAreas) : 0;

  return (
    <div className="space-y-3">
      <PageHeader
        title="地图管理"
        description="玩法配置在这里改，保存即生效；怪物与 NPC 在地图上看。"
        actions={
          <>
            <Badge tone="indigo">可编辑玩法配置</Badge>
            <Button variant="ghost" onClick={() => void loadList()}>
              刷新
            </Button>
          </>
        }
      />

      <Notice tone="slate" title="哪些能改、哪些改不了">
        <span className="text-emerald-300">能改</span>：名称 / 类型 / 进入等级 / 进入战斗力 / 进入战魂阶（服务端 <code className="text-slate-200">maps</code> 表，保存即生效）。
        <br />
        <span className="text-amber-300">改不了</span>：图层 / 刷怪区 / NPC —— 它们来自 TMX。换图只能改{" "}
        <code className="text-slate-200">resources/map/&lt;id&gt;/&lt;id&gt;.tmx</code> → 跑{" "}
        <code className="text-slate-200">node tools/import-spawn-areas.cjs</code>（带 <code className="text-slate-200">--db</code> 时覆盖刷怪区表）→ 重新打包客户端。
      </Notice>

      {loading ? (
        <div className="flex items-center gap-2 py-10 text-xs text-slate-500">
          <Spinner /> 加载地图清单…
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[260px_minmax(0,1fr)]">
          <Card title={`地图（${list.length}）`} description="按 id 升序，点一行看详情">
            <ul className="space-y-1">
              {list.map((item) => {
                const active = item.id === selected;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(item.id)}
                      className={`w-full rounded-lg border px-2.5 py-2 text-left transition ${
                        active ? "border-indigo-500/50 bg-indigo-500/10" : "border-slate-800 bg-slate-900/40 hover:border-slate-700"
                      }`}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm text-slate-100">{item.label || `（未命名 #${item.id}）`}</span>
                        <span className="shrink-0 text-xs text-slate-500">#{item.id}</span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
                        <span>{item.typeLabel}</span>
                        <span>·</span>
                        <span>
                          {item.cols}×{item.rows}
                        </span>
                        <span>·</span>
                        <span>刷怪区 {item.spawnAreaCount}</span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>

          <div className="space-y-3">
            {detailLoading && !detail ? (
              <Card>
                <div className="flex items-center gap-2 py-10 text-xs text-slate-500">
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
                      {dirty && <Badge tone="amber">未保存</Badge>}
                      <Button variant="ghost" onClick={() => setForm(formOf(detail))} disabled={!dirty || saving}>
                        还原
                      </Button>
                      <Button onClick={() => void save()} disabled={!dirty || saving || !form.label.trim()}>
                        {saving ? "保存中…" : "保存"}
                      </Button>
                    </div>
                  }
                >
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
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
                    <FormField label="进入战斗力（0 = 不限）">
                      <Input type="number" min={0} value={form.combat} onChange={(event) => setForm({ ...form, combat: event.target.value })} />
                    </FormField>
                    <FormField label="进入战魂阶（0 = 不限）">
                      <Input type="number" min={0} value={form.soulOfWar} onChange={(event) => setForm({ ...form, soulOfWar: event.target.value })} />
                    </FormField>
                  </div>
                  <p className="mt-2 text-[11px] text-slate-500">
                    数值 <code className="text-slate-400">0</code> 表示<b>不限制</b>（安全地图就是 0 / 0 / 0）。已经在图里的玩家不受影响，新门槛从下一次进游戏开始生效。
                  </p>
                </Card>

                <Card
                  title="地图"
                  description={
                    <>
                      实线 = 服务端刷怪区（世界坐标）；虚线 = TMX 原始矩形（Tiled 坐标），两者重合才说明导入没算错。
                      <br />
                      区域必须整体落在图内（x ∈ [0, 宽]、y ∈ [-高, 0]）：越界的那块会被画布裁掉，所以越界区域描成红色虚线。
                      <br />
                      资源 {detail.src || "—"} · {detail.cols}×{detail.rows} 格（{detail.width}×{detail.height} px）· 图层 {detail.layerCount} · NPC/复活点{" "}
                      {detail.npcCount}/{detail.reviveCount} · 刷怪区 {detail.spawnAreaCount}（资源 {detail.monsterAreaCount}）· 场上怪物 {detail.worldMonsterCount}
                    </>
                  }
                  actions={
                    <>
                      {/* 只在有越界时出现：0 越界是常态，天天挂一个绿徽标等于没有徽标 */}
                      {outOfBounds > 0 && <Badge tone="red">刷怪区越界 {outOfBounds}</Badge>}
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
                  <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-slate-500">
                    <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm border-2 border-dashed" style={{ borderColor: "#f43f5e" }} />
                    红色虚线 = 越出地图边界的区域（超出部分被画布裁掉，图上只剩缺角）
                  </p>
                  <div className="mt-2">
                    <MapCanvas detail={detail} visible={layers} onPickArea={openArea} onPickNpc={openNpc} />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button variant="ghost" onClick={() => {
                        setFocusArea(undefined);
                        setDialog("spawn");
                      }}>
                      刷怪区（{detail.spawnAreas.length}）
                    </Button>
                    <Button variant="ghost" onClick={() => {
                        setFocusNpc(undefined);
                        setDialog("points");
                      }}>
                      NPC / 复活点（{detail.npcCount + detail.reviveCount}）
                    </Button>
                    <Button variant="ghost" onClick={() => setDialog("monsters")}>
                      场上怪物（{detail.worldMonsterCount}）
                    </Button>
                    <Button variant="ghost" onClick={() => setDialog("layers")}>
                      图层（{detail.layerCount}）
                    </Button>
                    <Button variant="ghost" onClick={() => setDialog("groups")}>
                      对象组（{detail.groups.length}）
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

      <SpawnAreasDialog open={dialog === "spawn"} detail={detail} focusId={focusArea} onClose={() => setDialog(null)} />
      <NpcPointsDialog open={dialog === "points"} detail={detail} focusId={focusNpc} onClose={() => setDialog(null)} />
      <WorldMonstersDialog open={dialog === "monsters"} detail={detail} onClose={() => setDialog(null)} />
      <LayersDialog open={dialog === "layers"} detail={detail} onClose={() => setDialog(null)} />
      <GroupsDialog open={dialog === "groups"} detail={detail} onClose={() => setDialog(null)} />
      <SourcesDialog open={dialog === "sources"} detail={detail} onClose={() => setDialog(null)} />
    </div>
  );
}

/** 叠加层图例 + 开关（色块与 MapCanvas 的描边同一套颜色，靠 label 对上而不是靠记忆） */
function LayerLegend({ visible, onChange }: { visible: MapLayerVisibility; onChange: (next: MapLayerVisibility) => void }) {
  const items: Array<{ key: keyof MapLayerVisibility; label: string; color: string; dash?: boolean }> = [
    { key: "spawn", label: "刷怪区（服务端）", color: "#818cf8" },
    { key: "tiled", label: "TMX 原始矩形", color: "#fbbf24", dash: true },
    { key: "npc", label: "NPC", color: "#38bdf8" },
    { key: "revive", label: "复活点", color: "#34d399" },
    { key: "collision", label: "碰撞盒", color: "#fb7185" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {items.map((item) => (
        <label key={item.key} className="flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-400">
          <input
            type="checkbox"
            checked={visible[item.key]}
            onChange={(event) => onChange({ ...visible, [item.key]: event.target.checked })}
            className="h-3 w-3 accent-indigo-500"
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
    combat: String(row.combat),
    soulOfWar: String(row.soulOfWar),
  };
}

/** 表单 → 整数（空串 / 非法值按 0 = 不限制；服务端还会再校验一次范围） */
function toInt(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/** 两份表单是否等价（数字按数值比：`"10"` 与 `"010"` 存进去是同一个值） */
function sameForm(a: MapForm, b: MapForm): boolean {
  return (
    a.label.trim() === b.label.trim() &&
    a.type === b.type &&
    toInt(a.level) === toInt(b.level) &&
    toInt(a.combat) === toInt(b.combat) &&
    toInt(a.soulOfWar) === toInt(b.soulOfWar)
  );
}
