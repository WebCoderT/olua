import { Animation, Node, Vec2 } from "cc";
import { Role } from "../../../entities/Role";
import { Equipment } from "../../../types/good";
import { ACTION, DIRECTION } from "../../../types/animation";
import { actionNeedWeapon, getAnimationName, getDirectionIndex } from "../../../configs/animation";
import { ROLE_DEFAULT_CLOTH_OUT } from "../../../configs/role";
import GameUiHelper from "../../helpers/GameUiHelper";

/**
 * 角色外观（衣服 + 武器）
 * 负责两个外观节点的创建、动画加载与动作切换；换装后按新装备重新加载动画
 * 只有外观资源真的变了才重新装载动画，且复用节点上已有的动画组件（不再销毁重建）：
 * 引擎的 destroy 要到帧末才真正移除组件，同帧重新 addComponent 会让节点上短暂存在两个 Animation 互相抢帧
 * 攻击类动作动画完整播放完成时通过构造注入的回调通知宿主（宿主据此解除攻击锁）
 * 动画帧由 AnimationHelper 按目录缓存、进图前已由 PreloadManager 预加载，因此装载动画基本是同步完成的
 */
export default class RoleAppearance {
  /** 衣服节点 */
  private cloth: Node;
  /** 武器节点 */
  private weapon: Node;
  /** 衣服动画组件（无衣服时回退默认外观，因此加载后必有值） */
  private clothAnimate: Animation | null = null;
  /** 武器动画组件（未装备武器或该武器没有外观时为 null，需要武器的动作将保持原动画） */
  private weaponAnimate: Animation | null = null;
  /** 衣服当前装载的外观目录（换装后先比较，没变就不重复装载） */
  private clothSrc = "";
  /** 武器当前装载的外观目录（空串表示当前没有武器外观） */
  private weaponSrc = "";
  /** 攻击类动作播放完成回调（宿主用于解锁） */
  private onAttackFinished: () => void;
  /** 当前动作（动画播完回到最新动作用） */
  private action: ACTION = ACTION.STAND;
  /** 当前朝向 */
  private direction: DIRECTION = DIRECTION.DOWN;
  /** 当前穿戴的衣服/武器装备（play 里按方向应用外观位置用；未装备时为 null） */
  private clothEquipment: Equipment | null = null;
  private weaponEquipment: Equipment | null = null;

  constructor(host: Node, onAttackFinished: () => void) {
    this.onAttackFinished = onAttackFinished;
    // 衣服/武器节点（样式由 GameUiHelper 零件生成，本类只负责挂到宿主并持有引用）
    // 先武器后衣服：同层后加的节点渲染在上面，需求是衣服盖在武器上方（武器在身后）
    this.weapon = GameUiHelper.createRoleWeaponNode();
    host.addChild(this.weapon);
    this.cloth = GameUiHelper.createRoleClothNode();
    host.addChild(this.cloth);
  }

  /** 更新外观（换装后调用）：按当前装备重新加载衣服与武器动画 */
  updateOutShow(role: Role, action: ACTION, direction: DIRECTION) {
    this.action = action;
    this.direction = direction;
    this.reloadClothAnimation(role);
    this.reloadWeaponAnimation(role);
    this.play(action, direction);
  }

  /**
   * 播放指定动作与朝向的动画
   * 需要武器的动作在未装备武器时不切换（保持当前动画）
   */
  play(action: ACTION, direction: DIRECTION) {
    this.action = action;
    this.direction = direction;
    // 外观缩放与按方向的位置：朝向变化时也要更新，因此放在 play（换装后的 updateOutShow 最终也会走到这里）
    this.applyOutTransform(this.cloth, this.clothEquipment);
    this.applyOutTransform(this.weapon, this.weaponEquipment);
    if (actionNeedWeapon[action] && !this.weaponAnimate) return;
    const animationName = getAnimationName(action, direction);
    this.clothAnimate?.crossFade(animationName, 0.2);
    this.weaponAnimate?.crossFade(animationName, 0.2);
  }

  /** 重新加载衣服动画：无衣服时回退默认外观，保证角色始终有身体 */
  private reloadClothAnimation(role: Role) {
    const cloth = role.equipments.cloth;
    const src = cloth?.out || ROLE_DEFAULT_CLOTH_OUT;
    this.clothEquipment = cloth ?? null;
    if (src === this.clothSrc) return;
    this.clothSrc = src;
    this.clothAnimate = this.loadAnimation(this.cloth, src, role);
  }

  /** 重新加载武器动画：未装备武器或该武器没有外观时不加载（武器节点整节点隐藏） */
  private reloadWeaponAnimation(role: Role) {
    const weapon = role.equipments.weapon;
    const src = weapon?.out ?? "";
    this.weaponEquipment = weapon ?? null;
    if (src === this.weaponSrc) return;
    this.weaponSrc = src;
    this.weaponAnimate = src ? this.loadAnimation(this.weapon, src, role) : null;
    // 没有武器外观时必须隐藏：Sprite 会保留上一把武器的最后一帧，不隐藏就会看到残留的旧武器
    this.weapon.active = !!src;
  }

  /**
   * 应用装备配置的外观缩放与按方向的位置（outScale / outPositions）
   * 位置数组按 configs/animation 的 directions 顺序取当前朝向的下标；
   * 数组缺该项时回落第一项，旧存档（无该字段）回落到原点，避免脱下装备后残留上一件的变换
   */
  private applyOutTransform(node: Node, equipment: Equipment | null) {
    const scale = equipment?.outScale ?? 1;
    const positions = equipment?.outPositions;
    const offset = positions?.[getDirectionIndex(this.direction)] ?? positions?.[0] ?? Vec2.ZERO;
    node.setScale(scale, scale, 1);
    node.setPosition(offset.x, offset.y, 0);
  }

  /** 装载一个外观节点的动画（重复调用时先清掉上一次注册的完成监听，避免重复回调） */
  private loadAnimation(node: Node, src: string, role: Role) {
    const animate = GameUiHelper.useRoleAnimation(getAnimationName(this.action, this.direction), node, src, role.speedRate);
    animate.targetOff(this);
    animate.on(
      Animation.EventType.FINISHED,
      (_, { name }: { name: string }) => {
        if (name.includes("attack")) this.onAttackFinished();
        /** 播放完成后更换当前最新动画 */
        animate.play(getAnimationName(this.action, this.direction));
      },
      this,
    );
    return animate;
  }
}
