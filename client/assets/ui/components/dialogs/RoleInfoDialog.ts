import { isValid, Node, Vec2 } from "cc";
import StorageManager from "../../core/StorageManager";
import GameUiHelper from "../../helpers/GameUiHelper";
import { EQUIPMENT_TYPE } from "../../../types/good";
import { getEquipment, wornIdOf } from "../../../configs/items";
import EquipmentSlotGroup, { EQUIPMENT_SLOT_SIDES } from "../panel/EquipmentSlotGroup";
import RoleAttributeList from "../panel/RoleAttributeList";
import RoleInShowView from "../panel/RoleInShowView";
import { refreshInAlign } from "../../utils/net/ConfigLoader";
import { buttonTone, roleInfoDialogLayout } from "../../../configs/hudLayout";
import { getText } from "../../../configs/texts";
import TitleUpgradeDialog from "./TitleUpgradeDialog";
import WarSoulDialog from "./WarSoulDialog";
import RankUpgradeDialog from "./RankUpgradeDialog";
import FashionDialog from "./FashionDialog";
import BaseDialog from "./dialog-kit";
import CheckRow from "../panel/CheckRow";
import SocialDialog from "./SocialDialog";
import AttrAllocateDialog from "./AttrAllocateDialog";
import * as AutoBagPrefs from "../../core/storage/auto-bag-prefs";

/**
 * 角色信息弹窗
 * 只负责开关与组装：弹窗框 + 装饰背景（含战斗力图标）+ 装备槽分组（EquipmentSlotGroup）
 * + 属性列表（RoleAttributeList）+ 内观（RoleInShowView）+ 军衔/称号/战魂/时装/社交五个入口按钮
 * 槽位右键 = 脱下装备：转交数据层处理（脱下后装备进背包、属性重算与四处刷新由数据层统一收尾）
 * 槽位角标左键 = 一键换上背包里更好的装备（哪个槽位亮角标由 refreshHints 按背包现算）
 * 换装后由数据层经 RoleUIManager 调用 updateDialog 刷新对应区块；背包变动经 refreshBag 调用 refreshHints
 */
export default class RoleInfoDialog extends BaseDialog {
  /** 装备槽分组（左/右/底） */
  private equipmentGroups: EquipmentSlotGroup[] = [];
  /** 属性列表（装备变化后刷新数值） */
  private attributeList: RoleAttributeList | null = null;
  /** 内观（衣服 + 武器） */
  private inShowView: RoleInShowView | null = null;
  /** 属性加点弹窗（#833；持有实例，「再点一次属性按钮 = 关闭」靠它） */
  private attrDialog = new AttrAllocateDialog();

  /** 打开/关闭弹窗 */
  open() {
    this.openFrame(
      // 页脚文案走 texts（role_info_foot_left/right），不在 layout.footTexts
      {
        name: roleInfoDialogLayout.name,
        title: roleInfoDialogLayout.title,
        eyebrow: roleInfoDialogLayout.eyebrow,
        size: roleInfoDialogLayout.size,
        foot: roleInfoDialogLayout.foot,
        footTexts: { left: getText("role_info_foot_left"), right: getText("role_info_foot_right") },
      },
      (dialog) => {
    // 角色信息
    const role = StorageManager.findOnlineRole();
    // 内观（衣服与武器，未装备时容器为空）—— 最先挂：装备槽、属性、入口等兄弟后建，
    // 自然画在立绘之上，底部三格不被特效压住（#1089 的层级修复保留）。
    // RoleInShowView 是原点包装节点，直接以弹窗中心为原点原样全显；
    // #1231 拍板去掉全部遮罩层（Mask / 玻璃板框）与背景板，只显示衣服与武器内观
    this.inShowView = new RoleInShowView(role);
    this.inShowView.setPosition(-40, 53, 0);
    dialog.addChild(this.inShowView);
    // 装备槽分组（左/右/底三个方向），右键槽位脱下装备、左键角标一键换更好的
    this.equipmentGroups = EQUIPMENT_SLOT_SIDES.map((side) =>
      new EquipmentSlotGroup(
        side,
        role.equipments,
        (type) => {
          void StorageManager.unequipToBag(type);
        },
        (type) => {
          void StorageManager.equipBetterFromBag(type);
        },
      ),
    );
    this.equipmentGroups.forEach((group) => dialog.addChild(group));
    // 各槽位的「更好装备」提示按当前背包点亮
    this.refreshHints();
    // 「自动穿戴」开关（#1278）：衣服槽正下方 —— 勾上后自动换上背包里更好的装备
    // （判定复用一键换装 findBetterEquipmentInBag；触发在 RoleUIManager.refreshBag 汇聚点）
    const autoWearRow = new CheckRow(
      roleInfoDialogLayout.autoWearRow.name,
      getText("label_auto_wear"),
      AutoBagPrefs.getAutoWear(role.id),
      {
        width: roleInfoDialogLayout.autoWearRow.width,
        height: roleInfoDialogLayout.autoWearRow.height,
        fontSize: roleInfoDialogLayout.autoWearRow.fontSize,
        color: roleInfoDialogLayout.autoWearRow.hintColor,
      },
      (checked) => AutoBagPrefs.setAutoWear(role.id, checked),
    );
    autoWearRow.setPosition(roleInfoDialogLayout.autoWearRow.position.x, roleInfoDialogLayout.autoWearRow.position.y, 0);
    dialog.addChild(autoWearRow);
    // 角色属性列表
    this.attributeList = new RoleAttributeList(role);
    dialog.addChild(this.attributeList);
    // 内观几何「开弹窗就再拉一次」（#527）：玩家保存完的第一反应是再点开这个弹窗看一眼，
    // 那时人还在同一张图里、场景没重载 —— 只靠进图拉一次必然「看不到变化」。
    // 先把弹窗按当前配置建出来（不卡交互），拉到新值后再就地重建内观节点。
    void refreshInAlign().then(() => {
      if (!isValid(this.dialog) || !this.dialog?.active) return;
      const latest = StorageManager.findOnlineRole();
      if (!latest) return;
      this.inShowView?.updateCloth(latest);
      this.inShowView?.updateWeapon(latest);
    });
    // 「军衔」「称号」「战魂」「时装」「社交」「属性」入口按钮（右侧竖排相邻六格，几何见 roleInfoDialogLayout）
    // 都不走 NPC：入口固定在这里，点击打开各自弹窗，角色信息弹窗保持打开。
    // 属性加点（#833）用**持有的实例**而不是每次 new：它自己维护「再点一次是关闭」的开关语义
    // 与四行的重建引用，每次新建会让连点叠出两层弹窗
    const entryButtons: { layout: { name: string; text: string; position: Vec2 }; open: () => void }[] = [
      { layout: roleInfoDialogLayout.attrButton, open: () => this.attrDialog.open() },
      { layout: roleInfoDialogLayout.socialButton, open: () => new SocialDialog().open() },
      { layout: roleInfoDialogLayout.fashionButton, open: () => new FashionDialog().open() },
      { layout: roleInfoDialogLayout.rankButton, open: () => new RankUpgradeDialog().open() },
      { layout: roleInfoDialogLayout.titleButton, open: () => new TitleUpgradeDialog().open() },
      { layout: roleInfoDialogLayout.soulButton, open: () => new WarSoulDialog().open() },
    ];
    entryButtons.forEach(({ layout, open }) => {
      // 稿的入口是窄的 ghost 键（84×32），不是中号金属键 —— 一列六枚排下来要够紧凑
      const button = GameUiHelper.createToneButton(
        layout.name,
        layout.text,
        layout.position,
        roleInfoDialogLayout.entryButton.size,
        roleInfoDialogLayout.entryButton.fontSize,
        buttonTone.ghost,
      );
      button.on(Node.EventType.TOUCH_END, open, this);
      dialog.addChild(button);
    });
      },
    );
  }

  /** 装备变更后刷新：对应槽位的装备显示、属性数值与对应部位的内观 */
  updateDialog(equipmentType: EQUIPMENT_TYPE) {
    if (!this.dialog || !this.dialog.active) return;
    const role = StorageManager.findOnlineRole();
    // 槽位显示（不在本分组内的槽位会被忽略；槽位存 { id, bound?, from? }（#816），显示前取 id 实时解析）
    this.equipmentGroups.forEach((group) => group.updateSlot(equipmentType, getEquipment(wornIdOf(role.equipments[equipmentType]))));
    // 属性与战斗力随装备变化
    this.attributeList?.update(role);
    // 内观（衣服/武器）
    if (equipmentType === EQUIPMENT_TYPE.CLOTH) this.inShowView?.updateCloth(role);
    if (equipmentType === EQUIPMENT_TYPE.WEAPON) this.inShowView?.updateWeapon(role);
    // 换装会改变背包内容（旧装备回包），所有槽位的提示一起重算
    this.refreshHints();
  }

  /**
   * 属性列表单独刷新（#541：roleUpdate 权威快照到达时调）
   *
   * 与 updateDialog 的差别：不碰装备槽与内观 —— 服务端推的是数值（属性/战斗力/货币），
   * 槽位显示只随装备变化，内观更与数值无关。升级导致的属性变化此前漏刷（只刷了
   * 顶栏与血条，面板开着时数字停在旧值），从这条出口补上。
   */
  updateAttributes() {
    if (!this.dialog || !this.dialog.active) return;
    const role = StorageManager.findOnlineRole();
    if (!role) return;
    this.attributeList?.update(role);
  }

  /**
   * 按当前背包重算所有槽位的「更好装备」提示（弹窗未打开时忽略）
   * 背包任何变动（拾取/丢弃/回收/整理/换装）都会经 RoleUIManager.refreshBag 走到这里
   */
  refreshHints() {
    if (!this.dialog || !this.dialog.active) return;
    const role = StorageManager.findOnlineRole();
    if (!role) return;
    (Object.keys(role.equipments) as EQUIPMENT_TYPE[]).forEach((type) => {
      const better = StorageManager.findBetterEquipmentInBag(type);
      this.equipmentGroups.forEach((group) => group.updateUpgradeHint(type, !!better));
    });
  }

  /** 关闭弹窗时连属性加点子弹窗一起收掉（销毁与清引用在 BaseDialog.close） */
  protected onClose() {
    this.attrDialog.close();
  }

  /** 释放子组件引用 */
  protected reset() {
    this.equipmentGroups = [];
    this.attributeList = null;
    this.inShowView = null;
  }
}
