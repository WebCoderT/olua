import { Graphics, Label, Node, Size, UITransform, Vec2, Vec3 } from "cc";
import UiHelper from "../helpers/UiHelper";
import GameUiHelper from "../helpers/GameUiHelper";
import { guideConfig, guideOverlayStyle, guideStepCount } from "../../configs/guide";
import type { GuideSpot } from "../../types/guide";
import GuideStore from "../core/GuideStore";

/** 屏幕上的矩形（本层局部坐标，原点在屏幕中心） */
interface SpotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 新手引导的遮罩层（#402）
 *
 * 一屏四块黑边挖出一个洞罩住当前步骤的目标，旁边挂一条气泡说「做什么」，
 * 气泡上常显「跳过引导」。**整层不参与点击**（只有跳过按钮是按钮）：
 * 引导绝不锁移动、不拦面板 —— 卡死即事故，玩家想自己乱点就先让他乱点。
 *
 * 目标位置**不写死在配置里**：HUD 是贴边重排的（HUD 位置见 hudLayout 各 position（固定值）），
 * 写死坐标换个窗口宽高比就错位。这里把「语义位」（`GUIDE_SPOT`）交给组合根注册的
 * `spotProvider` 换成真实节点；取不到就只显示气泡（不画洞、不报错）。
 */
export default class GuideOverlay extends Node {
  /** 语义位 → 真实节点（组合根在 HUD 建好之后注册） */
  private static spotProvider: ((spot: GuideSpot) => Node | null) | null = null;

  /** 注册解析器（传 null 摘掉；组合根 onDestroy 时摘） */
  static setSpotProvider(provider: ((spot: GuideSpot) => Node | null) | null): void {
    this.spotProvider = provider;
  }

  private mask: Graphics;
  private frame: Graphics;
  private bubble: Node;
  private titleLabel: Label;
  private descLabel: Label;
  private progressLabel: Label;
  private unsubscribe: (() => void) | null = null;

  constructor() {
    super(guideOverlayStyle.names.overlay);
    const layout = guideConfig.layout;
    const screen = UiHelper.getScreenSize();
    this.addComponent(UITransform).setContentSize(screen.width, screen.height);
    // 遮罩：四块矩形拼出「口」字形，中间留洞（比 Mask 组件省事，也不需要额外贴图）
    const maskNode = new Node(guideOverlayStyle.names.mask);
    this.mask = maskNode.addComponent(Graphics);
    this.mask.fillColor = guideOverlayStyle.colors.mask;
    this.addChild(maskNode);
    // 高亮描边（金色一圈，让「看这里」更明确）
    const frameNode = new Node(guideOverlayStyle.names.frame);
    this.frame = frameNode.addComponent(Graphics);
    this.frame.lineWidth = layout.spotBorderWidth;
    this.frame.strokeColor = guideOverlayStyle.colors.frame;
    this.addChild(frameNode);
    this.bubble = this.createBubble();
    this.addChild(this.bubble);
    this.titleLabel = this.bubble.getChildByName(guideOverlayStyle.names.title).getComponent(Label);
    this.descLabel = this.bubble.getChildByName(guideOverlayStyle.names.desc).getComponent(Label);
    this.progressLabel = this.bubble.getChildByName(guideOverlayStyle.names.progress).getComponent(Label);
    this.active = false;
  }

  /** 打开（订阅进度变化） */
  open(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = GuideStore.onChange(() => this.render());
    this.active = true;
    this.render();
  }

  /** 关闭（退订；节点留着复用，不销毁） */
  close(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.active = false;
  }

  /** 重画遮罩与气泡（屏幕尺寸是常量，打开 / 换步骤时调） */
  refresh(): void {
    if (this.active) this.render();
  }

  /** 按当前步骤重绘；没有步骤可显示时自己关掉 */
  private render(): void {
    const step = GuideStore.currentStep();
    const progress = GuideStore.current();
    if (!step || !progress) {
      // 走完最后一步 → 飘一句「引导结束」；跳过的那句在按钮里发（两条路不一样）
      if (this.active && progress && progress.done) GameUiHelper.createTipText(guideConfig.texts.finished);
      this.close();
      return;
    }
    const screen = UiHelper.getScreenSize();
    const spot = GuideOverlay.spotProvider ? GuideOverlay.spotProvider(step.spot) : null;
    const hole = spot ? this.spotRect(spot) : null;
    this.drawMask(screen.width, screen.height, hole);
    this.drawFrame(hole);
    this.titleLabel.string = step.title;
    this.descLabel.string = step.desc;
    // 进度文案只在配置里写一处（`{index}` / `{total}` 两个占位）
    this.progressLabel.string = guideConfig.texts.progress.split("{index}").join(`${progress.step + 1}`).split("{total}").join(`${guideStepCount()}`);
    this.layoutBubble(screen.width, screen.height, hole);
    this.layoutSkipButton();
  }

  /**
   * 目标节点的屏幕矩形（转成本层局部坐标）
   *
   * 取两个对角点分别转换再算宽高，而不是「中心 + 世界宽高」—— 万一父层带缩放，
   * 后者算出来的宽高会偏，而这层是给贴边 HUD 挖的洞，偏一点就露出黑边。
   */
  private spotRect(spot: Node): SpotRect {
    const self = this.getComponent(UITransform);
    const target = spot.getComponent(UITransform);
    const pad = guideConfig.layout.spotPadding;
    if (!self || !target) return { x: 0, y: 0, width: 0, height: 0 };
    const box = target.getBoundingBoxToWorld();
    const topLeft = self.convertToNodeSpaceAR(new Vec3(box.x, box.y + box.height, 0));
    const bottomRight = self.convertToNodeSpaceAR(new Vec3(box.x + box.width, box.y, 0));
    return {
      x: (topLeft.x + bottomRight.x) / 2,
      y: (topLeft.y + bottomRight.y) / 2,
      width: Math.abs(bottomRight.x - topLeft.x) + pad * 2,
      height: Math.abs(topLeft.y - bottomRight.y) + pad * 2,
    };
  }

  /** 四块矩形拼遮罩；没有洞时整屏一块（目标还没创建出来就是这种情况） */
  private drawMask(screenWidth: number, screenHeight: number, hole: SpotRect | null): void {
    const g = this.mask;
    g.clear();
    const left = -screenWidth / 2;
    const bottom = -screenHeight / 2;
    const right = left + screenWidth;
    const top = bottom + screenHeight;
    if (!hole) {
      g.rect(left, bottom, screenWidth, screenHeight);
      g.fill();
      return;
    }
    const holeLeft = hole.x - hole.width / 2;
    const holeRight = hole.x + hole.width / 2;
    const holeBottom = hole.y - hole.height / 2;
    const holeTop = hole.y + hole.height / 2;
    // 上 / 下 / 左 / 右：四块拼起来只剩中间的洞
    g.rect(left, holeTop, screenWidth, top - holeTop);
    g.rect(left, bottom, screenWidth, holeBottom - bottom);
    g.rect(left, holeBottom, holeLeft - left, hole.height);
    g.rect(holeRight, holeBottom, right - holeRight, hole.height);
    g.fill();
  }

  /** 洞的金色描边（没有洞就不画） */
  private drawFrame(hole: SpotRect | null): void {
    const g = this.frame;
    g.clear();
    if (!hole) return;
    g.rect(hole.x - hole.width / 2, hole.y - hole.height / 2, hole.width, hole.height);
    g.stroke();
  }

  /**
   * 气泡位置：洞在上半屏 → 气泡放洞下面；洞在下半屏 → 气泡放洞上面
   *
   * 四个边界都夹一下（`screenMargin` + 气泡自身尺寸），否则底部功能栏那几步的
   * 气泡会被屏幕切掉一半 —— 而底部功能栏恰好是最后三步的高亮目标。
   */
  private layoutBubble(screenWidth: number, screenHeight: number, hole: SpotRect | null): void {
    const layout = guideConfig.layout;
    const transform = this.bubble.getComponent(UITransform);
    const height = transform ? transform.height : 0;
    const width = transform ? transform.width : 0;
    const margin = layout.screenMargin;
    const limitY = screenHeight / 2 - margin - height / 2;
    const limitX = screenWidth / 2 - margin - width / 2;
    if (!hole) {
      this.bubble.setPosition(0, -limitY, 0);
      return;
    }
    const above = hole.y + hole.height / 2 + layout.bubbleGap + height / 2;
    const below = hole.y - hole.height / 2 - layout.bubbleGap - height / 2;
    const preferred = hole.y > 0 ? below : above;
    const y = Math.max(-limitY, Math.min(limitY, preferred));
    const x = Math.max(-limitX, Math.min(limitX, hole.x));
    this.bubble.setPosition(x, y, 0);
  }

  /** 跳过按钮贴气泡右下角（按钮尺寸取它自己的 UITransform，不在这里猜） */
  private layoutSkipButton(): void {
    const layout = guideConfig.layout;
    const bubble = this.bubble.getComponent(UITransform);
    if (!bubble) return;
    let skip = this.bubble.getChildByName(guideOverlayStyle.names.skip);
    if (!skip) {
      skip = GameUiHelper.createMiddleButton(guideOverlayStyle.names.skip, guideConfig.texts.skip, new Vec2(0, 0));
      skip.on(Node.EventType.TOUCH_END, () => this.onSkip(), this);
      this.bubble.addChild(skip);
    }
    const skipTransform = skip.getComponent(UITransform);
    const width = skipTransform ? skipTransform.width : 0;
    const height = skipTransform ? skipTransform.height : 0;
    skip.setPosition(bubble.width / 2 - layout.bubblePadding - width / 2, -bubble.height / 2 + layout.bubblePadding + height / 2, 0);
  }

  /** 点跳过：落存档 + 飘一句（跳过与走完是两条不同的路，提示分开） */
  private onSkip(): void {
    GuideStore.skip();
    GameUiHelper.createTipText(guideConfig.texts.skipped);
  }

  /** 气泡本体：底板 + 标题 + 正文 + 进度（跳过按钮在 layoutSkipButton 里挂，尺寸要等组件给） */
  private createBubble(): Node {
    const layout = guideConfig.layout;
    const width = layout.bubbleWidth;
    const height = layout.bubbleHeight;
    const bubble = new Node(guideOverlayStyle.names.bubble);
    bubble.addComponent(UITransform).setContentSize(width, height);
    const background = new Node(guideOverlayStyle.names.bubbleBackground).addComponent(Graphics);
    background.fillColor = guideOverlayStyle.colors.bubble;
    background.roundRect(-width / 2, -height / 2, width, height, guideOverlayStyle.bubbleRadius);
    background.fill();
    background.lineWidth = guideOverlayStyle.bubbleBorderWidth;
    background.strokeColor = guideOverlayStyle.colors.bubbleBorder;
    background.roundRect(-width / 2, -height / 2, width, height, guideOverlayStyle.bubbleRadius);
    background.stroke();
    bubble.addChild(background.node);
    const inner = width - layout.bubblePadding * 2;
    // 标题（左对齐、靠上）
    bubble.addChild(
      UiHelper.createLabel(
        guideOverlayStyle.names.title,
        "",
        guideOverlayStyle.colors.title,
        layout.titleFontSize,
        new Vec2(0, height / 2 - layout.bubblePadding - layout.titleFontSize),
        new Size(inner, layout.titleFontSize * 1.4),
        Label.HorizontalAlign.LEFT,
        Label.VerticalAlign.CENTER,
      ),
    );
    // 正文（多行、宽度固定、高度随内容；**锚点在顶边** —— RESIZE_HEIGHT 的高度增长以锚点为基准，
    // 锚点在中心时两行以上的正文会向上下两个方向长，向上就顶进标题区，真机上就是
    // 「标题压在正文第一行上」（#462）。顶部起点 = 标题占位（titleFontSize*1.4）+ 一段间距，
    // 间距进 layout，不写死在组件里）
    const desc = UiHelper.createWrappedLabel(
      "guide_desc",
      "",
      guideOverlayStyle.colors.desc,
      layout.descFontSize,
      layout.descFontSize * 1.5,
      new Vec2(0, height / 2 - layout.bubblePadding - layout.titleFontSize * 1.4 - layout.descGap),
      inner,
      Label.HorizontalAlign.LEFT,
    );
    desc.getComponent(UITransform)?.setAnchorPoint(0.5, 1);
    bubble.addChild(desc);
    // 进度（左下）
    bubble.addChild(
      UiHelper.createLabel(
        guideOverlayStyle.names.progress,
        "",
        guideOverlayStyle.colors.progress,
        layout.progressFontSize,
        new Vec2(-inner / 2 + 70, -height / 2 + layout.bubblePadding + layout.progressFontSize / 2),
        new Size(160, layout.progressFontSize * 1.4),
        Label.HorizontalAlign.LEFT,
        Label.VerticalAlign.CENTER,
      ),
    );
    return bubble;
  }
}
