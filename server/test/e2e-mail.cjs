#!/usr/bin/env node
/**
 * 服务端 e2e：邮件通道（SMTP 接入 / 模板 / 发送队列 / 失败重试）
 *
 * 与其余几套同一套路（真实进程 + 真实 HTTP，跑 dist/ 产物）。单独成文件是因为
 * 邮件是**外部依赖**，验法与其它模块不同：
 *
 * ## e2e 不能真的发信
 * 真实 SMTP 需要一台可达的服务器，而且会在 CI 里外发真实邮件 —— 既慢又不可接受。
 * 所以发信器做成**可替换实现**（`MAIL_TRANSPORT` 环境变量）：
 * - `fake`：一律成功 → 验「投递被触发、队列流转到已发送」
 * - `fail`：一律失败 → 验「重试、退避、用尽上限后标为失败，原因可查」
 *
 * 断言的是**队列状态流转**而不是「邮件有没有到」：外部通道的结果本就不可控，
 * 可控的是「我们有没有按预期去调用它、失败后有没有按预期处理」。
 *
 * ## 三段式启动
 * 通道的三种配置形态（启用 / 启用但投递失败 / 未启用）**不可能在同一台服务上验**，
 * 所以各起一台：它们对应运营会真实遇到的三种部署状态。
 *
 * 用法：npm run test:e2e:mail（前置 npm run build）
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const ADMIN_CODE = "mailadmin-code";

// 重试退避与模板渲染都是纯函数，直接 require 编译产物跑边界值（不必起服务）
const { retryDelayMs } = require(path.join(SERVER_DIR, "dist", "common", "utils", "mail-retry.util.js"));
const templates = require(path.join(SERVER_DIR, "dist", "modules", "mail", "mail-templates.js"));

//#region 断言小工具

let passed = 0;
let failed = 0;
const failures = [];

function group(title) {
  console.log(`\n▶ ${title}`);
}

function check(condition, label) {
  if (condition) {
    passed += 1;
    return true;
  }
  failed += 1;
  failures.push(label);
  console.log(`  ✗ ${label}`);
  return false;
}

function checkEqual(actual, expected, label) {
  return check(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}

//#endregion

/** 取一个空闲端口 */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** 起一台服务并等它就绪 */
async function startServer(env) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ENTRY], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      API_PREFIX: "api",
      DB_PATH: ":memory:",
      JWT_SECRET: "e2e-mail-secret",
      JWT_EXPIRES_IN: "1h",
      ADMIN_REGISTER_CODE: ADMIN_CODE,
      LOG_REQUESTS: "false",
      // 调度节奏调快：默认 15 秒扫一次会让这套用例跑几十秒
      MAIL_POLL_MS: "50",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverErrors = [];
  child.stderr.on("data", (chunk) => serverErrors.push(String(chunk)));

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务进程提前退出（code=${child.exitCode}）\n${serverErrors.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return { baseUrl, kill: () => child.kill("SIGTERM") };
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("等待服务启动超时");
}

/** 发一次请求，返回 { status, body }（body 是唯一包裹体） */
async function api(baseUrl, method, route, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

/** 轮询等待条件成立（队列是异步投递的，状态到位需要时间） */
async function waitFor(label, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  check(false, `${label}（等待超时）`);
  return last;
}

/** 注册并登录一个管理员，返回 token */
async function registerAdmin(baseUrl, username, password) {
  const registered = await api(baseUrl, "POST", "/api/admin/auth/register", {
    body: { username, password, registerCode: ADMIN_CODE },
  });
  check(Boolean(registered.body?.data), `注册管理员 ${username}`);
  const login = await api(baseUrl, "POST", "/api/admin/auth/login", { body: { username, password } });
  check(Boolean(login.body?.data?.token), `登录管理员 ${username}`);
  return login.body?.data?.token;
}

/** 取一条投递任务 */
async function mailById(baseUrl, token, id) {
  const list = await api(baseUrl, "GET", "/api/admin/mails", { token });
  return list.body?.data?.list?.find((item) => item.id === id) ?? null;
}

//#region 零：纯函数（不起服务）

function runUtilSuite() {
  group("零、重试退避纯函数：指数增长 / 倍数封顶");

  const base = 1000;
  checkEqual(retryDelayMs(1, base), 1000, "第 1 次失败等 1 倍基数");
  checkEqual(retryDelayMs(2, base), 2000, "第 2 次失败等 2 倍（指数退避）");
  checkEqual(retryDelayMs(3, base), 4000, "第 3 次失败等 4 倍");
  checkEqual(retryDelayMs(10, base), 32_000, "第 10 次失败后倍数封顶 32（不至于等到几年后）");
  checkEqual(retryDelayMs(50, base), 32_000, "再往后也停在封顶值");
  checkEqual(retryDelayMs(0, base), 0, "未尝试过就不必等待");
  checkEqual(retryDelayMs(2, 0), 0, "基数为 0 = 立即重试");

  group("零之二、模板纯函数：必填变量 / 渲染 / 自定义");

  const welcome = templates.findMailTemplate("welcome");
  check(Boolean(welcome), "能按 key 取到 welcome 模板");
  checkEqual(templates.missingVariables(welcome, {}).join(","), "username", "缺必填变量会被列出来");
  checkEqual(templates.missingVariables(welcome, { username: "  " }).join(","), "username", "空白值也算缺失");
  checkEqual(templates.missingVariables(welcome, { username: "张三" }).length, 0, "给全了就不缺");

  const rendered = templates.renderMail(welcome, { username: "张三" });
  check(rendered.subject.includes("张三"), "标题里的占位符被替换");
  check(!rendered.subject.includes("{{"), "渲染后不残留占位符");
  check(!rendered.body.includes("{{"), "正文里不残留占位符");

  const custom = templates.findMailTemplate("custom");
  checkEqual(custom.variables.length, 0, "自定义模板没有必填变量");
  const own = templates.renderMail(custom, {}, { subject: "停机通知", body: "今晚 2 点停机" });
  checkEqual(own.subject, "停机通知", "自定义模板用运营填的标题");
  checkEqual(own.body, "今晚 2 点停机", "自定义模板用运营填的正文");
  checkEqual(
    templates.renderMail(custom, {}, { subject: "含 {{x}} 字面量" }).subject,
    "含 {{x}} 字面量",
    "自定义正文里的 {{}} 是字面内容，不被当占位符吃掉",
  );
}

//#endregion

//#region 一：通道启用（fake 发信器）—— 入队、投递、追溯

async function runEnabledSuite() {
  group("一、通道启用：发信入队 → 后台投递 → 已发送");

  const server = await startServer({
    SMTP_HOST: "smtp.example.test",
    SMTP_PORT: "465",
    SMTP_USER: "noreply@example.test",
    SMTP_PASS: "e2e-smtp-secret",
    SMTP_FROM: "olua <noreply@example.test>",
    MAIL_TRANSPORT: "fake",
  });
  try {
    const base = server.baseUrl;
    const token = await registerAdmin(base, "mailadmin", "MailAdmin#1");
    check(Boolean(token), "管理员注册并登录成功（第一个注册者是超级管理员）");

    // —— 模板列表 ——
    const templatesRes = await api(base, "GET", "/api/admin/mails/templates", { token });
    const list = templatesRes.body?.data ?? [];
    checkEqual(templatesRes.status, 200, "模板列表 200");
    check(list.some((item) => item.key === "welcome"), "模板列表里有 welcome");
    check(list.some((item) => item.key === "custom"), "模板列表里有 custom");
    check(
      list.find((item) => item.key === "welcome").variables.includes("username"),
      "welcome 声明了 username 必填变量",
    );

    // —— 发信（入队即返回） ——
    const send = await api(base, "POST", "/api/admin/mails", {
      token,
      body: { to: "player@example.com", templateKey: "welcome", variables: { username: "张三" } },
    });
    checkEqual(send.status, 201, "发信返回 201");
    checkEqual(send.body?.data?.status, "pending", "入队后状态是 pending（**不等投递**）");
    check(send.body?.data?.subject?.includes("张三"), "返回的标题是渲染后的（占位符已替换）");
    const jobId = send.body?.data?.id;

    // —— 后台调度器完成投递 ——
    const sent = await waitFor("任务最终变成已发送", async () => {
      const job = await mailById(base, token, jobId);
      return job && job.status === "sent" ? job : null;
    });
    checkEqual(sent?.status, "sent", "调度器把任务投递成功");
    checkEqual(sent?.attempts, 1, "成功只尝试了 1 次");
    check(typeof sent?.sentAt === "number" && sent.sentAt > 0, "已发送时间有值");
    checkEqual(sent?.lastError, null, "成功后没有失败原因");
    check(sent?.body?.includes("张三"), "正文是入队那一刻渲染的结果");
    checkEqual(sent?.createdBy, "mailadmin", "记录里留了发起人（管理员被删也追得到）");

    // —— 缺必填变量直接拒发 ——
    const missing = await api(base, "POST", "/api/admin/mails", {
      token,
      body: { to: "p2@example.com", templateKey: "welcome", variables: {} },
    });
    checkEqual(missing.status, 400, "缺必填变量返回 400");
    checkEqual(missing.body?.code, 50007, "缺必填变量的业务码是 50007");
    check(missing.body?.message?.includes("username"), "提示里点名缺哪个变量");

    // —— 自定义模板：必须自己填标题与正文 ——
    const customEmpty = await api(base, "POST", "/api/admin/mails", {
      token,
      body: { to: "p3@example.com", templateKey: "custom" },
    });
    checkEqual(customEmpty.body?.code, 50007, "自定义模板没填标题正文 → 50007");

    const customOk = await api(base, "POST", "/api/admin/mails", {
      token,
      body: { to: "p3@example.com", templateKey: "custom", subject: "停机通知", body: "今晚 2 点停机" },
    });
    checkEqual(customOk.body?.data?.subject, "停机通知", "自定义模板填了就能发");

    // —— 关联不存在的玩家账号 ——
    const badAccount = await api(base, "POST", "/api/admin/mails", {
      token,
      body: { to: "p4@example.com", templateKey: "welcome", variables: { username: "李四" }, accountId: "no-such-account" },
    });
    checkEqual(badAccount.body?.code, 50004, "关联了不存在的账号 → 50004");
    checkEqual(badAccount.status, 404, "账号不存在按 404 返（与其它「找不到」一致）");

    // —— 列表筛选 ——
    const all = await api(base, "GET", "/api/admin/mails", { token });
    // 只会有 2 条：被拒的那三封（缺变量 / 自定义空 / 账号不存在）**不会**入队
    checkEqual(all.body?.data?.total >= 2, true, "投递记录累计了多条");
    const byStatus = await api(base, "GET", "/api/admin/mails?status=sent", { token });
    check(
      (byStatus.body?.data?.list ?? []).every((item) => item.status === "sent"),
      "按状态筛选：结果里只有已发送",
    );
    const byKeyword = await api(base, "GET", "/api/admin/mails?keyword=p3@example.com", { token });
    checkEqual(byKeyword.body?.data?.total, 1, "按邮箱关键字筛选命中 1 条");

    // —— 审计留痕（邮件是「对外发声」，必须可追溯） ——
    const audit = await api(base, "GET", "/api/admin/audit-logs?size=50", { token });
    const mails = (audit.body?.data?.list ?? []).filter((item) => item.action === "adminMail.send");
    check(mails.length > 0, "发信进了操作日志");
    checkEqual(mails[0]?.actorName, "mailadmin", "审计记下了操作人");
    // 创建类接口没有路由参数 `:id`，审计的 targetId 取不到（与公告发布一致）；
    // 「发给了谁」由请求体留痕兜住 —— 邮件触达真实用户，事后必须能回答这个问题
    check(
      mails.some((item) => JSON.stringify(item.detail ?? "").includes("player@example.com")),
      "审计里留了收件邮箱（事后能回答「发给了谁」）",
    );

    // —— 权限：只读观察员**没有**邮件读权限 ——
    const viewerToken = await registerAdmin(base, "mailviewer", "MailViewer#1");
    const admins = await api(base, "GET", "/api/admin/admins", { token });
    const viewerRow = admins.body?.data?.list?.find((item) => item.username === "mailviewer");
    await api(base, "PATCH", `/api/admin/admins/${viewerRow.id}`, { token, body: { role: "viewer" } });
    const viewerMails = await api(base, "GET", "/api/admin/mails", { token: viewerToken });
    checkEqual(viewerMails.status, 403, "只读观察员看不了邮件投递记录（含玩家邮箱，属个人信息）");
    checkEqual(viewerMails.body?.code, 30006, "拒绝码是「权限不足」30006");
    const viewerSend = await api(base, "POST", "/api/admin/mails", {
      token: viewerToken,
      body: { to: "x@example.com", templateKey: "custom", subject: "a", body: "b" },
    });
    checkEqual(viewerSend.status, 403, "只读观察员更不能发信");
  } finally {
    server.kill();
  }
}

//#endregion

//#region 二：投递失败（fail 发信器）—— 重试、退避、上限、重投

async function runFailureSuite() {
  group("二、投递失败：重试 → 用尽上限 → 标为失败 → 可重投");

  const server = await startServer({
    SMTP_HOST: "smtp.example.test",
    SMTP_USER: "noreply@example.test",
    SMTP_PASS: "e2e-smtp-secret",
    MAIL_TRANSPORT: "fail",
    MAIL_MAX_ATTEMPTS: "3",
    MAIL_RETRY_BASE_MS: "30",
  });
  try {
    const base = server.baseUrl;
    const token = await registerAdmin(base, "failadmin", "FailAdmin#1");

    const send = await api(base, "POST", "/api/admin/mails", {
      token,
      body: { to: "ghost@example.com", templateKey: "welcome", variables: { username: "王五" } },
    });
    const jobId = send.body?.data?.id;
    checkEqual(send.body?.data?.status, "pending", "失败场景同样是先入队");

    // 中间态：第一次失败后应当进入「重试中」而不是直接判死
    const retrying = await waitFor("观察到重试中状态", async () => {
      const job = await mailById(base, token, jobId);
      return job && job.status === "retrying" ? job : null;
    }, 3_000);
    if (retrying) {
      checkEqual(retrying.status, "retrying", "第一次失败后进入重试中（不是直接失败）");
      checkEqual(retrying.attempts, 1, "重试中时已尝试 1 次");
      check(typeof retrying.nextRetryAt === "number", "重试中带着「下次重试时间」（退避由服务端算）");
      check(Boolean(retrying.lastError), "重试中已记下失败原因");
    }

    // 终态：次数用尽后标为失败，原因可查
    const failed = await waitFor("任务最终变成失败", async () => {
      const job = await mailById(base, token, jobId);
      return job && job.status === "failed" ? job : null;
    });
    checkEqual(failed?.status, "failed", "超过上限后标为最终失败");
    checkEqual(failed?.attempts, 3, "最终失败时尝试了 3 次（= MAIL_MAX_ATTEMPTS）");
    check(failed?.lastError?.includes("测试发信器"), "失败原因可查：写清楚是测试发信器拒收");
    checkEqual(failed?.sentAt, null, "没发出去就不会有发送时间");

    // —— 手动重投：只有最终失败的能重投 ——
    const sentJob = await api(base, "POST", "/api/admin/mails", {
      token,
      body: { to: "x@example.com", templateKey: "custom", subject: "不会被投递成功", body: "x" },
    });
    const pendingId = sentJob.body?.data?.id;
    const retryPending = await api(base, "POST", `/api/admin/mails/${pendingId}/retry`, { token });
    checkEqual(retryPending.status, 400, "重投一条「还不是终态」的任务会被拒");
    checkEqual(retryPending.body?.code, 50009, "拒绝码是 50009（状态不允许，与「任务不存在」分开）");

    const retried = await api(base, "POST", `/api/admin/mails/${jobId}/retry`, { token });
    checkEqual(retried.status, 201, "重投最终失败的任务成功（POST 一律 201）");
    checkEqual(retried.body?.data?.status, "pending", "重投后状态回到待发送");
    checkEqual(retried.body?.data?.attempts, 0, "重投把尝试次数归零（故障已排除，该重新拿满次数）");
    checkEqual(retried.body?.data?.lastError, null, "重投清掉旧失败原因");

    const failedAgain = await waitFor("重投后再次失败", async () => {
      const job = await mailById(base, token, jobId);
      return job && job.status === "failed" ? job : null;
    });
    // 归零的证据：如果续着数，这次只会再试 0 次就到上限；归零后应当又是完整 3 次
    checkEqual(failedAgain?.attempts, 3, "重投后重新走满 3 次（证明次数真的归零了）");

    const notFound = await api(base, "POST", "/api/admin/mails/no-such-job/retry", { token });
    checkEqual(notFound.body?.code, 50008, "重投不存在的任务 → 50008");

    // 重投带路由参数 `:id`，所以审计能关联出目标名 —— 这一条同时验证 mail 类型进了目标名关联
    const audit = await api(base, "GET", "/api/admin/audit-logs?size=50", { token });
    const retryLogs = (audit.body?.data?.list ?? []).filter((item) => item.action === "adminMail.retry");
    check(retryLogs.length > 0, "重投也进了操作日志");
    check(
      retryLogs.some((item) => item.targetName?.includes("王五")),
      "重投的审计目标名是邮件标题（uuid 看不出那封信说了什么）",
    );
  } finally {
    server.kill();
  }
}

//#endregion

//#region 三：未配置 SMTP —— 整体禁用，且密钥只报形态

async function runDisabledSuite() {
  group("三、未启用：功能整体禁用，而不是静默丢信");

  // 刻意不传任何 SMTP_* 环境变量
  const server = await startServer({ MAIL_TRANSPORT: "smtp" });
  try {
    const base = server.baseUrl;
    const token = await registerAdmin(base, "offadmin", "OffAdmin#1");

    const send = await api(base, "POST", "/api/admin/mails", {
      token,
      body: { to: "someone@example.com", templateKey: "welcome", variables: { username: "赵六" } },
    });
    checkEqual(send.status, 400, "未启用时发信被拒（不会假装成功）");
    checkEqual(send.body?.code, 50003, "业务码是 50003（邮件通道未启用）");
    check(send.body?.message?.includes("SMTP_HOST"), "提示里点名要配哪些环境变量（是可执行的人话）");

    const list = await api(base, "GET", "/api/admin/mails", { token });
    checkEqual(list.body?.data?.total, 0, "被拒的发信不会留下一条永远发不出去的任务");

    // —— 系统信息页：密钥只报「已配置 / 未配置」 ——
    const info = await api(base, "GET", "/api/admin/system", { token });
    const snapshot = info.body?.data?.config ?? [];
    const mailEnabled = snapshot.find((item) => item.key === "MAIL_ENABLED");
    check(mailEnabled?.value?.includes("未启用"), "系统信息页明确显示通道未启用");

    const pass = snapshot.find((item) => item.key === "SMTP_PASS");
    checkEqual(pass?.sensitive, true, "SMTP 密码被标记为敏感项");
    checkEqual(pass?.value, "未设置", "未配置时只报「未设置」，不回显任何原文");
    check(!JSON.stringify(snapshot).includes("e2e-smtp"), "整张快照里不出现任何 SMTP 凭据原文");
  } finally {
    server.kill();
  }
}

//#endregion

//#region 四：契约（openapi.json）—— 分组与权限标注

function runContractSuite() {
  group("四、契约：新接口都归「管理端」组且带权限点");

  const doc = JSON.parse(require("fs").readFileSync(path.join(SERVER_DIR, "openapi.json"), "utf8"));
  const operations = [
    ["GET", "/admin/mails"],
    ["GET", "/admin/mails/templates"],
    ["POST", "/admin/mails"],
    ["POST", "/admin/mails/{id}/retry"],
  ];
  operations.forEach(([method, route]) => {
    const op = doc.paths?.[route]?.[method.toLowerCase()];
    if (!check(Boolean(op), `${method} ${route} 在契约里`)) return;
    checkEqual(op.tags?.[0], "管理端", `${method} ${route} 归「管理端」分组`);
    checkEqual(op.tags?.length, 1, `${method} ${route} 恰好属于一个分组`);
    const permissions = op["x-olua-permissions"] ?? [];
    check(permissions.length > 0, `${method} ${route} 标了权限点（漏了就是真放行）`);
    check(
      permissions.includes("mail:read") || permissions.includes("mail:write"),
      `${method} ${route} 的权限点是 mail:read / mail:write`,
    );
    check(Boolean(op.operationId?.startsWith("adminMail.")), `${method} ${route} 的 operationId 以 adminMail. 开头`);
  });

  checkEqual(doc.paths?.["/announcements/active"]?.get?.tags?.[0], "公共接口", "玩家侧公告接口仍归「公共接口」（未被这次改动波及）");
}

//#endregion

async function main() {
  console.log("=== 服务端 e2e：邮件通道 ===");
  runUtilSuite();
  await runEnabledSuite();
  await runFailureSuite();
  await runDisabledSuite();
  runContractSuite();

  console.log("");
  if (failed > 0) {
    console.log(`❌ ${passed} 条通过 / ${failed} 条失败`);
    failures.forEach((item) => console.log(`   - ${item}`));
    process.exit(1);
  }
  console.log(`✅ ${passed} 条通过 / 0 条失败`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
