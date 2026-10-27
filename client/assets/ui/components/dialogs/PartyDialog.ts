import { Color, Graphics, isValid, Label, Node, ScrollView, Size, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import PartyStore from "../../core/PartyStore";
import SocialStore from "../../core/SocialStore";
import OtherPlayerManager from "../../core/OtherPlayerManager";
import UiHelper from "../../helpers/UiHelper";
import CombatChannel, { PARTY_ACTION } from "../../utils/net/CombatChannel";
import type { PartyAction, PartyInvite, PartyMemberEntry } from "../../utils/net/CombatChannel";
import { relationLabels } from "../../../configs/social";
import { partyDialogLayout as layout } from "../../../configs/hudLayout";
import { blockClickThrough } from "../../utils/input/UiHit";
import { clearChildren } from "../../utils/node/NodeTree";

/** 两个页签（成员 / 邀请） */
type PartyTab = "members" | "invite";

/** 页签顺序（与 layout.tabs.columns / layout.texts.tabs 一一对应） */
const TABS: PartyTab[] = ["members", "invite"];

/**
 * 队伍弹窗（#399：成员 / 邀请 / 退出 / 解散 / 踢人 / 转让）
 *
 * ## 数据从哪来
 * 全部来自 `PartyStore`（realtime `party` 帧 + `partyInvite` 帧的落点）。
 * 弹窗**不主动拉快照**：队伍状态是「变化即推」的，打开面板时看到的已经是最新的那份；
 * 进图 / 重连时服务端会补一份（见服务端 `pushSnapshotToAccount`），所以也没有「面板空着但我在队里」的窗口。
 *
 * ## 为什么动作都走帧
 * 邀请必须即时送达别人的屏幕，而 HTTP 与 WS 在两个进程里 —— 走帧是唯一能立刻送达的路。
 * 与聊天（#395）、拉黑（#398）同一取舍。发送失败（通道没连上）只提示一句，不假装成功。
 *
 * ## 谁的按钮能点
 * 服务端是唯一裁判（`PARTY_NOT_LEADER` 等码会拒绝），这里只按身份**画**：
 * 队长多「踢出 / 转让」「解散」，队员只有「退出」。画错最多是点一下被拒，
 * 但反过来（该有的按钮没画）玩家会以为功能不存在 —— 所以宁可多画。
 */
export default class PartyDialog {
  /** 弹窗根 */
  private dialog: Node | null = null;
  /** 内容容器（切页 / 状态变化时清空重画） */
  private body: Node | null = null;
  /** 底部按钮容器（身份变化时整份重画：队长多一枚「解散」） */
  private footer: Node | null = null;
  /** 当前页签 */
  private tab: PartyTab = "members";
  private tabNodes = new Map<PartyTab, Node>();
  private tabLabels = new Map<PartyTab, Node>();
  /** PartyStore 订阅（打开期间有效） */
  private unsubscribe: (() => void) | null = null;
  /** 我这一页里已经邀请过的人（30 秒内不重复发；面板关掉就清） */
  private invited = new Set<string>();

  /** 打开 / 关闭弹窗（重复点即关闭） */
  open() {
    if (this.dialog && isValid(this.dialog) && this.dialog.active) {
      this.close();
      return;
    }
    if (this.dialog && !isValid(this.dialog)) this.reset();
    this.dialog = GameUiHelper.createDialog(layout.name, layout.title, new Vec2(), layout.size);
    blockClickThrough(this.dialog);
    LayerManager.addDialogToUILayer(this.dialog);
    this.createTabs();
    this.body = UiHelper.createGroupNode(`${layout.name}_body`, new Vec2());
    this.dialog.addChild(this.body);
    this.paintFooter();
    this.unsubscribe = PartyStore.onChange(() => {
      this.refreshTabCaptions();
      this.render();
    });
    // 默认停在「成员」：打开队伍面板的人先想知道「队里现在有谁」
    this.select("members");
  }

  /** 关闭弹窗（订阅退掉） */
  close() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.dialog && isValid(this.dialog)) this.dialog.destroy();
    this.reset();
  }

  /** 是否开着（Game 里据此决定要不要把邀请提示顶到面板上） */
  isOpen(): boolean {
    return !!this.dialog && isValid(this.dialog) && this.dialog.active;
  }

  //#region 页签

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

  private select(tab: PartyTab) {
    this.tab = tab;
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
        const size = layout.tabs.size;
        graphics.clear();
        graphics.roundRect(-size.width / 2, -size.height / 2, size.width, size.height, layout.tabs.radius);
        graphics.fillColor = active ? layout.tabs.activeFill : layout.tabs.idleFill;
        graphics.fill();
        if (!active) {
          graphics.lineWidth = 1;
          graphics.strokeColor = layout.tabs.idleBorder;
          graphics.roundRect(-size.width / 2, -size.height / 2, size.width, size.height, layout.tabs.radius);
          graphics.stroke();
        }
      }
      const label = labelNode.getComponent(Label);
      if (label) label.color = active ? layout.tabs.activeText : layout.tabs.idleText;
    });
  }

  /** 页签角标：待处理邀请数 / 附近可邀请的人数（数字才值得提醒） */
  private refreshTabCaptions() {
    const counts: Record<PartyTab, number> = {
      members: PartyStore.pendingInvites().length,
      invite: this.invitable().length,
    };
    TABS.forEach((tab, index) => {
      const labelNode = this.tabLabels.get(tab);
      if (!labelNode || !isValid(labelNode)) return;
      const label = labelNode.getComponent(Label);
      if (!label) return;
      const base = layout.texts.tabs[index];
      const count = counts[tab];
      label.string = count > 0 ? `${base}·${count}` : base;
    });
  }

  //#endregion

  //#region 渲染

  private render() {
    const body = this.body;
    if (!body || !isValid(body)) return;
    clearChildren(body);
    this.renderSummary(body);
    this.paintFooter();
    const list = GameUiHelper.createScrollView(layout.list.name, layout.list.position, layout.list.size);
    body.addChild(list);
    const content = list.getComponent(ScrollView)?.content;
    if (!content) return;
    if (this.tab === "members") this.renderMembers(content);
    else this.renderCandidates(content);
  }

  /** 顶部小结：在队伍里显示人数 / 同图人数，没队伍显示一句引导 */
  private renderSummary(body: Node) {
    const snapshot = PartyStore.current();
    const text = snapshot
      ? layout.texts.summary
          .split("{count}")
          .join(`${snapshot.members.length}`)
          .split("{limit}")
          .join(`${snapshot.limit}`)
          .split("{sameMap}")
          .join(`${PartyStore.sameMapCount()}`)
      : layout.texts.solo;
    body.addChild(
      UiHelper.createLabel("party_summary", text, layout.summary.color, layout.summary.fontSize, layout.summary.position, layout.summary.size),
    );
  }

  /** 成员页：待处理邀请在前（有时效，先处理），然后是成员名单 */
  private renderMembers(content: Node) {
    const invites = PartyStore.pendingInvites();
    invites.forEach((invite) => content.addChild(this.createInviteRow(invite)));
    const snapshot = PartyStore.current();
    if (!snapshot) {
      if (invites.length === 0) {
        content.addChild(this.createEmpty(layout.name, layout.texts.memberEmpty));
      }
      return;
    }
    const myRoleId = this.myRoleId();
    let others = 0;
    snapshot.members.forEach((member) => {
      if (member.roleId !== myRoleId) others += 1;
      content.addChild(this.createMemberRow(member, myRoleId));
    });
    if (others === 0) content.addChild(this.createEmpty(layout.name, layout.texts.memberEmpty));
  }

  /** 邀请页：附近的人（同图才拉得到 —— 跨图邀请没有意义，服务端也只看得到在线的） */
  private renderCandidates(content: Node) {
    const list = this.invitable();
    if (list.length === 0) {
      content.addChild(this.createEmpty(layout.name, layout.texts.inviteEmpty));
      return;
    }
    list.forEach((player) => content.addChild(this.createCandidateRow(player)));
  }

  /** 一条待处理邀请：谁邀请的 + 「同意 / 拒绝」 */
  private createInviteRow(invite: PartyInvite) {
    const row = layout.inviteRow;
    const node = this.createPanel(`party_invite_${invite.fromRoleId}`, row.size, row.fill, row.border, row.radius);
    const title = layout.texts.inviteTitle
      .split("{name}")
      .join(invite.fromName)
      .split("{count}")
      .join(`${invite.memberCount}`)
      .split("{limit}")
      .join(`${invite.limit}`);
    node.addChild(
      UiHelper.createLabel(`party_invite_title_${invite.fromRoleId}`, title, layout.row.leaderColor, row.textFontSize, new Vec2(row.nameX, 10), row.nameSize, Label.HorizontalAlign.LEFT),
    );
    node.addChild(
      UiHelper.createLabel(`party_invite_hint_${invite.fromRoleId}`, layout.texts.inviteHint, layout.row.metaColor, layout.row.metaFontSize, new Vec2(row.nameX, -12), row.nameSize, Label.HorizontalAlign.LEFT),
    );
    node.addChild(this.createAction(`party_accept_${invite.fromRoleId}`, layout.texts.accept, new Vec2(row.acceptX, 0), () => this.accept(invite)));
    node.addChild(this.createAction(`party_decline_${invite.fromRoleId}`, layout.texts.decline, new Vec2(row.declineX, 0), () => this.decline(invite)));
    return node;
  }

  /** 一名队友：名字 + 等级/状态；队长对别人多「转让 / 踢出」 */
  private createMemberRow(member: PartyMemberEntry, myRoleId: string) {
    const row = layout.row;
    const isMe = !!myRoleId && member.roleId === myRoleId;
    const node = this.createPanel(`party_member_${member.roleId}`, row.size, row.fill, row.border, row.radius);
    const name = `${member.name}${isMe ? "（我）" : ""}`;
    node.addChild(
      UiHelper.createLabel(
        `party_member_name_${member.roleId}`,
        name,
        member.leader ? row.leaderColor : row.nameColor,
        row.nameFontSize,
        new Vec2(row.nameX, 12),
        row.nameSize,
        Label.HorizontalAlign.LEFT,
      ),
    );
    const state = this.stateOf(member);
    const meta = layout.texts.memberMeta.split("{level}").join(`${member.level}`).split("{state}").join(state);
    node.addChild(
      UiHelper.createLabel(
        `party_member_meta_${member.roleId}`,
        meta,
        member.online ? row.metaColor : row.offlineColor,
        row.metaFontSize,
        new Vec2(row.metaX, -12),
        row.metaSize,
        Label.HorizontalAlign.LEFT,
      ),
    );
    // 队长对**别人**才有踢人 / 转让；对自己那行什么都不画（退出走底部按钮）
    if (PartyStore.isLeader() && !isMe) {
      node.addChild(this.createAction(`party_transfer_${member.roleId}`, layout.texts.transfer, new Vec2(row.action2X, 0), () => this.transfer(member)));
      node.addChild(this.createAction(`party_kick_${member.roleId}`, layout.texts.kick, new Vec2(row.actionX, 0), () => this.kick(member)));
    }
    return node;
  }

  /** 附近的一名玩家：名字 + 等级/关系 + 「邀请」 */
  private createCandidateRow(player: { roleId: string; name: string; relation: string }) {
    const row = layout.row;
    const node = this.createPanel(`party_candidate_${player.roleId}`, row.size, row.fill, row.border, row.radius);
    node.addChild(
      UiHelper.createLabel(
        `party_candidate_name_${player.roleId}`,
        player.name,
        row.nameColor,
        row.nameFontSize,
        new Vec2(row.nameX, 12),
        row.nameSize,
        Label.HorizontalAlign.LEFT,
      ),
    );
    const meta = layout.texts.inviteMeta.split("{relation}").join(relationLabels[player.relation as keyof typeof relationLabels] ?? "");
    node.addChild(
      UiHelper.createLabel(
        `party_candidate_meta_${player.roleId}`,
        meta,
        row.metaColor,
        row.metaFontSize,
        new Vec2(row.metaX, -12),
        row.metaSize,
        Label.HorizontalAlign.LEFT,
      ),
    );
    if (PartyStore.has(player.roleId)) {
      node.addChild(
        UiHelper.createLabel(`party_candidate_in_${player.roleId}`, layout.texts.invited, row.metaColor, row.metaFontSize, new Vec2(row.actionX, 0), new Size(80, 20)),
      );
    } else if (this.invited.has(player.roleId)) {
      node.addChild(
        UiHelper.createLabel(`party_candidate_wait_${player.roleId}`, layout.texts.invite, row.metaColor, row.metaFontSize, new Vec2(row.actionX, 0), new Size(80, 20)),
      );
    } else {
      node.addChild(this.createAction(`party_invite_${player.roleId}`, layout.texts.invite, new Vec2(row.actionX, 0), () => this.invite(player.roleId, player.name)));
    }
    return node;
  }

  //#endregion

  //#region 底部按钮

  /**
   * 底部按钮的绘制（身份变化时重画）
   *
   * 「解散」只在我是队长时出现 —— 队员点解散一定是 50124，画出来只会让人以为功能坏了。
   */
  private paintFooter() {
    const dialog = this.dialog;
    if (!dialog || !isValid(dialog)) return;
    if (this.footer && isValid(this.footer)) this.footer.destroy();
    const footer = UiHelper.createGroupNode("party_footer", new Vec2());
    this.footer = footer;
    footer.addChild(this.createAction("party_footer_invite", layout.texts.invite, layout.footer.invite, () => this.select("invite")));
    if (PartyStore.inParty()) {
      footer.addChild(this.createAction("party_footer_leave", layout.texts.leave, layout.footer.leave, () => this.leave()));
      if (PartyStore.isLeader()) {
        footer.addChild(this.createAction("party_footer_disband", layout.texts.disband, layout.footer.disband, () => this.disband()));
      }
    }
    dialog.addChild(footer);
  }

  //#endregion

  //#region 动作

  /** 邀请一个人（顺手建队由服务端做：邀请人没队伍时自动建一支并自任队长） */
  private invite(roleId: string, name: string): void {
    if (!this.send(PARTY_ACTION.INVITE, roleId)) return;
    this.invited.add(roleId);
    GameUiHelper.createTipText(layout.texts.invitedTip.split("{name}").join(name));
    this.refreshTabCaptions();
    this.render();
  }

  /** 同意一条邀请（成功与否看服务端：满员 / 已在别的队都会被拒） */
  private accept(invite: PartyInvite): void {
    if (!this.send(PARTY_ACTION.ACCEPT, invite.fromRoleId)) return;
    PartyStore.dropInvite(invite.fromRoleId);
  }

  /** 拒绝（静默：服务端把邀请摘掉就行，不必给对方提示） */
  private decline(invite: PartyInvite): void {
    if (!this.send(PARTY_ACTION.DECLINE, invite.fromRoleId)) return;
    PartyStore.dropInvite(invite.fromRoleId);
  }

  private leave(): void {
    if (!this.send(PARTY_ACTION.LEAVE)) return;
    GameUiHelper.createTipText(layout.texts.leaveTip);
  }

  private kick(member: PartyMemberEntry): void {
    if (!this.send(PARTY_ACTION.KICK, member.roleId)) return;
  }

  private transfer(member: PartyMemberEntry): void {
    if (!this.send(PARTY_ACTION.TRANSFER, member.roleId)) return;
    GameUiHelper.createTipText(layout.texts.transferTip.split("{name}").join(member.name));
  }

  private disband(): void {
    if (!this.send(PARTY_ACTION.DISBAND)) return;
    GameUiHelper.createTipText(layout.texts.disbandedTip);
  }

  /** 发一个动作（通道没连上就提示一句，别假装成功） */
  private send(action: PartyAction, roleId?: string): boolean {
    if (CombatChannel.sendParty(action, roleId)) return true;
    GameUiHelper.createTipText(layout.texts.disconnectedTip);
    return false;
  }

  //#endregion

  //#region 零件

  /** 一名成员的第二行状态：队长 > 离线 > 异图 > 在线 */
  private stateOf(member: PartyMemberEntry): string {
    if (member.leader) return layout.texts.stateLeader;
    if (!member.online) return layout.texts.stateOffline;
    if (!member.sameMap) return layout.texts.stateOtherMap;
    return layout.texts.stateOnline;
  }

  /** 我自己的角色 id（标记「（我）」并隐藏对自己那行的踢人按钮；拿不到就不标） */
  private myRoleId(): string {
    const snapshot = SocialStore.get();
    return snapshot ? snapshot.myRoleId : "";
  }

  /** 可邀请的人：附近列表里排除自己与已在队里的人 */
  private invitable(): Array<{ roleId: string; name: string; relation: string }> {
    const myRoleId = this.myRoleId();
    return OtherPlayerManager.nearby()
      .filter((player) => player.roleId && player.roleId !== myRoleId && !PartyStore.has(player.roleId))
      .map((player) => ({ roleId: player.roleId, name: player.name, relation: player.relation }));
  }

  /** 空列表/空页的一句灰字 */
  private createEmpty(name: string, text: string) {
    return UiHelper.createLabel(`${name}_empty`, text, layout.row.metaColor, layout.row.metaFontSize, new Vec2(), new Size(layout.row.size.width, 32));
  }

  /** 行底板（圆角 + 填充 + 描边；尺寸与配色全来自 layout） */
  private createPanel(name: string, size: Size, fill: Color, border: Color, radius: number): Node {
    const node = UiHelper.createNode(name, new Vec2(), size);
    const graphics = node.addComponent(Graphics);
    const path = () => graphics.roundRect(-size.width / 2, -size.height / 2, size.width, size.height, radius);
    graphics.fillColor = fill;
    path();
    graphics.fill();
    graphics.lineWidth = 1;
    graphics.strokeColor = border;
    path();
    graphics.stroke();
    blockClickThrough(node);
    return node;
  }

  /** 行内小按钮（复用 HUD 小按钮的外观，位置由调用方给） */
  private createAction(name: string, text: string, position: Vec2, onTap: () => void) {
    const button = GameUiHelper.createSmallButtion(name, text, position);
    button.on(Node.EventType.TOUCH_END, onTap, this);
    return button;
  }

  //#endregion

  /** 释放引用（关闭后） */
  private reset() {
    this.dialog = null;
    this.body = null;
    this.footer = null;
    this.tab = "members";
    this.invited.clear();
    this.tabNodes.clear();
    this.tabLabels.clear();
  }
}
