/**
 * 怪物出厂数值种子（#588）—— **服务端独有，客户端没有这份文件**
 *
 * 数值归属边界（#586 定三层、#588 收口）：怪物的**数值**（label / level / tier，以及
 * 由它们展开的 maxHp / 六项攻防）唯一的家在这里 + `monsters` 表 —— 客户端
 * `configs/monster` 只留资源与表现（icon / out / 几何 / 移动 / AI 参数），运行时
 * 数值全部来自 `GET /game-config` 快照。想改数值：改管理端（`PATCH /admin/monsters/:id`）；
 * 想改**出厂值**：改这份文件然后重启（`seedRow` 是 INSERT OR IGNORE，只补新 key，
 * 已有行不会回滚 —— 出厂值只服务空库，这是有意的）。
 *
 * 每行只写**紧凑四元组**：maxHp 与六项攻防不手写，由 `expandMonsterSeed` 按成长曲线展开
 * （口径 = 原客户端 configs/growth 的 monsterStats：「血量 = 角色要打几刀」反推，
 * 曲线本身来自 game-data.generated 的 ROLE_LEVEL_ATTRIBUTES —— 客户端角色曲线仍是唯一来源，
 * 这里不做第二份曲线）。220 只怪在拆分时逐只验证过：展开结果与原快照逐字节一致、零条目覆盖。
 *
 * 加一只怪 = ① 素材入库跑 tools/gen-monster-config.cjs（客户端资源条目）
 *           ② 这里加一行（数值，唯一要写数值的地方）
 *           ③ 重启服务端（新 key 自动 seed 进表）。
 */

import { GROWTH_SCALARS, ROLE_LEVEL_ATTRIBUTES } from "./growth-seed";

/** 怪物定位（决定同等级下的强度倍率，见 MONSTER_TIER_SCALE） */
export type MonsterSeedTier = "normal" | "elite" | "boss";

/** 出厂种子行：紧凑四元组，数值由 expandMonsterSeed 展开 */
export interface MonsterSeedRow {
  /** 关联键（地图对象组 / 掉落 / 技能引用它；与客户端资源条目的 key 一致） */
  id: string;
  /** 名称（管理端列表与任务文案展示） */
  label: string;
  /** 等级（唯一定级入口） */
  level: number;
  /** 定位：normal / elite / boss */
  tier: MonsterSeedTier;
}

export const MONSTER_SEED_ROWS: MonsterSeedRow[] = [
  { id: "1", label: "赤焰斗鸡", level: 1, tier: "normal" },
  { id: "2", label: "金斑雄鹿", level: 1, tier: "normal" },
  { id: "3", label: "干尸行者", level: 2, tier: "normal" },
  { id: "4", label: "豺狼人巫师", level: 2, tier: "normal" },
  { id: "5", label: "狮头人术士", level: 2, tier: "normal" },
  { id: "6", label: "巨疣蟾蜍", level: 2, tier: "normal" },
  { id: "7", label: "碎骨残骸", level: 3, tier: "normal" },
  { id: "8", label: "牛角骷髅将", level: 3, tier: "normal" },
  { id: "9", label: "骨锤蛮兵", level: 3, tier: "normal" },
  { id: "10", label: "血赤骷髅", level: 4, tier: "normal" },
  { id: "11", label: "龟甲忍士", level: 4, tier: "normal" },
  { id: "12", label: "雪岭野人", level: 4, tier: "normal" },
  { id: "13", label: "黑猿妖", level: 5, tier: "normal" },
  { id: "14", label: "猛犸巨象", level: 5, tier: "normal" },
  { id: "15", label: "黑翼巨蝠", level: 5, tier: "normal" },
  { id: "16", label: "海螺精", level: 5, tier: "normal" },
  { id: "17", label: "金甲独角仙", level: 6, tier: "normal" },
  { id: "18", label: "金翅灵鸟", level: 6, tier: "normal" },
  { id: "19", label: "沙岗蠕虫", level: 6, tier: "normal" },
  { id: "20", label: "野狼", level: 7, tier: "normal" },
  { id: "21", label: "盘角羚羊", level: 7, tier: "normal" },
  { id: "22", label: "灰壳蛞蝓", level: 7, tier: "normal" },
  { id: "23", label: "独腿尸兵", level: 8, tier: "normal" },
  { id: "24", label: "血污行尸", level: 8, tier: "normal" },
  { id: "25", label: "枯叶飞虫群", level: 8, tier: "normal" },
  { id: "26", label: "枯行僧尸", level: 8, tier: "normal" },
  { id: "27", label: "食人妖花", level: 9, tier: "normal" },
  { id: "28", label: "金环蛇", level: 9, tier: "normal" },
  { id: "29", label: "赤练蛇", level: 9, tier: "normal" },
  { id: "30", label: "枯树妖", level: 10, tier: "normal" },
  { id: "31", label: "蘑菇精", level: 10, tier: "normal" },
  { id: "32", label: "黄甲多足虫", level: 10, tier: "normal" },
  { id: "33", label: "铜甲巨蝎", level: 11, tier: "normal" },
  { id: "34", label: "碎尸爬虫", level: 11, tier: "normal" },
  { id: "35", label: "赤蜈蚣", level: 11, tier: "normal" },
  { id: "36", label: "黄蜂妖", level: 11, tier: "normal" },
  { id: "37", label: "蜣螂精", level: 12, tier: "normal" },
  { id: "38", label: "虾兵怪", level: 12, tier: "normal" },
  { id: "39", label: "银甲蝎蛉", level: 12, tier: "normal" },
  { id: "40", label: "青竹大蜈蚣", level: 13, tier: "normal" },
  { id: "41", label: "金沙傀儡", level: 13, tier: "normal" },
  { id: "42", label: "绿袍兽人武者", level: 13, tier: "normal" },
  { id: "43", label: "牛角兽人斧手", level: 14, tier: "normal" },
  { id: "44", label: "白衣幽魂", level: 14, tier: "normal" },
  { id: "45", label: "幽冥触手魔", level: 14, tier: "normal" },
  { id: "46", label: "金色海星妖", level: 14, tier: "normal" },
  { id: "47", label: "灰毛猩猩兽", level: 15, tier: "normal" },
  { id: "48", label: "车轮骨妖", level: 15, tier: "normal" },
  { id: "49", label: "链锤夜叉", level: 15, tier: "normal" },
  { id: "50", label: "赤炎小恶魔", level: 16, tier: "normal" },
  { id: "51", label: "双斧狼卫", level: 16, tier: "normal" },
  { id: "52", label: "绿眼飞蛾妖", level: 16, tier: "normal" },
  { id: "53", label: "滑翔飞蜥", level: 16, tier: "normal" },
  { id: "54", label: "坠马骸骑兵", level: 17, tier: "normal" },
  { id: "55", label: "持戟猪首人", level: 17, tier: "normal" },
  { id: "56", label: "雷锤铁卫", level: 17, tier: "normal" },
  { id: "57", label: "赤膊狂猿", level: 18, tier: "normal" },
  { id: "58", label: "黑熊罴怪", level: 18, tier: "normal" },
  { id: "59", label: "赤须龙蜈", level: 18, tier: "normal" },
  { id: "60", label: "黑鳞龙裔", level: 19, tier: "normal" },
  { id: "61", label: "骨角黄巨魔", level: 19, tier: "normal" },
  { id: "62", label: "灰肤巨魔", level: 19, tier: "normal" },
  { id: "63", label: "赤鳞怪胎", level: 19, tier: "normal" },
  { id: "64", label: "青鳞怪胎", level: 20, tier: "normal" },
  { id: "65", label: "紫黑蟹蛛", level: 20, tier: "normal" },
  { id: "66", label: "金斑飞蝎", level: 20, tier: "normal" },
  { id: "67", label: "沙尘鬼", level: 21, tier: "normal" },
  { id: "68", label: "金牛甲士", level: 21, tier: "normal" },
  { id: "69", label: "紫甲双锤兵", level: 21, tier: "normal" },
  { id: "70", label: "黑甲长斧魔", level: 22, tier: "normal" },
  { id: "71", label: "银甲月刃枪卫", level: 22, tier: "normal" },
  { id: "72", label: "红袍蛇杖法老", level: 22, tier: "normal" },
  { id: "73", label: "陷坑野牛魔", level: 22, tier: "normal" },
  { id: "74", label: "土狼妖", level: 23, tier: "normal" },
  { id: "75", label: "青锋刀客", level: 23, tier: "normal" },
  { id: "76", label: "青蛙斗士", level: 23, tier: "normal" },
  { id: "77", label: "独眼触手魔", level: 24, tier: "normal" },
  { id: "78", label: "碧爪蛛母", level: 24, tier: "normal" },
  { id: "79", label: "碎金甲兵", level: 24, tier: "normal" },
  { id: "80", label: "黄袍圣甲虫", level: 25, tier: "normal" },
  { id: "81", label: "黄蜂后", level: 25, tier: "normal" },
  { id: "82", label: "铁壳蝼蛄", level: 25, tier: "normal" },
  { id: "83", label: "犀甲巨蚁", level: 25, tier: "normal" },
  { id: "84", label: "白骨披甲将", level: 26, tier: "normal" },
  { id: "85", label: "焰翅魔将", level: 26, tier: "normal" },
  { id: "86", label: "战旗兽人", level: 26, tier: "normal" },
  { id: "87", label: "碎铁石堆怪", level: 27, tier: "normal" },
  { id: "88", label: "血晶碎块怪", level: 27, tier: "normal" },
  { id: "89", label: "骨翅飞妖", level: 27, tier: "normal" },
  { id: "90", label: "骨爪爬魔", level: 28, tier: "normal" },
  { id: "91", label: "碎石傀儡", level: 28, tier: "normal" },
  { id: "92", label: "妖娆花魁女妖", level: 28, tier: "normal" },
  { id: "93", label: "青翼仙子", level: 28, tier: "normal" },
  { id: "94", label: "金冠飞刀侠", level: 29, tier: "normal" },
  { id: "95", label: "金甲持锤武圣", level: 29, tier: "normal" },
  { id: "96", label: "蓝翼法灵", level: 29, tier: "normal" },
  { id: "97", label: "白甲弓手", level: 30, tier: "normal" },
  { id: "98", label: "银甲白狼灵", level: 30, tier: "normal" },
  { id: "99", label: "枯骨废墟堆", level: 30, tier: "normal" },
  { id: "100", label: "白袍行者", level: 31, tier: "normal" },
  { id: "101", label: "黑铁锁链魔", level: 31, tier: "normal" },
  { id: "102", label: "金斧矮人酋长", level: 31, tier: "normal" },
  { id: "103", label: "白骨蛇", level: 31, tier: "normal" },
  { id: "104", label: "独眼巨魔", level: 32, tier: "normal" },
  { id: "105", label: "骨翼蝠魔", level: 32, tier: "normal" },
  { id: "106", label: "棕毛跳猿兽", level: 32, tier: "normal" },
  { id: "107", label: "白毛狼牙锤怪", level: 33, tier: "normal" },
  { id: "108", label: "电光双鞭将", level: 33, tier: "normal" },
  { id: "109", label: "金冠弯刀卫", level: 33, tier: "normal" },
  { id: "110", label: "血蛛后", level: 33, tier: "normal" },
  { id: "111", label: "碎金残兵堆", level: 34, tier: "normal" },
  { id: "112", label: "骨杖蛮巫", level: 34, tier: "normal" },
  { id: "113", label: "牛角红袍祭司", level: 34, tier: "normal" },
  { id: "114", label: "冰晶翼灵", level: 35, tier: "normal" },
  { id: "115", label: "赤肌血魔", level: 35, tier: "normal" },
  { id: "116", label: "金环武僧", level: 35, tier: "normal" },
  { id: "117", label: "机关木偶", level: 36, tier: "normal" },
  { id: "118", label: "红袍披风鬼将", level: 36, tier: "normal" },
  { id: "119", label: "悬空剑灵", level: 36, tier: "normal" },
  { id: "120", label: "金莲法阵", level: 36, tier: "normal" },
  { id: "121", label: "断戟残卒堆", level: 37, tier: "normal" },
  { id: "122", label: "赤凰翔灵", level: 37, tier: "normal" },
  { id: "123", label: "蓝冰晶簇", level: 37, tier: "normal" },
  { id: "124", label: "金冠法王", level: 38, tier: "normal" },
  { id: "125", label: "藤蔓树魔", level: 38, tier: "normal" },
  { id: "126", label: "缟素女鬼", level: 38, tier: "normal" },
  { id: "127", label: "巨翼骨蝠王", level: 39, tier: "normal" },
  { id: "128", label: "皮甲猎弓手", level: 39, tier: "normal" },
  { id: "129", label: "金甲长枪灵", level: 39, tier: "normal" },
  { id: "130", label: "双锤牛魔", level: 39, tier: "normal" },
  { id: "131", label: "尸骸兵器冢", level: 40, tier: "normal" },
  { id: "132", label: "焰发女妖", level: 40, tier: "normal" },
  { id: "133", label: "金链骷髅阵", level: 40, tier: "normal" },
  { id: "134", label: "粉晶机关兽", level: 41, tier: "normal" },
  { id: "135", label: "金蟾精", level: 41, tier: "normal" },
  { id: "136", label: "冰杖法童", level: 41, tier: "normal" },
  { id: "137", label: "提灯行商怪", level: 42, tier: "normal" },
  { id: "138", label: "绿杖树精", level: 42, tier: "normal" },
  { id: "139", label: "双筒火铳魔", level: 42, tier: "normal" },
  { id: "140", label: "白狐少女妖", level: 42, tier: "normal" },
  { id: "141", label: "金轮骨僧", level: 43, tier: "normal" },
  { id: "142", label: "碧鳞蛟龙", level: 43, tier: "normal" },
  { id: "143", label: "金纹道人", level: 43, tier: "normal" },
  { id: "144", label: "枯骨翼妖", level: 44, tier: "normal" },
  { id: "145", label: "黑棘龙兽", level: 44, tier: "normal" },
  { id: "146", label: "紫电武魂", level: 44, tier: "normal" },
  { id: "147", label: "莲台鲛人", level: 45, tier: "normal" },
  { id: "148", label: "血刃狂魔", level: 45, tier: "normal" },
  { id: "149", label: "骨幡妖将", level: 45, tier: "normal" },
  { id: "150", label: "翠纹飞蜥", level: 45, tier: "normal" },
  { id: "151", label: "血翼蝠群", level: 46, tier: "normal" },
  { id: "152", label: "金鬃瑞狮", level: 46, tier: "normal" },
  { id: "153", label: "独眼锤魔", level: 46, tier: "normal" },
  { id: "154", label: "长尾铁蝎", level: 47, tier: "normal" },
  { id: "155", label: "血羽战鹰", level: 47, tier: "normal" },
  { id: "156", label: "血雾散魂", level: 47, tier: "normal" },
  { id: "157", label: "金甲骁将", level: 47, tier: "normal" },
  { id: "158", label: "赤尾巨蝎", level: 48, tier: "normal" },
  { id: "159", label: "橙腹长脚蛛", level: 48, tier: "normal" },
  { id: "160", label: "缚链石魔", level: 48, tier: "normal" },
  { id: "161", label: "伏地金蟾", level: 49, tier: "normal" },
  { id: "162", label: "吐钱金蟾", level: 49, tier: "normal" },
  { id: "163", label: "倾覆货车怪", level: 49, tier: "normal" },
  { id: "164", label: "翻车货担怪", level: 50, tier: "normal" },
  { id: "165", label: "侧翻车厢怪", level: 50, tier: "normal" },
  { id: "166", label: "攻城战车怪", level: 50, tier: "normal" },
  { id: "167", label: "冲车机关怪", level: 50, tier: "normal" },
  { id: "168", label: "赤羽斗鸡", level: 51, tier: "normal" },
  { id: "169", label: "金斑幼鹿", level: 51, tier: "normal" },
  { id: "170", label: "枯瘦黄衣行者", level: 51, tier: "normal" },
  { id: "171", label: "举臂长毛猿", level: 52, tier: "normal" },
  { id: "172", label: "藤杖猴妖", level: 52, tier: "normal" },
  { id: "173", label: "象鼻地獾", level: 52, tier: "normal" },
  { id: "174", label: "白骨行尸", level: 53, tier: "normal" },
  { id: "175", label: "持斧骷髅卫", level: 53, tier: "normal" },
  { id: "176", label: "持锄白毛猿", level: 53, tier: "normal" },
  { id: "177", label: "血爪夜叉", level: 53, tier: "normal" },
  { id: "178", label: "灰甲蝼蛄", level: 54, tier: "normal" },
  { id: "179", label: "金龟甲虫", level: 54, tier: "normal" },
  { id: "180", label: "金翎鸟灵", level: 54, tier: "normal" },
  { id: "181", label: "黄斑腐尸", level: 55, tier: "normal" },
  { id: "182", label: "破衲行者", level: 55, tier: "normal" },
  { id: "183", label: "螺蛳灰虫", level: 55, tier: "normal" },
  { id: "184", label: "金环灵蛇", level: 56, tier: "normal" },
  { id: "185", label: "赤信蛇妖", level: 56, tier: "normal" },
  { id: "186", label: "金毛鬃兽", level: 56, tier: "normal" },
  { id: "187", label: "黄肚蛙将", level: 56, tier: "normal" },
  { id: "188", label: "骨刺橙蜈蚣", level: 57, tier: "normal" },
  { id: "189", label: "银角仙蜕", level: 57, tier: "normal" },
  { id: "190", label: "白骨团怪", level: 57, tier: "normal" },
  { id: "191", label: "铁甲双钳虫", level: 58, tier: "normal" },
  { id: "192", label: "银针骨虫", level: 58, tier: "normal" },
  { id: "193", label: "泥沼爬行兽", level: 58, tier: "normal" },
  { id: "194", label: "石肤鬼王", level: 59, tier: "normal" },
  { id: "195", label: "持叉狼妖", level: 59, tier: "normal" },
  { id: "196", label: "骨刺链锤魔", level: 59, tier: "normal" },
  { id: "197", label: "血翼魔王", level: 59, tier: "normal" },
  { id: "198", label: "坠马铁骨怪", level: 60, tier: "normal" },
  { id: "199", label: "骨翼小飞龙", level: 60, tier: "normal" },
  { id: "200", label: "长尾跳鼠怪", level: 10, tier: "boss" },
  { id: "201", label: "白骨弓手", level: 13, tier: "boss" },
  { id: "202", label: "铁甲长戟卫", level: 15, tier: "boss" },
  { id: "203", label: "断臂独锤兵", level: 18, tier: "boss" },
  { id: "204", label: "红肤举锤巨人", level: 20, tier: "boss" },
  { id: "205", label: "狼头黑锤妖", level: 23, tier: "boss" },
  { id: "206", label: "铁节钢蜈蚣", level: 25, tier: "boss" },
  { id: "207", label: "雪白羊怪", level: 28, tier: "boss" },
  { id: "208", label: "荆棘刺球兽", level: 30, tier: "boss" },
  { id: "209", label: "土黄瘦狐", level: 33, tier: "boss" },
  { id: "210", label: "白袍布衣道人", level: 35, tier: "boss" },
  { id: "211", label: "血背金龟虫", level: 38, tier: "boss" },
  { id: "212", label: "青绿毛毛虫", level: 40, tier: "boss" },
  { id: "213", label: "白骨腐尸", level: 43, tier: "boss" },
  { id: "214", label: "铁尾黑蝎", level: 45, tier: "boss" },
  { id: "215", label: "褐翼黑蝙蝠", level: 48, tier: "boss" },
  { id: "216", label: "银斧圆盾矮人", level: 50, tier: "boss" },
  { id: "217", label: "绿皮蟾人", level: 53, tier: "boss" },
  { id: "218", label: "金鬃狻猊", level: 55, tier: "boss" },
  { id: "219", label: "铁钩海盗", level: 58, tier: "boss" },
  { id: "220", label: "牛角石肤巨人", level: 60, tier: "boss" },
];

/** 定位倍率（原客户端 configs/growth 的 monsterTierScale，随数值一并搬来服务端） */
const MONSTER_TIER_SCALE: Record<MonsterSeedTier, { hp: number; attack: number; defense: number }> = {
  normal: { hp: 1, attack: 1, defense: 1 },
  elite: { hp: 3, attack: 1.3, defense: 1.3 },
  boss: { hp: 8, attack: 1.5, defense: 1.4 },
};

/** 手感参数（原客户端 configs/growth 的 monsterBalance）：血量 = 角色普攻平均伤害 × hitCount */
const MONSTER_BALANCE = { hitCount: 5.5, attackRate: 1, defenseRate: 1 };

/** 角色等级属性表按等级取行（生成物是字面量键对象，垫一层索引签名方便按变量取） */
const ROLE_BY_LEVEL = ROLE_LEVEL_ATTRIBUTES as Record<string, { physicalAttack: number[]; physicalDefense: number[] } | undefined>;

/** 按上限算属性取值区间（与客户端 growth.toAttributeRange 同口径） */
function toAttributeRange(maximum: number, minRate: number): [number, number] {
  return [Math.round(maximum * minRate), Math.round(maximum)];
}

/**
 * 把紧凑四元组展开成 monsters 表一行的数值部分
 *
 * 生命不是直接拍的，而是由「角色普攻要打几刀」反推（改角色曲线，怪物耐打程度自动跟手）；
 * 攻防 = 同等级角色曲线 × 手感参数 × 定位倍率。怪不回血（hpRecover 恒 0，
 * 回血是玩家养成线的收益，「磨血」打法依赖这一点）。法系特例直接改这份种子或管理端，
 * 展开器不管特例（220 只怪实测零覆盖，见文件头）。
 */
export function expandMonsterSeed(
  row: MonsterSeedRow,
): { maxHp: number; physicalAttack: [number, number]; magicAttack: [number, number]; taoistAttack: [number, number]; physicalDefense: [number, number]; magicDefense: [number, number]; taoistDefense: [number, number] } {
  const scale = MONSTER_TIER_SCALE[row.tier];
  const role = ROLE_BY_LEVEL[String(row.level)];
  if (!role) throw new Error(`怪物 ${row.id}（${row.label}）的等级 ${row.level} 超出角色曲线范围（ROLE_LEVEL_ATTRIBUTES 没有这一级）`);

  const minRate = GROWTH_SCALARS["attributeRange.minRate"];
  const attackMax = Math.round(role.physicalAttack[1] * MONSTER_BALANCE.attackRate * scale.attack);
  const defenseMax = Math.round(role.physicalDefense[1] * MONSTER_BALANCE.defenseRate * scale.defense);

  // 两边都是 [上限×minRate, 上限] 的均匀随机，均值 = 上限 × (1 + minRate) / 2
  const averageFactor = (1 + minRate) / 2;
  const damagePerAttack = Math.max(1, averageFactor * (role.physicalAttack[1] - defenseMax));
  const maxHp = Math.max(1, Math.round(damagePerAttack * MONSTER_BALANCE.hitCount * scale.hp));

  const defense = toAttributeRange(defenseMax, minRate);
  return {
    maxHp,
    physicalAttack: toAttributeRange(attackMax, minRate),
    magicAttack: [0, 0],
    taoistAttack: [0, 0],
    physicalDefense: defense,
    magicDefense: defense,
    taoistDefense: defense,
  };
}
