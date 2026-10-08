/** 军衔单阶属性加成（数值为该阶的总额，进阶后整体替换不叠加，与战魂/称号同构） */
export interface RankAttributes {
  maxHp: number;
  physicalAttack: [number, number];
  magicAttack: [number, number];
  taoistAttack: [number, number];
  physicalDefense: [number, number];
  magicDefense: [number, number];
  taoistDefense: [number, number];
}

/** 军衔单阶配置（单一成长线：一阶就是一级军衔，从 1 阶「新兵」到 100 阶「兵主临世」） */
export interface RankLevelConfig {
  /** 军衔阶数（1 起，共 100 阶） */
  level: number;
  /** 衔名（如「振威校尉」，也是头顶红字上显示的文案） */
  label: string;
  /** 衔阶大段（10 阶为一段：兵卒 / 校尉 / 都尉 / 中郎将 / 将军 / 重号将军 / 公卿 / 王爵 / 神将 / 神话） */
  tier: string;
  /** 描述 */
  description: string;
  /** 晋升到该阶消耗的绑定元宝（价格曲线见 configs/rank.rankUpgradePrice） */
  bindGold: number;
  /** 该阶提供的属性加成 */
  attributes: RankAttributes;
}
