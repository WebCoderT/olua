/** 账号 / 管理员状态 */
export const ENTITY_STATUS = {
  /** 正常 */
  ACTIVE: "active",
  /** 已停用（玩家账号 = 封禁；管理员 = 停用） */
  DISABLED: "disabled",
} as const;

export type EntityStatus = (typeof ENTITY_STATUS)[keyof typeof ENTITY_STATUS];
