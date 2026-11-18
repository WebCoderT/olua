#!/usr/bin/env node
/**
 * 技能列表弹窗的开关语义（client/tools/test-skill-dialog.cjs，issue #738）
 *
 * 盯的不变量（都是**结构接线**，跑不了真实 cc，所以读源码断言）：
 *   1. `SkillListDialog` 继承 BaseDialog（#1115 批次 4）—— 开关节点引用与销毁统一在骨架里；
 *   2. 引导事件 `OPEN_SKILL` 只发在**真打开**分支里（`openFrame` 返回 true 才发，切换关闭不该被当成学会了）；
 *   3. `onClose()` 收掉两样东西：子弹窗（快捷键设置）、悬停提示（弹窗节点本身由 BaseDialog 销毁）；
 *   4. 底栏「技能」入口走的就是这个 `open()`。
 *
 * 用法：node client/tools/test-skill-dialog.cjs
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const SKILL_DIALOG_FILE = path.join(PROJECT_ROOT, "assets/ui/components/dialogs/SkillListDialog.ts");
const SHORTCUT_DIALOG_FILE = path.join(PROJECT_ROOT, "assets/ui/components/dialogs/SkillShortcutSettingDialog.ts");
const BOTTOM_BAR_FILE = path.join(PROJECT_ROOT, "assets/ui/components/hud/BottomBar.ts");

try {
  const skillSource = fs.readFileSync(SKILL_DIALOG_FILE, "utf8");
  const shortcutSource = fs.readFileSync(SHORTCUT_DIALOG_FILE, "utf8");
  const bottomBarSource = fs.readFileSync(BOTTOM_BAR_FILE, "utf8");

  console.log("\n— A. 弹窗走 BaseDialog 骨架 —");
  check(/extends BaseDialog/.test(skillSource), "继承 BaseDialog（开关节点引用与销毁统一在骨架里，切换关闭的前提）");
  check(/this\.openFrame\(/.test(skillSource), "open 里走 openFrame（骨架由基类建，不再自建）");

  console.log("— B. open 是开关（开关语义在 BaseDialog） —");
  const openBody = skillSource.slice(skillSource.indexOf("open() {"), skillSource.indexOf("protected onClose()"));
  check(
    /if \(opened\) GuideStore\.notify\(GUIDE_EVENT\.OPEN_SKILL\);/.test(openBody),
    "引导事件只发在真打开分支（openFrame 返回 true 才发，切换关闭不算一次真打开）",
  );

  console.log("— C. onClose 收干净 —");
  const closeBody = skillSource.slice(skillSource.indexOf("protected onClose() {"));
  check(/this\.shortcutKeySettingDialog\.close\(\);/.test(closeBody), "连同快捷键子弹窗一起关（它挂在 UI 层，不随列表销毁）");
  check(/HoverTipManager\.hide\(\);/.test(closeBody), "收掉可能还挂着的悬停技能详情");
  // 弹窗节点本身的销毁与引用置空由 BaseDialog.close 统一做（dialog-kit 的守点在 test-dialog-top）

  console.log("— D. 与同类弹窗同一范式 —");
  check(/private dialog: Node \| null = null;/.test(shortcutSource), "快捷键设置弹窗同样持有节点引用");
  check(/open\(role: Role, skillId: SkillId\) \{\s*\n\s*this\.close\(\);/.test(shortcutSource), "快捷键弹窗重复打开先关上一个（不叠加）");
  check(/skill: \(\) => this\.skillListDialog\.open\(\),/.test(bottomBarSource), "底栏「技能」入口走的就是 open()（开关语义才生效）");

  console.log("— E. 没有裸中文（注释之外） —");
  check(
    !/[\u4e00-\u9fa5]/.test(skillSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")),
    "SkillListDialog 里没有裸中文（文案走 configs/texts / hudLayout）",
  );

  finish("技能列表弹窗：开关语义与清理接线全部通过");
} catch (error) {
  fail(error);
}
