import { ResolutionPolicy, Size, Vec2, screen, view } from "cc";

/**
 * 屏幕适配与常驻 HUD 的贴边布局（纯函数 + 两个屏幕级接口）
 *
 * 适配策略：铺满窗口（NO_BORDER）——画面按设计分辨率等比缩放铺满窗口、不留黑边，
 * 窗口宽高比与设计不一致时，**一轴等于设计尺寸、另一轴小于设计尺寸**（小的一轴就是被裁掉的量）：
 * 窗口偏窄（4:3）→ 可见高度 = 750、可见宽度 < 1624（左右各裁掉一些）；
 * 窗口偏宽（21:9）→ 可见宽度 = 1624、可见高度 < 750（上下各裁掉一些）。
 * 裁剪对设计中心对称，故**屏幕中心恒为坐标系原点**，各常驻 HUD 只需按可见尺寸贴边即可。
 *
 * 常驻 HUD（左上角色信息栏 / 右上小地图 / 底部栏）不写死坐标，
 * 而是按各自「贴哪条边 + 边距」由 getAnchoredPosition 用当前可见尺寸实时算出中心坐标，
 * 窗口尺寸变化时由 onWindowResize 通知各方重排（见 ui/Game.ts）。
 */

/** 设计分辨率（与项目设置一致；运行时策略在 applyScreenPolicy 里统一为铺满窗口） */
export const designResolution = new Size(1624, 750);

/** 应用屏幕适配策略：铺满窗口、不留黑边（各场景启动时调用一次即可，重复调用无副作用） */
export function applyScreenPolicy() {
  view.setDesignResolutionSize(designResolution.width, designResolution.height, ResolutionPolicy.NO_BORDER);
}

/**
 * 当前可见尺寸（设计坐标系；真实可见区，非设计分辨率）
 *
 * 注意：铺满窗口（NO_BORDER）时**不能用 `view.getVisibleSize()`**——引擎的实现是把「视口」
 * 放大到超出画布、再让画布裁掉溢出部分，于是 `view._visibleRect` 恒等于设计分辨率，
 * 用它算贴边位置会把区块排到屏幕外（窗口偏窄时左上/右上两块被切掉）。
 * 真实可见区 = 窗口像素尺寸 / 缩放系数，与引擎相机的口径完全一致：
 *   orthoHeight = screen.windowSize.height / view.getScaleY() / 2
 * 这里用同一公式反算，保证布局与相机实际渲染范围永远一致。
 */
export function getVisibleSize() {
  const windowSize = screen.windowSize;
  const scaleX = view.getScaleX();
  const scaleY = view.getScaleY();
  // 极端时机（引擎未初始化 / 尺寸为 0）下退回设计分辨率，避免算出 0 尺寸
  if (!windowSize.width || !windowSize.height || !scaleX || !scaleY) return view.getVisibleSize();
  return new Size(windowSize.width / scaleX, windowSize.height / scaleY);
}

/**
 * 计算整屏「舞台」的等比缩放系数（舞台 = 按固定设计尺寸摆好的完整构图，如选角场景）
 *
 * 按可见尺寸做 contain 适配：保证整块舞台都落在可见区内；可见区比舞台大时不放大（上限 1）
 * 用法：把位于屏幕中心的舞台容器节点 setScale(该系数)，即可让任意窗口宽高比下构图都完整可见
 * （不缩放的话，铺满窗口策略会在某个方向裁掉画面，贴边元素会跑到屏幕外）
 */
export function getStageScale(stageSize: Size, visibleSize: Size = getVisibleSize()): number {
  if (!stageSize.width || !stageSize.height) return 1;
  return Math.min(1, visibleSize.width / stageSize.width, visibleSize.height / stageSize.height);
}

/**
 * 监听窗口尺寸变化（Web 与原生均由 screen 派发；平台不支持时静默跳过）
 * @param handler 尺寸变化后的重排回调
 * @returns 取消监听函数（场景销毁前调用）
 */
export function onWindowResize(handler: () => void): () => void {
  if (!screen) return () => {};
  screen.on("window-resize", handler);
  return () => screen.off("window-resize", handler);
}

/** 贴边方式：左上 / 右上 / 底部居中 */
export type ScreenEdge = "top-left" | "top-right" | "bottom-center";

/**
 * 计算「贴边区块」的中心坐标（坐标系以屏幕中心为原点，与 UI 层各常驻组件一致）
 * @param blockSize 区块自身尺寸
 * @param visibleSize 当前可见尺寸（getVisibleSize）
 * @param edge 贴哪条边
 * @param marginX 水平边距（区块边缘到屏幕左/右边缘；bottom-center 忽略）
 * @param marginY 垂直边距（top-*：区块上边缘到屏幕上边缘；bottom-center：区块中心到屏幕下边缘）
 */
export function getAnchoredPosition(blockSize: Size, visibleSize: Size, edge: ScreenEdge, marginX: number, marginY: number): Vec2 {
  const halfWidth = visibleSize.width / 2;
  const halfHeight = visibleSize.height / 2;
  const x = edge === "top-left" ? -halfWidth + marginX + blockSize.width / 2 : edge === "top-right" ? halfWidth - marginX - blockSize.width / 2 : 0;
  // 底部栏的背景比可视内容高（下沿本就溢出屏幕），故按「区块中心到屏幕下边缘」定位
  const y = edge === "bottom-center" ? -halfHeight + marginY : halfHeight - marginY - blockSize.height / 2;
  return new Vec2(x, y);
}
