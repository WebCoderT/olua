import { isValid, Node, Rect, Vec2, Vec3 } from "cc";
import { autoBattle } from "../../configs/autoBattle";
import { ROLE_RUN_SPEED, ROLE_WALK_SPEED } from "../../configs/role";
import { maps } from "../../configs/game-config";
import { skills } from "../../configs/skill";
import { SkillId, SkillTargetType } from "../../types/skill";
import type RoleDisplay from "../components/role/RoleDisplay";
import { canAttackTarget } from "../utils/battle/BattleMath";
import { getMapWorldRect } from "../utils/map/MapPointMath";
import PathGrid, { type PolyPoint } from "../utils/map/PathGrid";
import GameUiHelper from "../helpers/GameUiHelper";
import MonsterManager from "./MonsterManager";
import SkillManager from "./SkillManager";
import CombatChannel from "../utils/net/CombatChannel";

/**
 * 自动战斗（静态类）
 * 「快速攻击」与「自动挂机」共用一套「选目标 → A* 走位接近 → 范围内出手」的循环，
 * 由组合根在 Game.update 每帧调用 tick（键盘移动输入优先于自动移动，作为参数传入）：
 * - 快速攻击：释放 canAuto 技能时没有可打目标/目标超出距离，由 SkillManager 委托本类
 *   自动选取最近的怪物并走位到技能范围内连续出手，直到玩家手动移动（键盘/鼠标操控）或目标死亡
 * - 自动挂机：挂机按钮开启后自动选取最近怪物持续攻击，目标死亡换下一个无限重复；
 *   玩家手动移动期间整体暂停（由玩家接管），松开继续；开关状态跨地图保留
 * 走位用 A* 寻路（见 utils/map/PathGrid）绕开障碍：网格以当前地图为基准（GameMap 注册），
 * 静态障碍取 Tiled 碰撞区与 NPC 占位，动态障碍为场上怪物碰撞盒（目标自身除外），每次寻路前重烙；
 * 目标永远取「最近」，被判定无法接近的目标短暂拉黑后自动换下一个，避免卡死
 * 当前路线对外暴露给路线指示线（getRoutePoints，见 core/RouteIndicator 与 components/hud/SmallMap）
 */
export default class AutoBattle {
  /** 主角（组合根注册，场景卸载时 reset 清空） */
  private static roleDisplay: RoleDisplay | null = null;
  /** 当前地图节点（GameMap 注册，寻路网格的数据来源） */
  private static mapNode: Node | null = null;
  /** 当前地图 id（读服务端快照里的 NPC 点位用；与 `mapNode` 同时注册） */
  private static mapId = "";
  /** 寻路网格（按地图惰性构建，换图作废） */
  private static grid: PathGrid | null = null;
  /** 挂机开关 */
  private static hangEnabled = false;
  /** 快速攻击的技能（玩家按了 canAuto 技能但没有可打目标时记录，优先于挂机的默认技能） */
  private static pendingSkill: SkillId | null = null;
  /** 点击寻路的目标点（小地图弹窗下发；静态目标，走到即结束，玩家手动移动可打断） */
  private static pendingPoint: Vec2 | null = null;
  /** 交互寻路（NPC 点击走近交互）：走进该点周围 interactRadius 即视为到达并触发 interactArrive */
  private static interactNear: Vec2 | null = null;
  private static interactRadius = 0;
  private static interactArrive: (() => void) | null = null;
  /** 当前自动战斗目标 */
  private static target: Node | null = null;
  /** 无法接近目标的拉黑记录（节点 -> 解禁时间戳） */
  private static banned = new Map<Node, number>();
  /** 当前路径（世界坐标路点，不含起点） */
  private static path: Vec2[] = [];
  /** 正在走向的路点下标 */
  private static pathIndex = 0;
  /**
   * 展示路线缓存（#1352，经典走路模式）：把逐格路径用视线拉直成关键拐点，
   * `displayIndices` 是各拐点在 `path` 里的下标。只给指示线/小地图画线用，
   * 行走数据仍走逐格的 `path`。路径整体替换（本地重算 / 服务端回执）时重建。
   */
  private static displayRoute: Vec2[] = [];
  private static displayIndices: number[] = [];
  /** 上次重寻路时的目标格（#1352：追怪只在目标换格时重算，不按时间盲算） */
  private static lastTargetCell: { col: number; row: number } | null = null;
  /** 上次寻路时间戳 */
  private static lastRepathAt = 0;
  /**
   * 最近一次向服务端请求寻路的序号（#811；0 = 没在等）
   *
   * 回执带回的 `seq` 与它对不上就说明是**过期回执**（中间又重寻过路），直接丢 ——
   * 照过期路点走会把角色带回上一个目标的方向。
   */
  private static pendingPathSeq = 0;
  /** 卡住检测：上次检测时间/位置与连续卡住次数 */
  private static lastStuckCheckAt = 0;
  private static lastStuckX = 0;
  private static lastStuckY = 0;
  private static stuckCount = 0;
  /** 下次允许自动选目标的时间戳（无怪/目标刚失效时限频，避免每帧全图扫描） */
  private static nextTargetSearchAt = 0;
  /** 挂机状态变化回调（挂机按钮注册，同步图标显隐） */
  private static hangStateListener: ((enabled: boolean) => void) | null = null;

  /** 注册主角（组合根在创建主角后调用） */
  static setRoleDisplay(roleDisplay: RoleDisplay) {
    this.roleDisplay = roleDisplay;
  }

  /**
   * 注册当前地图（换图时由 GameMap 调用）：旧寻路网格作废，自动战斗目标清空（挂机开关保留）
   *
   * `mapId` 是给「NPC 当静态障碍」用的：点位在服务端快照里（#672），光有地图节点查不到
   * 这张图上的 NPC 在哪。
   */
  static setMap(map: Node, mapId: string) {
    this.mapNode = map;
    this.mapId = mapId;
    this.grid = null;
    this.path = [];
    this.pathIndex = 0;
    this.target = null;
    this.pendingSkill = null;
    this.pendingPoint = null;
  }

  /** 挂机是否开启 */
  static isHangEnabled(): boolean {
    return this.hangEnabled;
  }

  /** 注册挂机状态变化回调（挂机按钮用；传 null 注销） */
  static setHangStateListener(listener: ((enabled: boolean) => void) | null) {
    this.hangStateListener = listener;
  }

  /**
   * 开关自动挂机（挂机按钮调用）
   * 开启时校验存在已学习且可自动释放（canAuto）的技能，没有则提示且不开启
   */
  static setHangEnabled(enabled: boolean) {
    if (enabled === this.hangEnabled) return;
    if (enabled && !SkillManager.findAutoSkill()) {
      GameUiHelper.createTip("auto_battle_no_skill_tip");
      return;
    }
    this.hangEnabled = enabled;
    if (enabled) {
      // 挂机接管：清掉快速攻击的技能偏好与旧目标，下一 tick 自动选最近的怪物
      this.pendingSkill = null;
      this.target = null;
      GameUiHelper.createTip("auto_battle_on_tip");
    } else {
      this.cancel();
      GameUiHelper.createTip("auto_battle_off_tip");
    }
    this.hangStateListener?.(enabled);
  }

  /**
   * 请求一次自动战斗（快速攻击入口，由 SkillManager 在「canAuto 技能无可打目标/目标超出距离」时调用）
   * @param skillId 触发自动战斗的技能
   * @param target 手动选中的目标（null 时由本类自动选取最近的怪物）
   * @returns 是否进入自动战斗流程
   */
  static requestSkill(skillId: SkillId, target: Node | null): boolean {
    if (!this.roleDisplay || !isValid(this.roleDisplay)) return false;
    this.pendingSkill = skillId;
    if (target && isValid(target)) this.setTarget(target);
    return true;
  }

  /**
   * 请求自动寻路到指定世界坐标点（小地图弹窗左键点击调用）
   * 优先于战斗：打断当前的快速攻击/追怪走位，挂机开关保持不变，到达（或放弃）后自动恢复挂机选怪
   * @returns 是否受理（主角未就绪或死亡时不受理）
   */
  static requestMoveTo(point: Vec2): boolean {
    if (!this.roleDisplay || !isValid(this.roleDisplay) || this.roleDisplay.isDead()) return false;
    this.pendingSkill = null;
    this.target = null;
    this.pendingPoint = new Vec2(point.x, point.y);
    // 新寻路覆盖旧的交互寻路：走到一半又点了别的目标，旧回调作废
    this.interactNear = null;
    this.interactArrive = null;
    this.path = [];
    this.pathIndex = 0;
    this.stuckCount = 0;
    this.lastRepathAt = 0;
    return true;
  }

  /** 当前地图节点（小地图弹窗做世界坐标换算用；未注册或已失效返回 null） */
  static getMapNode(): Node | null {
    return this.mapNode && isValid(this.mapNode) ? this.mapNode : null;
  }

  /** 当前地图 id（读服务端快照里的点位用；空串 = 还没注册，调用方按「没有点位」处理） */
  static getMapId(): string {
    return this.mapId;
  }

  /** 主角当前世界坐标（未就绪返回 null；NPC 点击的交互范围判定用） */
  static getRolePosition(): Vec3 | null {
    return this.roleDisplay && isValid(this.roleDisplay) ? this.roleDisplay.getWorldPosition() : null;
  }

  /**
   * 请求寻路直至进入指定点周围 radius 范围（NPC 点击走近交互）：与 requestMoveTo 同一套
   * 走位机制（卡住检测 / 按需重算路径），但到达判定是「进入范围」而非「走到点」——
   * NPC 占位是障碍，走到点本身不可达，寻路只会停在它身边。
   * 进入范围即触发 `onNear` 并停住（静默，不弹「已到达目的地」）；
   * 玩家手动移动 / 新寻路 / 卡住放弃都会取消，回调不再触发。
   * @returns 是否受理（主角未就绪或死亡时不受理，调用方自行退回直接交互）
   */
  static requestMoveToNear(point: Vec2, nearWorld: Vec2, radius: number, onNear: () => void): boolean {
    if (!this.requestMoveTo(point)) return false;
    this.interactNear = new Vec2(nearWorld.x, nearWorld.y);
    this.interactRadius = radius;
    this.interactArrive = onNear;
    return true;
  }

  /**
   * 当前寻路路线（世界坐标，供小地图/大地图/预览弹窗画路线指示线）
   * 经典模式（#1352）返回视线拉直后的关键拐点（跳过已走过的），连续模式从「正在走向的路点」起
   * 依次为后续 A* 路点；最后补上实时目标点
   * （点击寻路是下发的固定点，追怪时目标会移动，故终点取实时坐标，线的末端始终指着目标）；
   * 未在自动走位（当前无路径，例如已进入范围内原地出手）时返回空数组。
   * 展示路线只影响画线，行走数据仍走逐格的 `path`
   */
  static getRoutePoints(): Vec2[] {
    if (this.path.length === 0) return [];
    const points: Vec2[] = [];
    // 经典模式（#1352）：展示路线是拉直后的关键拐点（下标升序），跳过已走过的，每帧只复制十几个点
    if (autoBattle.classicWalkMode && this.displayRoute.length > 0) {
      let start = 0;
      while (start < this.displayIndices.length && this.displayIndices[start] < this.pathIndex) start++;
      for (let i = start; i < this.displayRoute.length; i++) {
        points.push(new Vec2(this.displayRoute[i].x, this.displayRoute[i].y));
      }
      const destination = this.getDestination();
      if (destination) points.push(destination);
      return points;
    }
    const from = Math.min(this.pathIndex, this.path.length - 1);
    for (let i = from; i < this.path.length; i++) points.push(new Vec2(this.path[i].x, this.path[i].y));
    const destination = this.getDestination();
    if (destination) points.push(destination);
    return points;
  }

  /** 取本次寻路的最终目标点（点击寻路为下发的固定点，追怪为目标怪当前位置，都没有时返回 null） */
  private static getDestination(): Vec2 | null {
    const point = this.pendingPoint;
    if (point) return new Vec2(point.x, point.y);
    const target = this.target;
    if (target && isValid(target)) {
      const position = target.getWorldPosition();
      return new Vec2(position.x, position.y);
    }
    return null;
  }

  /**
   * 取世界坐标附近最近的可行走点（小地图弹窗右键传送的落点吸附：点击点在墙里/障碍里时挪到最近能站的位置；
   * 突进类技能的落点吸附也走这里，传更大的 radius，见 configs/autoBattle 的 dashSnapRadius）
   * 网格未就绪时返回 null，调用方退回使用原始点
   */
  static findWalkablePoint(point: Vec2, radius: number = autoBattle.teleportSnapRadius): Vec2 | null {
    const grid = this.ensureGrid();
    if (!grid) return null;
    grid.rebuild(MonsterManager.getBlockingRects(null));
    return grid.findNearestWalkablePoint(point.x, point.y, radius);
  }

  /** 每帧驱动（组合根在 Game.update 调用；manualMoving 为玩家是否正在手动移动：键盘方向键或鼠标按下操控） */
  static tick(manualMoving: boolean) {
    const roleDisplay = this.roleDisplay;
    if (!roleDisplay || !isValid(roleDisplay)) return;
    // 没有开启挂机、快速攻击请求与点击寻路时零开销返回
    if (!this.hangEnabled && !this.pendingSkill && !this.pendingPoint) return;
    // 玩家手动移动优先：快速攻击/点击寻路被玩家移动打断直接结束；挂机只是暂停（松开继续）
    if (manualMoving) {
      if (this.pendingSkill || this.pendingPoint) this.cancel();
      return;
    }
    // 点击寻路优先于战斗：走向指定点直到到达/放弃，挂机在结束后自动恢复选怪出手
    if (this.pendingPoint) {
      this.approachToPoint(roleDisplay);
      return;
    }
    // 出手技能：快速攻击用玩家按下的那个技能，挂机用第一个已学习且可自动释放的技能
    const skillId = this.pendingSkill ?? SkillManager.findAutoSkill();
    const config = skillId ? skills.get(skillId) : null;
    if (!skillId || !config) {
      this.cancel();
      return;
    }
    // 目标维护：失效（死亡/移除）时快速攻击结束，挂机换下一个目标
    if (!this.isTargetAlive(this.target)) {
      if (!this.hangEnabled) {
        this.cancel();
        return;
      }
      // 场上暂无可打目标：原地等待（挂机不关，等刷怪/等怪走出拉黑期），限频扫描
      const now = Date.now();
      if (now < this.nextTargetSearchAt) return;
      this.nextTargetSearchAt = now + autoBattle.targetSearchInterval;
      const next = this.pickNearestTarget();
      if (!next) return;
      this.setTarget(next);
    }
    const target = this.target as Node;
    // 攻击动作播放中：等动作打完再决定继续出手还是走位（期间不移动）
    if (roleDisplay.isAttacking()) return;
    // 单体且有距离限制的技能需要走到范围内，其余（无距离限制/群体区域）原地出手
    const needApproach = config.targetType === SkillTargetType.SINGLE && config.distance > 0;
    if (!needApproach || canAttackTarget(target, roleDisplay as unknown as Node, config.distance)) {
      roleDisplay.setAutoMove(null);
      this.path = [];
      this.pathIndex = 0;
      // 范围内出手：冷却/施法锁未就绪时静默失败，下一 tick 再试
      SkillManager.releaseAuto(skillId);
      return;
    }
    // 目标点每次现取（怪会移动）；追怪与小地图点击寻路共用同一套走位机制
    const toPoint = () => {
      const to = target.getWorldPosition();
      return new Vec2(to.x, to.y);
    };
    this.advance(roleDisplay, toPoint(), () => this.repathTo(roleDisplay, toPoint()), () => this.giveUpCurrentTarget());
  }

  /** 停止自动战斗（清快速攻击请求/目标/路径并停住自动移动；挂机开关状态不动） */
  static cancel() {
    this.clearRuntimeState();
    this.roleDisplay?.setAutoMove(null);
  }

  /** 场景卸载（组合根 onDestroy 调用）：全部运行时状态清空，挂机开关保留（重进场景继续挂机） */
  static reset() {
    // 只清状态、不再驱动主角：此时主角节点正在随场景销毁，
    // 再走一次动作/朝向状态机去播放动画属于给已销毁的节点发指令（切图时表现为播放动画报错）
    this.clearRuntimeState();
    this.banned.clear();
    this.grid = null;
    this.mapNode = null;
    this.roleDisplay = null;
    this.hangStateListener = null;
  }

  /** 清空运行时状态（快速攻击请求/点击寻路点/目标/路径/卡住计数），不触碰主角节点 */
  private static clearRuntimeState() {
    this.pendingSkill = null;
    this.pendingPoint = null;
    this.interactNear = null;
    this.interactArrive = null;
    this.target = null;
    this.path = [];
    this.pathIndex = 0;
    this.stuckCount = 0;
    // 在途的寻路请求作废（#811）：不清的话它的回执回来会顶掉「下一次」请求的回执
    this.pendingPathSeq = 0;
  }

  /** 目标是否仍可打（节点存活且怪物数据还在、血量大于 0） */
  private static isTargetAlive(target: Node | null): boolean {
    if (!target || !isValid(target)) return false;
    const monster = MonsterManager.getMonsterData(target);
    return !!monster && monster.hp > 0;
  }

  /** 自动选取目标：以「最近」为唯一标准（被拉黑的跳过） */
  private static pickNearestTarget(): Node | null {
    const roleDisplay = this.roleDisplay as RoleDisplay;
    const now = Date.now();
    // 清掉过期与已失效的拉黑记录
    this.banned.forEach((expires, node) => {
      if (expires <= now || !isValid(node)) this.banned.delete(node);
    });
    const exclude = this.banned.size > 0 ? new Set<Node>(this.banned.keys()) : undefined;
    return MonsterManager.getNearestMonster(roleDisplay.getWorldPosition(), autoBattle.maxTargetDistance, exclude);
  }

  /** 设定自动战斗目标（同步主角的选中状态，怪物信息面板随之显示；并重置路径与卡住计数） */
  private static setTarget(target: Node) {
    this.target = target;
    if (this.roleDisplay && this.roleDisplay.getTarget() !== target) this.roleDisplay.setTarget(target);
    this.path = [];
    this.pathIndex = 0;
    this.stuckCount = 0;
    this.lastRepathAt = 0;
  }

  /** 走向点击寻路的目标点（小地图弹窗）：与追怪共用走位机制（卡住检测/按需重算路径），到达即结束 */
  private static approachToPoint(roleDisplay: RoleDisplay) {
    const to = this.pendingPoint as Vec2;
    const position = roleDisplay.getWorldPosition();
    // 交互寻路：先判「进入范围」（每帧判，走进圈里立刻触发，不一定要走到点跟前）
    if (this.interactNear && Math.hypot(position.x - this.interactNear.x, position.y - this.interactNear.y) <= this.interactRadius) {
      this.finishPointMove();
      return;
    }
    if (Math.hypot(position.x - to.x, position.y - to.y) <= this.pointArriveTolerance()) {
      this.finishPointMove();
      return;
    }
    // 攻击动作播放中：等动作打完再走（期间不移动，与追怪走位一致）
    if (roleDisplay.isAttacking()) return;
    this.advance(roleDisplay, to, () => this.repathTo(roleDisplay, to), () => this.giveUpPointMove());
  }

  /** 到达点击寻路的目标点：清状态停住；交互寻路静默触发回调（不弹「已到达目的地」），普通寻路照旧提示 */
  private static finishPointMove() {
    const arrive = this.interactArrive;
    this.clearRuntimeState();
    this.roleDisplay?.setAutoMove(null);
    if (arrive) arrive();
    else GameUiHelper.createTip("map_move_arrive_tip");
  }

  /** 点击寻路无法到达（连续卡住）：清状态停住并提示 */
  private static giveUpPointMove() {
    this.clearRuntimeState();
    this.roleDisplay?.setAutoMove(null);
    GameUiHelper.createErrorTip("map_move_unreachable_tip");
  }

  /**
   * 点击寻路的到达判定半径
   *
   * 经典走路模式（#1334）要放宽到「半格对角」：终点是目标格的**格心**，而点击点可以在
   * 格内任意位置，离格心最远 `cellSize × √2 / 2`（出厂 40 格 ≈ 28.3px，大于出厂 arriveTolerance 20px）——
   * 不放宽的话人已经站上格心还判「没到」，等重寻路找到「自己到自己」的空路径后就永远到不了，
   * 最后卡住放弃误报「走不到」。
   */
  private static pointArriveTolerance(): number {
    if (!autoBattle.classicWalkMode) return autoBattle.arriveTolerance;
    return Math.max(autoBattle.arriveTolerance, (autoBattle.cellSize * Math.SQRT2) / 2);
  }

  /** 朝目标点走位（追怪与点击寻路共用）：卡住检测 → 按需重算路径 → 朝当前路点移动 */
  private static advance(roleDisplay: RoleDisplay, to: Vec2, repath: () => void, onGiveUp: () => void) {
    const now = Date.now();
    const position = roleDisplay.getWorldPosition();
    // 卡住检测：一段时间几乎没有位移说明被挡住（怪堆/死角），强制重寻路，连续多次就放弃
    if (now - this.lastStuckCheckAt >= autoBattle.stuckInterval) {
      if (this.lastStuckCheckAt > 0 && Math.hypot(position.x - this.lastStuckX, position.y - this.lastStuckY) < autoBattle.stuckDistance) {
        this.stuckCount++;
        this.lastRepathAt = 0;
        if (this.stuckCount >= autoBattle.stuckRetryLimit) {
          onGiveUp();
          return;
        }
      } else {
        this.stuckCount = 0;
      }
      this.lastStuckCheckAt = now;
      this.lastStuckX = position.x;
      this.lastStuckY = position.y;
    }
    // 路线按需重算（#1352）：不再按时间盲算——点击寻路有路就不算，追怪目标换格才算；
    // repathInterval 只是最小节流间隔。卡住检测（上面）会把 lastRepathAt 清零强制重算
    if (this.needRepath(to, now)) repath();
    // 经典模式会在到步后同帧切下一个路点，声明为 let（连续模式行为不变）
    let waypoint = this.path[this.pathIndex];
    if (!waypoint) {
      // 无路可走（寻路失败且直线趋近也为空）：原地等待下一轮重算
      roleDisplay.setAutoMove(null);
      return;
    }
    const direction = new Vec2(waypoint.x - position.x, waypoint.y - position.y);
    // 经典走路模式（#1334）：一步必须走完才走下一步 —— 到步阈值收紧到「一帧步长」，
    // 且落点钉在格心。连续模式用 waypointTolerance（14px）提前拐弯，那种口径下
    // 方向在步中途切换，角色永远站不上格心，格子走动会越走越歪。
    // 路点在经典模式下是逐格格心（PathGrid keepCells / 服务端 path 同一口径），步长恒定。
    if (autoBattle.classicWalkMode) {
      const run = autoBattle.moveByRun;
      const frameStep = run ? ROLE_RUN_SPEED : ROLE_WALK_SPEED;
      // 一格一步：到步吸附格心后**同帧接下一步**（#1346）——每个路点空停一帧
      // 在逐格路径上是一路一顿；相邻格心间距恒大于一帧步长，循环至多推进一步
      while (waypoint) {
        const remaining = Math.hypot(waypoint.x - position.x, waypoint.y - position.y);
        if (remaining > frameStep) {
          direction.set(waypoint.x - position.x, waypoint.y - position.y);
          direction.multiplyScalar(1 / remaining);
          roleDisplay.setAutoMove(direction, run);
          return;
        }
        roleDisplay.snapToWorldPosition(waypoint.x, waypoint.y);
        this.pathIndex++;
        waypoint = this.path[this.pathIndex];
      }
      // 路点走完：原地等待（点击寻路下帧判到达；追怪下帧判攻击距离或重寻路）
      roleDisplay.setAutoMove(null);
      return;
    }
    if (direction.length() < autoBattle.waypointTolerance) {
      // 到达当前路点：切下一个（本帧先停一步，下一 tick 朝新路点走）
      this.pathIndex++;
      roleDisplay.setAutoMove(null);
      return;
    }
    direction.normalize();
    roleDisplay.setAutoMove(direction, autoBattle.moveByRun);
  }

  /** 重算到目标点的路径（追怪与点击寻路共用）：先烙上动态障碍（场上怪物，追击目标自身除外），A* 失败时直线趋近兜底 */
  private static repathTo(roleDisplay: RoleDisplay, to: Vec2) {
    this.lastRepathAt = Date.now();
    this.pathIndex = 0;
    const grid = this.ensureGrid();
    if (!grid) {
      this.path = [new Vec2(to.x, to.y)];
      this.displayRoute = [];
      this.displayIndices = [];
      this.lastTargetCell = null;
      return;
    }
    // 动态障碍每次寻路前重烙：怪物围成的「墙」也会被绕开；追击目标自身不算障碍，路径才能通到它身边
    grid.rebuild(MonsterManager.getBlockingRects(this.target));
    const from = roleDisplay.getWorldPosition();
    // 经典走路模式（#1334）：一格一步，本地预判这份路点同样保持逐格格心（与服务端权威路径同口径）
    const path = grid.findPath(new Vec2(from.x, from.y), new Vec2(to.x, to.y), {
      keepCells: autoBattle.classicWalkMode,
    });
    if (path.length > 0) {
      this.path = path;
    } else if (autoBattle.classicWalkMode) {
      // 经典模式下 findPath 为空多半是「起点格 == 目标格」（A* 不产出路点）：
      // 走到目标格心，而不是连续模式的直线趋近 —— 格子走动的落点必须是格心
      const center = grid.findNearestWalkablePoint(to.x, to.y, 0);
      this.path = [center ?? new Vec2(to.x, to.y)];
    } else {
      this.path = [new Vec2(to.x, to.y)];
    }
    this.lastTargetCell = grid.cellIndexOf(to.x, to.y);
    // 经典模式（#1346/#1349）：路点[0] 是当前格的格心，角色步中途可能已越过它——裁掉回头路
    if (autoBattle.classicWalkMode) this.prunePassedWaypoints(new Vec2(from.x, from.y));
    this.rebuildDisplayRoute(grid);
    // 服务端寻路（#811 第三道）：本地的这一份是**即时预判**（点了就先动，不留 40~80ms 空窗），
    // 服务端回执一到就用它替换 —— 权威路点才算「我走过去没穿墙」。连接不在时（离线）就只走本地
    if (this.mapId) this.pendingPathSeq = CombatChannel.requestPath(this.mapId, { x: to.x, y: to.y });
  }

  /**
   * 是否需要重寻路（#1352）：按需而非按时间——
   * - 首轮 / 卡住检测强制（lastRepathAt 被清零）→ 必算；
   * - repathInterval 只是**最小节流间隔**，目标再怎么动也不会快过它重算；
   * - 路已走完还没到（点击寻路被截断 / 追怪目标挪走）→ 必算；
   * - 点击寻路目标不动：有路就不算（截断 / 卡住兜底）；
   * - 追怪：目标换了格才算（目标没动，既有路照样走）。
   */
  private static needRepath(to: Vec2, now: number): boolean {
    if (this.lastRepathAt === 0) return true;
    if (now - this.lastRepathAt < autoBattle.repathInterval) return false;
    if (this.pathIndex >= this.path.length) return true;
    if (this.pendingPoint) return false;
    const grid = this.grid;
    if (!grid) return true;
    const cell = grid.cellIndexOf(to.x, to.y);
    const last = this.lastTargetCell;
    if (!cell || !last) return true;
    return cell.col !== last.col || cell.row !== last.row;
  }

  /** 重建展示路线缓存（#1352，经典走路模式）：逐格路径视线拉直成关键拐点；连续模式路径本来就少，不需要 */
  private static rebuildDisplayRoute(grid: PathGrid) {
    if (!autoBattle.classicWalkMode || this.path.length === 0) {
      this.displayRoute = [];
      this.displayIndices = [];
      return;
    }
    this.displayIndices = grid.simplifyIndices(this.path);
    this.displayRoute = this.displayIndices.map((index) => new Vec2(this.path[index].x, this.path[index].y));
  }

  /**
   * 裁掉已越过的前导路点（#1346 / #1349，经典走路模式）
   *
   * 服务端权威路径（#811）从**服务端最后一次接受的位置**起算（4Hz pos 上报 + RTT），
   * 回执到达时角色已经按本地路径走出 0.5~1.5 格甚至更远——回执整体替换本地路径后，
   * 前 1~2 个路点在角色**身后**，不裁掉就会先走回头路再前进；重寻路 400ms 一次 +
   * 回执一次，往返形成来回折返。本地重寻路从「当前位置所在格」起算，路点[0] 是
   * 邻格格心，步中途越过格心时同样适用本判据。
   *
   * 判据（#1349 换投影、不限距离）：路点[0]→路点[1] 方向上角色位置的投影分量 > 0
   * （已越过路点[0]、在其朝向路点[1]的一侧）就裁，循环裁到第一个没越过的路点——
   * 回执滞后几格都能裁干净，裁完剩余路点全在前方。**严格 > 0 保拐角**：垂直拐弯的
   * 下一段与来向正交，贴着来向走到拐角前投影恰为 0，不会误裁拐角路点。
   */
  private static prunePassedWaypoints(position: Vec2) {
    while (this.path.length >= 2) {
      const current = this.path[0];
      const next = this.path[1];
      const dx = next.x - current.x;
      const dy = next.y - current.y;
      // lenSq === 0 防御：路点不应重复，真重复时不能拿零向量做投影
      if (dx === 0 && dy === 0) break;
      if ((position.x - current.x) * dx + (position.y - current.y) * dy <= 0) break;
      this.path.shift();
    }
  }

  /**
   * 服务端下发的路点（#811；组合根接线到 `CombatChannel.onPath`）
   *
   * 只认**最新一次**请求的回执（`seq` 对不上就是过期回执）。不可达时的收尾按「当前在干什么」
   * 分两路：点击寻路 → 停住并提示走不到；追怪 → 拉黑这只怪换下一个（不然会一直撞墙）。
   */
  static applyServerPath(frame: { seq: number; points: Array<{ x: number; y: number }>; unreachable: boolean }): void {
    if (frame.seq !== this.pendingPathSeq) return;
    this.pendingPathSeq = 0;
    if (frame.unreachable) {
      if (this.pendingPoint) this.giveUpPointMove();
      else if (this.target) this.giveUpCurrentTarget();
      return;
    }
    if (frame.points.length === 0) return;
    this.path = frame.points.map((point) => new Vec2(point.x, point.y));
    this.pathIndex = 0;
    // 服务端路径从「服务端最后一次接受的位置」起算（#1349）：4Hz 上报 + RTT，回执到达时
    // 角色可能已走出 0.5~1.5 格，前几个路点在身后——裁掉已越过的前导路点，别照它走回头路
    if (autoBattle.classicWalkMode) {
      const position = this.roleDisplay && isValid(this.roleDisplay) ? this.roleDisplay.getWorldPosition() : null;
      if (position) this.prunePassedWaypoints(new Vec2(position.x, position.y));
    }
    // 展示路线随路径整体替换重建（#1352）；网格不在就清缓存（getRoutePoints 会退回逐格展示）
    if (this.grid && autoBattle.classicWalkMode) this.rebuildDisplayRoute(this.grid);
    else {
      this.displayRoute = [];
      this.displayIndices = [];
    }
  }

  /**
   * 服务端位置修正（#811；组合根接线到 `CombatChannel.onPosCorrect`）
   *
   * 除了把主角挪过去，**还必须把当前路点作废**：那条路是按「我刚才在错位置」算的，
   * 起点错了整条路都错；下一次 tick 会按新位置重新请求。
   */
  static applyServerCorrection(x: number, y: number): void {
    this.roleDisplay?.applyServerCorrection(x, y);
    this.path = [];
    this.pathIndex = 0;
    this.lastRepathAt = 0;
    this.pendingPathSeq = 0;
    this.stuckCount = 0;
  }

  /** 取寻路网格（按当前地图惰性构建；地图未注册/已失效时返回 null） */
  private static ensureGrid(): PathGrid | null {
    if (this.grid) return this.grid;
    const map = this.mapNode;
    if (!map || !isValid(map)) return null;
    // 网格范围 = 地图像素范围。地图节点原点在左上角（#566），范围就是
    // [原点.x, 原点.x + W] × [原点.y - H, 原点.y]，不再拼「中心 ± 半图」
    const bounds = getMapWorldRect(map);
    const obstacles = this.readStaticObstacles();
    this.grid = new PathGrid(bounds, autoBattle.cellSize, autoBattle.clearance, obstacles.rects, obstacles.polys);
    return this.grid;
  }

  /**
   * 读静态障碍（服务端快照里的碰撞多边形 + NPC 点位按估算体型占位）
   *
   * 两样都读快照（#672 / #676 起那是唯一来源）：地图文件里已经没有对象组，
   * 从 TMX 读会得到空数组 —— 表现为「寻路穿墙」，而页面上看起来一切正常。
   * #1190 起碰撞是多边形（顶点原样交给 PathGrid 烙格），NPC 占位仍是矩形。
   */
  private static readStaticObstacles(): { rects: Rect[]; polys: PolyPoint[][] } {
    const rects: Rect[] = [];
    const polys: PolyPoint[][] = [];
    const layout = maps.get(this.mapId);
    layout?.collisions.forEach((poly) => {
      // 快照里的碰撞多边形已经是世界坐标顶点序列（首尾自动闭合），原样交给 PathGrid
      polys.push(poly.points.map(([x, y]) => ({ x, y })));
    });
    layout?.npcs.forEach((point) => {
      // 点位已经是世界坐标（#672）；#1339 起占位盒与 NPC 障碍碰撞盒同形状同位置：
      // 尺寸/偏移见 configs/autoBattle 的 npcObstacleSize / npcObstacleOffsetY（中心 = 点位下方 55px）
      const width = autoBattle.npcObstacleSize.width;
      const height = autoBattle.npcObstacleSize.height;
      const centerY = point.y + autoBattle.npcObstacleOffsetY;
      rects.push(new Rect(point.x - width / 2, centerY - height / 2, width, height));
    });
    return { rects, polys };
  }

  /** 放弃当前目标：挂机时拉黑一段时间换下一个（无限重复的前提是不卡死在一只怪上），快速攻击直接结束 */
  private static giveUpCurrentTarget() {
    const target = this.target;
    this.stuckCount = 0;
    this.path = [];
    this.pathIndex = 0;
    if (this.hangEnabled && target) {
      this.banned.set(target, Date.now() + autoBattle.targetBanDuration);
      this.target = null;
      return;
    }
    this.cancel();
    GameUiHelper.createErrorTip("auto_battle_unreachable_tip");
  }
}
