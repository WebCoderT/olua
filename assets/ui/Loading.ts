import { _decorator, Component, director, Label, resources, TiledMapAsset } from "cc";
import { maps } from "../configs/map";
import SceneManager from "./core/SceneManager";
import GameUiHelper from "./helpers/GameUiHelper";
import StorageManager from "./core/StorageManager";

const { ccclass } = _decorator;

/**
 * 过渡场景控制器（挂载于 Loading 场景）
 * 所有场景与地图切换都必须经过本过渡场景：
 * 场景只显示一行字，随资源加载实时显示百分比进度，
 * 目标场景与地图资源全部加载完成后才真正进入游戏
 * 进度分配：场景预加载 0~90%，进入 Game 前的地图资源预加载 90~100%
 */
@ccclass("Loading")
export class Loading extends Component {
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
      // 预加载目标场景资源（0~90）
      await this.preloadScene(scene, (ratio) => this.setProgress(ratio * 90));
      // 进入游戏场景前，必须先完成角色所在地图的资源加载（90~100）
      if (scene === "Game") {
        const role = StorageManager.findOnlineRole();
        const map = role && maps.get(role.onMap);
        if (map) await this.preloadMap(map.src, (ratio) => this.setProgress(90 + ratio * 10));
      }
      this.setProgress(100);
      SceneManager.pendingScene = null;
      director.loadScene(scene);
    } catch (error) {
      console.error("资源加载失败：", error);
      this.setProgressText("加载失败，请重新进入");
    }
  }

  /** 更新进度（ratio 取值 0~1，显示为百分比） */
  private setProgress(ratio: number) {
    this.setProgressText(`加载中 ${Math.min(100, Math.floor(ratio))}%`);
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

  /** 预加载地图资源 */
  private preloadMap(src: string, onProgress: (ratio: number) => void) {
    return new Promise<void>((resolve, reject) => {
      resources.preload(
        src,
        TiledMapAsset,
        (finished: number, total: number) => onProgress(total ? finished / total : 1),
        (error) => (error ? reject(error) : resolve()),
      );
    });
  }
}
