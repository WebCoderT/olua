import { Animation, BoxCollider2D, Color, EventKeyboard, Input, input, Node, resources, RigidBody2D, Size, Sprite, SpriteFrame, UITransform, Vec2, Vec3 } from "cc";
import StorageManager from "../utils/StorageManager";
import { Role } from "../../configs/role";
import { ACTION, DIRECTION } from "../../types/common";
import { getAnimationName, roleAnimationMap } from "../../configs/game";
import LayerManager from "../utils/LayerManager";
import AnimationHelper from "../helpers/AnimationHelper";
import UiHelper from "../helpers/UiHelper";
import GameUiHelper from "../helpers/GameUiHelper";

interface RoleDisplayFrame {
  // 基础角色区域
  basicRole: Node | null;
  // 初始化
  init: () => void;
  /** 创建基础角色 */
  createBasicRole: (role: Role) => { node: Node; cloth: Node; weapon: Node };
  // 按键方向
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  // 奔跑
  run: boolean;
  // 操作节点处理
  addRigid: () => void;
  // 更改动画
  updateAnimationPlay: () => void;
  // 键盘监听
  keyboardListener: () => void;
  // 方向
  direction: DIRECTION;
  // 方向更改
  updateDirection: () => void;
  // 动作
  action: ACTION;
  // 动作更改
  updateAction: () => void;
  // 手动修改角色位置
  updateRoleWorldPosition: (worldPosition: Vec3) => void;
  // 移动，修改世界定位
  updateWorldPosition: () => void;
  // 衣服节点
  cloth: Node | null;
  // 动画组件
  clothAnimate: Animation | null;
  // 更改衣服外观
  updateClothOutShow(role: Role): void;
  // 武器节点
  weapon: Node | null;
  // 武器外观动画组件
  weaponAnimate: Animation | null;
  // 更改武器外观
  updateWeaponOutShow(role: Role): void;
  // 更改外观
  updateOutShow(role: Role): void;
}

const RoleDisplayFrame: RoleDisplayFrame = {
  // 基础角色区域
  basicRole: null,
  up: false,
  down: false,
  left: false,
  right: false,
  run: false,
  init() {
    // 初始化角色数据
    const role = StorageManager.findOnlineRole();
    // 创建基础角色
    const { node, cloth, weapon } = RoleDisplayFrame.createBasicRole(role);
    // 添加进场景
    RoleDisplayFrame.basicRole = node;
    RoleDisplayFrame.cloth = cloth;
    RoleDisplayFrame.weapon = weapon;
    // 增加碰撞
    RoleDisplayFrame.addRigid();
    // 加载动画
    RoleDisplayFrame.updateOutShow(role);
    // 开启监听
    RoleDisplayFrame.keyboardListener();
    console.log(roleAnimationMap.get("attack_up"));
  },
  /**
   * 创建基础角色
   */
  createBasicRole(role) {
    /** 角色效果展示父节点 */
    const effectNode = UiHelper.createSprite("basic_role", "", new Vec2(), new Size(40, 70));
    effectNode.getComponent(UITransform).setAnchorPoint(0.5, 0);
    /** 角色衣服效果展示节点 */
    const cloth = UiHelper.createSprite("cloth", "");
    cloth.getComponent(Sprite).sizeMode = Sprite.SizeMode.RAW;
    effectNode.addChild(cloth);
    /** 角色武器效果展示节点 */
    const weapon = UiHelper.createSprite("weapon", "");
    weapon.getComponent(Sprite).sizeMode = Sprite.SizeMode.RAW;
    effectNode.addChild(weapon);
    /** 角色头部信息栏父节点 */
    const roleInformationNode = GameUiHelper.createHead("role_head", role.name, role.hp, role.maxHp);
    /** 将橘色头部信息栏加入节点 */
    effectNode.addChild(roleInformationNode);
    /** 将角色节点加入游戏 */
    LayerManager.addToGameLayer(effectNode);
    return {
      node: effectNode,
      cloth,
      weapon,
    };
  },
  // 增加碰撞
  addRigid() {
    const rigidBody = RoleDisplayFrame.basicRole.addComponent(RigidBody2D);
    rigidBody.gravityScale = 0;
    rigidBody.fixedRotation = true;
    // rigidBody.group = GameCollisionLayer.PLAYER;
    const boxCollider = RoleDisplayFrame.basicRole.addComponent(BoxCollider2D);
    boxCollider.size = new Size(40, 70);
    boxCollider.offset = new Vec2(0, 35);
    // this.boxCollider.group = GameCollisionLayer.PLAYER;
  },
  // 更改动画
  updateAnimationPlay() {
    RoleDisplayFrame.clothAnimate && RoleDisplayFrame.clothAnimate.crossFade(getAnimationName(RoleDisplayFrame.action, RoleDisplayFrame.direction), 0.2);
    RoleDisplayFrame.weaponAnimate && RoleDisplayFrame.weaponAnimate.crossFade(getAnimationName(RoleDisplayFrame.action, RoleDisplayFrame.direction), 0.2);
  },

  // 键盘监听
  keyboardListener() {
    // 游戏按键监听
    input.on(Input.EventType.KEY_DOWN, (event: EventKeyboard) => {
      switch (event.keyCode) {
        case 87:
          RoleDisplayFrame.up = true;
          break;
        case 65:
          RoleDisplayFrame.left = true;
          break;
        case 83:
          RoleDisplayFrame.down = true;
          break;
        case 68:
          RoleDisplayFrame.right = true;
          break;
        case 16:
          RoleDisplayFrame.run = true;
          break;
      }
      RoleDisplayFrame.updateAction();
      RoleDisplayFrame.updateDirection();
    });
    input.on(Input.EventType.KEY_UP, (event: EventKeyboard) => {
      switch (event.keyCode) {
        case 87:
          RoleDisplayFrame.up = false;
          break;
        case 65:
          RoleDisplayFrame.left = false;
          break;
        case 83:
          RoleDisplayFrame.down = false;
          break;
        case 68:
          RoleDisplayFrame.right = false;
          break;
        case 16:
          RoleDisplayFrame.run = false;
          break;
      }
      RoleDisplayFrame.updateAction();
      RoleDisplayFrame.updateDirection();
    });
  },

  // 方向
  direction: DIRECTION.DOWN,

  // 方向更改
  updateDirection() {
    if (RoleDisplayFrame.up && RoleDisplayFrame.left) {
      RoleDisplayFrame.direction = DIRECTION.LEFT_UP;
    } else if (RoleDisplayFrame.up && RoleDisplayFrame.right) {
      RoleDisplayFrame.direction = DIRECTION.RIGHT_UP;
    } else if (RoleDisplayFrame.down && RoleDisplayFrame.left) {
      RoleDisplayFrame.direction = DIRECTION.LEFT_DOWN;
    } else if (RoleDisplayFrame.down && RoleDisplayFrame.right) {
      RoleDisplayFrame.direction = DIRECTION.RIGHT_DOWN;
    } else if (RoleDisplayFrame.up) {
      RoleDisplayFrame.direction = DIRECTION.UP;
    } else if (RoleDisplayFrame.down) {
      RoleDisplayFrame.direction = DIRECTION.DOWN;
    } else if (RoleDisplayFrame.left) {
      RoleDisplayFrame.direction = DIRECTION.LEFT;
    } else if (RoleDisplayFrame.right) {
      RoleDisplayFrame.direction = DIRECTION.RIGHT;
    }
    RoleDisplayFrame.updateAnimationPlay();
  },

  // 动作
  action: ACTION.ATTACK,

  // 动作更改
  updateAction() {
    const isWalk = RoleDisplayFrame.up || RoleDisplayFrame.left || RoleDisplayFrame.down || RoleDisplayFrame.right;
    const isRun = isWalk && RoleDisplayFrame.run;
    if (isWalk && isRun) {
      RoleDisplayFrame.action = ACTION.RUN;
      return;
    }
    if (isWalk) {
      RoleDisplayFrame.action = ACTION.WALK;
      return;
    }
    RoleDisplayFrame.action = ACTION.STAND;
    RoleDisplayFrame.updateAnimationPlay();
  },

  updateRoleWorldPosition(worldPosition) {
    RoleDisplayFrame.basicRole.setWorldPosition(worldPosition);
    LayerManager.move(RoleDisplayFrame.basicRole.getWorldPosition());
  },

  updateWorldPosition() {
    const rigidBody = RoleDisplayFrame.basicRole.getComponent(RigidBody2D);
    const speed = 2;
    let inputX = 0;
    let inputY = 0;
    if (RoleDisplayFrame.up) inputY += 1;
    if (RoleDisplayFrame.down) inputY -= 1;
    if (RoleDisplayFrame.left) inputX -= 1;
    if (RoleDisplayFrame.right) inputX += 1;

    const moveVec = new Vec2(inputX, inputY);
    if (moveVec.length() > 0) {
      moveVec.normalize();
    }

    // 关键：直接赋值速度，有输入就动，没输入就立刻清零，彻底解决漂移
    if (RoleDisplayFrame.action === ACTION.WALK || RoleDisplayFrame.action === ACTION.RUN) {
      rigidBody.linearVelocity = new Vec2(moveVec.x * speed, moveVec.y * speed);
      LayerManager.move(RoleDisplayFrame.basicRole.getWorldPosition());
    } else {
      // 松开按键后，立刻把速度设为0，实现“松手即停”
      rigidBody.linearVelocity = Vec2.ZERO;
    }
  },

  // 衣服节点
  cloth: null,
  // 动画组件
  clothAnimate: null,
  // 更改衣服外观
  updateClothOutShow(role) {
    // 销毁动画组件
    RoleDisplayFrame.cloth.getComponent(Animation)?.destroy();
    RoleDisplayFrame.clothAnimate = null;
    // 加载动画
    if (role.equipments.cloth) {
      RoleDisplayFrame.clothAnimate = AnimationHelper.useRoleAnimation(getAnimationName(RoleDisplayFrame.action, RoleDisplayFrame.direction), RoleDisplayFrame.cloth, role.equipments.cloth.out);
      RoleDisplayFrame.updateAnimationPlay();
    } else {
      RoleDisplayFrame.clothAnimate = AnimationHelper.useRoleAnimation(getAnimationName(RoleDisplayFrame.action, RoleDisplayFrame.direction), RoleDisplayFrame.cloth, "role/1");
      RoleDisplayFrame.updateAnimationPlay();
    }
  },
  // 武器节点
  weapon: null,
  // 武器外观动画组件
  weaponAnimate: null,
  // 更改武器外观
  updateWeaponOutShow(role: Role) {
    // 销毁动画组件
    RoleDisplayFrame.weapon.getComponent(Animation)?.destroy();
    RoleDisplayFrame.weaponAnimate = null;
    // 加载动画
    if (role.equipments.weapon) {
      RoleDisplayFrame.weaponAnimate = AnimationHelper.useRoleAnimation(getAnimationName(RoleDisplayFrame.action, RoleDisplayFrame.direction), RoleDisplayFrame.weapon, role.equipments.weapon.out);
      RoleDisplayFrame.updateAnimationPlay();
    }
  },

  // 更改外观
  updateOutShow(role) {
    // 衣服
    RoleDisplayFrame.updateClothOutShow(role);
    // 武器
    RoleDisplayFrame.updateWeaponOutShow(role);
  },
};

export default RoleDisplayFrame;
