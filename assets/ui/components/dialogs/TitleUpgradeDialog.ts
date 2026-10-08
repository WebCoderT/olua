import { Color, isValid, Label, Node, ScrollView, Sprite, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import StorageManager from "../../core/StorageManager";
import RoleUIManager from "../../core/RoleUIManager";
import UiHelper from "../../helpers/UiHelper";
import { getTitleLevel, titleLevels, titleMaxLevel } from "../../../configs/title";
import { titleUpgradeDialogLayout } from "../../../configs/hudLayout";
import { getText } from "../../../configs/texts";
import { clearChildren } from "../../utils/node/NodeTree";

/** 弹窗布局（尺寸与各栏位置、配色统一见 configs/hudLayout.titleUpgradeDialogLayout） */
const layout = titleUpgradeDialogLayout;

/**
 * 称号升级弹窗（左中右三栏，结构与战魂弹窗一致）
 * 左：所有称号等级卡片的竖向滚动列表（按等级从上到下排列，已激活/未激活/选中三种状态）
 * 中：所选等级的称号名牌动画 + 名称/描述/当前称号信息（称号常显头顶，没有「外显」勾选框）
 * 右：所选等级的称号属性（带下一级增量）+ 绑定元宝余额 + 升级按钮
 * 升级消耗绑定元宝（价格曲线见 configs/title），成功后整体刷新弹窗并刷新头顶名牌
 * 入口在角色信息弹窗的「称号」按钮（不走 NPC，见 RoleInfoDialog）
 */
export default class TitleUpgradeDialog {
  /** 当前预览的称号等级（点击左侧卡片切换） */
  private selectedLevel = 1;
  /** 弹窗内的可刷新部件 */
  private listContent: Node | null = null;
  private animationSlot: Node | null = null;
  private animationNode: Node | null = null;
  private infoSlot: Node | null = null;
  private attributeSlot: Node | null = null;
  private upgradeButton: Node | null = null;
  private bindGoldLabel: Node | null = null;

  /** 打开弹窗 */
  open() {
    const role = StorageManager.findOnlineRole();
    // 默认预览当前称号等级（尚未激活时预览 1 阶）
    this.selectedLevel = Math.max(1, role?.title ?? 1);
    const dialog = GameUiHelper.createDialog(layout.name, layout.title, new Vec2(), layout.size);
    // 左：称号等级列表（可上下滑动）
    const list = GameUiHelper.createScrollView(layout.list.name, layout.list.position, layout.list.size);
    this.listContent = list.getComponent(ScrollView).content;
    dialog.addChild(list);
    // 中：称号动画与信息（槽位节点内容随选中等级重建）
    this.animationSlot = UiHelper.createGroupNode("title_animation_slot", layout.animation.position);
    dialog.addChild(this.animationSlot);
    this.infoSlot = UiHelper.createGroupNode("title_info_slot", layout.info.position);
    dialog.addChild(this.infoSlot);
    // 右：属性面板 / 绑定元宝 / 升级按钮
    this.attributeSlot = UiHelper.createGroupNode("title_attribute_slot", layout.attribute.position);
    dialog.addChild(this.attributeSlot);
    this.bindGoldLabel = UiHelper.createLabel("title_bind_gold", "", Color.WHITE, layout.bindGold.fontSize, layout.bindGold.position, layout.bindGold.size);
    dialog.addChild(this.bindGoldLabel);
    this.upgradeButton = GameUiHelper.createMiddleButton("title_upgrade_button", layout.upgradeButton.text, layout.upgradeButton.position);
    this.upgradeButton.on(
      Node.EventType.TOUCH_END,
      () => {
        // 升级成功后整体刷新（失败时 StorageManager 已弹出原因提示）；称号常显头顶，同步换掉主角头顶的名牌动画
        if (StorageManager.upgradeTitle()) {
          RoleUIManager.updateTitleShow();
          this.refresh();
        }
      },
      this,
    );
    dialog.addChild(this.upgradeButton);
    LayerManager.addDialogToUILayer(dialog);
    this.refresh();
  }

  /** 整体刷新（选中等级切换、升级成功后调用）：列表状态 / 动画 / 信息 / 属性 / 按钮全部重建 */
  private refresh() {
    const role = StorageManager.findOnlineRole();
    const config = getTitleLevel(this.selectedLevel);
    if (!role || !config || !this.listContent || !this.animationSlot || !this.infoSlot || !this.attributeSlot) return;
    // 左列表：按等级从上到下（titleLevels 本身升序），点击切换预览
    clearChildren(this.listContent);
    titleLevels.forEach((item) =>
      this.listContent.addChild(
        GameUiHelper.createTitleCard(
          item,
          role.title,
          item.level === this.selectedLevel,
          () => {
            if (this.selectedLevel === item.level) return;
            this.selectedLevel = item.level;
            this.refresh();
          },
        ),
      ),
    );
    // 中间动画：先销毁旧的再重建（不同等级帧目录不同）
    if (this.animationNode && isValid(this.animationNode)) this.animationNode.destroy();
    this.animationNode = GameUiHelper.createTitleAnimation(config);
    this.animationSlot.addChild(this.animationNode);
    // 中间信息：名称 / 描述 / 当前称号（位置、尺寸、字号与配色见 layout.info）
    clearChildren(this.infoSlot);
    const info = layout.info;
    this.infoSlot.addChild(UiHelper.createLabel("title_name", config.label, info.name.color, info.name.fontSize, info.name.position, info.name.size));
    this.infoSlot.addChild(UiHelper.createLabel("title_desc", config.description, info.description.color, info.description.fontSize, info.description.position, info.description.size));
    const current = getTitleLevel(role.title);
    this.infoSlot.addChild(
      UiHelper.createLabel("title_current", current ? getText("label_title_current", { level: role.title, label: current.label }) : getText("label_title_none"), info.current.color, info.current.fontSize, info.current.position, info.current.size),
    );
    // 右侧属性：所选等级属性 + 下一级增量
    clearChildren(this.attributeSlot);
    this.attributeSlot.addChild(GameUiHelper.createTitleAttributeList(config, getTitleLevel(this.selectedLevel + 1)));
    // 升级按钮与绑定元宝（按钮始终针对当前称号等级的下一级；满级置灰，文案随 maxedText 切换）
    if (this.upgradeButton) {
      const sprite = this.upgradeButton.getComponent(Sprite);
      const label = this.upgradeButton.getChildByName("title_upgrade_button_label")?.getComponent(Label);
      const maxed = role.title >= titleMaxLevel;
      if (label) label.string = maxed ? layout.upgradeButton.maxedText : layout.upgradeButton.text;
      if (sprite) sprite.grayscale = maxed;
    }
    if (this.bindGoldLabel) this.bindGoldLabel.getComponent(Label).string = getText("label_bind_gold", { value: role.bindGold });
  }
}
