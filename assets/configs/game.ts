import { Size, Vec2 } from "cc";
import GameRoleUiHelper from "../ui/helpers/GameRoleUiHelper";
import RoleInformationDialog from "../ui/components/RoleInformationDialog";
import RoleBagDialog from "../ui/components/RoleBagDialog";

export interface RoleOccupationInfo {
  name: string;
  // 介绍文字的图片路径
  description: string;
  // 介绍文字的图片尺寸
  descriptionSize: Size;
}

// 职业
export enum OECCUPATION {
  ZHAN = 1,
  FA = 2,
  DAO = 3,
}

// 角色MAP
export const roleMap = new Map<OECCUPATION, RoleOccupationInfo>();

roleMap.set(OECCUPATION.ZHAN, { name: "战士", description: "create_role/tips_1", descriptionSize: new Size(245, 51) });
roleMap.set(OECCUPATION.FA, { name: "魔法师", description: "create_role/tips_2", descriptionSize: new Size(249, 69) });
roleMap.set(OECCUPATION.DAO, { name: "道士", description: "create_role/tips_3", descriptionSize: new Size(249, 69) });

/**
 * @param key 游戏角色编号
 * @returns 游戏角色信息
 */
export function getRoleOccupationInfoById(key: OECCUPATION): RoleOccupationInfo {
  return roleMap.get(key);
}

// 性别
export enum SEX {
  BOY = 1,
  GRIL = 2,
}

// 性别MAP
export const sexMap = new Map<string, string>();

sexMap.set("1", "男");
sexMap.set("2", "女");

// 关系MAP
export enum RELATION_SHIP {
  SELF = "1",
  BROTHER = "2",
}

// 关系文字map
export const relationShipMap = new Map<RELATION_SHIP, string>();
relationShipMap.set(RELATION_SHIP.SELF, "自己");
relationShipMap.set(RELATION_SHIP.BROTHER, "兄弟");

// 关系的角色信息显示位置关系map
export const RoleInfoFramePositionsMap = new Map<RELATION_SHIP, Vec2>();
RoleInfoFramePositionsMap.set(RELATION_SHIP.SELF, new Vec2(-648, 324));
RoleInfoFramePositionsMap.set(RELATION_SHIP.BROTHER, new Vec2());

// 主页面下方导航部分功能按键接口
export interface BottomNavBarButton {
  label: string;
  icon: string;
  openLevel: number;
  onClick: Function;
  name: string;
}

// 主页面下方导航部分功能按键
export const bottomNavBarButtons: BottomNavBarButton[] = [
  { label: "角色", icon: "bottom-nav-bar/role", openLevel: 1, onClick: RoleInformationDialog.open, name: "personal_information_dialog" },
  { label: "背包", icon: "bottom-nav-bar/bag", openLevel: 1, onClick: RoleBagDialog.open, name: "bag_dialog" },
  { label: "好友", icon: "bottom-nav-bar/friend", openLevel: 10, onClick: GameRoleUiHelper.createPersonalInformationDialog, name: "personal_information_dialog" },
  { label: "组队", icon: "bottom-nav-bar/group", openLevel: 10, onClick: GameRoleUiHelper.createPersonalInformationDialog, name: "personal_information_dialog" },
  { label: "任务", icon: "bottom-nav-bar/task", openLevel: 1, onClick: GameRoleUiHelper.createPersonalInformationDialog, name: "personal_information_dialog" },
  { label: "技能", icon: "bottom-nav-bar/skill", openLevel: 1, onClick: GameRoleUiHelper.createPersonalInformationDialog, name: "personal_information_dialog" },
  { label: "坐骑", icon: "bottom-nav-bar/horse", openLevel: 1, onClick: GameRoleUiHelper.createPersonalInformationDialog, name: "personal_information_dialog" },
  { label: "商城", icon: "bottom-nav-bar/mall", openLevel: 1, onClick: GameRoleUiHelper.createPersonalInformationDialog, name: "personal_information_dialog" },
  { label: "设置", icon: "bottom-nav-bar/config", openLevel: 1, onClick: GameRoleUiHelper.createPersonalInformationDialog, name: "personal_information_dialog" },
];

// 装备类型
export enum EQUIPMENT_TYPE {
  CLOTH = "cloth", // 衣服
  ACCESSORIES = "accessories", // 饰品
  BELT = "belt", // 腰带
  HELMET = "helmet", // 头盔
  NECKLACE = "necklace", // 项链
  RING = "ring", // 戒指
  SCAPULAR = "scapular", // 肩胛
  SHINGUARD = "shinguard", // 护腿
  SHOES = "shoes", // 鞋子
  WEAPON = "weapon", // 武器
  WRISTBAND = "wristband", // 护腕
  OTHER1 = "other1", // 其他1
  OTHER2 = "other2", // 其他2
}

// 装备槽接口
interface EquipmentSlot {
  // 名称
  label: string;
  // 图片地址
  imageSrc: string;
  // 插槽位置
  position: "left" | "right" | "bottom" | "custom";
  // 下方特殊插槽为主,当为
  customPosition?: Vec2;
}

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

// 背包插槽行数和列数
export const bagRow = 7; // 10行
export const bagCol = 11; // 10列

// 8方向：地图或角色朝向的八个离散方向编码
export enum ROLE_DIRECTION {
  // 上
  UP = "up",
  // 右上
  RIGHT_UP = "right_up",
  // 右
  RIGHT = "right",
  // 右下
  RIGHT_DOWN = "right_down",
  // 下
  DOWN = "down",
  // 左下
  LEFT_DOWN = "left_down",
  // 左
  LEFT = "left",
  // 左上
  LEFT_UP = "left_up",
}

// 动作：角色或NPC可能的动作状态，用以控制动画与移动逻辑
export enum ROLE_ACTION {
  // 站立
  STAND = "stand",
  // 走路
  WALK = "walk",
  // 跑动
  RUN = "run",
}

// 角色动作顺序
export const roleActions: ROLE_ACTION[] = [ROLE_ACTION.STAND, ROLE_ACTION.WALK, ROLE_ACTION.RUN];

// 角色方向顺序
export const roleDirections: ROLE_DIRECTION[] = [
  ROLE_DIRECTION.UP,
  ROLE_DIRECTION.RIGHT_UP,
  ROLE_DIRECTION.RIGHT,
  ROLE_DIRECTION.RIGHT_DOWN,
  ROLE_DIRECTION.DOWN,
  ROLE_DIRECTION.LEFT_DOWN,
  ROLE_DIRECTION.LEFT,
  ROLE_DIRECTION.LEFT_UP,
];

// 获取角色动画名称,实现归一化
export function getRoleAnimationName(action: ROLE_ACTION, direction: ROLE_DIRECTION) {
  return `${action}_${direction}`;
}

// 角色裸模动画长度（动作+方向）
export const roleBasicSpriteFrameInterval = 8;

// 角色拥有动画map
export const roleAnimationMap = new Map<string, number[]>();
// 角色动画map填入数据
roleActions.forEach((action, actionIndex) => {
  roleDirections.forEach((direction, directionIndex) => {
    roleAnimationMap.set(
      getRoleAnimationName(action, direction),
      Array.from({ length: roleBasicSpriteFrameInterval }, (v, k) => {
        return actionIndex * roleDirections.length * roleBasicSpriteFrameInterval + directionIndex * roleBasicSpriteFrameInterval + k;
      }),
    );
  });
});

// 物品类型
export enum GOOD_TYPE {
  GOLD = "gold", // 金
}

// 游戏中的所有基础属性
export interface CommonAttributes {
  // 名称
  label: string;
  // 等级
  level: number;
  // 介绍
  description: string;
  // 图标
  icon: string;
  // 出售价格
  sellPirce: number;
}
