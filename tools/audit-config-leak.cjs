/**
 * 配置外泄审计（config leak audit）
 *
 * 目的：核心代码（ui / skills / entities）只做「怎么跑」，不写「可调的数」——
 * 位置、尺寸、颜色、资源路径、时长、概率、魔法数字、中文文案都应沉到 configs/。
 *
 * 本脚本扫描非配置目录下的 .ts，按规则列出候选外泄项；
 * tools/config-leak-allowlist.json 里登记「已核对、确实该留在代码里」的条目（附原因）。
 *
 * 除「外泄」外还做一项反向检查：代码里用到的文案 key 是否都在 configs/texts 登记过
 * （`getText("xxx")` / `createTip("xxx")` 的 key 若漏登记，运行期只会打到一条 console.warn，
 *   这里直接当失败报出来，避免「提示变成 key 字符串」这种上线才发现的坑）。
 *
 * 用法：
 *   node tools/audit-config-leak.cjs            # 报告 + 退出码（有未处理项即 1）
 *   node tools/audit-config-leak.cjs --list     # 只列未处理项
 *   node tools/audit-config-leak.cjs --json     # 输出 JSON
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ASSETS = path.join(ROOT, "assets");
const SKIP_DIRS = ["configs", "types", "unused"];
const ALLOW_FILE = path.join(__dirname, "config-leak-allowlist.json");

const args = process.argv.slice(2);
const MODE = {
  json: args.includes("--json"),
  list: args.includes("--list"),
};

/** ---------- 规则 ---------- */
// 每行都会跑全部规则，命中即记录（同一行可命中多条）
// 原则：只报「可调的数与面向玩家的文案」；开发期日志（console.*）、单位换算、内部节点身份不算配置
const RULES = [
  {
    id: "color",
    label: "颜色字面量",
    // new Color("#fff") / new Color(255, 0, 0) / "#RRGGBB" 直接写死
    test: (line) =>
      /new\s+Color\(\s*["']#/.test(line) ||
      /new\s+Color\(\s*\d+\s*,/.test(line) ||
      /["']#[0-9a-fA-F]{3,8}["']/.test(line),
  },
  {
    id: "assetPath",
    label: "资源路径字面量",
    test: (line) =>
      /(load|loadDir|loadRemote)\s*\(\s*["'`][^"'`]*\//.test(line) ||
      // 排除 MIME 类型（image/png、audio/mpeg…）与常见扩展名，它们不是资源地址
      (/["'][a-zA-Z0-9_-]+\/[a-zA-Z0-9_/-]+["']/.test(line) &&
        !/["'](image|audio|video|text|application)\/[a-z.+-]+["']/.test(line)),
  },
  {
    id: "nodeName",
    label: "节点名字面量",
    test: (line) =>
      /find\s*\(\s*["']/.test(line) ||
      /getChildByName\s*\(\s*["']/.test(line) ||
      /new\s+Node\s*\(\s*["']/.test(line),
  },
  {
    id: "time",
    label: "时长/延迟硬编码",
    // 只报「第二个参数写死数字」的定时器，以及 duration/delay/interval 直接赋字面量
    test: (line) =>
      /(setTimeout|schedule|scheduleOnce|scheduleCallbackForTarget)\s*\([^)]*,\s*-?\d/.test(line) ||
      /\b(duration|delay|interval|timeout|elapsed|lifetime)\s*[:=]\s*-?\d/.test(line),
  },
  {
    id: "tunable",
    label: "可调数值（速度/半径/间距/阈值…）",
    test: (line) => {
      // 三元兜底（如 `rate > 0 ? rate : 1`）是除零/空值保护，不是可调数值
      if (/\?\s*\w*\s*:\s*-?\d/.test(line)) return false;
      return /\b(speed|velocity|radius|distance|gap|padding|offsetX|offsetY|margin|spacing|scaleFactor|alpha|chance|prob|rate|threshold|priority|weight|gravity|friction|damping|restitution|maxStack|cooldown|coolDown|crit|dodge|knockback)\w*\s*[:=]\s*-?\d/.test(
        line
      );
    },
  },
  {
    id: "magicCompare",
    label: "魔法阈值比较",
    // >= 3 的数字参与比较（0/1/2 常是边界语义，放行）；位运算（1 << n）是枚举，不算阈值
    test: (line) => {
      if (/<<|>>>|>>/.test(line)) return false;
      const m = line.match(/[<>]=?\s*-?(\d+(?:\.\d+)?)/g) || [];
      return m.some((s) => {
        const n = parseFloat(s.replace(/[^\d.-]/g, ""));
        return Math.abs(n) >= 3;
      });
    },
  },
  {
    id: "cn",
    label: "中文文案硬编码",
    // 开发期日志（console.*）与注释不算玩家可见文案
    test: (line) =>
      !/console\./.test(line) &&
      /["'`][^"'`]*[\u4e00-\u9fa5]{2,}[^"'`]*["'`]/.test(line) &&
      !/^\s*(\/\/|\*|\/\*)/.test(line),
  },
];

/** ---------- 收集文件 ---------- */
function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(ASSETS, full);
    if (fs.statSync(full).isDirectory()) {
      if (SKIP_DIRS.includes(name) || name === "resources") continue;
      walk(full, out);
    } else if (name.endsWith(".ts")) {
      out.push({ full, rel });
    }
  }
  return out;
}

/** ---------- 例外清单 ---------- */
function loadAllowlist() {
  if (!fs.existsSync(ALLOW_FILE)) return { entries: [] };
  try {
    return JSON.parse(fs.readFileSync(ALLOW_FILE, "utf8"));
  } catch (e) {
    console.error(`[warn] ${ALLOW_FILE} 解析失败：${e.message}`);
    return { entries: [] };
  }
}

function hitOf(rule, line, rel) {
  const key = `${rel}|${rule.id}`;
  return key;
}

const files = walk(ASSETS);
const allow = loadAllowlist();
const allowSet = new Set(allow.entries.map((e) => `${e.file}|${e.rule}|${e.match ?? ""}`));
const allowFileRule = new Set(allow.entries.map((e) => `${e.file}|${e.rule}`));

const findings = [];
for (const { full, rel } of files) {
  const text = fs.readFileSync(full, "utf8");
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // 注释不算
    for (const rule of RULES) {
      if (!rule.test(line)) continue;
      const snippet = line.trim().slice(0, 120);
      const allowHit =
        allowSet.has(`${rel}|${rule.id}|${snippet}`) || allowFileRule.has(`${rel}|${rule.id}`);
      if (allowHit) continue;
      findings.push({ file: rel, line: i + 1, rule: rule.id, label: rule.label, snippet, hitOf: hitOf(rule, line, rel) });
    }
  });
}

/** ---------- 文案 key 覆盖检查 ---------- */
// 代码里引用的文案 key 必须在 configs/texts 登记，否则运行期会显示成 key 本身
function checkTextKeys() {
  const textsFile = path.join(ASSETS, "configs", "texts.ts");
  if (!fs.existsSync(textsFile)) return { missing: [], checked: 0 };
  const source = fs.readFileSync(textsFile, "utf8");
  const body = source.slice(source.indexOf("export const uiTexts"), source.indexOf("as const"));
  const declared = new Set();
  for (const m of body.matchAll(/^\s*([A-Za-z_][\w]*)\s*:/gm)) declared.add(m[1]);

  const missing = [];
  let checked = 0;
  for (const { full, rel } of files) {
    const text = fs.readFileSync(full, "utf8");
    // getText("key") / textRef("key") / createTip("key") / createErrorTip("key") / uiTexts.key
    // 注意排除 this.createTip(...)：那是组件自己的私有方法（如 AutoBattleTips 的图集提示），不是文案 API
    for (const m of text.matchAll(/(?<!this\.)(?:getText|textRef|createTip|createErrorTip)\(\s*"([A-Za-z_][\w]*)"/g)) {
      checked++;
      if (!declared.has(m[1])) missing.push({ file: rel, key: m[1] });
    }
    for (const m of text.matchAll(/uiTexts\.([A-Za-z_][\w]*)/g)) {
      checked++;
      if (!declared.has(m[1])) missing.push({ file: rel, key: `uiTexts.${m[1]}` });
    }
  }
  return { missing, checked, declared: declared.size };
}

/** ---------- 汇总输出 ---------- */
const byRule = {};
const byFile = {};
for (const f of findings) {
  byRule[f.rule] = (byRule[f.rule] || 0) + 1;
  byFile[f.file] = (byFile[f.file] || 0) + 1;
}

const textKeys = checkTextKeys();
const failed = findings.length > 0 || textKeys.missing.length > 0;

if (MODE.json) {
  console.log(JSON.stringify({ total: findings.length, byRule, byFile, findings, textKeys }, null, 2));
  process.exit(failed ? 1 : 0);
}

console.log("配置外泄审计 / config leak audit");
console.log(`扫描目录：assets/{ui,skills,entities}（跳过 ${SKIP_DIRS.join("/")}/、resources/）`);
console.log(`文件数：${files.length}　命中：${findings.length}（例外清单 ${allow.entries.length} 条）`);
console.log("");
if (findings.length) {
  const files = Object.keys(byFile).sort((a, b) => byFile[b] - byFile[a]);
  for (const file of files) {
    console.log(`- ${file}  (${byFile[file]})`);
    if (!MODE.list) {
      for (const f of findings.filter((x) => x.file === file)) {
        console.log(`    ${String(f.line).padStart(4)} [${f.rule}] ${f.snippet}`);
      }
    }
  }
  console.log("");
  console.log("按规则：");
  for (const [k, v] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) {
    const label = (RULES.find((r) => r.id === k) || {}).label || k;
    console.log(`  ${k.padEnd(12)} ${String(v).padStart(4)}  ${label}`);
  }
}
console.log("文案 key 覆盖：");
console.log(`  已登记 ${textKeys.declared} 条，代码引用 ${textKeys.checked} 处，未登记 ${textKeys.missing.length} 处`);
for (const item of textKeys.missing) console.log(`    ${item.file}  →  ${item.key}`);
console.log("");
if (!failed) {
  console.log("PASS：核心代码无可配置项外泄，且引用的文案 key 全部已登记");
} else {
  if (findings.length) console.log(`FAIL：${findings.length} 处配置外泄待处理（或登记到 tools/config-leak-allowlist.json）`);
  if (textKeys.missing.length) console.log(`FAIL：${textKeys.missing.length} 处文案 key 未在 configs/texts 登记`);
}
process.exit(failed ? 1 : 0);
