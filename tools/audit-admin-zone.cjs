#!/usr/bin/env node
/**
 * 管理端单区上下文审计（#960 / docs/39-区服模型补完设计.md §3.8）
 *
 * ===========================================================================
 * 为什么要有它
 * ===========================================================================
 * 管理端口径是「**不绑区**（谁都能看所有区），但**一次只在一个区里干活**」。
 * 前半句很容易实现 —— 它什么都不用做；后一句全靠每个控制器自己记得挂 `ZoneContextGuard`
 * 并在仓储里带上 `zone_id`。忘一个接口的后果是静默的：
 *
 *   - 列表把两区的角色混在一起，「第 3 页」到底是谁的第 3 页说不清；
 *   - 页面停在 A 区、按钮带着 B 区的 id，写操作照样成功，改到了另一个区去。
 *
 * 所以这里钉两条结构判据（不看业务逻辑，只看形）：
 *
 *   1. 每个 `@ApiAudience("admin")` 的控制器，要么**类上挂了 `ZoneContextGuard`**，
 *      要么在整个白名单里显式登记成「全局模块 + 理由」。没登记的 = 红。
 *   2. 已挂守卫的控制器里，每个路由要么用 `@ZoneContext()` 把区取出来，
 *      要么显式登记成「账号级 / 刻意跨区」的例外（带理由）。
 *      「挂了守卫但一个路由都没取区」= 白挂，同样红。
 *
 * 为什么第二条要管到这个粒度：`ZoneContextGuard` 只做「这个区存在吗」，
 * 它**不会**让 SQL 自动按区过滤。挂了守卫却不取区，读代码的人会以为这里有区约束。
 *
 * ===========================================================================
 * 白名单（tools/admin-zone-allowlist.json）
 * ===========================================================================
 * 条目级，三种：
 *   - `file`  ：单个控制器文件（全局模块）
 *   - `dir`   ：整个目录下的管理端控制器（如 game-config 全家桶）
 *   - `route` ：已挂守卫的控制器里，某个刻意不按区过滤的路由（`METHOD /admin/...`）
 * 每条必须有 `issue` 与 `reason`。**条目不再命中 → 也算红**（自检），
 * 否则白名单只增不减，半年后没人知道哪些还能删。
 *
 * 反证方式：给一个 whitelist 里的控制器挂上守卫但不取区、给一个受控控制器新加一条
 * 不带 `@ZoneContext()` 的路由、把一个 `file` 条目的前缀改掉 —— 三处必须全部点名且 exit=1。
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "server", "src");
const MODULES = path.join(SERVER, "modules");
const ALLOWLIST_FILE = path.join(__dirname, "admin-zone-allowlist.json");

const VERBS = ["Get", "Post", "Put", "Patch", "Delete"];

/** 递归找所有 controller 文件 */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".controller.ts")) out.push(full);
  }
  return out;
}

/**
 * 把控制器拆成「类头 + 每个路由块」
 *
 * 路由块按 `\n  @Get(` 这类 2 空格缩进的装饰器切 —— 本项目所有控制器都是一层类，
 * 方法装饰器缩进固定 2 空格（`prettier` 定的），够用且不会误伤方法体里的调用。
 */
function parse(file) {
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes('ApiAudience("admin")')) return null;

  const ctrl = text.match(/@Controller\(\s*"([^"]*)"\s*\)/);
  const prefix = ctrl ? ctrl[1].replace(/^\/+|\/+$/g, "") : "";

  // 先只找装饰器的**起点**（2 空格缩进 + `@Get(` 这类），再按相邻起点切块
  const re = new RegExp(`\\n  @(${VERBS.join("|")})\\(`, "g");
  const starts = [];
  let hit;
  while ((hit = re.exec(text))) starts.push({ index: hit.index + 1, verb: hit[1] });

  const head = starts.length > 0 ? text.slice(0, starts[0].index) : text;
  const classGuarded = /@UseGuards\([^)]*ZoneContextGuard/.test(head);

  const routes = starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : text.length;
    const block = text.slice(start.index, end);
    const at = block.match(new RegExp(`@(${VERBS.join("|")})\\(\\s*(?:"([^"]*)")?\\s*\\)`));
    const verb = (at?.[1] ?? start.verb).toUpperCase();
    const sub = (at?.[2] ?? "").replace(/^\/+|\/+$/g, "");
    const name = block.match(/\n  ([A-Za-z_$][\w$]*)\s*\(/);
    return {
      key: `${verb} /${[prefix, sub].filter(Boolean).join("/")}`,
      name: name ? name[1] : "(unknown)",
      line: text.slice(0, start.index).split("\n").length,
      guarded: classGuarded || /@UseGuards\([^)]*ZoneContextGuard/.test(block),
      usesZone: /@ZoneContext\(/.test(block),
    };
  });

  return { file, prefix, classGuarded, routes };
}

// ---------------------------------------------------------------------------
// 白名单
// ---------------------------------------------------------------------------

const raw = JSON.parse(fs.readFileSync(ALLOWLIST_FILE, "utf8"));
const allow = {
  file: raw.files ?? [],
  dir: raw.dirs ?? [],
  route: raw.routes ?? [],
};

for (const entry of [...allow.file, ...allow.dir, ...allow.route]) {
  if (!entry.issue || !entry.reason) {
    console.error(`✗ 白名单条目缺 issue / reason：${JSON.stringify(entry)}`);
    process.exit(1);
  }
}

const problems = [];
const controllers = walk(MODULES).map(parse).filter(Boolean);
const seenFiles = new Set();
const seenRoutes = new Set();

for (const ctrl of controllers) {
  const rel = path.relative(ROOT, ctrl.file);
  const relFromServer = path.relative(SERVER, ctrl.file);

  const fileEntry = allow.file.find((e) => e.file === relFromServer);
  const dirEntry = allow.dir.find((e) => relFromServer.startsWith(`${e.dir.replace(/\/+$/, "")}/`));
  const globalEntry = fileEntry ?? dirEntry;
  if (globalEntry) seenFiles.add(globalEntry);

  for (const route of ctrl.routes) {
    const routeEntry = allow.route.find((e) => e.route === route.key);
    if (routeEntry) seenRoutes.add(routeEntry);

    // 判据 1：整个控制器都不带区 → 必须显式登记成全局模块
    if (!route.guarded) {
      if (!globalEntry) {
        problems.push({
          where: `${rel}:${route.line}`,
          route: route.key,
          hint:
            "这个管理端控制器没有挂 ZoneContextGuard。要么在类上加 " +
            "@UseGuards(ZoneContextGuard)（本次请求属于哪个区由 X-Zone-Id 决定），" +
            "要么在 tools/admin-zone-allowlist.json 里登记成全局模块并写明理由",
        });
      }
      continue;
    }

    // 判据 2：挂了守卫就必须真的取区，除非这条例外被显式登记
    if (!route.usesZone && !routeEntry) {
      problems.push({
        where: `${rel}:${route.line}`,
        route: route.key,
        hint:
          "这条路由挂了 ZoneContextGuard 却没有用 @ZoneContext() 取区 —— 等于白挂" +
          "（守卫只判区存在，不会让 SQL 自己按区过滤）。要么把区透传给 service，" +
          "要么在 tools/admin-zone-allowlist.json 的 routes 里登记成「账号级 / 刻意跨区」",
      });
    }
    if (route.usesZone && routeEntry) {
      problems.push({
        where: rel,
        route: route.key,
        hint: "这条路由已经用上 @ZoneContext() 了 —— 白名单里的对应条目可以删掉",
      });
    }
  }
}

// 自检：白名单条目不再命中 = 红
for (const entry of allow.file) {
  if (!seenFiles.has(entry)) {
    problems.push({
      where: path.relative(ROOT, ALLOWLIST_FILE),
      route: entry.file,
      hint: `file 条目已不再命中（文件不存在、或它已经不是管理端控制器、或已经挂上守卫）—— 删掉它`,
    });
  }
}
for (const entry of allow.dir) {
  if (!seenFiles.has(entry)) {
    problems.push({
      where: path.relative(ROOT, ALLOWLIST_FILE),
      route: `${entry.dir}/*`,
      hint: `dir 条目已不再命中任何管理端控制器 —— 删掉它`,
    });
  }
}
for (const entry of allow.route) {
  if (!seenRoutes.has(entry)) {
    problems.push({
      where: path.relative(ROOT, ALLOWLIST_FILE),
      route: entry.route,
      hint: `route 条目已不再命中（路由改了名、或已经用上 @ZoneContext()）—— 删掉它`,
    });
  }
}

// ---------------------------------------------------------------------------

if (problems.length === 0) {
  const guarded = controllers.filter((c) => c.classGuarded).length;
  const routes = controllers.reduce((n, c) => n + c.routes.filter((r) => r.guarded).length, 0);
  console.log(
    `✓ 管理端单区上下文：${controllers.length} 个管理端控制器（${guarded} 个挂 ZoneContextGuard，` +
      `${routes} 条受控路由）；全局模块登记 ${allow.file.length} 个文件 + ${allow.dir.length} 个目录，` +
      `刻意不按区过滤的路由 ${allow.route.length} 条（全部带 issue 与理由）`,
  );
  process.exit(0);
}

console.error(`✗ 管理端单区上下文：${problems.length} 处问题（口径见 docs/39 §3.8）\n`);
for (const item of problems) {
  console.error(`  ${item.route}`);
  console.error(`    ${item.where}`);
  console.error(`    ${item.hint}`);
}
process.exit(1);
