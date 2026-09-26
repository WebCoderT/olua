import { Button, Color, EditBox, Font, Label, math, Node, resources, Sprite, SpriteFrame, Size, UITransform, Vec2, view, Toggle, Layout, ToggleContainer, Graphics, ProgressBar } from "cc";

/**
 * Ui界面元素统一生成
 */
const UiHelper = {
  /**
   * 获取屏幕尺寸
   * @returns Size
   */
  getScreenSize: () => view.getDesignResolutionSize(),

  /**
   * 创建全屏背景
   * @param name 元素名称
   * @param src 图片资源路径
   */
  createFullScreenNode: (name: string, src: string) => {
    const screenSize = UiHelper.getScreenSize();
    const node = new Node();
    node.name = name;
    const uiTransform = node.addComponent(UITransform);
    const spriteComponent = node.addComponent(Sprite);
    spriteComponent.sizeMode = Sprite.SizeMode.CUSTOM;
    uiTransform.setContentSize(screenSize.width, screenSize.height);
    resources.load(src + "/spriteFrame", SpriteFrame, (err, sprite) => {
      if (err) {
        console.error(err.message);
        return;
      }
      spriteComponent.spriteFrame = sprite;
    });
    return node;
  },

  /**
   * 创建一个操作按钮
   * @param name 元素名称
   * @param src 图片地址
   */
  createButton: (name: string, src: string, position: Vec2 = new Vec2(0, 0), size: Size = new Size(100, 30)) => {
    const node = new Node();
    node.name = name;
    const uiTransform = node.addComponent(UITransform);
    const spriteComponent = node.addComponent(Sprite);
    const button = node.addComponent(Button);
    button.transition = Button.Transition.SCALE;
    node.setPosition(position.x, position.y, 0);
    spriteComponent.sizeMode = Sprite.SizeMode.CUSTOM;
    spriteComponent.trim = false;
    uiTransform.setContentSize(size.x, size.y);

    resources.load(src + "/spriteFrame", SpriteFrame, (err, sprite) => {
      if (err) console.error(err.message);
      spriteComponent.spriteFrame = sprite;
    });

    return node;
  },

  /**
   * 创建一个文本标签
   * @param name 元素名称
   * @param text 文本内容
   * @param position 位置
   * @param size 尺寸
   */
  createLabel: (name: string, text: string, color: Color = Color.WHITE, fontSize: number = 24, position: Vec2 = new Vec2(), size: Size = new Size()) => {
    const node = new Node();
    node.name = name;
    const uiTransform = node.addComponent(UITransform);
    uiTransform.setContentSize(size.x, size.y);
    node.setPosition(position.x, position.y, 0);
    const label = node.addComponent(Label);
    label.string = text;
    label.fontSize = fontSize;
    label.lineHeight = size.y;
    label.overflow = Label.Overflow.CLAMP;
    label.horizontalAlign = Label.HorizontalAlign.CENTER;
    label.verticalAlign = Label.VerticalAlign.CENTER;
    label.color = color;
    resources.load("fonts/msyh", Font, (err, font) => {
      if (err) console.error(err.message);
      label.font = font;
    });

    return node;
  },
  /**
   * 创建一个输入框
   * @param name 元素名称
   * @param placeholder 占位符文本
   * @param position 位置
   * @param size 尺寸
   */
  createInputBox: (name: string, placeholder: string, position: Vec2, size: Vec2, isPassword: boolean = false) => {
    const node = new Node();
    node.name = name;
    const uiTransform = node.addComponent(UITransform);
    uiTransform.setContentSize(size.x, size.y);
    node.setPosition(position.x, position.y, 0);
    const editBox = node.addComponent(EditBox);
    editBox.inputMode = EditBox.InputMode.SINGLE_LINE;
    editBox.textLabel.horizontalAlign = Label.HorizontalAlign.LEFT;
    editBox.textLabel.verticalAlign = Label.VerticalAlign.CENTER;
    editBox.textLabel.overflow = Label.Overflow.CLAMP;
    editBox.textLabel.fontSize = 24;
    editBox.textLabel.getComponent(UITransform).setContentSize(size.x, size.y);
    editBox.textLabel.getComponent(UITransform).setAnchorPoint(0, 1);
    // 如果是密码输入框，则设置输入标志为密码模式
    if (isPassword) {
      editBox.inputFlag = EditBox.InputFlag.PASSWORD;
    }
    editBox.placeholderLabel.horizontalAlign = Label.HorizontalAlign.LEFT;
    editBox.placeholderLabel.verticalAlign = Label.VerticalAlign.CENTER;
    editBox.placeholderLabel.overflow = Label.Overflow.CLAMP;
    editBox.placeholderLabel.fontSize = 24;
    editBox.placeholderLabel.color = new Color("#999999");
    editBox.placeholderLabel.string = placeholder;
    editBox.placeholderLabel.getComponent(UITransform).setContentSize(size.x, size.y);
    editBox.placeholderLabel.getComponent(UITransform).setAnchorPoint(0, 1);
    return node;
  },

  /**
   * 创建一个图片元素
   * @param name 元素名称
   * @param bgSrc 图片地址
   * @param position 位置
   * @param size 尺寸
   */
  createSprite: (name: string, bgSrc: string, position: Vec2 = new Vec2(0, 0), size: Size = new Size(0, 0)) => {
    const node = new Node();
    node.name = name;
    const uiTransform = node.addComponent(UITransform);
    uiTransform.setContentSize(size.x, size.y);
    node.setPosition(position.x, position.y, 0);
    const spriteComponent = node.addComponent(Sprite);
    spriteComponent.sizeMode = Sprite.SizeMode.CUSTOM;
    spriteComponent.trim = false;
    bgSrc &&
      resources.load(bgSrc + "/spriteFrame", SpriteFrame, (err, sprite) => {
        if (err) console.error(err.message);
        spriteComponent.spriteFrame = sprite;
      });
    return node;
  },

  /**
   * 创建一个错误提示文本元素
   * @param name 元素名称
   * @param text 提示文本内容
   */
  createErrorTip: (name: string, text: string) => {
    const node = UiHelper.createLabel(name, text, Color.RED, 12, new Vec2(0, 0), new Size(300, 20));
    return node;
  },

  /**
   * 创建一个提示文本元素
   * @param name 元素名称
   * @param text 提示文本内容
   */
  createTip: (name: string, text: string) => {
    const node = UiHelper.createLabel(name, text, Color.GREEN, 12, new Vec2(0, 0), new Size(300, 20));
    return node;
  },

  /**
   * 创建选择器
   * @param src 图片地址
   * @param selectedSrc 选择后的图片地址
   * @param position 位置
   * @param size 尺寸
   */
  createToggle: (name: string, src: string, selectedSrc: string, position: Vec2 = new Vec2(0, 0), size: Size = new Size(0, 0)) => {
    const node = new Node();
    node.name = name;
    const toggle = node.addComponent(Toggle);
    node.setPosition(position.x, position.y, 0);
    const spriteNode = UiHelper.createSprite(`${name}_unchecked`, src, new Vec2(0, 0), size);
    const selectedSpriteNode = UiHelper.createSprite(`${name}_checked`, selectedSrc, new Vec2(0, 0), size);
    node.getComponent(UITransform).setContentSize(math.size(size.x, size.y));
    spriteNode.name = "true";
    selectedSpriteNode.name = "false";
    node.addChild(spriteNode);
    node.addChild(selectedSpriteNode);
    toggle.target = spriteNode;
    toggle.checkMark = selectedSpriteNode.getComponent(Sprite);

    return node;
  },

  /**
   * 创建弹性布局
   * @param name 元素名称
   * @param spacex 横向距离
   * @param position 位置
   * @param size 尺寸
   */
  createFlexRow: (name: string, spacex: number = 0, position: Vec2 = new Vec2(0, 0), size: Size = new Size(0, 0)) => {
    const node = new Node();
    node.name = name;
    const layout = node.addComponent(Layout);
    layout.type = Layout.Type.HORIZONTAL;
    layout.alignHorizontal = true;
    layout.resizeMode = Layout.ResizeMode.NONE;
    layout.spacingX = spacex;
    layout.horizontalDirection = Layout.HorizontalDirection.LEFT_TO_RIGHT;
    layout.getComponent(UITransform).height = size.height;
    layout.getComponent(UITransform).width = size.width;
    node.setPosition(position.x, position.y);
    return node;
  },

  /**
   * 创建弹性布局-列
   * @param name 元素名称
   * @param spaceY 横向距离
   * @param position 位置
   * @param size 尺寸
   */
  createFlexCol: (name: string, spacey: number = 0, position: Vec2 = new Vec2(0, 0), size: Size = new Size(0, 0)) => {
    const node = new Node();
    node.name = name;
    const layout = node.addComponent(Layout);
    layout.type = Layout.Type.VERTICAL;
    layout.alignHorizontal = true;
    layout.resizeMode = Layout.ResizeMode.NONE;
    layout.spacingY = spacey;
    layout.verticalDirection = Layout.VerticalDirection.TOP_TO_BOTTOM;
    layout.getComponent(UITransform).height = size.height;
    layout.getComponent(UITransform).width = size.width;
    node.setPosition(position.x, position.y);
    return node;
  },

  /**
   * 创建弹性布局
   * @param name 元素名称
   * @param nodes 元素
   * @param spacex 横向距离
   * @param position 位置
   */
  createToggleGroup: (name: string, nodes: Node[], spacex: number = 0, position: Vec2 = new Vec2(0, 0)) => {
    const size = new Size(nodes[0].getComponent(UITransform).width, nodes[0].getComponent(UITransform).height);
    const sizes = new Size(size.width * nodes.length + spacex * (nodes.length - 1), size.y);
    const node = UiHelper.createFlexRow(name, spacex, new Vec2(0, 0), sizes);
    node.addComponent(ToggleContainer);
    nodes.forEach((n) => node.addChild(n));
    node.setPosition(position.x, position.y, 0);
    return node;
  },

  /**
   * 创建一个空节点，可用于确认选择体积
   * @param name 名称
   * @param position 位置，默认原点
   * @param size 尺寸，默认零尺寸
   */
  createEmptyNode: (name: string, position: Vec2 = new Vec2(), size: Size = new Size()) => {
    const node = new Node();
    node.name = name;
    node.setPosition(position.x, position.y);
    const uiTransform = node.addComponent(UITransform);
    uiTransform.setContentSize(size);
    // 添加边框，确认体积
    const graphics = node.addComponent(Graphics);
    graphics.lineWidth = 4;
    graphics.strokeColor = new Color(255, 0, 0, 255);
    graphics.rect(-size.width / 2, -size.height / 2, size.width, size.height);
    graphics.stroke();
    return node;
  },

  /**
   * 创建一个进度条
   * @param name 元素名称
   * @param progress 进度
   * @param progressBarBgSrc 进度条整体背景
   * @param position 位置
   * @param size 尺寸
   * @return 进度条
   */
  createProgressBar(name: string, progress: number, progressBarBgSrc: string, position: Vec2 = new Vec2(), size: Size = new Size()) {
    const node = new Node();
    node.name = name;
    node.setPosition(position.x, position.y, 0);
    const progressBar = node.addComponent(ProgressBar);
    const uiTransform = progressBar.getComponent(UITransform);
    uiTransform.setContentSize(size);

    if (progressBarBgSrc) {
      const background = UiHelper.createSprite(`${name}_background`, progressBarBgSrc, new Vec2(), size);
      progressBar.node.addChild(background);
    }
    progressBar.progress = progress;
    return node;
  },
};

export default UiHelper;
