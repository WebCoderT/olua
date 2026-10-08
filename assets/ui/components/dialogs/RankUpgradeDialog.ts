import { Color, isValid, Label, Layout, Node, ScrollView, Sprite, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import StorageManager from "../../core/StorageManager";
import UiHelper from "../../helpers/UiHelper";
import { getRankLevel, rankLevels, rankMaxLevel } from "../../../configs/rank";
import { rankUpgradeDialogLayout } from "../../../configs/hudLayout";
import { getText } from "../../../configs/texts";
import { clearChildren } from "../../utils/node/NodeTree";

/** 弹窗布局（尺寸与各栏位置、配色统一见 configs/hudLayout.rankUpgradeDialogLayout） */
const layout = rankUpgradeDialogLayout;

/**
 * 军衔进阶弹窗（左中右三栏，结构与战魂/称号弹窗一致）
 * 左：100 阶军衔卡片的竖向滚动列表（按阶数从上到下，未授衔/已授衔/选中三种状态）
 * 中：军衔徽记（军衔没有帧动画，徽记文字牌就是它的外观）+ 衔名/描述/当前军衔
 * 右：该阶军衔属性（带下一阶增量）+ 绑定元宝余额 + 晋升按钮
 * 晋升消耗绑定元宝（价格曲线见 configs/rank），成功后整体刷新并同步头顶那行军衔红字
 * 入口在角色信息弹窗的「军衔」按钮（不走 NPC，见 RoleInfoDialog）
 *
 * 与战魂/称号弹窗的工程差异：阶数有 100 阶，**卡片列表只在打开时建一次**，
 * 点击切换选中只改两张卡片的外观（见 GameUiHelper.updateRankCard）——
 * 每次点击重建 100 张卡片会重演商城「打开就卡」那个坑（建节点才是卡顿根因）
 */
export default class RankUpgradeDialog {
  /** 当前预览的军衔阶数（点击左侧卡片切换） */
  private selectedLevel = 1;
  /** 左侧列表的 ScrollView（滚动到选中阶用） */
  private listView: ScrollView | null = null;
  /** 列表内容容器（100 张卡片的父节点） */
  private listContent: Node | null = null;
  /** 卡片引用（下标 = 阶数 − 1；只建一次，切换选中原地改外观） */
  private listCards: Node[] = [];
  /** 弹窗内的可刷新部件 */
  private badgeSlot: Node | null = null;
  private infoSlot: Node | null = null;
  private attributeSlot: Node | null = null;
  private upgradeButton: Node | null = null;
  private bindGoldLabel: Node | null = null;

  /** 打开弹窗 */
  open() {
    const role = StorageManager.findOnlineRole();
    // 默认预览当前军衔（尚未授衔时预览 1 阶）
    this.selectedLevel = Math.max(1, role?.rank ?? 1);
    const dialog = GameUiHelper.createDialog(layout.name, layout.title, new Vec2(), layout.size);
    // 左：军衔阶数列表（可上下滑动，100 阶只建一次）
    const list = GameUiHelper.createScrollView(layout.list.name, layout.list.position, layout.list.size);
    this.listView = list.getComponent(ScrollView);
    this.listContent = this.listView.content;
    dialog.addChild(list);
    this.buildList(role?.rank ?? 0);
    // 中：军衔徽记与信息（槽位节点内容随选中阶重建）
    this.badgeSlot = UiHelper.createGroupNode("rank_badge_slot", layout.badge.position);
    dialog.addChild(this.badgeSlot);
    this.infoSlot = UiHelper.createGroupNode("rank_info_slot", layout.info.position);
    dialog.addChild(this.infoSlot);
    // 右：属性面板 / 绑定元宝 / 晋升按钮
    this.attributeSlot = UiHelper.createGroupNode("rank_attribute_slot", layout.attribute.position);
    dialog.addChild(this.attributeSlot);
    this.bindGoldLabel = UiHelper.createLabel("rank_bind_gold", "", Color.WHITE, layout.bindGold.fontSize, layout.bindGold.position, layout.bindGold.size);
    dialog.addChild(this.bindGoldLabel);
    this.upgradeButton = GameUiHelper.createMiddleButton("rank_upgrade_button", layout.upgradeButton.text, layout.upgradeButton.position);
    this.upgradeButton.on(
      Node.EventType.TOUCH_END,
      () => {
        // 晋升成功后整体刷新（失败时 StorageManager 已弹出原因提示）；
        // 军衔的红字外显随 updateUi 自动刷新（见 StorageManager.upgradeRank），这里只处理弹窗自身
        if (StorageManager.upgradeRank()) {
          // 选中挪到刚晋上的那一阶，顺势把列表滚过去
          this.selectedLevel = Math.min(rankMaxLevel, Math.max(1, StorageManager.findOnlineRole()?.rank ?? this.selectedLevel));
          this.updateCardStates();
          this.refreshDetail();
          this.scrollToSelected();
        }
      },
      this,
    );
    dialog.addChild(this.upgradeButton);
    LayerManager.addToUILayer(dialog);
    this.refreshDetail();
    this.scrollToSelected();
  }

  /**
   * 建左侧 100 阶卡片列表（**只在打开时建一次**）
   * 点击卡片只切选中：改两张卡片的外观 + 重刷中/右两栏，不重建列表
   */
  private buildList(currentLevel: number) {
    if (!this.listContent) return;
    clearChildren(this.listContent);
    this.listCards = rankLevels.map((config) => {
      const card = GameUiHelper.createRankCard(config, currentLevel, config.level === this.selectedLevel, () => this.selectLevel(config.level));
      this.listContent!.addChild(card);
      return card;
    });
  }

  /** 切换预览的军衔阶数（只刷两张卡片的选中外观与中/右两栏，不重建列表） */
  private selectLevel(level: number) {
    if (this.selectedLevel === level) return;
    const previous = this.selectedLevel;
    this.selectedLevel = level;
    const currentLevel = StorageManager.findOnlineRole()?.rank ?? 0;
    const repaint = (target: number) => {
      const card = this.listCards[target - 1];
      const config = getRankLevel(target);
      if (card && isValid(card) && config) GameUiHelper.updateRankCard(card, config, currentLevel, target === this.selectedLevel);
    };
    repaint(previous);
    repaint(level);
    this.refreshDetail();
  }

  /** 重刷全部卡片的选中/授衔外观（晋升成功后调用；只改颜色与描边，不建节点） */
  private updateCardStates() {
    const currentLevel = StorageManager.findOnlineRole()?.rank ?? 0;
    this.listCards.forEach((card, index) => {
      const config = getRankLevel(index + 1);
      if (isValid(card) && config) GameUiHelper.updateRankCard(card, config, currentLevel, index + 1 === this.selectedLevel);
    });
  }

  /**
   * 把列表滚到选中那一阶（100 阶太长，否则打开时停在最顶上、看不到自己那一阶）
   * 偏移用「卡片自身在内容里的位置」量出来，不把卡片高度/间距再写一遍到代码里
   */
  private scrollToSelected() {
    const card = this.listCards[this.selectedLevel - 1];
    if (!this.listView || !this.listContent || !card || !isValid(card)) return;
    // 先强制排一次版：CONTAINER 模式下内容高度要排完才有值，否则滚动会被按旧尺寸夹在顶部
    this.listContent.getComponent(Layout)?.updateLayout(true);
    // 让选中那一阶停在滚动区中间（卡片 y 是纵向布局排出来的，量它到内容顶部的距离再减半屏高）
    this.listView.scrollToOffset(new Vec2(0, -card.position.y - layout.list.size.height / 2));
  }

  /** 中/右两栏整体刷新（切换选中、晋升成功后调用）：徽记 / 信息 / 属性 / 按钮 / 绑定元宝 */
  private refreshDetail() {
    const role = StorageManager.findOnlineRole();
    const config = getRankLevel(this.selectedLevel);
    if (!role || !config || !this.badgeSlot || !this.infoSlot || !this.attributeSlot) return;
    // 中：军衔徽记（文字牌，随选中阶更换）
    clearChildren(this.badgeSlot);
    this.badgeSlot.addChild(GameUiHelper.createRankBadge(config));
    // 中：信息（衔名 / 描述 / 当前军衔，位置、尺寸、字号与配色见 layout.info）
    clearChildren(this.infoSlot);
    const info = layout.info;
    this.infoSlot.addChild(UiHelper.createLabel("rank_name", config.label, info.name.color, info.name.fontSize, info.name.position, info.name.size));
    this.infoSlot.addChild(UiHelper.createLabel("rank_desc", config.description, info.description.color, info.description.fontSize, info.description.position, info.description.size));
    const current = getRankLevel(role.rank);
    this.infoSlot.addChild(
      UiHelper.createLabel("rank_current", current ? getText("label_rank_current", { level: role.rank, label: current.label }) : getText("label_rank_none"), info.current.color, info.current.fontSize, info.current.position, info.current.size),
    );
    // 右：所选阶属性 + 下一阶增量
    clearChildren(this.attributeSlot);
    this.attributeSlot.addChild(GameUiHelper.createRankAttributeList(config, getRankLevel(this.selectedLevel + 1)));
    // 晋升按钮与绑定元宝（按钮始终针对当前军衔的下一阶；满衔置灰，文案随 maxedText 切换）
    if (this.upgradeButton) {
      const sprite = this.upgradeButton.getComponent(Sprite);
      const label = this.upgradeButton.getChildByName("rank_upgrade_button_label")?.getComponent(Label);
      const maxed = role.rank >= rankMaxLevel;
      if (label) label.string = maxed ? layout.upgradeButton.maxedText : layout.upgradeButton.text;
      if (sprite) sprite.grayscale = maxed;
    }
    if (this.bindGoldLabel) this.bindGoldLabel.getComponent(Label).string = getText("label_bind_gold", { value: role.bindGold });
  }
}
