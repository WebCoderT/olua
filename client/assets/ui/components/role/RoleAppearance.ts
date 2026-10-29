import { Animation, Node, Vec2 } from "cc";
import { OutTransform } from "../../../types/good";
import { ACTION, DIRECTION, SpeedRate } from "../../../types/animation";
import { SEX } from "../../../types/role";
import { actionNeedWeapon, getAnimationName, getDirectionIndex } from "../../../configs/animation";
import { getEquipment } from "../../../configs/items";
import { getFashionOut } from "../../../configs/fashionClothes";
import { getRoleDefaultCloth } from "../../../configs/role";
import GameUiHelper from "../../helpers/GameUiHelper";
import { EQUIP_ALIGN, placeWeaponOnHand } from "../../../configs/equipAlign";

/** 这些朝向下衣服在武器上方（武器在身后）：左 / 左上 / 上 / 左下；其余朝向武器在衣服上方 */
const CLOTH_ON_TOP_DIRECTIONS: DIRECTION[] = [DIRECTION.LEFT, DIRECTION.LEFT_UP, DIRECTION.UP, DIRECTION.LEFT_DOWN];

/**
 * 武器握持点：面向哪些朝向时武器在观众**左侧**
 *
 * 角色右手持械 —— 面向观众（down）时右手在观众左边；转身背对（up）时换到右边。
 * 左右斜向跟各自的主朝向一致，右向的两个朝向右、左向的两个朝向左。
 */
const WEAPON_ON_LEFT: DIRECTION[] = [DIRECTION.DOWN, DIRECTION.LEFT, DIRECTION.LEFT_DOWN, DIRECTION.LEFT_UP];



/**
 * 装配一套角色外观所需的最小数据（#383）
 *
 * 主角（entities/Role，字段齐全）与远端玩家（互见帧只给这几样）都满足它 —— 于是
 * 「时装 > 装备衣服 > 性别默认身体」的取源优先级、几何变换、衣服/武器层级只在
 * 这一份代码里，不存在「主角一套、别人一套」的漂移。
 */
export type RoleOutSource = {
  /** 性别：决定没穿衣服时用哪套默认身体（未知值回落男性，见 configs/role.getRoleDefaultCloth） */
  sex: SEX;
  /** 已穿戴的衣服 / 武器（槽位只存装备 id，null = 没穿） */
  equipments: { cloth: string | null; weapon: string | null };
  /** 时装 id（null = 没穿；只换外观不换数值） */
  fashionCloth: string | null;
  /** 动作速度倍率（决定每帧时长；远端玩家取默认值） */
  speedRate: SpeedRate;
};

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
  /**
   * 武器对齐的重试计数（素材是异步装上去的：首帧还没落到 Sprite 上时读不到内容 bbox，
   * 这时候不能拿 (0,0) 硬算，否则武器会先出现在脚底再跳上去）
   */
  private alignRetry = 0;

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
  updateOutShow(source: RoleOutSource, action: ACTION, direction: DIRECTION) {
    this.action = action;
    this.direction = direction;
    this.reloadClothAnimation(source);
    this.reloadWeaponAnimation(source);
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
    this.applyWeaponTransform();
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
    this.applyWeaponTransform();
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
   * 播放一次性受击动作（由宿主在玩家被普攻命中时调用，见 RoleDisplay.playInjured）
   *
   * **不改变** this.action / this.direction：受击动画播完由 loadAnimation 注册的 FINISHED 续播
   * 自动把画面带回到当前动作（受击 clip 不含 "attack"，不会触发攻击锁回调），
   * 宿主的动作状态机全程无感 —— 走路/待机不被打断，施法/死亡由宿主的守卫拦在外面进不来；
   * 已在受击动画中时不重启（连环挨打不至于抖成筛子）；外观没有受击帧（缺段）时静默跳过
   */
  playInjured(direction: DIRECTION) {
    if (this.dead) return;
    const animationName = getAnimationName(ACTION.INJURED, direction);
    if (!this.clothAnimate) return;
    const state = this.clothAnimate.getState(animationName);
    if (!state) return;
    if (state.isPlaying) return;
    this.clothAnimate.crossFade(animationName, 0.1);
    this.weaponAnimate?.crossFade(animationName, 0.1);
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
  private reloadClothAnimation(source: RoleOutSource) {
    const cloth = getEquipment(source.equipments.cloth);
    // 未穿衣服时按性别取默认身体（男 role/1、女 role/2），外观变换与穿衣服同口径
    const fallback = getRoleDefaultCloth(source.sex);
    // 取源：时装 > 装备衣服 > 默认身体（#377）。**只有外观帧目录被换掉** ——
    // 缩放/偏移仍按装备（或默认身体）那套几何，所以穿时装不会把角色挪位
    const src = getFashionOut(source.fashionCloth) || cloth?.out || fallback.out;
    this.clothTransform = cloth ?? fallback;
    if (src === this.clothSrc) return;
    this.clothSrc = src;
    this.clothAnimate = this.loadAnimation(this.cloth, src, source);
  }

  /** 重新加载武器动画：未装备武器或该武器没有外观时不加载（武器节点整节点隐藏） */
  private reloadWeaponAnimation(source: RoleOutSource) {
    const weapon = getEquipment(source.equipments.weapon);
    const src = weapon?.out ?? "";
    this.weaponTransform = weapon;
    if (src === this.weaponSrc) return;
    this.weaponSrc = src;
    this.weaponAnimate = src ? this.loadAnimation(this.weapon, src, source) : null;
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

  /**
   * 武器位置：贴到「当前身体帧」的握持点
   *
   * 为什么不直接用手调的 outPositions：素材的裁剪留白与画布尺寸每件都不一样（武器画布 245×234 ~ 570×608，
   * 身体 142×112 ~ 480×480），写死的偏移只对作者当初那件身体成立 —— 换一件衣服武器就飘走。
   * 这里改成读**当前帧的内容 bbox**（裁剪偏移已由 SpriteFrame.offset 还原）：
   *   手部锚点 = 身体内容 bbox 的侧边 × 0.52、纵向 52%（角色右手）
   *   武器位置 = 手部锚点 − 武器内容中心的缩放偏移
   * 于是任何身体尺寸、任何武器都自动对齐。outPositions 保留为**微调**（默认 0，逐件微调不碰公式）。
   * 素材未就绪（帧还没落到 Sprite 上）时保持不动 —— 下一帧的 play 会再算一次。
   *
   * **`outManual` 为 true 时整段跳过**（#509）：那件武器是在管理端「装备对齐」工作台里、
   * 以裸模为基准逐方向手调过的绝对值，再叠一层自动算法只会把人的判断改掉。
   */
  private applyWeaponTransform() {
    // 手调过的武器与衣服同一套摆法（缩放 + 8 方向绝对位置），差异只在数据来源
    if (this.weaponTransform?.outManual) {
      this.applyOutTransform(this.weapon, this.weaponTransform);
      return;
    }
    const weaponBox = GameUiHelper.spriteContentBox(this.weapon);
    const clothBox = GameUiHelper.spriteContentBox(this.cloth);
    const scale = this.weaponTransform?.outScale ?? 1;
    this.weapon.setScale(scale, scale, 1);
    if (!weaponBox || !clothBox) {
      this.retryAlign();
      return;
    }
    this.alignRetry = 0;
    // 身体内容 bbox（宿主坐标系：衣服节点自身带着它的 outPositions，且可能带 outScale）
    const clothPos = this.cloth.position;
    const clothScale = this.cloth.scale.x;
    const body = {
      cx: clothPos.x + clothBox.cx * clothScale,
      cy: clothPos.y + clothBox.cy * clothScale,
      w: clothBox.w * clothScale,
      h: clothBox.h * clothScale,
    };
    // 逐件微调（outPositions 按方向下标；缺省 0）
    const nudge = this.weaponTransform?.outPositions?.[getDirectionIndex(this.direction)] ?? Vec2.ZERO;
    const pos = placeWeaponOnHand(body, weaponBox, scale, nudge, WEAPON_ON_LEFT.indexOf(this.direction) !== -1);
    this.weapon.setPosition(pos.x, pos.y, 0);
  }

  /** 素材未就绪：下一帧再算一次（上限与间隔见 configs/equipAlign.EQUIP_ALIGN，避免素材真的缺帧时无限重排） */
  private retryAlign() {
    if (this.alignRetry >= EQUIP_ALIGN.alignRetryTimes) return;
    this.alignRetry += 1;
    setTimeout(() => this.applyWeaponTransform(), EQUIP_ALIGN.alignRetryDelayMs);
  }

  /** 装载一个外观节点的动画（重复调用时先清掉上一次注册的完成监听，避免重复回调） */
  private loadAnimation(node: Node, src: string, source: RoleOutSource) {
    const animate = GameUiHelper.useRoleAnimation(getAnimationName(this.action, this.direction), node, src, source.speedRate);
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
