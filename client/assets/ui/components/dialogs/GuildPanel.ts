import { Color, EditBox, Graphics, isValid, Node, ScrollView, Size, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import SocialStore from "../../core/SocialStore";
import UiHelper from "../../helpers/UiHelper";
import { GuildApi } from "../../utils/net/Api";
import type { GuildApplication, GuildMember, GuildSummary, MyGuild } from "../../utils/net/Api";
import { guildDialogLayout as layout } from "../../../configs/hudLayout";
import { GUILD_RANK, guildRules } from "../../../configs/social";
import { getText } from "../../../configs/texts";
import { clearChildren } from "../../utils/node/NodeTree";
import ConfirmDialog from "./ConfirmDialog";

/**
 * 帮会页（#388，社交弹窗「帮会」页；#389 起由 SocialDialog 内嵌，自己不再开弹窗）
 *
 * 一个页面两种形态，靠 `myGuild` 是否为 null 切换：
 * - **未加入**：创建表单 + 全部帮会列表（每行一个「申请」）
 * - **已加入**：帮会信息 / 公告（可改）/ 成员名单 / 待审批申请 / 退出或解散
 *
 * ## 为什么整块重建，而不是显隐两套节点 + 局部刷新
 * 任何一次操作（审批、踢人、转让、改公告）都会同时改动「成员 / 申请 / 我的职位」三份数据。
 * 局部刷新迟早漏一块 —— 典型症状是踢完人名单少了一行，「成员（4/50）」还写着 5。
 * 所以 render() 每次清空 body 重画一遍；几十个节点的成本远小于一个对不上的数字。
 *
 * ## 权限不在客户端判
 * `canReview` / `canManage` / `canDisband` 是服务端按我的职位算好下发的：客户端只拿它们
 * 决定按钮显隐，**绝不自己再判一遍 rank** —— 否则改一次职位规则就要在两端各改一处，
 * 而漏掉的那一处，总会变成「按钮能点但请求被拒」。
 * （例外只有「副帮主之间互不踢」这类展示细节，见 createMemberRow：服务端同样会拒。）
 *
 * ## 写接口都带最新状态回来
 * 审批 / 踢人 / 转让 / 改公告的响应就是「操作后的我」（MyGuild），直接替换再渲染，
 * 界面不会出现「操作成功但显示的还是旧名单」；退出 / 解散没有返回值（我已经不在帮会里了），
 * 走 reload() 重新拉一次。
 */
export default class GuildPanel {
  /** 内容容器（由 SocialDialog 提供；每次 render 整块重建，见类注释） */
  private body: Node | null = null;
  /** 当前帮会（null = 未加入） */
  private myGuild: MyGuild | null = null;
  /** 未加入时看到的全部帮会 */
  private guilds: GuildSummary[] = [];
  /** 本次开窗里已申请过的帮会（只影响按钮文案，不落盘；下次开窗重新算） */
  private appliedGuildIds = new Set<string>();
  /** 帮会列表里每个「申请」按钮的文字节点（申请成功后只改这一处，不重画列表 —— 重画会让滚动位置跳回顶部） */
  private applyLabels = new Map<string, Node>();
  /** 二次确认框（同一时刻只留一个） */
  private confirmDialog: Node | null = null;

  /**
   * 挂到社交弹窗的「帮会」页上并拉一次状态
   *
   * 容器由弹窗提供（切页时清空重挂），页面自己不开弹窗 —— 四个页签共用一个弹窗框，
   * 关窗 / 切页的销毁由弹窗统一负责。
   */
  mount(parent: Node) {
    this.body = parent;
    void this.reload();
  }

  /** 离开这一页（收掉确认框；快照留着，切回来时 reload 会覆盖） */
  unmount() {
    this.closeConfirm();
    this.body = null;
  }

  /**
   * 拉一次服务端状态并重画
   *
   * 先问「我在不在帮会里」再决定要不要拉列表：已在帮会的人不需要那份列表，
   * 只有未加入的人才需要 —— 两个请求串起来，省掉一次无意义的往返。
   */
  private async reload() {
    try {
      const mine = await GuildApi.mine();
      const guilds = mine ? [] : await GuildApi.list();
      // 请求期间可能已经切页 / 关窗：此时 body 已不是我们的容器，一个节点都不该碰
      if (!this.body || !isValid(this.body)) return;
      this.myGuild = mine;
      this.guilds = guilds;
      this.render();
    } catch {
      // 失败提示由 HttpClient 的全局出口统一弹出，这里只保证界面保持原样（不吞错误码，也不重复提示）
    }
  }

  /** 按当前状态重画整个弹窗内容 */
  private render() {
    const body = this.body;
    if (!body || !isValid(body)) return;
    clearChildren(body);
    this.applyLabels.clear();
    if (this.myGuild) this.renderMember(this.myGuild);
    else this.renderGuest();
  }

  //#region 未加入：创建 + 帮会列表

  /** 未加入帮会时的形态：创建表单 + 全部帮会 */
  private renderGuest() {
    const body = this.body;
    if (!body) return;
    const guest = layout.guest;
    const texts = layout.texts;
    body.addChild(
      UiHelper.createLabel("guild_guest_hint", texts.guestHint, guest.hint.color, guest.hint.fontSize, guest.hint.position, guest.hint.size),
    );
    // 创建：输入框 + 按钮。长度先按客户端镜像挡一道（guildRules），真判定在服务端
    const nameInput = UiHelper.createInputBox("guild_name_input", guest.nameInput.placeholder, guest.nameInput.position, guest.nameInput.size);
    const nameBox = nameInput.getComponent(EditBox);
    if (nameBox) nameBox.maxLength = guildRules.nameMax;
    body.addChild(nameInput);
    const createButton = GameUiHelper.createMiddleButton(guest.createButton.name, guest.createButton.text, guest.createButton.position);
    createButton.on(Node.EventType.TOUCH_END, () => void this.createGuild(nameInput), this);
    body.addChild(createButton);
    // 全部帮会（人数降序由服务端排好）
    body.addChild(
      UiHelper.createLabel(
        "guild_list_title",
        this.text(texts.listTitle, { count: this.guilds.length }),
        guest.listTitle.color,
        guest.listTitle.fontSize,
        guest.listTitle.position,
        guest.listTitle.size,
      ),
    );
    const list = GameUiHelper.createScrollView(guest.list.name, guest.list.position, guest.list.size);
    body.addChild(list);
    const content = list.getComponent(ScrollView)?.content;
    if (!content) return;
    if (this.guilds.length === 0) {
      content.addChild(this.createEmptyLabel("guild_list_empty", texts.listEmpty));
      return;
    }
    this.guilds.forEach((guild) => content.addChild(this.createGuildRow(guild)));
  }

  /** 帮会列表的一行：帮会名 / 帮主 / 人数 / 申请按钮 */
  private createGuildRow(guild: GuildSummary) {
    const row = layout.row;
    const texts = layout.texts;
    const node = this.createRowNode(`guild_row_${guild.id}`, false);
    node.addChild(
      UiHelper.createLabel(`guild_row_name_${guild.id}`, guild.name, Color.WHITE, row.nameFontSize, new Vec2(row.columns.name, 0), new Size(100, 20)),
    );
    node.addChild(
      UiHelper.createLabel(
        `guild_row_leader_${guild.id}`,
        this.text(texts.rowLeader, { leader: guild.leaderName }),
        row.metaColor,
        row.metaFontSize,
        new Vec2(row.columns.meta, 0),
        new Size(170, 18),
      ),
    );
    node.addChild(
      UiHelper.createLabel(
        `guild_row_count_${guild.id}`,
        this.text(texts.rowMembers, { count: guild.memberCount }),
        row.metaColor,
        row.metaFontSize,
        new Vec2(row.columns.extra, 0),
        new Size(90, 18),
      ),
    );
    // 本窗内申请过就换成「已申请」并且不再发请求：重复申请只会覆盖留言，没有必要连点
    const applied = this.appliedGuildIds.has(guild.id);
    const button = GameUiHelper.createSmallButtion(
      `guild_apply_${guild.id}`,
      applied ? texts.applyDone : texts.applyButton,
      new Vec2(row.columns.action, 0),
    );
    const label = button.getChildByName(`guild_apply_${guild.id}_label`);
    if (label) this.applyLabels.set(guild.id, label);
    button.on(
      Node.EventType.TOUCH_END,
      () => {
        // 已申请过就什么都不做（按钮文案已经变成「已申请」）
        if (this.appliedGuildIds.has(guild.id)) return;
        void this.applyTo(guild);
      },
      this,
    );
    node.addChild(button);
    return node;
  }

  //#endregion

  //#region 已加入：信息 / 公告 / 成员 / 审批 / 退出

  /** 已加入帮会时的形态 */
  private renderMember(guild: MyGuild) {
    const body = this.body;
    if (!body) return;
    const member = layout.member;
    const texts = layout.texts;
    body.addChild(
      UiHelper.createLabel("guild_member_name", guild.name, member.header.color, member.header.fontSize, member.header.position, member.header.size),
    );
    body.addChild(
      UiHelper.createLabel(
        "guild_member_summary",
        this.text(texts.summary, { count: guild.memberCount, limit: guild.memberLimit, rank: guild.myRankLabel }),
        member.summary.color,
        member.summary.fontSize,
        member.summary.position,
        member.summary.size,
      ),
    );
    // 公告：一行展示（长公告在下面的输入框里能看到全文 —— 输入框会带着现有公告）
    body.addChild(
      UiHelper.createLabel(
        "guild_notice",
        guild.notice ? this.text(texts.noticePrefix, { notice: guild.notice }) : texts.noticeNone,
        member.notice.color,
        member.notice.fontSize,
        member.notice.position,
        member.notice.size,
      ),
    );
    // 改公告（帮主 / 副帮主才有输入框，普通成员连入口都看不到）
    if (guild.canManage) {
      const noticeInput = UiHelper.createInputBox(
        "guild_notice_input",
        member.noticeInput.placeholder,
        member.noticeInput.position,
        member.noticeInput.size,
      );
      const noticeBox = noticeInput.getComponent(EditBox);
      if (noticeBox) {
        noticeBox.maxLength = guildRules.noticeMax;
        noticeBox.string = guild.notice;
      }
      body.addChild(noticeInput);
      const saveButton = GameUiHelper.createSmallButtion(member.saveButton.name, member.saveButton.text, member.saveButton.position);
      saveButton.on(Node.EventType.TOUCH_END, () => void this.saveNotice(noticeInput), this);
      body.addChild(saveButton);
    }
    // 成员名单
    body.addChild(
      UiHelper.createLabel(
        "guild_member_title",
        this.text(texts.memberTitle, { count: guild.memberCount, limit: guild.memberLimit }),
        member.memberTitle.color,
        member.memberTitle.fontSize,
        member.memberTitle.position,
        member.memberTitle.size,
      ),
    );
    const memberList = GameUiHelper.createScrollView(member.memberList.name, member.memberList.position, member.memberList.size);
    body.addChild(memberList);
    const memberContent = memberList.getComponent(ScrollView)?.content;
    if (memberContent) {
      if (guild.members.length === 0) memberContent.addChild(this.createEmptyLabel("guild_member_empty", texts.memberEmpty));
      else guild.members.forEach((item) => memberContent.addChild(this.createMemberRow(item, guild)));
    }
    // 待审批：普通成员的 applicants 恒为空数组（服务端不下发），这里明说「看不到」而不是显示「没有申请」
    body.addChild(
      UiHelper.createLabel(
        "guild_applicant_title",
        guild.canReview ? this.text(texts.applicantTitle, { count: guild.applicants.length }) : texts.applicantTitleLocked,
        member.applicantTitle.color,
        member.applicantTitle.fontSize,
        member.applicantTitle.position,
        member.applicantTitle.size,
      ),
    );
    const applicantList = GameUiHelper.createScrollView(member.applicantList.name, member.applicantList.position, member.applicantList.size);
    body.addChild(applicantList);
    const applicantContent = applicantList.getComponent(ScrollView)?.content;
    if (applicantContent) {
      if (!guild.canReview) applicantContent.addChild(this.createEmptyLabel("guild_applicant_locked", texts.applicantEmptyLocked));
      else if (guild.applicants.length === 0) applicantContent.addChild(this.createEmptyLabel("guild_applicant_empty", texts.applicantEmpty));
      else guild.applicants.forEach((item) => applicantContent.addChild(this.createApplicantRow(item)));
    }
    // 退出 / 解散：恰好一个 —— 帮主只能解散（退出会被服务端拒 50106），成员只能退出。单个按钮居中摆
    const position = member.singleButtonPosition;
    if (guild.canDisband) {
      const disbandButton = GameUiHelper.createSmallButtion(member.disbandButton.name, member.disbandButton.text, position);
      disbandButton.on(Node.EventType.TOUCH_END, () => this.askDisband(guild), this);
      body.addChild(disbandButton);
    } else {
      const leaveButton = GameUiHelper.createSmallButtion(member.leaveButton.name, member.leaveButton.text, position);
      leaveButton.on(Node.EventType.TOUCH_END, () => this.askLeave(guild), this);
      body.addChild(leaveButton);
    }
  }

  /** 成员行：名字 / 等级 · 职位 / 转让 · 踢出（自己那一行描金边） */
  private createMemberRow(item: GuildMember, guild: MyGuild) {
    const row = layout.row;
    const texts = layout.texts;
    const self = item.roleId === guild.myRoleId;
    const node = this.createRowNode(`guild_member_row_${item.roleId}`, self);
    node.addChild(
      UiHelper.createLabel(
        `guild_member_row_name_${item.roleId}`,
        item.name,
        Color.WHITE,
        row.nameFontSize,
        new Vec2(row.columns.name, 0),
        new Size(100, 20),
      ),
    );
    node.addChild(
      UiHelper.createLabel(
        `guild_member_row_meta_${item.roleId}`,
        this.text(texts.memberMeta, { level: item.level, rank: item.rankLabel }),
        row.metaColor,
        row.metaFontSize,
        new Vec2(row.columns.meta, 0),
        new Size(170, 18),
      ),
    );
    // 转让：只有帮主、且对方不是自己
    if (guild.myRank === GUILD_RANK.LEADER && !self) {
      const transferButton = GameUiHelper.createSmallButtion(
        `guild_transfer_${item.roleId}`,
        texts.transfer,
        new Vec2(row.columns.action2, 0),
      );
      transferButton.on(Node.EventType.TOUCH_END, () => this.askTransfer(item), this);
      node.addChild(transferButton);
    }
    // 踢人：我管得着、对方不是我、不是帮主；副帮主之间互不踢（服务端同样拒，先不给按钮）
    const canKick =
      guild.canManage &&
      !self &&
      item.rank !== GUILD_RANK.LEADER &&
      !(guild.myRank === GUILD_RANK.VICE && item.rank === GUILD_RANK.VICE);
    if (canKick) {
      const kickButton = GameUiHelper.createSmallButtion(`guild_kick_${item.roleId}`, texts.kick, new Vec2(row.columns.action, 0));
      kickButton.on(Node.EventType.TOUCH_END, () => this.askKick(item), this);
      node.addChild(kickButton);
    }
    return node;
  }

  /** 申请行：申请人 / 等级 · 留言 / 通过 · 拒绝 */
  private createApplicantRow(item: GuildApplication) {
    const row = layout.row;
    const texts = layout.texts;
    const node = this.createRowNode(`guild_applicant_row_${item.roleId}`, false);
    node.addChild(
      UiHelper.createLabel(
        `guild_applicant_row_name_${item.roleId}`,
        item.name,
        Color.WHITE,
        row.nameFontSize,
        new Vec2(row.columns.name, 0),
        new Size(100, 20),
      ),
    );
    node.addChild(
      UiHelper.createLabel(
        `guild_applicant_row_meta_${item.roleId}`,
        item.message
          ? this.text(texts.applicantMetaWithMessage, { level: item.level, message: item.message })
          : this.text(texts.applicantMeta, { level: item.level }),
        row.metaColor,
        row.metaFontSize,
        new Vec2(row.columns.meta, 0),
        new Size(170, 18),
      ),
    );
    const rejectButton = GameUiHelper.createSmallButtion(
      `guild_reject_${item.roleId}`,
      texts.reject,
      new Vec2(row.columns.action2, 0),
    );
    rejectButton.on(Node.EventType.TOUCH_END, () => void this.review(item, false), this);
    node.addChild(rejectButton);
    const acceptButton = GameUiHelper.createSmallButtion(`guild_accept_${item.roleId}`, texts.accept, new Vec2(row.columns.action, 0));
    acceptButton.on(Node.EventType.TOUCH_END, () => void this.review(item, true), this);
    node.addChild(acceptButton);
    return node;
  }

  //#endregion

  //#region 行与列的公共画法

  /**
   * 行底：圆角底色 + 描边（自己那一行描金边）
   *
   * 行是滚动区 content（带纵向 Layout）的直接子节点：宽度与 content 相同、高度固定，
   * 所以可以直接挂上去由 Layout 竖排，不需要再包一层网格（与时装卡片的情形不同）。
   */
  private createRowNode(name: string, self: boolean) {
    const row = layout.row;
    const node = UiHelper.createNode(name, new Vec2(), row.size);
    const graphics = node.addComponent(Graphics);
    const path = () => graphics.roundRect(-row.size.width / 2, -row.size.height / 2, row.size.width, row.size.height, row.radius);
    graphics.fillColor = row.fill;
    path();
    graphics.fill();
    graphics.lineWidth = self ? 2 : 1;
    graphics.strokeColor = self ? row.selfBorder : row.border;
    path();
    graphics.stroke();
    return node;
  }

  /** 列表空态（一行灰字；给足高度，否则纵向 Layout 量出来是 0） */
  private createEmptyLabel(name: string, text: string) {
    const row = layout.row;
    return UiHelper.createLabel(name, text, row.metaColor, row.metaFontSize, new Vec2(), new Size(row.size.width, 32));
  }

  /** 文案模板替换（模板集中在 configs/layout/dialogs.guildDialogLayout.texts） */
  private text(template: string, params: Record<string, string | number>) {
    return Object.keys(params).reduce((acc, key) => acc.split(`{${key}}`).join(String(params[key])), template);
  }

  //#endregion

  //#region 动作（全部直接打服务端，成功后重画）

  /** 建帮：客户端只挡长度，重名 / 已在帮会里都由服务端判 */
  private async createGuild(input: Node) {
    const name = (input.getComponent(EditBox)?.string ?? "").trim();
    if (name.length < guildRules.nameMin || name.length > guildRules.nameMax) {
      GameUiHelper.createErrorTipText(this.text(layout.texts.nameRule, { min: guildRules.nameMin, max: guildRules.nameMax }));
      return;
    }
    try {
      await GuildApi.create({ name });
      GameUiHelper.createTipText(layout.texts.createdTip);
      // 建帮换了我的 guildId：地图上「同帮的人名字是蓝的」判定要立刻跟上（社交快照重拉一次）
      void SocialStore.refresh();
      await this.reload();
    } catch {
      // 提示已由全局出口弹出（重名 50102 / 已在帮会 50103 等），界面保持不变
    }
  }

  /** 申请入帮：成功只把这一行的按钮换成「已申请」，不重画整个列表（免得列表跳回顶部） */
  private async applyTo(guild: GuildSummary) {
    try {
      await GuildApi.apply(guild.id, {});
      this.appliedGuildIds.add(guild.id);
      GameUiHelper.createTipText(layout.texts.appliedTip);
      this.render();
    } catch {
      // 同上
    }
  }

  /** 审批：通过 / 拒绝都返回最新的「我」（成员名单与申请列表会同时变） */
  private async review(applicant: GuildApplication, approve: boolean) {
    try {
      this.myGuild = await GuildApi.review(applicant.roleId, { approve });
      this.render();
    } catch {
      // 同上
    }
  }

  /** 改公告（空串 = 清空） */
  private async saveNotice(input: Node) {
    const notice = (input.getComponent(EditBox)?.string ?? "").trim();
    try {
      this.myGuild = await GuildApi.notice({ notice });
      GameUiHelper.createTipText(layout.texts.noticeSaved);
      this.render();
    } catch {
      // 同上
    }
  }

  /** 踢人 */
  private async kick(member: GuildMember) {
    try {
      this.myGuild = await GuildApi.kick(member.roleId);
      GameUiHelper.createTipText(layout.texts.kickedTip);
      this.render();
    } catch {
      // 同上
    }
  }

  /** 转让帮主（双方职位互换，我变成普通成员） */
  private async transfer(member: GuildMember) {
    try {
      this.myGuild = await GuildApi.transfer({ roleId: member.roleId });
      GameUiHelper.createTipText(layout.texts.transferredTip);
      this.render();
    } catch {
      // 同上
    }
  }

  /** 退出帮会（帮主走不到这里：只有成员才看得到退出按钮） */
  private async leave() {
    try {
      await GuildApi.leave();
      GameUiHelper.createTipText(layout.texts.leftTip);
      // 退帮后 guildId 变成空串：原来的「同帮」全部回落到好友 / 普通，名字颜色要立刻重算
      void SocialStore.refresh();
      await this.reload();
    } catch {
      // 同上
    }
  }

  /** 解散帮会（仅帮主；成员与待审批申请由外键级联清除） */
  private async disband() {
    try {
      await GuildApi.disband();
      GameUiHelper.createTipText(layout.texts.disbandedTip);
      void SocialStore.refresh();
      await this.reload();
    } catch {
      // 同上
    }
  }

  //#endregion

  //#region 二次确认（不可恢复 / 影响他人的操作先问一句）

  private askLeave(guild: MyGuild) {
    this.confirm(layout.texts.confirmLeaveTitle, this.text(layout.texts.confirmLeaveText, { name: guild.name }), () => void this.leave());
  }

  private askDisband(guild: MyGuild) {
    this.confirm(layout.texts.confirmDisbandTitle, this.text(layout.texts.confirmDisbandText, { name: guild.name }), () => void this.disband());
  }

  private askKick(member: GuildMember) {
    this.confirm(layout.texts.confirmKickTitle, this.text(layout.texts.confirmKickText, { name: member.name }), () => void this.kick(member));
  }

  private askTransfer(member: GuildMember) {
    this.confirm(layout.texts.confirmTransferTitle, this.text(layout.texts.confirmTransferText, { name: member.name }), () =>
      void this.transfer(member),
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
}
