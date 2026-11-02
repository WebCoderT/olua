#!/usr/bin/env node
/**
 * 配置快照契约审计（#604）：客户端的「要什么」与服务端的「发什么」必须是同一张清单
 *
 * 为什么要有它：#604 之前快照的每一段都是可选的，`if (snapshot.skills) {...}` 缺段静默跳过，
 * 客户端用内置出厂表兜住 —— 表现是「管理端改了，游戏里没变」，日志里一个字都没有。
 * 现在改成显式契约（缺段抛错 + 挡住进游戏），**风险就从「静默」转成了「服务端少发一段，
 * 玩家登录被卡住」**。一条静态守点必须钉住这件事，否则下次改 `snapshot()` 的 return，
 * 要么客户端白屏，要么有人顺手把客户端的校验去掉。
 *
 * 五条规则（全部静态可判，不需要起服务）：
 * 1. 客户端 `SNAPSHOT_SECTIONS`（`configs/snapshot-contract.ts`）非空、key 不重复、每段有中文名；
 * 2. 这份清单的 key 集合 == `GameConfigSnapshotDto` 的字段集合（双向：少一个或多一个都报）——
 *    DTO 是下发的形状声明，清单是客户端的要求，两边对不上就是契约破裂；
 * 3. `client-config.service.snapshot()` 的 return 字面量 key 集合 == DTO 字段集合
 *    （DTO 声明了却忘了赋值 = 运行时 `undefined`，静态检查抓的就是这种漏发）；
 * 4. `apply-snapshot.ts` 里 `applyConfigSnapshot` 必须**先校验**（函数体第一句就是
 *    `checkSnapshotContract`），且全文不许再出现 `if (snapshot.xxx)` 这种「缺段跳过」分支
 *    （那正是 #604 要消灭的影子兜底）；
 * 5. 进游戏前的加载顺序不能退化：`Loading.ts` 必须在 `PreloadManager.preloadGame` **之前**
 *    调 `loadGameConfig`（预载要读快照里的怪物 / NPC / 时装表），并且真的看返回值（`config.ok`）——
 *    「加了校验没人看返回值」等于没做。
 *
 * 用法：node tools/audit-snapshot-contract.cjs
 */

const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");
const CONTRACT = path.join(REPO, "client/assets/configs/snapshot-contract.ts");
const APPLY = path.join(REPO, "client/assets/configs/apply-snapshot.ts");
const DTO = path.join(REPO, "server/src/modules/game-config/dto/client-config.dto.ts");
const SERVICE = path.join(REPO, "server/src/modules/game-config/client-config.service.ts");
const LOADING = path.join(REPO, "client/assets/ui/Loading.ts");

/** 逐条问题（文件名:行号 + 该做什么） */
const problems = [];

function problem(file, line, hint) {
  problems.push({ file, line, hint });
}

/** 读取文件（不存在直接报问题，别静默跳过 —— 判据被删了就等于没有守点） */
function read(file, label) {
  if (!fs.existsSync(file)) {
    problem(label, 0, "文件不存在 —— 审计的判据被删了，请恢复或同步改本脚本");
    return "";
  }
  return fs.readFileSync(file, "utf8");
}

const rel = (file) => path.relative(REPO, file);

/** 客户端契约清单（一段一行的字面量，格式见 snapshot-contract.ts 顶部注释） */
function parseContract() {
  const src = read(CONTRACT, rel(CONTRACT));
  if (!src) return [];
  const block = /SNAPSHOT_SECTIONS: SnapshotSectionSpec\[\] = \[([\s\S]*?)\n\];/.exec(src);
  if (!block) {
    problem(rel(CONTRACT), 0, "找不到 `SNAPSHOT_SECTIONS: SnapshotSectionSpec[] = [...]` —— 清单被改名/改形了，请同步改本审计");
    return [];
  }
  const sections = [];
  const entry = /\{\s*key:\s*"([A-Za-z0-9]+)",\s*label:\s*"([^"]+)",\s*kind:\s*"(array|object)"(?:,\s*minRows:\s*(\d+))?\s*\}/g;
  let match;
  while ((match = entry.exec(block[1])) !== null) {
    sections.push({ key: match[1], label: match[2], kind: match[3], minRows: match[4] ? Number(match[4]) : 0 });
  }
  if (sections.length === 0) {
    problem(rel(CONTRACT), 0, "清单一个条目都没解析出来 —— 格式变了，别让它空跑即通过");
  }
  return sections;
}

/** 服务端 DTO 的字段（`  xxx!: Type;` 形式，见 client-config.dto.ts） */
function parseDtoKeys() {
  const src = read(DTO, rel(DTO));
  if (!src) return [];
  const keys = [];
  const field = /^\s{2}([A-Za-z][A-Za-z0-9]*)!:/gm;
  let match;
  while ((match = field.exec(src)) !== null) keys.push(match[1]);
  if (keys.length === 0) problem(rel(DTO), 0, "DTO 一个字段都没解析出来 —— 字段写法变了，请同步改本审计");
  return keys;
}

/** `snapshot()` 里 return 字面量的键（服务端真正下发的段） */
function parseServiceKeys() {
  const src = read(SERVICE, rel(SERVICE));
  if (!src) return [];
  const body = /snapshot\(\): GameConfigSnapshotDto \{[\s\S]*?return \{([\s\S]*?)\n    \};/.exec(src);
  if (!body) {
    problem(rel(SERVICE), 0, "找不到 `snapshot(): GameConfigSnapshotDto { ... return {...}; }` —— 组装方式变了，请同步改本审计");
    return [];
  }
  const keys = [];
  const entry = /^\s{6}([A-Za-z][A-Za-z0-9]*):/gm;
  let match;
  while ((match = entry.exec(body[1])) !== null) keys.push(match[1]);
  if (keys.length === 0) problem(rel(SERVICE), 0, "return 字面量一个键都没解析出来 —— 缩进/写法变了，请同步改本审计");
  return keys;
}

/** 集合差异（双向比对，返回人话） */
function diff(leftName, left, rightName, right) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const onlyLeft = left.filter((key) => !rightSet.has(key));
  const onlyRight = right.filter((key) => !leftSet.has(key));
  return `${onlyLeft.length ? `${leftName} 独有：${onlyLeft.join("、")}；` : ""}${onlyRight.length ? `${rightName} 独有：${onlyRight.join("、")}；` : ""}`;
}

/** 规则 1/2/3：三方清单必须一致 */
function checkThreeWay() {
  const sections = parseContract();
  if (sections.length === 0) return;
  const keys = sections.map((section) => section.key);
  if (new Set(keys).size !== keys.length) {
    problem(rel(CONTRACT), 0, "契约清单里有重复 key（重复的段会被校验两次，且 diff 结果不可信）");
  }
  const nameless = sections.filter((section) => !section.label).map((section) => section.key);
  if (nameless.length > 0) {
    problem(rel(CONTRACT), 0, `这些段没有中文名（报错文案会只剩 key，玩家看不懂）：${nameless.join("、")}`);
  }

  const dtoKeys = parseDtoKeys();
  if (dtoKeys.length === 0) return;
  const contractVsDto = diff("客户端清单", keys, "快照 DTO", dtoKeys);
  if (contractVsDto) {
    problem(
      rel(CONTRACT),
      0,
      `客户端要求与快照 DTO 对不上 —— ${contractVsDto}两边必须是同一张清单（加段时 DTO、service、客户端清单一起改）`,
    );
  }

  const serviceKeys = parseServiceKeys();
  if (serviceKeys.length === 0) return;
  const serviceVsDto = diff("DTO", dtoKeys, "snapshot() 返回", serviceKeys);
  if (serviceVsDto) {
    problem(rel(SERVICE), 0, `DTO 与真正下发的字段对不上 —— ${serviceVsDto}DTO 声明了却没赋值 = 客户端拿到 undefined（#604 会让登录直接失败）`);
  }
}

/** 规则 4：先校验、且不许再有「缺段跳过」 */
function checkApplySnapshot() {
  const src = read(APPLY, rel(APPLY));
  if (!src) return;
  const body = /export function applyConfigSnapshot\([\s\S]*?\n\}/.exec(src);
  if (!body) {
    problem(rel(APPLY), 0, "找不到 applyConfigSnapshot —— 入口改名了，请同步改本审计");
    return;
  }
  // 函数体第一句必须是契约校验（中间插一行别的就等于「先落库后校验」）
  const firstStatement = /export function applyConfigSnapshot\([^)]*\): void \{\s*\n\s*([^\n]+)/.exec(src);
  if (!firstStatement || !/checkSnapshotContract\(/.test(firstStatement[1])) {
    problem(rel(APPLY), 0, "applyConfigSnapshot 的第一句必须是 checkSnapshotContract(snapshot) —— 先校验后落库，失败时表一点不能动");
  }
  // 全文不许再有 if (snapshot.xxx)：那是「缺段静默跳过 / 回落本地」的入口
  const lines = src.split("\n");
  lines.forEach((line, index) => {
    if (/^\s*(\*|\/\/|\/\*)/.test(line)) return;
    if (/if\s*\(\s*snapshot\.[A-Za-z]/.test(line)) {
      problem(rel(APPLY), index + 1, "不许再出现 `if (snapshot.x)` 的缺段跳过（#604）：段在不在由 snapshot-contract 判，缺了就抛");
    }
  });
}

/** 规则 5：配置先于预载，且返回值真的被看 */
function checkLoadingOrder() {
  const src = read(LOADING, rel(LOADING));
  if (!src) return;
  const lines = src.split("\n");
  const isComment = (line) => /^\s*(\*|\/\/|\/\*)/.test(line);
  const configAt = lines.findIndex((line) => !isComment(line) && /await\s+loadGameConfig\(\)/.test(line));
  const preloadAt = lines.findIndex((line) => !isComment(line) && /PreloadManager\.preloadGame\(/.test(line));
  if (configAt < 0) {
    problem(rel(LOADING), 0, "Loading 场景必须 await loadGameConfig()（#604：配置是进游戏的硬依赖）");
    return;
  }
  if (preloadAt >= 0 && configAt > preloadAt) {
    problem(
      rel(LOADING),
      configAt + 1,
      "配置必须在 preloadGame **之前**拉：预载要读快照里的怪物 / NPC / 时装表，顺序反了那些表还是空的（预载等于白做）",
    );
  }
  if (!/config\.ok/.test(src)) {
    problem(rel(LOADING), 0, "必须真的看 loadGameConfig 的返回值（config.ok）：只看不判 = 校验白加，失败照样进图");
  }
  if (!/installNetwork\(\)/.test(src)) {
    problem(rel(LOADING), 0, "拉配置前要 installNetwork()：令牌过期时请求层才能把人送回登录场景，而不是卡在 Loading 重试");
  }
}

checkThreeWay();
checkApplySnapshot();
checkLoadingOrder();

if (problems.length === 0) {
  console.log("✓ 快照契约：客户端清单 == 快照 DTO == snapshot() 实际下发；applyConfigSnapshot 先校验后落库、无缺段跳过；Loading 先拉配置再预载且看返回值");
  process.exit(0);
}

console.error(`✗ 快照契约有 ${problems.length} 处问题（#604：段必填，缺了就炸在登录时而不是静默半份数据）：`);
for (const item of problems) {
  console.error(`  ${item.file}${item.line ? `:${item.line}` : ""}\n    ${item.hint}`);
}
process.exit(1);
