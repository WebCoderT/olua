import { useCallback, useEffect, useState } from "react";
import { gameResUrl } from "../components/GameImage";
import { PageHeader } from "../components/PageHeader";
import { Badge, Button, Card, EmptyState, Field as FormField, Input, Notice, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { mapPreview, mapsApi, refreshMapCatalog } from "../api";
import type { MapDetail, MapGroup, MapObject, MapSummary, MapTypeGroup, SaveMapConfig } from "../api";
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

/**
 * 地图管理（#571 观测台 / #573 玩法配置可改）
 *
 * ## 这一页能改什么、不能改什么
 *
 * 按三端边界（用户 2026-11-01 口径）：
 * - **客户端**只保存资源的真实对象 —— TMX 瓦片、底图、预览图；
 * - **服务端**存「对这份资源的整理结果」；
 * - **管理端**可视化地改服务端的整理结果。
 *
 * 所以这里分两块：
 *
 * | 块 | 能不能改 | 改了怎么生效 |
 * |---|---|---|
 * | 名称 / 类型 / 进入等级 / 进入战斗力 / 进入战魂阶 | **能改**（`PATCH /admin/maps/:id`） | 立即（服务端进图校验读同一张表；客户端下次进游戏拉快照） |
 * | 图层 / 对象组 / 刷怪区 / 场上怪物 | 只读 | 改 TMX → 跑导入工具 → 重打包客户端 |
 *
 * ## 两套坐标必须分开看（页面里也是最容易看错的地方）
 *
 * | 展示块 | 口径 | 来源 |
 * |---|---|---|
 * | 对象组 / NPC / 复活点 | **Tiled 原始坐标**（左上角原点、y 向下） | 服务端生成快照（源自 TMX） |
 * | 刷怪区 | **世界坐标**（原点 = 地图左上角、y 轴向上，故 cy 为负） | `map_spawn_areas` 表 |
 *
 * 两条路的同一块区域，数值本来就不同（差一次 y 取反），不是数据不一致。
 */
export function MapsPage() {
  const [list, setList] = useState<MapSummary[]>([]);
  const [types, setTypes] = useState<MapTypeGroup[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [detail, setDetail] = useState<MapDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [form, setForm] = useState<MapForm | null>(null);
  const [saving, setSaving] = useState(false);

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
    setPreviewFailed(false);
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

  const dirty = !!form && !!detail && !sameForm(form, formOf(detail));

  return (
    <div className="space-y-3">
      <PageHeader
        title="地图管理"
        description="玩法配置（名称 / 类型 / 进入条件）在这里改，保存即生效；地图资源（TMX / 底图）仍走客户端资源包。"
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
        <span className="text-emerald-300">能改</span>：名称 / 类型 / 进入等级 / 进入战斗力 / 进入战魂阶 ——
        这些以前写在客户端 <code className="text-slate-200">configs/map.ts</code> 里，改一次要重打整个客户端包；
        现在归服务端 <code className="text-slate-200">maps</code> 表，保存后服务端进图校验立即按新值判，客户端下次进游戏拉取新配置。
        <br />
        <span className="text-amber-300">改不了</span>：图层 / 对象组 / 刷怪区 —— 它们来自 TMX。换图的唯一路径是改{" "}
        <code className="text-slate-200">resources/map/&lt;id&gt;/&lt;id&gt;.tmx</code> → 跑{" "}
        <code className="text-slate-200">node tools/import-spawn-areas.cjs</code>（带{" "}
        <code className="text-slate-200">--db</code> 时覆盖刷怪区表）→ 重新打包客户端。
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
                        active
                          ? "border-indigo-500/50 bg-indigo-500/10"
                          : "border-slate-800 bg-slate-900/40 hover:border-slate-700"
                      }`}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm text-slate-100">{item.label || `（未命名 #${item.id}）`}</span>
                        <span className="shrink-0 text-xs text-slate-500">#{item.id}</span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
                        <span>{item.typeLabel}</span>
                        <span>·</span>
                        <span>{item.cols}×{item.rows}</span>
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
                <EmptyState title="选一张地图" description="左侧列表里点一张图，这里显示它的全部信息" />
              </Card>
            ) : (
              <>
                <Card
                  title={`${detail.label || `（未命名 #${detail.id}）`}（#${detail.id}）`}
                  description={`资源路径 ${detail.src || "—"} · ${detail.typeLabel}`}
                  actions={<Badge tone="indigo">{detail.typeLabel}</Badge>}
                >
                  <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_240px]">
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs sm:grid-cols-3">
                      <Field label="尺寸" value={`${detail.cols} × ${detail.rows} 格`} />
                      <Field label="单格" value={`${detail.tileWidth} × ${detail.tileHeight} px`} />
                      <Field label="像素" value={`${detail.width} × ${detail.height}`} />
                      <Field label="图层" value={String(detail.layerCount)} />
                      <Field label="NPC" value={String(detail.npcCount)} />
                      <Field label="复活点" value={String(detail.reviveCount)} />
                      <Field label="刷怪区（资源）" value={String(detail.monsterAreaCount)} />
                      <Field label="刷怪区（服务端）" value={String(detail.spawnAreaCount)} />
                      <Field label="场上怪物" value={String(detail.worldMonsterCount)} />
                    </dl>
                    <div>
                      {previewFailed ? (
                        <div className="flex h-[136px] items-center justify-center rounded-lg border border-slate-800 bg-slate-900/60 text-[11px] text-slate-600">
                          无预览图
                        </div>
                      ) : (
                        <img
                          alt={`${detail.label} 预览`}
                          src={gameResUrl(mapPreview(detail.id), "jpg")}
                          onError={() => setPreviewFailed(true)}
                          className="h-[136px] w-full rounded-lg border border-slate-800 bg-slate-900/60 object-cover"
                        />
                      )}
                      <p className="mt-1 text-[11px] text-slate-600">预览图取自客户端资源（map/{detail.id}/preview.jpg）</p>
                    </div>
                  </div>
                </Card>

                <Card
                  title="玩法配置"
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
                      <Input
                        value={form.label}
                        maxLength={24}
                        placeholder="如：卧龙城"
                        onChange={(event) => setForm({ ...form, label: event.target.value })}
                      />
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
                      <Input
                        type="number"
                        min={0}
                        max={200}
                        value={form.level}
                        onChange={(event) => setForm({ ...form, level: event.target.value })}
                      />
                    </FormField>
                    <FormField label="进入战斗力（0 = 不限）">
                      <Input
                        type="number"
                        min={0}
                        value={form.combat}
                        onChange={(event) => setForm({ ...form, combat: event.target.value })}
                      />
                    </FormField>
                    <FormField label="进入战魂阶（0 = 不限）">
                      <Input
                        type="number"
                        min={0}
                        value={form.soulOfWar}
                        onChange={(event) => setForm({ ...form, soulOfWar: event.target.value })}
                      />
                    </FormField>
                  </div>
                  <p className="mt-2 text-[11px] text-slate-500">
                    数值 <code className="text-slate-400">0</code> 表示<b>不限制</b>（安全地图就是 0 / 0 / 0）。
                    改完保存，玩家下一次进游戏（客户端拉配置快照）就能看到新名字与新门槛；已经在图里的玩家不受影响。
                  </p>
                </Card>

                <Card title="数据来源" description="这一页每个数字是谁的 —— 来源不同，能不能改也不同">
                  <div className="overflow-x-auto">
                    <table className={tableClass}>
                      <thead className={theadClass}>
                        <tr>
                          <th className={thClass}>数据块</th>
                          <th className={thClass}>类别</th>
                          <th className={thClass}>文件 / 表</th>
                          <th className={thClass}>说明</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.sources.map((source) => (
                          <tr key={source.section}>
                            <td className={tdClass}>{source.label}</td>
                            <td className={tdClass}>
                              <Badge tone={source.origin === "db" ? "green" : source.origin === "config" ? "amber" : "slate"}>
                                {source.origin === "db" ? "服务端库表" : source.origin === "config" ? "客户端资源" : "生成快照"}
                              </Badge>
                            </td>
                            <td className={`${tdClass} font-mono text-[11px]`}>{source.ref}</td>
                            <td className={`${tdClass} whitespace-normal text-slate-400`}>{source.note}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>

                <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                  <Card title="图层" description="TMX 结构（瓦片数据留在客户端）">
                    <div className="overflow-x-auto">
                      <table className={tableClass}>
                        <thead className={theadClass}>
                          <tr>
                            <th className={thClass}>图层名</th>
                            <th className={thClass}>格数</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.layers.map((layer) => (
                            <tr key={layer.name}>
                              <td className={tdClass}>{layer.name}</td>
                              <td className={tdClass}>{layer.width} × {layer.height}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Card>

                  <Card title="NPC / 复活点" description="Tiled 原始坐标（左上角原点、y 向下）">
                    <ObjectsTable objects={npcObjects(detail.groups)} empty="这张图没有 NPC / 复活点" />
                  </Card>
                </div>

                <Card title="刷怪区（服务端整理后）" description="世界坐标：原点 = 地图左上角、y 轴向上（cy 因此为负）；播种直接读这张表">
                  {detail.spawnAreas.length === 0 ? (
                    <EmptyState title="没有刷怪区" description="安全地图不刷怪；或者这张图还没跑过导入工具" />
                  ) : (
                    <div className="max-h-72 overflow-auto">
                      <table className={tableClass}>
                        <thead className={theadClass}>
                          <tr>
                            <th className={thClass}>#</th>
                            <th className={thClass}>区域名</th>
                            <th className={thClass}>怪物</th>
                            <th className={thClass}>数量</th>
                            <th className={thClass}>中心（世界）</th>
                            <th className={thClass}>尺寸</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.spawnAreas.map((area) => (
                            <tr key={area.id}>
                              <td className={tdClass}>{area.id}</td>
                              <td className={tdClass}>{area.name}</td>
                              <td className={tdClass}>
                                {area.monsterLabel} <span className="text-slate-600">({area.monsterKey})</span>
                              </td>
                              <td className={tdClass}>{area.min}~{area.max}</td>
                              <td className={tdClass}>({area.cx}, {area.cy})</td>
                              <td className={tdClass}>{area.w} × {area.h}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>

                <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                  <Card title="场上怪物" description="服务端世界实例（world_monsters），按区聚合">
                    {detail.worldMonsters.length === 0 ? (
                      <EmptyState title="当前没有实例" description="世界没跑过这张图，或进程刚重启还没播种" />
                    ) : (
                      <table className={tableClass}>
                        <thead className={theadClass}>
                          <tr>
                            <th className={thClass}>区服</th>
                            <th className={thClass}>实例数</th>
                            <th className={thClass}>存活</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.worldMonsters.map((item) => (
                            <tr key={item.zoneId}>
                              <td className={tdClass}>{item.zoneId} 区</td>
                              <td className={tdClass}>{item.total}</td>
                              <td className={tdClass}>{item.alive}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </Card>

                  <Card title="对象组计数" description="客户端资源里的对象数（不是服务端刷怪区）">
                    <table className={tableClass}>
                      <thead className={theadClass}>
                        <tr>
                          <th className={thClass}>对象组</th>
                          <th className={thClass}>对象数</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.groups.map((group) => (
                          <tr key={group.name}>
                            <td className={tdClass}>{group.name}</td>
                            <td className={tdClass}>{group.objects.length}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Card>
                </div>

                <Card title="对象组明细" description="Tiled 原始坐标与属性；用来对着编辑器核对资源里到底有什么">
                  <div className="space-y-2">
                    {detail.groups.map((group) => (
                      <details key={group.name} className="rounded-lg border border-slate-800 bg-slate-900/30" open={group.name !== "collision"}>
                        <summary className="cursor-pointer select-none px-3 py-2 text-xs text-slate-300">
                          {group.name} <span className="text-slate-600">（{group.objects.length} 个）</span>
                        </summary>
                        <div className="max-h-64 overflow-auto border-t border-slate-800 px-3 py-2">
                          <ObjectsTable objects={group.objects} empty="这个对象组是空的" />
                        </div>
                      </details>
                    ))}
                  </div>
                </Card>
              </>
            )}
          </div>
        </div>
      )}
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

/** 只取 NPC 与复活点对象（对象类可能落在 npc 组，也可能在早期地图的 objects 组里） */
function npcObjects(groups: MapGroup[]): MapObject[] {
  return groups.flatMap((group) => group.objects).filter((object) => object.klass === "npc" || object.klass === "revive");
}

/** 对象表（对象组明细与 NPC 表共用一份，避免两处列宽漂移） */
function ObjectsTable({ objects, empty }: { objects: MapObject[]; empty: string }) {
  if (objects.length === 0) return <EmptyState title={empty} />;
  return (
    <table className={tableClass}>
      <thead className={theadClass}>
        <tr>
          <th className={thClass}>id</th>
          <th className={thClass}>名称</th>
          <th className={thClass}>类</th>
          <th className={thClass}>坐标（Tiled）</th>
          <th className={thClass}>尺寸</th>
          <th className={thClass}>属性</th>
        </tr>
      </thead>
      <tbody>
        {objects.map((object) => (
          <tr key={`${object.id}-${object.name}`}>
            <td className={tdClass}>{object.id}</td>
            <td className={tdClass}>{object.name || "—"}</td>
            <td className={tdClass}>{object.klass || "—"}</td>
            <td className={tdClass}>({object.x}, {object.y})</td>
            <td className={tdClass}>
              {object.width || object.height ? `${object.width} × ${object.height}` : "点"}
            </td>
            <td className={`${tdClass} whitespace-normal font-mono text-[11px] text-slate-500`}>
              {formatProperties(object.properties)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 属性对象 → 一行 `k=v`（空属性给「—」，别让单元格看起来像漏数据） */
function formatProperties(properties: Record<string, string>): string {
  const entries = Object.entries(properties);
  if (entries.length === 0) return "—";
  return entries.map(([key, value]) => `${key}=${value}`).join(" · ");
}

/** 详情里的小字段（标签 + 值）；不用 ui 的 Field 是因为它带输入框语义（label + input） */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-slate-500">{label}</dt>
      <dd className="truncate text-slate-200">{value}</dd>
    </div>
  );
}
