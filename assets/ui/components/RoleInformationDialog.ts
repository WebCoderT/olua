import { instantiate, isValid, Node, Size, Vec2 } from "cc";
import GameRoleUiHelper from "../helpers/GameRoleUiHelper";
import LayerHelper from "../helpers/LayerHelper";
import UiHelper from "../helpers/UiHelper";
import { equipmentSlots } from "../../configs/equipments";
import StorageHelper from "../utils/StorageHelper";
import GameUiHelper from "../helpers/GameUiHelper";
import { EQUIPMENT_TYPE } from "../../types/common";
import { Role } from "../../configs/role";

interface RoleInformationDialog {
  dialog: Node | null;
  // 装备槽
  slots: Node[];
  // 衣服内观
  clothInShow: Node | null;
  // 添加衣服内观
  createClothInShow: (role: Role) => void;
  // 武器内观
  weaponInShow: Node | null;
  // 添加武器内观
  createWeaponInShow: (role: Role) => void;
  // 更新节点显示
  updateDialog: (equipmentType: EQUIPMENT_TYPE) => void;
  open: () => void;
  close: () => void;
}

const RoleInformationDialog: RoleInformationDialog = {
  // 节点
  dialog: null,
  // 装备槽
  slots: [],
  // 打开
  open() {
    if (RoleInformationDialog.dialog && isValid(RoleInformationDialog.dialog) && RoleInformationDialog.dialog.active) {
      RoleInformationDialog.close();
      return;
    }
    if (RoleInformationDialog.dialog && !isValid(RoleInformationDialog.dialog)) {
      RoleInformationDialog.dialog = null;
      RoleInformationDialog.clothInShow = null;
      RoleInformationDialog.weaponInShow = null;
    }
    RoleInformationDialog.slots.length = 0;
    {
      // 角色信息
      const role = StorageHelper.findOnlineRole();
      RoleInformationDialog.dialog = GameRoleUiHelper.createDialog("personal_information_dialog", "角色信息");
      LayerHelper.addToUILayer(RoleInformationDialog.dialog);
      // 添加装饰
      const bg = UiHelper.createSprite("role_information_background", "common/personal-information-bg", new Vec2(-78, -19), new Size(431, 452));
      LayerHelper.setLayerToUILayer(bg);
      RoleInformationDialog.dialog.addChild(bg);
      // 战斗力
      const combatIcon = UiHelper.createSprite("combat_icon", "common/combat", new Vec2(-7, -225), new Size(100, 50));
      LayerHelper.setLayerToUILayer(combatIcon);
      bg.addChild(combatIcon);
      // 左侧插槽列表
      const leftSlots = UiHelper.createFlexCol("equipment_slots_left", 10, new Vec2(-240, 40), new Size(50, 290));
      LayerHelper.setLayerToUILayer(leftSlots);
      // 右侧插槽列表
      const rightSlots = UiHelper.createFlexCol("equipment_slots_right", 10, new Vec2(80, 40), new Size(50, 290));
      LayerHelper.setLayerToUILayer(rightSlots);
      // 底部插槽列表
      const bottomSlots = UiHelper.createFlexRow("equipment_slots_bottom", 10, new Vec2(-75, -140), new Size(170, 50));
      LayerHelper.setLayerToUILayer(bottomSlots);
      // 添加显示插槽
      equipmentSlots.forEach((value, key) => {
        const slot = UiHelper.createSprite(`equipment_slot_${key}`, value.imageSrc, new Vec2(), new Size(50, 50));
        slot.name = key;
        if (role.equipments[key]) {
          GameUiHelper.createGood(slot, role.equipments[key]);
        }
        LayerHelper.setLayerToUILayer(slot);
        if (value.position === "left") {
          RoleInformationDialog.slots.push(slot);
          leftSlots.addChild(slot);
        }
        if (value.position === "right") {
          RoleInformationDialog.slots.push(slot);
          rightSlots.addChild(slot);
        }
        if (value.position === "bottom") {
          RoleInformationDialog.slots.push(slot);
          bottomSlots.addChild(slot);
        }
      });
      RoleInformationDialog.dialog.addChild(leftSlots);
      RoleInformationDialog.dialog.addChild(rightSlots);
      RoleInformationDialog.dialog.addChild(bottomSlots);
      role.equipments.cloth && RoleInformationDialog.createClothInShow(role);
      role.equipments.weapon && RoleInformationDialog.createWeaponInShow(role);
    }
  },

  // 衣服内观
  clothInShow: null,
  // 添加衣服内观
  createClothInShow(role: Role) {
    if (RoleInformationDialog.clothInShow && isValid(RoleInformationDialog.clothInShow)) {
      RoleInformationDialog.clothInShow.destroy();
    }
    RoleInformationDialog.clothInShow = null;
    RoleInformationDialog.clothInShow = GameUiHelper.createRoleClothInShow(role, new Vec2(-73, -10), new Size(400, 400));
    RoleInformationDialog.dialog.addChild(RoleInformationDialog.clothInShow);
  },

  // 武器内观
  weaponInShow: null,
  // 添加衣服内观
  createWeaponInShow(role: Role) {
    if (RoleInformationDialog.weaponInShow && isValid(RoleInformationDialog.weaponInShow)) {
      RoleInformationDialog.weaponInShow.destroy();
    }
    RoleInformationDialog.weaponInShow = null;
    RoleInformationDialog.weaponInShow = GameUiHelper.createRoleWeaponInshow(role, new Vec2(-169, 95), new Size(400, 400));
    RoleInformationDialog.dialog.addChild(RoleInformationDialog.weaponInShow);
  },

  // 更新节点显示
  updateDialog(equipmentType) {
    if (!RoleInformationDialog.dialog || !RoleInformationDialog.dialog.active) return;
    const role = StorageHelper.findOnlineRole();
    RoleInformationDialog.slots.find((node) => {
      if (node.name === equipmentType) {
        node.removeAllChildren();
        if (role.equipments[equipmentType]) GameUiHelper.createGood(node, role.equipments[equipmentType]);
      }
    });
    switch (equipmentType) {
      case EQUIPMENT_TYPE.CLOTH:
        RoleInformationDialog.createClothInShow(role);
        break;
      case EQUIPMENT_TYPE.WEAPON:
        RoleInformationDialog.createWeaponInShow(role);
        break;
    }
  },

  // 关闭
  close() {
    RoleInformationDialog.slots.length = 0;
    if (RoleInformationDialog.dialog && isValid(RoleInformationDialog.dialog)) RoleInformationDialog.dialog.destroy();
    RoleInformationDialog.dialog = null;
    RoleInformationDialog.clothInShow = null;
    RoleInformationDialog.weaponInShow = null;
  },
};

export default RoleInformationDialog;
