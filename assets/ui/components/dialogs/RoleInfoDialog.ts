import { isValid, Node, Size, Vec2 } from "cc";
import LayerManager from "../../core/LayerManager";
import StorageManager from "../../core/StorageManager";
import GameUiHelper from "../../helpers/GameUiHelper";
import { EQUIPMENT_TYPE } from "../../../types/good";
import EquipmentSlotGroup, { EQUIPMENT_SLOT_SIDES } from "../panel/EquipmentSlotGroup";
import RoleAttributeList from "../panel/RoleAttributeList";
import RoleInShowView from "../panel/RoleInShowView";

/** 弹窗名称 */
const DIALOG_NAME = "role_info_dialog";

/**
 * 角色信息弹窗
 * 只负责开关与组装：弹窗框 + 装饰背景（含战斗力图标）+ 装备槽分组（EquipmentSlotGroup）
 * + 属性列表（RoleAttributeList）+ 内观（RoleInShowView）
 * 换装后由数据层经 RoleUIManager 调用 updateDialog 刷新对应区块
 */
export default class RoleInfoDialog {
  /** 弹窗节点 */
  private dialog: Node | null = null;
  /** 装备槽分组（左/右/底） */
  private equipmentGroups: EquipmentSlotGroup[] = [];
  /** 内观（衣服 + 武器） */
  private inShowView: RoleInShowView | null = null;

  /** 打开/关闭弹窗 */
  open() {
    if (this.dialog && isValid(this.dialog) && this.dialog.active) {
      this.close();
      return;
    }
    // 弹窗已在场景切换中被销毁时清理残留引用
    if (this.dialog && !isValid(this.dialog)) this.reset();
    // 角色信息
    const role = StorageManager.findOnlineRole();
    // 弹窗框
    this.dialog = GameUiHelper.createDialog(DIALOG_NAME, "角色信息");
    // 装饰背景与战斗力图标
    const bg = GameUiHelper.createImage("role_information_background", "common/personal-information-bg", new Vec2(-78, -19), new Size(431, 452));
    bg.addChild(GameUiHelper.createImage("combat_icon", "common/combat", new Vec2(-7, -225), new Size(100, 50)));
    this.dialog.addChild(bg);
    // 装备槽分组（左/右/底三个方向）
    this.equipmentGroups = EQUIPMENT_SLOT_SIDES.map((side) => new EquipmentSlotGroup(side, role.equipments));
    this.equipmentGroups.forEach((group) => this.dialog.addChild(group));
    // 角色属性列表
    this.dialog.addChild(new RoleAttributeList(role));
    // 内观（衣服与武器，未装备时容器为空）
    this.inShowView = new RoleInShowView(role);
    this.dialog.addChild(this.inShowView);
    LayerManager.addToUILayer(this.dialog);
  }

  /** 装备变更后刷新：对应槽位的装备显示与对应部位的内观 */
  updateDialog(equipmentType: EQUIPMENT_TYPE) {
    if (!this.dialog || !this.dialog.active) return;
    const role = StorageManager.findOnlineRole();
    // 槽位显示（不在本分组内的槽位会被忽略）
    this.equipmentGroups.forEach((group) => group.updateSlot(equipmentType, role.equipments[equipmentType]));
    // 内观（衣服/武器）
    if (equipmentType === EQUIPMENT_TYPE.CLOTH) this.inShowView?.updateCloth(role);
    if (equipmentType === EQUIPMENT_TYPE.WEAPON) this.inShowView?.updateWeapon(role);
  }

  /** 关闭弹窗 */
  close() {
    if (this.dialog && isValid(this.dialog)) this.dialog.destroy();
    this.reset();
  }

  /** 释放弹窗与子组件引用 */
  private reset() {
    this.dialog = null;
    this.equipmentGroups = [];
    this.inShowView = null;
  }
}
