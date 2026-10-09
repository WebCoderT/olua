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
const net = require("node:net");
const path = require("node:path");
// 限流的判定是纯函数，直接 require 编译产物跑边界值（不必起服务）
const rateLimit = require(path.join(__dirname, "..", "dist", "common", "utils", "rate-limit.util.js"));
// 封禁的到期判定同理：纯函数，边界值不必起服务
const ban = require(path.join(__dirname, "..", "dist", "common", "utils", "ban.util.js"));

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const ADMIN_CODE = "guard-admin-code";

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

/** 起一台服务并等它就绪，返回 { baseUrl, kill } */
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
  child.stderr.on("data", (chunk) => serverErrors.push(String(chunk)));
  child.stdout.on("data", () => {});

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务进程提前退出（code=${child.exitCode}）\n${serverErrors.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return { baseUrl, kill: () => child.kill("SIGTERM"), serverErrors };
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
}

//#endregion

//#region 八：第二台服务专测 IP 维度限流

async function runIpSuite(baseUrl) {
  group("八、登录限流：按 IP 锁定（阈值 1 次，用户名维度放宽）");

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
    await runMainSuite(main1.baseUrl);
  } finally {
    main1.kill();
  }

  const main2 = await startServer({ LOGIN_MAX_FAILURES: "1000", LOGIN_IP_MAX_FAILURES: "1", LOGIN_IP_LOCK_MS: "600000" });
  try {
    await runIpSuite(main2.baseUrl);
  } finally {
    main2.kill();
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"} 口令 / 审计 / 限流 / 踢下线 / 封禁 / 看板：${passed} 条通过 / ${failed} 条失败`);
  if (failed) {
    console.log("失败项：\n" + failures.map((item) => `  - ${item}`).join("\n"));
    process.exitCode = 1;
  }
}

void main();
