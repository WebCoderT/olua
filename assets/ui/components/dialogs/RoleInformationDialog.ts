import { isValid, Layout, Node, Size, UITransform, Vec2 } from "cc";
import LayerManager from "../../core/LayerManager";
import StorageManager from "../../core/StorageManager";
import GameUiHelper from "../../helpers/GameUiHelper";
import { EQUIPMENT_TYPE } from "../../../types/good";
import { Role } from "../../../entities/Role";
import { equipmentSlots } from "../../../configs/equipments";
import { goodShowAttributesLabel } from "../../../configs/good";

/**
 * 角色信息弹窗
 * 弹窗由通用零件（弹窗框/装饰图/装备插槽/属性标签）拼装，本类负责开关、内观与装备刷新逻辑
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
    // 弹窗框
    this.dialog = GameUiHelper.createDialog("personal_information_dialog", "角色信息");
    // 装饰背景与战斗力图标
    const bg = GameUiHelper.createImage("role_information_background", "common/personal-information-bg", new Vec2(-78, -19), new Size(431, 452));
    bg.addChild(GameUiHelper.createImage("combat_icon", "common/combat", new Vec2(-7, -225), new Size(100, 50)));
    this.dialog.addChild(bg);
    // 装备插槽分组（左/右/底）
    const leftSlots = GameUiHelper.createColumn("equipment_slots_left", 10, new Vec2(-240, 40), new Size(50, 290));
    const rightSlots = GameUiHelper.createColumn("equipment_slots_right", 10, new Vec2(80, 40), new Size(50, 290));
    const bottomSlots = GameUiHelper.createRow("equipment_slots_bottom", 10, new Vec2(-75, -140), new Size(170, 50));
    equipmentSlots.forEach((value, key) => {
      const slot = GameUiHelper.createEquipmentSlot(key, value.imageSrc);
      if (role.equipments[key]) GameUiHelper.createGood(slot, role.equipments[key]);
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
    // 角色属性列表
    this.dialog.addChild(this.createRoleAttributes(role));
    // 内观
    role.equipments.cloth && this.createClothInShow(role);
    role.equipments.weapon && this.createWeaponInShow(role);
    LayerManager.addToUILayer(this.dialog);
  }

  /** 角色属性列表（基础属性 + 特殊属性标题） */
  private createRoleAttributes(role: Role) {
    const layout = GameUiHelper.createColumn("role_attributes", 5, new Vec2(217, 205), new Size(150, 0));
    const layoutComponent = layout.getComponent(Layout);
    layoutComponent.resizeMode = Layout.ResizeMode.CONTAINER;
    layoutComponent.padding = 10;
    layout.getComponent(UITransform).setAnchorPoint(0.5, 1);
    layout.addChild(GameUiHelper.createText("role_basic_attributes", "基础属性", 14, new Vec2(), new Size(150, 14)));
    for (const element of goodShowAttributesLabel.keys()) {
      layout.addChild(GameUiHelper.createAttributeLabel(element, role[element].toString(), new Size(150, 20)));
    }
    layout.addChild(GameUiHelper.createText("role_special_attributes", "特殊属性", 14, new Vec2(), new Size(150, 14)));
    return layout;
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
    if (this.dialog && isValid(this.dialog)) this.dialog.destroy();
    this.dialog = null;
    this.clothInShow = null;
    this.weaponInShow = null;
  }
}
