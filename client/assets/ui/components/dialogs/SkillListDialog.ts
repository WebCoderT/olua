import { isValid, Label, Node, ScrollView, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import HoverTipManager from "../../core/HoverTipManager";
import LayerManager from "../../core/LayerManager";
import StorageManager from "../../core/StorageManager";
import { oeccupationSkills } from "../../../configs/skill";
import { getText } from "../../../configs/texts";
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
 *
 * 技能升级（#828）：顶部一行「技能点：N」，每个已学技能行尾一个「升级」按钮。
 * 点了走服务端（`StorageManager.upgradeSkillOnServer`），成功后**就地重建**技能行并改数字 ——
 * 不重开弹窗：重开会把滚动位置弹回顶部，玩家刚翻到第 8 个技能，升一级又被扔回第 1 个。
 */
export default class SkillListDialog {
  /** 快捷键设置弹窗（子弹窗，由本弹窗持有） */
  private shortcutKeySettingDialog = new SkillShortcutSettingDialog();
  /** 弹窗节点（切换关闭要用；关闭后置空） */
  private dialog: Node | null = null;
  /** 技能点标签（升级成功后改数字用） */
  private pointsLabel: Label | null = null;
  /** 技能列表的滚动内容节点（升级成功后重建行用） */
  private listContent: Node | null = null;
  /** 正在等服务端回执：防止连点把点数一次花两级（服务端会按余额拒第二个，但界面会闪） */
  private upgrading = false;

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
    const dialog = GameUiHelper.createDialog(skillListDialogLayout.name, skillListDialogLayout.title, new Vec2(), skillListDialogLayout.size);
    // 技能点（#828）：紧贴标题下沿，先建节点、内容由 rebuild 填
    const pointsNode = GameUiHelper.createSkillPointsLabel();
    dialog.addChild(pointsNode);
    this.pointsLabel = pointsNode.getComponent(Label);
    const skillList = GameUiHelper.createSkillListView();
    this.listContent = skillList.getComponent(ScrollView).content;
    dialog.addChild(skillList);
    this.dialog = dialog;
    LayerManager.addDialogToUILayer(dialog);
    this.rebuild();
  }

  /**
   * 重建技能行 + 刷新技能点数字
   *
   * 角色数据（等级 / 技能等级 / 技能点）每次都现读 `StorageManager`：
   * 服务端升级回执已经把新值写进在线角色，所以重建出来就是最新状态。
   */
  private rebuild() {
    const role = StorageManager.findOnlineRole();
    const content = this.listContent;
    if (!role || !content || !isValid(content)) return;
    if (this.pointsLabel && isValid(this.pointsLabel)) {
      // 点数只显示服务端给的值；老存档没有这个字段时按 0（`ensureRoleDefaults` 已补齐）
      this.pointsLabel.string = getText("label_skill_points", { points: role.skillPoints });
    }
    content.removeAllChildren();
    oeccupationSkills.get(role.occupation).forEach((skillId) => {
      const item = GameUiHelper.createSkillItem(
        role,
        skillId,
        () => this.shortcutKeySettingDialog.open(role, skillId),
        () => void this.upgrade(skillId),
      );
      // 鼠标悬停技能图标弹出技能详情（图标是技能行的第一个子节点，节点名 = 技能 id）
      const icon = item.getChildByName(skillId);
      if (icon) {
        icon.on(Node.EventType.MOUSE_ENTER, () => HoverTipManager.showSkill(skillId, icon), this);
        icon.on(Node.EventType.MOUSE_LEAVE, () => HoverTipManager.hide(), this);
        icon.once(Node.EventType.NODE_DESTROYED, () => HoverTipManager.hide(), this);
      }
      content.addChild(item);
    });
  }

  /**
   * 升级一个技能（扣点与等级推进都在服务端）
   *
   * 成功：服务端回执已把 `data.skills` / `data.skillPoints` 写回在线角色 → 就地重建。
   * 失败：请求层按业务码弹提示（20034 升不了 / 20035 点数不足 / 20036 已到顶 / 20006 存档过期），
   * 界面**不动** —— 失败时没有任何本地改动，重开弹窗也是同一份数据。
   */
  private async upgrade(skillId: string): Promise<void> {
    if (this.upgrading) return;
    this.upgrading = true;
    try {
      const ok = await StorageManager.upgradeSkillOnServer(skillId);
      if (ok) this.rebuild();
    } finally {
      this.upgrading = false;
    }
  }

  /** 关闭弹窗（连同子弹窗与悬停提示一起收掉） */
  close() {
    // 快捷键设置弹窗是独立挂在 UI 层的，不随列表销毁 —— 不显式收掉会留下一块无主面板
    this.shortcutKeySettingDialog.close();
    HoverTipManager.hide();
    if (this.dialog && isValid(this.dialog)) this.dialog.destroy();
    this.dialog = null;
    this.pointsLabel = null;
    this.listContent = null;
  }
}
