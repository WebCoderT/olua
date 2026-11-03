/** 战魂单级属性加成（数值为该等级的总额，升级后整体替换不叠加） */
export interface SoulAttributes {
  maxHp: number;
  /** 每秒血量回复量（按等效等级裸回血 × rate × 系列 factor 派生，见服务端 soul-seed） */
  hpRecover: number;
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
  /** 升级到该等级消耗的绑定元宝（管理端成长列表可改） */
  bindGold: number;
  /** 中间展示的战魂动画（resources 下的散图帧目录，不含扩展名，如 war-soul/sfx_13001） */
  animation: string;
  /** 动画每秒帧数 */
  animationFrameRate: number;
  /**
   * 成长链序号（1 起；37 阶全量持有）
   *
   * 战魂没有「获得渠道」概念，每一阶都在链上；但运营仍可在管理端「战魂成长列表」里
   * 拖动排序 —— 所以「下一阶」是链上的下一行，不是 `level + 1`
   * （见 configs/game-config.nextSoulUpgrade）。
   */
  upgradeOrder: number;
  /** 该等级提供的属性加成 */
  attributes: SoulAttributes;
}
