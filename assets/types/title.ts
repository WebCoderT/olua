/** 称号单级属性加成（数值为该等级的总额，升级后整体替换不叠加，与战魂同构） */
export interface TitleAttributes {
  maxHp: number;
  physicalAttack: [number, number];
  magicAttack: [number, number];
  taoistAttack: [number, number];
  physicalDefense: [number, number];
  magicDefense: [number, number];
  taoistDefense: [number, number];
}

/** 称号等级配置（单一成长线：每张卡片就是一个等级阶段） */
export interface TitleLevelConfig {
  /** 称号等级（1 起） */
  level: number;
  /** 名称（与素材画面上烙的字一致，如「飞龙在天」） */
  label: string;
  /** 描述 */
  description: string;
  /** 升级到该等级消耗的绑定元宝（价格曲线见 configs/title.titleUpgradePrice） */
  bindGold: number;
  /** 头顶外显与弹窗展示的称号动画（resources 下的散图帧目录，不含扩展名，如 titles/sfx_13009） */
  animation: string;
  /** 动画每秒帧数 */
  animationFrameRate: number;
  /** 该等级提供的属性加成 */
  attributes: TitleAttributes;
}
