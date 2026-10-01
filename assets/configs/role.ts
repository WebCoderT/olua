import { ACTION, SpeedRate } from "../types/animation";
import { Equipment } from "../types/good";
import { NeedSetShortcutKeyConfig, OECCUPATION, RELATION_SHIP, RoleOccupationInfo, SEX } from "../types/role";
import type { SkillId } from "../types/skill";
import { Size, Vec2 } from "cc";
import { belts, clothes, helmets, nicklaces, rings, shoes, weapons } from "./equipments";

/** 角色移动速度-全局 */
export const ROLE_WALK_SPEED = 2;
/** 角色跑动速度-全局 */
export const ROLE_RUN_SPEED = 4;

/**
 * 鼠标操控角色（鼠标左键按下走路、右键按下跑动，抬起即停）
 * 移动方向 = 「按下点相对角色的方位」按 360° 平分八块取其一（与角色八方向动画、八方向移动一致），
 * 由 components/input/RolePointerInput 负责取点与判定，这里只放手感参数
 */
export const pointerMove = {
  /** 死区：按下点与角色的距离小于该值视为「原地按下」，不移动（世界单位；角色体型 40×70） */
  deadZone: 24,
};

/**
 * 角色魔法值自然回复速度（点/秒），设为 0 即关闭自然回复
 * 最大魔法值见 configs/level 的等级配置（maxMp），技能消耗见 configs/skill 的 mpCost
 */
export const mpRecoverPerSecond = 2;

/**
 * 角色默认外观目录（未穿戴衣服时使用）
 * 保证角色始终有身体，同时让"预加载角色外观"与 RoleAppearance 的回退取到同一份资源
 */
export const ROLE_DEFAULT_CLOTH_OUT = "role/1";

/** 职业介绍信息MAP */
export const occupations = new Map<OECCUPATION, RoleOccupationInfo>();

occupations.set(OECCUPATION.ZHAN, { name: "战士", description: "create_role/tips_1", descriptionSize: new Size(245, 51) });
occupations.set(OECCUPATION.FA, { name: "魔法师", description: "create_role/tips_2", descriptionSize: new Size(249, 69) });
occupations.set(OECCUPATION.DAO, { name: "道士", description: "create_role/tips_3", descriptionSize: new Size(249, 69) });

/** 关系的角色信息显示位置关系map */
export const roleInfoPositions = new Map<RELATION_SHIP, Vec2>();
roleInfoPositions.set(RELATION_SHIP.SELF, new Vec2(-648, 324));
roleInfoPositions.set(RELATION_SHIP.BROTHER, new Vec2());

// 背包插槽行数和列数
export const bagRow = 7; // 7行
export const bagCol = 11; // 11列

/** 初始金币数量 */
export const initialGold = 10000;
export const initialBindGold = 10000;
export const initialSilver = 10000;

/** 初始技能等级表（角色创建时全部解锁1级） */
export const initialSkills: { [key in SkillId]: number } = {
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

/** 初始快捷键配置 */
export const initialShortcutKeys: NeedSetShortcutKeyConfig[] = [
  { label: "1", key: 49, skillId: null },
  { label: "2", key: 50, skillId: null },
  { label: "3", key: 51, skillId: null },
  { label: "4", key: 52, skillId: null },
  { label: "5", key: 53, skillId: null },
  { label: "6", key: 54, skillId: null },
];

/** 角色默认速度倍率 */
export const defaultRoleSpeedRate: SpeedRate = {
  [ACTION.STAND]: 1,
  [ACTION.WALK]: 1,
  [ACTION.RUN]: 1,
  [ACTION.ATTACK_NEAR]: 1,
  [ACTION.ATTACK_SKILL_1]: 1,
  [ACTION.TEST3]: 1,
  [ACTION.ATTACK_FAR]: 1,
  [ACTION.INJURED]: 1,
  [ACTION.A1]: 1,
  [ACTION.DIE]: 1,
  [ACTION.TEST1]: 1,
};

/** 根据职业与性别获取新手装备 */
export function getNewRoleEquipments(occupation: OECCUPATION, sex: SEX): Equipment[] {
  // 通用装备
  const equipments = [rings[0], nicklaces[0], shoes[0], helmets[0], belts[0]];

  // 根据角色职业，性别获取衣服
  if (sex === SEX.BOY) {
    if (occupation === OECCUPATION.ZHAN) equipments.push(clothes[0]);
  } else {
    if (occupation === OECCUPATION.ZHAN) equipments.push(clothes[1]);
  }
  // 根据角色职业获得武器
  if (occupation === OECCUPATION.ZHAN) equipments.push(weapons[0]);
  return equipments;
}
