import { Animation, Node, Vec2 } from "cc";
import { Role } from "../../../entities/Role";
import { OutTransform } from "../../../types/good";
import { ACTION, DIRECTION } from "../../../types/animation";
import { actionNeedWeapon, getAnimationName, getDirectionIndex } from "../../../configs/animation";
import { getEquipment } from "../../../configs/items";
import { getRoleDefaultCloth } from "../../../configs/role";
import GameUiHelper from "../../helpers/GameUiHelper";

/** 这些朝向下衣服在武器上方（武器在身后）：左 / 左上 / 上 / 左下；其余朝向武器在衣服上方 */
const CLOTH_ON_TOP_DIRECTIONS: DIRECTION[] = [DIRECTION.LEFT, DIRECTION.LEFT_UP, DIRECTION.UP, DIRECTION.LEFT_DOWN];

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
  /**
   * 当前外观变换（play 里按方向应用缩放与位置用）
   * 衣服：未穿戴时是**该性别的默认外观**（见 configs/role.roleDefaultCloths），因此恒有值；
   * 武器：未装备或该武器没有外观时为 null（回落到不缩放、不偏移）
   * 装备与默认外观都满足 OutTransform，于是两条路走的是同一套变换代码
   */
  private clothTransform: OutTransform | null = null;
  private weaponTransform: OutTransform | null = null;
  /** 上次计算的层级关系（null 表示尚未计算；方向没变时不重复调整 sibling） */
  private clothOnTop: boolean | null = null;
  /** 死亡标记：死亡动画播完停最后一帧，期间不再响应任何动作切换与播完续播，直到复活 */
  private dead = false;

  constructor(host: Node, onAttackFinished: () => void) {
    this.onAttackFinished = onAttackFinished;
    // 衣服/武器节点（样式由 GameUiHelper 零件生成，本类只负责挂到宿主并持有引用）
    // 两者的层级关系由 updateLayerOrder 按朝向动态调整（首次 play 时立即生效），这里的顺序只是初始兜底
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
    // 死亡期间动作切换全部冻结：死亡动画播完后一直停最后一帧，直到复活
    if (this.dead) return;
    this.action = action;
    this.direction = direction;
    // 外观缩放与按方向的位置：朝向变化时也要更新，因此放在 play（换装后的 updateOutShow 最终也会走到这里）
    this.applyOutTransform(this.cloth, this.clothTransform);
    this.applyOutTransform(this.weapon, this.weaponTransform);
    this.updateLayerOrder();
    if (actionNeedWeapon[action] && !this.weaponAnimate) return;
    const animationName = getAnimationName(action, direction);
    this.clothAnimate?.crossFade(animationName, 0.2);
    this.weaponAnimate?.crossFade(animationName, 0.2);
  }

  /**
   * 播放死亡动画（由宿主在角色血量归零时调用，见 RoleDisplay.die）
   * 按当前朝向播放死亡动作，播完停最后一帧（Normal 模式播完保持末帧，播完续播被 dead 标记拦住）
   */
  die(direction: DIRECTION) {
    this.action = ACTION.DIE;
    this.direction = direction;
    this.dead = true;
    this.applyOutTransform(this.cloth, this.clothTransform);
    this.applyOutTransform(this.weapon, this.weaponTransform);
    this.updateLayerOrder();
    const animationName = getAnimationName(ACTION.DIE, direction);
    this.clothAnimate?.crossFade(animationName, 0.1);
    this.weaponAnimate?.crossFade(animationName, 0.1);
  }

  /** 复活（由宿主在回血/传送完成后调用）：解除死亡状态并回到待机 */
  revive() {
    this.dead = false;
    this.play(ACTION.STAND, this.direction);
  }

  /**
   * 按朝向调整衣服与武器的层级：左/左上/上/左下时衣服在武器上方，其余朝向武器在衣服上方
   * 方向没变时不做任何事（play 会在动作切换时频繁调用，避免反复触发 sibling 重排）
   */
  private updateLayerOrder() {
    const clothOnTop = CLOTH_ON_TOP_DIRECTIONS.indexOf(this.direction) !== -1;
    if (this.clothOnTop === clothOnTop) return;
    this.clothOnTop = clothOnTop;
    if (clothOnTop) this.cloth.setSiblingIndex(this.weapon.getSiblingIndex() + 1);
    else this.weapon.setSiblingIndex(this.cloth.getSiblingIndex() + 1);
  }

  /** 重新加载衣服动画：无衣服时按性别回退默认外观，保证角色始终有身体 */
  private reloadClothAnimation(role: Role) {
    const cloth = getEquipment(role.equipments.cloth);
    // 未穿衣服时按性别取默认身体（男 role/1、女 role/2），外观变换与穿衣服同口径
    const fallback = getRoleDefaultCloth(role.sex);
    const src = cloth?.out || fallback.out;
    this.clothTransform = cloth ?? fallback;
    if (src === this.clothSrc) return;
    this.clothSrc = src;
    this.clothAnimate = this.loadAnimation(this.cloth, src, role);
  }

  /** 重新加载武器动画：未装备武器或该武器没有外观时不加载（武器节点整节点隐藏） */
  private reloadWeaponAnimation(role: Role) {
    const weapon = getEquipment(role.equipments.weapon);
    const src = weapon?.out ?? "";
    this.weaponTransform = weapon;
    if (src === this.weaponSrc) return;
    this.weaponSrc = src;
    this.weaponAnimate = src ? this.loadAnimation(this.weapon, src, role) : null;
    // 没有武器外观时必须隐藏：Sprite 会保留上一把武器的最后一帧，不隐藏就会看到残留的旧武器
    this.weapon.active = !!src;
  }

  /**
   * 应用外观变换（outScale / outPositions）
   * 位置数组按 configs/animation 的 directions 顺序取当前朝向的下标；
   * 数组缺该项时回落第一项，变换缺省（null）时回落到不缩放、不偏移
   */
  private applyOutTransform(node: Node, transform: OutTransform | null) {
    const scale = transform?.outScale ?? 1;
    const positions = transform?.outPositions;
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
        // 死亡动画播完停最后一帧：不解除攻击锁、也不续播当前动作
        if (this.dead) return;
        if (name.includes("attack")) this.onAttackFinished();
        /** 播放完成后更换当前最新动画 */
        animate.play(getAnimationName(this.action, this.direction));
      },
      this,
    );
    return animate;
  }
}
