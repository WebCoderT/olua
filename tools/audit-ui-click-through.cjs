#!/usr/bin/env node
/**
 * UI 点击穿透与按压归属审计（静态扫描，不参与构建：Cocos 只收 assets/，tools/ 只在本地跑）
 *
 * 背景：引擎的输入派发按事件通道各走一套（pointer-event-dispatcher）——
 * · touch 通道（Node.EventType.TOUCH_*）：Button 组件走这条，TOUCH_START 命中的节点独占本次触摸；
 * · mouse 通道（Node.EventType.MOUSE_*）：按渲染优先级从上到下命中即中断，Button 在这条通道上**不可见**。
 * 于是「只注册 TOUCH_* 的点击元素」压在一个「注册了 MOUSE_* 的元素」上面时，
 * 一次鼠标点击会被派发两次：上面的元素按 touch 通道响应，mouse 通道继续往下找到下面那个元素。
 * 修法是在点击元素上补一次鼠标通道登记（utils/input/UiHit.blockClickThrough）。
 *
 * 但「命中即独占」是有代价的：世界侧的「按住走路」以按下为开始、以抬起为结束
 * （RolePointerInput 听的是全局 input.MOUSE_UP），抬起一旦被界面独占，全局监听就收不到它
 * → 按住状态不解除、角色一直走。所以界面独占抬起时必须把这次按压的结束交还世界侧
 * （utils/input/Pointer 的 releaseWorldPress，见 assets/ui/utils/input/Pointer.ts 的「按压归属」）。
 *
 * 按压归属的其它两条硬约束（前两版分别踩过，本脚本逐条盯住）：
 * · 记的必须是**引擎给出的命中目标**（event.target），不能记「本节点」——节点事件会冒泡，
 *   祖先会在冒泡阶段把内层元素的起点覆盖成自己，弹窗内所有点击会一起失灵；
 * · 登记点必须是**有 UITransform 的界面元素**，不能图省事挂在 UI 根上——UI 根没有 UITransform，
 *   引擎 _sortPointerEventProcessorList 读 `trans!.cameraPriority` 会抛空指针，鼠标交互全废。
 *
 * 本脚本要回答的问题是：
 * 1. **有没有点击元素漏了鼠标通道登记？**（点它会穿透到下层 UI）
 *    扫出所有「touch 点击注册点」，回溯它注册在哪个节点上，判断该节点是否已具备鼠标通道拦截
 *    （直接调了 blockClickThrough，或来自内部已登记的工厂：createButton / createDialog 等）；
 * 2. **有没有 mouse 通道独占点漏了「交还世界侧」？**（会让按住走路卡死）
 *    扫出所有 node.on(Node.EventType.MOUSE_UP/MOUSE_DOWN) 注册点，要求它们都在共用助手里
 *    （bindMousePress / bindPointerAction / blockClickThrough），不要自己裸注册；
 * 3. **有鼠标监听的节点是不是都成了「按压起点登记点」？**（漏了会让抬起判定拿到脏起点）
 *    扫出所有 Node.EventType.MOUSE_* 注册点，要求该节点自身已 trackUiPress，
 *    或所在子树另有登记点（人工核对白名单，须写明理由）；
 * 4. **UI 根有没有被误挂鼠标事件？**（会直接把引擎打崩）
 * 5. 关键接线是否还在（世界侧登记收尾回调、界面独占抬起时交还、记的是命中目标、判定含子树、
 *    UITransform 防呆、世界侧跳过 NPC 按压），以及列出 mouse 通道监听点供人工核对。
 *
 * 用法：node tools/audit-ui-click-through.cjs
 */

const fs = require("fs");
const path = require("path");

const UI_ROOT = path.resolve(__dirname, "../assets/ui");

/** 内部已登记鼠标通道拦截的工厂/工具（点击元素由它们产出即视为覆盖） */
const SHIELD_FACTORIES = [
  "createButton",
  "createTexturedButton",
  "createCloseButton",
  "createBigButton",
  "createMiddleButton",
  "createSmallButtion",
  "createSmallButton",
  "createToggle",
  "createToggleGroup",
  "createScrollView",
  "createDialog",
  "createDialogBg",
  "createRolePreview",
  "createSoulCard",
  "createSoulShowToggle",
  "bindPointerAction",
];

/**
 * 已确认无需在「本处」登记的点击元素（键 = "<相对路径>#<节点变量名>"）
 * 每条都要能说清为什么安全，否则就该去补登记而不是加白名单
 */
const REVIEWED = new Map([
  [
    "assets/ui/components/dialogs/MapPreviewDialog.ts#preview",
    "PC 环境自身即注册了 MOUSE_UP（本处 TOUCH_END 是触屏分支）；且外层弹窗面板已登记",
  ],
  ["assets/ui/components/hud/AutoFightButton.ts#this", "节点由 GameUiHelper.applyAutoFightButtonStyle 登记"],
  ["assets/ui/components/hud/BottomNavButton.ts#this", "节点由 GameUiHelper.applyBottomNavBarButtonStyle 登记"],
  ["assets/ui/components/hud/ShortcutKeySlot.ts#this", "节点由 GameUiHelper.applyShortcutKeyStyle 登记"],
  [
    "assets/ui/components/map/MapObjectSpawner.ts#npcNode",
    "世界侧对象（非 UI 层），刻意不在 mouse 通道登记：登记会顶掉 MOUSE_UP，让世界点击的全局监听收不到（点 NPC 就选不中了）；世界侧改由 markWorldInteractive + LayerManager.isPointOnWorldInteractive 跳过 NPC 上的按下与点击",
  ],
  ["assets/ui/utils/input/Pointer.ts#node", "bindPointerAction / bindMousePress 的内部实现，本身就在鼠标通道登记"],
]);

/**
 * mouse 通道独占点的允许位置（自己裸注册 MOUSE_DOWN/MOUSE_UP 的地方）
 * 只有这两个模块可以裸注册：它们就是「按压归属」的实现本体，独占抬起时负责把结束交还世界侧
 */
const PRESS_HELPER_FILES = new Map([
  [
    "assets/ui/utils/input/Pointer.ts",
    "bindMousePress：登记 MOUSE_UP（独占抬起时 releaseWorldPress()），并调 trackUiPress 记录按压起点、按「起点在本节点或其子树内」决定要不要响应",
  ],
  ["assets/ui/utils/input/UiHit.ts", "blockClickThrough：命中即独占（防穿透），抬起时调 releaseWorldPress() 交还世界侧"],
]);

/**
 * 「有鼠标监听的节点」的核对白名单（键 = "<相对路径>#<节点变量名>"）
 * 这些节点自己没调 trackUiPress，但**所在子树里另有按压起点登记点**（祖先已 blockClickThrough 等），
 * 按下时会靠冒泡把起点记上。每条都要能说清是哪个登记点，说不清就该去补 trackUiPress。
 */
const MOUSE_LISTEN_REVIEWED = new Map([
  [
    "assets/ui/components/dialogs/SkillListDialog.ts#icon",
    "技能图标在 createSkillItem 的 skillIcon 子树内（已 blockClickThrough），且外层弹窗面板已登记",
  ],
  [
    "assets/ui/components/hud/ShortcutKeySlot.ts#this",
    "节点由 GameUiHelper.applyShortcutKeyStyle 登记（内部即 blockClickThrough → trackUiPress）",
  ],
  [
    "assets/ui/helpers/GameUiHelper.ts#sprite",
    "背包/装备格子里的物品图标：格子经 bindPointerAction 登记（内部即 trackUiPress）",
  ],
]);

/** 关键接线（少一条就会重现「按住走路卡死」/「弹窗内点击全废」/「鼠标交互被引擎打崩」，这里逐条盯住） */
const WIRING = [
  [
    "assets/ui/components/input/RolePointerInput.ts",
    /setWorldPressRelease\s*\(/,
    "世界侧登记收尾回调（界面交还抬起时用它解除按住状态）",
  ],
  [
    "assets/ui/components/input/RolePointerInput.ts",
    /isPointOnWorldInteractive\s*\(/,
    "世界侧按下时跳过 NPC 这类可交互对象（否则按一下就先往 NPC 迈步）",
  ],
  ["assets/ui/utils/input/UiHit.ts", /releaseWorldPress\s*\(\)/, "blockClickThrough 独占抬起时交还世界侧"],
  ["assets/ui/utils/input/Pointer.ts", /releaseWorldPress\s*\(\)/, "bindMousePress 独占抬起时交还世界侧"],
  [
    "assets/ui/utils/input/Pointer.ts",
    /pressTarget\s*=\s*event\.target/,
    "留痕记的是「派发的命中目标」——若改成各节点记自己，祖先会在冒泡阶段覆盖内层元素的起点，弹窗内所有点击一起失灵",
  ],
  [
    "assets/ui/utils/input/Pointer.ts",
    /target\.isChildOf\(\s*node\s*\)/,
    "归属判定含子树（格子里的物品图标注册了悬浮事件，点它时命中目标是图标而不是格子）",
  ],
  [
    "assets/ui/utils/input/Pointer.ts",
    /ensureMouseHitTestable\s*\(/,
    "注册鼠标事件前的 UITransform 防呆（无 UITransform 的节点注册鼠标事件会让引擎抛 cameraPriority 空指针）",
  ],
  [
    "assets/ui/utils/input/UiHit.ts",
    /ensureMouseHitTestable\s*\(/,
    "blockClickThrough 也过同一道防呆",
  ],
  [
    "assets/ui/utils/input/Pointer.ts",
    /trackUiPress\(\s*node\s*\)/,
    "bindMousePress 顺手把本节点的按压起点记上（记的是命中目标，与祖先的登记不冲突）",
  ],
  [
    "assets/ui/utils/input/UiHit.ts",
    /trackUiPress\(\s*node\s*\)/,
    "blockClickThrough 顺手把本节点的按压起点记上",
  ],
  [
    "assets/ui/components/hud/StatusIconBar.ts",
    /trackUiPress\(\s*icon\s*\)/,
    "状态图标只注册了悬停事件、链路上没有别的登记点，必须自己登记（否则它的按下会被记成上一次按压的起点）",
  ],
  [
    "assets/ui/components/map/MapObjectSpawner.ts",
    /markWorldInteractive\s*\(/,
    "NPC 节点标记为世界侧可交互对象（没有它前面的跳过判定就永远不成立）",
  ],
  [
    "assets/ui/core/LayerManager.ts",
    /trackUiPress\s*\(|Node\.EventType\.MOUSE_/,
    "UI 根没有 UITransform，**绝不能**在它上面注册鼠标事件（引擎整理监听列表时读 trans!.cameraPriority 会抛空指针）",
    true,
  ],
];

const RE_TOUCH_CLICK = /([A-Za-z_$][\w.$]*)\.(?:on|once)\(\s*Node\.EventType\.TOUCH_(?:END|START)/g;
const RE_MOUSE_NODE_LISTEN = /([A-Za-z_$][\w.$]*)\.(?:on|once)\(\s*Node\.EventType\.MOUSE_(UP|DOWN|ENTER|LEAVE)/g;
const RE_INPUT_MOUSE = /Input\.EventType\.MOUSE_(?:UP|DOWN|MOVE)/g;
const RE_SHIELD_CALL = /blockClickThrough\(([^)]*)\)/g;
const RE_NODE_MOUSE_PRESS = /([A-Za-z_$][\w.$]*)\.(?:on|once)\(\s*Node\.EventType\.MOUSE_(UP|DOWN)/g;
const PRESS_HELPERS = ["bindMousePress", "bindPointerAction", "blockClickThrough"];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** 取某个变量在文件里的赋值来源（首个赋值语句右侧），找不到返回 "" */
function findSource(lines, varName) {
  const re = new RegExp(`\\b${varName.replace(/\./g, "\\.")}\\s*=\\s*([^;\\n]+)`);
  for (const line of lines) {
    const m = line.match(re);
    if (m) return m[1].trim();
  }
  return "";
}

const files = walk(UI_ROOT);
const touchClicks = [];
const mouseListens = [];
const globalMouseListens = [];
const shieldCalls = [];
const mousePressPoints = [];
const fileTexts = new Map();

for (const file of files) {
  const rel = path.relative(path.resolve(__dirname, ".."), file);
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  fileTexts.set(rel, text);

  // 1. touch 通道点击注册点
  RE_TOUCH_CLICK.lastIndex = 0;
  let m;
  while ((m = RE_TOUCH_CLICK.exec(text))) {
    const varName = m[1];
    const lineNo = text.slice(0, m.index).split("\n").length;
    const source = varName === "this" ? "self" : findSource(lines, varName);
    const shieldDirect = new RegExp(`blockClickThrough\\(\\s*${varName.replace(/\./g, "\\.")}\\s*\\)`).test(text);
    const viaFactory = SHIELD_FACTORIES.some((f) => source.includes(f));
    const reviewed = REVIEWED.get(`${rel}#${varName}`);
    touchClicks.push({
      file: rel,
      line: lineNo,
      varName,
      source,
      reviewed,
      verdict: shieldDirect ? "直接登记" : viaFactory ? "工厂已登记" : reviewed ? "已核对" : "待确认",
    });
  }

  // 2. mouse 通道节点监听点：有监听的节点必须是「按压起点登记点」（自身 trackUiPress，或子树里有）
  RE_MOUSE_NODE_LISTEN.lastIndex = 0;
  while ((m = RE_MOUSE_NODE_LISTEN.exec(text))) {
    const varName = m[1];
    const tracked = new RegExp(`trackUiPress\\(\\s*${varName.replace(/\./g, "\\.")}\\s*\\)`).test(text);
    const reviewed = MOUSE_LISTEN_REVIEWED.get(`${rel}#${varName}`);
    mouseListens.push({
      file: rel,
      line: text.slice(0, m.index).split("\n").length,
      varName,
      kind: m[2],
      reviewed,
      verdict: PRESS_HELPER_FILES.has(rel) ? "助手自身" : tracked ? "已登记" : reviewed ? "已核对" : "待确认",
    });
  }
  // 全局 input 鼠标监听（不是节点监听，不受节点命中影响，仅列出）
  RE_INPUT_MOUSE.lastIndex = 0;
  while ((m = RE_INPUT_MOUSE.exec(text))) {
    globalMouseListens.push({ file: rel, line: text.slice(0, m.index).split("\n").length, api: m[0] });
  }

  // 3. blockClickThrough 调用点
  RE_SHIELD_CALL.lastIndex = 0;
  while ((m = RE_SHIELD_CALL.exec(text))) {
    shieldCalls.push({ file: rel, line: text.slice(0, m.index).split("\n").length, arg: m[1].trim() });
  }

  // 4. mouse 通道独占点（按下/抬起登记处）：必须走共用助手
  const isHelperFile = PRESS_HELPER_FILES.has(rel);
  RE_NODE_MOUSE_PRESS.lastIndex = 0;
  while ((m = RE_NODE_MOUSE_PRESS.exec(text))) {
    const viaHelper = isHelperFile || PRESS_HELPERS.some((h) => text.includes(h));
    mousePressPoints.push({
      file: rel,
      line: text.slice(0, m.index).split("\n").length,
      varName: m[1],
      kind: m[2],
      verdict: isHelperFile ? "助手自身" : viaHelper ? "经共用助手" : "待确认",
    });
  }
}

console.log("=== 1. touch 通道点击注册点（点击元素） ===");
const needReview = touchClicks.filter((c) => c.verdict === "待确认");
for (const c of touchClicks) {
  const why = c.reviewed ? `  （${c.reviewed}）` : "";
  console.log(`  [${c.verdict}] ${c.file}:${c.line}  ${c.varName}  <- ${(c.source || "(未找到来源)").slice(0, 70)}${why}`);
}
console.log(`  合计 ${touchClicks.length} 处；已覆盖 ${touchClicks.length - needReview.length} 处；待确认 ${needReview.length} 处`);

console.log("\n=== 2. mouse 通道节点监听点（有监听的节点必须同时是「按压起点登记点」） ===");
const badMouseListens = mouseListens.filter((l) => l.verdict === "待确认");
for (const l of mouseListens) {
  const why = l.reviewed ? `  （${l.reviewed}）` : "";
  console.log(`  [${l.verdict}] ${l.file}:${l.line}  ${l.varName}.on(MOUSE_${l.kind})${why}`);
}
console.log(`  合计 ${mouseListens.length} 处；已登记/已核对 ${mouseListens.length - badMouseListens.length} 处；待确认 ${badMouseListens.length} 处`);
console.log("  —— 全局 input 鼠标监听（不受节点命中影响，仅列出）——");
for (const l of globalMouseListens) console.log(`  ${l.file}:${l.line}  ${l.api}`);
console.log(`  合计 ${globalMouseListens.length} 处`);

console.log("\n=== 3. blockClickThrough 调用点 ===");
for (const s of shieldCalls) console.log(`  ${s.file}:${s.line}  -> ${s.arg}`);
console.log(`  合计 ${shieldCalls.length} 处`);

console.log("\n=== 4. mouse 通道独占点（按下/抬起登记处：独占抬起必须交还世界侧，且必须记按压起点） ===");
const badPressPoints = mousePressPoints.filter((p) => p.verdict === "待确认");
for (const p of mousePressPoints) {
  const note = PRESS_HELPER_FILES.get(p.file);
  console.log(`  [${p.verdict}] ${p.file}:${p.line}  ${p.varName}.on(MOUSE_${p.kind})${note ? `  （${note}）` : ""}`);
}
console.log(`  合计 ${mousePressPoints.length} 处；走共用助手 ${mousePressPoints.length - badPressPoints.length} 处；待确认 ${badPressPoints.length} 处`);

console.log("\n=== 5. 按压归属关键接线 ===");
let wiringBad = 0;
for (const [file, re, why, mustNotMatch] of WIRING) {
  const text = fileTexts.get(file) || "";
  const matched = re.test(text);
  const ok = mustNotMatch ? !matched : matched;
  if (!ok) wiringBad++;
  console.log(`  [${ok ? "OK" : "缺失"}] ${file}  —— ${mustNotMatch ? "不得出现：" : ""}${why}`);
}

console.log("\n=== 结论 ===");
if (needReview.length) {
  console.log("!! 以下点击元素未在鼠标通道登记，点在它上面时可能穿透到下层 UI：");
  for (const c of needReview) console.log(`   ${c.file}:${c.line}  ${c.varName}  <- ${c.source || "(未找到来源)"}`);
}
if (badPressPoints.length) {
  console.log("!! 以下 mouse 通道独占点是自己裸注册的，独占抬起时可能没交还世界侧（按住走路会卡死）：");
  for (const p of badPressPoints) console.log(`   ${p.file}:${p.line}  ${p.varName}.on(MOUSE_${p.kind})  —— 改用 Pointer.bindMousePress / UiHit.blockClickThrough`);
}
if (badMouseListens.length) {
  console.log("!! 以下节点注册了鼠标事件但链路里没有「按压起点登记点」，按下时起点不会被记录（抬起会用到上一次按压的脏起点）：");
  for (const l of badMouseListens) console.log(`   ${l.file}:${l.line}  ${l.varName}.on(MOUSE_${l.kind})  —— 加 Pointer.trackUiPress(${l.varName})，或给它所在容器补 blockClickThrough`);
}
if (wiringBad) console.log(`!! 有 ${wiringBad} 项关键接线缺失：按住走路卡死 / 弹窗内点击全废 / 鼠标交互被引擎打崩 三者之一会重现`);

if (needReview.length || badPressPoints.length || badMouseListens.length || wiringBad) {
  process.exitCode = 1;
} else {
  console.log("PASS：touch 点击元素都在鼠标通道登记；mouse 通道独占点都走共用助手（抬起都会交还世界侧）；有鼠标监听的节点都登记了按压起点；UI 根未被挂鼠标事件；关键接线齐全。");
}
