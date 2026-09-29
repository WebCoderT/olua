import { ACTION, SpeedRate } from "../types/animation";
import { BattleAttributes } from "../types/common";
import { Equipment, EQUIPMENT_TYPE, Goods } from "../types/good";
import { NeedSetShortcutKeyConfig, OECCUPATION, RELATION_SHIP, SEX } from "../types/role";
import { SkillId } from "../types/skill";
import { MapId } from "../types/map";
import { bagCol, bagRow, defaultRoleSpeedRate, getNewRoleEquipments, initialBindGold, initialGold, initialShortcutKeys, initialSilver, initialSkills } from "../configs/role";
import { levelMap } from "../configs/level";

/**
 * 角色实体
 * 承载一个角色的运行时数据；初始数值与配置见 configs/role
 */
export class Role implements BattleAttributes {
  id: string;
  name: string;
  occupation: OECCUPATION;
  sex: SEX;
  level: number = 1;
  fashionCloth: number | null = null;
  relationShip: RELATION_SHIP = RELATION_SHIP.SELF;
  avatar: number = 0;
  gold: number = initialGold;
  bindGold: number = initialBindGold;
  silver: number = initialSilver;
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
  skills: { [key in SkillId]: number } = { ...initialSkills };
  /** 快捷键 */
  shortcutKeys: NeedSetShortcutKeyConfig[] = initialShortcutKeys.map((config) => ({ ...config }));
  /** 速度倍率 */
  speedRate: SpeedRate = { ...defaultRoleSpeedRate };

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
    const equipments = getNewRoleEquipments(occupation, sex);
    equipments.forEach((eq, index) => {
      this.bag[Math.floor(index / bagCol)][index % bagCol] = eq;
    });
  }
}
