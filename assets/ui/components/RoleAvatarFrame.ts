import { Label, Node } from "cc";
import { Role } from "../../configs";
import GameUiHelper from "../GameUiHelper";
import LayerHelper from "../LayerHelper";
import StorageHelper from "../StorageHelper";

interface RoleAvatarFrame {
  selectedRole: Role | null;
  combatNumber: Node | null;
  init: () => void;
  level: Node | null;
  updateLevel: () => void;
}

const RoleAvatarFrame: RoleAvatarFrame = {
  // 角色信息
  selectedRole: null,
  // 战斗力
  combatNumber: null,
  init: () => {
    // 初始化角色数据
    RoleAvatarFrame.selectedRole = StorageHelper.findSelectedRole();
    // 用户头像
    const avatarNodes = GameUiHelper.createRoleInfoFrame(RoleAvatarFrame.selectedRole);
    RoleAvatarFrame.combatNumber = avatarNodes.combatNumber;
    RoleAvatarFrame.level = avatarNodes.level;
    LayerHelper.addToUILayer(avatarNodes.node);
  },
  // 等级
  level: null,
  // 更新等级
  updateLevel() {
    // 更新角色数据
    RoleAvatarFrame.selectedRole = StorageHelper.findSelectedRole();
    // 更新等级
    RoleAvatarFrame.level.getComponent(Label).string = RoleAvatarFrame.selectedRole.level.toString();
  },
};

export default RoleAvatarFrame;
