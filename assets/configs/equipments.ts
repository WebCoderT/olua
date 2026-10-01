import { Vec2 } from "cc";
import { Equipment, EQUIPMENT_TYPE, EquipmentSlot, GOOD_TYPE } from "../types/good";
import { OECCUPATION, SEX } from "../types/role";

// 角色弹窗中装备槽map
export const equipmentSlots = new Map<EQUIPMENT_TYPE, EquipmentSlot>();
equipmentSlots.set(EQUIPMENT_TYPE.OTHER1, { label: "其他1", imageSrc: "slots/other", position: "bottom" });
equipmentSlots.set(EQUIPMENT_TYPE.CLOTH, { label: "衣服", imageSrc: "slots/cloth", position: "bottom" });
equipmentSlots.set(EQUIPMENT_TYPE.OTHER2, { label: "其他2", imageSrc: "slots/other", position: "bottom" });

equipmentSlots.set(EQUIPMENT_TYPE.WEAPON, { label: "武器", imageSrc: "slots/weapon", position: "left" });
equipmentSlots.set(EQUIPMENT_TYPE.NECKLACE, { label: "项链", imageSrc: "slots/necklace", position: "left" });
equipmentSlots.set(EQUIPMENT_TYPE.RING, { label: "戒指", imageSrc: "slots/ring", position: "left" });
equipmentSlots.set(EQUIPMENT_TYPE.ACCESSORIES, { label: "饰品", imageSrc: "slots/accessories", position: "left" });
equipmentSlots.set(EQUIPMENT_TYPE.SHINGUARD, { label: "护腿", imageSrc: "slots/shinguard", position: "left" });

equipmentSlots.set(EQUIPMENT_TYPE.HELMET, { label: "头盔", imageSrc: "slots/helmet", position: "right" });
equipmentSlots.set(EQUIPMENT_TYPE.SCAPULAR, { label: "肩胛", imageSrc: "slots/scapular", position: "right" });
equipmentSlots.set(EQUIPMENT_TYPE.BELT, { label: "腰带", imageSrc: "slots/belt", position: "right" });
equipmentSlots.set(EQUIPMENT_TYPE.WRISTBAND, { label: "护腕", imageSrc: "slots/wristband", position: "right" });
equipmentSlots.set(EQUIPMENT_TYPE.SHOES, { label: "鞋子", imageSrc: "slots/shoes", position: "right" });

// 衣服（label/description/icon/in/out 按 resources/clothes 的图标与内外观资源拟定；战斗数值与内外观位置/缩放待逐件调整；全部不限性别与职业）
export const clothes = new Map<string, Equipment>([
  [
    "cloth_1",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "* 唯一深爱(衣) *",
      sex: SEX.ALL,
      level: 1,
      description: "葬爱家族专属衣服，穿上此装备，开启你的旅程吧！",
      sellPirce: 0,
      icon: "clothes/icon/005",
      in: "clothes/in/005",
      out: "clothes/out/005",
      physicalAttack: [0, 100],
      magicAttack: [0, 100],
      taoistAttack: [0, 100],
      physicalDefense: [0, 50],
      magicDefense: [0, 50],
      taoistDefense: [0, 50],
      maxHp: 3000,
      inPosition: new Vec2(-72.5, 48),
      tags: ["第一大陆"],
      prefix: "葬爱",
      suffix: "魂级",
      inScaleX: 1.3,
      inScaleY: 1.3,
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ],
  /**   [
    "cloth_2",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "妖绯巫女",
      sex: SEX.ALL,
      level: 1,
      description: "白红相间的东瀛巫女装束，周身缠绕着妖异的紫雾，据说来自异国的神秘祭司。",
      sellPirce: 0,
      icon: "clothes/icon/001",
      in: "clothes/in/001",
      out: "clothes/out/001",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ], */
  /** [
    "cloth_3",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "金棒阔少",
      sex: SEX.ALL,
      level: 1,
      description: "金发紫衫的富家公子，扛着鎏金球棒、拎着漆皮宝箱，走路都带风。",
      sellPirce: 0,
      icon: "clothes/icon/002",
      in: "clothes/in/002",
      out: "clothes/out/002",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ], */
  /** [
    "cloth_4",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "绯樱刀姬",
      sex: SEX.ALL,
      level: 1,
      description: "白裙红缨的女武士，裙摆沾着不灭的火光，太刀出鞘时如樱花绽落。",
      sellPirce: 0,
      icon: "clothes/icon/003",
      in: "clothes/in/003",
      out: "clothes/out/003",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ], */
  /** 
   * [
    "cloth_5",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "熔岩魔躯",
      sex: SEX.ALL,
      level: 1,
      description: "由熔岩凝成的魔神之躯，金角獠牙、鬃毛流火，行走时大地都被烧红。",
      sellPirce: 0,
      icon: "clothes/icon/004",
      in: "clothes/in/004",
      out: "clothes/out/004",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ],
   */
  /** [
    "cloth_6",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "兽首金甲",
      sex: SEX.ALL,
      level: 1,
      description: "肩披兽首的金甲战袍，红披风猎猎作响，佩剑燃着熊熊烈焰。",
      sellPirce: 0,
      icon: "clothes/icon/006",
      in: "clothes/in/006",
      out: "clothes/out/006",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ], */
  /** 
   * [
    "cloth_7",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "双焰鬼将",
      sex: SEX.ALL,
      level: 1,
      description: "双手各持一把燃烧魔刀的鬼面战将，双翼喷焰，凶戾无比。",
      sellPirce: 0,
      icon: "clothes/icon/007",
      in: "clothes/in/007",
      out: "clothes/out/007",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ],
   */
  /** 
    ["cloth_8", {
    type: GOOD_TYPE.EQUIPMENT,
    slot: EQUIPMENT_TYPE.CLOTH,
    occupation: OECCUPATION.ALL,
    label: "红金机甲",
    sex: SEX.ALL,
    level: 1,
    description: "传说从异世界掉落的钢铁战衣，胸口能量核心散发着幽蓝的光芒。",
    sellPirce: 0,
    icon: "clothes/icon/008",
    in: "clothes/in/008",
    out: "clothes/out/008",
    physicalAttack: [0, 0],
    magicAttack: [0, 0],
    taoistAttack: [0, 0],
    physicalDefense: [0, 0],
    magicDefense: [0, 0],
    taoistDefense: [0, 0],
    maxHp: 0,
    inPosition: new Vec2(0, 0),
    tags: [],
    prefix: "",
    suffix: "",
    outScale: 1,
    outPositions: [
      new Vec2(7.3, 34.2), // up
      new Vec2(7.3, 34.2), // right_up
      new Vec2(7.3, 34.2), // right
      new Vec2(7.3, 34.2), // right_down
      new Vec2(7.3, 34.2), // down
      new Vec2(7.3, 34.2), // left_down
      new Vec2(7.3, 34.2), // left
      new Vec2(7.3, 34.2), // left_up
    ],
  }],
 */
  /** 
   * [
    "cloth_9",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "星盾卫士",
      sex: SEX.ALL,
      level: 1,
      description: "身披星条战衣，手持坚不可摧的圆盾，正义感满满的老兵。",
      sellPirce: 0,
      icon: "clothes/icon/009",
      in: "clothes/in/009",
      out: "clothes/out/009",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ],
   */
  [
    "cloth_10",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "钢铁战甲",
      sex: SEX.ALL,
      level: 1,
      description: "红金涂装的钢铁战甲，可以吸收星光来补充能量。",
      sellPirce: 0,
      icon: "clothes/icon/010",
      in: "clothes/in/010",
      out: "clothes/out/010",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ],
  /** 异常
   * [
    "cloth_11",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "黄金圣翼",
      sex: SEX.ALL,
      level: 1,
      description: "铺展开的金色羽翼如神明降世，金光所照之处皆成圣域。",
      sellPirce: 0,
      icon: "clothes/icon/011",
      in: "clothes/in/011",
      out: "", // resources/clothes/out/011 缺失，暂无外观
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ],
   */
  /** 
 * 异常
 *   [
    "cloth_12",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "英伦军花",
      sex: SEX.ALL,
      level: 1,
      description: "笔挺军装的英气女官，站姿标准得像在阅兵场上。",
      sellPirce: 0,
      icon: "clothes/icon/012",
      in: "", // resources/clothes/in/012 缺失，暂无内观
      out: "clothes/out/012",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ],
 */
  /** 
 * 异常
 * 
 *   [
    "cloth_13",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "军装丽人",
      sex: SEX.ALL,
      level: 1,
      description: "与军花气质相仿的礼服军装，英姿飒爽，气度不凡。",
      sellPirce: 0,
      icon: "clothes/icon/013",
      in: "", // resources/clothes/in/013 缺失，暂无内观
      out: "clothes/out/013",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ],
 */
  [
    "cloth_14",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "青铜重甲",
      sex: SEX.ALL,
      level: 1,
      description: "古战场流传下来的青铜重铠，甲片铆接、刀枪难入。",
      sellPirce: 0,
      icon: "clothes/icon/014",
      in: "clothes/in/014",
      out: "clothes/out/014",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ],
  [
    "cloth_15",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "紫蓑浪人",
      sex: SEX.ALL,
      level: 1,
      description: "紫蓑斗笠的独行浪人，腰间铃铛与手杖随夜风轻响。",
      sellPirce: 0,
      icon: "clothes/icon/015",
      in: "clothes/in/015",
      out: "clothes/out/015",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ],
  /** 
 *   [
    "cloth_16",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "暗黑骨甲",
      sex: SEX.ALL,
      level: 1,
      description: "由魔兽骨壳拼成的黑甲，浑身上下唯一的亮光是一双幽蓝的眼睛。",
      sellPirce: 0,
      icon: "clothes/icon/016",
      in: "clothes/in/016",
      out: "clothes/out/016",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ],
 */
  [
    "cloth_17",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "苍龙宝甲",
      sex: SEX.ALL,
      level: 1,
      description: "缀有龙纹的宝蓝战甲，沉稳如山，是为大将之风。",
      sellPirce: 0,
      icon: "clothes/icon/017",
      in: "clothes/in/017",
      out: "clothes/out/017",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ],
  /**  [
    "cloth_18",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "烈焰神拳",
      sex: SEX.ALL,
      level: 1,
      description: "火神附体般的魁梧战躯，双拳燃着不灭之火，头顶金环流焰。",
      sellPirce: 0,
      icon: "clothes/icon/018",
      in: "clothes/in/018",
      out: "clothes/out/018",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ], */
  /** 
 *   [
    "cloth_19",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "赤绒猫娘",
      sex: SEX.ALL,
      level: 1,
      description: "红衣猫耳少女，绒爪轻挥也能挠出漫天火花。",
      sellPirce: 0,
      icon: "clothes/icon/019",
      in: "clothes/in/019",
      out: "clothes/out/019",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ],
 */
  /** 
  *  [
    "cloth_20",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "招财福猪",
      sex: SEX.ALL,
      level: 1,
      description: "圆滚滚的福猪财主，怀里抱着吃不完的包子，是财运的象征。",
      sellPirce: 0,
      icon: "clothes/icon/020",
      in: "clothes/in/020",
      out: "clothes/out/020",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ],
  */
  [
    "cloth_21",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "紫电黑衣",
      sex: SEX.ALL,
      level: 1,
      description: "一袭黑衣的沉默剑客，周身偶尔炸开细碎的紫色电弧。",
      sellPirce: 0,
      icon: "clothes/icon/021",
      in: "clothes/in/021",
      out: "clothes/out/021",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ],
  /** 
 *   [
    "cloth_22",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "蓝雷甲士",
      sex: SEX.ALL,
      level: 1,
      description: "头生双角的铠甲武士，全身缠绕着蓝色雷霆，怒目如电。",
      sellPirce: 0,
      icon: "clothes/icon/022",
      in: "clothes/in/022",
      out: "clothes/out/022",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ],
 */
  [
    "cloth_23",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "白霜猫灵",
      sex: SEX.ALL,
      level: 1,
      description: "雪白皮毛的猫族少女，一身霜白，来自雪山之巅。",
      sellPirce: 0,
      icon: "clothes/icon/023",
      in: "clothes/in/023",
      out: "clothes/out/023",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ],
  /** 
 *   [
    "cloth_24",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "月宫仙子",
      sex: SEX.ALL,
      level: 1,
      description: "月下起舞的仙子，紫纱罗裙随风而动，疑似月宫下凡。",
      sellPirce: 0,
      icon: "clothes/icon/024",
      in: "clothes/in/024",
      out: "clothes/out/024",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ],
 */
  /** 
  *  [
    "cloth_25",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "金翎雀帝",
      sex: SEX.ALL,
      level: 1,
      description: "背后展开金焰雀羽的男人，传说是南方神鸟转世。",
      sellPirce: 0,
      icon: "clothes/icon/025",
      in: "clothes/in/025",
      out: "clothes/out/025",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ],
  */
  [
    "cloth_26",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "幽影夜行",
      sex: SEX.ALL,
      level: 1,
      description: "黑紫异形的暗影行者，夜色里掠过的一抹紫光是它唯一的痕迹。",
      sellPirce: 0,
      icon: "clothes/icon/026",
      in: "clothes/in/026",
      out: "clothes/out/026",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ],
  /** 
  *  [
    "cloth_27",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "金龙帝袍",
      sex: SEX.ALL,
      level: 1,
      description: "金龙盘冠的帝王战袍，举手投足间尽显威仪，似有龙吟环绕。",
      sellPirce: 0,
      icon: "clothes/icon/027",
      in: "clothes/in/027",
      out: "clothes/out/027",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ],
  */
  /** 
 *   [
    "cloth_28",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "金身财神",
      sex: SEX.ALL,
      level: 1,
      description: "金甲加身的财神爷，周身落满金币与火光，见者发财。",
      sellPirce: 0,
      icon: "clothes/icon/028",
      in: "clothes/in/028",
      out: "clothes/out/028",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ],
 */
  [
    "cloth_29",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "伏魔圣僧",
      sex: SEX.ALL,
      level: 1,
      description: "蓝光护体的圣僧，僧袍猎猎，专降世间妖魔。",
      sellPirce: 0,
      icon: "clothes/icon/029",
      in: "clothes/in/029",
      out: "clothes/out/029",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ],
  [
    "cloth_30",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "夜雨黑衣",
      sex: SEX.ALL,
      level: 1,
      description: "雨夜中静立的黑衣男子，紫焰在他指间明灭。",
      sellPirce: 0,
      icon: "clothes/icon/030",
      in: "clothes/in/030",
      out: "clothes/out/030",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ],
  [
    "cloth_31",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "鎏金圣衣",
      sex: SEX.ALL,
      level: 1,
      description: "闪耀着金色光辉的圣衣，穿上它便是全场焦点。",
      sellPirce: 0,
      icon: "clothes/icon/031",
      in: "clothes/in/031",
      out: "clothes/out/031",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ],
  [
    "cloth_32",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.CLOTH,
      occupation: OECCUPATION.ALL,
      label: "赤裙猫娘",
      sex: SEX.ALL,
      level: 1,
      description: "红裙猫族少女，爪印与铃铛是她走过的记号。",
      sellPirce: 0,
      icon: "clothes/icon/032",
      in: "clothes/in/032",
      out: "clothes/out/032",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 34.2), // up
        new Vec2(7.3, 34.2), // right_up
        new Vec2(7.3, 34.2), // right
        new Vec2(7.3, 34.2), // right_down
        new Vec2(7.3, 34.2), // down
        new Vec2(7.3, 34.2), // left_down
        new Vec2(7.3, 34.2), // left
        new Vec2(7.3, 34.2), // left_up
      ],
    },
  ],
]);

// 武器（label/description/icon/in/out 按 resources/weapons 的图标与内外观资源拟定，战斗数值待补）
export const weapons = new Map<string, Equipment>([
  [
    "weapon_1",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.WEAPON,
      occupation: OECCUPATION.ALL,
      label: "定海神针",
      sex: SEX.ALL,
      level: 1,
      description: "东海龙王的宝物，送给新手冒险家的第一件武器。握紧它，开启你的旅程吧！",
      sellPirce: 0,
      icon: "weapons/icon/001",
      in: "weapons/in/001",
      out: "weapons/out/001",
      physicalAttack: [0, 10],
      magicAttack: [0, 1],
      taoistAttack: [0, 1],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(-205.5, 194),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(5.6, 3.1), // up
        new Vec2(5.6, 3.1), // right_up
        new Vec2(5.6, 3.1), // right
        new Vec2(5.6, 3.1), // right_down
        new Vec2(5.6, 3.1), // down
        new Vec2(5.6, 3.1), // left_down
        new Vec2(5.6, 3.1), // left
        new Vec2(5.6, 3.1), // left_up
      ],
    },
  ],
  [
    "weapon_2",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.WEAPON,
      occupation: OECCUPATION.ALL,
      label: "暗夜雷光剑",
      sex: SEX.ALL,
      level: 1,
      description: "漆黑的剑身中封存着一道白色雷霆，挥动之时雷光乍现，暗夜如昼。",
      sellPirce: 0,
      icon: "weapons/icon/002",
      in: "weapons/in/002",
      out: "weapons/out/002",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(-151.5, 111),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(-10.0, 75.2), // up
        new Vec2(-10.0, 75.2), // right_up
        new Vec2(-10.0, 75.2), // right
        new Vec2(-10.0, 75.2), // right_down
        new Vec2(-10.0, 75.2), // down
        new Vec2(-10.0, 75.2), // left_down
        new Vec2(-10.0, 75.2), // left
        new Vec2(-10.0, 75.2), // left_up
      ],
    },
  ],
  [
    "weapon_3",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.WEAPON,
      occupation: OECCUPATION.ALL,
      label: "圣天使之剑",
      sex: SEX.ALL,
      level: 1,
      description: "剑柄生有天使之翼，护手处镶着一颗心形红宝石，传说是圣天使留给凡间的馈赠。",
      sellPirce: 0,
      icon: "weapons/icon/003",
      in: "weapons/in/003",
      out: "weapons/out/003",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(-178, 137),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.6, 8.0), // up
        new Vec2(7.6, 8.0), // right_up
        new Vec2(7.6, 8.0), // right
        new Vec2(7.6, 8.0), // right_down
        new Vec2(7.6, 8.0), // down
        new Vec2(7.6, 8.0), // left_down
        new Vec2(7.6, 8.0), // left
        new Vec2(7.6, 8.0), // left_up
      ],
    },
  ],
  [
    "weapon_4",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.WEAPON,
      occupation: OECCUPATION.ALL,
      label: "青龙破军剑",
      sex: SEX.ALL,
      level: 1,
      description: "青碧剑身上盘绕着金龙与流火，出鞘之时隐有龙吟，破军之锋所指之处皆为坦途。",
      sellPirce: 0,
      icon: "weapons/icon/004",
      in: "weapons/in/004",
      out: "weapons/out/004",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(-170.5, 150),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(6.6, 50.4), // up
        new Vec2(6.6, 50.4), // right_up
        new Vec2(6.6, 50.4), // right
        new Vec2(6.6, 50.4), // right_down
        new Vec2(6.6, 50.4), // down
        new Vec2(6.6, 50.4), // left_down
        new Vec2(6.6, 50.4), // left
        new Vec2(6.6, 50.4), // left_up
      ],
    },
  ],
  [
    "weapon_5",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.WEAPON,
      occupation: OECCUPATION.ALL,
      label: "炎狱狂刀",
      sex: SEX.ALL,
      level: 1,
      description: "布满锯齿的重刃燃烧着狱蓝色的火焰，戾气极重，凡人难以掌控。",
      sellPirce: 0,
      icon: "weapons/icon/005",
      in: "weapons/in/005",
      out: "", // resources/weapons/out/005 缺失，暂无外观
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(6.6, 50.4), // up
        new Vec2(6.6, 50.4), // right_up
        new Vec2(6.6, 50.4), // right
        new Vec2(6.6, 50.4), // right_down
        new Vec2(6.6, 50.4), // down
        new Vec2(6.6, 50.4), // left_down
        new Vec2(6.6, 50.4), // left
        new Vec2(6.6, 50.4), // left_up
      ],
    },
  ],
  [
    "weapon_6",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.WEAPON,
      occupation: OECCUPATION.ALL,
      label: "焚天赤金刃",
      sex: SEX.ALL,
      level: 1,
      description: "通体赤金的宝刃，刀身终年缠绕着不灭的烈焰，可焚天下之物。",
      sellPirce: 0,
      icon: "weapons/icon/006",
      in: "weapons/in/006",
      out: "weapons/out/006",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(-141, 86),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(12.7, 36.5), // up
        new Vec2(12.7, 36.5), // right_up
        new Vec2(12.7, 36.5), // right
        new Vec2(12.7, 36.5), // right_down
        new Vec2(12.7, 36.5), // down
        new Vec2(12.7, 36.5), // left_down
        new Vec2(12.7, 36.5), // left
        new Vec2(12.7, 36.5), // left_up
      ],
    },
  ],
  [
    "weapon_7",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.WEAPON,
      occupation: OECCUPATION.ALL,
      label: "玄铁惊雷剑",
      sex: SEX.ALL,
      level: 1,
      description: "以玄铁铸就的重剑，剑锋常年缠绕惊雷，挥落之时如雷鸣贯耳。",
      sellPirce: 0,
      icon: "weapons/icon/007",
      in: "weapons/in/007",
      out: "weapons/out/007",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(-185, 102),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(6.5, 47.4), // up
        new Vec2(6.5, 47.4), // right_up
        new Vec2(6.5, 47.4), // right
        new Vec2(6.5, 47.4), // right_down
        new Vec2(6.5, 47.4), // down
        new Vec2(6.5, 47.4), // left_down
        new Vec2(6.5, 47.4), // left
        new Vec2(6.5, 47.4), // left_up
      ],
    },
  ],
  [
    "weapon_8",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.WEAPON,
      occupation: OECCUPATION.ALL,
      label: "嗜血魔刃",
      sex: SEX.ALL,
      level: 1,
      description: "暗红的剑身上浮现着古老的血色符文，饮血而愈，愈战愈勇。",
      sellPirce: 0,
      icon: "weapons/icon/008",
      in: "weapons/in/008",
      out: "weapons/out/008",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(-164, 146),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(-19.2, 80.2), // up
        new Vec2(-19.2, 80.2), // right_up
        new Vec2(-19.2, 80.2), // right
        new Vec2(-19.2, 80.2), // right_down
        new Vec2(-19.2, 80.2), // down
        new Vec2(-19.2, 80.2), // left_down
        new Vec2(-19.2, 80.2), // left
        new Vec2(-19.2, 80.2), // left_up
      ],
    },
  ],
  [
    "weapon_9",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.WEAPON,
      occupation: OECCUPATION.ALL,
      label: "紫电青霜剑",
      sex: SEX.ALL,
      level: 1,
      description: "紫蓝雷光在水晶剑身上流转，出剑快如闪电，剑气冷若寒霜。",
      sellPirce: 0,
      icon: "weapons/icon/009",
      in: "weapons/in/009",
      out: "weapons/out/009",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(-139, -9.5),
      inRotate: 260,
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(14.0, 4.5), // up
        new Vec2(14.0, 4.5), // right_up
        new Vec2(14.0, 4.5), // right
        new Vec2(14.0, 4.5), // right_down
        new Vec2(14.0, 4.5), // down
        new Vec2(14.0, 4.5), // left_down
        new Vec2(14.0, 4.5), // left
        new Vec2(14.0, 4.5), // left_up
      ],
    },
  ],
  [
    "weapon_10",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.WEAPON,
      occupation: OECCUPATION.ALL,
      label: "朱雀羽刃",
      sex: SEX.ALL,
      level: 1,
      description: "刀如凤凰展翅，燃着朱雀神火，传说蕴含浴火重生之力。",
      sellPirce: 0,
      icon: "weapons/icon/010",
      in: "weapons/in/010",
      out: "weapons/out/010",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(-125, -13.5),
      inRotate: 280,
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(13.0, -12.8), // up
        new Vec2(13.0, -12.8), // right_up
        new Vec2(13.0, -12.8), // right
        new Vec2(13.0, -12.8), // right_down
        new Vec2(13.0, -12.8), // down
        new Vec2(13.0, -12.8), // left_down
        new Vec2(13.0, -12.8), // left
        new Vec2(13.0, -12.8), // left_up
      ],
    },
  ],
  [
    "weapon_11",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.WEAPON,
      occupation: OECCUPATION.ALL,
      label: "炽焰双头杖",
      sex: SEX.ALL,
      level: 1,
      description: "两端燃着不灭火焰的秘法长杖，是火系法师梦寐以求的宝物。",
      sellPirce: 0,
      icon: "weapons/icon/011",
      in: "weapons/in/011",
      out: "weapons/out/011",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(-68, 15.5),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(14.0, 5.9), // up
        new Vec2(14.0, 5.9), // right_up
        new Vec2(14.0, 5.9), // right
        new Vec2(14.0, 5.9), // right_down
        new Vec2(14.0, 5.9), // down
        new Vec2(14.0, 5.9), // left_down
        new Vec2(14.0, 5.9), // left
        new Vec2(14.0, 5.9), // left_up
      ],
    },
  ],
  [
    "weapon_12",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.WEAPON,
      occupation: OECCUPATION.ALL,
      label: "圣光十字剑",
      sex: SEX.ALL,
      level: 1,
      description: "金色十字剑柄辉映着湛蓝圣光，可破一切黑暗邪祟。",
      sellPirce: 0,
      icon: "weapons/icon/012",
      in: "weapons/in/012",
      out: "weapons/out/012",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(-139, 42),
      inRotate: 240,
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(11.5, 4.9), // up
        new Vec2(11.5, 4.9), // right_up
        new Vec2(11.5, 4.9), // right
        new Vec2(11.5, 4.9), // right_down
        new Vec2(11.5, 4.9), // down
        new Vec2(11.5, 4.9), // left_down
        new Vec2(11.5, 4.9), // left
        new Vec2(11.5, 4.9), // left_up
      ],
    },
  ],
  [
    "weapon_13",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.WEAPON,
      occupation: OECCUPATION.ALL,
      label: "炎皇圣剑",
      sex: SEX.ALL,
      level: 1,
      description: "剑身铭刻上古炎皇纹章，中央的赤红宝石封存着焚世之力。",
      sellPirce: 0,
      icon: "weapons/icon/013",
      in: "weapons/in/013",
      out: "weapons/out/013",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(-79, 17),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(15.5, -26.9), // up
        new Vec2(15.5, -26.9), // right_up
        new Vec2(15.5, -26.9), // right
        new Vec2(15.5, -26.9), // right_down
        new Vec2(15.5, -26.9), // down
        new Vec2(15.5, -26.9), // left_down
        new Vec2(15.5, -26.9), // left
        new Vec2(15.5, -26.9), // left_up
      ],
    },
  ],
  [
    "weapon_14",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.WEAPON,
      occupation: OECCUPATION.ALL,
      label: "紫翼金冠刃",
      sex: SEX.ALL,
      level: 1,
      description: "形似金冠、缀以紫翼的奇门兵器，唯有王者方可驾驭。",
      sellPirce: 0,
      icon: "weapons/icon/014",
      in: "weapons/in/014",
      out: "weapons/out/014",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(0, 0),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(14.5, 18.3), // up
        new Vec2(14.5, 18.3), // right_up
        new Vec2(14.5, 18.3), // right
        new Vec2(14.5, 18.3), // right_down
        new Vec2(14.5, 18.3), // down
        new Vec2(14.5, 18.3), // left_down
        new Vec2(14.5, 18.3), // left
        new Vec2(14.5, 18.3), // left_up
      ],
    },
  ],
  [
    "weapon_15",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.WEAPON,
      occupation: OECCUPATION.ALL,
      label: "屠龙金纹剑",
      sex: SEX.ALL,
      level: 1,
      description: "剑身铭满屠龙金纹，曾是斩杀上古魔龙的英雄佩剑。",
      sellPirce: 0,
      icon: "weapons/icon/015",
      in: "weapons/in/015",
      out: "weapons/out/015",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(-76, 80),
      inRotate: 280,
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(-8.5, 70.4), // up
        new Vec2(-8.5, 70.4), // right_up
        new Vec2(-8.5, 70.4), // right
        new Vec2(-8.5, 70.4), // right_down
        new Vec2(-8.5, 70.4), // down
        new Vec2(-8.5, 70.4), // left_down
        new Vec2(-8.5, 70.4), // left
        new Vec2(-8.5, 70.4), // left_up
      ],
    },
  ],
  [
    "weapon_16",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.WEAPON,
      occupation: OECCUPATION.ALL,
      label: "青莲业火剑",
      sex: SEX.ALL,
      level: 1,
      description: "剑身燃着青莲业火，焚尽业障，可斩虚空。",
      sellPirce: 0,
      icon: "weapons/icon/016",
      in: "weapons/in/016",
      out: "weapons/out/016",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(-80, 80),
      inRotate: 280,
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(-8.6, 71.6), // up
        new Vec2(-8.6, 71.6), // right_up
        new Vec2(-8.6, 71.6), // right
        new Vec2(-8.6, 71.6), // right_down
        new Vec2(-8.6, 71.6), // down
        new Vec2(-8.6, 71.6), // left_down
        new Vec2(-8.6, 71.6), // left
        new Vec2(-8.6, 71.6), // left_up
      ],
    },
  ],
  [
    "weapon_17",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.WEAPON,
      occupation: OECCUPATION.ALL,
      label: "紫晶魔剑",
      sex: SEX.ALL,
      level: 1,
      description: "由整块紫晶雕琢而成的魔剑，剑气所过之处空间震裂。",
      sellPirce: 0,
      icon: "weapons/icon/017",
      in: "weapons/in/017",
      out: "weapons/out/017",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(-222, 231),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.3, 1.5), // up
        new Vec2(7.3, 1.5), // right_up
        new Vec2(7.3, 1.5), // right
        new Vec2(7.3, 1.5), // right_down
        new Vec2(7.3, 1.5), // down
        new Vec2(7.3, 1.5), // left_down
        new Vec2(7.3, 1.5), // left
        new Vec2(7.3, 1.5), // left_up
      ],
    },
  ],
  [
    "weapon_18",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.WEAPON,
      occupation: OECCUPATION.ALL,
      label: "紫翼神冠刃",
      sex: SEX.ALL,
      level: 1,
      description: "紫翼金冠的真正形态，觉醒之后可撕裂苍穹。",
      sellPirce: 0,
      icon: "weapons/icon/018",
      in: "weapons/in/018",
      out: "weapons/out/018",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(-80, 48),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(14.5, 18.3), // up
        new Vec2(14.5, 18.3), // right_up
        new Vec2(14.5, 18.3), // right
        new Vec2(14.5, 18.3), // right_down
        new Vec2(14.5, 18.3), // down
        new Vec2(14.5, 18.3), // left_down
        new Vec2(14.5, 18.3), // left
        new Vec2(14.5, 18.3), // left_up
      ],
    },
  ],
  [
    "weapon_19",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.WEAPON,
      occupation: OECCUPATION.ALL,
      label: "燃金圣剑",
      sex: SEX.ALL,
      level: 1,
      description: "圣剑通体由燃金铸成，剑焰不熄，光照千里。",
      sellPirce: 0,
      icon: "weapons/icon/019",
      in: "weapons/in/019",
      out: "weapons/out/019",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(-225, 230),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(7.4, 1.2), // up
        new Vec2(7.4, 1.2), // right_up
        new Vec2(7.4, 1.2), // right
        new Vec2(7.4, 1.2), // right_down
        new Vec2(7.4, 1.2), // down
        new Vec2(7.4, 1.2), // left_down
        new Vec2(7.4, 1.2), // left
        new Vec2(7.4, 1.2), // left_up
      ],
    },
  ],
  [
    "weapon_20",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.WEAPON,
      occupation: OECCUPATION.ALL,
      label: "焚世巨剑",
      sex: SEX.ALL,
      level: 1,
      description: "传闻此剑一挥，可焚尽一世。唯有真正的强者敢将它握在手中。",
      sellPirce: 0,
      icon: "weapons/icon/020",
      in: "weapons/in/020",
      out: "weapons/out/020",
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      inPosition: new Vec2(-172, 143),
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(11.7, 57.2), // up
        new Vec2(11.7, 57.2), // right_up
        new Vec2(11.7, 57.2), // right
        new Vec2(11.7, 57.2), // right_down
        new Vec2(11.7, 57.2), // down
        new Vec2(11.7, 57.2), // left_down
        new Vec2(11.7, 57.2), // left
        new Vec2(11.7, 57.2), // left_up
      ],
    },
  ],
]);

// 戒指
export const rings = new Map<string, Equipment>([
  [
    "ring_1",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.RING,
      occupation: OECCUPATION.ALL,
      sex: SEX.ALL,
      in: "",
      inPosition: new Vec2(),
      out: "",
      label: "新手戒指",
      level: 1,
      description: "新手戒指，穿上此装备，开启你的旅程吧！",
      icon: "item/2010210",
      sellPirce: 0,
      physicalAttack: [0, 1],
      magicAttack: [0, 1],
      taoistAttack: [0, 1],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(0.0, 0.0), // up
        new Vec2(0.0, 0.0), // right_up
        new Vec2(0.0, 0.0), // right
        new Vec2(0.0, 0.0), // right_down
        new Vec2(0.0, 0.0), // down
        new Vec2(0.0, 0.0), // left_down
        new Vec2(0.0, 0.0), // left
        new Vec2(0.0, 0.0), // left_up
      ],
    },
  ],
]);

// 项链
export const nicklaces = new Map<string, Equipment>([
  [
    "necklace_1",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.NECKLACE,
      occupation: OECCUPATION.ALL,
      sex: SEX.ALL,
      in: "",
      inPosition: new Vec2(),
      out: "",
      label: "新手项链",
      level: 1,
      description: "新手项链，穿上此装备，开启你的旅程吧！",
      icon: "item/2010310",
      sellPirce: 0,
      physicalAttack: [0, 1],
      magicAttack: [0, 1],
      taoistAttack: [0, 1],
      physicalDefense: [0, 0],
      magicDefense: [0, 0],
      taoistDefense: [0, 0],
      maxHp: 0,
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(0.0, 0.0), // up
        new Vec2(0.0, 0.0), // right_up
        new Vec2(0.0, 0.0), // right
        new Vec2(0.0, 0.0), // right_down
        new Vec2(0.0, 0.0), // down
        new Vec2(0.0, 0.0), // left_down
        new Vec2(0.0, 0.0), // left
        new Vec2(0.0, 0.0), // left_up
      ],
    },
  ],
]);

// 鞋子
export const shoes = new Map<string, Equipment>([
  [
    "shoes_1",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.SHOES,
      occupation: OECCUPATION.ALL,
      sex: SEX.ALL,
      in: "",
      inPosition: new Vec2(),
      out: "",
      label: "新手鞋子",
      level: 1,
      description: "新手鞋子，穿上此装备，开启你的旅程吧！",
      icon: "item/2030410",
      sellPirce: 0,
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 5],
      magicDefense: [0, 5],
      taoistDefense: [0, 5],
      maxHp: 5,
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(0.0, 0.0), // up
        new Vec2(0.0, 0.0), // right_up
        new Vec2(0.0, 0.0), // right
        new Vec2(0.0, 0.0), // right_down
        new Vec2(0.0, 0.0), // down
        new Vec2(0.0, 0.0), // left_down
        new Vec2(0.0, 0.0), // left
        new Vec2(0.0, 0.0), // left_up
      ],
    },
  ],
]);

// 头盔
export const helmets = new Map<string, Equipment>([
  [
    "helmet_1",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.HELMET,
      occupation: OECCUPATION.ALL,
      sex: SEX.ALL,
      in: "",
      inPosition: new Vec2(),
      out: "",
      label: "新手头盔",
      level: 1,
      description: "新手头盔，穿上此装备，开启你的旅程吧！",
      icon: "item/2030702",
      sellPirce: 0,
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 5],
      magicDefense: [0, 5],
      taoistDefense: [0, 5],
      maxHp: 5,
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(0.0, 0.0), // up
        new Vec2(0.0, 0.0), // right_up
        new Vec2(0.0, 0.0), // right
        new Vec2(0.0, 0.0), // right_down
        new Vec2(0.0, 0.0), // down
        new Vec2(0.0, 0.0), // left_down
        new Vec2(0.0, 0.0), // left
        new Vec2(0.0, 0.0), // left_up
      ],
    },
  ],
]);

// 腰带
export const belts = new Map<string, Equipment>([
  [
    "belt_1",
    {
      type: GOOD_TYPE.EQUIPMENT,
      slot: EQUIPMENT_TYPE.BELT,
      occupation: OECCUPATION.ALL,
      sex: SEX.ALL,
      in: "",
      inPosition: new Vec2(),
      out: "",
      label: "新手腰带",
      level: 1,
      description: "新手腰带，穿上此装备，开启你的旅程吧！",
      icon: "item/2030810",
      sellPirce: 0,
      physicalAttack: [0, 0],
      magicAttack: [0, 0],
      taoistAttack: [0, 0],
      physicalDefense: [0, 5],
      magicDefense: [0, 5],
      taoistDefense: [0, 5],
      maxHp: 5,
      tags: [],
      prefix: "",
      suffix: "",
      outScale: 1,
      outPositions: [
        new Vec2(0.0, 0.0), // up
        new Vec2(0.0, 0.0), // right_up
        new Vec2(0.0, 0.0), // right
        new Vec2(0.0, 0.0), // right_down
        new Vec2(0.0, 0.0), // down
        new Vec2(0.0, 0.0), // left_down
        new Vec2(0.0, 0.0), // left
        new Vec2(0.0, 0.0), // left_up
      ],
    },
  ],
]);
