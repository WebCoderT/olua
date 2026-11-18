/**
 * 社交线弹窗（行会 / 社交 / 举报 / 聊天 / 组队）布局
 *
 * 拆分自原 configs/layout/dialogs.ts（#1115 批次 2），数值与注释原样保留。
 */
import { Color, Size, Vec2 } from "cc";
import { T } from "../tokens";

export const guildDialogLayout = {
  name: "guild_dialog",
  title: "社 交",
  // ---- 未加入帮会 ----
  /**
   * 页面坐标（#389 起本面板内嵌在社交弹窗 600×560 的「帮会」页里，自己不开弹窗）
   *
   * 社交弹窗顶部多出一条页签栏（tabs.y 219 / 高 32 → 占 203~235），原来的顶部行
   * 必须整体下移 60 才不压在页签上（y 208 → 148）。底部到 −236 为止，留出面板下沿。
   */
  guest: {
    hint: { position: new Vec2(0, 148), size: new Size(560, 22), fontSize: 15, color: T.text[1] },
    nameInput: { position: new Vec2(-60, 110), size: new Vec2(360, 34), placeholder: "输入帮会名（2~12 字）" },
    createButton: { name: "guild_create_button", text: "创建帮会", position: new Vec2(195, 110) },
    listTitle: { position: new Vec2(0, 78), size: new Size(560, 20), fontSize: 13, color: T.gold[4] },
    list: { name: "guild_list", position: new Vec2(0, -86), size: new Size(556, 300) },
  },
  // ---- 已加入帮会 ----
  member: {
    header: { position: new Vec2(-110, 148), size: new Size(340, 24), fontSize: 16, color: T.gold[4] },
    summary: { position: new Vec2(140, 148), size: new Size(280, 22), fontSize: 12, color: T.text[3] },
    notice: { position: new Vec2(0, 116), size: new Size(548, 22), fontSize: 12, color: T.text[2] },
    noticeInput: { position: new Vec2(-60, 86), size: new Vec2(360, 30), placeholder: "输入新公告（0~200 字）" },
    saveButton: { name: "guild_notice_save_button", text: "保存公告", position: new Vec2(195, 86), small: true },
    memberTitle: { position: new Vec2(0, 56), size: new Size(560, 20), fontSize: 13, color: T.gold[4] },
    memberList: { name: "guild_member_list", position: new Vec2(0, -34), size: new Size(556, 160) },
    applicantTitle: { position: new Vec2(0, -126), size: new Size(560, 20), fontSize: 13, color: T.gold[4] },
    applicantList: { name: "guild_applicant_list", position: new Vec2(0, -184), size: new Size(556, 104) },
    /** 退出 / 解散二选一（帮主只能解散、成员只能退出），一律摆 singleButtonPosition */
    leaveButton: { name: "guild_leave_button", text: "退出帮会", small: true },
    disbandButton: { name: "guild_disband_button", text: "解散帮会", small: true },
    /** 只剩一个按钮时（帮主只能解散、成员只能退出）居中摆放，避免偏在一边 */
    singleButtonPosition: new Vec2(0, -254),
  },
  /** 列表行（三种行共用同一套几何与配色） */
  row: {
    size: new Size(556, 48),
    /** 行底色 / 描边 / 自己的那一行的高亮描边 */
    fill: T.surface[1],
    border: T.surface[3],
    selfBorder: T.gold[4],
    /** 行内文字：主名 / 次要信息 */
    nameFontSize: 14,
    metaFontSize: 11,
    metaColor: T.text[3],
    /** 行内 label 尺寸（#1115 批次 3 收编组件内联）：帮会名 / 帮主与成员信息 / 人数 / 空态行高 */
    nameSize: new Size(100, 20),
    metaSize: new Size(170, 18),
    countSize: new Size(90, 18),
    emptyHeight: 32,
    radius: 6,
    /** 行内各列的中心 x（相对行中心） */
    columns: {
      name: -180,
      meta: -40,
      extra: 90,
      action: 210,
      action2: 150,
    },
  },
  /** 文案（状态提示与按钮，集中在这里避免散在组件里） */
  texts: {
    guestHint: "你还没有加入帮会：可以自己创建一个，或申请加入下面任意一个",
    guestHintWithCost: "建帮需 {need}，也可以直接申请加入下面的帮会",
    /** 建帮门槛的两个分句 + 连接符（门槛数值来自快照，单位词留在这里） */
    createNeedLevel: "{level} 级",
    createNeedBindGold: "{amount} 绑定元宝",
    createNeedJoin: " + ",
    listTitle: "全部帮会（{count}）",
    listEmpty: "还没有人创建帮会，你可以是第一个",
    nameRule: "帮会名要 {min}~{max} 个字",
    rowLeader: "帮主 {leader}",
    rowMembers: "{count} 人",
    applyButton: "申请",
    applyDone: "已申请",
    memberTitle: "成员（{count}/{limit}）",
    memberEmpty: "（没有成员）",
    memberMeta: "{level} 级 · {rank}",
    applicantTitle: "待审批（{count}）",
    applicantTitleLocked: "待审批（只有帮主和副帮主能看到）",
    applicantEmpty: "（没有待审批的申请）",
    applicantEmptyLocked: "（你的职位看不到申请）",
    applicantMeta: "{level} 级",
    applicantMetaWithMessage: "{level} 级 · {message}",
    noticePrefix: "公告：{notice}",
    noticeNone: "公告：（暂无）",
    summary: "{count}/{limit} 人 · 我的职位：{rank}",
    accept: "通过",
    reject: "拒绝",
    kick: "踢出",
    transfer: "转让",
    /** 任命 / 卸任副帮主（#871；同一个按钮按目标当前职位换字，所以两个字都得短） */
    appoint: "任命",
    demote: "卸任",
    appointedTip: "已任命为副帮主",
    demotedTip: "已卸任副帮主",
    noticeSaved: "公告已更新",
    createdTip: "帮会创建成功",
    appliedTip: "申请已提交，等待帮主审批",
    leftTip: "已退出帮会",
    disbandedTip: "帮会已解散",
    kickedTip: "已把对方踢出帮会",
    transferredTip: "帮主已转让",
    /** 二次确认（不可恢复 / 影响他人的操作都要先问一句） */
    confirmLeaveTitle: "退出帮会",
    confirmLeaveText: "确定退出「{name}」吗？退出后要重新申请才能回来",
    confirmDisbandTitle: "解散帮会",
    confirmDisbandText: "确定解散「{name}」吗？成员与待审批申请会一并清除，不可恢复",
    confirmKickTitle: "踢出成员",
    confirmKickText: "确定把「{name}」踢出帮会吗？",
    confirmTransferTitle: "转让帮主",
    confirmTransferText: "确定把帮主转给「{name}」吗？你会变成普通成员，且自己无法撤回",
  },
};

//#endregion

//#region 社交弹窗（#389：帮会 / 好友 / 敌人 / 附近四个页签）

/**
 * 社交弹窗布局
 *
 * **四页共用一个框**：页签在标题下方一行，内容区由 SocialDialog 按页挂载 ——
 * 「帮会」页沿用 `guildDialogLayout` 的坐标（那份坐标是按 500 高的框调的，
 * 这里把框加到 560 高，页签正好塞进多出来的 60 里，帮会页一个字都不用挪）。
 *
 * 好友页有**三段列表**（别人加我 / 我的好友 / 我发出的），所以每段都给了固定高度；
 * 行高与帮会列表一致（48），一眼看上去是同一套东西。
 */

export const socialDialogLayout = {
  name: "social_dialog",
  title: "社 交",
  eyebrow: "好友 · 帮会",
  /** 比通用弹窗高 60：多出来的一行放页签（帮会页的坐标因此可以原样复用） */
  size: new Size(600, 560),
  /**
   * 页签栏（选中金色底、未选中暗色底；x 是各页签中心，从「帮会」到「附近」）
   * 稿 13-social：五枚 96 宽 + 6 间距 = 504（内容宽 560），整行居中 → ±102 步进
   */
  tabs: {
    y: 219,
    size: new Size(96, 32),
    columns: [-204, -102, 0, 102, 204],
    /** 与 texts.tabs 一一对应，别只改一处 */
    radius: T.radius.r2,
    activeFill: T.gold[4],
    activeText: T.surface[3],
    idleFill: T.surface[2],
    idleText: T.text[1],
    idleBorder: T.surface[3],
    fontSize: T.fontSize.f14,
  },
  /** 列表行（与帮会列表同一套几何与配色） */
  row: {
    size: new Size(556, 52),
    fill: T.surface[1],
    border: T.surface[3],
    radius: T.radius.r2,
    nameFontSize: T.fontSize.f13,
    metaFontSize: T.fontSize.f11,
    metaColor: T.text[3],
    columns: {
      name: -180,
      meta: -40,
      /** 行尾按钮，从右往左：主动作 210 → 150 → 90 → 30（小按钮宽 56.5，间隙 3.5） */
      action: 210,
      action2: 150,
      action3: 90,
      action4: 30,
    },
    /** 行内「关系」标签（右对齐的小字，颜色按关系走） */
    relationSize: new Size(64, 18),
    relationX: -86,
  },
  /** 好友页：三段列表各占一块（标题 + 滚动区） */
  friends: {
    incomingTitle: { position: new Vec2(0, 200), size: new Size(560, 20) },
    incomingList: { name: "social_incoming_list", position: new Vec2(0, 150), size: new Size(556, 96) },
    listTitle: { position: new Vec2(0, 96), size: new Size(560, 20) },
    list: { name: "social_friend_list", position: new Vec2(0, 18), size: new Size(556, 148) },
    outgoingTitle: { position: new Vec2(0, -60), size: new Size(560, 20) },
    outgoingList: { name: "social_outgoing_list", position: new Vec2(0, -110), size: new Size(556, 96) },
  },
  /** 敌人页：一整块列表 */
  enemies: {
    title: { position: new Vec2(0, 200), size: new Size(560, 20) },
    list: { name: "social_enemy_list", position: new Vec2(0, 40), size: new Size(556, 312) },
  },
  /** 附近页：一行说明 + 一整块列表（数据源是当前互见帧的内存态） */
  nearby: {
    hint: { position: new Vec2(0, 200), size: new Size(560, 20) },
    list: { name: "social_nearby_list", position: new Vec2(0, 40), size: new Size(556, 312) },
  },
  /** 黑名单页（#398）：与敌人页同构 —— 一整块列表 + 底部「按名拉黑」 */
  blocks: {
    title: { position: new Vec2(0, 200), size: new Size(560, 20) },
    list: { name: "social_block_list", position: new Vec2(0, 40), size: new Size(556, 312) },
  },
  /** 加人/标人一行（好友页与敌人页共用，贴在框底） */
  addRow: {
    input: { position: new Vec2(-70, -226), size: new Vec2(400, 30) },
    button: { position: new Vec2(195, -226) },
  },
  /** 小字（段落标题用金色，空态用灰） */
  titleColor: T.gold[4],
  titleFontSize: 12,
  /** 文案 */
  texts: {
    tabs: ["帮 会", "好 友", "敌 人", "附 近", "黑名单"],
    friendsTitle: "我的好友（{count}）",
    friendsEmpty: "（还没有好友：在「附近」点「加好友」，或按名字申请）",
    incomingTitle: "别人加我（{count}）",
    incomingEmpty: "（没有等你处理的申请）",
    outgoingTitle: "我发出的申请（{count}）",
    outgoingEmpty: "（没有等对方处理的申请）",
    enemiesTitle: "我标的敌人（{count}）",
    enemiesEmpty: "（还没标过谁：把名字标成敌人后，你看到他的名字就是红的）",
    nearbyHint: "附近的人（{count}；同图可见，只显示此刻看得见的人）",
    nearbyEmpty: "（附近没有其他玩家）",
    blocksTitle: "黑名单（{count}）",
    blocksEmpty: "（黑名单是空的：在「附近」点「拉黑」，屏蔽他的人与消息）",
    blockInput: "输入角色名拉黑",
    addBlock: "拉黑",
    removeBlock: "解除",
    block: "拉黑",
    blocked: "已拉黑",
    report: "举报",
    blockAddedTip: "已拉黑（他的消息与位置不再出现，对方不会收到通知）",
    blockRemovedTip: "已解除拉黑",
    reportSubmittedTip: "举报已提交，管理端会人工处理",
    confirmBlockTitle: "拉黑",
    confirmBlockText: "确定拉黑「{name}」吗？拉黑后你收不到他的聊天、看不到他的位置；他那边不会收到任何提示",
    confirmRemoveBlockTitle: "解除拉黑",
    confirmRemoveBlockText: "确定解除对「{name}」的拉黑吗？他的消息与位置会重新出现",
    friendInput: "输入角色名加好友",
    enemyInput: "输入角色名标敌人",
    addFriend: "加好友",
    addEnemy: "标敌人",
    accept: "同意",
    reject: "拒绝",
    removeFriend: "删除",
    removeEnemy: "解除",
    cancel: "撤回",
    friendMeta: "{level} 级 · {occupation}",
    guildMeta: "「{guild}」",
    noGuild: "无帮会",
    friendRequestedTip: "好友申请已发出",
    friendAcceptedTip: "已加为好友",
    friendRejectedTip: "已拒绝",
    friendRemovedTip: "已删除好友",
    enemyAddedTip: "已标为敌人（对方不会收到通知）",
    enemyRemovedTip: "已解除",
    ambiguousTip: "有多个同名角色，请在「附近」里点选添加",
    nameEmptyTip: "先输入角色名",
    confirmRemoveFriendTitle: "删除好友",
    confirmRemoveFriendText: "确定删除好友「{name}」吗？对方那边也会同时消失（可以重新加）",
    confirmRemoveEnemyTitle: "解除敌人",
    confirmRemoveEnemyText: "确定解除对「{name}」的敌意吗？他的名字会变回普通颜色",
  },
};

//#endregion

//#region 举报弹窗（#398）

/**
 * 举报弹窗布局
 *
 * 与确认框同款（全屏遮罩 + 居中面板），但多三样东西：**类别选择**（四个小按钮，选中变金）、
 * 补充说明输入框、提交按钮。为什么不做成「几个文件对话框套娃」：
 * 举报是一次性的低频操作，弹一次、填完就走，不需要常驻面板。
 */

export const reportDialogLayout = {
  name: "report_dialog",
  /** 眉题（「副标题必须有」，全弹窗统一 `.panel-eyebrow` 口径） */
  eyebrow: "反馈",
  maskColor: T.surface.scrim,
  panel: { name: "report_panel", size: new Size(460, 320) },
  title: { name: "report_title", position: new Vec2(0, 122), size: new Size(400, 26), fontSize: 16, color: T.ember[4] },
  /** 提示行（被举报人 + 一句话说明举报只落库） */
  hint: { name: "report_hint", position: new Vec2(0, 86), size: new Size(400, 20), fontSize: 13, color: T.text[2] },
  /** 类别小按钮：一行四个（中心 x 从 -135 到 135，间隔 90） */
  category: {
    y: 44,
    columns: [-135, -45, 45, 135],
    size: new Size(84, 30),
    activeFill: T.gold[4],
    activeText: T.surface[3],
    idleFill: T.surface[2],
    idleText: T.text[1],
    idleBorder: T.surface[3],
    radius: T.radius.r2,
    fontSize: T.fontSize.f12,
  },
  /** 补充说明输入框（单行，200 字上限在服务端 DTO 里） */
  reason: { name: "report_reason", position: new Vec2(0, -14), size: new Vec2(400, 30) },
  /** 底部两个按钮（与确认框同位） */
  submitButton: { name: "report_submit_button", position: new Vec2(-90, -110) },
  cancelButton: { name: "report_cancel_button", position: new Vec2(90, -110) },
  texts: {
    title: "举报「{name}」",
    hint: "举报只提交给管理端人工处理，不会通知对方",
    reasonPlaceholder: "补充说明（可留空）",
    submit: "提交举报",
    cancel: "取消",
    categories: ["骚扰辱骂", "外挂刷资源", "名字违规", "其他"],
  },
};

//#endregion

//#region 聊天窗（#395；#469 起为常驻左下角小窗）

/**
 * 聊天窗布局（世界 / 帮会 / 私聊三页签）
 *
 * **#469 起不再是居中大弹窗**：按主流网游的习惯改成**常驻左下角的小窗**（440×280），
 * 进游戏自动打开（引导进行中除外）。**常驻不可关闭**（2026-11-18 用户拍板）：
 * 稿里的两颗工具钮（清屏 / 收起）已删，窗体没有关闭入口。
 *
 * 停靠位置算过两侧邻居：左下角摇杆 175×172（margin 24/18，顶到 y=-185），
 * 任务追踪栏三行到 y=124 —— 本窗 marginY 205（下缘 y=-170）到 y=110，两头都不叠。
 *
 * 气泡（bubbles）不是窗体的一部分：它是屏幕左上角的常驻演出（窗关着的时候新消息往上冒），
 * 布局放在这里只是因为「聊天的长相关什么」都归这一块管。
 */

export const chatDialogLayout = {
  name: "chat_box",
  /** 稿 `.chat{width:424px;height:302px}` */
  size: new Size(424, 302),
  /** 常驻停靠：屏幕左下角（稿 left 20 / bottom 18 → 中心 (-960+20+212, -540+18+151)） */
  position: new Vec2(-728, -371),
  /**
   * 窗体底板（稿 `.chat .panel` 是 `panel panel--rivet`：暖炭褐半透明 + 古铜金发丝线 + r-3 + 四角铆钉）
   *
   * **必须与其它 HUD 面板同一套**：早前这里是 `scrim`（纯黑 62%）+ `surface[0]` 描边，
   * 在小地图与底栏旁边看就是「一个没有边框的黑洞」—— 暖褐面板之间夹一块冷黑，
   * 三处 UI 各说各话（2026-11-17 用户指出）。面板类统一 `surface.glass` + `line[3]`。
   */
  box: {
    /** 稿 `.chat .panel` = `panel--rivet`：linear-gradient(160deg,rgba(28,20,12,.94),rgba(16,11,7,.9)) */
    fill: new Color(19, 13, 8, 240),
    /** 渐变亮端（顶）与过渡带占比：Graphics 没有渐变，用「底 + 顶带」近似 */
    fillTop: new Color(28, 20, 12, 240),
    fillTopRatio: 0.5,
    border: T.line[3],
    radius: T.radius.r3,
    borderWidth: T.border.width,
    padding: 12,
  },
  /**
   * 页签（四个：世界 / 同图 / 帮会 / 私聊；贴窗顶左侧一格排开）
   *
   * 稿 `.chat-tabs{display:flex;gap:5px}` + `button{height:22px;padding:0 9px;font-size:11px}`：
   * 四个页签只占头部左半（约 175px），不是四条通栏；选中 = 金渐变底 + `text-on-gold` 字，
   * 未选中 = 半透明黑底 + `line-2` 描边 + `text-3` 字。
   */
  tabs: {
    y: 131,
    size: new Size(50, 22),
    columns: [-175, -120, -65, -10],
    radius: T.radius.r2,
    /** 稿是 `linear-gradient(180deg,gold-4,gold-3)`：平涂取中间档 gold-3，文字用深色 */
    activeFill: T.gold[3],
    activeText: T.text.onGold,
    idleFill: T.surface.sunken,
    idleText: T.text[3],
    idleBorder: T.line[2],
    fontSize: T.fontSize.f11,
  },
  /**
   * 头/底的 1px 暗分隔线（稿 `.chat-head{border-bottom:1px solid rgba(0,0,0,.55)}`、
   * `.chat-in{border-top:1px solid rgba(0,0,0,.55)}`）
   * 位置是分隔线在面板内的中心 y：头部下沿 = 151 - (9+22+8) = 112，输入行上沿 = -151 + 44 = -107
   */
  dividers: { color: new Color(0, 0, 0, 140), headY: 112, inputY: -107 },
  /** 消息列表（窗体主体，位于两条分隔线之间） */
  list: { name: "chat_message_list", position: new Vec2(0, 2), size: new Size(400, 210) },
  /**
   * 消息行：时间戳 + 发送者名（按关系上色）+ 正文
   *
   * 稿 `.msg` 是**纯文字行**（没有行底板）：`[19:58] [世界] 铁头: 收 40 级武器`。
   * 早前每行一块 `surface[1]` 深底 + 看不见的 `surface[3]` 描边，聊天气泡区看着像一排黑条；
   * 这里底板与描边都置透明（组件据此跳过绘制），文字色单独给 `text`。
   */
  row: {
    size: new Size(376, 22),
    /** 空态行高（#1115 批次 3 收编组件内联的 32） */
    emptyHeight: 32,
    fill: T.overlay.transparent,
    border: T.overlay.transparent,
    radius: 6,
    nameFontSize: T.fontSize.f11,
    textFontSize: T.fontSize.f11,
    /** 时间戳（稿 `.msg .t`：9.5px、text-4、等宽） */
    timeX: -172,
    timeSize: new Size(34, 16),
    timeFontSize: T.fontSize.f10,
    /** 名字列（时间戳右侧；名字 bbox 右缘与正文左缘留 2px 缝） */
    nameX: -104,
    nameSize: new Size(96, 16),
    /** 正文列（吃剩下的宽度） */
    textX: 54,
    textSize: new Size(208, 18),
    metaColor: T.text[3],
    /** 正文色（稿 `--text-2`） */
    text: T.text[2],
  },
  /**
   * 输入行（贴窗底；私聊有对象时旁边多一枚「返回」）
   *
   * 稿 `.chat-in{padding:8px 12px 10px}`：左侧频道 chip（26 高）｜ 输入框（26 高，吃满剩余）｜
   * 金色发送键（26 高、最小 56 宽）。
   */
  inputRow: {
    /** 当前频道 chip（稿 `.chat-in .chip`：26 高、`line-2` 边、金-4 字 + ▾） */
    chip: { position: new Vec2(-172, -122), size: new Vec2(56, 26), fontSize: T.fontSize.f11, fill: T.surface.input, border: T.line[2], radius: T.radius.r1 },
    /**
     * 输入条：26 高的窄框必须有底板 + 小字号 —— 默认 24 号字的字形就 24 高，
     * 在 26 高的框里会顶出上下边、贴到窗体边框上（#477 顺带发现）
     */
    input: {
      position: new Vec2(-26, -122),
      size: new Vec2(220, 26),
      fontSize: T.fontSize.f11,
      /** 稿 `.chat-in .input`：rgba(0,0,0,.42) 沉底 + `line-2` 发丝线 */
      fill: T.surface.input,
      border: T.line[2],
      radius: T.radius.r2,
    },
    /** 发送键（稿 `.btn--gold`：金渐变底 + 深字，min-width 56） */
    send: {
      position: new Vec2(112, -122),
      size: new Vec2(56, 26),
      fontSize: T.fontSize.f11,
      fill: T.gold[3],
      fillTop: T.gold[4],
      border: T.gold[5],
      text: T.text.onGold,
    },
    back: { position: new Vec2(176, -122), size: new Vec2(44, 26) },
  },
  /** 私聊选人页：一行说明 + 候选列表（聊天记录里出现过的 + 附近的人） */
  privatePick: {
    hint: { position: new Vec2(0, 84), size: new Size(380, 18) },
    list: { name: "chat_private_pick_list", position: new Vec2(0, -10), size: new Size(392, 170) },
  },
  /**
   * 选人行的行内几何（行高 / 底色 / 描边复用上面的 row，只是名字列不同）：
   * 选人行只有「名字 + 一枚按钮」，名字列按消息行的窄列摆会几乎贴到行左缘，
   * 且 120 宽装不下最长 12 字的角色名 —— 这里把名字列居中放宽到 220，按钮挪到行尾
   */
  pickRow: {
    nameX: -70,
    nameSize: new Size(220, 18),
    buttonX: 140,
  },
  /** 屏幕气泡（弹窗关着时新消息在左上角冒一下；最多同时三条，逐条下移） */
  bubbles: {
    /** 首条气泡位置（横屏 1920×1080，屏幕坐标原点在中心） */
    position: new Vec2(-660, 290),
    size: new Size(430, 30),
    spacing: 34,
    maxCount: 3,
    fontSize: 12,
    fill: T.surface[1],
    border: T.surface[3],
    radius: 6,
    /** 停留毫秒（到了自己消失；新消息来了重置计时） */
    lifetimeMs: 6000,
    /** 正文截断（气泡里只求「知道有人说话」，全量在面板里看） */
    textMaxLength: 40,
  },
  /** 小字 */
  titleColor: T.gold[4],
  titleFontSize: 12,
  /** 文案 */
  texts: {
    tabs: ["世界", "同图", "帮会", "私聊"],
    worldEmpty: "（还没有人说第一句——输入框在下面）",
    mapEmpty: "（同图频道还没有消息；跟眼前的人打个招呼）",
    guildEmpty: "（帮会频道还没有消息；没有帮会时发不出去）",
    /** 私聊**选人页**的空态（还没挑对象） */
    privateEmpty: "（还没有私聊：先点「选人」挑一个对象）",
    /**
     * 私聊**会话页**的空态（已经挑好对象、只是还没聊过）
     *
     * 不能复用 privateEmpty：那句是「先点选人挑一个对象」，而这时玩家已经挑好了，
     * 再让他去挑就是自相矛盾（#495，与 #491 的组队空态同一类错误）。
     */
    privateChatEmpty: "（还没有私聊消息，说点什么吧）",
    inputWorld: "对全世界说点什么…",
    inputMap: "对同图的人说点什么…",
    inputGuild: "对帮会的伙伴说点什么…",
    inputPrivate: "对「{name}」说…",
    send: "发送",
    back: "返回",
    pickHint: "选择私聊对象（聊过的 + 附近的人）",
    pickEmpty: "（附近没有其他玩家，也还没聊过天）",
    privateChat: "私 聊",
    disconnectedTip: "实时通道未连接，暂时不能发言",
    guildPrefix: "［{guild}］",
    privateTo: "→ {name}",
  },
};

//#endregion

//#region 任务弹窗（#396）

/**
 * 任务弹窗布局（与聊天弹窗同框：600×560）
 *
 * 两个页签（进行中 / 可接）—— 「已完成」不列：主线领奖后只是链门控的一行数据，
 * 日常领奖即删行，玩家真正要看的是「现在能做什么」。
 *
 * 行内左侧是任务名 + 进度 / 目标描述，右侧一枚动作按钮（接取 / 交付 / 灰掉）。
 */

export const partyDialogLayout = {
  name: "party_dialog",
  title: "队 伍",
  eyebrow: "快捷键 · G",
  size: new Size(600, 540),
  /** 页签（两枚 96 宽，与任务弹窗同款；头部下沿 225 − 小结 30 − 半行高 16 = 179） */
  tabs: {
    y: 179,
    size: new Size(96, 32),
    columns: [-51, 51],
    radius: T.radius.r2,
    activeFill: T.gold[4],
    activeText: T.surface[3],
    idleFill: T.surface[2],
    idleText: T.text[1],
    idleBorder: T.surface[3],
    fontSize: T.fontSize.f14,
  },
  /** 顶部小结（「3 / 4 人 · 同图 2 人」；没队伍时显示一句引导）—— 稿 `.psum` 在页签上方 */
  summary: { position: new Vec2(0, 215), size: new Size(556, 20), fontSize: T.fontSize.f12, color: T.text[3] },
  /** 成员 / 候选列表（稿 `.plist` 360 高，中心 -27） */
  list: { name: "party_member_list", position: new Vec2(0, -27), size: new Size(556, 360) },
  /** 成员行：名字 + 等级/状态（左）+ 动作按钮（右，最多两枚） */
  row: {
    size: new Size(552, 56),
    fill: T.surface[1],
    border: T.surface[3],
    radius: T.radius.r2,
    nameFontSize: T.fontSize.f13,
    metaFontSize: T.fontSize.f11,
    nameColor: T.text[1],
    metaColor: T.text[3],
    leaderColor: T.gold[4],
    offlineColor: T.text[4],
    /**
     * 动作按钮的水平中心（两枚时左右各一；一枚时用 actionX）
     * 小按钮宽 56.5：184 / 244 → 155.75~212.25 与 215.75~272.25，两枚间距 3.5、右缘留 3.75 不越行（#477）
     */
    actionX: 184,
    action2X: 244,
    /** 名字 / 次行的 x 见 quest 行的注释：文本框左缘 + 16 = 行内左缘（552 宽 → x = −100，宽 320） */
    nameX: -100,
    nameSize: new Size(320, 20),
    metaX: -100,
    metaSize: new Size(320, 18),
  },
  /** 邀请行（队伍页顶部的「某人邀请你」，高一点点放两枚按钮） */
  inviteRow: {
    size: new Size(552, 52),
    fill: T.surface[2],
    border: T.gold[2],
    radius: T.radius.r2,
    acceptX: 150,
    declineX: 232,
    /** 同上：文本框左缘 + 16 = 行内左缘（x = −100，宽 320），两枚小按钮落在 121.75~260.25 不越行 */
    nameX: -100,
    /** 标题 / 提示两行的中心 y（#1115 批次 3 收编组件内联的 10 / -12） */
    titleY: 10,
    hintY: -12,
    nameSize: new Size(320, 20),
    textFontSize: T.fontSize.f12,
  },
  /** 底部按钮（邀请 / 退出 / 解散；不是队长的「解散」不画）—— 列表底 -207 − 12 − 半高 15 = -234 */
  footer: {
    invite: new Vec2(-150, -234),
    leave: new Vec2(0, -234),
    disband: new Vec2(150, -234),
  },
  /** 文案 */
  texts: {
    tabs: ["队 员", "邀 请"],
    /** 顶部小结：{count} / {limit} 人 · 同图 {sameMap} 人 */
    summary: "{count} / {limit} 人 · 同图 {sameMap} 人",
    /** 没队伍时的一句引导（面板空着也要说清「怎么开始」） */
    solo: "你还没有队伍：去「邀请」拉一个人，顺手就建队",
    /** 成员行第二行：Lv{level} · 状态 */
    memberMeta: "Lv {level} · {state}",
    stateLeader: "队长",
    stateOnline: "在线",
    stateOffline: "离线",
    stateOtherMap: "异图",
    memberEmpty: "（队伍里只有你一个人：去「邀请」再拉几个）",
    /**
     * 没队伍时成员区的占位（**不要**复用 memberEmpty）
     *
     * memberEmpty 说的是「队伍里只有你一个人」—— 没队伍时它和顶部的 solo（「你还没有队伍」）
     * 同屏出现就是自相矛盾（#491）。这里只做中性说明，不宣称任何队伍状态。
     */
    noPartyEmpty: "（队伍成员会显示在这里）",
    inviteEmpty: "（附近没有别的玩家 —— 同图的人才拉得到）",
    /** 候选行第二行：只有关系（互见帧不下发对方等级，写死一个 Lv 会骗人） */
    inviteMeta: "{relation}",
    /** 邀请行：{name} 邀请你加入队伍（{count}/{limit}） */
    inviteTitle: "{name} 邀请你加入队伍（{count}/{limit}）",
    inviteHint: "同意后就能一起打怪分经验（30 秒内有效）",
    accept: "同 意",
    decline: "拒 绝",
    invite: "邀 请",
    invited: "已邀请",
    /**
     * 已经邀请过、等对方回应（候选行右侧的**灰字**状态）
     *
     * 不能复用 `invite`（「邀 请」）：那和旁边真正可点的按钮长得一模一样，
     * 玩家分不清「这个还能点」和「已经发出去在等」（#498 顺带发现的）。
     */
    invitePending: "等待回应",
    kick: "踢 出",
    transfer: "转 让",
    leave: "退出队伍",
    disband: "解散队伍",
    /** 飘字 / 提示 */
    invitedTip: "已邀请「{name}」",
    inviteReceivedTip: "「{name}」邀请你组队（G 键查看）",
    expGainTip: "队友击杀 +{exp} 经验",
    joinTip: "「{name}」加入了队伍",
    /**
     * 进队 / 离队的通用提示（离队那一句服务端不下发原因：被踢、解散、自己退都是一份空快照）
     *
     * 没有单独的「你已退出队伍」了（#498）：退队的提示统一由 `endedTip` 承担 ——
     * 它由**服务端快照变化**驱动，天然不会在「退队被拒」时说假话；两处都写就是一句重复飘字。
     */
    joinedTip: "已加入「{name}」的队伍",
    endedTip: "你已不在队伍中",
    kickedTip: "你被移出了队伍",
    disbandedTip: "队伍已解散",
    fullTip: "队伍已满（{limit} 人）",
    transferTip: "队长已转给「{name}」",
    disconnectedTip: "实时通道未连接，暂时不能组队",
  },
};

//#endregion

//#region 排行榜弹窗（#400）

/**
 * 排行榜弹窗布局（与聊天 / 任务 / 队伍同框：600×560）
 *
 * 三个页签就是三个榜（等级 / 战力 / 击杀）—— 它们是同一份数据的三种排法，
 * 分成三个弹窗会让玩家在打开之前就得先想清楚「我要看哪个」。
 *
 * 底部固定一条「我的名次」：榜只留前 N 条（默认 100），排在后面的人翻不到自己，
 * 那一行是**唯一**能让人确认「我到底第几」的地方。
 */
