import { _decorator, Camera, Component, PhysicsSystem, Vec3 } from "cc";
import LayerHelper from "./LayerHelper";
import BottomBarFrame from "./components/BottomBarFrame";
import RoleAvatarFrame from "./components/RoleAvatarFrame";
import { ActivityController } from "./controllers/ActivityController";
import RoleDisplayFrame from "./components/RoleDisplayFrame";
import MapFrame from "./components/MapFrame";
import RolePlayFrame from "./components/RolePlayFrame";
const { ccclass, property } = _decorator;

@ccclass("Game")
export class Game extends Component {
  @property({ type: Camera })
  camera: Camera;

  //底部区域
  bottomBar: BottomBarFrame = BottomBarFrame;
  // 角色头像
  roleAvatar: RoleAvatarFrame = RoleAvatarFrame;
  // 角色显示效果
  roleDisplay: RoleDisplayFrame = RoleDisplayFrame;
  // 地图显示
  map: MapFrame = MapFrame;

  start() {
    // 初始化图层
    LayerHelper.initLayer(this.node, this.camera);
    // 初始化底部
    this.bottomBar.init();
    // 初始化用户头像
    this.roleAvatar.init();
    // 初始化角色显示
    this.roleDisplay.init(this.node);
    // 初始化地图
    this.map.init();
    // 挂载活动控制器
    this.node.addComponent(ActivityController);
  }

  update(deltaTime: number) {
    RolePlayFrame.updateWorldPosition(deltaTime);
  }
}
