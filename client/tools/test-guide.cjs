#!/usr/bin/env node
/**
 * 新手引导（#402）的自动化验证
 *
 * 跑**真代码**，不是复刻一份逻辑：
 * - 推进 / 跳过的判定是 `ui/utils/guide/guide-progress` 的纯函数；
 * - 存档读写走真的 `StorageManager`（沙箱见 client/tools/lib/storage-sandbox.cjs，
 *   `cc` 垫片提供内存版 localStorage，角色落盘是真的发生）；
 * - 进度落盘 / 续走走真的 `GuideStore`。
 *
 * 覆盖：
 * A. 步骤表是数据：id 唯一 / 文案非空 / 触发与高亮目标都在枚举内
 * B. 推进：只有当前步的 trigger 能推进，别的事件不越级；走完置 done；「下一步」无条件前进
 * C. 老档与坏值：读不到 guide（或值坏了）一律按「已完成」，老号不弹
 * D. 存档续走：新角色从第 0 步开始；推进后落盘、重新读回还在原步
 * E. 跳过：显式跳过落 skipped，之后不再弹也不再推进
 * F. 接线契约：组合根起停、三个面板与两个玩法事件真的 notify 了、遮罩不拦点击、两个按钮各自接线
 * G. 气泡排版：正文放得下、折两行也不压底部那一行、底部两个按钮不与进度文字重叠
 *
 * 用法：node client/tools/test-guide.cjs
 */
const fs = require("fs");
const path = require("path");
const { prepareStorage } = require("./lib/storage-sandbox.cjs");
const { PROJECT_ROOT, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const GAME_FILE = path.join(PROJECT_ROOT, "assets/ui/Game.ts");
const OVERLAY_FILE = path.join(PROJECT_ROOT, "assets/ui/components/GuideOverlay.ts");
const ROLE_DATA_UTIL = path.join(PROJECT_ROOT, "../server/src/modules/roles/role-data.util.ts");
const DIALOGS = ["BagDialog", "SkillListDialog", "ChatDialog"].map((name) => ({
  name,
  file: path.join(PROJECT_ROOT, `assets/ui/components/dialogs/${name}.ts`),
}));

let sandbox;
try {
  // configs/layout/sizes.ts 只是为了让排版守点能拿到真实按钮尺寸（UI 层不能进沙箱，配置可以）
  sandbox = prepareStorage("olua-guide", [
    "ui/core/GuideStore.ts",
    "ui/utils/guide/guide-progress.ts",
    "configs/layout/sizes.ts",
  ]);
} catch (error) {
  fail(`沙箱准备失败：${error.message}`);
  return;
}

const { StorageManager, Role, outDir, shim } = sandbox;
const requireOut = (rel) => require(path.join(outDir, rel));
const guideLogic = requireOut("ui/utils/guide/guide-progress.js");
const GuideStore = requireOut("ui/core/GuideStore.js").default;
const guideConfig = requireOut("configs/guide.js");
const guideTypes = requireOut("types/guide.js");
const uiSize = requireOut("configs/layout/sizes.js").uiSize;

const steps = guideConfig.guideSteps;
const stepCount = steps.length;
const read = (rel) => fs.readFileSync(rel, "utf8");

/** 造一个角色（Role 的 id 取时间戳，同毫秒会撞，测试里显式指定） */
function makeRole(id, name = "引导测试") {
  const role = new Role(name, "1", "1");
  role.id = id;
  return role;
}

//#region A. 步骤表是数据

console.log("— A. 步骤表：数据驱动，加一步不用改代码 —");

check(stepCount > 0, "至少有一步引导", `${stepCount} 步`);
check(new Set(steps.map((step) => step.id)).size === stepCount, "步骤 id 唯一（落日志与断言都靠它）", steps.map((step) => step.id).join("/"));
check(
  steps.every((step) => step.title.length > 0 && step.desc.length > 0),
  "每一步都有标题与正文（文案全在配置里，改文案不用碰代码）",
);
const eventValues = Object.values(guideTypes.GUIDE_EVENT);
const spotValues = Object.values(guideTypes.GUIDE_SPOT);
check(
  steps.every((step) => eventValues.includes(step.trigger)),
  "每一步的触发事件都在事件枚举内（配错成字符串会在推进时永不命中）",
  steps.map((step) => step.trigger).join("/"),
);
check(
  steps.every((step) => spotValues.includes(step.spot)),
  "每一步的高亮目标都在语义位枚举内（写错会静默退化成只有气泡）",
  steps.map((step) => step.spot).join("/"),
);

//#endregion

//#region B. 推进

console.log("— B. 推进：只有当前步的 trigger 能推进 —");

const first = guideLogic.newGuideProgress();
check(first.step === 0 && !first.done && !first.skipped, "新进度从第 0 步开始");
check(
  guideLogic.advanceGuide(first, steps[0].trigger, guideTypes.GUIDE_EVENT.OPEN_BAG, stepCount) === null,
  "非当前步的事件不越级（先点背包不会把「走路」这一步吃掉）",
);
const afterOne = guideLogic.advanceGuide(first, steps[0].trigger, steps[0].trigger, stepCount);
check(afterOne && afterOne.step === 1 && !afterOne.done, "当前步的 trigger 命中 → 前进一步", JSON.stringify(afterOne));
let walked = guideLogic.newGuideProgress();
for (let index = 0; index < stepCount; index++) walked = guideLogic.advanceGuide(walked, steps[index].trigger, steps[index].trigger, stepCount);
check(walked && walked.step === stepCount && walked.done === true, "走完最后一步置 done", JSON.stringify(walked));
check(guideLogic.advanceGuide(walked, steps[0].trigger, steps[0].trigger, stepCount) === null, "done 之后再收到事件不再推进");
check(guideLogic.shouldRunGuide(walked, stepCount) === false, "done 之后不显示引导");

// 「下一步」是第二条推进路径：不看当前步的 trigger，玩家点了就前进
const nudged = guideLogic.nextGuide(first, stepCount);
check(nudged && nudged.step === 1 && !nudged.done, "「下一步」不看触发事件直接前进（不做动作也能往下走）", JSON.stringify(nudged));
check(guideLogic.nextGuide(guideLogic.skipGuide(first), stepCount) === null, "跳过后「下一步」不再推进（skip 不是临时状态）");
check(guideLogic.nextGuide(walked, stepCount) === null, "走完之后「下一步」不再推进（不会越过末尾，也不会把 done 洗掉）");
let byNext = guideLogic.newGuideProgress();
for (let index = 0; index < stepCount; index++) byNext = guideLogic.nextGuide(byNext, stepCount);
check(byNext && byNext.step === stepCount && byNext.done === true, "连点「下一步」能一路走到完成（与走完是同一条落账）", JSON.stringify(byNext));

//#endregion

//#region C. 老档与坏值

console.log("— C. 老档与坏值：读不到就按「已完成」，老号不弹 —");

const legacy = guideLogic.normalizeGuideProgress(undefined, stepCount);
check(legacy.done === true && legacy.skipped === false, "没有 guide 字段的老档 → 已完成（老号不弹）", JSON.stringify(legacy));
check(guideLogic.normalizeGuideProgress({ step: 999, done: false }, stepCount).done === true, "步数越界（被改包）→ 已完成，不把玩家卡在引导里");
check(guideLogic.normalizeGuideProgress({ step: 1.5, done: false }, stepCount).done === true, "步数不是整数 → 已完成");
check(
  guideLogic.normalizeGuideProgress({ step: 2, done: false, skipped: false }, stepCount).step === 2,
  "合法进度原样保留（重连续走靠这个）",
);
check(guideLogic.shouldRunGuide(legacy, stepCount) === false, "已完成的老档不显示引导");

//#endregion

//#region D. 存档续走（真 StorageManager + 真 GuideStore）

console.log("— D. 存档续走：进度在存档里，重连还在原步 —");

StorageManager.clear();
const fresh = makeRole("guide_new");
StorageManager.setRoles([fresh]);
StorageManager.onlineRole("guide_new");
check(fresh.guide && fresh.guide.step === 0 && !fresh.guide.done, "新建角色自带第 0 步（新号天然会弹引导）", JSON.stringify(fresh.guide));

GuideStore.start(StorageManager.findOnlineRole());
check(GuideStore.visible() === true, "start 之后引导可见（新号首登走一遍）");
GuideStore.notify(steps[1].trigger);
check(GuideStore.current().step === 0, "不是当前步的事件不推进（第 0 步还在）");
GuideStore.notify(steps[0].trigger);
check(GuideStore.current().step === 1, "当前步事件推进到第 1 步");
GuideStore.notify(steps[0].trigger);
check(GuideStore.current().step === 1, "重复收到同一个事件不会连跳两步");
check(StorageManager.findOnlineRole().guide.step === 1, "进度已写回角色存档（换设备 / 重连都从这一步继续）");
check(JSON.parse(sandbox.shim.__memory.get("roles"))[0].guide.step === 1, "存档文件里真的是第 1 步（不是只在内存对象上）");

// 模拟「重连」：存档原样读回 → start 之后仍在第 1 步
GuideStore.reset();
GuideStore.start(StorageManager.findOnlineRole());
check(GuideStore.current().step === 1 && GuideStore.visible() === true, "重连后从存档的第 1 步继续（断点续走）");

// 「下一步」按钮走的是同一个落账路径（真仓 + 真存档）
GuideStore.next();
check(GuideStore.current().step === 2 && GuideStore.visible() === true, "点「下一步」推进一步（不需要先做对应动作）");
check(StorageManager.findOnlineRole().guide.step === 2, "「下一步」推进的进度同样写回存档");

// 老档（没有 guide 字段）经 ensureRoleDefaults 补成「已完成」
const legacyRole = makeRole("guide_old");
delete legacyRole.guide;
StorageManager.setRoles([legacyRole]);
StorageManager.onlineRole("guide_old");
StorageManager.ensureRoleDefaults(legacyRole);
check(legacyRole.guide && legacyRole.guide.done === true, "老档补齐成「已完成」（不弹）", JSON.stringify(legacyRole.guide));
GuideStore.start(legacyRole);
check(GuideStore.visible() === false, "老号进游戏不弹引导");

//#endregion

//#region E. 跳过

console.log("— E. 跳过：显式选择，落存档后不再弹 —");

const skipper = makeRole("guide_skip");
StorageManager.setRoles([skipper]);
StorageManager.onlineRole("guide_skip");
GuideStore.start(skipper);
GuideStore.skip();
check(GuideStore.current().skipped === true && GuideStore.visible() === false, "点跳过后立刻隐藏");
check(StorageManager.findOnlineRole().guide.skipped === true, "跳过是显式选择，落进存档（不是只记在内存）");
GuideStore.notify(steps[0].trigger);
check(GuideStore.current().skipped === true && GuideStore.current().step === 0, "跳过后再收到事件也不再推进");
GuideStore.reset();
GuideStore.start(StorageManager.findOnlineRole());
check(GuideStore.visible() === false, "重连 / 重启后仍然不弹（skip 不是临时状态）");

//#endregion

//#region F. 接线契约

console.log("— F. 接线契约：事件源与遮挡纪律 —");

const game = read(GAME_FILE);
const overlay = read(OVERLAY_FILE);
check(/GuideStore\.start\(role\)/.test(game), "组合根进游戏时用角色存档启动引导");
check(/GuideOverlay\.setSpotProvider\(\(spot\) => this\.resolveGuideSpot\(spot\)\)/.test(game), "组合根注册「语义位 → 节点」解析器（不写死坐标）");
check(/GuideStore\.reset\(\)/.test(game) && /GuideOverlay\.setSpotProvider\(null\)/.test(game), "离开游戏时清进度并摘掉解析器（否则指向已销毁的 HUD）");
check(/GuideStore\.notifyMove\(/.test(game), "移动事件按实际位移喂给引导（摇杆 / 方向键 / 点地面都算）");
check(!/blockClickThrough|addComponent\(Button\)/.test(overlay), "遮罩不拦点击（引导绝不锁操作：卡死即事故）");
check(/GuideStore\.skip\(\)/.test(overlay), "气泡上的跳过按钮直接调 GuideStore.skip");
check(/GuideStore\.next\(\)/.test(overlay), "气泡上的「下一步」按钮直接调 GuideStore.next（与事件推进共用落账路径）");
check(
  /names\.nextLabel/.test(overlay) && guideConfig.guideOverlayStyle.names.nextLabel === `${guideConfig.guideOverlayStyle.names.next}_label`,
  "「完成」文案取的是按钮里那个文字节点（名 = 按钮名 + _label，与 createMiddleButton 的约定一致）",
);
check(/GUIDE_EVENT\.OPEN_BAG/.test(read(DIALOGS[0].file)), "打开背包 → 通知引导");
check(/GUIDE_EVENT\.OPEN_SKILL/.test(read(DIALOGS[1].file)), "打开技能 → 通知引导");
check(/GUIDE_EVENT\.OPEN_CHAT/.test(read(DIALOGS[2].file)), "打开聊天 → 通知引导");
check(/GUIDE_EVENT\.KILL/.test(read(path.join(PROJECT_ROOT, "assets/ui/core/MonsterManager.ts"))), "击杀（死亡分支）→ 通知引导");
check(/GUIDE_EVENT\.PICKUP/.test(read(path.join(PROJECT_ROOT, "assets/ui/core/DropManager.ts"))), "拾取成功 → 通知引导");
check(/normalizeGuide\(source\.guide\)/.test(read(ROLE_DATA_UTIL)), "服务端对 guide 做结构 + 体量校验（不认识客户端的步骤含义）");

//#endregion

//#region G. 气泡排版自洽

console.log("— G. 气泡排版：正文放得下、折两行也不压底部那一行 —");

const bubble = guideConfig.guideConfig.layout;
const innerWidth = bubble.bubbleWidth - bubble.bubblePadding * 2;
// 最长那句正文 24 个汉字，20 号字约 480 —— 可用宽必须比它宽，否则末行只剩「手。」（#466）
check(innerWidth >= 500, "正文可用宽 ≥ 500（放得下最长那句）", `bubbleWidth ${bubble.bubbleWidth} − padding ${bubble.bubblePadding}×2 = ${innerWidth}`);
// 正文锚点在顶边（#462）：起点在标题占位下方，高度按「折两行」估
const descTop = bubble.bubbleHeight / 2 - bubble.bubblePadding - bubble.titleFontSize * 1.4 - bubble.descGap;
const descBottom = descTop - bubble.descFontSize * 1.5 * 2;
// 底部行 = 进度文字（中心 y 与盒高见 GuideOverlay.createBubble）
const progressTop = -bubble.bubbleHeight / 2 + bubble.bubblePadding + bubble.progressFontSize / 2 + (bubble.progressFontSize * 1.4) / 2;
check(
  descBottom > progressTop,
  "正文折两行时仍高于底部进度行（否则最后一行会压在「新手引导 x/6」上）",
  `正文底 ${descBottom.toFixed(1)} vs 进度顶 ${progressTop.toFixed(1)}`,
);

// 底部那一行现在并排两个中号按钮（跳过 + 下一步），位置算法见 GuideOverlay.layoutButtons：
// 右对齐 → 下一步贴右缘，跳过排在它左侧，间距 buttonGap
const buttonWidth = uiSize.middleButtonSize.width;
const buttonHeight = uiSize.middleButtonSize.height;
const rightEdge = bubble.bubbleWidth / 2 - bubble.bubblePadding;
const buttonLeft = rightEdge - buttonWidth * 2 - bubble.buttonGap;
check(
  buttonLeft > -innerWidth / 2,
  "两个按钮放得进气泡（不会从左边溢出去）",
  `按钮左缘 ${buttonLeft} vs 气泡内左边 ${-innerWidth / 2}`,
);
// 进度文字：中心 x = -inner/2 + 70、盒宽 160（见 GuideOverlay.createBubble），右缘不能压到「跳过」
const progressRight = -innerWidth / 2 + 70 + 160 / 2;
check(
  progressRight < buttonLeft,
  "进度文字与按钮行不重叠（文字在左、按钮在右）",
  `进度右缘 ${progressRight} vs 按钮左缘 ${buttonLeft}`,
);
// 按钮行的上沿不能顶到正文（正文底边 descBottom，折两行）
const buttonTop = -bubble.bubbleHeight / 2 + bubble.bubblePadding + buttonHeight;
check(
  descBottom > buttonTop,
  "正文折两行时仍高于按钮行（否则按钮会盖住正文最后一行）",
  `正文底 ${descBottom.toFixed(1)} vs 按钮顶 ${buttonTop.toFixed(1)}`,
);

//#endregion

finish("新手引导（#402）：步骤表 / 推进 / 老档 / 续走 / 跳过 / 下一步 / 接线 / 排版");
