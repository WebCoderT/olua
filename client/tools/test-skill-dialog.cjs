#!/usr/bin/env node
/**
 * 技能列表弹窗的开关语义（client/tools/test-skill-dialog.cjs，issue #738）
 *
 * 盯的不变量（都是**结构接线**，跑不了真实 cc，所以读源码断言）：
 *   1. `SkillListDialog` 持有弹窗节点引用 —— 没有引用就不可能「再点关掉」；
 *   2. `open()` 先判「已开且有效」就 `close()` 返回（开关语义，与背包 / 商城 / 任务同一范式）；
 *   3. 引导事件 `OPEN_SKILL` 只发在**真打开**分支里（切换关闭不该被当成学会了）；
 *   4. `close()` 收掉三样东西：子弹窗（快捷键设置）、悬停提示、弹窗节点本身；
 *   5. 底栏「技能」入口走的就是这个 `open()`。
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

  console.log("\n— A. 弹窗持有节点引用 —");
  check(/private dialog: Node \| null = null;/.test(skillSource), "持有弹窗节点引用（切换关闭的前提）");
  check(/this\.dialog = dialog;/.test(skillSource), "open 里把新建节点存进引用");
  check(/import \{[^}]*isValid[^}]*\} from "cc";/.test(skillSource), "从 cc 引入 isValid（销毁后判引用是否还有效）");

  console.log("— B. open 是开关 —");
  const openBody = skillSource.slice(skillSource.indexOf("open() {"), skillSource.indexOf("close() {"));
  check(
    /if \(this\.dialog && isValid\(this\.dialog\) && this\.dialog\.active\) \{\s*\n\s*this\.close\(\);\s*\n\s*return;/.test(openBody),
    "已开且有效 → close() 后返回（再点即关，不再叠一个）",
  );
  check(
    /if \(this\.dialog && !isValid\(this\.dialog\)\) this\.dialog = null;/.test(openBody),
    "关闭按钮 / 场景切换销毁了节点时清残留引用（不清会永远判成「已开」）",
  );
  const notifyIndex = openBody.indexOf("GuideStore.notify(GUIDE_EVENT.OPEN_SKILL)");
  const toggleIndex = openBody.indexOf("isValid(this.dialog)");
  check(notifyIndex > 0 && toggleIndex > 0 && notifyIndex > toggleIndex, "引导事件在开关判据之后（切换关闭不算一次真打开）");

  console.log("— C. close 收干净 —");
  const closeBody = skillSource.slice(skillSource.indexOf("close() {"));
  check(/this\.shortcutKeySettingDialog\.close\(\);/.test(closeBody), "连同快捷键子弹窗一起关（它挂在 UI 层，不随列表销毁）");
  check(/HoverTipManager\.hide\(\);/.test(closeBody), "收掉可能还挂着的悬停技能详情");
  check(/if \(this\.dialog && isValid\(this\.dialog\)\) this\.dialog\.destroy\(\);/.test(closeBody), "销毁弹窗节点（先判有效，已被关闭按钮销毁时跳过）");
  check(/this\.dialog = null;/.test(closeBody), "引用置空（下次 open 重新建）");

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
