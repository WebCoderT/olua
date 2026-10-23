import type { SoulAttributes, SoulLevelConfig } from "../types/soul";

/**
 * 战魂配置（单一成长线）
 * 数据来自 resources/war-soul：sfx_13001 ~ sfx_13201 共 37 个散图帧目录，
 * 按外观由弱到强排成等级序列 1 ~ 37（下标 + 1 即等级）：
 * - sfx_13001~13020 灵体系（factor 1）
 * - sfx_13101~13115 兽魂/魔将系（factor 1.15）
 * - sfx_13200~13201 魔神系（factor 1.35）
 *
 * 属性与升级消耗是**逐级明文表**（issue #17），不再由运行时公式推导：
 * 两张表按「等效等级映射」的公式一次性冻结而来（1 阶 ≈ 2 级角色、37 阶 ≈ 60 级角色的
 * 0.5 × 1.35 ≈ 67.5%，冻结于 2026-10-23，当时的三条成长线排序 称号 39% < 军衔 52.5% < 战魂 67.5% 由此保持），
 * 之后**想调哪一阶就改哪一行** —— 等级曲线（configs/growth）再怎么改，战魂强度也不会被动漂移。
 * 全量重导出的旧公式只活在 git 历史里；满阶收益排序的口径见本文件末尾的 soulMaxLevel 注释与 test-soul-growth.cjs。
 */

/** 战魂外观源：resources/war-soul 下的目录编号 + 系列强度系数（系数只说明系列定位，数值已冻结进属性表） */
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

/** 升到 N 阶战魂的消耗（绑定元宝；下标 0 = 升到 1 阶，数组长度 = 满阶） */
export const soulUpgradeCosts: number[] = [
  300, // 1 阶 · 烈阳灵体
  1200, // 2 阶 · 碧波灵体
  2700, // 3 阶 · 寒霜灵体
  4800, // 4 阶 · 沧澜灵体
  7500, // 5 阶 · 紫电灵体
  10800, // 6 阶 · 烈焰灵体
  14700, // 7 阶 · 疾风灵体
  19200, // 8 阶 · 幻海灵体
  24300, // 9 阶 · 紫霄灵体
  30000, // 10 阶 · 玄波灵体
  36300, // 11 阶 · 鎏金灵体
  43200, // 12 阶 · 沧浪灵体
  50700, // 13 阶 · 碎冰灵体
  58800, // 14 阶 · 月华灵体
  67500, // 15 阶 · 紫微灵体
  76800, // 16 阶 · 流火灵体
  86700, // 17 阶 · 霜风灵体
  97200, // 18 阶 · 天羽灵体
  108300, // 19 阶 · 紫鸢灵体
  120000, // 20 阶 · 冥波灵体
  132300, // 21 阶 · 寒渊魔将
  145200, // 22 阶 · 碧涛兽魂
  158700, // 23 阶 · 涌泉精魄
  172800, // 24 阶 · 深渊魔灵
  187500, // 25 阶 · 玄波兽魂
  202800, // 26 阶 · 青藤古灵
  218700, // 27 阶 · 翠灵
  235200, // 28 阶 · 紫煞魔灵
  252300, // 29 阶 · 圣光天使
  270000, // 30 阶 · 金曜兽魂
  288300, // 31 阶 · 炎狱兽魂
  307200, // 32 阶 · 熔金鳞皇
  326700, // 33 阶 · 赤炎兽魂
  346800, // 34 阶 · 血煞魔将
  367500, // 35 阶 · 炽血魔君
  388800, // 36 阶 · 血翼魔神
  410700, // 37 阶 · 灭世魔神
];

/**
 * 每阶战魂的属性加成（下标 0 = 1 阶；数组长度 = 满阶）
 * 区间与角色属性同口径：[下限, 上限]
 */
const soulLevelAttributes: SoulAttributes[] = [
  { maxHp: 59, physicalAttack: [9, 12], magicAttack: [9, 12], taoistAttack: [9, 12], physicalDefense: [3, 4], magicDefense: [3, 4], taoistDefense: [3, 4], hpRecover: 1 }, // 1 阶 · 烈阳灵体
  { maxHp: 77, physicalAttack: [11, 16], magicAttack: [11, 16], taoistAttack: [11, 16], physicalDefense: [3, 5], magicDefense: [3, 5], taoistDefense: [3, 5], hpRecover: 1 }, // 2 阶 · 碧波灵体
  { maxHp: 86, physicalAttack: [13, 18], magicAttack: [13, 18], taoistAttack: [13, 18], physicalDefense: [4, 5], magicDefense: [4, 5], taoistDefense: [4, 5], hpRecover: 1 }, // 3 阶 · 寒霜灵体
  { maxHp: 104, physicalAttack: [16, 22], magicAttack: [16, 22], taoistAttack: [16, 22], physicalDefense: [4, 6], magicDefense: [4, 6], taoistDefense: [4, 6], hpRecover: 1 }, // 4 阶 · 沧澜灵体
  { maxHp: 113, physicalAttack: [17, 24], magicAttack: [17, 24], taoistAttack: [17, 24], physicalDefense: [5, 7], magicDefense: [5, 7], taoistDefense: [5, 7], hpRecover: 1 }, // 5 阶 · 紫电灵体
  { maxHp: 131, physicalAttack: [20, 28], magicAttack: [20, 28], taoistAttack: [20, 28], physicalDefense: [6, 8], magicDefense: [6, 8], taoistDefense: [6, 8], hpRecover: 2 }, // 6 阶 · 烈焰灵体
  { maxHp: 195, physicalAttack: [26, 37], magicAttack: [26, 37], taoistAttack: [26, 37], physicalDefense: [8, 11], magicDefense: [8, 11], taoistDefense: [8, 11], hpRecover: 2 }, // 7 阶 · 疾风灵体
  { maxHp: 224, physicalAttack: [30, 42], magicAttack: [30, 42], taoistAttack: [30, 42], physicalDefense: [9, 12], magicDefense: [9, 12], taoistDefense: [9, 12], hpRecover: 2 }, // 8 阶 · 幻海灵体
  { maxHp: 283, physicalAttack: [37, 53], magicAttack: [37, 53], taoistAttack: [37, 53], physicalDefense: [11, 15], magicDefense: [11, 15], taoistDefense: [11, 15], hpRecover: 3 }, // 9 阶 · 紫霄灵体
  { maxHp: 342, physicalAttack: [45, 64], magicAttack: [45, 64], taoistAttack: [45, 64], physicalDefense: [13, 18], magicDefense: [13, 18], taoistDefense: [13, 18], hpRecover: 4 }, // 10 阶 · 玄波灵体
  { maxHp: 372, physicalAttack: [49, 70], magicAttack: [49, 70], taoistAttack: [49, 70], physicalDefense: [14, 20], magicDefense: [14, 20], taoistDefense: [14, 20], hpRecover: 4 }, // 11 阶 · 鎏金灵体
  { maxHp: 431, physicalAttack: [57, 81], magicAttack: [57, 81], taoistAttack: [57, 81], physicalDefense: [16, 23], magicDefense: [16, 23], taoistDefense: [16, 23], hpRecover: 5 }, // 12 阶 · 沧浪灵体
  { maxHp: 540, physicalAttack: [65, 92], magicAttack: [65, 92], taoistAttack: [65, 92], physicalDefense: [20, 28], magicDefense: [20, 28], taoistDefense: [20, 28], hpRecover: 6 }, // 13 阶 · 碎冰灵体
  { maxHp: 732, physicalAttack: [88, 125], magicAttack: [88, 125], taoistAttack: [88, 125], physicalDefense: [27, 38], magicDefense: [27, 38], taoistDefense: [27, 38], hpRecover: 8 }, // 14 阶 · 月华灵体
  { maxHp: 924, physicalAttack: [111, 158], magicAttack: [111, 158], taoistAttack: [111, 158], physicalDefense: [34, 48], magicDefense: [34, 48], taoistDefense: [34, 48], hpRecover: 9 }, // 15 阶 · 紫微灵体
  { maxHp: 1020, physicalAttack: [122, 175], magicAttack: [122, 175], taoistAttack: [122, 175], physicalDefense: [37, 53], magicDefense: [37, 53], taoistDefense: [37, 53], hpRecover: 10 }, // 16 阶 · 流火灵体
  { maxHp: 1212, physicalAttack: [146, 208], magicAttack: [146, 208], taoistAttack: [146, 208], physicalDefense: [44, 63], magicDefense: [44, 63], taoistDefense: [44, 63], hpRecover: 12 }, // 17 阶 · 霜风灵体
  { maxHp: 1308, physicalAttack: [157, 224], magicAttack: [157, 224], taoistAttack: [157, 224], physicalDefense: [48, 68], magicDefense: [48, 68], taoistDefense: [48, 68], hpRecover: 13 }, // 18 阶 · 天羽灵体
  { maxHp: 1760, physicalAttack: [193, 275], magicAttack: [193, 275], taoistAttack: [193, 275], physicalDefense: [58, 83], magicDefense: [58, 83], taoistDefense: [58, 83], hpRecover: 18 }, // 19 阶 · 紫鸢灵体
  { maxHp: 2390, physicalAttack: [263, 375], magicAttack: [263, 375], taoistAttack: [263, 375], physicalDefense: [79, 113], magicDefense: [79, 113], taoistDefense: [79, 113], hpRecover: 24 }, // 20 阶 · 冥波灵体
  { maxHp: 3111, physicalAttack: [342, 489], magicAttack: [342, 489], taoistAttack: [342, 489], physicalDefense: [103, 147], magicDefense: [103, 147], taoistDefense: [103, 147], hpRecover: 31 }, // 21 阶 · 寒渊魔将
  { maxHp: 3835, physicalAttack: [423, 604], magicAttack: [423, 604], taoistAttack: [423, 604], physicalDefense: [127, 181], magicDefense: [127, 181], taoistDefense: [127, 181], hpRecover: 39 }, // 22 阶 · 碧涛兽魂
  { maxHp: 4198, physicalAttack: [463, 661], magicAttack: [463, 661], taoistAttack: [463, 661], physicalDefense: [139, 198], magicDefense: [139, 198], taoistDefense: [139, 198], hpRecover: 42 }, // 23 阶 · 涌泉精魄
  { maxHp: 4922, physicalAttack: [543, 776], magicAttack: [543, 776], taoistAttack: [543, 776], physicalDefense: [163, 233], magicDefense: [163, 233], taoistDefense: [163, 233], hpRecover: 49 }, // 24 阶 · 深渊魔灵
  { maxHp: 6612, physicalAttack: [664, 949], magicAttack: [664, 949], taoistAttack: [664, 949], physicalDefense: [200, 285], magicDefense: [200, 285], taoistDefense: [200, 285], hpRecover: 66 }, // 25 阶 · 玄波兽魂
  { maxHp: 7803, physicalAttack: [781, 1116], magicAttack: [781, 1116], taoistAttack: [781, 1116], physicalDefense: [234, 335], magicDefense: [234, 335], taoistDefense: [234, 335], hpRecover: 78 }, // 26 阶 · 青藤古灵
  { maxHp: 10183, physicalAttack: [1014, 1449], magicAttack: [1014, 1449], taoistAttack: [1014, 1449], physicalDefense: [304, 435], magicDefense: [304, 435], taoistDefense: [304, 435], hpRecover: 102 }, // 27 阶 · 翠灵
  { maxHp: 12564, physicalAttack: [1248, 1782], magicAttack: [1248, 1782], taoistAttack: [1248, 1782], physicalDefense: [374, 535], magicDefense: [374, 535], taoistDefense: [374, 535], hpRecover: 126 }, // 28 阶 · 紫煞魔灵
  { maxHp: 13754, physicalAttack: [1364, 1949], magicAttack: [1364, 1949], taoistAttack: [1364, 1949], physicalDefense: [409, 585], magicDefense: [409, 585], taoistDefense: [409, 585], hpRecover: 137 }, // 29 阶 · 圣光天使
  { maxHp: 16134, physicalAttack: [1598, 2283], magicAttack: [1598, 2283], taoistAttack: [1598, 2283], physicalDefense: [480, 685], magicDefense: [480, 685], taoistDefense: [480, 685], hpRecover: 162 }, // 30 阶 · 金曜兽魂
  { maxHp: 17325, physicalAttack: [1715, 2450], magicAttack: [1715, 2450], taoistAttack: [1715, 2450], physicalDefense: [515, 735], magicDefense: [515, 735], taoistDefense: [515, 735], hpRecover: 173 }, // 31 阶 · 炎狱兽魂
  { maxHp: 25576, physicalAttack: [2278, 3254], magicAttack: [2278, 3254], taoistAttack: [2278, 3254], physicalDefense: [684, 976], magicDefense: [684, 976], taoistDefense: [684, 976], hpRecover: 256 }, // 32 阶 · 熔金鳞皇
  { maxHp: 33373, physicalAttack: [2970, 4244], magicAttack: [2970, 4244], taoistAttack: [2970, 4244], physicalDefense: [891, 1273], magicDefense: [891, 1273], taoistDefense: [891, 1273], hpRecover: 334 }, // 33 阶 · 赤炎兽魂
  { maxHp: 37272, physicalAttack: [3317, 4738], magicAttack: [3317, 4738], taoistAttack: [3317, 4738], physicalDefense: [995, 1421], magicDefense: [995, 1421], taoistDefense: [995, 1421], hpRecover: 373 }, // 34 阶 · 血煞魔将
  { maxHp: 45069, physicalAttack: [4009, 5727], magicAttack: [4009, 5727], taoistAttack: [4009, 5727], physicalDefense: [1203, 1718], magicDefense: [1203, 1718], taoistDefense: [1203, 1718], hpRecover: 451 }, // 35 阶 · 炽血魔君
  { maxHp: 57483, physicalAttack: [5112, 7304], magicAttack: [5112, 7304], taoistAttack: [5112, 7304], physicalDefense: [1534, 2191], magicDefense: [1534, 2191], taoistDefense: [1534, 2191], hpRecover: 575 }, // 36 阶 · 血翼魔神
  { maxHp: 66636, physicalAttack: [5925, 8465], magicAttack: [5925, 8465], taoistAttack: [5925, 8465], physicalDefense: [1777, 2539], magicDefense: [1777, 2539], taoistDefense: [1777, 2539], hpRecover: 666 }, // 37 阶 · 灭世魔神
];

// 两张表必须与外观序列一一对齐（错位会让某阶拿不到消耗或属性，在别处表现为 undefined 静默失效）
if (soulUpgradeCosts.length !== soulSources.length || soulLevelAttributes.length !== soulSources.length) {
  throw new Error(
    `soul 配置错位：消耗 ${soulUpgradeCosts.length} 条 / 属性 ${soulLevelAttributes.length} 条 ≠ 外观 ${soulSources.length} 阶（改表时逐阶一起改）`,
  );
}

/** 战魂等级序列（level 从 1 开始连续，外观目录在 resources/war-soul 下；消耗与属性取上面的逐级明文表） */
export const soulLevels: SoulLevelConfig[] = soulSources.map((source, index) => ({
  level: index + 1,
  label: source.label,
  description: source.description,
  bindGold: soulUpgradeCosts[index],
  animation: `war-soul/sfx_${source.id}`,
  animationFrameRate: 10,
  attributes: soulLevelAttributes[index],
}));

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
  { key: "hpRecover", label: "回血" },
];

/**
 * 取某等级的战魂配置
 * @param level 战魂等级（0 或负数返回 null，表示尚未激活战魂）
 */
export function getSoulLevel(level: number): SoulLevelConfig | null {
  if (level < 1) return null;
  return soulLevels.find((config) => config.level === level) ?? null;
}
