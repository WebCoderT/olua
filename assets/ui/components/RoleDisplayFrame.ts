import { Animation, AnimationClip, BoxCollider2D, EventKeyboard, Input, input, Node, resources, RigidBody2D, SpriteFrame, Vec2, Vec3 } from "cc";
import GameRoleUiHelper from "../helpers/GameRoleUiHelper";
import StorageHelper from "../utils/StorageHelper";
import { Role } from "../../configs/role";
import { ROLE_ACTION, ROLE_DIRECTION } from "../../types/common";
import { getRoleAnimationName, roleAnimationMap } from "../../configs/game";
import LayerHelper from "../helpers/LayerHelper";

interface RoleDisplayFrame {
  // 角色信息
  selectedRole: Role | null;
  // 基础裸模
  basicRole: Node | null;
  // 初始化
  init: (game: Node) => void;
  // 动画组件
  animate: Animation | null;
  // 按键方向
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  // 奔跑
  run: boolean;
  // 操作节点处理
  playNodeHandler: () => void;
  // 加载裸模动画
  loadBasicSpriteFrames: () => void;
  // 动画切割
  spliceAnimation: (spriteFrames: SpriteFrame[]) => void;
  // 创建动画
  createAnimation: (name: string, spriteFrames: SpriteFrame[]) => void;
  // 更改动画
  updateAnimationPlay: () => void;
  // 键盘监听
  keyboardListener: () => void;
  // 方向
  direction: ROLE_DIRECTION;
  // 方向更改
  updateDirection: () => void;
  // 动作
  action: ROLE_ACTION;
  // 动作更改
  updateAction: () => void;
  // 手动修改角色位置
  updateRoleWorldPosition: (worldPosition: Vec3) => void;
  // 移动，修改世界定位
  updateWorldPosition: () => void;
}

const RoleDisplayFrame: RoleDisplayFrame = {
  selectedRole: null,
  basicRole: null,
  // 动画组件
  animate: null,
  up: false,
  down: false,
  left: false,
  right: false,
  run: false,
  init(game: Node) {
    // 初始化角色数据
    this.selectedRole = StorageHelper.findOnlineRole();
    // 创建基础裸模
    RoleDisplayFrame.basicRole = GameRoleUiHelper.createBasicRole();
    game.addChild(RoleDisplayFrame.basicRole);
    // 初始化角色数据
    RoleDisplayFrame.selectedRole = StorageHelper.findOnlineRole();
    // 操作节点处理
    RoleDisplayFrame.playNodeHandler();
    // 加载裸模动画
    RoleDisplayFrame.loadBasicSpriteFrames();
    // 开启监听
    RoleDisplayFrame.keyboardListener();
  },
  // 操作节点处理
  playNodeHandler() {
    RoleDisplayFrame.animate = RoleDisplayFrame.basicRole.addComponent(Animation);
    const rigidBody = RoleDisplayFrame.basicRole.addComponent(RigidBody2D);
    rigidBody.gravityScale = 0;
    rigidBody.fixedRotation = true;
    // rigidBody.group = GameCollisionLayer.PLAYER;
    const boxCollider = RoleDisplayFrame.basicRole.addComponent(BoxCollider2D);
    // this.boxCollider.group = GameCollisionLayer.PLAYER;
  },
  // 加载裸模动画
  loadBasicSpriteFrames() {
    resources.loadDir(`role/${RoleDisplayFrame.selectedRole.sex}`, SpriteFrame, (err, spriteFrames) => {
      if (err) {
        console.error(`裸模动画帧加载失败：${err.message}`);
        return;
      }
      RoleDisplayFrame.spliceAnimation(spriteFrames);
    });
  },
  // 动画切割
  spliceAnimation(spriteFrames) {
    roleAnimationMap.forEach((value, key) => {
      // 有效动画帧过滤
      const validSpriteFrames = spriteFrames.filter((spriteFrame) => value.indexOf(Number(spriteFrame.name)) >= 0 && spriteFrame.getRect().width > 1 && spriteFrame.getRect().height > 1);
      RoleDisplayFrame.createAnimation(key, validSpriteFrames);
    });
    // 完成后首次播放动画
    RoleDisplayFrame.updateAnimationPlay();
  },
  // 创建动画
  createAnimation(name: string, spriteFrames: SpriteFrame[]) {
    const clip = AnimationClip.createWithSpriteFrames(spriteFrames, spriteFrames.length);
    clip.wrapMode = AnimationClip.WrapMode.Loop;
    clip.enableTrsBlending = false;
    clip.name = name;
    RoleDisplayFrame.animate.addClip(clip, name);
  },
  // 更改动画
  updateAnimationPlay() {
    RoleDisplayFrame.animate.crossFade(getRoleAnimationName(RoleDisplayFrame.action, RoleDisplayFrame.direction));
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
  direction: ROLE_DIRECTION.DOWN,

  // 方向更改
  updateDirection() {
    if (RoleDisplayFrame.up && RoleDisplayFrame.left) {
      RoleDisplayFrame.direction = ROLE_DIRECTION.LEFT_UP;
    } else if (RoleDisplayFrame.up && RoleDisplayFrame.right) {
      RoleDisplayFrame.direction = ROLE_DIRECTION.RIGHT_UP;
    } else if (RoleDisplayFrame.down && RoleDisplayFrame.left) {
      RoleDisplayFrame.direction = ROLE_DIRECTION.LEFT_DOWN;
    } else if (RoleDisplayFrame.down && RoleDisplayFrame.right) {
      RoleDisplayFrame.direction = ROLE_DIRECTION.RIGHT_DOWN;
    } else if (RoleDisplayFrame.up) {
      RoleDisplayFrame.direction = ROLE_DIRECTION.UP;
    } else if (RoleDisplayFrame.down) {
      RoleDisplayFrame.direction = ROLE_DIRECTION.DOWN;
    } else if (RoleDisplayFrame.left) {
      RoleDisplayFrame.direction = ROLE_DIRECTION.LEFT;
    } else if (RoleDisplayFrame.right) {
      RoleDisplayFrame.direction = ROLE_DIRECTION.RIGHT;
    }
    RoleDisplayFrame.updateAnimationPlay();
  },

  // 动作
  action: ROLE_ACTION.STAND,

  // 动作更改
  updateAction() {
    const isWalk = RoleDisplayFrame.up || RoleDisplayFrame.left || RoleDisplayFrame.down || RoleDisplayFrame.right;
    const isRun = isWalk && RoleDisplayFrame.run;
    if (isWalk && isRun) {
      RoleDisplayFrame.action = ROLE_ACTION.RUN;
      return;
    }
    if (isWalk) {
      RoleDisplayFrame.action = ROLE_ACTION.WALK;
      return;
    }
    RoleDisplayFrame.action = ROLE_ACTION.STAND;
    RoleDisplayFrame.updateAnimationPlay();
  },

  updateRoleWorldPosition(worldPosition) {
    RoleDisplayFrame.basicRole.setWorldPosition(worldPosition);
    LayerHelper.move(RoleDisplayFrame.basicRole.getWorldPosition());
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
    if (RoleDisplayFrame.action === ROLE_ACTION.WALK || RoleDisplayFrame.action === ROLE_ACTION.RUN) {
      rigidBody.linearVelocity = new Vec2(moveVec.x * speed, moveVec.y * speed);
      LayerHelper.move(RoleDisplayFrame.basicRole.getWorldPosition());
    } else {
      // 松开按键后，立刻把速度设为0，实现“松手即停”
      rigidBody.linearVelocity = Vec2.ZERO;
    }
  },
};

export default RoleDisplayFrame;
