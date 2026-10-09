import { Drug, GOOD_TYPE } from "../types/good";

/**
 * 药品配置（物品大类 GOOD_TYPE.DRUG）
 * icon 取自 resources/item，effects 为使用效果（可扩展回血/回蓝/增益等）
 *
 * 回复量按 configs/growth 的等级曲线定标，规则：
 * 「小药 ≈ 1 级血量的 60%、中药 ≈ 5 级、大药 ≈ 10~20 级」——即**每档药大约回满它对应等级段的一条命**，
 * 越级使用就会明显不够用。改了成长曲线记得回来同步这三档的回复量。
 *
 * 注意：目前只有 1 / 5 / 10 三档，属于前期用药；resources/item 下还留着
 * fs_5~fs_7（红）、sz_4~sz_7（蓝）、tz_3~tz_7（太阳水）的图标，
 * 等掉落表能按怪物等级分档之后再补 21 / 31 / 41 / 51 级的高级药。
 */
export const drugs: Drug[] = [
  {
    id: "drug_hp_1",
    type: GOOD_TYPE.DRUG,
    label: "金创药（小）",
    level: 1,
    description: "外伤药，使用后恢复 60 点生命值。",
    icon: "item/fs_2",
    sellPirce: 5,
    stackable: true,
    maxStack: 99,
    effects: [{ hp: 60 }],
    cooldown: 1,
  },
  {
    id: "drug_hp_2",
    type: GOOD_TYPE.DRUG,
    label: "金创药（中）",
    level: 5,
    description: "外伤药，使用后恢复 250 点生命值。",
    icon: "item/fs_3",
    sellPirce: 15,
    stackable: true,
    maxStack: 99,
    effects: [{ hp: 250 }],
    cooldown: 1,
  },
  {
    id: "drug_hp_3",
    type: GOOD_TYPE.DRUG,
    label: "金创药（大）",
    level: 10,
    description: "外伤药，使用后恢复 900 点生命值。",
    icon: "item/fs_4",
    sellPirce: 40,
    stackable: true,
    maxStack: 99,
    effects: [{ hp: 900 }],
    cooldown: 1,
  },
  {
    id: "drug_mp_1",
    type: GOOD_TYPE.DRUG,
    label: "魔法药（小）",
    level: 1,
    description: "使用后恢复 40 点魔法值。",
    icon: "item/sz_2",
    sellPirce: 5,
    stackable: true,
    maxStack: 99,
    effects: [{ mp: 40 }],
    cooldown: 1,
  },
  {
    id: "drug_mp_2",
    type: GOOD_TYPE.DRUG,
    label: "魔法药（中）",
    level: 5,
    description: "使用后恢复 180 点魔法值。",
    icon: "item/sz_3",
    sellPirce: 15,
    stackable: true,
    maxStack: 99,
    effects: [{ mp: 180 }],
    cooldown: 1,
  },
  {
    id: "drug_sun",
    type: GOOD_TYPE.DRUG,
    label: "太阳水",
    level: 1,
    description: "使用后同时恢复 150 点生命值与 80 点魔法值。",
    icon: "item/tz_2",
    sellPirce: 45,
    stackable: true,
    maxStack: 99,
    effects: [{ hp: 150, mp: 80 }],
    cooldown: 1,
  },
];
