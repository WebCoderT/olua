/**
 * 弹窗骨架与按钮零件：弹窗框/玻璃板/眉题/页脚/按钮五档/悬停详情行/物品详情弹窗
 *
 * 由 GameUiHelper.ts 按域拆出（epic #1115 批次 1，机械搬移零行为变化）：
 * 原类 static 方法改为模块函数；调用方仍经 GameUiHelper 默认导出使用，本文件不直接消费。
 */


import { Button, Color, Graphics, instantiate, isValid, Label, Layout, Node, Size, UITransform, Vec2 } from "cc";
import UiHelper from ".././UiHelper";
import VectorPlate from "../../components/common/VectorPlate";
import DialogFrame from "../../components/dialogs/DialogFrame";
import DialogFoot from "../../components/dialogs/DialogFoot";
import { getText } from "../../../configs/texts";
import { monsterLabelOf } from "../../../configs/game-config";
import { Equipment, Goods, isEquipment } from "../../../types/good";
import SoundManager from "../../core/SoundManager";
import { blockClickThrough } from "../../utils/input/UiHit";
import { goodShowAttributes } from "../../../configs/good";
import { equipmentAttributeDiffs, equipmentCombatValue, equipmentSlots, formatSignedAttributeValue, getEquipmentNameParts, getRecyclePrice } from "../../../configs/equipments";
import LayerManager from "../../core/LayerManager";
import { getPopupPosition } from "../../utils/layout/ScreenLayout";
import { ButtonTone, buttonStyle, buttonTone, dialogFrame, goodDetailLayout, hoverTipLayout, T, uiSize } from "../../../configs/hudLayout";
import { BagCellMeta } from "../../../configs/items";
import { createRow } from "./ui-parts";
import { applyBackgroundEffect, createEquipmentDetailBackground, createGoodTagRow, formatAttributeValue, formatOriginTime } from "./item-parts";
import { createAttributeLabel, createVectorDot } from "./role-parts";

/**
   * 为已有节点施加悬停详情弹窗主体样式（尺寸/背景/内边距见 configs/layout/dialogs 的 hoverTipLayout）
   * 节点自身即弹窗背景（矢量底板，VectorPlate 随内容尺寸重画），纵向 Layout 容器按内容自适应高度
   */
export function applyHoverTipBodyStyle(node: Node) {
    const transform = node.addComponent(UITransform);
    transform.setContentSize(hoverTipLayout.size);
    node.addComponent(VectorPlate);
    const layout = node.addComponent(Layout);
    layout.type = Layout.Type.VERTICAL;
    layout.resizeMode = Layout.ResizeMode.CONTAINER;
    layout.verticalDirection = Layout.VerticalDirection.TOP_TO_BOTTOM;
    layout.padding = hoverTipLayout.padding;
    layout.spacingY = hoverTipLayout.rowSpacing;
  }

  /** 创建悬停详情标题行（左图标 + 加粗标题；无图标时标题独占整行） */
export function createHoverTipTitle(text: string, icon?: string): Node {
    const layout = hoverTipLayout.title;
    const header = createRow("hover_tip_header", 8, new Vec2(), new Size(hoverTipLayout.row.size.width, layout.iconSize.height));
    if (icon) header.addChild(UiHelper.createSprite("hover_tip_icon", icon, new Vec2(), layout.iconSize));
    const iconWidth = icon ? layout.iconSize.width + 8 : 0;
    const title = UiHelper.createLabel("hover_tip_title", text, Color.WHITE, layout.fontSize, new Vec2(), new Size(hoverTipLayout.row.size.width - iconWidth, layout.iconSize.height), Label.HorizontalAlign.LEFT, Label.VerticalAlign.CENTER);
    title.getComponent(Label).isBold = true;
    header.addChild(title);
    return header;
  }

  /** 创建悬停详情信息行（「名称：值」单行左对齐） */
export function createHoverTipRow(text: string): Node {
    const layout = hoverTipLayout.row;
    return UiHelper.createLabel("hover_tip_row", text, Color.WHITE, layout.fontSize, new Vec2(), layout.size, Label.HorizontalAlign.LEFT, Label.VerticalAlign.CENTER);
  }

  /** 创建悬停详情描述（自动换行，高度按内容自适应） */
export function createHoverTipDescription(text: string): Node {
    const layout = hoverTipLayout.description;
    const node = UiHelper.createLabel("hover_tip_description", text, Color.WHITE, layout.fontSize, new Vec2(), layout.size, Label.HorizontalAlign.LEFT, Label.VerticalAlign.TOP);
    const label = node.getComponent(Label)!;
    label.lineHeight = layout.lineHeight;
    label.overflow = Label.Overflow.RESIZE_HEIGHT;
    label.enableWrapText = true;
    return node;
  }




  /**
   * HUD 常驻件底板（半透明暖褐 + 一圈弱金线，无铆钉）
   *
   * 对齐 `design/olua-ui` 的 `.surface-glass` 用法：HUD 上的信息栏 / 怪物条 / 底部栏都靠它
   * 从世界里「浮」出来，但不该像弹窗那样抢视线 —— 因此不画铆钉、线只到 line-2。
   */
export function createGlassPlate(name: string, size: Size, radius: number, border: Color = T.line[2], fill: Color = T.surface.glass) {
    const node = UiHelper.createNode(name, new Vec2(), size);
    drawGlassPlate(node.addComponent(Graphics), size, radius, border, fill);
    return node;
  }

  /**
   * 重绘玻璃底板（Graphics 是立即模式：状态切换要换边框颜色时不能只改 strokeColor，必须清掉重画）
   * @param plate createGlassPlate 返回的底板节点
   */
export function restyleGlassPlate(plate: Node, size: Size, radius: number, border: Color) {
    const graphics = plate?.getComponent(Graphics);
    if (!graphics) return;
    graphics.clear();
    drawGlassPlate(graphics, size, radius, border);
  }

  /** 玻璃底板绘制（建与重绘共用一套几何与配色） */
export function drawGlassPlate(graphics: Graphics, size: Size, radius: number, border: Color, fill: Color = T.surface.glass) {
    const left = -size.width / 2;
    const bottom = -size.height / 2;
    const bw = Math.max(1, T.border.width);
    // ⚠️ 引擎坑：Graphics 的 **1px 描边整条不渲染**（2px 正常）——稿里的 1px 古铜发丝线
    // 用 stroke 画在实机上是不可见的（弹窗、rail、视口框全都「没有边框」就是这个原因）。
    // 这里改成「先按描边色填满整块，再内缩 1px 填主体色」，得到恒 1px 的清晰边线。
    if (border.a > 0 && fill.a > 0) {
      graphics.fillColor = border;
      graphics.roundRect(left, bottom, size.width, size.height, radius);
      graphics.fill();
      graphics.fillColor = fill;
      graphics.roundRect(left + bw, bottom + bw, size.width - bw * 2, size.height - bw * 2, Math.max(0, radius - bw));
      graphics.fill();
      return;
    }
    if (fill.a > 0) {
      graphics.fillColor = fill;
      graphics.roundRect(left, bottom, size.width, size.height, radius);
      graphics.fill();
    }
    if (border.a > 0) {
      // 透明填充（只描边的视口框）：四条 1px 实心窄条 —— 圆角处留直角，线宽 1px 时看不出来
      graphics.fillColor = border;
      graphics.rect(left, bottom + size.height - bw, size.width, bw);
      graphics.fill();
      graphics.rect(left, bottom, size.width, bw);
      graphics.fill();
      graphics.rect(left, bottom, bw, size.height);
      graphics.fill();
      graphics.rect(left + size.width - bw, bottom, bw, size.height);
      graphics.fill();
    }
  }

  /**
   * 创建通用弹窗背景面板（矢量底板 + 四角铆钉，#1059；#1386 起绘制进 VectorPlate 组件）
   *
   * 对齐 `design/olua-ui` 的 `.panel--rivet`：暖炭褐底 + 顶部明暗过渡 + 1px 古铜金线 + 四角铆钉。
   * #1386：绘制逻辑已与 VectorPlate 组件完全同构（组件按 UITransform 尺寸重画、外观全部
   * @property 化、缺省值取 configs.dialogFrame.panel）——这里不再手画 Graphics，
   * 改挂组件；prefab 化的弹窗（DialogFrame.prefab）与运行时 addComponent 的旧弹窗同视觉。
   * 返回的容器尺寸即弹窗尺寸，后续子件坐标以弹窗中心为原点（与 createDialog 系列一致）。
   */
export function createDialogPanel(name: string, size: Size = dialogFrame.size) {
    const panel = UiHelper.createNode(name, new Vec2(), size);
    panel.addComponent(VectorPlate);
    return panel;
  }

  /**
   * 「点中弹窗即浮到其它弹窗之上」的置顶接线：#1386 起实现移到 utils/input/DialogBehavior
   * （DialogFrame 骨架组件与工厂共享同一实现，避免 helper ↔ 组件循环依赖）；
   * 这里 re-export 保持 GameUiHelper 聚合出口与既有调用点（ReportDialog / BagDialog / ConfirmDialog）不变。
   */
export { bindDialogRaiseOnPress } from "../../utils/input/DialogBehavior";

  /**
   * 眉题标签（`.panel-eyebrow`：左上角一行金色小字，含分区 / 快捷键信息）。
   * 标准弹窗（createDialog）的眉题在 DialogFrame.prefab 里；本方法保留给
   * **自建面板的 overlay 弹窗**（确认框 / 举报 / 频道 / 选区 / 公告详情 / 死亡界面 /
   * 物品详情）—— 它们要求有副标题（2026-11-18 用户拍板「副标题必须有」），共用本方法。
   */
export function createEyebrow(name: string, panelSize: Size, eyebrow: string) {
    const cap = dialogFrame.eyebrow;
    return UiHelper.createLabel(
      name,
      eyebrow,
      cap.color,
      cap.fontSize,
      new Vec2(-panelSize.width / 2 + cap.left + cap.width / 2, panelSize.height / 2 - cap.top - cap.height / 2),
      new Size(cap.width, cap.height),
      Label.HorizontalAlign.LEFT,
    );
  }

  /**
   * 创建通用弹窗（#1386 起骨架来自 `ui/prefabs/dialogs/DialogFrame.prefab`）
   *
   * 骨架对齐 `design/olua-ui` 的 `.panel--rivet` + `.panel-head`：
   * 底板（VectorPlate）→ 标题栏拖拽柄 → 左上眉题 → 居中标题 + 44×1 短金线 → 右上关闭键。
   * prefab 由 Game 场景的 `Game.dialogFramePrefab` 注入（NpcDialog 同款静态引用）；
   * 代码只写**文案与尺寸**（frame.setTitle / setEyebrow / setSize），摆位与样式全部归 prefab
   * —— 组件 onLoad 自动接线 blockClickThrough / 置顶提层 / 拖拽 / 关闭键销毁（原 createDialogBg 行为）。
   * 签名不变，调用点零改动；prefab 未注入 = 场景配置错误，直接抛错暴露（不留代码兜底路径）。
   *
   * @param eyebrow 左上角英文眉题（`BAG · B` 这类，含键盘快捷键）；不传则不画（整块隐藏）
   */
export function createDialog(name: string, title: string, position: Vec2 = new Vec2(), size: Size = dialogFrame.size, eyebrow = "") {
    const prefab = DialogFrame.getPrefab();
    if (!prefab) {
      throw new Error("DialogFrame.prefab 未注入：请确认 Game 场景 Game 组件的 dialogFramePrefab 字段已绑定（#1386）");
    }
    const dialog = instantiate(prefab);
    dialog.name = name;
    dialog.setPosition(position.x, position.y, 0);
    const frame = dialog.getComponent(DialogFrame)!;
    frame.setTitle(title);
    frame.setEyebrow(eyebrow);
    frame.setSize(size);
    return dialog;
  }

  /**
   * 弹窗页脚（ui.css `.panel-foot`；#1386 起结构来自 `ui/prefabs/dialogs/DialogFoot.prefab`）
   *
   * 通栏 1px 分隔线 + 两端各一行小字：结构与字号/颜色/线色在 prefab（DialogFoot 组件），
   * 摆位几何随面板尺寸变（`dialogFootLayout` 按尺寸算，不逐屏手抄），
   * 文案由调用方给（业务文案在 configs/texts）。纯标注层，不拦点击 ——
   * 弹窗根已经 blockClickThrough，点在页脚上照样算「点中弹窗」。
   *
   * @param width 通栏线宽（一般就是弹窗宽）
   * @param foot 页脚几何（dialogFootLayout 的返回值：线 y / 文字 y / 两端 x / 文本块宽高）
   */
export function createDialogFoot(
    name: string,
    width: number,
    foot: {
      lineY: number;
      textY: number;
      leftX: number;
      rightX: number;
      width: number;
      height: number;
    },
    leftText: string,
    rightText: string,
  ) {
    const prefab = DialogFoot.getPrefab();
    if (!prefab) {
      throw new Error("DialogFoot.prefab 未注入：请确认 Game 场景 Game 组件的 dialogFootPrefab 字段已绑定（#1386）");
    }
    const container = instantiate(prefab);
    container.name = name;
    const component = container.getComponent(DialogFoot)!;
    component.setGeometry(foot);
    component.setTexts(leftText, rightText);
    return container;
  }

  /**
   * 矢量小按钮（只画字，不带底图）：关闭键 / 行内文字键这类「不需要重量感」的点击区
   *
   * 与 createButton 同一套接线（Button 缩放反馈 + 点击音 + 鼠标通道命中拦截），
   * 只是外观由字色决定，避免为 30×30 的小键再切一张图。
   */
export function createVectorButton(name: string, text: string, position: Vec2, size: Size, fontSize: number, color: Color) {
    const node = UiHelper.createNode(name, position, size);
    node.addComponent(Button).transition = Button.Transition.SCALE;
    SoundManager.bindClick(node);
    blockClickThrough(node);
    node.addChild(UiHelper.createLabel(`${name}_label`, text, color, fontSize, new Vec2(), size));
    return node;
  }

  /**
   * 创建游戏大按钮（主行动档：朱红渐变 + 亮朱描边，ui.css .btn--primary）
   */
export function createBigButton(name: string, text: string, position: Vec2 = new Vec2()) {
    return createPlateButton(name, text, "", position, uiSize.bigButtonSize, uiSize.bigButtonFontSize, buttonTone.primary);
  }

  /** 创建游戏中按钮（常规档：暗褐金属 + 金线，ui.css .btn） */
export function createMiddleButton(name: string, text: string, position: Vec2 = new Vec2()) {
    return createPlateButton(name, text, "", position, uiSize.middleButtonSize, uiSize.middleButtonFontSize, buttonTone.normal);
  }

  /** 创建游戏小按钮（行内档：24 高，ui.css .btn--xs） */
export function createSmallButtion(name: string, text: string, position: Vec2 = new Vec2()) {
    return createPlateButton(name, text, "", position, uiSize.smallButtonSize, uiSize.smallButtonFontSize, buttonTone.normal);
  }

  /**
   * 矢量底板按钮（对外入口：#1059 起界面上新增的按钮走这里，色调由调用方指定）
   *
   * 与 createBigButton / createMiddleButton / createSmallButtion 同一套绘制，只是尺寸与色调自由给。
   */
export function createToneButton(name: string, text: string, position: Vec2, size: Size, fontSize: number, tone: ButtonTone) {
    return createPlateButton(name, text, "", position, size, fontSize, tone);
  }

  /**
   * 矢量底板按钮（三档按钮共用）
   *
   * 底板由 Graphics 现画：主色整块 + 上半一条亮带（模拟 180deg 渐变）+ 一圈描边；
   * 文字居中。色调与几何见 configs/layout/sizes 的 buttonTone / buttonStyle。
   * @param image 兼容旧调用：底板已改为矢量，图片参数不再参与绘制（保留形参避免改一圈调用点）
   */
export function createPlateButton(name: string, text: string, image: string, position: Vec2, size: Size, fontSize: number, tone: ButtonTone) {
    const node = UiHelper.createNode(name, position, size);
    node.addComponent(Button).transition = Button.Transition.SCALE;
    SoundManager.bindClick(node);
    blockClickThrough(node);
    const graphics = node.addComponent(Graphics);
    const w = size.width;
    const h = size.height;
    const radius = buttonStyle.radius;
    const bw = buttonStyle.borderWidth;
    // 底色 + 上半亮带（模拟 180deg 渐变）：内缩 bw，把一圈边框让出来
    if (tone.fill.a > 0) {
      graphics.fillColor = tone.fill;
      graphics.roundRect(-w / 2 + bw, -h / 2 + bw, w - bw * 2, h - bw * 2, radius);
      graphics.fill();
      if (tone.fillTopRatio > 0) {
        const bandH = (h - bw * 2) * tone.fillTopRatio;
        graphics.fillColor = tone.fillTop;
        graphics.roundRect(-w / 2 + bw, h / 2 - bw - bandH, w - bw * 2, bandH, radius);
        graphics.fill();
      }
    }
    // 边框：**不能用 stroke** —— 1px 描边在 web 构建里整条不渲染（引擎坑，见 tab-kit 同款注释），
    // 用四条 1px 填充代替。ghost 档没有底色，边框就是它全部的可见部分
    graphics.fillColor = tone.border;
    graphics.rect(-w / 2, h / 2 - bw, w, bw);
    graphics.rect(-w / 2, -h / 2, w, bw);
    graphics.rect(-w / 2, -h / 2 + bw, bw, h - bw * 2);
    graphics.rect(w / 2 - bw, -h / 2 + bw, bw, h - bw * 2);
    graphics.fill();
    node.addChild(UiHelper.createLabel(`${name}_label`, text, tone.text, fontSize, new Vec2(), size));
    return node;
  }

  /**
   * 创建物品详情弹窗（鼠标悬停在物品上时显示，背包格子与身上装备槽共用）
   *
   * 摆放：位置一律用**屏幕中心系坐标**（锚点世界坐标 − UI 层世界坐标，与 UI 层各常驻组件同口径），
   * 再交给 `ScreenLayout.getPopupPosition` 算 —— 竖直与物品同高居中、水平放物品靠屏幕中间那一侧、
   * 最后整块夹进可见区（弹窗比物品大得多，贴外侧摆会被裁掉一半）。
   * 这里**不能**用相机 worldToScreen 的像素坐标减设计分辨率：两个口径差一个 view 缩放系数，
   * 算出来的位置会严重偏移（这个 bug 修过一次，见 utils/layout/ScreenLayout.getPopupPosition 的注释）。
   *
   * 结构（#700 重构）：弹窗自身只留精灵（静态底图）+ 背景动画子节点（垫底），
   * 内容排版（Layout GRID + CONTAINER）在内层 `content` 节点上 —— Layout 不能直接
   * 挂弹窗，否则背景子节点会被当成一行参与排版、还会撑高容器。弹窗尺寸跟随 content
   * （SIZE_CHANGED 同步），对外表现与旧结构一致。
   *
   * 弹窗高度由内容自适应：首帧量到的是配置里的占位高度，内容撑开后才准，
   * 所以尺寸一变就用最终尺寸重算一次位置（幂等，内容稳定后不再动）。
   *
   * @param good 物品数据
   * @param anchor 物品格节点（摆放与尺寸都以它为准）
   * @param compare 对比模式：传装备 = 在属性列表下方追加「与身上穿戴对比」段；
   *   传 "hint" = 只显示「按住 Ctrl 对比」提示行（身上有穿戴但没按 Ctrl）；
   *   传 null/缺省 = 不出现对比相关内容（身上没得比、悬停的不是装备、或调用方没接对比）
   * @param meta 格子的绑定与溯源（#789，服务端写、这里只读）：
   *   `bound` 为真时多一行「已绑定 · 不可交易」；`from` 有值时（只有装备会带）多三行
   *   「掉落者 / 怪物 / 掉落于」。**缺省 = 不显示**，比如身上装备槽只存 id、没有元数据
   */
export function createGoodDetailDialog(good: Goods, anchor: Node, compare: Equipment | "hint" | null = null, meta?: BagCellMeta) {
    // 弹窗主体即矢量底板（VectorPlate 随内容尺寸重画，替代原九宫格背景贴图）
    const dialog = UiHelper.createNode(goodDetailLayout.name, new Vec2(), goodDetailLayout.size);
    dialog.addComponent(VectorPlate);
    // 装备详情背景（前后缀决定的品质背景动画）：独立子节点垫底，加载完成前先显示静态底图
    const background = createEquipmentDetailBackground(dialog, good);
    if (background) dialog.addChild(background.node);

    // 内容排版节点：Layout 在它上面（占位尺寸与旧结构相同，Layout 撑它，弹窗再跟着它走）
    const content = UiHelper.createNode("content", new Vec2(), goodDetailLayout.size);
    dialog.addChild(content);
    const layout = content.addComponent(Layout);
    layout.type = Layout.Type.GRID;
    layout.alignHorizontal = true;
    layout.spacingY = goodDetailLayout.rowSpacing;
    layout.verticalDirection = Layout.VerticalDirection.TOP_TO_BOTTOM;
    layout.padding = goodDetailLayout.padding;
    layout.resizeMode = Layout.ResizeMode.CONTAINER;

    // 眉题（全弹窗统一副标题口径）：Layout 会把它排到内容最顶
    content.addChild(createEyebrow(`${goodDetailLayout.name}_eyebrow`, goodDetailLayout.size, goodDetailLayout.eyebrow));

    // 头部
    const contentHeader = UiHelper.createFlexRow("header", goodDetailLayout.headerSpacing, new Vec2(), new Size(220, 40));
    // 图标
    const goodImage = UiHelper.createSprite("good_image", good.icon, new Vec2(), new Size(40, 40));
    // 标题（装备 = 前缀 + 名称 + 后缀 三段着色：前缀/名称用前缀色、后缀用后缀色；其他物品单行白字）
    let title: Node;
    if (isEquipment(good)) {
      const parts = getEquipmentNameParts(good);
      const titleRow = UiHelper.createFlexRow("good_detail_title", 2, new Vec2(), new Size(goodDetailLayout.title.size.width, goodDetailLayout.title.size.height));
      const mkTitleLabel = (name: string, text: string, color: Color) => {
        const node = UiHelper.createLabel(name, text, color, goodDetailLayout.title.fontSize, new Vec2(), new Size(10, goodDetailLayout.title.size.height), Label.HorizontalAlign.LEFT, Label.VerticalAlign.CENTER);
        const label = node.getComponent(Label)!;
        // 宽度随文字自适应（Overflow.NONE），由横向 Layout 依次排开；行高 40 保持与图标垂直居中
        label.overflow = Label.Overflow.NONE;
        label.isBold = true;
        return node;
      };
      titleRow.addChild(mkTitleLabel("good_detail_title_prefix", parts.prefix.label, parts.prefix.color));
      titleRow.addChild(mkTitleLabel("good_detail_title_name", parts.label, parts.prefix.color));
      titleRow.addChild(mkTitleLabel("good_detail_title_suffix", parts.suffix.label, parts.suffix.color));
      title = titleRow;
    } else {
      title = UiHelper.createLabel(
        "good_detail_title",
        good.label,
        Color.WHITE,
        goodDetailLayout.title.fontSize,
        new Vec2(),
        new Size(goodDetailLayout.title.size.width, goodDetailLayout.title.size.height),
        Label.HorizontalAlign.LEFT,
        Label.VerticalAlign.TOP,
      );
      const titleLabel = title.getComponent(Label)!;
      titleLabel.enableWrapText = true;
      titleLabel.lineHeight = goodDetailLayout.title.lineHeight;
      titleLabel.isBold = true;
    }

    contentHeader.addChild(goodImage);
    contentHeader.addChild(title);

    // 基础信息行（装备专属：穿戴等级与部位；前后缀变体与基础件同等级，门槛一致）
    const infoLayout = goodDetailLayout.info;
    const contentInfo = isEquipment(good)
      ? UiHelper.createLabel(
          "good_detail_info",
          getText("label_good_detail_info", { level: good.level, slot: equipmentSlots.get(good.slot)?.label ?? getText("label_good_slot_fallback") }),
          infoLayout.color,
          infoLayout.fontSize,
          new Vec2(),
          infoLayout.size,
          Label.HorizontalAlign.LEFT,
          Label.VerticalAlign.CENTER,
        )
      : null;

    // 回收价行（装备专属：背包「一键回收」按它结算，货币为绑定元宝；前后缀变体的价已随倍率缩放）
    const recycleLayout = goodDetailLayout.recycle;
    const contentRecycle = isEquipment(good)
      ? UiHelper.createLabel(
          "good_detail_recycle",
          getText("label_good_detail_recycle", { price: getRecyclePrice(good) }),
          recycleLayout.color,
          recycleLayout.fontSize,
          new Vec2(),
          recycleLayout.size,
          Label.HorizontalAlign.LEFT,
          Label.VerticalAlign.CENTER,
        )
      : null;

    // 标签行（装备专属：显示在名称正下方，与其他物品区分开）
    const contentTags = isEquipment(good) ? createGoodTagRow(good.tags ?? []) : null;

    // 绑定标记行（#789）：只有**真的绑定**时才占一行 —— 未绑定时不留空位，否则多数掉落物
    // 的详情弹窗会白白高一截。绑定 = 不允许交易，这条是给玩家看的结论，不是可点的开关。
    const boundStyle = goodDetailLayout.bound;
    const contentBound =
      meta && meta.bound === true
        ? UiHelper.createLabel(
            "good_detail_bound",
            getText("label_good_detail_bound"),
            boundStyle.color,
            boundStyle.fontSize,
            new Vec2(),
            boundStyle.size,
            Label.HorizontalAlign.LEFT,
            Label.VerticalAlign.CENTER,
          )
        : null;

    // 掉落溯源三行（#789；只有装备会带 from）：谁掉的 / 哪个怪 / 什么时候。
    // 缺哪项就少一行而不是填「未记录」—— 服务端只记到一半时，空白比假数据诚实。
    const originRows: Node[] = [];
    const origin = meta?.from;
    if (origin) {
      const style = goodDetailLayout.origin;
      const pushOriginRow = (name: string, text: string) => {
        originRows.push(
          UiHelper.createLabel(name, text, style.color, style.fontSize, new Vec2(), style.size, Label.HorizontalAlign.LEFT, Label.VerticalAlign.CENTER),
        );
      };
      if (origin.role) pushOriginRow("good_detail_origin_role", getText("label_good_detail_origin_role", { role: origin.role }));
      // 怪物 key 翻中文名（怪物表随快照下发；未知 key 直接显示 key，不吞掉这条线索）
      if (origin.monster) pushOriginRow("good_detail_origin_monster", getText("label_good_detail_origin_monster", { monster: monsterLabelOf(origin.monster) }));
      if (typeof origin.at === "number" && origin.at > 0) pushOriginRow("good_detail_origin_time", getText("label_good_detail_origin_time", { time: formatOriginTime(origin.at) }));
    }

    // 介绍
    const descLayout = goodDetailLayout.description;
    const contentDescription = UiHelper.createLabel("content_description", good.description, Color.WHITE, descLayout.fontSize, new Vec2(), descLayout.size);
    const descLabel = contentDescription.getComponent(Label);
    descLabel.lineHeight = descLayout.lineHeight;
    descLabel.enableWrapText = true;
    descLabel.horizontalAlign = Label.HorizontalAlign.LEFT;
    descLabel.overflow = Label.Overflow.RESIZE_HEIGHT;

    // 属性列表（装备按槽位显示战斗属性）
    const contentBody = UiHelper.createFlexCol("content_body", 3, new Vec2(), new Size(220, 220));
    contentBody.getComponent(Layout).resizeMode = Layout.ResizeMode.CONTAINER;
    if (isEquipment(good)) {
      (goodShowAttributes.get(good.slot) ?? []).forEach((attr) => {
        contentBody.addChild(createAttributeLabel(attr, good[attr]));
      });
    }

    content.addChild(contentHeader);
    if (contentInfo) content.addChild(contentInfo);
    if (contentRecycle) content.addChild(contentRecycle);
    if (contentBound) content.addChild(contentBound);
    originRows.forEach((row) => content.addChild(row));
    if (contentTags) content.addChild(contentTags);
    content.addChild(contentDescription);
    content.addChild(contentBody);
    // 对比段（仅背包装备悬停 + 接了对比数据源时出现，模式见上方参数说明）
    if (compare === "hint") content.addChild(createGoodCompareHintRow());
    if (compare && compare !== "hint") content.addChild(createGoodCompareSection(good as Equipment, compare));

    // 弹窗尺寸跟随内容（#700：Layout 撑的是 content，弹窗自身不再被 Layout 管）
    const dialogTransform = dialog.getComponent(UITransform)!;
    const contentTransform = content.getComponent(UITransform)!;
    const syncDialogSize = () => {
      dialogTransform.setContentSize(contentTransform.contentSize);
      // 背景效果乘在**最终面板宽度**上（内容撑开后才是真实面板），高度按帧比例自适应、
      // 顶边贴面板顶（帧未量到比例时按铺满过渡，帧加载完成后已按最新比例重设）
      if (background) applyBackgroundEffect(background.node, background.effect, dialogTransform.contentSize, background.ratio.value);
    };
    content.on(Node.EventType.SIZE_CHANGED, syncDialogSize);
    syncDialogSize();

    // 摆放：锚点恒为 0.5/0.5（内容排版交给上面的 Layout，动锚点会让 Layout 按新锚点重排而错位）
    const anchorWorld = anchor.getWorldPosition();
    const layerWorld = LayerManager.UILayer.getWorldPosition();
    const anchorCenter = new Vec2(anchorWorld.x - layerWorld.x, anchorWorld.y - layerWorld.y);
    const anchorSize = anchor.getComponent(UITransform)?.contentSize ?? goodDetailLayout.size;
    placeGoodDetailDialog(dialog, anchorCenter, anchorSize);
    // 自适应高度撑开后按最终尺寸复夹一次（可能来两三帧，每次都按当前尺寸重算，内容稳定后不再变）
    dialog.on(
      Node.EventType.SIZE_CHANGED,
      () => {
        if (isValid(dialog)) placeGoodDetailDialog(dialog, anchorCenter, anchorSize);
      },
    );
    return dialog;
  }

  /**
   * 把物品详情弹窗摆到物品旁（尽量靠屏幕中间且整块都在可见区内，规则见 ScreenLayout.getPopupPosition）
   * 独立成方法是为了「首帧按占位高度摆 + Layout 撑开后再按最终尺寸复夹」两处共用同一套算法
   */
export function placeGoodDetailDialog(dialog: Node, anchorCenter: Vec2, anchorSize: Size) {
    const transform = dialog.getComponent(UITransform);
    if (!transform) return;
    const position = getPopupPosition(
      anchorCenter,
      anchorSize,
      transform.contentSize,
      goodDetailLayout.placement.gap,
      goodDetailLayout.placement.screenMargin,
    );
    dialog.setPosition(position.x, position.y, 0);
  }

  /**
   * 「按住 Ctrl 与身上装备对比」提示行（灰字弱提示：身上有穿戴但没按 Ctrl 时出现在介绍下方）
   * 让玩家知道有对比能力可按（配置见 configs/layout/dialogs.goodDetailLayout.compare）
   */
export function createGoodCompareHintRow() {
    const style = goodDetailLayout.compare;
    const row = UiHelper.createLabel("good_detail_compare_hint", getText("label_good_detail_compare_hint"), style.hintColor, style.hintFontSize, new Vec2(), new Size(220, 16), Label.HorizontalAlign.LEFT, Label.VerticalAlign.CENTER);
    return row;
  }

  /**
   * 「对比 · 身上穿戴」段（悬停背包装备 + 按住左 Ctrl 时出现在属性列表下方）
   *
   * 结构：段标题 → 按槽位显示属性逐项「穿戴值 → 候选值（±差）」→ 战斗力对比行。
   * 差值着色：变强绿 / 变弱红 / 持平灰（配色见 configs/layout/dialogs.goodDetailLayout.compare）；
   * 行排版复用 createAttributeLabel（图标 + 属性名 50 + 值区），只改值区文字与颜色。
   *
   * @param good 悬停的装备（背包里那件，作为「候选」）
   * @param worn 身上穿戴的同槽位装备（作为「旧值」；同一件装备由调用方排除，这里不判）
   */
export function createGoodCompareSection(good: Equipment, worn: Equipment) {
    const style = goodDetailLayout.compare;
    const section = UiHelper.createFlexCol("good_detail_compare", 3, new Vec2(), new Size(220, 20));
    section.getComponent(Layout).resizeMode = Layout.ResizeMode.CONTAINER;
    // 段标题（金色，与回收价行同调）
    section.addChild(UiHelper.createLabel("good_detail_compare_title", getText("label_good_detail_compare_title"), style.titleColor, 12, new Vec2(), new Size(220, 18), Label.HorizontalAlign.LEFT, Label.VerticalAlign.CENTER));
    // 逐项属性行（顺序与槽位显示属性一致：configs/good.goodShowAttributes）
    const diffs = equipmentAttributeDiffs(goodShowAttributes.get(good.slot) ?? [], good, worn);
    diffs.forEach(({ key, worn: wornValue, value, delta }) => {
      // 装备属性是固定值（区间两端相等），着色看首端差即可；区间不等时首端也是主口径
      const firstDelta = typeof delta === "number" ? delta : delta[0];
      const color = firstDelta > 0 ? style.gainColor : firstDelta < 0 ? style.lossColor : style.sameColor;
      const row = createAttributeLabel(key, value);
      const valueLabel = row.getChildByName(String(key))?.getComponent(Label);
      if (valueLabel) {
        valueLabel.string = getText("label_good_detail_compare_row", {
          worn: formatAttributeValue(wornValue),
          value: formatAttributeValue(value),
          delta: formatSignedAttributeValue(delta),
        });
        valueLabel.color = color;
      }
      section.addChild(row);
    });
    // 战斗力对比行（与「更好装备」提示同一口径：configs/equipments.equipmentCombatValue）
    const wornCombat = equipmentCombatValue(worn);
    const goodCombat = equipmentCombatValue(good);
    const combatDelta = goodCombat - wornCombat;
    const combatColor = combatDelta > 0 ? style.gainColor : combatDelta < 0 ? style.lossColor : style.sameColor;
    const combatRow = UiHelper.createFlexRow("good_detail_compare_combat", 10, new Vec2(), new Size(220, 20));
    combatRow.addChild(createVectorDot("icon", T.gold[3], new Vec2(), new Size(10, 10)));
    combatRow.addChild(UiHelper.createLabel("combat_label", getText("label_combat"), Color.WHITE, 12, new Vec2(), new Size(50, 20), Label.HorizontalAlign.LEFT, Label.VerticalAlign.CENTER));
    combatRow.addChild(
      UiHelper.createLabel(
        "combat_value",
        getText("label_good_detail_compare_combat", { worn: wornCombat, value: goodCombat, delta: formatSignedAttributeValue(combatDelta) }),
        combatColor,
        12,
        new Vec2(),
        new Size(140, 20),
        Label.HorizontalAlign.LEFT,
        Label.VerticalAlign.CENTER,
      ),
    );
    section.addChild(combatRow);
    return section;
  }
