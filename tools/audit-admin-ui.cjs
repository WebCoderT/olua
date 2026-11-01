#!/usr/bin/env node
/**
 * 管理端界面一致性审计（静态扫描 `admin/src/pages`，不参与构建）
 *
 * 为什么要有它：管理端三十多个页面是分批写的，同一件事被写了两三遍 ——
 * 页头各写一份 `<div><h1…/><p…/></div>`（字号从 `text-lg` 漂到 `text-xl`）、
 * 弹窗各写一份 `fixed inset-0`（宽度、Esc、遮罩关闭各一套）、卡片各写一份
 * `rounded-2xl border border-slate-800 bg-slate-900/40`、字段标签各写一份 `<span>`。
 * #562 把这些收口到 `PageHeader` / `Modal` / `Card` / `Field` 之后，**没有守点就等于没做** ——
 * 下一个页面照着旧代码抄一遍，半年后又回到三种写法。
 *
 * 扫描范围只有 `pages/`：`components/` 是这些组件的实现处（`Modal` 自己就要写遮罩），
 * 拿同一套规则卡它会变成一堆假 FAIL，而假 FAIL 会让人学会无视这个审计。
 *
 * 四条规则：
 * 1. **不许手写全屏遮罩**（`fixed inset-0`）→ 用 `components/Modal.tsx`；
 * 2. **不许手写页头**（`<h1`）→ 用 `components/PageHeader.tsx`；
 *    例外：登录 / 注册页的标题是「应用名」，不是页面头，走白名单（见 EXEMPT）；
 * 3. **不许手写字段标签**（`mb-1.5 block text-xs font-medium`）→ 用 `Field`；
 * 4. **不许手写卡片外壳**（`rounded-2xl border border-slate-800 bg-slate-900/40`）→ 用 `Card`。
 *
 * 用法：node tools/audit-admin-ui.cjs
 */

const fs = require("node:fs");
const path = require("node:path");

const PAGES = path.resolve(__dirname, "../admin/src/pages");

/** 白名单：文件名 → 理由（必须写清楚，否则下一个人会往里塞第二个） */
const EXEMPT = {
  "LoginPage.tsx": "登录壳：`<h1>` 是应用名，不是后台页面头（没有侧栏、没有 PageHeader）",
  "RegisterPage.tsx": "注册壳：同上，与登录页对称",
};

const RULES = [
  {
    id: "no-handwritten-overlay",
    pattern: /fixed inset-0/,
    hint: "弹窗一律用 components/Modal.tsx（Esc / 遮罩关闭 / 内容区滚动 / footer 都在它里面），不要自己写遮罩层",
  },
  {
    id: "no-handwritten-header",
    pattern: /<h1\b/,
    hint: "页头一律用 components/PageHeader.tsx（标题字号只有 text-lg 一档），不要手写 <h1>",
  },
  {
    id: "no-handwritten-field-label",
    pattern: /mb-1\.5 block text-xs font-medium/,
    hint: "字段标签用 <Field label>（筛选条里也是它：标签在上、控件在下），不要手写 <span>",
  },
  {
    id: "no-handwritten-card",
    pattern: /rounded-2xl border border-slate-800 bg-slate-900\/40/,
    hint: "卡片外壳用 <Card>（内边距、圆角、边框只在 ui.tsx 定义一处）",
  },
];

const files = fs.readdirSync(PAGES).filter((f) => f.endsWith(".tsx")).sort();
const problems = [];

for (const file of files) {
  const rel = path.join("admin/src/pages", file);
  const lines = fs.readFileSync(path.join(PAGES, file), "utf8").split("\n");
  for (const rule of RULES) {
    // 白名单只对「页头」放宽：登录页里也不该有遮罩与自造卡片
    if (rule.id === "no-handwritten-header" && EXEMPT[file]) continue;
    lines.forEach((line, index) => {
      if (rule.pattern.test(line)) {
        problems.push({ file: rel, line: index + 1, id: rule.id, hint: rule.hint, text: line.trim().slice(0, 100) });
      }
    });
  }
}

if (problems.length === 0) {
  console.log(`✓ 界面一致性：${files.length} 个页面全部走共用组件（PageHeader / Modal / Card / Field）`);
  process.exit(0);
}

console.error(`✗ 界面一致性：${problems.length} 处绕过了共用组件\n`);
for (const p of problems) {
  console.error(`  ${p.file}:${p.line}  [${p.id}]`);
  console.error(`     ${p.text}`);
  console.error(`     → ${p.hint}\n`);
}
console.error("规则见 .workbuddy/skills/olua-admin-ui/SKILL.md（「组件映射」与「禁用清单」两节）。");
process.exit(1);
