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
 *
 * 贴在某个界面元素旁的浮层（物品详情弹窗）另有 getPopupPosition：同样吃「当前可见尺寸」，
 * 目标不是贴边而是**尽量靠屏幕中间且整块可见**。
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

/** 贴边方式：左上 / 右上 / 左下 / 底部居中 */
export type ScreenEdge = "top-left" | "top-right" | "bottom-left" | "bottom-center";

/**
 * 计算「贴边区块」的中心坐标（坐标系以屏幕中心为原点，与 UI 层各常驻组件一致）
 * @param blockSize 区块自身尺寸
 * @param visibleSize 当前可见尺寸（getVisibleSize）
 * @param edge 贴哪条边
 * @param marginX 水平边距（区块边缘到屏幕左/右边缘；bottom-center 忽略）
 * @param marginY 垂直边距（top-*：区块上边缘到屏幕上边缘；bottom-left：区块下边缘到屏幕下边缘；
 *   bottom-center：区块中心到屏幕下边缘——底部栏的背景比可视内容高、下沿本就溢出屏幕，故按中心定位）
 */
export function getAnchoredPosition(blockSize: Size, visibleSize: Size, edge: ScreenEdge, marginX: number, marginY: number): Vec2 {
  const halfWidth = visibleSize.width / 2;
  const halfHeight = visibleSize.height / 2;
  const x =
    edge === "top-right"
      ? halfWidth - marginX - blockSize.width / 2
      : edge === "bottom-center"
        ? 0
        : -halfWidth + marginX + blockSize.width / 2; // 贴左边（top-left / bottom-left）
  const y =
    edge === "bottom-center"
      ? -halfHeight + marginY
      : edge === "bottom-left"
        ? -halfHeight + marginY + blockSize.height / 2
        : halfHeight - marginY - blockSize.height / 2; // 贴顶边（top-left / top-right）
  return new Vec2(x, y);
}

/**
 * 夹取：把值压进 [min, max]；区间本身无解（min > max，例如浮层比可见区还大）时退回区间中点
 *
 * 中点就是屏幕中心（区间对称：±(可见区半边长 − 边距 − 浮层半边长)），于是"塞不下"时浮层居中、
 * 上下（或左右）各溢出一半，而不是被推到某一侧的屏幕外
 */
function clampCenter(value: number, min: number, max: number): number {
  if (min > max) return (min + max) / 2;
  return Math.min(max, Math.max(min, value));
}

/**
 * 计算「贴着某个界面元素」的浮层（物品详情弹窗等）的摆放位置 —— 屏幕中心系坐标，浮层锚点 0.5/0.5
 *
 * 玩家口径：**浮层尽量靠屏幕中间，且整块都要落在可视范围内**（弹窗信息比物品大得多，
 * 贴着物品往屏幕外侧摆会被裁掉一半）。规则：
 * 1. 竖直：与锚点同高居中（不上下跳，物品附近就是它）；
 * 2. 水平：摆在锚点**靠屏幕中间的那一侧**（锚点在左半屏 → 摆它右边，右半屏 → 摆它左边），
 *    于是浮层自然贴着屏幕中间；这一侧放不下（会溢出可见区）才换另一侧，
 *    两边都放不下就取空得多的一侧，最后由夹取把它拉回可见区；
 * 3. 夹取：整块浮层夹进可见区（四周留 screenMargin），超大浮层退回居中。
 *
 * 入参坐标必须是**屏幕中心系**（与 UI 层各组件一致，即 `节点世界坐标 − LayerManager.UILayer 世界坐标`），
 * 不能用相机 `worldToScreen` 的像素坐标——那是物理像素口径，与设计坐标系差一个 view 缩放系数，
 * 直接相减会让浮层跑到屏幕外（olua 的详情弹窗踩过这个坑）。
 *
 * @param anchorCenter 锚点（物品格）中心的屏幕中心系坐标
 * @param anchorSize 锚点尺寸（浮层按它的边缘算间距，不遮住锚点）
 * @param popupSize 浮层尺寸（自适应高度的浮层要用最终尺寸，撑开后重算一次）
 * @param visibleSize 当前可见尺寸（getVisibleSize，不是设计分辨率）
 * @param gap 浮层与锚点的间距
 * @param screenMargin 浮层到可见区边缘的最小留白
 */
export function getPopupPosition(
  anchorCenter: Vec2,
  anchorSize: Size,
  popupSize: Size,
  visibleSize: Size,
  gap: number,
  screenMargin: number,
): Vec2 {
  const halfVisibleWidth = visibleSize.width / 2;
  const halfVisibleHeight = visibleSize.height / 2;
  const halfAnchorWidth = anchorSize.width / 2;

  // 锚点左右两侧各能放多宽的浮层（算到可见区边缘，去掉留白）
  const rightRoom = halfVisibleWidth - screenMargin - (anchorCenter.x + halfAnchorWidth + gap);
  const leftRoom = anchorCenter.x - halfAnchorWidth - gap - (-halfVisibleWidth + screenMargin);
  // 靠屏幕中间的一侧：左半屏摆右边（+1）、右半屏摆左边（−1）；正中线上按右边
  const towardCenter = anchorCenter.x <= 0 ? 1 : -1;
  const roomAt = (side: number) => (side > 0 ? rightRoom : leftRoom);
  let side = towardCenter;
  if (roomAt(side) < popupSize.width) {
    // 靠中间那侧放不下：换另一侧；两边都不够时取空得多的一侧（夹取会兜底）
    const other = -towardCenter;
    if (roomAt(other) >= popupSize.width || roomAt(other) > roomAt(side)) side = other;
  }

  const x = clampCenter(
    anchorCenter.x + side * (halfAnchorWidth + gap + popupSize.width / 2),
    -halfVisibleWidth + screenMargin + popupSize.width / 2,
    halfVisibleWidth - screenMargin - popupSize.width / 2,
  );
  const y = clampCenter(anchorCenter.y, -halfVisibleHeight + screenMargin + popupSize.height / 2, halfVisibleHeight - screenMargin - popupSize.height / 2);
  return new Vec2(x, y);
}
