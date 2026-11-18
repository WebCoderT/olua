import { isValid, Label, Node, Size, Vec2 } from "cc";
import SceneManager from "../../core/SceneManager";
import StorageManager from "../../core/StorageManager";
import UiHelper from "../../helpers/UiHelper";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import BaseDialog from "./dialog-kit";
import ConfirmDialog from "./ConfirmDialog";
import { settingsDialogLayout as layout } from "../../../configs/hudLayout";
import { buttonTone, ButtonTone } from "../../../configs/layout/sizes";
import { getText } from "../../../configs/texts";
import { logoutToLogin } from "../../utils/net/NetworkSetup";

/**
 * 设置弹窗（稿 21-settings；底部导航「设置」入口 / ESC 打开）
 *
 * 两行动作（2026-11-18 用户拍板的确认口径）：
 * - **选择角色**：直接执行 —— 清本地的在线角色标记并回选角场景（与被踢下线的兜底同一条路径，
 *   见 RoleSync.onKicked）；角色进度在 Game 场景卸载时由 RoleSync.flush 统一推给服务端，不丢。
 * - **退出登录**：先弹确认框，确认后走 `logoutToLogin()`（先吊销服务端令牌，再清本地会话回登录）。
 *
 * 同一时间只保留一个实例（重复打开先关旧的）；确认框挂 UI 层顶层（全屏模态）。
 */
export default class SettingsDialog extends BaseDialog {
  /** 退出登录确认框（全屏模态；同一时刻最多一个） */
  private confirmDialog: ConfirmDialog | null = null;

  /** 打开/关闭弹窗 */
  open() {
    this.openFrame(layout, (dialog) => {
      dialog.addChild(this.createActionRow(layout.rows.select, getText("settings_select_role"), getText("settings_select_role_desc"), () => this.selectRole()));
      dialog.addChild(this.createActionRow(layout.rows.logout, getText("settings_logout"), getText("settings_logout_desc"), () => this.confirmLogout()));
    });
  }

  /** 关闭弹窗时连确认框一起收（开着的时候点关闭键，不该留下一个盖住全屏的确认框） */
  protected onClose() {
    this.closeConfirm();
  }

  /** 一行动作：玻璃底板 + 名称/说明（左，左对齐）+ 行内按钮（右） */
  private createActionRow(row: (typeof layout.rows)["select"] | (typeof layout.rows)["logout"], nameText: string, descText: string, onTap: () => void) {
    const size = new Size(layout.rows.width, layout.rows.height);
    const node = UiHelper.createNode(row.name, new Vec2(0, row.y), size);
    // 行底板：HUD 常驻件同款玻璃底（半透明暖褐 + 一圈弱金线；弹窗里要暗一档，不抢标题）
    node.addChild(GameUiHelper.createGlassPlate(`${row.name}_plate`, size, 0));
    const { name, desc, buttonSize, buttonFontSize, buttonX } = layout.rows;
    node.addChild(
      UiHelper.createLabel(`${row.name}_name`, nameText, name.color, name.fontSize, new Vec2(name.x, name.offsetY), new Size(name.width, name.height), Label.HorizontalAlign.LEFT),
    );
    node.addChild(
      UiHelper.createLabel(`${row.name}_desc`, descText, desc.color, desc.fontSize, new Vec2(desc.x, desc.offsetY), new Size(desc.width, desc.height), Label.HorizontalAlign.LEFT),
    );
    const tone: ButtonTone = row.button.tone === "gold" ? buttonTone.gold : buttonTone.danger;
    const button = GameUiHelper.createToneButton(row.button.name, nameText, new Vec2(buttonX, 0), buttonSize, buttonFontSize, tone);
    button.on(Node.EventType.TOUCH_END, onTap, this);
    node.addChild(button);
    return node;
  }

  /** 选择角色：清在线角色标记并回选角场景（进度由 Game 场景卸载时的 RoleSync.flush 收尾） */
  private selectRole() {
    this.close();
    StorageManager.clearOnlineRole();
    SceneManager.loadScene("RoleSelector");
  }

  /** 退出登录：弹确认框（2026-11-18 用户拍板只给退出加确认），确认后吊销令牌回登录 */
  private confirmLogout() {
    if (this.confirmDialog && isValid(this.confirmDialog)) return;
    const confirm = new ConfirmDialog({
      title: getText("settings_logout_confirm_title"),
      message: getText("settings_logout_confirm_text"),
      confirmText: getText("settings_logout"),
      cancelText: getText("label_confirm_cancel"),
      // ConfirmDialog 先关自己再回调；这里再收掉引用与设置弹窗（人都要走登录了，弹窗不必留）
      onConfirm: () => {
        this.confirmDialog = null;
        this.close();
        logoutToLogin();
      },
      onCancel: () => {
        this.confirmDialog = null;
      },
    });
    this.confirmDialog = confirm;
    LayerManager.addDialogToUILayer(confirm);
  }

  /** 收掉确认框（没开着时什么也不做） */
  private closeConfirm() {
    if (this.confirmDialog && isValid(this.confirmDialog)) this.confirmDialog.destroy();
    this.confirmDialog = null;
  }
}
