import NodeRoleAvatarFrame from "../nodes/RoleAvatar";
import LayerManager from "../utils/LayerManager";
import { Role } from "../../configs/role";

interface RoleAvatarFrame {
  node: NodeRoleAvatarFrame | null;
  init: (role: Role) => void;
  update: (role: Role) => void;
}

const RoleAvatarFrame: RoleAvatarFrame = {
  node: null,
  init: (role) => {
    RoleAvatarFrame.node = new NodeRoleAvatarFrame(role);
    LayerManager.addToUILayer(RoleAvatarFrame.node);
  },
  update(role: Role) {
    /** RoleAvatarFrame.node?.updateRole(role); */
  },
};

export default RoleAvatarFrame;
