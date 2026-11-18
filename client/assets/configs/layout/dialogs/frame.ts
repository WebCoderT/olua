/**
 * 通用弹窗框与页脚几何（createDialog 系列零件的缺省几何，所有弹窗共用）
 *
 * 拆分自原 configs/layout/dialogs.ts（#1115 批次 2），数值与注释原样保留。
 */
import { Size } from "cc";
import { uiSize } from "../sizes";
import { T } from "../tokens";

//#region 通用弹窗框（createDialog 系列零件的缺省几何）

/** 通用弹窗框几何（所有弹窗共用：位置跟随拖动，尺寸可被各弹窗覆盖） */
export const dialogFrame = {
  /** 缺省弹窗尺寸（createDialog 不传尺寸时使用；ui.css --dlg-w-md / --dlg-h-md） */
  size: new Size(T.stage.dlgWidthMd, T.stage.dlgHeightMd),
  /**
   * 面板本体（ui.css `.panel--rivet`）：
   * 暖炭褐底 + 顶部略亮的明暗过渡 + 1px 古铜金线 + 四角铆钉，全部 Graphics 现画，
   * 不再用九宫拼图 —— 弹窗尺寸变化时金线始终是 1px、铆钉始终是同一个圆，不会跟着拉伸变形。
   */
  panel: {
    /** 底板主色（surface-2） */
    fill: T.surface[2],
    /**
     * 顶部明暗过渡带（模拟 `.panel{background:linear-gradient(165deg,var(--surface-3),var(--surface-2) 62%,#150F08)}`
     * 的亮端）：稿的亮端是 surface-3 —— 早前误配成与主色同档，等于没有渐变，面板一片死平
     */
    fillTop: T.surface[3],
    /** 过渡带占面板高度的比例（自顶向下；稿里 62% 处已到 surface-2，故取 0.42 让亮端止于上半区） */
    fillTopRatio: 0.42,
    /** 外框金线（line-3）与线宽 */
    border: T.line[3],
    borderWidth: T.border.width,
    /** 渐变收尾色（稿 `.panel` 165deg 渐变的最底端 #150F08） */
    gradientBottom: T.surface.panelDeep,
    /** 渐变条数（Graphics 无渐变 API，用等高色带插值；40 条在高 540 的面板上肉眼无缝） */
    gradientSteps: 40,
    /** 内侧一圈极弱高光（模拟 inset 0 1px 0 rgba(255,255,255,.06)） */
    innerHighlight: T.overlay.highlight,
    /** 圆角（--r-3） */
    radius: T.radius.r3,
    /** 四角铆钉：直径、金色、距面板边缘的内缩、铆钉旁的小拖尾点（直径与偏移） */
    rivet: {
      size: T.border.rivet,
      color: T.gold[3],
      inset: 9,
      trailSize: 3,
      trailOffset: 14,
    },
  },
  /**
   * 头部眉题（ui.css `.panel-eyebrow`）：左上角一行小字（`BAG · B` 这类英文缩写），
   * 距弹窗左边缘 `padDialog`、中心距顶边 26（用户拍板 2026-11-18：bag_dialog 540 高时 Y=244），
   * 字号 f10、金色、字距加大
   *
   * 与标题（居中）分工：眉题给键盘快捷键与分区信息，标题才是中文名。
   * 宽高只决定文本对齐框（LEFT + CENTER），不动不影响排版。
   */
  eyebrow: {
    left: T.spacing.padDialog,
    top: 19,
    width: 240,
    height: 14,
    fontSize: T.fontSize.f10,
    color: T.gold[2],
  },
  /** 标题：距弹窗上边缘的内缩、文本高度、宽度两侧内缩、字号与颜色（摆放见 GameUiHelper.createDialog） */
  title: {
    /**
     * 标题中心距弹窗顶边的距离（用户拍板 2026-11-18：以 bag_dialog 实测为准 ——
     * 弹窗 540 高时标题中心 Y=245，即距顶 25；全弹窗统一按此距离）
     */
    insetTop: 25,
    height: 24,
    widthPadding: 60,
    /** 用户拍板（2026-11-18）：全弹窗标题统一 12 号 */
    fontSize: T.fontSize.f12,
    color: T.text[1],
    /** 标题下的短金线（ui.css .panel-title::after，44×1）；gap = 标题下沿到金线中心的距离（Y=226 → 距顶 44） */
    rule: { width: T.border.titleRuleWidth, height: T.border.titleRuleHeight, color: T.gold[3], gap: 7 },
  },
  /**
   * 标题栏拖拽柄（#1090：只有标题栏可拖动弹窗，内容区拖动不影响弹窗位置）
   *
   * 通栏透明条带，从弹窗顶边覆盖到标题金线之下（标题距顶 25 + 高 24 + 金线区 ≈ 56），
   * 垫在标题/眉题/关闭键之下 —— 按标题文字、眉题都是拖拽，按关闭键是关窗。
   */
  headDrag: { height: 56 },
  /**
   * 关闭按钮：尺寸（公共尺寸，见 sizes.uiSize）+ 距弹窗右/上边缘的内缩 + 矢量化 × 的字号与色
   *
   * 内缩按 ui.css `.panel-close` 的 `top:10px; right:12px` 反推中心点（按钮 30×30 居中，故各加 15）。
   */
  closeButton: {
    size: uiSize.closeButtonSize,
    insetX: 27,
    insetY: 25,
    text: "×",
    fontSize: T.fontSize.f18,
    color: T.text[3],
    hoverColor: T.text[1],
  },
};

/**
 * 弹窗页脚几何（ui.css `.panel-foot`）：顶部 1px 分隔线 + 两端各一行小字
 *
 * 16 个弹窗里 13 个有页脚，几何只随面板尺寸变，所以按尺寸算而不是逐屏手抄：
 * 线距面板底 24（`--sp-6` + 字高的一半）、字中心距底 8；两端文字块宽 `textWidth`，
 * 内缘距面板边 `inset`（= `--pad-dialog` 20）→ 左块中心 = -半宽 + inset + 半宽文字块。
 *
 * @param size 弹窗尺寸（页脚按**面板高度**贴底，不含外框）
 * @param textWidth 单侧文字块宽（两端各一块，居中会让长句截断，所以给足）
 */

export function dialogFootLayout(size: Size, textWidth = 300, inset = T.spacing.padDialog) {
  const halfWidth = size.width / 2;
  const halfHeight = size.height / 2;
  return {
    lineY: -halfHeight + 24,
    textY: -halfHeight + 8,
    leftX: -halfWidth + inset + textWidth / 2,
    rightX: halfWidth - inset - textWidth / 2,
    width: textWidth,
    height: 14,
    fontSize: T.fontSize.f11,
    color: T.text[4],
    lineColor: T.line[1],
  };
}

//#endregion

//#region 战魂弹窗（左中右三栏）

/**
 * 三栏养成弹窗（战魂 / 称号 / 军衔）的公共几何 —— 一处改、三窗同变
 *
 * 三个弹窗的结构与坐标完全同源（左列表 + 中展示 + 右属性列），差异只在文案、
 * 列表名与中间栏的内容（动画 / 徽记）。数值直接改这里。
 */
/**
 * 成长线三窗（军衔 / 称号 / 战魂）共用的左栏卡片列表
 *
 * 稿 17-growth 的 `.gbody`：`padding:0 18px`、三列 `216px 1fr 224px`、`gap:18`、高 392。
 * 面板 880×540 → 内容带 -422..422（宽 844）：
 * 左栏 216（中心 -314）· 间距 18 · 中栏 368（中心 -4）· 间距 18 · 右栏 224（中心 310）。
 * 纵向：内容顶 225（头部下沿）、高 392 → 底 -167、中心 29。
 *
 * 卡片按稿 `.gitem`：212×46、行距 6、圆角 r2、`rgba(0,0,0,.24)` 底 + line-1 边；
 * 选中金边 + 金色淡底；左侧 26px 圆形阶号徽章（选中金底深字）。
 */
