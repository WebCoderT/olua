import { isValid, Node, Vec2 } from "cc";
import LayerManager from "../../core/LayerManager";
import StorageManager from "../../core/StorageManager";
import GameUiHelper from "../../helpers/GameUiHelper";
import { EQUIPMENT_TYPE } from "../../../types/good";
import { getEquipment } from "../../../configs/items";
import EquipmentSlotGroup, { EQUIPMENT_SLOT_SIDES } from "../panel/EquipmentSlotGroup";
import RoleAttributeList from "../panel/RoleAttributeList";
import RoleInShowView from "../panel/RoleInShowView";
import { roleInfoDialogLayout } from "../../../configs/hudLayout";
import TitleUpgradeDialog from "./TitleUpgradeDialog";
import WarSoulDialog from "./WarSoulDialog";
import RankUpgradeDialog from "./RankUpgradeDialog";

/**
 * 角色信息弹窗
 * 只负责开关与组装：弹窗框 + 装饰背景（含战斗力图标）+ 装备槽分组（EquipmentSlotGroup）
 * + 属性列表（RoleAttributeList）+ 内观（RoleInShowView）+ 称号/战魂两个入口按钮
 * 槽位右键 = 脱下装备：转交数据层处理（脱下后装备进背包、属性重算与四处刷新由数据层统一收尾）
 * 换装后由数据层经 RoleUIManager 调用 updateDialog 刷新对应区块
 */
export default class RoleInfoDialog {
  /** 弹窗节点 */
  private dialog: Node | null = null;
  /** 装备槽分组（左/右/底） */
  private equipmentGroups: EquipmentSlotGroup[] = [];
  /** 属性列表（装备变化后刷新数值） */
  private attributeList: RoleAttributeList | null = null;
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
    // 弹窗框（尺寸与装饰背景见 configs/hudLayout.roleInfoDialogLayout）
    this.dialog = GameUiHelper.createDialog(roleInfoDialogLayout.name, roleInfoDialogLayout.title);
    // 装饰背景与战斗力图标
    const bgLayout = roleInfoDialogLayout.background;
    const bg = GameUiHelper.createImage("role_information_background", bgLayout.image, bgLayout.position, bgLayout.size);
    const combatLayout = roleInfoDialogLayout.combatIcon;
    bg.addChild(GameUiHelper.createImage("combat_icon", combatLayout.image, combatLayout.position, combatLayout.size));
    this.dialog.addChild(bg);
    // 装备槽分组（左/右/底三个方向），右键槽位脱下装备
    this.equipmentGroups = EQUIPMENT_SLOT_SIDES.map((side) => new EquipmentSlotGroup(side, role.equipments, (type) => StorageManager.unequipToBag(type)));
    this.equipmentGroups.forEach((group) => this.dialog.addChild(group));
    // 角色属性列表
    this.attributeList = new RoleAttributeList(role);
    this.dialog.addChild(this.attributeList);
    // 内观（衣服与武器，未装备时容器为空）
    this.inShowView = new RoleInShowView(role);
    this.dialog.addChild(this.inShowView);
    // 「军衔」「称号」「战魂」入口按钮（右侧竖排相邻三格，几何见 roleInfoDialogLayout）
    // 三者都不走 NPC：入口固定在这里，点击打开各自弹窗，角色信息弹窗保持打开
    const entryButtons: { layout: { name: string; text: string; position: Vec2 }; open: () => void }[] = [
      { layout: roleInfoDialogLayout.rankButton, open: () => new RankUpgradeDialog().open() },
      { layout: roleInfoDialogLayout.titleButton, open: () => new TitleUpgradeDialog().open() },
      { layout: roleInfoDialogLayout.soulButton, open: () => new WarSoulDialog().open() },
    ];
    entryButtons.forEach(({ layout, open }) => {
      const button = GameUiHelper.createMiddleButton(layout.name, layout.text, layout.position);
      button.on(Node.EventType.TOUCH_END, open, this);
      this.dialog!.addChild(button);
    });
    LayerManager.addDialogToUILayer(this.dialog);
  }

  /** 装备变更后刷新：对应槽位的装备显示、属性数值与对应部位的内观 */
  updateDialog(equipmentType: EQUIPMENT_TYPE) {
    if (!this.dialog || !this.dialog.active) return;
    const role = StorageManager.findOnlineRole();
    // 槽位显示（不在本分组内的槽位会被忽略；槽位只存装备 id，显示前实时解析）
    this.equipmentGroups.forEach((group) => group.updateSlot(equipmentType, getEquipment(role.equipments[equipmentType])));
    // 属性与战斗力随装备变化
    this.attributeList?.update(role);
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
    this.attributeList = null;
    this.inShowView = null;
  }
}
