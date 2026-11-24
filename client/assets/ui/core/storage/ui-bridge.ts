import RoleUIManager from "../RoleUIManager";
import { Role } from "../../../entities/Role";
import RoleDeltaLog from "./role-delta-log";
import { getItem } from "../../../configs/items";
import { skills } from "../../../configs/skill";
import { getFashion } from "../../../configs/game-config";
import type { SkillId } from "../../../types/skill";

/**
 * 角色 UI 刷新桥（#1115 批次 6）：storage 各子模块统一走它刷「信息栏 / 底栏 / 血条」，
 * 不再各自回头 import StorageManager（facade）—— 子模块只依赖视图，不依赖门面。
 *
 * #1229 起这里顺手记流水：本函数是「角色数据变了、要刷 UI」的单一出口，所以角色差分
 * （经验 / 等级 / 货币 / 物品 / 成长）挂在这里，新增数值来源不用再回来挂埋点。
 * 名称解析器也在这一层注入 —— 背包 / 技能 / 时装三张表要引擎与快照，差分模块自身保持纯 TS。
 */
RoleDeltaLog.configure({
  itemName: (id) => getItem(id)?.label ?? id,
  skillName: (id) => skills.get(id as SkillId)?.label ?? id,
  fashionName: (id) => getFashion(id)?.label ?? id,
});

export function updateRoleUi(role: Role) {
  // 先记流水再刷视图：数据已经是新的，顺序只影响观感（玩家先看到数字变，流水紧随）
  RoleDeltaLog.note(role);
  RoleUIManager.updateRoleData(role);
}
