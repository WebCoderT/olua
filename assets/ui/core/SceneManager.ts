import { director } from "cc";

type Scenes = "Login" | "RoleSelector" | "Game";

/**
 * 场景管理器
 */
export default class SceneManager {
  static loadScene(sceneName: Scenes) {
    director.loadScene(sceneName);
  }
}

