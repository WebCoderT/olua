import { _decorator, Camera, Component, error, Node, Size, Sprite, tween, UIOpacity, Vec2, Vec3 } from "cc";
import LayerHelper from "./LayerHelper";
import { Role } from "../configs";
import BottomBarFrame from "./components/BottomBarFrame";
import RoleAvatarFrame from "./components/RoleAvatarFrame";
import { ActivityController } from "./controllers/ActivityController";
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
    // 挂载活动控制器
    this.node.addComponent(ActivityController);
  }

  update(deltaTime: number) {}
}
