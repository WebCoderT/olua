import { Size, Vec2 } from "cc";

/**
 * 屏幕尺寸与布局计算（单分辨率 1920×1080）
 *
 * 本作**只有 1920×1080 一个分辨率**：设计分辨率写在项目设置里
 * （`client/settings/v2/packages/project.json` → `general.designResolution`），
 * 运行时既不设置、也不读窗口尺寸 —— 没有「当前可见区」这个概念，
 * 屏幕就是 designResolution，1 个设计像素 = 1080p 下的 1 个屏幕像素。
 *
 * 于是布局只剩纯算术：贴边坐标、全屏遮罩尺寸、浮层夹取全部以 designResolution 为边界。
 * 窗口宽高比不是 16:9 时由引擎按项目设置的比例策略（fitWidth + fitHeight = 等比完整显示、
 * 多余处留黑边）整体缩放，**游戏内坐标与元素相对位置都不受影响**。
 *
 * 代价写在这里，免得下次又「顺手加个适配」：
 * 改分辨率 = 改项目设置 + 改 designResolution，并且所有按 1080p 定的尺寸要重新过一遍；
 * 为了让某个窗口「看起来正好」而引入的等比缩放，会让同一份坐标在不同机器上得出不同画面 ——
 * 那正是这次删掉的东西。
 */

/**
 * 设计分辨率（唯一分辨率）
 *
 * 必须与 `client/settings/v2/packages/project.json` 的 `general.designResolution` 一致 ——
 * 项目设置是引擎启动时真正生效的那一份，这里只是给布局计算用的同名常量。
 * 两个数字靠单测守（client/tools/test-scene-stage.cjs 会直接读 project.json 比对），别手改一处。
 */
export const designResolution = new Size(1920, 1080);

/** 贴边方式：左上 / 右上 / 左下 / 底部居中 */
export type ScreenEdge = "top-left" | "top-right" | "bottom-left" | "bottom-center";

/**
 * 计算「贴边区块」的中心坐标（坐标系以屏幕中心为原点，与 UI 层各常驻组件一致）
 * @param blockSize 区块自身尺寸
 * @param edge 贴哪条边
 * @param marginX 水平边距（区块边缘到屏幕左/右边缘；bottom-center 忽略）
 * @param marginY 垂直边距（top-*：区块上边缘到屏幕上边缘；bottom-left：区块下边缘到屏幕下边缘；
 *   bottom-center：区块中心到屏幕下边缘——底部栏的背景比可视内容高、下沿本就贴着屏幕底边，故按中心定位）
 */
export function getAnchoredPosition(blockSize: Size, edge: ScreenEdge, marginX: number, marginY: number): Vec2 {
  const halfWidth = designResolution.width / 2;
  const halfHeight = designResolution.height / 2;
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
 * 夹取：把值压进 [min, max]；区间本身无解（min > max，例如浮层比屏幕还大）时退回区间中点
 *
 * 中点就是屏幕中心（区间对称：±(半屏边长 − 边距 − 浮层半边长)），于是"塞不下"时浮层居中、
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
 *    于是浮层自然贴着屏幕中间；这一侧放不下（会溢出屏幕）才换另一侧，
 *    两边都放不下就取空得多的一侧，最后由夹取把它拉回屏幕内；
 * 3. 夹取：整块浮层夹进屏幕（四周留 screenMargin），超大浮层退回居中。
 *
 * 入参坐标必须是**屏幕中心系**（与 UI 层各组件一致，即 `节点世界坐标 − LayerManager.UILayer 世界坐标`），
 * 不能用相机 `worldToScreen` 的像素坐标——那是物理像素口径，与设计坐标系差一个 view 缩放系数，
 * 直接相减会让浮层跑到屏幕外（olua 的详情弹窗踩过这个坑）。
 *
 * @param anchorCenter 锚点（物品格）中心的屏幕中心系坐标
 * @param anchorSize 锚点尺寸（浮层按它的边缘算间距，不遮住锚点）
 * @param popupSize 浮层尺寸（自适应高度的浮层要用最终尺寸，撑开后重算一次）
 * @param gap 浮层与锚点的间距
 * @param screenMargin 浮层到屏幕边缘的最小留白
 */
export function getPopupPosition(anchorCenter: Vec2, anchorSize: Size, popupSize: Size, gap: number, screenMargin: number): Vec2 {
  const halfVisibleWidth = designResolution.width / 2;
  const halfVisibleHeight = designResolution.height / 2;
  const halfAnchorWidth = anchorSize.width / 2;

  // 锚点左右两侧各能放多宽的浮层（算到屏幕边缘，去掉留白）
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
