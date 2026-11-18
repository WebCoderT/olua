import { isValid, Label, Node, ProgressBar, UITransform, Vec2, Vec3 } from "cc";
import StorageManager from "../../core/StorageManager";
import { Role } from "../../../entities/Role";
import { ACTION, DIRECTION } from "../../../types/animation";
import { actionFinishTimeoutMarginSeconds } from "../../../configs/animation";
import { roleBody } from "../../../configs/role";
import { networkConfig } from "../../../configs/network";
import { SkillContextInput } from "../../../types/skill";
import LayerManager from "../../core/LayerManager";
import GameUiHelper from "../../helpers/GameUiHelper";
import { getDirectionByVector } from "../../utils/battle/BattleMath";
import { getSoulLevel } from "../../../configs/game-config";
import { getTitleLevel } from "../../../configs/game-config";
import { roleShowLayout } from "../../../configs/hudLayout";
import MonsterManager from "../../core/MonsterManager";
import RoleUIManager from "../../core/RoleUIManager";
import SnapshotInterpolator from "../../core/SnapshotInterpolator";
import ServerClock from "../../utils/net/ServerClock";
import RoleAppearance from "./RoleAppearance";
import RoleKeyboardInput from "../input/RoleKeyboardInput";
import RolePointerInput from "../input/RolePointerInput";
import RoleJoystickInput from "../input/RoleJoystickInput";

/**
 * 服务端快照的瞬移阈值（像素，#1139）
 *
 * 与缓冲最新快照的差量超过它判定「合法大位移」（突进落位 / 复活传送 / 服务端重播种），
 * 整段跳过不滑行 —— 清缓冲从头压，下一拍直接落在新位置。正常行走到不了这条线：
 * 跑速 128px/s 在 10Hz 广播下一帧只走 ~13px。
 */
const SELF_SNAP_DISTANCE = 64;

/**
 * 角色展示组件（自身即主角节点）
 * 负责主角节点的构建与状态机（动作/朝向）、移动意图上报、攻击锁与技能上下文组装
 * 具体职责由协作组件承担：外观动画 → RoleAppearance，键盘操控 → RoleKeyboardInput，
 * 鼠标操控 → RolePointerInput，左下角摇杆操控 → RoleJoystickInput（节点在 HUD 层，见 setJoystick）
 * 怪物查询与结算统一走 MonsterManager
 * **位置是纯演出（#1139 移动收权）**：本地不跑任何物理 —— 输入只组装移动意图帧发给服务端
 * （服务端 10Hz 步进 + 仲裁），自己与别人一样按服务端帧插值回放（见 updatePlayback）。
 * 攻击/技能锁（attacking）：动作动画从播放到完整播完期间不接受新的攻击/技能（按下无反应）；
 * 攻击锁期间意图恒 null，服务端同步停步，两边的「站着打」是同一份状态
 */
export default class RoleDisplay extends Node {
  /** 外观（衣服/武器节点与动画） */
  private appearance: RoleAppearance;
  /** 键盘操控输入（init 时创建） */
  private keyboardInput: RoleKeyboardInput | null = null;
  /** 鼠标操控输入（init 时创建：左键按下走路、右键按下跑动、抬起即停） */
  private pointerInput: RolePointerInput | null = null;
  /**
   * 摇杆操控输入（左下角常驻摇杆，由组合根在 HUD 装配完成后注入，见 setJoystick）
   * 与上面两个不同：摇杆节点在 UI 层（贴屏幕左下角、不随角色移动），所以不在这里自建
   */
  private joystickInput: RoleJoystickInput | null = null;
  /** 当前朝向 */
  private direction: DIRECTION = DIRECTION.DOWN;
  /** 当前动作 */
  private action: ACTION = ACTION.STAND;
  /** 攻击目标 */
  private target: Node | null = null;
  /** 自动移动方向（自动战斗写入；键盘输入优先，键盘无输入时生效） */
  private autoMove: Vec2 | null = null;
  /** 自动移动是否使用跑步速度 */
  private autoRun = false;
  /**
   * 自机位置快照缓冲（#1139）：与别人（OtherPlayerManager）/ 怪物（MonsterAI）同一套插值口径
   * —— 按服务端时间回放，匀速、抗丢帧；帧间距过大（瞬移）时整段跳过（见 applyServerPosition）
   */
  private readonly positions = new SnapshotInterpolator(
    networkConfig.realtime.interpolation.bufferSize,
    networkConfig.realtime.interpolation.maxExtrapolate,
  );
  /** 最近一帧服务端快照的移动标记（#1139）：攻击锁收尾时用它恢复走/站，不等下一个广播节拍 */
  private lastFrameMoving = false;
  /** 上次实际播到动画里的动作 / 朝向（插值每帧重算但动作没变时不重播 —— crossFade 会把动画拉回开头） */
  private playedAction: ACTION = ACTION.STAND;
  private playedDirection: DIRECTION = DIRECTION.DOWN;

  /** 当前角色数据 */
  private role: Role;
  /**
   * 头顶信息栏节点（军衔红字与血量实时刷新，见 updateHead）
   * 结构由 GameUiHelper.createHead 固定，称号名牌动画会插进同一个容器的最上方（见 updateTitleShow），
   * 所以取件按名字（role_hp_bar / role_hp_text）而不是按下标；角色名称不在这个容器里（见 createBody）
   */
  private head: Node;
  /** 战魂外显节点（右上角循环播放当前等级战魂动画，见 updateSoulShow；未勾选外显时为 null） */
  private soulShowNode: Node | null = null;
  /** 称号外显节点（解锁称号后常显头顶名牌动画，见 updateTitleShow；未激活时为 null） */
  private titleNode: Node | null = null;

  /** 攻击/技能锁：动作动画播放完成前为 true */
  private attacking = false;
  /** 攻击锁期间待执行的完成回调（动画完整播放后调用） */
  private attackComplete: (() => void) | null = null;
  /** 兜底解锁定时器（FINISHED 事件未触发时按动作时长解锁） */
  private attackTimeout: ReturnType<typeof setTimeout> | null = null;
  /** 死亡标记：死亡动画播完停最后一帧，期间锁全部操控与动作切换，直到复活（见 die / revive） */
  private dead = false;
  /**
   * 被控制标记（#826 第三批：眩晕 / 麻痹 / 定身）
   *
   * 由组合根每帧按 `StatusManager.isMoveLocked()` 同步 —— 状态的真实来源是服务端下发的
   * `statuses` 快照，本组件只负责「锁住手感」。**权限不在这一层**：服务端在控制期间
   * 不接受移动意图，所以这里漏判也只是意图多报两帧，服务端不会采纳
   */
  private controlLocked = false;

  /**
   * 移动意图上报出口（#1138 移动收权；Game 接线到 `CombatChannel.sendMoveIntent / sendMoveStop`）
   *
   * null = 当前没有移动意图（没输入 / 死亡 / 攻击锁 / 被控）—— 服务端收到 `moveStop`
   * 同语义。**意图变化时才回调**（比对见 `reportMoveIntent`），不是每帧都发。
   */
  onMoveIntent: ((intent: { dx: number; dy: number; run: boolean } | null) => void) | null = null;
  /** 上次上报的意图（null = 上次报的是停；比对用） */
  private lastReportedIntent: { dx: number; dy: number; run: boolean } | null = null;

  constructor(role: Role) {
    super("basic_role");
    this.role = role;
    this.createBody();
    LayerManager.addToGameLayer(this);
  }

  /** 初始化（外观动画、键盘操控与鼠标操控） */
  init() {
    this.updateOutShow(this.role);
    this.keyboardInput = new RoleKeyboardInput(this as Node);
    this.pointerInput = new RolePointerInput(this as Node);
  }

  /**
   * 绑定操作摇杆（由组合根在 HUD 装配完成后调用：摇杆是屏幕常驻 HUD，不属于角色子树，
   * 所以这里只接管它的输入逻辑，节点仍归 ui/components/hud/Joystick 所有）
   * 重复调用先销毁旧输入（幂等，重进场景时不会残留对旧摇杆节点的引用）
   */
  setJoystick(stick: Node, handle: Node) {
    this.joystickInput?.destroy();
    this.joystickInput = new RoleJoystickInput(stick, handle);
  }

  /** 构建角色身体（尺寸/锚点 + 外观节点 + 名称 + 头部信息栏） */
  private createBody() {
    const uiTransform = this.addComponent(UITransform);
    uiTransform.setContentSize(roleBody.size);
    uiTransform.setAnchorPoint(0.5, 0);
    /** 角色外观（衣服与武器节点由 RoleAppearance 自建并挂到自身） */
    this.appearance = new RoleAppearance(this as Node, () => this.onAttackFinished());
    /** 角色名称（人物区域正中间，与怪物名称同一套口径；在 appearance 之后添加 → 绘制在角色之上） */
    this.addChild(GameUiHelper.createRoleName(this.role));
    /** 角色头部信息栏父节点（最后添加，绘制在角色之上；军衔红字由 createHead 一并建好，见 updateHead） */
    this.head = GameUiHelper.createHead("role_head", this.role.hp, this.role.maxHp, this.role.rank);
    this.addChild(this.head);
  }

  //#region 动作与朝向状态机

  /**
   * 同步「被控制」状态（组合根每帧调；值没变直接返回）
   *
   * 锁上时立刻切回待机：不切的话动画还停在跑步帧，人物却寸步不移 —— 看起来像卡住了。
   * 解锁**不主动恢复动作**（#1139）：服务端在意图激活期间保留意图、控制一解除就恢复步进，
   * moving 帧会把走/站带回 —— 本地抢跑只会跟帧打架。
   */
  setControlLocked(locked: boolean) {
    if (this.controlLocked === locked) return;
    this.controlLocked = locked;
    if (locked) {
      this.action = ACTION.STAND;
      this.updateAnimationPlay();
    }
  }

  /**
   * 玩家操控的移动意图：键盘优先（按下即接管），其次摇杆（左下角常驻，触屏的主输入手段），
   * 最后鼠标按住的八方向（方向随指针移动实时更新）；都没有输入返回 null。
   * 优先级是固定的链条，桌面端鼠标与摇杆不会同时被按住（同一个指针），所以互不干扰。
   * 意图只进 `reportMoveIntent` 的上报（#1139 起本地不再拿它驱动位移与动画）
   */
  private getMoveIntent(): { vector: Vec2; run: boolean } | null {
    const keyboard = this.keyboardInput;
    if (keyboard?.isMoving) return { vector: keyboard.moveDirection, run: keyboard.isSprinting };
    const joystick = this.joystickInput;
    if (joystick?.isMoving) return { vector: joystick.moveDirection, run: joystick.isRunning };
    const pointer = this.pointerInput;
    if (pointer?.isMoving) return { vector: pointer.moveDirection, run: pointer.isRunning };
    return null;
  }

  /**
   * 更改播放的动作
   * 节点已销毁（切场景收尾）、外观尚未建好（构造未完成）时直接跳过：
   * 该状态下再去操作动画组件只会报错，且动画已无意义
   * 播完记下「实际播到的」动作与朝向（插值每帧重算，没变不重播，见 updatePlayback）
   */
  private updateAnimationPlay() {
    if (!isValid(this) || !this.appearance || this.dead) return;
    this.appearance.play(this.action, this.direction);
    this.playedAction = this.action;
    this.playedDirection = this.direction;
  }

  //#endregion

  //#region 位置回放（#1139：服务端权威帧驱动，本地零物理）

  /** 每帧驱动：选中目标已死亡/移除则取消选中（面板与选中光圈随之销毁），并回放服务端位置 */
  update() {
    // 选中状态只由鼠标点击改变（点击怪物选中、点击其他位置取消），移动不影响；
    // 但目标本身消失（死亡/移除）时必须同步取消，避免残留无效引用
    if (this.target && this.isTargetGone(this.target)) this.setTarget(null);
    // 移动意图上报（#1138）：输入只产生意图帧，位移由服务端步进
    this.reportMoveIntent();
    this.updatePlayback();
  }

  /**
   * 自机位置回放（#1139）：与别人（OtherPlayerManager）/ 怪物（MonsterAI）同一套口径 ——
   * 按服务端时间在快照缓冲里线性插值，朝向与走/站按这一帧的实际位移差量演。
   * 还没收到第一帧时站在进图定位的位置（复活点，与条目播种同源）等帧。
   */
  private updatePlayback() {
    if (!isValid(this) || this.dead) return; // 躺尸期间不追帧（复活后由帧把位置带回）
    const sampled = this.positions.sample(ServerClock.renderTime(networkConfig.realtime.interpolation.renderDelay));
    if (!sampled) return;
    this.lastFrameMoving = sampled.moving;
    const current = this.getWorldPosition();
    const dx = sampled.x - current.x;
    const dy = sampled.y - current.y;
    if (dx !== 0 || dy !== 0) {
      this.setWorldPosition(sampled.x, sampled.y, current.z);
      LayerManager.move(this.getWorldPosition());
    }
    // 朝向 / 动作按帧内速度差量演（与别人同口径）：站着时位移为 0，保持上一次朝向 ——
    // 拿「到目标的剩余差量」定朝向会让追上之后剩几像素的残差把人转得乱转
    if (!this.attacking && Math.abs(dx) + Math.abs(dy) > 0.5) {
      this.direction = getDirectionByVector(new Vec2(dx, dy));
    }
    if (!this.attacking) {
      // 走 / 站取采样结果的移动标记（= 服务端步进的意图）。互见帧只带布尔（run 不随帧下发），
      // 与别人的表演同一口径：跑与走都播走路动画，步频差异由位移差量自然带出
      this.action = sampled.moving ? ACTION.WALK : ACTION.STAND;
    }
    // 只在真的变了才切：play 里的 crossFade 每帧调用会不断把动画拉回开头
    if (!this.attacking && (this.action !== this.playedAction || this.direction !== this.playedDirection)) {
      this.updateAnimationPlay();
    }
  }

  /**
   * 落一帧服务端自机位置（#1139；组合根从 players / entityEnter 帧里挑出自己那条喂进来）
   *
   * 与缓冲最新快照的差量超过 `SELF_SNAP_DISTANCE` 判定「合法大位移」（突进落位 / 复活传送 /
   * 服务端重播种）：清缓冲从头压，下一拍 sample 直接落在新位置 —— 不会看到自己从半个
   * 地图外滑过来。正常行走的帧间距（跑速 10Hz ≈ 13px）永远到不了这条线。
   */
  applyServerPosition(x: number, y: number, moving: boolean, t: number): void {
    if (!isValid(this)) return;
    const newest = this.positions.newest;
    if (newest && Math.hypot(x - newest.x, y - newest.y) > SELF_SNAP_DISTANCE) this.positions.reset();
    this.positions.push(t, x, y, moving);
  }

  /** 设置角色世界坐标（如传送到复活点）：传送后清缓冲 —— 旧快照是传送前的位置，不清会被拽回去 */
  setWorldPositionByTransfer(worldPosition: Vec3) {
    this.positions.reset();
    this.setWorldPosition(worldPosition);
    LayerManager.move(this.getWorldPosition());
  }

  //#endregion

  /**
   * 移动意图上报（#1138）：本帧的「有效移动意图」与上次上报的不一样才发帧
   *
   * 有效意图 = 当前输入（键盘 > 摇杆 > 鼠标按住）或自动战斗走位方向，**但死亡 /
   * 攻击锁 / 被控期间恒为 null** —— 与服务端步进的停步条件一致，
   * 服务端才不会「本地站着打怪、别人看到你在滑步」。
   */
  private reportMoveIntent() {
    if (!this.onMoveIntent) return;
    const blocked = this.dead || this.attacking || this.controlLocked;
    let intent: { dx: number; dy: number; run: boolean } | null = null;
    if (!blocked) {
      const manual = this.getMoveIntent();
      const auto = this.autoMove && this.autoMove.lengthSqr() > 0 ? { vector: this.autoMove, run: this.autoRun } : null;
      const source = manual ?? auto;
      if (source) {
        const length = Math.hypot(source.vector.x, source.vector.y);
        if (length > 1e-6) intent = { dx: source.vector.x / length, dy: source.vector.y / length, run: source.run };
      }
    }
    const last = this.lastReportedIntent;
    const changed =
      (intent === null) !== (last === null) ||
      (intent !== null && last !== null && (Math.abs(intent.dx - last.dx) > 1e-6 || Math.abs(intent.dy - last.dy) > 1e-6 || intent.run !== last.run));
    if (!changed) return;
    this.lastReportedIntent = intent;
    this.onMoveIntent(intent);
  }

  /**
   * 选中目标是否已失效（死亡/移除）
   * 判据与怪物信息面板、选中光圈一致：节点失效 **或** 怪物数据已消失/血量归零都算失效。
   * 不能只看 isValid(节点)：引擎的 isValid 默认只检查 Destroyed、不检查「已标记待销毁」(ToDestroy)，
   * 怪物死亡当帧节点仍然算「有效」，只看节点会让选中状态多残留一帧，进而让光圈比面板晚一帧销毁
   * （那一帧的空档正是「怪物死亡后光圈残留」的成因，见 core/RoleUIManager.selectMonster）
   */
  private isTargetGone(target: Node): boolean {
    if (!isValid(target)) return true;
    const monster = MonsterManager.getMonsterData(target);
    return !monster || monster.hp <= 0;
  }

  //#endregion

  //#region 外观更新

  /**
   * 头顶信息栏血量与军衔实时刷新（由 RoleUIManager.updateRoleData 统一触发，与血球/经验条同一时机）
   * 血量变更的全部来源（怪物普攻/药品/升级补满/复活）最终都会走 updateUi，覆盖即可做到实时；
   * 军衔红字（军衔的唯一外显）也在这里刷 —— 晋升走 StorageManager.upgradeRank → updateUi → 本方法
   */
  updateHead(role: Role) {
    if (!isValid(this) || !this.head) return;
    // 按名字取件：头部容器里除了军衔红字/血条/血量文字，还会插进称号名牌动画（未激活时摘除），下标不稳定
    // （角色名称不在容器里 —— 它显示在人物区域正中间且创建后不变，见 GameUiHelper.createRoleName）
    const hpBar = this.head.getChildByName("role_hp_bar")?.getComponent(ProgressBar);
    if (hpBar) hpBar.progress = role.maxHp > 0 ? Math.max(0, Math.min(1, role.hp / role.maxHp)) : 0;
    const hpText = this.head.getChildByName("role_hp_text")?.getComponent(Label);
    if (hpText) hpText.string = `${Math.max(0, Math.floor(role.hp))} / ${role.maxHp}`;
    const rankText = this.head.getChildByName("role_rank")?.getComponent(Label);
    if (rankText) rankText.string = GameUiHelper.getRankHeadText(role.rank);
  }

  /** 更改外观 */
  updateOutShow(role: Role) {
    this.role = role;
    // 衣服与武器外观（节点已销毁/外观未就绪时跳过，同 updateAnimationPlay）
    if (!isValid(this) || !this.appearance) return;
    this.appearance.updateOutShow(role, this.action, this.direction);
  }

  /**
   * 战魂外显（由战魂弹窗勾选开关与升级后、以及进图时调用）
   * 按角色数据 role.soulShow 重建右上角的战魂动画节点：
   * 勾选且已激活战魂（soulOfWar > 0）时挂载，否则摘除；挂载的节点随主角移动（作为子节点跟随）
   * 注意：StorageManager 每次读取都是新 JSON.parse 出来的对象（见 getRoles），this.role 只是进图时的快照，
   *   弹窗改的是另一份实例并落盘，故这里必须用前重读最新数据，否则勾选后要重进游戏才生效
   */
  updateSoulShow() {
    if (!isValid(this)) return;
    const role = StorageManager.findOnlineRole() ?? this.role;
    if (this.soulShowNode && isValid(this.soulShowNode)) this.soulShowNode.destroy();
    this.soulShowNode = null;
    if (!role.soulShow) return;
    const config = getSoulLevel(role.soulOfWar);
    if (!config) return;
    // 挂件位置与尺寸见 configs/hudLayout.roleShowLayout.soul（角色锚点 (0.5, 0)、内容 40×70，
    // (26, 62) 约为右上角肩侧；动画帧自带大量透明边距，实际视觉尺寸更小）
    const node = GameUiHelper.createSoulAnimation(config, roleShowLayout.soul.size);
    node.name = "soul_show";
    node.setScale(roleShowLayout.soul.scale.x, roleShowLayout.soul.scale.y);
    node.setPosition(roleShowLayout.soul.position.x, roleShowLayout.soul.position.y);
    this.addChild(node);
    this.soulShowNode = node;
  }

  /**
   * 称号外显（由称号升级弹窗升级后、以及进图时调用）
   * 按角色数据 role.title 重建名牌动画：已激活称号（title > 0）时**常显**（无开关），未激活时摘除。
   * 节点挂在**头部信息栏容器**里（与角色名称/血条同一个 FlexCol），位置交给该容器的纵向布局、
   * 不手动定位也**不缩放**（按素材原始尺寸显示）；插入位置见 configs/hudLayout.roleShowLayout.title.siblingIndex
   * 与 updateSoulShow 同一套「用前重读最新角色数据」的口径（见上）
   */
  updateTitleShow() {
    if (!isValid(this) || !this.head || !isValid(this.head)) return;
    const role = StorageManager.findOnlineRole() ?? this.role;
    if (this.titleNode && isValid(this.titleNode)) {
      // 先摘下再销毁：destroy 当帧内节点仍挂在父节点上，会与新建的名牌同时参与一次布局
      this.titleNode.removeFromParent();
      this.titleNode.destroy();
    }
    this.titleNode = null;
    const config = getTitleLevel(role.title);
    if (!config) return;
    const node = GameUiHelper.createTitleAnimation(config, roleShowLayout.title.size);
    node.name = "title_show";
    this.head.insertChild(node, roleShowLayout.title.siblingIndex);
    this.titleNode = node;
  }

  //#endregion

  //#region 攻击锁（普攻/技能通用）

  /**
   * 发起一次攻击动作（普攻/技能通用入口）
   * 正在攻击（动画未播放完成）时返回 false，按下不产生任何反应
   * 动画完整播放完成（FINISHED）后解锁并回调 onComplete；FINISHED 未触发时按动作时长兜底解锁
   */
  startAttack(action: ACTION, direction: DIRECTION, onComplete: () => void, lockMs: number = 0): boolean {
    if (this.dead || this.attacking) return false;
    this.attacking = true;
    this.direction = direction;
    this.action = action;
    this.attackComplete = onComplete;
    this.updateAnimationPlay();
    // 兜底：动作时长（speedRate 为每秒循环数，一段动画时长即该值）+ 余量后强制解锁（余量见 configs/animation）；
    // 技能配了 castLockMs（#367）时以它为准 —— 它是运营在后台调的「出手硬直」，0 = 跟动画走
    const animationLockMs = ((this.role.speedRate[action] ?? 1) + actionFinishTimeoutMarginSeconds) * 1000;
    this.attackTimeout = setTimeout(() => this.onAttackFinished(), lockMs > 0 ? lockMs : animationLockMs);
    return true;
  }

  /** 是否正在攻击/施法（供 SkillManager 释放前校验） */
  isAttacking(): boolean {
    return this.attacking;
  }

  /** 攻击动画播放完成：解锁、回到待机/恢复移动，并执行待结算回调 */
  private onAttackFinished() {
    if (!this.attacking) return;
    this.attacking = false;
    if (this.attackTimeout !== null) {
      clearTimeout(this.attackTimeout);
      this.attackTimeout = null;
    }
    const complete = this.attackComplete;
    this.attackComplete = null;
    // 恢复动作状态（#1139）：攻击锁期间回放不写 action，但一直读帧 —— 用最近一帧的
    // 移动标记恢复走/站并立刻续播，不等下一个广播节拍
    this.action = this.lastFrameMoving ? ACTION.WALK : ACTION.STAND;
    this.updateAnimationPlay();
    complete?.();
  }

  //#endregion

  //#region 死亡与复活

  /** 是否处于死亡状态（死亡动画播完停最后一帧、操控全锁，直到 revive） */
  isDead(): boolean {
    return this.dead;
  }

  /**
   * 死亡（由组合根在角色血量归零时调用）
   * 解除攻击锁（不再恢复动作）、清目标与自动移动，
   * 然后按当前朝向播放死亡动画——播完停最后一帧，之后一直躺尸直到复活
   * 键盘/鼠标输入、自动移动、技能与普攻在此期间全部被 dead 标记拦住（见各入口的守卫）；
   * 意图上报同样停（reportMoveIntent 的 blocked 判据），服务端同步停步
   */
  die() {
    if (this.dead) return;
    this.dead = true;
    // 攻击锁收尾：清兜底定时器与待结算回调，死亡期间 onAttackFinished 不再恢复动作
    if (this.attackTimeout !== null) {
      clearTimeout(this.attackTimeout);
      this.attackTimeout = null;
    }
    this.attacking = false;
    this.attackComplete = null;
    this.autoMove = null;
    this.setTarget(null);
    this.appearance?.die(this.direction);
  }

  /** 复活（由组合根在补满血量、安全复活传送完成后调用）：解除死亡状态并回到待机（走/站由帧带回） */
  revive() {
    if (!this.dead) return;
    this.dead = false;
    this.appearance?.revive();
    this.action = ACTION.STAND;
    this.updateAnimationPlay();
  }

  //#endregion

  //#region 受击反馈

  /**
   * 受击动作（怪物普攻命中玩家时由组合根接线触发，见 MonsterManager.onPlayerServerHit 与 Game.start）
   *
   * 优先级规则（issue #13：受击不能随便打断玩家正在做的事）：
   * - 正在施法/普攻（attacking 锁）→ 不播：被小怪碰一下就断技能，比没有反馈更糟；
   * - 死亡 → 不播（死亡动画播完停最后一帧，期间一切动作切换冻结）；
   * - 其余情况（待机/走跑/自动战斗走位）→ 播一次性受击动作，动作与位移都不被打断
   *   （外观播完自动回到当前动作，见 RoleAppearance.playInjured）
   */
  playInjured() {
    if (this.dead || this.attacking) return;
    this.appearance?.playInjured(this.direction);
  }

  //#endregion

  //#region 选中目标与操控状态

  /** 设置攻击目标（null 表示取消选中），并刷新怪物信息面板 */
  setTarget(target: Node | null) {
    this.target = target;
    RoleUIManager.selectMonster(target);
  }

  /** 当前选中的攻击目标（自动战斗同步选中状态用） */
  getTarget(): Node | null {
    return this.target;
  }

  /** 玩家是否正在手动移动（键盘/摇杆/鼠标按住；自动战斗据此让位：快速攻击结束、挂机暂停） */
  isManualMoving(): boolean {
    return !!this.keyboardInput?.isMoving || !!this.joystickInput?.isMoving || !!this.pointerInput?.isMoving;
  }

  /** 是否正在自动移动（自动战斗走位中，「自动寻路中」提示的显示依据） */
  isAutoMoving(): boolean {
    return !!this.autoMove && this.autoMove.lengthSqr() > 0;
  }

  /**
   * 设置自动移动（自动战斗走位用，见 core/AutoBattle；传 null 表示停止）
   * 键盘输入优先于自动移动（玩家随时可接管）；攻击锁期间只记录方向，解锁后由下一帧自动战斗接管
   * 只记方向不驱动动画（#1139）：意图帧发出后，服务端步进的 moving 帧 + 位移差量会把走/跑/朝向带回
   */
  setAutoMove(direction: Vec2 | null, run: boolean = false) {
    if (this.dead) return;
    this.autoMove = direction;
    this.autoRun = run;
  }

  //#endregion

  //#region 技能释放

  /** 组装技能释放上下文（由组合根注入 SkillManager，作为统一触发来源） */
  buildSkillContext(): SkillContextInput {
    return {
      // 角色数据实时读取存储，避免组件内快照过期
      role: StorageManager.findOnlineRole() ?? this.role,
      caster: this,
      target: this.target,
      monsters: MonsterManager,
    };
  }

  /**
   * 面向指定方向播放技能配置的动作动画（技能表现），动画播放完成前锁定移动与再次攻击
   * @param action 技能配置的动作（config.action）
   */
  playSkillAttack(action: ACTION, direction: DIRECTION, lockMs: number = 0) {
    return this.startAttack(action, direction, () => {}, lockMs);
  }

  //#endregion
}
