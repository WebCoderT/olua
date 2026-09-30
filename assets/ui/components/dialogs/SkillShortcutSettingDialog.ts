import { isValid, Node, Size, Vec2 } from "cc";
import LayerManager from "../../core/LayerManager";
import StorageManager from "../../core/StorageManager";
import GameUiHelper from "../../helpers/GameUiHelper";
import { Role } from "../../../entities/Role";
import { SkillId } from "../../../types/skill";

/** 弹窗名称 */
const DIALOG_NAME = "skill_shortcut_setting_dialog";

/**
 * 技能快捷键设置弹窗
 * 打开后为指定技能选择要绑定的快捷键，选择后经 StorageManager.changeShortcutKey 落库
 * 同一时间只保留一个实例（重复打开会先关闭上一个）
 */
export default class SkillShortcutSettingDialog {
  /** 弹窗节点 */
  private dialog: Node | null = null;

  /** 打开：为指定技能选择快捷键 */
  open(role: Role, skillId: SkillId) {
    this.close();
    // 尺寸按「快捷键数量」留足：每个选项按钮 50 宽 + 间距 10（见 GameUiHelper.createSmallButtion）
    const dialog = GameUiHelper.createDialog(DIALOG_NAME, "设置快捷键", new Vec2(), new Size(370, 200));
    const content = GameUiHelper.createRow("shortcut_key_options", 10, new Vec2(), new Size(350, 50));
    role.shortcutKeys.forEach((config, index) => {
      const button = GameUiHelper.createSmallButtion(`shortcut_key_option_${config.label}`, config.label, new Vec2());
      content.addChild(button);
      button.on(Node.EventType.TOUCH_END, () => StorageManager.changeShortcutKey(index, skillId), this);
    });
    dialog.addChild(content);
    this.dialog = dialog;
    LayerManager.addToUILayer(dialog);
  }

  /** 关闭弹窗 */
  close() {
    if (this.dialog && isValid(this.dialog)) this.dialog.destroy();
    this.dialog = null;
  }
}
