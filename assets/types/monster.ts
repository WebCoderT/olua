import { Size, Vec2, Vec3 } from "cc";
import type { BattleAttributes, CommonAttributes } from "./common";
import type { ACTION, DIRECTION, SpeedRate } from "./animation";
import type { DropSource } from "./drop";
import type { SkillId } from "./skill";

/** 怪物配置接口 */
export interface MonsterConfig extends CommonAttributes, BattleAttributes {
  /** 图标 */
  icon: string;
  // 外观
  out: string;
  /** 外观偏移 */
  outOffset: Vec2;
  /** 怪物选中区域 */
  contentSize: Size;
  /** 怪物每个动作对应时长
   * 每一个怪物都不同，没有添加
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
   * 玩家离开 detectRange 就停在原地（不返回出生点），原地待机时会换动作并偶尔小走一下
   */
  aggressive: boolean;
  /** 检测范围（像素半径，以怪物自身为圆心；只有主动攻击的怪物使用） */
  detectRange: number;
  /** 怪物技能（未配置则不显示技能） */
  skills?: SkillId[];
  /**
   * 掉落配置：字符串引用具名掉落表（configs/drop 的 dropTables），
   * 也可直接内联掉落表对象；未配置则使用默认掉落表
   */
  drops?: DropSource;
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
