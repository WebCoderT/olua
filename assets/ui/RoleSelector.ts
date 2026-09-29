import { _decorator, Component } from "cc";
import GameUiHelper from "./helpers/GameUiHelper";
import type { RoleSelectorCreateView, RoleSelectorMainView } from "./helpers/GameUiHelper";
import { roles } from "../configs/game";
import StorageManager from "./core/StorageManager";
import SceneManager from "./core/SceneManager";
const { ccclass } = _decorator;

@ccclass("RoleSelector")
export class RoleSelector extends Component {
  private mainView: RoleSelectorMainView;
  private createRoleView: RoleSelectorCreateView | null = null;
  private ownerRoleSelectedId: string | null = null;

  start() {
    this.mainView = GameUiHelper.createMainView(
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
    GameUiHelper.updateRolePreviews(this.mainView, this.node, StorageManager.getRoles(), (roleId) => this.onlineRole(roleId));
  }

  private onlineRole(roleId: string) {
    this.ownerRoleSelectedId = roleId;
    const role = StorageManager.findRoleById(this.ownerRoleSelectedId);
    if (!role) return;
    GameUiHelper.setBeginGameEnabled(this.mainView, true);
    GameUiHelper.updateSelectedRole(this.mainView, role);
  }

  createRoleUI() {
    if (this.createRoleView) return;
    this.createRoleView = GameUiHelper.createRoleView(
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
    if (this.createRoleView) GameUiHelper.updateOccupationSelection(this.createRoleView, roles);
  }

  cancelCreateRoleUI() {
    if (!this.createRoleView) return;
    GameUiHelper.closeRoleView(this.createRoleView);
    this.createRoleView = null;
  }

  createRole() {
    if (!this.createRoleView) return;
    const role = GameUiHelper.readRoleForm(this.createRoleView);
    if (!role.name) return;
    StorageManager.createRole(role.name, role.occupation, role.sex);
    this.cancelCreateRoleUI();
    this.showOwnerRolesUI();
  }

  update() {
    if (this.createRoleView) GameUiHelper.syncCreateButtonState(this.createRoleView);
  }
}
