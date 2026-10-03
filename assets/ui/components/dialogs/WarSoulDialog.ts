import { Color, isValid, Label, Node, ScrollView, Sprite, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import StorageManager from "../../core/StorageManager";
import RoleUIManager from "../../core/RoleUIManager";
import UiHelper from "../../helpers/UiHelper";
import { getSoulLevel, soulLevels, soulMaxLevel } from "../../../configs/soul";
import { warSoulDialogLayout } from "../../../configs/hudLayout";
import { clearChildren } from "../../utils/node/NodeTree";

/** 弹窗布局（尺寸与各栏位置、配色统一见 configs/hudLayout.warSoulDialogLayout） */
const layout = warSoulDialogLayout;

/**
 * 战魂弹窗（左中右三栏）
 * 左：所有战魂等级卡片的竖向滚动列表（按等级从上到下排列，已激活/未激活/选中三种状态）
 * 中：所选等级的战魂动画 + 名称/描述/当前战魂信息 + 外显勾选框（勾选后当前等级动画挂主角右上角）
 * 右：所选等级的战魂属性（带下一级增量）+ 绑定元宝余额 + 升级按钮
 * 升级消耗绑定元宝（见 configs/soul），成功后整体刷新弹窗
 */
export default class WarSoulDialog {
  /** 当前预览的战魂等级（点击左侧卡片切换） */
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
    // 默认预览当前战魂等级（尚未激活时预览 1 阶）
    this.selectedLevel = Math.max(1, role?.soulOfWar ?? 1);
    const dialog = GameUiHelper.createDialog(layout.name, layout.title, new Vec2(), layout.size);
    // 左：战魂等级列表（可上下滑动）
    const list = GameUiHelper.createScrollView(layout.list.name, layout.list.position, layout.list.size);
    this.listContent = list.getComponent(ScrollView).content;
    dialog.addChild(list);
    // 中：战魂动画与信息（槽位节点内容随选中等级重建）
    this.animationSlot = UiHelper.createGroupNode("soul_animation_slot", layout.animation.position);
    dialog.addChild(this.animationSlot);
    this.infoSlot = UiHelper.createGroupNode("soul_info_slot", layout.info.position);
    dialog.addChild(this.infoSlot);
    // 右：属性面板 / 绑定元宝 / 升级按钮
    this.attributeSlot = UiHelper.createGroupNode("soul_attribute_slot", layout.attribute.position);
    dialog.addChild(this.attributeSlot);
    this.bindGoldLabel = UiHelper.createLabel("soul_bind_gold", "", Color.WHITE, layout.bindGold.fontSize, layout.bindGold.position, layout.bindGold.size);
    dialog.addChild(this.bindGoldLabel);
    this.upgradeButton = GameUiHelper.createMiddleButton("soul_upgrade_button", layout.upgradeButton.text, layout.upgradeButton.position);
    this.upgradeButton.on(
      Node.EventType.TOUCH_END,
      () => {
        // 升级成功后整体刷新（失败时 StorageManager 已弹出原因提示）；外显已勾选时同步换掉主角身上的战魂动画
        if (StorageManager.upgradeSoul()) {
          RoleUIManager.updateSoulShow();
          this.refresh();
        }
      },
      this,
    );
    dialog.addChild(this.upgradeButton);
    LayerManager.addToUILayer(dialog);
    this.refresh();
  }

  /** 整体刷新（选中等级切换、升级成功后调用）：列表状态 / 动画 / 信息 / 属性 / 按钮全部重建 */
  private refresh() {
    const role = StorageManager.findOnlineRole();
    const config = getSoulLevel(this.selectedLevel);
    if (!role || !config || !this.listContent || !this.animationSlot || !this.infoSlot || !this.attributeSlot) return;
    // 左列表：按等级从上到下（soulLevels 本身升序），点击切换预览
    clearChildren(this.listContent);
    soulLevels.forEach((item) =>
      this.listContent.addChild(
        GameUiHelper.createSoulCard(
          item,
          role.soulOfWar,
          item.level === this.selectedLevel,
          () => {
            if (this.selectedLevel === item.level) return;
            this.selectedLevel = item.level;
            this.refresh();
          },
        ),
      ),
    );
    // 中间动画：先销毁旧的再重建（不同等级图集不同）
    if (this.animationNode && isValid(this.animationNode)) this.animationNode.destroy();
    this.animationNode = GameUiHelper.createSoulAnimation(config);
    this.animationSlot.addChild(this.animationNode);
    // 中间信息：名称 / 描述 / 当前战魂（位置、尺寸、字号与配色见 layout.info）
    clearChildren(this.infoSlot);
    const info = layout.info;
    this.infoSlot.addChild(UiHelper.createLabel("soul_name", config.label, info.name.color, info.name.fontSize, info.name.position, info.name.size));
    this.infoSlot.addChild(UiHelper.createLabel("soul_desc", config.description, info.description.color, info.description.fontSize, info.description.position, info.description.size));
    const current = getSoulLevel(role.soulOfWar);
    this.infoSlot.addChild(
      UiHelper.createLabel("soul_current", current ? `当前战魂：${role.soulOfWar} 阶 · ${current.label}` : "尚未激活战魂", info.current.color, info.current.fontSize, info.current.position, info.current.size),
    );
    // 外显勾选框：勾选后把当前等级的战魂动画挂到主角右上角（状态持久在角色数据 role.soulShow）
    // 勾选后立刻刷新主角身上的战魂动画（RoleUIManager → RoleDisplay，后者用前重读角色数据，见 RoleDisplay.updateSoulShow）
    const showToggle = GameUiHelper.createSoulShowToggle(role.soulShow, () => {
      role.soulShow = !role.soulShow;
      StorageManager.updateOnlineRole(role);
      RoleUIManager.updateSoulShow();
      this.refresh();
    });
    showToggle.setPosition(info.toggle.position.x, info.toggle.position.y);
    this.infoSlot.addChild(showToggle);
    // 右侧属性：所选等级属性 + 下一级增量
    clearChildren(this.attributeSlot);
    this.attributeSlot.addChild(GameUiHelper.createSoulAttributeList(config, getSoulLevel(this.selectedLevel + 1)));
    // 升级按钮与绑定元宝（按钮始终针对当前战魂等级的下一级）
    if (this.upgradeButton) {
      const sprite = this.upgradeButton.getComponent(Sprite);
      const label = this.upgradeButton.getChildByName("soul_upgrade_button_label")?.getComponent(Label);
      const maxed = role.soulOfWar >= soulMaxLevel;
      const next = getSoulLevel(role.soulOfWar + 1);
      if (label) label.string = maxed ? layout.upgradeButton.maxedText : layout.upgradeButton.text;
      if (sprite) sprite.grayscale = maxed;
      if (label && !maxed && next) {
        // 按钮下方提示下一级消耗（绑定元宝不足时点击会被 StorageManager 拦下并提示）
        label.string = layout.upgradeButton.text;
      }
    }
    if (this.bindGoldLabel) this.bindGoldLabel.getComponent(Label).string = `绑定元宝：${role.bindGold}`;
  }
}
