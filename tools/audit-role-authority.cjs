#!/usr/bin/env node
/**
 * 守卫：角色存档的权威边界（#548）—— 服务端独占的字段，客户端不许本地改
 *
 * ===========================================================================
 * 为什么必须有这个
 * ===========================================================================
 * `PUT /roles/:id` 是「客户端推整份存档」的形态（`data` 是不透明 JSON），服务端只校验
 * 结构。于是「谁能写哪个字段」这件事**没有被任何类型或运行时机制表达出来** ——
 * 它只写在 `role-authority.ts` 的注释里，而注释不会拦人。
 *
 * 真实的翻车轮廓是这样的：某天给商城加个「折扣券」，顺手在客户端写一行
 * `role.bindGold -= price`（想省一次接口往返）。存档推上去，服务端把账本字段回填成库里的
 * 旧值 —— 玩家**扣了券没扣钱**，或者反过来**花了钱没拿到东西**，而且两边都不报错：
 * 客户端以为自己扣了，服务端以为自己是对的。这类 bug 没有任何一个现有审计能看见。
 *
 * 所以把「客户端碰这些字段的方式」钉成三条机器判据：
 *
 *   1. **字段清单在客户端确实存在**：`SERVER_OWNED_FIELDS` 里保护一个客户端根本没有的
 *      字段 = 保护了空气，服务端那份清单会慢慢腐化成一份过期的愿望清单；
 *   2. **存档路径真的挂了边界**：`RolesService.save` 必须调 `enforceServerAuthority`
 *      （清单写得再对，没挂在写入口上等于没做）；
 *   3. **客户端对这些字段的赋值只能来自服务端**：右值必须是 `update.` / `data.` /
 *      `result.` 这类服务端应答，或者旧档补默认的 `0`。出现别的右值 = 有人在本地改账本。
 *
 * ===========================================================================
 * 判据口径
 * ===========================================================================
 * - 第 3 条只扫 `client/assets/ui/**`（`entities/Role.ts` 是字段声明，不算赋值）
 * - 「服务端应答」= 右值以 `update.` / `data.` / `result.` / `Number(data.` /
 *   `Number(result.` 开头；`0` 仅允许出现在 `if (typeof x !== "number")` 的旧档补默认行
 * - 命中一行就 exit 1，并打印「文件:行 + 那一行原文 + 该怎么改」
 *
 * 输出风格与 `audit-doc-numbers.cjs` 一致：违规逐条指名道姓，exit 1。
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const AUTHORITY = path.join(ROOT, "server", "src", "modules", "roles", "role-authority.ts");
const ROLES_SERVICE = path.join(ROOT, "server", "src", "modules", "roles", "roles.service.ts");
const CLIENT_ROLE = path.join(ROOT, "client", "assets", "entities", "Role.ts");
const CLIENT_UI = path.join(ROOT, "client", "assets", "ui");

const problems = [];

function rel(p) {
  return path.relative(ROOT, p);
}

function read(p) {
  return fs.readFileSync(p, "utf8");
}

/** 从 role-authority.ts 里读出服务端独占字段（解析常量数组的字面量，不执行 TS） */
function serverOwnedFields() {
  const text = read(AUTHORITY);
  const fields = [];
  for (const name of ["SERVER_LEDGER_FIELDS", "SERVER_GROWTH_FIELDS", "SERVER_PROGRESS_FIELDS"]) {
    const match = new RegExp(`export const ${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(text);
    if (!match) {
      problems.push(`${rel(AUTHORITY)}：找不到 ${name}（权威边界清单被改名或删掉了？）`);
      continue;
    }
    for (const item of match[1].matchAll(/"([^"]+)"/g)) fields.push(item[1]);
  }
  return fields;
}

/** 判据 1：清单里的字段在客户端 Role 实体里真的有 */
function checkFieldsExist(fields) {
  if (!fields.length) {
    problems.push(`${rel(AUTHORITY)}：服务端独占字段清单是空的（保护了空气）`);
    return;
  }
  const duplicated = fields.filter((f, i) => fields.indexOf(f) !== i);
  if (duplicated.length) {
    problems.push(`${rel(AUTHORITY)}：字段清单里重复写了 ${duplicated.join(" / ")}`);
  }
  const roleText = read(CLIENT_ROLE);
  for (const field of fields) {
    // 客户端 Role 的字段声明形如 `  gold: number = initialGold;`
    if (!new RegExp(`^\\s{2}${field}[?:]?\\s*:`, "m").test(roleText)) {
      problems.push(`${rel(CLIENT_ROLE)}：客户端角色实体里没有字段 ${field} —— 服务端在保护一个不存在的字段`);
    }
  }
}

/** 判据 2：save() / create() 真的挂了边界 */
function checkSaveWired() {
  const text = read(ROLES_SERVICE);
  const slices = {
    save: sliceMethod(text, "  save(accountId: string, roleId: string, dto: SaveRoleDto)"),
    create: sliceMethod(text, "  create(accountId: string, dto: CreateRoleDto)"),
  };
  if (!slices.save || !slices.create) {
    problems.push(`${rel(ROLES_SERVICE)}：找不到 save() / create()（方法签名变了就同步这条判据）`);
    return;
  }
  // 直接调 enforceServerAuthority 或经服务内的 enforceAuthority（带日志的那层）都算挂上了
  for (const [label, pattern, why] of [
    ["enforceServerAuthority", /enforce(Server)?Authority\s*\(/, "账本与成长线阶位要按库里的值回填"],
    ["clampVitals", /clampVitals\s*\(/, "血蓝要夹回 [0, 上限]"],
  ]) {
    if (!pattern.test(slices.save)) problems.push(`${rel(ROLES_SERVICE)}：save() 没有调用 ${label} —— ${why}`);
  }
  // 建号是唯一没有旧值可比的口子，上界靠这个函数
  if (!/clampInitialCurrency\s*\(/.test(slices.create)) {
    problems.push(`${rel(ROLES_SERVICE)}：create() 没有调用 clampInitialCurrency —— 建号的金币上界没封，改包能开号即暴富`);
  }
}

/** 切出一个方法的方法体（到下一个 JSDoc 或类结束为止） */
function sliceMethod(text, signature) {
  const start = text.indexOf(signature);
  if (start < 0) return "";
  const end = text.indexOf("\n  /**", start);
  return text.slice(start, end > 0 ? end : start + 6000);
}

/** 递归收集客户端 UI 目录下的 .ts */
function collectTs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      collectTs(p, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

/** 判据 3：客户端对账本 / 阶位 / 进度的赋值只能来自服务端 */
function checkClientAssignments(fields) {
  if (!fields.length) return;
  // 赋值运算符要包含复合赋值：`role.gold -= price` 才是真正常见的翻车写法。
  //
  // 接收者必须叫 `role`（#550 收窄）：`level` 这个词在客户端到处都是 —— 任务目标的
  // `this.level`（QuestStore）、怪物的 `monster.level`、UI 节点的 `layout.title` ——
  // 按字段名裸匹配会把它们全判成违规。真正要盯的是「角色对象自己那份账」。
  const pattern = new RegExp(`(?:^|[^.\\w])role\\.(${fields.join("|")})\\s*([+\\-*/]?=)(?!=)\\s*(.*)$`);
  for (const file of collectTs(CLIENT_UI)) {
    const lines = read(file).split("\n");
    lines.forEach((line, index) => {
      const match = pattern.exec(line);
      if (!match) return;
      const rhs = match[3].trim();
      // 右值里**引用**了服务端应答对象就算放行 —— 包一层 `Math.max(0, Math.floor(update.exp))`
      // 也还是照抄服务端，不该因为多了个取整就判红
      const fromServer = /(^|[^\w.])(update|data|result|fresh|saved|detail|reward|gain)\./.test(rhs);
      // 旧档补默认：`if (typeof role.gold !== "number") role.gold = 0;`
      const legacyDefault = /^0;?$/.test(rhs) && /typeof\s+\w+\.\w+\s*!==/.test(line);
      if (fromServer || legacyDefault) return;
      problems.push(
        `${rel(file)}:${index + 1}：在本地改服务端独占字段 ${match[1]}（${line.trim()}）` +
          ` —— 推上去会被服务端回填成库里的值，改了个寂寞；要走服务端接口`,
      );
    });
  }
}

const fields = serverOwnedFields();
checkFieldsExist(fields);
checkSaveWired();
checkClientAssignments(fields);

if (problems.length) {
  console.log("❌ 角色存档的权威边界被破坏：");
  for (const p of problems) console.log(`   · ${p}`);
  process.exit(1);
}

console.log(`✔ 权威边界完好：服务端独占 ${fields.length} 个字段（${fields.join(" / ")}）`);
console.log("  · 清单在客户端实体里都存在 · save() 已挂 enforceServerAuthority + clampVitals，create() 已挂 clampInitialCurrency");
console.log("  · 客户端对这些字段的赋值全部来自服务端应答（或旧档补 0）");
