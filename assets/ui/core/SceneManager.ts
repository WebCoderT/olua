import { director } from "cc";

type Scenes = "Login" | "RoleSelector" | "Game";

/**
 * 场景管理器
 * 所有场景与地图切换均先经过 Loading 过渡场景：
 * 过渡场景预加载目标场景与地图资源（一行文字实时显示百分比），
 * 资源加载完成后才真正进入游戏
 */
export default class SceneManager {
  /** 待进入的目标场景（由 Loading 过渡场景读取并消费） */
  static pendingScene: Scenes | null = null;

  /** 带过渡加载场景：先进入 Loading 过渡场景，资源就绪后再进入目标场景 */
  static loadScene(sceneName: Scenes) {
    this.pendingScene = sceneName;
    director.loadScene("Loading");
  }
}
