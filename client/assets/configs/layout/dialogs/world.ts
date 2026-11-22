/**
 * 地图与分流弹窗（地图传送 / 地图预览 / 选区 / 频道）布局
 *
 * 拆分自原 configs/layout/dialogs.ts（#1115 批次 2），数值与注释原样保留。
 */
import { Color, Size, Vec2 } from "cc";
import { dialogFootLayout } from "./frame";
import { T } from "../tokens";

export const mapTeleportDialogLayout = {
  name: "map_teleport_dialog",
  title: "大陆传送官",
  eyebrow: "世界地图",
  /**
   * 内容视口（纵向滚动）：弹窗 600×500，标题金线下沿在中心上方 215。
   *
   * 视口宽 580（左右各留 10）、高 430（顶 215 → 底 -215，离弹窗底边还有 35）——
   * 62 张图一个分组十几行，靠高度自适应会直接顶出屏幕，所以内容一律进滚动区：
   * 分组标题与网格依次往下排，地图再多也只是滑。
   */
  content: { name: "map_teleport_content", position: new Vec2(0, 0), size: new Size(580, 430), groupSpacing: 16 },
  /** 分组标题 */
  groupTitle: { fontSize: T.fontSize.f14, height: 20, color: T.gold[4] },
  /** 地图按钮网格：每行 4 个（4 × 123 + 3 × 20 = 552，在 580 容器内水平居中） */
  grid: { spacingX: 20, spacingY: 12 },
};

//#endregion

//#region 小地图弹窗（当前地图的整图预览）

/** 弹窗尺寸 720×520（ui.css --dlg-w-lg 一级；19-world-map 稿） */

export const mapPreviewDialogLayout = {
  name: "map_preview_dialog",
  eyebrow: "世界地图",
  size: new Size(720, 520),
  /** 标题兜底文案（正常显示当前地图名，见 SmallMap 传入） */
  title: "小地图",
  /**
   * 预览区：地图 preview.jpg 整图铺满；点击按比例换算成世界坐标（左键寻路 / 右键传送）
   *
   * 稿 19-map 的 `.mview`：内容宽 680、高 330，顶边 205（头部下沿）→ 中心 40、底 -125。
   * 点击换算按**这个尺寸**的比例走，改尺寸不用动代码。
   */
  preview: { name: "map_preview", position: new Vec2(0, 40), size: new Size(680, 330) },
  /** 操作提示（稿的 `.hint` 叠在预览区底部内侧的渐变带上） */
  hint: { text: "左键点击自动寻路，右键点击直接传送", position: new Vec2(0, -108), size: new Size(660, 20), fontSize: T.fontSize.f11, color: T.gold[4] },
  /**
   * 预览图上的静态文字标记（开窗时按配置快照的点位 / 区域建一次，随预览图一起移动/缩放）
   * 三类标记：NPC 白点 + 点上方紧挨着的名称、刷怪区中心的怪物名称
   */
  marker: {
    /** 名称文字框尺寸（宽 × 高；宽给足避免名称被截断，各标记居中显示） */
    labelSize: new Size(140, 16),
    /** NPC 白点半径（像素） */
    npcDotRadius: 3,
    /** NPC 白点颜色 */
    npcDotColor: Color.WHITE,
    /** NPC 名称文字颜色与字号 */
    npcLabelColor: T.text[1],
    npcLabelFontSize: 12,
    /** NPC 名称与白点的间距（像素：文字底边到白点边缘的距离） */
    npcLabelGap: 2,
    /** 刷怪区怪物名称文字颜色与字号 */
    monsterLabelColor: T.gold[4],
    monsterLabelFontSize: 12,
  },
  /**
   * 预览图上的路线指示线样式（自动寻路期间画出的「角色 → 目标」路线）
   * 白色点状线，单位是预览区像素（与黑点/红点同一坐标系，见 MapPreviewDialog.createPreviewMapper）；
   * 预览区比常驻小地图大得多，故点半径/间距单独配置，不共用 configs/smallMap 的 route*
   */
  route: {
    /** 点与终点圆点的颜色 */
    color: T.text[1],
    /** 单个点半径（像素） */
    dotRadius: 2.5,
    /** 相邻点间距（像素） */
    dotGap: 12,
    /** 终点圆点半径（像素）：比途中的点大一圈 */
    endDotRadius: 7,
  },
  /** 页脚（稿 19-map 的 .panel-foot） */
  foot: dialogFootLayout(new Size(720, 520), 300),
  footTexts: { left: "左键寻路 · 右键直接传送", right: "传送有冷却，战斗中不可用" },
};

//#endregion

//#region 角色信息弹窗

/**
 * 角色信息弹窗（06-role-info 稿）
 *
 * 面板 660×520：五列结构 = 左装备列 / 内观 / 右装备列 / 属性列 / 六入口列
 * （装备列与属性列的几何在 layout/panels，内观是服务端 `equip_in_aligns` 的对齐数据，不在这里摆）。
 */

export const zoneSelectLayout = {
  name: "zone_select_dialog",
  /** 眉题（「副标题必须有」，全弹窗统一 `.panel-eyebrow` 口径） */
  eyebrow: "分区",
  maskColor: T.surface.scrim,
  panel: { name: "zone_select_panel", size: new Size(560, 500) },
  /** 标题文本的位置与样式（配色与通用弹窗标题一致） */
  titleLabel: { name: "zone_select_title", position: new Vec2(0, 220), size: new Size(480, 28), fontSize: T.fontSize.f18, color: T.ember[4] },
  /** 说明行：为什么必须先选一个区（不同区的角色互不相通） */
  hint: { position: new Vec2(0, 188), size: new Size(500, 20), fontSize: T.fontSize.f12, color: T.text[3] },
  /** 区列表（纵向滚动，每行固定高、行间距见 row.gap） */
  list: { name: "zone_select_list", position: new Vec2(0, -20), size: new Size(500, 356) },
  row: {
    size: new Size(496, 58),
    /** 行间距（滚动区 content 的 Layout.spacingY） */
    gap: 10,
    fill: T.surface[1],
    border: T.surface[3],
    /** 当前浏览区的高亮描边（与帮会列表「自己那一行」同一口径） */
    currentBorder: T.gold[4],
    /** 进不去的区（维护中 / 已关闭）：底色压暗、区名变灰。点它有提示，不是静默无反应 */
    disabledFill: T.surface[1],
    radius: 6,
    /** 区名（左列，相对行中心） */
    nameX: -178,
    nameSize: new Size(200, 22),
    nameFontSize: 16,
    nameColor: T.text[1],
    disabledNameColor: T.text[4],
    /** 角色数 · 状态（中列） */
    metaX: -18,
    metaSize: new Size(220, 18),
    metaFontSize: 12,
    metaColor: T.text[3],
    /** 角标：从 tagRightX 起往左一个个摆（最多两个：「上次在」「推荐」） */
    tagRightX: 226,
    tagGap: 6,
    tagSize: new Size(56, 20),
    tagFontSize: 11,
    tagFill: T.line[2],
    tagBorder: T.line[3],
    tagColor: T.gold[4],
  },
  /** 取消按钮（面板底部居中）：打开选服窗不等于必须换区 */
  closeButton: { name: "zone_select_close_button", text: "取消", position: new Vec2(0, -218) },
};

//#endregion

//#region 社交 · 帮会（#388）

/**
 * 帮会弹窗（社交面板的第一页；好友 / 敌人 / 附近在 #389 补成同框多页）
 *
 * 两种形态共用一个弹窗，按「有没有帮会」切换：
 * - **未加入**：创建帮会（输入框 + 按钮）+ 全部帮会列表（每行一个「申请」）
 * - **已加入**：帮会信息头 + 公告（干部可改）+ 成员名单 + 待审批（干部可见）+ 退出 / 解散
 *
 * 列表行是「整行一条」的横排（不是网格）：滚动区 content 自带纵向 Layout，
 * 直接 addChild 就按行往下排，行内位置以**行中心**为原点（见 row.*）。
 */

export const channelSelectLayout = {
  name: "channel_select_dialog",
  /** 眉题（「副标题必须有」，全弹窗统一 `.panel-eyebrow` 口径） */
  eyebrow: "频道",
  maskColor: T.surface.scrim,
  panel: { name: "channel_select_panel", size: new Size(420, 400) },
  /** 标题（配色与选服弹窗同一套） */
  titleLabel: { name: "channel_select_title", position: new Vec2(0, 170), size: new Size(360, 28), fontSize: T.fontSize.f18, color: T.ember[4] },
  /** 说明行：告诉玩家换线意味着什么（各线怪物与掉落独立，人挤就换线） */
  hint: { position: new Vec2(0, 142), size: new Size(380, 20), fontSize: T.fontSize.f12, color: T.text[3] },
  /** 线列表（纵向滚动；行高与间距见 row） */
  list: { name: "channel_select_list", position: new Vec2(0, -8), size: new Size(372, 240) },
  row: {
    size: new Size(368, 52),
    /** 行间距（滚动区 content 的 Layout.spacingY） */
    gap: 10,
    fill: T.surface[1],
    border: T.surface[3],
    /** 当前所在线的高亮描边（与选服弹窗「上次在」同一套金色） */
    currentBorder: T.gold[4],
    radius: 6,
    /** 线名（左列） */
    nameX: -120,
    nameSize: new Size(180, 22),
    nameFontSize: 16,
    nameColor: T.text[1],
    /** 「当前」角标（贴右） */
    tagX: 140,
    tagSize: new Size(52, 20),
    tagFontSize: 11,
    tagFill: T.line[2],
    tagBorder: T.line[3],
    tagColor: T.gold[4],
  },
  /** 取消按钮：打开选线窗不等于必须换 */
  closeButton: { name: "channel_select_close_button", text: "取消", position: new Vec2(0, -158) },
};

//#endregion
