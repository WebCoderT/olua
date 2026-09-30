import { GOOD_TYPE, Material } from "../types/good";

/**
 * 材料配置（物品大类 GOOD_TYPE.MATERIAL）
 * 用于合成/任务等用途，可叠加
 */
export const materials: Material[] = [
  {
    id: "material_hide",
    type: GOOD_TYPE.MATERIAL,
    label: "兽皮",
    level: 1,
    description: "从野兽身上剥下的皮，可用于制作防具。",
    icon: "item/2010210",
    sellPirce: 2,
    stackable: true,
    maxStack: 99,
  },
  {
    id: "material_iron",
    type: GOOD_TYPE.MATERIAL,
    label: "铁矿",
    level: 1,
    description: "常见的矿石，可用于打造武器。",
    icon: "item/2010310",
    sellPirce: 3,
    stackable: true,
    maxStack: 99,
  },
  {
    id: "material_cloth",
    type: GOOD_TYPE.MATERIAL,
    label: "粗布",
    level: 1,
    description: "粗糙的布料，可用于制作衣物。",
    icon: "item/2030410",
    sellPirce: 2,
    stackable: true,
    maxStack: 99,
  },
  {
    id: "material_gem",
    type: GOOD_TYPE.MATERIAL,
    label: "宝石",
    level: 10,
    description: "蕴含灵气的宝石，可用于强化装备。",
    icon: "item/2030702",
    sellPirce: 50,
    stackable: true,
    maxStack: 99,
  },
  {
    id: "material_herb",
    type: GOOD_TYPE.MATERIAL,
    label: "药草",
    level: 1,
    description: "常见的草药，可用于炼制药品。",
    icon: "item/2030810",
    sellPirce: 2,
    stackable: true,
    maxStack: 99,
  },
];
