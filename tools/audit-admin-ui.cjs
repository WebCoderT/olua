#!/usr/bin/env node
/**
 * 管理端界面一致性审计（静态扫描 `admin/src`，不参与构建）
 *
 * 为什么要有它：管理端三十多个页面是分批写的，同一件事被写了两三遍 ——
 * 页头各写一份 `<div><h1…/><p…/></div>`（字号从 `text-lg` 漂到 `text-xl`）、
 * 弹窗各写一份 `fixed inset-0`（宽度、Esc、遮罩关闭各一套）、卡片各写一份
 * `rounded-2xl border border-slate-800 bg-slate-900/40`、字段标签各写一份 `<span>`。
 * #562 把这些收口到 `PageHeader` / `Modal` / `Card` / `Field` 之后，**没有守点就等于没做** ——
 * 下一个页面照着旧代码抄一遍，半年后又回到三种写法。
 *
 * #946 加了「legend 设计系统」的色彩纪律（token 单一来源、四族各司其职），
 * 于是这里从 4 条扩到 7 条：前 4 条管**结构**（不许重写组件），后 3 条管**词汇**
 * （不许用设计系统以外的颜色）。
 *
 * 扫描范围：
 * - `pages/`：全部 7 条（页面是布局层，最容易被抄坏）；
 * - `components/`：只查「手写遮罩 / 旧色族 / 裸色值」—— 那里正是组件的实现处，
 *   拿「不许写卡片 class」去卡 `ui.tsx` 只会得到一堆假 FAIL，
 *   而**假 FAIL 会让人学会无视这个审计**。
 *
 * 用法：node tools/audit-admin-ui.cjs
 */

const fs = require("node:fs");
const path = require("node:path");

const PAGES = path.resolve(__dirname, "../admin/src/pages");
const COMPONENTS = path.resolve(__dirname, "../admin/src/components");

/** 认证壳：没有侧栏、没有 PageHeader，`<h1>` 是应用名 —— 与后台页面不是同一类东西 */
const AUTH_SHELLS = {
  "LoginPage.tsx": "登录壳：`<h1>` 是应用名，不是后台页面头",
  "RegisterPage.tsx": "注册壳：同上，与登录页对称",
};

/** 组件目录的豁免（跨页面传染过的是「手写遮罩」） */
const COMPONENT_EXEMPT = {
  "Modal.tsx": "它就是遮罩的唯一实现",
  "GameImage.tsx": "大图查看器（`z-[100]` 全屏看图），不是表单弹窗，没有 footer 与标题栏",
};

/** 设计系统以外一律不许出现的 Tailwind 色族（legend token 见 admin/src/index.css） */
const BANNED_FAMILIES =
  "slate|gray|zinc|neutral|stone|indigo|blue|sky|cyan|teal|emerald|green|lime|amber|yellow|orange|red|rose|pink|fuchsia|purple|violet|black|white";

const UTILITY = "bg|text|border|divide|ring|ring-offset|from|to|via|fill|stroke|placeholder|outline|decoration|accent|caret|shadow";
const VARIANT = "hover:|focus:|active:|visited:|disabled:|group-hover:|focus-visible:|focus-within:";

const LEGACY_PALETTE = new RegExp(
  `(?:^|[\\s"'\`:{])(?:${VARIANT})?(?:${UTILITY})-(?:${BANNED_FAMILIES})(?:-\\d{2,3})?(?:/\\d{1,3})?`,
);

const RULES = [
  {
    id: "no-handwritten-overlay",
    test: (line) => /fixed inset-0/.test(line),
    hint: "弹窗一律用 components/Modal.tsx（Esc / 遮罩关闭 / 内容区滚动 / footer 都在它里面），不要自己写遮罩层",
  },
  {
    id: "no-handwritten-header",
    test: (line) => /<h1\b/.test(line),
    hint: "页头一律用 components/PageHeader.tsx（标题字号只有 text-lg 一档），不要手写 <h1>",
  },
  {
    id: "no-handwritten-field-label",
    test: (line) => /mb-1\.5 block text-xs font-medium/.test(line),
    hint: "字段标签用 <Field label>（筛选条里也是它：标签在上、控件在下），不要手写 <span>",
  },
  {
    id: "no-handwritten-card",
    test: (line) => /rounded-2xl border border-(?:slate-800|line) bg-(?:slate-900|surface-2)/.test(line),
    hint: "卡片外壳用 <Card>（内边距、圆角、边框、金线只在 ui.tsx 定义一处）",
  },
  {
    id: "no-legacy-palette",
    test: (line) => LEGACY_PALETTE.test(line),
    hint:
      "颜色只许用 legend 语义 token（surface / line / ink / gold / ember / jade / warn，见 admin/src/index.css 的 @theme）；" +
      "Tailwind 内置色族已全部禁用（过渡层已随 #946 阶段三删除）",
  },
  {
    id: "no-raw-color",
    test: (line) => {
      // 任意值色类：`bg-[#123456]` / `text-[rgb(…)` / `border-[hsl(…)` —— 出现在哪儿都是绕过 token
      if (/\[(?:#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\()/.test(line)) return true;
      // 内联样式里的裸色值：`className={… #fff …}` / `style={{ color: "#f43f5e" }}`
      const inline = /(?:className|style)\s*=\s*\{/.test(line);
      return inline && /(?:#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\()/.test(line);
    },
    hint: "裸色值只许出现在 admin/src/index.css（@theme token）与页面作用域样式文件里；SVG / 内联样式用 var(--color-*)",
  },
  {
    id: "require-page-header",
    fileLevel: true,
    test: (source) => !/PageHeader/.test(source),
    hint: "每个后台页面都必须以 <PageHeader> 开头（标题 / 说明 / 动作区三件套只在它里面定义）",
  },
];

/** 组件目录只跑这三条（结构与页面根组件无关） */
const COMPONENT_RULE_IDS = new Set(["no-handwritten-overlay", "no-legacy-palette", "no-raw-color"]);

const problems = [];

function collect(file, dirLabel, source, allowedIds) {
  const lines = source.split("\n");
  for (const rule of RULES) {
    if (allowedIds && !allowedIds.has(rule.id)) continue;
    // 认证壳只豁免「页头」与「必须有 PageHeader」两条：它们也不该有遮罩与自造卡片
    if (AUTH_SHELLS[file] && (rule.id === "no-handwritten-header" || rule.id === "require-page-header")) continue;

    if (rule.fileLevel) {
      if (rule.test(source)) {
        problems.push({ file: path.join(dirLabel, file), line: 0, id: rule.id, hint: rule.hint, text: "（整个文件）" });
      }
      continue;
    }
    lines.forEach((line, index) => {
      if (rule.test(line)) {
        problems.push({
          file: path.join(dirLabel, file),
          line: index + 1,
          id: rule.id,
          hint: rule.hint,
          text: line.trim().slice(0, 110),
        });
      }
    });
  }
}

const pageFiles = fs.readdirSync(PAGES).filter((f) => f.endsWith(".tsx")).sort();
for (const file of pageFiles) {
  collect(file, "admin/src/pages", fs.readFileSync(path.join(PAGES, file), "utf8"));
}

const allComponentFiles = fs.readdirSync(COMPONENTS).filter((f) => f.endsWith(".tsx")).sort();
const componentFiles = allComponentFiles.filter((f) => !COMPONENT_EXEMPT[f]);
for (const file of componentFiles) {
  collect(file, "admin/src/components", fs.readFileSync(path.join(COMPONENTS, file), "utf8"), COMPONENT_RULE_IDS);
}

if (problems.length === 0) {
  console.log(
    `✓ 界面一致性：${pageFiles.length} 个页面 + ${componentFiles.length} 个组件 —— ` +
      `结构 4 条（PageHeader / Modal / Card / Field）+ 词汇 3 条（语义 token / 无裸色值 / 必有页头）全过`,
  );
  process.exit(0);
}

// 按规则归组输出：同一条规则刷 40 行，没人会看第二条
const groups = new Map();
for (const p of problems) {
  if (!groups.has(p.id)) groups.set(p.id, []);
  groups.get(p.id).push(p);
}

console.error(`✗ 界面一致性：${problems.length} 处不合规（${groups.size} 类）\n`);
for (const [id, list] of groups) {
  console.error(`── [${id}] ${list.length} 处`);
  console.error(`   → ${list[0].hint}`);
  for (const p of list.slice(0, 12)) console.error(`   ${p.file}:${p.line}  ${p.text}`);
  if (list.length > 12) console.error(`   …另有 ${list.length - 12} 处同类`);
  console.error("");
}
console.error("规则见 .workbuddy/skills/olua-admin-ui/SKILL.md（「组件映射」「色彩纪律」两节）。");
process.exit(1);
