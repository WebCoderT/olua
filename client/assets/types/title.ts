/** 称号单级属性加成（数值为该等级的总额，升级后整体替换不叠加，与战魂同构） */
export interface TitleAttributes {
  maxHp: number;
  /** 每秒血量回复量（按等效等级裸回血 × rate × 系列 factor 派生，见服务端 title-seed） */
  hpRecover: number;
  physicalAttack: [number, number];
  magicAttack: [number, number];
  taoistAttack: [number, number];
  physicalDefense: [number, number];
  magicDefense: [number, number];
  taoistDefense: [number, number];
}

/** 称号获得渠道（服务端 `titles.acquire_channel` 原样下发） */
export type TitleAcquireChannel = "upgrade" | "grant" | "unavailable";

/** 称号等级配置（单一成长线：每张卡片就是一个等级阶段） */
export interface TitleLevelConfig {
  /** 称号等级（1 起） */
  level: number;
  /** 名称（与素材画面上烙的字一致，如「飞龙在天」） */
  label: string;
  /** 描述 */
  description: string;
  /** 升级到该等级消耗的绑定元宝（服务端 `titles.bind_gold`，管理端成长列表可改） */
  bindGold: number;
  /** 头顶外显与弹窗展示的称号动画（resources 下的散图帧目录，不含扩展名，如 titles/sfx_13009） */
  animation: string;
  /** 动画每秒帧数 */
  animationFrameRate: number;
  /**
   * 获得渠道：`upgrade` 称号升级（**只有这类在升级链上**）、`grant` 系统赠送、`unavailable` 暂不放出
   *
   * 升级弹窗的列表只列 `upgrade` 的行 —— 运营没放出的等级不该让玩家看见「点得到的空档」。
   * 头顶名牌 / 当前称号展示仍按等级号读全表（玩家已获得的 grant 称号照样显示）。
   */
  acquireChannel: TitleAcquireChannel;
  /**
   * 成长链序号（1 起；**仅 `upgrade` 渠道的行有值**，其余为 null）
   *
   * 运营在管理端「称号成长列表」里拖动排序改的就是它，与等级号解耦 ——
   * 所以「下一级」是链上的下一行，不是 `level + 1`（见 configs/game-config.nextTitleUpgrade）。
   */
  upgradeOrder: number | null;
  /** 该等级提供的属性加成 */
  attributes: TitleAttributes;
}
