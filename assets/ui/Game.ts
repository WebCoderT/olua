import { _decorator, Camera, Component, isValid } from "cc";
import { maps } from "../configs/map";
import MpHelper from "./utils/battle/MpHelper";
import HpHelper from "./utils/battle/HpHelper";
import { ActivityController } from "./controllers/ActivityController";
import GameMap from "./components/map/GameMap";
import BottomBar from "./components/hud/BottomBar";
import RoleInfoBar from "./components/hud/RoleInfoBar";
import MonsterInfoPanel from "./components/hud/MonsterInfoPanel";
import MonsterSelectIndicator from "./components/hud/MonsterSelectIndicator";
import SmallMap from "./components/hud/SmallMap";
import Joystick from "./components/hud/Joystick";
import RoleDisplay from "./components/role/RoleDisplay";
import ScreenClickInput from "./components/input/ScreenClickInput";
import CursorInput from "./components/input/CursorInput";
import DeathDialog from "./components/dialogs/DeathDialog";
import GameHelper from "./core/GameHelper";
import StorageManager from "./core/StorageManager";
import SceneManager from "./core/SceneManager";
import LayerManager from "./core/LayerManager";
import CursorManager from "./core/CursorManager";
import DropManager from "./core/DropManager";
import MonsterManager from "./core/MonsterManager";
import MonsterAI from "./core/MonsterAI";
import AutoBattle from "./core/AutoBattle";
import AutoBattleTips from "./core/AutoBattleTips";
import RouteIndicator from "./core/RouteIndicator";
import PreloadManager from "./core/PreloadManager";
import RoleUIManager from "./core/RoleUIManager";
import SkillManager from "./core/SkillManager";
import StatusManager from "./core/StatusManager";
import HoverTipManager from "./core/HoverTipManager";
import { applyScreenPolicy, onWindowResize } from "./utils/layout/ScreenLayout";
import GameUiHelper from "./helpers/GameUiHelper";
import RoleSync from "./utils/net/RoleSync";
import { installNetwork } from "./utils/net/NetworkSetup";
import { describeError } from "./utils/net/ApiError";
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
  /** 操作摇杆（左下角常驻，按住拖动即移动；手感参数见 configs/role.joystickMove） */
  private joystick: Joystick | null = null;
  /** 死亡遮罩弹窗（进入死亡流程时创建、复活后销毁） */
  private deathDialog: DeathDialog | null = null;
  /** 场景是否已就绪（start 中的资源预加载完成前，update 不做任何事） */
  private ready = false;
  /** 自然回复（魔法值 / 血量）的结算计时（秒，满 1 秒结算一次） */
  private recoverTimer = 0;
  /** 窗口尺寸变化的取消监听函数（场景销毁时调用） */
  private offWindowResize: (() => void) | null = null;

  async start() {
    // 屏幕适配：铺满窗口（无黑边），可见宽度随窗口宽高比变化（见 utils/layout/ScreenLayout）
    applyScreenPolicy();
    // 网络层接线（幂等，登录场景已调过一次）：令牌失效回登录场景、请求失败统一飘字
    installNetwork();
    // 角色进度同步的失败出口：同步请求是静默的（不弹通用提示），
    // 这里接上「只提示一次」的飘字，避免后端挂了之后打怪期间被刷屏（见 utils/net/RoleSync）
    RoleSync.onFailed = (error) => GameUiHelper.createErrorTipText(describeError(error));
    // 同步成功：把服务端刚给的修订号记回本地（下一次推送带着它做乐观锁，否则会拿旧版本撞自己）
    RoleSync.onSaved = (roleId, revision) => StorageManager.applyServerRevision(roleId, revision);
    // 撞上乐观锁：角色被后台改过 —— 以服务端最新数据为基线（后台改动优先），并告知玩家
    RoleSync.onConflict = (fresh) => {
      const role = StorageManager.cacheServerRole(fresh);
      GameUiHelper.createTip("role_sync_conflict_tip");
      if (role) RoleUIManager.updateRoleData(role);
    };
    // 角色已被后台删除：本地不该继续玩一个不存在的角色（否则会卡在永远同步失败的游戏里）
    RoleSync.onMissing = (roleId) => {
      GameUiHelper.createTip("role_sync_missing_tip");
      StorageManager.deleteRole(roleId);
      SceneManager.loadScene("RoleSelector");
    };
    // 获取角色信息（本地缓存由选角场景进游戏前写入，见 ui/RoleSelector.enterGame；
    // 旧存档缺失的字段由 StorageManager 在读取时统一补齐）
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
    /** 操作摇杆（左下角常驻；节点归摇杆组件，输入逻辑在下面注入给主角组件） */
    this.joystick = new Joystick();
    LayerManager.addToUILayer(this.joystick);
    // 窗口尺寸变化时重排四个常驻区域（角色信息栏贴左上角 / 小地图贴右上角 / 底部栏贴底部居中 / 摇杆贴左下角）
    // 注意顺序：引擎的 Canvas 在尺寸变化时会把相机世界坐标拽回 Canvas 节点位置（canvas-resize），
    // 而相机/UI 层本该跟着主角，故重排后必须再把相机与 UI 层重新对齐到主角，否则地图视野会错位
    this.offWindowResize = onWindowResize(() => {
      // 相机与 UI 层重新对齐到主角（Canvas 在尺寸变化时会把相机拽回 Canvas 节点位置）
      if (this.roleDisplay && isValid(this.roleDisplay)) LayerManager.move(this.roleDisplay.getWorldPosition());
      this.roleInfoBar?.applyAnchorPosition();
      this.smallMap?.applyAnchorPosition();
      this.bottomBar?.applyAnchorPosition();
      this.joystick?.applyAnchorPosition();
    });
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
    // 左下角摇杆操控（摇杆节点在 HUD 层、屏幕空间贴着左下角，故在这里把手感逻辑交给主角组件）
    this.roleDisplay.setJoystick(this.joystick.stickNode, this.joystick.handleNode);
    // 战魂外显（上次勾选过则进图直接挂上，见 RoleDisplay.updateSoulShow）
    this.roleDisplay.updateSoulShow();
    // 称号外显（已激活称号则进图直接挂上，见 RoleDisplay.updateTitleShow）
    this.roleDisplay.updateTitleShow();
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
    // 把防抖窗口里还没推给服务端的角色进度推掉（切地图/退出都会走到这里销毁本场景，
    // 不 flush 的话这几秒内的改动会随场景一起丢；失败与否都由 RoleSync 自己处理，不阻塞卸载）
    void RoleSync.flush();
    // 场景卸载后飘字出口可能失效（场景根都要没了），先摘掉回调
    RoleSync.onFailed = null;
    RoleSync.onSaved = null;
    RoleSync.onConflict = null;
    RoleSync.onMissing = null;
    // 窗口尺寸监听挂在 screen 单例上（不随节点销毁），必须显式取消
    this.offWindowResize?.();
    this.offWindowResize = null;
    this.screenClickInput?.destroy();
    this.cursorInput?.destroy();
    CursorManager.destroy();
    AutoBattle.reset();
    AutoBattleTips.reset();
    RouteIndicator.reset();
    HoverTipManager.hide();
    StatusManager.reset();
    RoleUIManager.clearViews();
    // 死亡弹窗随 UI 层一起随场景销毁，这里只释放引用
    this.deathDialog = null;
  }

  update(deltaTime: number) {
    // 资源预加载完成前（start 里在 await）不驱动任何逻辑，避免用到还没创建的组件
    if (!this.ready) return;
    // 角色死亡检测（怪物普攻把血量扣到 0 即进入死亡流程：死亡动画 + 复活弹窗）
    this.checkRoleDeath();
    // 鼠标指针样式（每帧最多判定一次：鼠标未移动且悬停目标未变化时不做任何事）
    CursorManager.tick();
    // 自动战斗每帧驱动（快速攻击/自动挂机：写入自动移动方向、按冷却出手；玩家手动移动时由玩家接管）
    // 先于主角 update：本帧写入的自动移动方向当帧即生效
    AutoBattle.tick(this.roleDisplay?.isManualMoving() ?? false);
    // 主角每帧驱动（选中目标失效校验 + 位移）
    this.roleDisplay?.update();
    // 角色自然回复（每秒结算一次并落盘：角色数据在存储层是反序列化对象，不落盘下次读取会回滚）
    // 魔法值按 configs/role.mpRecoverPerSecond 的固定速度；血量按角色的 hpRecover 属性
    // （等级 / 防御装备 / 战魂 / 称号 / 军衔之和，见 ui/utils/battle/HpHelper）。
    // 两者共用同一次落盘与刷新：同一秒里先后各写一次存档没有意义，反而把服务端同步的防抖窗口挤掉
    this.recoverTimer += deltaTime;
    if (this.recoverTimer >= 1) {
      const role = StorageManager.findOnlineRole();
      if (role) {
        const mpChanged = MpHelper.recover(role, this.recoverTimer * 1000);
        const hpChanged = HpHelper.recover(role, this.recoverTimer * 1000);
        if (mpChanged || hpChanged) {
          StorageManager.updateOnlineRole(role);
          RoleUIManager.updateRoleData(role);
        }
      }
      this.recoverTimer = 0;
    }
    // 自动战斗提示（屏幕中间循环播放：「自动战斗中」挂机期间 /「自动寻路中」自动走位期间，允许同显，挂特效层）
    AutoBattleTips.update(this.roleDisplay);
    // 路线指示线（自动寻路期间在大地图地面上画出「角色 → 目标」的路线；无路线时清空）
    RouteIndicator.update(this.roleDisplay);
    // 怪物 AI 每帧驱动（待机游走 / 追击玩家 / 普攻，玩家节点由组合根传入；
    // 玩家死亡后不再给怪物提供玩家节点——尸体不会被追击与普攻）
    MonsterAI.tick(MonsterManager.getMonsterMap(), this.roleDisplay && !this.roleDisplay.isDead() ? this.roleDisplay : null);
    // 小地图每帧驱动（内部按刷新间隔节流：地图名称/世界坐标文本与角色黑点/怪物红点重绘）
    this.smallMap?.update();
    // 掉落物自动拾取（角色走到掉落物上即收入背包，用位移后的最新位置判定）
    const rolePosition = this.roleDisplay?.getWorldPosition();
    if (rolePosition) DropManager.autoPickup(rolePosition);
    // 快捷键冷却显示
    this.bottomBar?.updateCooldowns();
    // 状态每帧驱动（到期移除 + 身上特效跟随主角）
    StatusManager.tick();
    // 悬停详情弹窗每帧驱动（剩余时间/冷却剩余刷新；图标销毁或状态到期时收起）
    HoverTipManager.tick();
    // 怪物信息面板血量刷新（选中怪物期间一直显示，目标失效时自动销毁）
    RoleUIManager.updateMonsterInfo();
    // 选中指示器跟随目标脚下（目标失效时自动销毁）
    RoleUIManager.updateMonsterSelect();
  }

  //#region 死亡与复活

  /**
   * 角色死亡检测（每帧校验）：角色血量归零即进入死亡流程——
   * 停自动战斗 → 播死亡动画并锁全部操控（见 RoleDisplay.die）→ 弹出复活选择弹窗
   * 血量归零也可能来自上一次会话的存档（死亡时退出游戏），进图后同样会在这里补上死亡流程
   */
  private checkRoleDeath() {
    const role = StorageManager.findOnlineRole();
    if (!role || role.hp > 0 || !this.roleDisplay || this.roleDisplay.isDead()) return;
    AutoBattle.cancel();
    this.roleDisplay.die();
    this.deathDialog = new DeathDialog({
      onReviveInPlace: () => this.reviveRole(false),
      onReviveSafe: () => this.reviveRole(true),
    });
    LayerManager.addToUILayer(this.deathDialog);
  }

  /**
   * 复活：补满血量与魔法值并落盘刷新视图，然后按复活方式收尾——
   * 原地复活：留在死亡位置直接起身；安全复活：先传送回当前地图的复活点再起身
   */
  private reviveRole(safe: boolean) {
    const role = StorageManager.findOnlineRole();
    if (!role) return;
    role.hp = role.maxHp;
    role.mp = role.maxMp;
    StorageManager.updateOnlineRole(role);
    RoleUIManager.updateRoleData(role);
    // 安全复活先传送（复活点定位走 GameMap 的 revive 回调，与进图定位同一套换算）
    if (safe) this.gameMap?.revive();
    this.roleDisplay?.revive();
    this.deathDialog?.destroy();
    this.deathDialog = null;
  }

  //#endregion
}
