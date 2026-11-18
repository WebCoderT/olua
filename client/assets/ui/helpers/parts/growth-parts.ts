/**
 * 成长线三窗零件（战魂/称号/军衔）：卡片/属性列表/动画/展示开关/绑定元宝行
 *
 * 由 GameUiHelper.ts 按域拆出（epic #1115 批次 1，机械搬移零行为变化）：
 * 原类 static 方法改为模块函数；调用方仍经 GameUiHelper 默认导出使用，本文件不直接消费。
 */


import { Button, Color, Graphics, isValid, Label, Node, Size, Sprite, UIOpacity, UITransform, Vec2 } from "cc";
import UiHelper from ".././UiHelper";
import AnimationHelper from ".././AnimationHelper";
import { drawVectorIcon } from ".././VectorIcon";
import { icons } from "../../../configs/layout/icons";
import { getText } from "../../../configs/texts";
import { SoulLevelConfig } from "../../../types/soul";
import { TitleLevelConfig } from "../../../types/title";
import { RankLevelConfig } from "../../../types/rank";
import SoundManager from "../../core/SoundManager";
import { blockClickThrough } from "../../utils/input/UiHit";
import { soulAttributeLabels } from "../../../configs/game-config";
import { titleAttributeLabels } from "../../../configs/game-config";
import { rankAttributeLabels } from "../../../configs/game-config";
import { titleUpgradeDialogLayout, rankUpgradeDialogLayout, T, warSoulDialogLayout } from "../../../configs/hudLayout";

/** 战魂弹窗布局（卡片列表 / 动画 / 信息 / 属性 / 绑定元宝 / 升级按钮，统一见 configs/hudLayout.warSoulDialogLayout） */
const soul = warSoulDialogLayout;



  /**
   * 升级链为空时的列表占位（运营一档都没开放）
   *
   * 不铺一排假卡片、也不静默留白：玩家至少要知道「这里本来是列表，但还没开放」，
   * 而不是对着空面板猜是不是加载失败。
   * @param name 节点名（各弹窗取不同的，调试时能认出是哪个弹窗的列表）
   * @param width 列表卡片宽度（用于居中与折行）
   */
export function createChainEmptyLabel(name: string, width: number, color: Color, fontSize: number) {
    return UiHelper.createLabel(name, getText("label_growth_chain_empty"), color, fontSize, new Vec2(), new Size(width, 28), Label.HorizontalAlign.CENTER);
  }

  /**
   * 三栏养成弹窗的中栏容器（稿 17-growth 的 `.gcenter`：line-1 边 + 深底 + 圆角 r2）
   * 垫在动画 / 徽记 / 文字之下，让中栏与左右两栏一样有边界感
   */
export function createGrowthCenter(name: string, spec: { position: Vec2; size: Size; fill: Color; border: Color; radius: number }) {
    const node = UiHelper.createNode(name, spec.position, spec.size);
    const graphics = node.addComponent(Graphics);
    UiHelper.paintRoundedPanel(graphics, spec.size, spec.radius, spec.fill, spec.border, 1);
    return node;
  }

  /**
   * 成长线左栏卡片（稿 17-growth 的 `.gitem`：212×46、圆角 r2、`rgba(0,0,0,.24)` 底 + line-1 边）
   *
   * 结构与三窗同源：底/边（Graphics 重画）→ 26px 阶号圆徽 → 名称（f13 左对齐）→ 右侧状态（f11）。
   * 选中态金边 + 金色淡底、圆徽变金底深字；未激活的名称与状态走 text-4。
   * @param step 阶号（圆徽里的数字）
   * @param label 名称（只放名字，不再拼「N 阶 ·」——阶号在圆徽里）
   * @param stateText 右侧状态（已激活 / 未激活 / 已授衔 / 未授衔，各线自己给）
   */
export function createGrowthCard(
    name: string,
    step: number,
    label: string,
    stateText: string,
    activated: boolean,
    selected: boolean,
    spec: {
      cardSize: Size;
      radius: number;
      stepSize: number;
      stepFontSize: number;
      cardFontSize: number;
      stateFontSize: number;
      fill: Color;
      fillSelected: Color;
      borderColor: Color;
      borderSelected: Color;
      selectedColor: Color;
      activeColor: Color;
      lockedColor: Color;
      stepRing: Color;
      stepFill: Color;
      stepText: Color;
      stepFillSelected: Color;
      stepTextSelected: Color;
      borderWidth?: number;
    },
    onClick: () => void,
  ) {
    const card = UiHelper.createNode(name, new Vec2(), spec.cardSize);
    const button = card.addComponent(Button);
    button.transition = Button.Transition.SCALE;
    // 底 + 边（先加，绘制在圆徽与文字之下）
    const bg = new Node(`${name}_bg`);
    bg.addComponent(UITransform).setContentSize(spec.cardSize);
    bg.addComponent(Graphics);
    card.addChild(bg);
    // 阶号圆徽（稿 .step：26 圆、11 号字）
    const badge = UiHelper.createNode(`${name}_step`, new Vec2(-spec.cardSize.width / 2 + 12 + spec.stepSize / 2, 0), new Size(spec.stepSize, spec.stepSize));
    badge.addComponent(Graphics);
    badge.addChild(UiHelper.createLabel(`${name}_step_label`, `${step}`, spec.stepText, spec.stepFontSize, new Vec2(), new Size(spec.stepSize, spec.stepSize)));
    card.addChild(badge);
    // 名称（圆徽右侧、左对齐）与右侧状态
    const stateWidth = 56;
    const textLeft = -spec.cardSize.width / 2 + 12 + spec.stepSize + 10;
    const nameWidth = spec.cardSize.width - (12 + spec.stepSize + 10) - stateWidth - 12;
    card.addChild(
      UiHelper.createLabel(`${name}_label`, label, spec.selectedColor, spec.cardFontSize, new Vec2(textLeft + nameWidth / 2, 0), new Size(nameWidth, spec.cardSize.height), Label.HorizontalAlign.LEFT),
    );
    card.addChild(
      UiHelper.createLabel(`${name}_state`, stateText, spec.activeColor, spec.stateFontSize, new Vec2(spec.cardSize.width / 2 - 12 - stateWidth / 2, 0), new Size(stateWidth, spec.cardSize.height)),
    );
    paintGrowthCard(card, spec, activated, selected, stateText);
    card.on(Node.EventType.TOUCH_END, onClick);
    // 按钮点击音（#685）：手写按钮不走 UiHelper.createButton，声音得自己贴一行
    SoundManager.bindClick(card);
    // 手写的 Button + TOUCH_END（不走 UiHelper.createButton），鼠标通道同样补一次命中拦截
    blockClickThrough(card);
    return card;
  }

  /**
   * 重画一张已有成长卡片的选中/激活外观（不建节点）
   * 军衔 100 阶切换选中走它（重建 100 张卡片会重演商城「打开就卡」那个坑）
   */
export function paintGrowthCard(
    card: Node,
    spec: { cardSize: Size; radius: number; stepSize: number; fill: Color; fillSelected: Color; borderColor: Color; borderSelected: Color; selectedColor: Color; activeColor: Color; lockedColor: Color; stepRing: Color; stepFill: Color; stepText: Color; stepFillSelected: Color; stepTextSelected: Color; borderWidth?: number },
    activated: boolean,
    selected: boolean,
    stateText: string,
  ) {
    const bg = card.getChildByName(`${card.name}_bg`)?.getComponent(Graphics);
    if (bg) {
      bg.clear();
      // 先铺半透明底、再压 1px 边：不能走 paintRoundedPanel（它是「外框色填整块 → 内缩填主体」，
      // 半透明主体盖不住底下的边色，卡片会整块发亮 —— 实机核对时第一版就是这样）
      bg.fillColor = selected ? spec.fillSelected : spec.fill;
      bg.roundRect(-spec.cardSize.width / 2, -spec.cardSize.height / 2, spec.cardSize.width, spec.cardSize.height, spec.radius);
      bg.fill();
      UiHelper.paintRectBorder(bg, spec.cardSize, selected ? spec.borderSelected : spec.borderColor, selected ? (spec.borderWidth ?? 1) : 1);
    }
    const badge = card.getChildByName(`${card.name}_step`);
    const graphics = badge?.getComponent(Graphics);
    if (graphics) {
      graphics.clear();
      const radius = spec.stepSize / 2;
      // 圆环用「外圆填环色 → 内圆填底色」拼（1px stroke 实机不渲染，同 paintRoundedPanel 的坑）
      graphics.fillColor = selected ? spec.stepFillSelected : spec.stepRing;
      graphics.circle(0, 0, radius);
      graphics.fill();
      graphics.fillColor = selected ? spec.stepFillSelected : spec.stepFill;
      graphics.circle(0, 0, radius - 1);
      graphics.fill();
    }
    const stepLabel = card.getChildByName(`${card.name}_step_label`)?.getComponent(Label);
    if (stepLabel) stepLabel.color = selected ? spec.stepTextSelected : spec.stepText;
    const nameLabel = card.getChildByName(`${card.name}_label`)?.getComponent(Label);
    if (nameLabel) nameLabel.color = selected ? spec.selectedColor : activated ? Color.WHITE : spec.lockedColor;
    const stateLabel = card.getChildByName(`${card.name}_state`)?.getComponent(Label);
    if (stateLabel) {
      stateLabel.string = stateText;
      stateLabel.color = activated ? spec.activeColor : spec.lockedColor;
    }
    // 未激活卡片整体变暗（稿 `.gitem.locked{opacity:.6}`）：选中项不管授没授衔都保持全亮
    const opacity = card.getComponent(UIOpacity) ?? card.addComponent(UIOpacity);
    opacity.opacity = activated || selected ? 255 : 153;
  }

  /**
   * 成长线右栏的一行「名称 …… 数值」（稿 `.gcost .kv`：名称贴右栏左缘、数值贴右栏右缘）
   */
export function createGrowthCostRow(name: string, label: string, value: string, y: number, spec: { leftX: number; rightX: number; fontSize: number; valueFontSize: number; nameColor: Color; valueColor: Color }) {
    const width = spec.rightX - spec.leftX;
    const node = UiHelper.createNode(name, new Vec2((spec.leftX + spec.rightX) / 2, y), new Size(width, 18));
    node.addChild(UiHelper.createLabel(`${name}_label`, label, spec.nameColor, spec.fontSize, new Vec2(-width / 2 + 60, 0), new Size(120, 18), Label.HorizontalAlign.LEFT));
    node.addChild(UiHelper.createLabel(`${name}_value`, value, spec.valueColor, spec.valueFontSize, new Vec2(width / 2 - 70, 0), new Size(140, 18), Label.HorizontalAlign.RIGHT));
    return node;
  }

  /** 成长线右栏「消耗区」顶部的 1px 分隔线（稿 .gcost 的 border-top；1px stroke 不渲染，用填充条画） */
export function createGrowthCostDivider(name: string, spec: { leftX: number; rightX: number; line: { y: number; width: number; color: Color } }) {
    const node = UiHelper.createNode(name, new Vec2((spec.leftX + spec.rightX) / 2, spec.line.y), new Size(spec.line.width, 1));
    const graphics = node.addComponent(Graphics);
    graphics.fillColor = spec.line.color;
    graphics.rect(-spec.line.width / 2, -0.5, spec.line.width, 1);
    graphics.fill();
    return node;
  }

  /**
   * 成长线右栏按钮下的提示行（稿 `.showline`：半透明底 + 1px 边 + r2 的框，左侧金勾 + 小字）
   * 文案由各窗给（军衔含当前预览的军衔名，切换选中时要重设，见 rank 弹窗）；
   * 文字块定高、在框内垂直居中 —— 1 行 / 2 行都不会把金勾顶偏或撑出框。
   */
export function createGrowthShowline(
    name: string,
    text: string,
    spec: { position: Vec2; size: Size; radius: number; fill: Color; border: Color; padding: number; gap: number; fontSize: number; color: Color; checkColor: Color; checkSize: number },
  ) {
    const node = UiHelper.createNode(name, spec.position, spec.size);
    // 底框：先铺半透明底、再压 1px 边（半透明主体盖不住 paintRoundedPanel 的边色，同卡片的坑）
    const bg = UiHelper.createNode(`${name}_bg`, new Vec2(), spec.size);
    const graphics = bg.addComponent(Graphics);
    graphics.fillColor = spec.fill;
    graphics.roundRect(-spec.size.width / 2, -spec.size.height / 2, spec.size.width, spec.size.height, spec.radius);
    graphics.fill();
    UiHelper.paintRectBorder(graphics, spec.size, spec.border, 1);
    node.addChild(bg);
    // 金勾贴左内边距、纵向居中
    const check = UiHelper.createNode(`${name}_check`, new Vec2(-spec.size.width / 2 + spec.padding + spec.checkSize / 2, 0), new Size(spec.checkSize, spec.checkSize));
    drawVectorIcon(check, icons.growthCheck, new Size(spec.checkSize, spec.checkSize), spec.checkColor, 1.7);
    node.addChild(check);
    // 文字块：宽 = 框宽 − 两侧内边距 − 勾与间距；高 = 框高 − 上下内边距
    const textLeft = -spec.size.width / 2 + spec.padding + spec.checkSize + spec.gap;
    const width = spec.size.width - spec.padding * 2 - spec.checkSize - spec.gap;
    const height = spec.size.height - spec.padding * 2;
    node.addChild(UiHelper.createWrappedLabel(`${name}_text`, text, spec.color, spec.fontSize, 13, new Vec2(textLeft + width / 2, 0), width, Label.HorizontalAlign.LEFT, height));
    return node;
  }



  /**
   * 创建战魂等级卡片（左侧列表行）：等级 + 名称 + 激活状态，选中加金色描边
   * @param config 该等级的战魂配置
   * @param activated 是否已到达 —— **由调用方按升级链序判定**（链序 ≠ 阶数，这里不做比较）
   * @param selected 是否为当前选中项
   * @param onClick 点击回调（切换选中预览）
   */
export function createSoulCard(config: SoulLevelConfig, activated: boolean, selected: boolean, onClick: () => void) {
    return createGrowthCard(
      `soul_card_${config.level}`,
      config.level,
      config.label,
      activated ? getText("label_soul_active") : getText("label_soul_locked"),
      activated,
      selected,
      soul.list,
      onClick,
    );
  }

  /**
   * 成长线右栏属性表（稿 17-growth 的 `.gside`：13 号金字的标题 + 属性行）
   * 行内三段：属性名（左，text-3）→ 当前值（白）→ 下一级增量（绿，右对齐）
   * @param title 列标题（战魂/称号「升级加成」、军衔「晋升加成」）
   */
export function createGrowthAttributeList(
    name: string,
    title: string,
    rows: Array<{ label: string; valueText: string; diffText: string | null }>,
    spec: { width: number; spacing: number; fontSize: number; titleFontSize: number; titleColor: Color; rowNameColor: Color; rowDiffColor: Color },
  ) {
    const column = UiHelper.createFlexCol(name, spec.spacing, new Vec2(), new Size(spec.width, 0));
    column.addChild(UiHelper.createLabel(`${name}_title`, title, spec.titleColor, spec.titleFontSize, new Vec2(), new Size(spec.width, 22), Label.HorizontalAlign.LEFT));
    const nameWidth = 52;
    const valueWidth = 78;
    rows.forEach((row, index) => {
      const line = UiHelper.createFlexRow(`${name}_row_${index}`, 0, new Vec2(), new Size(spec.width, 18));
      line.addChild(UiHelper.createLabel("name", row.label, spec.rowNameColor, spec.fontSize, new Vec2(), new Size(nameWidth, 18), Label.HorizontalAlign.LEFT));
      line.addChild(UiHelper.createLabel("value", row.valueText, Color.WHITE, spec.fontSize, new Vec2(), new Size(valueWidth, 18), Label.HorizontalAlign.LEFT));
      if (row.diffText) {
        line.addChild(
          UiHelper.createLabel("diff", row.diffText, spec.rowDiffColor, spec.fontSize, new Vec2(), new Size(spec.width - nameWidth - valueWidth - 8, 18), Label.HorizontalAlign.RIGHT),
        );
      }
      column.addChild(line);
    });
    return column;
  }

  /**
   * 创建战魂属性列表（右侧面板）：标题 + 各属性行（有下一级时附带绿色增量）
   * @param config 展示的战魂等级配置
   * @param next 下一级配置（没有传 null，如已满级）
   */
export function createSoulAttributeList(config: SoulLevelConfig, next: SoulLevelConfig | null) {
    return createGrowthAttributeList(
      "soul_attribute_list",
      getText("label_growth_bonus"),
      soulAttributeLabels.map((item) => ({
        label: item.label,
        valueText: formatSoulAttributeValue(config.attributes[item.key]),
        diffText: next ? formatSoulAttributeDiff(config.attributes[item.key], next.attributes[item.key]) : null,
      })),
      soul.attribute,
    );
  }

  /** 属性值文案：数值直接显示，区间属性显示为「min ~ max」 */
export function formatSoulAttributeValue(value: number | [number, number]) {
    return typeof value === "number" ? `${value}` : `${value[0]} ~ ${value[1]}`;
  }

  /** 下一级增量文案：数值「+N」，区间「+min~+max」（数值/区间混用时按区间补齐两侧） */
export function formatSoulAttributeDiff(current: number | [number, number], next: number | [number, number]) {
    if (typeof current === "number" && typeof next === "number") return `+${next - current}`;
    const c = typeof current === "number" ? [current, current] : current;
    const n = typeof next === "number" ? [next, next] : next;
    return `+${n[0] - c[0]}~+${n[1] - c[1]}`;
  }

  /**
   * 创建战魂动画节点（异步加载图集帧后循环播放）
   * @param config 战魂等级配置
   * @param size 节点尺寸（缺省用弹窗中间展示尺寸；挂到主角身上的外显传小尺寸）
   */
export function createSoulAnimation(config: SoulLevelConfig, size: Size = soul.animation.size) {
    const node = UiHelper.createNode("soul_animation", new Vec2(), size);
    const sprite = node.addComponent(Sprite);
    sprite.sizeMode = Sprite.SizeMode.RAW;
    sprite.trim = false;
    AnimationHelper.loadLoopFrames(config.animation).then((frames) => {
      if (!isValid(node) || !frames.length) return;
      // 帧图集是整格方图（RAW 会按原始像素把节点撑到 800 见方），按槽位等比缩放——
      // 否则立绘会溢出中栏、压住左右两栏与底部信息（实机截图核对 #1111）
      const raw = frames[0]?.originalSize ?? frames[0]?.rect?.size;
      if (raw && raw.width > 0 && raw.height > 0) {
        const scale = Math.min(size.width / raw.width, size.height / raw.height);
        node.setScale(scale, scale, 1);
      }
      AnimationHelper.playLoopWithFrames("soul_stand", node, frames, config.animationFrameRate);
    });
    return node;
  }

  /**
   * 创建战魂外显勾选框（小方框 + 对勾 + 「外显」文字；点击回调带回切换后的状态）
   * 勾选状态由调用方传入（弹窗整体刷新式重建，状态以角色数据 role.soulShow 为准）
   */
export function createSoulShowToggle(checked: boolean, onClick: (checked: boolean) => void) {
    const toggle = soul.info.toggle;
    const half = toggle.boxSize / 2;
    const node = UiHelper.createNode("soul_show_toggle", new Vec2(), toggle.size);
    const button = node.addComponent(Button);
    button.transition = Button.Transition.SCALE;
    // 勾选框（小方框）：未勾选是空心框（line-2 发丝线），勾选后填金 + 深金对勾
    const box = new Node("soul_show_box");
    box.addComponent(UITransform).setContentSize(toggle.boxSize, toggle.boxSize);
    box.setPosition(-toggle.size.width / 2 + half, 0);
    const graphics = box.addComponent(Graphics);
    if (checked) {
      graphics.fillColor = soul.list.selectedColor;
      graphics.rect(-half, -half, toggle.boxSize, toggle.boxSize);
      graphics.fill();
    }
    // 1px 边框用填充条画（stroke 实机不渲染，同卡片 / 按钮的坑）
    UiHelper.paintRectBorder(graphics, new Size(toggle.boxSize, toggle.boxSize), checked ? soul.list.selectedColor : soul.list.stepRing, 1);
    if (checked) {
      box.addChild(UiHelper.createLabel("soul_show_check", "✓", T.text.onGold, toggle.fontSize, new Vec2(), new Size(toggle.boxSize, toggle.boxSize)));
    }
    node.addChild(box);
    node.addChild(UiHelper.createLabel("soul_show_text", toggle.text, T.text[2], toggle.fontSize, new Vec2(toggle.textGap, 0), new Size(60, toggle.size.height), Label.HorizontalAlign.LEFT));
    node.on(Node.EventType.TOUCH_END, () => onClick(!checked));
    // 按钮点击音（#685）：手写按钮不走 UiHelper.createButton，声音得自己贴一行
    SoundManager.bindClick(node);
    // 手写的 Button + TOUCH_END（不走 UiHelper.createButton），鼠标通道同样补一次命中拦截
    blockClickThrough(node);
    return node;
  }



  /**
   * 创建称号等级卡片（左侧列表行）：等级 + 名称 + 激活状态，选中加金色描边
   * @param config 该等级的称号配置
   * @param activated 是否已到达 —— **由调用方按升级链序判定**（链序 ≠ 等级号，这里不做比较）
   * @param selected 是否为当前选中项
   * @param onClick 点击回调（切换选中预览）
   */
export function createTitleCard(config: TitleLevelConfig, activated: boolean, selected: boolean, onClick: () => void) {
    return createGrowthCard(
      `title_card_${config.level}`,
      config.level,
      config.label,
      activated ? getText("label_title_active") : getText("label_title_locked"),
      activated,
      selected,
      titleUpgradeDialogLayout.list,
      onClick,
    );
  }

  /**
   * 创建称号属性列表（右侧面板）：标题 + 各属性行（有下一级时附带绿色增量），与战魂属性表同一套格式
   * @param config 展示的称号等级配置
   * @param next 下一级配置（没有传 null，如已满级）
   */
export function createTitleAttributeList(config: TitleLevelConfig, next: TitleLevelConfig | null) {
    return createGrowthAttributeList(
      "title_attribute_list",
      getText("label_growth_bonus"),
      titleAttributeLabels.map((item) => ({
        label: item.label,
        valueText: formatSoulAttributeValue(config.attributes[item.key]),
        diffText: next ? formatSoulAttributeDiff(config.attributes[item.key], next.attributes[item.key]) : null,
      })),
      titleUpgradeDialogLayout.attribute,
    );
  }

  /**
   * 创建称号动画节点（异步加载散图帧目录后循环播放；头顶外显与弹窗中间展示共用）
   * 名牌帧带字（如「飞龙在天」）且各称号宽窄不一，一律**按素材原始尺寸显示（不缩放）**：
   * 头顶那份交给头部信息栏的纵向布局排位置，弹窗那份直接放进动画槽位
   * @param config 称号等级配置
   * @param size 节点初始尺寸（RAW 模式加载首帧后会被原始尺寸覆盖，仅占位）
   */
export function createTitleAnimation(config: TitleLevelConfig, size: Size = titleUpgradeDialogLayout.animation.size) {
    const node = UiHelper.createNode("title_animation", new Vec2(), size);
    const sprite = node.addComponent(Sprite);
    sprite.sizeMode = Sprite.SizeMode.RAW;
    sprite.trim = false;
    AnimationHelper.loadLoopFrames(config.animation).then((frames) => {
      if (!isValid(node) || !frames.length) return;
      AnimationHelper.playLoopWithFrames("title_loop", node, frames, config.animationFrameRate);
    });
    return node;
  }



  /**
   * 创建军衔阶数卡片（左侧列表行）：阶数 + 衔名 + 授衔状态，选中加金色描边（与称号/战魂卡片同一套样式）
   * 卡片只在这里建一次（100 阶重建一次代价不小，见弹窗的 buildList），点击切换选中走 updateRankCard 改外观
   * @param config 该阶的军衔配置
   * @param activated 是否已授衔 —— 由调用方给（军衔按阶比较，与称号/战魂的链序判定分开写）
   * @param selected 是否为当前选中项
   * @param onClick 点击回调（切换选中预览）
   */
export function createRankCard(config: RankLevelConfig, activated: boolean, selected: boolean, onClick: () => void) {
    return createGrowthCard(
      `rank_card_${config.level}`,
      config.level,
      config.label,
      activated ? getText("label_rank_active") : getText("label_rank_locked"),
      activated,
      selected,
      rankUpgradeDialogLayout.list,
      onClick,
    );
  }

  /**
   * 刷新一张已有军衔卡片的选中/授衔外观（切换选中、晋升后重刷状态都走它，不重建卡片）
   * 底/边/圆徽/文字全部按状态重画，杜绝「点一下重建 100 张卡片」
   * @param granted 是否已授衔（调用方按阶比较：`config.level <= role.rank`）
   */
export function updateRankCard(card: Node, granted: boolean, selected: boolean) {
    paintGrowthCard(card, rankUpgradeDialogLayout.list, granted, selected, granted ? getText("label_rank_active") : getText("label_rank_locked"));
  }

  /**
   * 创建军衔属性列表（右侧面板）：标题 + 各属性行（有下一阶时附带绿色增量），与战魂/称号属性表同一套格式
   * @param config 展示的军衔阶配置
   * @param next 下一阶配置（没有传 null，如已满衔）
   */
export function createRankAttributeList(config: RankLevelConfig, next: RankLevelConfig | null) {
    return createGrowthAttributeList(
      "rank_attribute_list",
      getText("label_rank_bonus"),
      rankAttributeLabels.map((item) => ({
        label: item.label,
        valueText: formatSoulAttributeValue(config.attributes[item.key]),
        diffText: next ? formatSoulAttributeDiff(config.attributes[item.key], next.attributes[item.key]) : null,
      })),
      rankUpgradeDialogLayout.attribute,
    );
  }

  /**
   * 创建军衔徽记（弹窗中间那栏的展示物；军衔没有帧动画，徽记就是它的「外观」）
   * 按稿 17-growth 的 `.emblem`：150 圆、金环 + 深底，环内一枚大字（军衔名末字）+ 段名小字
   * 军衔全名与「第 N 阶 / 共 M 阶」由中栏的信息行显示（name / current），不在环里重复
   * @param config 展示的军衔阶配置
   */
export function createRankBadge(config: RankLevelConfig) {
    const layout = rankUpgradeDialogLayout.badge;
    const node = UiHelper.createNode("rank_badge", new Vec2(), layout.size);
    // 圆徽（外圆填环色 → 内圆填底色，1px 级 stroke 实机不渲染，同 paintRoundedPanel 的坑）
    const plate = new Node("rank_badge_plate");
    const graphics = plate.addComponent(Graphics);
    const radius = layout.size.width / 2;
    graphics.fillColor = layout.borderColor;
    graphics.circle(0, 0, radius);
    graphics.fill();
    graphics.fillColor = layout.fill;
    graphics.circle(0, 0, radius - layout.borderWidth);
    graphics.fill();
    node.addChild(plate);
    // 虚线外环（稿 .emblem::after）：金环外一圈小圆点，同盘绘制（在 plate 的 Graphics 上画）
    graphics.fillColor = layout.ring.color;
    for (let i = 0; i < layout.ring.dots; i++) {
      const angle = (i / layout.ring.dots) * Math.PI * 2;
      graphics.circle(Math.cos(angle) * layout.ring.radius, Math.sin(angle) * layout.ring.radius, layout.ring.dotSize / 2);
      graphics.fill();
    }
    node.addChild(UiHelper.createLabel("rank_badge_glyph", config.label.slice(-1), layout.glyph.color, layout.glyph.fontSize, layout.glyph.position, layout.glyph.size));
    node.addChild(UiHelper.createLabel("rank_badge_tier", config.tier, layout.tier.color, layout.tier.fontSize, layout.tier.position, layout.tier.size));
    return node;
  }
