import { SpeedRate } from "../types/animation";
import { BattleAttributes } from "../types/common";
import { EQUIPMENT_TYPE, BagCell } from "../types/good";
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
  /** 最大魔法值（按等级取自 configs/level） */
  maxMp: number;
  /** 当前魔法值：释放技能扣除（技能消耗见 configs/skill 的 mpCost），读写统一走 ui/utils/battle/MpHelper */
  mp: number;
  /** 魔法值自然回复的累积量（不足 1 点的部分，避免低回复速度下被取整丢弃） */
  mpRecoverAccumulator: number = 0;
  /** 背包：格子只存物品 key 与数量（BagCell），物品数据经 configs/items 实时解析 */
  bag: Array<Array<BagCell | null>>;
  combat: number = 0;
  /** 战魂等级（0 = 未激活；升级消耗绑定元宝，见 configs/soul；属性加成计入 combatCalc，也是地图 soulOfWar 进入条件） */
  soulOfWar: number = 0;
  physicalAttack: [number, number] = [0, 0];
  magicAttack: [number, number] = [0, 0];
  taoistAttack: [number, number] = [0, 0];
  physicalDefense: [number, number] = [0, 0];
  magicDefense: [number, number] = [0, 0];
  taoistDefense: [number, number] = [0, 0];
  onMap: MapId = "0";
  /** 已穿戴装备：槽位只存装备 id（items 总表的 key），装备数据一律经 configs/items.getEquipment 实时解析，
   *  因此调整装备配置后重启即可生效，无需重新穿戴；旧存档快照由 StorageManager.ensureRoleDefaults 迁移 */
  equipments: { [key in EQUIPMENT_TYPE]: string | null } = {
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
    this.mp = this.maxMp = levelMap.get(this.level).maxMp;
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
    // 初始化成功后，获得新手物品（配置对象经 items 注册表带有 id，格子只存 key + 数量）
    const equipments = getNewRoleEquipments(occupation, sex);
    equipments.forEach((eq, index) => {
      this.bag[Math.floor(index / bagCol)][index % bagCol] = eq.id ? { id: eq.id, count: 1 } : null;
    });
  }
}
