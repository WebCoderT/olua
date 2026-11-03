import { director } from "cc";
import SoundManager from "./SoundManager";

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
    // 循环音（登录背景音）跟着场景走：这里是全项目唯一的场景切换入口，
    // 所以「离开登录场景就停背景音」只写这一处（见 core/SoundManager，节点本身常驻不销毁）
    SoundManager.stopMusic();
    this.pendingScene = sceneName;
    director.loadScene("Loading");
  }
}
