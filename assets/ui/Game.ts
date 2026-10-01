import { _decorator, Camera, Component, isValid } from "cc";
import { maps } from "../configs/map";
import MpHelper from "./utils/battle/MpHelper";
import { ActivityController } from "./controllers/ActivityController";
import GameMap from "./components/map/GameMap";
import BottomBar from "./components/hud/BottomBar";
import RoleInfoBar from "./components/hud/RoleInfoBar";
import MonsterInfoPanel from "./components/hud/MonsterInfoPanel";
import MonsterSelectIndicator from "./components/hud/MonsterSelectIndicator";
import SmallMap from "./components/hud/SmallMap";
import RoleDisplay from "./components/role/RoleDisplay";
import ScreenClickInput from "./components/input/ScreenClickInput";
import CursorInput from "./components/input/CursorInput";
import GameHelper from "./core/GameHelper";
import StorageManager from "./core/StorageManager";
import LayerManager from "./core/LayerManager";
import CursorManager from "./core/CursorManager";
import DropManager from "./core/DropManager";
import MonsterManager from "./core/MonsterManager";
import MonsterAI from "./core/MonsterAI";
import AutoBattle from "./core/AutoBattle";
import AutoBattleTips from "./core/AutoBattleTips";
import PreloadManager from "./core/PreloadManager";
import RoleUIManager from "./core/RoleUIManager";
import SkillManager from "./core/SkillManager";
import StatusManager from "./core/StatusManager";
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
  /** 小地图（右上角：地图名称/世界坐标/角色黑点/附近怪物红点） */
  private smallMap: SmallMap | null = null;
  /** 场景是否已就绪（start 中的资源预加载完成前，update 不做任何事） */
  private ready = false;
  /** 魔法值自然回复的结算计时（秒，满 1 秒结算一次） */
  private mpRecoverTimer = 0;

  async start() {
    // 获取角色信息（旧存档缺失的字段由 StorageManager 在读取时统一补齐）
    const role = StorageManager.findOnlineRole();
    // 初始化图层（含掉落物层/怪物层）
    LayerManager.initLayer(this.node, this.camera);
    // 预加载：地图信息 → 地图内 NPC/怪物帧动画 → 当前角色穿戴的帧动画（见 core/PreloadManager）
    // 走 Loading 过渡场景进来时资源已就绪，这里直接命中缓存立即返回；
    // 直接从 Game 场景启动（编辑器里单独跑 Game）时在此补齐，避免进图后逐个节点异步加载帧动画造成卡顿
    const map = role && maps.get(role.onMap);
    if (map) await PreloadManager.preloadGame(map.src, role).catch((error) => console.error("资源预加载失败：", error));
    // 预加载是异步的，期间场景可能已被切换/销毁（组件失效）——此时不再创建任何节点
    if (!isValid(this)) return;
    // 创建地图与主角（互不直接依赖，怪物由地图侧的刷怪区域一次性生成）
    this.gameMap = new GameMap();
    this.roleDisplay = new RoleDisplay(role);
    // 复活点定位：每次进入地图（含大陆传送）都在该地图 npc 对象组的 revive 点位出生
    // 地图是异步加载的、主角在其后创建，故以回调注册，地图先就绪时会立刻回调一次
    this.gameMap.setReviveHandler((worldPosition) => this.roleDisplay.setWorldPositionByTransfer(worldPosition));
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
    /** 小地图（右上角常驻，依赖主角组件取世界坐标） */
    this.smallMap = new SmallMap(this.roleDisplay);
    LayerManager.addToUILayer(this.smallMap);
    /** 怪物信息面板创建器（选中怪物时才动态创建，取消选中即销毁） */
    RoleUIManager.setMonsterInfoFactory((target) => {
      const monsterInfoPanel = new MonsterInfoPanel(target);
      LayerManager.addToUILayer(monsterInfoPanel);
      return monsterInfoPanel;
    });
    /** 选中指示器创建器（怪物脚下的循环光圈，与信息面板同一套生命周期；口径见 configs/effect.selectIndicator） */
    RoleUIManager.setMonsterSelectFactory((target) => {
      const indicator = new MonsterSelectIndicator(target);
      LayerManager.addToEffectLayer(indicator);
      return indicator;
    });
    // 初始化主角外观动画与键盘操控
    this.roleDisplay.init();
    // 自动战斗（快速攻击/自动挂机）以主角为载体走位与出手
    AutoBattle.setRoleDisplay(this.roleDisplay);
    // 技能触发上下文（施法者/选中目标/怪物容器由主角组件提供）
    SkillManager.setContextProvider(() => this.roleDisplay.buildSkillContext());
    // 状态归属主角（状态特效跟随主角移动，见 core/StatusManager）
    StatusManager.setOwner(this.roleDisplay);
    // 初始化游戏全局工具
    GameHelper.init(this.camera);
    /** 挂载全局点击事件 */
    this.screenClickInput.init();
    /** 接管鼠标指针样式（指针配置见 configs/cursor；无鼠标/原生环境自动跳过） */
    CursorManager.init();
    this.cursorInput.init();
    // 挂载活动控制器
    this.node.addComponent(ActivityController);
    // 上面全部就绪后才开始驱动每帧逻辑
    this.ready = true;
  }

  /** 场景卸载：清理全局监听、动态面板与视图引用（图层容器与相机由 LayerManager 在下次 initLayer 重建） */
  onDestroy() {
    this.screenClickInput?.destroy();
    this.cursorInput?.destroy();
    CursorManager.destroy();
    AutoBattle.reset();
    AutoBattleTips.reset();
    StatusManager.reset();
    RoleUIManager.clearViews();
  }

  update(deltaTime: number) {
    // 资源预加载完成前（start 里在 await）不驱动任何逻辑，避免用到还没创建的组件
    if (!this.ready) return;
    // 鼠标指针样式（每帧最多判定一次：鼠标未移动且悬停目标未变化时不做任何事）
    CursorManager.tick();
    // 自动战斗每帧驱动（快速攻击/自动挂机：写入自动移动方向、按冷却出手；移动键按下时由玩家接管）
    // 先于主角 update：本帧写入的自动移动方向当帧即生效
    AutoBattle.tick(this.roleDisplay?.isMovementKeyDown() ?? false);
    // 主角每帧驱动（选中目标失效校验 + 位移）
    this.roleDisplay?.update();
    // 角色魔法值自然回复（每秒结算一次并落盘：角色数据在存储层是反序列化对象，不落盘下次读取会回滚）
    this.mpRecoverTimer += deltaTime;
    if (this.mpRecoverTimer >= 1) {
      const role = StorageManager.findOnlineRole();
      if (role && MpHelper.recover(role, this.mpRecoverTimer * 1000)) {
        StorageManager.updateOnlineRole(role);
        RoleUIManager.updateRoleData(role);
      }
      this.mpRecoverTimer = 0;
    }
    // 自动战斗提示（屏幕中间循环播放：「自动战斗中」挂机期间 /「自动寻路中」自动走位期间，允许同显，挂特效层）
    AutoBattleTips.update(this.roleDisplay);
    // 怪物 AI 每帧驱动（待机游走 / 追击玩家 / 普攻，玩家节点由组合根传入）
    MonsterAI.tick(MonsterManager.getMonsterMap(), this.roleDisplay);
    // 小地图每帧驱动（内部按刷新间隔节流：地图名称/世界坐标文本与角色黑点/怪物红点重绘）
    this.smallMap?.update();
    // 掉落物自动拾取（角色走到掉落物上即收入背包，用位移后的最新位置判定）
    const rolePosition = this.roleDisplay?.getWorldPosition();
    if (rolePosition) DropManager.autoPickup(rolePosition);
    // 快捷键冷却显示
    this.bottomBar?.updateCooldowns();
    // 状态每帧驱动（到期移除 + 身上特效跟随主角）
    StatusManager.tick();
    // 怪物信息面板血量刷新（选中怪物期间一直显示，目标失效时自动销毁）
    RoleUIManager.updateMonsterInfo();
    // 选中指示器跟随目标脚下（目标失效时自动销毁）
    RoleUIManager.updateMonsterSelect();
  }
}
