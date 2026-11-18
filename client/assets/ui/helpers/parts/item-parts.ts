/**
 * 物品与装备零件：物品图标/背包格/装备边框/详情背景/光效/掉落物/升级特效/数值格式化
 *
 * 由 GameUiHelper.ts 按域拆出（epic #1115 批次 1，机械搬移零行为变化）：
 * 原类 static 方法改为模块函数；调用方仍经 GameUiHelper 默认导出使用，本文件不直接消费。
 */


import { Animation, Color, Graphics, isValid, Label, Layout, Mask, Node, Size, Sprite, UITransform, Vec2 } from "cc";
import UiHelper from ".././UiHelper";
import AnimationHelper from ".././AnimationHelper";
import { isCtrlPressed, onCtrlChange } from "../../utils/input/ModifierKeys";
import { getText } from "../../../configs/texts";
import { BLANK_FRAME_MAX_AREA } from "../../../configs/animation";
import { dropLightEffectConfig, upgradeEffectConfig } from "../../../configs/game-config";
import type { UiEffectConfig } from "../../utils/net/ApiModels";
import { bagRow, bagCol } from "../../../configs/role";
import { Equipment, Goods, isEquipment } from "../../../types/good";
import type { DropOwner } from "../../../types/drop";
import { markClickThrough } from "../../utils/input/UiHit";
import { getEquipmentNameParts } from "../../../configs/equipments";
import LayerManager from "../../core/LayerManager";
import { avatarImage, bagGridLayout, dropItemLayout, equipmentBorderLayout, equipmentDetailBackgroundLayout, equipmentLightLayout, goodDetailLayout, T, uiImages } from "../../../configs/hudLayout";
import { borders, resolveEquipmentBorder } from "../../../configs/border";
import { detailBackgrounds, resolveEquipmentDetailBackground } from "../../../configs/background";
import type { AppearanceEffect } from "../../../types/appearance";
import { getEquipmentLightKey, lights } from "../../../configs/light";
import { BagCellMeta, getStackBadge, StackBadge } from "../../../configs/items";
import { fitNodeToBox, setNodeOpacity } from "./ui-parts";
import { createGoodDetailDialog } from "./dialog-builder";

/** 详情弹窗内的标签行样式（标签行尺寸/颜色/字号/间距与左右留白，见 configs/hudLayout.goodDetailLayout.tag） */
const goodTag = goodDetailLayout.tag;

/**
 * 衣服内观的最小数据源（#377）
 *
 * 装备（Equipment）与时装（fashionClothes.FashionDataEntry）都满足：时装只有内观资源，
 * 没有位置/缩放这些几何参数（缺省即不缩放、不旋转、居中），所以这里全部可选。
 */
export type ClothInShowSource = {
  in?: string;
  inPosition?: Vec2;
  inScaleX?: number;
  inScaleY?: number;
  inRotate?: number;
};



  /**
   * 创建掉落物零件（地面上的物品：图标 + 名称，可叠加物品显示数量）
   * 挂载点与拾取逻辑由 DropManager 处理
   * @param good 物品数据
   * @param count 掉落数量
   * @param size 图标尺寸
   * @param owner 归属者（#804：非空时名称行左侧挂「XX的」前缀 + 圆形小头像；自己的掉落传 null）
   * @return node 掉落物节点、nameLabel 名称行里第一段文本（供刷新/高亮）、
   *   ownerMark 归属标记节点（保护期结束时由 DropManager 整块移除，没画时为 null）
   */
export function createDropItem(good: Goods, count: number = 1, size: Size = dropItemLayout.iconSize, owner: DropOwner | null = null) {
    const node = UiHelper.createNode("drop_item", new Vec2(), new Size(size.width, size.height + dropItemLayout.nodeExtraHeight));
    // 光柱先挂：它是掉落物的第一个子节点，排在图标之前 → 画在图标**下层**
    // （图标压住光柱中心、光柱从四周透出，物品本身始终清晰可辨）
    applyEquipmentLight(node, good);
    const icon = UiHelper.createSprite(`drop_icon_${good.type}`, good.icon, new Vec2(0, dropItemLayout.iconOffsetY), size);
    node.addChild(icon);
    const { row, nameLabel, ownerMark } = createDropNameRow(good, count, size, owner);
    node.addChild(row);
    return { node, nameLabel, ownerMark };
  }

  /**
   * 创建掉落物名称行：装备 = 前缀 + 名称 + 后缀 三段着色，其余物品单行白字，可叠加物品追加「x{数量}」段
   *
   * 装备的段文案与配色**与详情弹窗同源**（同走 configs/equipments.getEquipmentNameParts）：
   * 前缀/名称用前缀色、后缀用后缀色 —— 地面与详情永远一致，不各写一份色表。
   * 各段宽度随文字自适应（Overflow.NONE），整行按内容宽度（CONTAINER）在图标正下方居中
   * @return row 名称行节点、nameLabel 行里第一段文本（可能为 null，供调用方刷新/高亮）、
   *   ownerMark 归属标记（头像 + 前缀，整块可一次性移除；没画时为 null）
   */
export function createDropNameRow(
    good: Goods,
    count: number,
    iconSize: Size,
    owner: DropOwner | null = null,
  ): { row: Node; nameLabel: Label | null; ownerMark: Node | null } {
    const layout = dropItemLayout.name;
    const row = UiHelper.createFlexRow("drop_name", layout.spacing, new Vec2(0, -iconSize.height / 2 - layout.offsetY), new Size(0, layout.lineHeight));
    // 行宽 = 各段宽度之和（CONTAINER），配合锚点 (0.5, 1) 让整行在图标正下方居中；
    // 首帧各段还没算出文字宽度，等 Label 定尺后 Layout 会自动重排（它会监听子件 SIZE_CHANGED）
    row.getComponent(Layout)!.resizeMode = Layout.ResizeMode.CONTAINER;
    row.getComponent(UITransform)!.setAnchorPoint(0.5, 1);
    let nameLabel: Label | null = null;
    // 归属标记排在最前（#804）：头像 + 「XX的」，保护期一过由 DropManager 整块移除
    const ownerMark = owner ? createDropOwnerMark(owner) : null;
    if (ownerMark) row.addChild(ownerMark);
    const addSegment = (text: string, color: Color) => {
      const segment = UiHelper.createLabel("drop_name_segment", text, color, layout.fontSize, new Vec2(), new Size(0, layout.lineHeight));
      const label = segment.getComponent(Label)!;
      // 宽度随文字自适应：CONTAINER 依赖子件宽度求和，CLAMP 会把宽度压成 0
      label.overflow = Label.Overflow.NONE;
      if (!nameLabel) nameLabel = label;
      row.addChild(segment);
    };
    if (isEquipment(good)) {
      const parts = getEquipmentNameParts(good);
      addSegment(parts.prefix.label, parts.prefix.color);
      addSegment(parts.label, parts.prefix.color);
      addSegment(parts.suffix.label, parts.suffix.color);
      if (count > 1) addSegment(`x${count}`, dropItemLayout.countColor);
    } else {
      addSegment(count > 1 ? `${good.label} x${count}` : good.label, dropItemLayout.nameColor);
    }
    return { row, nameLabel, ownerMark };
  }

  /**
   * 掉落物归属标记（#804）：圆形小头像 + 「XX的」前缀
   *
   * 头像用**现有素材**（`ui/avatar/{职业}-{性别}.png`，与角色信息面板同源），不新增美术；
   * 职业或性别缺一个就**不画头像**（拼不出图，画空框比不画更糟）—— 此时只剩前缀，
   * 这正是 docs/18 §6.7 里「归属者离线 / 头像缺失」的退化形态。
   *
   * 圆形靠 Mask（GRAPHICS_ELLIPSE）裁：头像是方图，不裁会在地面上多出一个方块边角，
   * 和「小头像」的观感差很远。整块（头像 + 前缀）放进一个 flex 行，保护期结束时
   * 一次性 `destroy()`（不做动画，见 §6.7 的口径）。
   */
export function createDropOwnerMark(owner: DropOwner): Node {
    const layout = dropItemLayout.owner;
    const nameLayout = dropItemLayout.name;
    const mark = UiHelper.createFlexRow("drop_owner", layout.avatarGap, new Vec2(), new Size(0, layout.avatarSize.height));
    mark.getComponent(Layout)!.resizeMode = Layout.ResizeMode.CONTAINER;
    if (owner.occupation && owner.sex) {
      const avatar = UiHelper.createNode("drop_owner_avatar", new Vec2(), layout.avatarSize);
      avatar.addComponent(Mask).type = Mask.Type.GRAPHICS_ELLIPSE;
      avatar.addChild(UiHelper.createSprite("drop_owner_avatar_pic", avatarImage(owner.occupation, owner.sex), new Vec2(), layout.avatarSize));
      mark.addChild(avatar);
    }
    const prefix = UiHelper.createLabel(
      "drop_owner_name",
      getText("drop_owner_prefix", { name: owner.name }),
      layout.prefixColor,
      nameLayout.fontSize,
      new Vec2(),
      new Size(0, nameLayout.lineHeight),
    );
    // 宽度随文字自适应（与名称段同一口径：CONTAINER 依赖子件宽度求和）
    prefix.getComponent(Label)!.overflow = Label.Overflow.NONE;
    mark.addChild(prefix);
    return mark;
  }

  /**
   * 给地面掉落物挂上装备光柱（仅装备有；前缀 → 光柱的映射与特殊装备的自定义表在 configs/light）
   *
   * 光柱是循环播放的 plist 图集动画（resources/effect/light/light-<编号>，400×400 画布），与边框同口径：
   * 帧偏移由图集的 spriteOffset 保留（打包时逐帧按 alpha 裁剪并记录回贴位置），精灵 trim 保持
   * createSprite 的缺省 false，各帧画布一致、画面帧间不跳。
   *
   * 表现参数（摆位 / 缩放 / 旋转 / 一轮时长 / 开关）归服务端 `ui_effects` 的 `light-*` 行（#634，
   * 管理端「特效管理」可改，与升级特效同一套取向）—— 这里只决定「这张装备用哪张光柱」。
   * 关掉时**连节点都不建**（不是建一个空精灵），与 `createUpgradeEffect` 的 enabled 口径一致。
   *
   * 光柱排在图标之前（见 createDropItem）→ 画在图标下层；它是掉落物节点的子节点，
   * 随掉落物一起销毁（拾取 / 换图清空都不必单独清理）
   *
   * @param node 掉落物节点
   * @param good 物品数据（非装备、没分配到光柱、或该光柱被运营关掉时不显示）
   */
export function applyEquipmentLight(node: Node, good: Goods) {
    if (!isEquipment(good)) return;
    const lightKey = getEquipmentLightKey(good);
    const resource = lightKey ? lights.get(lightKey) : null;
    if (!lightKey || !resource) return;
    const config = dropLightEffectConfig(lightKey);
    if (!config || !config.enabled) return;
    const light = createEquipmentLight(lightKey, config);
    node.addChild(light);
    // 帧已由 PreloadManager 进图前预加载（片段按 图集|时长 缓存，同一档光柱的多个掉落物共用）
    AnimationHelper.playLoopAtlasWithDuration(light.name, light, resource.atlas, Math.max(0.1, config.durationMs / 1000));
  }

  /**
   * 创建装备光柱零件（空精灵 + 动画组件，帧由 playLoopAtlasWithDuration 异步装载）
   *
   * 摆位口径：**与图标同中心**再加服务端给的偏移 —— 基准点是 `dropItemLayout.iconOffsetY`
   * （随掉落物布局走，不在这里另配一套坐标），所以偏移 (0,0) 时与 #634 之前完全一致。
   * 缩放按横纵各自乘、旋转顺时针，与升级特效 / 武器外观同一套语义。
   *
   * 节点名 = 前缀 + 光柱 key（`drop_light_light-1`）—— key 从 #542 起就是素材名、不含斜杠
   * （Cocos 对含 `/` 的节点名会报 `Node name can not include '/'`）。名字同时是
   * playLoopAtlasWithDuration 的动画状态名，改前缀会连带动画名，别单改一边。
   */
export function createEquipmentLight(lightKey: string, config: UiEffectConfig) {
    const light = UiHelper.createSprite(
      `${equipmentLightLayout.namePrefix}${lightKey}`,
      "",
      new Vec2(config.offsetX, dropItemLayout.iconOffsetY + config.offsetY),
      equipmentLightLayout.size,
    );
    light.setScale(config.scaleX, config.scaleY, 1);
    light.angle = config.rotate;
    light.addComponent(Animation);
    return light;
  }



  /**
   * 在某个格子上创建物品
   * @param options.compareWornProvider 悬停装备时取「身上同槽位穿戴件」的入口（Ctrl 对比的数据源）；
   *   只传给需要对比的调用方（背包格子）：身上装备槽、商城等悬停不做对比
   * @param options.meta 这一格的绑定与溯源（#789，背包格子传存档里的值）：
   *   详情弹窗据此显示「已绑定 · 不可交易」与掉落溯源；不传 = 都不显示
   *   （身上装备槽只存 id、没有元数据，传不出来也是如实反映）
   */
export function createGood(cell: Node, good: Goods, count?: number, options?: { compareWornProvider?: () => Equipment | null; meta?: BagCellMeta }) {
    const sprite = UiHelper.createSprite(`good_${good.label}`, good.icon, new Vec2(), new Size(40, 40));
    cell.addChild(sprite);
    // 装备边框（前后缀决定的品质光效，背包与身上装备槽同一入口）：挂在**图标**节点上而不是格子下——
    // 拖动压暗源格图标时边框一起变暗（边框是图标的子节点、随 UIOpacity 一起变淡），
    // 格子刷新销毁图标时边框也随子节点一起销毁，不必单独清理
    applyEquipmentBorder(sprite, good);
    // 叠加数量角标（仅背包格子传 count；身上装备槽不传，装备也不可叠加）：
    // 与边框同挂图标下，压暗/销毁跟着图标走；画什么由 configs/items.getStackBadge 决定（可叠加且数量 > 1 才画）
    const badge = getStackBadge(good, count);
    if (badge) sprite.addChild(createGoodStackBadge(badge));
    sprite.on(
      Node.EventType.MOUSE_ENTER,
      () => {
        // 悬停期间按住/松开 Ctrl 要在「带对比 / 不带对比」间实时切换：整窗重建
        // （对比段插在属性列表后面，穿插增删节点再复算摆放比重建更容易漏状态）
        let detailDialog: Node | null = null;
        let closed = false;
        let unsubscribeCtrl: (() => void) | null = null;
        const rebuild = () => {
          detailDialog?.destroy();
          // 只对装备做对比；身上没穿戴同槽位（或悬停的就是身上那件）时不比（见 issue #198）
          const worn = options?.compareWornProvider?.() ?? null;
          const comparable = isEquipment(good) && !!worn && worn.id !== good.id;
          const holdingCtrl = isCtrlPressed();
          detailDialog = createGoodDetailDialog(good, cell, comparable && holdingCtrl ? worn : comparable ? "hint" : null, options?.meta);
          LayerManager.addToUILayer(detailDialog);
        };
        const handleCtrlChange = () => {
          if (!closed) rebuild();
        };
        rebuild();
        unsubscribeCtrl = onCtrlChange(handleCtrlChange);
        // 鼠标移出、或物品节点被销毁（背包刷新/换装重建）都要销毁详情，
        // 否则图标被销毁时不会触发 MOUSE_LEAVE，详情会永久留在屏幕上并挡住后续点击
        const closeDetail = () => {
          if (closed) return;
          closed = true;
          unsubscribeCtrl?.();
          detailDialog?.destroy();
        };
        sprite.once(Node.EventType.MOUSE_LEAVE, closeDetail);
        sprite.once(Node.EventType.NODE_DESTROYED, closeDetail);
      },
    );
  }

  /**
   * 创建物品的叠加数量角标（数字标签，样式见 configs/layout/panels.bagGridLayout.badge）
   *
   * · 标为点击穿透：纯展示的小数字，不该参与「点是否落在 UI 上」的判定（见 utils/input/UiHit）；
   * · 数字右对齐：一位数与三位数都贴着标签框右缘，视觉上贴住格子右下角；
   * · 满叠（数量达到 maxStack）换 fullColor，提示这堆到顶了
   *
   * @param badge 角标内容（configs/items.getStackBadge 的返回值）
   */
export function createGoodStackBadge(badge: StackBadge) {
    const style = bagGridLayout.badge;
    const node = UiHelper.createLabel("good_stack_badge", badge.text, badge.full ? style.fullColor : style.color, style.fontSize, style.position, style.size, Label.HorizontalAlign.RIGHT, Label.VerticalAlign.CENTER);
    markClickThrough(node);
    return node;
  }

  /**
   * 给物品图标挂上装备边框（仅装备有；前后缀 → 边框的映射与特殊装备的自定义表在 configs/border）
   *
   * 边框是循环播放的图集帧动画（resources/borders），挂在物品图标节点上、画在图标之上；
   * 各边框图集的原始尺寸不一（6 个尺寸家族），帧加载完成后按首帧原始宽高把节点缩进统一的外框
   * （equipmentBorderLayout.size，contain 保持各自宽高比），再交给 playLoopAtlas 循环播放
   *
   * @param icon 物品图标节点（边框作为它的子节点：随图标一起被压暗/销毁）
   * @param good 物品数据（非装备或没分配到边框时不显示）
   */
export function applyEquipmentBorder(icon: Node, good: Goods) {
    if (!isEquipment(good)) return;
    const resolved = resolveEquipmentBorder(good);
    const resource = resolved ? borders.get(resolved.key) : null;
    if (!resource || !resolved) return;
    const border = createEquipmentBorder(resolved.key);
    icon.addChild(border);
    // 帧异步加载：加载完成后先定尺寸再播放（期间节点可能已被销毁——背包刷新、弹窗关闭都会重建边框）
    AnimationHelper.loadFramesFromAtlas(resource.atlas).then((frames) => {
      if (!isValid(border) || !frames.length) return;
      fitNodeToBox(border, frames[0], equipmentBorderLayout.size);
      // 每条配置的显示效果（#700）：默认 {0,0,1} 与「不调」完全一致
      applyEffectToNode(border, resolved.effect);
      AnimationHelper.playLoopAtlas(border.name, border, resource.atlas, equipmentBorderLayout.frameRate);
    });
  }

  /**
   * 把一条显示效果（#700）应用到节点：偏移 + 尺寸倍率
   *
   * 语义（与 AppearanceEffect 的注释、管理端工作台同一套口径）：
   * - `x` / `y`：相对**基准中心**的偏移（y 向上，引擎同口径，直接 setPosition）；
   * - `scale`：乘在「第一帧 contain 缩进基准框」的结果上（fitNodeToBox 先定尺寸，这里再乘）。
   * 默认 {0,0,1} 时两个分支都不走，与 #700 之前的行为逐字节一致。
   */
export function applyEffectToNode(node: Node, effect: AppearanceEffect) {
    if (effect.x || effect.y) node.setPosition(effect.x, effect.y);
    if (effect.scale !== 1) {
      const transform = node.getComponent(UITransform);
      if (transform) transform.setContentSize(transform.contentSize.width * effect.scale, transform.contentSize.height * effect.scale);
    }
  }

  /**
   * 创建装备边框零件（空精灵 + 动画组件，帧由 applyEquipmentBorder 异步装载）
   *
   * trim 必须为 true：这批边框图集「未裁剪但每帧 offset 全部非 0」，而 offset 只在 trim=false 的
   * 逆向补边路径里生效（引擎 simple 装配器按 trimmedBorder 平移整帧画面，非 0 的 offset 会把
   * 边框整体挪出节点框）；trim=true 时画面取 rect 全帧、完全不看 offset，未裁剪素材的 rect
   * 尺寸 == 原始尺寸，正好铺满节点框且不会变形（test-equipment-border.cjs 有断言盯住这一点）
   */
export function createEquipmentBorder(borderKey: string) {
    const border = UiHelper.createSprite(`${equipmentBorderLayout.namePrefix}${borderKey}`, "", new Vec2(), equipmentBorderLayout.size);
    const sprite = border.getComponent(Sprite)!;
    sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    sprite.trim = true;
    border.addComponent(Animation);
    return border;
  }

  /**
   * 把一条背景显示效果（#700）应用到背景节点：顶边贴面板顶 + 面板宽 × scale + 偏移
   *
   * 与边框的 `applyEffectToNode`（乘法）不同：背景的基准是**面板宽度**（宽度贴面板，
   * 高度 = 宽度 × 帧原始宽高比，不拉伸变形），且**顶边贴弹窗顶部**（锚点 0.5/1，
   * 位置 = 面板顶边 + effect.y；品质背景是弹窗的「头图」，居中会在上下留出静态底图）。
   * 「ratio 未知时退回铺满面板」只是帧尚未加载完的过渡态，第一帧量到比例后立即按
   * 新口径重设（见 createEquipmentDetailBackground）。
   * 由调用方把最终面板传进来（内容自适应，撑开后才准）。
   */
export function applyBackgroundEffect(node: Node, effect: AppearanceEffect, panel: Size, ratio: number) {
    const transform = node.getComponent(UITransform);
    if (!transform) return;
    transform.setAnchorPoint(0.5, 1);
    const width = panel.width * effect.scale;
    const height = ratio > 0 ? width * ratio : panel.height * effect.scale;
    transform.setContentSize(width, height);
    // 弹窗锚点 0.5/0.5 → 面板顶边在本地 y = +panel.height/2；effect.y 向上为正（引擎口径）
    node.setPosition(effect.x, panel.height / 2 + effect.y);
  }

  /**
   * 给装备详情弹窗创建背景动画节点（#700 起是**独立子节点**，不再换弹窗自身精灵的帧）
   *
   * 为什么改结构：背景的每条配置可以带显示效果（偏移 / 缩放），「换弹窗自身帧」
   * 没有独立的变换可调（动弹窗节点会连内容一起动）。改为底层子节点后，
   * 效果 = **顶边贴面板顶** + 面板宽 × scale + 偏移，高度按第一帧原始宽高比自适应
   * （不拉伸变形：素材本身宽高比不一，铺满面板会把有的拉高、有的压扁），
   * 默认 {0,0,1} 即「宽度贴面板、高度等比、顶边对齐」。
   * Layout 排版陷阱依旧成立：这个节点必须加在**没有 Layout 的弹窗**下（内容排版
   * 在内层 content 节点上，见 createGoodDetailDialog），先 add 让它垫在内容之下。
   * 加载完成前弹窗显示静态底图（节点比例未知，先按占位尺寸铺满作过渡）；
   * 未分配到背景的装备（含非装备物品）返回 null、保持静态底图。
   *
   * @param dialog 详情弹窗节点（背景节点随后 addChild 到它、垫底）
   * @param good 物品数据
   * @returns 背景节点、它的效果与**帧宽高比的可变持有者**（帧加载完成后由本方法回填，
   *   弹窗尺寸再变时 syncDialogSize 用最新比例重算）
   */
export function createEquipmentDetailBackground(dialog: Node, good: Goods): { node: Node; effect: AppearanceEffect; ratio: { value: number } } | null {
    if (!isEquipment(good)) return null;
    const resolved = resolveEquipmentDetailBackground(good);
    const resource = resolved ? detailBackgrounds.get(resolved.key) : null;
    if (!resource || !resolved) return null;
    const node = UiHelper.createSprite(`${equipmentDetailBackgroundLayout.namePrefix}${resolved.key}`, "", new Vec2(), goodDetailLayout.size);
    node.getComponent(Sprite)!.sizeMode = Sprite.SizeMode.CUSTOM;
    node.addComponent(Animation);
    const ratio = { value: 0 };
    AnimationHelper.loadLoopFrames(resource.dir).then((frames) => {
      // 节点/弹窗可能已被销毁（详情弹窗随鼠标移出即销毁）；帧加载失败保持过渡态铺满
      if (!isValid(node, true) || !isValid(dialog, true) || !frames.length) return;
      const size = frames[0].originalSize;
      if (size.width > 0 && size.height > 0) ratio.value = size.height / size.width;
      const dialogTransform = dialog.getComponent(UITransform);
      if (dialogTransform) applyBackgroundEffect(node, resolved.effect, dialogTransform.contentSize, ratio.value);
      AnimationHelper.playLoopDir(node.name, node, resource.dir, equipmentDetailBackgroundLayout.frameRate);
    });
    return { node, effect: resolved.effect, ratio };
  }

  /**
   * 属性值格式化
   * 区间两端相同时只显示一个数（装备是固定值，显示「120 - 120」没有意义），
   * 两端不同才显示区间（角色等级属性是 [上限×0.7, 上限] 的浮动区间）
   */
export function formatAttributeValue(value: readonly number[] | number): string {
    if (typeof value === "number") return String(value);
    return value[0] === value[1] ? String(value[0]) : `${value[0]} - ${value[1]}`;
  }

  /**
   * 掉落时间的展示格式（详情弹窗溯源行用）
   *
   * 口径「月日 + 时分」而不是完整年月：一件装备的掉落时间大概率就在最近几天，
   * 年月占位只会把这一行挤成两行。`at` 由服务端写成毫秒时间戳，这里只负责补零排版；
   * 非法值（0 / NaN / 负数）返回空串，调用方据此整行不显示（不编一个时间出来）。
   */
export function formatOriginTime(at: number): string {
    if (!Number.isFinite(at) || at <= 0) return "";
    const date = new Date(at);
    // 补零不用 padStart（客户端 tsconfig 不引 ES2017），也不用数字比较（`< 10` 会被
    // `audit-config-leak` 当成魔法阈值）；借两位常数前缀切尾两位，两个坑一起绕开
    const pad = (value: number) => `00${value}`.slice(-2);
    return getText("label_good_detail_origin_time_format", {
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: pad(date.getHours()),
      minute: pad(date.getMinutes()),
    });
  }

  /**
   * 创建装备标签行（标签逐条横排，占名称下方一整行）
   * 无标签时返回空行：保持"名称下方固定有一行标签"的排版位置不随标签有无而跳动
   */
export function createGoodTagRow(tags: string[], size: Size = goodTag.rowSize) {
    const row = UiHelper.createFlexRow("good_tags", goodTag.spacing, new Vec2(), size);
    tags.forEach((tag, index) => {
      // 每条标签按字数给宽（中文字宽≈字号），避免长标签被 CLAMP 截断
      const width = Math.max(goodTag.minWidth, tag.length * goodTag.fontSize + goodTag.paddingX);
      row.addChild(UiHelper.createLabel(`good_tag_${index}`, tag, goodTag.color, goodTag.fontSize, new Vec2(), new Size(width, size.height)));
    });
    return row;
  }



  /**
   * 创建角色衣服内观
   * 大小、旋转与位置由装备配置的 inScaleX / inScaleY / inRotate / inPosition 决定（缺省不缩放、不旋转）
   * @param onReady 素材就绪（首帧已落到 Sprite 上）后回调 —— 对齐要读帧几何，必须等这一刻
   */
export function createRoleClothInShow(cloth: ClothInShowSource, size: Size = new Size(), onReady?: () => void) {
    const clothInShow = UiHelper.createSprite("cloth_in_show", "", cloth.inPosition, size);
    clothInShow.getComponent(Sprite).sizeMode = Sprite.SizeMode.RAW;
    clothInShow.setScale(cloth?.inScaleX ?? 1, cloth?.inScaleY ?? 1, 1);
    clothInShow.angle = cloth?.inRotate ?? 0;
    void AnimationHelper.playLoopAtlasWithDuration("cloth_in_show", clothInShow, cloth.in, 1).then(() => onReady?.());
    return clothInShow;
  }

  /**
   * 创建角色武器内观
   * 大小、旋转与位置由装备配置的 inScaleX / inScaleY / inRotate / inPosition 决定（缺省不缩放、不旋转）
   * @param onReady 素材就绪（首帧已落到 Sprite 上）后回调 —— 对齐要读帧几何，必须等这一刻
   */
export function createRoleWeaponInshow(weapon: Equipment, size: Size = new Size(), onReady?: () => void) {
    const weaponInShow = UiHelper.createSprite("weapon_in_show", "", weapon.inPosition, size);
    weaponInShow.getComponent(Sprite).sizeMode = Sprite.SizeMode.RAW;
    weaponInShow.setScale(weapon?.inScaleX ?? 1, weapon?.inScaleY ?? 1, 1);
    weaponInShow.angle = weapon?.inRotate ?? 0;
    void AnimationHelper.playLoopAtlasWithDuration("weapon_in_show", weaponInShow, weapon.in, 1).then(() => onReady?.());
    return weaponInShow;
  }

  /**
   * 读一个精灵节点**当前帧**的内容 bbox（节点本地坐标，y 向上）
   *
   * 帧是裁剪过的（TexturePacker 的 spriteOffset → 引擎 SpriteFrame.offset，两者同号同值，
   * 2026-10-29 真机实测），所以「内容中心」不等于节点中心：要按裁剪偏移还原，
   * 否则所有「把 X 摆到 Y」的对齐都会随素材留白量漂移。
   * @returns 没有 Sprite / 帧还没加载时返回 null（调用方按「素材未就绪」处理，不要拿 (0,0) 硬算）
   */
export function spriteContentBox(node: Node | null): { cx: number; cy: number; w: number; h: number } | null {
    if (!node || !isValid(node)) return null;
    const frame = node.getComponent(Sprite)?.spriteFrame;
    if (!frame) return null;
    const rect = frame.getRect();
    const offset = frame.offset;
    // 占位空帧与「还没拿到帧」一样处理：拿它算出来的中心会把武器甩到天上去
    // （图集里的空帧由 AnimationHelper.isSolidFrame 在切片时滤掉，但 Sprite 上仍可能短暂停留；
    //   判据与那边同口径——阈值见 configs/animation.BLANK_FRAME_MAX_AREA，武器空帧是 2×2，边长判据会漏过）
    if (rect.width * rect.height <= BLANK_FRAME_MAX_AREA) return null;
    return { cx: offset.x, cy: offset.y, w: rect.width, h: rect.height };
  }

  /**
   * 创建升级特效（#594：表现参数归服务端）
   *
   * 摆位 / 缩放 / 旋转 / 时长 / 开关全部来自快照（`upgradeEffectConfig()`，管理端「特效管理」
   * 可改，与武器外观同一套取向）；**无本地兜底**（#724）：快照 `uiEffects` 表里没有 `upgrade`
   * 行时不演（返回 null，不建节点）—— 服务端没配 / 删了行就该如实地没有特效。
   * 尺寸口径与技能特效（`createSkillEffect`）一致：**不传 size**（`createSprite` 即 RAW +
   * trim = false），节点尺寸由帧的 `spriteSourceSize` 决定、裁剪帧按 `spriteOffset`
   * 回到原画布里的位置 —— 不写死素材尺寸（素材重新导出成分辨率不同也不会被拉伸）。
   * 帧来自 `effect/upgrade/upgrade.plist` 图集（`loadLoopFrames` 图集优先）。
   * @returns 没配置行或 `enabled = false` 时返回 null（调用方不挂节点，不是挂一个空的）
   */
export function createUpgradeEffect(): Node | null {
    const config = upgradeEffectConfig();
    if (!config || !config.enabled) return null;
    const upgrade = UiHelper.createSprite("upgrade_effect", "", new Vec2(config.offsetX, config.offsetY));
    upgrade.setScale(config.scaleX, config.scaleY, 1);
    upgrade.angle = config.rotate;
    // 升级特效是纯装饰动画，标为点击穿透：不遮挡世界点击
    markClickThrough(upgrade);
    AnimationHelper.playOnceWithDir("upgrade", upgrade, uiImages.upgradeEffect, Math.max(0.1, config.durationMs / 1000));
    return upgrade;
  }



  /** 创建背包格子（矢量：稿 05-bag 的 `.slot` —— **无底色**、只有一圈 1px 金线，格子透出面板底色） */
export function createRoleBagCell(row: number, col: number) {
    const size = bagGridLayout.cellSize;
    const cell = UiHelper.createNode(`bag_slot_${row}_${col}`, new Vec2(), size);
    const graphics = cell.addComponent(Graphics);
    // 1px 级 stroke 实机不渲染 → 四条 1px 填充拼边框（半径 r1 只有 2px，直角差异不可辨）
    UiHelper.paintRectBorder(graphics, size, T.line[2]);
    return cell;
  }

  /** 创建背包格子行（在 parent 下逐行生成格子并返回 [行][列] 索引） */
export function createRoleBagCellRow(parent: Node) {
    const cells = [];
    for (let row = 0; row < bagRow; row++) {
      cells[row] = [];
      const rowNode = UiHelper.createFlexRow(`bag_row_${row}`, bagGridLayout.rowSpacing, new Vec2(0, 0), bagGridLayout.rowSize);
      parent.addChild(rowNode);
      for (let col = 0; col < bagCol; col++) {
        const cell = createRoleBagCell(row, col);
        rowNode.addChild(cell);
        cells[row][col] = cell;
      }
    }
    return cells;
  }

  /**
   * 创建拖动时跟随指针的「幽灵」图标（半透明，表示这是被提起来的一个影子）
   * 标为点击穿透：它跟着指针盖在界面上，不该参与「点是否落在 UI 上」的判定（见 utils/input/UiHit）
   */
export function createBagDragGhost(icon: string) {
    const style = bagGridLayout.drag;
    const ghost = UiHelper.createSprite("bag_drag_ghost", icon, new Vec2(), style.ghostSize);
    setNodeOpacity(ghost, style.ghostOpacity);
    markClickThrough(ghost);
    return ghost;
  }

  /** 创建拖动落点高亮框（描边空框；拖动中被摆到指针下的格子上，取消/落子后连同节点销毁） */
export function createBagDragHighlight() {
    const style = bagGridLayout.drag;
    const node = UiHelper.createNode("bag_drag_highlight", new Vec2(), style.highlightSize);
    const graphics = node.addComponent(Graphics);
    graphics.lineWidth = style.highlightLineWidth;
    graphics.strokeColor = style.highlightColor;
    // 描边从尺寸边缘内缩，免得和格子底图的外框重叠
    const halfWidth = style.highlightSize.width / 2 - style.highlightInset;
    const halfHeight = style.highlightSize.height / 2 - style.highlightInset;
    graphics.rect(-halfWidth, -halfHeight, halfWidth * 2, halfHeight * 2);
    graphics.stroke();
    markClickThrough(node);
    return node;
  }
