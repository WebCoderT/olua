import { Color, isValid, Layout, Node, Size, UITransform, Vec2 } from "cc";
import LayerManager from "../../core/LayerManager";
import UiHelper from "../../helpers/UiHelper";
import { equipmentSlots } from "../../../configs/equipments";
import StorageManager from "../../core/StorageManager";
import GameUiHelper from "../../helpers/GameUiHelper";
import { EQUIPMENT_TYPE } from "../../../types/common";
import { Role } from "../../../configs/role";
import { goodShowAttributesLabel } from "../../../configs/good";

/**
 * 角色信息弹窗
 * 实例由使用方（BottomBar）创建持有，不导出全局单例
 */
export default class RoleInformationDialog {
  /** 弹窗节点 */
  private dialog: Node | null = null;
  /** 装备槽节点列表 */
  private slots: Node[] = [];
  /** 衣服内观节点 */
  private clothInShow: Node | null = null;
  /** 武器内观节点 */
  private weaponInShow: Node | null = null;
  /** 角色属性显示节点列表 */
  private roleAttributes: Node[] = [];

  /** 打开/关闭弹窗 */
  open() {
    if (this.dialog && isValid(this.dialog) && this.dialog.active) {
      this.close();
      return;
    }
    if (this.dialog && !isValid(this.dialog)) {
      this.dialog = null;
      this.clothInShow = null;
      this.weaponInShow = null;
    }
    this.slots.length = 0;
    // 角色信息
    const role = StorageManager.findOnlineRole();
    this.dialog = GameUiHelper.createDialog("personal_information_dialog", "角色信息");
    // 添加装饰
    const bg = UiHelper.createSprite("role_information_background", "common/personal-information-bg", new Vec2(-78, -19), new Size(431, 452));
    this.dialog.addChild(bg);
    // 战斗力
    const combatIcon = UiHelper.createSprite("combat_icon", "common/combat", new Vec2(-7, -225), new Size(100, 50));
    bg.addChild(combatIcon);
    // 左侧插槽列表
    const leftSlots = UiHelper.createFlexCol("equipment_slots_left", 10, new Vec2(-240, 40), new Size(50, 290));
    // 右侧插槽列表
    const rightSlots = UiHelper.createFlexCol("equipment_slots_right", 10, new Vec2(80, 40), new Size(50, 290));
    // 底部插槽列表
    const bottomSlots = UiHelper.createFlexRow("equipment_slots_bottom", 10, new Vec2(-75, -140), new Size(170, 50));
    // 添加显示插槽
    equipmentSlots.forEach((value, key) => {
      const slot = UiHelper.createSprite(`equipment_slot_${key}`, value.imageSrc, new Vec2(), new Size(50, 50));
      slot.name = key;
      if (role.equipments[key]) {
        GameUiHelper.createGood(slot, role.equipments[key]);
      }
      if (value.position === "left") {
        this.slots.push(slot);
        leftSlots.addChild(slot);
      }
      if (value.position === "right") {
        this.slots.push(slot);
        rightSlots.addChild(slot);
      }
      if (value.position === "bottom") {
        this.slots.push(slot);
        bottomSlots.addChild(slot);
      }
    });
    this.dialog.addChild(leftSlots);
    this.dialog.addChild(rightSlots);
    this.dialog.addChild(bottomSlots);
    role.equipments.cloth && this.createClothInShow(role);
    role.equipments.weapon && this.createWeaponInShow(role);
    this.createRoleAttributeUi(role, this.dialog);
    LayerManager.addToUILayer(this.dialog);
  }

  /** 角色属性显示UI */
  private createRoleAttributeUi(role: Role, parent: Node) {
    // 基础布局
    const layout = UiHelper.createFlexCol("role_attributes", 5, new Vec2(217, 205), new Size(150, 0));
    const layoutComponent = layout.getComponent(Layout);
    layoutComponent.resizeMode = Layout.ResizeMode.CONTAINER;
    layoutComponent.padding = 10;
    const uitransform = layout.getComponent(UITransform);
    uitransform.setAnchorPoint(0.5, 1);

    // 基础属性
    const label = UiHelper.createLabel("role_basic_attributes", "基础属性", Color.WHITE, 14, new Vec2(), new Size(150, 14));
    layout.addChild(label);

    for (const element of goodShowAttributesLabel.keys()) {
      const node = GameUiHelper.createAttributeLabel(element, role[element].toString(), new Size(150, 20));
      this.roleAttributes.push(node);
      layout.addChild(node);
    }

    // 特殊属性
    const specialLabel = UiHelper.createLabel("role_special_attributes", "特殊属性", Color.WHITE, 14, new Vec2(), new Size(150, 14));
    layout.addChild(specialLabel);

    parent.addChild(layout);
  }

  /** 添加衣服内观 */
  private createClothInShow(role: Role) {
    if (this.clothInShow && isValid(this.clothInShow)) {
      this.clothInShow.destroy();
    }
    this.clothInShow = GameUiHelper.createRoleClothInShow(role, new Vec2(-73, -10), new Size(400, 400));
    this.dialog.addChild(this.clothInShow);
  }

  /** 添加武器内观 */
  private createWeaponInShow(role: Role) {
    if (this.weaponInShow && isValid(this.weaponInShow)) {
      this.weaponInShow.destroy();
    }
    this.weaponInShow = GameUiHelper.createRoleWeaponInshow(role, new Vec2(-169, 95), new Size(400, 400));
    this.dialog.addChild(this.weaponInShow);
  }

  /** 更新节点显示 */
  updateDialog(equipmentType: EQUIPMENT_TYPE) {
    if (!this.dialog || !this.dialog.active) return;
    const role = StorageManager.findOnlineRole();
    this.slots.find((node) => {
      if (node.name === equipmentType) {
        node.removeAllChildren();
        if (role.equipments[equipmentType]) GameUiHelper.createGood(node, role.equipments[equipmentType]);
      }
    });
    switch (equipmentType) {
      case EQUIPMENT_TYPE.CLOTH:
        this.createClothInShow(role);
        break;
      case EQUIPMENT_TYPE.WEAPON:
        this.createWeaponInShow(role);
        break;
    }
  }

  /** 关闭弹窗 */
  close() {
    this.slots.length = 0;
    this.roleAttributes.length = 0;
    if (this.dialog && isValid(this.dialog)) this.dialog.destroy();
    this.dialog = null;
    this.clothInShow = null;
    this.weaponInShow = null;
  }
}
