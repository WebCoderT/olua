import { Node } from "cc";
import { Role } from "../../../entities/Role";
import GameUiHelper from "../../helpers/GameUiHelper";
import { roleAttributeListLayout } from "../../../configs/hudLayout";

/**
 * 角色属性列表组件（角色信息弹窗中的基础/特殊属性清单）
 * 本组件自身即属性列表容器，条目内容与样式由 GameUiHelper 零件生成
 * 位置与尺寸见 configs/hudLayout.roleAttributeListLayout
 */
export default class RoleAttributeList extends Node {
  constructor(role: Role) {
    super(roleAttributeListLayout.name);
    GameUiHelper.applyRoleAttributeListStyle(this, role, roleAttributeListLayout.position, roleAttributeListLayout.size);
  }

  /** 属性变化后刷新（装备穿脱、升级等；条目内容按最新属性重建） */
  update(role: Role) {
    GameUiHelper.applyRoleAttributeListStyle(this, role, roleAttributeListLayout.position, roleAttributeListLayout.size);
  }
}
