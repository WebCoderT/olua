import { director } from "cc";

type Scenes = "Login" | "RoleSelector" | "Game";
const SceneManager = {
  loadScene: (sceneName: Scenes) => {
    director.loadScene(sceneName);
  },
};

export default SceneManager;
