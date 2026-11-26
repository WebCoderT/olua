import { Graphics, Label, Node, Size, UITransform, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import UiHelper from "../../helpers/UiHelper";
import RoleUIManager from "../../core/RoleUIManager";
import StatusIconBar from "./StatusIconBar";
import RealtimeClient, { RealtimeStatus } from "../../utils/net/RealtimeClient";
import { Role } from "../../../entities/Role";
import { RELATION_SHIP } from "../../../types/role";
import { roleInfoBarLayout, T, uiImages } from "../../../configs/hudLayout";
import { getText } from "../../../configs/texts";

/** 货币种数（收敛后只有绑定元宝一种，#843/#844），用于把货币容器宽度等分给每件 */
const CURRENCY_COUNT = 1;

/** 实时通道状态 → 指示文字的文案 key（#1324；四态颜色见 hudLayout.realtimeStatus.colors，按同一组键取） */
const REALTIME_STATUS_TEXTS: Record<RealtimeStatus, string> = {
  [RealtimeStatus.Idle]: "realtime_status_idle",
  [RealtimeStatus.Connecting]: "realtime_status_connecting",
  [RealtimeStatus.Connected]: "realtime_status_connected",
  [RealtimeStatus.Disconnected]: "realtime_status_disconnected",
};

/**
 * 角色信息栏组件（左上角常驻 HUD）
 * 展示：背景框 + 头像 + 名称 + 等级 + 绑定元宝（横向布局容器）+ 战斗力
 * 由通用零件（背景/头像/货币/战斗力）拼装而成，本组件负责拼装与数据刷新
 * 位置与尺寸全部来自 configs/hudLayout（各子件坐标以信息栏中心为原点）：
 * 自己的位置是固定值（hudLayout.roleInfoBarLayout.position，创建时调一次 applyFixedPosition）
 */
export default class RoleInfoBar extends Node {
  /** 名称文本 */
  private nameLabel: Label;
  /** 等级文本 */
  private levelLabel: Label;
  /** 绑定元宝数量文本（唯一货币，*） */
  private bindGoldCountLabel: Label;
  /** 战斗力文本 */
  private combatLabel: Label;
  /** 战斗力零件节点（±飘字的挂点） */
  private combatNode: Node;
  /** 上一次显示的战斗力（变化检测基准；构造时初始化，首次刷新不弹 ±提示） */
  private shownCombat: number;
  /** 是否为本人信息栏（本人贴左上角，其他玩家固定在屏幕中心） */
  private isSelf: boolean;
  /** 实时通道状态点的圆（#1324，仅本人信息栏；状态变化时清了重画换色） */
  private realtimeDot: Graphics | null = null;
  /** 实时通道状态文字（与圆点同色） */
  private realtimeLabel: Label | null = null;
  /** 实时通道状态订阅的退订函数（dispose 时先退订，#1188 口径） */
  private offRealtimeStatus: (() => void) | null = null;

  constructor(role: Role) {
    super("role_info_bar");
    const layout = roleInfoBarLayout;
    const isSelf = role.relationShip === RELATION_SHIP.SELF;
    this.isSelf = isSelf;
    this.addComponent(UITransform).setContentSize(layout.size);
    this.applyFixedPosition();
    // 底板（#1059：矢量半透明面板，不再用底图）
    this.addChild(GameUiHelper.createGlassPlate("role_info_background", layout.backgroundSize, T.radius.r3, T.line[3]));
    // 名称与等级（稿 `.info .nm`：名称 17px 骨白 + 「N 级」11px 金-4，同一行基线）
    this.nameLabel = GameUiHelper.createText("role_name", role.name, layout.name.fontSize, layout.name.position, layout.name.size, T.text[1], Label.HorizontalAlign.LEFT).getComponent(Label);
    this.addChild(this.nameLabel.node);
    this.levelLabel = GameUiHelper.createText("role_level", `${role.level} 级`, layout.level.fontSize, layout.level.position, layout.level.size, layout.level.color).getComponent(Label);
    this.addChild(this.levelLabel.node);
    this.placeLevel(role.name);
    // 头像
    this.addChild(GameUiHelper.createAvatarPortrait(role, layout.portrait.position, layout.portrait.size));
    // 货币区：唯一货币（绑定元宝）放在横向布局容器里，占容器全宽、内容左对齐
    const currencyBar = GameUiHelper.createRow("role_currency_bar", layout.currencyBar.spacing, layout.currencyBar.position, layout.currencyBar.size);
    const itemSize = new Size(layout.currencyBar.size.width / CURRENCY_COUNT, layout.currencyBar.size.height);
    const bindGold = GameUiHelper.createCurrencyItem(uiImages.bindGold, role.bindGold, new Vec2(), itemSize, {
      iconSize: layout.currencyBar.iconSize,
      label: layout.currencyBar.label,
      value: layout.currencyBar.value,
    });
    this.bindGoldCountLabel = bindGold.valueLabel;
    currencyBar.addChild(bindGold.node);
    this.addChild(currencyBar);
    // 战斗力（右侧一小块：左边一条 1px line-2 竖线把货币区分开，标签/数值都右对齐）
    this.addChild(this.createCombatDivider());
    const combat = GameUiHelper.createCombatPower(role, layout.combat.position);
    this.combatLabel = combat.combatLabel;
    this.combatNode = combat.node;
    this.shownCombat = role.combat;
    this.addChild(combat.node);
    // 实时通道状态指示（#1324：战斗力数值正下方的小圆点 + 同色文字；只有本人信息栏带）
    if (isSelf) {
      const rs = layout.realtimeStatus;
      const node = UiHelper.createNode("realtime_status", rs.position, rs.size);
      const dotNode = UiHelper.createNode("realtime_status_dot", new Vec2(rs.dotX, 0), new Size(rs.dotSize, rs.dotSize));
      this.realtimeDot = dotNode.addComponent(Graphics);
      node.addChild(dotNode);
      this.realtimeLabel = UiHelper.createLabel("realtime_status_text", "", T.text[3], rs.fontSize, new Vec2(), rs.size, Label.HorizontalAlign.RIGHT).getComponent(Label)!;
      node.addChild(this.realtimeLabel.node);
      this.addChild(node);
      // 注册即以当前状态回调一次，之后每次状态变化跟着变；退订函数留到 dispose
      this.offRealtimeStatus = RealtimeClient.addStatusListener((change) => this.paintRealtimeStatus(change.status));
    }
    // 状态图标条（头像正下方，进行中状态的图标；由 StatusManager 经 RoleUIManager 刷新）
    const statusIconBar = new StatusIconBar();
    this.addChild(statusIconBar);
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

  /** 数据变更后刷新显示 */
  updateRole(role: Role) {
    this.nameLabel.string = role.name;
    this.levelLabel.string = `${role.level} 级`;
    this.placeLevel(role.name);
    this.bindGoldCountLabel.string = role.bindGold.toString();
    this.updateCombat(role.combat);
  }

  /**
   * 「N 级」紧跟在名称右缘（稿 `.info .nm{display:flex;align-items:baseline;gap:8px}`）
   *
   * 客户端两个 Label 是固定 bbox，只能按名字的**估算宽度**把等级摆到名字后面：
   * 汉字按整字宽、ASCII 按 0.56 字宽（角色名基本是中文，误差只在英文名上）；
   * 再夹一道上限，别让超长名字把等级顶进战斗力分隔线。
   */
  private placeLevel(name: string) {
    const layout = roleInfoBarLayout;
    const leftEdge = layout.name.position.x - layout.name.size.width / 2;
    let width = 0;
    for (const ch of name) width += ch.charCodeAt(0) > 0x2e80 ? layout.name.fontSize : layout.name.fontSize * 0.56;
    const maxX = layout.combat.divider.x - layout.level.size.width / 2 - 4;
    const x = Math.min(leftEdge + width + 8 + layout.level.size.width / 2, maxX);
    this.levelLabel.node.setPosition(x, layout.level.position.y, 0);
  }

  /** 战斗力块左侧的竖分隔线（稿 `.info .pw{border-left:1px solid line-2}`，1px 填充条画） */
  private createCombatDivider() {
    const cfg = roleInfoBarLayout.combat.divider;
    const node = UiHelper.createNode("combat_divider", new Vec2(cfg.x, 0), new Size(1, cfg.height));
    const graphics = node.addComponent(Graphics);
    graphics.fillColor = cfg.color;
    graphics.rect(-0.5, -cfg.height / 2, 1, cfg.height);
    graphics.fill();
    return node;
  }

  /**
   * 战斗力数字更新（#732）：真的变了才动文本，并在战斗力旁边弹 ±飘字（上升绿 / 下降红）
   *
   * 战斗力的写点有多路（bagOp 应答 / roleUpdate 帧），没变就一个字都不动 ——
   * 「抖动」的另一面是「没变化也重绘」，这里顺带把显示收敛成变化驱动
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
   * 点与文字永远同色：已连接 jade / 连接中 gold-4 / 已断开 ember-3 / 未连接 text-3（灰）。
   * 圆是 Graphics 现画的，换色 = 清了重画一次（点只有 6px，DrawCall 不变）。
   * 订阅方（RealtimeClient.addStatusListener）销毁前先退订 —— 这里是纯绘制，字段已清时直接跳过兜底。
   */
  private paintRealtimeStatus(status: RealtimeStatus) {
    if (!this.realtimeDot || !this.realtimeLabel) return;
    const rs = roleInfoBarLayout.realtimeStatus;
    const color = rs.colors[status];
    const graphics = this.realtimeDot;
    graphics.clear();
    graphics.fillColor = color;
    graphics.circle(0, 0, rs.dotSize / 2);
    graphics.fill();
    this.realtimeLabel.string = getText(REALTIME_STATUS_TEXTS[status]);
    this.realtimeLabel.color = color;
  }

  /** 离场清理：先退订静态监听再拆字段（#1188：销毁期 emit 回调摸已销毁字段是崩溃源），由 ui/Game 的场景收尾调用 */
  dispose() {
    this.offRealtimeStatus?.();
    this.offRealtimeStatus = null;
  }
}
