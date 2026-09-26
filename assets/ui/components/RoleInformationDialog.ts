import { instantiate, Node, Size, Vec2 } from "cc";
import GameRoleUiHelper from "../helpers/GameRoleUiHelper";
import LayerHelper from "../helpers/LayerHelper";
import { equipmentSlots } from "../../configs";
import UiHelper from "../helpers/UiHelper";

interface RoleInformationDialog {
  dialog: Node | null;
  // 装备槽-左侧
  leftSlots: Node[];
  // 装备槽-右侧
  rightSlots: Node[];
  // 装备槽-底部
  bottomSlots: Node[];
  open: () => void;
  close: () => void;
}

const RoleInformationDialog: RoleInformationDialog = {
  // 节点
  dialog: null,
  // 装备槽-左侧
  leftSlots: [],
  // 装备槽-右侧
  rightSlots: [],
  // 装备槽-底部
  bottomSlots: [],
  // 打开
  open() {
    if (RoleInformationDialog.dialog && RoleInformationDialog.dialog.active) RoleInformationDialog.close();
    else {
      RoleInformationDialog.dialog = GameRoleUiHelper.createDialog("personal_information_dialog", "角色信息");
      LayerHelper.addToUILayer(RoleInformationDialog.dialog);
      // 添加装饰
      const bg = UiHelper.createSprite("common/personal-information-bg", new Vec2(-78, -19), new Size(431, 452));
      LayerHelper.setLayerToUILayer(bg);
      RoleInformationDialog.dialog.addChild(bg);
      // 战斗力
      const combatIcon = UiHelper.createSprite("common/combat", new Vec2(-7, -225), new Size(100, 50));
      LayerHelper.setLayerToUILayer(combatIcon);
      bg.addChild(combatIcon);
      // 左侧插槽列表
      const leftSlots = UiHelper.createFlexCol(10, new Vec2(-240, 40), new Size(50, 290));
      LayerHelper.setLayerToUILayer(leftSlots);
      // 右侧插槽列表
      const rightSlots = UiHelper.createFlexCol(10, new Vec2(80, 40), new Size(50, 290));
      LayerHelper.setLayerToUILayer(rightSlots);
      // 底部插槽列表
      const bottomSlots = UiHelper.createFlexRow(10, new Vec2(-75, -140), new Size(170, 50));
      LayerHelper.setLayerToUILayer(bottomSlots);
      // 添加显示插槽
      equipmentSlots.forEach((value, key) => {
        const slot = UiHelper.createSprite(value.imageSrc, new Vec2(), new Size(50, 50));
        slot.name = key;
        LayerHelper.setLayerToUILayer(slot);
        if (value.position === "left") {
          RoleInformationDialog.leftSlots.push(slot);
          leftSlots.addChild(slot);
        }
        if (value.position === "right") {
          RoleInformationDialog.rightSlots.push(slot);
          rightSlots.addChild(slot);
        }
        if (value.position === "bottom") {
          RoleInformationDialog.bottomSlots.push(slot);
          bottomSlots.addChild(slot);
        }
      });
      RoleInformationDialog.dialog.addChild(leftSlots);
      RoleInformationDialog.dialog.addChild(rightSlots);
      RoleInformationDialog.dialog.addChild(bottomSlots);
    }
  },
  // 关闭
  close() {
    RoleInformationDialog.bottomSlots.length = 0;
    RoleInformationDialog.leftSlots.length = 0;
    RoleInformationDialog.rightSlots.length = 0;
    RoleInformationDialog.dialog.destroy();
    RoleInformationDialog.dialog = null;
  },
};

export default RoleInformationDialog;
