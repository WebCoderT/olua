import { Node } from "cc";
import { Role } from "../../configs";
import GameRoleUiHelper from "../GameRoleUiHelper";
import LayerHelper from "../LayerHelper";
import StorageHelper from "../StorageHelper";
import RolePlayFrame from "./RolePlayFrame";

interface RoleDisplayFrame {
  // 角色信息
  selectedRole: Role | null;
  // 基础裸模
  basicRole: Node | null;
  // 初始化
  init: (game: Node) => void;
}

const RoleDisplayFrame: RoleDisplayFrame = {
  selectedRole: null,
  basicRole: null,
  init(game: Node) {
    // 初始化角色数据
    this.selectedRole = StorageHelper.findSelectedRole();
    // 创建基础裸模
    RoleDisplayFrame.basicRole = GameRoleUiHelper.createBasicRole();
    game.addChild(RoleDisplayFrame.basicRole);
    // 初始化角色操作
    RolePlayFrame.init(RoleDisplayFrame.basicRole);
  },
};

export default RoleDisplayFrame;
