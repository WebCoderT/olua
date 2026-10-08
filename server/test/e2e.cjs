#!/usr/bin/env node
/**
 * 服务端 e2e 冒烟测试（真实进程 + 真实 HTTP）
 *
 * 做法：另起一个 `node dist/main.js` 子进程（内存库、随机空闲端口、固定密钥），
 * 然后把它当成一个黑盒服务，按**客户端与管理端真实会走的顺序**打完一圈：
 * 注册 → 登录 → 建角色 → 列表 → 选中 → 保存进度 → 越权/令牌串用 → 管理端登录 → 查账号角色 → 改角色 → 封禁 → 删账号。
 *
 * 前置：npm run build（本脚本跑的是 dist/，不是 ts 源码 —— 这样连编译产物一起验了）
 * 用法：npm run test:e2e
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const ADMIN_CODE = "e2e-admin-code";

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

/** 取一个空闲端口（避免与开发中的服务撞端口） */
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

/** 等子进程里服务起来（轮询健康检查） */
async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务进程提前退出（code=${child.exitCode}）`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      /* 还没起来，继续等 */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("等待服务启动超时");
}

/** 发一次请求，返回 { status, body }（body 是解析后的统一响应包裹） */
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

async function main() {
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
      JWT_SECRET: "e2e-secret-key",
      JWT_EXPIRES_IN: "1h",
      ADMIN_REGISTER_CODE: ADMIN_CODE,
      ROLE_MAX_PER_ACCOUNT: "3",
      LOG_REQUESTS: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const serverErrors = [];
  child.stderr.on("data", (chunk) => serverErrors.push(String(chunk)));
  child.stdout.on("data", () => {});

  try {
    await waitForServer(baseUrl, child);
    await runSuite(baseUrl);
  } finally {
    child.kill("SIGTERM");
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"} 服务端 e2e：${passed} 条通过 / ${failed} 条失败`);
  if (failed) {
    console.log("失败项：\n" + failures.map((item) => `  - ${item}`).join("\n"));
    if (serverErrors.length) console.log("服务端 stderr：\n" + serverErrors.join(""));
    process.exitCode = 1;
  }
}

async function runSuite(baseUrl) {
  const call = (method, route, options) => api(baseUrl, method, route, options);

  //#region 一、基础：健康检查 + 统一响应包裹 + Swagger
  group("统一响应包裹 / 健康检查 / 接口文档");

  const health = await call("GET", "/api/health");
  checkEqual(health.status, 200, "GET /api/health 返回 200");
  checkEqual(health.body.code, 0, "响应 code 为 0");
  checkEqual(health.body.message, "ok", "响应 message 为 ok");
  check(typeof health.body.timestamp === "number", "响应带 timestamp");
  checkEqual(health.body.data.status, "ok", "data.status = ok");

  const docs = await fetch(`${baseUrl}/api-docs-json`);
  checkEqual(docs.status, 200, "Swagger JSON 可访问（/api-docs-json）");
  const document = await docs.json();
  check(Boolean(document.paths["/api/auth/login"]), "文档包含 /api/auth/login");
  check(Boolean(document.paths["/api/roles/{id}"]), "文档包含 /api/roles/{id}");
  check(Boolean(document.paths["/api/admin/roles/{id}"]), "文档包含 /api/admin/roles/{id}");
  const loginSchema = JSON.stringify(document.paths["/api/auth/login"].post.responses["200"]);
  check(loginSchema.includes("ApiEnvelopeDto"), "登录响应在文档里画出了统一包裹");
  const docsPage = await fetch(`${baseUrl}/api-docs`);
  checkEqual(docsPage.status, 200, "Swagger UI 页面可访问（/api-docs）");

  // —— 文档分组：公共接口 / 客户端 / 管理端，且与令牌要求、权限点一一对应 ——
  const tagsOf = (route, method) => document.paths[route]?.[method]?.tags ?? [];
  const securityOf = (route, method) => (document.paths[route]?.[method]?.security ?? []).flatMap((item) => Object.keys(item));
  const permOf = (route, method) => document.paths[route]?.[method]?.["x-olua-permissions"] ?? [];
  const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

  checkEqual(
    (document.tags ?? []).map((item) => item.name).join(" | "),
    "公共接口 | 客户端 | 管理端",
    "文档声明三个分组且顺序为 公共 → 客户端 → 管理端",
  );
  checkEqual(tagsOf("/api/health", "get").join(","), "公共接口", "健康检查归入公共接口");
  checkEqual(tagsOf("/api/auth/login", "post").join(","), "公共接口", "登录归入公共接口");
  checkEqual(tagsOf("/api/admin/auth/register", "post").join(","), "公共接口", "管理员注册归入公共接口");
  checkEqual(tagsOf("/api/auth/me", "get").join(","), "客户端", "账号 me 归入客户端");
  checkEqual(tagsOf("/api/roles/{id}", "get").join(","), "客户端", "角色接口归入客户端");
  checkEqual(tagsOf("/api/admin/roles/{id}", "get").join(","), "管理端", "管理端角色接口归入管理端");
  checkEqual(tagsOf("/api/admin/admins/{id}", "patch").join(","), "管理端", "管理员管理接口归入管理端");

  checkEqual(securityOf("/api/auth/login", "post").length, 0, "公共接口不要求令牌");
  checkEqual(securityOf("/api/roles/{id}", "get").join(","), "player", "客户端接口要求 player 令牌");
  checkEqual(securityOf("/api/admin/roles/{id}", "patch").join(","), "admin", "管理端接口要求 admin 令牌");

  checkEqual(permOf("/api/admin/roles/{id}", "patch").join(","), "role:write", "改角色标注所需权限点 role:write");
  checkEqual(permOf("/api/admin/roles/{id}", "delete").join(","), "role:delete", "删角色标注 role:delete");
  checkEqual(permOf("/api/admin/accounts/{id}/status", "patch").join(","), "account:status", "封号标注 account:status");
  checkEqual(permOf("/api/admin/admins/{id}", "patch").join(","), "admin:manage", "管理员管理标注 admin:manage");
  checkEqual(permOf("/api/admin/auth/me", "get").length, 0, "「查自己」不需要权限点");
  check(
    String(document.paths["/api/admin/accounts/{id}/status"].patch.description ?? "").includes("所需权限"),
    "文档里写出了「所需权限」说明",
  );

  const multiTag = Object.entries(document.paths).flatMap(([route, item]) =>
    HTTP_METHODS.filter((method) => item[method]).filter((method) => (item[method].tags ?? []).length !== 1).map((method) => `${method.toUpperCase()} ${route}`),
  );
  checkEqual(multiTag.length, 0, `每个接口恰好属于一个分组（异常：${multiTag.join("；") || "无"}）`);

  //#endregion

  //#region 二、注册 / 登录
  group("注册与登录");

  const badRegister = await call("POST", "/api/auth/register", { body: { username: "ab", password: "123456" } });
  checkEqual(badRegister.status, 400, "非法账号名被拒（400）");
  checkEqual(badRegister.body.code, 40000, "非法账号名的业务码为 PARAM_INVALID");
  check(Array.isArray(badRegister.body.data) === false && badRegister.body.data === null, "失败响应 data 为 null");

  const register = await call("POST", "/api/auth/register", { body: { username: "player001", password: "123456" } });
  checkEqual(register.status, 201, "注册返回 201");
  const playerToken = register.body.data?.token;
  check(typeof playerToken === "string" && playerToken.length > 20, "注册直接返回令牌");
  checkEqual(register.body.data.account.username, "player001", "返回账号名");
  checkEqual(register.body.data.account.status, "active", "新账号状态为 active");

  const dupRegister = await call("POST", "/api/auth/register", { body: { username: "player001", password: "123456" } });
  checkEqual(dupRegister.status, 409, "重复注册被拒（409）");
  checkEqual(dupRegister.body.code, 10001, "重复注册业务码为 ACCOUNT_EXISTS");

  const wrongPassword = await call("POST", "/api/auth/login", { body: { username: "player001", password: "bad-pass" } });
  checkEqual(wrongPassword.status, 401, "密码错误返回 401");
  checkEqual(wrongPassword.body.code, 10003, "密码错误业务码为 PASSWORD_WRONG");
  checkEqual(wrongPassword.body.message, "账号或密码错误", "密码错误与账号不存在同提示");

  const unknownAccount = await call("POST", "/api/auth/login", { body: { username: "nobody", password: "123456" } });
  checkEqual(unknownAccount.body.message, wrongPassword.body.message, "账号不存在与密码错误提示一致（不暴露账号）");

  const login = await call("POST", "/api/auth/login", { body: { username: "player001", password: "123456" } });
  checkEqual(login.status, 200, "登录返回 200");
  const token = login.body.data.token;

  const me = await call("GET", "/api/auth/me", { token });
  checkEqual(me.body.data.username, "player001", "GET /api/auth/me 返回当前账号");

  const noToken = await call("GET", "/api/auth/me");
  checkEqual(noToken.status, 401, "无令牌访问受保护接口返回 401");
  checkEqual(noToken.body.code, 40100, "无令牌业务码为 UNAUTHORIZED");

  const forgeToken = await call("GET", "/api/auth/me", { token: "not-a-real-token" });
  checkEqual(forgeToken.status, 401, "伪造令牌被拒（401）");
  checkEqual(forgeToken.body.code, 40101, "伪造令牌业务码为 TOKEN_INVALID");

  //#endregion

  //#region 三、角色操作
  group("角色：列表 / 创建 / 上限 / 重名 / 详情");

  const emptyList = await call("GET", "/api/roles", { token });
  checkEqual(emptyList.status, 200, "角色列表可访问");
  checkEqual(emptyList.body.data.length, 0, "新账号角色列表为空");

  const badRoleData = await call("POST", "/api/roles", { token, body: { data: { id: "r1", name: "  ", occupation: "1", sex: "1", level: 1 } } });
  checkEqual(badRoleData.status, 400, "空角色名被拒（400）");
  checkEqual(badRoleData.body.code, 20003, "空角色名业务码为 ROLE_DATA_INVALID");

  const badOccupation = await call("POST", "/api/roles", { token, body: { data: { id: "r1", name: "小明", occupation: "9", sex: "1", level: 1 } } });
  checkEqual(badOccupation.body.code, 20003, "非法职业被拒");

  const role1 = { id: "1001", name: "小明", occupation: "1", sex: "1", level: 1, gold: 1000, bindGold: 500, silver: 0, exp: 0, bag: [[{ id: "a", count: 1 }]], equipments: { CLOTH: "x" } };
  const created = await call("POST", "/api/roles", { token, body: { data: role1 } });
  checkEqual(created.status, 201, "创建角色返回 201");
  checkEqual(created.body.data.id, "1001", "返回角色 id");
  checkEqual(created.body.data.online, true, "第一个角色自动设为在线");
  checkEqual(created.body.data.data.gold, 1000, "完整 data 原样返回");

  const dupId = await call("POST", "/api/roles", { token, body: { data: { ...role1, name: "小红" } } });
  checkEqual(dupId.status, 409, "重复角色 id 被拒（409）");
  checkEqual(dupId.body.code, 20004, "重复 id 业务码为 ROLE_ID_EXISTS");

  const dupName = await call("POST", "/api/roles", { token, body: { data: { ...role1, id: "1002" } } });
  checkEqual(dupName.body.code, 20005, "同账号重名被拒");

  const role2 = await call("POST", "/api/roles", { token, body: { data: { ...role1, id: "1002", name: "小红", occupation: "2", sex: "2" } } });
  checkEqual(role2.status, 201, "创建第二个角色成功");
  checkEqual(role2.body.data.online, false, "第二个角色不会顶掉在线角色");

  const role3 = await call("POST", "/api/roles", { token, body: { data: { ...role1, id: "1003", name: "小刚" } } });
  checkEqual(role3.status, 201, "创建第三个角色成功");

  const role4 = await call("POST", "/api/roles", { token, body: { data: { ...role1, id: "1004", name: "小强" } } });
  checkEqual(role4.status, 409, "超过角色上限被拒（409）");
  checkEqual(role4.body.code, 20001, "超上限业务码为 ROLE_LIMIT");

  const list = await call("GET", "/api/roles", { token });
  checkEqual(list.body.data.length, 3, "角色列表 3 个");
  checkEqual(list.body.data[0].name, "小明", "列表按创建顺序");
  checkEqual(list.body.data[0].data, undefined, "列表不含 data（体量小）");
  checkEqual(list.body.data[0].online, true, "列表带在线标记");

  const detail = await call("GET", "/api/roles/1001", { token });
  checkEqual(detail.body.data.data.bag[0][0].id, "a", "详情含完整 data（背包原样）");
  checkEqual(detail.body.data.data.equipments.CLOTH, "x", "详情含装备槽");

  const missingDetail = await call("GET", "/api/roles/nope", { token });
  checkEqual(missingDetail.status, 404, "角色不存在返回 404");
  checkEqual(missingDetail.body.code, 20002, "角色不存在业务码为 ROLE_NOT_FOUND");

  //#endregion

  //#region 四、保存进度 / 选中
  group("角色：保存进度 / 切换在线");

  const save = await call("PUT", "/api/roles/1001", {
    token,
    body: { data: { ...role1, id: "换掉的id", level: 5, gold: 8888, exp: 120 } },
  });
  checkEqual(save.status, 200, "保存进度返回 200");
  checkEqual(save.body.data.id, "1001", "id 以路径为准（请求体里的 id 被忽略）");
  checkEqual(save.body.data.level, 5, "等级已保存");
  checkEqual(save.body.data.data.gold, 8888, "金币已保存");
  checkEqual(save.body.data.data.bag[0][0].id, "a", "未改动的字段原样保留");

  const savedDetail = await call("GET", "/api/roles/1001", { token });
  checkEqual(savedDetail.body.data.level, 5, "重新读取仍是保存后的等级");

  const onlineBefore = await call("GET", "/api/roles/online", { token });
  checkEqual(onlineBefore.body.data.id, "1001", "在线角色是 1001");

  const select = await call("POST", "/api/roles/1002/select", { token });
  checkEqual(select.status, 200, "选中角色返回 200");
  checkEqual(select.body.data.online, true, "返回体标记为在线");

  const onlineAfter = await call("GET", "/api/roles/online", { token });
  checkEqual(onlineAfter.body.data.id, "1002", "在线角色切换为 1002");
  checkEqual(onlineAfter.body.data.data.gold, 1000, "在线角色返回完整 data");

  const listAfterSelect = await call("GET", "/api/roles", { token });
  checkEqual(listAfterSelect.body.data.filter((item) => item.online).length, 1, "同时只有一个在线角色");

  //#endregion

  //#region 五、越权与令牌隔离
  group("越权防护 / 令牌受众隔离");

  await call("POST", "/api/auth/register", { body: { username: "player002", password: "123456" } });
  const otherLogin = await call("POST", "/api/auth/login", { body: { username: "player002", password: "123456" } });
  const otherToken = otherLogin.body.data.token;

  const otherList = await call("GET", "/api/roles", { token: otherToken });
  checkEqual(otherList.body.data.length, 0, "另一个账号看不到别人的角色");

  const stealRead = await call("GET", "/api/roles/1001", { token: otherToken });
  checkEqual(stealRead.status, 403, "读别人的角色返回 403");

  const stealWrite = await call("PUT", "/api/roles/1001", { token: otherToken, body: { data: role1 } });
  checkEqual(stealWrite.status, 403, "改别人的角色返回 403");

  const stealDelete = await call("DELETE", "/api/roles/1001", { token: otherToken });
  checkEqual(stealDelete.status, 403, "删别人的角色返回 403");

  const playerOnAdmin = await call("GET", "/api/admin/accounts", { token });
  checkEqual(playerOnAdmin.status, 401, "玩家令牌调管理端接口被拒（401）");

  const adminOnPlayer = await call("GET", "/api/roles");
  checkEqual(adminOnPlayer.status, 401, "无令牌调玩家接口被拒（401）");

  //#endregion

  //#region 六、管理端
  group("管理端：注册 / 登录 / 账号与角色管理");

  const wrongCode = await call("POST", "/api/admin/auth/register", { body: { username: "gm001", password: "admin123", registerCode: "wrong" } });
  checkEqual(wrongCode.status, 403, "注册码不对被拒（403）");
  checkEqual(wrongCode.body.code, 30004, "注册码错误业务码为 ADMIN_REGISTER_CODE_WRONG");

  const adminRegister = await call("POST", "/api/admin/auth/register", { body: { username: "gm001", password: "admin123", registerCode: ADMIN_CODE } });
  checkEqual(adminRegister.status, 201, "管理员注册成功（201）");
  const adminToken = adminRegister.body.data.token;

  const adminLogin = await call("POST", "/api/admin/auth/login", { body: { username: "gm001", password: "admin123" } });
  checkEqual(adminLogin.status, 200, "管理员登录返回 200");
  const adminLoginToken = adminLogin.body.data.token;

  const adminMe = await call("GET", "/api/admin/auth/me", { token: adminLoginToken });
  checkEqual(adminMe.body.data.username, "gm001", "管理员 me 返回当前管理员");

  const adminNoToken = await call("GET", "/api/admin/accounts");
  checkEqual(adminNoToken.status, 401, "无令牌调管理端接口被拒（401）");

  const adminByPlayerToken = await call("GET", "/api/admin/accounts", { token });
  checkEqual(adminByPlayerToken.status, 401, "玩家令牌调管理端被拒（401）");

  const stats = await call("GET", "/api/admin/stats", { token: adminToken });
  checkEqual(stats.status, 200, "概览统计可访问");
  checkEqual(stats.body.data.accountCount, 2, "账号总数 = 2");
  checkEqual(stats.body.data.roleCount, 3, "角色总数 = 3");
  checkEqual(stats.body.data.adminCount, 1, "管理员数 = 1");

  const accounts = await call("GET", "/api/admin/accounts?page=1&size=10", { token: adminToken });
  checkEqual(accounts.body.data.total, 2, "账号分页 total = 2");
  checkEqual(accounts.body.data.list.length, 2, "账号分页 list 长度");
  checkEqual(accounts.body.data.page, 1, "分页回显 page");
  check(typeof accounts.body.data.list[0].roleCount === "number", "账号列表带角色数");

  const keywordAccounts = await call("GET", "/api/admin/accounts?keyword=player002", { token: adminToken });
  checkEqual(keywordAccounts.body.data.total, 1, "账号关键字检索生效");

  const pagedAccounts = await call("GET", "/api/admin/accounts?page=2&size=1", { token: adminToken });
  checkEqual(pagedAccounts.body.data.list.length, 1, "第二页 size=1 返回 1 条");

  const accountId = register.body.data.account.id;
  const accountDetail = await call("GET", `/api/admin/accounts/${accountId}`, { token: adminToken });
  checkEqual(accountDetail.body.data.account.username, "player001", "账号详情返回账号信息");
  checkEqual(accountDetail.body.data.roles.length, 3, "账号详情带名下角色");

  const adminRoles = await call("GET", `/api/admin/roles?accountId=${accountId}`, { token: adminToken });
  checkEqual(adminRoles.body.data.total, 3, "按账号查角色 total = 3");
  checkEqual(adminRoles.body.data.list[0].accountName, "player001", "角色列表带账号名");
  checkEqual(adminRoles.body.data.list.filter((item) => item.online).length, 1, "角色列表带在线标记");

  const roleKeyword = await call("GET", "/api/admin/roles?keyword=1001", { token: adminToken });
  checkEqual(roleKeyword.body.data.total, 1, "角色 id 关键字检索生效");

  const roleDetail = await call("GET", "/api/admin/roles/1001", { token: adminToken });
  checkEqual(roleDetail.body.data.name, "小明", "管理端角色详情");
  checkEqual(roleDetail.body.data.data.bag[0][0].id, "a", "管理端角色详情含完整 data");
  checkEqual(roleDetail.body.data.accountName, "player001", "管理端角色详情带账号名");

  const patched = await call("PATCH", "/api/admin/roles/1001", { token: adminToken, body: { level: 42, gold: 99999, bindGold: 777, exp: 555, title: 3 } });
  checkEqual(patched.status, 200, "管理端改角色返回 200");
  checkEqual(patched.body.data.level, 42, "等级已改");
  checkEqual(patched.body.data.data.gold, 99999, "金币已改（写进 data）");
  checkEqual(patched.body.data.data.title, 3, "称号已改");
  checkEqual(patched.body.data.data.bag[0][0].id, "a", "未编辑的背包字段原样保留");

  const patchedName = await call("PATCH", "/api/admin/roles/1001", { token: adminToken, body: { name: "改名后" } });
  checkEqual(patchedName.body.data.name, "改名后", "角色名已改");

  const badPatch = await call("PATCH", "/api/admin/roles/1001", { token: adminToken, body: { level: 0 } });
  checkEqual(badPatch.status, 400, "等级 0 被拒（400）");

  const playerSeesPatch = await call("GET", "/api/roles/1001", { token });
  checkEqual(playerSeesPatch.body.data.level, 42, "客户端能读到管理端的改动");
  checkEqual(playerSeesPatch.body.data.name, "改名后", "客户端能读到管理端改的名字");

  const adminSelect = await call("POST", "/api/admin/roles/1001/select", { token: adminToken });
  checkEqual(adminSelect.status, 200, "管理端设为在线角色返回 200");
  checkEqual(adminSelect.body.data.online, true, "管理端设为在线后返回体标记在线");
  const onlineAfterAdminSelect = await call("GET", "/api/roles/online", { token });
  checkEqual(onlineAfterAdminSelect.body.data.id, "1001", "管理端设置的在线角色对客户端生效");

  const restoreOnline = await call("POST", "/api/admin/roles/1002/select", { token: adminToken });
  checkEqual(restoreOnline.body.data.online, true, "管理端可再次切换在线角色");

  const disable = await call("PATCH", `/api/admin/accounts/${accountId}/status`, { token: adminToken, body: { status: "disabled" } });
  checkEqual(disable.body.data.status, "disabled", "账号已封禁");

  const blockedAfterBan = await call("GET", "/api/auth/me", { token });
  checkEqual(blockedAfterBan.status, 401, "封禁后旧令牌立即失效（401）");
  checkEqual(blockedAfterBan.body.code, 10004, "封禁业务码为 ACCOUNT_DISABLED");

  const blockedLogin = await call("POST", "/api/auth/login", { body: { username: "player001", password: "123456" } });
  checkEqual(blockedLogin.status, 403, "封禁账号无法登录（403）");

  const enable = await call("PATCH", `/api/admin/accounts/${accountId}/status`, { token: adminToken, body: { status: "active" } });
  checkEqual(enable.body.data.status, "active", "账号已解封");
  const afterEnable = await call("GET", "/api/auth/me", { token });
  checkEqual(afterEnable.status, 200, "解封后令牌恢复可用");

  const deleteOnlineRole = await call("DELETE", "/api/admin/roles/1002", { token: adminToken });
  checkEqual(deleteOnlineRole.status, 200, "管理端删除在线角色成功");
  checkEqual(deleteOnlineRole.body.data, null, "删除接口 data 为 null");
  const onlineAfterDelete = await call("GET", "/api/roles/online", { token });
  checkEqual(onlineAfterDelete.body.data, null, "在线角色被删后在线标记清空");

  const deleteOwnRole = await call("DELETE", "/api/roles/1003", { token });
  checkEqual(deleteOwnRole.status, 200, "客户端删除角色成功");
  const listAfterDelete = await call("GET", "/api/roles", { token });
  checkEqual(listAfterDelete.body.data.length, 1, "删除后角色只剩 1 个");

  const otherAccountId = otherLogin.body.data.account.id;
  const deleteAccount = await call("DELETE", `/api/admin/accounts/${accountId}`, { token: adminToken });
  checkEqual(deleteAccount.status, 200, "管理端删除账号成功");

  const accountsAfterDelete = await call("GET", "/api/admin/accounts", { token: adminToken });
  checkEqual(accountsAfterDelete.body.data.total, 1, "删账号后总数 = 1");

  const cascadedRoles = await call("GET", `/api/admin/roles?accountId=${accountId}`, { token: adminToken });
  checkEqual(cascadedRoles.body.data.total, 0, "账号下的角色被级联删除");

  const accountGone = await call("GET", `/api/admin/accounts/${accountId}`, { token: adminToken });
  checkEqual(accountGone.status, 404, "被删账号详情返回 404");

  const remainingRoles = await call("GET", "/api/admin/roles", { token: adminToken });
  checkEqual(remainingRoles.body.data.total, 0, "角色总数为 0（另一个账号没建角色）");

  const otherStillThere = await call("GET", `/api/admin/accounts/${otherAccountId}`, { token: adminToken });
  checkEqual(otherStillThere.status, 200, "另一个账号不受影响");

  //#endregion

  //#region 七、权限管理：管理员角色 / 权限点 / 保护规则
  group("管理端：权限管理（角色 / 权限点 / 保护）");

  const superPerms = adminMe.body.data.permissions;
  const admin1Id = adminMe.body.data.id;
  checkEqual(adminMe.body.data.role, "super_admin", "第一个注册的管理员自动是超级管理员");
  checkEqual(adminMe.body.data.roleLabel, "超级管理员", "返回角色中文名");
  check(superPerms.includes("admin:manage"), "超级管理员带「管理管理员」权限");

  const adminRegister2 = await call("POST", "/api/admin/auth/register", {
    body: { username: "gm002", password: "cyoe1122", registerCode: ADMIN_CODE },
  });
  checkEqual(adminRegister2.status, 201, "第二个管理员注册成功");
  const admin2Token = adminRegister2.body.data.token;
  const admin2Id = adminRegister2.body.data.admin.id;
  checkEqual(adminRegister2.body.data.admin.role, "admin", "第二个注册的管理员是普通管理员");
  checkEqual(adminRegister2.body.data.admin.roleLabel, "管理员", "普通管理员角色中文名");
  checkEqual(
    superPerms.filter((item) => !adminRegister2.body.data.admin.permissions.includes(item)).join(","),
    "admin:manage",
    "普通管理员只比超管少「管理管理员」",
  );

  const listAdmins = await call("GET", "/api/admin/admins?page=1&size=10", { token: adminToken });
  checkEqual(listAdmins.status, 200, "超管可查管理员列表");
  checkEqual(listAdmins.body.data.total, 2, "管理员总数 = 2");
  checkEqual(listAdmins.body.data.page, 1, "管理员列表回显分页");
  const superOnly = await call("GET", "/api/admin/admins?role=super_admin", { token: adminToken });
  checkEqual(superOnly.body.data.total, 1, "管理员列表可按角色筛选");

  const manageByAdmin2 = await call("PATCH", `/api/admin/admins/${admin1Id}`, { token: admin2Token, body: { role: "viewer" } });
  checkEqual(manageByAdmin2.status, 403, "普通管理员改管理员被拒（403）");
  checkEqual(manageByAdmin2.body.code, 30006, "无权限业务码为 ADMIN_PERMISSION_DENIED");
  check(String(manageByAdmin2.body.message).includes("权限"), "无权限提示说明原因");

  const toViewer = await call("PATCH", `/api/admin/admins/${admin2Id}`, { token: adminToken, body: { role: "viewer" } });
  checkEqual(toViewer.status, 200, "超管可改管理员角色");
  checkEqual(toViewer.body.data.role, "viewer", "已改为只读观察员");
  checkEqual(
    [...toViewer.body.data.permissions].sort().join(","),
    "account:read,role:read,stats:read",
    "只读观察员恰好 3 个读权限",
  );

  // 降权当即生效：还是同一枚旧令牌
  checkEqual((await call("GET", "/api/admin/stats", { token: admin2Token })).status, 200, "只读观察员可看概览");
  checkEqual((await call("GET", "/api/admin/accounts", { token: admin2Token })).status, 200, "只读观察员可看账号列表");
  const viewerBan = await call("PATCH", `/api/admin/accounts/${otherAccountId}/status`, {
    token: admin2Token,
    body: { status: "disabled" },
  });
  checkEqual(viewerBan.status, 403, "只读观察员封号被拒（403）");
  checkEqual(viewerBan.body.code, 30006, "越权封号业务码为 30006");
  checkEqual((await call("PATCH", "/api/admin/roles/1", { token: admin2Token, body: { level: 5 } })).status, 403, "只读观察员改角色被拒");
  checkEqual((await call("POST", "/api/admin/roles/1/select", { token: admin2Token })).status, 403, "只读观察员切在线角色被拒");
  checkEqual((await call("DELETE", "/api/admin/roles/1", { token: admin2Token })).status, 403, "只读观察员删角色被拒");
  checkEqual((await call("GET", "/api/admin/admins", { token: admin2Token })).status, 403, "只读观察员查管理员列表被拒");
  const viewerMe = await call("GET", "/api/admin/auth/me", { token: admin2Token });
  checkEqual(viewerMe.status, 200, "只读观察员可看自己的信息（无需权限点）");
  checkEqual(viewerMe.body.data.role, "viewer", "me 返回最新角色");
  checkEqual(viewerMe.body.data.permissions.length, 3, "me 返回的权限点与角色一致");
  checkEqual((await call("PATCH", `/api/admin/accounts/${otherAccountId}/status`, { token: admin2Token, body: { status: "disabled" } })).body.code, 30006, "越权码重复确认");

  // 最后一个启用中的超管受保护
  const selfDemote = await call("PATCH", `/api/admin/admins/${admin1Id}`, { token: adminToken, body: { role: "admin" } });
  checkEqual(selfDemote.status, 403, "最后一个超管自降被拒（403）");
  checkEqual(selfDemote.body.code, 30007, "保护业务码为 ADMIN_PROTECTED");
  checkEqual(
    (await call("PATCH", `/api/admin/admins/${admin1Id}`, { token: adminToken, body: { status: "disabled" } })).status,
    403,
    "最后一个超管停用自己被拒",
  );
  checkEqual((await call("DELETE", `/api/admin/admins/${admin1Id}`, { token: adminToken })).status, 403, "最后一个超管删除自己被拒");

  // 有第二个超管之后：自降可以，但轮到下一个「最后一个」时又被保护
  const promote = await call("PATCH", `/api/admin/admins/${admin2Id}`, { token: adminToken, body: { role: "super_admin" } });
  checkEqual(promote.body.data.role, "super_admin", "可提升为超级管理员");
  checkEqual((await call("PATCH", `/api/admin/admins/${admin2Id}`, { token: admin2Token, body: { role: "admin" } })).status, 200, "有第二个超管后自降被允许");
  checkEqual(
    (await call("PATCH", `/api/admin/admins/${admin1Id}`, { token: adminToken, body: { role: "viewer" } })).status,
    403,
    "此时 admin1 是最后一个超管，自降再次被拒",
  );

  // 收尾：删掉 gm002（admin1 全程仍是超管）
  checkEqual((await call("DELETE", `/api/admin/admins/${admin2Id}`, { token: adminToken })).status, 200, "超管可删除其他管理员");
  check(Array.isArray((await call("GET", "/api/admin/admins", { token: adminToken })).body.data.list), "管理员列表仍可读（删除后）");
  checkEqual((await call("GET", "/api/admin/admins", { token: adminToken })).body.data.total, 1, "删除后管理员只剩 1 个");
  checkEqual(
    (await call("PATCH", `/api/admin/admins/${admin2Id}`, { token: adminToken, body: { role: "viewer" } })).status,
    404,
    "再改被删掉的管理员返回 404",
  );

  //#endregion
}

main().catch((error) => {
  console.error(`\n❌ e2e 执行失败：${error instanceof Error ? error.message : String(error)}`);
  console.error(error);
  process.exitCode = 1;
});
