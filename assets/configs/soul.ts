import type { SoulAttributes, SoulLevelConfig } from "../types/soul";
import { getRoleLevelAttributes, roleMaxLevel } from "./growth";

/**
 * 战魂配置（单一成长线）
 * 数据来自 resources/war-soul：sfx_13001 ~ sfx_13201 共 37 个散图帧目录，
 * 按外观由弱到强排成等级序列 1 ~ 37（下标 + 1 即等级）：
 * - sfx_13001~13020 灵体系（factor 1）
 * - sfx_13101~13115 兽魂/魔将系（factor 1.15）
 * - sfx_13200~13201 魔神系（factor 1.35）
 *
 * 属性**不在这里拍数值**，而是按阶映射到一个「等效角色等级」，取该等级的角色裸属性再打折
 * （见下面的 soulGrowth），这样 configs/growth 的等级曲线一改，战魂强度自动跟着走，
 * 不会出现「战魂比角色本人还强」或「升了几十阶毫无感觉」。
 */

/** 战魂外观源：resources/war-soul 下的目录编号 + 系列强度系数 */
interface SoulSource {
  /** 资源目录编号（目录名 = sfx_编号） */
  id: number;
  /** 系列强度系数（灵体 1 / 兽魂 1.15 / 魔神 1.35，换系列时属性小跳一档） */
  factor: number;
  /** 名称 */
  label: string;
  /** 描述 */
  description: string;
}

/** 战魂外观序列（顺序即等级顺序，来自 resources/war-soul 实际目录） */
const soulSources: SoulSource[] = [
  { id: 13001, factor: 1, label: "烈阳灵体", description: "周身缠绕金色光弧的战魂灵体，初醒便带着几分暖意。" },
  { id: 13002, factor: 1, label: "碧波灵体", description: "踏水而生的灵体，足下涟漪一圈圈荡开。" },
  { id: 13003, factor: 1, label: "寒霜灵体", description: "周身凝结冰棱的战魂，靠近便能感到彻骨寒意。" },
  { id: 13004, factor: 1, label: "沧澜灵体", description: "立于漩涡之上的灵体，掌中暗流涌动。" },
  { id: 13005, factor: 1, label: "紫电灵体", description: "电弧缠绕周身的战魂，出手时雷光乍现。" },
  { id: 13006, factor: 1, label: "烈焰灵体", description: "周身燃着不灭之火的灵体，所过之处留有余温。" },
  { id: 13007, factor: 1, label: "疾风灵体", description: "身形在风中若隐若现，仿佛下一刻便要散入风里。" },
  { id: 13008, factor: 1, label: "幻海灵体", description: "多臂张开的深海战魂，仿佛能掀起滔天巨浪。" },
  { id: 13009, factor: 1, label: "紫霄灵体", description: "背生紫翼的战魂，翼羽间电光隐现。" },
  { id: 13010, factor: 1, label: "玄波灵体", description: "由整片海水凝成的灵体，举手投足都带着潮汐之力。" },
  { id: 13011, factor: 1, label: "鎏金灵体", description: "金火缠身的灵体，威仪初显。" },
  { id: 13012, factor: 1, label: "沧浪灵体", description: "环抱水之力的战魂，身形如雾似水。" },
  { id: 13013, factor: 1, label: "碎冰灵体", description: "踏着碎冰与浪花而行的战魂，寒气凛冽。" },
  { id: 13014, factor: 1, label: "月华灵体", description: "月色般清冷的水之战魂，静谧而深邃。" },
  { id: 13015, factor: 1, label: "紫微灵体", description: "紫气环身的战魂，隐隐有星辰之力流转。" },
  { id: 13016, factor: 1, label: "流火灵体", description: "火光作裙的战魂，热情与危险并存。" },
  { id: 13017, factor: 1, label: "霜风灵体", description: "风雪簇拥的战魂，清冷孤傲。" },
  { id: 13018, factor: 1, label: "天羽灵体", description: "背生天羽的战魂，翼展之时如天神降临。" },
  { id: 13019, factor: 1, label: "紫鸢灵体", description: "紫翼如鸢的战魂，翱翔于雷霆之间。" },
  { id: 13020, factor: 1, label: "冥波灵体", description: "自冥海深处走出的灵体，双目如渊。" },
  { id: 13101, factor: 1.15, label: "寒渊魔将", description: "牛角魔将自寒渊苏醒，冰晶随其咆哮炸裂。" },
  { id: 13102, factor: 1.15, label: "碧涛兽魂", description: "形似蛟龙的兽魂，翻涌间碧涛四起。" },
  { id: 13103, factor: 1.15, label: "涌泉精魄", description: "体态娇小的水之精魄，力量却不容小觑。" },
  { id: 13104, factor: 1.15, label: "深渊魔灵", description: "自深渊攀爬而出的魔灵，水甲覆身刀枪不入。" },
  { id: 13105, factor: 1.15, label: "玄波兽魂", description: "狮形兽魂仰天长啸，声浪裹挟玄波震荡四野。" },
  { id: 13106, factor: 1.15, label: "青藤古灵", description: "古藤缠绕的木灵，生机之中暗藏杀机。" },
  { id: 13107, factor: 1.15, label: "翠灵", description: "翠色欲滴的草木之灵，静谧中蕴藏伟力。" },
  { id: 13108, factor: 1.15, label: "紫煞魔灵", description: "紫煞凝成的魔灵，触须所及皆化焦土。" },
  { id: 13109, factor: 1.15, label: "圣光天使", description: "金翼天使降临，圣光涤荡一切邪祟。" },
  { id: 13110, factor: 1.15, label: "金曜兽魂", description: "曜金狼魂疾驰如电，爪风撕裂长空。" },
  { id: 13111, factor: 1.15, label: "炎狱兽魂", description: "自炎狱走出的火兽，足下大地皆成熔岩。" },
  { id: 13112, factor: 1.15, label: "熔金鳞皇", description: "鳞甲如熔金的兽皇，一声低吼百兽俯首。" },
  { id: 13113, factor: 1.15, label: "赤炎兽魂", description: "赤焰裹身的兽魂，狂性不改战意滔天。" },
  { id: 13114, factor: 1.15, label: "血煞魔将", description: "血色魔将横刀而立，煞气冲霄。" },
  { id: 13115, factor: 1.15, label: "炽血魔君", description: "执斧魔君战意如炽，血色残影令敌胆寒。" },
  { id: 13200, factor: 1.35, label: "血翼魔神", description: "双翼遮天的魔神，血色光辉之下众生俯首。" },
  { id: 13201, factor: 1.35, label: "灭世魔神", description: "战魂的最终形态，紫芒刺破苍穹，世称灭世。" },
];

/**
 * 战魂强度曲线（战魂属性 = 等效等级的角色裸属性 × rate × 系列 factor）
 * - 1 阶 ≈ 2 级角色（刚激活时只是象征性加成）
 * - 满阶 37 阶 ≈ 60 级角色的 0.5 × 1.35 ≈ 67%，相当于多穿一套满级裸装
 * 想让战魂整体更强/更弱只改 rate；想让成长更陡就把 toLevel 往上顶（等效等级提前拉满）。
 */
export const soulGrowth = {
  /** 1 阶对应的等效角色等级 */
  fromLevel: 2,
  /** 满阶对应的等效角色等级 */
  toLevel: roleMaxLevel,
  /** 属性折扣率（再乘各系列 factor） */
  rate: 0.5,
};

/** 阶 → 等效角色等级（线性映射） */
function getEquivalentLevel(level: number): number {
  const span = Math.max(1, soulSources.length - 1);
  return soulGrowth.fromLevel + ((level - 1) / span) * (soulGrowth.toLevel - soulGrowth.fromLevel);
}

/** 把一份角色属性整体打 rate 折（区间上下限一起打折） */
function scaleAttributes(base: ReturnType<typeof getRoleLevelAttributes>, rate: number) {
  const scale = (range: [number, number]): [number, number] => [Math.round(range[0] * rate), Math.round(range[1] * rate)];
  return {
    maxHp: Math.round(base.maxHp * rate),
    physicalAttack: scale(base.physicalAttack),
    magicAttack: scale(base.magicAttack),
    taoistAttack: scale(base.taoistAttack),
    physicalDefense: scale(base.physicalDefense),
    magicDefense: scale(base.magicDefense),
    taoistDefense: scale(base.taoistDefense),
  };
}

/** 战魂等级序列（level 从 1 开始连续，外观目录在 resources/war-soul 下） */
export const soulLevels: SoulLevelConfig[] = soulSources.map((source, index) => {
  const level = index + 1;
  const factor = source.factor;
  // 属性：取「等效等级」的角色裸属性整体打折（换个说法：战魂相当于一个低你好几十级的角色在给你加成）
  const equivalentLevel = Math.round(getEquivalentLevel(level));
  return {
    level,
    label: source.label,
    description: source.description,
    // 升级消耗：等级越高越贵（想手调改成字面量即可）
    bindGold: 300 * level * level,
    animation: `war-soul/sfx_${source.id}`,
    animationFrameRate: 10,
    attributes: scaleAttributes(getRoleLevelAttributes(equivalentLevel), soulGrowth.rate * factor),
  };
});

/** 战魂满级 */
export const soulMaxLevel = soulLevels.length;

/**
 * 战魂属性列表的显示名与顺序（战魂弹窗右侧面板）
 * 用短名（生命/物攻…）：面板窄，且与角色信息弹窗的属性列表（configs/good.goodShowAttributesLabel 全名）互不干扰
 * 数组即顺序，key 为 SoulAttributes 的字段名
 */
export const soulAttributeLabels: { key: keyof SoulAttributes; label: string }[] = [
  { key: "maxHp", label: "生命" },
  { key: "physicalAttack", label: "物攻" },
  { key: "magicAttack", label: "魔攻" },
  { key: "taoistAttack", label: "道攻" },
  { key: "physicalDefense", label: "物防" },
  { key: "magicDefense", label: "魔防" },
  { key: "taoistDefense", label: "道防" },
];

/**
 * 取某等级的战魂配置
 * @param level 战魂等级（0 或负数返回 null，表示尚未激活战魂）
 */
export function getSoulLevel(level: number): SoulLevelConfig | null {
  if (level < 1) return null;
  return soulLevels.find((config) => config.level === level) ?? null;
}
