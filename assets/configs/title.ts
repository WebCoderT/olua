import type { TitleAttributes, TitleLevelConfig } from "../types/title";
import { getRoleLevelAttributes, roleMaxLevel } from "./growth";

/**
 * 称号配置（单一成长线）
 * 数据来自 resources/titles：sfx_13009 ~ sfx_13070 共 34 个散图帧目录（名牌带字动画），
 * 按外观由弱到强排成等级序列 1 ~ 34（下标 + 1 即等级）：
 * - sfx_13009~13020 江湖奇趣系（factor 1）
 * - sfx_13031~13041 军阶系（factor 1.15）
 * - sfx_13060~13070 「我能打」搞怪系（factor 1.3）
 *
 * 属性**不在这里拍数值**，而是按阶映射到一个「等效角色等级」，取该等级的角色裸属性再打折
 * （与 configs/soul 同一套做法），configs/growth 的等级曲线一改，称号强度自动跟着走。
 * 称号比战魂弱一档（rate 0.3 vs 0.5）：战魂是主成长线，称号是次级补充。
 */

/** 称号外观源：resources/titles 下的目录编号 + 系列强度系数 */
interface TitleSource {
  /** 资源目录编号（目录名 = sfx_编号） */
  id: number;
  /** 系列强度系数（江湖 1 / 军阶 1.15 / 搞怪 1.3，换系列时属性小跳一档） */
  factor: number;
  /** 名称（与素材画面上烙的字一致） */
  label: string;
  /** 描述 */
  description: string;
}

/** 称号外观序列（顺序即等级顺序，来自 resources/titles 实际目录） */
const titleSources: TitleSource[] = [
  { id: 13009, factor: 1, label: "飞龙在天", description: "紫电缠绕的飞龙盘旋头顶，取「飞龙在天」之意。" },
  { id: 13010, factor: 1, label: "九龙拉棺", description: "九条金龙牵引古棺而行，神秘而威严。" },
  { id: 13011, factor: 1, label: "龙战于野", description: "金龙相斗于野，血染黄沙的赫赫凶名。" },
  { id: 13012, factor: 1, label: "潜龙勿用", description: "潜龙在渊，静待风云际会之时。" },
  { id: 13013, factor: 1, label: "神龙摆尾", description: "龙尾横扫千军，招式凌厉的象征。" },
  { id: 13014, factor: 1, label: "笑看浮华苍生", description: "金翼加身的王者，冷眼笑看浮华苍生。" },
  { id: 13015, factor: 1, label: "老司机来了", description: "驾车技术炉火纯青，老司机带带我。" },
  { id: 13016, factor: 1, label: "万界第一神", description: "万界敬仰的第一神祇，赤焰加身。" },
  { id: 13017, factor: 1, label: "万界第一魔", description: "万界闻风丧胆的第一魔头，魔气冲霄。" },
  { id: 13018, factor: 1, label: "北冥有鱼", description: "北冥有鱼，其名为鲲，化而为鸟翱翔九天。" },
  { id: 13019, factor: 1, label: "策马啸西风", description: "仗剑策马，长啸西风的江湖游侠。" },
  { id: 13020, factor: 1, label: "万界第一佛", description: "万界朝拜的第一佛陀，佛光普照。" },
  { id: 13031, factor: 1.15, label: "王城勇士", description: "王城比武夺魁的勇士，军旅生涯的起点。" },
  { id: 13032, factor: 1.15, label: "抚夷校尉", description: "抚定四夷的校尉，初掌兵权。" },
  { id: 13033, factor: 1.15, label: "远征先锋", description: "大军远征的开路先锋，逢山开路遇水搭桥。" },
  { id: 13034, factor: 1.15, label: "魔域护军", description: "镇守魔域边关的护军，煞气缠身而军心不改。" },
  { id: 13035, factor: 1.15, label: "铁血军候", description: "治军如铁的军候，令行禁止。" },
  { id: 13036, factor: 1.15, label: "破军都尉", description: "冲锋破阵的都尉，所部战无不胜。" },
  { id: 13037, factor: 1.15, label: "镇远将军", description: "坐镇远疆的将军，一方安宁系于一身。" },
  { id: 13038, factor: 1.15, label: "神武督军", description: "督率三军的将才，神武之名传遍诸国。" },
  { id: 13039, factor: 1.15, label: "至尊军神", description: "军旅至尊，一呼百应的军神。" },
  { id: 13040, factor: 1.15, label: "三军元帅", description: "执掌三军帅印，运筹帷幄之中决胜千里之外。" },
  { id: 13041, factor: 1.15, label: "号令天下", description: "帅旗所指天下景从，军功系统的顶点。" },
  { id: 13060, factor: 1.3, label: "悍无人性", description: "下手太狠悍无人性，怪物见了绕道走。" },
  { id: 13061, factor: 1.3, label: "我能打十个", description: "一瓶酒下肚放话：我能打十个！" },
  { id: 13062, factor: 1.3, label: "我能打20个", description: "吹牛逐渐失控：二十个不在话下。" },
  { id: 13063, factor: 1.3, label: "我能打30个", description: "三十个怪围上来，竟然真被他打完了。" },
  { id: 13064, factor: 1.3, label: "我能打40个", description: "四十连斩的战绩，没人再敢说他吹牛。" },
  { id: 13065, factor: 1.3, label: "我能打50个", description: "五十连斩，屠怪如麻。" },
  { id: 13066, factor: 1.3, label: "我能打60个", description: "六十连斩，杀气已凝成实质。" },
  { id: 13067, factor: 1.3, label: "我能打70个", description: "七十连斩，凶名远播。" },
  { id: 13068, factor: 1.3, label: "我能打80个", description: "八十连斩，档口排列如仪仗。" },
  { id: 13069, factor: 1.3, label: "我能打90个", description: "九十连斩，一息一刀从不停手。" },
  { id: 13070, factor: 1.3, label: "我能打100个", description: "百人斩！称号系统的最终成就。" },
];

/**
 * 称号强度曲线（称号属性 = 等效等级的角色裸属性 × rate × 系列 factor）
 * - 1 阶 ≈ 2 级角色（刚激活时只是象征性加成）
 * - 满阶 34 阶 ≈ 60 级角色的 0.3 × 1.3 ≈ 39%，比满阶战魂（≈67%）弱一档
 * 想让称号整体更强/更弱只改 rate；升级价格见下面的 priceBase。
 */
export const titleGrowth = {
  /** 1 阶对应的等效角色等级 */
  fromLevel: 2,
  /** 满阶对应的等效角色等级 */
  toLevel: roleMaxLevel,
  /** 属性折扣率（再乘各系列 factor；战魂是 0.5，称号整体弱一档） */
  rate: 0.3,
  /** 升级价格基数：升到 N 阶消耗 priceBase × N²（战魂为 300 × N²，称号便宜一档） */
  priceBase: 200,
};

/** 阶 → 等效角色等级（线性映射，与 configs/soul 同一口径） */
function getEquivalentLevel(level: number): number {
  const span = Math.max(1, titleSources.length - 1);
  return titleGrowth.fromLevel + ((level - 1) / span) * (titleGrowth.toLevel - titleGrowth.fromLevel);
}

/** 把一份角色属性整体打 rate 折（区间上下限一起打折） */
function scaleAttributes(base: ReturnType<typeof getRoleLevelAttributes>, rate: number): TitleAttributes {
  const scale = (range: [number, number]): [number, number] => [Math.round(range[0] * rate), Math.round(range[1] * rate)];
  return {
    maxHp: Math.round(base.maxHp * rate),
    // 回血与血量同一口径打折（与 configs/soul 一致）
    hpRecover: Math.round(base.hpRecover * rate),
    physicalAttack: scale(base.physicalAttack),
    magicAttack: scale(base.magicAttack),
    taoistAttack: scale(base.taoistAttack),
    physicalDefense: scale(base.physicalDefense),
    magicDefense: scale(base.magicDefense),
    taoistDefense: scale(base.taoistDefense),
  };
}

/** 升级价格曲线：升到 N 阶消耗 priceBase × N²（N 越大越贵，跳档感与战魂一致） */
export function titleUpgradePrice(level: number): number {
  return Math.round(titleGrowth.priceBase * level * level);
}

/** 称号等级序列（level 从 1 开始连续，外观目录在 resources/titles 下） */
export const titleLevels: TitleLevelConfig[] = titleSources.map((source, index) => {
  const level = index + 1;
  const factor = source.factor;
  // 属性：取「等效等级」的角色裸属性整体打折（换个说法：称号相当于一个低你好几十级的角色在给你加成）
  const equivalentLevel = Math.round(getEquivalentLevel(level));
  return {
    level,
    label: source.label,
    description: source.description,
    bindGold: titleUpgradePrice(level),
    animation: `titles/sfx_${source.id}`,
    animationFrameRate: 10,
    attributes: scaleAttributes(getRoleLevelAttributes(equivalentLevel), titleGrowth.rate * factor),
  };
});

/** 称号满级 */
export const titleMaxLevel = titleLevels.length;

/**
 * 称号属性列表的显示名与顺序（称号弹窗右侧面板，与战魂同一套短名）
 * 数组即顺序，key 为 TitleAttributes 的字段名
 */
export const titleAttributeLabels: { key: keyof TitleAttributes; label: string }[] = [
  { key: "maxHp", label: "生命" },
  { key: "physicalAttack", label: "物攻" },
  { key: "magicAttack", label: "魔攻" },
  { key: "taoistAttack", label: "道攻" },
  { key: "physicalDefense", label: "物防" },
  { key: "magicDefense", label: "魔防" },
  { key: "taoistDefense", label: "道防" },
  { key: "hpRecover", label: "回血" },
];

/**
 * 取某等级的称号配置
 * @param level 称号等级（0 或负数返回 null，表示尚未激活称号）
 */
export function getTitleLevel(level: number): TitleLevelConfig | null {
  if (level < 1) return null;
  return titleLevels.find((config) => config.level === level) ?? null;
}
