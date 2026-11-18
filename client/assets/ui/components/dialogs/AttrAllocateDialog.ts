import { Color, Graphics, isValid, Label, Node, Size, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import UiHelper from "../../helpers/UiHelper";
import LayerManager from "../../core/LayerManager";
import StorageManager from "../../core/StorageManager";
import { attrAllocateDialogLayout, T } from "../../../configs/hudLayout";
import { goodShowAttributesLabel } from "../../../configs/good";
import { getText } from "../../../configs/texts";
import { ATTR_POINT_KEYS, AttrPointKey } from "../../../types/role";

/** 总览行的键：BattleAttributes 八键 + 表外的魔法上限 / 战斗力（文案见 texts） */
type OverviewKey = typeof attrAllocateDialogLayout.overview.keys[number];

/**
 * 属性弹窗（#833 加点；#1108 按 22-attributes 稿扩为总览＋加点合一）
 *
 * 三段一屏：剩余属性点 → 战斗属性总览（两列 10 项，服务端 roleUpdate 汇总下发，
 * 客户端零计算）→ 四维加点，底部一条说明。洗点条已移除（#1113）：客户端不再提供
 * 洗点入口，服务端接口保留。
 *
 * 三条取舍（#833 原有两条沿用，一条被 #1108 推翻）：
 * - **一次加一点**：界面上就是四个「+」，点一下发一次（服务端接口本来支持多段增量，
 *   但「一次加几点」的输入框在手机上比四个按钮难用得多）；
 * - **加完就地重建**，不重开弹窗：重开会让玩家丢失「刚点了哪一项」的视觉连续性，
 *   而这个弹窗只有四行、重建成本可以忽略；
 * - **（#1108 推翻）点数为 0 时「＋」置灰不可点**：#833 原为「不禁用、点了收 20037 提示」；
 *   22 稿（06 稿精神行同款）用禁用画法表达「没点可加」，置灰是即时反馈，
 *   不用点一下才知道。服务端校验仍是权威，置灰只是省一次必拒的请求。
 */
export default class AttrAllocateDialog {
  /** 弹窗节点（切换关闭要用；关闭后置空） */
  private dialog: Node | null = null;
  /** 剩余点数数值标签（加完点改数字用） */
  private pointsLabel: Label | null = null;
  /** 总览两列行的容器（属性变化后重建用） */
  private overviewContent: Node | null = null;
  /** 四行的容器（加完点重建行用） */
  private listContent: Node | null = null;
  /** 正在等服务端回执：防止连点把同一笔请求发两次（第二个会被服务端按余额拒掉，但界面会闪） */
  private pending = false;

  /** 打开/关闭（开关：已开则关） */
  open() {
    if (this.dialog && isValid(this.dialog) && this.dialog.active) {
      this.close();
      return;
    }
    // 弹窗已在场景切换 / 关闭按钮销毁时清掉残留引用
    if (this.dialog && !isValid(this.dialog)) this.dialog = null;
    const cfg = attrAllocateDialogLayout;
    const dialog = GameUiHelper.createDialog(cfg.name, cfg.title, new Vec2(), cfg.size, cfg.eyebrow);
    const contentWidth = cfg.points.width;

    // 剩余点数行（左灰标签 + 右金色数值）+ 行下沿细分隔线
    const pointsRow = GameUiHelper.createAttrPointsRow();
    dialog.addChild(pointsRow);
    this.pointsLabel = pointsRow.getChildByName(cfg.points.value.name)?.getComponent(Label) ?? null;
    dialog.addChild(this.createDivider("attr_points_divider", cfg.points.dividerY, contentWidth));

    // 战斗属性总览（两列 10 项）
    dialog.addChild(this.createSectionTitle(cfg.overview.title.name, getText("label_attributes_combat"), cfg.overview.title.y, cfg.overview.title));
    dialog.addChild(this.createDivider("attr_overview_divider", cfg.overview.dividerY, contentWidth));
    const overview = UiHelper.createNode("attr_overview", new Vec2(), cfg.size);
    this.overviewContent = overview;
    dialog.addChild(overview);

    // 四维加点（四行）
    dialog.addChild(this.createSectionTitle(cfg.list.title.name, getText("label_attributes_alloc"), cfg.list.title.y, cfg.list.title));
    dialog.addChild(this.createDivider("attr_alloc_divider", cfg.list.dividerY, contentWidth));
    const list = GameUiHelper.createAttrListView();
    this.listContent = list;
    dialog.addChild(list);

    // 底部说明条（稿 .panel-foot 两行小字）
    dialog.addChild(this.createDivider("attr_foot_divider", cfg.foot.dividerY, contentWidth));
    dialog.addChild(
      this.createNoteLabel(cfg.foot.left.name, getText("label_attr_foot_left"), cfg.foot.left.x, cfg.foot.y, cfg.foot.left.width, cfg.foot.left.fontSize, cfg.foot.left.color),
    );
    dialog.addChild(
      this.createNoteLabel(cfg.foot.right.name, getText("label_attr_foot_right"), cfg.foot.right.x, cfg.foot.y, cfg.foot.right.width, cfg.foot.right.fontSize, cfg.foot.right.color),
    );

    this.dialog = dialog;
    LayerManager.addDialogToUILayer(dialog);
    this.rebuild();
  }

  /**
   * 重建总览两列 + 四行 + 刷新剩余点数
   *
   * 角色数据每次都现读 `StorageManager`：加点回执已经把新值写进在线角色，
   * 所以重建出来就是最新状态（**不在本地加一** —— 那是第二个真相）。
   * 总览也要重建：四维直接乘进面板（物攻 / 生命 / 物防 / 法力），加一点总览就变。
   */
  private rebuild() {
    const role = StorageManager.findOnlineRole();
    const overview = this.overviewContent;
    const content = this.listContent;
    if (!role || !overview || !isValid(overview) || !content || !isValid(content)) return;
    if (this.pointsLabel && isValid(this.pointsLabel)) {
      this.pointsLabel.string = getText("label_attr_points_value", { points: role.attrPoints });
    }
    // 总览：行序与列位见 layout.overview（两列 × 5 行，行高固定不用滚动）
    overview.removeAllChildren();
    attrAllocateDialogLayout.overview.keys.forEach((key, index) => {
      const item = GameUiHelper.createAttrOverviewRow(
        `attr_overview_${key}`,
        this.overviewLabelText(key),
        this.overviewValueText(role, key),
        key === "combat",
      );
      const column = index % 2;
      const rowIndex = Math.floor(index / 2);
      item.setPosition(
        attrAllocateDialogLayout.overview.row.colX[column],
        attrAllocateDialogLayout.overview.row.firstY - rowIndex * attrAllocateDialogLayout.overview.row.pitch,
      );
      overview.addChild(item);
    });
    // 四行：行高固定，第一行中心在 list.firstY，往下按行高 + 间距排
    content.removeAllChildren();
    ATTR_POINT_KEYS.forEach((key, index) => {
      const row = GameUiHelper.createAttrPointRow(role, key, () => void this.addPoint(key));
      row.setPosition(0, attrAllocateDialogLayout.list.firstY - index * (attrAllocateDialogLayout.row.height + attrAllocateDialogLayout.list.gap));
      content.addChild(row);
    });
  }

  /** 总览行名称：BattleAttributes 八键走显示名表，maxMp / combat 走专属文案键 */
  private overviewLabelText(key: OverviewKey): string {
    if (key === "maxMp") return getText("label_attr_max_mp");
    if (key === "combat") return getText("label_attr_combat_power");
    return goodShowAttributesLabel.get(key) ?? "";
  }

  /** 总览行数值：区间走 `formatAttributeValue`（与角色信息主窗同一口径），单值直排 */
  private overviewValueText(role: { maxHp: number; hpRecover: number; maxMp: number; combat: number } & Record<OverviewKey, unknown>, key: OverviewKey): string {
    if (key === "maxMp") return GameUiHelper.formatAttributeValue(role.maxMp);
    if (key === "combat") return String(role.combat);
    return GameUiHelper.formatAttributeValue(role[key] as readonly number[] | number);
  }

  /** 段标题（「战斗属性 / 四维加点」）：金色小字贴内容左缘（稿 h4） */
  private createSectionTitle(name: string, text: string, y: number, style: { fontSize: number; color: Color }): Node {
    const { sectionTitle } = attrAllocateDialogLayout;
    return GameUiHelper.createText(name, text, style.fontSize, new Vec2(sectionTitle.x, y), sectionTitle.size, style.color, Label.HorizontalAlign.LEFT);
  }

  /** 小字说明行（底部说明条，左对齐） */
  private createNoteLabel(name: string, text: string, x: number, y: number, width: number, fontSize: number, color: Color): Node {
    return UiHelper.createLabel(name, text, color, fontSize, new Vec2(x, y), new Size(width, attrAllocateDialogLayout.foot.noteHeight), Label.HorizontalAlign.LEFT);
  }

  /** 细分隔线（1px Graphics，AnnouncementBoard 同款画法；颜色 T.line[1]） */
  private createDivider(name: string, y: number, width: number): Node {
    const node = UiHelper.createNode(name, new Vec2(0, y), new Size(width, 1));
    const graphics = node.addComponent(Graphics);
    graphics.fillColor = T.line[1];
    graphics.rect(-width / 2, -0.5, width, 1);
    graphics.fill();
    return node;
  }

  /** 加一点（扣点、属性重算、落库都在服务端；成功后就地重建） */
  private async addPoint(key: AttrPointKey): Promise<void> {
    if (this.pending) return;
    this.pending = true;
    try {
      const ok = await StorageManager.allocateAttrsOnServer(key);
      if (ok) this.rebuild();
    } finally {
      this.pending = false;
    }
  }

  /** 关闭弹窗 */
  close() {
    if (this.dialog && isValid(this.dialog)) this.dialog.destroy();
    this.dialog = null;
    this.pointsLabel = null;
    this.overviewContent = null;
    this.listContent = null;
  }
}
