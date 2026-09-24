import { _decorator, Camera, Component, error, Node, Size, Sprite, tween, UIOpacity, Vec2, Vec3 } from "cc";
import GameUiHelper from "./GameUiHelper";
import StorageHelper from "./StorageHelper";
import LayerHelper from "./LayerHelper";
import UiHelper from "./UiHelper";
import { bottomNavBarButtons, getCurrentLevelExpRate, Role } from "../configs";
import BottomBarFrame from "./components/BottomBarFrame";
import RoleAvatarFrame from "./components/RoleAvatarFrame";
const { ccclass, property } = _decorator;

@ccclass("Game")
export class Game extends Component {
  @property({ type: Camera })
  camera: Camera;

  selectedRole: Role;

  bottomBar: BottomBarFrame = BottomBarFrame;

  roleAvatar: RoleAvatarFrame = RoleAvatarFrame;

  start() {
    // 初始化图层
    LayerHelper.initLayer(this.node, this.camera);
    // 初始化底部
    this.bottomBar.init();
    // 用户头像
    this.roleAvatar.init();
  }

  update(deltaTime: number) {}
}
