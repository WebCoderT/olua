import { isValid, Label, Node, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import StorageManager from "../../core/StorageManager";
import { getText } from "../../../configs/texts";
import { attrAllocateDialogLayout } from "../../../configs/hudLayout";
import { ATTR_POINT_KEYS, AttrPointKey } from "../../../types/role";
import ConfirmDialog from "./ConfirmDialog";

/**
 * 属性加点弹窗（#833）
 *
 * 只负责开关与把「+」的点击转成一次请求：行零件由 `GameUiHelper.createAttrPointRow`
 * 生成，几何见 `configs/hudLayout.attrAllocateDialogLayout`。
 *
 * 三条取舍：
 * - **一次加一点**：界面上就是四个「+」，点一下发一次（服务端接口本来支持多段增量，
 *   但「一次加几点」的输入框在手机上比四个按钮难用得多）；
 * - **加完就地重建**，不重开弹窗：重开会让玩家丢失「刚点了哪一项」的视觉连续性，
 *   而这个弹窗只有四行、重建成本可以忽略；
 * - **洗点必须二次确认**：它要花绑定元宝且不可撤销。确认框里**不写价格** ——
 *   价格只在服务端（`growth_scalars.attrResetCost`），写死一个数字，
 *   运营调价那天客服就会被「界面明明写着 300」找上门。
 */
export default class AttrAllocateDialog {
  /** 弹窗节点（切换关闭要用；关闭后置空） */
  private dialog: Node | null = null;
  /** 剩余点数标签（加完点改数字用） */
  private pointsLabel: Label | null = null;
  /** 四行的容器（加完点重建行用） */
  private listContent: Node | null = null;
  /** 洗点确认框（开着时不许再开一个） */
  private confirmDialog: ConfirmDialog | null = null;
  /** 正在等服务端回执：防止连点把同一笔请求发两次（第二个会被服务端按余额拒掉，但界面会闪） */
  private pending = false;

  /** 打开/关闭（开关：已开则关） */
  open() {
    if (this.dialog && isValid(this.dialog) && this.dialog.active) {
      this.close();
      return;
    }
    // 弹窗已在场景切换 / 关闭按钮销毁时清掉残留引用
    if (this.dialog && !isValid(this.dialog)) this.dialog = null;
    const dialog = GameUiHelper.createDialog(attrAllocateDialogLayout.name, attrAllocateDialogLayout.title, new Vec2(), attrAllocateDialogLayout.size);
    const pointsNode = GameUiHelper.createAttrPointsLabel();
    dialog.addChild(pointsNode);
    this.pointsLabel = pointsNode.getComponent(Label);
    const list = GameUiHelper.createAttrListView();
    this.listContent = list;
    dialog.addChild(list);
    dialog.addChild(GameUiHelper.createAttrResetButton(() => this.confirmReset()));
    this.dialog = dialog;
    LayerManager.addDialogToUILayer(dialog);
    this.rebuild();
  }

  /**
   * 重建四行 + 刷新剩余点数
   *
   * 角色数据每次都现读 `StorageManager`：加点回执已经把新值写进在线角色，
   * 所以重建出来就是最新状态（**不在本地加一** —— 那是第二个真相）。
   */
  private rebuild() {
    const role = StorageManager.findOnlineRole();
    const content = this.listContent;
    if (!role || !content || !isValid(content)) return;
    if (this.pointsLabel && isValid(this.pointsLabel)) {
      this.pointsLabel.string = getText("label_attr_points", { points: role.attrPoints });
    }
    content.removeAllChildren();
    ATTR_POINT_KEYS.forEach((key, index) => {
      const row = GameUiHelper.createAttrPointRow(role, key, () => void this.addPoint(key));
      // 四行手动摆（容器锚点左中）：行高固定，第一行中心在容器顶部内侧
      const top = attrAllocateDialogLayout.list.size.height / 2;
      row.setPosition(0, top - attrAllocateDialogLayout.row.height / 2 - index * (attrAllocateDialogLayout.row.height + attrAllocateDialogLayout.list.gap));
      content.addChild(row);
    });
  }

  /** 加一点（扣点、属性重算、落库都在服务端；成功后就地重建） */
  private async addPoint(key: AttrPointKey): Promise<void> {
    if (this.pending) return;
    this.pending = true;
    try {
      const ok = await StorageManager.allocateAttrsOnServer(key);
      if (ok) this.rebuild();
    } finally {
      this.pending = false;
    }
  }

  /** 洗点：先确认（花钱且不可撤销），确认后走服务端 */
  private confirmReset() {
    if (this.confirmDialog && isValid(this.confirmDialog)) return;
    const confirm = new ConfirmDialog({
      title: getText("label_attr_reset_title"),
      message: getText("label_attr_reset_confirm"),
      confirmText: getText("label_confirm_ok"),
      cancelText: getText("label_confirm_cancel"),
      onConfirm: () => {
        this.confirmDialog = null;
        void this.reset();
      },
      onCancel: () => {
        this.confirmDialog = null;
      },
    });
    this.confirmDialog = confirm;
    LayerManager.addDialogToUILayer(confirm);
  }

  /** 真的洗点：四维归零 + 点数全退 + 扣绑定元宝，三件事都在服务端同一次写档里 */
  private async reset(): Promise<void> {
    if (this.pending) return;
    this.pending = true;
    try {
      const ok = await StorageManager.resetAttrsOnServer();
      if (ok) this.rebuild();
    } finally {
      this.pending = false;
    }
  }

  /** 关闭弹窗（连确认框一起收掉，否则会留下一块无主遮罩） */
  close() {
    if (this.confirmDialog && isValid(this.confirmDialog)) this.confirmDialog.destroy();
    this.confirmDialog = null;
    if (this.dialog && isValid(this.dialog)) this.dialog.destroy();
    this.dialog = null;
    this.pointsLabel = null;
    this.listContent = null;
  }
}
