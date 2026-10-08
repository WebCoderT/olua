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
  /** 战魂外显开关（勾选后在主角右上角挂当前等级的战魂动画，见 RoleDisplay.updateSoulShow） */
  soulShow: boolean = false;
  /** 称号等级（0 = 未激活；解锁/升级消耗绑定元宝，见 configs/title；属性加成计入 combatCalc，解锁后名牌动画常显头顶，见 RoleDisplay.updateTitleShow） */
  title: number = 0;
  /**
   * 军衔阶数（0 = 未授衔；晋升消耗绑定元宝，见 configs/rank，共 100 阶）
   * 属性加成计入 combatCalc；授衔后军衔名以**红色文字**常显在头顶信息栏血条上方（见 RoleDisplay.updateHead）
   */
  rank: number = 0;
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
    // 复制一份初始属性（不要直接引用配置里的区间数组，避免运行时改动污染配置表；
    // 完整属性由 GameHelper.combatCalc 按「等级 + 装备 + 战魂」重算）
    this.physicalAttack = [...levelMap.get(this.level).physicalAttack];

    // 初始化背包数据
    this.bag = [];
    for (let row = 0; row < bagRow; row++) {
      this.bag[row] = [];
      for (let col = 0; col < bagCol; col++) {
        this.bag[row][col] = null;
      }
    }
    // 初始化成功后，获得新手物品（配置对象经 items 注册表带有 id，格子只存 key + 数量）
    // 防御：超出背包容量的条目丢弃（绝不能越界写 bag[row]，否则报 Cannot set properties of undefined）；
    // 静默丢弃会让人以为东西发下去了，所以留一条可查的日志（调整新手物品清单后如果刷这条，说明该精简清单或扩背包）
    const newRoleItems = getNewRoleEquipments(occupation, sex);
    const capacity = bagRow * bagCol;
    if (newRoleItems.length > capacity) {
      console.warn(`[role] 新手物品 ${newRoleItems.length} 件超出背包容量 ${capacity} 格，末尾 ${newRoleItems.length - capacity} 件已丢弃`);
    }
    newRoleItems.slice(0, capacity).forEach((item, index) => {
      if (!item.id) return; // 无 id（没注册进物品总表）的条目跳过
      this.bag[Math.floor(index / bagCol)][index % bagCol] = { id: item.id, count: 1 };
    });
  }
}
