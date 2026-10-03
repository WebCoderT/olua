/** 战魂单级属性加成（数值为该等级的总额，升级后整体替换不叠加） */
export interface SoulAttributes {
  maxHp: number;
  physicalAttack: [number, number];
  magicAttack: [number, number];
  taoistAttack: [number, number];
  physicalDefense: [number, number];
  magicDefense: [number, number];
  taoistDefense: [number, number];
}

/** 战魂等级配置（单一成长线：每张卡片就是一个等级阶段） */
export interface SoulLevelConfig {
  /** 战魂等级（1 起） */
  level: number;
  /** 名称（如「初生魂翼」） */
  label: string;
  /** 描述 */
  description: string;
  /** 升级到该等级消耗的绑定元宝 */
  bindGold: number;
  /** 中间展示的战魂动画（resources 下的散图帧目录，不含扩展名，如 war-soul/sfx_13001） */
  animation: string;
  /** 动画每秒帧数 */
  animationFrameRate: number;
  /** 该等级提供的属性加成 */
  attributes: SoulAttributes;
}
