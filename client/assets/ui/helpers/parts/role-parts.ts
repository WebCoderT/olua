/**
 * 角色与 HUD 零件：货币/战力/头像/装备槽/血条/头顶信息/角色预览/底部导航/属性行
 *
 * 由 GameUiHelper.ts 按域拆出（epic #1115 批次 1，机械搬移零行为变化）：
 * 原类 static 方法改为模块函数；调用方仍经 GameUiHelper 默认导出使用，本文件不直接消费。
 */


import { Animation, Button, Color, Graphics, isValid, Label, Layout, Mask, Node, ProgressBar, Size, Sprite, UIOpacity, UITransform, Vec2 } from "cc";
import UiHelper from ".././UiHelper";
import AnimationHelper from ".././AnimationHelper";
import VectorBarBridge from "../../components/common/VectorBarBridge";
import { drawVectorIcon, type VectorIconShape } from ".././VectorIcon";
import { icons } from "../../../configs/layout/icons";
import { getText } from "../../../configs/texts";
import { BottomNavItem } from "../../../configs/bottomNav";
import { Role } from "../../../entities/Role";
import type { AttrPointKey } from "../../../types/role";
import { SpeedRate } from "../../../types/animation";
import { BattleAttributes } from "../../../types/common";
import { EQUIPMENT_TYPE } from "../../../types/good";
import SoundManager from "../../core/SoundManager";
import { blockClickThrough } from "../../utils/input/UiHit";
import { goodShowAttributesLabel } from "../../../configs/good";
import { getRankLevel } from "../../../configs/game-config";
import { clearChildren } from "../../utils/node/NodeTree";
import { avatarImage, bottomBarLayout, buttonTone, createRolePreviewImage, createRoleShowImage, roleSelectEffectImage, roleShowLayout, equipmentSlotLayout, roleAttributeListLayout, roleInfoBarLayout, roleSelectorLayout, attrAllocateDialogLayout, T, uiSize } from "../../../configs/hudLayout";
import { applyColumnStyle, createText } from "./ui-parts";
import { createGlassPlate, createToneButton } from "./dialog-builder";
import { formatAttributeValue } from "./item-parts";

const ROLE_PREVIEW_EFFECT_SUFFIX = "_select_effect";

const ROLE_PREVIEW_SHOW_SUFFIX = "_show_animation";

/**
 * 角色预览容器下的三个子节点名后缀（都由预览名派生）：
 * 站立帧 / 选中展示帧 / 脚下选中特效。切换选中态时按名字找、不缓存引用
 * （选角列表重建会换掉整棵节点树，存引用就得自己管失效）
 */
const ROLE_PREVIEW_STAND_SUFFIX = "_stand_animation";

/** 底部功能按钮（数据见 configs/bottomNav.bottomNavItems，这里补上点击回调——回调是代码不是配置） */
export interface BottomNavBarButton extends BottomNavItem {
  /** 点击回调 */
  onClick: () => void;
}

  /**
   * 创建货币显示零件（图标 + 名称 + 数值，内容在零件内左对齐）
   *
   * 稿 `.info .cur`：金色小方块图标 + 「绑定元宝」说明字（11px text-3）+ 数值（11px 金-4）。
   * 名称是可选的：不传 spec.label 就是旧口径（只有图标 + 数值）。
   * @param icon 货币图标资源路径
   * @param value 数值
   * @param position 零件中心位置
   * @param size 零件尺寸（父容器等分时传容器宽度/份数）
   * @param spec 图标尺寸 / 名称 / 数值的配色与宽度（见 hudLayout.roleInfoBarLayout.currencyBar）
   */
export function createCurrencyItem(
    icon: string,
    value: string | number,
    position: Vec2 = new Vec2(),
    size: Size = new Size(43, 12),
    spec?: {
      iconSize?: Size;
      label?: { text: string; fontSize: number; color: Color; width: number; gap: number };
      value?: { fontSize: number; color: Color; gap: number };
    },
  ) {
    const node = UiHelper.createNode("currency_item", position, size);
    const iconSize = spec?.iconSize ?? new Size(15, 10);
    const left = -size.width / 2;
    node.addChild(UiHelper.createSprite("currency_icon", icon, new Vec2(left + iconSize.width / 2, 0), iconSize));
    let cursor = left + iconSize.width;
    if (spec?.label) {
      cursor += spec.label.gap;
      node.addChild(
        UiHelper.createLabel(
          "currency_label",
          spec.label.text,
          spec.label.color,
          spec.label.fontSize,
          new Vec2(cursor + spec.label.width / 2, 0),
          new Size(spec.label.width, size.height),
          Label.HorizontalAlign.LEFT,
        ),
      );
      cursor += spec.label.width;
    }
    cursor += spec?.value?.gap ?? 3;
    const valueNode = UiHelper.createLabel(
      "currency_value",
      value.toString(),
      spec?.value?.color ?? Color.WHITE,
      spec?.value?.fontSize ?? 12,
      new Vec2(cursor, 0),
      new Size(Math.max(10, size.width / 2 - cursor), size.height),
      Label.HorizontalAlign.LEFT,
    );
    valueNode.getComponent(UITransform).setAnchorPoint(0, 0.5);
    node.addChild(valueNode);
    return { node, valueLabel: valueNode.getComponent(Label) };
  }

  /**
   * 创建战斗力显示零件（`战斗力` 小字标签在上、红色数值在下，**右对齐**贴信息栏右缘）
   * 图标尺寸见 hudLayout.roleInfoBarLayout.combat.iconSize
   * @return node 零件节点、combatLabel 战斗力文本（供刷新）
   */
export function createCombatPower(role: Role, position: Vec2 = new Vec2()) {
    const layout = roleInfoBarLayout.combat;
    const node = UiHelper.createNode("combat_power", position);
    // 战斗力数字用默认字体（曾引用 font/combat 数字图集，素材包里从来没有过这个资源，
    // 加载恒失败后静默回退——2026-10-26 资源引用审计把它当断链清掉；要上数字图集先补素材）
    // 新稿口径：`战斗力` 小字标签在上、红色数值在下，纯文字无图标、整块右对齐
    const labelNode = UiHelper.createLabel("combat_label", layout.label.text, layout.label.color, layout.label.fontSize, layout.label.position, layout.label.size, Label.HorizontalAlign.RIGHT);
    const label = labelNode.getComponent(Label);
    if (label) label.spacingX = layout.label.spacingX;
    node.addChild(labelNode);
    const valueNode = UiHelper.createLabel("combat_number", role.combat.toString(), layout.value.color, layout.value.fontSize, layout.value.position, layout.value.size, Label.HorizontalAlign.RIGHT);
    node.addChild(valueNode);
    return { node, combatLabel: valueNode.getComponent(Label)! };
  }

  /**
   * 创建角色头像（按职业与性别取图，尺寸见 hudLayout.roleInfoBar.portrait）
   * 稿 `.info .avatar`：54×58、1px 金-2 边框 + 深褐渐变底 —— 头像图叠在金线框里，
   * 边框用「填外框再内缩填底」画（1px 描边在实机不渲染）
   */
export function createAvatarPortrait(role: Role, position: Vec2 = new Vec2(), size: Size = roleInfoBarLayout.portrait.size) {
    const frame = UiHelper.createNode(`role_avatar_${role.occupation}_${role.sex}`, position, size);
    const layout = roleInfoBarLayout.portrait;
    const graphics = frame.addComponent(Graphics);
    graphics.fillColor = layout.border;
    graphics.roundRect(-size.width / 2, -size.height / 2, size.width, size.height, T.radius.r2);
    graphics.fill();
    graphics.fillColor = T.surface[3];
    graphics.roundRect(-size.width / 2 + 1, -size.height / 2 + 1, size.width - 2, size.height - 2, Math.max(0, T.radius.r2 - 1));
    graphics.fill();
    const portrait = UiHelper.createSprite("role_avatar_art", avatarImage(role.occupation, role.sex), new Vec2(), new Size(size.width - 2, size.height - 2));
    portrait.getComponent(Sprite)!.trim = true;
    frame.addChild(portrait);
    return frame;
  }

  /** 创建装备插槽（名称即装备类型，便于按类型查找） */
export function createEquipmentSlot(type: EQUIPMENT_TYPE, imageSrc: string, size: Size = equipmentSlotLayout.slotSize) {
    const slot = UiHelper.createSprite(`equipment_slot_${type}`, imageSrc, new Vec2(), size);
    slot.name = type;
    return slot;
  }

  /**
   * 创建装备槽的「更好装备」提示角标（槽位右上角的小圆牌，几何与配色见 configs/layout/panels.equipmentSlotLayout.upgradeHint）
   * 只负责创建（默认隐藏，显隐由 EquipmentSlotGroup.updateUpgradeHint 控制）：
   * Graphics 自绘圆底（不依赖底图）+ 文案（configs/texts.label_equip_upgrade_hint）
   */
export function createEquipmentUpgradeHint() {
    const layout = equipmentSlotLayout.upgradeHint;
    const node = UiHelper.createNode("equipment_upgrade_hint", layout.position, layout.size);
    const plate = new Node("equipment_upgrade_hint_plate");
    const graphics = plate.addComponent(Graphics);
    // 圆形边框同样走「填外圈 → 内缩填主体」（1px 级 stroke 实机不渲染）
    graphics.fillColor = layout.borderColor;
    graphics.circle(0, 0, layout.size.width / 2);
    graphics.fill();
    graphics.fillColor = layout.fill;
    graphics.circle(0, 0, layout.size.width / 2 - layout.borderWidth);
    graphics.fill();
    node.addChild(plate);
    node.addChild(UiHelper.createLabel("equipment_upgrade_hint_text", getText("label_equip_upgrade_hint"), layout.color, layout.fontSize, new Vec2(), layout.size));
    node.active = false;
    return node;
  }



  /**
   * 创建加载进度文本零件（一行字，百分比显示）
   * @return node 零件节点、progressLabel 进度文本（供刷新）
   */
export function createLoadingProgress(text: string, position: Vec2 = new Vec2(), fontSize: number = 32) {
    const node = UiHelper.createLabel("loading_progress", text, Color.WHITE, fontSize, position, new Size(960, 50));
    return { node, progressLabel: node.getComponent(Label) };
  }



  /**
   * 创建角色预览效果（选角界面：未选中播站立帧、选中播展示帧 + 脚下特效）
   * 帧动画走 AnimationHelper：素材是 TexturePacker 图集（plist），按帧名末尾序号排序后循环播放
   * 帧加载是异步的（已缓存时微任务内即完成），装载完成时节点已销毁/已标记销毁则静默跳过
   *
   * 容器用**普通节点**（不是 `UiHelper.createEmptyNode`）：后者是核对体积用的调试节点，
   * 会无条件画一圈纯红 4px 边框，挂到选角界面上就是角色四周一个去不掉的红框（#455）。
   *
   * 选中态由 `setRolePreviewSelected` 切换 —— 展示帧与脚下特效都是**首次选中才建**，
   * 列表里没被选过的角色不额外占图集内存（图集帧与片段装载后走全局缓存，切角色不重复读盘）
   * @param name 预览名（同时作为动画节点名前缀；选中态那两个子节点按它派生名字，切换时按名字找）
   * @param level 等级（预览动画与等级无关，保留参数以兼容调用方）
   * @param occupation 职业
   * @param sex 性别
   */
export function createRolePreview(name: string, level: number, occupation: string = "1", sex: string = "1", position: Vec2 = new Vec2(), size: Size = new Size()) {
    const role = UiHelper.createNode(name, position, size);
    const animationName = `${name}${ROLE_PREVIEW_STAND_SUFFIX}`;
    const node = createRoleFrameSprite(animationName);
    role.addChild(node);
    AnimationHelper.playLoopAtlas(animationName, node, createRolePreviewImage(occupation, sex), roleSelectorLayout.previewFrameRate);
    // 角色预览本身是可点元素（选角列表点击切换角色），鼠标通道补一次命中拦截
    // 点击音同理（#685）：点角色卡就是点按钮
    SoundManager.bindClick(role);
    blockClickThrough(role);
    return role;
  }

  /**
   * 切换角色预览的选中态
   *
   * 选中：站立帧隐藏、展示帧（show）循环播放，脚底循环 `select_player@0`；
   * 取消：反过来（展示帧与特效隐藏，节点留着下次复用，不销毁 —— 列表滚动/反复点选不该反复建节点）。
   * 展示帧**等帧装载好再藏站立帧**：否则首次选中会有一段「站立已藏、展示帧还没到」的空白。
   * @param preview createRolePreview 返回的容器节点
   * @param selected 是否选中
   * @param occupation 职业（show 图集按它取，取消选中时可传默认值）
   * @param sex 性别
   */
export function setRolePreviewSelected(preview: Node, selected: boolean, occupation: string = "1", sex: string = "1") {
    if (!isValid(preview, true)) return;
    const stand = preview.getChildByName(`${preview.name}${ROLE_PREVIEW_STAND_SUFFIX}`);
    const showName = `${preview.name}${ROLE_PREVIEW_SHOW_SUFFIX}`;
    const show = preview.getChildByName(showName);
    if (!selected) {
      if (show) show.active = false;
      const effect = preview.getChildByName(`${preview.name}${ROLE_PREVIEW_EFFECT_SUFFIX}`);
      if (effect) effect.active = false;
      if (stand && !stand.active) {
        stand.active = true;
        replayRoleLoop(stand, `${preview.name}${ROLE_PREVIEW_STAND_SUFFIX}`, createRolePreviewImage(occupation, sex), roleSelectorLayout.previewFrameRate);
      }
      return;
    }
    const atlas = createRoleShowImage(occupation, sex);
    let target = show;
    if (!target) {
      target = createRoleFrameSprite(showName);
      preview.addChild(target);
    }
    // 先亮着（此时还没有帧 = 什么都不画），装载完成后再收掉站立帧，见函数头注释
    target.active = true;
    const showNode = target;
    AnimationHelper.loadFramesFromAtlas(atlas).then((frames) => {
      // 装载期间换了选中角色（showNode 已被藏起）或节点没了：这次装载作废
      if (!frames.length || !isValid(preview, true) || !isValid(showNode, true) || !showNode.active) return;
      if (stand) stand.active = false;
      replayRoleLoop(showNode, showName, atlas, roleSelectorLayout.selection.showFrameRate);
    });
    showRoleSelectEffect(preview, true);
  }

  /** 脚底选中特效：首次显示才建节点（垫在角色下面，地面圈不能压住脚） */
export function showRoleSelectEffect(preview: Node, visible: boolean) {
    const name = `${preview.name}${ROLE_PREVIEW_EFFECT_SUFFIX}`;
    let effect = preview.getChildByName(name);
    if (!visible) {
      if (effect) effect.active = false;
      return;
    }
    if (!effect) {
      effect = createRoleFrameSprite(name);
      preview.addChild(effect);
      // 层级：站立 0、展示 1、特效最后加 → 挪到最下面，才不会被角色挡住
      effect.setSiblingIndex(0);
    }
    // 位置与尺寸每次都对一遍（幂等）：配置改了即时生效，不用等重建节点
    const { offset, size } = roleSelectorLayout.selection.effect;
    effect.setPosition(offset.x, offset.y, 0);
    const sprite = effect.getComponent(Sprite);
    if (sprite && size.width > 0 && size.height > 0) {
      // 图集原画布只有 134×72，RAW 出图太小 → 按配置尺寸拉伸。
      // 必须 CUSTOM：RAW 会让节点尺寸跟着每帧的 sourceSize 走，配置的尺寸会被覆盖
      sprite.sizeMode = Sprite.SizeMode.CUSTOM;
      (effect.getComponent(UITransform) ?? effect.addComponent(UITransform)).setContentSize(size);
    }
    effect.active = true;
    replayRoleLoop(effect, name, roleSelectEffectImage, roleSelectorLayout.selection.effect.frameRate);
  }

  /**
   * 重播一个循环动画：**装过就直接 play**，没装过才走 AnimationHelper 装载
   *
   * 反复点选会让 `playLoopAtlas` 每次都 `addClip` 一遍 —— 同一别名会不断 new 出新的
   * AnimationState（片段是缓存共享的，状态不是），点几十次就攒几十份。所以这里先看节点上
   * 有没有这个片段：有就只重新 `play`（从头播），没有才装载。
   */
export function replayRoleLoop(node: Node, alias: string, atlasSrc: string, frameRate: number) {
    const animate = node.getComponent(Animation);
    if (animate?.getState(alias)) {
      animate.play(alias);
      return;
    }
    AnimationHelper.playLoopAtlas(alias, node, atlasSrc, frameRate);
  }

  /** 建一个「等着被帧动画填图」的 Sprite 节点（RAW + 不裁边：按图集原画布尺寸出图，帧间不抖动） */
export function createRoleFrameSprite(name: string) {
    const node = UiHelper.createSprite(name, "");
    const sprite = node.getComponent(Sprite);
    sprite.sizeMode = Sprite.SizeMode.RAW;
    sprite.trim = false;
    return node;
  }



  /**
   * 为已有节点施加底部导航按钮样式（组件自身即按钮时使用）
   * 新稿（04-hud）口径：**矢量底板按钮**（44×44 玻璃底板 + 功能名文字 + 右上角快捷键字母），
   * 不再用带烙字的图标图。解锁 = 金边亮金字；未解锁 = 灰边灰字（置灰语义由组件持 flag 判断）
   * @param node 目标节点
   * @param button 按钮配置
   * @param role 当前角色（用于判断功能是否解锁）
   * @returns 文字 Label 与是否未解锁（组件点击时据此提示等级）
   */
  /**
   * 底部导航 key → 描边图标（data 见 configs/layout/icons.ts，逐字抄设计稿）
   *
   * 未知 key 返回空形状（画不出东西，但不崩）——新增导航入口时记得在这里补一条
   */
export function navIconOf(key: string): VectorIconShape {
    const map: Record<string, VectorIconShape> = {
      role: icons.navRole,
      bag: icons.navBag,
      friend: icons.navFriend,
      group: icons.navGroup,
      skill: icons.navSkill,
      mall: icons.navMall,
      settings: icons.navSettings,
    };
    return map[key] ?? { paths: [] };
  }

export function applyBottomNavBarButtonStyle(node: Node, button: BottomNavBarButton, role: Role): { label: Label; locked: boolean } {
    const layout = bottomBarLayout.navButton;
    const uiTransform = node.getComponent(UITransform) ?? node.addComponent(UITransform);
    uiTransform.setContentSize(layout.size);
    const buttonComponent = node.getComponent(Button) ?? node.addComponent(Button);
    buttonComponent.transition = Button.Transition.SCALE;
    const locked = button.openLevel > role.level;
    // 底板与快捷格 / 小地图 rail 用**同一条发丝线**（稿 .nbtn 的 border 是 line-2）：
    // 早前这里按解锁态切 gold[2]，结果底栏自己的按钮比旁边技能格的边亮一档，一排里两种线
    const plate = createGlassPlate("nav_plate", layout.size, T.radius.r2, T.line[2]);
    node.addChild(plate);
    // 图标（稿 .nbtn .ic：16px 描边图，gold-3；未解锁置灰）
    const iconNode = UiHelper.createNode("nav_icon", layout.icon.position, layout.icon.size);
    drawVectorIcon(iconNode, navIconOf(button.key), layout.icon.size, locked ? T.text[4] : T.gold[3], 2);
    node.addChild(iconNode);
    const labelNode = UiHelper.createLabel("nav_label", button.label, locked ? T.text[3] : T.text[2], layout.label.fontSize, layout.label.position, layout.label.size);
    node.addChild(labelNode);
    node.addChild(UiHelper.createLabel("shortcut_key", button.shortcutKey, T.text[4], layout.key.fontSize, layout.key.position, layout.key.size));
    // 组件自身即按钮（点击走 TOUCH_END），鼠标通道补一次命中拦截，避免点底部栏时穿透到下层 UI
    blockClickThrough(node);
    return { label: labelNode.getComponent(Label)!, locked };
  }

  /**
   * 为已有节点施加自动挂机开关按钮样式（组件自身即按钮时使用）
   * 新稿（04-hud）口径：战斗列顶行的**细长横条**（与技能格等宽 256×26），矢量底板 +
   * 刀剑图标 + 「挂机」文字；底板边框与图标/文字颜色随挂机状态切换
   * （开 = 金 `#F3DEA6` + 金边，关 = text-2 + line-2），由组件拿返回值在 refresh 里改
   * @param node 目标节点
   * @returns 底板节点 / 外圈节点（开启态亮出，见 autoFight.onRing）/ 文字 Label / 图标换色（状态切换时重画）
   */
export function applyAutoFightButtonStyle(node: Node): { plate: Node; ring: Node; label: Label; setIconColor: (color: Color) => void } {
    const layout = bottomBarLayout.autoFight;
    const uiTransform = node.addComponent(UITransform);
    uiTransform.setContentSize(layout.size);
    node.setPosition(layout.position.x, layout.position.y, 0);
    // 开启态外圈（稿 `.auto.on` 的 box-shadow 0 0 0 1px）：比底板四周各大 1px 的空心描边板，
    // 常态隐藏、开启时亮出（显隐在组件 refresh 里切）
    const ring = createGlassPlate(
      "auto_fight_ring",
      new Size(layout.size.width + 2, layout.size.height + 2),
      T.radius.r2,
      layout.onRing,
      T.overlay.transparent,
    );
    ring.active = false;
    node.addChild(ring);
    const plate = createGlassPlate("auto_fight_plate", layout.size, T.radius.r2, T.line[2]);
    node.addChild(plate);
    // 图标（稿 `.auto svg{width:14px;height:14px}`，与文字同排）
    const iconNode = UiHelper.createNode("auto_fight_icon", layout.icon.position, layout.icon.size);
    const setIconColor = (color: Color) => drawVectorIcon(iconNode, icons.autoFight, layout.icon.size, color, layout.icon.stroke);
    setIconColor(T.text[2]);
    node.addChild(iconNode);
    const labelNode = UiHelper.createLabel("auto_fight_label", layout.label.text, T.text[2], layout.label.fontSize, layout.label.position, layout.label.size);
    const label = labelNode.getComponent(Label)!;
    label.spacingX = layout.label.spacingX;
    node.addChild(labelNode);
    // 组件自身即按钮（点击走 TOUCH_END），鼠标通道补一次命中拦截
    blockClickThrough(node);
    return { plate, ring, label, setIconColor };
  }



  /**
   * 矢量进度条（新稿口径，HUD 不再用进度条贴图）：深色圆角底 + 纯色圆角填充
   * 填充宽度随进度重画（Graphics 立即模式），进度更新走返回的 setProgress
   * @param name 元素名称
   * @param progress 初始进度（0~1）
   * @param position 位置
   * @param size 尺寸
   * @param fillColor 填充色（经验 = 金、生命 = 朱红）
   */
export function createVectorBar(name: string, progress: number, position: Vec2, size: Size, fillColor: Color): { node: Node; setProgress: (p: number) => void } {
    const node = UiHelper.createNode(name, position, size);
    const radius = Math.min(size.height / 2, 4);
    const drawBg = () => {
      const bg = node.addComponent(Graphics);
      // 1px 描边实机不渲染：外框色填整块 → 内缩填主体色（UiHelper.paintRoundedPanel）
      UiHelper.paintRoundedPanel(bg, size, radius, T.surface.scrim, T.line[1]);
    };
    drawBg();
    const fillNode = UiHelper.createNode(`${name}_fill`, new Vec2(-size.width / 2, 0), new Size(size.width - 4, size.height - 2));
    fillNode.getComponent(UITransform).setAnchorPoint(0, 0.5);
    const fill = fillNode.addComponent(Graphics);
    node.addChild(fillNode);
    const fillHeight = size.height - 2;
    const drawFill = (p: number) => {
      fill.clear();
      if (p <= 0) return;
      fill.fillColor = fillColor;
      fill.roundRect(0, -fillHeight / 2, Math.max((size.width - 4) * p, fillHeight), fillHeight, fillHeight / 2);
      fill.fill();
    };
    drawFill(progress);
    // 进度桥：同节点挂 ProgressBar 作为进度状态持有者（旧调用方按 getComponent(ProgressBar) 刷进度），
    // VectorBarBridge 每帧把 progress 同步给 drawFill —— 新旧两种刷入口都通
    const progressBar = node.addComponent(ProgressBar);
    progressBar.mode = ProgressBar.Mode.HORIZONTAL;
    progressBar.progress = progress;
    node.addComponent(VectorBarBridge).setProgress = drawFill;
    return { node, setProgress: drawFill };
  }

  /** 创建血条（矢量：暗底圆槽 + 朱红填充，头顶信息栏 / 怪物头顶共用；进度按 ProgressBar 组件刷） */
export function createHpBar(name: string, progress: number, position: Vec2 = new Vec2(), size: Size = new Size()) {
    return createVectorBar(name, progress, position, size, T.ember[3]).node;
  }

  /** 创建矢量小圆点（说明性图标 / 未读红点：替代 ui/common/dot 贴图） */
export function createVectorDot(name: string, color: Color, position: Vec2 = new Vec2(), size: Size = new Size(10, 10)) {
    const node = UiHelper.createNode(name, position, size);
    const graphics = node.addComponent(Graphics);
    graphics.fillColor = color;
    graphics.circle(0, 0, size.width / 2);
    graphics.fill();
    return node;
  }

  /**
   * 创建头部信息（返回纵向弹性容器，子节点自上而下：**军衔红字** / 血条 / 血量文字；
   * 称号名牌动画由 RoleDisplay.updateTitleShow 插进同一个容器的最上方，故后续读件一律按名字而不是按下标）
   * 角色名称不在这里 —— 与怪物名称同一套口径显示在人物区域正中间，见 createRoleName
   * 军衔红字排在最早就有的那个文字称号占位上（血条之上），样式取自 configs/layout/hud.roleShowLayout.rank
   * @param rank 当前军衔阶数（0 = 未授衔，红字留空，由 RoleDisplay.updateHead 负责后续填值）
   */
export function createHead(name: string, hp: number, maxHp: number, rank: number) {
    /** 头部信息栏父节点 */
    const head = UiHelper.createFlexCol(name, 3, new Vec2(0, 100), new Size(100, 0));
    head.getComponent(UITransform).setAnchorPoint(0.5, 0);
    /** 军衔红字（军衔的唯一外显：头顶这一行；未授衔时为空串，不占视觉） */
    const roleRank = UiHelper.createLabel("role_rank", getRankHeadText(rank), roleShowLayout.rank.color, roleShowLayout.rank.fontSize, new Vec2(), roleShowLayout.rank.size);
    head.addChild(roleRank);
    /** 血量进度条（两个字面名与 RoleDisplay.updateHead 的取件口径成对，改动请同步） */
    const roleHp = createHpBar("role_hp_bar", hp / maxHp, new Vec2(), new Size(80, 4));
    head.addChild(roleHp);
    /** 血量文字显示 */
    const roleHpText = UiHelper.createLabel("role_hp_text", `${hp} / ${maxHp}`, Color.WHITE, 8, new Vec2(), new Size(100, 8));
    head.addChild(roleHpText);
    return head;
  }

  /**
   * 创建角色名称（显示在**人物区域正中间**：与怪物名称同一套口径，见 createMonsterName，不进头顶信息栏）
   * 位置/尺寸/字号取自 configs/layout/hud.roleShowLayout.name —— 纵坐标为 roleBody 高度的一半（身体几何中心），
   * roleBody 改尺寸时自动保持「正中间」；名称创建后不变（角色无改名），无需刷新链路
   */
export function createRoleName(role: Role) {
    const layout = roleShowLayout.name;
    return UiHelper.createLabel("role_name", role.name, layout.color, layout.fontSize, layout.position, layout.size);
  }

  /**
   * 头顶军衔红字的文案（未授衔返回空串；授衔后按 configs/texts 的 label_rank_head 模板套上军衔名）
   * createHead（建）与 RoleDisplay.updateHead（刷）共用它，两条路径同一个口径
   */
export function getRankHeadText(rank: number): string {
    const config = getRankLevel(rank);
    return config ? getText("label_rank_head", { rank: config.label }) : "";
  }

  /**
   * 创建属性标签
   * @param value 属性值：装备是固定值 [v, v]、角色等级属性是浮动区间 [min, max]
   */
export function createAttributeLabel(key: keyof BattleAttributes, value: readonly number[] | number, size: Size = new Size(220, 20)) {
    const attributeLabel = UiHelper.createFlexRow(key, 10, new Vec2(), size);

    const icon = createVectorDot("icon", T.gold[3], new Vec2(), new Size(10, 10));
    attributeLabel.addChild(icon);

    const label = UiHelper.createLabel(key, goodShowAttributesLabel.get(key), Color.WHITE, 12, new Vec2(), new Size(50, size.height));
    label.getComponent(Label).horizontalAlign = Label.HorizontalAlign.LEFT;
    attributeLabel.addChild(label);

    const attribute = UiHelper.createLabel(key, formatAttributeValue(value), Color.WHITE, 12, new Vec2(), new Size(size.width - 20 - 50 - 10, size.height));
    attributeLabel.addChild(attribute);

    return attributeLabel;
  }

  /**
   * 为已有节点施加"角色属性列表"样式并填充属性条目（组件自身即列表容器时使用）
   * 结构：基础属性标题 + 各属性行
   *
   * **不再有「特殊属性」分节标题**（#470）：那一节从来没有行跟着（全仓只有这一处
   * 调用 `createAttributeLabel`），空标题白占一行高度，还正好压在最上面那枚功能按钮上。
   * 等特殊属性真的接入（幸运 / 准确之类）时再加标题 —— 加的时候同步 `roleAttributeListLayout`
   * 的高度上限，见那份配置的注释。
   * @param node 目标节点
   * @param role 角色数据
   * @param position 位置
   * @param size 尺寸
   * @returns 该节点的 Layout 组件
   */
export function applyRoleAttributeListStyle(node: Node, role: Role, position: Vec2 = roleAttributeListLayout.position, size: Size = roleAttributeListLayout.size) {
    const layout = applyColumnStyle(node, roleAttributeListLayout.spacing, position, size);
    layout.resizeMode = Layout.ResizeMode.CONTAINER;
    layout.padding = roleAttributeListLayout.padding;
    node.getComponent(UITransform).setAnchorPoint(0.5, 1);
    // 重复调用即刷新（装备穿脱等改变属性后重建条目，旧条目真正销毁）
    clearChildren(node);
    node.addChild(createText("role_basic_attributes", getText("label_attributes_base"), 14, new Vec2(), new Size(size.width, roleAttributeListLayout.titleHeight)));
    for (const element of goodShowAttributesLabel.keys()) {
      node.addChild(createAttributeLabel(element, role[element], new Size(size.width, roleAttributeListLayout.rowHeight)));
    }
    return layout;
  }



  /**
   * 使用角色动画（按游戏配置 roleAnimationMap 切割帧动画）
   * @param name 首次播放动画名称
   * @param node 播放动画的节点
   * @param dirSrc 动画帧存放的文件夹
   * @param speedRate 速度倍率
   * @param onReady 片段装上并起播后的回调（同步就绪立即回调、异步装载完成回调）
   * @param isStale 异步装载完成后的作废判断（见 AnimationHelper.useManyNameAnimation）
   */
export function useRoleAnimation(name: string, node: Node, dirSrc: string, speedRate: SpeedRate, onReady?: () => void, isStale?: () => boolean) {
    return AnimationHelper.useRoleAnimation(name, node, dirSrc, speedRate, onReady, isStale);
  }

  /**
   * 使用怪物动画（按游戏配置 monsterAnimation 切割帧动画）
   * @param name 首次播放动画名称
   * @param node 播放动画的节点
   * @param dirSrc 动画帧存放的文件夹
   * @param speedRate 速度倍率
   */
export function useMonsterAnimation(name: string, node: Node, dirSrc: string, speedRate: SpeedRate) {
    return AnimationHelper.useMonsterAnimation(name, node, dirSrc, speedRate);
  }



  /** 为快捷键节点附加图标样式与按键名，返回冷却倒计时文字引用（几何见 hudLayout.bottomBar.shortcutSlot） */
export function applyShortcutKeyStyle(node: Node, label: string) {
    const layout = bottomBarLayout.shortcutSlot;
    // 槽位本体是裸 Node（ShortcutKeySlot extends Node），矢量改造后不再挂 Sprite，
    // 所以 UITransform 得自己补 —— 以前是靠 addComponent(Sprite) 的 @requireComponent 顺带带出来的
    (node.getComponent(UITransform) ?? node.addComponent(UITransform)).setContentSize(layout.size);
    // 底板与导航按钮同一条发丝线（稿 .sslot 的 border 是 line-2）
    node.addChild(createGlassPlate("slot_plate", layout.size, T.radius.r1, T.line[2]));
    const iconNode = UiHelper.createSprite("slot_icon", "", new Vec2(), layout.size);
    node.addChild(iconNode);
    // 空槽占位（稿 `.sslot.is-empty`：12px text-4 的槽位名）；绑上技能后由组件隐藏
    const emptyNode = UiHelper.createLabel("shortcut_empty", layout.emptyText, layout.emptyColor, layout.emptyFontSize, new Vec2(0, 2), new Size(layout.size.width, 16));
    node.addChild(emptyNode);
    // 快捷键字母与冷却倒计时（稿 .sslot .k = text-4；冷却字 = text-2）
    node.addChild(UiHelper.createLabel("shortcut_key_label", label, T.text[4], layout.key.fontSize, layout.key.position, layout.key.size));
    const cooldownNode = UiHelper.createLabel("shortcut_key_cooldown", "", T.text[2], layout.cooldown.fontSize, layout.cooldown.position, layout.cooldown.size);
    cooldownNode.active = false;
    node.addChild(cooldownNode);
    // 组件自身即按钮（点击走 TOUCH_END），鼠标通道补一次命中拦截
    blockClickThrough(node);
    return { cooldownLabel: cooldownNode.getComponent(Label), iconSprite: iconNode.getComponent(Sprite)!, emptyLabel: emptyNode.getComponent(Label)! };
  }



  /**
   * 创建血量/魔法值文字零件
   * 位置/尺寸/字号由调用方传自各自球布局的 text（见 hudLayout.bottomBar.hpOrb.text / mpOrb.text，
   * 坐标相对球心），默认值仅是兜底
   */
export function createHpText(text: string, position: Vec2 = new Vec2(), size: Size = new Size(120, 10), name = "hp_text", fontSize = 12) {
    const node = UiHelper.createLabel(name, text, T.text[1], fontSize, position, size);
    // 稿 `.orb-val` 是 text-shadow: 0 2px 4px #000 —— Label 没有投影，用 2px 深色描边近似，
    // 否则数值压在红色液面上（尤其满血时）会糊成一片
    const label = node.getComponent(Label);
    if (label) {
      label.enableOutline = true;
      label.outlineWidth = 2;
      label.outlineColor = T.surface[0];
    }
    return node;
  }

  /**
   * 创建圆形血量/魔法值显示零件（矢量球，见 createRoundOrb）
   */
  /**
   * 矢量圆形球（逐值对齐 design/olua-ui 的 `.orb`）：血球 / 魔法球不再用贴图
   *
   * 稿的球体是四层叠出来的，这里用同一个 Graphics 顺序画：
   *   1. 2px 古铜金外环（`border: 2px solid gold-2`）—— 先填金、再内缩 2px 填球腔
   *      （1px Stroke 在实机整条不渲染，见 drawGlassPlate 的引擎坑注释）
   *   2. 球腔：`radial-gradient(circle at 50% 34%, #2A1D12, #0C0805 72%)` —— Graphics 没有径向渐变，
   *      用「深底 + 偏上三层柔光圆」近似（圆心抬 6px，最大半径恰好落在环内，不溢出）
   *   3. 液面：内缩 5px 的圆形遮罩 + **竖向渐变**（亮端在上、深端在下，稿 `.orb--hp .orb-fill i`）
   *   4. 液面上沿 1px 黑圈（稿 `.orb::after{inset:6px}`，画在液面之上）
   *
   * @param progress 初始进度（0~1）
   * @param position 位置
   * @param size 球尺寸（宽高相等）
   * @param fillTop 液面亮端（血 = hpHi / 法力 = mpHi）
   * @param fillBottom 液面深端（血 = ember1 / 法力 = frostDeep）
   * @returns 球节点与进度刷新（节点含球体与液面，数值文字由调用方另挂）
   */
export function createRoundOrb(
    progress: number,
    position: Vec2,
    size: Size,
    fillTop: Color,
    fillBottom: Color,
    skin: typeof bottomBarLayout.orb = bottomBarLayout.orb,
  ): { node: Node; setProgress: (p: number) => void } {
    const radius = size.width / 2;
    const node = UiHelper.createNode("orb", position, size);
    const rim = skin.rim;
    const base = node.addComponent(Graphics);
    // 1) 外金环 + 球腔深底
    base.fillColor = T.gold[2];
    base.circle(0, 0, radius);
    base.fill();
    base.fillColor = T.surface[1];
    base.circle(0, 0, radius - rim);
    base.fill();
    // 2) 球腔柔光（圆心上移，半径加起来不超过 rim 内沿，正好不外溢）
    const cavity = radius - rim;
    for (const layer of skin.sheen) {
      const tint = layer.color.clone();
      tint.a = layer.alpha;
      base.fillColor = tint;
      base.circle(0, skin.sheenCenterY, Math.round((cavity - skin.sheenCenterY) * layer.scale));
      base.fill();
    }
    // 3) 液面：圆形遮罩（GRAPHICS_STENCIL）+ 底部对齐的竖向渐变条
    //
    // **顺序不能反**：Mask 的 stencil 图形取的是「节点上已有的 Graphics」（引擎 Mask._createGraphics
    // 里 `getComponent(Graphics) ?? addComponent(Graphics)`）。所以必须先把 Graphics 挂上、再设 type，
    // 否则设 type 时引擎会自建一个空白 Graphics 当 stencil，而我们的圆画在第二个 Graphics 上 ——
    // 模板里什么都没有，液面矩形就整块露出来（2026-11-16 浏览器实测：血球/魔法球渲染成纯色方块）
    const innerRadius = radius - skin.liquidInset;
    const maskNode = UiHelper.createNode("orb_mask", new Vec2(), new Size(innerRadius * 2, innerRadius * 2));
    const stencil = maskNode.addComponent(Graphics);
    const mask = maskNode.addComponent(Mask);
    mask.type = Mask.Type.GRAPHICS_STENCIL;
    stencil.clear();
    stencil.circle(0, 0, innerRadius);
    stencil.fill();
    node.addChild(maskNode);
    const liquidNode = UiHelper.createNode("orb_liquid", new Vec2(0, -innerRadius), new Size(innerRadius * 2, innerRadius * 2));
    const liquid = liquidNode.addComponent(Graphics);
    maskNode.addChild(liquidNode);
    // 渐变条数：横条越多越平滑（同一个 Graphics，DrawCall 不变）
    const gradientSteps = skin.gradientSteps;
    /** 液面颜色插值：t = 0 顶部（亮端）→ 1 底部（深端）；稿的深端停在 70% 处不再变暗 */
    const colorAt = (t: number) => {
      const k = Math.min(1, t / skin.gradientStop);
      const mix = (a: number, b: number) => Math.round(a + (b - a) * k);
      return new Color(mix(fillTop.r, fillBottom.r), mix(fillTop.g, fillBottom.g), mix(fillTop.b, fillBottom.b), 255);
    };
    const drawLiquid = (p: number) => {
      liquid.clear();
      if (p <= 0) return;
      const height = Math.max(innerRadius * 2 * p, 1);
      const strip = height / gradientSteps;
      for (let i = 0; i < gradientSteps; i++) {
        // node 坐标 y 向上：i = 0 是**最下面**那条 → 颜色取「离顶部最远」
        liquid.fillColor = colorAt(1 - (i + 0.5) / gradientSteps);
        liquid.rect(-innerRadius, i * strip, innerRadius * 2, strip + 0.5);
        liquid.fill();
      }
    };
    drawLiquid(progress);
    // 4) 液面上沿的黑圈（稿 .orb::after：inset 6px、1px 黑）——2px 描边才渲染得出来
    //    （同一节点不能挂两个 Graphics，单独开一个子节点，排在液面之后即压在液面上）
    const ringNode = UiHelper.createNode("orb_ring", new Vec2(), size);
    const ring = ringNode.addComponent(Graphics);
    ring.lineWidth = skin.ringWidth;
    ring.strokeColor = T.surface.scrim;
    ring.circle(0, 0, radius - skin.ringInset);
    ring.stroke();
    node.addChild(ringNode);
    return { node, setProgress: drawLiquid };
  }



  /** 创建主角衣服展示节点 */
export function createRoleClothNode() {
    const cloth = UiHelper.createSprite("cloth", "");
    cloth.getComponent(Sprite).sizeMode = Sprite.SizeMode.RAW;
    return cloth;
  }

  /** 创建主角武器展示节点 */
export function createRoleWeaponNode() {
    const weapon = UiHelper.createSprite("weapon", "");
    weapon.getComponent(Sprite).sizeMode = Sprite.SizeMode.RAW;
    return weapon;
  }

  /**
   * 创建属性点标签（#833）：加点弹窗顶部一行「属性点：N」
   *
   * 与 `createSkillPointsLabel` 同款：返回节点，调用方自己拿 Label 改数字 ——
   * 加完点只改这一行 + 重建四行，不重开弹窗。
   */
export function createAttrPointsRow(): Node {
    const cfg = attrAllocateDialogLayout.points;
    const row = UiHelper.createNode(cfg.name, new Vec2(0, cfg.y), new Size(cfg.width, cfg.height));
    const label = UiHelper.createLabel(
      `${cfg.name}_label`,
      getText("label_attr_points_left"),
      cfg.label.color,
      cfg.label.fontSize,
      new Vec2(cfg.label.x, 0),
      new Size(cfg.label.width, cfg.height),
      Label.HorizontalAlign.LEFT,
    );
    row.addChild(label);
    // 数值单独一枚标签：加完点只改这一枚（调用方按 name 拿 Label）
    const value = UiHelper.createLabel(
      cfg.value.name,
      "",
      cfg.value.color,
      cfg.value.fontSize,
      new Vec2(cfg.value.x, 0),
      new Size(cfg.value.width, cfg.height),
      Label.HorizontalAlign.RIGHT,
    );
    row.addChild(value);
    return row;
  }

  /**
   * 属性总览的一行（22 稿 .attr-grid .kv）：金点 + 名称 + 数值
   *
   * 与 `createAttributeLabel` 同款视觉（金点 + 白名 + 数值），但不绑 BattleAttributes
   * 显示名表 —— 总览里还有「魔法上限 / 战斗力」两个表外键，文案与数值都由调用方给。
   */
export function createAttrOverviewRow(name: string, labelText: string, valueText: string, valueGold = false): Node {
    const cfg = attrAllocateDialogLayout.overview.row;
    const row = UiHelper.createFlexRow(name, 10, new Vec2(), new Size(cfg.width, cfg.height));
    row.addChild(createVectorDot("icon", T.gold[3], new Vec2(), new Size(10, 10)));
    const label = UiHelper.createLabel(
      `${name}_label`,
      labelText,
      Color.WHITE,
      cfg.fontSize,
      new Vec2(),
      new Size(cfg.labelWidth, cfg.height),
      Label.HorizontalAlign.LEFT,
    );
    row.addChild(label);
    const value = UiHelper.createLabel(
      `${name}_value`,
      valueText,
      valueGold ? T.gold[4] : Color.WHITE,
      cfg.fontSize,
      new Vec2(),
      new Size(cfg.width - 20 - cfg.labelWidth - 10, cfg.height),
      Label.HorizontalAlign.RIGHT,
    );
    row.addChild(value);
    return row;
  }

  /**
   * 创建四维的一行（#833）：名称 · 已分配点数 · 作用说明 · 「+」
   *
   * 作用说明只写短语（「物理攻击」），**不写百分比**：系数在服务端
   * （`growth_scalars.attrPointRatio`，运营随时改），界面上写死「每点 +0.5%」
   * 就是第二个真相 —— 改配置那天它会开始骗人。
   *
   * 「+」按钮点了就发一次「加 1 点」的请求（服务端判够不够）。点数不足时按钮**不禁用**：
   * 点一下收到 20037 的提示，比一个悄悄灰掉的按钮好懂（与技能升级同一个取舍）。
   */
export function createAttrPointRow(role: Role, key: AttrPointKey, onAdd: () => void): Node {
    const cfg = attrAllocateDialogLayout.row;
    const node = UiHelper.createNode(`attr_row_${key}`, new Vec2(), new Size(cfg.width, cfg.height));
    const left = -cfg.width / 2;
    // 名称（左对齐）：贴行左缘，宽度按最长的「精神」留
    const name = UiHelper.createLabel(
      `${key}_name`,
      getText(`label_attr_${key}`),
      Color.WHITE,
      cfg.nameFontSize,
      new Vec2(left + cfg.nameWidth / 2, 0),
      new Size(cfg.nameWidth, cfg.height),
    );
    name.getComponent(Label).horizontalAlign = Label.HorizontalAlign.LEFT;
    node.addChild(name);
    // 已分配点数：固定一格居中，数字从 1 位涨到 3 位也不会把后面的说明挤走
    node.addChild(
      UiHelper.createLabel(
        `${key}_value`,
        String(role.attrs?.[key] ?? 0),
        Color.WHITE,
        cfg.valueFontSize,
        new Vec2(left + cfg.nameWidth + cfg.valueWidth / 2, 0),
        new Size(cfg.valueWidth, cfg.height),
      ),
    );
    // 作用说明（左对齐、小字）
    const descX = left + cfg.nameWidth + cfg.valueWidth;
    const desc = UiHelper.createLabel(
      `${key}_desc`,
      getText(`label_attr_${key}_desc`),
      Color.WHITE,
      cfg.descFontSize,
      new Vec2(descX + cfg.descWidth / 2, 0),
      new Size(cfg.descWidth, cfg.height),
    );
    desc.getComponent(Label).horizontalAlign = Label.HorizontalAlign.LEFT;
    node.addChild(desc);
    // 「+」按钮：贴行右缘
    const addCfg = cfg.add;
    const addButton = createToneButton(
      `${key}_add_button`,
      addCfg.label,
      new Vec2(cfg.width / 2 - addCfg.width / 2, 0),
      new Size(addCfg.width, addCfg.height),
      uiSize.smallButtonFontSize,
      buttonTone.normal,
    );
    addButton.on(Node.EventType.TOUCH_END, onAdd);
    // 剩余点数为 0：「＋」置灰不可点（22 稿的禁用画法，06 稿精神行同款）。
    // #833 原取舍是「不禁用、点了收 20037 提示」，#1108 按认可稿推翻：置灰是即时反馈，
    // 不用点一下才知道没点可加；服务端校验仍是权威（客户端置灰只是省一次必拒的请求）。
    if ((role.attrPoints ?? 0) <= 0) {
      addButton.getComponent(Button).interactable = false;
      addButton.addComponent(UIOpacity).opacity = 110;
    }
    node.addChild(addButton);
    return node;
  }

  /**
   * 创建四维行的容器（#833）
   *
   * 不是 ScrollView：只有四行，还要滚就是给自己找麻烦。锚点左上、行由调用方按行序摆
   * （`createAttrPointRow` 返回的行内部坐标以自己中心为原点）。
   */
export function createAttrListView(): Node {
    const cfg = attrAllocateDialogLayout.list;
    const node = UiHelper.createNode(cfg.name, new Vec2(), cfg.size);
    return node;
  }
