#!/usr/bin/env node
/**
 * 改动哪跑哪（targeted regression runner）
 *
 * ===========================================================================
 * 为什么必须有这个
 * ===========================================================================
 * 全量回归（make verify：三端类型检查 + 58 套单测 + 24 套 e2e + 全部审计）一次要跑
 * 很久，而日常改动往往只碰一个模块 —— 「稍微改个东西就全部重跑」不是更安全，
 * 是在烧时间，烧到最后人会开始绕过门禁。#541 把回归硬性门槛改成：**改动了哪里，
 * 就跑哪里受影响的那几套**；make verify 留给发布前的全量确认。
 *
 * 映射策略（刻意保守，宁可多跑一套也不漏）：
 *   - 客户端单测**按内容匹配**：改了 `StorageManager.ts`，就把源码里提到
 *     `StorageManager` 的那几套 test-*.cjs 跑一遍。测试文件自己会过时，
 *     但「它测谁」写在其源码里，内容匹配不需要人维护映射表。
 *   - 服务端 e2e **按模块表匹配**：e2e 是黑盒 HTTP 测试，源码里认不出模块归属，
 *     所以这里显式登记「模块目录 → 套件」；改了表里没有的模块 → 全量 e2e，
 *     并把缺项补进这张表（宁可全量，不可静默漏）。
 *   - 审计按「它守什么」匹配：文档动了跑文档数字审计，env 配置动了跑硬编码审计，
 *     configs 动了跑数据漂移审计；`tools/audit-x.cjs` 自己被改 → 跑它自己。
 *
 * 用法：
 *   node tools/test-changed.cjs              # 工作区未提交改动（git diff HEAD + 未跟踪）
 *   node tools/test-changed.cjs --base=main  # 相对某个基准的全部改动
 *
 * 退出码：全部通过 = 0；任一步失败 = 1（停在该步，后面的不跑 —— 失败优先修）。
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");

//#region 运行环境

/** 受限终端注入的 NODE_OPTIONS 会让 node 子进程静默起不来 —— 一律摘掉再跑 */
delete process.env.NODE_OPTIONS;

/** 与 Makefile 同款默认：客户端类型检查用 Cocos 自带的 tsc */
const TSC =
  process.env.OLUA_TSC ||
  "/Applications/Cocos/Creator/3.8.7/CocosCreator.app/Contents/Resources/app.asar.unpacked/node_modules/typescript/bin/tsc";

//#endregion

//#region 改动收集

function collectChangedFiles() {
  const baseArg = process.argv.find((a) => a.startsWith("--base="));
  const files = new Set();
  const run = (args) =>
    execFileSync("git", args, { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  if (baseArg) {
    const base = baseArg.slice("--base=".length);
    // 三点 diff：分叉点以来的全部改动（含本分支提交），不含 base 自己后来的变化
    for (const f of run(["diff", "--name-only", `${base}...HEAD`])) files.add(f);
  }
  // 工作区（未提交）：已跟踪的改动 + 未跟踪的新文件
  for (const f of run(["diff", "--name-only", "HEAD"])) files.add(f);
  for (const f of run(["ls-files", "--others", "--exclude-standard"])) files.add(f);
  return [...files];
}

//#endregion

//#region 映射规则

/**
 * 服务端模块目录 → e2e 套件（`npm run test:e2e:<name>` 的 <name>）
 *
 * 这是一张**人工维护**的表：e2e 是黑盒 HTTP 测试，认不出自己测哪个模块。
 * 新增模块/新增 e2e 时补一行；改了表外的东西宁可全量跑，也不静默漏。
 */
const SERVER_MODULE_E2E = [
  ["src/modules/auth", ["guard"]],
  ["src/modules/roles", ["roles"]],
  ["src/modules/mail", ["mail", "game-mail"]],
  ["src/modules/realtime", ["realtime", "combat", "world"]],
  ["src/modules/world", ["world"]],
  ["src/modules/combat", ["combat", "roles"]],
  ["src/modules/game-config", ["game-config"]],
  ["src/modules/zone", ["zone"]],
  ["src/modules/guild", ["guild"]],
  ["src/modules/social", ["social"]],
  ["src/modules/chat", ["chat"]],
  ["src/modules/quest", ["quest"]],
  ["src/modules/sell", ["sell"]],
  ["src/modules/blocks", ["blocks"]],
  ["src/modules/party", ["party", "realtime"]],
  ["src/modules/leaderboard", ["rank"]],
  ["src/modules/achievement", ["achievement"]],
  ["src/modules/admin", ["guard"]],
  // 共享数据 / 建库 / 进程装配是「所有套件的底座」—— 动了就全量
  ["src/shared", "ALL"],
  ["src/database", "ALL"],
  ["src/common", "ALL"],
  ["src/config", "ALL"],
  ["src/main.ts", "ALL"],
  ["src/main.realtime.ts", "ALL"],
];

/** 服务端改动必跑的审计（便宜、且守的都是「静默失效」类问题） */
const SERVER_AUDITS = ["audit-server-boundaries", "audit-api-hardcode"];

//#endregion

//#region 计划构造

/** @returns {{ clientTsc: boolean, clientTests: string[], serverTsc: boolean, e2e: string[]|null(=全量), adminTsc: boolean, audits: string[], notes: string[] }} */
function buildPlan(files) {
  const plan = {
    clientTsc: false,
    clientTests: new Set(),
    serverTsc: false,
    e2e: new Set(), // null = 全量
    adminTsc: false,
    audits: new Set(),
    notes: [],
  };
  let clientTouched = false;
  let serverTouched = false;
  let serverNeedsAllE2E = false;

  for (const rel of files) {
    // ---------- 客户端 ----------
    if (rel.startsWith("client/")) {
      clientTouched = true;
      if (rel.startsWith("client/assets/configs/")) {
        // 配置表是三端共享数据的源头：数据漂移审计必须跑
        plan.audits.add("audit-shared-data");
        plan.audits.add("audit-equip-align-catalog");
      }
      if (rel.startsWith("client/tools/test-")) {
        plan.clientTests.add(path.basename(rel, ".cjs"));
        continue;
      }
      continue;
    }

    // ---------- 服务端 ----------
    if (rel.startsWith("server/")) {
      serverTouched = true;
      if (rel.startsWith("server/src/")) {
        plan.serverTsc = true;
        for (const audit of SERVER_AUDITS) plan.audits.add(audit);
        if (rel === "server/.env.example" || rel.startsWith("server/src/config/")) {
          plan.audits.add("audit-api-hardcode");
        }
        if (rel.startsWith("server/src/shared/") || rel.startsWith("server/src/database/")) {
          plan.audits.add("audit-shared-data");
        }
        const hit = SERVER_MODULE_E2E.find(([dir]) => rel.startsWith(`server/${dir}`));
        if (hit) {
          if (hit[1] === "ALL") serverNeedsAllE2E = true;
          else for (const name of hit[1]) plan.e2e.add(name);
        } else {
          serverNeedsAllE2E = true;
          plan.notes.push(`server/src 下表外路径 ${rel} —— e2e 回落全量（补进 SERVER_MODULE_E2E 后可收敛）`);
        }
      } else if (rel.startsWith("server/test/")) {
        // 直接改了某个 e2e：跑它自己（套件名 = 去掉 e2e- 前缀；backup.cjs 的名字就是 backup）
        const m = rel.match(/(?:^|\/)(?:e2e-)?([\w-]+)\.cjs$/);
        if (m) plan.e2e.add(m[1]);
      } else if (rel === "server/package.json" || rel.startsWith("server/tsconfig")) {
        plan.serverTsc = true;
      }
      continue;
    }

    // ---------- 管理端 ----------
    if (rel.startsWith("admin/src/") || rel === "admin/package.json") {
      plan.adminTsc = true;
      continue;
    }

    // ---------- 审计脚本自己被改 ----------
    const auditMatch = rel.match(/^tools\/(audit-[\w-]+)\.cjs$/);
    if (auditMatch) {
      plan.audits.add(auditMatch[1]);
      continue;
    }

    // ---------- 文档 / 官网 / 技能（数字守卫与双语 parity 守着它们） ----------
    if (/\.(md|html)$/.test(rel) || rel.startsWith(".workbuddy/")) {
      plan.audits.add("audit-doc-numbers");
      if (!rel.startsWith("website/")) plan.audits.add("audit-docs-en");
      continue;
    }

    // ---------- 其余（Makefile、资源清单、CI 配置…） ----------
    plan.notes.push(`${rel}：无定向映射，跳过（必要时手动 make verify）`);
  }

  // 客户端单测内容匹配：改的文件名（去扩展名）出现在哪套测试的源码里，就跑哪套
  if (clientTouched) {
    plan.clientTsc = true;
    const changedNames = files
      .filter((f) => f.startsWith("client/assets/"))
      .map((f) => path.basename(f).replace(/\.\w+$/, ""))
      .filter(Boolean);
    if (changedNames.length > 0) {
      for (const t of fs.readdirSync(path.join(ROOT, "client", "tools"))) {
        if (!/^test-[\w-]+\.cjs$/.test(t)) continue;
        const name = t.slice(0, -4);
        if (plan.clientTests.has(name)) continue;
        const source = fs.readFileSync(path.join(ROOT, "client", "tools", t), "utf8");
        if (changedNames.some((n) => source.includes(n))) plan.clientTests.add(name);
      }
    }
  }

  if (serverTouched && !plan.serverTsc) plan.serverTsc = true; // 只改了 test/ 也要能编译
  if (serverNeedsAllE2E) plan.e2e = null;

  return {
    clientTsc: plan.clientTsc,
    clientTests: [...plan.clientTests],
    serverTsc: plan.serverTsc,
    e2e: plan.e2e === null ? null : [...plan.e2e],
    adminTsc: plan.adminTsc,
    audits: [...plan.audits],
    notes: plan.notes,
  };
}

//#endregion

//#region 执行

const steps = [];

function step(title, fn) {
  steps.push({ title, fn });
}

function sh(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

/** 客户端单测的已知基线红（全是素材未入库：散帧归档 / 素材目录不在仓库，#235）：失败不算门禁失败 */
const CLIENT_BASELINE_RED = new Set([
  "test-equipment-appearance",
  "test-equipment-detail-background",
  "test-monster-config",
  "test-role-default-cloth",
  "test-role-frames",
]);

/** 全部 e2e 套件名（与 server/package.json 的 test:e2e:* 一致；e2e.cjs 本身是全量入口不重复跑） */
function allE2eNames() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "server", "package.json"), "utf8"));
  return Object.keys(pkg.scripts)
    .filter((s) => /^test:e2e/.test(s) && s !== "test:e2e")
    .map((s) => s.replace("test:e2e:", ""))
    .sort();
}

function main() {
  // 删除的文件不进映射：文件已不在磁盘上，没有「跑它」可言（尤其 audit-*/test-* 被删时）
  const files = collectChangedFiles().filter((f) => fs.existsSync(path.join(ROOT, f)));
  if (files.length === 0) {
    console.log("工作区没有改动 —— 没什么要跑的。");
    return;
  }
  const plan = buildPlan(files);

  console.log("==> 本次改动：");
  for (const f of files) console.log(`    ${f}`);
  console.log("");

  if (plan.clientTsc) {
    step("客户端类型检查", () => {
      sh(process.execPath, [TSC, "-p", "tools/tsconfig.check.json"], path.join(ROOT, "client"));
    });
  }
  for (const t of plan.clientTests) {
    step(`客户端单测 ${t}`, () => {
      try {
        sh(process.execPath, [path.join(ROOT, "client", "tools", `${t}.cjs`)], ROOT);
      } catch (error) {
        if (CLIENT_BASELINE_RED.has(t)) {
          console.log(`  （已知基线红：素材未入库，不计入门禁 —— ${t}）`);
          return;
        }
        throw error;
      }
    });
  }
  if (plan.adminTsc) {
    step("管理端类型检查", () => sh("npm", ["run", "typecheck"], path.join(ROOT, "admin")));
  }
  if (plan.serverTsc) {
    step("服务端编译（tsc）", () => sh("npm", ["run", "build"], path.join(ROOT, "server")));
  }
  const e2eNames = plan.e2e === null ? allE2eNames() : plan.e2e;
  for (const name of e2eNames) {
    step(`服务端 e2e ${name}`, () => sh("npm", ["run", `test:e2e:${name}`], path.join(ROOT, "server")));
  }
  for (const audit of plan.audits) {
    step(`审计 ${audit}`, () => sh(process.execPath, [path.join(ROOT, "tools", `${audit}.cjs`)], ROOT));
  }

  if (steps.length === 0) {
    console.log("映射后没有需要跑的验证 —— 改动不触及三端代码与受管文档。");
    for (const n of plan.notes) console.log(`  · ${n}`);
    return;
  }

  console.log("==> 计划（改动哪跑哪）：");
  for (const s of steps) console.log(`    - ${s.title}`);
  if (plan.e2e === null) console.log("    （e2e 全量：改动落在所有套件共用的底座上）");
  for (const n of plan.notes) console.log(`  · ${n}`);
  console.log("");

  for (const s of steps) {
    console.log(`\n==> ${s.title}`);
    try {
      s.fn();
    } catch {
      console.error(`\n✗ ${s.title} 失败 —— 修好它再重跑 make test-changed（后面的步骤已跳过）。`);
      process.exit(1);
    }
  }

  console.log(`\n✓ 定向回归全绿：${steps.length} 步（改动哪跑哪）。发布前的全量门禁仍是 make verify。`);
}

main();

//#endregion
