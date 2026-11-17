import { Graphics, isValid, Node, Size, Vec2 } from "cc";
import LayerManager from "../../core/LayerManager";
import StorageManager from "../../core/StorageManager";
import UiHelper from "../../helpers/UiHelper";
import GameUiHelper from "../../helpers/GameUiHelper";
import { Role } from "../../../entities/Role";
import { SkillId } from "../../../types/skill";
import { T, skillShortcutSettingDialogLayout as layout } from "../../../configs/hudLayout";
import { getText } from "../../../configs/texts";
import { skills } from "../../../configs/skill";
import { blockClickThrough } from "../../utils/input/UiHit";

/**
 * 技能快捷键设置弹窗（稿 07-skill 的 .key-dlg）
 *
 * 打开后为指定技能选择要绑定的键位，选择后经 StorageManager.changeShortcutKey 落库并**立即关闭**
 * （稿的副标题写的就是「立即生效并关闭」）。
 * 卡片内容 = 键位数字 + 该键位当前绑的技能名（空 = 「空」）；正在被改的这个键位按金框金字高亮。
 * 同一时间只保留一个实例（重复打开会先关闭上一个）。
 */
export default class SkillShortcutSettingDialog {
  /** 弹窗节点 */
  private dialog: Node | null = null;

  /** 打开：为指定技能选择键位 */
  open(role: Role, skillId: SkillId) {
    this.close();
    const dialog = GameUiHelper.createDialog(layout.name, layout.title, new Vec2(), layout.size);
    // 副标题（稿 .key-hint）
    dialog.addChild(
      UiHelper.createLabel(
        `${layout.name}_hint`,
        getText("label_shortcut_hint"),
        layout.hint.color,
        layout.hint.fontSize,
        new Vec2(0, layout.hint.y),
        new Size(layout.hint.width, layout.hint.height),
      ),
    );
    const row = layout.optionsRow;
    const options = UiHelper.createFlexRow(row.name, row.spacing, new Vec2(0, row.y), new Size(row.width, row.height));
    role.shortcutKeys.forEach((config, index) => {
      // 当前这个技能已经在这个键位上 → 高亮（稿 .keybtn.on）
      const selected = config.skillId === skillId;
      const card = this.createKeyCard(`shortcut_key_option_${config.label}`, config.label, config.skillId, selected);
      // 卡片是点击元素：补鼠标通道登记，点它不会穿透到下层 UI（audit-ui-click-through 守点）
      blockClickThrough(card);
      card.on(
        Node.EventType.TOUCH_END,
        () => {
          StorageManager.changeShortcutKey(index, skillId);
          this.close();
        },
        this,
      );
      options.addChild(card);
    });
    dialog.addChild(options);
    this.dialog = dialog;
    LayerManager.addDialogToUILayer(dialog);
  }

  /** 一张键位卡片：大号数字 + 下方技能名（空 = 「空」），选中态金框金字 */
  private createKeyCard(name: string, keyLabel: string, boundSkillId: SkillId | null, selected: boolean) {
    const { keySize, number, label, selected: on } = layout.optionsRow;
    const card = UiHelper.createNode(name, new Vec2(), keySize);
    this.paintCard(card.addComponent(Graphics), keySize, selected);
    card.addChild(
      UiHelper.createLabel(
        `${name}_num`,
        keyLabel,
        selected ? on.number : number.color,
        number.fontSize,
        new Vec2(0, number.offsetY),
        new Size(keySize.width, number.fontSize + 4),
      ),
    );
    const bound = boundSkillId ? skills.get(boundSkillId) : null;
    card.addChild(
      UiHelper.createLabel(
        `${name}_skill`,
        bound ? bound.label : getText("label_shortcut_empty"),
        selected ? on.label : label.color,
        label.fontSize,
        new Vec2(0, label.offsetY),
        new Size(keySize.width - 6, label.fontSize + 4),
      ),
    );
    return card;
  }

  /** 卡片底板：1px 描边用「填外框色 → 内缩填主体色」两块画（引擎 1px 描边不渲染） */
  private paintCard(graphics: Graphics, size: Size, selected: boolean) {
    const border = selected ? layout.optionsRow.selected.border : T.line[2];
    const fill = selected ? T.surface[4] : T.surface[3];
    graphics.fillColor = border;
    graphics.rect(-size.width / 2, -size.height / 2, size.width, size.height);
    graphics.fill();
    graphics.fillColor = fill;
    graphics.rect(
      -size.width / 2 + T.border.width,
      -size.height / 2 + T.border.width,
      size.width - T.border.width * 2,
      size.height - T.border.width * 2,
    );
    graphics.fill();
  }

  /** 关闭弹窗 */
  close() {
    if (this.dialog && isValid(this.dialog)) this.dialog.destroy();
    this.dialog = null;
  }
}
