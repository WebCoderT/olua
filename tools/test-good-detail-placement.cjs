#!/usr/bin/env node
/**
 * 物品详情弹窗「摆放」的自动化验证：跑**真实的 ScreenLayout.getPopupPosition / getVisibleSize**
 * （沙箱见 tools/lib/configs-sandbox.cjs，cc 垫片额外补了 screen / view），
 * 再对 GameUiHelper 的接线与 configs/layout/dialogs 的摆放配置做源码断言。
 *
 * 背景（真实用户反馈）：「鼠标放在装备上，弹窗位置偏移得很严重」——
 * 老实现把相机 worldToScreen 的**物理像素**坐标直接减**设计分辨率**的一半，两个口径差一个 view
 * 缩放系数，窗口一大弹窗就飞出屏幕；而且它中途改弹窗（与两个子节点）的锚点，Layout 会按新锚点
 * 重排内容，整块内容又跟着错位。现在改成「屏幕中心系坐标 + 纯函数摆放 + 尺寸撑开后复夹」。
 *
 * 盯的不变量（改摆放逻辑后必须全绿）：
 * · 任意锚点（四角/四边/中心采样）下，弹窗**整块都在可见区内**（四周留 screenMargin）
 * · 水平优先摆锚点**靠屏幕中间的那一侧**（两侧都有空间时也不许往外侧摆）
 * · 有空间时不遮住锚点本身（间距 = placement.gap，恰好贴边）
 * · 竖直与锚点同高居中
 * · 弹窗比可见区还大（夹取无解）时退回中心，不许出 NaN / Infinity
 * · 可见区取「窗口像素 ÷ view 缩放」，不是设计分辨率（引擎未就绪时退回设计分辨率）
 * · 入参不被修改、同入参两次结果相同（纯函数）
 * · 间距/留白全部来自 configs；GameUiHelper 不再混用像素与设计分辨率、不再改锚点
 *
 * 用法：node tools/test-good-detail-placement.cjs
 * 找不到 tsc 时可用环境变量指定：TSC=/path/to/typescript/bin/tsc node tools/test-good-detail-placement.cjs
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, loadCcShim, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const GAME_UI_HELPER_FILE = path.join(PROJECT_ROOT, "assets/ui/helpers/GameUiHelper.ts");
const GAME_HELPER_FILE = path.join(PROJECT_ROOT, "assets/ui/core/GameHelper.ts");
const DIALOGS_FILE = path.join(PROJECT_ROOT, "assets/configs/layout/dialogs.ts");

/**
 * 追加到 cc 垫片末尾的屏幕部分：把 screen / view 做成**可调**的（测试里改窗口尺寸与缩放，
 * 验证「可见区 = 窗口像素 ÷ 缩放」而不是设计分辨率），行为与引擎 NO_BORDER 下的口径一致
 */
const SCREEN_SHIM = `
const __screen = { windowWidth: 1624, windowHeight: 750, scaleX: 1, scaleY: 1 };
const view = {
  getScaleX: () => __screen.scaleX,
  getScaleY: () => __screen.scaleY,
  getDesignResolutionSize: () => new Size(1624, 750),
  // 引擎在 NO_BORDER 下 view.getVisibleSize() 恒等于设计分辨率（故真实可见区不能用它算）
  getVisibleSize: () => new Size(1624, 750),
  setDesignResolutionSize: () => {},
};
const screen = {
  get windowSize() { return new Size(__screen.windowWidth, __screen.windowHeight); },
  on: () => {},
  off: () => {},
};
const ResolutionPolicy = { NO_BORDER: "NO_BORDER", SHOW_ALL: "SHOW_ALL" };
module.exports.view = view;
module.exports.screen = screen;
module.exports.ResolutionPolicy = ResolutionPolicy;
module.exports.__screen = __screen;
`;

let outDir;
try {
  outDir = prepare("olua-good-detail", ["ui/utils/layout/ScreenLayout.ts", "configs/layout/dialogs.ts"], SCREEN_SHIM);
} catch (error) {
  fail(`沙箱准备失败：${error.message}`);
  return;
}

const { getPopupPosition, getVisibleSize } = require(path.join(outDir, "ui/utils/layout/ScreenLayout.js"));
const { goodDetailLayout } = require(path.join(outDir, "configs/layout/dialogs.js"));
const cc = loadCcShim(outDir);
const { Vec2, Size } = cc;

// 位置算完再读回配置，保证断言跟着配置走（改 configs 不用改测试）
const gap = goodDetailLayout.placement.gap;
const screenMargin = goodDetailLayout.placement.screenMargin;
const popupSize = goodDetailLayout.size;
const anchorSize = new Size(50, 50);
const EPS = 1e-6;

/** 设置当前窗口（像素）与缩放 */
function setWindow(width, height, scaleX = 1, scaleY = scaleX) {
  cc.__screen.windowWidth = width;
  cc.__screen.windowHeight = height;
  cc.__screen.scaleX = scaleX;
  cc.__screen.scaleY = scaleY;
}

/** 弹窗实际占的矩形（锚点 0.5/0.5 → 位置就是中心） */
function rectOf(position, size) {
  return {
    left: position.x - size.width / 2,
    right: position.x + size.width / 2,
    bottom: position.y - size.height / 2,
    top: position.y + size.height / 2,
  };
}

/** 矩形是否整块落在可见区内（四周留 margin） */
function isInside(rect, visibleSize, margin) {
  return (
    rect.left >= -visibleSize.width / 2 + margin - EPS &&
    rect.right <= visibleSize.width / 2 - margin + EPS &&
    rect.bottom >= -visibleSize.height / 2 + margin - EPS &&
    rect.top <= visibleSize.height / 2 - margin + EPS
  );
}

const place = (anchorX, anchorY, size = popupSize, anchor = anchorSize) => getPopupPosition(new Vec2(anchorX, anchorY), anchor, size, getVisibleSize(), gap, screenMargin);

const finite = (position) => Number.isFinite(position.x) && Number.isFinite(position.y);
const describe = (position) => `(${position.x.toFixed(1)}, ${position.y.toFixed(1)})`;

console.log("\n— 可见区口径：窗口像素 ÷ view 缩放，不是设计分辨率 —");
setWindow(1624, 750);
check(getVisibleSize().width === 1624 && getVisibleSize().height === 750, "窗口与设计分辨率同尺寸时可见区 = 1624×750", `${getVisibleSize().width}×${getVisibleSize().height}`);
setWindow(2600, 1200, 2);
check(getVisibleSize().width === 1300 && getVisibleSize().height === 600, "窗口 2600×1200、缩放 2 → 可见区 1300×600（用设计分辨率就会算出 1624×750 → 弹窗飞出屏幕）", `${getVisibleSize().width}×${getVisibleSize().height}`);
setWindow(1152, 520, 0.9);
check(Math.abs(getVisibleSize().width - 1152 / 0.9) < EPS && Math.abs(getVisibleSize().height - 520 / 0.9) < EPS, "窗口 1152×520、缩放 0.9 → 可见区随缩放换算");
setWindow(0, 0);
check(getVisibleSize().width === 1624 && getVisibleSize().height === 750, "引擎未就绪（窗口 0×0）→ 退回设计分辨率，不出现 0 尺寸/除零");

console.log("\n— 竖直：与锚点同高居中 —");
setWindow(1624, 750);
[[0, 0], [-300, 120], [420, -260]].forEach(([ax, ay]) => {
  const position = place(ax, ay);
  check(Math.abs(position.y - ay) < EPS, `锚点 y=${ay} → 弹窗中心与锚点同高`, `y=${position.y.toFixed(1)}`);
});

console.log("\n— 水平：优先摆靠屏幕中间的一侧，且不遮住锚点 —");
const center = place(0, 0);
const idealDistance = anchorSize.width / 2 + gap + popupSize.width / 2;
check(Math.abs(center.x - idealDistance) < EPS, "锚点在屏幕正中 → 摆右侧、间距 = 半个锚点 + gap + 半个弹窗", `x=${center.x.toFixed(1)}（期望 ${idealDistance}）`);
check(rectOf(center, popupSize).left - (0 + anchorSize.width / 2) >= gap - EPS, "不遮住锚点：弹窗左边缘与锚点右边缘之间留出 gap");
const onRightHalf = place(400, 0);
check(Math.abs(onRightHalf.x - (400 - idealDistance)) < EPS, "锚点在右半屏、两侧都有空间 → 仍摆**左侧**（靠屏幕中间那侧）", `x=${onRightHalf.x.toFixed(1)}（若摆右侧会是 ${(400 + idealDistance).toFixed(1)}）`);
check(400 - anchorSize.width / 2 - rectOf(onRightHalf, popupSize).right >= gap - EPS, "摆左侧同样不遮住锚点");
const onLeftHalf = place(-400, 0);
check(Math.abs(onLeftHalf.x - (-400 + idealDistance)) < EPS, "锚点在左半屏 → 摆右侧（靠屏幕中间那侧）", `x=${onLeftHalf.x.toFixed(1)}`);

console.log("\n— 锚点贴边：换到有空间的一侧，仍整块可见 —");
[
  [-800, 0, "最左"],
  [800, 0, "最右"],
  [0, 360, "最上"],
  [0, -360, "最下"],
].forEach(([ax, ay, label]) => {
  const position = place(ax, ay);
  const rect = rectOf(position, popupSize);
  check(finite(position) && isInside(rect, getVisibleSize(), screenMargin), `锚点在最${label.slice(1)}（${ax},${ay}）→ 弹窗整块在可见区内`, describe(position));
});

console.log("\n— 全屏采样：任意锚点都整块可见 —");
const sizes = [
  [1624, 750, 1],
  [2600, 1200, 2],
  [1152, 520, 0.9],
  [900, 620, 1.2],
];
let sampled = 0;
let escaped = [];
let finiteBad = [];
sizes.forEach(([w, h, scale]) => {
  setWindow(w, h, scale);
  const visible = getVisibleSize();
  const xs = [-visible.width / 2, -visible.width / 4, 0, visible.width / 4, visible.width / 2];
  const ys = [-visible.height / 2, -visible.height / 4, 0, visible.height / 4, visible.height / 2];
  xs.forEach((ax) =>
    ys.forEach((ay) => {
      const position = place(ax, ay);
      sampled++;
      if (!finite(position)) finiteBad.push(`${w}×${h}/${scale} (${ax},${ay})`);
      else if (!isInside(rectOf(position, popupSize), visible, screenMargin)) escaped.push(`${w}×${h}/${scale} (${ax},${ay}) → ${describe(position)}`);
    }),
  );
});
check(finiteBad.length === 0, `${sampled} 组锚点全部算出有限坐标（无 NaN/Infinity）`, finiteBad.slice(0, 3).join(" | "));
check(escaped.length === 0, `${sampled} 组锚点下弹窗全部整块留在可见区内（含窗口比设计分辨率小的情况）`, escaped.slice(0, 3).join(" | "));

console.log("\n— 极端尺寸：塞不下时退回居中，不许跑到屏幕外/出 NaN —");
setWindow(1200, 300);
const tooTall = new Size(popupSize.width, 444);
const tallPlace = place(0, 0, tooTall);
check(Number.isFinite(tallPlace.x) && Number.isFinite(tallPlace.y), "弹窗（444）比可见区（300）还高 → 坐标仍有限", describe(tallPlace));
check(Math.abs(tallPlace.y) < EPS, "塞不下 → 竖直退回屏幕中心（上下各溢出一半，而不是推到某侧屏幕外）", `y=${tallPlace.y.toFixed(1)}`);
setWindow(200, 750);
const tooWide = new Size(400, 200);
const widePlace = place(0, 0, tooWide);
check(Number.isFinite(widePlace.x) && Math.abs(widePlace.x) < EPS, "弹窗（400）比可见区（200）还宽 → 水平退回屏幕中心", `x=${widePlace.x.toFixed(1)}`);

console.log("\n— 纯函数：不改入参、同入参同结果 —");
setWindow(1624, 750);
const anchorCenter = new Vec2(300, -120);
const anchorBox = new Size(50, 50);
const visible = getVisibleSize();
const snapshot = `${anchorCenter.x},${anchorCenter.y}|${anchorBox.width},${anchorBox.height}|${visible.width},${visible.height}`;
const first = getPopupPosition(anchorCenter, anchorBox, popupSize, visible, gap, screenMargin);
const second = getPopupPosition(anchorCenter, anchorBox, popupSize, visible, gap, screenMargin);
check(first.x === second.x && first.y === second.y, "同入参两次调用结果完全一致");
check(`${anchorCenter.x},${anchorCenter.y}|${anchorBox.width},${anchorBox.height}|${visible.width},${visible.height}` === snapshot, "入参（锚点中心/尺寸/可见区）未被修改");

console.log("\n— 间距与留白来自配置，改配置即生效 —");
const withGap = (value) => getPopupPosition(new Vec2(0, 0), anchorSize, popupSize, getVisibleSize(), value, screenMargin);
check(Math.abs(withGap(gap + 12).x - withGap(gap).x - 12) < EPS, "gap 变大 12 → 理想位置同步外移 12（配置真的被用上）");
const marginValues = [4, 8, 20, 60];
setWindow(1624, 750);
const clamped = marginValues.map((margin) => getPopupPosition(new Vec2(100000, 0), anchorSize, popupSize, getVisibleSize(), gap, margin));
check(clamped.every((position, index) => Math.abs(position.x - (1624 / 2 - marginValues[index] - popupSize.width / 2)) < EPS), "锚点远在屏幕外 → 弹窗被夹到「可见区边缘 − screenMargin」，留白值直接生效", clamped.map(describe).join(" "));

console.log("\n— 配置：goodDetailLayout.placement —");
check(gap > 0 && screenMargin > 0, "placement 已登记（gap / screenMargin 均为正）", `gap=${gap}, screenMargin=${screenMargin}`);
check(!!goodDetailLayout.size.width && !!goodDetailLayout.size.height, "弹窗仍用配置里的占位尺寸（首帧量到的就是它，撑开后复夹）", `${goodDetailLayout.size.width}×${goodDetailLayout.size.height}`);

console.log("\n— 接线：GameUiHelper 的摆放口径 —");
const helperSource = fs.readFileSync(GAME_UI_HELPER_FILE, "utf8");
const helperCode = helperSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const gameHelperSource = fs.readFileSync(GAME_HELPER_FILE, "utf8");
const dialogsSource = fs.readFileSync(DIALOGS_FILE, "utf8");

check(/getPopupPosition\(/.test(helperCode), "详情弹窗位置走 ScreenLayout.getPopupPosition（摆放算法只有一个来源）");
check(/getVisibleSize\(\)/.test(helperCode), "夹取用的是真实可见尺寸 getVisibleSize()（不是设计分辨率）");
check(/anchorWorld\.x - layerWorld\.x/.test(helperCode) && /anchorWorld\.y - layerWorld\.y/.test(helperCode), "锚点坐标取「物品格世界坐标 − UI 层世界坐标」（屏幕中心系）");
check(/createGoodDetailDialog\(good, cell\)/.test(helperCode), "调用点把物品格节点交给弹窗（坐标与尺寸都由它现算）");
check(/getComponent\(UITransform\)\?\.contentSize \?\? goodDetailLayout\.size/.test(helperCode), "物品格尺寸取不到时退回弹窗配置尺寸（不会算出 NaN）");
check(/Node\.EventType\.SIZE_CHANGED/.test(helperSource) && /placeGoodDetailDialog/.test(helperSource), "Layout 自适应高度撑开后按最终尺寸复夹一次（首帧用的是占位高度）");
check(/goodDetailLayout\.placement\.gap/.test(helperCode) && /goodDetailLayout\.placement\.screenMargin/.test(helperCode), "间距与留白全从 configs 读，组件不写数值");

console.log("\n— 回归：老 bug 不许回来 —");
check(!/screenPosition\.x - screenSize\.width \/ 2/.test(helperCode), "不再用「相机像素坐标 − 设计分辨率的一半」（两个口径差一个 view 缩放系数 → 位置严重偏移）");
check(!/worldPositionToScreenPosition/.test(helperCode) && !/worldPositionToScreenPosition/.test(gameHelperSource), "已删掉「世界 → 屏幕像素」接口，避免又被当成 UI 摆放坐标用");
check(/物理像素/.test(gameHelperSource), "GameHelper 里写明了像素口径不能用于摆 UI（并指向屏幕中心系的做法）");
check(!/dialog\.getComponent\(UITransform\)\.anchor/.test(helperCode) && !/contentHeader\.getComponent\(UITransform\)\.anchor/.test(helperCode), "不再中途改弹窗与子节点的锚点（Layout 会按新锚点重排，整块内容跟着错位）");
check(!/screenPosition: Vec3/.test(helperCode) && !/screenSize/.test(helperCode), "详情弹窗已不再吃像素坐标（没 screenPosition 参数、也没设计分辨率一半的换算）");

finish("PASS：详情弹窗摆放（靠中间 + 整块可见 + 任意锚点/窗口）与接线全部通过。");
