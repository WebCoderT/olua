import { Size, Vec2, Vec3 } from "cc";
import type { ACTION, DIRECTION, SpeedRate } from "./animation";

/**
 * 怪物定位（normal / elite / boss）
 *
 * **#588 起只是个类型**：数值语义（倍率、强度）归服务端 —— 出厂在 `monster-seed.ts`
 * （MONSTER_TIER_SCALE），运行时权威在 `monsters` 表（管理端可改），战斗频道的 BOSS 判定也读那边。
 * 客户端只消费快照里带来的 tier 值（MonsterRuntimeStats.tier），不再自己按 tier 算任何数值。
 */
export type MonsterTier = "normal" | "elite" | "boss";

/**
 * 怪物运行时数值（#588 数据归属收口）
 *
 * 唯一来源 = 服务端 `monsters` 表（出厂值由 `server/src/shared/monster-seed.ts` 展开 seed，
 * 管理端 `PATCH /admin/monsters/:id` 可改），经 `GET /game-config` 快照下发，
 * `configs/monsterRuntime` 的运行时数值表持有 —— 客户端 configs/monster **不再有本地副本**。
 */
export interface MonsterRuntimeStats {
  /** 名称（管理端改的是表里这份；地图预览 / 任务文案 / 怪物头顶都显示它） */
  label: string;
  /** 等级 */
  level: number;
  /** 定位：normal / elite / boss（BOSS 判定的展示口径；结算判定在服务端） */
  tier: MonsterTier;
  /** 最大血量 */
  maxHp: number;
  /** 物理攻击区间 */
  physicalAttack: [number, number];
  /** 魔法攻击区间 */
  magicAttack: [number, number];
  /** 道术攻击区间 */
  taoistAttack: [number, number];
  /** 物理防御区间 */
  physicalDefense: [number, number];
  /** 魔法防御区间 */
  magicDefense: [number, number];
  /** 道术防御区间 */
  taoistDefense: [number, number];
}

/**
 * 怪物资源与表现（#588 数据归属收口）
 *
 * 唯一来源 = 服务端 `monster-presentation.generated.ts`（生成器从图集基准帧实测几何，
 * key 与数值种子双向对账），随 `GET /game-config` 快照的 `monsterPresentations` 段下发，
 * `configs/monsterRuntime` 的运行时资源表持有。客户端**没有怪物数据文件** ——
 * icon / out 是素材包里的路径事实，改素材 = 服务端重跑生成器 + 客户端重新进游戏。
 */
export interface MonsterPresentation {
  /** 图标（monster/icon/<key>_00000 单图） */
  icon: string;
  /** 外观图集目录（monster/out/<key>，帧动画按动作约定拼） */
  out: string;
  /**
   * 外观节点摆放偏移：把**可见身体中心**对准节点原点
   * （外观画布中心默认落在原点，身体在画布里不居中 → 外观节点按此偏移回摆；
   * 生成器按基准帧 trim 实测，消费点 GameUiHelper.createMonsterBody）
   */
  outOffset: Vec2;
  /**
   * 可见身体尺寸（基准帧 trim 实测）：碰撞盒（MonsterCollider）、
   * 点击选中（UITransform.hitTest）、头顶血条位置都由它决定
   */
  contentSize: Size;
  /**
   * 动作速度（每秒循环数）：快照带的逐怪覆盖与 configs/monster 的 monsterDefaultSpeedRate
   * 在落运行时表时已合成完毕，消费方直接用
   */
  speedRate: SpeedRate;
  /**
   * 移动速度：与 configs/role 的 ROLE_WALK_SPEED 同一单位（刚体线速度），
   * 追击玩家与原地随机走动都用它（随机走动会乘一个减速倍率，见 configs/monster 的 monsterAI）
   */
  moveSpeed: number;
  /**
   * 是否主动攻击玩家：
   * true 时玩家进入 detectRange 就追人，追到 attackRange 内站定普攻；
   * false 时只待机游走，但被玩家打伤后会被激怒（见 MonsterAI.provoke），
   * 之后与主动怪一样在 detectRange 内追击普攻；
   * 玩家离开 detectRange 就停在原地（不返回出生点），原地待机时会换动作并偶尔小走一下
   */
  aggressive: boolean;
  /** 检测范围（像素半径，以怪物自身为圆心；主动怪常驻使用，被动怪被激怒后同样使用） */
  detectRange: number;
}

/**
 * 场上怪物实例 = 资源表现 + 运行时数值 + 实例状态
 * 两半都来自服务端（#588）：资源与表现走快照 `monsterPresentations`，数值走快照 `monsters`；
 * 实例本身（出生点 / 实例 id / 血量）来自 world 帧与结算帧。
 */
export interface Monster extends MonsterPresentation, MonsterRuntimeStats {
  /** 怪物编号（服务端种子的 key，同一编号的怪物可分布在多个刷怪区域） */
  id: string;
  /** 当前血量 */
  hp: number;
  /**
   * 恒为 0：怪物不回血（回血是玩家养成线的收益，「磨血」打法依赖这一点）。
   * 战斗纯函数（BattleMath）按 BattleAttributes 口径收参，要这个字段 —— 实例上补一个常量
   * 比让纯函数改签名干净（怪不回血是游戏规则，不是数据）。
   */
  hpRecover: number;
  /**
   * 实例 id：场上每只怪一份，全服唯一。
   * 世界权威（#35）后由**服务端发牌**（进图 worldJoin 的 world 帧下发，跨重启稳定），
   * cast 的 targetId 用它。数值（maxHp / 攻防）一律来自服务端那份表。
   */
  instanceId: string;
}

/**
 * 怪物 AI 运行时状态
 * 每个怪物一份，由 MonsterAI 按怪物节点维护（节点销毁即回收），不参与任何存档
 * 时间字段一律为时间戳（毫秒），到点即触发；追人、待机、击退三套计时互不干扰
 */
export interface MonsterAIState {
  /** 当前动作（动画播完据此续播；缺帧的动作会回退成待机） */
  action: ACTION;
  /** 死亡标记：死亡动画播放期间不再续播/接管任何行为，节点由 MonsterManager 在动画播完后移除 */
  dead: boolean;
  /** 激怒标记：被动攻击的怪物被玩家打过后置位，之后在检测范围内与主动怪一样追击普攻（主动怪恒为 true 效果） */
  provoked: boolean;
  /** 当前朝向 */
  direction: DIRECTION;
  /** 停留点（生成位置或失去玩家时的位置，原地随机走动围绕它进行） */
  anchor: Vec3;
  /** 下次更换待机动作的时间戳 */
  nextIdleAnimationAt: number;
  /** 下次原地随机走动的时间戳 */
  nextIdleMoveAt: number;
  /** 本次随机走动的结束时间戳（已过期表示当前没有在走动） */
  idleMoveEndAt: number;
  /** 本次随机走动的方向（单位向量） */
  idleMoveDirection: Vec2;
  /** 普攻动作结束的时间戳（出手期间站定不移动） */
  attackEndAt: number;
  /** 下次可普攻的时间戳 */
  nextAttackAt: number;
  /** 是否有一次普攻待结算（普攻动作播放完成后结算伤害） */
  attackPending: boolean;
  /** 击退结束的时间戳（已过期表示当前没有被击退） */
  pushEndAt: number;
  /** 击退方向（单位向量，世界坐标） */
  pushDirection: Vec2;
  /** 击退速度（像素/秒，由击退距离与时长换算，见 MonsterAI.push） */
  pushSpeed: number;
  /** 服务端权威位置（#323：monster-ai 帧的最新坐标；null = 还没收到过服务端位置） */
  serverX: number | null;
  /** 服务端权威位置 y（与 serverX 成对出现） */
  serverY: number;
  /** 服务端给的移动标记（true = 在追击或游走，客户端播走路） */
  serverMoving: boolean;
  /** 上次向服务端位置趋近的时刻（毫秒，按帧步进用） */
  serverStepAt: number;
}

/**
 * 怪物刷新区域
 * 对应地图 monster 对象组里的一个矩形区域（自定义属性 id/min/max）：
 * 开图时在该区域内随机落点生成 max 只对应编号的怪物（只生成一次，不做刷新补充）
 */
export interface MonsterSpawnArea {
  /** 区域名称（地图里给区域起的名字，仅用于日志与调试显示） */
  label: string;
  /** 怪物编号（服务端种子的 key，由自定义属性 id 指定） */
  monsterId: string;
  /** 区域中心（世界坐标，怪物落点以它为基准；地图节点位于原点时与本地坐标一致） */
  center: Vec3;
  /** 区域尺寸（即怪物落点的取值范围） */
  size: Size;
  /** 该区域允许的最少怪物数（地图配置里的 min，当前生成逻辑未使用，保留给后续数量策略） */
  min: number;
  /** 该区域生成的怪物数量（地图配置里的 max） */
  max: number;
}
