import { EventTouch, Graphics, Layout, Node, ScrollView, UITransform, Vec2, isValid } from "cc";
import { ZoneApi } from "../../utils/net/Api";
import type { MyZone } from "../../utils/net/ApiModels";
import { describeError } from "../../utils/net/ApiError";
import { zoneSelectLayout as layout } from "../../../configs/hudLayout";
import { getText } from "../../../configs/texts";
import GameUiHelper from "../../helpers/GameUiHelper";
import UiHelper from "../../helpers/UiHelper";
import ZoneStore from "../../core/ZoneStore";
import SoundManager from "../../core/SoundManager";
import { blockClickThrough } from "../../utils/input/UiHit";
import { designResolution } from "../../utils/layout/ScreenLayout";
import { clearChildren } from "../../utils/node/NodeTree";
import { createRoundedPanel } from "./tab-kit";

/**
 * 选服弹窗（全屏模态，#962）
 *
 * ## 什么时候出现
 * **只有玩家自己点开**：选角页顶部那颗「区服：X（点击切换）」。登录不自动弹 ——
 * 绝大多数登录都是回自己那个区，每次逼人确认一次只会变成肌肉记忆，还挡住进游戏的节奏。
 * 单区服（只有一个活区）连入口都不给点：点了也是它。
 *
 * ## 为什么每次都重新拉 `GET /zones/mine`
 * 打开是低频动作（换区才用），而列表会变：运营可能刚把某个区转成维护、刚开新区。
 * 拿选角页启动时那份缓存去渲染，玩家会看到一个「已经不能进的区还能点」的弹窗。
 *
 * ## 进不去的区照样列出来
 * 维护中 / 已关闭的区**置灰但仍占一行**，点了给一句提示（不是静默无反应）。让它们从列表里
 * 消失，玩家会以为「我的区被删了」—— 这正是最该说清楚的时候。
 */
export default class ZoneSelectDialog {
  /** 弹窗根（未打开时为 null） */
  private dialog: Node | null = null;
  /** 选好之后的回调（已 POST /zones/select 成功、ZoneStore 已更新） */
  private onPicked: ((zone: MyZone) => void) | null = null;
  /** 是否有请求在途（防止连点两个区发两次 select） */
  private busy = false;

  /**
   * 打开
   *
   * @param host 挂载点。选角场景没有 UI 图层容器（从不调 LayerManager.initLayer），
   *   所以挂它自己的节点上 —— 与 AnnouncementNoticeDialog 同一个原因。
   * @param onPicked 选好并切换成功之后的回调（调用方去重拉角色列表）
   */
  async open(host: Node, onPicked: (zone: MyZone) => void): Promise<void> {
    // 已经开着就不重开（连点顶部那颗「区服」不该叠出两个弹窗）
    if (this.dialog && isValid(this.dialog)) return;
    let zones: MyZone[];
    try {
      // 不走 silent：拉不到要让玩家知道（网络层统一飘字），静默会让人以为点坏了
      zones = await ZoneApi.mine();
    } catch (error) {
      console.warn(`[ZoneSelect] 区服列表拉取失败：${describeError(error)}`);
      return;
    }
    // 拉取期间可能已经切走场景（切到游戏 / 回登录），此时不再建节点
    if (!isValid(host)) return;
    this.onPicked = onPicked;
    this.dialog = this.create(zones);
    host.addChild(this.dialog);
  }

  /** 关闭并销毁 */
  close() {
    if (this.dialog && isValid(this.dialog)) this.dialog.destroy();
    this.dialog = null;
    this.onPicked = null;
  }

  /** 组装弹窗（几何、配色与用图全部来自 configs/hudLayout.zoneSelectLayout） */
  private create(zones: MyZone[]): Node {
    const dialog = new Node(layout.name);
    // 全屏尺寸 = 设计分辨率（与确认框 / 公告提醒同一口径）：本作只有一个分辨率，遮罩正好盖满屏幕
    const screenSize = designResolution;
    dialog.addComponent(UITransform).setContentSize(screenSize.width, screenSize.height);
    // 遮罩：黑色半透明 + 兼作下层点击的拦截层
    const mask = new Node(`${layout.name}_mask`);
    const graphics = mask.addComponent(Graphics);
    graphics.fillColor = layout.maskColor;
    graphics.rect(-screenSize.width / 2, -screenSize.height / 2, screenSize.width, screenSize.height);
    graphics.fill();
    dialog.addChild(mask);
    // 居中面板
    const panel = GameUiHelper.createDialogPanel(layout.panel.name, layout.panel.size);
    dialog.addChild(panel);
    const title = layout.titleLabel;
    panel.addChild(UiHelper.createLabel(title.name, getText("zone_select_title"), title.color, title.fontSize, title.position, title.size));
    const hint = layout.hint;
    panel.addChild(UiHelper.createLabel("zone_select_hint", getText("zone_select_hint"), hint.color, hint.fontSize, hint.position, hint.size));
    // 区列表（纵向滚动，每行固定高）
    const list = GameUiHelper.createScrollView(layout.list.name, layout.list.position, layout.list.size);
    const content = list.getComponent(ScrollView)?.content;
    if (content) {
      content.getComponent(Layout)!.spacingY = layout.row.gap;
      clearChildren(content);
      zones.forEach((zone) => content.addChild(this.createRow(zone)));
    }
    panel.addChild(list);
    // 取消：打开选服窗不等于必须换区（关掉就停在原来那个）
    const closeButton = GameUiHelper.createMiddleButton(layout.closeButton.name, layout.closeButton.text, layout.closeButton.position);
    closeButton.on(Node.EventType.TOUCH_END, () => this.close(), this);
    panel.addChild(closeButton);
    this.setupInputOwnership(dialog);
    return dialog;
  }

  /**
   * 一行一个区：区名（左）/ 角色数 · 状态（中）/ 角标（右）
   *
   * 状态与角色数合成一行（「2 个角色 · 维护中」）：两行会把这个 58 高的行撑得没地方放角标。
   */
  private createRow(zone: MyZone): Node {
    const row = layout.row;
    const playable = zone.status === "open";
    const node = createRoundedPanel(
      `${layout.name}_row_${zone.id}`,
      row.size,
      playable ? row.fill : row.disabledFill,
      zone.current ? row.currentBorder : row.border,
      row.radius,
    );
    const nameColor = playable ? row.nameColor : row.disabledNameColor;
    node.addChild(UiHelper.createLabel(`${layout.name}_row_${zone.id}_name`, zone.name, nameColor, row.nameFontSize, new Vec2(row.nameX, 0), row.nameSize));
    node.addChild(
      UiHelper.createLabel(`${layout.name}_row_${zone.id}_meta`, this.metaText(zone), row.metaColor, row.metaFontSize, new Vec2(row.metaX, 0), row.metaSize),
    );
    // 整行就是一个点击目标：鼠标通道要独占（否则一次点击会穿透到下面的角色格子）。
    // createRoundedPanel 内部已登记过一次（幂等），这里写出来是为了让静态守点
    // tools/audit-ui-click-through.cjs 能在节点变量上看到登记点
    blockClickThrough(node);
    // 角标从右往左摆：先「上次在」再「推荐」（两个都有的区，「上次在」贴右）
    let tagX = row.tagRightX;
    if (zone.current) tagX = this.addTag(node, zone, "zone_tag_current", tagX);
    if (zone.recommended) this.addTag(node, zone, "zone_tag_recommended", tagX);
    // 点击音：行不是 createButton 建的，按 Login 页区服选择同一套口径自己贴一行
    SoundManager.bindClick(node);
    node.on(Node.EventType.TOUCH_END, () => void this.pick(zone), this);
    return node;
  }

  /** 中间那列的文案：角色数 · 状态（状态只在进不去时出现，免得正常区每行都挂一句「开放中」） */
  private metaText(zone: MyZone): string {
    const count = zone.roleCount > 0 ? getText("zone_role_count", { count: zone.roleCount }) : getText("zone_role_count_empty");
    if (zone.status === "open") return count;
    const status = getText(zone.status === "closed" ? "zone_status_closed" : "zone_status_maintenance");
    return `${count} · ${status}`;
  }

  /** 加一枚角标，返回下一个角标该放的 x（往左挪） */
  private addTag(parent: Node, zone: MyZone, textKey: string, x: number): number {
    const row = layout.row;
    const tag = createRoundedPanel(
      `${layout.name}_row_${zone.id}_tag_${textKey}`,
      row.tagSize,
      row.tagFill,
      row.tagBorder,
      row.tagSize.height / 2,
    );
    tag.setPosition(x - row.tagSize.width / 2, 0, 0);
    tag.addChild(UiHelper.createLabel(`${layout.name}_row_${zone.id}_tag_${textKey}_label`, getText(textKey), row.tagColor, row.tagFontSize, new Vec2(), row.tagSize));
    parent.addChild(tag);
    return x - row.tagSize.width - row.tagGap;
  }

  /**
   * 选一个区
   *
   * 进不去的区先挡下来（服务端也会拒，但让它变成一次本地提示，不浪费一次往返）；
   * 能进就 `POST /zones/select`。**服务端是权威**：只有它返回成功才算切了 ——
   * 本地存的那份偏好跟着写，下次打开弹窗默认还是这个区（见 ZoneStore）。
   */
  private async pick(zone: MyZone): Promise<void> {
    if (this.busy) return;
    if (zone.status !== "open") {
      GameUiHelper.createTip(zone.status === "closed" ? "zone_closed_tip" : "zone_unavailable_tip");
      return;
    }
    this.busy = true;
    try {
      await ZoneApi.select({ zoneId: zone.id });
      ZoneStore.set(zone.id, zone.name);
      const onPicked = this.onPicked;
      this.close();
      GameUiHelper.createTip("zone_switched_tip", { zone: zone.name });
      onPicked?.(zone);
    } catch (error) {
      // 失败由网络层统一飘字（维护中 → 50030 自带服务端文案）
      console.warn(`[ZoneSelect] 切区失败：${describeError(error)}`);
    } finally {
      this.busy = false;
    }
  }

  /**
   * 输入独占：触摸通道让遮罩/面板独占本次触摸，鼠标通道命中即中断
   *
   * 选角页背后是可点的角色格子与按钮，按下若穿透过去会顺手选中一个角色；
   * 鼠标通道交给 blockClickThrough（它登记的是 MOUSE_UP 的中断）。
   */
  private setupInputOwnership(dialog: Node) {
    blockClickThrough(dialog);
    dialog.on(Node.EventType.TOUCH_START, this.stopTouchBubble, this);
    dialog.on(Node.EventType.TOUCH_MOVE, this.stopTouchBubble, this);
    dialog.on(Node.EventType.TOUCH_END, this.stopTouchBubble, this);
    dialog.on(Node.EventType.TOUCH_CANCEL, this.stopTouchBubble, this);
  }

  /** 停住这次触摸的冒泡（不再传给下层的角色格子与按钮） */
  private stopTouchBubble(event: EventTouch) {
    event.propagationStopped = true;
  }
}
