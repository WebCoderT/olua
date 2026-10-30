import { _decorator, Camera, Component, isValid, Node, screen, sys, Vec3 } from "cc";
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
import QuestTracker from "./components/hud/QuestTracker";
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
import OtherPlayerManager from "./core/OtherPlayerManager";
import SocialStore from "./core/SocialStore";
import PartyStore from "./core/PartyStore";
import LeaderboardStore from "./core/LeaderboardStore";
import AchievementStore from "./core/AchievementStore";
import MailStore from "./core/MailStore";
import GuideStore from "./core/GuideStore";
import GuideOverlay from "./components/GuideOverlay";
import { GUIDE_SPOT } from "../types/guide";
import type { GuideSpot } from "../types/guide";
import ChatStore from "./core/ChatStore";
import ChatBubbles from "./core/ChatBubbles";
import QuestStore from "./core/QuestStore";
import QuestNpcMarks from "./core/QuestNpcMarks";
import MonsterAI from "./core/MonsterAI";
import AutoBattle from "./core/AutoBattle";
import AutoBattleTips from "./core/AutoBattleTips";
import RouteIndicator from "./core/RouteIndicator";
import PreloadManager from "./core/PreloadManager";
import RoleUIManager from "./core/RoleUIManager";
import SkillManager from "./core/SkillManager";
import StatusManager from "./core/StatusManager";
import HoverTipManager from "./core/HoverTipManager";
import GameUiHelper from "./helpers/GameUiHelper";
import { partyDialogLayout } from "../configs/hudLayout";
import RoleSync from "./utils/net/RoleSync";
import RealtimeClient, { RealtimeStatus } from "./utils/net/RealtimeClient";
import CombatChannel from "./utils/net/CombatChannel";
import { QuestApi } from "./utils/net/Api";
import { installNetwork } from "./utils/net/NetworkSetup";
import { loadGameConfig } from "./utils/net/ConfigLoader";
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
  /** 任务追踪栏（左侧常驻，进行中的任务与进度；点一下开任务面板） */
  private questTracker: QuestTracker | null = null;
  /** 操作摇杆（左下角常驻，按住拖动即移动；手感参数见 configs/role.joystickMove） */
  private joystick: Joystick | null = null;
  /** 死亡遮罩弹窗（进入死亡流程时创建、复活后销毁） */
  private deathDialog: DeathDialog | null = null;
  /** 场景是否已就绪（start 中的资源预加载完成前，update 不做任何事） */
  private ready = false;
  /** 自然回复（魔法值 / 血量）的结算计时（秒，满 1 秒结算一次） */
  private recoverTimer = 0;
  /** 位置上报的累积计时（#323：CombatChannel.sendPosition 内部也节流，这里是帧累计的触发点） */
  private positionReportTimer = 0;
  /** 上次上报的位置（#324：与本次差量判「是否在移动」，随 pos 帧上报给互见广播） */
  private lastReportedPosition: { x: number; y: number } | null = null;
  /** 窗口尺寸变化的取消监听函数（场景销毁时调用；只用来把相机拉回主角，不重排布局） */
  private offWindowResize: (() => void) | null = null;
  /** 引导进度订阅（#469：走完/跳过的那一刻补开聊天窗；离场退订） */
  private offGuideChange: (() => void) | null = null;
  /** 新手引导遮罩（#402；挂在 UI 层最上面，只在有步骤可显示时 active） */
  private guideOverlay: GuideOverlay | null = null;
  /** 上一帧的主角世界坐标（引导「先动起来」按实际走过的距离判，不看按键） */
  private guideLastPosition: Vec3 | null = null;

  async start() {
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
    // 被管理员下线（后台点了「踢下线」）：角色**还在**，只是账号的在线角色被清了 ——
    // 只清本地的在线标记，绝不能删角色数据，然后回选角界面让他重选一次（选了会重新认领在线角色）
    RoleSync.onKicked = () => {
      GameUiHelper.createTip("role_sync_kicked_tip");
      StorageManager.clearOnlineRole();
      SceneManager.loadScene("RoleSelector");
    };
    // 实时通道（WebSocket）：进游戏才连、离开游戏就断（见 utils/net/RealtimeClient）。
    // 提示只在「状态真的变了」时发一次 —— 服务端挂掉期间每隔几秒重连失败一次，
    // 每次都弹就成了刷屏（这就是 RealtimeClient 把 lost / reconnected / willRetry 分开给的原因）
    RealtimeClient.onStatusChange = (change) => {
      if (change.status === RealtimeStatus.Connected) {
        if (change.reconnected) GameUiHelper.createTip("realtime_reconnected_tip");
        return;
      }
      if (change.status !== RealtimeStatus.Disconnected || !change.lost) return;
      GameUiHelper.createTip(change.willRetry ? "realtime_disconnected_tip" : "realtime_replaced_tip");
    };
    // 伤害结算上移服务端（#34）：settle 帧的结果由怪物管理器落到目标身上（扣血/飘字/死亡）
    CombatChannel.onSettle = MonsterManager.applyServerSettle.bind(MonsterManager);
    // 玩家受击反馈（#13）：怪物普攻命中后播受击动作（优先级规则在 RoleDisplay.playInjured：
    // 施法/死亡不播，其余情况一次性抖一下不打断任何事）；屏幕红闪在 MonsterAI 内直接触发
    MonsterAI.onPlayerHit = () => this.roleDisplay?.playInjured();
    // 世界权威（#35）：world 帧的快照由怪物管理器与场上节点做差量合并（播种落场/重生补场）
    CombatChannel.onWorld = MonsterManager.applyWorldState.bind(MonsterManager);
    // 怪物 AI 权威（#323）：monster-ai 帧由怪物管理器落点（位置趋近演出 + 自己的受击事件），
    // 受击的血量入账/飘字/红闪在这里做（服务端已落账，客户端只演）
    CombatChannel.onMonsterAi = MonsterManager.applyServerAi.bind(MonsterManager);
    // 玩家互见（#324）：players 帧由远端玩家管理器落场（占位节点 + 名字 + 血条，纯演出）；
    // 自己按账号 id 过滤（广播的收件人是同图观看者，服务端不保证剔除发送者）
    CombatChannel.onPlayers = (frame) => OtherPlayerManager.applyPlayersFrame(frame, RealtimeClient.onlineUserId ?? "");
    // 拾取权威（#325）：picked 帧由掉落管理器落账（入包格子照搬 + 收掉地面节点）
    CombatChannel.onPicked = (data) => DropManager.applyPickedFrame(data);
    // 聊天（#395）：chat 帧只喂 ChatStore（回显即成功——自己的消息也从服务端回来），
    // 气泡订阅同一个仓；弹窗开着时它自己挂起气泡并增量上屏
    ChatStore.setSelf(RealtimeClient.onlineUserId ?? "");
    CombatChannel.onChat = (entry) => ChatStore.applyEntry(entry);
    // 任务（#396）：quest 帧只推给本人，落进 QuestStore（追踪栏 / 弹窗 / NPC 标记都读它）
    CombatChannel.onQuest = (frame) =>
      QuestStore.applyState({ questId: frame.questId, status: frame.status as "accepted" | "ready", progress: frame.progress, target: frame.target });
    // 队伍（#399）：三条帧都落进 PartyStore（面板 / 队友名字上色 / 队标都读它）。
    // 进队与离队各飘一句 —— 服务端只在**变化时**推快照，前后一比就知道是不是刚发生的事。
    CombatChannel.onParty = (snapshot) => {
      const before = PartyStore.partyId();
      PartyStore.applySnapshot(snapshot);
      const after = PartyStore.partyId();
      if (!before && after) {
        const leader = (PartyStore.current()?.members ?? []).find((member) => member.leader);
        // 队长是**我自己** = 这支队是我刚建的（邀请别人时顺手建队）→ 不飘「已加入」：
        // 那等于对自己说「你加入了你的队伍」，而邀请成功的「已邀请」已经给了反馈（#498 同族）
        const myRoleId = SocialStore.get()?.myRoleId ?? "";
        if (!leader || leader.roleId !== myRoleId) {
          // 队长那一行理论上一定在（服务端每份快照都标了 leader），找不到就退回「队长」这个词
          GameUiHelper.createTipText(partyDialogLayout.texts.joinedTip.split("{name}").join(leader ? leader.name : partyDialogLayout.texts.stateLeader));
        }
      } else if (before && !after) {
        GameUiHelper.createTipText(partyDialogLayout.texts.endedTip);
      }
    };
    CombatChannel.onPartyInvite = (invite) => {
      PartyStore.applyInvite(invite);
      // 面板开着就不飘字（邀请行已经顶在成员页最上面了，再飘一句是重复提示）
      if (this.bottomBar?.isPartyOpen()) return;
      GameUiHelper.createTipText(partyDialogLayout.texts.inviteReceivedTip.split("{name}").join(invite.fromName));
    };
    // 队友击杀分到的那一份经验：服务端已入账，这里只把经验条 / 修订号接上（不碰血量）
    CombatChannel.onExpGain = (gain) => {
      const exp = StorageManager.applyPartyExpGain(gain);
      if (exp > 0) GameUiHelper.createTipText(partyDialogLayout.texts.expGainTip.split("{exp}").join(`${exp}`));
    };
    // 服务端拒绝（#495：聊天限频 / 组队失败 / 参数不合法…）：把服务端给的原因飘出来。
    // 不接这条的话动作被拒等于没反应（玩家只会反复点），所以文案直接用服务端的 message。
    // 用**错误色**（#498）：拒绝不是普通提示，绿色小字和「已邀请」「经验 +N」混在一起分不出来。
    CombatChannel.onServerError = (error) => GameUiHelper.createErrorTipText(error.message);
    MonsterManager.onPlayerServerHit = (hit) => {
      StorageManager.applyMonsterHit(hit);
      if (!this.roleDisplay) return;
      GameUiHelper.showDamageText(this.roleDisplay, hit.damage);
      GameUiHelper.showHitScreenFlash();
      this.roleDisplay.playInjured();
    };
    // 服务端配置快照（#294）：管理端改的运营配置（成长线文案/价格/属性、商城定价…）进游戏拉一次
    // 覆写进本地 configs（消费点零改动）；静默失败回落本地静态值，游戏照常能玩
    void loadGameConfig();
    RealtimeClient.start();
    // 获取角色信息（本地缓存由选角场景进游戏前写入，见 ui/RoleSelector.enterGame；
    // 旧存档缺失的字段由 StorageManager 在读取时统一补齐）
    const role = StorageManager.findOnlineRole();
    // 任务（#396）：等级用于「可接」判定（服务端只下发有进度行的任务），
    // 进图拉一次全量进度；之后的变化走 quest 帧（打怪 / 对话）与面板里的接取/交付响应
    QuestStore.setLevel(role?.level ?? 0);
    void QuestApi.mine()
      .then((snapshot) => QuestStore.applyStates(snapshot.quests))
      .catch(() => undefined);
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
    /** 任务追踪栏（左侧常驻；点一下开任务面板 —— 面板归底部栏持有，这里只给回调） */
    this.questTracker = new QuestTracker(() => this.bottomBar?.openQuests());
    LayerManager.addToUILayer(this.questTracker);
    /** 小地图（右上角常驻，依赖主角组件取世界坐标） */
    this.smallMap = new SmallMap(this.roleDisplay);
    LayerManager.addToUILayer(this.smallMap);
    /**
     * 操作摇杆（左下角常驻；节点归摇杆组件，输入逻辑在下面注入给主角组件）
     *
     * **只在触屏设备上创建**（sys.isMobile）：web-desktop 构建在电脑浏览器里跑，
     * 移动走键盘/鼠标，摇杆是纯摆设还占掉一块屏幕；手机浏览器打开同一构建时
     * 没有键盘，摇杆必须还在（#462）。
     */
    if (sys.isMobile) {
      this.joystick = new Joystick();
      LayerManager.addToUILayer(this.joystick);
    }
    // 新手引导（#402）：遮罩最后加 → 盖在 HUD 之上；进度从存档读（老档补成「已完成」，不会弹）。
    // 位置解析交给本类（摇杆与底部按钮都在这里持有），所以先注册 provider 再 open
    GuideStore.start(role);
    this.guideOverlay = new GuideOverlay();
    GuideOverlay.setSpotProvider((spot) => this.resolveGuideSpot(spot));
    LayerManager.addToUILayer(this.guideOverlay);
    if (GuideStore.visible()) {
      this.guideOverlay.open();
    } else {
      // 引导已走完/跳过：聊天窗常驻左下角（#469，用户口径「其他网游都放在屏幕左下角」）；
      // auto=true 只开不关、不推进引导（「别一个人玩」那步仍要玩家自己点）
      this.bottomBar?.openChatBox(true);
    }
    // 引导在本次会话里走完/跳过的那一刻也补开（新号引导结束不该等到下次进游戏才有聊天窗）
    this.offGuideChange = GuideStore.onChange(() => {
      if (!GuideStore.visible()) this.bottomBar?.openChatBox(true);
    });
    // 窗口尺寸变化时**不重排任何布局**：本作只有 1920×1080 一个分辨率，HUD 坐标都是常量
    // （见 configs/hudLayout 与 ScreenLayout.designResolution），重排只会算出同一批数字。
    // 唯一要处理的是相机：引擎的 Canvas 在尺寸变化时会把相机世界坐标拽回 Canvas 节点位置
    // （canvas-resize），而相机 / UI 层本该跟着主角 —— 角色站着不动时没有哪一次 LayerManager.move
    // 会把它拉回来，视野就永久错位，所以这条监听留着，且只做这一件事。
    const realignCamera = () => {
      if (this.roleDisplay && isValid(this.roleDisplay)) LayerManager.move(this.roleDisplay.getWorldPosition());
    };
    screen.on("window-resize", realignCamera);
    this.offWindowResize = () => screen.off("window-resize", realignCamera);
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
    // 摇杆操控（触屏设备才有摇杆节点；桌面端键盘/鼠标直接操控，见 components/input）
    if (this.joystick) this.roleDisplay.setJoystick(this.joystick.stickNode, this.joystick.handleNode);
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
    RoleSync.onKicked = null;
    // 实时通道：离开游戏就断（回选角/登录不该还挂着一条连接；先摘回调再断，避免收尾时又提示一句）
    CombatChannel.onSettle = null;
    CombatChannel.onWorld = null;
    CombatChannel.onMonsterAi = null;
    CombatChannel.onPlayers = null;
    CombatChannel.onPicked = null;
    CombatChannel.onChat = null;
    CombatChannel.onQuest = null;
    CombatChannel.onParty = null;
    CombatChannel.onPartyInvite = null;
    CombatChannel.onExpGain = null;
    CombatChannel.onServerError = null;
    MonsterManager.onPlayerServerHit = null;
    MonsterAI.onPlayerHit = null;
    OtherPlayerManager.reset();
    // 社交快照（好友 / 敌人 / 帮会）是「这个角色」的，离开游戏就不该留给下一个角色
    SocialStore.clear();
    // 队伍同理（#399）：队伍是「这个角色此刻」的状态，留着只会让下一角色看到别人的队友
    PartyStore.clear();
    // 榜单缓存（#400）：里面存着「我的名次」，换角色后必须重拉，否则底部那行会写上一个角色的名次
    LeaderboardStore.clear();
    // 成就快照（#401）：达成状态与进度都是「这个角色」的，留着会让下一个角色看到别人的成就墙
    AchievementStore.clear();
    // 收件箱（#429）：邮件是发给具体角色的，换角色后不清会把上一个角色的信显示给下一个
    MailStore.clear();
    // 新手引导（#402）：进度是「这个角色走到第几步」，换角色必须重新 start；
    // 遮罩也随 UI 层一起销毁，这里摘掉解析器并释放引用（不清会指向已销毁的 HUD 节点）
    this.guideOverlay?.close();
    this.guideOverlay = null;
    this.guideLastPosition = null;
    GuideOverlay.setSpotProvider(null);
    GuideStore.reset();
    // 聊天的消息 / 未读 / 气泡同理（消息不跨会话持久是服务端定好的口径，客户端跟着清）
    ChatStore.reset();
    ChatBubbles.reset();
    // 任务同理（进度行不跨角色；NPC 头顶标记挂在地图层，随场景一起清）
    this.questTracker?.dispose();
    this.questTracker = null;
    QuestStore.reset();
    QuestNpcMarks.reset();
    RealtimeClient.onStatusChange = null;
    RealtimeClient.stop();
    // 窗口尺寸监听挂在 screen 单例上（不随节点销毁），必须显式取消
    this.offWindowResize?.();
    this.offWindowResize = null;
    // 引导进度订阅同理（GuideStore 不随场景销毁，挂着的回调会指向已销毁的 bottomBar）
    this.offGuideChange?.();
    this.offGuideChange = null;
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
    // 玩家死亡后不再给怪物提供玩家节点——尸体不会被追击与普攻）。
    // 服务端 AI 权威（#323）：实时通道在线且进过图时，怪物行为 / 位置以 monster-ai 帧为准，
    // 本地只演（向服务端位置趋近）；同时按节流上报自身位置（AI 的目标检测输入）
    if (MonsterManager.serverAuthority) {
      MonsterAI.tick(MonsterManager.getMonsterMap(), null, true);
      OtherPlayerManager.tick(deltaTime);
      this.reportPosition(deltaTime);
    } else {
      MonsterAI.tick(MonsterManager.getMonsterMap(), this.roleDisplay && !this.roleDisplay.isDead() ? this.roleDisplay : null);
    }
    // 小地图每帧驱动（内部按刷新间隔节流：地图名称/世界坐标文本与角色黑点/怪物红点重绘）
    this.smallMap?.update();
    // 掉落物自动拾取（角色走到掉落物上即收入背包，用位移后的最新位置判定）
    const rolePosition = this.roleDisplay?.getWorldPosition();
    if (rolePosition) DropManager.autoPickup(rolePosition);
    // 新手引导（#402）：「先动起来」按**实际走过的距离**判，不看按键 ——
    // 摇杆、方向键、点地面走的都算（这些都是「我在移动」的同一种事实）
    if (rolePosition) {
      if (this.guideLastPosition) {
        GuideStore.notifyMove(Vec3.distance(rolePosition, this.guideLastPosition));
      }
      this.guideLastPosition = rolePosition.clone();
    }
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

  /**
   * 上报自身位置给服务端（#323 AI 目标检测输入 + #324 玩家互见数据源；内部按 4Hz 再节流一层）。
   * 死亡也照报（hp 会是 0，服务端据此停止追击）——「死了还占着位置」比「位置消失」好处理。
   * 是否在移动按「与上次上报的位置差」判（移动是玩家自己的事，客户端自报；自动战斗走位也算移动）。
   */
  /**
   * 引导「语义位」→ 真实节点（#402）
   *
   * 写死坐标在贴边重排的 HUD 上必然错位，所以 `configs/guide` 里存的是语义位，
   * 由这里换成节点；**取不到就返回 null**（`GuideOverlay` 会退化成只显示气泡），
   * 不该因为某个入口还没建出来就让引导整层不显示。
   */
  private resolveGuideSpot(spot: GuideSpot): Node | null {
    switch (spot) {
      case GUIDE_SPOT.JOYSTICK:
        return this.joystick;
      case GUIDE_SPOT.NAV_BAG:
        return this.bottomBar?.navNode("bag") ?? null;
      case GUIDE_SPOT.NAV_SKILL:
        return this.bottomBar?.navNode("skill") ?? null;
      case GUIDE_SPOT.NAV_CHAT:
        return this.bottomBar?.navNode("chat") ?? null;
      case GUIDE_SPOT.SHORTCUT:
        return this.bottomBar?.shortcutNode() ?? null;
      default:
        return null;
    }
  }

  private reportPosition(deltaTime: number) {
    this.positionReportTimer += deltaTime;
    if (this.positionReportTimer < 0.25) return;
    this.positionReportTimer = 0;
    const role = StorageManager.findOnlineRole();
    const position = this.roleDisplay?.getWorldPosition();
    if (!role || !position) return;
    const moving = this.lastReportedPosition === null ||
      Math.hypot(position.x - this.lastReportedPosition.x, position.y - this.lastReportedPosition.y) > 0.5;
    this.lastReportedPosition = { x: position.x, y: position.y };
    CombatChannel.sendPosition(role.onMap, position.x, position.y, role.hp, moving);
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
