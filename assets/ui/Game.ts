import { _decorator, Camera, Component, PhysicsSystem, Vec3 } from "cc";
import BottomBarFrame from "./components/BottomBarFrame";
import { ActivityController } from "./controllers/ActivityController";
import MapFrame from "./components/MapFrame";
import GameHelper from "./utils/GameHelper";
import StorageManager from "./utils/StorageManager";
import RoleDisplayFrame from "./components/RoleDisplayFrame";
import LayerManager from "./utils/LayerManager";
import ScreenClick from "./components/ScreenClick";
import RoleUIManager from "./utils/RoleUIManager";
import RoleAvatar from "./nodes/RoleAvatar";
const { ccclass, property } = _decorator;

@ccclass("Game")
export class Game extends Component {
  @property({ type: Camera })
  camera: Camera;

  //底部区域
  bottomBar: BottomBarFrame = BottomBarFrame;
  // 角色头像
  RoleAvatar: RoleAvatar;
  // 地图显示
  map: MapFrame = MapFrame;
  // 游戏工具
  gameHelper: GameHelper = GameHelper;

  start() {
    // 获取角色信息
    const role = StorageManager.findOnlineRole();
    // 初始化图层
    LayerManager.initLayer(this.node, this.camera);
    // 初始化底部
    this.bottomBar.init(role);
    /** 将用户头像加入游戏UI */
    this.RoleAvatar = new RoleAvatar(role);
    LayerManager.addToUILayer(this.RoleAvatar);
    RoleUIManager.registerRoleAvatar(this.RoleAvatar);
    RoleUIManager.registerBottomBarUpdater((updatedRole) => this.bottomBar.update(updatedRole));
    // 初始化地图
    this.map.init();
    // 初始化游戏全局工具
    this.gameHelper.init(this.camera);
    /** 挂载全局点击事件 */
    ScreenClick.init();
    // 挂载活动控制器
    this.node.addComponent(ActivityController);
  }

  update() {
    RoleDisplayFrame.updateWorldPosition();
  }
}
