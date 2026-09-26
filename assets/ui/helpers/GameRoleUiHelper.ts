import { Node, Size, Vec2 } from "cc";
import UiHelper from "./UiHelper";
import LayerHelper from "./LayerHelper";
import GameUiHelper from "./GameUiHelper";

const GameRoleUiHelper = {
  /**
   * 创建基础裸模
   */
  createBasicRole(): Node {
    const node = UiHelper.createSprite("basic_role", "role/0", new Vec2(), new Size(60, 70));
    LayerHelper.setLayerToRoleLayer(node);
    return node;
  },

  /**
   * 创建通用弹窗
   */
  createDialog(name: string, title: string) {
    // 弹窗
    const dialog = GameUiHelper.createDialog(name);
    LayerHelper.setLayerToUILayer(dialog);
    // 弹窗标题
    const dialogTitle = GameUiHelper.createDialogTitle("dialog_title", title);
    LayerHelper.setLayerToUILayer(dialogTitle);
    dialog.addChild(dialogTitle);
    // 关闭弹窗按钮
    const closeButton = GameUiHelper.createCloseButton("close_button", new Vec2(280, 230));
    LayerHelper.setLayerToUILayer(closeButton);
    dialog.addChild(closeButton);
    // 添加关闭功能
    closeButton.on(Node.EventType.TOUCH_END, () => dialog.destroy(), this);
    return dialog;
  },

  /**
   * 创建个人信息弹窗
   */
  createPersonalInformationDialog() {
    const dialog = GameRoleUiHelper.createDialog("personal_information_dialog", "角色信息");
    return dialog;
  },

  /**
   * 创建背包弹窗
   */
  createBagDialog(name: string) {
    const dialog = GameRoleUiHelper.createDialog(name, "背包");
    return dialog;
  },
};

export default GameRoleUiHelper;
