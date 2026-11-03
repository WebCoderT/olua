import { Modal } from "../Modal";
import { Badge, Button, EmptyState, tableClass, tdClass, thClass, theadClass } from "../ui";
import type { MapDetail, MapObject, MapSpawnArea } from "../../api";
import { overflowText, overflowTitle } from "./bounds";

/**
 * 地图观测弹窗（图层 / 点位 / 刷怪区 / 场上怪物 / 对象组 / 数据来源）
 *
 * ## 为什么全塞进弹窗
 *
 * 这些块以前平铺在页面上，和玩法配置表单抢同一条滚动轴：看完「进入等级」再往下滚三屏
 * 才能看到「这张图的刷怪区长什么样」，而两者本来要一起判断（「50 级的图配了 3 个刷怪区，对么？」）。
 *
 * 主视图留「配置 + 地图」，其余按需打开 —— 打开的宽度按内容形态选：
 * 表格型（刷怪区 / 对象组 / 点位）用 `lg`，长表（对象组明细带属性）用 `xl`，
 * 数据来源与图层这种小表用 `md`。
 *
 * ## 每个弹窗都要能回答「这块数据是谁的」
 *
 * 只读区块最容易造成的误会是「页面显示的就是能改的」。所以每个标题下面都带一句来源
 * （客户端 TMX / 服务端库表 / 生成快照），和页面的来源表口径一致。
 */

/** 行高亮：从图上点过来时，表里那一行要能被一眼找到（否则弹窗打开了还得自己找） */
function rowClass(active: boolean): string {
  return active ? `${tdClass} bg-indigo-500/10` : tdClass;
}

export function LayersDialog({ open, detail, onClose }: { open: boolean; detail: MapDetail | null; onClose: () => void }) {
  return (
    <Modal open={open} title="图层" hint="来源：客户端 TMX —— 瓦片数据留在客户端资源包里，这里只列结构" size="md" onClose={onClose}>
      {!detail ? null : detail.layers.length === 0 ? (
        <EmptyState title="没有图层" description="这张图的 TMX 里没有 layer 节点" />
      ) : (
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
                <td className={tdClass}>
                  {layer.width} × {layer.height}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

/** NPC / 复活点清单（从图上点进来时定位到那一行） */
export function NpcPointsDialog({
  open,
  detail,
  focusId,
  onClose,
}: {
  open: boolean;
  detail: MapDetail | null;
  focusId?: number;
  onClose: () => void;
}) {
  const objects = detail ? detail.groups.flatMap((group) => group.objects).filter((object) => object.klass === "npc" || object.klass === "revive") : [];
  return (
    <Modal
      open={open}
      title="NPC / 复活点"
      hint="来源：客户端 TMX 的 npc 对象组。坐标是 Tiled 原始口径（左上角原点、y 向下），与地图上的点标记一致"
      size="lg"
      onClose={onClose}
    >
      {objects.length === 0 ? (
        <EmptyState title="这张图没有 NPC / 复活点" description="安全地图一般只有一个复活点；野外图才挂 NPC" />
      ) : (
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>id</th>
                <th className={thClass}>名称</th>
                <th className={thClass}>类</th>
                <th className={thClass}>坐标（Tiled）</th>
                <th className={thClass}>属性</th>
              </tr>
            </thead>
            <tbody>
              {objects.map((object) => (
                <tr key={`${object.id}-${object.name}`} className="align-top">
                  <td className={rowClass(object.id === focusId)}>{object.id}</td>
                  <td className={rowClass(object.id === focusId)}>{object.name || "—"}</td>
                  <td className={rowClass(object.id === focusId)}>
                    <Badge tone={object.klass === "revive" ? "green" : "indigo"}>{object.klass === "revive" ? "复活点" : "NPC"}</Badge>
                  </td>
                  <td className={rowClass(object.id === focusId)}>
                    ({object.x}, {object.y})
                  </td>
                  <td className={`${rowClass(object.id === focusId)} whitespace-normal font-mono text-[11px] text-slate-500`}>{formatProperties(object.properties)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

/**
 * 刷怪区清单（服务端 `map_spawn_areas`，世界坐标）
 *
 * #667 起这张表由后台绘制写入，TMX 的 `monster` 组不再是来源 —— 所以原来那列
 * 「Tiled 原始矩形 + 与实线重合」的对照已经删掉：没有第二份真相，也就没什么可对的。
 * 行尾的「编辑」直接打开表单（删除也在表单里，删除路径只留一处）。
 */
export function SpawnAreasDialog({
  open,
  detail,
  focusId,
  onEdit,
  onClose,
}: {
  open: boolean;
  detail: MapDetail | null;
  focusId?: number;
  /** 点「编辑」：上层打开表单（弹窗自己关闭） */
  onEdit: (area: MapSpawnArea) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      title="刷怪区"
      hint="数据来自服务端 map_spawn_areas（世界坐标：原点左上、y 轴向上，cy 为负）。「在图内」由服务端按地图尺寸判 —— 新建 / 修改时越界会被直接拒，这里出现红色只会是历史数据"
      size="xl"
      onClose={onClose}
    >
      {!detail ? null : detail.spawnAreas.length === 0 ? (
        <EmptyState title="没有刷怪区" description="安全地图不刷怪；野外图点「绘制刷怪区」，在底图上拖一个框就能加" />
      ) : (
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>#</th>
                <th className={thClass}>区域名</th>
                <th className={thClass}>怪物</th>
                <th className={thClass}>数量</th>
                <th className={thClass}>世界中心</th>
                <th className={thClass}>尺寸</th>
                <th className={thClass}>在图内</th>
                <th className={thClass}>操作</th>
              </tr>
            </thead>
            <tbody>
              {detail.spawnAreas.map((area) => {
                return (
                  <tr key={area.id}>
                    <td className={rowClass(area.id === focusId)}>{area.id}</td>
                    <td className={rowClass(area.id === focusId)}>{area.name}</td>
                    <td className={rowClass(area.id === focusId)}>
                      {area.monsterLabel} <span className="text-slate-600">({area.monsterKey})</span>
                    </td>
                    <td className={rowClass(area.id === focusId)}>
                      {area.min}~{area.max}
                    </td>
                    <td className={rowClass(area.id === focusId)}>
                      ({area.cx}, {area.cy})
                    </td>
                    <td className={rowClass(area.id === focusId)}>
                      {area.w} × {area.h}
                    </td>
                    <td className={rowClass(area.id === focusId)}>
                      {area.inBounds ? (
                        <Badge tone="green">在图内</Badge>
                      ) : (
                        <span className="flex flex-wrap items-center gap-1.5 text-[11px]" title={overflowTitle(area)}>
                          <Badge tone="red">越界</Badge>
                          <span className="font-mono text-rose-300">{overflowText(area)}</span>
                        </span>
                      )}
                    </td>
                    <td className={tdClass}>
                      <Button variant="ghost" onClick={() => onEdit(area)}>
                        编辑
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

export function WorldMonstersDialog({ open, detail, onClose }: { open: boolean; detail: MapDetail | null; onClose: () => void }) {
  return (
    <Modal
      open={open}
      title="场上怪物"
      hint="来源：服务端 world_monsters（世界实例）。按区服聚合 —— 只有活着的人才会让这张图有实例"
      size="md"
      onClose={onClose}
    >
      {!detail ? null : detail.worldMonsters.length === 0 ? (
        <EmptyState title="当前没有实例" description="世界没跑过这张图，或者进程刚重启还没播种" />
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
                <td className={tdClass}>
                  {item.alive} / {item.total}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

/** 对象组计数 + 逐组明细（一张表看全，明细按组折叠） */
export function GroupsDialog({ open, detail, onClose }: { open: boolean; detail: MapDetail | null; onClose: () => void }) {
  return (
    <Modal
      open={open}
      title="对象组与对象明细"
      hint="来源：客户端 TMX 的对象层。坐标是 Tiled 原始口径；这里是「资源里到底有什么」，不是服务端的刷怪区"
      size="xl"
      onClose={onClose}
    >
      {!detail ? null : detail.groups.length === 0 ? (
        <EmptyState title="没有对象组" description="这张图的 TMX 里没有 objectgroup" />
      ) : (
        <div className="space-y-2">
          {detail.groups.map((group) => (
            <details key={group.name} className="rounded-lg border border-slate-800 bg-slate-900/30" open={group.name !== "collision"}>
              <summary className="cursor-pointer select-none px-3 py-2 text-xs text-slate-300">
                {group.name} <span className="text-slate-600">（{group.objects.length} 个）</span>
              </summary>
              <div className="max-h-72 overflow-auto border-t border-slate-800 px-3 py-2">
                <ObjectsTable objects={group.objects} empty="这个对象组是空的" />
              </div>
            </details>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function SourcesDialog({ open, detail, onClose }: { open: boolean; detail: MapDetail | null; onClose: () => void }) {
  return (
    <Modal
      open={open}
      title="数据来源"
      hint="这一页每个数字是谁的 —— 来源不同，能不能改也不同（只有「服务端库表」里的玩法配置能在这里改）"
      size="lg"
      onClose={onClose}
    >
      {!detail ? null : (
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
              <tr key={source.section} className="align-top">
                <td className={tdClass}>{source.label}</td>
                <td className={tdClass}>
                  {/* 只有两类（#655 起「生成快照」这一类随数据落库消失）；未知值按库表兜底显示原文 */}
                  <Badge tone={source.origin === "config" ? "amber" : "green"}>
                    {source.origin === "config" ? "客户端资源" : "服务端库表"}
                  </Badge>
                </td>
                <td className={`${tdClass} font-mono text-[11px]`}>{source.ref}</td>
                <td className={`${tdClass} whitespace-normal text-slate-400`}>{source.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

export function ObjectsTable({ objects, empty }: { objects: MapObject[]; empty: string }) {
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
            <td className={tdClass}>
              ({object.x}, {object.y})
            </td>
            <td className={tdClass}>{object.width || object.height ? `${object.width} × ${object.height}` : "点"}</td>
            <td className={`${tdClass} whitespace-normal font-mono text-[11px] text-slate-500`}>{formatProperties(object.properties)}</td>
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
