import { Size, Vec2 } from "cc";
import GameRoleUiHelper from "../ui/GameRoleUiHelper";

export interface RoleOccupationInfo {
  name: string;
  // 介绍文字的图片路径
  description: string;
  // 介绍文字的图片尺寸
  descriptionSize: Size;
}

// 角色MAP
export const roleMap = new Map<string, RoleOccupationInfo>();

roleMap.set("1", { name: "战士", description: "create_role/tips_1", descriptionSize: new Size(245, 51) });
roleMap.set("2", { name: "魔法师", description: "create_role/tips_2", descriptionSize: new Size(249, 69) });
roleMap.set("3", { name: "道士", description: "create_role/tips_3", descriptionSize: new Size(249, 69) });

export const roleMapKeys = roleMap.keys();

/**
 * @param key 游戏角色编号
 * @returns 游戏角色信息
 */
export function getRoleOccupationInfoById(key: string): RoleOccupationInfo {
  return roleMap.get(key);
}

// 性别MAP
export const sexMap = new Map<string, string>();

sexMap.set("1", "男");
sexMap.set("2", "女");

export const sexMapKeys = sexMap.keys();

/**
 * @param key 游戏性别编号
 * @returns 游戏性别信息
 */
export function getSex(key: string): String {
  return sexMap.get(key);
}

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
  { label: "角色", icon: "bottom-nav-bar/role", openLevel: 1, onClick: GameRoleUiHelper.createPersonalInformationDialog, name: "personal_information_dialog" },
  { label: "背包", icon: "bottom-nav-bar/bag", openLevel: 1, onClick: GameRoleUiHelper.createPersonalInformationDialog, name: "personal_information_dialog" },
  { label: "好友", icon: "bottom-nav-bar/friend", openLevel: 10, onClick: GameRoleUiHelper.createPersonalInformationDialog, name: "personal_information_dialog" },
  { label: "组队", icon: "bottom-nav-bar/group", openLevel: 10, onClick: GameRoleUiHelper.createPersonalInformationDialog, name: "personal_information_dialog" },
  { label: "任务", icon: "bottom-nav-bar/task", openLevel: 1, onClick: GameRoleUiHelper.createPersonalInformationDialog, name: "personal_information_dialog" },
  { label: "技能", icon: "bottom-nav-bar/skill", openLevel: 1, onClick: GameRoleUiHelper.createPersonalInformationDialog, name: "personal_information_dialog" },
  { label: "坐骑", icon: "bottom-nav-bar/horse", openLevel: 1, onClick: GameRoleUiHelper.createPersonalInformationDialog, name: "personal_information_dialog" },
  { label: "商城", icon: "bottom-nav-bar/mall", openLevel: 1, onClick: GameRoleUiHelper.createPersonalInformationDialog, name: "personal_information_dialog" },
  { label: "设置", icon: "bottom-nav-bar/config", openLevel: 1, onClick: GameRoleUiHelper.createPersonalInformationDialog, name: "personal_information_dialog" },
];

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
