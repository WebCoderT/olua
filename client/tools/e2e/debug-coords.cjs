#!/usr/bin/env node
/**
 * 坐标换算校准工具
 *
 * 把「引擎世界坐标 → 页面 CSS 坐标」算出来的矩形盖回页面上，截图肉眼对一遍。
 * 任何时候改了 canvas 布局、换了窗口尺寸、升级了 Cocos 版本，都用这个先验一下，
 * 否则后面所有点击都可能整体偏掉。
 *
 * 用法：node client/tools/e2e/debug-coords.cjs [节点名...] [--dir build/xxx]
 */
const path = require("path");
const { serve } = require("./lib/server.cjs");
const { open } = require("./lib/browser.cjs");

const CLIENT_ROOT = path.resolve(__dirname, "../..");

const args = process.argv.slice(2);
const dirIndex = args.indexOf("--dir");
const buildRel = dirIndex >= 0 ? args[dirIndex + 1] : "build/web-desktop-001";
const names = args.filter((a, i) => !a.startsWith("--") && (dirIndex < 0 || i !== dirIndex + 1));
const targets = names.length ? names : ["login_button", "register_button", "input"];

(async () => {
  const buildDir = path.resolve(CLIENT_ROOT, buildRel);
  const server = await serve(buildDir, 0);
  const session = await open({ width: 1920, height: 1080 });

  try {
    await session.goto(server.origin + "/");
    const ready = await session.waitEngineReady(45000);
    console.log(`引擎就绪 ${ready} ms`);
    await session.page.waitForTimeout(8000);

    const result = await session.page.evaluate(async (nodeNames) => {
      const probe = window.__cocosProbe;
      const colors = ["#ff2d55", "#00d084", "#0a84ff", "#ffb020"];
      const out = [];
      for (let i = 0; i < nodeNames.length; i += 1) {
        const nodes = await probe.findAll(nodeNames[i]);
        if (!nodes.length) {
          out.push({ name: nodeNames[i], found: false });
          continue;
        }
        const node = nodes[0];
        const rect = await probe.nodeClientRect(node);
        probe.markRect(rect, `${nodeNames[i]} #${i}`, colors[i % colors.length]);
        out.push({
          name: nodeNames[i],
          found: true,
          count: nodes.length,
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
          center: { x: Math.round(rect.center.x), y: Math.round(rect.center.y) },
          world: rect.world,
        });
      }
      return out;
    }, targets);

    console.table(result);

    const out = path.join(__dirname, "out", "coords.png");
    await session.screenshot(out);
    console.log("截图：" + out);
  } finally {
    await session.close().catch(() => {});
    await server.close().catch(() => {});
  }
})();
