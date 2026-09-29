import { Animation, BoxCollider2D, EventKeyboard, Input, input, Node, RigidBody2D, Size, UITransform, Vec2, Vec3 } from "cc";
import StorageManager from "../../core/StorageManager";
import { Role } from "../../../entities/Role";
import { ACTION, DIRECTION } from "../../../types/animation";
import { SkillContextInput } from "../../../types/skill";
import { actionNeedWeapon, getAnimationName } from "../../../configs/animation";
import { ROLE_RUN_SPEED, ROLE_WALK_SPEED } from "../../../configs/role";
import LayerManager from "../../core/LayerManager";
import GameUiHelper from "../../helpers/GameUiHelper";
import BattleHelper from "../../utils/BattleHelper";
import Monsters from "../map/Monsters";

/**
 * 角色展示组件（自身即主角节点）
 * 负责主角节点的构建、键盘操控、动作/方向状态机、外观（衣服与武器）动画切换及攻击逻辑
 * 怪物容器（Monsters）由外部注入
 */
export default class RoleDisplay extends Node {
  /** 衣服节点 */
  private cloth: Node;
  /** 衣服动画组件 */
  private clothAnimate: Animation | null = null;
  /** 武器节点 */
  private weapon: Node;
  /** 武器外观动画组件 */
  private weaponAnimate: Animation | null = null;
  /** 当前朝向 */
  private direction: DIRECTION = DIRECTION.DOWN;
  /** 当前动作 */
  private action: ACTION = ACTION.STAND;
  /** 攻击目标 */
  private target: Node | null = null;

  /** 怪物容器（外部注入） */
  private monsters: Monsters;
  /** 当前角色数据 */
  private role: Role;

  /** 键盘方向键按下状态 */
  private moveUp = false;
  private moveDown = false;
  private moveLeft = false;
  private moveRight = false;
  private sprint = false;

  constructor(role: Role, monsters: Monsters) {
    super("basic_role");
    this.role = role;
    this.monsters = monsters;
    this.createBody();
    this.addRigid();
    LayerManager.addToGameLayer(this);
  }

  /** 初始化（外观动画与键盘监听） */
  init() {
    this.updateOutShow(this.role);
    this.keyboardListener();
  }

  /** 构建角色身体（衣服/武器节点与头部信息栏） */
  private createBody() {
    const uiTransform = this.addComponent(UITransform);
    uiTransform.setContentSize(40, 70);
    this.getComponent(UITransform).setAnchorPoint(0.5, 0);
    /** 角色衣服效果展示节点（由 GameUiHelper 生成） */
    const cloth = GameUiHelper.createRoleClothNode();
    this.addChild(cloth);
    this.cloth = cloth;
    /** 角色武器效果展示节点（由 GameUiHelper 生成） */
    const weapon = GameUiHelper.createRoleWeaponNode();
    this.addChild(weapon);
    this.weapon = weapon;
    /** 角色头部信息栏父节点 */
    const roleInformationNode = GameUiHelper.createHead("role_head", this.role.name, this.role.hp, this.role.maxHp);
    /** 将角色头部信息栏加入节点 */
    this.addChild(roleInformationNode);
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

  //#region 动作与方向状态机

  /** 键盘监听 */
  private keyboardListener() {
    // 游戏按键监听
    input.on(Input.EventType.KEY_DOWN, this.onKeyDown, this);
    input.on(Input.EventType.KEY_UP, this.onKeyUp, this);
    // 场景销毁时移除全局键盘监听，避免重进场景后残留对已销毁节点的引用
    this.once(Node.EventType.NODE_DESTROYED, () => {
      input.off(Input.EventType.KEY_DOWN, this.onKeyDown, this);
      input.off(Input.EventType.KEY_UP, this.onKeyUp, this);
    });
  }

  /** 按键按下 */
  private onKeyDown(event: EventKeyboard) {
    this.setKeyState(event.keyCode, true);
    this.updateAction();
    this.updateDirection();
  }

  /** 按键抬起 */
  private onKeyUp(event: EventKeyboard) {
    this.setKeyState(event.keyCode, false);
    this.updateAction();
    this.updateDirection();
  }

  /** 按键码对应的按下状态变更 */
  private setKeyState(keyCode: number, pressed: boolean) {
    switch (keyCode) {
      case 87:
        this.moveUp = pressed;
        break;
      case 65:
        this.moveLeft = pressed;
        break;
      case 83:
        this.moveDown = pressed;
        break;
      case 68:
        this.moveRight = pressed;
        break;
      case 16:
        this.sprint = pressed;
        break;
    }
  }

  /** 方向更改 */
  private updateDirection() {
    if (this.moveUp && this.moveLeft) {
      this.direction = DIRECTION.LEFT_UP;
    } else if (this.moveUp && this.moveRight) {
      this.direction = DIRECTION.RIGHT_UP;
    } else if (this.moveDown && this.moveLeft) {
      this.direction = DIRECTION.LEFT_DOWN;
    } else if (this.moveDown && this.moveRight) {
      this.direction = DIRECTION.RIGHT_DOWN;
    } else if (this.moveUp) {
      this.direction = DIRECTION.UP;
    } else if (this.moveDown) {
      this.direction = DIRECTION.DOWN;
    } else if (this.moveLeft) {
      this.direction = DIRECTION.LEFT;
    } else if (this.moveRight) {
      this.direction = DIRECTION.RIGHT;
    }
    this.updateAnimationPlay();
  }

  /** 动作更改 */
  private updateAction() {
    const isWalk = this.moveUp || this.moveLeft || this.moveDown || this.moveRight;
    const isRun = isWalk && this.sprint;
    if (isWalk && isRun) {
      this.action = ACTION.RUN;
      return;
    }
    if (isWalk) {
      this.action = ACTION.WALK;
      return;
    }
    this.action = ACTION.STAND;
    this.updateAnimationPlay();
  }

  /** 更改播放的动作 */
  private updateAnimationPlay() {
    /** 更换动作前判断，动作是否需要武器 */
    if (actionNeedWeapon[this.action] && !this.weaponAnimate) return;
    this.clothAnimate && this.clothAnimate.crossFade(getAnimationName(this.action, this.direction), 0.2);
    this.weaponAnimate && this.weaponAnimate.crossFade(getAnimationName(this.action, this.direction), 0.2);
  }

  //#endregion

  //#region 位置更新

  /** 每帧根据按键状态更新角色位移 */
  updateWorldPosition() {
    const rigidBody = this.getComponent(RigidBody2D);
    const speed = this.sprint ? ROLE_RUN_SPEED : ROLE_WALK_SPEED;
    let inputX = 0;
    let inputY = 0;
    if (this.moveUp) inputY += 1;
    if (this.moveDown) inputY -= 1;
    if (this.moveLeft) inputX -= 1;
    if (this.moveRight) inputX += 1;
    const moveVec = new Vec2(inputX, inputY);
    if (moveVec.length() > 0) {
      moveVec.normalize();
    }
    // 直接赋值速度，有输入就动，没输入就立刻清零，解决漂移
    if (this.action === ACTION.WALK || this.action === ACTION.RUN) {
      rigidBody.linearVelocity = new Vec2(moveVec.x * speed, moveVec.y * speed);
      LayerManager.move(this.getWorldPosition());
    } else {
      // 松开按键后，立刻把速度设为0，实现"松手即停"
      rigidBody.linearVelocity = Vec2.ZERO;
    }
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
    // 衣服
    this.updateClothOutShow(role);
    // 武器
    this.updateWeaponOutShow(role);
  }

  /** 更改衣服外观 */
  private updateClothOutShow(role: Role) {
    // 销毁动画组件
    this.cloth.getComponent(Animation)?.destroy();
    this.clothAnimate = null;
    // 加载动画
    if (role.equipments.cloth) {
      this.clothAnimate = GameUiHelper.useRoleAnimation(getAnimationName(this.action, this.direction), this.cloth, role.equipments.cloth.out, role.speedRate);
    } else {
      this.clothAnimate = GameUiHelper.useRoleAnimation(getAnimationName(this.action, this.direction), this.cloth, "role/1", role.speedRate);
    }
    this.updateAnimationPlay();
    this.clothAnimate.on(
      Animation.EventType.FINISHED,
      (_, { name }: { name: string }) => {
        /** 播放完成后更换当前最新动画 */
        this.clothAnimate.play(getAnimationName(this.action, this.direction));
      },
      this,
    );
  }

  /** 更改武器外观 */
  private updateWeaponOutShow(role: Role) {
    // 销毁动画组件
    this.weapon.getComponent(Animation)?.destroy();
    this.weaponAnimate = null;
    /** 加载动画,除了最基础的站立，跑动，走路动画外，其他动画都必须有武器 */
    if (role.equipments.weapon) {
      this.weaponAnimate = GameUiHelper.useRoleAnimation(getAnimationName(this.action, this.direction), this.weapon, role.equipments.weapon.out, role.speedRate);
      this.updateAnimationPlay();
      this.weaponAnimate.on(
        Animation.EventType.FINISHED,
        (_, { name }: { name: string }) => {
          if (name.includes("attack")) {
            this.attackTargetUpdate();
          }
          /** 播放完成后更换当前最新动画 */
          this.weaponAnimate.play(getAnimationName(this.action, this.direction));
        },
        this,
      );
    }
  }

  //#endregion

  //#region 攻击逻辑

  /** 设置攻击目标 */
  setTarget(target: Node) {
    this.target = target;
  }

  /** 攻击目标 */
  private attackTarget(target: Node) {
    /** 判断攻击距离，不在范围内不发起攻击 */
    if (!BattleHelper.checkTargetCanAttack(target, this as Node)) {
      GameUiHelper.createErrorTip("attack_range_tip", "距离太远，无法攻击！");
      return;
    }
    /** 设置动作为攻击，并立即更改动作 */
    this.action = ACTION.ATTACK_NEAR;
    this.direction = BattleHelper.checkSelfDirection(target, this as Node);
    this.updateAnimationPlay();
  }

  /** 攻击动画播放完成后的结算 */
  private attackTargetUpdate() {
    return this.monsters.monsterUpdate(this.target.uuid, StorageManager.findOnlineRole());
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
      monsters: this.monsters,
    };
  }

  /** 面向指定方向播放攻击动画（技能表现） */
  playSkillAttack(direction: DIRECTION) {
    this.direction = direction;
    this.action = ACTION.ATTACK_NEAR;
    this.updateAnimationPlay();
  }

  //#endregion
}
