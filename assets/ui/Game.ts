import { _decorator, Camera, Component } from "cc";
import { ActivityController } from "./controllers/ActivityController";
import GameMap from "./components/map/GameMap";
import BottomBar from "./components/hud/BottomBar";
import RoleInfoBar from "./components/hud/RoleInfoBar";
import MonsterInfoPanel from "./components/hud/MonsterInfoPanel";
import RoleDisplay from "./components/role/RoleDisplay";
import ScreenClickInput from "./components/input/ScreenClickInput";
import CursorInput from "./components/input/CursorInput";
import GameHelper from "./core/GameHelper";
import StorageManager from "./core/StorageManager";
import LayerManager from "./core/LayerManager";
import CursorManager from "./core/CursorManager";
import DropManager from "./core/DropManager";
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
  /** 鼠标指针输入（上报鼠标位置，指针样式由 CursorManager 判定） */
  private cursorInput: CursorInput;
  /** 底部栏（含功能按键区/血球/经验条/快捷键栏） */
  private bottomBar: BottomBar | null = null;
  /** 角色信息栏 */
  private roleInfoBar: RoleInfoBar | null = null;

  start() {
    // 获取角色信息
    const role = StorageManager.findOnlineRole();
    // 初始化图层（含掉落物层/怪物层）
    LayerManager.initLayer(this.node, this.camera);
    // 创建地图与主角（互不直接依赖，怪物由地图侧的刷怪区域一次性生成）
    this.gameMap = new GameMap();
    this.roleDisplay = new RoleDisplay(role);
    RoleUIManager.registerRoleDisplay(this.roleDisplay);
    this.screenClickInput = new ScreenClickInput(this.roleDisplay);
    this.cursorInput = new CursorInput();
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
    /** 接管鼠标指针样式（指针配置见 configs/cursor；无鼠标/原生环境自动跳过） */
    CursorManager.init();
    this.cursorInput.init();
    // 挂载活动控制器
    this.node.addComponent(ActivityController);
  }

  /** 场景卸载：清理全局监听、动态面板与视图引用（图层容器与相机由 LayerManager 在下次 initLayer 重建） */
  onDestroy() {
    this.screenClickInput?.destroy();
    this.cursorInput?.destroy();
    CursorManager.destroy();
    RoleUIManager.clearViews();
  }

  update() {
    // 鼠标指针样式（每帧最多判定一次：鼠标未移动且悬停目标未变化时不做任何事）
    CursorManager.tick();
    // 主角每帧驱动（选中目标失效校验 + 位移）
    this.roleDisplay?.update();
    // 掉落物自动拾取（角色走到掉落物上即收入背包，用位移后的最新位置判定）
    const rolePosition = this.roleDisplay?.getWorldPosition();
    if (rolePosition) DropManager.autoPickup(rolePosition);
    // 快捷键冷却显示
    this.bottomBar?.updateCooldowns();
    // 怪物信息面板血量刷新（选中怪物期间一直显示，目标失效时自动销毁）
    RoleUIManager.updateMonsterInfo();
  }
}
