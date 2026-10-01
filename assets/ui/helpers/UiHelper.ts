import {
  Button,
  Color,
  EditBox,
  Font,
  isValid,
  Label,
  Node,
  resources,
  Sprite,
  SpriteFrame,
  Size,
  UITransform,
  Vec2,
  view,
  Toggle,
  Layout,
  ToggleContainer,
  Graphics,
  ProgressBar,
  ScrollView,
  Mask,
} from "cc";

/**
 * UI基础元素工厂（静态类）
 * 只封装 Cocos 引擎基础组件的创建：节点、按钮、文本、输入框、图片、
 * 布局、选择器、进度条、滚动视图、Tiled 地图等，不含任何游戏业务样式
 */
export default class UiHelper {
  //#region 公共基础（内部复用）

  /**
   * 创建带 UITransform 的基础节点，统一处理名称、位置与尺寸
   */
  static createNode(name: string, position: Vec2 = new Vec2(), size?: Size | Vec2) {
    const node = new Node();
    node.name = name;
    node.setPosition(position.x, position.y, 0);
    const uiTransform = node.addComponent(UITransform);
    if (size) uiTransform.setContentSize(size.x, size.y);
    return node;
  }

  /**
   * 创建纯分组节点（不带 UITransform，只做位置与层级组织）
   * 用途：承载那些"不希望被父节点 Layout 排列"的子元素——Layout 只排列带 UITransform 的子节点，
   * 纯分组节点因此不会被重排（如挂在 NPC 这类布局容器下的调试显示）
   * @param name 名称
   * @param position 位置，默认原点
   */
  static createGroupNode(name: string, position: Vec2 = new Vec2()) {
    const node = new Node();
    node.name = name;
    node.setPosition(position.x, position.y, 0);
    return node;
  }

  /**
   * 加载 SpriteFrame 资源并回调，统一错误日志
   */
  static loadSprite(src: string, onLoad: (spriteFrame: SpriteFrame) => void) {
    resources.load(src + "/spriteFrame", SpriteFrame, (err, sprite) => {
      if (err) {
        console.error(err.message);
        return;
      }
      if (!sprite) return;
      onLoad(sprite);
    });
  }

  /** 获取屏幕尺寸 */
  static getScreenSize() {
    return view.getDesignResolutionSize();
  }

  //#endregion

  //#region 节点与图片

  /**
   * 创建全屏背景节点
   * @param name 元素名称
   * @param src 图片资源路径
   */
  static createFullScreenNode(name: string, src: string) {
    const screenSize = this.getScreenSize();
    return this.createSprite(name, src, new Vec2(), new Size(screenSize.width, screenSize.height));
  }

  /**
   * 创建一个空节点（仅 UITransform，可用于确认选择体积）
   * @param name 名称
   * @param position 位置，默认原点
   * @param size 尺寸，默认零尺寸
   */
  static createEmptyNode(name: string, position: Vec2 = new Vec2(), size: Size = new Size()) {
    const node = this.createNode(name, position, size);
    // 添加边框，确认体积
    const graphics = node.addComponent(Graphics);
    graphics.lineWidth = 4;
    graphics.strokeColor = new Color(255, 0, 0, 255);
    graphics.rect(-size.width / 2, -size.height / 2, size.width, size.height);
    graphics.stroke();
    return node;
  }

  /**
   * 创建一个图片元素
   * @param name 元素名称
   * @param bgSrc 图片地址
   * @param position 位置
   * @param size 尺寸（不传则按原图尺寸 RAW 模式）
   */
  static createSprite(name: string, bgSrc: string, position: Vec2 = new Vec2(0, 0), size?: Size) {
    const node = this.createNode(name, position, size);
    const spriteComponent = node.addComponent(Sprite);
    spriteComponent.sizeMode = size ? Sprite.SizeMode.CUSTOM : Sprite.SizeMode.RAW;
    spriteComponent.trim = false;
    bgSrc &&
      this.loadSprite(bgSrc, (sprite) => {
        if (!isValid(node) || !isValid(spriteComponent)) return;
        spriteComponent.spriteFrame = sprite;
      });
    return node;
  }

  //#endregion

  //#region 文本与输入

  /**
   * 创建一个文本标签
   * @param name 元素名称
   * @param text 文本内容
   * @param color 文字颜色
   * @param fontSize 字号
   * @param position 位置
   * @param size 尺寸
   * @param horizontalAlign 水平对齐（默认居中）
   * @param verticalAlign 垂直对齐（默认居中）
   */
  static createLabel(
    name: string,
    text: string,
    color: Color = Color.WHITE,
    fontSize: number = 24,
    position: Vec2 = new Vec2(),
    size: Size = new Size(),
    horizontalAlign?: Label["horizontalAlign"],
    verticalAlign?: Label["verticalAlign"],
  ) {
    const node = this.createNode(name, position, size);
    const label = node.addComponent(Label);
    label.string = text;
    label.fontSize = fontSize;
    label.lineHeight = size.y;
    label.overflow = Label.Overflow.CLAMP;
    label.horizontalAlign = horizontalAlign ?? Label.HorizontalAlign.CENTER;
    label.verticalAlign = verticalAlign ?? Label.VerticalAlign.CENTER;
    label.color = color;
    label.enableWrapText = false;
    resources.load("fonts/msyh", Font, (err, font) => {
      // 加载失败（font 为空）或 Label 已随节点销毁（如怪物死亡时销毁身上的文本）时直接跳过：
      // 对已销毁的 Label 写 font 会命中已清空的渲染数据（_renderData 为 null）并抛错
      if (err || !font) {
        if (err) console.error(err.message);
        return;
      }
      if (!isValid(label) || !isValid(label.node)) return;
      label.font = font;
    });
    return node;
  }

  /**
   * 创建一个提示文本元素（全局提示的尺寸/字号/颜色见 configs/hudLayout.tipsLayout，由 GameUiHelper 使用）
   * @param name 元素名称
   * @param text 提示文本内容
   * @param color 文本颜色
   * @param fontSize 字号
   * @param size 尺寸
   */
  static createTipLabel(name: string, text: string, color: Color, fontSize: number, size: Size) {
    return this.createLabel(name, text, color, fontSize, new Vec2(0, 0), size);
  }

  /**
   * 创建一个输入框
   * @param name 元素名称
   * @param placeholder 占位符文本
   * @param position 位置
   * @param size 尺寸
   * @param isPassword 是否密码输入
   */
  static createInputBox(name: string, placeholder: string, position: Vec2, size: Vec2, isPassword: boolean = false) {
    const node = this.createNode(name, position, size);
    const editBox = node.addComponent(EditBox);
    editBox.inputMode = EditBox.InputMode.SINGLE_LINE;
    // 如果是密码输入框，则设置输入标志为密码模式
    if (isPassword) {
      editBox.inputFlag = EditBox.InputFlag.PASSWORD;
    }
    editBox.textLabel.fontSize = 24;
    editBox.placeholderLabel.fontSize = 24;
    editBox.placeholderLabel.color = new Color("#999999");
    editBox.placeholderLabel.string = placeholder;
    this.setupEditBoxLabel(editBox.textLabel, size);
    this.setupEditBoxLabel(editBox.placeholderLabel, size);
    return node;
  }

  /** 统一设置 EditBox 内部 Label 的对齐与锚点 */
  private static setupEditBoxLabel(label: Label, size: Vec2) {
    label.horizontalAlign = Label.HorizontalAlign.LEFT;
    label.verticalAlign = Label.VerticalAlign.CENTER;
    label.overflow = Label.Overflow.CLAMP;
    label.getComponent(UITransform).setContentSize(size.x, size.y);
    label.getComponent(UITransform).setAnchorPoint(0, 1);
  }

  //#endregion

  //#region 按钮与选择器

  /**
   * 创建一个操作按钮
   * @param name 元素名称
   * @param src 图片地址
   * @param position 位置
   * @param size 尺寸
   */
  static createButton(name: string, src: string, position: Vec2 = new Vec2(0, 0), size: Size = new Size(100, 30)) {
    const node = this.createSprite(name, src, position, size);
    const button = node.addComponent(Button);
    button.transition = Button.Transition.SCALE;
    return node;
  }

  /**
   * 创建选择器
   * @param name 元素名称
   * @param src 图片地址
   * @param selectedSrc 选择后的图片地址
   * @param position 位置
   * @param size 尺寸
   */
  static createToggle(name: string, src: string, selectedSrc: string, position: Vec2 = new Vec2(0, 0), size: Size = new Size(0, 0)) {
    const node = this.createNode(name, position, size);
    const toggle = node.addComponent(Toggle);
    const spriteNode = this.createSprite(`${name}_unchecked`, src, new Vec2(0, 0), size);
    const selectedSpriteNode = this.createSprite(`${name}_checked`, selectedSrc, new Vec2(0, 0), size);
    spriteNode.name = "true";
    selectedSpriteNode.name = "false";
    node.addChild(spriteNode);
    node.addChild(selectedSpriteNode);
    toggle.target = spriteNode;
    toggle.checkMark = selectedSpriteNode.getComponent(Sprite);
    return node;
  }

  /**
   * 创建选择器组
   * @param name 元素名称
   * @param nodes 元素
   * @param spacex 横向距离
   * @param position 位置
   */
  static createToggleGroup(name: string, nodes: Node[], spacex: number = 0, position: Vec2 = new Vec2(0, 0)) {
    const size = new Size(nodes[0].getComponent(UITransform).width, nodes[0].getComponent(UITransform).height);
    const sizes = new Size(size.width * nodes.length + spacex * (nodes.length - 1), size.y);
    const node = this.createFlexRow(name, spacex, new Vec2(0, 0), sizes);
    node.addComponent(ToggleContainer);
    nodes.forEach((n) => node.addChild(n));
    node.setPosition(position.x, position.y, 0);
    return node;
  }

  //#endregion

  //#region 布局

  /**
   * 创建弹性布局-行
   * @param name 元素名称
   * @param spacex 横向间距
   * @param position 位置
   * @param size 尺寸
   */
  static createFlexRow(name: string, spacex: number = 0, position: Vec2 = new Vec2(0, 0), size: Size = new Size(0, 0)) {
    const node = this.createNode(name, position, size);
    this.applyFlexRowStyle(node, spacex, position, size);
    return node;
  }

  /**
   * 为已有节点施加横向排列容器样式（组件"自身即容器"时使用，避免为了套样式多包一层节点）
   * @param node 目标节点
   * @param spacex 横向间距
   * @param position 位置
   * @param size 尺寸
   * @returns 该节点的 Layout 组件
   */
  static applyFlexRowStyle(node: Node, spacex: number = 0, position: Vec2 = new Vec2(0, 0), size: Size = new Size(0, 0)) {
    const uiTransform = node.getComponent(UITransform) ?? node.addComponent(UITransform);
    uiTransform.setContentSize(size);
    node.setPosition(position.x, position.y, 0);
    const layout = node.getComponent(Layout) ?? node.addComponent(Layout);
    layout.type = Layout.Type.HORIZONTAL;
    layout.alignHorizontal = true;
    layout.resizeMode = Layout.ResizeMode.NONE;
    layout.spacingX = spacex;
    layout.horizontalDirection = Layout.HorizontalDirection.LEFT_TO_RIGHT;
    return layout;
  }

  /**
   * 创建弹性布局-列
   * @param name 元素名称
   * @param spacey 纵向间距
   * @param position 位置
   * @param size 尺寸
   */
  static createFlexCol(name: string, spacey: number = 0, position: Vec2 = new Vec2(0, 0), size: Size = new Size(0, 0)) {
    const node = this.createNode(name, position, size);
    this.applyFlexColStyle(node, spacey, position, size);
    return node;
  }

  /**
   * 为已有节点施加纵向排列容器样式（组件"自身即容器"时使用）
   * 未指定高度时按内容自适应（CONTAINER）且锚点上对齐，与 createFlexCol 行为一致
   * @param node 目标节点
   * @param spacey 纵向间距
   * @param position 位置
   * @param size 尺寸
   * @returns 该节点的 Layout 组件
   */
  static applyFlexColStyle(node: Node, spacey: number = 0, position: Vec2 = new Vec2(0, 0), size: Size = new Size(0, 0)) {
    const uiTransform = node.getComponent(UITransform) ?? node.addComponent(UITransform);
    uiTransform.setContentSize(size);
    node.setPosition(position.x, position.y, 0);
    const layout = node.getComponent(Layout) ?? node.addComponent(Layout);
    layout.type = Layout.Type.VERTICAL;
    layout.alignHorizontal = true;
    if (size.height) layout.resizeMode = Layout.ResizeMode.NONE;
    else layout.resizeMode = Layout.ResizeMode.CONTAINER;
    if (!size.height) uiTransform.setAnchorPoint(0.5, 1);
    layout.spacingY = spacey;
    layout.verticalDirection = Layout.VerticalDirection.TOP_TO_BOTTOM;
    return layout;
  }

  //#endregion

  //#region 进度条与滚动视图

  /**
   * 创建一个进度条
   * @param name 元素名称
   * @param progress 进度
   * @param progressBarBgSrc 进度条整体背景
   * @param position 位置
   * @param size 尺寸
   * @return 进度条
   */
  static createProgressBar(name: string, progress: number, progressBarBgSrc: string, position: Vec2 = new Vec2(), size: Size = new Size()) {
    const node = this.createNode(name, position, size);
    const progressBar = node.addComponent(ProgressBar);
    if (progressBarBgSrc) {
      const background = this.createSprite(`${name}_background`, progressBarBgSrc, new Vec2(), size);
      progressBar.node.addChild(background);
    }
    progressBar.progress = progress;
    return node;
  }

  /** 创建滚动视图 */
  static createScrollView(name: string, position: Vec2, size: Size) {
    const node = this.createNode(name, position, size);
    node.addComponent(Mask);
    const scrollView = node.addComponent(ScrollView);
    scrollView.inertia = false;
    scrollView.elastic = false;
    const content = this.createFlexCol(`${name}_content`, 3, new Vec2(position.x, size.height / 2), size);
    node.addChild(content);
    const layout = content.getComponent(Layout);
    layout.resizeMode = Layout.ResizeMode.CONTAINER;
    const contentUiTransform = content.getComponent(UITransform);
    contentUiTransform.anchorY = 1;
    scrollView.content = content;
    return node;
  }

  //#endregion
}
