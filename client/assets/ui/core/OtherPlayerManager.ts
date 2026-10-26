import { isValid, Label, Node, ProgressBar, UITransform, Vec2 } from "cc";
import { defaultRoleSpeedRate, roleBody } from "../../configs/role";
import { roleShowLayout } from "../../configs/layout/hud";
import { ACTION, DIRECTION } from "../../types/animation";
import { SEX } from "../../types/role";
import RoleAppearance, { RoleOutSource } from "../components/role/RoleAppearance";
import LayerManager from "./LayerManager";
import GameUiHelper from "../helpers/GameUiHelper";
import UiHelper from "../helpers/UiHelper";
import { getDirectionByVector } from "../utils/battle/BattleMath";
import type { PlayerAppearance, PlayerEntry, PlayersFrame } from "../utils/net/CombatChannel";

/**
 * 互见帧没带外观时的兜底（#383）：旧服务端不发 appearance 字段，
 * 按「男性、没穿没拿」拼一个 —— 至少是一具完整身体，不是空白
 */
const DEFAULT_APPEARANCE: PlayerAppearance = { sex: SEX.BOY, cloth: "", weapon: "", fashion: "" };

/**
 * 互见帧的外观 -> RoleAppearance 的装配数据
 *
 * 协议里「没穿」用空串（跨语言最省事的缺省），客户端的装备槽用 null 表示，在这里转一次；
 * 速度倍率取角色默认值 —— 远端玩家的属性不随互见帧下发，而 speedRate 只影响每帧时长
 * （走动快慢的观感），用默认值反而让所有远端玩家的步频一致。
 */
function toOutSource(appearance: PlayerAppearance): RoleOutSource {
  return {
    sex: appearance.sex as SEX,
    equipments: { cloth: appearance.cloth || null, weapon: appearance.weapon || null },
    fashionCloth: appearance.fashion || null,
    speedRate: defaultRoleSpeedRate,
  };
}

/** 外观比较键（换装判据：四个字段拼一串，字符串比较比逐字段比省事） */
function appearanceKey(appearance: PlayerAppearance): string {
  return `${appearance.sex}|${appearance.cloth}|${appearance.weapon}|${appearance.fashion}`;
}

/**
 * 一名远端玩家的演出视图
 *
 * **纯演出**：位置 / 血量 / 移动标记 / 外观都来自 players 帧（服务端转发的别人客户端自报），
 * 本地不做任何权威判断，也不参与碰撞 / 目标选择 —— 多人互见的第一步是「看得见」，
 * 打得着（互相对战）是另一把刀的事。
 */
interface OtherPlayerView {
  node: Node;
  /** 外观装配器（衣服 + 武器两个子节点由它管理） */
  appearance: RoleAppearance;
  /** 当前外观数据（换装后整份替换） */
  source: RoleOutSource;
  /** 当前外观的比较键（换装判据） */
  appearanceKey: string;
  /** 广播给的最新位置（世界坐标；每帧向它插值，平滑过广播节拍的台阶感） */
  targetX: number;
  targetY: number;
  hp: number;
  maxHp: number;
  /** 服务端转发的「他客户端自报的移动标记」——决定走 / 站 */
  moving: boolean;
  /** 当前朝向（按位移差量算，差量太小时保持不动） */
  direction: DIRECTION;
  /** 当前动作（走 / 站） */
  action: ACTION;
}

/**
 * 其他玩家管理器（#324：同图玩家互见的客户端落点，静态类）
 *
 * 与 MonsterManager 同一套生命周期纪律：
 * - players 帧进来（组合根接线 onPlayers）→ 差量合并到场景：full 快照重建集合、
 *   增量 upsert、left 移除销毁 —— 消失与重现都是服务端的显式事件，本地不做猜测；
 * - 每帧 tick 做位置插值（向广播位置趋近，速度自适应距离）并按剩余位移定朝向；
 * - 换图 reset 整份清空（与怪物 / 掉落物同口径，见 GameMap 构造）。
 *
 * ## 外观（#383）
 * 不再用占位圆：直接复用 `RoleAppearance`，衣服 / 武器的帧目录取源（时装 > 装备衣服 >
 * 性别默认身体）、几何变换、层级顺序与主角是**同一份代码** —— 别人穿什么、拿什么、
 * 有没有时装，看到的就是他客户端看到的。
 *
 * ## 演出的边界（刻意留着）
 * - **没有战斗动作**：对方放技能 / 挨打 / 倒地都不会在别人屏幕上播 —— 那需要互见帧
 *   再带一条事件流（他在放什么、打谁），是独立的一刀。现在最多看到他在走 / 站。
 * - **没有军衔**：头顶那行红字按 0 建占位，恒为空行（军衔不随互见帧下发）。
 * - **位置不权威**：坐标就是对方客户端上报的值，本地只做插值平滑，不校正。
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
      this.upsert(entry);
    }
  }

  /** 每帧驱动：向广播位置插值 + 按位移差量定朝向 / 动作（Game.update 的 serverAuthority 分支里调用） */
  static tick(deltaTime: number): void {
    if (this.others.size === 0) return;
    // 插值系数按帧长折算：约 0.15s 追上目标位置 —— 比广播节拍（200ms）略慢半拍，视觉上是「匀速滑动」
    const factor = Math.min(1, (deltaTime / 0.15) * 0.5);
    for (const view of this.others.values()) {
      if (!isValid(view.node)) continue;
      const current = view.node.position;
      const dx = view.targetX - current.x;
      const dy = view.targetY - current.y;
      view.node.setPosition(current.x + dx * factor, current.y + dy * factor, current.z);
      let changed = false;
      // 朝向跟着剩余位移走：差量太小（已基本追上 / 原地微抖）时保持上一次朝向，
      // 否则站着不动会被几像素的误差转得乱转
      if (Math.abs(dx) + Math.abs(dy) > 1) {
        const direction = getDirectionByVector(new Vec2(dx, dy));
        if (direction !== view.direction) {
          view.direction = direction;
          changed = true;
        }
      }
      // 走 / 站以服务端的移动标记为准（那是他自己客户端的真实意图），不看插值有没有走完
      const action = view.moving ? ACTION.WALK : ACTION.STAND;
      if (action !== view.action) {
        view.action = action;
        changed = true;
      }
      // 只在真的变了才切：play 里的 crossFade 会把动画从头重启，每帧调等于永远停在第一帧
      if (changed) view.appearance.play(view.action, view.direction);
    }
  }

  /** 清空所有远端玩家（切换地图时调用，与怪物 / 掉落物同一口径） */
  static reset(): void {
    for (const accountId of [...this.others.keys()]) this.remove(accountId);
  }

  //#region 内部：增删与节点构建

  private static upsert(entry: PlayerEntry): void {
    let view = this.others.get(entry.accountId);
    if (!view) {
      view = this.create(entry);
      this.others.set(entry.accountId, view);
    }
    view.targetX = entry.x;
    view.targetY = entry.y;
    view.moving = entry.moving;
    const appearance = entry.appearance ?? DEFAULT_APPEARANCE;
    const key = appearanceKey(appearance);
    if (key !== view.appearanceKey) {
      // 换装（#383）：按新外观重新装配，动作 / 朝向沿用当前值 —— 不打断正在走的人
      view.appearanceKey = key;
      view.source = toOutSource(appearance);
      view.appearance.updateOutShow(view.source, view.action, view.direction);
    }
    if (view.hp !== entry.hp || view.maxHp !== entry.maxHp) {
      view.hp = entry.hp;
      view.maxHp = entry.maxHp;
      this.refreshHead(view);
    }
  }

  private static remove(accountId: string): void {
    const view = this.others.get(accountId);
    if (!view) return;
    this.others.delete(accountId);
    if (isValid(view.node)) view.node.destroy();
  }

  private static create(entry: PlayerEntry): OtherPlayerView {
    /** 宿主节点（几何与主角一致：锚点 (0.5, 0)、roleBody 同尺寸，原点在脚底 —— 互见的坐标才有可比性） */
    const node = new Node(`other_player_${entry.accountId}`);
    const transform = node.addComponent(UITransform);
    transform.setContentSize(roleBody.size);
    transform.setAnchorPoint(0.5, 0);
    node.setPosition(entry.x, entry.y);
    const appearance = entry.appearance ?? DEFAULT_APPEARANCE;
    // 外观装配与主角同一份代码（#383）：衣服 / 武器两个子节点由它在构造函数里挂到宿主上。
    // 攻击完成的回调给空实现 —— 远端玩家不播攻击动作（见类注释的边界）。
    const roleAppearance = new RoleAppearance(node, () => {});
    const source = toOutSource(appearance);
    roleAppearance.updateOutShow(source, ACTION.STAND, DIRECTION.DOWN);
    /** 角色名称（与主角 / 怪物同一套样式口径，见 roleShowLayout.name） */
    const layout = roleShowLayout.name;
    node.addChild(UiHelper.createLabel("role_name", entry.username, layout.color, layout.fontSize, layout.position, layout.size));
    /** 头顶信息栏（血条 + 血量文字；军衔红字按 0 建立占位，远端玩家的军衔不随互见帧下发，恒为空行） */
    node.addChild(GameUiHelper.createHead("other_head", 1, 1, 0));
    LayerManager.addToGameLayer(node);
    return {
      node,
      appearance: roleAppearance,
      source,
      appearanceKey: appearanceKey(appearance),
      targetX: entry.x,
      targetY: entry.y,
      hp: 1,
      maxHp: 1,
      moving: entry.moving,
      direction: DIRECTION.DOWN,
      action: ACTION.STAND,
    };
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
