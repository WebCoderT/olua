import { Size, Vec2 } from "cc";
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
  /** 当前血量 */
  hp: number;
}
