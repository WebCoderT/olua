/**
 * 技能零件：技能点/技能列表/技能行
 *
 * 由 GameUiHelper.ts 按域拆出（epic #1115 批次 1，机械搬移零行为变化）：
 * 原类 static 方法改为模块函数；调用方仍经 GameUiHelper 默认导出使用，本文件不直接消费。
 */


import { Color, Graphics, Label, Node, Size, Sprite, Vec2 } from "cc";
import UiHelper from ".././UiHelper";
import { wrappedHeight } from ".././TextLayout";
import { getText } from "../../../configs/texts";
import { Role } from "../../../entities/Role";
import { SkillId } from "../../../types/skill";
import { blockClickThrough } from "../../utils/input/UiHit";
import { skills } from "../../../configs/skill";
import { buttonTone, skillListDialogLayout, T, uiSize } from "../../../configs/hudLayout";
import { createToneButton } from "./dialog-builder";

/**
   * 创建技能点行（#828，稿 07-skill 的 `.pt-line`）：左标签「技能点」+ 右数值 + 行底通栏分隔线
   *
   * 返回**容器节点**，数值是它的子节点 `skill_points_value`（调用方按名字取 Label 改数字）——
   * 升级成功后只改这一行 + 重建技能行，不重开弹窗（重开会把滚动位置弹回顶部）。
   */
export function createSkillPointsLabel(): Node {
    const cfg = skillListDialogLayout.points;
    const container = UiHelper.createNode(cfg.name, new Vec2(), new Size(cfg.label.width + cfg.value.width, cfg.height));
    container.addChild(
      UiHelper.createLabel(
        `${cfg.name}_caption`,
        getText("label_skill_points"),
        cfg.label.color,
        cfg.label.fontSize,
        new Vec2(cfg.label.x, cfg.y),
        new Size(cfg.label.width, cfg.height),
        Label.HorizontalAlign.LEFT,
      ),
    );
    container.addChild(
      UiHelper.createLabel(
        `${cfg.name}_value`,
        "",
        cfg.value.color,
        cfg.value.fontSize,
        new Vec2(cfg.value.x, cfg.y),
        new Size(cfg.value.width, cfg.height),
        Label.HorizontalAlign.RIGHT,
      ),
    );
    const ruleWidth = skillListDialogLayout.list.size.width;
    const rule = UiHelper.createNode(`${cfg.name}_rule`, new Vec2(0, cfg.rule.y), new Size(ruleWidth, 1));
    const graphics = rule.addComponent(Graphics);
    graphics.fillColor = cfg.rule.color;
    graphics.rect(-ruleWidth / 2, -0.5, ruleWidth, 1);
    graphics.fill();
    container.addChild(rule);
    return container;
  }

  /** 创建技能列表滚动区（几何见 configs/hudLayout.skillListDialogLayout.list） */
export function createSkillListView(): Node {
    const list = skillListDialogLayout.list;
    return UiHelper.createScrollView(list.name, list.position, list.size);
  }

  /**
   * 创建单个技能行（未学习置灰；已学习点击触发回调）
   *
   * 说明是**多行**的：`createLabel` 默认单行 CLAMP，205 宽只有 ~20 字，而说明普遍 40~73 字，
   * 单行会把后半句切掉（#481）。这里按 `skillListDialogLayout.row.desc` 的宽度换行、
   * 用 `TextLayout.wrappedHeight` 估算行高，行高随字数变高（列在 ScrollView 里，变高只是滚动变长）。
   *
   * **行内不用水平 Layout**：行高变成 40~82 之后，Layout 会把图标和说明列垂直居中，
   * 图标就浮在行中间、看起来像属于上一条技能。这里手动摆：图标与说明列都**贴行顶**。
   *
   * 行尾的升级按钮（#828）：**只有学过的技能才有**。按钮上不写花费 —— `当前等级`
   * 这条公式只在服务端（`common/utils/skill-upgrade.util`），写到界面上就是第二个真相，
   * 服务端改一次公式这里就变成骗人的。点了之后花多少、还剩多少由服务端的回执 +
   * 浮动提示告诉玩家。到顶的技能照样给按钮：玩家点一下收到 20036「已经练到顶」，
   * 比界面上悄悄少一个按钮更好懂（客户端不知道档数，猜不出来）。
   */
export function createSkillItem(
    role: Role,
    skillId: SkillId,
    onOpenShortcutKey: () => void,
    onUpgrade: () => void,
    shortcutLabel = "",
  ): Node {
    const skillConfig = skills.get(skillId);
    const rowCfg = skillListDialogLayout.row;
    const descCfg = rowCfg.desc;
    const descText = skillConfig.description ?? "";
    const descHeight = wrappedHeight(descText, descCfg.width, descCfg.fontSize, descCfg.lineHeight, descCfg.maxLines);
    const rowHeight = Math.max(
      rowCfg.iconSize,
      descCfg.nameHeight + descCfg.gap + descHeight + descCfg.paddingY * 2,
    );
    const node = UiHelper.createNode(skillId, new Vec2(), new Size(rowCfg.width, rowHeight));
    const left = -rowCfg.width / 2;
    const top = rowHeight / 2;
    const iconCenterX = left + rowCfg.iconInsetLeft + rowCfg.iconSize / 2;
    // 图标垂直中心：贴行顶（见上方说明，不用 Layout 居中）。升级按钮与它同一水平线
    const iconCenterY = top - descCfg.paddingY - rowCfg.iconSize / 2;
    const skillIcon = UiHelper.createSprite(
      skillId,
      skillConfig.icon,
      new Vec2(iconCenterX, iconCenterY),
      new Size(rowCfg.iconSize, rowCfg.iconSize),
    );
    if (!role.skills[skillId]) skillIcon.getComponent(Sprite).grayscale = true;
    if (role.skills[skillId]) {
      skillIcon.on(Node.EventType.TOUCH_END, onOpenShortcutKey);
      // 可点的技能图标（不走 UiHelper.createButton），鼠标通道补一次命中拦截
      blockClickThrough(skillIcon);
    }
    node.addChild(skillIcon);
    // 说明列：锚点 (0.5, 1)、高度按内容自适应 → 位置直接给「左上角」
    const descLeft = left + rowCfg.iconInsetLeft + rowCfg.iconSize + rowCfg.gap;
    const description = UiHelper.createFlexCol(
      `${skillId}_desc`,
      descCfg.gap,
      new Vec2(descLeft + descCfg.width / 2, top - descCfg.paddingY),
      new Size(descCfg.width, 0),
    );
    // 名称行：左侧「名称 (lv.N)」，右端「快捷键 N」右对齐（07 稿 .nm 的 .key；没绑键位时不画）
    const shortcutCfg = rowCfg.shortcut;
    const nameWidth = shortcutLabel ? descCfg.width - shortcutCfg.width : descCfg.width;
    const skillLabel = UiHelper.createLabel(
      "skill_label",
      `${skillConfig.label} (${role.skills[skillId] ? getText("label_skill_level", { level: role.skills[skillId] }) : getText("label_skill_unlearned")})`,
      Color.WHITE,
      descCfg.nameFontSize,
      new Vec2(),
      new Size(nameWidth, descCfg.nameHeight),
    );
    skillLabel.getComponent(Label).horizontalAlign = Label.HorizontalAlign.LEFT;
    description.addChild(skillLabel);
    if (shortcutLabel) {
      // 挂行节点而不是说明列：说明列是纵向 Layout，塞进去会被当第二行排列
      const keyLabel = UiHelper.createLabel(
        `${skillId}_shortcut`,
        shortcutLabel,
        T.text[3],
        shortcutCfg.fontSize,
        new Vec2(
          descLeft + descCfg.width - shortcutCfg.width / 2,
          top - descCfg.paddingY - descCfg.nameHeight / 2,
        ),
        new Size(shortcutCfg.width, descCfg.nameHeight),
        Label.HorizontalAlign.RIGHT,
      );
      node.addChild(keyLabel);
    }
    const skillDesc = UiHelper.createLabel(
      `${skillId}_desc_text`,
      descText,
      Color.WHITE,
      descCfg.fontSize,
      new Vec2(),
      new Size(descCfg.width, descHeight),
    );
    const descLabel = skillDesc.getComponent(Label);
    descLabel.horizontalAlign = Label.HorizontalAlign.LEFT;
    descLabel.enableWrapText = true;
    descLabel.lineHeight = descCfg.lineHeight;
    description.addChild(skillDesc);
    node.addChild(description);
    // 升级按钮（#828）：贴行右缘、与图标同一水平线。没学过的技能没有按钮 ——
    // 「升一个还没学的技能」在服务端也是 20034，界面上不该给这个入口
    if (role.skills[skillId]) {
      const upgradeCfg = rowCfg.upgrade;
      const upgradeButton = createToneButton(
        `${skillId}_upgrade_button`,
        upgradeCfg.label,
        new Vec2(rowCfg.width / 2 - rowCfg.insetRight - upgradeCfg.width / 2, iconCenterY),
        new Size(upgradeCfg.width, upgradeCfg.height),
        uiSize.smallButtonFontSize,
        buttonTone.gold,
      );
      upgradeButton.on(Node.EventType.TOUCH_END, onUpgrade);
      node.addChild(upgradeButton);
    }
    return node;
  }
