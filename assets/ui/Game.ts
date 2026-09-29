import { _decorator, Camera, Component } from "cc";
import BottomBar from "./components/BottomBar";
import { ActivityController } from "./controllers/ActivityController";
import GameMap from "./components/map/GameMap";
import RoleDisplay from "./components/role/RoleDisplay";
import ScreenClick from "./components/ScreenClick";
import GameHelper from "./core/GameHelper";
import StorageManager from "./core/StorageManager";
import LayerManager from "./core/LayerManager";
import RoleUIManager from "./core/RoleUIManager";
import RoleAvatar from "./components/role/RoleAvatar";
import SkillManager from "./core/SkillManager";
const { ccclass, property } = _decorator;

@ccclass("Game")
export class Game extends Component {
  @property({ type: Camera })
  camera: Camera;

  /** 地图组件 */
  private gameMap: GameMap;
  /** 主角组件 */
  private roleDisplay: RoleDisplay;
  /** 屏幕点击 */
  private screenClick: ScreenClick;
  /** 底部区域 */
  private bottomBar: BottomBar | null = null;
  /** 角色头像 */
  private roleAvatar: RoleAvatar | null = null;

  start() {
    // 获取角色信息
    const role = StorageManager.findOnlineRole();
    // 初始化图层（含怪物层）
    LayerManager.initLayer(this.node, this.camera);
    // 创建地图与主角（互不直接依赖，怪物的生成/查询/结算统一走 MonsterManager）
    this.gameMap = new GameMap();
    this.roleDisplay = new RoleDisplay(role);
    RoleUIManager.registerRoleDisplay(this.roleDisplay);
    this.screenClick = new ScreenClick(this.roleDisplay);
    // 初始化底部
    this.bottomBar = new BottomBar(role);
    LayerManager.addToUILayer(this.bottomBar);
    RoleUIManager.registerBottomBar(this.bottomBar);
    /** 将用户头像加入游戏UI */
    this.roleAvatar = new RoleAvatar(role);
    LayerManager.addToUILayer(this.roleAvatar);
    RoleUIManager.registerRoleAvatar(this.roleAvatar);
    // 初始化主角外观动画与键盘监听
    this.roleDisplay.init();
    // 技能触发上下文（施法者/选中目标/怪物容器由主角组件提供）
    SkillManager.setContextProvider(() => this.roleDisplay.buildSkillContext());
    // 初始化游戏全局工具
    GameHelper.init(this.camera);
    /** 挂载全局点击事件 */
    this.screenClick.init();
    // 挂载活动控制器
    this.node.addComponent(ActivityController);
  }

  /** 场景卸载：清理全局监听（图层容器与相机由 LayerManager 在下次 initLayer 重建） */
  onDestroy() {
    this.screenClick?.destroy();
  }

  update() {
    this.roleDisplay?.updateWorldPosition();
    // 快捷键冷却显示
    this.bottomBar?.updateCooldowns();
  }
}
