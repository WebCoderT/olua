import { Node, Size, Sprite, Vec2 } from "cc";
import UiHelper from "./UiHelper";
import GameUiHelper from "./GameUiHelper";
import LayerManager from "../utils/LayerManager";

const GameRoleUiHelper = {
  /**
   * 创建基础角色
   */
  createBasicRole() {
    const node = UiHelper.createSprite("basic_role", "", new Vec2(), new Size(40, 70));
    LayerManager.setLayerToUILayer(node);
    const cloth = UiHelper.createSprite("cloth", "");
    cloth.getComponent(Sprite).sizeMode = Sprite.SizeMode.RAW;
    LayerManager.setLayerToUILayer(cloth);
    node.addChild(cloth);
    const weapon = UiHelper.createSprite("weapon", "");
    weapon.getComponent(Sprite).sizeMode = Sprite.SizeMode.RAW;
    LayerManager.setLayerToUILayer(weapon);
    node.addChild(weapon);
    return {
      node,
      cloth,
      weapon,
    };
  },

  /**
   * 创建通用弹窗
   */
  createDialog(name: string, title: string) {
    // 弹窗
    const dialog = GameUiHelper.createDialogBg(name);
    LayerManager.setLayerToUILayer(dialog);
    // 弹窗标题
    const dialogTitle = GameUiHelper.createDialogTitle("dialog_title", title);
    LayerManager.setLayerToUILayer(dialogTitle);
    dialog.addChild(dialogTitle);
    // 关闭弹窗按钮
    const closeButton = GameUiHelper.createCloseButton("close_button", new Vec2(280, 230));
    LayerManager.setLayerToUILayer(closeButton);
    dialog.addChild(closeButton);
    // 添加关闭功能
    closeButton.on(Node.EventType.TOUCH_END, () => dialog.destroy(), this);
    return dialog;
  },
};

export default GameRoleUiHelper;
