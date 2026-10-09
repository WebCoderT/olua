#!/usr/bin/env node
/**
 * 服务端 e2e：口令管理 / 操作审计 / 登录限流 / 踢下线
 *
 * 与 test/e2e.cjs 同一套路（真实进程 + 真实 HTTP，跑 dist/ 产物），单独成文件是因为这四条
 * 都属于「运营与安全底座」，与主流程冒烟分开跑更容易定位。
 *
 * 两段式启动：
 * - 第一台服务用**默认阈值之外的宽松 IP 维度**（LOGIN_IP_MAX_FAILURES=1000），
 *   这样「按用户名锁定」能单独验，不会因为同一台机器 IP 相同而把后面的用例一起锁死；
 * - 第二台服务把 IP 维度调到 1、用户名维度调高，专门验 IP 维度的锁定。
 *
 * 用法：npm run test:e2e:guard（前置 npm run build）
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
// 限流的判定是纯函数，直接 require 编译产物跑边界值（不必起服务）
const rateLimit = require(path.join(__dirname, "..", "dist", "common", "utils", "rate-limit.util.js"));
// 封禁的到期判定同理：纯函数，边界值不必起服务
const ban = require(path.join(__dirname, "..", "dist", "common", "utils", "ban.util.js"));
// CSV 转义同理：导出功能的「防公式注入」就在这里，纯函数验最准
const csv = require(path.join(__dirname, "..", "dist", "common", "utils", "csv.util.js"));

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const ADMIN_CODE = "guard-admin-code";

/**
 * 内置的默认 JWT 密钥
 *
 * **不抄字面量**：把环境变量摘掉后算一次 `configuration()` 就是它 ——
 * 服务端换了默认值，这里自动跟着走，不会留下一个「测试还认旧密钥」的假绿。
 */
const DEFAULT_JWT_SECRET = (() => {
  const configuration = require(path.join(SERVER_DIR, "dist", "config", "configuration.js")).default;
  const saved = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  const value = configuration().jwtSecret;
  if (saved === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = saved;
  return value;
})();

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

/** 起一台服务并等它就绪，返回 { baseUrl, kill, serverErrors, serverLogs } */
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
      JWT_SECRET: "e2e-guard-secret",
      JWT_EXPIRES_IN: "1h",
      ADMIN_REGISTER_CODE: ADMIN_CODE,
      LOG_REQUESTS: "false",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverErrors = [];
  // 启动自检（配置告警）走 Nest 的 Logger，落在 **stdout**，所以这里也要收着 ——
  // 「启动日志有没有喊出来」是这一套自检唯一能被验证的出口
  const serverLogs = [];
  child.stderr.on("data", (chunk) => serverErrors.push(String(chunk)));
  child.stdout.on("data", (chunk) => serverLogs.push(String(chunk)));

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务进程提前退出（code=${child.exitCode}）\n${serverErrors.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return { baseUrl, kill: () => child.kill("SIGTERM"), serverErrors, serverLogs };
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
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

/** 造一份合法的角色数据 */
function roleData(id, name, level) {
  return {
    id,
    name,
    occupation: "1",
    sex: "1",
    level,
    gold: 1000,
    bindGold: 0,
    silver: 0,
    exp: 0,
    bag: [[null, null], [null, null]],
    equipments: { WEAPON: null },
    skills: { "1001": 1 },
    shortcutKeys: [],
    onMap: "0",
  };
}

//#region 零：限流纯函数（不起服务，直接跑编译产物）

function runUtilSuite() {
  group("零、限流纯函数：阈值 / 锁定 / 过期 / 关闭维度");

  const rule = { maxFailures: 3, lockMs: 60_000 };
  const now = 1_000_000;

  let state = rateLimit.createAttemptState();
  checkEqual(state.failures, 0, "初始状态没有失败计数");
  checkEqual(rateLimit.lockedForMs(state, rule, now), 0, "初始状态未锁定");

  state = rateLimit.afterFailure(state, rule, now);
  checkEqual(state.failures, 1, "第一次失败计数为 1");
  state = rateLimit.afterFailure(state, rule, now);
  checkEqual(state.failures, 2, "第二次失败计数为 2");
  checkEqual(rateLimit.remainingAttempts(state, rule, now), 1, "还剩 1 次机会");

  state = rateLimit.afterFailure(state, rule, now);
  checkEqual(state.lockedUntil, now + rule.lockMs, "达到阈值即锁定到 now + lockMs");
  checkEqual(state.failures, 0, "进入锁定后计数归零（锁定期满重新计数，正常用户不会一错再错）");
  checkEqual(rateLimit.remainingAttempts(state, rule, now), 0, "锁定中剩余次数为 0");

  checkEqual(rateLimit.lockedForMs(state, rule, now + 1_000), 59_000, "锁定期内返回剩余毫秒");
  checkEqual(rateLimit.lockedForMs(state, rule, now + rule.lockMs), 0, "刚好到期即解锁");
  checkEqual(rateLimit.lockedForMs(state, rule, now + rule.lockMs + 1), 0, "过期后未锁定");

  const disabled = { maxFailures: 0, lockMs: 1 };
  checkEqual(rateLimit.lockedForMs({ failures: 99, lockedUntil: now + 999 }, disabled, now), 0, "maxFailures <= 0 = 关闭该维度（永不锁）");

  checkEqual(rateLimit.describeWait(1_000), "1 分钟", "不足 1 分钟按 1 分钟提示");
  checkEqual(rateLimit.describeWait(61_000), "2 分钟", "向上取整到分钟");

  checkEqual(rateLimit.isIdle(rateLimit.afterSuccess(), now), true, "成功后状态回到空闲（内存表可清理）");
  checkEqual(rateLimit.isIdle(state, now), false, "锁定中的状态不会被判为空闲");

  group("零之二、封禁纯函数：到期判定 / 期限文案");

  // 判据是「disabled + 有结束时间 + 已到期」三者同时成立，缺一不可
  checkEqual(ban.isBanned({ status: "active", ban_until: null }, now), false, "正常账号不算被封");
  checkEqual(ban.isBanned({ status: "disabled", ban_until: null }, now), true, "disabled 且无到期时间 = 永久封禁");
  checkEqual(ban.isBanned({ status: "disabled", ban_until: now + 1 }, now), true, "未到期的临时封禁算封禁中");
  checkEqual(ban.isBanned({ status: "disabled", ban_until: now }, now), false, "到期当刻即解封（边界含等号）");
  checkEqual(ban.isBanned({ status: "disabled", ban_until: now - 1 }, now), false, "已过期的临时封禁不算被封");
  checkEqual(
    ban.isBanExpired({ status: "active", ban_until: now - 1 }, now),
    false,
    "正常账号即使带着过去的 ban_until 也不算「封禁到期」（不能只看时间）",
  );

  checkEqual(ban.humanizeDuration(30_000), "1 分钟", "不足 1 分钟按 1 分钟说");
  checkEqual(ban.humanizeDuration(3 * 3600_000), "3 小时", "纯小时");
  checkEqual(ban.humanizeDuration(50 * 3600_000), "2 天 2 小时", "天 + 小时");
  checkEqual(ban.humanizeDuration(26 * 3600_000), "1 天 2 小时", "跨天后不再拼接分钟");

  checkEqual(
    ban.describeBan({ status: "disabled", ban_until: null, ban_reason: "使用外挂" }, now),
    "账号已被封禁：使用外挂（永久封禁，如有疑问请联系客服）",
    "永久封禁文案带原因",
  );
  check(
    ban.describeBan({ status: "disabled", ban_until: now + 3600_000, ban_reason: null }, now).includes("剩余 1 小时后自动解封"),
    "临时封禁文案带剩余时长",
  );
  checkEqual(
    ban.describeBan({ status: "disabled", ban_until: null, ban_reason: "   " }, now),
    "账号已被封禁（永久封禁，如有疑问请联系客服）",
    "原因全是空白时按未填写处理",
  );

  group("零之三、CSV 纯函数：转义 / 防公式注入 / BOM");

  checkEqual(csv.csvCell(null), '""', "null 落成空单元格");
  checkEqual(csv.csvCell(undefined), '""', "undefined 同理");
  checkEqual(csv.csvCell(42), '"42"', "数字转字符串");
  checkEqual(csv.csvCell('说 "引号" 的事'), '"说 ""引号"" 的事"', "内部引号翻倍（RFC 4180）");
  checkEqual(csv.csvCell("a,b"), '"a,b"', "逗号被引号包住，不会多切一列");
  checkEqual(csv.csvCell({ reason: "外挂" }), '"{""reason"":""外挂""}"', "对象按 JSON 落格（内部引号同样翻倍）");

  checkEqual(csv.csvCell("=1+1"), '"\'=1+1"', "以 = 开头的值加前导单引号（防表格软件当公式执行）");
  checkEqual(csv.csvCell("@SUM(A1)"), '"\'@SUM(A1)"', "+ - @ 同理");
  checkEqual(csv.csvCell("-2"), '"\'-2"', "负号开头也要挡（`-2+3` 也会被当公式）");
  checkEqual(csv.csvCell("+86 138"), '"\'+86 138"', "加号开头同理");
  checkEqual(csv.csvCell("正常文本"), '"正常文本"', "普通文本不加多余的引号前缀");

  const built = csv.buildCsv(["时间", "操作人"], [[1_760_000_000_000, "guard_super"]]);
  check(built.startsWith(csv.CSV_BOM), "整份 CSV 带 UTF-8 BOM（Excel 打开中文不乱码）");
  checkEqual(built.slice(csv.CSV_BOM.length).split("\r\n").filter(Boolean).length, 2, "表头 + 1 行数据（CRLF 分行）");
  check(built.includes('"时间","操作人"'), "表头也走同一套转义");
}

//#endregion

//#region 一 ~ 五：第一台服务

async function runMainSuite(baseUrl) {
  const call = (method, route, options) => api(baseUrl, method, route, options);

  //#region 一、准备账号
  group("一、准备：玩家账号 / 超管 / 普通管理员 / 只读观察员");

  const player = await call("POST", "/api/auth/register", {
    body: { username: "guard_player", password: "player-pass-1" },
  });
  const playerToken = player.body.data.token;
  const playerAccountId = player.body.data.account.id;
  check(Boolean(playerToken), "玩家注册成功并拿到令牌");

  const superReg = await call("POST", "/api/admin/auth/register", {
    body: { username: "guard_super", password: "super-pass-1", registerCode: ADMIN_CODE },
  });
  const superToken = superReg.body.data.token;
  const superId = superReg.body.data.admin.id;
  checkEqual(superReg.body.data.admin.role, "super_admin", "首个管理员自动是超级管理员");

  const adminReg = await call("POST", "/api/admin/auth/register", {
    body: { username: "guard_admin", password: "admin-pass-1", registerCode: ADMIN_CODE },
  });
  const adminToken = adminReg.body.data.token;
  const adminId = adminReg.body.data.admin.id;
  checkEqual(adminReg.body.data.admin.role, "admin", "第二个管理员是普通管理员");

  const viewerReg = await call("POST", "/api/admin/auth/register", {
    body: { username: "guard_viewer", password: "viewer-pass-1", registerCode: ADMIN_CODE },
  });
  const viewerId = viewerReg.body.data.admin.id;
  await call("PATCH", `/api/admin/admins/${viewerId}`, { token: superToken, body: { role: "viewer" } });
  const viewerLogin = await call("POST", "/api/admin/auth/login", { body: { username: "guard_viewer", password: "viewer-pass-1" } });
  const viewerToken = viewerLogin.body.data.token;
  checkEqual(viewerLogin.body.data.admin.role, "viewer", "观察员登录后角色为 viewer");

  //#endregion

  //#region 二、口令管理闭环
  group("二、口令管理：重置玩家 / 自助改密 / 超管重置 / 权限");

  // —— 超管重置玩家密码 ——
  const resetPlayer = await call("PATCH", `/api/admin/accounts/${playerAccountId}/password`, {
    token: superToken,
    body: { password: "player-new-pass" },
  });
  checkEqual(resetPlayer.body.code, 0, "超管可以重置玩家密码");
  checkEqual(resetPlayer.body.data.name, "guard_player", "重置回执带账号名");
  checkEqual(resetPlayer.body.data.revokedTokens, true, "回执标明旧令牌已作废");
  check(
    !JSON.stringify(resetPlayer.body).includes("player-new-pass"),
    "重置接口不回显密码明文",
  );

  // 旧令牌立即失效（令牌版本号比对）
  const staleMe = await call("GET", "/api/auth/me", { token: playerToken });
  checkEqual(staleMe.status, 401, "重置密码后玩家旧令牌立即失效（401）");
  checkEqual(staleMe.body.code, 40103, "旧令牌失效的业务码是 40103 TOKEN_REVOKED");

  const oldPassLogin = await call("POST", "/api/auth/login", { body: { username: "guard_player", password: "player-pass-1" } });
  checkEqual(oldPassLogin.body.code, 10003, "旧密码不能再登录");
  const newPassLogin = await call("POST", "/api/auth/login", { body: { username: "guard_player", password: "player-new-pass" } });
  checkEqual(newPassLogin.body.code, 0, "新密码可以登录");
  const freshPlayerToken = newPassLogin.body.data.token;

  // —— 权限：观察员不能重置玩家密码 ——
  const viewerReset = await call("PATCH", `/api/admin/accounts/${playerAccountId}/password`, {
    token: viewerToken,
    body: { password: "hacked-pass" },
  });
  checkEqual(viewerReset.status, 403, "只读观察员重置玩家密码被拒（403）");
  checkEqual(viewerReset.body.code, 30006, "无权操作的业务码是 30006");
  const stillWorks = await call("POST", "/api/auth/login", { body: { username: "guard_player", password: "player-new-pass" } });
  checkEqual(stillWorks.body.code, 0, "被拒的重置没有改动密码");

  // —— 管理员自助改密 ——
  const wrongOld = await call("PATCH", "/api/admin/auth/password", {
    token: adminToken,
    body: { oldPassword: "not-my-password", newPassword: "admin-pass-2" },
  });
  checkEqual(wrongOld.body.code, 30010, "自助改密带错原密码 → 30010");

  const samePass = await call("PATCH", "/api/admin/auth/password", {
    token: adminToken,
    body: { oldPassword: "admin-pass-1", newPassword: "admin-pass-1" },
  });
  checkEqual(samePass.body.code, 30011, "新密码与当前密码相同 → 30011");

  const changed = await call("PATCH", "/api/admin/auth/password", {
    token: adminToken,
    body: { oldPassword: "admin-pass-1", newPassword: "admin-pass-2" },
  });
  checkEqual(changed.body.code, 0, "自助改密成功");
  check(Boolean(changed.body.data?.token), "自助改密返回新令牌（自己不会被踢出去）");
  const newAdminToken = changed.body.data.token;

  const oldAdminToken = await call("GET", "/api/admin/auth/me", { token: adminToken });
  checkEqual(oldAdminToken.body.code, 40103, "改密后旧管理员令牌失效（40103）");
  const newAdminTokenOk = await call("GET", "/api/admin/auth/me", { token: newAdminToken });
  checkEqual(newAdminTokenOk.body.code, 0, "新令牌可用");
  const adminRelogin = await call("POST", "/api/admin/auth/login", { body: { username: "guard_admin", password: "admin-pass-2" } });
  checkEqual(adminRelogin.body.code, 0, "管理员可以用新密码重新登录");

  // —— 超管重置他人密码 ——
  const resetAdmin = await call("PATCH", `/api/admin/admins/${adminId}/password`, {
    token: superToken,
    body: { password: "admin-forced-3" },
  });
  checkEqual(resetAdmin.body.code, 0, "超管可以重置其他管理员的密码");
  const afterResetAdmin = await call("GET", "/api/admin/auth/me", { token: newAdminToken });
  checkEqual(afterResetAdmin.body.code, 40103, "被重置的管理员旧令牌立即失效");

  // 普通管理员不能重置别人（admin:manage 只有超管有）
  // 注意：上一步超管刚把 guard_admin 的密码改掉，所以这里要用**新密码**重新登录
  //（旧令牌已随版本号作废 —— 这正是「重置密码 = 把对方踢下线」的体现）
  const adminAfterReset = await call("POST", "/api/admin/auth/login", {
    body: { username: "guard_admin", password: "admin-forced-3" },
  });
  checkEqual(adminAfterReset.body.code, 0, "被重置的管理员可用新密码登录");
  const adminResetsPeer = await call("PATCH", `/api/admin/admins/${viewerId}/password`, {
    token: adminAfterReset.body.data.token,
    body: { password: "peer-forced-1" },
  });
  checkEqual(adminResetsPeer.status, 403, "普通管理员不能重置他人密码（403）");

  //#endregion

  //#region 三、操作审计
  group("三、操作审计：落库 / 打码 / 筛选 / 权限");

  const logs = await call("GET", "/api/admin/audit-logs?size=100", { token: superToken });
  checkEqual(logs.body.code, 0, "超管可以查操作日志");
  check(logs.body.data.total > 0, "日志里有记录");

  const list = logs.body.data.list;
  const resetLog = list.find((item) => item.action === "adminAccount.resetPassword");
  check(Boolean(resetLog), "重置玩家密码被自动记入日志（action 取 operationId）");
  if (resetLog) {
    checkEqual(resetLog.actorName, "guard_super", "日志记录了操作人");
    checkEqual(resetLog.actorRole, "super_admin", "日志记录了操作人角色");
    checkEqual(resetLog.targetType, "account", "日志记录了目标类型");
    checkEqual(resetLog.targetId, playerAccountId, "日志记录了目标 id");
    checkEqual(resetLog.targetName, "guard_player", "日志关联出目标当前名字");
    checkEqual(resetLog.success, true, "成功的操作标为成功");
    checkEqual(resetLog.detail.password, "***", "请求体里的密码被自动打码");
    check(typeof resetLog.ip === "string" && resetLog.ip.length > 0, "日志记录了来源 IP");
  }

  const failedLog = list.find((item) => item.action === "auth.login" && item.success === false);
  check(Boolean(failedLog), "登录失败也留痕（含来源 IP 与尝试的用户名）");
  if (failedLog) {
    checkEqual(failedLog.detail.username, "guard_player", "失败日志里带着尝试的用户名");
    checkEqual(failedLog.actorName, null, "登录失败没有操作人（还没认证）");
    checkEqual(failedLog.errorCode, 10003, "失败日志记录业务码");
  }

  const loginOkLog = list.find((item) => item.action === "auth.login" && item.success === true);
  check(Boolean(loginOkLog), "登录成功同样留痕");

  const adminLoginLog = list.find((item) => item.action === "adminAuth.login" && item.success === true);
  check(Boolean(adminLoginLog), "管理端登录留痕");

  const failedOnly = await call("GET", "/api/admin/audit-logs?success=false&size=100", { token: superToken });
  check(
    failedOnly.body.data.list.length > 0 && failedOnly.body.data.list.every((item) => item.success === false),
    "success=false 只返回失败记录",
  );

  const byAction = await call("GET", "/api/admin/audit-logs?action=adminAdmin.update&size=100", { token: superToken });
  check(
    byAction.body.data.list.length > 0 && byAction.body.data.list.every((item) => item.action === "adminAdmin.update"),
    "按动作筛选只返回该动作",
  );

  const byTarget = await call("GET", `/api/admin/audit-logs?targetType=account&targetId=${playerAccountId}&size=100`, { token: superToken });
  check(
    byTarget.body.data.list.length > 0 && byTarget.body.data.list.every((item) => item.targetId === playerAccountId),
    "按目标筛选只返回该目标的记录",
  );

  // 关键字：命中四项之一即可（操作人账号名 / 动作 / 目标 id / 请求路径）
  const byKeyword = await call("GET", "/api/admin/audit-logs?keyword=guard_super&size=100", { token: superToken });
  check(
    byKeyword.body.data.list.length > 0 && byKeyword.body.data.list.every((item) => item.actorName === "guard_super"),
    "keyword 能按操作人账号名模糊匹配",
  );

  const byKeywordAction = await call("GET", "/api/admin/audit-logs?keyword=resetPassword&size=100", { token: superToken });
  check(
    byKeywordAction.body.data.list.length > 0 && byKeywordAction.body.data.list.every((item) => item.action.includes("resetPassword")),
    "keyword 能匹配到动作名",
  );

  const byKeywordId = await call("GET", `/api/admin/audit-logs?keyword=${playerAccountId}&size=100`, { token: superToken });
  check(
    byKeywordId.body.data.list.length > 0 && byKeywordId.body.data.list.every((item) => item.targetId === playerAccountId),
    "keyword 能匹配到目标 id",
  );

  // 通配符要转义：`%` 必须当字面量，否则这条会退化成「匹配所有含 guard 的记录」
  const keywordLiteral = await call("GET", "/api/admin/audit-logs?keyword=guard%25&size=100", { token: superToken });
  checkEqual(keywordLiteral.body.data.list.length, 0, "keyword 里的 % 按字面量处理（不退化成通配符）");

  const keywordAnd = await call("GET", "/api/admin/audit-logs?keyword=guard_super&success=false&size=100", { token: superToken });
  check(
    keywordAnd.body.data.list.every((item) => item.success === false && item.actorName === "guard_super"),
    "keyword 与其他条件之间是「与」的关系",
  );

  const actions = await call("GET", "/api/admin/audit-logs/actions", { token: superToken });
  check(actions.body.data.actions.includes("adminAccount.resetPassword"), "动作清单含重置玩家密码");
  check(actions.body.data.actions.includes("adminAuth.login"), "动作清单含登录动作");

  const viewerReadsAudit = await call("GET", "/api/admin/audit-logs", { token: viewerToken });
  checkEqual(viewerReadsAudit.body.code, 30006, "只读观察员不能查看操作日志（30006）");

  const playerReadsAudit = await call("GET", "/api/admin/audit-logs", { token: freshPlayerToken });
  checkEqual(playerReadsAudit.status, 401, "玩家令牌拿不到管理端接口（401）");

  //#endregion

  //#region 四、登录限流（用户名维度）
  group("四、登录限流：按用户名锁定（阈值 3 次）");

  const attempt = (password) => call("POST", "/api/auth/login", { body: { username: "guard_bruteforce", password } });

  for (let index = 1; index <= 3; index += 1) {
    const result = await attempt(`wrong-${index}`);
    checkEqual(result.body.code, 10003, `第 ${index} 次错误密码 → 10003`);
  }
  const locked = await attempt("wrong-4");
  checkEqual(locked.status, 429, "达到阈值后再试 → 429");
  checkEqual(locked.body.code, 10005, "锁定的业务码是 10005 LOGIN_LOCKED");
  check(/分钟/.test(locked.body.message), "提示里说明还要等多久");

  const otherUser = await call("POST", "/api/auth/login", { body: { username: "guard_super_never_used", password: "whatever-1" } });
  checkEqual(otherUser.body.code, 10003, "锁定只针对该用户名，其他人不受影响");

  //#endregion

  //#region 五、踢下线
  group("五、踢下线：清在线标记 + 让客户端存档写入失效");

  const created = await call("POST", "/api/roles", { token: freshPlayerToken, body: { data: roleData("kick_role", "被踢的号", 5) } });
  checkEqual(created.body.code, 0, "玩家创建角色成功（自动设为在线）");
  const kickRoleId = created.body.data.id;

  const saveOk = await call("PUT", `/api/roles/${kickRoleId}`, {
    token: freshPlayerToken,
    body: { data: roleData("kick_role", "被踢的号", 6) },
  });
  checkEqual(saveOk.body.code, 0, "在线时推存档正常");

  const kicked = await call("POST", `/api/admin/accounts/${playerAccountId}/offline`, { token: superToken });
  checkEqual(kicked.body.code, 0, "超管踢下线成功");
  checkEqual(kicked.body.data.onlineRoleId, null, "踢下线后账号没有在线角色");

  const saveAfterKick = await call("PUT", `/api/roles/${kickRoleId}`, {
    token: freshPlayerToken,
    body: { data: roleData("kick_role", "被踢的号", 7) },
  });
  checkEqual(saveAfterKick.body.code, 20007, "被踢后推存档被拒（20007 ROLE_KICKED）");

  const kickAgain = await call("POST", `/api/admin/accounts/${playerAccountId}/offline`, { token: superToken });
  checkEqual(kickAgain.body.code, 0, "重复踢下线幂等（不报错）");

  const onlineNow = await call("GET", "/api/roles/online", { token: freshPlayerToken });
  checkEqual(onlineNow.body.data, null, "玩家查在线角色返回 null（客户端据此回选角）");

  const reselect = await call("POST", `/api/roles/${kickRoleId}/select`, { token: freshPlayerToken });
  checkEqual(reselect.body.code, 0, "玩家重新选择角色可以恢复");
  const saveAgain = await call("PUT", `/api/roles/${kickRoleId}`, {
    token: freshPlayerToken,
    body: { data: roleData("kick_role", "被踢的号", 8) },
  });
  checkEqual(saveAgain.body.code, 0, "重新选角后推存档恢复正常");

  //#endregion

  //#region 六、封禁闭环
  group("六、封禁闭环：原因与时长进提示，解封清空封禁信息");

  const banTarget = `/api/admin/accounts/${playerAccountId}/status`;

  // 先让这个账号在线，用来验证「封禁会顺带清掉在线标记」
  const banCreated = await call("POST", "/api/roles", { token: freshPlayerToken, body: { data: roleData("ban_role", "待封的号", 5) } });
  const banRoleId = banCreated.body.data.id;
  check(Boolean(banRoleId), "准备：玩家创建一个在线角色（封禁用例的前置）");

  const banTemp = await call("PATCH", banTarget, {
    token: superToken,
    body: { status: "disabled", reason: "使用外挂", durationHours: 24 },
  });
  checkEqual(banTemp.body.code, 0, "临时封禁成功");
  checkEqual(banTemp.body.data.status, "disabled", "状态变为 disabled");
  checkEqual(banTemp.body.data.banReason, "使用外挂", "封禁原因落库");
  checkEqual(banTemp.body.data.bannedBy, "guard_super", "记下执行封禁的管理员账号名");
  checkEqual(banTemp.body.data.banUntil - banTemp.body.data.bannedAt, 24 * 3600_000, "到期时间 = 封禁时刻 + 24 小时");
  checkEqual(banTemp.body.data.onlineRoleId, null, "封禁会顺带清掉在线标记");

  const banLogin = await call("POST", "/api/auth/login", { body: { username: "guard_player", password: "player-new-pass" } });
  checkEqual(banLogin.status, 403, "被封的账号登录被拒（403）");
  checkEqual(banLogin.body.code, 10004, "业务码是账号封禁 10004");
  check(banLogin.body.message.includes("使用外挂"), "登录被拒的提示里带封禁原因");
  check(banLogin.body.message.includes("剩余"), "临时封禁的提示里带剩余时长");

  const bannedMe = await call("GET", "/api/auth/me", { token: freshPlayerToken });
  checkEqual(bannedMe.status, 401, "已登录的令牌下一次请求即被拒（封禁即时生效）");

  const unbanned = await call("PATCH", banTarget, { token: superToken, body: { status: "active" } });
  checkEqual(unbanned.body.data.status, "active", "解封后状态回到 active");
  checkEqual(unbanned.body.data.banReason, null, "解封清空封禁原因");
  checkEqual(unbanned.body.data.banUntil, null, "解封清空到期时间");
  checkEqual(unbanned.body.data.bannedBy, null, "解封清空执行人");
  checkEqual(unbanned.body.data.bannedAt, null, "解封清空封禁时间");

  const backLogin = await call("POST", "/api/auth/login", { body: { username: "guard_player", password: "player-new-pass" } });
  checkEqual(backLogin.body.code, 0, "解封后可以正常登录");
  const backToken = backLogin.body.data.token;

  // 不传时长 = 永久封禁（ban_until 写 null，「disabled + null」才是永久，不能只看 null）
  const banForever = await call("PATCH", banTarget, { token: superToken, body: { status: "disabled", reason: "恶意刷屏" } });
  checkEqual(banForever.body.data.banUntil, null, "不传时长 = 永久封禁（banUntil 为 null）");
  const foreverLogin = await call("POST", "/api/auth/login", { body: { username: "guard_player", password: "player-new-pass" } });
  check(foreverLogin.body.message.includes("永久封禁"), "永久封禁的提示里写明「永久」");

  const badDuration = await call("PATCH", banTarget, { token: superToken, body: { status: "disabled", durationHours: 0 } });
  checkEqual(badDuration.status, 400, "封禁时长小于 1 小时被拒（400）");
  const badReason = await call("PATCH", banTarget, { token: superToken, body: { status: "disabled", reason: "x".repeat(101) } });
  checkEqual(badReason.status, 400, "封禁原因超过 100 字被拒（400）");

  // 收尾：解封（本段是 runMainSuite 最后一段，留个正常状态给后面的改动）
  await call("PATCH", banTarget, { token: superToken, body: { status: "active" } });
  checkEqual((await call("GET", "/api/auth/me", { token: backToken })).body.code, 0, "解封后重新登录的令牌可用（收尾）");

  //#endregion

  //#region 七、运营看板
  group("七、运营看板：趋势补日期 / 分布不翻译 / 最近动态不外泄请求体");

  const trend = await call("GET", "/api/admin/stats/trend?days=7", { token: superToken });
  checkEqual(trend.body.code, 0, "趋势接口可读");
  checkEqual(trend.body.data.days, 7, "回显统计天数");
  checkEqual(trend.body.data.points.length, 7, "返回 7 个点（没有数据的那天也要有）");
  checkEqual(new Set(trend.body.data.points.map((point) => point.day)).size, 7, "日期互不重复");
  check(/^\d{4}-\d{2}-\d{2}$/.test(trend.body.data.points[0].day), "日期格式为 YYYY-MM-DD（本地时区）");
  check(
    trend.body.data.points.every((point) => typeof point.newAccounts === "number" && typeof point.newRoles === "number"),
    "每个点都带新增账号与新增角色（缺数据的日期给 0，不是缺项）",
  );
  checkEqual(
    trend.body.data.totalNewAccounts,
    trend.body.data.points.reduce((sum, point) => sum + point.newAccounts, 0),
    "区间合计等于逐日之和",
  );
  check(trend.body.data.points[6].newAccounts >= 1, "今天至少有 1 个新增账号（前面注册过的）");

  const tooManyDays = await call("GET", "/api/admin/stats/trend?days=999", { token: superToken });
  checkEqual(tooManyDays.status, 400, "统计天数超过上限被拒（400）");

  const breakdown = await call("GET", "/api/admin/stats/breakdown", { token: superToken });
  checkEqual(breakdown.body.code, 0, "分布接口可读");
  check(breakdown.body.data.levels.length > 0, "等级分布有数据（前面创建过角色）");
  check(
    breakdown.body.data.levels.every((item) => typeof item.key === "string" && typeof item.count === "number"),
    "分布项只给分组键与数量",
  );
  check(
    breakdown.body.data.levels.every((item) => item.label === undefined),
    "服务端不返回展示名（职业/性别/地图的翻译交给管理端，避免复制客户端配置）",
  );
  check(breakdown.body.data.occupations.length > 0, "职业分布有数据");
  check(Array.isArray(breakdown.body.data.maps), "地图分布是数组（从角色快照的 onMap 聚合）");

  const recent = await call("GET", "/api/admin/stats/recent?limit=5", { token: superToken });
  checkEqual(recent.body.code, 0, "最近动态可读");
  check(recent.body.data.length > 0 && recent.body.data.length <= 5, "最多返回 limit 条");
  check(
    recent.body.data.every((item) => typeof item.action === "string" && typeof item.createdAt === "number"),
    "每条都带动作与时间",
  );
  check(
    recent.body.data.every((item) => item.detail === undefined && item.path === undefined),
    "不外泄请求体与路径（只给界面要显示的字段）",
  );
  checkEqual(recent.body.data[0].action, "adminAccount.updateStatus", "最近一条正是上一步的解封操作");

  const viewerTrend = await call("GET", "/api/admin/stats/trend", { token: viewerToken });
  checkEqual(viewerTrend.body.code, 0, "只读观察员有 stats:read，可以看趋势");
  const playerTrend = await call("GET", "/api/admin/stats/trend", { token: backToken });
  checkEqual(playerTrend.status, 401, "玩家令牌拿不到看板接口（401）");

  //#endregion

  //#region 八、列表体验（排序白名单 / 每页条数 / 批量封禁解封）
  group("八、列表体验：排序白名单 / 每页条数 / 批量封禁解封");

  // 准备：两个用户名有前后之分的账号（用来验证排序真的换了顺序）
  const sortA = await call("POST", "/api/auth/register", { body: { username: "guard_aaa", password: "aaa-qzmw-1" } });
  const sortB = await call("POST", "/api/auth/register", { body: { username: "guard_zzz", password: "zzz-qzmw-1" } });
  const sortAId = sortA.body.data.account.id;
  const sortBId = sortB.body.data.account.id;
  check(Boolean(sortAId) && Boolean(sortBId), "准备：注册两个用户名有前后之分的账号");

  // —— 排序（服务端执行） ——
  const byNameAsc = await call("GET", "/api/admin/accounts?sort=username&order=asc&size=100", { token: superToken });
  const ascNames = byNameAsc.body.data.list.map((item) => item.username);
  check(
    ascNames.indexOf("guard_aaa") !== -1 && ascNames.indexOf("guard_aaa") < ascNames.indexOf("guard_zzz"),
    "sort=username&order=asc 生效（aaa 排在 zzz 之前）",
  );
  checkEqual(byNameAsc.body.data.size, 100, "每页条数 100 生效（size 回显）");
  checkEqual(byNameAsc.body.data.list.length, byNameAsc.body.data.total, "每页 100 能装下全部数据（条数 = total）");

  const byNameDesc = await call("GET", "/api/admin/accounts?sort=username&order=desc&size=100", { token: superToken });
  const descNames = byNameDesc.body.data.list.map((item) => item.username);
  check(descNames.indexOf("guard_zzz") < descNames.indexOf("guard_aaa"), "order=desc 把顺序反过来");

  // 白名单：sort 是拼进 SQL 的，传白名单外的值必须静默退回默认排序（不报错、更不能拼进语句）
  const injected = await call("GET", `/api/admin/accounts?sort=${encodeURIComponent("username; DROP TABLE accounts")}&order=asc`, {
    token: superToken,
  });
  checkEqual(injected.body.code, 0, "白名单外的排序字段不报错（静默退回默认排序）");
  check(injected.body.data.list.length > 0, "退回默认排序后仍然返回数据");
  const tableAlive = await call("GET", "/api/admin/accounts?size=1", { token: superToken });
  check(tableAlive.body.data.total >= 3, "accounts 表完好（注入串没有被拼进 SQL）");

  const badOrder = await call("GET", "/api/admin/accounts?sort=username&order=sideways", { token: superToken });
  checkEqual(badOrder.status, 400, "排序方向只认 asc / desc（其他值 400）");
  const tooLongSort = await call("GET", `/api/admin/accounts?sort=${"x".repeat(33)}`, { token: superToken });
  checkEqual(tooLongSort.status, 400, "排序字段过长被拒（400）");

  const rolesSorted = await call("GET", "/api/admin/roles?sort=level&order=desc&size=100", { token: superToken });
  const levels = rolesSorted.body.data.list.map((item) => item.level);
  check(levels.length >= 2, "角色列表数据够验证排序");
  check(levels.every((value, index) => index === 0 || levels[index - 1] >= value), "sort=level&order=desc 生效（等级从高到低）");

  const adminsDefault = await call("GET", "/api/admin/admins?size=100", { token: superToken });
  const adminsDesc = await call("GET", "/api/admin/admins?sort=username&order=desc&size=100", { token: superToken });
  checkEqual(
    adminsDesc.body.data.list.map((item) => item.username).join(","),
    adminsDefault.body.data.list
      .map((item) => item.username)
      .sort()
      .reverse()
      .join(","),
    "管理员列表按用户名倒序（默认仍按创建时间升序）",
  );

  const auditSorted = await call("GET", "/api/admin/audit-logs?sort=action&order=asc&size=50", { token: superToken });
  const sortedActions = auditSorted.body.data.list.map((item) => item.action);
  check(sortedActions.length > 1, "操作日志数据够验证排序");
  check(sortedActions.every((value, index) => index === 0 || sortedActions[index - 1] <= value), "sort=action&order=asc 生效");

  // —— 批量封禁 / 解封 ——
  const batchBan = await call("POST", "/api/admin/accounts/batch-status", {
    token: superToken,
    body: { ids: [sortAId, sortBId], status: "disabled", reason: "批量测试", durationHours: 6 },
  });
  checkEqual(batchBan.body.code, 0, "批量封禁成功");
  checkEqual(batchBan.body.data.requested, 2, "requested 回显请求条数");
  checkEqual(batchBan.body.data.updated, 2, "两条都改到了");
  checkEqual(batchBan.body.data.ids.length, 2, "返回实际改到的 id 列表");
  checkEqual(batchBan.body.data.clearedOnlineAccountIds.length, 0, "这两个账号没有在线角色，无需踢下线");
  const batchBanned = await call("POST", "/api/auth/login", { body: { username: "guard_aaa", password: "aaa-qzmw-1" } });
  checkEqual(batchBanned.body.code, 10004, "被批量封禁的账号登录被拒（10004）");
  check(batchBanned.body.message.includes("批量测试"), "批量封禁的原因同样进登录提示");

  const ghost = await call("POST", "/api/admin/accounts/batch-status", {
    token: superToken,
    body: { ids: [sortAId, "no-such-account-id"], status: "active" },
  });
  checkEqual(ghost.body.data.requested, 2, "requested 含已不存在的 id");
  checkEqual(ghost.body.data.updated, 1, "已不存在的 id 静默跳过（幂等）");
  checkEqual(
    (await call("POST", "/api/auth/login", { body: { username: "guard_aaa", password: "aaa-qzmw-1" } })).body.code,
    0,
    "批量解封后可以登录",
  );

  const viewerBatch = await call("POST", "/api/admin/accounts/batch-status", {
    token: viewerToken,
    body: { ids: [sortAId], status: "disabled", reason: "越权尝试" },
  });
  checkEqual(viewerBatch.status, 403, "只读观察员批量封禁被拒（403）");
  checkEqual(viewerBatch.body.code, 30006, "越权批量操作的业务码是 30006");
  checkEqual(
    (await call("POST", "/api/auth/login", { body: { username: "guard_aaa", password: "aaa-qzmw-1" } })).body.code,
    0,
    "被拒的批量封禁没有生效",
  );

  const tooMany = await call("POST", "/api/admin/accounts/batch-status", {
    token: superToken,
    body: { ids: Array.from({ length: 101 }, (_, index) => `id-${index}`), status: "disabled" },
  });
  checkEqual(tooMany.status, 400, "一次操作超过 100 个账号被拒（400）");
  const emptyIds = await call("POST", "/api/admin/accounts/batch-status", { token: superToken, body: { ids: [], status: "disabled" } });
  checkEqual(emptyIds.status, 400, "空 id 列表被拒（400）");

  // 收尾：把 sortB 解封（上面批量封禁过它，ghost 那步只解了 sortA），留个干净状态
  const cleanup = await call("POST", "/api/admin/accounts/batch-status", { token: superToken, body: { ids: [sortBId], status: "active" } });
  checkEqual(cleanup.body.data.updated, 1, "收尾：解封剩余的被封账号");
  checkEqual(
    (await call("POST", "/api/auth/login", { body: { username: "guard_zzz", password: "zzz-qzmw-1" } })).body.code,
    0,
    "收尾：被批量封禁过的账号解封后可登录",
  );

  //#endregion

  //#region 九、审计增强（IP / 角色筛选 + CSV 导出）
  group("九、审计增强：IP 与角色筛选 / CSV 导出 / 防公式注入");

  // —— 筛选维度：来源 IP 与操作人角色 ——
  const sample = await call("GET", "/api/admin/audit-logs?keyword=guard_super&size=5", { token: superToken });
  const sampleIp = sample.body.data.list.find((item) => item.ip)?.ip;
  check(Boolean(sampleIp), "准备：日志里记到了来源 IP");

  const byIp = await call("GET", `/api/admin/audit-logs?ip=${encodeURIComponent(sampleIp)}&size=50`, { token: superToken });
  checkEqual(byIp.body.code, 0, "按来源 IP 筛选可读");
  check(
    byIp.body.data.list.length > 0 && byIp.body.data.list.every((item) => item.ip === sampleIp),
    "筛出来的每一条都是该 IP",
  );

  const noSuchIp = await call("GET", "/api/admin/audit-logs?ip=203.0.113.9", { token: superToken });
  checkEqual(noSuchIp.body.data.total, 0, "不存在的 IP 筛出 0 条");

  const byRole = await call("GET", "/api/admin/audit-logs?actorRole=super_admin&size=50", { token: superToken });
  check(
    byRole.body.data.list.length > 0 && byRole.body.data.list.every((item) => item.actorRole === "super_admin"),
    "按操作人角色筛选生效",
  );

  const badRole = await call("GET", "/api/admin/audit-logs?actorRole=root", { token: superToken });
  checkEqual(badRole.status, 400, "操作人角色取值不在枚举内被拒（400）");
  const longIp = await call("GET", `/api/admin/audit-logs?ip=${"9".repeat(46)}`, { token: superToken });
  checkEqual(longIp.status, 400, "来源 IP 过长被拒（400）");

  // —— CSV 导出 ——
  // 准备：造一个「像公式」的角色名 —— 这种名字一旦被表格软件当公式执行就是真的漏洞
  const zzzLogin = await call("POST", "/api/auth/login", { body: { username: "guard_zzz", password: "zzz-qzmw-1" } });
  const csvRole = await call("POST", "/api/roles", {
    token: zzzLogin.body.data.token,
    body: { data: roleData("csv_role", "=1+1", 3) },
  });
  checkEqual(csvRole.body.code, 0, "准备：创建一个名字像公式的角色");
  const csvSelect = await call("POST", `/api/admin/roles/${csvRole.body.data.id}/select`, { token: superToken });
  checkEqual(csvSelect.body.code, 0, "准备：用管理端操作它一次（留下带目标名的日志）");

  const exported = await call("GET", "/api/admin/audit-logs/export", { token: superToken });
  checkEqual(exported.body.code, 0, "导出接口可读");
  check(/^olua-audit-\d{8}-\d{6}\.csv$/.test(exported.body.data.filename), "文件名带本地时间戳");
  check(exported.body.data.content.startsWith("\uFEFF"), "CSV 带 UTF-8 BOM（Excel 打开不乱码）");
  check(exported.body.data.content.includes('"时间","时间戳(毫秒)","操作人"'), "表头齐全且顺序固定");
  checkEqual(
    exported.body.data.rows,
    exported.body.data.content.slice(1).split("\r\n").filter(Boolean).length - 1,
    "rows 与 CSV 实际行数一致（行数 = 总行 - 表头）",
  );
  check(exported.body.data.total >= exported.body.data.rows, "total 不小于实际导出的条数");
  checkEqual(exported.body.data.truncated, false, "数据量没到上限，不截断");

  const filtered = await call("GET", "/api/admin/audit-logs/export?action=adminRole.select", { token: superToken });
  checkEqual(filtered.body.data.total, filtered.body.data.rows, "导出与列表共用同一套筛选条件（按动作导出）");
  check(filtered.body.data.rows >= 1, "按动作导出有数据");
  check(filtered.body.data.content.includes("'=1+1"), "以 = 开头的角色名被钉成文本（防 CSV 注入，端到端）");

  const emptyExport = await call("GET", "/api/admin/audit-logs/export?ip=203.0.113.9", { token: superToken });
  checkEqual(emptyExport.body.data.rows, 0, "筛不到数据时导出只有表头");
  checkEqual(emptyExport.body.data.total, 0, "空结果的 total 为 0");

  // 导出走 audit:read：普通管理员有、只读观察员**有意没有**（审计日志会暴露「谁做了什么」）
  const adminLogin = await call("POST", "/api/admin/auth/login", { body: { username: "guard_admin", password: "admin-forced-3" } });
  const adminExport = await call("GET", "/api/admin/audit-logs/export", { token: adminLogin.body.data.token });
  checkEqual(adminExport.body.code, 0, "普通管理员（有 audit:read）可以导出");
  const viewerExport = await call("GET", "/api/admin/audit-logs/export", { token: viewerToken });
  checkEqual(viewerExport.status, 403, "只读观察员没有 audit:read，导出被拒（403）");
  checkEqual(viewerExport.body.code, 30006, "导出越权的业务码是 30006");
  const playerExport = await call("GET", "/api/admin/audit-logs/export", { token: backToken });
  checkEqual(playerExport.status, 401, "玩家令牌拿不到导出接口（401）");

  //#endregion

  // 令牌交给后面的「系统信息」段复用：本套用例改过好几个账号的口令，重登不如直接传
  return { superToken, viewerToken, playerToken };
}

//#endregion

//#region 十：系统信息

/**
 * 系统信息页允许出现的配置项
 *
 * 这是**断言的目标**（写死在这里是刻意的）：白名单的默认行为是「没登记 = 不暴露」，
 * 所以多出来的键一定是漏了，必须让人看见。服务端新增快照项时这里要跟着加 —— 这一步不能省。
 */
const EXPECTED_CONFIG_KEYS = [
  "NODE_ENV",
  "PORT",
  "API_PREFIX",
  "DB_PATH",
  "JWT_EXPIRES_IN",
  "ROLE_MAX_PER_ACCOUNT",
  "LOG_REQUESTS",
  "TRUST_PROXY",
  "CORS_ORIGINS",
  "PLAYER_REGISTER_OPEN",
  "ADMIN_REGISTER_OPEN",
  "LOGIN_MAX_FAILURES",
  "LOGIN_LOCK_MS",
  "LOGIN_IP_MAX_FAILURES",
  "LOGIN_IP_LOCK_MS",
  "AUDIT_LOG_MAX_ROWS",
  "AUDIT_RETENTION_DAYS",
  "AUDIT_EXPORT_MAX_ROWS",
  "JWT_SECRET",
  "ADMIN_REGISTER_CODE",
  // 邮件通道（密码只报形态，值本身在 e2e-mail 里单独断言）
  "MAIL_ENABLED",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
  "MAIL_TRANSPORT",
  "MAIL_MAX_ATTEMPTS",
  "MAIL_RETRY_BASE_MS",
  "MAIL_POLL_MS",
];

/**
 * 系统信息（运维自查）与**启动自检**
 *
 * 分三支：
 * 1. 主服务（密钥已自定义、配了注册码、非生产）—— 验结构、白名单、权限、密钥不回显，
 *    并断言启动日志里**一条告警都没有**（配置正常时不该吵）；
 * 2. 生产的「危险默认值」组合（默认密钥 + CORS 全开 + 开放注册且无注册码）——
 *    三条告警要同时出现在启动日志与信息页上，且**判据同源**；
 * 3. 两个注册开关都是默认值 —— 管理端注册必须直接关死，且启动日志给出补救办法。
 */
async function runSystemSuite(server, tokens) {
  group("十、系统信息 + 启动自检：脱敏快照 / 白名单 / 权限 / 危险默认值");

  const baseUrl = server.baseUrl;
  const read = await api(baseUrl, "GET", "/api/admin/system", { token: tokens.superToken });
  checkEqual(read.body.code, 0, "超级管理员可读系统信息");
  const info = read.body.data;

  // —— 运行时 ——
  check(typeof info.runtime.version === "string" && info.runtime.version.length > 0, "带服务端版本号（读 package.json）");
  checkEqual(info.runtime.nodeVersion, process.version, "Node 版本取的是当前进程版本");
  checkEqual(info.runtime.platform, process.platform, "平台与当前机器一致");
  checkEqual(info.runtime.env, "test", "运行环境读的是 NODE_ENV");
  check(info.runtime.uptimeMs > 0 && Boolean(info.runtime.uptimeText), "运行时长带人读文案");
  check(info.runtime.memoryRssBytes > 0, "带常驻内存");
  check(Math.abs(info.time - Date.now()) < 60_000, "带服务端采集时间戳");

  // —— 数据库 ——
  checkEqual(info.database.path, ":memory:", "内存库照实报 :memory:");
  checkEqual(info.database.sizeBytes, null, "内存库没有文件体积（null，不是 0）");
  checkEqual(info.database.modifiedAt, null, "内存库没有最后写入时间（null）");
  const tableNames = info.database.tables.map((item) => item.table);
  for (const name of ["accounts", "roles", "admins", "audit_logs"]) {
    check(tableNames.includes(name), `各表行数包含 ${name}（表清单动态枚举 sqlite_master）`);
  }
  check(
    info.database.tables.every((item) => Number.isInteger(item.rows) && item.rows >= 0),
    "每张表的行数都是非负整数",
  );
  check(info.database.tables.find((item) => item.table === "accounts").rows > 0, "accounts 行数反映真实数据");

  // —— 配置快照：白名单 ——
  const keys = info.config.map((item) => item.key);
  const unknown = keys.filter((key) => !EXPECTED_CONFIG_KEYS.includes(key));
  checkEqual(unknown.join(","), "", "配置快照没有白名单之外的项");
  for (const envKey of ["PATH", "HOME", "NODE_OPTIONS", "TZ"]) {
    check(!keys.includes(envKey), `子进程环境变量 ${envKey} 没有漏进快照`);
  }
  // `*` 只在生产算问题（开发时前后端本来就是两个源）；这台是 NODE_ENV=test，所以不该吵
  checkEqual(info.config.find((item) => item.key === "CORS_ORIGINS").warning, false, "非生产环境 CORS 全开不告警");
  checkEqual(info.config.find((item) => item.key === "ADMIN_REGISTER_OPEN").warning, false, "配了注册码时「开放注册」开关不告警");

  // 启动自检与信息页同源：配置正常时，启动日志里一条告警都不该有
  const normalLogs = server.serverLogs.join("");
  for (const keyword of ["JWT_SECRET", "CORS_ORIGINS", "ADMIN_REGISTER_OPEN"]) {
    check(!normalLogs.includes(keyword), `配置正常时启动日志没提 ${keyword}`);
  }

  // —— 配置快照：脱敏（最要紧的一条是「值里不能出现原文」）——
  const snapshotText = JSON.stringify(info.config);
  check(!snapshotText.includes("e2e-guard-secret"), "JWT_SECRET 原文不出现在快照里");
  check(!snapshotText.includes(ADMIN_CODE), "ADMIN_REGISTER_CODE 原文不出现在快照里");

  const jwtItem = info.config.find((item) => item.key === "JWT_SECRET");
  checkEqual(jwtItem.sensitive, true, "JWT_SECRET 标为脱敏项");
  checkEqual(jwtItem.warning, false, "已自定义过密钥 → 不告警");
  checkEqual(jwtItem.value, "已自定义", "JWT_SECRET 只报形态（已自定义）");

  const codeItem = info.config.find((item) => item.key === "ADMIN_REGISTER_CODE");
  checkEqual(codeItem.sensitive, true, "ADMIN_REGISTER_CODE 标为脱敏项");
  check(codeItem.value.includes("已设置"), "注册码只报「已设置」而不回显原文");

  // —— 权限：这一页暴露部署形态（文件路径、限流与保留阈值），不给只读观察员 ——
  const viewerRead = await api(baseUrl, "GET", "/api/admin/system", { token: tokens.viewerToken });
  checkEqual(viewerRead.status, 403, "只读观察员没有 system:read，读不到（403）");
  checkEqual(viewerRead.body.code, 30006, "越权的业务码是 30006");
  const playerRead = await api(baseUrl, "GET", "/api/admin/system", { token: tokens.playerToken });
  checkEqual(playerRead.status, 401, "玩家令牌进不了管理端接口（401）");

  // —— 第二支：生产环境的「危险默认值」组合 ——
  const risky = await startServer({
    NODE_ENV: "production",
    JWT_SECRET: DEFAULT_JWT_SECRET,
    ADMIN_REGISTER_CODE: "",
    ADMIN_REGISTER_OPEN: "true",
    PLAYER_REGISTER_OPEN: "false",
  });
  try {
    // 启动日志：三条告警必须都喊出来（判据与信息页同源，所以两边只会是一致的）
    const riskyLogs = risky.serverLogs.join("");
    check(riskyLogs.includes("JWT_SECRET 仍是内置默认值"), "启动自检喊出「密钥仍是默认值」");
    check(riskyLogs.includes("CORS_ORIGINS 是 *"), "启动自检喊出「CORS 全开」");
    check(riskyLogs.includes("ADMIN_REGISTER_OPEN 开着"), "启动自检喊出「公网开放注册」");

    // 没配注册码但显式开了开放注册 → 仍然可以注册（这是开发机/内网的逃生口）
    const registered = await api(risky.baseUrl, "POST", "/api/admin/auth/register", {
      body: { username: "risky_super", password: "risky-mpvk-7" },
    });
    checkEqual(registered.body.code, 0, "没注册码但开了 ADMIN_REGISTER_OPEN → 可以注册");

    const riskyInfo = await api(risky.baseUrl, "GET", "/api/admin/system", { token: registered.body.data.token });
    const rows = riskyInfo.body.data.config;
    const rowOf = (key) => rows.find((item) => item.key === key);
    checkEqual(rowOf("JWT_SECRET").warning, true, "生产 + 默认密钥 → 信息页标红");
    checkEqual(rowOf("CORS_ORIGINS").warning, true, "生产 + CORS 全开 → 信息页标红");
    checkEqual(rowOf("ADMIN_REGISTER_OPEN").warning, true, "生产 + 开放注册且无注册码 → 信息页标红");
    check(rowOf("JWT_SECRET").value.includes("默认"), "默认密钥只报「仍是内置默认值」而不回显原文");
    check(!JSON.stringify(rows).includes(DEFAULT_JWT_SECRET), "默认密钥原文不出现在快照里");
    check(!JSON.stringify(rows).includes("risky-mpvk-7"), "口令不可能出现在快照里");

    // 玩家注册开关：关掉后只有已注册账号能登录
    const closedPlayer = await api(risky.baseUrl, "POST", "/api/auth/register", {
      body: { username: "risky_player", password: "risky-plyr-1" },
    });
    checkEqual(closedPlayer.status, 403, "关了玩家注册后注册被拒（403）");
    checkEqual(closedPlayer.body.code, 10006, "玩家注册关闭的业务码是 10006");
  } finally {
    risky.kill();
  }

  // —— 第三支：两个开关都用默认值（没注册码、没开开放注册）→ 管理端注册直接关死 ——
  const closed = await startServer({ ADMIN_REGISTER_CODE: "" });
  try {
    const denied = await api(closed.baseUrl, "POST", "/api/admin/auth/register", {
      body: { username: "closed_super", password: "closed-mpvk-7" },
    });
    checkEqual(denied.status, 403, "没注册码又没开开关 → 管理端注册被拒（403）");
    checkEqual(denied.body.code, 30012, "管理端注册关闭的业务码是 30012（与「注册码错误」30004 分开）");
    // 一个管理员都没有 + 注册关着 = 后台谁也进不去，启动日志必须说清楚怎么救
    check(closed.serverLogs.join("").includes("还没有任何管理员"), "没有管理员且注册关闭时，启动日志给出补救办法");
  } finally {
    closed.kill();
  }
}

//#endregion

//#region 十一：审计保留策略

/**
 * 直接往文件库里塞一条 N 天前的日志
 *
 * 内存库做不到（外部进程看不见也塞不进），所以这一段单独用文件库 ——
 * 也只有这样才验得了「陈年日志在启动时被按保留天数清掉」。
 */
function seedOldLog(dbPath, days, action) {
  const db = new DatabaseSync(dbPath);
  db.prepare(
    `INSERT INTO audit_logs
      (id, actor_id, actor_name, actor_role, action, target_type, target_id, detail,
       ip, method, path, status_code, success, error_code, error_message, created_at)
     VALUES (?, NULL, NULL, NULL, ?, NULL, NULL, NULL, '127.0.0.1', 'GET', '/seed', 200, 1, NULL, NULL, ?)`,
  ).run(`seed-${action}-${days}`, action, Date.now() - days * 24 * 3600_000);
  db.close();
}

/** 等文件锁松开（服务刚被 kill，进程退出与句柄释放有一小段延迟），成功返回 true */
async function seedWithRetry(dbPath, days, action) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      seedOldLog(dbPath, days, action);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  return false;
}

/**
 * 审计保留策略（配置驱动）
 *
 * 保留天数只影响「陈年日志」，靠等是等不出来的 —— 所以用文件库：起一台把表建好，
 * 手工塞一条 40 天前的日志，再按不同的 `AUDIT_RETENTION_DAYS` 重启，看它还在不在。
 */
async function runRetentionSuite() {
  group("十一、审计保留策略：AUDIT_RETENTION_DAYS 生效");

  const dbPath = path.join(os.tmpdir(), `olua-audit-retention-${Date.now()}.db`);
  const OLD_ACTION = "retention.oldRow";

  // ① 先起一台把表建出来并注册超管（后面几台复用同一个库文件）
  const setup = await startServer({ DB_PATH: dbPath, AUDIT_LOG_MAX_ROWS: "0", AUDIT_RETENTION_DAYS: "0" });
  const registered = await api(setup.baseUrl, "POST", "/api/admin/auth/register", {
    body: { username: "retention_super", password: "retention-pass-1", registerCode: ADMIN_CODE },
  });
  checkEqual(registered.body.code, 0, "准备：文件库 + 超管（后续几台复用同一个库）");
  setup.kill();

  // ② 保留 30 天：塞一条 40 天前的日志，重启后应当被清掉
  check(await seedWithRetry(dbPath, 40, OLD_ACTION), "准备：往库里塞一条 40 天前的日志");

  const pruneOn = await startServer({ DB_PATH: dbPath, AUDIT_LOG_MAX_ROWS: "0", AUDIT_RETENTION_DAYS: "30" });
  try {
    const login = await api(pruneOn.baseUrl, "POST", "/api/admin/auth/login", {
      body: { username: "retention_super", password: "retention-pass-1" },
    });
    const token = login.body.data.token;
    checkEqual(login.body.code, 0, "重启后超管仍在（同一个库）");

    const old = await api(pruneOn.baseUrl, "GET", `/api/admin/audit-logs?action=${OLD_ACTION}`, { token });
    checkEqual(old.body.data.total, 0, "启动时按保留天数清掉了陈年日志");

    const recent = await api(pruneOn.baseUrl, "GET", "/api/admin/audit-logs?size=1", { token });
    check(recent.body.data.total > 0, "保留期内的日志不受影响");
  } finally {
    pruneOn.kill();
  }

  // ③ 保留天数填 0 = 不按时间清理：同样一条陈年日志必须留着
  check(await seedWithRetry(dbPath, 40, OLD_ACTION), "准备：再塞一条同样陈年的日志");

  const pruneOff = await startServer({ DB_PATH: dbPath, AUDIT_LOG_MAX_ROWS: "0", AUDIT_RETENTION_DAYS: "0" });
  try {
    const login = await api(pruneOff.baseUrl, "POST", "/api/admin/auth/login", {
      body: { username: "retention_super", password: "retention-pass-1" },
    });
    const token = login.body.data.token;
    const kept = await api(pruneOff.baseUrl, "GET", `/api/admin/audit-logs?action=${OLD_ACTION}`, { token });
    checkEqual(kept.body.data.total, 1, "AUDIT_RETENTION_DAYS=0 = 不按时间清理（陈年日志留着）");
  } finally {
    pruneOff.kill();
  }

  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    try {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  }
}

//#endregion

//#region 十二：第二台服务专测 IP 维度限流

async function runIpSuite(baseUrl) {
  group("十二、登录限流：按 IP 锁定（阈值 1 次，用户名维度放宽）");

  const first = await api(baseUrl, "POST", "/api/auth/login", { body: { username: "ip_victim_a", password: "x-pass-1" } });
  checkEqual(first.body.code, 10003, "第一次失败（用户名维度未锁）");

  const second = await api(baseUrl, "POST", "/api/auth/login", { body: { username: "ip_victim_b", password: "x-pass-1" } });
  checkEqual(second.status, 429, "换一个用户名也会被 IP 维度拦下（429）");
  checkEqual(second.body.code, 10005, "IP 维度锁定同样是 10005");

  const adminIp = await api(baseUrl, "POST", "/api/admin/auth/login", { body: { username: "ip_victim_admin", password: "x-pass-1" } });
  checkEqual(adminIp.status, 429, "管理端登录共用同一套 IP 限流");
}

//#endregion

async function main() {
  runUtilSuite();

  const main1 = await startServer({ LOGIN_MAX_FAILURES: "3", LOGIN_LOCK_MS: "600000", LOGIN_IP_MAX_FAILURES: "1000" });
  try {
    const tokens = await runMainSuite(main1.baseUrl);
    await runSystemSuite(main1, tokens);
  } finally {
    main1.kill();
  }

  await runRetentionSuite();

  const main2 = await startServer({ LOGIN_MAX_FAILURES: "1000", LOGIN_IP_MAX_FAILURES: "1", LOGIN_IP_LOCK_MS: "600000" });
  try {
    await runIpSuite(main2.baseUrl);
  } finally {
    main2.kill();
  }

  console.log(
    `\n${failed === 0 ? "✅" : "❌"} 口令 / 审计 / 限流 / 踢下线 / 封禁 / 看板 / 列表 / 导出 / 系统信息：${passed} 条通过 / ${failed} 条失败`,
  );
  if (failed) {
    console.log("失败项：\n" + failures.map((item) => `  - ${item}`).join("\n"));
    process.exitCode = 1;
  }
}

void main();
