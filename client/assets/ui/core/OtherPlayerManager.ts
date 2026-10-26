import { Graphics, isValid, Label, Node, ProgressBar, UITransform } from "cc";
import { roleBody } from "../../configs/role";
import { roleShowLayout } from "../../configs/layout/hud";
import { otherPlayerGhost } from "../../configs/effect";
import LayerManager from "./LayerManager";
import GameUiHelper from "../helpers/GameUiHelper";
import UiHelper from "../helpers/UiHelper";
import type { PlayersFrame } from "../utils/net/CombatChannel";

/**
 * 一名远端玩家的演出视图
 *
 * **纯演出**：位置 / 血量 / 移动标记都来自 players 帧（服务端转发的别人客户端自报），
 * 本地不做任何权威判断，也不参与碰撞 / 目标选择 —— 多人互见的第一步是「看得见」，
 * 打得着（互相对战）是另一把刀的事。
 */
interface OtherPlayerView {
  node: Node;
  /** 广播给的最新位置（世界坐标；每帧向它插值，平滑过广播节拍的台阶感） */
  targetX: number;
  targetY: number;
  hp: number;
  maxHp: number;
}

/**
 * 其他玩家管理器（#324：同图玩家互见的客户端落点，静态类）
 *
 * 与 MonsterManager 同一套生命周期纪律：
 * - players 帧进来（组合根接线 onPlayers）→ 差量合并到场景：full 快照重建集合、
 *   增量 upsert、left 移除销毁 —— 消失与重现都是服务端的显式事件，本地不做猜测；
 * - 每帧 tick 做位置插值（向广播位置趋近，速度自适应距离）；
 * - 换图 reset 整份清空（与怪物 / 掉落物同口径，见 GameMap 构造）。
 *
 * ## 演出的边界（刻意简化）
 * 远端玩家没有外观动画（衣服 / 武器帧动画依赖对方角色的穿戴数据，那要随互见帧下发，
 * 与时装系统同一条线），当前用一个圆形占位 + 角色名 + 头顶血条表达「这里有个人」。
 * 移动的「走路感」由插值 + 服务端 moving 标记间接呈现；真正的动作演出等外观数据上线。
 */
export default class OtherPlayerManager {
  /** 场上的远端玩家：账号 id → 演出视图 */
  private static others = new Map<string, OtherPlayerView>();

  /**
   * 落一帧互见广播（组合根接线；自己会被过滤掉 —— 广播的收件人是同图观看者，
   * 但服务端不保证剔除发送者自己，客户端按账号 id 过滤一次最稳）
   */
  static applyPlayersFrame(frame: PlayersFrame, selfAccountId: string): void {
    if (frame.full) {
      // 快照兜底：以帧为准重建集合（换图后的第一帧 / 重连后的补偿都走这里）
      const keep = new Set(frame.players.map((entry) => entry.accountId));
      for (const accountId of [...this.others.keys()]) {
        if (!keep.has(accountId)) this.remove(accountId);
      }
    }
    for (const accountId of frame.left) this.remove(accountId);
    for (const entry of frame.players) {
      if (entry.accountId === selfAccountId) continue;
      this.upsert(entry.accountId, entry.username, entry.x, entry.y, entry.hp, entry.maxHp);
    }
  }

  /** 每帧驱动：向广播位置插值（Game.update 的 serverAuthority 分支里调用） */
  static tick(deltaTime: number): void {
    if (this.others.size === 0) return;
    // 插值系数按帧长折算：约 0.15s 追上目标位置 —— 比广播节拍（200ms）略慢半拍，视觉上是「匀速滑动」
    const factor = Math.min(1, (deltaTime / 0.15) * 0.5);
    for (const view of this.others.values()) {
      if (!isValid(view.node)) continue;
      const current = view.node.position;
      view.node.setPosition(current.x + (view.targetX - current.x) * factor, current.y + (view.targetY - current.y) * factor, current.z);
    }
  }

  /** 清空所有远端玩家（切换地图时调用，与怪物 / 掉落物同一口径） */
  static reset(): void {
    for (const accountId of [...this.others.keys()]) this.remove(accountId);
  }

  //#region 内部：增删与节点构建

  private static upsert(accountId: string, username: string, x: number, y: number, hp: number, maxHp: number): void {
    let view = this.others.get(accountId);
    if (!view) {
      view = this.create(accountId, username, x, y);
      this.others.set(accountId, view);
    }
    view.targetX = x;
    view.targetY = y;
    if (view.hp !== hp || view.maxHp !== maxHp) {
      view.hp = hp;
      view.maxHp = maxHp;
      this.refreshHead(view);
    }
  }

  private static remove(accountId: string): void {
    const view = this.others.get(accountId);
    if (!view) return;
    this.others.delete(accountId);
    if (isValid(view.node)) view.node.destroy();
  }

  private static create(accountId: string, username: string, x: number, y: number): OtherPlayerView {
    /** 占位节点（几何与主角一致：锚点 (0.5, 0)、roleBody 同尺寸，原点在脚底 —— 互见的坐标才有可比性） */
    const node = new Node(`other_player_${accountId}`);
    const transform = node.addComponent(UITransform);
    transform.setContentSize(roleBody.size);
    transform.setAnchorPoint(0.5, 0);
    node.setPosition(x, y);
    /** 身体占位（圆形：有外观动画之前先让人「看得见」；配色见 configs/effect.otherPlayerGhost） */
    const body = node.addComponent(Graphics);
    const radius = Math.min(roleBody.size.width, roleBody.size.height) * 0.35;
    body.circle(0, radius + 6, radius);
    body.fillColor = otherPlayerGhost.fillColor.clone();
    body.strokeColor = otherPlayerGhost.strokeColor.clone();
    body.lineWidth = otherPlayerGhost.lineWidth;
    body.fill();
    body.stroke();
    /** 角色名称（与主角 / 怪物同一套样式口径，见 roleShowLayout.name） */
    const layout = roleShowLayout.name;
    node.addChild(UiHelper.createLabel("role_name", username, layout.color, layout.fontSize, layout.position, layout.size));
    /** 头顶信息栏（血条 + 血量文字；军衔红字按 0 建立占位，远端玩家的军衔不随互见帧下发，恒为空行） */
    node.addChild(GameUiHelper.createHead("other_head", 1, 1, 0));
    LayerManager.addToGameLayer(node);
    return { node, targetX: x, targetY: y, hp: 1, maxHp: 1 };
  }

  /** 刷新头顶血条（取件口径与 RoleDisplay.updateHead 成对：role_hp_bar / role_hp_text） */
  private static refreshHead(view: OtherPlayerView): void {
    const head = view.node.getChildByName("other_head");
    if (!head) return;
    const ratio = view.maxHp > 0 ? Math.max(0, Math.min(1, view.hp / view.maxHp)) : 0;
    const hpBar = head.getChildByName("role_hp_bar")?.getComponent(ProgressBar);
    if (hpBar) hpBar.progress = ratio;
    const hpText = head.getChildByName("role_hp_text")?.getComponent(Label);
    if (hpText) hpText.string = `${view.hp} / ${view.maxHp}`;
  }

  //#endregion
}
