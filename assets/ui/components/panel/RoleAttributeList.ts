import { Node, Size, Vec2 } from "cc";
import { Role } from "../../../entities/Role";
import GameUiHelper from "../../helpers/GameUiHelper";

/** 属性列表布局（弹窗内固定几何） */
const ATTRIBUTE_LIST_POSITION = new Vec2(217, 205);
const ATTRIBUTE_LIST_SIZE = new Size(150, 0);

/**
 * 角色属性列表组件（角色信息弹窗中的基础/特殊属性清单）
 * 本组件自身即属性列表容器，条目内容与样式由 GameUiHelper 零件生成
 */
export default class RoleAttributeList extends Node {
  constructor(role: Role) {
    super("role_attributes");
    GameUiHelper.applyRoleAttributeListStyle(this, role, ATTRIBUTE_LIST_POSITION, ATTRIBUTE_LIST_SIZE);
  }
}
