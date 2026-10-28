#!/usr/bin/env node
/**
 * Cocos 构建产物的真实浏览器验证入口
 *
 * 用法：
 *   node client/tools/e2e/verify.cjs                       # 冒烟：加载 → 引擎就绪 → 场景树 → 报错 → 截图
 *   node client/tools/e2e/verify.cjs --dir build/web-desktop-001 --headed
 *   node client/tools/e2e/verify.cjs --scenario login      # 跑某个场景脚本
 *   node client/tools/e2e/verify.cjs --width 1280 --height 720   # 换窗口尺寸看适配
 *
 * 产物落在 client/tools/e2e/out/<时间戳>/：截图 + report.json + report.md
 */
const fs = require("fs");
const path = require("path");
const { serve } = require("./lib/server.cjs");
const { open } = require("./lib/browser.cjs");

const CLIENT_ROOT = path.resolve(__dirname, "../..");

function parseArgs(argv) {
  const args = { dir: "build/web-desktop-001", width: 1920, height: 1080, headless: true, scenario: "smoke", wait: 6, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    switch (key) {
      case "--dir": args.dir = next; i += 1; break;
      case "--width": args.width = Number(next); i += 1; break;
      case "--height": args.height = Number(next); i += 1; break;
      case "--wait": args.wait = Number(next); i += 1; break;
      case "--scenario": args.scenario = next; i += 1; break;
      case "--out": args.out = next; i += 1; break;
      case "--headed": args.headless = false; break;
      case "--help":
        console.log(fs.readFileSync(__filename, "utf8").split("*/")[0]);
        process.exit(0);
        break;
      default:
        if (key.startsWith("--")) console.warn(`未知参数：${key}`);
    }
  }
  return args;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname + (u.search ? "?…" : "");
  } catch {
    return url;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const buildDir = path.resolve(CLIENT_ROOT, args.dir);
  if (!fs.existsSync(path.join(buildDir, "index.html"))) {
    console.error(`找不到构建产物：${buildDir}/index.html`);
    console.error("先构建：见 client/tools/e2e/README.md");
    process.exit(2);
  }

  const outDir = args.out || path.join(__dirname, "out", stamp());
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`\n构建产物  ${path.relative(CLIENT_ROOT, buildDir)}`);
  console.log(`输出目录  ${path.relative(CLIENT_ROOT, outDir)}`);
  console.log(`窗口      ${args.width}x${args.height}  ${args.headless ? "headless" : "headed"}\n`);

  const server = await serve(buildDir, 0);
  const session = await open({ headless: args.headless, width: args.width, height: args.height });

  const report = {
    startedAt: new Date().toISOString(),
    buildDir: path.relative(CLIENT_ROOT, buildDir),
    viewport: { width: args.width, height: args.height },
    scenario: args.scenario,
    load: {},
    viewportInfo: null,
    scene: null,
    checks: [],
    errors: null,
    screenshots: [],
  };

  const fail = (name, detail) => report.checks.push({ name, ok: false, detail });
  const pass = (name, detail) => report.checks.push({ name, ok: true, detail });

  try {
    const t0 = Date.now();
    await session.goto(server.origin + "/");
    report.load.navigatedMs = Date.now() - t0;

    const readyMs = await session.waitEngineReady(45000);
    report.load.engineReadyMs = readyMs;
    if (readyMs < 0) {
      fail("引擎启动", "45 秒内没有等到首场景，游戏可能卡在加载或引擎崩溃");
    } else {
      pass("引擎启动", `${readyMs} ms 内首场景就绪`);
    }

    // 给游戏几秒真正跑起来：加载资源、跑首个 tick、连后端
    await session.page.waitForTimeout(Math.max(0, args.wait) * 1000);

    report.viewportInfo = await session.probe.call("viewportInfo").catch((e) => ({ error: String(e) }));
    const sceneName = await session.probe.call("currentScene").catch(() => null);
    report.scene = sceneName;
    if (sceneName) pass("当前场景", sceneName);

    const tree = await session.probe.call("dumpTree", { maxDepth: 8, includeInactive: false }).catch((e) => ({ error: String(e) }));
    report.tree = tree;
    if (tree && tree.nodeCount) pass("场景树", `${tree.nodeCount} 个可见节点`);

    const shot = path.join(outDir, "01-initial.png");
    await session.screenshot(shot);
    report.screenshots.push(path.basename(shot));

    report.errors = await session.collectErrors();

    const errCount =
      report.errors.fromNode.consoleErrors.length +
      report.errors.fromNode.pageErrors.length +
      report.errors.fromNode.requestsFailed.length +
      report.errors.fromNode.httpErrors.length +
      ((report.errors.fromPage && (report.errors.fromPage.consoleErrors.length + report.errors.fromPage.pageErrors.length + report.errors.fromPage.rejections.length)) || 0);
    if (errCount === 0) pass("运行期报错", "无 console error / 未捕获异常 / 资源加载失败");
    else fail("运行期报错", `${errCount} 条，见 report.json`);
  } catch (error) {
    fail("执行中断", String(error && error.stack ? error.stack.split("\n")[0] : error));
    report.fatal = String(error && error.stack ? error.stack : error);
  } finally {
    await session.close().catch(() => {});
    await server.close().catch(() => {});
  }

  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, "report.md"), renderMarkdown(report));

  console.log(renderSummary(report));
  console.log(`\n完整报告  ${path.relative(process.cwd(), path.join(outDir, "report.md"))}`);
  process.exit(report.checks.every((c) => c.ok) ? 0 : 1);
}

function renderSummary(report) {
  const lines = ["—".repeat(60)];
  for (const check of report.checks) {
    lines.push(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name}${check.detail ? "  · " + check.detail : ""}`);
  }
  const { fromNode, fromPage } = report.errors || {};
  if (fromNode) {
    const groups = [
      ["console.error", fromNode.consoleErrors.map((e) => e.text)],
      ["未捕获异常", fromNode.pageErrors.map((e) => e.message)],
      ["资源加载失败", fromNode.requestsFailed.map((e) => `${e.reason} ${shortUrl(e.url)}`)],
      ["HTTP 4xx/5xx", fromNode.httpErrors.map((e) => `${e.status} ${shortUrl(e.url)}`)],
      ["页面内 rejection", (fromPage && fromPage.rejections.map((e) => e.message)) || []],
    ];
    for (const [label, items] of groups) {
      if (!items.length) continue;
      lines.push(`\n  ${label}（${items.length}）`);
      const uniq = [...new Set(items)];
      for (const item of uniq.slice(0, 8)) lines.push(`    · ${String(item).slice(0, 160)}`);
      if (uniq.length > 8) lines.push(`    … 另有 ${uniq.length - 8} 条同类`);
    }
  }
  lines.push("—".repeat(60));
  return lines.join("\n");
}

function renderMarkdown(report) {
  const out = [];
  out.push(`# Cocos 浏览器验证报告`);
  out.push("");
  out.push(`- 构建产物：\`${report.buildDir}\``);
  out.push(`- 窗口：${report.viewport.width}×${report.viewport.height}`);
  out.push(`- 场景：${report.scene || "（未取到）"}`);
  out.push(`- 引擎就绪：${report.load.engineReadyMs} ms`);
  out.push("");
  out.push(`## 检查项`);
  out.push("");
  out.push(`| 结果 | 检查项 | 说明 |`);
  out.push(`| --- | --- | --- |`);
  for (const c of report.checks) out.push(`| ${c.ok ? "✅" : "❌"} | ${c.name} | ${c.detail || ""} |`);

  const { fromNode, fromPage } = report.errors || {};
  if (fromNode) {
    out.push("");
    out.push(`## 运行期错误`);
    const section = (title, items, render) => {
      if (!items || !items.length) return;
      out.push("");
      out.push(`### ${title}（${items.length}）`);
      out.push("");
      const uniq = [...new Set(items.map((i) => render(i)))];
      for (const line of uniq.slice(0, 25)) out.push(`- ${line}`);
      if (uniq.length > 25) out.push(`- … 另有 ${uniq.length - 25} 条`);
    };
    section("console.error", fromNode.consoleErrors, (e) => "`" + e.text.slice(0, 300) + "`");
    section("未捕获异常", fromNode.pageErrors, (e) => "`" + e.message.slice(0, 300) + "`");
    section("资源加载失败", fromNode.requestsFailed, (e) => `${e.reason} — \`${shortUrl(e.url)}\``);
    section("HTTP 错误", fromNode.httpErrors, (e) => `${e.status} — \`${shortUrl(e.url)}\``);
    if (fromPage) section("页面内 rejection", fromPage.rejections, (e) => "`" + e.message.slice(0, 300) + "`");
  }

  if (report.screenshots && report.screenshots.length) {
    out.push("");
    out.push(`## 截图`);
    for (const s of report.screenshots) out.push(`- \`${s}\``);
  }
  out.push("");
  return out.join("\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(3);
});
