import { Role } from "../../configs";
import GameUiHelper from "../GameUiHelper";
import LayerHelper from "../LayerHelper";
import StorageHelper from "../StorageHelper";

interface RoleAvatarFrame {
  selectedRole: Role | null;
  init: () => void;
}

const RoleAvatarFrame: RoleAvatarFrame = {
  selectedRole: null,
  init() {
    // 初始化角色数据
    this.selectedRole = StorageHelper.findSelectedRole();
    // 用户头像
    LayerHelper.addToUILayer(GameUiHelper.createRoleInfoFrame(this.selectedRole));
  },
};

export default RoleAvatarFrame;
