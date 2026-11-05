import { isValid, Node, ScrollView, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import HoverTipManager from "../../core/HoverTipManager";
import LayerManager from "../../core/LayerManager";
import StorageManager from "../../core/StorageManager";
import { oeccupationSkills } from "../../../configs/skill";
import SkillShortcutSettingDialog from "./SkillShortcutSettingDialog";
import { skillListDialogLayout } from "../../../configs/hudLayout";
import GuideStore from "../../core/GuideStore";
import { GUIDE_EVENT } from "../../../types/guide";

/**
 * 技能列表弹窗
 * 只负责开关与技能数据读取：技能行（未学习置灰、已学习可点击）由 GameUiHelper 零件生成，
 * 点击技能图标打开快捷键设置弹窗（SkillShortcutSettingDialog）；
 * 鼠标悬停技能图标弹出技能详情弹窗（HoverTipManager）
 *
 * 开关语义与背包 / 商城 / 任务一致（#738）：**再点一次底栏技能按钮是关闭**，不是再叠一个。
 * 为此必须持有弹窗节点 —— 关闭按钮销毁节点后引用会失效，下次 open 时按 isValid 清理。
 */
export default class SkillListDialog {
  /** 快捷键设置弹窗（子弹窗，由本弹窗持有） */
  private shortcutKeySettingDialog = new SkillShortcutSettingDialog();
  /** 弹窗节点（切换关闭要用；关闭后置空） */
  private dialog: Node | null = null;

  /** 打开/关闭技能列表弹窗（开关：已开则关） */
  open() {
    if (this.dialog && isValid(this.dialog) && this.dialog.active) {
      this.close();
      return;
    }
    // 弹窗已在场景切换 / 关闭按钮销毁时清掉残留引用
    if (this.dialog && !isValid(this.dialog)) this.dialog = null;
    // 引导（#402）：「认识技能」那一步就是「打开过技能列表」—— 事件在**真打开**之后发，
    // 上面的切换关闭不该算一次（玩家关窗不该被当成学会了）
    GuideStore.notify(GUIDE_EVENT.OPEN_SKILL);
    const role = StorageManager.findOnlineRole();
    const dialog = GameUiHelper.createDialog(skillListDialogLayout.name, skillListDialogLayout.title, new Vec2(), skillListDialogLayout.size);
    const skillList = GameUiHelper.createSkillListView();
    const content = skillList.getComponent(ScrollView).content;
    oeccupationSkills.get(role.occupation).forEach((skillId) => {
      const item = GameUiHelper.createSkillItem(role, skillId, () => this.shortcutKeySettingDialog.open(role, skillId));
      // 鼠标悬停技能图标弹出技能详情（图标是技能行的第一个子节点，节点名 = 技能 id）
      const icon = item.getChildByName(skillId);
      if (icon) {
        icon.on(Node.EventType.MOUSE_ENTER, () => HoverTipManager.showSkill(skillId, icon), this);
        icon.on(Node.EventType.MOUSE_LEAVE, () => HoverTipManager.hide(), this);
        icon.once(Node.EventType.NODE_DESTROYED, () => HoverTipManager.hide(), this);
      }
      content.addChild(item);
    });
    dialog.addChild(skillList);
    this.dialog = dialog;
    LayerManager.addDialogToUILayer(dialog);
  }

  /** 关闭弹窗（连同子弹窗与悬停提示一起收掉） */
  close() {
    // 快捷键设置弹窗是独立挂在 UI 层的，不随列表销毁 —— 不显式收掉会留下一块无主面板
    this.shortcutKeySettingDialog.close();
    HoverTipManager.hide();
    if (this.dialog && isValid(this.dialog)) this.dialog.destroy();
    this.dialog = null;
  }
}
