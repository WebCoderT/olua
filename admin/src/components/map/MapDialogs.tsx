import { Modal } from "../Modal";
import { Badge, Button, EmptyState, tableClass, tdClass, thClass, theadClass } from "../ui";
import type { MapCollision, MapDetail, MapNpc, MapSpawnArea } from "../../api";
import { overflowText, overflowTitle } from "./bounds";

/**
 * 地图观测弹窗（图层 / 点位 / 刷怪区 / 碰撞盒 / 场上怪物 / 数据来源）
 *
 * ## 为什么全塞进弹窗
 *
 * 这些块以前平铺在页面上，和玩法配置表单抢同一条滚动轴：看完「进入等级」再往下滚三屏
 * 才能看到「这张图的刷怪区长什么样」，而两者本来要一起判断（「50 级的图配了 3 个刷怪区，对么？」）。
 *
 * 主视图留「配置 + 地图」，其余按需打开 —— 打开的宽度按内容形态选：
 * 表格型（刷怪区 / 碰撞盒 / 点位）用 `lg`，数据来源与图层这种小表用 `md`。
 *
 * ## 每个弹窗都要能回答「这块数据是谁的」
 *
 * 只读区块最容易造成的误会是「页面显示的就是能改的」。所以每个标题下面都带一句来源
 * （客户端 TMX / 服务端库表），和页面的来源表口径一致。
 */

/** 行高亮：从图上点过来时，表里那一行要能被一眼找到（否则弹窗打开了还得自己找） */
function rowClass(active: boolean): string {
  return active ? `${tdClass} bg-gold/10` : tdClass;
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

/**
 * NPC 点位与复活点清单（读服务端 `map_npcs` / `maps.revive_*`，#672 起点位归后台）
 *
 * ## 为什么不再显示 TMX 的 npc 对象组
 *
 * #672 之前这里是「客户端资源对照」：TMX 里写了几个 NPC、几个复活点。但那已经是**旧口径**——
 * 点位现在由这张页面的画布写进库，客户端也只认快照。再把 TMX 的那份列出来，运维会看到两套
 * 不一致的数字（资源里 1 个、库里 0 个），而这页面的任务恰恰是「让它生效」，不是「对账」。
 * #676 起 TMX 里连对象组都没有了，所以也不再需要一处「对照」的地方。
 *
 * 坐标一律显示**世界坐标**（库里的口径，也是客户端消费的口径），与刷怪区表格对齐；
 * 画布上的点标记是 Tiled 口径（y 取反），两者是同一个点的两种写法 —— 弹窗里标了 `cy` 为负。
 */
export function NpcPointsDialog({
  open,
  detail,
  focusId,
  onEdit,
  onEditRevive,
  onClose,
}: {
  open: boolean;
  detail: MapDetail | null;
  /** 从图上点过来时高亮那一行（点位行 id，不是 Tiled 的 object id） */
  focusId?: number;
  /** 点「编辑」：上层打开 NPC 点位表单 */
  onEdit: (point: MapNpc) => void;
  /** 点复活点的「编辑」：上层切到复活点模式（页面上那条提示会指引点图） */
  onEditRevive: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      title="NPC 点位与复活点"
      hint="数据来自服务端（map_npcs / maps.revive_cx,cy）。坐标是世界坐标：原点 = 地图左上角、y 轴向上，故 cy 为负 —— 与画布上差一次 y 取反"
      size="lg"
      onClose={onClose}
    >
      {!detail ? null : (
        <div className="space-y-3">
          <section>
            <h4 className="mb-1 text-xs text-ink-3">
              NPC 点位 <span className="text-ink-6">（{detail.npcPoints.length}）</span>
            </h4>
            {detail.npcPoints.length === 0 ? (
              <EmptyState title="这张图没有 NPC" description="安全地图一般只有复活点；要加就点页面上「放置 NPC」，在图上点一下" />
            ) : (
              <div className="overflow-x-auto">
                <table className={tableClass}>
                  <thead className={theadClass}>
                    <tr>
                      <th className={thClass}>#</th>
                      <th className={thClass}>NPC</th>
                      <th className={thClass}>世界坐标</th>
                      <th className={thClass}>在图内</th>
                      <th className={thClass}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.npcPoints.map((point) => (
                      <tr key={point.id}>
                        <td className={rowClass(point.id === focusId)}>{point.id}</td>
                        <td className={rowClass(point.id === focusId)}>
                          {point.npcLabel} <span className="text-ink-6">({point.npcId})</span>
                        </td>
                        <td className={rowClass(point.id === focusId)}>
                          ({point.cx}, {point.cy})
                        </td>
                        <td className={rowClass(point.id === focusId)}>
                          <InBoundsCell inBounds={point.inBounds} />
                        </td>
                        <td className={tdClass}>
                          <Button variant="ghost" onClick={() => onEdit(point)}>
                            编辑
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <h4 className="mb-1 text-xs text-ink-3">复活点</h4>
            {!detail.revivePoint ? (
              <EmptyState title="这张图没有复活点" description="没有复活点的图，玩家死在这里会退回上一次的复活点 —— 点页面上「设复活点」，在图上点一下即可" />
            ) : (
              <table className={tableClass}>
                <thead className={theadClass}>
                  <tr>
                    <th className={thClass}>世界坐标</th>
                    <th className={thClass}>在图内</th>
                    <th className={thClass}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className={tdClass}>
                      ({detail.revivePoint.cx}, {detail.revivePoint.cy})
                    </td>
                    <td className={tdClass}>
                      <InBoundsCell inBounds={detail.revivePoint.inBounds} />
                    </td>
                    <td className={tdClass}>
                      <Button variant="ghost" onClick={onEditRevive}>
                        去图上挪
                      </Button>
                    </td>
                  </tr>
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}

/** 「在图内」单元格：判据来自服务端 `inBounds`（点位没有 overflow 量，只有一个是非） */
function InBoundsCell({ inBounds }: { inBounds: boolean }) {
  return inBounds ? <Badge tone="jade">在图内</Badge> : <Badge tone="ember">越界</Badge>;
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
                      {area.monsterLabel} <span className="text-ink-6">({area.monsterKey})</span>
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
                        <Badge tone="jade">在图内</Badge>
                      ) : (
                        <span className="flex flex-wrap items-center gap-1.5 text-[11px]" title={overflowTitle(area)}>
                          <Badge tone="ember">越界</Badge>
                          <span className="font-mono text-ember-hi">{overflowText(area)}</span>
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

/**
 * 碰撞盒清单（读服务端 `map_collisions`，#676 起碰撞归后台）
 *
 * 一张图几十到两百多个盒子，画布上只能看出「哪里不能走」，改的时候要按 id 找 ——
 * 所以给一张表：点一行 → 关掉本弹窗、在画布上打开那个盒子的表单（矩形同时高亮）。
 */
export function CollisionsDialog({
  open,
  detail,
  focusId,
  onEdit,
  onClose,
}: {
  open: boolean;
  detail: MapDetail | null;
  focusId?: number;
  onEdit: (box: MapCollision) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      title={`碰撞盒（${detail?.collisions.length ?? 0}）`}
      hint="来源：服务端 map_collisions 表 —— 在画布上拖框新增、点已有框改。坐标是世界坐标（原点 = 地图左上角、y 向上），允许超出地图边界（四面围墙就在图外）"
      size="lg"
      onClose={onClose}
    >
      {!detail ? null : detail.collisions.length === 0 ? (
        <EmptyState title="这张图没有碰撞盒" description="没有阻挡 = 玩家和挂机寻路都可以直接穿过去" />
      ) : (
        <table className={tableClass}>
          <thead className={theadClass}>
            <tr>
              <th className={thClass}>#</th>
              <th className={thClass}>中心（世界坐标）</th>
              <th className={thClass}>尺寸</th>
              <th className={thClass}>位置</th>
              <th className={thClass} />
            </tr>
          </thead>
          <tbody>
            {detail.collisions.map((box) => (
              <tr key={box.id}>
                <td className={rowClass(box.id === focusId)}>{box.id}</td>
                <td className={rowClass(box.id === focusId)}>
                  ({box.cx}, {box.cy})
                </td>
                <td className={rowClass(box.id === focusId)}>
                  {box.w} × {box.h}
                </td>
                <td className={rowClass(box.id === focusId)}>
                  {box.fullyOutside ? <Badge tone="ember">整块在图外（看不见）</Badge> : <span className="text-ink-5">图内 / 跨边界</span>}
                </td>
                <td className={rowClass(box.id === focusId)}>
                  <Button variant="ghost" onClick={() => onEdit(box)}>
                    编辑
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
                  <Badge tone={source.origin === "config" ? "warn" : "jade"}>
                    {source.origin === "config" ? "客户端资源" : "服务端库表"}
                  </Badge>
                </td>
                <td className={`${tdClass} font-mono text-[11px]`}>{source.ref}</td>
                <td className={`${tdClass} whitespace-normal text-ink-4`}>{source.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
