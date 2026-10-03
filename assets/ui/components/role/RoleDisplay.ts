import { BoxCollider2D, isValid, Label, Node, ProgressBar, RigidBody2D, Size, UITransform, Vec2, Vec3 } from "cc";
import StorageManager from "../../core/StorageManager";
import { Role } from "../../../entities/Role";
import { ACTION, DIRECTION } from "../../../types/animation";
import { SkillContextInput } from "../../../types/skill";
import { ROLE_RUN_SPEED, ROLE_WALK_SPEED } from "../../../configs/role";
import LayerManager from "../../core/LayerManager";
import GameUiHelper from "../../helpers/GameUiHelper";
import { getDirectionByVector } from "../../utils/battle/BattleMath";
import { getSoulLevel } from "../../../configs/soul";
import { roleShowLayout } from "../../../configs/hudLayout";
import { resolveBlockedVelocity } from "../../utils/physics/MoveBlocking";
import MonsterManager from "../../core/MonsterManager";
import RoleUIManager from "../../core/RoleUIManager";
import RoleAppearance from "./RoleAppearance";
import RoleKeyboardInput from "../input/RoleKeyboardInput";
import RolePointerInput from "../input/RolePointerInput";

/**
 * 角色展示组件（自身即主角节点）
 * 负责主角节点的构建与状态机（动作/朝向）、位移、攻击锁与技能上下文组装
 * 具体职责由协作组件承担：外观动画 → RoleAppearance，键盘操控 → RoleKeyboardInput，鼠标操控 → RolePointerInput
 * 怪物查询与结算统一走 MonsterManager
 * 攻击/技能锁（attacking）：动作动画从播放到完整播完期间锁定移动，且不接受新的攻击/技能（按下无反应）
 * 怪物推不动角色、角色也推不动怪物（怪物的碰撞盒是传感器，见 addMonsterCollider），
 * 角色不会穿过怪物这一条由位移前的阻挡预测保证：撞上只取消这一步，不把怪物挤开（见 MoveBlocking）
 */
export default class RoleDisplay extends Node {
  /** 外观（衣服/武器节点与动画） */
  private appearance: RoleAppearance;
  /** 键盘操控输入（init 时创建） */
  private keyboardInput: RoleKeyboardInput | null = null;
  /** 鼠标操控输入（init 时创建：左键按下走路、右键按下跑动、抬起即停） */
  private pointerInput: RolePointerInput | null = null;
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

  /** 当前角色数据 */
  private role: Role;
  /** 头顶信息栏节点（血量实时刷新，见 updateHead；结构由 GameUiHelper.createHead 固定：2=血条 3=血量文字） */
  private head: Node;
  /** 战魂外显节点（右上角循环播放当前等级战魂动画，见 updateSoulShow；未勾选外显时为 null） */
  private soulShowNode: Node | null = null;

  /** 攻击/技能锁：动作动画播放完成前为 true */
  private attacking = false;
  /** 攻击锁期间待执行的完成回调（动画完整播放后调用） */
  private attackComplete: (() => void) | null = null;
  /** 兜底解锁定时器（FINISHED 事件未触发时按动作时长解锁） */
  private attackTimeout: ReturnType<typeof setTimeout> | null = null;
  /** 死亡标记：死亡动画播完停最后一帧，期间锁全部操控与动作切换，直到复活（见 die / revive） */
  private dead = false;

  constructor(role: Role) {
    super("basic_role");
    this.role = role;
    this.createBody();
    this.addRigid();
    LayerManager.addToGameLayer(this);
  }

  /** 初始化（外观动画、键盘操控与鼠标操控） */
  init() {
    this.updateOutShow(this.role);
    this.keyboardInput = new RoleKeyboardInput(this as Node, () => this.refreshMotion());
    this.pointerInput = new RolePointerInput(this as Node, () => this.refreshMotion());
  }

  /** 构建角色身体（尺寸/锚点 + 外观节点 + 头部信息栏） */
  private createBody() {
    const uiTransform = this.addComponent(UITransform);
    uiTransform.setContentSize(40, 70);
    uiTransform.setAnchorPoint(0.5, 0);
    /** 角色外观（衣服与武器节点由 RoleAppearance 自建并挂到自身） */
    this.appearance = new RoleAppearance(this as Node, () => this.onAttackFinished());
    /** 角色头部信息栏父节点（最后添加，绘制在角色之上） */
    this.head = GameUiHelper.createHead("role_head", this.role.name, this.role.hp, this.role.maxHp);
    this.addChild(this.head);
  }

  /** 增加碰撞 */
  private addRigid() {
    const rigidBody = this.addComponent(RigidBody2D);
    rigidBody.gravityScale = 0;
    rigidBody.fixedRotation = true;
    const boxCollider = this.addComponent(BoxCollider2D);
    boxCollider.size = new Size(40, 70);
    boxCollider.offset = new Vec2(0, 35);
    // 碰撞范围显示（调试用，全部碰撞体共用一套开关；角色自身用另一种配色区分于静态障碍）
    GameUiHelper.showColliderRange(this as Node, this.role.name, "role");
  }

  //#region 动作与朝向状态机

  /** 操控状态变化（键盘按键/鼠标按下）：死亡/攻击/技能锁期间只记录状态，不改变动作与朝向（解锁后恢复移动） */
  private refreshMotion() {
    if (this.dead || this.attacking) return;
    this.updateAction();
    this.updateDirection();
  }

  /** 朝向更改（按当前移动意图取八方向；无输入时保持原朝向） */
  private updateDirection() {
    const intent = this.getMoveIntent();
    if (intent) this.direction = getDirectionByVector(intent.vector);
    // 动作/朝向统一在此处落地为动画播放（调用方总是成对调用 updateAction + updateDirection）
    this.updateAnimationPlay();
  }

  /** 动作更改（只计算动作，动画播放由 updateDirection 统一触发） */
  private updateAction() {
    const intent = this.getMoveIntent();
    if (!intent) {
      this.action = ACTION.STAND;
      return;
    }
    this.action = intent.run ? ACTION.RUN : ACTION.WALK;
  }

  /**
   * 玩家操控的移动意图：键盘优先（按下即接管），其次鼠标按住的八方向（方向随指针移动实时更新），都没有输入返回 null
   * 走跑速度不在这里取（见 updateWorldPosition），这里只回答「往哪走、是否跑」
   */
  private getMoveIntent(): { vector: Vec2; run: boolean } | null {
    const keyboard = this.keyboardInput;
    if (keyboard?.isMoving) return { vector: keyboard.moveDirection, run: keyboard.isSprinting };
    const pointer = this.pointerInput;
    if (pointer?.isMoving) return { vector: pointer.moveDirection, run: pointer.isRunning };
    return null;
  }

  /**
   * 更改播放的动作
   * 节点已销毁（切场景收尾）、外观尚未建好（构造未完成）时直接跳过：
   * 该状态下再去操作动画组件只会报错，且动画已无意义
   */
  private updateAnimationPlay() {
    if (!isValid(this) || !this.appearance || this.dead) return;
    this.appearance.play(this.action, this.direction);
  }

  //#endregion

  //#region 位置更新

  /** 每帧驱动：选中目标已死亡/移除则取消选中（面板与选中光圈随之销毁），并更新角色位移 */
  update() {
    // 选中状态只由鼠标点击改变（点击怪物选中、点击其他位置取消），移动不影响；
    // 但目标本身消失（死亡/移除）时必须同步取消，避免残留无效引用
    if (this.target && this.isTargetGone(this.target)) this.setTarget(null);
    this.updateWorldPosition();
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

  /** 每帧根据按键状态更新角色位移 */
  updateWorldPosition() {
    const rigidBody = this.getComponent(RigidBody2D);
    // 死亡期间原地躺尸：速度清零，不接受任何位移
    if (this.dead) {
      rigidBody.linearVelocity = Vec2.ZERO;
      return;
    }
    // 攻击/技能锁期间不可移动，立刻停住
    if (this.attacking) {
      rigidBody.linearVelocity = Vec2.ZERO;
      return;
    }
    // 非移动动作（待机/攻击等）立刻把速度设为 0，实现"松手即停"
    if (this.action !== ACTION.WALK && this.action !== ACTION.RUN) {
      rigidBody.linearVelocity = Vec2.ZERO;
      return;
    }
    // 玩家操控优先（键盘 > 鼠标按下，随时接管），没有玩家输入时才走自动战斗写入的自动移动方向
    const intent = this.getMoveIntent();
    let speed: number;
    let moveVector: Vec2;
    if (intent) {
      speed = intent.run ? ROLE_RUN_SPEED : ROLE_WALK_SPEED;
      moveVector = intent.vector;
    } else if (this.autoMove && this.autoMove.lengthSqr() > 0) {
      speed = this.autoRun ? ROLE_RUN_SPEED : ROLE_WALK_SPEED;
      moveVector = this.autoMove;
    } else {
      // 直接赋值速度清零，解决漂移
      rigidBody.linearVelocity = Vec2.ZERO;
      return;
    }
    // 位移前先做阻挡预测：撞上怪物只取消这一步（怪物不会因此被推动，角色也不会被怪物挤开）
    const velocity = new Vec2(moveVector.x * speed, moveVector.y * speed);
    rigidBody.linearVelocity = resolveBlockedVelocity(this as Node, velocity, MonsterManager.getBlockingRects());
    LayerManager.move(this.getWorldPosition());
  }

  /** 设置角色世界坐标（如传送到复活点） */
  setWorldPositionByTransfer(worldPosition: Vec3) {
    this.setWorldPosition(worldPosition);
    LayerManager.move(this.getWorldPosition());
  }

  //#endregion

  //#region 外观更新

  /**
   * 头顶信息栏血量实时刷新（由 RoleUIManager.updateRoleData 统一触发，与血球/经验条同一时机）
   * 血量变更的全部来源（怪物普攻/药品/升级补满/复活）最终都会走 updateUi，覆盖即可做到实时
   */
  updateHead(role: Role) {
    if (!isValid(this) || !this.head) return;
    const hpBar = this.head.children[2]?.getComponent(ProgressBar);
    if (hpBar) hpBar.progress = role.maxHp > 0 ? Math.max(0, Math.min(1, role.hp / role.maxHp)) : 0;
    const hpText = this.head.children[3]?.getComponent(Label);
    if (hpText) hpText.string = `${Math.max(0, Math.floor(role.hp))} / ${role.maxHp}`;
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

  //#endregion

  //#region 攻击锁（普攻/技能通用）

  /**
   * 发起一次攻击动作（普攻/技能通用入口）
   * 正在攻击（动画未播放完成）时返回 false，按下不产生任何反应
   * 动画完整播放完成（FINISHED）后解锁并回调 onComplete；FINISHED 未触发时按动作时长兜底解锁
   */
  startAttack(action: ACTION, direction: DIRECTION, onComplete: () => void): boolean {
    if (this.dead || this.attacking) return false;
    this.attacking = true;
    this.direction = direction;
    this.action = action;
    this.attackComplete = onComplete;
    this.updateAnimationPlay();
    // 兜底：动作时长（speedRate 为每秒循环数，一段动画时长即该值）+ 1 秒余量后强制解锁
    this.attackTimeout = setTimeout(() => this.onAttackFinished(), ((this.role.speedRate[action] ?? 1) + 1) * 1000);
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
    // 恢复动作状态（攻击期间按下的方向键此时生效：有键则直接走/跑，无键回到待机）
    this.updateAction();
    this.updateDirection();
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
   * 解除攻击锁（不再恢复动作）、清目标与自动移动、停住位移，
   * 然后按当前朝向播放死亡动画——播完停最后一帧，之后一直躺尸直到复活
   * 键盘/鼠标输入、自动移动、技能与普攻在此期间全部被 dead 标记拦住（见各入口的守卫）
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
    const rigidBody = this.getComponent(RigidBody2D);
    if (rigidBody) rigidBody.linearVelocity = Vec2.ZERO;
    this.appearance?.die(this.direction);
  }

  /** 复活（由组合根在补满血量、安全复活传送完成后调用）：解除死亡状态并回到待机 */
  revive() {
    if (!this.dead) return;
    this.dead = false;
    this.appearance?.revive();
    // 按当前输入恢复动作（无输入回到待机）
    this.updateAction();
    this.updateDirection();
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

  /** 玩家是否正在手动移动（键盘方向键或鼠标按下；自动战斗据此让位：快速攻击结束、挂机暂停） */
  isManualMoving(): boolean {
    return !!this.keyboardInput?.isMoving || !!this.pointerInput?.isMoving;
  }

  /** 是否正在自动移动（自动战斗走位中，「自动寻路中」提示的显示依据） */
  isAutoMoving(): boolean {
    return !!this.autoMove && this.autoMove.lengthSqr() > 0;
  }

  /**
   * 设置自动移动（自动战斗走位用，见 core/AutoBattle；传 null 表示停止并按键盘状态恢复动作）
   * 键盘输入优先于自动移动（玩家随时可接管）；攻击锁期间只记录方向，解锁后由下一帧自动战斗接管
   */
  setAutoMove(direction: Vec2 | null, run: boolean = false) {
    if (this.dead) return;
    this.autoMove = direction;
    this.autoRun = run;
    if (this.attacking) return;
    if (direction && direction.lengthSqr() > 0) {
      const action = run ? ACTION.RUN : ACTION.WALK;
      const targetDirection = getDirectionByVector(direction);
      // 动作与朝向都没变时不重复触发动画：crossFade 每帧调用会不断把动画拉回开头
      if (this.action === action && this.direction === targetDirection) return;
      this.action = action;
      this.direction = targetDirection;
      this.updateAnimationPlay();
      return;
    }
    // 停止自动移动：按键盘当前状态恢复动作与朝向（无键回待机）
    this.updateAction();
    this.updateDirection();
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
  playSkillAttack(action: ACTION, direction: DIRECTION) {
    return this.startAttack(action, direction, () => {});
  }

  //#endregion
}
