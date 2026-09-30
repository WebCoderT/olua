import { Size, Vec2, Vec3 } from "cc";
import type { BattleAttributes, CommonAttributes } from "./common";
import type { SpeedRate } from "./animation";
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
