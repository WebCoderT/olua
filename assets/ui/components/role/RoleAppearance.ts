import { Animation, Node } from "cc";
import { Role } from "../../../entities/Role";
import { ACTION, DIRECTION } from "../../../types/animation";
import { actionNeedWeapon, getAnimationName } from "../../../configs/animation";
import GameUiHelper from "../../helpers/GameUiHelper";

/**
 * 角色外观（衣服 + 武器）
 * 负责两个外观节点的创建、动画加载与动作切换；换装后按新装备重新加载动画
 * 攻击类动作动画完整播放完成时通过构造注入的回调通知宿主（宿主据此解除攻击锁）
 */
export default class RoleAppearance {
  /** 衣服节点 */
  private cloth: Node;
  /** 武器节点 */
  private weapon: Node;
  /** 衣服动画组件（无衣服时回退默认外观，因此加载后必有值） */
  private clothAnimate: Animation | null = null;
  /** 武器动画组件（未装备武器时为 null，需要武器的动作将保持原动画） */
  private weaponAnimate: Animation | null = null;
  /** 攻击类动作播放完成回调（宿主用于解锁） */
  private onAttackFinished: () => void;
  /** 当前动作（动画播完回到最新动作用） */
  private action: ACTION = ACTION.STAND;
  /** 当前朝向 */
  private direction: DIRECTION = DIRECTION.DOWN;

  constructor(host: Node, onAttackFinished: () => void) {
    this.onAttackFinished = onAttackFinished;
    // 衣服/武器节点（样式由 GameUiHelper 零件生成，本类只负责挂到宿主并持有引用）
    this.cloth = GameUiHelper.createRoleClothNode();
    host.addChild(this.cloth);
    this.weapon = GameUiHelper.createRoleWeaponNode();
    host.addChild(this.weapon);
  }

  /** 更新外观（换装后调用）：按当前装备重新加载衣服与武器动画 */
  updateOutShow(role: Role, action: ACTION, direction: DIRECTION) {
    this.action = action;
    this.direction = direction;
    this.reloadClothAnimation(role);
    this.reloadWeaponAnimation(role);
  }

  /**
   * 播放指定动作与朝向的动画
   * 需要武器的动作在未装备武器时不切换（保持当前动画）
   */
  play(action: ACTION, direction: DIRECTION) {
    this.action = action;
    this.direction = direction;
    if (actionNeedWeapon[action] && !this.weaponAnimate) return;
    const animationName = getAnimationName(action, direction);
    this.clothAnimate?.crossFade(animationName, 0.2);
    this.weaponAnimate?.crossFade(animationName, 0.2);
  }

  /** 重新加载衣服动画：无衣服时回退默认外观（role/1），保证角色始终有身体 */
  private reloadClothAnimation(role: Role) {
    // 销毁旧动画组件，避免叠加
    this.cloth.getComponent(Animation)?.destroy();
    this.clothAnimate = null;
    const animate = GameUiHelper.useRoleAnimation(getAnimationName(this.action, this.direction), this.cloth, role.equipments.cloth ? role.equipments.cloth.out : "role/1", role.speedRate);
    this.clothAnimate = animate;
    this.play(this.action, this.direction);
    animate.on(
      Animation.EventType.FINISHED,
      (_, { name }: { name: string }) => {
        if (name.includes("attack")) this.onAttackFinished();
        /** 播放完成后更换当前最新动画 */
        animate.play(getAnimationName(this.action, this.direction));
      },
      this,
    );
  }

  /** 重新加载武器动画：未装备武器时不加载 */
  private reloadWeaponAnimation(role: Role) {
    // 销毁旧动画组件，避免叠加
    this.weapon.getComponent(Animation)?.destroy();
    this.weaponAnimate = null;
    if (!role.equipments.weapon) return;
    /** 加载动画，除站立/走路/跑动外，其他动作都必须有武器 */
    const animate = GameUiHelper.useRoleAnimation(getAnimationName(this.action, this.direction), this.weapon, role.equipments.weapon.out, role.speedRate);
    this.weaponAnimate = animate;
    this.play(this.action, this.direction);
    animate.on(
      Animation.EventType.FINISHED,
      (_, { name }: { name: string }) => {
        if (name.includes("attack")) this.onAttackFinished();
        /** 播放完成后更换当前最新动画 */
        animate.play(getAnimationName(this.action, this.direction));
      },
      this,
    );
  }
}
