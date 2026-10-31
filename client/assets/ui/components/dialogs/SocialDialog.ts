import { Color, EditBox, Graphics, isValid, Label, Node, ScrollView, Size, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import OtherPlayerManager from "../../core/OtherPlayerManager";
import type { NearbyPlayer } from "../../core/OtherPlayerManager";
import SocialStore from "../../core/SocialStore";
import UiHelper from "../../helpers/UiHelper";
import { SocialApi } from "../../utils/net/Api";
import type { SocialEntry } from "../../utils/net/Api";
import { socialDialogLayout as layout } from "../../../configs/hudLayout";
import { getRelationColor, relationLabels } from "../../../configs/social";
import { getText } from "../../../configs/texts";
import { blockClickThrough } from "../../utils/input/UiHit";
import { clearChildren } from "../../utils/node/NodeTree";
import CombatChannel from "../../utils/net/CombatChannel";
import ConfirmDialog from "./ConfirmDialog";
import ReportDialog from "./ReportDialog";
import GuildPanel from "./GuildPanel";
import { createTabStrip, paintTabStrip } from "./tab-kit";

/** 社交弹窗的五个页签 */
type SocialTab = "guild" | "friends" | "enemies" | "nearby" | "blocks";

/** 页签顺序（与 layout.tabs.columns / layout.texts.tabs 一一对应，改这里就三处一起改） */
const TABS: SocialTab[] = ["guild", "friends", "enemies", "nearby", "blocks"];

/**
 * 社交弹窗（#389：帮会 / 好友 / 敌人 / 附近；#398：黑名单）
 *
 * ## 为什么是一个弹窗五个页签
 * 这四件事是同一个问题（「我跟别人的关系」）的四个切面：帮会是组织、好友是双向契约、
 * 敌人是我的单向标记、附近是此刻看得见谁。分成四个入口等于让玩家自己在脑子里拼，
 * 而它们要的原料是同一份 —— 一次快照、一份互见帧。
 *
 * ## 数据从哪来
 * - **好友 / 敌人 / 我的帮会**：`SocialApi.mine()`（写接口都返回同一形状），拿到就塞进
 *   `SocialStore` —— 地图上的名字颜色与这个面板读的是同一份，不会出现两边不一致；
 * - **附近**：`OtherPlayerManager.nearby()`（当前互见帧的内存态）。所以「附近」里的人是
 *   **此刻真的看得见的**，不是服务端按地图列出来的名单 —— 关掉面板走两步再打开就变了；
 * - **黑名单**（#398）：快照里的 `blocks`。名单里只有**我拉黑的人** —— 服务端不下发
 *   「谁拉黑了我」（那等于告诉对方「他怕了」）。
 *
 * ## 帮会页是内嵌的
 * 「帮会」页由 `GuildPanel` 画（#388 的整套逻辑原样复用），本类只负责把内容区交给它、
 * 切页时收回。弹窗的开关 / 拖动 / 层级全在这里一处管。
 */
export default class SocialDialog {
  /** 弹窗根 */
  private dialog: Node | null = null;
  /** 内容容器（切页时清空重画） */
  private body: Node | null = null;
  /** 当前页签 */
  private tab: SocialTab = "guild";
  /** 页签底图（选中态要重画，所以本体与文字分开存） */
  private tabNodes = new Map<SocialTab, Node>();
  /** 页签文字（选中态改色，未选中改灰） */
  private tabLabels = new Map<SocialTab, Node>();
  /** 帮会页（内嵌；只在「帮会」页签时挂到内容区） */
  private guildPanel = new GuildPanel();
  /** 二次确认框（同一时刻只留一个） */
  private confirmDialog: Node | null = null;

  /** 打开/关闭弹窗 */
  open() {
    if (this.dialog && isValid(this.dialog) && this.dialog.active) {
      this.close();
      return;
    }
    if (this.dialog && !isValid(this.dialog)) this.reset();
    this.dialog = GameUiHelper.createDialog(layout.name, layout.title, new Vec2(), layout.size);
    // 弹窗整体吃掉点击：否则点在行与行之间的空隙会穿透到下层 UI（createDialog 已登记过，这里幂等）
    blockClickThrough(this.dialog);
    LayerManager.addDialogToUILayer(this.dialog);
    this.createTabs();
    this.body = UiHelper.createGroupNode(`${layout.name}_body`, new Vec2());
    this.dialog.addChild(this.body);
    this.select("guild");
  }

  /** 关闭弹窗（确认框、内嵌页一起收掉） */
  close() {
    this.closeConfirm();
    this.guildPanel.unmount();
    if (this.dialog && isValid(this.dialog)) this.dialog.destroy();
    this.reset();
  }

  //#region 页签

  /** 建四个页签（位置来自 layout.tabs.columns） */
  private createTabs() {
    const dialog = this.dialog;
    if (!dialog) return;
    const { nodes, labels } = createTabStrip(dialog, layout.name, TABS, layout.texts.tabs, layout.tabs, (tab) => this.select(tab));
    this.tabNodes = nodes;
    this.tabLabels = labels;
  }

  /** 切换页签（清空内容区重画；数据在画之前重拉一次，切过去就是新的） */
  private select(tab: SocialTab) {
    if (this.tab === "guild" && tab !== "guild") this.guildPanel.unmount();
    this.tab = tab;
    this.paintTabs();
    const body = this.body;
    if (!body || !isValid(body)) return;
    clearChildren(body);
    // 先按现有快照画一遍（有就立刻可见，不必等网络），再拉一次最新覆盖
    this.render();
    void this.reload();
  }

  /** 页签底/字配色（选中 = 金色实底深色字；未选中 = 暗底灰字） */
  private paintTabs() {
    paintTabStrip(this.tabNodes, this.tabLabels, TABS, this.tab, layout.tabs);
  }

  /** 页签上的角标（「好友」页签带待处理数：不打开面板也知道有人加你） */
  private refreshTabCaptions() {
    const incoming = SocialStore.incomingCount();
    TABS.forEach((tab, index) => {
      const labelNode = this.tabLabels.get(tab);
      if (!labelNode || !isValid(labelNode)) return;
      const label = labelNode.getComponent(Label);
      if (!label) return;
      const base = layout.texts.tabs[index];
      label.string = tab === "friends" && incoming > 0 ? `${base}·${incoming}` : base;
    });
  }

  //#endregion

  //#region 数据

  /** 重拉我的社交快照（切页 / 每次写操作之后；失败静默 —— 提示由 HttpClient 全局出口弹） */
  private async reload() {
    try {
      const snapshot = await SocialApi.mine();
      SocialStore.set(snapshot);
      this.refreshTabCaptions();
      // 帮会页自己管渲染（它拉的是 /guilds/me，与这份快照无关）：这里再调一次 render()
      // 会把帮会页整块重挂、多打一次请求。只在好友 / 敌人 / 附近三页重画。
      if (this.tab !== "guild" && this.body && isValid(this.body)) this.render();
    } catch {
      // 忽略：面板保持上一次的样子（社交是装饰性数据，不该打断主流程）
    }
  }

  /** 按当前页签重画内容区 */
  private render() {
    const body = this.body;
    if (!body || !isValid(body)) return;
    clearChildren(body);
    if (this.tab === "guild") {
      // 帮会页自带一整套渲染与交互，内容区整块交给它
      this.guildPanel.mount(body);
      return;
    }
    if (this.tab === "friends") this.renderFriends();
    else if (this.tab === "enemies") this.renderEnemies();
    else if (this.tab === "blocks") this.renderBlocks();
    else this.renderNearby();
  }

  //#endregion

  //#region 好友页

  /** 好友页：别人加我 / 我的好友 / 我发出的申请，三段 + 按名加好友 */
  private renderFriends() {
    const body = this.body;
    if (!body) return;
    const snapshot = SocialStore.get();
    const page = layout.friends;
    const texts = layout.texts;
    body.addChild(this.createSectionTitle("social_incoming_title", this.text(texts.incomingTitle, { count: snapshot?.incoming.length ?? 0 }), page.incomingTitle));
    const incoming = GameUiHelper.createScrollView(page.incomingList.name, page.incomingList.position, page.incomingList.size);
    body.addChild(incoming);
    const incomingContent = incoming.getComponent(ScrollView)?.content;
    if (incomingContent) {
      if (!snapshot || snapshot.incoming.length === 0) incomingContent.addChild(this.createEmptyLabel("social_incoming_empty", texts.incomingEmpty));
      else snapshot.incoming.forEach((entry) => incomingContent.addChild(this.createIncomingRow(entry)));
    }
    body.addChild(this.createSectionTitle("social_friend_title", this.text(texts.friendsTitle, { count: snapshot?.friends.length ?? 0 }), page.listTitle));
    const friends = GameUiHelper.createScrollView(page.list.name, page.list.position, page.list.size);
    body.addChild(friends);
    const friendContent = friends.getComponent(ScrollView)?.content;
    if (friendContent) {
      if (!snapshot || snapshot.friends.length === 0) friendContent.addChild(this.createEmptyLabel("social_friend_empty", texts.friendsEmpty));
      else snapshot.friends.forEach((entry) => friendContent.addChild(this.createFriendRow(entry)));
    }
    body.addChild(this.createSectionTitle("social_outgoing_title", this.text(texts.outgoingTitle, { count: snapshot?.outgoing.length ?? 0 }), page.outgoingTitle));
    const outgoing = GameUiHelper.createScrollView(page.outgoingList.name, page.outgoingList.position, page.outgoingList.size);
    body.addChild(outgoing);
    const outgoingContent = outgoing.getComponent(ScrollView)?.content;
    if (outgoingContent) {
      if (!snapshot || snapshot.outgoing.length === 0) outgoingContent.addChild(this.createEmptyLabel("social_outgoing_empty", texts.outgoingEmpty));
      else snapshot.outgoing.forEach((entry) => outgoingContent.addChild(this.createOutgoingRow(entry)));
    }
    this.addAddRow(body, texts.friendInput, texts.addFriend, "social_add_friend", (name) => this.addFriendByName(name));
  }

  /** 好友行：名字 / 等级 · 职业 / 删除 */
  private createFriendRow(entry: SocialEntry) {
    const node = this.createRowNode(`social_friend_row_${entry.roleId}`);
    this.addRowMeta(node, `social_friend_row_meta_${entry.roleId}`, entry);
    const removeButton = GameUiHelper.createSmallButtion(`social_friend_remove_${entry.roleId}`, layout.texts.removeFriend, new Vec2(layout.row.columns.action, 0));
    removeButton.on(Node.EventType.TOUCH_END, () => this.askRemoveFriend(entry), this);
    node.addChild(removeButton);
    return node;
  }

  /** 等我处理的申请：同意 / 拒绝 */
  private createIncomingRow(entry: SocialEntry) {
    const node = this.createRowNode(`social_incoming_row_${entry.roleId}`);
    this.addRowMeta(node, `social_incoming_row_meta_${entry.roleId}`, entry);
    const rejectButton = GameUiHelper.createSmallButtion(`social_incoming_reject_${entry.roleId}`, layout.texts.reject, new Vec2(layout.row.columns.action2, 0));
    rejectButton.on(Node.EventType.TOUCH_END, () => void this.rejectFriend(entry), this);
    node.addChild(rejectButton);
    const acceptButton = GameUiHelper.createSmallButtion(`social_incoming_accept_${entry.roleId}`, layout.texts.accept, new Vec2(layout.row.columns.action, 0));
    acceptButton.on(Node.EventType.TOUCH_END, () => void this.acceptFriend(entry), this);
    node.addChild(acceptButton);
    return node;
  }

  /** 我发出的申请：撤回（服务端就是「删掉这一对关系」，与删好友同一个接口） */
  private createOutgoingRow(entry: SocialEntry) {
    const node = this.createRowNode(`social_outgoing_row_${entry.roleId}`);
    this.addRowMeta(node, `social_outgoing_row_meta_${entry.roleId}`, entry);
    const cancelButton = GameUiHelper.createSmallButtion(`social_outgoing_cancel_${entry.roleId}`, layout.texts.cancel, new Vec2(layout.row.columns.action, 0));
    cancelButton.on(Node.EventType.TOUCH_END, () => void this.removeFriend(entry), this);
    node.addChild(cancelButton);
    return node;
  }

  //#endregion

  //#region 敌人页

  /** 敌人页：我标的敌人 + 按名标敌人 */
  private renderEnemies() {
    const body = this.body;
    if (!body) return;
    const snapshot = SocialStore.get();
    const page = layout.enemies;
    const texts = layout.texts;
    body.addChild(this.createSectionTitle("social_enemy_title", this.text(texts.enemiesTitle, { count: snapshot?.enemies.length ?? 0 }), page.title));
    const list = GameUiHelper.createScrollView(page.list.name, page.list.position, page.list.size);
    body.addChild(list);
    const content = list.getComponent(ScrollView)?.content;
    if (content) {
      if (!snapshot || snapshot.enemies.length === 0) content.addChild(this.createEmptyLabel("social_enemy_empty", texts.enemiesEmpty));
      else snapshot.enemies.forEach((entry) => content.addChild(this.createEnemyRow(entry)));
    }
    this.addAddRow(body, texts.enemyInput, texts.addEnemy, "social_add_enemy", (name) => this.addEnemyByName(name));
  }

  /** 敌人行：名字（红）/ 等级 · 职业 / 解除 */
  private createEnemyRow(entry: SocialEntry) {
    const node = this.createRowNode(`social_enemy_row_${entry.roleId}`);
    this.addRowMeta(node, `social_enemy_row_meta_${entry.roleId}`, entry, getRelationColor("enemy"));
    const removeButton = GameUiHelper.createSmallButtion(`social_enemy_remove_${entry.roleId}`, layout.texts.removeEnemy, new Vec2(layout.row.columns.action, 0));
    removeButton.on(Node.EventType.TOUCH_END, () => this.askRemoveEnemy(entry), this);
    node.addChild(removeButton);
    return node;
  }

  //#endregion

  //#region 黑名单页（#398）

  /** 黑名单页：我拉黑的人 + 按名拉黑 */
  private renderBlocks() {
    const body = this.body;
    if (!body) return;
    const snapshot = SocialStore.get();
    const page = layout.blocks;
    const texts = layout.texts;
    body.addChild(this.createSectionTitle("social_block_title", this.text(texts.blocksTitle, { count: snapshot?.blocks.length ?? 0 }), page.title));
    const list = GameUiHelper.createScrollView(page.list.name, page.list.position, page.list.size);
    body.addChild(list);
    const content = list.getComponent(ScrollView)?.content;
    if (content) {
      if (!snapshot || snapshot.blocks.length === 0) content.addChild(this.createEmptyLabel("social_block_empty", texts.blocksEmpty));
      else snapshot.blocks.forEach((entry) => content.addChild(this.createBlockRow(entry)));
    }
    this.addAddRow(body, texts.blockInput, texts.addBlock, "social_add_block", (name) => this.addBlockByName(name));
  }

  /** 黑名单行：名字（暗灰）/ 等级 · 职业 / 解除 */
  private createBlockRow(entry: SocialEntry) {
    const node = this.createRowNode(`social_block_row_${entry.roleId}`);
    this.addRowMeta(node, `social_block_row_meta_${entry.roleId}`, entry, getRelationColor("block"));
    const removeButton = GameUiHelper.createSmallButtion(`social_block_remove_${entry.roleId}`, layout.texts.removeBlock, new Vec2(layout.row.columns.action, 0));
    removeButton.on(Node.EventType.TOUCH_END, () => this.askRemoveBlock(entry), this);
    node.addChild(removeButton);
    return node;
  }

  //#endregion

  //#region 附近页

  /** 附近页：此刻同图看得见的人（取源是互见帧，不是服务端名单） */
  private renderNearby() {
    const body = this.body;
    if (!body) return;
    const page = layout.nearby;
    const players = OtherPlayerManager.nearby();
    body.addChild(this.createSectionTitle("social_nearby_hint", this.text(layout.texts.nearbyHint, { count: players.length }), page.hint));
    const list = GameUiHelper.createScrollView(page.list.name, page.list.position, page.list.size);
    body.addChild(list);
    const content = list.getComponent(ScrollView)?.content;
    if (!content) return;
    if (players.length === 0) {
      content.addChild(this.createEmptyLabel("social_nearby_empty", layout.texts.nearbyEmpty));
      return;
    }
    players.forEach((player) => content.addChild(this.createNearbyRow(player)));
  }

  /**
   * 附近行：名字（按关系上色）/ 关系标签 / 帮会 / 加好友 / 标敌人
   *
   * 关系标签直接用 `player.relation`（OtherPlayerManager 已经算好，与名字颜色同源），
   * 面板里不再判一遍 —— 两处判定迟早出现「名字红了，标签写着普通」。
   */
  private createNearbyRow(player: NearbyPlayer) {
    const node = this.createRowNode(`social_nearby_row_${player.accountId}`);
    node.addChild(
      UiHelper.createLabel(
        `social_nearby_row_name_${player.accountId}`,
        player.name,
        getRelationColor(player.relation),
        layout.row.nameFontSize,
        new Vec2(layout.row.columns.name, 0),
        new Size(150, 20),
        Label.HorizontalAlign.LEFT,
      ),
    );
    node.addChild(
      UiHelper.createLabel(
        `social_nearby_row_relation_${player.accountId}`,
        relationLabels[player.relation] ?? "",
        getRelationColor(player.relation),
        layout.row.metaFontSize,
        new Vec2(layout.row.relationX, 0),
        layout.row.relationSize,
      ),
    );
    node.addChild(
      UiHelper.createLabel(
        `social_nearby_row_guild_${player.accountId}`,
        player.guildName ? this.text(layout.texts.guildMeta, { guild: player.guildName }) : layout.texts.noGuild,
        layout.row.metaColor,
        layout.row.metaFontSize,
        new Vec2(layout.row.columns.meta, 0),
        new Size(150, 18),
      ),
    );
    // 加好友：已经是好友就置灰（不加 on 回调，点了也不发请求，省掉一次 50111）
    const isFriend = SocialStore.isFriend(player.roleId);
    const friendButton = GameUiHelper.createSmallButtion(
      `social_nearby_friend_${player.accountId}`,
      layout.texts.addFriend,
      new Vec2(layout.row.columns.action2, 0),
    );
    if (!isFriend && !!player.roleId) {
      friendButton.on(Node.EventType.TOUCH_END, () => void this.addFriendById(player), this);
    } else if (isFriend) {
      this.dimButton(friendButton);
    }
    node.addChild(friendButton);
    // 标敌人：已经标过就置灰
    const isEnemy = SocialStore.isEnemy(player.roleId);
    const enemyButton = GameUiHelper.createSmallButtion(
      `social_nearby_enemy_${player.accountId}`,
      layout.texts.addEnemy,
      new Vec2(layout.row.columns.action, 0),
    );
    if (!isEnemy && !!player.roleId) {
      enemyButton.on(Node.EventType.TOUCH_END, () => void this.addEnemyById(player), this);
    } else if (isEnemy) {
      this.dimButton(enemyButton);
    }
    node.addChild(enemyButton);
    // 拉黑（#398）：已拉黑就置灰（正常也看不到他，这条只兜住「拉黑前已在场」的残帧）
    const isBlocked = SocialStore.isBlocked(player.roleId);
    const blockButton = GameUiHelper.createSmallButtion(
      `social_nearby_block_${player.accountId}`,
      isBlocked ? layout.texts.blocked : layout.texts.block,
      new Vec2(layout.row.columns.action3, 0),
    );
    if (!isBlocked && !!player.roleId) {
      blockButton.on(Node.EventType.TOUCH_END, () => this.askBlockById(player), this);
    } else if (isBlocked) {
      this.dimButton(blockButton);
    }
    node.addChild(blockButton);
    // 举报：总是可用（包括已拉黑的人 —— 拉黑是「别让我看见」，举报是「请官方看看」）
    const reportButton = GameUiHelper.createSmallButtion(
      `social_nearby_report_${player.accountId}`,
      layout.texts.report,
      new Vec2(layout.row.columns.action4, 0),
    );
    if (player.roleId) reportButton.on(Node.EventType.TOUCH_END, () => this.openReport(player), this);
    node.addChild(reportButton);
    return node;
  }

  //#endregion

  //#region 动作（全部直接打服务端，成功用响应里的快照覆盖）

  /** 按名加好友（角色名只在同账号内唯一，重名由服务端给 50116，提示里让玩家去「附近」点） */
  private async addFriendByName(name: string) {
    if (!name) {
      GameUiHelper.createErrorTipText(layout.texts.nameEmptyTip);
      return;
    }
    try {
      SocialStore.set(await SocialApi.addFriend({ name }));
      GameUiHelper.createTipText(layout.texts.friendRequestedTip);
      this.render();
    } catch {
      // 50116 重名 / 50109 查无此人：提示已由全局出口弹出（服务端文案里带「用附近点选」的引导）
    }
  }

  /** 点「附近」的某个人加好友（roleId 精确，不存在重名问题） */
  private async addFriendById(player: NearbyPlayer) {
    try {
      SocialStore.set(await SocialApi.addFriend({ roleId: player.roleId }));
      GameUiHelper.createTipText(layout.texts.friendRequestedTip);
      this.render();
    } catch {
      // 50111 已是好友 / 50110 不能加自己：同上
    }
  }

  /** 同意好友申请 */
  private async acceptFriend(entry: SocialEntry) {
    try {
      SocialStore.set(await SocialApi.acceptFriend(entry.roleId));
      GameUiHelper.createTipText(layout.texts.friendAcceptedTip);
      this.render();
    } catch {
      // 50112 申请已失效：同上
    }
  }

  /** 拒绝好友申请（服务端直接删掉这一对，不留记录） */
  private async rejectFriend(entry: SocialEntry) {
    try {
      SocialStore.set(await SocialApi.rejectFriend(entry.roleId));
      GameUiHelper.createTipText(layout.texts.friendRejectedTip);
      this.render();
    } catch {
      // 同上
    }
  }

  /** 删好友 / 撤回申请（同一个接口：双向消失） */
  private async removeFriend(entry: SocialEntry) {
    try {
      SocialStore.set(await SocialApi.removeFriend(entry.roleId));
      GameUiHelper.createTipText(layout.texts.friendRemovedTip);
      this.render();
    } catch {
      // 同上
    }
  }

  /** 按名标敌人 */
  private async addEnemyByName(name: string) {
    if (!name) {
      GameUiHelper.createErrorTipText(layout.texts.nameEmptyTip);
      return;
    }
    try {
      SocialStore.set(await SocialApi.addEnemy({ name }));
      GameUiHelper.createTipText(layout.texts.enemyAddedTip);
      this.render();
    } catch {
      // 50113 已标过 / 50116 重名：同上
    }
  }

  /** 点「附近」的某个人标敌人 */
  private async addEnemyById(player: NearbyPlayer) {
    try {
      SocialStore.set(await SocialApi.addEnemy({ roleId: player.roleId }));
      GameUiHelper.createTipText(layout.texts.enemyAddedTip);
      this.render();
    } catch {
      // 同上
    }
  }

  /** 解除敌人 */
  private async removeEnemy(entry: SocialEntry) {
    try {
      SocialStore.set(await SocialApi.removeEnemy(entry.roleId));
      GameUiHelper.createTipText(layout.texts.enemyRemovedTip);
      this.render();
    } catch {
      // 50114 本来就没标：同上
    }
  }

  /** 按名拉黑 */
  private async addBlockByName(name: string) {
    if (!name) {
      GameUiHelper.createErrorTipText(layout.texts.nameEmptyTip);
      return;
    }
    try {
      SocialStore.set(await SocialApi.addBlock({ name }));
      GameUiHelper.createTipText(layout.texts.blockAddedTip);
      this.render();
    } catch {
      // 50117 已拉黑 / 50119 名单满 / 50116 重名：提示已由全局出口弹出
    }
  }

  /**
   * 拉黑一个人（roleId 精确）
   *
   * 拉黑成功后 `SocialStore.set` 会通知 `OtherPlayerManager.applyRelations`，
   * 场上那个人的节点当场摘掉 —— 不必等下一次互见帧（服务端已经不给我发他的帧了）。
   */
  private async blockById(roleId: string) {
    try {
      SocialStore.set(await SocialApi.addBlock({ roleId }));
      GameUiHelper.createTipText(layout.texts.blockAddedTip);
      this.render();
    } catch {
      // 同上
    }
  }

  /** 解除拉黑（解除后重发一次进图登记，把「本该看得见的人」的全量快照拉回来） */
  private async removeBlock(entry: SocialEntry) {
    try {
      SocialStore.set(await SocialApi.removeBlock(entry.roleId));
      GameUiHelper.createTipText(layout.texts.blockRemovedTip);
      this.render();
      // 解除后对方不会「自己冒出来」（互见帧只发变化），所以要一份全量：
      // 重发 worldJoin 是最省的一条路（服务端会回一帧 full 的 players，且进图本身是幂等的）
      CombatChannel.resendWorldJoin();
    } catch {
      // 50118 本来就没拉黑：同上
    }
  }

  /** 打开举报框（类别 + 可选说明；提交成功后刷新当前页） */
  private openReport(player: NearbyPlayer) {
    ReportDialog.open({
      targetRoleId: player.roleId,
      targetName: player.name,
      onSubmitted: () => {
        GameUiHelper.createTipText(layout.texts.reportSubmittedTip);
        this.render();
      },
    });
  }

  //#endregion

  //#region 行与公共零件

  /**
   * 行底：圆角底色 + 描边
   *
   * 行是滚动区 content（带纵向 Layout）的直接子节点：宽度与 content 相同、高度固定，
   * 所以可以直接挂上去由 Layout 竖排（与帮会列表同一套口径）。
   */
  private createRowNode(name: string) {
    const row = layout.row;
    const node = UiHelper.createNode(name, new Vec2(), row.size);
    const graphics = node.addComponent(Graphics);
    const path = () => graphics.roundRect(-row.size.width / 2, -row.size.height / 2, row.size.width, row.size.height, row.radius);
    graphics.fillColor = row.fill;
    path();
    graphics.fill();
    graphics.lineWidth = 1;
    graphics.strokeColor = row.border;
    path();
    graphics.stroke();
    return node;
  }

  /** 行内「名字 + 等级 · 职业」两列（好友 / 敌人 / 申请行共用） */
  private addRowMeta(node: Node, metaName: string, entry: SocialEntry, nameColor: Color = Color.WHITE) {
    node.addChild(
      UiHelper.createLabel(
        `${metaName}_name`,
        entry.name,
        nameColor,
        layout.row.nameFontSize,
        new Vec2(layout.row.columns.name, 0),
        new Size(150, 20),
        Label.HorizontalAlign.LEFT,
      ),
    );
    node.addChild(
      UiHelper.createLabel(
        metaName,
        this.text(layout.texts.friendMeta, { level: entry.level, occupation: entry.occupation || "—" }),
        layout.row.metaColor,
        layout.row.metaFontSize,
        new Vec2(layout.row.columns.meta, 0),
        new Size(170, 18),
      ),
    );
  }

  /** 段落标题（金色小字） */
  private createSectionTitle(name: string, text: string, geometry: { position: Vec2; size: Size }) {
    return UiHelper.createLabel(name, text, layout.titleColor, layout.titleFontSize, geometry.position, geometry.size);
  }

  /** 列表空态（一行灰字；给足高度，否则纵向 Layout 量出来是 0） */
  private createEmptyLabel(name: string, text: string) {
    return UiHelper.createLabel(name, text, layout.row.metaColor, layout.row.metaFontSize, new Vec2(), new Size(layout.row.size.width, 32));
  }

  /** 底部「输入角色名 + 按钮」一行（好友页与敌人页共用） */
  private addAddRow(body: Node, placeholder: string, buttonText: string, buttonName: string, submit: (name: string) => void) {
    const input = UiHelper.createInputBox(`${buttonName}_input`, placeholder, layout.addRow.input.position, layout.addRow.input.size);
    body.addChild(input);
    const button = GameUiHelper.createSmallButtion(buttonName, buttonText, layout.addRow.button.position);
    button.on(Node.EventType.TOUCH_END, () => submit((input.getComponent(EditBox)?.string ?? "").trim()), this);
    body.addChild(button);
  }

  /** 按钮置灰（已达成的关系：按钮还在原位，但不响应点击 —— 比让玩家点一下拿错误码好） */
  private dimButton(button: Node) {
    const label = button.getChildByName(`${button.name}_label`)?.getComponent(Label);
    if (label) label.color = layout.row.metaColor;
  }

  /** 文案模板替换（模板集中在 configs/layout/dialogs.socialDialogLayout.texts） */
  private text(template: string, params: Record<string, string | number>) {
    return Object.keys(params).reduce((acc, key) => acc.split(`{${key}}`).join(String(params[key])), template);
  }

  //#endregion

  //#region 二次确认（删好友 / 解除敌人 / 拉黑：影响对方或影响自己的视野，先问一句）

  private askRemoveFriend(entry: SocialEntry) {
    this.confirm(
      layout.texts.confirmRemoveFriendTitle,
      this.text(layout.texts.confirmRemoveFriendText, { name: entry.name }),
      () => void this.removeFriend(entry),
    );
  }

  private askRemoveEnemy(entry: SocialEntry) {
    this.confirm(
      layout.texts.confirmRemoveEnemyTitle,
      this.text(layout.texts.confirmRemoveEnemyText, { name: entry.name }),
      () => void this.removeEnemy(entry),
    );
  }

  /** 拉黑要问一句（会剪掉好友 / 敌人关系，且对方的位置立刻从屏幕上消失） */
  private askBlockById(player: NearbyPlayer) {
    this.confirm(
      layout.texts.confirmBlockTitle,
      this.text(layout.texts.confirmBlockText, { name: player.name }),
      () => void this.blockById(player.roleId),
    );
  }

  private askRemoveBlock(entry: SocialEntry) {
    this.confirm(
      layout.texts.confirmRemoveBlockTitle,
      this.text(layout.texts.confirmRemoveBlockText, { name: entry.name }),
      () => void this.removeBlock(entry),
    );
  }

  /** 弹一个确认框（同一时刻只留一个；确定/取消都由 ConfirmDialog 关掉自己后再回调） */
  private confirm(title: string, message: string, onConfirm: () => void) {
    this.closeConfirm();
    const dialog = new ConfirmDialog({
      title,
      message,
      confirmText: getText("label_confirm_ok"),
      cancelText: getText("label_confirm_cancel"),
      onConfirm: () => {
        this.confirmDialog = null;
        onConfirm();
      },
      onCancel: () => {
        this.confirmDialog = null;
      },
    });
    this.confirmDialog = dialog;
    // 确认框自身是全屏模态（盖住整屏并独占输入），挂在 UI 层顶层
    LayerManager.addDialogToUILayer(dialog);
  }

  /** 收掉确认框（关弹窗 / 再弹一个之前调用；没开着时什么也不做） */
  private closeConfirm() {
    if (this.confirmDialog && isValid(this.confirmDialog)) this.confirmDialog.destroy();
    this.confirmDialog = null;
  }

  //#endregion

  /** 释放引用（关闭后） */
  private reset() {
    this.dialog = null;
    this.body = null;
    this.tab = "guild";
    this.tabNodes.clear();
    this.tabLabels.clear();
    this.confirmDialog = null;
  }
}
