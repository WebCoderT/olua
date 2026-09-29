import { ACTION, BattleAttributes, Equipment, EQUIPMENT_TYPE, Goods, MapId, needSetShortCutKeyConfig, OECCUPATION, RELATION_SHIP, SEX, SkillId, SpeedRate } from "../types/common";
import { belts, clothes, helmets, nicklaces, rings, shoes, weapons } from "./equipments";
import { bagCol, bagRow } from "./game";
import { levelMap } from "./level";

export class Role implements BattleAttributes {
  id: string;
  name: string;
  occupation: OECCUPATION;
  sex: SEX;
  level: number = 1;
  fashionCloth: number | null = null;
  relationShip: RELATION_SHIP = RELATION_SHIP.SELF;
  avatar: number = 0;
  gold: number = 10000;
  bindGold: number = 10000;
  silver: number = 10000;
  exp: number = 0;
  maxHp: number;
  hp: number;
  bag: Array<Array<Goods | null>>;
  combat: number = 0;
  physicalAttack: [number, number] = [0, 0];
  magicAttack: [number, number] = [0, 0];
  taoistAttack: [number, number] = [0, 0];
  physicalDefense: [number, number] = [0, 0];
  magicDefense: [number, number] = [0, 0];
  taoistDefense: [number, number] = [0, 0];
  onMap: MapId = "0";
  equipments: { [key in EQUIPMENT_TYPE]: Equipment | null } = {
    [EQUIPMENT_TYPE.CLOTH]: null,
    [EQUIPMENT_TYPE.ACCESSORIES]: null,
    [EQUIPMENT_TYPE.BELT]: null,
    [EQUIPMENT_TYPE.HELMET]: null,
    [EQUIPMENT_TYPE.NECKLACE]: null,
    [EQUIPMENT_TYPE.RING]: null,
    [EQUIPMENT_TYPE.SCAPULAR]: null,
    [EQUIPMENT_TYPE.SHINGUARD]: null,
    [EQUIPMENT_TYPE.SHOES]: null,
    [EQUIPMENT_TYPE.WEAPON]: null,
    [EQUIPMENT_TYPE.WRISTBAND]: null,
    [EQUIPMENT_TYPE.OTHER1]: null,
    [EQUIPMENT_TYPE.OTHER2]: null,
  };
  skills: { [key in SkillId]: number } = {
    "1000": 1,
    "1001": 1,
    "1002": 1,
    "1003": 1,
    "1004": 1,
    "1005": 1,
    "1006": 1,
    "1007": 1,
    "1008": 1,
    "1009": 1,
    "1010": 1,
    "1011": 1,
  };
  /** 快捷键 */
  shortcutKeys: needSetShortCutKeyConfig[] = [
    {
      label: "1",
      key: 49,
      skillId: null,
    },
    {
      label: "2",
      key: 50,
      skillId: null,
    },
    {
      label: "3",
      key: 51,
      skillId: null,
    },
    {
      label: "4",
      key: 52,
      skillId: null,
    },
  ];
  /** 速度倍率 */
  speedRate: SpeedRate = {
    [ACTION.STAND]: 1,
    [ACTION.WALK]: 1,
    [ACTION.RUN]: 1,
    [ACTION.ATTACK_NEAR]: 1,
    [ACTION.TEST2]: 1,
    [ACTION.TEST3]: 1,
    [ACTION.ATTACK_FAR]: 1,
    [ACTION.INJURED]: 1,
    [ACTION.A1]: 1,
    [ACTION.DIE]: 1,
    [ACTION.TEST1]: 1,
  };
  constructor(name: string, occupation: OECCUPATION, sex: SEX) {
    this.id = new Date().getTime().toString();
    this.name = name;
    this.occupation = occupation;
    this.sex = sex;
    this.hp = this.maxHp = levelMap.get(this.level).maxHp;
    this.combat = this.maxHp * 10;
    this.physicalAttack = levelMap.get(this.level).physicalAttack;

    // 初始化背包数据
    this.bag = [];
    for (let row = 0; row < bagRow; row++) {
      this.bag[row] = [];
      for (let col = 0; col < bagCol; col++) {
        this.bag[row][col] = null;
      }
    }
    // 初始化成功后，获得新手物品
    const equiments = getNewRoleEquipments(this);
    equiments.forEach((eq, index) => {
      this.bag[Math.floor(index / bagCol)][index % bagCol] = eq;
    });
  }
}

// 获得新手装备
function getNewRoleEquipments(role) {
  // 通用装备
  const equipments = [rings[0], nicklaces[0], shoes[0], helmets[0], belts[0]];

  // 根据角色职业，性别获取衣服
  if (role.sex === SEX.BOY) {
    if (role.occupation === OECCUPATION.ZHAN) equipments.push(clothes[0]);
  } else {
    if (role.occupation === OECCUPATION.ZHAN) equipments.push(clothes[1]);
  }
  // 根据角色职业获得武器
  if (role.occupation === OECCUPATION.ZHAN) equipments.push(weapons[0]);
  return equipments;
}
