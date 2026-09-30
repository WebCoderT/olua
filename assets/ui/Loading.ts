import { _decorator, Component, director, Label } from "cc";
import { maps } from "../configs/map";
import SceneManager from "./core/SceneManager";
import PreloadManager from "./core/PreloadManager";
import GameUiHelper from "./helpers/GameUiHelper";
import StorageManager from "./core/StorageManager";

const { ccclass } = _decorator;

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

  start() {
    // 背景
    this.node.addChild(GameUiHelper.createFullScreenImage("loading_background", "loading/loading_bg"));
    // 一行进度文字（百分比显示）
    const progress = GameUiHelper.createLoadingProgress("加载中 0%");
    this.progressLabel = progress.progressLabel;
    this.node.addChild(progress.node);
    this.load();
  }

  /** 预加载资源，全部完成后进入目标场景 */
  private async load() {
    const scene = SceneManager.pendingScene ?? "Login";
    try {
      // 预加载目标场景资源（0~50）
      await this.preloadScene(scene, (ratio) => this.setProgress(ratio * Loading.SCENE_PROGRESS_END));
      // 进入游戏场景前预加载游戏资源（50~100）：地图信息 → 地图内 NPC/怪物帧动画 → 角色穿戴的帧动画
      if (scene === "Game") {
        const role = StorageManager.findOnlineRole();
        const map = role && maps.get(role.onMap);
        if (map) {
          await PreloadManager.preloadGame(map.src, role, (ratio, tip) => this.setProgress(Loading.SCENE_PROGRESS_END + ratio * (100 - Loading.SCENE_PROGRESS_END), tip));
        }
      }
      this.setProgress(100);
      SceneManager.pendingScene = null;
      director.loadScene(scene);
    } catch (error) {
      console.error("资源加载失败：", error);
      this.setProgressText("加载失败，请重新进入");
    }
  }

  /** 更新进度（ratio 取值 0~1，显示为百分比；tip 为当前阶段的说明，如"帧动画 3/7"） */
  private setProgress(ratio: number, tip?: string) {
    const percent = Math.min(100, Math.floor(ratio));
    this.setProgressText(tip ? `加载中 ${percent}% · ${tip}` : `加载中 ${percent}%`);
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
