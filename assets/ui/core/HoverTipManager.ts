import { isValid, Node } from "cc";
import { skillTargetTypeLabels, skillTypeLabels, skills } from "../../configs/skill";
import { getText, uiTexts } from "../../configs/texts";
import { statuses } from "../../configs/status";
import { SkillId } from "../../types/skill";
import { StatusBadge } from "../../types/status";
import HoverTipDialog, { HoverTipData } from "../components/dialogs/HoverTipDialog";
import { markClickThrough } from "../utils/input/UiHit";
import LayerManager from "./LayerManager";
import SkillManager from "./SkillManager";
import StatusManager from "./StatusManager";
import StorageManager from "./StorageManager";

/**
 * 悬停详情弹窗管理器（静态类）
 * 鼠标悬停在状态图标/技能图标上时弹出详情（名称/介绍/剩余时间/冷却等），移开或图标销毁即收起：
 * - 图标侧只负责在 MOUSE_ENTER 时调用 showSkill/showStatus、MOUSE_LEAVE 与 NODE_DESTROYED 时调用 hide
 * - 同屏只保留一个详情弹窗，重复悬停直接重建（内容量小，重建开销可忽略）
 * - 剩余时间/剩余冷却每帧刷新（动态行），状态到期时随图标销毁一并收起
 * - 弹窗标记了点击穿透（markClickThrough），悬停期间不遮挡世界点击
 */
export default class HoverTipManager {
  /** 当前显示的详情弹窗 */
  private static dialog: HoverTipDialog | null = null;
  /** 弹窗对应的锚点图标（图标销毁即收起） */
  private static anchor: Node | null = null;
  /** 动态行取值器（返回剩余秒数；无动态行为 null） */
  private static remainingProvider: (() => number) | null = null;
  /** 动态行文案前缀（「剩余时间」/「冷却剩余」） */
  private static dynamicPrefix = "";
  /** 剩余秒数归零时是否整体收起（状态到期收起；技能冷却结束改为显示「就绪」） */
  private static hideOnZero = false;

  /** 显示技能详情弹窗（anchor 为技能图标节点，快捷键槽/技能列表通用） */
  static showSkill(skillId: SkillId, anchor: Node) {
    const skill = skills.get(skillId);
    if (!skill) return;
    const role = StorageManager.findOnlineRole();
    const rows = [
      getText("hover_skill_type", { type: skillTypeLabels[skill.type], target: skillTargetTypeLabels[skill.targetType] }),
      getText("hover_skill_level", { level: skill.level }),
      getText("hover_skill_mp", { cost: skill.mpCost }),
      getText("hover_skill_cooldown", { seconds: skill.cooldown }),
      getText("hover_skill_distance", { distance: skill.distance }),
      getText("hover_skill_mastery", { level: role?.skills[skillId] ? getText("label_skill_level", { level: role.skills[skillId] }) : getText("label_skill_unlearned") }),
    ];
    // 冷却中额外给一条每帧刷新的剩余冷却行（冷却结束改为「就绪」，不收起弹窗）
    const remaining = SkillManager.getCooldownRemaining(skillId);
    const dynamicRow = this.remainingRow(uiTexts.hover_prefix_cooldown, remaining);
    this.show({ title: skill.label, icon: skill.icon, rows, dynamicRow, description: skill.description }, anchor, () => SkillManager.getCooldownRemaining(skillId), uiTexts.hover_prefix_cooldown, false);
  }

  /** 显示状态详情弹窗（anchor 为状态图标节点） */
  static showStatus(badge: StatusBadge, anchor: Node) {
    const status = statuses.get(badge.id);
    if (!status) return;
    const seconds = StatusManager.getRemainingSeconds(badge.id);
    this.show(
      {
        title: status.label,
        icon: status.icon,
        rows: [],
        dynamicRow: this.remainingRow(uiTexts.hover_prefix_remaining, seconds),
        description: status.description,
      },
      anchor,
      () => StatusManager.getRemainingSeconds(badge.id),
      uiTexts.hover_prefix_remaining,
      true,
    );
  }

  /** 收起当前详情弹窗（移开鼠标/图标销毁/场景卸载时调用，幂等） */
  static hide() {
    const dialog = this.dialog;
    this.dialog = null;
    this.anchor = null;
    this.remainingProvider = null;
    if (dialog && isValid(dialog)) dialog.destroy();
  }

  /** 每帧驱动（组合根 update 调用）：刷新动态行；图标或弹窗失效、状态到期时收起 */
  static tick() {
    const dialog = this.dialog;
    if (!dialog) return;
    // 图标被销毁（状态到期重建/快捷键刷新/场景切换）即收起
    if (!dialog.isValidNode() || !this.anchor || !isValid(this.anchor)) {
      this.hide();
      return;
    }
    if (!this.remainingProvider) return;
    const seconds = this.remainingProvider();
    if (seconds <= 0) {
      // 状态到期：图标马上会被 StatusManager 重建，这里提前收起；技能冷却结束只改文案
      if (this.hideOnZero) {
        this.hide();
        return;
      }
      dialog.updateDynamicText(getText("hover_row_ready", { prefix: this.dynamicPrefix }));
      return;
    }
    dialog.updateDynamicText(getText("hover_row_seconds", { prefix: this.dynamicPrefix, seconds: seconds.toFixed(1) }));
  }

  /** 复用的动态行文案（剩 0 秒时为「就绪」，否则为「N 秒」） */
  private static remainingRow(prefix: string, seconds: number): string {
    return seconds > 0 ? getText("hover_row_seconds", { prefix, seconds: seconds.toFixed(1) }) : getText("hover_row_ready", { prefix });
  }

  /** 弹出详情弹窗（统一入口：重建式显示，先收起旧的再建新的） */
  private static show(data: HoverTipData, anchor: Node, remainingProvider: () => number, dynamicPrefix: string, hideOnZero: boolean) {
    this.hide();
    const dialog = new HoverTipDialog(data);
    LayerManager.addToUILayer(dialog);
    dialog.placeByAnchor(anchor);
    // 详情是被动展示的浮层：不参与 UI 命中判定，悬停期间不遮挡世界点击
    markClickThrough(dialog);
    this.dialog = dialog;
    this.anchor = anchor;
    this.remainingProvider = remainingProvider;
    this.dynamicPrefix = dynamicPrefix;
    this.hideOnZero = hideOnZero;
  }
}
