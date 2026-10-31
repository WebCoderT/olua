import { _decorator, Component, director, Label, Mask, Node, UITransform, Vec2 } from "cc";
import { maps } from "../configs/map";
import SceneManager from "./core/SceneManager";
import PreloadManager from "./core/PreloadManager";
import GameUiHelper from "./helpers/GameUiHelper";
import AnimationHelper from "./helpers/AnimationHelper";
import StorageManager from "./core/StorageManager";
import { loadingLayout } from "../configs/hudLayout";
import { getText } from "../configs/texts";

const { ccclass } = _decorator;

/** 【临时开关】true = 加载完不跳转，停在 Loading 场景 100%（调场景效果用；调完改回 false） */
const STAY_AFTER_LOADED = false;

/**
 * 过渡场景控制器（挂载于 Loading 场景）
 * 所有场景与地图切换都必须经过本过渡场景：
 * 场景只显示一行字，随资源加载实时显示百分比进度与当前阶段，
 * 目标场景与游戏资源全部加载完成后才真正进入游戏
 * 进度分配：目标场景资源 0~50%，进入 Game 前的游戏资源预加载 50~100%
 * （游戏资源 = 地图信息 + 地图内 NPC/怪物帧动画 + 角色穿戴的帧动画，见 core/PreloadManager）
 */
@ccclass("Loading")
export class Loading extends Component {
  /** 场景资源在总进度中的占比上限（其余部分留给游戏资源预加载） */
  private static readonly SCENE_PROGRESS_END = 50;

  /** 进度文本 */
  private progressLabel: Label | null = null;
  /** 进度条填充的 Mask（宽度跟进度走，从内条左缘起裁切 —— 图不拉伸，见 configs bar.fillArea 注释） */
  private progressFillMask: UITransform | null = null;

  start() {
    // 背景与进度文字（位置、字号与用图见 configs/hudLayout.loadingLayout）
    this.node.addChild(GameUiHelper.createFullScreenImage("loading_background", loadingLayout.background));
    // 居中的加载帧动画（图集 7 帧循环；显示尺寸 / 帧率见 configs loadingLayout.loadingAnimation）
    const animLayout = loadingLayout.loadingAnimation;
    const animation = GameUiHelper.createImage("loading_animation", "", animLayout.position, animLayout.size);
    AnimationHelper.playLoopAtlas("loading_animation", animation, animLayout.atlas, animLayout.frameRate);
    this.node.addChild(animation);
    // 底部进度条：底图 + 填充图。填充图挂 Mask 下，Mask 锚点在内条左缘、宽度 = 进度 × 内条宽 ——
    // 填充区坐标全部按条显示尺寸从素材占比现算（fillArea 是素材原生占比，条改大小不用改这里）
    const barLayout = loadingLayout.bar;
    const fillArea = barLayout.fillArea;
    this.node.addChild(GameUiHelper.createImage(`${barLayout.name}_background`, barLayout.background, barLayout.position, barLayout.size));
    // 内条左缘 / 纵心相对**条中心**的偏移（由素材占比 × 条显示尺寸现算）
    const relLeft = (fillArea.leftFrac - 0.5) * barLayout.size.width;
    const relOffsetY = -(fillArea.yCenterFrac - 0.5) * barLayout.size.height;
    // Mask 锚点 (0,0.5) 定在内条左缘：舞台坐标 = 条坐标 + 相对偏移
    const fillMask = new Node(`${barLayout.name}_fill_mask`);
    this.progressFillMask = fillMask.addComponent(UITransform);
    this.progressFillMask.setAnchorPoint(0, 0.5);
    fillMask.setPosition(barLayout.position.x + relLeft, barLayout.position.y + relOffsetY, 0);
    this.progressFillMask.setContentSize(0, fillArea.heightFrac * barLayout.size.height); // 初始进度 0 → 宽 0
    fillMask.addComponent(Mask);
    // 填充图与底图对齐：子节点（锚点 0.5,0.5）摆在「条中心相对 Mask 锚点」的局部坐标 = 负的相对偏移
    const fill = GameUiHelper.createImage(`${barLayout.name}_fill`, barLayout.fill, new Vec2(-relLeft, -relOffsetY), barLayout.size);
    fillMask.addChild(fill);
    this.node.addChild(fillMask);
    // 一行小字：进度条右下角（位置 / 字号见 configs loadingLayout.progress）
    const progress = GameUiHelper.createLoadingProgress(loadingLayout.progress.text, loadingLayout.progress.position, loadingLayout.progress.fontSize);
    this.progressLabel = progress.progressLabel;
    this.node.addChild(progress.node);
    this.load();
  }

  /** 预加载资源，全部完成后进入目标场景 */
  private async load() {
    const scene = SceneManager.pendingScene ?? "Login";
    const startedAt = Date.now();
    try {
      // 预加载目标场景资源（0~50）
      await this.timed(`目标场景 ${scene}`, startedAt, () =>
        this.preloadScene(scene, (ratio) => this.setProgress(ratio * Loading.SCENE_PROGRESS_END)),
      );
      // 进入游戏场景前预加载游戏资源（50~100）：地图信息 → 地图内 NPC/怪物帧动画 → 角色穿戴的帧动画
      if (scene === "Game") {
        const role = StorageManager.findOnlineRole();
        const map = role && maps.get(role.onMap);
        if (map) {
          await this.timed("游戏资源（地图/帧动画）", startedAt, () =>
            PreloadManager.preloadGame(map.src, role, (ratio, tip) => this.setProgress(Loading.SCENE_PROGRESS_END + ratio * (100 - Loading.SCENE_PROGRESS_END), tip)),
          );
        }
      }
      this.setProgress(100);
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
      this.setProgressText(getText("progress_failed"));
    }
  }

  /** 记录阶段耗时（量化加载瓶颈，与 PreloadManager 的阶段耗时日志配套看） */
  private async timed<T>(name: string, startedAt: number, task: () => Promise<T>): Promise<T> {
    const begin = Date.now();
    const result = await task();
    console.log(`[Loading] ${name}加载耗时 ${Date.now() - begin}ms（自开始加载起 ${Date.now() - startedAt}ms）`);
    return result;
  }

  /** 更新进度（ratio 取值 0~100；填充 Mask 宽度 + 百分比小字同步；tip 为当前阶段的说明，如"帧动画 3/7"） */
  private setProgress(ratio: number, tip?: string) {
    const percent = Math.min(100, Math.floor(ratio));
    if (this.progressFillMask) {
      const fillArea = loadingLayout.bar.fillArea;
      this.progressFillMask.width = Math.max(0, Math.min(1, ratio / 100)) * fillArea.widthFrac * loadingLayout.bar.size.width;
    }
    this.setProgressText(tip ? getText("progress_loading_tip", { percent, tip }) : getText("progress_loading", { percent }));
  }

  /** 设置进度文本 */
  private setProgressText(text: string) {
    if (this.progressLabel) this.progressLabel.string = text;
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
