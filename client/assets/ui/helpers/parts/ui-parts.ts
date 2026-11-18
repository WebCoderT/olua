/**
 * 通用零件薄代理（转发 UiHelper 的基础工厂）与无样式节点工具（贴点/对齐/透明度/换图标）
 *
 * 由 GameUiHelper.ts 按域拆出（epic #1115 批次 1，机械搬移零行为变化）：
 * 原类 static 方法改为模块函数；调用方仍经 GameUiHelper 默认导出使用，本文件不直接消费。
 */


import { Color, isValid, Label, Node, Size, Sprite, SpriteFrame, UIOpacity, UITransform, Vec2, Vec3 } from "cc";
import UiHelper from ".././UiHelper";
import GameHelper from "../../core/GameHelper";

/** 创建一张带资源图的节点 */
export function createImage(name: string, src: string, position: Vec2 = new Vec2(), size: Size = new Size()) {
    return UiHelper.createSprite(name, src, position, size);
  }

  /** 创建铺满全屏的资源图 */
export function createFullScreenImage(name: string, src: string) {
    return UiHelper.createFullScreenNode(name, src);
  }

  /**
   * 创建「等比铺满」的背景图（cover：只缩放不拉伸，溢出部分由画布裁掉）
   *
   * 用于**构图可裁**的底图（选角背景：一整幅天空+地面，没有必须完整可见的 logo/文字）。
   * 登录与加载背景不在此列 —— 那两张的构图里有 logo 与合规文字，裁掉就是内容缺失。
   * @param name 元素名称
   * @param src 图片资源路径
   * @param onTextureLoaded 素材原始尺寸回调（加载完拿它算铺满尺寸，见 fitCover）
   */
export function createCoverImage(name: string, src: string, onTextureLoaded?: (textureSize: Size) => void) {
    return UiHelper.createCoverNode(name, src, onTextureLoaded);
  }

  /** 按屏幕尺寸给背景算铺满尺寸（cover）：等比缩放，永远铺满且不变形 */
export function fitCover(node: Node, textureSize: Size) {
    UiHelper.fitCoverNode(node, textureSize);
  }

  /** 创建文本 */
export function createText(
    name: string,
    text: string,
    fontSize: number,
    position: Vec2 = new Vec2(),
    size: Size = new Size(),
    color: Color = Color.WHITE,
    horizontalAlign: Label["horizontalAlign"] = Label.HorizontalAlign.CENTER,
    verticalAlign: Label["verticalAlign"] = Label.VerticalAlign.CENTER,
  ) {
    return UiHelper.createLabel(name, text, color, fontSize, position, size, horizontalAlign, verticalAlign);
  }

  /** 创建横向排列容器 */
export function createRow(name: string, spacing: number, position: Vec2 = new Vec2(), size: Size = new Size()) {
    return UiHelper.createFlexRow(name, spacing, position, size);
  }

  /** 创建纵向排列容器 */
export function createColumn(name: string, spacing: number, position: Vec2 = new Vec2(), size: Size = new Size()) {
    return UiHelper.createFlexCol(name, spacing, position, size);
  }

  /** 创建网格排列容器（从左到右排满换行、从上到下；高度为 0 时按内容自适应且锚点顶对齐） */
export function createGrid(name: string, spacingX: number, spacingY: number, position: Vec2 = new Vec2(), size: Size = new Size()) {
    return UiHelper.createGrid(name, spacingX, spacingY, position, size);
  }

  /** 创建滚动视图（内容纵向排列、可上下滑动） */
export function createScrollView(name: string, position: Vec2, size: Size, spacing: number = 3, padding: number = 0) {
    return UiHelper.createScrollView(name, position, size, spacing, padding);
  }

  /**
   * 为已有节点施加"横向排列容器"样式（组件自身即容器时使用，避免多包一层节点）
   * @returns 该节点的 Layout 组件
   */
export function applyRowStyle(node: Node, spacing: number, position: Vec2 = new Vec2(), size: Size = new Size()) {
    return UiHelper.applyFlexRowStyle(node, spacing, position, size);
  }

  /**
   * 为已有节点施加"纵向排列容器"样式（组件自身即容器时使用，避免多包一层节点）
   * @returns 该节点的 Layout 组件
   */
export function applyColumnStyle(node: Node, spacing: number, position: Vec2 = new Vec2(), size: Size = new Size()) {
    return UiHelper.applyFlexColStyle(node, spacing, position, size);
  }

  /** 创建带资源图的按钮（可选文字） */
export function createTexturedButton(name: string, src: string, text: string = "", position: Vec2 = new Vec2(), size: Size = new Size(129, 54), textColor: Color = Color.WHITE, fontSize: number = 20) {
    const button = UiHelper.createButton(name, src, position, size);
    if (text) button.addChild(UiHelper.createLabel(`${name}_label`, text, textColor, fontSize, new Vec2(), size));
    return button;
  }

  /** 创建开关组 */
export function createToggleGroup(name: string, toggles: Node[], spacing: number, position: Vec2 = new Vec2()) {
    return UiHelper.createToggleGroup(name, toggles, spacing, position);
  }

  /**
   * 把节点的内容尺寸按 contain 缩进外框（保持素材宽高比，最长的边贴到外框）
   * 用于原始尺寸各异的图集动画（边框 6 个尺寸家族共用一个显示口径，见 configs/layout/borders）
   */
export function fitNodeToBox(node: Node, frame: SpriteFrame, box: Size) {
    const source = frame.originalSize;
    const transform = node.getComponent(UITransform);
    if (!source.width || !source.height || !transform) return;
    const scale = Math.min(box.width / source.width, box.height / source.height);
    transform.setContentSize(source.width * scale, source.height * scale);
  }

  /**
   * 让节点跟随屏幕坐标（把屏幕点换算成 node 父节点坐标系下的位置再赋给 node）
   * 用于拖动中的幽灵图标：它挂在弹窗（或其子容器）下，而弹窗自己也可能被拖过，所以一律走世界坐标换算
   * @param node 要跟随的节点（必须已在场景里，即已有父节点）
   * @param screenPoint 屏幕坐标（与 UITransform.hitTest 同一口径，见 utils/input/Pointer）
   */
export function followScreenPoint(node: Node, screenPoint: Vec3) {
    const parent = node.parent;
    if (!parent || !isValid(parent)) return;
    const transform = parent.getComponent(UITransform);
    if (!transform) return;
    const local = transform.convertToNodeSpaceAR(GameHelper.screenPositionToWorldPosition(screenPoint), new Vec3());
    node.setPosition(local.x, local.y);
  }

  /** 把节点摆到目标节点的位置上（同一父节点坐标系；拖动落点高亮用） */
export function alignNodeToNode(node: Node, target: Node) {
    const parent = node.parent;
    if (!parent || !isValid(target)) return;
    const transform = parent.getComponent(UITransform);
    if (!transform) return;
    const local = transform.convertToNodeSpaceAR(target.getWorldPosition(), new Vec3());
    node.setPosition(local.x, local.y);
  }

  /** 设置节点不透明度（没有 UIOpacity 就补一个；拖动压暗源格物品与恢复都用它） */
export function setNodeOpacity(node: Node | null, opacity: number) {
    if (!node || !isValid(node)) return;
    const uiOpacity = node.getComponent(UIOpacity) ?? node.addComponent(UIOpacity);
    uiOpacity.opacity = opacity;
  }

  /** 更新节点图标（异步加载 SpriteFrame） */
export function updateNodeIcon(node: Node, src?: string) {
    const sprite = node.getComponent(Sprite);
    if (!src || !sprite) return;
    UiHelper.loadSprite(src, (spriteFrame) => {
      if (node.isValid && sprite.isValid) sprite.spriteFrame = spriteFrame;
    });
  }
