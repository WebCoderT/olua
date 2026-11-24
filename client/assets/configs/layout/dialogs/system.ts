/**
 * 系统与通知弹窗（设置 / 死亡 / 确认 / 公告 / 任务 / 排行榜）布局
 *
 * 拆分自原 configs/layout/dialogs.ts（#1115 批次 2），数值与注释原样保留。
 */
import { Color, Size, Vec2 } from "cc";
import { dialogFootLayout } from "./frame";
import { T } from "../tokens";

export const settingsDialogLayout = {
  name: "settings_dialog",
  /** 标题与眉题（眉题全中文分区词，与标题不用词重复——标题/眉题去重口径，2026-11-18） */
  title: "设置",
  eyebrow: "系统",
  /** 稿 `.settings`：460×220 */
  size: new Size(460, 220),
  /** 两行动作的公共几何：行底板 400×52、中心 x=0、第一行中心 y=30、行间距（中心距）68 */
  rows: {
    /** 选择角色行（按钮 = 金键：常规主动作；点击直接执行，不二次确认——2026-11-18 用户拍板） */
    select: {
      name: "settings_select_row",
      y: 30,
      button: { name: "settings_select_button", tone: "gold" as const },
    },
    /** 退出登录行（按钮 = 危险档：暗朱底；点击弹确认框再执行） */
    logout: {
      name: "settings_logout_row",
      y: -38,
      button: { name: "settings_logout_button", tone: "danger" as const },
    },
    /** 行底板尺寸与两侧内距（名称/说明左对齐起点、按钮右对齐终点） */
    width: 400,
    height: 52,
    /** 名称列 / 说明列：左对齐文本框（中心 x、宽）与上下偏移 */
    name: { x: -74, width: 236, height: 20, offsetY: 12, fontSize: T.fontSize.f14, color: T.text[1] },
    desc: { x: -68, width: 248, height: 16, offsetY: -11, fontSize: T.fontSize.f11, color: T.text[3] },
    /** 行内按钮（右侧）：100×32，中心距行右缘 66（行宽 400 → 按钮 x = 134） */
    buttonSize: new Size(100, 32),
    buttonFontSize: T.fontSize.f12,
    buttonX: 134,
  },
};

//#endregion

//#region 死亡弹窗（全屏遮罩）

/**
 * 死亡遮罩弹窗布局（自身即全屏节点，坐标为全屏节点中心）
 *
 * 稿 20-overlay 的 `.death`：560 宽的主面板（暗朱径向渐变压在纯色上，Graphics 用
 * 「整块深底 + 上半一条暗朱亮带」近似）+ 标题 36 + 一句说明 + 两枚 196×46 的按钮。
 */

export const deathDialogLayout = {
  name: "death_dialog",
  /** 眉题（「副标题必须有」，全弹窗统一 `.panel-eyebrow` 口径） */
  eyebrow: "复活",
  /** 遮罩颜色（黑色半透明，盖住整个屏幕并挡住世界点击） */
  maskColor: T.surface.scrim,
  /** 主面板（稿 `.death`：560 宽，内容 44/40 内距；这里给固定外框） */
  panel: {
    name: "death_panel",
    position: new Vec2(0, 0),
    size: new Size(560, 260),
    fill: T.surface[0],
    fillTop: T.ember[1],
    fillTopRatio: 0.5,
    border: T.line[2],
    radius: T.radius.r3,
  },
  /** 标题「您已死亡」（稿 38px → 收敛到令牌 f40，不为单屏造新档） */
  title: { text: "您已死亡", position: new Vec2(0, 64), size: new Size(520, 48), fontSize: T.fontSize.f40, color: T.ember[4] },
  /** 标题下的一句说明（复活代价与去处） */
  subtitle: {
    text: "可原地复活（消耗一枚还魂丹），或回到城内安全复活",
    position: new Vec2(0, 20),
    size: new Size(500, 20),
    fontSize: T.fontSize.f12,
    color: T.text[3],
  },
  /** 两个复活按钮（稿 `.acts`：196×46、间距 16、居中 → 中心 ±106） */
  buttonSize: new Size(196, 46),
  buttonFontSize: T.fontSize.f16,
  reviveInPlaceButton: { name: "revive_in_place_button", text: "原地复活", position: new Vec2(-106, -62) },
  reviveSafeButton: { name: "revive_safe_button", text: "安全复活", position: new Vec2(106, -62) },
};

//#endregion

//#region 通用确认框（模态：盖住整个屏幕的「确定 / 取消」二选一）

/**
 * 通用确认框布局（组件见 ui/components/dialogs/ConfirmDialog，自身即全屏模态节点）
 *
 * 与死亡遮罩（deathDialogLayout）同一套做法：全屏黑遮罩 + 居中面板；
 * 文案不进这里 —— 玩家文案的唯一来源是 configs/texts，由使用方取好后传进组件
 * （首个使用方是背包的「拖出弹窗销毁」，见 ui/components/dialogs/BagDialog）
 */

export const confirmDialogLayout = {
  name: "confirm_dialog",
  /** 眉题（「副标题必须有」，全弹窗统一 `.panel-eyebrow` 口径） */
  eyebrow: "提示",
  /** 遮罩颜色（黑色半透明，盖住整个屏幕并挡住下层点击；与死亡遮罩同色） */
  maskColor: T.surface.scrim,
  /** 居中面板：尺寸（矢量底板 + 四角铆钉，见 createDialogPanel） */
  panel: { name: "confirm_panel", size: new Size(420, 210) },
  /** 标题（稿 20-overlay .panel-title：亮字居中 + 44×1 金下划线；字号随 2026-11-18 拍板统一 12 号） */
  title: { name: "confirm_title", position: new Vec2(0, 72), size: new Size(360, 26), fontSize: T.fontSize.f12, color: T.text[1] },
  titleUnderline: { position: new Vec2(0, 47), size: new Size(44, 1) },
  /** 右上角关闭按钮（稿 .panel-close：30×30，右缘 12 / 顶缘 10；点它 = 取消） */
  closeButton: { name: "confirm_close_button", position: new Vec2(183, 80), size: new Size(30, 30), fontSize: T.fontSize.f18 },
  /** 正文：宽度固定、高度按内容自适应（稿 .body p：f14 居中、行高 26 ≈ 1.9） */
  message: { name: "confirm_message", position: new Vec2(0, 6), width: 336, fontSize: T.fontSize.f14, lineHeight: 26, color: T.text[2] },
  /** 双按钮（稿 .acts：各宽 110 高 40、间隙 14、整体距底缘约 21；确定 = 危险朱红，取消 = ghost） */
  confirmButton: { name: "confirm_ok_button", position: new Vec2(-62, -64), size: new Size(110, 40), fontSize: T.fontSize.f14 },
  cancelButton: { name: "confirm_cancel_button", position: new Vec2(62, -64), size: new Size(110, 40), fontSize: T.fontSize.f14 },
};

//#endregion

//#region 物品详情弹窗（鼠标悬停在物品图标上时显示）

/** 物品详情弹窗（跟随鼠标，坐标为屏幕中心系） */

export const announcementBoardDialogLayout = {
  name: "announcement_board_dialog",
  title: "公告",
  eyebrow: "资讯",
  size: new Size(720, 500),
  /**
   * 左右两栏（稿 10-announcement 的 `.board-body`）：左 280 列表 + 14 间距 + 右 390 详情，
   * 两栏同高 388（面板 500 − 头部 45 − 页脚下留白），顶边 205。
   * 左列中心 -202、右列中心 147。
   */
  /** 左：公告条目滚动列表（行高固定，正文在右栏） */
  list: {
    name: "announcement_list",
    position: new Vec2(-202, 11),
    size: new Size(280, 388),
    /** 条目：上下 10 内距 + 标题两行 36 + 4 + 来源行 16 + 10 = 76 */
    itemSize: new Size(268, 76),
    /** 条目间距（条目内部的两行文字几何见下面两项） */
    itemGap: T.spacing.sp3,
    itemTitleFontSize: T.fontSize.f13,
    itemMetaFontSize: T.fontSize.f10,
    /** 条目的标题（两行，可换行）与来源行（左对齐） */
    itemTitle: { position: new Vec2(4, 14), size: new Size(244, 36), lineHeight: 18 },
    itemMeta: { position: new Vec2(4, -22), size: new Size(244, 16) },
    /** 未读条目用亮色标题 + 左上圆点，已读压暗（一眼看出哪几条是新的） */
    unreadTitleColor: T.gold[4],
    readTitleColor: T.text[4],
    itemMetaColor: T.text[4],
    /** 条目底（稿 `.bi`：深底 + 一圈弱线 + 圆角；选中时再叠一层金底） */
    itemFill: T.surface.sunken,
    itemBorder: T.line[1],
    itemRadius: T.radius.r2,
    /** 选中条目的底色（Graphics 自绘，不依赖底图） */
    selectedFill: T.gold[1],
    /** 未读圆点（稿 `.dot` 在条目右上角；相对条目中心） */
    itemDot: { position: new Vec2(118, 22), size: new Size(8, 8) },
  },
  /** 右：选中公告的详情（外框 + 标题 / 级别 · 时间窗 / 分隔线 / 正文滚动区） */
  detail: {
    /** 右栏外框（稿 `.br`：一圈弱线 + 深底 + 圆角） */
    frame: {
      name: "announcement_detail_frame",
      position: new Vec2(147, 11),
      size: new Size(390, 388),
      fill: T.surface.sunken,
      border: T.line[1],
      radius: T.radius.r2,
    },
    title: { name: "announcement_detail_title", position: new Vec2(147, 179), size: new Size(354, 24), fontSize: T.fontSize.f16, color: T.gold[5] },
    /** 级别 · 时间窗（没有选中公告时这里显示空态 / 失败提示） */
    meta: { name: "announcement_detail_meta", position: new Vec2(147, 154), size: new Size(354, 16), fontSize: T.fontSize.f11, color: T.text[4] },
    /** 头部与正文之间的分隔线（稿 `.br-head` 的 border-bottom） */
    divider: { y: 136, color: T.line[1] },
    scroll: { name: "announcement_body_scroll", position: new Vec2(147, -24), size: new Size(354, 290) },
    /** 正文：宽度固定、高度按内容自适应（可换行） */
    body: { name: "announcement_body", fontSize: T.fontSize.f13, lineHeight: 22, width: 346, color: T.text[2] },
  },
};

/**
 * 登录页公告提醒（全屏模态）
 *
 * 与公告板的分工：这里只摊开「生效中的重要公告」（停机维护这类玩家进游戏前最需要看到的），
 * 内容少且是必读，所以直接一篇篇纵向摊开，不做左右分栏。
 * 尺寸与遮挡口径与确认框一致（见 confirmDialogLayout）：全屏遮罩取可见区，任意窗口比例都盖满。
 */

export const announcementNoticeDialogLayout = {
  name: "announcement_notice_dialog",
  /** 眉题：与公告列表弹窗（ANNOUNCEMENT）同一分区 */
  eyebrow: "资讯",
  title: "公告",
  maskColor: T.surface.scrim,
  panel: { name: "announcement_notice_panel", size: new Size(640, 460) },
  /** 标题文本的位置与样式（配色与通用弹窗标题一致） */
  titleLabel: { name: "announcement_notice_title", position: new Vec2(0, 200), size: new Size(560, 26), fontSize: T.fontSize.f16, color: T.ember[4] },
  /** 公告列表（纵向滚动，每一条自己撑高） */
  list: { name: "announcement_notice_list", position: new Vec2(0, 20), size: new Size(576, 350) },
  /** 单条公告：标题 / 级别 · 时间窗 / 正文，纵向排列且高度按内容自适应 */
  item: {
    width: 568,
    /** 条目之间与条目内部的纵向间距 */
    itemGap: 22,
    rowGap: 6,
    title: { fontSize: T.fontSize.f14, lineHeight: 21, color: T.gold[4] },
    meta: { fontSize: T.fontSize.f11, lineHeight: 16, color: T.text[4] },
    body: { fontSize: T.fontSize.f13, lineHeight: 20, color: T.text[1] },
  },
  /** 「我知道了」按钮（中号按钮，面板底部居中） */
  confirmButton: { name: "announcement_notice_confirm_button", text: "我知道了", position: new Vec2(0, -200) },
};

/**
 * 选服弹窗（全屏模态，#962）
 *
 * 从**选角页顶部**的「区服：X（点击切换）」手动打开 —— 登录时不自动弹：
 * 绝大多数登录都是回自己那个区，每次都逼人点一次确认只会变成肌肉记忆。
 *
 * 列出**全部未合并的区**（含维护中 / 已关闭，置灰点不动）：玩家要看到「这区还在、
 * 只是进不去」，而不是让它从列表里凭空消失。进过哪些区由服务端给
 * （`GET /zones/mine` 的 `roleCount` / `current`），客户端不自己记一份。
 *
 * 行内三列：区名（左）/ 角色数 · 状态（中）/ 角标「上次在」「推荐」（右）。
 */

export const questDialogLayout = {
  name: "quest_dialog",
  title: "任 务",
  eyebrow: "冒险",
  size: new Size(600, 540),
  /** 页签（两枚，与聊天弹窗同款式；角标直接在页签文案后追加「·N」，不另设小字样式） */
  tabs: {
    /** 头部下沿 225 − 半行高 16 = 209（下边距 12 之后是列表顶 181） */
    y: 209,
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
  /** 任务列表（框体主体；稿 `.qlist` 396 高，中心 -17） */
  list: { name: "quest_list", position: new Vec2(0, -17), size: new Size(556, 396) },
  /** 任务行（稿 `.qrow2`）：名称+进度（左）+ 奖励列（右二）+ 动作（右一） */
  row: {
    size: new Size(552, 64),
    fill: T.surface[1],
    border: T.surface[3],
    radius: T.radius.r2,
    /** 可交付行的描边与底（稿 `.qrow2.ready`：jade 45% 描边 + 10% 淡染底，与详情卡同值） */
    readyBorder: new Color(111, 191, 142, 115),
    readyFill: new Color(111, 191, 142, 26),
    nameFontSize: T.fontSize.f14,
    textFontSize: T.fontSize.f11,
    nameColor: T.gold[5],
    metaColor: T.text[3],
    readyColor: T.jade,
    /**
     * 两行文字的 x 是**文本框中心**，且 `UiHelper.createLabel` 是 CLAMP + 左对齐 → 文字从
     * 文本框左缘（nameX − 宽/2）起排。所以 x 必须让「左缘 = 行左缘 + 14」：
     * 行宽 552（半宽 276）→ 左缘 −260 → 宽 300 时 x = −110。
     * 曾经写 −180（左缘 −360，跑出行外 84px），被 ScrollView 遮罩裁掉，任务名整行看不见（#477）。
     */
    nameX: -110,
    /** 名称行中心 y（#1115 批次 3 收编组件内联的 12） */
    nameY: 12,
    /** 宽从 360 收到 300：右半给奖励列（稿 `.mid{flex:1}`，中间列不压奖励块） */
    nameSize: new Size(300, 20),
    metaX: -110,
    metaSize: new Size(300, 18),
    /**
     * 奖励列（稿 `.qrow2 .reward`：右对齐数字块，f10 text-4 行高 1.7 ≈ 17）。
     * 盒宽 130，右缘 186 = 行右缘 262 − 按钮 64 − 间距 12；中心 x = 186 − 65 = 121。
     */
    rewardX: 121,
    rewardSize: new Size(130, 34),
    rewardFontSize: T.fontSize.f10,
    rewardColor: T.text[4],
    /** 行内动作键（稿 `.btn--xs` 64×24 行内档，与详情弹窗「前往」同款） */
    actionSize: new Size(64, 24),
    actionFontSize: T.fontSize.f11,
    /** 动作区中心 x：行右缘 276 − 内距 14 = 内容右缘 262，再往左半键宽 32 → 230 */
    buttonX: 230,
  },
  /** 行内状态角标（稿 `.badge--muted`：与任务详情弹窗 badge 同配色，只用于「进行中」行） */
  badge: {
    height: 18,
    fontSize: T.fontSize.f10,
    activeFill: T.surface[3],
    activeText: T.text[3],
    text: "进行中",
  },
  /** 文案 */
  texts: {
    tabs: ["进行中", "可 接"],
    activeEmpty: "（没有进行中的任务：去「可接」看一眼）",
    availableEmpty: "（暂时没有能接的任务：升级或先完成前置）",
    accept: "接 取",
    submit: "交 付",
    ready: "可交付",
    /** 进度行：{done} / {total} */
    progress: "进度 {done}/{total}",
    /** 目标行：{type} · {target} ×{count} */
    objective: "{type} · {target} ×{count}",
    /** 交接奖励行（交付成功的飘字） */
    rewards: "奖励：绑定元宝 {bindGold} · 经验 {exp}",
    /** 行内奖励列（稿 `.qrow2 .reward`，右对齐两行）：{value} = 数量 */
    rewardExp: "{value} 经验",
    rewardBindGold: "{value} 绑元",
    /** 接取 / 交付失败的兜底提示（服务端的错误文案更具体，走请求层统一提示） */
    acceptFailed: "接取失败",
    submitFailed: "交付失败",
    /** 接取成功的飘字（{name} = 任务名） */
    acceptedTip: "已接取「{name}」",
  },
  /** 页脚（稿 11-quest 的 .panel-foot）：左入口说明 / 右结算说明 */
  foot: dialogFootLayout(new Size(600, 540), 250),
  footTexts: { left: "左侧任务追踪整块可点打开本窗", right: "交付奖励由服务端结算" },
};

//#endregion

//#region 任务详情弹窗（#1191，稿 11-quest 的 #state=detail 面板）

/**
 * 任务详情弹窗布局（稿 `.qdetail`：480×560，入口是 HUD 任务追踪块标题行「详」）
 *
 * 与任务面板（600×540 两页签）分工：面板管「接 / 交付」，详情管「看得懂」——
 * 描述、进度条、奖励明细、交付 NPC 都在详情卡里展开，一卡一任务。
 *
 * 卡片高度**不在这里定死**：描述行数随文案变，组件按 `card` 的排版参数算
 * （估算行数 = 文案长 / 每行字数，Chinese 全角近似），列表总高随卡片累计。
 */
export const questDetailDialogLayout = {
  name: "quest_detail_dialog",
  title: "任 务 详 情",
  eyebrow: "任务",
  /** 稿 `.qdetail{width:480px;height:560px}` */
  size: new Size(480, 560),
  /** 任务卡列表（稿 `.qlist` 420 高；头部下沿 ≈ 232、页脚分隔线在 -256，居中取 -10） */
  list: { name: "quest_detail_list", position: new Vec2(0, -10), size: new Size(444, 420) },
  /** 详情卡（稿 `.qcard`）：名称+角标+放弃 / 描述 / 目标+进度条 / 奖励 chip / 交付 NPC+前往 */
  card: {
    /** 卡宽比列表窄 4（滚动条压边不裁内容） */
    width: 440,
    paddingX: 14,
    padTop: 12,
    padBottom: 10,
    fill: T.surface[1],
    border: T.surface[3],
    radius: T.radius.r2,
    /** 可交付卡的描边与底（稿 `.qcard.ready`：jade 45% 描边 + jade 10% 渐变底，渐变近似成整块淡染） */
    readyBorder: new Color(111, 191, 142, 115),
    readyFill: new Color(111, 191, 142, 26),
    /** 名称行（稿 `.qc-head b`：display 15px 金-5；字号按 tokens 收敛口径取 f14） */
    nameColor: T.gold[5],
    nameFontSize: T.fontSize.f14,
    nameSize: new Size(250, 20),
    /** 描述（稿 `.qc-desc` 11.5px text-2，行高 1.7 ≈ 19） */
    descColor: T.text[2],
    descFontSize: T.fontSize.f11,
    descLineHeight: 19,
    descGapTop: 6,
    descGapBottom: 8,
    /** 目标行（稿 `.qc-obj`：20 高，中间进度条） */
    objColor: T.text[3],
    objValueColor: T.text[2],
    objSize: new Size(120, 20),
    /** 进度条（稿 `.qc-obj .bar`：高 6 圆角 3，黑底金填充；可交付换 jade） */
    barHeight: 6,
    barBg: new Color(0, 0, 0, 115),
    barBorder: T.line[1],
    barFill: T.gold[3],
    barFillReady: T.jade,
    /** 奖励 chip 行（稿 `.qc-rw`：20 高圆角小签，数字用金-4） */
    chipHeight: 20,
    chipFontSize: T.fontSize.f10,
    chipColor: T.gold[4],
    chipFill: new Color(0, 0, 0, 77),
    chipBorder: T.line[1],
    chipGap: 6,
    chipMarginTop: 8,
    /** 交付 NPC 行（稿 `.qc-go`：上 1px 虚线分隔，8+8 上下距） */
    goColor: T.text[3],
    goValueColor: T.text[2],
    goFontSize: T.fontSize.f11,
    goDivider: T.line[1],
    goGapTop: 8,
    goHeight: 24,
    /** 前往按钮（可交付 = 金键，进行中 = ghost；64×24 行内档） */
    goButtonSize: new Size(64, 24),
    goButtonFontSize: T.fontSize.f11,
  },
  /** 状态角标（稿 `.badge--jade/.badge--muted`：18 高圆角小签） */
  badge: {
    height: 18,
    fontSize: T.fontSize.f10,
    readyFill: new Color(111, 191, 142, 38),
    readyText: T.jade,
    activeFill: T.surface[3],
    activeText: T.text[3],
    texts: { ready: "可交付", active: "进行中" },
  },
  /** 放弃按钮（稿 `.abandon`：朱红字弱底，确认态换金框） */
  abandon: {
    size: new Size(64, 20),
    fontSize: T.fontSize.f10,
    text: "放 弃",
    confirmText: "确认放弃",
    /** 待确认 3 秒未点复位（与回收 / 丢弃 / 删角色同一套口径） */
    confirmTimeout: 3000,
  },
  /** 文案（模板用 {x} 占位，组件 split/join 替换——与 QuestDialog 同一口径） */
  texts: {
    /** 目标行：{type} {target} */
    objective: "{type} {target}",
    /** 目标行的「目标」前缀 */
    objLabel: "目标",
    /** 奖励 chip：{value} = 数量 */
    chipExp: "{value} 经验",
    chipBindGold: "{value} 绑元",
    /** 交付 NPC 行：{npc} · {map} */
    goNpc: "交付 {npc} · {map}",
    goButton: "前 往",
    /** 交付 NPC 不在本地图时的提示（不做跨图传送：先去大地图换图） */
    goOtherMapTip: "「{npc}」在「{map}」，请先前往那张地图",
    /** 地图未知（快照里查不到该 NPC 的点位） */
    goUnknownTip: "找不到「{npc}」的位置",
    goUnknownMap: "未知区域",
    /** 当前状态无法寻路（主角未就绪 / 死亡） */
    goRefuseTip: "当前状态无法寻路",
    empty: "（没有进行中的任务：打开任务面板接一个）",
    /** 放弃成功的飘字（{name} = 任务名） */
    abandonedTip: "已放弃「{name}」",
  },
  /** 页脚（稿 `.qdetail` 的 .panel-foot 三段并两段） */
  foot: dialogFootLayout(new Size(480, 560), 210),
  footTexts: { left: "「放弃」两步确认 · 3 秒未确认复位", right: "交付奖励由服务端结算" },
};

//#endregion

//#region 队伍弹窗（#399）

/**
 * 队伍弹窗布局（与聊天 / 任务弹窗同框：600×560）
 *
 * 两个页签：**成员**（含待处理邀请）与**邀请**（附近的人）。
 * 「成员」页是默认页 —— 打开队伍面板的人十次有九次是想看「队里现在有谁、谁不在线」，
 * 而不是来拉人；邀请是主动动作，翻一页的成本可以接受。
 *
 * 行内按钮的数量随身份变（队长多「转让」「踢人」两枚），几何在这里定死，
 * 组件只决定画哪几枚 —— 这样队长与队员的行高一致，列表不会跳。
 */

export const leaderboardDialogLayout = {
  name: "leaderboard_dialog",
  title: "排 行 榜",
  eyebrow: "荣誉",
  size: new Size(600, 540),
  /** 页签（三枚 96 宽 + 6 间距，整行居中；头部下沿 225 − 半行高 16 = 209） */
  tabs: {
    y: 209,
    size: new Size(96, 32),
    columns: [-102, 0, 102],
    radius: T.radius.r2,
    activeFill: T.gold[4],
    activeText: T.surface[3],
    idleFill: T.surface[2],
    idleText: T.text[1],
    idleBorder: T.surface[3],
    fontSize: T.fontSize.f14,
  },
  /** 顶部小结（共几人上榜 + 这份快照的时刻；稿 `.rsum` 在页签下居中） */
  summary: {
    position: new Vec2(0, 175),
    size: new Size(556, 20),
    fontSize: T.fontSize.f11,
    color: T.text[4],
    /** 「刚刚更新」的界线（毫秒）：快照比这个还新就不写时分 */
    freshMs: 60_000,
  },
  /** 榜单列表（稿 `.rlist` 330 高，中心 -10） */
  list: { name: "leaderboard_list", position: new Vec2(0, -10), size: new Size(556, 330) },
  /** 一条名次：名次（左）+ 名字 + 关键数值（右）；稿 `.rrow` 46 高 */
  row: {
    size: new Size(552, 46),
    fill: T.surface[1],
    border: T.surface[3],
    radius: T.radius.r2,
    rankX: -252,
    rankSize: new Size(44, 20),
    rankFontSize: 14,
    rankColor: T.text[3],
    /** 前三名的名次数字用金色（一眼看出榜头） */
    topRankColor: T.gold[4],
    /** 金色名次的界线：名次 ≤ 这个数就用金色（第 4 名开始是普通灰） */
    topRankThreshold: 3,
    /**
     * 名次列（−274~−230）之后接名字列：名字 bbox 从 −222 起（留 8px 间隙），宽 220 → x = −112；
     * 再往右是数值列（14~254）。原来写 −186（bbox 左缘 −296，跑出行外 20px，被遮罩裁掉，见 #477）
     */
    nameX: -112,
    nameSize: new Size(220, 20),
    nameFontSize: 13,
    nameColor: T.text[1],
    metaX: 134,
    metaSize: new Size(240, 18),
    metaFontSize: 11,
    metaColor: T.text[3],
    /** 我自己那一行的底色与边框（滚到哪都认得出来） */
    selfFill: T.surface[3],
    selfBorder: T.gold[4],
  },
  /** 底部固定的「我的名次」条（稿 `.rself` 42 高，列表底 -175 − 10 − 21 = -206） */
  selfRow: {
    position: new Vec2(0, -206),
    size: new Size(552, 42),
    fill: T.surface[2],
    border: T.gold[2],
    radius: T.radius.r2,
    textFontSize: T.fontSize.f11,
    textColor: T.gold[4],
  },
  /** 页脚（稿 15-rank 的 .panel-foot） */
  foot: dialogFootLayout(new Size(600, 540), 250),
  footTexts: { left: "每小时刷新一次 · 只列在线过的角色", right: "点击页签切换维度" },
  /** 文案 */
  texts: {
    tabs: ["等 级", "战 力", "击 杀"],
    /** 顶部小结：共 {total} 人上榜 · {updated} 更新 */
    summary: "共 {total} 人上榜 · {updated} 更新",
    /** 我的名次：第 {rank} 名 */
    selfIn: "我的名次：第 {rank} 名",
    /** 没有名次（没有在线角色 / 还没上榜） */
    selfOut: "你还没有名次 —— 进游戏后自动上榜",
    /** 三个榜各自的数值行（同一行里展示另外两个维度，免得玩家来回切页） */
    levelMeta: "Lv {level} · 战力 {combat} · 击杀 {kills}",
    combatMeta: "战力 {combat} · Lv {level} · 击杀 {kills}",
    killsMeta: "{kills} 杀 · Lv {level} · 战力 {combat}",
    emptyList: "（榜上还没有人 —— 先去打两只怪）",
    loading: "正在取榜…",
    failed: "榜单没取到，稍后再试",
    /** 时刻格式：{time} 更新（今天）/ 不是今天就不显示时分，只写「刚刚更新」 */
    updatedNow: "刚刚",
    updatedAt: "{time}",
  },
};

//#endregion

//#region 选线弹窗（#1016）

/**
 * 选线弹窗（小地图的「N 线」标签打开，#1016）
 *
 * 列出这张图的**全部线**（0..maxChannels-1，玩家视角 1..N 线；服务端口径公共线 = 0，
 * 显示时 +1），当前线高亮并标「当前」。点一行发一次 `changeChannel`：成功关窗飘字，
 * 失败按 `field` 提示并留在弹窗里（换线是可逆操作，服务端总是回帧）。
 *
 * 数据是**纯本地**的：线数读配置快照的 `maps`（#812 已下发），当前线读 `world` 帧
 * 带回的 `channel` —— 不需要为开一个弹窗拉接口。行数就是 maxChannels，通常 ≤ 3，
 * 滚动区只是防「运营把某张图开到十几条线」的保底。
 */
