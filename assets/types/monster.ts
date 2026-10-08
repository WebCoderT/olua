import { Size, Vec2, Vec3 } from "cc";
import type { BattleAttributes, CommonAttributes } from "./common";
import type { ACTION, DIRECTION, SpeedRate } from "./animation";
import type { DropPicks, DropSource } from "./drop";
import type { SkillId } from "./skill";

/**
 * 怪物定位：决定「同等级」下的强度倍率（倍率数值见 configs/growth 的 monsterTierScale）
 * - normal 普通怪：曲线基准
 * - elite  精英怪：更耐打、打人更疼
 * - boss   首领：同级要打几十刀
 */
export type MonsterTier = "normal" | "elite" | "boss";

/**
 * 怪物配置数据（configs/monster 里的条目形态）
 *
 * **key 只做关联**：地图对象组的 id、掉落表、AI 都用它引用同一只怪；
 * key 可以是任意字符串（不要求是数字，例如 "goblin_chief"），也不参与任何数值计算。
 * 数值一律按 level（配合 tier）从 configs/growth 的成长曲线派生。
 *
 * 战斗属性（maxHp 与六项攻防）与动作速度（speedRate）是**可选**的：
 * 不写就分别由 monsterStats(level, tier) 与 configs/monster 的 monsterDefaultSpeedRate 生成，
 * 写了则逐字段覆盖生成值（用于法系怪要魔法攻击、特殊怪要更高血量 / 某只怪动作更慢之类的特例）。
 */
export type MonsterData = Omit<MonsterConfig, keyof BattleAttributes | "speedRate"> &
  Partial<BattleAttributes> & {
    /** 关联键（唯一）——地图对象组的 id 就是它，仅用于相互引用 */
    key: string;
    /** 定位（不写 = normal，影响同等级下的强度倍率） */
    tier?: MonsterTier;
    /** 动作速度覆盖：只写要改的动作，其余沿用 configs/monster 的 monsterDefaultSpeedRate */
    speedRate?: Partial<SpeedRate>;
  };

/** 怪物配置接口 */
export interface MonsterConfig extends CommonAttributes, BattleAttributes {
  /** 图标 */
  icon: string;
  // 外观
  out: string;
  /**
   * 外观节点摆放偏移：把**可见身体中心**对准节点原点
   * （外观画布中心默认落在原点，身体在画布里不居中 → 外观节点按此偏移回摆；
   * 生成器按基准帧的 auto-trim 实测，消费点 GameUiHelper.createMonsterBody）
   */
  outOffset: Vec2;
  /**
   * 可见身体尺寸（基准帧 auto-trim 实测）：碰撞盒（MonsterCollider）、
   * 点击选中（UITransform.hitTest）、头顶血条位置都由它决定
   */
  contentSize: Size;
  /**
   * 动作速度（每秒循环数，片段总时长 = 1 / 该值）：运行时由 configs/monster 的
   * monsterDefaultSpeedRate 打底、条目覆盖合成，全怪共用一套默认（素材帧规格统一）
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
  /** 怪物技能（未配置则不显示技能） */
  skills?: SkillId[];
  /**
   * 掉落物品列表：**默认取 configs/monsterDrops 里该 key 的独立掉落表**（每只怪一份，
   * 条目逐条配 weight/chance/count）；条目里直接写数组或具名表 id 可完全覆盖本表
   */
  drops?: DropSource;
  /**
   * 掉落件数（= 抽取次数）：数字 = 固定件数，[最小, 最大] = 件数区间（例 [1, 10] 掉 1~10 件，
   * 每次抽取独立随机、可重复命中同一条目）；默认取独立掉落表里的 picks，写了则覆盖
   */
  dropPicks?: DropPicks;
}

/** 生成的怪物接口 */
export interface Monster extends MonsterConfig {
  /** 怪物编号（configs/monster 中的 key，同一编号的怪物可分布在多个刷怪区域） */
  id: string;
  /** 当前血量 */
  hp: number;
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
}

/**
 * 怪物刷新区域
 * 对应地图 monster 对象组里的一个矩形区域（自定义属性 id/min/max）：
 * 开图时在该区域内随机落点生成 max 只对应编号的怪物（只生成一次，不做刷新补充）
 */
export interface MonsterSpawnArea {
  /** 区域名称（地图里给区域起的名字，仅用于日志与调试显示） */
  label: string;
  /** 怪物编号（configs/monster 中的 key，由自定义属性 id 指定） */
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
