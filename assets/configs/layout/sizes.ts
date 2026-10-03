import { Size } from "cc";

/**
 * 跨界面复用的尺寸与字号
 * 只放「多个界面/零件都会用到」的公共尺寸；某个界面专属的尺寸写在各自的布局块里
 * （见 configs/layout/{hud,dialogs,panels,scenes}.ts）
 */
export const uiSize = {
  /** 按钮尺寸（大/中/小） */
  bigButtonSize: new Size(183, 48),
  middleButtonSize: new Size(123, 36),
  smallButtonSize: new Size(56.5, 24),
  /** 按钮文字尺寸（大/中/小） */
  smallButtonFontSize: 10,
  middleButtonFontSize: 12,
  bigButtonFontSize: 14,
  /** 通用关闭按钮尺寸（弹窗框用，见 dialogs.dialogFrame.closeButton） */
  closeButtonSize: new Size(30, 30),
};
