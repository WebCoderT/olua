import { Animation, isValid, Node, RigidBody2D, Vec2 } from "cc";
import { getAnimationName } from "../../configs/animation";
import { ACTION, DIRECTION } from "../../types/animation";
import { Monster, MonsterAIState } from "../../types/monster";
import { getDirectionByVector } from "../utils/battle/BattleMath";

/** 怪物身体内的动画节点名（由 GameUiHelper.createMonsterBody 创建） */
const MONSTER_ANIMATION_NODE = "monster_animation";

/** 一次性动作：播完即回待机，不做续播（受伤动作就属于这种） */
const ONCE_ACTIONS: ACTION[] = [ACTION.INJURED];

/**
 * 与服务端位置差距较大时的追赶时长（秒）：差距 / 这个秒数 = 最低追赶速度
 *
 * 正常跟随时用怪物自己的 moveSpeed（与服务端同速，不会忽快忽慢）；只有差距大到
 * 一个广播周期（200ms）追不回来时才加快 —— 典型场景是技能击退的 120px 位移。
 */
const SERVER_CATCHUP_SECONDS = 0.2;

/**
 * 怪物表现层（静态类）—— **客户端不跑任何怪物行为**
 *
 * ===========================================================================
 * 为什么这里没有 AI
 * ===========================================================================
 * #670 起怪物的目标选择、待机游走、追击、普攻、技能释放**全部在服务端**
 * （`server/src/modules/realtime/monster-ai.service.ts`），客户端只做两件事：
 * 1. 把节点朝服务端给的最新坐标**同速趋近**（`stepServer`，滞后约一个广播周期）；
 * 2. 按事件播动作（`playServerAction`：普攻命中 → 攻击动作、技能释放 → 技能动作）。
 *
 * 之前这里并存一套本地 AI（待机游走 / 追击 / 普攻 / 击退 / 激怒），只在「实时通道没连上」
 * 时跑。代价是同图两个客户端各跑一套随机行为：A 屏幕上怪在东边打人，B 屏幕上同一只怪在
 * 西边遛弯 —— 而双方的血量又都是服务端权威，看起来像「怪在远程打人」。现在只有一条路：
 * 服务端说它在哪、在干什么，客户端照演。
 *
 * 由此**刻意不做**的（想做就得先让服务端知道）：
 * - 抛下本地动画随机（待机时随机换动作 / 朝随机方向小走）—— 那会让同一只怪在两个人屏幕上
 *   动得不一样；待机表现改为「服务端说停就站定」，游走本身由服务端模拟并广播；
 * - 击退位移：服务端模拟（结算侧 `MonsterAiService.applyPush`），落点照常走位置广播，
 *   客户端只负责趋近（追赶速度见 stepServer）—— 本地自己推一下，别人的屏幕上怪根本不动；
 * - 玩家侧伤害结算：怪打人的伤害由服务端算（`hits` 帧），客户端不再有 `hitPlayer`。
 *
 * 每个怪物的状态按节点存在本类的状态表里（弱引用，节点销毁自动回收），怪物数据上不挂额外字段
 */
export default class MonsterAI {
  /** 每个怪物一份的表现状态（键为怪物节点） */
  private static states = new WeakMap<Node, MonsterAIState>();

  /**
   * 每帧驱动场上怪物的表现（位置趋近 + 走路/待机切换）
   * @param monsters 场上怪物（节点 -> 怪物数据，见 MonsterManager.getMonsterMap）
   */
  static tick(monsters: Map<Node, Monster>) {
    monsters.forEach((monster, node) => this.stepServer(node, monster));
  }

  /**
   * 记录一次服务端权威位置（#323：由 MonsterManager 收到 monster-ai 帧后调用）
   * 首次收到直接吸附（服务端可能已经模拟了一段），之后由 stepServer 按帧趋近
   */
  static applyServerState(node: Node, x: number, y: number, moving: boolean) {
    if (!isValid(node)) return;
    const state = this.getState(node);
    if (state.serverX === null) {
      const position = node.getWorldPosition();
      node.setWorldPosition(x, y, position.z);
    }
    state.serverX = x;
    state.serverY = y;
    state.serverMoving = moving;
  }

  /**
   * 服务端权威下的一帧演出：向服务端最新位置趋近（同速追赶，滞后约一个广播周期），
   * 按「服务端移动标记 + 是否还有距离」播走路 / 待机；朝向由位移差量自算。
   * 本地不跑任何行为决策（追击 / 普攻都在服务端），出手动作由事件驱动（MonsterManager）。
   */
  private static stepServer(node: Node, monster: Monster) {
    if (!isValid(node) || monster.hp <= 0) return;
    const state = this.states.get(node);
    if (!state || state.serverX === null) return; // 还没收到服务端位置：原地站着等第一帧
    const animate = this.getAnimate(node);
    if (!animate) return;
    const now = Date.now();
    const position = node.getWorldPosition();
    const offsetX = state.serverX - position.x;
    const offsetY = state.serverY - position.y;
    const distance = Math.hypot(offsetX, offsetY);
    if (distance > 0.05) {
      // 与服务端同一速度追赶（moveSpeed 像素/秒），步长按真实帧间隔算。
      // 差距大时（击退 / 网络抖一下迟了半秒）按「一个广播周期内追上」加快 —— 只按 moveSpeed
      // 走的话，一次 120px 的击退要拖一秒多才补齐，看起来像慢动作回放
      const dt = Math.min(0.5, Math.max(0, (now - state.serverStepAt) / 1000));
      const speed = Math.max(monster.moveSpeed, distance / SERVER_CATCHUP_SECONDS);
      const step = Math.min(distance, speed * dt);
      node.setWorldPosition(position.x + (offsetX / distance) * step, position.y + (offsetY / distance) * step, position.z);
      this.playAction(animate, state, ACTION.WALK, getDirectionByVector(new Vec2(offsetX, offsetY)));
    } else if (!state.serverMoving) {
      this.stopMoving(node);
      this.playAction(animate, state, ACTION.STAND, state.direction);
    }
    state.serverStepAt = now;
  }

  /**
   * 播一次服务端驱动的动作（#372：由 MonsterManager 收到 casts / hits 后调用）
   *
   * 服务端权威模式下怪物的行为不在本地决策，动作只能由事件驱动：
   * 普攻命中 → attack_near；释放技能 → 技能配置的 action。
   * 半销毁节点、已死亡的怪、还没装载动画的怪一律静默跳过 —— 这是最常见的崩点。
   */
  static playServerAction(node: Node, action: ACTION, direction?: DIRECTION) {
    if (!isValid(node)) return;
    const animate = this.getAnimate(node);
    if (!animate) return;
    const state = this.states.get(node);
    if (!state || state.dead) return;
    this.playAction(animate, state, action, direction ?? state.direction);
  }

  /**
   * 动画播完续播当前动作（由怪物动画节点的 FINISHED 事件触发）
   * 怪物当前动作由本类维护，因此续播也在这里做，否则动作播完会停在最后一帧不再动；
   * 一次性动作（受伤）播完不续播，直接切回待机
   */
  static replayCurrent(node: Node) {
    const animate = this.getAnimate(node);
    if (!animate) return;
    const state = this.states.get(node);
    // 死亡动画播完不续播：节点由 MonsterManager 在死亡动画的 FINISHED 里移除
    if (state?.dead) return;
    const action = state?.action ?? ACTION.STAND;
    const direction = state?.direction ?? DIRECTION.DOWN;
    if (state && ONCE_ACTIONS.indexOf(action) >= 0) {
      state.action = ACTION.STAND;
      const standName = getAnimationName(ACTION.STAND, direction);
      if (animate.getState(standName)) animate.play(standName);
      return;
    }
    const name = getAnimationName(action, direction);
    if (animate.getState(name)) animate.play(name);
  }

  /**
   * 播放死亡动画（由 MonsterManager 在怪物血量归零时调用）
   * 停住位移，按当前朝向播放死亡动作；播完即移除节点（怪物死亡后不再消失于下一帧，而是等动画播完）
   * 死亡期间 dead 标记会拦住「播完续播」（replayCurrent），动画停帧后节点随即被销毁
   * @returns 是否已开始播放死亡动画（没有动画组件或缺死亡帧资源时返回 false，调用方直接移除节点）
   */
  static die(node: Node): boolean {
    const animate = this.getAnimate(node);
    if (!animate) return false;
    const state = this.getState(node);
    state.dead = true;
    this.stopMoving(node);
    const name = getAnimationName(ACTION.DIE, state.direction);
    if (!animate.getState(name)) return false;
    // 死亡动画播完移除节点（createMonsterNode 注册的续播监听会被 dead 标记拦住，不会把死亡动画重播）
    animate.once(Animation.EventType.FINISHED, () => {
      if (isValid(node)) node.destroy();
    }, node);
    animate.play(name);
    return true;
  }

  //#region 移动

  /** 停下（速度清零；表现层唯一的位移来源是 setWorldPosition，这里只兜住残留速度） */
  private static stopMoving(node: Node) {
    const rigidBody = node.getComponent(RigidBody2D);
    if (rigidBody) rigidBody.linearVelocity = Vec2.ZERO;
  }

  //#endregion

  //#region 动作动画

  /**
   * 播放怪物动作
   * 只有动作或朝向变了才切换（每帧重启动画会永远停在第一帧）；
   * 该动作/朝向没有帧资源时回退待机（如 attack_near 只有部分方向），保证怪物身上一直有动画在播
   */
  private static playAction(animate: Animation, state: MonsterAIState, action: ACTION, direction: DIRECTION) {
    const resolvedAction = animate.getState(getAnimationName(action, direction)) ? action : ACTION.STAND;
    if (state.action === resolvedAction && state.direction === direction) return;
    state.action = resolvedAction;
    state.direction = direction;
    animate.crossFade(getAnimationName(resolvedAction, direction), 0.2);
  }

  /** 取怪物身体里的动画组件（由 GameUiHelper.createMonsterBody 创建） */
  private static getAnimate(node: Node) {
    return node.getChildByName(MONSTER_ANIMATION_NODE)?.getComponent(Animation) ?? null;
  }

  //#endregion

  //#region 状态

  /** 取怪物的表现状态（首次调用时初始化） */
  private static getState(node: Node): MonsterAIState {
    const existed = this.states.get(node);
    if (existed) return existed;
    const state: MonsterAIState = {
      /** 初始动作与 GameUiHelper.createMonsterBody 播的待机动画一致，避免开局多切一次动画 */
      action: ACTION.STAND,
      dead: false,
      direction: DIRECTION.DOWN,
      serverX: null,
      serverY: 0,
      serverMoving: false,
      serverStepAt: Date.now(),
    };
    this.states.set(node, state);
    return state;
  }

  //#endregion
}
