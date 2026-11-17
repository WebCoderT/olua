import {
  Button,
  Color,
  EditBox,
  Font,
  Graphics,
  isValid,
  Label,
  Node,
  resources,
  Sprite,
  SpriteFrame,
  Size,
  UITransform,
  Vec2,
  Toggle,
  Layout,
  ToggleContainer,
  ProgressBar,
  ScrollView,
  Mask,
} from "cc";
import { uiImages, uiTheme } from "../../configs/hudLayout";
import { T } from "../../configs/layout/tokens";
import SoundManager from "../core/SoundManager";
import { blockClickThrough } from "../utils/input/UiHit";
import { designResolution } from "../utils/layout/ScreenLayout";

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
   * 用 Graphics 画 1px 级矩形边框。
   * 引擎坑：Graphics.stroke() 在 1px 线宽下整条不渲染（实机验证），
   * 因此用"四条 1px 高/宽的填充矩形"拼出边框。
   */
  static paintRectBorder(graphics: Graphics, size: Size, color: Color, width = 1) {
    const halfW = size.width / 2;
    const halfH = size.height / 2;
    graphics.fillColor = color;
    graphics.rect(-halfW, halfH - width, size.width, width);
    graphics.rect(-halfW, -halfH, size.width, width);
    graphics.rect(-halfW, -halfH + width, width, size.height - width * 2);
    graphics.rect(halfW - width, -halfH + width, width, size.height - width * 2);
    graphics.fill();
  }

  /**
   * 把带透明度的前景色压到不透明背景色上，返回不透明结果色。
   * 用途：1px 边框用「填两块」画时，半透明边线若直接落在面板最底层，会跟面板**外面**的背景
   * （世界地图那种亮底）混色 —— 稿里的边线是叠在面板底色上的，所以先合成到面板底色再画。
   */
  static blendOver(fg: Color, bg: Color): Color {
    const a = fg.a / 255;
    return new Color(
      Math.round(fg.r * a + bg.r * (1 - a)),
      Math.round(fg.g * a + bg.g * (1 - a)),
      Math.round(fg.b * a + bg.b * (1 - a)),
      255,
    );
  }

  /**
   * 竖向渐变（Graphics 没有渐变 API，用 N 条等高色带插值近似；稿的面板是 165deg 线性渐变）
   * @param stops 由顶到底的色标（t: 0=顶 1=底，须按 t 递增）
   * @param inset 四周内缩（让出边框宽度）
   * @param radius 顶部圆角（首尾两条色带横向收窄，避免把圆角盖成直角）
   * @param steps 色带条数（40 条在高 540 的面板上肉眼无缝）
   */
  static paintVerticalGradient(graphics: Graphics, size: Size, stops: Array<{ t: number; color: Color }>, inset: number, radius: number, steps: number) {
    const width = size.width - inset * 2;
    const top = size.height / 2 - inset;
    const height = size.height - inset * 2;
    const stepHeight = height / steps;
    const sample = (t: number) => {
      for (let i = 0; i < stops.length - 1; i++) {
        const from = stops[i];
        const to = stops[i + 1];
        if (t <= to.t) {
          const k = (t - from.t) / Math.max(1e-6, to.t - from.t);
          return new Color(
            Math.round(from.color.r + (to.color.r - from.color.r) * k),
            Math.round(from.color.g + (to.color.g - from.color.g) * k),
            Math.round(from.color.b + (to.color.b - from.color.b) * k),
            255,
          );
        }
      }
      return stops[stops.length - 1].color;
    };
    for (let i = 0; i < steps; i++) {
      graphics.fillColor = sample((i + 0.5) / steps);
      const shrink = radius > 0 && (i === 0 || i === steps - 1) ? radius * 0.5 : 0;
      graphics.rect(-width / 2 + shrink, top - (i + 1) * stepHeight, width - shrink * 2, stepHeight + 0.5);
      graphics.fill();
    }
  }

  /**
   * 画「圆角面板」：外框色填整块 → 内缩 borderWidth 填主体色，两块填充拼出边框。
   * 引擎坑同上：1px stroke 实机不渲染，一律走本方法（与 GameUiHelper.createDialogPanel 同构）。
   * @param fill 主体色；传 null 表示只画边框（退化为四条 1px 填充的直角框，1px 下圆角差异不可辨）
   */
  static paintRoundedPanel(graphics: Graphics, size: Size, radius: number, fill: Color | null, border: Color, borderWidth = 1) {
    if (!fill) {
      this.paintRectBorder(graphics, size, border, borderWidth);
      return;
    }
    const left = -size.width / 2;
    const bottom = -size.height / 2;
    graphics.fillColor = border;
    graphics.roundRect(left, bottom, size.width, size.height, radius);
    graphics.fill();
    graphics.fillColor = fill;
    graphics.roundRect(left + borderWidth, bottom + borderWidth, size.width - borderWidth * 2, size.height - borderWidth * 2, Math.max(0, radius - borderWidth));
    graphics.fill();
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

  /** 屏幕尺寸：单分辨率下就是设计分辨率（唯一来源见 ScreenLayout.designResolution） */
  static getScreenSize() {
    return designResolution;
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
   * 创建「等比铺满」的背景节点（cover）：按素材自身比例缩放、铺满整个屏幕，多出的部分落在屏外
   *
   * 与 `createFullScreenNode` 的区别：那个把节点尺寸直接设成设计分辨率（CUSTOM 拉伸），
   * 素材比例与屏幕比例不一致时会把整张图画歪（如 650×1154 的竖图铺到 1920×1080 上，
   * 纵横比被拉歪 3 倍多，整屏糊）；这个只缩放不拉伸，代价是构图被裁。
   * 所以**只用在"构图可裁"的底图上**；带 logo / 合规文字的整图（登录、加载）不能用。
   *
   * 素材尺寸要等加载完才知道，故通过回调把原始尺寸给调用方；
   * 加载完由调用方拿这个尺寸再调 `fitCoverNode` 算铺满尺寸。
   */
  static createCoverNode(name: string, src: string, onTextureLoaded?: (textureSize: Size) => void) {
    const node = this.createNode(name, new Vec2(), this.getScreenSize());
    const sprite = node.addComponent(Sprite);
    sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    sprite.trim = false;
    this.loadSprite(src, (frame) => {
      if (!isValid(node) || !isValid(sprite)) return;
      sprite.spriteFrame = frame;
      const textureSize = new Size(frame.rect.width, frame.rect.height);
      if (!textureSize.width || !textureSize.height) return;
      this.fitCoverNode(node, textureSize);
      onTextureLoaded?.(textureSize);
    });
    return node;
  }

  /**
   * 按素材尺寸把节点铺满整个屏幕（cover；本作只有一个分辨率，见 ScreenLayout）
   * @param node 目标节点（需带 UITransform）
   * @param textureSize 素材原始像素尺寸
   */
  static fitCoverNode(node: Node, textureSize: Size) {
    const transform = node.getComponent(UITransform);
    if (!transform || !textureSize.width || !textureSize.height) return;
    // 取两轴较大的缩放系数：短边刚好铺满，长边溢出屏外（由画布裁掉）—— 等比，永不变形
    const scale = Math.max(designResolution.width / textureSize.width, designResolution.height / textureSize.height);
    transform.setContentSize(textureSize.width * scale, textureSize.height * scale);
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
    resources.load(uiImages.defaultFont, Font, (err, font) => {
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
   * 创建一个「宽度固定、高度按内容自适应」的多行文本
   *
   * createLabel 的口径是单行 + CLAMP（超出直接裁掉），只适合标题这类定长文本；
   * 公告正文、长段说明这类长度不定的文本必须换行 + RESIZE_HEIGHT ——
   * 高度随内容撑开后，父级 Layout（CONTAINER）才量得到它，外层滚动区才知道内容有多长
   * （同一口径的内联写法见 ui/components/dialogs/ConfirmDialog 的 createMessage）。
   *
   * @param width 文本宽度（即换行宽度）；高度不传，由内容决定
   * @param lineHeight 行高（RESIZE_HEIGHT 下每行占多高完全由它决定）
   * @param horizontalAlign 水平对齐（默认居中；左对齐的正文传 Label.HorizontalAlign.LEFT）
   */
  static createWrappedLabel(
    name: string,
    text: string,
    color: Color,
    fontSize: number,
    lineHeight: number,
    position: Vec2,
    width: number,
    horizontalAlign?: Label["horizontalAlign"],
    height?: number,
  ) {
    // 定高模式（height 给出时）：换行 + 溢出裁剪 + 文字块在框内垂直居中。
    // RESIZE_HEIGHT 的块会随行数长高、且锚点居中 → 行数一变就把上下邻居挤掉（成长弹窗描述踩过）；
    // 定高模式行数多寡都占同一块，布局可算。
    if (height) {
      const fixed = this.createLabel(name, text, color, fontSize, position, new Size(width, height), horizontalAlign, Label.VerticalAlign.CENTER);
      const label = fixed.getComponent(Label);
      label.lineHeight = lineHeight;
      label.overflow = Label.Overflow.CLAMP;
      label.enableWrapText = true;
      return fixed;
    }
    const node = this.createLabel(name, text, color, fontSize, position, new Size(width, 0), horizontalAlign, Label.VerticalAlign.TOP);
    const label = node.getComponent(Label);
    label.lineHeight = lineHeight;
    label.overflow = Label.Overflow.RESIZE_HEIGHT;
    label.enableWrapText = true;
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
   *
   * `fontSize` 默认 24 是给登录页 / 各弹窗的大输入条用的；聊天窗那种 26 高的窄输入框必须显式传小字号
   * —— 24px 中文字形本身就 24 高，塞进 26 高的框里会顶着上下边缘往外溢（#477 顺带发现）。
   * @param name 元素名称
   * @param placeholder 占位符文本
   * @param position 位置
   * @param size 尺寸
   * @param isPassword 是否密码输入
   * @param fontSize 文字与占位符字号（默认 24）
   */
  /**
   * 矢量输入框（登录页账号 / 密码同一口径）：`surface.input` 圆角暗底 + 1px 弱线描边 + EditBox
   *
   * 这是输入框的**唯一视觉来源**——登录重排后新输入框一律用它，不再用图片底那张
   * loginInputBackground（弹窗与登录页底色 / 圆角 / 字号不一致就是从混用两张底开始的）。
   * @param placeholder 占位文案
   * @param position 框中心相对父节点位置
   * @param size 框体尺寸
   * @param options.icon 左侧图标（登录页用；传了会把文字区往右收）
   * @param options.password 密码掩码
   * @param options.fontSize 输入字号（默认 f14，登录页口径）
   * @param options.inset 文字区总收缩（默认 24 = 左右各 12；登录页带图标是 84）
   * @param options.height 文字区高度（默认 34，登录页口径）
   */
  static createVectorInputField(
    placeholder: string,
    position: Vec2,
    size: Size,
    options: { icon?: string; password?: boolean; fontSize?: number; inset?: number; height?: number } = {},
  ) {
    const background = this.createNode("input_background", position, size);
    const graphics = background.addComponent(Graphics);
    this.paintRoundedPanel(graphics, size, T.radius.r2, T.surface.input, T.line[2]);
    if (options.icon) {
      background.addChild(this.createSprite("input_icon", options.icon, new Vec2(-size.width / 2 + 22, 0), new Size(20, 20)));
    }
    const inset = options.inset ?? 24;
    const height = options.height ?? 34;
    const input = this.createInputBox("input", placeholder, new Vec2(), new Vec2(size.width - inset, height), options.password ?? false, options.fontSize ?? T.fontSize.f14);
    background.addChild(input);
    return { node: background, input };
  }

  static createInputBox(name: string, placeholder: string, position: Vec2, size: Vec2, isPassword: boolean = false, fontSize: number = 24) {
    const node = this.createNode(name, position, size);
    const editBox = node.addComponent(EditBox);
    editBox.inputMode = EditBox.InputMode.SINGLE_LINE;
    // 如果是密码输入框，则设置输入标志为密码模式
    if (isPassword) {
      editBox.inputFlag = EditBox.InputFlag.PASSWORD;
    } else {
      this.keepLabelVisibleWhileEditing(node, editBox);
    }
    editBox.textLabel.fontSize = fontSize;
    editBox.placeholderLabel.fontSize = fontSize;
    editBox.placeholderLabel.color = uiTheme.inputPlaceholderColor;
    editBox.placeholderLabel.string = placeholder;
    this.setupEditBoxLabel(editBox.textLabel, size);
    this.setupEditBoxLabel(editBox.placeholderLabel, size);
    return node;
  }

  /**
   * 编辑期间保持自绘 Label 常显（覆盖引擎 Web 端「隐藏 Label、改用 DOM input 显示文字」的默认行为）
   *
   * 引擎 Web 端 EditBox（edit-box-impl.ts）在 beginEditing 时会 `_hideLabels` 并把文字画进一个
   * 绝对定位的 DOM `<input>` 覆盖层（位置由 `_updateMatrix` 按节点世界矩阵算）。本项目 Game 场景是
   * 「UILayer 每帧跟着主角搬 + 相机跟随」的非常规结构，实测该覆盖层落位不可靠：打字看不见、
   * 中文输入法组词也不可见，按回车（失焦恢复 Label）文字才出现（2026-11-18 用户实测）。
   *
   * 反着来：文字显示一律走自绘 Label —— 引擎每次输入都会触发 `text-changed` 并同步 `string`，
   * 本就是实时的，我们只需在编辑期间把被引擎藏掉的 Label 重新点亮；DOM input 退化为纯键盘/输入法
   * 载体，其文字设为透明、仅保留光标，避免与 Label 叠出双份文字。输入法组词期间引擎不上报内容，
   * 这里额外把 DOM 草稿同步进 Label 让组词预览可见（仅改显示层，不动 EditBox.string，提交后引擎自己会同步）。
   * 密码框不走这套：登录页的掩码圆点依赖 DOM 显示。
   */
  private static keepLabelVisibleWhileEditing(node: Node, editBox: EditBox) {
    node.on(EditBox.EventType.EDITING_DID_BEGAN, () => {
      // 引擎的事件在 _showDom（藏 Label）之前发出，延一拍等引擎藏完再点亮，否则会被盖回去
      setTimeout(() => {
        editBox.textLabel.node.active = editBox.string !== "";
        this.hideDomInputText(editBox);
      }, 0);
    });
    // 每次输入引擎都会先同步 string 再发事件，这里把 Label 点回来即可（组词期间引擎不同步，由 DOM 预览监听补）
    node.on(EditBox.EventType.TEXT_CHANGED, () => {
      editBox.textLabel.node.active = true;
    });
  }

  /** 已装过「组词预览」监听的 DOM input（同一元素只装一次，元素随 EditBox 销毁一起回收） */
  private static domPreviewAttached = new WeakSet<object>();

  /**
   * 把正在编辑的 DOM input 文字藏成透明（只留光标），并装上「组词预览」监听。
   * 引擎每次 beginEditing 都会按 Label 颜色重设 DOM 文字色，因此每个编辑会话都要重新藏一次。
   */
  private static hideDomInputText(editBox: EditBox) {
    const domDocument: Document | undefined = (globalThis as { document?: Document }).document;
    if (!domDocument) return;
    const element = domDocument.activeElement as (HTMLInputElement & { dataset?: DOMStringMap }) | null;
    if (!element) return;
    const tag = element.tagName;
    if (tag !== "INPUT" && tag !== "TEXTAREA") return;
    element.style.color = "transparent";
    element.style.caretColor = editBox.textLabel.color.toCSS();
    if (!this.domPreviewAttached.has(element)) {
      this.domPreviewAttached.add(element);
      // 组词（composition）期间引擎锁输入不上报：把 DOM 草稿直接写进显示层 Label，
      // 预览内容只改 textLabel.string 不动 EditBox.string，选字提交后引擎会用正式文本覆盖
      element.addEventListener("input", () => {
        const draft = element.value;
        if (draft === editBox.string) return;
        editBox.textLabel.string = draft;
        editBox.textLabel.node.active = draft !== "";
      });
    }
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
    // 按钮点击音（#685）：这里是项目的**按钮工厂**，挂在这里等于所有走它的按钮都有声音
    // （登录 / 选角 / 弹窗 / 底部面板…）。手写按钮各自调 SoundManager.bindClick，见那边的说明
    SoundManager.bindClick(node);
    // 点击逻辑走 Button 自己的 touch 通道；这里在鼠标通道上也登记一次命中拦截，
    // 否则按钮对 mouse 通道不可见，点击会继续穿透到下层 UI（见 utils/input/UiHit.blockClickThrough）
    blockClickThrough(node);
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
    // 勾选也是按钮（#685）：类目切换、开关型选项都走这里
    SoundManager.bindClick(node);
    // 同 createButton：Toggle 也只走 touch 通道，需在鼠标通道补一次命中拦截
    blockClickThrough(node);
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

  /**
   * 创建弹性布局-网格（子项从左到右排满一行后换到下一行，从上到下）
   * @param name 元素名称
   * @param spacex 横向间距
   * @param spacey 纵向间距
   * @param position 位置
   * @param size 尺寸（高度为 0 时按内容自适应且锚点顶对齐，方便动态增删子项）
   */
  static createGrid(name: string, spacex: number = 0, spacey: number = 0, position: Vec2 = new Vec2(0, 0), size: Size = new Size(0, 0)) {
    const node = this.createNode(name, position, size);
    this.applyGridStyle(node, spacex, spacey, position, size);
    return node;
  }

  /**
   * 为已有节点施加网格布局样式（组件"自身即容器"时使用）
   * @param node 目标节点
   * @param spacex 横向间距
   * @param spacey 纵向间距
   * @param position 位置
   * @param size 尺寸（高度为 0 时按内容自适应且锚点顶对齐）
   * @returns 该节点的 Layout 组件
   */
  static applyGridStyle(node: Node, spacex: number = 0, spacey: number = 0, position: Vec2 = new Vec2(0, 0), size: Size = new Size(0, 0)) {
    const uiTransform = node.getComponent(UITransform) ?? node.addComponent(UITransform);
    uiTransform.setContentSize(size);
    node.setPosition(position.x, position.y, 0);
    const layout = node.getComponent(Layout) ?? node.addComponent(Layout);
    layout.type = Layout.Type.GRID;
    layout.resizeMode = size.height ? Layout.ResizeMode.NONE : Layout.ResizeMode.CONTAINER;
    if (!size.height) uiTransform.setAnchorPoint(0.5, 1);
    layout.startAxis = Layout.AxisDirection.HORIZONTAL;
    layout.horizontalDirection = Layout.HorizontalDirection.LEFT_TO_RIGHT;
    layout.verticalDirection = Layout.VerticalDirection.TOP_TO_BOTTOM;
    layout.spacingX = spacex;
    layout.spacingY = spacey;
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
  /**
   * 竖向滚动区（滚动视口 + 顶对齐的自适应纵向内容容器）
   * @param spacing 行间距（默认 3；成长线三窗的稿是 6）
   * @param padding 内容顶部留白（默认 0；首行带描边的列表传 3，
   *   否则首行边框正好压在 mask 裁剪线上、整条边被裁掉 —— 同 #1104 的网格坑）
   */
  static createScrollView(name: string, position: Vec2, size: Size, spacing: number = 3, padding: number = 0) {
    const node = this.createNode(name, position, size);
    node.addComponent(Mask);
    // 滚动区的拖动与点选同样只在 touch 通道；鼠标通道补一次拦截，滚动区内的点击不穿透到下层 UI
    blockClickThrough(node);
    const scrollView = node.addComponent(ScrollView);
    scrollView.inertia = false;
    scrollView.elastic = false;
    const content = this.createFlexCol(`${name}_content`, spacing, new Vec2(0, size.height / 2 - padding), size);
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
