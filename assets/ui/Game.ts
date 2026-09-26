import { _decorator, Camera, Component, PhysicsSystem, Vec3 } from "cc";
import LayerHelper from "./helpers/LayerHelper";
import BottomBarFrame from "./components/BottomBarFrame";
import RoleAvatarFrame from "./components/RoleAvatarFrame";
import { ActivityController } from "./controllers/ActivityController";
import RoleDisplayFrame from "./components/RoleDisplayFrame";
import MapFrame from "./components/MapFrame";
import RolePlayFrame from "./components/RolePlayFrame";
import GameHelper from "./utils/GameHelper";
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
  // 游戏工具
  gameHelper: GameHelper = GameHelper;

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
    // 初始化游戏全局工具
    this.gameHelper.init(this.camera);
    // 挂载活动控制器
    this.node.addComponent(ActivityController);
  }

  update() {
    RolePlayFrame.updateWorldPosition();
  }
}
