import { Role } from "../../configs/role";

interface RoleAvatarView {
  updateRole: (role: Role) => void;
}

let roleAvatar: RoleAvatarView | null = null;
let updateBottomBar: ((role: Role) => void) | null = null;

const RoleUIManager = {
  registerRoleAvatar(view: RoleAvatarView) {
    roleAvatar = view;
  },

  registerBottomBarUpdater(updater: (role: Role) => void) {
    updateBottomBar = updater;
  },

  updateRoleData(role: Role) {
    roleAvatar?.updateRole(role);
    updateBottomBar?.(role);
  },
};

export default RoleUIManager;