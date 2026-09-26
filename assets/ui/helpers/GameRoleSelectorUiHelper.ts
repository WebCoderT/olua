import { Color, EditBox, EventHandler, Label, Node, Size, Sprite, ToggleContainer, Vec2 } from "cc";
import GameUiHelper from "./GameUiHelper";
import UiHelper from "./UiHelper";
import { Role } from "../../configs/role";
import { OECCUPATION, RoleOccupationInfo } from "../../types/common";

export interface RoleSelectorMainView {
  beginGameButton: Node;
  selectedRoleName: Node;
  selectedRoleLevel: Node;
  ownerRoleNodes: Node[];
}

export interface RoleSelectorCreateView {
  backButton: Node;
  dialog: Node;
  nameInput: Node;
  sexToggleGroup: Node;
  occupationToggleGroup: Node;
  createButton: Node;
  occupationDescription: Node | null;
  occupationPreview: Node | null;
}

interface RoleSelectorCallbacks {
  onCreateRole: () => void;
  onCancelCreateRole: () => void;
  onOccupationChanged: () => void;
}

const rolePositions = [new Vec2(-485, -25), new Vec2(-250, -75), new Vec2(-10, -40)];

const GameRoleSelectorUiHelper = {
  createMainView(parent: Node, onBeginGame: () => void, onCreateRole: () => void): RoleSelectorMainView {
    parent.addChild(UiHelper.createFullScreenNode("role_selector_background", "create_role/bg"));

    const bottomBar = UiHelper.createSprite("role_selector_bottom_bar", "create_role/bg_bottom", new Vec2(0, -305), new Size(1624, 139));
    parent.addChild(bottomBar);

    const beginGameButton = UiHelper.createButton("begin_game_button", "create_role/start_btn", new Vec2(0, -40), new Size(190, 48));
    beginGameButton.getComponent(Sprite).grayscale = true;
    beginGameButton.on(Node.EventType.TOUCH_END, onBeginGame);
    bottomBar.addChild(beginGameButton);

    const createRoleButton = UiHelper.createButton("show_create_role_button", "create_role/new_role", new Vec2(-740, 300), new Size(75, 79));
    createRoleButton.on(Node.EventType.TOUCH_END, onCreateRole);
    parent.addChild(createRoleButton);

    parent.addChild(UiHelper.createButton("manage_role_button", "create_role/manage", new Vec2(-740, 200), new Size(75, 79)));

    const selectedInfoBox = UiHelper.createSprite("selected_role_info_background", "create_role/idlv", new Vec2(-435, -335), new Size(345, 26));
    selectedInfoBox.addChild(UiHelper.createLabel("selected_role_name", "---", Color.WHITE, 20, new Vec2(-35, 0), new Size(160, 30)));
    selectedInfoBox.addChild(UiHelper.createLabel("selected_role_level", "-", Color.WHITE, 16, new Vec2(147, 0), new Size(40, 30)));
    parent.addChild(selectedInfoBox);

    return {
      beginGameButton,
      selectedRoleName: selectedInfoBox.getChildByName("selected_role_name"),
      selectedRoleLevel: selectedInfoBox.getChildByName("selected_role_level"),
      ownerRoleNodes: [],
    };
  },

  updateRolePreviews(view: RoleSelectorMainView, parent: Node, roles: Role[], ononlineRole: (roleId: string) => void): void {
    this.destroyNodes(view.ownerRoleNodes);
    view.ownerRoleNodes = roles.map((role, index) => {
      const node = GameUiHelper.createRolePreview(role.id, 1, role.occupation, role.sex, rolePositions[index] ?? new Vec2(), new Size(200, 360));
      node.on(Node.EventType.TOUCH_END, () => ononlineRole(role.id));
      parent.addChild(node);
      return node;
    });
  },

  destroyNodes(nodes: Node[]): void {
    nodes.forEach((node) => node.destroy());
    nodes.length = 0;
  },

  setBeginGameEnabled(view: RoleSelectorMainView, enabled: boolean): void {
    view.beginGameButton.getComponent(Sprite).grayscale = !enabled;
  },

  updateSelectedRole(view: RoleSelectorMainView, role: Role): void {
    view.selectedRoleName.getComponent(Label).string = role.name;
    view.selectedRoleLevel.getComponent(Label).string = role.level.toString();
  },

  createRoleView(parent: Node, callbacks: RoleSelectorCallbacks, occupations: Map<OECCUPATION, RoleOccupationInfo>): RoleSelectorCreateView {
    const backButton = UiHelper.createButton("cancel_create_role_button", "create_role/back_btn", new Vec2(-740, -210), new Size(75, 79));
    parent.addChild(backButton);
    backButton.on(Node.EventType.TOUCH_END, callbacks.onCancelCreateRole);

    const dialog = UiHelper.createSprite("create_role_dialog", "create_role/bg_dialog", new Vec2(630, 35), new Size(320, 580));
    parent.addChild(dialog);
    dialog.addChild(UiHelper.createSprite("create_role_dialog_title", "create_role/label_title", new Vec2(0, 242), new Size(128, 28)));
    dialog.addChild(UiHelper.createSprite("gender_label", "create_role/label_1", new Vec2(0, 190), new Size(56, 25)));

    const sexToggleGroup = UiHelper.createToggleGroup(
      "role_sex_toggle_group",
      [UiHelper.createToggle("1", "create_role/1_1", "create_role/1_0", new Vec2(), new Size(48, 48)), UiHelper.createToggle("2", "create_role/2_1", "create_role/2_0", new Vec2(), new Size(48, 48))],
      30,
      new Vec2(0, 148),
    );
    dialog.addChild(sexToggleGroup);

    dialog.addChild(UiHelper.createSprite("occupation_label", "create_role/label_2", new Vec2(0, 100), new Size(56, 25)));
    const occupationToggleGroup = UiHelper.createToggleGroup(
      "role_occupation_toggle_group",
      [
        UiHelper.createToggle("1", "create_role/3_1", "create_role/3_0", new Vec2(), new Size(48, 48)),
        UiHelper.createToggle("2", "create_role/4_1", "create_role/4_0", new Vec2(), new Size(48, 48)),
        UiHelper.createToggle("3", "create_role/5_1", "create_role/5_0", new Vec2(), new Size(48, 48)),
      ],
      30,
      new Vec2(0, 52),
    );
    dialog.addChild(occupationToggleGroup);

    const nameInputBackground = UiHelper.createSprite("role_name_input_background", "login/input_bg", new Vec2(0, -26), new Size(240, 60));
    const nameInput = UiHelper.createInputBox("role_name_input", "输入角色名称", new Vec2(0, -6), new Vec2(200, 60));
    nameInputBackground.addChild(nameInput);
    dialog.addChild(nameInputBackground);

    const createButton = UiHelper.createButton("confirm_create_role_button", "create_role/start_btn", new Vec2(0, -238), new Size(190, 48));
    createButton.getComponent(Sprite).grayscale = true;
    createButton.on(Node.EventType.TOUCH_END, callbacks.onCreateRole);
    dialog.addChild(createButton);

    const view: RoleSelectorCreateView = {
      backButton,
      dialog,
      nameInput,
      sexToggleGroup,
      occupationToggleGroup,
      createButton,
      occupationDescription: null,
      occupationPreview: null,
    };

    const eventHandler = new EventHandler();
    eventHandler.target = parent;
    eventHandler.component = "RoleSelector";
    eventHandler.handler = "onOccupationChanged";
    occupationToggleGroup.getComponent(ToggleContainer).checkEvents.push(eventHandler);
    sexToggleGroup.getComponent(ToggleContainer).checkEvents.push(eventHandler);

    this.updateOccupationSelection(view, occupations);
    return view;
  },

  updateOccupationSelection(view: RoleSelectorCreateView, occupations: Map<OECCUPATION, RoleOccupationInfo>): void {
    const occupationId = view.occupationToggleGroup.getComponent(ToggleContainer).activeToggles()[0]?.node.name;
    const sex = view.sexToggleGroup.getComponent(ToggleContainer).activeToggles()[0]?.node.name;
    const occupation = occupationId && occupations.get(Number(occupationId) as OECCUPATION);
    if (!occupation || !sex) return;

    view.occupationDescription?.destroy();
    view.occupationPreview?.destroy();

    view.occupationDescription = UiHelper.createSprite("occupation_description", occupation.description, new Vec2(0, -142), occupation.descriptionSize);
    view.dialog.addChild(view.occupationDescription);
    view.occupationPreview = GameUiHelper.createRolePreview("role_creation_preview", 0, occupationId, sex, new Vec2(-245, -95), new Size(200, 360));
    view.dialog.addChild(view.occupationPreview);
  },

  readRoleForm(view: RoleSelectorCreateView): { name: string; occupation: string; sex: string } {
    const occupation = view.occupationToggleGroup.getComponent(ToggleContainer).activeToggles()[0]?.node.name ?? "";
    const sex = view.sexToggleGroup.getComponent(ToggleContainer).activeToggles()[0]?.node.name ?? "";
    return {
      name: view.nameInput.getComponent(EditBox).string,
      occupation,
      sex,
    };
  },

  syncCreateButtonState(view: RoleSelectorCreateView): void {
    view.createButton.getComponent(Sprite).grayscale = !Boolean(view.nameInput.getComponent(EditBox).string);
  },

  closeRoleView(view: RoleSelectorCreateView): void {
    view.dialog.destroy();
    view.backButton.destroy();
  },
};

export default GameRoleSelectorUiHelper;
