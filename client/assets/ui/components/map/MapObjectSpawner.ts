import { Node, Vec3 } from "cc";
import { maps, npcs } from "../../../configs/game-config";
// 副作用导入：NPC 点击行为在 npcClicks 里登记（数据在服务端，行为留客户端）
import "../../../configs/npcClicks";
import LayerManager from "../../core/LayerManager";
import QuestNpcMarks from "../../core/QuestNpcMarks";
import GameUiHelper from "../../helpers/GameUiHelper";
import QuestTalk from "../../utils/net/QuestTalk";
import { markWorldInteractive } from "../../utils/input/UiHit";
import { addObstacleCollider } from "../../utils/physics/ObstacleCollider";

/**
 * 地图对象生成器（NPC 点位 / 复活点）
 *
 * ## 数据来源：服务端快照，不是 TMX（#672）
 *
 * #672 之前这两样都读 TMX 的 `npc` 对象组（`class=npc` / `class=revive`）。点位改成后台
 * 在图上点放之后，TMX 只剩瓦片与碰撞 —— 再读它就会出现「后台改了点位、客户端没变」
 * 这种无法解释的现象。现在读 `configs/game-config` 的 `maps` 表（`applyMapRows` 填的），
 * 那是 `GET /game-config` 的 `maps` 段。
 *
 * ## 坐标是**世界坐标**，不再换算
 *
 * TMX 口径是左上角原点 + y 向下，进游戏要 `mapPointToWorld` 翻一次 y；服务端存的已经是
 * 世界坐标（`cy` 为负），所以这里**直接用**。少一次换算就少一处「差一个符号」的机会。
 *
 * ## 快照没到时会怎样
 *
 * `maps` 在 Loading 阶段就已填好（`#604` 缺段直接停在 Loading 重试），所以正常进图一定有值。
 * 万一没有（比如有人绕过 Loading 直接 openScene），这里 `warn` 并**不生成任何 NPC** ——
 * 挂一个猜出来的点位比没有更糟。
 */
export default class MapObjectSpawner {
  /** 这张图的 id（`resources/map/<id>` 与快照 `maps` 表的 key） */
  private mapId: string;
  /** 复活点世界坐标（快照里没有就是 null） */
  private revivePoint: Vec3 | null = null;

  constructor(mapId: string) {
    this.mapId = mapId;
  }

  /** 按快照生成全部 NPC，并记录复活点 */
  spawnAll() {
    const config = maps.get(this.mapId);
    if (!config) {
      console.warn(`[MapObjectSpawner] 地图 ${this.mapId} 的配置还没到，跳过 NPC 与复活点`);
      return;
    }
    for (const point of config.npcs) {
      this.spawnNpc(point.npcId, new Vec3(point.x, point.y));
    }
    this.revivePoint = config.revive ? new Vec3(config.revive.x, config.revive.y) : null;
  }

  /** 地图的复活点（世界坐标；这张图没设复活点时 null） */
  getRevivePoint() {
    return this.revivePoint;
  }

  /** 添加 NPC（节点主体由 GameUiHelper 生成，此处只负责放置与事件绑定） */
  private spawnNpc(id: string, position: Vec3) {
    const npc = npcs.get(id);
    if (!npc) {
      // 点位上写的 NPC 在 npcs 表里查不到：多半是管理端放了已下线的 NPC，跳过而不是画个空白节点
      console.warn(`[MapObjectSpawner] NPC ${id} 不在 npcs 表里，跳过`);
      return;
    }
    const npcNode = GameUiHelper.createNpcNode(npc);
    addObstacleCollider(npcNode);
    // 碰撞范围显示（调试用，全部碰撞体共用一套开关）
    GameUiHelper.showColliderRange(npcNode, npc.label);
    // 先入层再定位：节点无父节点时 setWorldPosition 写进去的其实是本地坐标，
    // 一旦以后地图层不再位于世界原点（或地图节点挂到别处），顺序反了就会整体偏移
    LayerManager.addToMapLayer(npcNode);
    npcNode.setWorldPosition(position);
    // 头顶任务标记（#396：! 可接 / ? 可交付；没有任务时整块隐藏）
    QuestNpcMarks.attach(npcNode, id);
    npcNode.on(
      Node.EventType.TOUCH_END,
      () => {
        // 点 NPC 即一次「对话」（#396）：推进 talk 目标，失败静默；原有点击行为照旧
        QuestTalk.report(id);
        npc.onClick && npc.onClick();
      },
      this,
    );
    // 标记为「世界侧可交互对象」：按下它是交互（点开对话/传送），世界侧不接管成「按住走路」、
    // 点它也不清掉当前攻击目标（见 LayerManager.isPointOnWorldInteractive）。
    // 标记就打在这个挂了点击监听的节点上：判定范围与它的点击范围天然一致
    markWorldInteractive(npcNode);
  }
}
