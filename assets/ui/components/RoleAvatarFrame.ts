import { Label, Node } from "cc";
import GameUiHelper from "../helpers/GameUiHelper";
import LayerManager from "../utils/LayerManager";
import { Role } from "../../configs/role";

interface RoleAvatarFrame {
  combatNumber: Node | null;
  init: (role: Role) => void;
  level: Node | null;
  update: (role: Role) => void;
}

const RoleAvatarFrame: RoleAvatarFrame = {
  // 战斗力
  combatNumber: null,
  init: (role) => {
    // 用户头像
    const avatarNodes = GameUiHelper.createRoleInfoFrame(role);
    RoleAvatarFrame.combatNumber = avatarNodes.combatNumber;
    RoleAvatarFrame.level = avatarNodes.level;
    LayerManager.addToUILayer(avatarNodes.node);
  },
  // 等级
  level: null,

  // 更新
  update(role: Role) {
    // 更新等级
    RoleAvatarFrame.level.getComponent(Label).string = role.level.toString();
    // 更新战斗力
    RoleAvatarFrame.combatNumber.getComponent(Label).string = role.combat.toString();
  },
};

export default RoleAvatarFrame;
