import { isValid, Label, Node, ScrollView } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import HoverTipManager from "../../core/HoverTipManager";
import StorageManager from "../../core/StorageManager";
import { oeccupationSkills } from "../../../configs/skill";
import { getText } from "../../../configs/texts";
import BaseDialog from "./dialog-kit";
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
export default class SkillListDialog extends BaseDialog {
  /** 快捷键设置弹窗（子弹窗，由本弹窗持有） */
  private shortcutKeySettingDialog = new SkillShortcutSettingDialog();
  /** 技能点标签（升级成功后改数字用） */
  private pointsLabel: Label | null = null;
  /** 技能列表的滚动内容节点（升级成功后重建行用） */
  private listContent: Node | null = null;
  /** 正在等服务端回执：防止连点把点数一次花两级（服务端会按余额拒第二个，但界面会闪） */
  private upgrading = false;

  /** 打开/关闭技能列表弹窗（开关：已开则关） */
  open() {
    const cfg = skillListDialogLayout;
    const opened = this.openFrame(
      // 页脚文案走 texts（skill_foot_left/right），不在 layout.footTexts
      { name: cfg.name, title: cfg.title, eyebrow: cfg.eyebrow, size: cfg.size, foot: cfg.foot, footTexts: { left: getText("skill_foot_left"), right: getText("skill_foot_right") } },
      (dialog) => {
    // 技能点（#828）：稿 07-skill 的 .pt-line —— 左标签 + 右数值 + 行底分隔线；
    // 数值是容器里的子节点，改数字只动它（标签是静态文案）
    const pointsNode = GameUiHelper.createSkillPointsLabel();
    dialog.addChild(pointsNode);
    this.pointsLabel = pointsNode.getChildByName(`${skillListDialogLayout.points.name}_value`)?.getComponent(Label) ?? null;
    const skillList = GameUiHelper.createSkillListView();
    this.listContent = skillList.getComponent(ScrollView).content;
    dialog.addChild(skillList);
      this.rebuild();
      },
    );
    // 引导（#402）：「认识技能」那一步就是「打开过技能列表」—— 事件在**真打开**之后发，
    // 切换关闭不该算一次（玩家关窗不该被当成学会了）
    if (opened) GuideStore.notify(GUIDE_EVENT.OPEN_SKILL);
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
      this.pointsLabel.string = `${role.skillPoints}`;
    }
    content.removeAllChildren();
    oeccupationSkills.get(role.occupation).forEach((skillId) => {
      // 该技能绑在哪个键位上（07 稿 .nm 的 .key）：没绑就不显示
      const bound = role.shortcutKeys.find((config) => config.skillId === skillId);
      const item = GameUiHelper.createSkillItem(
        role,
        skillId,
        () => this.shortcutKeySettingDialog.open(role, skillId),
        () => void this.upgrade(skillId),
        bound ? getText("label_skill_shortcut", { key: bound.label }) : "",
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

  /** 关闭弹窗（销毁与清引用在 BaseDialog.close）：快捷键子弹窗与悬停提示不随列表销毁，要显式收 */
  protected onClose() {
    this.shortcutKeySettingDialog.close();
    HoverTipManager.hide();
    this.pointsLabel = null;
    this.listContent = null;
  }
}
