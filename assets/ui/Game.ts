import { _decorator, Camera, Component } from "cc";
import { ActivityController } from "./controllers/ActivityController";
import GameMap from "./components/map/GameMap";
import BottomBar from "./components/hud/BottomBar";
import RoleInfoBar from "./components/hud/RoleInfoBar";
import MonsterInfoPanel from "./components/hud/MonsterInfoPanel";
import RoleDisplay from "./components/role/RoleDisplay";
import ScreenClickInput from "./components/input/ScreenClickInput";
import GameHelper from "./core/GameHelper";
import StorageManager from "./core/StorageManager";
import LayerManager from "./core/LayerManager";
import DropManager from "./core/DropManager";
import MonsterManager from "./core/MonsterManager";
import RoleUIManager from "./core/RoleUIManager";
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
  /** 屏幕点击输入 */
  private screenClickInput: ScreenClickInput;
  /** 底部栏（含功能按键区/血球/经验条/快捷键栏） */
  private bottomBar: BottomBar | null = null;
  /** 角色信息栏 */
  private roleInfoBar: RoleInfoBar | null = null;

  start() {
    // 获取角色信息
    const role = StorageManager.findOnlineRole();
    // 初始化图层（含掉落物层/怪物层）
    LayerManager.initLayer(this.node, this.camera);
    // 创建地图与主角（互不直接依赖，怪物的生成/查询/结算统一走 MonsterManager）
    this.gameMap = new GameMap();
    this.roleDisplay = new RoleDisplay(role);
    RoleUIManager.registerRoleDisplay(this.roleDisplay);
    this.screenClickInput = new ScreenClickInput(this.roleDisplay);
    // 初始化底部栏（其内部自行组装功能按键区/血球/经验条/快捷键栏，并持有各弹窗）
    this.bottomBar = new BottomBar(role);
    LayerManager.addToUILayer(this.bottomBar);
    RoleUIManager.registerBottomBar(this.bottomBar);
    /** 将角色信息栏加入游戏UI */
    this.roleInfoBar = new RoleInfoBar(role);
    LayerManager.addToUILayer(this.roleInfoBar);
    RoleUIManager.registerRoleInfoBar(this.roleInfoBar);
    /** 怪物信息面板创建器（选中怪物时才动态创建，取消选中即销毁） */
    RoleUIManager.setMonsterInfoFactory((target) => {
      const monsterInfoPanel = new MonsterInfoPanel(target);
      LayerManager.addToUILayer(monsterInfoPanel);
      return monsterInfoPanel;
    });
    // 初始化主角外观动画与键盘操控
    this.roleDisplay.init();
    // 技能触发上下文（施法者/选中目标/怪物容器由主角组件提供）
    SkillManager.setContextProvider(() => this.roleDisplay.buildSkillContext());
    // 初始化游戏全局工具
    GameHelper.init(this.camera);
    /** 挂载全局点击事件 */
    this.screenClickInput.init();
    // 挂载活动控制器
    this.node.addComponent(ActivityController);
  }

  /** 场景卸载：清理全局监听、动态面板与视图引用（图层容器与相机由 LayerManager 在下次 initLayer 重建） */
  onDestroy() {
    this.screenClickInput?.destroy();
    RoleUIManager.clearViews();
  }

  update(deltaTime: number) {
    // 主角每帧驱动（选中目标失效校验 + 位移）
    this.roleDisplay?.update();
    // 掉落物自动拾取（角色走到掉落物上即收入背包，用位移后的最新位置判定）
    const rolePosition = this.roleDisplay?.getWorldPosition();
    if (rolePosition) DropManager.autoPickup(rolePosition);
    // 怪物重生检测（按刷怪区域的重生时间统计数量并补充）
    MonsterManager.update(deltaTime);
    // 快捷键冷却显示
    this.bottomBar?.updateCooldowns();
    // 怪物信息面板血量刷新（选中怪物期间一直显示，目标失效时自动销毁）
    RoleUIManager.updateMonsterInfo();
  }
}
