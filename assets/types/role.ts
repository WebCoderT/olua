import { Size } from "cc";
import type { SkillId } from "./skill";

// 职业
export enum OECCUPATION {
  /** 战士 */
  ZHAN = "1",
  /** 法师 */
  FA = "2",
  /** 道士 */
  DAO = "3",
  /** 全职业 */
  ALL = "4",
}

// 性别
export enum SEX {
  /** 男 */
  BOY = "1",
  /** 女 */
  GRIL = "2",
  /** 全性别 */
  ALL = "3",
}

// 关系MAP
export enum RELATION_SHIP {
  /** 自己 */
  SELF = "1",
  /** 兄弟 */
  BROTHER = "2",
}

/** 职业介绍信息 */
export interface RoleOccupationInfo {
  /** 名称 */
  name: string;
  /** 介绍文字的图片路径 */
  description: string;
  /** 介绍文字的图片尺寸 */
  descriptionSize: Size;
}

/** 快捷键（keyCode） */
export type ShortcutKeys = 49 | 50 | 51 | 52;

/** 需要配置的快捷键接口 */
export interface NeedSetShortcutKeyConfig {
  /** 名称 */
  label: string;
  /** 快捷键 */
  key: ShortcutKeys;
  /** 技能id */
  skillId: SkillId | null;
}
