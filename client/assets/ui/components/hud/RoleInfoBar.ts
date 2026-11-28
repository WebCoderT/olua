import { Color, instantiate, Label, Node, Prefab, Sprite, UITransform } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import UiHelper from "../../helpers/UiHelper";
import RoleUIManager from "../../core/RoleUIManager";
import StatusIconBar from "./StatusIconBar";
import RealtimeClient, { RealtimeStatus } from "../../utils/net/RealtimeClient";
import { Role } from "../../../entities/Role";
import { RELATION_SHIP } from "../../../types/role";
import { roleInfoBarLayout } from "../../../configs/hudLayout";
import { getText } from "../../../configs/texts";
import { roleInfoBarPrefab } from "../../../configs/layout/hud";

/** 实时通道状态 → 指示文字的文案 key（#1324；四态颜色见 roleInfoBarPrefab.realtimeColors） */
const REALTIME_STATUS_TEXTS: Record<RealtimeStatus, string> = {
  [RealtimeStatus.Idle]: "realtime_status_idle",
  [RealtimeStatus.Connecting]: "realtime_status_connecting",
  [RealtimeStatus.Connected]: "realtime_status_connected",
  [RealtimeStatus.Disconnected]: "realtime_status_disconnected",
};

/**
 * 角色信息栏组件（左上角常驻 HUD，#1353 HUD prefab 化样板）
 *
 * 静态外观（底板 / 头像框 / 名字 / 等级 / 货币 / 战斗力 / 通道状态的位置、尺寸、颜色、字号）
 * 全部固化在 `ui/prefabs/hud/RoleInfoBar.prefab`，由 Game 静态注入（同 #1348），
 * 可在 Cocos 编辑器里直接可视化改版式 —— 改版式请改 prefab，别回代码拼节点。
 *
 * 本组件 `extends Node` 的对外契约不变（RoleUIManager 注册 / LayerManager.addToUILayer / dispose），
 * 只把"构造函数拼节点"换成"实例化 prefab + 按节点名绑定动态零件"，并保留三件事：
 * 1. 动态填值（名字 / 等级 / 货币 / 战斗力）
 * 2. 动态换图（职业性别头像）
 * 3. 动态色（实时通道四态 + 战斗力 ±飘字）—— 数据驱动，无法固化进 prefab
 *
 * 节点名集中在 `roleInfoBarPrefab.nodes`，重命名节点要同步那里；缺节点只警告不让整块 UI 崩。
 */
export default class RoleInfoBar extends Node {
  /** 名字文本 */
  private nameLabel: Label;
  /** 等级文本 */
  private levelLabel: Label;
  /** 绑定元宝数量文本 */
  private bindGoldCountLabel: Label;
  /** 战斗力数值文本 */
  private combatLabel: Label;
  /** 战斗力零件节点（±飘字的挂点） */
  private combatNode: Node;
  /** 头像图（按职业/性别换 spriteFrame） */
  private avatar: Sprite;
  /** 战斗力分隔线节点（placeLevel 的宽度上限从它实际位置读） */
  private combatDivider: Node;
  /** 实时通道状态点（四态换色） */
  private realtimeDot: Sprite | null = null;
  /** 实时通道状态文字（四态换文案 + 换色） */
  private realtimeLabel: Label | null = null;
  /** 实时通道状态订阅的退订函数（dispose 时先退订，#1188 口径） */
  private offRealtimeStatus: (() => void) | null = null;
  /** 是否为本人信息栏（本人贴左上角，其他玩家固定在屏幕中心） */
  private isSelf: boolean;
  /** 上一次显示的战斗力（变化检测基准；构造时初始化，首次刷新不弹 ±提示） */
  private shownCombat: number;

  constructor(role: Role, prefab: Prefab) {
    super("role_info_bar");
    this.isSelf = role.relationShip === RELATION_SHIP.SELF;
    this.shownCombat = role.combat;

    if (!prefab) {
      console.warn("[role-info-bar] prefab 未注入：请确认 Game 场景的 roleInfoBarPrefab 字段已绑定");
      return;
    }
    // 实例化 prefab：把根节点子树挂到 this（this 本身就是信息栏根节点，契约不变）
    const instance = instantiate(prefab) as Node;
    this.addComponent(UITransform).setContentSize(instance.getComponent(UITransform)!.contentSize);
    const children = instance.children.slice();
    for (const child of children) child.setParent(this);
    this.applyFixedPosition();

    const nodes = roleInfoBarPrefab.nodes;
    // 取用器找不到节点/组件只告警不崩（#1357）：报出具体路径，层级错位一眼定位，
    // 别再出一个无从下手的 `Cannot set properties of null`
    const node = (path: string): Node | null => {
      const found = this.getChildByPath(path);
      if (!found) console.warn(`[role-info-bar] prefab 缺节点: ${path}`);
      return found;
    };
    const sprite = (path: string): Sprite | null => {
      const comp = node(path)?.getComponent(Sprite) ?? null;
      if (!comp) console.warn(`[role-info-bar] 节点缺 Sprite 组件: ${path}`);
      return comp;
    };
    const label = (path: string): Label | null => {
      const comp = node(path)?.getComponent(Label) ?? null;
      if (!comp) console.warn(`[role-info-bar] 节点缺 Label 组件: ${path}`);
      return comp;
    };

    this.nameLabel = label(nodes.name)!;
    this.levelLabel = label(nodes.level)!;
    this.bindGoldCountLabel = label(nodes.currencyValue)!;
    this.combatLabel = label(nodes.combatValue)!;
    this.combatNode = node(nodes.combatValue)!;
    this.avatar = sprite(nodes.avatar)!;
    this.combatDivider = node(nodes.combatDivider)!;

    // 动态填值（颜色字号在 prefab，代码不覆写）
    this.nameLabel.string = role.name;
    this.levelLabel.string = `${role.level} 级`;
    this.placeLevel();
    this.bindGoldCountLabel.string = role.bindGold.toString();
    this.combatLabel.string = role.combat.toString();
    this.applyAvatar(role);

    // 实时通道状态指示（#1324：仅本人信息栏带；四态色由代码按状态覆盖 prefab 占位色）
    if (this.isSelf) {
      this.realtimeDot = sprite(nodes.statusDot);
      this.realtimeLabel = label(nodes.statusText);
      // 注册即以当前状态回调一次，之后每次状态变化跟着变；退订函数留到 dispose
      this.offRealtimeStatus = RealtimeClient.addStatusListener((change) => this.paintRealtimeStatus(change.status));
    }

    // 状态图标条（头像正下方，进行中状态的图标；由 StatusManager 经 RoleUIManager 刷新）
    const statusIconBar = new StatusIconBar();
    node(nodes.statusIcons)!.addChild(statusIconBar);
    RoleUIManager.registerStatusIconBar(statusIconBar);
  }

  /** 定位（固定值，见 hudLayout.roleInfoBarLayout.position —— 主界面布局不再按屏幕尺寸换算） */
  applyFixedPosition() {
    const layout = roleInfoBarLayout;
    if (!this.isSelf) {
      this.setPosition(layout.otherPosition.x, layout.otherPosition.y, 0);
      return;
    }
    this.setPosition(layout.position.x, layout.position.y, 0);
  }

  /** 数据变更后刷新显示（只填值，颜色字号不动） */
  updateRole(role: Role) {
    this.nameLabel.string = role.name;
    this.levelLabel.string = `${role.level} 级`;
    this.placeLevel();
    this.bindGoldCountLabel.string = role.bindGold.toString();
    this.updateCombat(role.combat);
    this.applyAvatar(role);
  }

  /**
   * 「N 级」紧跟在名称右缘（稿 `.info .nm`）
   *
   * #1353：字号已固化进 prefab，这里从 nameLabel 节点**实际字号**读，不再取配置常量 ——
   * 用户在编辑器里改了字号 / 位置，等级定位自动跟着变，不会算错。
   */
  private placeLevel() {
    const fontSize = this.nameLabel.fontSize;
    const namePos = this.nameLabel.node.position;
    const nameWidth = this.nameLabel.node.getComponent(UITransform)!.contentSize.width;
    const leftEdge = namePos.x - nameWidth / 2;
    let width = 0;
    for (const ch of this.nameLabel.string) width += ch.charCodeAt(0) > 0x2e80 ? fontSize : fontSize * 0.56;
    const levelUt = this.levelLabel.node.getComponent(UITransform)!;
    const dividerX = this.combatDivider.position.x;
    const maxX = dividerX - levelUt.contentSize.width / 2 - 4;
    const x = Math.min(leftEdge + width + 8 + levelUt.contentSize.width / 2, maxX);
    this.levelLabel.node.setPosition(x, this.levelLabel.node.position.y, 0);
  }

  /** 职业/性别头像：spriteFrame 从 resources 动态加载（素材随包走，不固化进 prefab） */
  private applyAvatar(role: Role) {
    const path = `ui/avatar/${role.occupation}-${role.sex}`;
    UiHelper.loadSprite(path, (frame) => {
      if (!this.avatar || !this.avatar.isValid) return;
      this.avatar.spriteFrame = frame;
    });
  }

  /**
   * 战斗力数字更新（#732）：真的变了才动文本，并在战斗力旁边弹 ±飘字（上升绿 / 下降红）
   * 飘字颜色属动态色（数据驱动），仍由 tip-fx 运行时绘制，不固化进 prefab。
   */
  private updateCombat(combat: number) {
    if (combat === this.shownCombat) return;
    const delta = combat - this.shownCombat;
    this.shownCombat = combat;
    this.combatLabel.string = combat.toString();
    GameUiHelper.showCombatDelta(this.combatNode, delta);
  }

  /**
   * 实时通道状态点的着色与文案（#1324）
   *
   * #1353：四态色是数据驱动的动态色，无法固化进 prefab —— prefab 里放占位色，这里按状态覆盖。
   * 点与文字永远同色：已连接 jade / 连接中 gold-4 / 已断开 ember-3 / 未连接 text-3（灰）。
   */
  private paintRealtimeStatus(status: RealtimeStatus) {
    if (!this.realtimeDot || !this.realtimeLabel) return;
    const color: Color = roleInfoBarPrefab.realtimeColors[status];
    this.realtimeDot.color = color;
    this.realtimeLabel.string = getText(REALTIME_STATUS_TEXTS[status]);
    this.realtimeLabel.color = color;
  }

  /** 离场清理：先退订静态监听再拆字段（#1188：销毁期 emit 回调摸已销毁字段是崩溃源），由 ui/Game 的场景收尾调用 */
  dispose() {
    this.offRealtimeStatus?.();
    this.offRealtimeStatus = null;
  }
}
