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
import { chatDialogLayout as layout, T } from "../../../configs/hudLayout";
import { getRelationColor } from "../../../configs/social";
import { clearChildren } from "../../utils/node/NodeTree";
import GuideStore from "../../core/GuideStore";
import { GUIDE_EVENT } from "../../../types/guide";
import { createTabStrip, paintTabStrip } from "./tab-kit";
import { drawVectorIcon } from "../../helpers/VectorIcon";
import { icons } from "../../../configs/layout/icons";
import { blockClickThrough } from "../../utils/input/UiHit";

/** 聊天弹窗的四个页签（与协议频道同名，切换零映射） */
type ChatTab = ChatChannel;

/** 页签顺序（与 layout.tabs.columns / layout.texts.tabs 一一对应，改这里就三处一起改） */
const TABS: ChatTab[] = ["world", "map", "guild", "private"];

/** 各频道的输入框占位（private 走会话模板；其余按这里查） */
const INPUT_PLACEHOLDER: Record<Exclude<ChatTab, "private">, string> = {
  world: "inputWorld",
  map: "inputMap",
  guild: "inputGuild",
};

/** 消息时间戳（稿 `.msg .t`：HH:MM；服务端 ts 是毫秒时间戳，只做本地展示） */
function formatClock(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number) => ("0" + n).slice(-2);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 聊天弹窗（#395：世界 / 同图 / 帮会 / 私聊）
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
  /**
   * 「清屏」时刻（按频道记）：只影响本地视图 —— 该时刻之前的消息不再画，
   * 之后的新消息照常上屏。消息仓在 ChatStore（服务端帧的唯一落点），这里不清它的数据。
   */
  private clearedAt: Partial<Record<ChatTab, number>> = {};
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
    this.createChrome();
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

  /** 重贴左下角（开小窗时由组合根调；关着时是 no-op） */
  refreshDock() {
    if (this.dialog && isValid(this.dialog)) this.dialog.setPosition(layout.position.x, layout.position.y, 0);
  }

  //#region 页签

  /** 建四个页签（几何与社交弹窗同款） */
  private createTabs() {
    const dialog = this.dialog;
    if (!dialog) return;
    const { nodes, labels } = createTabStrip(dialog, layout.name, TABS, layout.texts.tabs, layout.tabs, (tab) => this.select(tab));
    this.tabNodes = nodes;
    this.tabLabels = labels;
  }

  /**
   * 头部右侧的两颗工具钮（清屏 / 收起）+ 头/底两条 1px 暗分隔线
   *
   * 稿 `.chat-tools button{width:22px;height:22px}`：纯图标小方钮，底色 rgba(0,0,0,.3)、
   * `line-2` 边、图标 text-4；「清屏」只清本地视图（不动 ChatStore 的消息仓），
   * 「收起」就是关窗（与点聊天入口同一个出口）。
   */
  private createChrome() {
    const dialog = this.dialog;
    if (!dialog) return;
    const { tools, dividers } = layout;
    // 分隔线：稿是 1px rgba(0,0,0,.55)，用填充条画（1px 描边在实机不渲染）
    const width = layout.size.width - 2;
    for (const y of [dividers.headY, dividers.inputY]) {
      const line = UiHelper.createNode(`chat_divider_${y}`, new Vec2(0, y), new Size(width, 1));
      const graphics = line.addComponent(Graphics);
      graphics.fillColor = dividers.color;
      graphics.rect(-width / 2, -0.5, width, 1);
      graphics.fill();
      dialog.addChild(line);
    }
    // 两颗工具钮（右起：第 1 颗「收起」贴右缘，第 2 颗「清屏」在它左边）
    const shapes = [icons.chatClear, icons.headChevron];
    const actions = [() => this.clearCurrent(), () => this.close()];
    shapes.forEach((shape, index) => {
      const x = tools.right - (tools.size + tools.gap) * (1 - index);
      const button = UiHelper.createNode(`chat_tool_${index}`, new Vec2(x, tools.y), new Size(tools.size, tools.size));
      const graphics = button.addComponent(Graphics);
      // 底板：半透明黑 + line-2 边（填外框 → 内缩填底）
      graphics.fillColor = T.line[2];
      graphics.roundRect(-tools.size / 2, -tools.size / 2, tools.size, tools.size, T.radius.r1);
      graphics.fill();
      graphics.fillColor = T.surface.sunken;
      graphics.roundRect(-tools.size / 2 + 1, -tools.size / 2 + 1, tools.size - 2, tools.size - 2, T.radius.r1);
      graphics.fill();
      const iconNode = UiHelper.createNode("chat_tool_icon", new Vec2(), new Size(tools.iconSize, tools.iconSize));
      drawVectorIcon(iconNode, shape, new Size(tools.iconSize, tools.iconSize), tools.color, 1.7);
      button.addChild(iconNode);
      button.on(Node.EventType.TOUCH_END, actions[index], this);
      blockClickThrough(button);
      dialog.addChild(button);
    });
  }

  /** 清屏：把当前频道「此刻之前的消息」标记为不显示，只影响本地视图 */
  private clearCurrent() {
    this.clearedAt[this.tab] = Date.now();
    this.render();
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
    paintTabStrip(this.tabNodes, this.tabLabels, TABS, this.tab, layout.tabs);
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
    const all = this.tab === "private" && this.privatePeer
      ? ChatStore.conversationWith(this.privatePeer.roleId)
      : ChatStore.list(this.tab);
    // 「清屏」只挡本地视图：该时刻之前的消息不画，之后的新消息照常上屏
    const cleared = this.clearedAt[this.tab] ?? 0;
    const entries = all.filter((entry) => entry.ts > cleared);
    const list = GameUiHelper.createScrollView(layout.list.name, layout.list.position, layout.list.size);
    body.addChild(list);
    const content = list.getComponent(ScrollView)?.content;
    if (!content) return;
    if (entries.length === 0) {
      // 私聊会话页不能复用选人页的 privateEmpty（那句是「先点选人挑一个对象」，
      // 这里对象已经挑好了 —— #495）
      const emptyText = this.tab === "private" && this.privatePeer ? layout.texts.privateChatEmpty : layout.texts[`${this.tab}Empty` as const];
      content.addChild(this.createEmptyLabel(emptyText));
    } else {
      entries.forEach((entry) => content.addChild(this.createMessageRow(entry)));
    }
    this.addInputRow(body);
  }

  /** 消息行：发送者名（按关系上色，帮会名做前缀）+ 正文 */
  private createMessageRow(entry: ChatEntry) {
    const row = layout.row;
    const node = UiHelper.createNode(`chat_msg_${entry.ts}_${entry.from.roleId}`, new Vec2(), row.size);
    // 行底板按配置画（稿 .msg 是纯文字行 → 两个色都透明时整段跳过，不白建 Graphics）
    if (row.fill.a > 0 || row.border.a > 0) {
      const graphics = node.addComponent(Graphics);
      UiHelper.paintRoundedPanel(graphics, row.size, row.radius, row.fill.a > 0 ? row.fill : null, row.border);
    }

    // 时间戳（稿 `.msg .t`：9.5px、text-4、等宽数字，压在消息行最左）
    node.addChild(
      UiHelper.createLabel(
        `chat_msg_time_${entry.ts}`,
        formatClock(entry.ts),
        T.text[4],
        row.timeFontSize,
        new Vec2(row.timeX, 0),
        row.timeSize,
        Label.HorizontalAlign.LEFT,
      ),
    );
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
        row.text,
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
      // 行底板按配置画（与消息行同一口径：两色透明时跳过）
      if (row.fill.a > 0 || row.border.a > 0) {
        const graphics = node.addComponent(Graphics);
        UiHelper.paintRoundedPanel(graphics, row.size, row.radius, row.fill.a > 0 ? row.fill : null, row.border);
      }
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

  /** 输入行：频道 chip + 输入条 + 金色发送（私聊会话态多一枚「返回」） */
  private addInputRow(body: Node) {
    const placeholder = this.tab === "private" && this.privatePeer
      ? layout.texts.inputPrivate.split("{name}").join(this.privatePeer.username)
      : layout.texts[INPUT_PLACEHOLDER[this.tab as Exclude<ChatTab, "private">]];
    const row = layout.inputRow;
    // 左侧频道 chip（稿 .chat-in .chip：点一下切下一个频道）
    body.addChild(this.createChannelChip());
    // 输入条底板：没有它，占位文字就是「飘在窗体上的一行字」，看不出哪里能点（#477 顺带发现）
    const field = row.input;
    const fieldSize = new Size(field.size.x, field.size.y);
    const frame = UiHelper.createNode("chat_input_frame", field.position, fieldSize);
    const frameGraphics = frame.addComponent(Graphics);
    // 1px 描边在实机整条不渲染 → 填外框再内缩填底（与 HUD 面板同一套做法）
    frameGraphics.fillColor = field.border;
    frameGraphics.roundRect(-fieldSize.width / 2, -fieldSize.height / 2, fieldSize.width, fieldSize.height, field.radius);
    frameGraphics.fill();
    frameGraphics.fillColor = field.fill;
    frameGraphics.roundRect(-fieldSize.width / 2 + 1, -fieldSize.height / 2 + 1, fieldSize.width - 2, fieldSize.height - 2, Math.max(0, field.radius - 1));
    frameGraphics.fill();
    body.addChild(frame);
    this.input = UiHelper.createInputBox("chat_input", placeholder, field.position, field.size, false, field.fontSize);
    body.addChild(this.input);
    // 金色发送键（稿 .btn--gold：金渐变底 + 深字）
    const sendSize = new Size(row.send.size.x, row.send.size.y);
    const send = GameUiHelper.createToneButton("chat_send", layout.texts.send, row.send.position, sendSize, row.send.fontSize, {
      fill: row.send.fill,
      fillTop: row.send.fillTop,
      border: row.send.border,
      text: row.send.text,
      fillTopRatio: 0.55,
    });
    send.on(Node.EventType.TOUCH_END, () => this.send(), this);
    body.addChild(send);
    if (this.tab === "private" && this.privatePeer) {
      const back = GameUiHelper.createToneButton("chat_back", layout.texts.back, row.back.position, new Size(row.back.size.x, row.back.size.y), layout.inputRow.input.fontSize, {
        fill: T.surface[3],
        fillTop: T.surface[4],
        border: T.line[2],
        text: T.text[2],
        fillTopRatio: 0.55,
      });
      back.on(Node.EventType.TOUCH_END, () => {
        this.privatePeer = null;
        this.render();
      }, this);
      body.addChild(back);
    }
  }

  /** 当前频道 chip（稿 `.chat-in .chip`）：显示当前频道 + ▾，点一下切到下一个频道 */
  private createChannelChip(): Node {
    const cfg = layout.inputRow.chip;
    const size = new Size(cfg.size.x, cfg.size.y);
    const node = UiHelper.createNode("chat_channel_chip", cfg.position, size);
    const graphics = node.addComponent(Graphics);
    graphics.fillColor = cfg.border;
    graphics.roundRect(-size.width / 2, -size.height / 2, size.width, size.height, cfg.radius);
    graphics.fill();
    graphics.fillColor = cfg.fill;
    graphics.roundRect(-size.width / 2 + 1, -size.height / 2 + 1, size.width - 2, size.height - 2, Math.max(0, cfg.radius - 1));
    graphics.fill();
    const index = Math.max(0, TABS.indexOf(this.tab));
    node.addChild(UiHelper.createLabel("chat_channel_chip_label", `${layout.texts.tabs[index]} ▾`, T.gold[4], cfg.fontSize, new Vec2(), size));
    node.on(Node.EventType.TOUCH_END, () => {
      // 只在能直接发言的三个频道里循环（私聊要先选人，交给页签）
      const cycle: ChatTab[] = ["world", "map", "guild"];
      const at = cycle.indexOf(this.tab);
      this.select(cycle[(at + 1) % cycle.length]);
    }, this);
    blockClickThrough(node);
    return node;
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
