#!/usr/bin/env node
/**
 * 服务端 e2e：玩家邮箱字段（accounts.email）
 *
 * 覆盖 issue #20 的核心行为：
 * - 邮箱是**个人信息**，只有持 `account:email` 权限的角色（ADMIN / SUPER）才看得到、改得了；
 *   只读观察员（只有 `account:read`）看不到，也改不了（403 / 30006）。
 * - 补录 / 修改 / 清空（空串）。
 * - 格式校验（400 / 40000）与去重（同一邮箱只绑一个账号，409 / 10007）。
 * - 发信兜底：选了关联账号且账号填了邮箱时，不填 `to` 也能按账号邮箱投递；都没有才 50005。
 *
 * 套路与 e2e-mail.cjs 一致（真实进程 + 真实 HTTP，跑 dist/ 产物），单独成文件便于只看这一块。
 *
 * 用法：npm run test:e2e:account-email（前置 npm run build）
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("path");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const ADMIN_CODE = "account-email-code";

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
      JWT_SECRET: "e2e-account-email-secret",
      JWT_EXPIRES_IN: "1h",
      ADMIN_REGISTER_CODE: ADMIN_CODE,
      LOG_REQUESTS: "false",
      // 邮件测试要启用通道（fake 发信器，不真发）
      SMTP_HOST: "smtp.example.test",
      SMTP_PORT: "465",
      SMTP_USER: "noreply@example.test",
      SMTP_PASS: "e2e-smtp-secret",
      SMTP_FROM: "olua <noreply@example.test>",
      MAIL_TRANSPORT: "fake",
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

/** 轮询等待条件成立 */
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
  await api(baseUrl, "POST", "/api/admin/auth/register", {
    body: { username, password, registerCode: ADMIN_CODE },
  });
  const login = await api(baseUrl, "POST", "/api/admin/auth/login", { body: { username, password } });
  return login.body?.data?.token;
}

/** 注册一个玩家账号，返回 { token, username } */
async function registerPlayer(baseUrl, username, password) {
  const res = await api(baseUrl, "POST", "/api/auth/register", { body: { username, password } });
  return { token: res.body?.data?.token, username };
}

/** 按账号名查账号 id（管理端列表接口，仅 super/admin 可用） */
async function findAccountId(baseUrl, token, username) {
  const res = await api(baseUrl, "GET", `/api/admin/accounts?keyword=${encodeURIComponent(username)}`, { token });
  return res.body?.data?.list?.find((item) => item.username === username)?.id ?? null;
}

/** 按管理员名查管理员 id（管理端管理员列表接口） */
async function findAdminId(baseUrl, token, username) {
  const res = await api(baseUrl, "GET", `/api/admin/admins?keyword=${encodeURIComponent(username)}`, { token });
  return res.body?.data?.list?.find((item) => item.username === username)?.id ?? null;
}

async function main() {
  console.log("=== 服务端 e2e：玩家邮箱字段 ===");

  const server = await startServer({});
  try {
    const base = server.baseUrl;
    const superToken = await registerAdmin(base, "email_super", "EmailSuper#1");
    check(Boolean(superToken), "超级管理员注册并登录成功（第一个注册者是超级管理员）");

    // —— 造两个玩家账号（存量库都没有邮箱） ——
    const playerA = await registerPlayer(base, "email_player_a", "pass1234");
    const playerB = await registerPlayer(base, "email_player_b", "pass1234");
    const idA = await findAccountId(base, superToken, "email_player_a");
    const idB = await findAccountId(base, superToken, "email_player_b");
    check(Boolean(idA) && Boolean(idB), "两个玩家账号已创建并可被管理端查到");

    // —— 只读观察员（只有 account:read，没有 account:email） ——
    const viewerToken = await registerAdmin(base, "email_viewer", "EmailViewer#1");
    const viewerId = await findAdminId(base, superToken, "email_viewer");
    check(Boolean(viewerId), "查到观察员管理员 id（用管理员列表接口，不是玩家账号列表）");
    const demote = await api(base, "PATCH", `/api/admin/admins/${viewerId}`, { token: superToken, body: { role: "viewer" } });
    checkEqual(demote.status, 200, "把观察员降级为 viewer 成功");

    group("一、可见性：只读观察员看不到邮箱，也改不了");
    {
      const detail = await api(base, "GET", `/api/admin/accounts/${idA}`, { token: viewerToken });
      checkEqual(detail.status, 200, "观察员能看账号详情（account:read）");
      check(detail.body?.data?.account?.email === undefined, "观察员拿到的账号里**没有** email 字段（个人信息被隐藏）");

      const patch = await api(base, "PATCH", `/api/admin/accounts/${idA}/email`, {
        token: viewerToken,
        body: { email: "viewer-sees@x.com" },
      });
      checkEqual(patch.status, 403, "观察员补录邮箱被拒（403）");
      checkEqual(patch.body?.code, 30006, "拒绝码是「权限不足」30006");
    }

    group("二、补录 / 查看 / 清空（持 account:email 的超级管理员）");
    {
      const patch = await api(base, "PATCH", `/api/admin/accounts/${idA}/email`, {
        token: superToken,
        body: { email: "a@example.com" },
      });
      checkEqual(patch.status, 200, "补录邮箱返回 200");
      checkEqual(patch.body?.data?.email, "a@example.com", "回包带上了新邮箱");

      const detail = await api(base, "GET", `/api/admin/accounts/${idA}`, { token: superToken });
      checkEqual(detail.body?.data?.account?.email, "a@example.com", "详情里能看到刚补录的邮箱（account:email 持有者可见）");
    }

    group("三、格式校验与去重");
    {
      const bad = await api(base, "PATCH", `/api/admin/accounts/${idA}/email`, {
        token: superToken,
        body: { email: "not-an-email" },
      });
      checkEqual(bad.status, 400, "非法邮箱格式返回 400");
      checkEqual(bad.body?.code, 40000, "格式错误的业务码是 40000（PARAM_INVALID）");
      checkEqual(bad.body?.data?.email ?? "a@example.com", "a@example.com", "格式错误不会改动原邮箱");

      // 先把 playerB 绑上一个邮箱
      const setB = await api(base, "PATCH", `/api/admin/accounts/${idB}/email`, {
        token: superToken,
        body: { email: "dup@example.com" },
      });
      checkEqual(setB.status, 200, "给 playerB 绑邮箱成功");

      // playerA 想用同一个邮箱 → 冲突
      const dup = await api(base, "PATCH", `/api/admin/accounts/${idA}/email`, {
        token: superToken,
        body: { email: "DUP@example.com" }, // 大小写不敏感，应判冲突
      });
      checkEqual(dup.status, 409, "同一邮箱（大小写不敏感）被别的账号占用 → 409");
      checkEqual(dup.body?.code, 10007, "冲突业务码是 10007（ACCOUNT_EMAIL_EXISTS）");
      checkEqual(dup.body?.data?.email ?? "a@example.com", "a@example.com", "冲突不会改动原邮箱");
    }

    group("四、清空（传空串）");
    {
      const clear = await api(base, "PATCH", `/api/admin/accounts/${idA}/email`, {
        token: superToken,
        body: { email: "" },
      });
      checkEqual(clear.status, 200, "清空邮箱返回 200");
      const detail = await api(base, "GET", `/api/admin/accounts/${idA}`, { token: superToken });
      check(detail.body?.data?.account?.email === null || detail.body?.data?.account?.email === undefined, "清空后邮箱为 null / 不返回");
    }

    group("五、发信兜底：按关联账号的邮箱投递");
    {
      // 重新给 playerA 绑一个邮箱
      await api(base, "PATCH", `/api/admin/accounts/${idA}/email`, {
        token: superToken,
        body: { email: "fallback@example.com" },
      });

      // 不填 to，只关联账号 → 应自动用账号的邮箱
      const send = await api(base, "POST", "/api/admin/mails", {
        token: superToken,
        body: { templateKey: "custom", subject: "通知", body: "内容", accountId: idA },
      });
      checkEqual(send.status, 201, "关联账号 + 不填 to 也能入队");
      // 收件邮箱不在「发送回包」里（那是 SendMailResultDto，只有 id/status/subject），
      // 真正落库的 to_email 要去投递记录里看
      const job = await waitFor("投递任务出现", async () => {
        const list = await api(base, "GET", "/api/admin/mails", { token: superToken });
        return list.body?.data?.list?.find((item) => item.id === send.body?.data?.id) ?? null;
      });
      checkEqual(job?.to, "fallback@example.com", "收件邮箱自动取关联账号的邮箱");

      // 都没填：账号没邮箱 + 没传 to → 50005
      const playerC = await registerPlayer(base, "email_player_c", "pass1234");
      const idC = await findAccountId(base, superToken, "email_player_c");
      const missing = await api(base, "POST", "/api/admin/mails", {
        token: superToken,
        body: { templateKey: "custom", subject: "通知", body: "内容", accountId: idC },
      });
      checkEqual(missing.status, 400, "账号没邮箱且不填 to → 被拒");
      checkEqual(missing.body?.code, 50005, "拒绝码是 50005（MAIL_ADDRESS_MISSING）");
    }

    group("六、契约：新接口归「管理端」组且带权限点");
    {
      const doc = JSON.parse(require("fs").readFileSync(path.join(SERVER_DIR, "openapi.json"), "utf8"));
      const op = doc.paths?.["/admin/accounts/{id}/email"]?.patch;
      check(Boolean(op), "PATCH /admin/accounts/{id}/email 在契约里");
      checkEqual(op?.tags?.[0], "管理端", "归「管理端」分组");
      const permissions = op?.["x-olua-permissions"] ?? [];
      check(permissions.includes("account:email"), "标了 account:email 权限点（漏了就是真放行）");
      check(Boolean(op?.operationId?.startsWith("adminAccount.")), "operationId 以 adminAccount. 开头");
    }
  } finally {
    server.kill();
  }

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
