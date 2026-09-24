import { Animation, AnimationClip, EventKeyboard, input, Input, isValid, Node, resources, SpriteFrame } from "cc";
import { getRoleAnimationName, Role, ROLE_ACTION, ROLE_DIRECTION, roleActions, roleAnimationMap } from "../../configs";
import StorageHelper from "../StorageHelper";

interface RolePlayFrame {
  // 角色信息
  selectedRole: Role | null;
  // 基础裸模
  basicRole: Node | null;
  // 动画组件
  animate: Animation | null;
  // 按键方向
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  // 奔跑
  run: boolean;
  // 初始化
  init: (node: Node) => void;
  // 操作节点处理
  playNodeHandler: (node: Node) => void;
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
  updateDirection: Function;
  // 动作
  action: ROLE_ACTION;
  // 动作更改
  updateAction: Function;
}

const RolePlayFrame: RolePlayFrame = {
  selectedRole: null,
  basicRole: null,
  // 动画组件
  animate: null,
  up: false,
  down: false,
  left: false,
  right: false,
  run: false,
  init(node: Node) {
    // 初始化角色数据
    RolePlayFrame.selectedRole = StorageHelper.findSelectedRole();
    // 操作节点处理
    RolePlayFrame.playNodeHandler(node);
    // 加载裸模动画
    RolePlayFrame.loadBasicSpriteFrames();
    // 开启监听
    RolePlayFrame.keyboardListener();
  },
  // 操作节点处理
  playNodeHandler(node: Node) {
    RolePlayFrame.basicRole = node;
    RolePlayFrame.animate = RolePlayFrame.basicRole.addComponent(Animation);
  },
  // 加载裸模动画
  loadBasicSpriteFrames() {
    resources.loadDir(`role/${RolePlayFrame.selectedRole.sex}`, SpriteFrame, (err, spriteFrames) => {
      if (err) {
        console.log(`裸模动画帧加载失败：${err.message}`);
        return;
      }
      RolePlayFrame.spliceAnimation(spriteFrames);
    });
  },
  // 动画切割
  spliceAnimation(spriteFrames) {
    roleAnimationMap.forEach((value, key) => {
      // 有效动画帧过滤
      const validSpriteFrames = spriteFrames.filter((spriteFrame) => value.indexOf(Number(spriteFrame.name)) >= 0 && spriteFrame.getRect().width > 1 && spriteFrame.getRect().height > 1);
      RolePlayFrame.createAnimation(key, validSpriteFrames);
    });
    // 完成后首次播放动画
    RolePlayFrame.updateAnimationPlay();
  },
  // 创建动画
  createAnimation(name: string, spriteFrames: SpriteFrame[]) {
    const clip = AnimationClip.createWithSpriteFrames(spriteFrames, spriteFrames.length);
    clip.wrapMode = AnimationClip.WrapMode.Loop;
    clip.enableTrsBlending = false;
    clip.name = name;
    RolePlayFrame.animate.addClip(clip, name);
  },
  // 更改动画
  updateAnimationPlay() {
    console.log(RolePlayFrame.action, RolePlayFrame.direction);
    RolePlayFrame.animate.crossFade(getRoleAnimationName(RolePlayFrame.action, RolePlayFrame.direction));
  },
  // 键盘监听
  keyboardListener() {
    // 游戏按键监听
    input.on(Input.EventType.KEY_DOWN, (event: EventKeyboard) => {
      switch (event.keyCode) {
        case 87:
          RolePlayFrame.up = true;
          break;
        case 65:
          RolePlayFrame.left = true;
          break;
        case 83:
          RolePlayFrame.down = true;
          break;
        case 68:
          RolePlayFrame.right = true;
          break;
        case 16:
          RolePlayFrame.run = true;
          break;
      }
      RolePlayFrame.updateAction();
      RolePlayFrame.updateDirection();
    });
    input.on(Input.EventType.KEY_UP, (event: EventKeyboard) => {
      switch (event.keyCode) {
        case 87:
          RolePlayFrame.up = false;
          break;
        case 65:
          RolePlayFrame.left = false;
          break;
        case 83:
          RolePlayFrame.down = false;
          break;
        case 68:
          RolePlayFrame.right = false;
          break;
        case 16:
          RolePlayFrame.run = false;
          break;
      }
      RolePlayFrame.updateAction();
      RolePlayFrame.updateDirection();
    });
  },

  // 方向
  direction: ROLE_DIRECTION.DOWN,

  // 方向更改
  updateDirection() {
    if (RolePlayFrame.up && RolePlayFrame.left) {
      RolePlayFrame.direction = ROLE_DIRECTION.LEFT_UP;
    } else if (RolePlayFrame.up && RolePlayFrame.right) {
      RolePlayFrame.direction = ROLE_DIRECTION.RIGHT_UP;
    } else if (RolePlayFrame.down && RolePlayFrame.left) {
      RolePlayFrame.direction = ROLE_DIRECTION.LEFT_DOWN;
    } else if (RolePlayFrame.down && RolePlayFrame.right) {
      RolePlayFrame.direction = ROLE_DIRECTION.RIGHT_DOWN;
    } else if (RolePlayFrame.up) {
      RolePlayFrame.direction = ROLE_DIRECTION.UP;
    } else if (RolePlayFrame.down) {
      RolePlayFrame.direction = ROLE_DIRECTION.DOWN;
    } else if (RolePlayFrame.left) {
      RolePlayFrame.direction = ROLE_DIRECTION.LEFT;
    } else if (RolePlayFrame.right) {
      RolePlayFrame.direction = ROLE_DIRECTION.RIGHT;
    }
    RolePlayFrame.updateAnimationPlay();
  },

  // 动作
  action: ROLE_ACTION.STAND,

  // 动作更改
  updateAction() {
    const isWalk = RolePlayFrame.up || RolePlayFrame.left || RolePlayFrame.down || RolePlayFrame.right;
    const isRun = isWalk && RolePlayFrame.run;
    if (isWalk && isRun) {
      RolePlayFrame.action = ROLE_ACTION.RUN;
      return;
    }
    if (isWalk) {
      RolePlayFrame.action = ROLE_ACTION.WALK;
      return;
    }
    RolePlayFrame.action = ROLE_ACTION.STAND;
    RolePlayFrame.updateAnimationPlay();
  },
};

export default RolePlayFrame;
