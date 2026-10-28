/**
 * 浏览器会话封装
 *
 * 一个 session = 一个 Chrome page + 一套错误收集 + 已注入的探针。
 * 上层只跟 session 打交道，不直接碰 playwright 对象。
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const PROBE_SOURCE = fs.readFileSync(path.join(__dirname, "probe.js"), "utf8");

/**
 * @param {object} options
 * @param {boolean} [options.headless] 默认 true
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {boolean} [options.hasTouch] 模拟移动端触摸
 * @param {string} [options.chromePath] 指定 Chrome 可执行文件
 */
async function open(options = {}) {
  const {
    headless = true,
    width = 1920,
    height = 1080,
    hasTouch = false,
    chromePath,
  } = options;

  const launchOptions = {
    channel: chromePath ? undefined : "chrome",
    executablePath: chromePath,
    headless,
    args: [
      // headless 下 WebGL2 走 SwiftShader，不加这个新版本 Chrome 会直接拒绝创建上下文
      "--enable-unsafe-swiftshader",
      "--autoplay-policy=no-user-gesture-required",
      "--mute-audio",
      // 后台标签页会被降频，跑计时/动画相关的检查会失真
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ],
  };

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    hasTouch,
    isMobile: false,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  });

  // 必须在任何页面脚本之前注入，才能抢到最早的报错
  await context.addInitScript({ content: PROBE_SOURCE });

  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  const events = {
    consoleErrors: [],
    consoleWarns: [],
    pageErrors: [],
    requestsFailed: [],
    httpErrors: [],
    dialogs: [],
  };

  page.on("console", (msg) => {
    const type = msg.type();
    if (type === "error") events.consoleErrors.push({ text: msg.text(), location: msg.location() });
    else if (type === "warning") events.consoleWarns.push({ text: msg.text() });
  });
  page.on("pageerror", (err) => {
    events.pageErrors.push({ message: err.message, stack: String(err.stack || "").slice(0, 2000) });
  });
  page.on("requestfailed", (req) => {
    const failure = req.failure();
    events.requestsFailed.push({
      url: req.url(),
      method: req.method(),
      reason: failure ? failure.errorText : "unknown",
    });
  });
  page.on("response", (res) => {
    const status = res.status();
    if (status >= 400) {
      events.httpErrors.push({ url: res.url(), status, method: res.request().method() });
    }
  });
  page.on("dialog", async (dialog) => {
    events.dialogs.push({ type: dialog.type(), message: dialog.message() });
    await dialog.dismiss();
  });

  const session = {
    browser,
    context,
    page,
    events,
    url: "",
    console: (text) => process.stdout.write(`  ${text}\n`),

    async goto(url, waitUntil = "domcontentloaded") {
      session.url = url;
      await page.goto(url, { waitUntil, timeout: 60000 });
    },

    /** 等引擎首场景启动；返回毫秒耗时，-1 表示超时 */
    async waitEngineReady(timeoutMs = 45000) {
      return page.evaluate((t) => window.__cocosProbe.waitReady(t), timeoutMs);
    },

    probe: {
      async call(fnName, ...args) {
        return page.evaluate(
          ({ name, params }) => {
            const fn = window.__cocosProbe[name];
            if (typeof fn !== "function") throw new Error("probe 上没有 " + name);
            return fn(...params);
          },
          { name: fnName, params: args }
        );
      },
    },

    async screenshot(filePath, options = {}) {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await page.screenshot({ path: filePath, ...options });
      return filePath;
    },

    /** 页面内所有错误来源合并成一份 */
    async collectErrors() {
      const inPage = await page
        .evaluate(() => {
          const p = window.__cocosProbe;
          return p ? p.snapshotErrors() : null;
        })
        .catch(() => null);
      return { fromNode: events, fromPage: inPage };
    },

    async close() {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };

  return session;
}

module.exports = { open };
