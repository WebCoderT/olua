import { Animation, isValid, Node, Rect, RigidBody2D, Vec2, Vec3 } from "cc";
import { monsterAI } from "../../configs/monster";
import { getAnimationName } from "../../configs/animation";
import { ACTION, DIRECTION } from "../../types/animation";
import { Monster, MonsterAIState } from "../../types/monster";
import { applyHitDamage, getDirectionByVector, getDirectionToTarget } from "../utils/battle/BattleMath";
import { getWorldColliderRect, resolveBlockedVelocity } from "../utils/physics/MoveBlocking";
import GameUiHelper from "../helpers/GameUiHelper";
import StorageManager from "./StorageManager";

/** 怪物身体内的动画节点名（由 GameUiHelper.createMonsterBody 创建） */
const MONSTER_ANIMATION_NODE = "monster_animation";

/** 一次性动作：播完即回待机，不做续播（被击退时播的受伤动作就属于这种） */
const ONCE_ACTIONS: ACTION[] = [ACTION.INJURED];

/**
 * 怪物 AI（静态类）
 * 每帧驱动场上怪物的行为与动画，由组合根在 Game.update 中调用：
 * - 待机：停在原地，不定时更换动作（动作与朝向都随机），并偶尔朝随机方向小走一段
 * - 追击：主动攻击（aggressive）的怪物发现玩家进入检测范围（detectRange）后朝玩家移动；
 *   被动怪被玩家打伤后同样进入追击（激怒，见 provoke），追击范围与主动怪一致
 * - 普攻：追到普攻距离站定出手（怪物只会普攻，没有技能），动作播完结算伤害
 * - 击退：被技能推动（push）期间按击退速度位移，普攻被打断
 * 玩家离开检测范围即停在原地（停留点成为原地随机走动的活动中心），不会返回出生点
 * 怪物不会推动角色、角色也推不动怪物（碰撞盒是传感器，见 addMonsterCollider），
 * 双方"不可穿越"由角色侧移动预测保证（见 MoveBlocking），击退是唯一能推动位置的途径
 * 每个怪物的状态按节点存在本类的状态表里（弱引用，节点销毁自动回收），怪物数据上不挂额外字段
 * 节奏参数在 configs/monster 的 monsterAI；追击是直线趋近，不做寻路（绕障碍以后再考虑）
 */
export default class MonsterAI {
  /** 每个怪物一份的 AI 运行时状态（键为怪物节点） */
  private static states = new WeakMap<Node, MonsterAIState>();

  /**
   * 每帧驱动场上怪物的行为
   * @param monsters 场上怪物（节点 -> 怪物数据，见 MonsterManager.getMonsterMap）
   * @param player 玩家节点（取坐标与飘字用；场上没有玩家时传 null）
   */
  static tick(monsters: Map<Node, Monster>, player: Node | null = null) {
    const target = player && isValid(player) ? player : null;
    monsters.forEach((monster, node) => this.tickMonster(node, monster, target));
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

  /**
   * 激怒怪物（由 MonsterManager 在怪物被玩家打伤时调用）
   * 被动攻击的怪物受伤后记恨：之后只要玩家进入检测范围（detectRange）就与主动怪一样追击普攻，
   * 玩家离开范围即停在原地——脱离后标记不清除，玩家再靠近会继续被追（与主动怪的发现/丢失节奏一致）
   */
  static provoke(node: Node) {
    if (!isValid(node)) return;
    this.getState(node).provoked = true;
  }

  //#region 单个怪物的行为

  /** 驱动一只怪物：先打完手上这一击，再按「是否发现玩家」决定追击还是待机 */
  private static tickMonster(node: Node, monster: Monster, player: Node | null) {
    if (!isValid(node) || monster.hp <= 0) return;
    const animate = this.getAnimate(node);
    if (!animate) return;
    const now = Date.now();
    const state = this.getState(node);
    // 被技能击退中：只走击退位移，期间不推进任何其他行为（普攻已在 push 里打断）
    if (now < state.pushEndAt) {
      this.pushStep(node, state, animate, now);
      return;
    }
    // 普攻动作播放中：站定把动作打完，伤害在动作播完后结算
    if (now < state.attackEndAt) {
      this.stopMoving(node);
      return;
    }
    if (state.attackPending) {
      state.attackPending = false;
      this.hitPlayer(node, monster, player);
    }
    // 感知玩家：主动怪常驻发现；被动怪被激怒后同样发现（其余情况一律待在原地）
    const distance = player ? this.getDistance(node, player) : Infinity;
    if ((monster.aggressive || state.provoked) && player && distance <= monster.detectRange) {
      // 追击期间停留点跟着走，玩家一离开范围就停在当前位置
      this.followAnchor(node, state, now);
      this.chase(node, monster, state, animate, player, distance);
      return;
    }
    this.stayIdle(node, monster, state, animate, now, player);
  }

  /**
   * 追击/击退期间都把停留点固定在当前位置，并把待机计时往后推
   * （脱离后先站一会儿再开始随机走动，而不是立刻接着走）
   */
  private static followAnchor(node: Node, state: MonsterAIState, now: number) {
    const position = node.getWorldPosition();
    state.anchor.set(position.x, position.y, position.z);
    state.idleMoveEndAt = 0;
    state.nextIdleAnimationAt = Math.max(state.nextIdleAnimationAt, now + monsterAI.idleAnimationInterval[0]);
    state.nextIdleMoveAt = Math.max(state.nextIdleMoveAt, now + monsterAI.idleMoveInterval[0]);
  }

  /** 追击：朝玩家逼近，进入普攻距离后站定出手 */
  private static chase(node: Node, monster: Monster, state: MonsterAIState, animate: Animation, player: Node, distance: number) {
    if (distance <= monsterAI.attackRange) {
      this.stopMoving(node);
      this.attackPlayer(node, monster, state, animate, player);
      return;
    }
    // 追击不做阻挡预测：普攻距离（attackRange）常常小于双方体积之和，
    // 一旦按体积挡住，大体积怪会停在普攻距离之外、永远打不到人（角色不会被推动，重叠本身无害）
    this.moveTowards(node, player.getWorldPosition(), monster.moveSpeed);
    this.playAction(animate, state, ACTION.WALK, getDirectionToTarget(player, node));
  }

  /**
   * 普攻玩家：按普攻间隔出手，面向玩家播放普攻动作，伤害在动作播完后结算
   * 攻击间隔未到时只站定不出手，玩家仍在追击范围内就继续贴着
   */
  private static attackPlayer(node: Node, monster: Monster, state: MonsterAIState, animate: Animation, player: Node) {
    const now = Date.now();
    if (now < state.nextAttackAt) return;
    state.nextAttackAt = now + monsterAI.attackInterval;
    state.attackEndAt = now + monsterAI.attackActionTime;
    state.attackPending = true;
    this.playAction(animate, state, ACTION.ATTACK_NEAR, getDirectionToTarget(player, node));
  }

  /**
   * 结算一次普攻
   * 伤害走与角色打怪同一套公式（BattleMath），玩家在挥击期间跑出普攻距离则落空；
   * 扣血后保存角色数据并刷新角色UI（血球/信息栏）
   */
  private static hitPlayer(node: Node, monster: Monster, player: Node | null) {
    if (!player || !isValid(player) || this.getDistance(node, player) > monsterAI.attackRange) return;
    const role = StorageManager.findOnlineRole();
    if (!role || role.hp <= 0) return;
    const damage = applyHitDamage(role, monster);
    GameUiHelper.showDamageText(player, damage);
    StorageManager.updateOnlineRole(role);
    StorageManager.updateUi(role);
  }

  /** 待在原地：站定 + 不定时换动作 + 偶尔小走一下 */
  private static stayIdle(node: Node, monster: Monster, state: MonsterAIState, animate: Animation, now: number, player: Node | null) {
    // 正在随机走动：保持走路速度与走路动画，走完这一段
    if (now < state.idleMoveEndAt) {
      this.wanderStep(node, monster, state, animate, player);
      return;
    }
    // 没在走动：站定
    this.stopMoving(node);
    // 不定时换一个动作（动作与朝向都随机），让怪物待在原地也是有动静的
    if (now >= state.nextIdleAnimationAt) {
      state.nextIdleAnimationAt = now + this.randomBetween(monsterAI.idleAnimationInterval);
      this.playAction(animate, state, this.pickIdleAction(), this.randomDirection());
    }
    // 偶尔移动一下位置：朝随机方向走一小段时间（立刻走这一步，动画随之切到走路）
    if (now >= state.nextIdleMoveAt) {
      state.nextIdleMoveAt = now + this.randomBetween(monsterAI.idleMoveInterval);
      state.idleMoveEndAt = now + this.randomBetween(monsterAI.idleMoveDuration);
      state.idleMoveDirection = this.pickWanderDirection(node, state);
      this.wanderStep(node, monster, state, animate, player);
    }
  }

  /**
   * 走一步原地随机走动：按当前随机方向移动并保持走路动画
   * 待机游走会避开玩家（不踩到人身上）；追击不受此限制，否则大体积怪够不到普攻距离
   */
  private static wanderStep(node: Node, monster: Monster, state: MonsterAIState, animate: Animation, player: Node | null) {
    const playerRect = player ? getWorldColliderRect(player) : null;
    this.moveByDirection(node, state.idleMoveDirection, monster.moveSpeed * monsterAI.idleMoveSpeedScale, playerRect ? [playerRect] : []);
    this.playAction(animate, state, ACTION.WALK, getDirectionByVector(state.idleMoveDirection));
  }

  //#endregion

  //#region 移动

  /** 朝目标点移动（线速度驱动，与主角同一套做法） */
  private static moveTowards(node: Node, target: Vec3, speed: number) {
    const position = node.getWorldPosition();
    const offsetX = target.x - position.x;
    const offsetY = target.y - position.y;
    const distance = Math.hypot(offsetX, offsetY);
    if (distance <= 0.001) {
      this.stopMoving(node);
      return;
    }
    this.moveByDirection(node, new Vec2(offsetX / distance, offsetY / distance), speed);
  }

  /**
   * 按方向移动（direction 为单位向量，blockings 为需要避开的碰撞盒）
   * 速度驱动型移动统一走 resolveBlockedVelocity：撞上阻挡物只取消这一步，不挤开对方
   */
  private static moveByDirection(node: Node, direction: Vec2, speed: number, blockings: Rect[] = []) {
    const rigidBody = node.getComponent(RigidBody2D);
    if (!rigidBody) return;
    rigidBody.linearVelocity = resolveBlockedVelocity(node, new Vec2(direction.x * speed, direction.y * speed), blockings);
  }

  /** 停下（速度清零） */
  private static stopMoving(node: Node) {
    const rigidBody = node.getComponent(RigidBody2D);
    if (rigidBody) rigidBody.linearVelocity = Vec2.ZERO;
  }

  //#endregion

  //#region 击退（技能推动）

  /**
   * 击退怪物：场上唯一能推动位置的途径（技能配置 push 后由 SkillManager 调用）
   * 按「距离 / 时长」换算匀速位移，击退期间由 pushStep 接管移动，普攻被打断；
   * 击退中再次被击退直接覆盖（取最新一次的方向与速度）
   * @param node 怪物节点
   * @param direction 击退方向（世界坐标，无需归一化）
   * @param distance 击退距离（像素）
   * @param duration 击退时长（毫秒，缺省取 monsterAI.pushDuration）
   */
  static push(node: Node, direction: Vec2, distance: number, duration: number = monsterAI.pushDuration) {
    const length = Math.hypot(direction.x, direction.y);
    if (!isValid(node) || length <= 0 || distance <= 0 || duration <= 0) return;
    const state = this.getState(node);
    state.pushDirection = new Vec2(direction.x / length, direction.y / length);
    state.pushSpeed = distance / (duration / 1000);
    state.pushEndAt = Date.now() + duration;
    // 打断手上的普攻：被击退的怪不该一边被推一边把这一击打出去
    state.attackEndAt = 0;
    state.attackPending = false;
  }

  /** 击退位移：按击退速度移动并播放受伤动作，停留点跟着走（击退结束后在落点继续待机/追击） */
  private static pushStep(node: Node, state: MonsterAIState, animate: Animation, now: number) {
    this.followAnchor(node, state, now);
    this.moveByDirection(node, state.pushDirection, state.pushSpeed);
    this.playAction(animate, state, ACTION.INJURED, getDirectionByVector(state.pushDirection));
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

  //#region 状态与随机

  /** 取怪物的 AI 状态（首次调用时按出生位置初始化） */
  private static getState(node: Node): MonsterAIState {
    const existed = this.states.get(node);
    if (existed) return existed;
    const now = Date.now();
    const state: MonsterAIState = {
      /** 初始动作与 GameUiHelper.createMonsterBody 播的待机动画一致，避免开局多切一次动画 */
      action: ACTION.STAND,
      dead: false,
      provoked: false,
      direction: DIRECTION.DOWN,
      /** 初始停留点即出生位置 */
      anchor: node.getWorldPosition(),
      nextIdleAnimationAt: now + this.randomBetween(monsterAI.idleAnimationInterval),
      nextIdleMoveAt: now + this.randomBetween(monsterAI.idleMoveInterval),
      idleMoveEndAt: 0,
      idleMoveDirection: new Vec2(),
      attackEndAt: 0,
      nextAttackAt: 0,
      attackPending: false,
      pushEndAt: 0,
      pushDirection: new Vec2(),
      pushSpeed: 0,
    };
    this.states.set(node, state);
    return state;
  }

  /** 待机动作池里随机取一个动作（池为空时回退待机） */
  private static pickIdleAction(): ACTION {
    const actions = monsterAI.idleActions;
    if (!actions.length) return ACTION.STAND;
    return actions[Math.floor(Math.random() * actions.length)];
  }

  /**
   * 随机走动的方向：离停留点超过活动半径就往回走（避免越走越远），否则完全随机
   */
  private static pickWanderDirection(node: Node, state: MonsterAIState): Vec2 {
    const position = node.getWorldPosition();
    const offsetX = position.x - state.anchor.x;
    const offsetY = position.y - state.anchor.y;
    const distance = Math.hypot(offsetX, offsetY);
    if (distance > monsterAI.wanderRadius) return new Vec2(-offsetX / distance, -offsetY / distance);
    return this.randomUnitVector();
  }

  /** 随机单位向量 */
  private static randomUnitVector(): Vec2 {
    const angle = Math.random() * Math.PI * 2;
    return new Vec2(Math.cos(angle), Math.sin(angle));
  }

  /** 随机一个朝向（八方向） */
  private static randomDirection(): DIRECTION {
    return getDirectionByVector(this.randomUnitVector());
  }

  /** 取区间内的随机值（毫秒间隔用） */
  private static randomBetween(range: [number, number]): number {
    return range[0] + Math.random() * (range[1] - range[0]);
  }

  /** 两个节点的间距（像素） */
  private static getDistance(from: Node, to: Node): number {
    const fromPosition = from.getWorldPosition();
    const toPosition = to.getWorldPosition();
    return Math.hypot(toPosition.x - fromPosition.x, toPosition.y - fromPosition.y);
  }

  //#endregion
}
