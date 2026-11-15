import { _decorator, Component, director, Graphics, Label, Node, Size, tween, UITransform, Vec2 } from "cc";
import SceneManager from "./core/SceneManager";
import PreloadManager from "./core/PreloadManager";
import GameUiHelper from "./helpers/GameUiHelper";
import UiHelper from "./helpers/UiHelper";
import StorageManager from "./core/StorageManager";
import { buttonTone, loadingLayout, T } from "../configs/hudLayout";
import { getText } from "../configs/texts";
import { installNetwork } from "./utils/net/NetworkSetup";
import { loadGameConfig } from "./utils/net/ConfigLoader";
import type { GameConfigLoadResult } from "./utils/net/ConfigLoader";

const { ccclass } = _decorator;

/** 【临时开关】true = 加载完不跳转，停在 Loading 场景 100%（调场景效果用；调完改回 false） */
const STAY_AFTER_LOADED = false;

/**
 * 过渡场景控制器（挂载于 Loading 场景）
 *
 * 视觉对齐 `design/olua-ui/screens/03-loading.html`：一屏只讲「进度」——
 * 中央一圈金色进度环（外圈断续刻度缓慢旋转）+ 大号百分比 + 阶段说明，
 * 底部一条通栏细线 + 四阶段刻度（运营配置 / 场景资源 / 帧动画 / 进入世界）。
 * 所有几何与配色在 configs/layout/scenes.loadingLayout，本文件只组装与刷新。
 *
 * 进度分配：**运营配置快照**（#604，只在进 Game 时拉）→ 目标场景资源 0~50%，进入 Game 前的
 * 游戏资源预加载 50~100%（游戏资源 = 地图信息 + 地图内 NPC/怪物帧动画 + 角色穿戴的帧动画，见 core/PreloadManager）
 *
 * ## 为什么运营配置在这里拉（#604）
 * 预加载要读**快照里的表**（怪物资源行给帧动画目录、NPC 给对话对象、时装给外观图集…）。
 * 以前快照在 `Game.start` 里才拉，而 Loading 的预载排在它之前 —— 那时这些表是空的，
 * 所以「进图前预载完怪物 / NPC 帧动画」实际只对地图与角色生效，其余进图后逐个异步补。
 * 提到这里之后：① 预载真正命中；② 配置是**硬依赖** —— 拉不到就停在 Loading，
 * 而不是进一个「背包空、技能点不出来」的游戏（客户端出厂表已随 #603 全部退场）。
 */
@ccclass("Loading")
export class Loading extends Component {
  /** 场景资源在总进度中的占比上限（其余部分留给游戏资源预加载） */
  private static readonly SCENE_PROGRESS_END = 50;

  /** 中央百分比 / 阶段名 / 阶段明细三行文字 */
  private percentLabel: Label | null = null;
  private phaseTitle: Label | null = null;
  private phaseDetail: Label | null = null;
  /** 环形进度弧（重画用）与底部细线的填充 / 亮点 */
  private ringGraphics: Graphics | null = null;
  private barFill: Node | null = null;
  private barKnob: Node | null = null;
  /** 四阶段刻度：圆点（重画状态）+ 文字 */
  private stepDots: Graphics[] = [];
  private stepLabels: Label[] = [];
  /** 失败面板（#604）：只在配置拉不到时出现，重试时销毁 */
  private failureDetail: Node | null = null;
  /** 已停在失败态（等玩家点「重试」） */
  private failed = false;
  /** 当前进度（0~100，供失败后重试复位刻度用） */
  private ratio = 0;

  start() {
    this.createBackground();
    this.createRing();
    this.createBottomBar();
    this.createPhaseText();
    this.load();
  }

  //#region 组装

  private createBackground() {
    this.node.addChild(GameUiHelper.createFullScreenImage("loading_background", loadingLayout.background));
    const brand = loadingLayout.brand;
    this.node.addChild(GameUiHelper.createImage(brand.name, brand.image, brand.position, brand.size));
  }

  /** 中央进度环：刻度（慢转）+ 底轨 + 进度弧，环心上方摆百分比 */
  private createRing() {
    const ring = loadingLayout.ring;
    const ringNode = UiHelper.createNode("loading_ring", ring.center, new Size(ring.radius * 2, ring.radius * 2));
    this.node.addChild(ringNode);

    // 外圈断续刻度：静态画一次，整圈节点慢速旋转（设计稿 26s 一转）
    const ticks = UiHelper.createNode("loading_ring_ticks", new Vec2(), new Size(ring.ticks.outer * 2, ring.ticks.outer * 2));
    const tickGraphics = ticks.addComponent(Graphics);
    tickGraphics.lineWidth = T.border.width;
    tickGraphics.strokeColor = ring.ticks.color;
    for (let i = 0; i < ring.ticks.count; i++) {
      const angle = (i * ring.ticks.stepDeg * Math.PI) / 180;
      tickGraphics.moveTo(Math.cos(angle) * ring.ticks.inner, Math.sin(angle) * ring.ticks.inner);
      tickGraphics.lineTo(Math.cos(angle) * ring.ticks.outer, Math.sin(angle) * ring.ticks.outer);
    }
    tickGraphics.stroke();
    ringNode.addChild(ticks);
    tween(ticks).by(ring.ticks.rotateMs / 1000, { angle: -360 }).repeatForever().start();

    // 进度弧（底轨 + 弧本身都在同一个 Graphics 上重画）
    const arcNode = UiHelper.createNode("loading_ring_arc", new Vec2(), new Size(ring.radius * 2, ring.radius * 2));
    this.ringGraphics = arcNode.addComponent(Graphics);
    ringNode.addChild(arcNode);
    this.paintRing(0);

    // 百分比 + 小小的 % 号
    const percent = loadingLayout.percent;
    this.percentLabel = UiHelper.createLabel("loading_percent", "0", percent.color, percent.fontSize, percent.position, new Size(200, 70)).getComponent(Label);
    ringNode.addChild(this.percentLabel!.node);
    const unit = UiHelper.createLabel(
      "loading_percent_unit",
      percent.unitText,
      percent.unitColor,
      percent.unitSize,
      new Vec2(percent.position.x + 62, percent.position.y - 14),
      new Size(40, 30),
    );
    ringNode.addChild(unit);
  }

  /** 阶段名（环下方）与明细行（再下一行） */
  private createPhaseText() {
    const phase = loadingLayout.phase;
    this.phaseTitle = UiHelper.createLabel("loading_phase_title", getText("progress_config"), phase.title.color, phase.title.fontSize, phase.title.position, phase.title.size).getComponent(
      Label,
    );
    this.node.addChild(this.phaseTitle!.node);
    this.phaseDetail = UiHelper.createLabel("loading_phase_detail", "", phase.detail.color, phase.detail.fontSize, phase.detail.position, phase.detail.size).getComponent(Label);
    this.node.addChild(this.phaseDetail!.node);
  }

  /** 底部通栏细线（底轨 + 金色填充 + 末端亮点）与四阶段刻度 */
  private createBottomBar() {
    const bar = loadingLayout.bar;
    const track = UiHelper.createNode(`${bar.name}_track`, bar.position, new Size(bar.width, bar.height));
    const trackGraphics = track.addComponent(Graphics);
    trackGraphics.fillColor = bar.trackColor;
    trackGraphics.rect(-bar.width / 2, -bar.height / 2, bar.width, bar.height);
    trackGraphics.fill();
    this.node.addChild(track);

    this.barFill = UiHelper.createNode(`${bar.name}_fill`, new Vec2(-bar.width / 2, bar.position.y), new Size(0, bar.height));
    const fillGraphics = this.barFill.addComponent(Graphics);
    fillGraphics.fillColor = bar.fillColor;
    fillGraphics.rect(0, -bar.height / 2, 1, bar.height);
    fillGraphics.fill();
    this.barFill.getComponent(UITransform)!.setAnchorPoint(0, 0.5);
    this.node.addChild(this.barFill);

    this.barKnob = UiHelper.createNode(`${bar.name}_knob`, new Vec2(-bar.width / 2, bar.position.y), new Size(bar.knobSize, bar.knobSize));
    const knobGraphics = this.barKnob.addComponent(Graphics);
    knobGraphics.fillColor = bar.stepNowColor;
    knobGraphics.circle(0, 0, bar.knobSize / 2);
    knobGraphics.fill();
    this.node.addChild(this.barKnob);

    // 四阶段刻度：等距铺开，圆点在左、文字在右
    const steps = bar.steps;
    const gap = steps.length > 1 ? bar.width / (steps.length - 1) : 0;
    steps.forEach((step, index) => {
      const x = -bar.width / 2 + gap * index;
      const dot = UiHelper.createNode(`${bar.name}_step_dot_${index}`, new Vec2(x, bar.stepsPositionY), new Size(bar.stepDot, bar.stepDot));
      const dotGraphics = dot.addComponent(Graphics);
      this.stepDots.push(dotGraphics);
      this.node.addChild(dot);
      const label = UiHelper.createLabel(
        `${bar.name}_step_${index}`,
        getText(step.textKey),
        bar.stepIdleColor,
        bar.stepFontSize,
        new Vec2(x + 40, bar.stepsPositionY),
        new Size(120, 18),
      ).getComponent(Label);
      this.stepLabels.push(label!);
      this.node.addChild(label!.node);
    });
    this.paintBar(0);
  }

  //#endregion

  //#region 绘制

  /** 重画环形进度（ratio 0~100）：底轨恒在，进度弧从 12 点方向顺时针长 */
  private paintRing(ratio: number) {
    const graphics = this.ringGraphics;
    if (!graphics) return;
    const ring = loadingLayout.ring;
    graphics.clear();
    graphics.lineWidth = ring.trackWidth;
    graphics.strokeColor = ring.trackColor;
    graphics.circle(0, 0, ring.radius);
    graphics.stroke();
    if (ratio <= 0) return;
    graphics.lineWidth = ring.barWidth;
    graphics.strokeColor = ring.barColor;
    graphics.arc(0, 0, ring.radius, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * Math.min(1, ratio / 100)), false);
    graphics.stroke();
  }

  /** 重画底部细线（填充宽度 + 亮点位置 + 四阶段刻度状态） */
  private paintBar(ratio: number) {
    const bar = loadingLayout.bar;
    const clamped = Math.max(0, Math.min(1, ratio / 100));
    const filledWidth = Math.max(1, bar.width * clamped);
    const fillTransform = this.barFill?.getComponent(UITransform);
    if (fillTransform) {
      fillTransform.setContentSize(filledWidth, bar.height);
      const graphics = this.barFill?.getComponent(Graphics);
      if (graphics) {
        graphics.clear();
        graphics.fillColor = bar.fillColor;
        graphics.rect(0, -bar.height / 2, filledWidth, bar.height);
        graphics.fill();
      }
    }
    this.barKnob?.setPosition(-bar.width / 2 + bar.width * clamped, bar.position.y, 0);

    const steps = bar.steps;
    let nowIndex = steps.findIndex((step) => ratio < step.until);
    if (nowIndex < 0) nowIndex = steps.length - 1;
    this.stepDots.forEach((dot, index) => {
      const color = index < nowIndex ? bar.stepDoneColor : index === nowIndex ? bar.stepNowColor : bar.stepIdleColor;
      dot.clear();
      dot.fillColor = color;
      dot.circle(0, 0, bar.stepDot / 2);
      dot.fill();
      dot.lineWidth = T.border.width;
      dot.strokeColor = color;
      dot.circle(0, 0, bar.stepDot / 2);
      dot.stroke();
      const label = this.stepLabels[index];
      if (label) label.color = color;
    });
  }

  //#endregion

  /** 预加载资源，全部完成后进入目标场景 */
  private async load() {
    const scene = SceneManager.pendingScene ?? "Login";
    const startedAt = Date.now();
    try {
      // 运营配置快照（#604）：进 Game 之前拉。失败就停在原地（下面 showConfigFailure），
      // 不构建游戏世界 —— 客户端没有出厂表可回落，带病进图只会看到「背包空、技能点不出来」
      if (scene === "Game") {
        installNetwork();
        this.setProgress(1, getText("progress_config"));
        const config = await loadGameConfig();
        if (!config.ok) {
          this.showConfigFailure(config);
          return;
        }
      }
      // 预加载目标场景资源（0~50）
      await this.timed(`目标场景 ${scene}`, startedAt, () =>
        this.preloadScene(scene, (ratio) => this.setProgress(ratio * Loading.SCENE_PROGRESS_END, getText("progress_stage_scene"))),
      );
      // 进入游戏场景前预加载游戏资源（50~100）：地图信息 → 地图内 NPC/怪物帧动画 → 角色穿戴的帧动画
      if (scene === "Game") {
        const role = StorageManager.findOnlineRole();
        // 资源路径与帧动画来源都按地图 id 走（#672：NPC / 刷怪区从服务端快照取，不读 TMX）
        if (role) {
          await this.timed("游戏资源（地图/帧动画）", startedAt, () =>
            PreloadManager.preloadGame(role.onMap, role, (ratio, tip) =>
              this.setProgress(Loading.SCENE_PROGRESS_END + ratio * (100 - Loading.SCENE_PROGRESS_END), tip ?? getText("progress_frames_short")),
            ),
          );
        }
      }
      this.setProgress(100, getText("progress_world"));
      // 【临时】调 Loading 场景效果用：加载完停在 100% 不跳转（pendingScene 也不清，
      // 把上面 STAY_AFTER_LOADED 改回 false 后，下次进 Loading 仍按原目标场景走）
      if (STAY_AFTER_LOADED) {
        console.log(`[Loading] 临时不跳转（STAY_AFTER_LOADED）—— 场景 ${scene} 资源就绪，停在 Loading`);
        return;
      }
      SceneManager.pendingScene = null;
      director.loadScene(scene);
      console.log(`[Loading] 场景 ${scene} 加载总耗时 ${Date.now() - startedAt}ms`);
    } catch (error) {
      console.error("资源加载失败：", error);
      this.setPhase(getText("progress_failed"), "");
    }
  }

  /**
   * 配置没拉下来（#604）：停在 Loading，写明原因，等玩家点「重试」
   *
   * 两类失败都停在原地：`network`（服务端没起 / 断网）与 `contract`（服务端漏发段）。
   * 区别只在明细文案 —— 前者「重试大概率就好」，后者要按 key 去服务端补段，
   * 所以明细用的是 `缺少「技能配置」（skills）：整段缺失` 这种能直接对代码的措辞。
   *
   * 为什么是按钮而不是「点屏幕任意处重试」：Loading 场景里的图片节点都不吞事件，
   * 在根节点上收 touchend 确实能收到，但那属于「没登记输入通道就当能点」——
   * `make audit` 的 `audit-ui-click-through` 会直接把根节点上的点击监听判成穿点。
   * 按钮走 createButton（自带 blockClickThrough），鼠标 / 触摸两条通道都是显式的。
   */
  private showConfigFailure(result: GameConfigLoadResult): void {
    this.failed = true;
    this.setPhase(getText("progress_config_failed"), "");
    console.error(`[Loading] ${result.reason === "contract" ? "配置契约不满足" : "配置拉取失败"}：${result.message ?? ""}`, result.problems ?? []);
    this.destroyFailureDetail();
    const layout = loadingLayout.failure;
    // 失败面板：矢量弹窗底板（金线 + 四角铆钉）+ 标题 + 明细 + 重试
    const panel = GameUiHelper.createDialogPanel(layout.panel.name, layout.panel.size);
    panel.setPosition(layout.panel.position.x, layout.panel.position.y, 0);
    this.node.addChild(panel);
    panel.addChild(UiHelper.createLabel(`${layout.panel.name}_title`, getText(layout.title.textKey), layout.title.color, layout.title.fontSize, layout.title.position, layout.title.size));
    const detail = GameUiHelper.createText(
      `${layout.panel.name}_detail`,
      truncate(result.message ?? "", 200),
      layout.detailFontSize,
      layout.detailPosition,
      new Size(layout.detailWidth, 0),
      layout.detailColor,
    );
    const label = detail.getComponent(Label);
    if (label) {
      label.overflow = Label.Overflow.RESIZE_HEIGHT;
      label.enableWrapText = true;
    }
    panel.addChild(detail);
    const retry = GameUiHelper.createToneButton(
      `${layout.panel.name}_retry`,
      getText("progress_config_retry"),
      layout.retryPosition,
      layout.retrySize,
      T.fontSize.f16,
      buttonTone.primary,
    );
    retry.on(Node.EventType.TOUCH_END, () => this.retryIfFailed(), this);
    panel.addChild(retry);
    this.failureDetail = panel;
  }

  /** 点「重试」= 从头再走一遍加载（配置是最前面那一步，会重拉快照） */
  private retryIfFailed(): void {
    if (!this.failed) return;
    this.failed = false;
    this.destroyFailureDetail();
    this.setProgress(0);
    void this.load();
  }

  private destroyFailureDetail(): void {
    if (!this.failureDetail) return;
    this.failureDetail.destroy();
    this.failureDetail = null;
  }

  /** 记录阶段耗时（量化加载瓶颈，与 PreloadManager 的阶段耗时日志配套看） */
  private async timed<T>(name: string, startedAt: number, task: () => Promise<T>): Promise<T> {
    const begin = Date.now();
    const result = await task();
    console.log(`[Loading] ${name}加载耗时 ${Date.now() - begin}ms（自开始加载起 ${Date.now() - startedAt}ms）`);
    return result;
  }

  /** 更新进度（ratio 0~100）：环 + 底部细线 + 大号百分比 + 阶段名一起走 */
  private setProgress(ratio: number, tip?: string) {
    this.ratio = Math.max(0, Math.min(100, ratio));
    const percent = Math.floor(this.ratio);
    this.paintRing(this.ratio);
    this.paintBar(this.ratio);
    if (this.percentLabel) this.percentLabel.string = String(percent);
    this.setPhase(tip ?? getText("progress_stage_scene"), getText("progress_loading", { percent }));
  }

  /** 阶段名 + 明细行（失败态复用同一处，明细留空） */
  private setPhase(title: string, detail: string) {
    if (this.phaseTitle) this.phaseTitle.string = title;
    if (this.phaseDetail) this.phaseDetail.string = detail;
  }

  /** 预加载场景资源 */
  private preloadScene(sceneName: string, onProgress: (ratio: number) => void) {
    return new Promise<void>((resolve, reject) => {
      director.preloadScene(
        sceneName,
        (completedCount: number, totalCount: number) => onProgress(totalCount ? completedCount / totalCount : 1),
        (error) => (error ? reject(error) : resolve()),
      );
    });
  }
}

/** 截断长文案（失败明细可能是十几段的问题清单，屏幕上只留开头，全文在控制台） */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…（完整清单见控制台）` : text;
}
