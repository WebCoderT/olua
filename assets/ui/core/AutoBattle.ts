import { isValid, Node, Rect, Vec2, Vec3 } from "cc";
import { autoBattle } from "../../configs/autoBattle";
import { tiledGroupNames, tiledObjectClasses } from "../../configs/map";
import { skills } from "../../configs/skill";
import { SkillId, SkillTargetType } from "../../types/skill";
import type RoleDisplay from "../components/role/RoleDisplay";
import { canAttackTarget } from "../utils/battle/BattleMath";
import { getMapPixelSize, getMapPointPositionOnWorld, getMapRectCenterPositionOnWorld } from "../utils/map/MapPointMath";
import PathGrid from "../utils/map/PathGrid";
import { TiledObject, getTiledObjectsFrom } from "../utils/map/TiledObjects";
import GameUiHelper from "../helpers/GameUiHelper";
import MonsterManager from "./MonsterManager";
import SkillManager from "./SkillManager";

/**
 * 自动战斗（静态类）
 * 「快速攻击」与「自动挂机」共用一套「选目标 → A* 走位接近 → 范围内出手」的循环，
 * 由组合根在 Game.update 每帧调用 tick（键盘移动输入优先于自动移动，作为参数传入）：
 * - 快速攻击：释放 canAuto 技能时没有可打目标/目标超出距离，由 SkillManager 委托本类
 *   自动选取最近的怪物并走位到技能范围内连续出手，直到玩家按下移动键或目标死亡
 * - 自动挂机：挂机按钮开启后自动选取最近怪物持续攻击，目标死亡换下一个无限重复；
 *   玩家按下移动键期间整体暂停（由玩家接管），松开继续；开关状态跨地图保留
 * 走位用 A* 寻路（见 utils/map/PathGrid）绕开障碍：网格以当前地图为基准（GameMap 注册），
 * 静态障碍取 Tiled 碰撞区与 NPC 占位，动态障碍为场上怪物碰撞盒（目标自身除外），每次寻路前重烙；
 * 目标永远取「最近」，被判定无法接近的目标短暂拉黑后自动换下一个，避免卡死
 */
export default class AutoBattle {
  /** 主角（组合根注册，场景卸载时 reset 清空） */
  private static roleDisplay: RoleDisplay | null = null;
  /** 当前地图节点（GameMap 注册，寻路网格的数据来源） */
  private static mapNode: Node | null = null;
  /** 寻路网格（按地图惰性构建，换图作废） */
  private static grid: PathGrid | null = null;
  /** 挂机开关 */
  private static hangEnabled = false;
  /** 快速攻击的技能（玩家按了 canAuto 技能但没有可打目标时记录，优先于挂机的默认技能） */
  private static pendingSkill: SkillId | null = null;
  /** 当前自动战斗目标 */
  private static target: Node | null = null;
  /** 无法接近目标的拉黑记录（节点 -> 解禁时间戳） */
  private static banned = new Map<Node, number>();
  /** 当前路径（世界坐标路点，不含起点） */
  private static path: Vec2[] = [];
  /** 正在走向的路点下标 */
  private static pathIndex = 0;
  /** 上次寻路时间戳 */
  private static lastRepathAt = 0;
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

  /** 注册当前地图（换图时由 GameMap 调用）：旧寻路网格作废，自动战斗目标清空（挂机开关保留） */
  static setMap(map: Node) {
    this.mapNode = map;
    this.grid = null;
    this.path = [];
    this.pathIndex = 0;
    this.target = null;
    this.pendingSkill = null;
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
      GameUiHelper.createTip("auto_battle_no_skill_tip", "没有可自动释放的技能，无法挂机");
      return;
    }
    this.hangEnabled = enabled;
    if (enabled) {
      // 挂机接管：清掉快速攻击的技能偏好与旧目标，下一 tick 自动选最近的怪物
      this.pendingSkill = null;
      this.target = null;
      GameUiHelper.createTip("auto_battle_on_tip", "自动挂机已开启");
    } else {
      this.cancel();
      GameUiHelper.createTip("auto_battle_off_tip", "自动挂机已关闭");
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

  /** 每帧驱动（组合根在 Game.update 调用；keyboardMoving 为当前是否有移动键按下） */
  static tick(keyboardMoving: boolean) {
    const roleDisplay = this.roleDisplay;
    if (!roleDisplay || !isValid(roleDisplay)) return;
    // 没有开启挂机也没有快速攻击请求时零开销返回
    if (!this.hangEnabled && !this.pendingSkill) return;
    // 玩家手动移动优先：快速攻击被移动键打断直接结束；挂机只是暂停（松手继续）
    if (keyboardMoving) {
      if (this.pendingSkill) this.cancel();
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
    this.approach(roleDisplay, target);
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

  /** 清空运行时状态（快速攻击请求/目标/路径/卡住计数），不触碰主角节点 */
  private static clearRuntimeState() {
    this.pendingSkill = null;
    this.target = null;
    this.path = [];
    this.pathIndex = 0;
    this.stuckCount = 0;
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

  /** 走位接近目标：卡住检测 → 按需重算路径 → 朝当前路点移动 */
  private static approach(roleDisplay: RoleDisplay, target: Node) {
    const now = Date.now();
    const position = roleDisplay.getWorldPosition();
    // 卡住检测：一段时间几乎没有位移说明被挡住（怪堆/死角），强制重寻路，连续多次就放弃当前目标
    if (now - this.lastStuckCheckAt >= autoBattle.stuckInterval) {
      if (this.lastStuckCheckAt > 0 && Math.hypot(position.x - this.lastStuckX, position.y - this.lastStuckY) < autoBattle.stuckDistance) {
        this.stuckCount++;
        this.lastRepathAt = 0;
        if (this.stuckCount >= autoBattle.stuckRetryLimit) {
          this.giveUpCurrentTarget();
          return;
        }
      } else {
        this.stuckCount = 0;
      }
      this.lastStuckCheckAt = now;
      this.lastStuckX = position.x;
      this.lastStuckY = position.y;
    }
    // 路径按间隔重算（目标会移动）；走完现有路径还没进入范围时原地等一小段再重算，避免每帧都搜索
    if (this.lastRepathAt === 0 || now - this.lastRepathAt >= autoBattle.repathInterval) {
      this.repath(roleDisplay, target);
    }
    const waypoint = this.path[this.pathIndex];
    if (!waypoint) {
      // 无路可走（寻路失败且直线兜底也为空）：原地等待下一轮重算
      roleDisplay.setAutoMove(null);
      return;
    }
    const direction = new Vec2(waypoint.x - position.x, waypoint.y - position.y);
    if (direction.length() < autoBattle.waypointTolerance) {
      // 到达当前路点：切下一个（本帧先停一步，下一 tick 朝新路点走）
      this.pathIndex++;
      roleDisplay.setAutoMove(null);
      return;
    }
    direction.normalize();
    roleDisplay.setAutoMove(direction, autoBattle.moveByRun);
  }

  /** 重算到目标的路径：先烙上动态障碍（场上怪物，目标自身除外），A* 失败时直线趋近兜底 */
  private static repath(roleDisplay: RoleDisplay, target: Node) {
    this.lastRepathAt = Date.now();
    this.pathIndex = 0;
    const to = target.getWorldPosition();
    const grid = this.ensureGrid();
    if (!grid) {
      this.path = [new Vec2(to.x, to.y)];
      return;
    }
    // 动态障碍每次寻路前重烙：怪物围成的「墙」也会被绕开；目标自身不算障碍，路径才能通到它身边
    grid.rebuild(MonsterManager.getBlockingRects(target));
    const path = grid.findPath(new Vec2(roleDisplay.getWorldPosition().x, roleDisplay.getWorldPosition().y), new Vec2(to.x, to.y));
    this.path = path.length > 0 ? path : [new Vec2(to.x, to.y)];
  }

  /** 取寻路网格（按当前地图惰性构建；地图未注册/已失效时返回 null） */
  private static ensureGrid(): PathGrid | null {
    if (this.grid) return this.grid;
    const map = this.mapNode;
    if (!map || !isValid(map)) return null;
    // 网格范围 = 地图像素范围（地图节点在世界原点，本地坐标即世界坐标）
    const size = getMapPixelSize(map);
    const mapWorld = map.getWorldPosition();
    const bounds = new Rect(mapWorld.x - size.width / 2, mapWorld.y - size.height / 2, size.width, size.height);
    this.grid = new PathGrid(bounds, autoBattle.cellSize, autoBattle.clearance, this.readStaticObstacles(map));
    return this.grid;
  }

  /** 读地图里的静态障碍（Tiled collision 矩形 + NPC 点位按估算体型占位），转成世界坐标矩形 */
  private static readStaticObstacles(map: Node): Rect[] {
    const rects: Rect[] = [];
    getTiledObjectsFrom(map, tiledGroupNames.collision).forEach((object) => {
      // 没有面积的元素（点、多边形）构不成矩形阻挡，与碰撞区生成器同一规则跳过
      if (object.width <= 0 || object.height <= 0) return;
      rects.push(this.tiledRectToWorld(object, map));
    });
    getTiledObjectsFrom(map, tiledGroupNames.npc, tiledGroupNames.legacyObjects).forEach((object) => {
      if (object.objectClass !== tiledObjectClasses.npc) return;
      const position = getMapPointPositionOnWorld(new Vec3(object.x, object.y, 0), map);
      const width = autoBattle.npcObstacleSize.width;
      const height = autoBattle.npcObstacleSize.height;
      rects.push(new Rect(position.x - width / 2, position.y - height / 2, width, height));
    });
    return rects;
  }

  /** Tiled 矩形对象 -> 世界坐标矩形（复用 MapPointMath 的换算，避免再踩 y 轴翻转的坑） */
  private static tiledRectToWorld(object: TiledObject, map: Node): Rect {
    const center = getMapRectCenterPositionOnWorld(object.x, object.y, object.width, object.height, map);
    return new Rect(center.x - object.width / 2, center.y - object.height / 2, object.width, object.height);
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
    GameUiHelper.createErrorTip("auto_battle_unreachable_tip", "无法接近目标，已停止自动攻击");
  }
}
