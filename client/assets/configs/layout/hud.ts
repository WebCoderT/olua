import { Color, Size, Vec2 } from "cc";
import { roleBody } from "../role";
import { T } from "./tokens";

/**
 * 常驻 HUD 与游戏内固定表现元素的布局
 *
 * 位置/尺寸的坐标系见各自注释：组件自身坐标以屏幕中心为原点，子件坐标以所在容器中心为原点
 * 常驻 HUD 四区域（左上角色信息栏 / 右上小地图 / 底部栏 / 左下操作摇杆）的自身位置是**固定值**，
 * 不做任何按屏幕尺寸的换算 —— 手调位置直接改这里的 position
 * （例外：角色信息栏 #1359 起 prefab 为准，本人信息栏的根位置在 prefab 根节点上设计）
 *
 * 图片来源见 configs/layout/images（uiImages）；公共尺寸见 configs/layout/sizes（uiSize）
 */

//#region 角色信息栏（左上角常驻）

/**
 * 角色信息栏 prefab 的运行时契约（#1353 HUD prefab 化样板）
 *
 * 静态外观（位置 / 尺寸 / 颜色 / 字号）已固化在 `ui/prefabs/hud/RoleInfoBar.prefab`，
 * 改版式请直接改 prefab；这里只放运行时代码必须知道的**节点名**（#1359：代码对信息栏
 * 只写文字内容，不碰任何样式，故无颜色/字号配置）。
 */
export const roleInfoBarPrefab = {
  /**
   * prefab 里的固定节点路径（相对 prefab 根，逐段匹配**不递归**，嵌套节点必须带父级——#1357）：
   * 组件靠这些路径取引用，prefab 改层级/重命名节点要同步这里
   */
  nodes: {
    name: "Name",
    level: "Level",
    currencyValue: "CurrencyBar/CurrencyValue",
    combatValue: "Combat/CombatValue",
    avatar: "AvatarFrame/Avatar",
    statusText: "RealtimeStatus/StatusText",
    statusIcons: "StatusIcons",
  },
};

//#region HUD prefab 化第二批（#1361：小地图 / 底部栏 / 聊天窗 / 消息记录）

/**
 * 小地图 prefab 的运行时契约（#1361，口径同 #1359：prefab 为准，代码只写文字内容）
 *
 * 静态骨架（铆钉面板 / 标题条 / 坐标文本）与**摆位锚点**（rail 网格、地图视口、下拉箭头）
 * 固化在 `ui/prefabs/hud/SmallMap.prefab`；动态零件（底图、点位、路线、红点）由代码
 * 挂在锚点上绘制 —— 挪锚点即挪整块动态区。
 */
export const smallMapPrefab = {
  /** prefab 里的固定节点路径（相对根逐段匹配不递归，#1357 口径；改名要同步这里） */
  nodes: {
    mapName: "MapName",
    channelLabel: "ChannelLabel",
    chevron: "ChevronAnchor",
    entryRail: "EntryRail",
    mapView: "MapViewAnchor",
    positionText: "PositionText",
  },
};

/**
 * 底部栏 prefab 的运行时契约（#1361）：七个子组件挂点。
 * 底衬（HudBackdrop）与两条竖分隔线（VerticalRule）的视觉在 prefab（#1363），
 * 子组件（血球/经验条/快捷键栏/挂机钮…）自身不再定位，摆位全部由锚点承载。
 */
export const bottomBarPrefab = {
  nodes: {
    navBar: "NavBar",
    settingsButton: "SettingsButton",
    expBar: "ExpBar",
    hpOrb: "HpOrb",
    mpOrb: "MpOrb",
    shortcutBar: "ShortcutBar",
    autoFight: "AutoFight",
  },
};

/** 聊天窗 prefab 的运行时契约（#1361）：窗体底板与分隔线在 prefab，页签挂 TabsAnchor */
export const chatBoxPrefab = {
  nodes: {
    tabsAnchor: "TabsAnchor",
  },
};

/** 消息记录 prefab 的运行时契约（#1361）：面板/标题/底部注释在 prefab，动态行挂 RowsAnchor */
export const messageLogPrefab = {
  nodes: {
    plate: "Plate",
    headTitle: "HeadTitle",
    count: "CountLabel",
    den: "DenLabel",
    capBar: "CapBarAnchor",
    collapse: "CollapseAnchor",
    rows: "RowsAnchor",
    footLeft: "FootLeft",
    footRight: "FootRight",
  },
};

//#endregion

/** 角色信息栏布局（坐标以信息栏中心为原点，逐值对照 04-hud 的 `.info` 段） */
export const roleInfoBarLayout = {
  /** 信息栏自身尺寸（HUD 规范 344×84：左边缘距屏幕 20、顶边 18） */
  size: new Size(344, 84),
  /** 本人信息栏位置在 prefab 根节点上设计（#1359 prefab 为准）；其他玩家（屏幕中心） */
  otherPosition: new Vec2(0, 0),
  /** 背景框尺寸（与信息栏同尺寸；#1059 起底板改矢量绘制） */
  backgroundSize: new Size(344, 84),
  /** 名称（左对齐，17px 衬线体；bbox 从 who 列左缘 -92 起，宽 130） */
  name: { position: new Vec2(-27, 10), size: new Size(130, 20), fontSize: T.fontSize.f16 },
  /** 等级（与名称同一基线，11px 金-4：显示成「42 级」） */
  level: { position: new Vec2(56, 8), size: new Size(56, 16), fontSize: T.fontSize.f11, color: T.gold[4] },
  /** 头像（按职业/性别取图；54×58 + 1px 金-2 边框 + 深褐底） */
  portrait: { position: new Vec2(-131, 0), size: new Size(54, 58), border: T.gold[2], fill: new Size(54, 58) },
  /**
   * 三种货币（同一个横向布局容器，子件均分容器宽度且内部左对齐）
   * 稿 `.info .cur`：金色小方块 9×9 + 「绑定元宝」11px text-3 + 数值 11px 金-4
   */
  currencyBar: {
    position: new Vec2(-26, -18),
    size: new Size(132, 14),
    spacing: 0,
    iconSize: new Size(10, 10),
    label: { text: "绑定元宝", fontSize: T.fontSize.f11, color: T.text[3], width: 60, gap: 4 },
    value: { fontSize: T.fontSize.f11, color: T.gold[4], width: 90, gap: 6 },
  },
  /**
   * 战斗力（新稿口径：`战斗力` 小字标签在上、红色数值在下，**右对齐**一小块贴信息栏右缘；
   * 左侧一条 1px line-2 竖线与货币区分开）。数值变化 ±飘字挂在同一节点（见 RoleInfoBar.updateCombat）
   */
  combat: {
    position: new Vec2(116, 0),
    /** 分隔线（稿 `.info .pw{border-left:1px solid line-2}`）：相对信息栏中心的 x + 上下高度 */
    divider: { x: 83, height: 40, color: T.line[2] },
    label: { text: "战斗力", position: new Vec2(0, 12), size: new Size(84, 12), fontSize: T.fontSize.f10, color: T.text[3], spacingX: 2 },
    value: { position: new Vec2(0, -8), size: new Size(84, 22), fontSize: T.fontSize.f20, color: T.ember[3] },
  },
  /**
   * 实时通道状态指示（#1324）：战斗力数值正下方 —— 小圆点 + 同色文字（右对齐，与战斗力数值共用右缘）
   * 只挂在**本人**信息栏（其他玩家的信息栏不带通道状态）。四态颜色全取 token，
   * 文案见 configs/texts 的 realtime_status_*（四条都是三个字，右对齐下不跳位）
   */
  realtimeStatus: {
    position: new Vec2(116, -32),
    size: new Size(84, 12),
    /** 圆点直径与圆心 x（文字右对齐后左缘约 +12，圆点贴在它左边留 4px） */
    dotSize: 6,
    dotX: 5,
    fontSize: T.fontSize.f10,
    colors: {
      idle: T.text[3],
      connecting: T.gold[4],
      connected: T.jade,
      disconnected: T.ember[3],
    },
  },
  /** 状态图标条（首个图标中心对齐头像中心、向右排开，横向布局；稿 `.buff` 26×26 带金线框） */
  statusBar: { size: new Size(240, 26), spacing: 4, iconSize: new Size(26, 26) },
};

//#endregion

//#region 底部栏（底部常驻容器）

/**
 * 底部栏布局（自身坐标以屏幕中心为原点，子件坐标以底部栏中心为原点）
 *
 * 按 design/olua-ui/screens/04-hud.html 新稿重排（2026-11-18 逐值对照）：
 * 不再画整条底板（新稿元素直接浮在场景上），四组共用一条底线 ——
 * 血球 ｜ 战斗列（挂机条 / 技能格 / 经验条，同一 256 宽竖列）｜ 竖分隔线 ｜ 六个功能键 ｜ 竖分隔线 ｜ 设置 ｜ 法力球
 *
 * 横向口径（稿实测，2026-11-18 用 getBoundingClientRect 量 `.bottom` 子树）：
 *   mid-top 660 = 战斗列 256 + 13 + 竖线 1 + 18（含 `.nav{margin-left:6px}`）+ 功能键组 294
 *                 + 13 + 竖线 1 + 18 + 设置 44
 *   居中后战斗列中心 = -202、两条竖线 x = -60 / 267、功能键组中心 = 106、设置中心 = 308；
 *   球组与 mid 间距 18 → 球心 = ±393；四组共用一条底线 -514（技能格 / 导航 / 竖线 / 球底边）
 */
export const bottomBarLayout = {
  /** 底部栏主体（仅作子件定位容器，本身不画底板；内容实际高 98，上下各留边） */
  size: new Size(900, 110),
  /** 贴屏幕底部居中（底边距屏幕 10px；固定值直接手调） */
  position: new Vec2(0, -475),
  /**
   * 底衬（稿 `.bottom::before` 的底部暗角：*椭圆*径向渐变，中心在底栏正中、底边最暗、向上左右同时淡出）
   *
   * 底栏本身不画整条底板（新稿口径），但技能格与导航按钮之间会露出世界 ——
   * 亮色地块（水面 / 浅石板）从缝里钻出来时，底栏就像几块板子漂在亮底上。
   * 这层把世界压下去，三块 HUD 下面都有同一层暗底。
   */
  /**
   * 功能按键区（横向布局容器，按钮排列交给 Layout）
   *
   * 6 个主入口 = 6×44 + 5×6 = 294（稿 `.nav{gap:6px}`），贴战斗列右侧；
   * 「设置」不在这个容器里：稿把它单独放在第二条竖分隔线之后（见 settingsButton）。
   * 入口清单见 configs/bottomNav.bottomNavItems。
   */
  navBar: { spacing: 6, size: new Size(294, 44) },
  /**
   * 单个功能按键（稿 .nbtn：44×44 竖排 —— 16px 描边图标 + 9px 功能名，右上角快捷键字母）
   *
   * 图标是矢量描边（data 见 configs/layout/icons.ts 的 navRole/navBag/...），
   * 不再用 ui/nav 下的贴图；字母放**右上角**（#466 经验：放右下会挤到功能名）
   */
  navButton: {
    size: new Size(44, 44),
    icon: { position: new Vec2(0, 6), size: new Size(16, 16) },
    label: { position: new Vec2(0, -8.5), size: new Size(44, 14), fontSize: T.fontSize.f10 },
    key: { position: new Vec2(16, 16), size: new Size(18, 18), fontSize: T.fontSize.f10 },
  },
  /**
   * 经验条行（战斗列最下）：`N 级 [进度条] M%` 三段横排，总宽与战斗列等宽 256
   * （barWidth 由总宽减去两端文字与间距推出，改 labelWidth / percentLabelWidth / gap 会联动）
   */
  expBar: {
    size: new Size(256, 5),
    levelLabel: { width: 34, fontSize: T.fontSize.f10 },
    percentLabel: { width: 26, fontSize: T.fontSize.f10 },
    gap: 8,
  },
  /**
   * 血量球（role_hp_orb 节点：球体/液面与血量文字都挂这个节点下）
   *
   * position 是 role_hp_orb **节点**在底部栏坐标系里的位置（固定值直接手调，
   * 改它整球——球体加文字——一起动）；球体在节点原点，
   * 血量文字居中在球心（对齐新稿：数值画在球内）
   */
  hpOrb: {
    size: new Size(90, 90),
    text: { position: new Vec2(0, 0), size: new Size(120, 14), fontSize: T.fontSize.f14 },
    /** 球下方的小标题（稿 `.orb-cap`：bottom -19 → 中心 -64；10px、字距拉开） */
    caption: { text: "生命", position: new Vec2(0, -56), size: new Size(60, 12), fontSize: T.fontSize.f10, color: T.text[3], spacingX: 2 },
  },
  /**
   * 魔法球（role_mp_orb 节点：结构与血球一致，液面换蓝）
   * 坐标口径与 hpOrb 相同：position 是节点在底部栏里的位置，文字相对球心偏移
   */
  mpOrb: {
    size: new Size(90, 90),
    text: { position: new Vec2(0, 0), size: new Size(120, 14), fontSize: T.fontSize.f14 },
    /** 球下方的小标题（稿 `.orb-cap`：bottom -19 → 中心 -64；10px、字距拉开） */
    caption: { text: "法力", position: new Vec2(0, -56), size: new Size(60, 12), fontSize: T.fontSize.f10, color: T.text[3], spacingX: 2 },
  },
  /**
   * 快捷键栏（横向布局容器，5 格 = 5×48 + 4×4 = 256，与挂机条 / 经验条同宽同列）
   *
   * #1310：槽由 48×56 改为 48×48 正方形 —— 高度与宽度一致（图标本来就是方的，多出的 8px 只是空着）。
   * 四组共用底线 -19 不变，故栏中心由 9 上移到 5（底边仍 -19、顶边 29）。
   */
  shortcutBar: { spacing: 4, size: new Size(256, 48) },
  /** 单个快捷键槽：图标尺寸 + 右下角按键名 + 居中冷却倒计时 */
  shortcutSlot: {
    size: new Size(48, 48),
    /** 稿 `.sslot .k{right:3px;bottom:1px}` → 距右/底各 5px，48 高槽中心 (19, -19)，字号 9 */
    key: { position: new Vec2(19, -19), size: new Size(20, 10), fontSize: T.fontSize.f10 },
    cooldown: { position: new Vec2(0, 0), size: new Size(40, 20), fontSize: T.fontSize.f16 },
    /** 空槽（未绑技能）：稿 `.sslot.is-empty` 虚线框 + 12px text-4；客户端没有技能名，用一个占位字 */
    emptyColor: T.text[4],
    emptyFontSize: T.fontSize.f12,
    emptyText: "空",
  },
  /** 自动挂机开关（战斗列顶行的细长横条：矢量底板 + 刀剑图标 + 「挂机」文字；开 = 金边金字） */
  autoFight: {
    size: new Size(256, 26),
    /** 摆位在 prefab 的 AutoFight 锚点上（#1361） */
    label: { text: "挂机", position: new Vec2(4, 0), size: new Size(60, 12), fontSize: T.fontSize.f10, spacingX: 1 },
    /** 稿 `.auto svg{width:14px}`：图标与文字同排（图标偏左、文字偏右） */
    icon: { position: new Vec2(-16, 0), size: new Size(14, 14), stroke: 1.7 },
    /** 开启态边框（稿 `.auto.on` 的 rgba(217,162,39,.7)）与字色（稿 #F3DEA6，取最近的 gold-5） */
    onBorder: new Color(217, 162, 39, 178),
    onColor: T.gold[5],
    /**
     * 开启态外圈（#1085：稿 `.auto.on` 的 `box-shadow: 0 0 0 1px rgba(217,162,39,.3)`）
     * 底板外圈 1px 的弱金晕：比底板大一圈（四周各 1px）的空心描边板，开启时亮出
     */
    onRing: new Color(217, 162, 39, 77),
  },
  /**
   * 球体皮肤（稿 `.orb` 的四层结构；血球 / 法力球共用）
   *
   * Graphics 没有径向渐变：球腔用「深底 + 几层偏心柔光圆」近似 —— 圆心抬 `sheenCenterY`，
   * 最大半径恰好落在金环内沿，保证不溢出球外。
   */
  orb: {
    /** 外环宽（稿 border 2px） */
    rim: T.border.widthStrong,
    /** 柔光圆心抬高（px，稿 radial 圆心在 50% 34%） */
    sheenCenterY: 6,
    /** 柔光层：scale 是相对「环内半径 − 抬高量」的比例 */
    sheen: [
      { scale: 1, color: T.surface[2], alpha: 255 },
      { scale: 0.62, color: T.surface[3], alpha: 190 },
      { scale: 0.3, color: T.surface[4], alpha: 130 },
    ],
    /** 液面内缩（稿 `.orb-fill{inset:5px}`） */
    liquidInset: 5,
    /** 液面上沿黑圈（稿 `.orb::after{inset:6px}`，2px 描边才渲染得出来） */
    ringInset: 6,
    ringWidth: 2,
    /** 液面竖向渐变的切条数（同一个 Graphics，DrawCall 不变） */
    gradientSteps: 16,
    /** 渐变深端停靠位置（稿 70% 之后不再变暗） */
    gradientStop: 0.7,
  },
  /** 「设置」独立按钮摆位在 prefab 的 SettingsButton 锚点上（#1361，尺寸 = navButton.size 44×44） */
};

//#endregion

//#region 操作摇杆（左下角常驻）

/**
 * 操作摇杆布局（自身坐标以屏幕中心为原点，子件坐标以摇杆中心为原点）
 *
 * 结构：底座（背景图）+ 手柄（可拖动手柄，拖动位移被夹在 radius 之内）。
 * 「拖得少 = 走路、拖得多 = 跑动」的判定见 components/input/RoleJoystickInput，
 * 两个阈值是**占 radius 的比例**（configs/role.joystickMove）——
 * 所以 radius 同时是手感的分母，调它要一并复核那两个阈值。
 */
export const joystickLayout = {
  /** 摇杆主体（= 底座底图尺寸，同时也是按下时的命中范围） */
  size: new Size(175, 172),
  /** 贴屏幕左下角（屏幕坐标，原点在屏幕中心；固定值直接手调） */
  position: new Vec2(-848.5, -436),
  /** 手柄显示尺寸（素材 98×99 略缩，给拖动留出空间） */
  handleSize: new Size(72, 73),
  /** 手柄中心可离底座中心的最大距离（拖动幅度按它归一化；取值使手柄贴到最外圈时恰好不溢出底座） */
  radius: 48,
};

//#endregion

//#region 小地图（右上角常驻）

/**
 * 小地图布局
 * 组件主体坐标以屏幕中心为原点；其余子件坐标以「地图内容区中心」为原点
 * （功能入口按钮网格贴地图内容区左侧且顶边与地图面板对齐，名称条贴内容区上方，坐标条贴下方）
 */
/**
 * 右上小地图 —— **逐值对照 design/olua-ui/screens/04-hud.html 的 .map 段 + ui.css 的 .panel/.map-rail**
 *
 * 稿口径（1920×1080 基准，1 设计像素 = 1px）：`.map{right:20px;top:14px;width:304px}`，
 * 面板高 = head 40 + view 上边距 8 + view 170 + foot 32 = 250。
 * 组件原点 = 面板中心：x = 960 - 20 - 152 = 788，y = 540 - 14 - 125 = 401
 */
export const smallMapLayout = {
  /** 面板（稿 `.map .panel`：304 宽、r3、line-3 边、四角铆钉 —— 底板由 GameUiHelper.createDialogPanel 现画） */
  size: new Size(304, 256),
  /** 根位置在 prefab 根节点上（#1361 prefab 为准） */
  /**
   * 功能入口 rail（稿 `.map-rail`）：**2 列、间距 5、共 7 个文字按钮**（#1310 起由描边图标改文字，
   * 玩家认不出图标含义）。世界 / 线路 / 排行榜 / 成就 / 消息(+红点) / 设置 / 声音 —— 排行榜与线路**在 rail 里**，
   * 底部（.map-foot）只剩世界坐标（早前「胶囊在地图下方」是看漏稿，#1076 尾批已改回）
   *
   * key 同时是按钮节点名后缀（`small_map_entry_<key>`）与文案 key 后缀（`map_entry_<key>`）
   */
  entries: ["world", "channel", "ranking", "achievement", "mail", "config", "sound"],
  /**
   * 哪个入口开消息中心（邮件面板，公告板在面板里；#429 之前这颗只开公告板）
   *
   * 其余入口仍是占位。红点跟这颗图标走，口径是「未读邮件 + 未领附件 + 未读公告 > 0」——
   * 两路都是「有东西要处理」，分成两个红点反而要玩家去猜哪个更急。
   */
  mailEntry: "mail",
  /** 未读红点（8px；按钮右上角内侧 1px —— 与稿 `.reddot{right:1px;top:1px}` 同口径，58×26 按钮相对坐标 (24,8)） */
  entryDot: { position: new Vec2(24, 8), size: new Size(8, 8) },
  /**
   * rail 网格：2 列文字按钮（#1310）
   *
   * 按钮 58×26：最长文案「排行榜」3 字 × 12px = 36，左右各留 11 内边距；
   * 4 行 × 26 + 3×5 = 119 高。文字 f12 骨白（同稿 rail 图标的 text-2），底/边沿用 rail 原有口径。
   */
  entryGrid: {
    columns: 2,
    buttonSize: new Size(58, 26),
    gap: 5,
    fontSize: T.fontSize.f12,
    textColor: T.text[2],
  },
  /** rail 容器摆位在 prefab 的 EntryRail 锚点上（#1361） */
  /** 标题条（稿 `.map-head`：高 40、内容居中 —— 图名 gold-5 + 「· N 线」text-4 + 下拉箭头 12px） */
  head: {
    /** 图名 / 副文字的摆位与配色在 prefab 的 MapName / ChannelLabel 节点上（#1361） */
    /**
     * 下拉箭头（稿 `svg 12px color text-3`，路径 M6 9l6 6 6-6 → icons.headChevron）
     * 有线号时排在「· N线」之后（x=88）；公共线没有副文字，箭头紧跟图名（x=30）——
     * 稿是 flex 居中整组，客户端两个 Label 固定摆放，只能按有无副文字给两个位
     */
    chevron: { position: new Vec2(68, 107), aloneX: 30, size: new Size(12, 12), color: T.text[3] },
  },
  /**
   * 地图内容区（稿 `.map-view`：280×170 = 304 - 左右 12 边距、r2、line-1 边）
   * 中心 y = +85（head 底）- 8（margin）- 85（半高）= -8；黑点/红点/底图都画在这里
   */
  contentSize: new Size(280, 170),
  /** 内容区摆位在 prefab 的 MapViewAnchor 锚点上（#1361） */
  /** 内容区视口的外观（稿 `.map-view` 径向底 + 22px 网格 + 底图 opacity .5 + 内暗角 26px） */
  mapView: {
    /** 视口边线（极弱，只用来分界） */
    border: T.line[1],
    /** 底图不透明度（0~255；稿 .terrain 是 .5） */
    imageOpacity: 128,
    /**
     * 径向底色（稿 `radial-gradient(circle, #2A2015, #120D08 76%)`）：Graphics 没有径向渐变，
     * 用「外圈 rect + 中圈/内圈两层圆」叠出近似 —— 色值取最接近的 surface 档
     */
    backdrop: { outer: T.surface[1], mid: T.surface[3], midRadius: 125, inner: T.surface[4], innerRadius: 62 },
    /**
     * 网格（稿 22px repeating：金 10% × opacity .35 ≈ alpha 9）。客户端网格画在**实拍底图之上**
     * （稿的地形只是稀疏折线，网格在图下方也看得见；实拍图是满幅，alpha 9 会被完全吃掉），
     * 所以这里取 20 ≈ 8%，与稿的可见强度对齐
     */
    grid: { step: 22, color: T.gold[3], alpha: 26 },
    /** 压暗薄纱（稿地形底 #2A2015→#120D08 是近黑；实拍底图 50% 叠上去仍偏亮，再压一层到同一调子） */
    scrim: { color: T.surface.veil, alpha: 130 },
    /** 内暗角（稿 `inset 0 0 26px rgba(0,0,0,.75)`）：四边填充条近似，13 条 × 2px（条太宽会看出分层） */
    vignette: { steps: 13, width: 2, color: Color.BLACK },
  },
  /** 底部世界坐标（稿 `.map-foot`：右对齐、右距 12 / 下距 12 → 右缘 x=140，文字中心 y≈-108；格式 `X 128 Y 96`） */
  /** 底部世界坐标（稿 `.map-foot` 的 coord：右对齐、右缘 x=140（右距 12）、文字中心 y=-107） */
  /** 坐标文本摆位在 prefab 的 PositionText 节点上（#1361） */
};

//#endregion

//#region 怪物信息面板（屏幕上方，选中怪物时显示）

/** 怪物信息面板布局（坐标以面板中心为原点；逐值对照 04-hud 的 `.monster` 段） */
export const monsterInfoPanelLayout = {
  size: new Size(276, 80),
  position: new Vec2(0, 484),
  /** 底板：稿是暖炭褐 + 朱红半透明边 `rgba(198,58,32,.5)`（与血条同族，提示「这是敌人」） */
  border: new Color(198, 58, 32, 128),
  fill: T.surface.glass,
  /** 左侧头像（56×64，朱红边 + 深褐底） */
  avatar: { position: new Vec2(-104, 0), size: new Size(56, 64), border: new Color(224, 86, 47, 153) },
  /** 名称（左对齐，14px 骨白） */
  name: { position: new Vec2(14, 22), size: new Size(150, 18), fontSize: T.fontSize.f14, color: T.text[1] },
  /** 等级（右对齐，朱红文字） */
  level: { position: new Vec2(112, 22), size: new Size(60, 14), fontSize: T.fontSize.f10, color: T.ember[4] },
  /** 血量条与血量文字（文字盖在条内居中，条加高到 14 才不裁字） */
  hpBar: { position: new Vec2(34, 2), size: new Size(190, 14) },
  hpText: { position: new Vec2(34, 2), size: new Size(120, 12), fontSize: T.fontSize.f10 },
  /** 技能行（未配置技能则不渲染；稿 `.monster .skills i` 18×18 朱红薄底 + 内发光） */
  skillRow: { position: new Vec2(62, -24), slotSize: 18, spacing: 3 },
};

//#endregion

//#region 地面掉落物（世界内，挂在掉落点上）

/**
 * 地面掉落物布局（子件坐标以掉落物节点中心为原点；节点锚点即图标中心）
 *
 * 名称行由若干「段」横向拼成（拼装见 ui/helpers/GameUiHelper.createDropItem）：
 * 装备 = 前缀 + 名称 + 后缀 三段着色，其余物品单行白字，可叠加物品再追加「x{数量}」段。
 * 装备的段文案与配色**与详情弹窗同源**（同走 configs/equipments.getEquipmentNameParts）——
 * 即前缀/名称用前缀色、后缀用后缀色，两处永远一致，不各写一份色表。
 */
export const dropItemLayout = {
  /** 图标默认尺寸 */
  iconSize: new Size(40, 40),
  /** 节点高度 = 图标高度 + 该值（下方多出的空间留给名称行） */
  nodeExtraHeight: 14,
  /** 图标相对节点中心的纵向偏移（= nodeExtraHeight / 2：图标偏上、名称落在下方） */
  iconOffsetY: 7,
  /** 名称行：位置相对图标下沿再往下偏 offsetY；字号 / 行高 / 各段之间的横向间距 */
  name: {
    offsetY: 3,
    fontSize: T.fontSize.f10,
    lineHeight: 12,
    spacing: 2,
  },
  /** 非装备物品的名称颜色（装备按前后缀着色，见 configs/equipments 的两张配色表） */
  nameColor: Color.WHITE,
  /** 数量段颜色（可叠加物品的「x{数量}」） */
  countColor: Color.WHITE,
  /**
   * 归属标记（#804）：名称行最左侧的圆形小头像 + 「XX的」前缀
   *
   * `avatarSize` 固定 32×32（比图标小一圈才不像第二个物品）；头像缺职业 / 性别时**不画空框**，
   * 只留前缀（见 docs/18 §6.7）。前缀色刻意压暗：它是「这是谁的」的注解，不该比物品名更抢眼。
   */
  owner: {
    avatarSize: new Size(32, 32),
    /** 头像与前缀之间的间距（名称行内部的段间距仍取 name.spacing） */
    avatarGap: 2,
    prefixColor: T.text[2],
  },
};

//#endregion

//#region 屏幕中间的提示

/** 浮动提示（消息/错误）：居中显示后上浮淡出 */
export const tipsLayout = {
  size: new Size(480, 24),
  fontSize: T.fontSize.f16,
  /**
   * 描边（Label 自带的 outline）
   *
   * 飘字最常见的落点是**屏幕中心**，而那里常常压着深色或同色系的面板
   * （登录页输入框之间那条深红装饰板就是典型）：纯红 12 号字直接贴上去几乎读不出来。
   * 统一加深色描边 + 提字号，任何底色上都读得清（#457）
   */
  outline: { width: 2, color: T.surface[0] },
  /** 上浮目标位置（纵坐标）与上浮时长（秒） */
  risePositionY: 40,
  messageMoveDuration: 0.5,
  errorMoveDuration: 0.3,
  /** 淡出时长（秒） */
  messageFadeDuration: 3,
  errorFadeDuration: 1.5,
  messageColor: Color.GREEN,
  errorColor: Color.RED,
  /** 自动战斗状态提示（跟随主角的矢量胶囊）：胶囊尺寸 / 圆角 / 字号（两个提示互斥不同显，无让位偏移） */
  autoTipSize: new Size(140, 30),
  autoTipRadius: 15,
  autoTipFontSize: 14,
  /**
   * 状态点光晕（#1085：稿 `.autoflag .dot` 的 `box-shadow: 0 0 10px rgba(217,162,39,.8)`）
   * Graphics 无模糊阴影：点色同色的一层大圆低透明近似（尺寸 = 光晕圆直径，alpha 取中段浓度）
   */
  autoTipDotGlowSize: new Size(22, 22),
  autoTipDotGlowAlpha: 110,
};

//#endregion

//#region 角色身上的挂件（世界内，坐标随角色、不参与屏幕适配）

/**
 * 主角身上的挂件布局（子件坐标以主角节点原点为原点：锚点 (0.5, 0)、内容 40×70，原点在脚底）
 */
export const roleShowLayout = {
  /**
   * 角色名称：显示在**人物区域正中间**，与怪物名称同一套口径（见 GameUiHelper.createMonsterName /
   * createRoleName），不进头顶信息栏。纵坐标取 roleBody 高度的一半 = 身体几何中心，
   * 由推导保证「正中间」；roleBody 改尺寸时自动跟随
   */
  name: { position: new Vec2(0, roleBody.size.height / 2), size: new Size(100, 12), fontSize: T.fontSize.f10, color: T.text[1] },
  /** 战魂外显（勾选「外显」时挂载，随主角移动；动画帧自带大量透明边距，实际视觉尺寸更小） */
  soul: { position: new Vec2(26, 62), size: new Size(72, 72), scale: { x: 0.1, y: 0.1 } },
/**
 * 称号名牌（解锁后**常显**头顶，无开关；取代头部信息栏里写死的文字称号占位）。
 * 节点直接挂在**头部信息栏容器**里（与军衔红字/血条同一个 FlexCol，见 RoleDisplay.updateTitleShow；
 * 角色名称不在这个容器里 —— 它显示在人物区域正中间，见 roleShowLayout.name）：
 * 位置由该容器的纵向布局自动排列 —— 故这里不配坐标、也不缩放（按素材原始尺寸显示，帧原始 156×91 ~ 256×107）。
 * · siblingIndex：名牌在头部容器里的插入位置（0 = 最上）
 * · size：仅加载首帧前的占位尺寸（RAW 模式，帧到达后会被素材原始尺寸覆盖；进图前已预加载，通常一帧内就换掉）
 */
  title: { siblingIndex: 0, size: new Size(260, 140) },
  /**
   * 军衔红字（头顶信息栏里的一行红字，排在血条之上 —— 即最早那版写死的文字称号占位所在的
   * 位置，见 GameUiHelper.createHead 的子节点顺序）。
   * 军衔没有素材，头顶这份就是它的全部外观：未授衔（rank = 0）时整行清空、不留视觉。
   * 颜色刻意用红：军衔是「杀出来的功名」，与白色的角色名称、白色的血量文字区分开。
   */
  rank: { fontSize: T.fontSize.f10, size: new Size(100, 12), color: T.ember[3] },
};

//#endregion

//#region 任务追踪栏（#396：左侧常驻，进行中的任务最多三条）

/**
 * 任务追踪栏布局（逐值对照 04-hud 的 `.quests` 段）
 *
 * 位置固定在屏幕左侧、角色信息栏（左上）与聊天气泡（左上偏内）之下的空档：
 * 稿 `.quests{left:20px;top:300px;width:330px}` → 屏幕坐标 (-960+20+165, 540-300-12) = (-775, 228)？
 * 这里 position 是**标题行**的中心（标题高 24）：y = 540 - 300 - 12 = 228。
 * 行数上限三条 —— 再多就盖住地图了，剩下的去任务面板看。
 */
export const questTrackerLayout = {
  /** 标题行位置（屏幕坐标原点在中心；稿 `.quests .head` 中心 y = 230） */
  position: new Vec2(-775, 230),
  /** 命中区宽度（文字左对齐铺满） */
  width: 330,
  /** 标题行（稿 `.quests .head`：「任务」13px 金-4 + 计数 10px text-4 + 一条渐隐细线） */
  head: {
    height: 20,
    title: "任务",
    titleFontSize: T.fontSize.f13,
    titleColor: T.gold[4],
    titleSpacingX: 2,
    /** 计数（`进行中 / 全部`，如 `3 / 8`）：标题右侧（稿中心 x = 计数中心 -888 → 偏移 32） */
    countFontSize: T.fontSize.f10,
    countColor: T.text[4],
    countX: 32,
    /** 渐隐细线：从标题右侧起铺到右缘前留出「详」按钮的位置（稿细线是 flex:1，按钮 24 宽 + 6 间距） */
    rule: { startOffset: 52, endGap: 34, color: T.line[2] },
    /**
     * 「详」按钮（#1191，稿 `.quests .head .detail-btn`）：标题行右端 24×20，金框小键，
     * 点击直达任务详情弹窗（整块点击仍是任务面板，两个入口并存）
     */
    detailButton: {
      text: "详",
      size: new Size(24, 20),
      fontSize: T.fontSize.f11,
    },
  },
  /** 每行高度（稿 `.qrow{height:24px}`） */
  rowHeight: 24,
  /** 最多显示几条（稿 `.quests` 高 124 = 头 20 + 间距 8 + 4×24，超出显示「还有 N 条」） */
  maxRows: 4,
  fontSize: T.fontSize.f12,
  /** 任务名颜色 / 进度颜色（可交付时整行转绿） */
  nameColor: T.gold[4],
  progressColor: T.text[3],
  progressFontSize: T.fontSize.f11,
  readyColor: T.jade,
  /** 超出提示（{count} = 还有几条没显示） */
  moreText: "还有 {count} 条任务，打开任务面板查看",
  moreColor: T.text[4],
  moreFontSize: T.fontSize.f11,
  /** 行 hover 高亮（#1191，稿 `.qrow:hover`：amber 12% 淡染圆角底；触屏没有 hover，不画） */
  rowHover: new Color(217, 162, 39, 31),
  rowRadius: T.radius.r1,
  /** 空态不显示任何东西（追踪栏占位也不留） */
  texts: {
    /** 进度格式：{done}/{total} */
    progress: "{done}/{total}",
    /** 可交付标记 */
    ready: "可交付",
  },
};

//#endregion

//#region 消息记录（#1224：右下角常驻系统消息流水）

/**
 * 消息记录面板（逐值对照 04-hud 的 `.mlog` 段）
 *
 * 稿 `.mlog{right:20px;bottom:18px;width:352px;height:272px}` → 屏幕坐标（原点在中心）：
 * 右缘 960-20=940、左缘 940-352=588（中心 x = 764）；下缘 -540+18=-522、上缘 -522+272=-250（中心 y = -386）。
 * 与左下聊天块镜像；**只收系统消息**（系统 / 获得 / 战斗 / 任务），聊天对话在左下聊天。
 */
export const messageLogLayout = {
  /** 面板尺寸（收起时高度变小；位置与配色（fill/border/radius/铆钉）在 prefab 的 Plate 节点上，#1361） */
  size: new Size(352, 272),
  /** 标题行（稿 `.mlog-head`：标题 13px 金-4 + 计数 + 3px 容量条 + 收起钮，高 32） */
  head: {
    height: 32,
    /**
     * 容量条（稿 `.capbar`：3px 细条，当前 312/1000 的占比）：
     * 常色金阶、满格转朱红（即将清空）；宽度由「计数右缘 → 收起钮左缘」之间的剩余空间决定
     */
    bar: {
      height: 3,
      radius: 2,
      bg: T.surface.sunken,
      fill: T.gold[3],
      full: T.ember[3],
      gap: 8,
    },
    /** 收起钮（稿 `.chat-tools button` 22×22：点一下折到只剩标题行，再点展开） */
    collapse: {
      text: "▾",
      expandText: "▴",
      size: new Size(22, 22),
      fontSize: T.fontSize.f10,
      color: T.text[4],
      hoverColor: T.gold[4],
      fill: T.surface.input,
      border: T.line[2],
      radius: T.radius.r1,
    },
  },
  /** 消息行（稿 `.mlog-msgs`：10 行、每行「时间 10px + 36×18 标签 + 11px 正文」） */
  rows: {
    /** 面板内可见行数（312 条里只画最近这 10 条，往上翻是弹窗的事 —— 本块只做流水回看） */
    count: 10,
    height: 21,
    paddingX: 12,
    /** 时间列宽 / 与标签的间距 / 标签与正文的间距 */
    timeWidth: 30,
    gap: 6,
    tag: { width: 36, height: 18, fontSize: T.fontSize.f10, radius: T.radius.r1, fill: T.surface.input, border: T.line[2] },
    text: { fontSize: T.fontSize.f11, color: T.text[2] },
    time: { fontSize: T.fontSize.f10, color: T.text[4] },
    /**
     * 分类标签文案与色（#1229 个人流水七类）：
     * 系统灰 / 任务金 / 获得翠绿 / 经验冷蓝 / 升级琥珀 / 货币暗金 / 成长朱红淡
     * 七类都是两字，36px 宽的 chip 不用改（扩容分类不改编版式）
     */
    tagTexts: {
      system: "系统",
      quest: "任务",
      gain: "获得",
      exp: "经验",
      level: "升级",
      money: "货币",
      growth: "成长",
    },
    tagColors: {
      system: T.text[3],
      quest: T.gold[4],
      gain: T.jade,
      exp: T.frost,
      level: T.amber,
      money: T.gold[3],
      growth: T.ember[4],
    },
    /** 空态（本次上线还没有任何流水） */
    emptyText: "暂无记录",
    emptyColor: T.text[4],
  },
  /** 底部注释（稿 `.mlog-foot`：左「个人流水 · 不含聊天对话」+ 右「满 1000 条自动清空 · 重新累计」） */
  foot: {
    height: 28,
    paddingX: 12,
    fontSize: T.fontSize.f10,
    ruleColor: T.surface[0],
    left: "个人流水 · 不含聊天对话",
    right: "满 1000 条自动清空 · 重新累计",
    leftColor: T.text[4],
    rightColor: T.text[3],
  },
};

//#endregion

//#region NPC 头顶任务标记（#396：可接 ! / 可交付 ?）

/**
 * NPC 头顶的任务标记
 *
 * 不挂在 NPC 节点里：那个节点是纵向 FlexCol（名字 + 立绘），塞进去会被布局重排。
 * 做法是在地图层单独放一个标签节点，位置 = NPC 世界坐标 + offset（NPC 节点高 170，
 * 名字在最上面一行，标记再抬一点）。
 */
export const questNpcMarkLayout = {
  name: "quest_npc_mark",
  /** 相对 NPC 节点原点的偏移（NPC 静止不动，故不需要跟随） */
  offset: new Vec2(0, 96),
  size: new Size(40, 26),
  fontSize: T.fontSize.f20,
  availableColor: T.gold[4],
  readyColor: T.jade,
  /** 标记字符（! 可接 / ? 可交付；两个都没有就整块隐藏） */
  texts: { available: "!", ready: "?" },
};

//#endregion
