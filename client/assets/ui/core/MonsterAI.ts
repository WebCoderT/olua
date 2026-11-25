import { Animation, isValid, Node, RigidBody2D, Vec2 } from "cc";
import { actionFinishTimeoutMarginSeconds, getAnimationName } from "../../configs/animation";
import { networkConfig } from "../../configs/network";
import { ACTION, DIRECTION } from "../../types/animation";
import { Monster, MonsterAIState } from "../../types/monster";
import { getDirectionByVector } from "../utils/battle/BattleMath";
import ServerClock from "../utils/net/ServerClock";
import SnapshotInterpolator from "./SnapshotInterpolator";

/** 怪物身体内的动画节点名（由 GameUiHelper.createMonsterBody 创建） */
const MONSTER_ANIMATION_NODE = "monster_animation";

/** 一次性动作：播完即回待机，不做续播（受伤动作就属于这种） */
const ONCE_ACTIONS: ACTION[] = [ACTION.INJURED];

/** 循环动作：事件驱动上锁时跳过它们——循环片段没有 FINISHED，锁上去只能等超时解锁 */
const LOOP_ACTIONS: ACTION[] = [ACTION.STAND, ACTION.WALK, ACTION.RUN];

/**
 * 怪物表现层（静态类）—— **客户端不跑任何怪物行为**
 *
 * ===========================================================================
 * 为什么这里没有 AI
 * ===========================================================================
 * #670 起怪物的目标选择、待机游走、追击、普攻、技能释放**全部在服务端**
 * （`server/src/modules/realtime/monster-ai.service.ts`），客户端只做两件事：
 * 1. 按服务端时间回放位置快照（`stepServer` + `SnapshotInterpolator`，#769：匀速、抗丢帧，
 *    不再「朝目标点同速趋近」那种带残差的追赶）；
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
 *   客户端只负责回放（快照之间是匀速插值，击退在别人屏幕上也是同一段位移，见 stepServer）；
 * - 玩家侧伤害结算：怪打人的伤害由服务端算（`hits` 帧），客户端不再有 `hitPlayer`。
 *
 * 每个怪物的状态按节点存在本类的状态表里（弱引用，节点销毁自动回收），怪物数据上不挂额外字段
 */
export default class MonsterAI {
  /** 每个怪物一份的表现状态（键为怪物节点） */
  private static states = new WeakMap<Node, MonsterAIState>();

  /**
   * 每个怪物的位置快照缓冲（#769；键为怪物节点）
   *
   * 与玩家侧**同一个插值器**（`SnapshotInterpolator`）：怪物只是「谁在驱动它」不同，
   * 「怎么把一串坐标变成动画」没有任何理由写第二份 —— 两份逻辑迟早漂移成两套手感。
   * 状态放在 WeakMap 里而不是 MonsterAIState 上：那个类型在 `types/`，不该反向依赖 ui/core。
   */
  private static positions = new WeakMap<Node, SnapshotInterpolator>();

  /**
   * 每帧驱动场上怪物的表现（位置趋近 + 走路/待机切换）
   * @param monsters 场上怪物（节点 -> 怪物数据，见 MonsterManager.getMonsterMap）
   */
  static tick(monsters: Map<Node, Monster>) {
    monsters.forEach((monster, node) => this.stepServer(node, monster));
  }

  /**
   * 记录一次服务端权威位置（#323：由 MonsterManager 收到 monster-ai 帧后调用）
   *
   * #769 起不再「记一个目标点让 stepServer 追」：这里只把带时间戳的快照压进缓冲，
   * 回放由 stepServer 按服务端时间做。第一条快照仍然**直接吸附**（服务端可能已经模拟了
   * 一段，位置离出生点很远），之后的位移全部交给插值。
   *
   * @param t 这一帧的服务端时刻（帧级 `t`；缺省取服务端此刻 —— 进视野那条路不带时间戳）
   */
  static applyServerState(node: Node, x: number, y: number, moving: boolean, t: number = ServerClock.now()) {
    if (!isValid(node)) return;
    let positions = this.positions.get(node);
    if (!positions) {
      positions = new SnapshotInterpolator(
        networkConfig.realtime.interpolation.bufferSize,
        networkConfig.realtime.interpolation.maxExtrapolate,
      );
      this.positions.set(node, positions);
      const position = node.getWorldPosition();
      node.setWorldPosition(x, y, position.z);
    }
    positions.push(t, x, y, moving);
  }

  /**
   * 服务端权威下的一帧演出：按**服务端时间**回放快照（匀速、抗丢帧），
   * 按「服务端移动标记 + 位移」播走路 / 待机；朝向由这一帧的实际位移自算。
   * 本地不跑任何行为决策（追击 / 普攻都在服务端），出手动作由事件驱动（MonsterManager）。
   */
  private static stepServer(node: Node, monster: Monster) {
    if (!isValid(node) || monster.hp <= 0) return;
    const positions = this.positions.get(node);
    if (!positions) return; // 还没收到服务端位置：原地站着等第一帧
    const animate = this.getAnimate(node);
    if (!animate) return;
    const sampled = positions.sample(ServerClock.renderTime(networkConfig.realtime.interpolation.renderDelay));
    if (!sampled) return;
    const state = this.getState(node);
    const position = node.getWorldPosition();
    const offsetX = sampled.x - position.x;
    const offsetY = sampled.y - position.y;
    if (offsetX !== 0 || offsetY !== 0) node.setWorldPosition(sampled.x, sampled.y, position.z);
    if (sampled.moving) {
      // 服务端说在移动：动作锁立即失效（服务端出手前必先站定，移动中的怪不可能在出招），
      // 否则走路段起播前还得白等一段锁时间
      state.locked = false;
      // 「在移动」但没有位移（刚起步 / 一帧内没推进）：保持上一次朝向，别拿零向量算方向
      const direction = Math.abs(offsetX) + Math.abs(offsetY) > 0.5 ? getDirectionByVector(new Vec2(offsetX, offsetY)) : state.direction;
      this.playAction(animate, state, ACTION.WALK, direction);
    } else {
      this.stopMoving(node);
      // 事件动作（普攻/施法）播放期间不覆盖：#1240 —— 站定分支每帧都到，
      // 不加锁的话攻击起播后下一帧就被 crossFade(stand) 打断，只能看到 0.2 秒的半截混合。
      // 超时兜底见 playServerAction（FINISHED 丢失时也会解锁，不会永久卡死在攻击态）
      if (state.locked) {
        if (Date.now() < state.lockExpireAt) return;
        state.locked = false;
      }
      this.playAction(animate, state, ACTION.STAND, state.direction);
    }
  }

  /**
   * 播一次服务端驱动的动作（#372：由 MonsterManager 收到 casts / hits 后调用）
   *
   * 服务端权威模式下怪物的行为不在本地决策，动作只能由事件驱动：
   * 普攻命中 → attack_near；释放技能 → 技能配置的 action。
   * 半销毁节点、已死亡的怪、还没装载动画的怪一律静默跳过 —— 这是最常见的崩点。
   *
   * #1240 动作锁：非循环动作（普攻/施法这类一次性演出）起播后上锁，
   * 锁到「片段时长 + actionFinishTimeoutMarginSeconds」——期间 stepServer 的站定分支
   * 不许把它覆盖回待机（角色侧 RoleDisplay.startAttack 同款守点，超时兜底防 FINISHED 丢失）。
   * 片段不存在（素材缺，如怪物包没有攻击帧）时 playAction 回退待机，不上锁 —— 观感与缺帧现状一致。
   */
  static playServerAction(node: Node, action: ACTION, direction?: DIRECTION) {
    if (!isValid(node)) return;
    const animate = this.getAnimate(node);
    if (!animate) return;
    const state = this.getState(node);
    if (state.dead) return;
    const resolved = this.playAction(animate, state, action, direction ?? state.direction);
    if (resolved && LOOP_ACTIONS.indexOf(resolved) < 0) {
      // 只给「真的在播非循环片段」的动作上锁
      const clip = animate.getState(getAnimationName(resolved, state.direction));
      const duration = (clip?.duration ?? 0) + actionFinishTimeoutMarginSeconds;
      state.locked = true;
      state.lockExpireAt = Date.now() + duration * 1000;
    } else {
      // 回退待机 / 落在循环动作上：旧锁一并清掉（循环片段没有 FINISHED，靠超时解锁太慢）
      state.locked = false;
    }
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
    // 动作锁（#1240）：事件动作（普攻/施法）播完 → 解锁并切回待机。
    // 这类动作不该像待机那样循环重播（重播会一直卡在攻击态），stepServer 下一帧会接手站定表现
    if (state?.locked) {
      state.locked = false;
      state.action = ACTION.STAND;
      const standName = getAnimationName(ACTION.STAND, state.direction);
      if (animate.getState(standName)) animate.play(standName);
      return;
    }
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
   * @returns 实际生效的动作（含缺帧回退成 STAND 的那一种；调用方据此决定是否上动作锁）
   */
  private static playAction(animate: Animation, state: MonsterAIState, action: ACTION, direction: DIRECTION): ACTION {
    const resolvedAction = animate.getState(getAnimationName(action, direction)) ? action : ACTION.STAND;
    if (state.action === resolvedAction && state.direction === direction) return resolvedAction;
    state.action = resolvedAction;
    state.direction = direction;
    animate.crossFade(getAnimationName(resolvedAction, direction), 0.2);
    return resolvedAction;
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
      locked: false,
      lockExpireAt: 0,
    };
    this.states.set(node, state);
    return state;
  }

  //#endregion
}
