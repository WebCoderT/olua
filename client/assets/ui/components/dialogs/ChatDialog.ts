import { EditBox, Graphics, isValid, Label, Node, ScrollView, Size, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import OtherPlayerManager from "../../core/OtherPlayerManager";
import type { ChatPeer } from "../../core/ChatStore";
import ChatStore from "../../core/ChatStore";
import ChatBubbles from "../../core/ChatBubbles";
import UiHelper from "../../helpers/UiHelper";
import RealtimeClient, { RealtimeStatus } from "../../utils/net/RealtimeClient";
import CombatChannel from "../../utils/net/CombatChannel";
import type { ChatChannel, ChatEntry } from "../../utils/net/CombatChannel";
import { chatDialogLayout as layout } from "../../../configs/hudLayout";
import { getRelationColor } from "../../../configs/social";
import { blockClickThrough } from "../../utils/input/UiHit";
import { clearChildren } from "../../utils/node/NodeTree";
import GuideStore from "../../core/GuideStore";
import { GUIDE_EVENT } from "../../../types/guide";

/** 聊天弹窗的三个页签（与协议频道同名，切换零映射） */
type ChatTab = ChatChannel;

/** 页签顺序（与 layout.tabs.columns / layout.texts.tabs 一一对应，改这里就三处一起改） */
const TABS: ChatTab[] = ["world", "guild", "private"];

/**
 * 聊天弹窗（#395：世界 / 帮会 / 私聊）
 *
 * ## 数据从哪来
 * 全部来自 `ChatStore`（服务端帧的唯一落点）：这里不发请求、不存消息，
 * 打开时把存量画出来、订阅 `onChange` 增量重画当前页。**回显即成功**——
 * 自己发的消息也走服务端帧回来，发送侧不清空输入框的条件是「帧发出去了」
 * （`sendChat` 返回 false = 通道未连接，输入原样保留让玩家重试）。
 *
 * ## 私聊为什么有「选人」一态
 * 私聊必须有收件人，而收件人没法凭空打字选中（角色名不唯一）。候选来自两个
 * 天然的地方：**聊过的**（ChatStore 聚出来的会话列表）与**附近的人**（互见帧内存态）。
 * 选中后进入会话视图（消息过滤到这一个人 + 输入框指向他），「返回」回到选人页。
 *
 * ## 气泡联动
 * 弹窗打开时挂起屏幕气泡（ChatBubbles.setSuppressed）：同一条消息既在全屏面板里
 * 又在角落冒泡是纯干扰。关闭时恢复，并把当前页标为已读。
 */
export default class ChatDialog {
  /** 弹窗根 */
  private dialog: Node | null = null;
  /** 内容容器（切页 / 新消息时清空重画；消息量 ≤ 50/频道，整画便宜且不会漏） */
  private body: Node | null = null;
  /** 当前页签 */
  private tab: ChatTab = "world";
  /** 私聊会话对象（null = 选人页） */
  private privatePeer: ChatPeer | null = null;
  /** 页签底图与文字（选中态重画） */
  private tabNodes = new Map<ChatTab, Node>();
  private tabLabels = new Map<ChatTab, Node>();
  /** 输入框（发送后按发送结果清空；引用留着避免每次 render 重建查询） */
  private input: Node | null = null;
  /** ChatStore 订阅（打开期间有效；关闭时退订） */
  private unsubscribe: (() => void) | null = null;

  /**
   * 打开/关闭聊天窗（#469 起为常驻左下角小窗）
   *
   * @param auto **自动开**（进游戏 / 引导走完时组合根调）：只开不关，且**不推进引导** ——
   *   「别一个人玩」那一步要的是玩家自己点开聊天，程序代开不算学会
   */
  open(auto = false) {
    if (this.dialog && isValid(this.dialog) && this.dialog.active) {
      if (auto) return;
      this.close();
      return;
    }
    if (this.dialog && !isValid(this.dialog)) this.reset();
    // 引导（#402）：「别一个人玩」那一步就是「打开过聊天」—— 同样只在真打开之后发；
    // 自动开窗（auto）不算（见上）
    if (!auto) GuideStore.notify(GUIDE_EVENT.OPEN_CHAT);
    this.dialog = GameUiHelper.createChatBox();
    LayerManager.addDialogToUILayer(this.dialog);
    this.createTabs();
    this.body = UiHelper.createGroupNode(`${layout.name}_body`, new Vec2());
    this.dialog.addChild(this.body);
    // 挂起气泡 + 订阅变化：弹窗开着的时候，新消息直接上屏当前页（并刷新页签角标）
    ChatBubbles.setSuppressed(true);
    this.unsubscribe = ChatStore.onChange(() => {
      this.refreshTabCaptions();
      this.renderMessages();
    });
    this.select("world");
  }

  /** 关闭弹窗（订阅退掉、气泡恢复） */
  close() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    ChatBubbles.setSuppressed(false);
    if (this.dialog && isValid(this.dialog)) this.dialog.destroy();
    this.reset();
  }

  /** 窗口尺寸变化时重贴左下角（组合根的 onWindowResize 调；关着时是 no-op） */
  refreshDock() {
    if (this.dialog && isValid(this.dialog)) GameUiHelper.placeChatBox(this.dialog);
  }

  //#region 页签

  /** 建三个页签（几何与社交弹窗同款） */
  private createTabs() {
    const dialog = this.dialog;
    if (!dialog) return;
    this.tabNodes.clear();
    this.tabLabels.clear();
    TABS.forEach((tab, index) => {
      const node = UiHelper.createNode(`${layout.name}_tab_${tab}`, new Vec2(layout.tabs.columns[index], layout.tabs.y), layout.tabs.size);
      node.addComponent(Graphics);
      const label = UiHelper.createLabel(
        `${layout.name}_tab_${tab}_label`,
        layout.texts.tabs[index],
        layout.tabs.idleText,
        layout.tabs.fontSize,
        new Vec2(),
        layout.tabs.size,
      );
      node.addChild(label);
      node.on(Node.EventType.TOUCH_END, () => this.select(tab), this);
      blockClickThrough(node);
      dialog.addChild(node);
      this.tabNodes.set(tab, node);
      this.tabLabels.set(tab, label);
    });
  }

  /** 切换页签（清空内容区重画；切走 = 该页已读） */
  private select(tab: ChatTab) {
    this.tab = tab;
    ChatStore.markRead(tab);
    this.privatePeer = null; // 换页回到该页的初始态（私聊 = 选人页）
    this.paintTabs();
    this.refreshTabCaptions();
    this.render();
  }

  private paintTabs() {
    TABS.forEach((tab) => {
      const node = this.tabNodes.get(tab);
      const labelNode = this.tabLabels.get(tab);
      if (!node || !isValid(node) || !labelNode) return;
      const active = tab === this.tab;
      const graphics = node.getComponent(Graphics);
      if (graphics) {
        graphics.clear();
        const half = layout.tabs.size;
        graphics.roundRect(-half.width / 2, -half.height / 2, half.width, half.height, layout.tabs.radius);
        graphics.fillColor = active ? layout.tabs.activeFill : layout.tabs.idleFill;
        graphics.fill();
        if (!active) {
          graphics.lineWidth = 1;
          graphics.strokeColor = layout.tabs.idleBorder;
          graphics.roundRect(-half.width / 2, -half.height / 2, half.width, half.height, layout.tabs.radius);
          graphics.stroke();
        }
      }
      const label = labelNode.getComponent(Label);
      if (label) label.color = active ? layout.tabs.activeText : layout.tabs.idleText;
    });
  }

  /** 页签角标（私聊未读数；世界 / 帮会有气泡扛提醒，这里只标私聊） */
  private refreshTabCaptions() {
    const unread = ChatStore.unreadOf("private");
    TABS.forEach((tab, index) => {
      const labelNode = this.tabLabels.get(tab);
      if (!labelNode || !isValid(labelNode)) return;
      const label = labelNode.getComponent(Label);
      if (!label) return;
      const base = layout.texts.tabs[index];
      label.string = tab === "private" && unread > 0 ? `${base}·${unread}` : base;
    });
  }

  //#endregion

  //#region 渲染

  /** 按当前状态重画内容区（世界 / 帮会 = 消息列表；私聊 = 选人页或会话） */
  private render() {
    const body = this.body;
    if (!body || !isValid(body)) return;
    clearChildren(body);
    if (this.tab === "private" && !this.privatePeer) {
      this.renderPrivatePick();
      return;
    }
    this.renderMessages();
  }

  /** 消息列表（世界 / 帮会 = 全部；私聊 = 只看当前对象） */
  private renderMessages() {
    const body = this.body;
    if (!body || !isValid(body) || this.tab === "private" && !this.privatePeer) return;
    clearChildren(body);
    const entries = this.tab === "private" && this.privatePeer
      ? ChatStore.conversationWith(this.privatePeer.roleId)
      : ChatStore.list(this.tab);
    const list = GameUiHelper.createScrollView(layout.list.name, layout.list.position, layout.list.size);
    body.addChild(list);
    const content = list.getComponent(ScrollView)?.content;
    if (!content) return;
    if (entries.length === 0) {
      content.addChild(this.createEmptyLabel(layout.texts[`${this.tab}Empty` as const]));
    } else {
      entries.forEach((entry) => content.addChild(this.createMessageRow(entry)));
    }
    this.addInputRow(body);
  }

  /** 消息行：发送者名（按关系上色，帮会名做前缀）+ 正文 */
  private createMessageRow(entry: ChatEntry) {
    const row = layout.row;
    const node = UiHelper.createNode(`chat_msg_${entry.ts}_${entry.from.roleId}`, new Vec2(), row.size);
    const graphics = node.addComponent(Graphics);
    const path = () => graphics.roundRect(-row.size.width / 2, -row.size.height / 2, row.size.width, row.size.height, row.radius);
    graphics.fillColor = row.fill;
    path();
    graphics.fill();
    graphics.lineWidth = 1;
    graphics.strokeColor = row.border;
    path();
    graphics.stroke();

    let name = entry.from.username;
    if (entry.from.guildName) name = layout.texts.guildPrefix.split("{guild}").join(entry.from.guildName) + name;
    if (entry.channel === "private" && entry.to) name += layout.texts.privateTo.split("{name}").join(entry.to.username);
    // 关系色：优先 OtherPlayerManager 的缓存（判定唯一入口是 resolveRelation，这里只读缓存）
    const relation = OtherPlayerManager.relationOfAccount(entry.from.accountId);
    node.addChild(
      UiHelper.createLabel(
        `chat_msg_name_${entry.ts}`,
        name,
        relation ? getRelationColor(relation) : row.metaColor,
        row.nameFontSize,
        new Vec2(row.nameX, 0),
        row.nameSize,
        Label.HorizontalAlign.LEFT,
      ),
    );
    node.addChild(
      UiHelper.createLabel(
        `chat_msg_text_${entry.ts}`,
        entry.text,
        row.border,
        row.textFontSize,
        new Vec2(row.textX, 0),
        row.textSize,
        Label.HorizontalAlign.LEFT,
      ),
    );
    return node;
  }

  /** 私聊选人页：聊过的 + 附近的人（按 roleId 去重；没有 roleId 的候选没法精确私聊，不列） */
  private renderPrivatePick() {
    const body = this.body;
    if (!body) return;
    body.addChild(
      UiHelper.createLabel("chat_pick_hint", layout.texts.pickHint, layout.titleColor, layout.titleFontSize, layout.privatePick.hint.position, layout.privatePick.hint.size),
    );
    const candidates = new Map<string, ChatPeer>();
    for (const peer of ChatStore.privatePeers()) candidates.set(peer.roleId, peer);
    for (const player of OtherPlayerManager.nearby()) {
      if (!player.roleId || candidates.has(player.roleId)) continue;
      candidates.set(player.roleId, { accountId: player.accountId, roleId: player.roleId, username: player.name });
    }
    const list = GameUiHelper.createScrollView(layout.privatePick.list.name, layout.privatePick.list.position, layout.privatePick.list.size);
    body.addChild(list);
    const content = list.getComponent(ScrollView)?.content;
    if (!content) return;
    if (candidates.size === 0) {
      content.addChild(this.createEmptyLabel(layout.texts.pickEmpty));
      return;
    }
    for (const peer of candidates.values()) {
      const row = layout.row;
      const node = UiHelper.createNode(`chat_pick_row_${peer.roleId}`, new Vec2(), row.size);
      const graphics = node.addComponent(Graphics);
      graphics.fillColor = row.fill;
      graphics.roundRect(-row.size.width / 2, -row.size.height / 2, row.size.width, row.size.height, row.radius);
      graphics.fill();
      graphics.lineWidth = 1;
      graphics.strokeColor = row.border;
      graphics.roundRect(-row.size.width / 2, -row.size.height / 2, row.size.width, row.size.height, row.radius);
      graphics.stroke();
      // 名字列用 pickRow（比消息行的名字列宽一倍：行里只有名字 + 按钮，名字给足才不被裁）
      const pickRow = layout.pickRow;
      node.addChild(
        UiHelper.createLabel(
          `chat_pick_name_${peer.roleId}`,
          peer.username,
          OtherPlayerManager.relationOfAccount(peer.accountId)
            ? getRelationColor(OtherPlayerManager.relationOfAccount(peer.accountId)!)
            : row.metaColor,
          row.nameFontSize,
          new Vec2(pickRow.nameX, 0),
          pickRow.nameSize,
          Label.HorizontalAlign.LEFT,
        ),
      );
      const chatButton = GameUiHelper.createSmallButtion(`chat_pick_open_${peer.roleId}`, layout.texts.privateChat, new Vec2(pickRow.buttonX, 0));
      chatButton.on(Node.EventType.TOUCH_END, () => {
        this.privatePeer = peer;
        this.render();
      }, this);
      node.addChild(chatButton);
      content.addChild(node);
    }
  }

  //#endregion

  //#region 输入行

  /** 输入行：输入条 + 发送（私聊会话态多一枚「返回」） */
  private addInputRow(body: Node) {
    const placeholder = this.tab === "private" && this.privatePeer
      ? layout.texts.inputPrivate.split("{name}").join(this.privatePeer.username)
      : this.tab === "guild"
        ? layout.texts.inputGuild
        : layout.texts.inputWorld;
    const field = layout.inputRow.input;
    // 输入条底板：没有它，占位文字就是「飘在窗体上的一行字」，看不出哪里能点（#477 顺带发现）
    const frame = UiHelper.createNode("chat_input_frame", field.position, field.size);
    const frameGraphics = frame.addComponent(Graphics);
    const framePath = () => frameGraphics.roundRect(-field.size.x / 2, -field.size.y / 2, field.size.x, field.size.y, field.radius);
    frameGraphics.fillColor = field.fill;
    framePath();
    frameGraphics.fill();
    frameGraphics.lineWidth = 1;
    frameGraphics.strokeColor = field.border;
    framePath();
    frameGraphics.stroke();
    body.addChild(frame);
    this.input = UiHelper.createInputBox("chat_input", placeholder, field.position, field.size, false, field.fontSize);
    body.addChild(this.input);
    const send = GameUiHelper.createSmallButtion("chat_send", layout.texts.send, layout.inputRow.send.position);
    send.on(Node.EventType.TOUCH_END, () => this.send(), this);
    body.addChild(send);
    if (this.tab === "private" && this.privatePeer) {
      const back = GameUiHelper.createSmallButtion("chat_back", layout.texts.back, layout.inputRow.back.position);
      back.on(Node.EventType.TOUCH_END, () => {
        this.privatePeer = null;
        this.render();
      }, this);
      body.addChild(back);
    }
  }

  /**
   * 发送：通道在线就发帧；**成功与否以服务端回显为准**——发出去了才清输入框，
   * 被服务端拒（限频 / 空消息）时 error 帧的提示由 RealtimeClient 的错误出口弹，
   * 输入原样保留让玩家改完重试。
   */
  private send() {
    const text = (this.input?.getComponent(EditBox)?.string ?? "").trim();
    if (!text) return;
    if (RealtimeClient.status !== RealtimeStatus.Connected) {
      GameUiHelper.createErrorTipText(layout.texts.disconnectedTip);
      return;
    }
    const toRoleId = this.tab === "private" ? this.privatePeer?.roleId : undefined;
    if (CombatChannel.sendChat(this.tab, text, toRoleId)) {
      const editBox = this.input?.getComponent(EditBox);
      if (editBox) editBox.string = "";
    }
  }

  //#endregion

  //#region 公共零件

  private createEmptyLabel(text: string) {
    return UiHelper.createLabel("chat_empty", text, layout.row.metaColor, layout.row.textFontSize, new Vec2(), new Size(layout.row.size.width, 32));
  }

  //#endregion

  /** 释放引用（关闭后） */
  private reset() {
    this.dialog = null;
    this.body = null;
    this.tab = "world";
    this.privatePeer = null;
    this.tabNodes.clear();
    this.tabLabels.clear();
    this.input = null;
  }
}
