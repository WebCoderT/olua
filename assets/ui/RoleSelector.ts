import { _decorator, Component } from "cc";
import GameRoleSelectorUiHelper from "./helpers/GameRoleSelectorUiHelper";
import type { RoleSelectorCreateView, RoleSelectorMainView } from "./helpers/GameRoleSelectorUiHelper";
import { roles } from "../configs/game";
import StorageManager from "./utils/StorageManager";
import SceneManager from "./utils/SceneManager";
const { ccclass } = _decorator;

@ccclass("RoleSelector")
export class RoleSelector extends Component {
  private mainView: RoleSelectorMainView;
  private createRoleView: RoleSelectorCreateView | null = null;
  private ownerRoleSelectedId: string | null = null;

  start() {
    this.mainView = GameRoleSelectorUiHelper.createMainView(
      this.node,
      () => this.beginGame(),
      () => this.createRoleUI(),
    );
    this.showOwnerRolesUI();
  }

  beginGame() {
    if (this.ownerRoleSelectedId) {
      StorageManager.onlineRole(this.ownerRoleSelectedId);
      SceneManager.loadScene("Game");
    }
  }

  showOwnerRolesUI() {
    GameRoleSelectorUiHelper.updateRolePreviews(this.mainView, this.node, StorageManager.getRoles(), (roleId) => this.onlineRole(roleId));
  }

  private onlineRole(roleId: string) {
    this.ownerRoleSelectedId = roleId;
    const role = StorageManager.findRoleById(this.ownerRoleSelectedId);
    if (!role) return;
    GameRoleSelectorUiHelper.setBeginGameEnabled(this.mainView, true);
    GameRoleSelectorUiHelper.updateSelectedRole(this.mainView, role);
  }

  createRoleUI() {
    if (this.createRoleView) return;
    this.createRoleView = GameRoleSelectorUiHelper.createRoleView(
      this.node,
      {
        onCreateRole: () => this.createRole(),
        onCancelCreateRole: () => this.cancelCreateRoleUI(),
        onOccupationChanged: () => this.onOccupationChanged(),
      },
      roles,
    );
  }

  onOccupationChanged() {
    if (this.createRoleView) GameRoleSelectorUiHelper.updateOccupationSelection(this.createRoleView, roles);
  }

  cancelCreateRoleUI() {
    if (!this.createRoleView) return;
    GameRoleSelectorUiHelper.closeRoleView(this.createRoleView);
    this.createRoleView = null;
  }

  createRole() {
    if (!this.createRoleView) return;
    const role = GameRoleSelectorUiHelper.readRoleForm(this.createRoleView);
    if (!role.name) return;
    StorageManager.createRole(role.name, role.occupation, role.sex);
    this.cancelCreateRoleUI();
    this.showOwnerRolesUI();
  }

  update() {
    if (this.createRoleView) GameRoleSelectorUiHelper.syncCreateButtonState(this.createRoleView);
  }
}
