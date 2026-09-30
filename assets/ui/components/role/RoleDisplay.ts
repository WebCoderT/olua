import { BoxCollider2D, isValid, Node, RigidBody2D, Size, UITransform, Vec2, Vec3 } from "cc";
import StorageManager from "../../core/StorageManager";
import { Role } from "../../../entities/Role";
import { ACTION, DIRECTION } from "../../../types/animation";
import { SkillContextInput } from "../../../types/skill";
import { ROLE_RUN_SPEED, ROLE_WALK_SPEED } from "../../../configs/role";
import LayerManager from "../../core/LayerManager";
import GameUiHelper from "../../helpers/GameUiHelper";
import BattleHelper from "../../utils/BattleHelper";
import MonsterManager from "../../core/MonsterManager";
import RoleUIManager from "../../core/RoleUIManager";
import RoleAppearance from "./RoleAppearance";
import RoleKeyboardInput from "../input/RoleKeyboardInput";

/**
 * 角色展示组件（自身即主角节点）
 * 负责主角节点的构建与状态机（动作/朝向）、位移、攻击锁与技能上下文组装
 * 具体职责由协作组件承担：外观动画 → RoleAppearance，键盘操控 → RoleKeyboardInput
 * 怪物查询与结算统一走 MonsterManager
 * 攻击/技能锁（attacking）：动作动画从播放到完整播完期间锁定移动，且不接受新的攻击/技能（按下无反应）
 */
export default class RoleDisplay extends Node {
  /** 外观（衣服/武器节点与动画） */
  private appearance: RoleAppearance;
  /** 键盘操控输入（init 时创建） */
  private keyboardInput: RoleKeyboardInput | null = null;
  /** 当前朝向 */
  private direction: DIRECTION = DIRECTION.DOWN;
  /** 当前动作 */
  private action: ACTION = ACTION.STAND;
  /** 攻击目标 */
  private target: Node | null = null;

  /** 当前角色数据 */
  private role: Role;

  /** 攻击/技能锁：动作动画播放完成前为 true */
  private attacking = false;
  /** 攻击锁期间待执行的完成回调（动画完整播放后调用） */
  private attackComplete: (() => void) | null = null;
  /** 兜底解锁定时器（FINISHED 事件未触发时按动作时长解锁） */
  private attackTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(role: Role) {
    super("basic_role");
    this.role = role;
    this.createBody();
    this.addRigid();
    LayerManager.addToGameLayer(this);
  }

  /** 初始化（外观动画与键盘操控） */
  init() {
    this.updateOutShow(this.role);
    this.keyboardInput = new RoleKeyboardInput(this as Node, () => this.refreshMotion());
  }

  /** 构建角色身体（尺寸/锚点 + 外观节点 + 头部信息栏） */
  private createBody() {
    const uiTransform = this.addComponent(UITransform);
    uiTransform.setContentSize(40, 70);
    uiTransform.setAnchorPoint(0.5, 0);
    /** 角色外观（衣服与武器节点由 RoleAppearance 自建并挂到自身） */
    this.appearance = new RoleAppearance(this as Node, () => this.onAttackFinished());
    /** 角色头部信息栏父节点（最后添加，绘制在角色之上） */
    this.addChild(GameUiHelper.createHead("role_head", this.role.name, this.role.hp, this.role.maxHp));
  }

  /** 增加碰撞 */
  private addRigid() {
    const rigidBody = this.addComponent(RigidBody2D);
    rigidBody.gravityScale = 0;
    rigidBody.fixedRotation = true;
    const boxCollider = this.addComponent(BoxCollider2D);
    boxCollider.size = new Size(40, 70);
    boxCollider.offset = new Vec2(0, 35);
  }

  //#region 动作与朝向状态机

  /** 按键状态变化：攻击/技能锁期间只记录按键状态，不改变动作与朝向（解锁后恢复移动） */
  private refreshMotion() {
    if (this.attacking) return;
    this.updateAction();
    this.updateDirection();
  }

  /** 朝向更改（根据按下的方向键组合取八方向） */
  private updateDirection() {
    const keyboard = this.keyboardInput;
    if (keyboard) {
      if (keyboard.isUp && keyboard.isLeft) {
        this.direction = DIRECTION.LEFT_UP;
      } else if (keyboard.isUp && keyboard.isRight) {
        this.direction = DIRECTION.RIGHT_UP;
      } else if (keyboard.isDown && keyboard.isLeft) {
        this.direction = DIRECTION.LEFT_DOWN;
      } else if (keyboard.isDown && keyboard.isRight) {
        this.direction = DIRECTION.RIGHT_DOWN;
      } else if (keyboard.isUp) {
        this.direction = DIRECTION.UP;
      } else if (keyboard.isDown) {
        this.direction = DIRECTION.DOWN;
      } else if (keyboard.isLeft) {
        this.direction = DIRECTION.LEFT;
      } else if (keyboard.isRight) {
        this.direction = DIRECTION.RIGHT;
      }
    }
    // 动作/朝向统一在此处落地为动画播放（调用方总是成对调用 updateAction + updateDirection）
    this.updateAnimationPlay();
  }

  /** 动作更改（只计算动作，动画播放由 updateDirection 统一触发） */
  private updateAction() {
    const keyboard = this.keyboardInput;
    const isWalk = !!keyboard?.isMoving;
    const isRun = isWalk && !!keyboard?.isSprinting;
    if (isRun) {
      this.action = ACTION.RUN;
      return;
    }
    this.action = isWalk ? ACTION.WALK : ACTION.STAND;
  }

  /** 更改播放的动作 */
  private updateAnimationPlay() {
    this.appearance.play(this.action, this.direction);
  }

  //#endregion

  //#region 位置更新

  /** 每帧驱动：选中目标已死亡/移除则取消选中（面板随之销毁），并更新角色位移 */
  update() {
    // 选中状态只由鼠标点击改变（点击怪物选中、点击其他位置取消），移动不影响；
    // 但目标本身消失（死亡/移除）时必须同步取消，避免残留无效引用
    if (this.target && !isValid(this.target)) this.setTarget(null);
    this.updateWorldPosition();
  }

  /** 每帧根据按键状态更新角色位移 */
  updateWorldPosition() {
    const rigidBody = this.getComponent(RigidBody2D);
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
    const speed = this.keyboardInput?.isSprinting ? ROLE_RUN_SPEED : ROLE_WALK_SPEED;
    const moveVec = this.keyboardInput?.moveDirection ?? new Vec2();
    // 直接赋值速度，有输入就动，没输入就立刻清零，解决漂移
    rigidBody.linearVelocity = new Vec2(moveVec.x * speed, moveVec.y * speed);
    LayerManager.move(this.getWorldPosition());
  }

  /** 设置角色世界坐标（如传送到复活点） */
  setWorldPositionByTransfer(worldPosition: Vec3) {
    this.setWorldPosition(worldPosition);
    LayerManager.move(this.getWorldPosition());
  }

  //#endregion

  //#region 外观更新

  /** 更改外观 */
  updateOutShow(role: Role) {
    this.role = role;
    // 衣服与武器外观
    this.appearance.updateOutShow(role, this.action, this.direction);
  }

  //#endregion

  //#region 攻击锁（普攻/技能通用）

  /**
   * 发起一次攻击动作（普攻/技能通用入口）
   * 正在攻击（动画未播放完成）时返回 false，按下不产生任何反应
   * 动画完整播放完成（FINISHED）后解锁并回调 onComplete；FINISHED 未触发时按动作时长兜底解锁
   */
  startAttack(action: ACTION, direction: DIRECTION, onComplete: () => void): boolean {
    if (this.attacking) return false;
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

  //#region 攻击逻辑

  /** 设置攻击目标（null 表示取消选中），并刷新怪物信息面板 */
  setTarget(target: Node | null) {
    this.target = target;
    RoleUIManager.selectMonster(target);
  }

  /** 攻击目标 */
  private attackTarget(target: Node) {
    /** 判断攻击距离，不在范围内不发起攻击 */
    if (!BattleHelper.checkTargetCanAttack(target, this as Node)) {
      GameUiHelper.createErrorTip("attack_range_tip", "距离太远，无法攻击！");
      return;
    }
    /** 发起普攻：锁定至攻击动画播放完成，完成后结算 */
    this.startAttack(ACTION.ATTACK_NEAR, BattleHelper.checkSelfDirection(target, this as Node), () => this.attackTargetUpdate());
  }

  /** 攻击动画播放完成后的结算 */
  private attackTargetUpdate() {
    if (!this.target || !isValid(this.target)) return;
    return MonsterManager.attack(this.target, StorageManager.findOnlineRole());
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
