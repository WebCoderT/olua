import { Color, Size } from "cc";
import { T } from "./tokens";

/**
 * 跨界面复用的尺寸与字号
 * 只放「多个界面/零件都会用到」的公共尺寸；某个界面专属的尺寸写在各自的布局块里
 * （见 configs/layout/{hud,dialogs,panels,scenes}.ts）
 */
export const uiSize = {
  /** 按钮尺寸（大/中/小）：48 主行动 / 36 常规 / 24 行内（ui.css .btn 三档） */
  bigButtonSize: new Size(183, 48),
  middleButtonSize: new Size(123, 36),
  smallButtonSize: new Size(56.5, 24),
  /** 按钮文字尺寸（大/中/小） */
  smallButtonFontSize: T.fontSize.f10,
  middleButtonFontSize: T.fontSize.f14,
  bigButtonFontSize: T.fontSize.f18,
  /** 通用关闭按钮尺寸（弹窗框用，见 dialogs.dialogFrame.closeButton） */
  closeButtonSize: new Size(30, 30),
};

/**
 * 按钮色调（ui.css 的 .btn / .btn--primary / .btn--gold / .btn--danger）
 *
 * 一档 = 底 / 顶部亮带 / 描边 / 字色 四个值。Graphics 画不出渐变，用「主色整块 + 上半一条亮带」
 * 叠出上亮下暗的金属感；圆角与线宽全走令牌。
 */
export interface ButtonTone {
  fill: Color;
  fillTop: Color;
  border: Color;
  text: Color;
  /** 亮带占按钮高度的比例（自顶向下） */
  fillTopRatio: number;
}

export const buttonTone = {
  /** 主行动（进入游戏 / 重试）：朱红渐变 + 亮朱描边 + 朱底字 */
  primary: {
    fill: T.ember[2],
    fillTop: T.ember[3],
    border: T.ember.border,
    text: T.text.onEmber,
    fillTopRatio: 0.55,
  },
  /** 常规（暗褐金属 + 金线） */
  normal: {
    fill: T.surface[3],
    fillTop: T.surface[4],
    border: T.line[3],
    text: T.text[1],
    fillTopRatio: 0.55,
  },
  /** 金键（整理 / 回收这类次要主动作） */
  gold: {
    fill: new Color(36, 26, 16, 255), // #241A10
    fillTop: new Color(58, 44, 26, 255), // #3A2C1A
    border: T.gold[2],
    text: T.gold[5],
    fillTopRatio: 0.55,
  },
  /** 危险（删除 / 丢弃）：暗朱底 + 朱红字，不做高饱和填充 */
  danger: {
    fill: new Color(36, 16, 10, 255), // #24100A
    fillTop: new Color(58, 23, 14, 255), // #3A170E
    border: new Color(198, 58, 32, 153),
    text: T.ember[4],
    fillTopRatio: 0.55,
  },
  /** 次要（只有一圈弱线，点上去才亮） */
  ghost: {
    fill: new Color(0, 0, 0, 0),
    fillTop: new Color(0, 0, 0, 0),
    border: T.line[2],
    text: T.text[2],
    fillTopRatio: 0,
  },
} as const;

/** 按钮公共几何（三档高度 + 圆角 + 线宽；宽度由调用方按文案长度给） */
export const buttonStyle = {
  radius: T.radius.r2,
  borderWidth: T.border.width,
  /** 最小宽度（避免「删除」这种两字键被压成一条） */
  minWidth: { big: 120, middle: 96, small: 56 },
} as const;
