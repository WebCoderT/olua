#!/usr/bin/env node
/**
 * 公告按区投放 e2e（server/test/e2e-zone-announcement.cjs，issue #963）
 *
 * 盯的不变量：
 *
 * 一、**默认投本区**：管理端发公告不带 `scope` 时，落在请求头 `X-Zone-Id` 指的区 ——
 *    同一个超管在 1 区和 2 区各发一条，两条各自只在那个区可见
 * 二、**玩家侧只看到「全服 + 本区」**：1 区的号看不到 2 区的公告，2 区的号看不到 1 区的；
 *    全服公告（`zone_id IS NULL`）两边都看得到
 * 三、**登录页（无令牌）只给全服**：那条公共接口的回答里不能出现任何区公告 ——
 *    玩家还没选区，别区的内部通知不该漏给他
 * 四、**「全服」是影响面权限**：`admin` 角色发 `scope=all` 被拒（403 / 30006），
 *    改投放范围到全服同样被拒；发本区、改别的字段不受影响
 * 五、**区只能由服务端推导**：`?zoneId=<别区>` 对玩家侧毫无影响（响应逐字节相同）
 * 六、**改范围不悄悄搬区**：只改 `enabled` 时 `zoneId` 保持原值（否则一条全服公告
 *    会因为「停用一下」被搬回当前区）
 *
 * 口径（见 workbuddy memory「只校验代码，不校验数据」）：
 * - 断言钉的是**字段与可见性**，不数条数以外的数值；条数只用来证明「哪几条可见」；
 * - 时间窗用「立即生效 / 不设截止」，不赌 wall-clock；
 * - 权限拒绝钉 `30006`（业务码），不钉 HTTP 文案。
 */
const { spawn } = require("child_process");
const net = require("net");
const os = require("os");
const path = require("path");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/** 管理端请求所在的区（与其它套件同款：管理端一次只在一个区里干活） */
const ADMIN_ZONE = 1;

//#region 断言小工具

const failures = [];
let passed = 0;
let failed = 0;

function check(ok, label, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  [OK] ${label}${detail ? " —— " + detail : ""}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  [!!] ${label}${detail ? " —— " + detail : ""}`);
  }
}

function checkEqual(actual, expected, label) {
  return check(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}

function group(label) {
  console.log(`\n▶ ${label}`);
}

//#endregion

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startServer(dbPath) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ENTRY], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      API_PREFIX: "api",
      DB_PATH: dbPath,
      JWT_SECRET: "e2e-zone-announcement-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      ADMIN_REGISTER_CODE: "zone-announcement-code",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(String(chunk)));
  child.stderr.on("data", (chunk) => chunks.push(String(chunk)));

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务进程提前退出（code=${child.exitCode}）\n${chunks.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return { baseUrl, port, child, logs: () => chunks.join("") };
    } catch {
      /* 还没起来 */
    }
    await sleep(100);
  }
  throw new Error("等待服务启动超时");
}

/** 发一个请求，返回 `{ status, body }`（判定 403 要看状态码，业务码在 body 里） */
async function http(baseUrl, method, route, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.zoneId !== undefined) headers["X-Zone-Id"] = String(options.zoneId);
  const response = await fetch(`${baseUrl}/api/${route}`, {
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

/** 只要信封（多数断言看 data / code，不看状态码） */
async function api(baseUrl, method, route, options = {}) {
  return (await http(baseUrl, method, route, options)).body;
}

function createRole(baseUrl, token, name) {
  return api(baseUrl, "POST", "roles", { token, body: { name, occupation: "1", sex: "1" } });
}

/** 标题列表（公告可见性断言只关心「哪几条」，不关心顺序以外的内容） */
function titles(envelope) {
  return Array.isArray(envelope && envelope.data) ? envelope.data.map((item) => item.title) : [];
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-zone-announcement-${Date.now()}.db`);
  const server = await startServer(dbPath);
  try {
    const { baseUrl } = server;

    //#region 准备：两个区 / 三种玩家
    group("准备：两个区、一个超管、一个管理员、三种玩家");

    const superReg = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "ann_super", password: "super-pass-1", registerCode: "zone-announcement-code" },
    });
    const superToken = superReg.data && superReg.data.token;
    check(!!superToken, "准备：超级管理员已注册", superReg.message);

    const zone2 = await api(baseUrl, "POST", "admin/zones", {
      token: superToken,
      zoneId: ADMIN_ZONE,
      body: { name: "二区" },
    });
    const zone2Id = zone2.data && zone2.data.id;
    check(!!zone2Id && zone2Id >= 2, "准备：开了「二区」", JSON.stringify(zone2.data && zone2.data.id));

    // 第二个管理员，降成 `admin`（没有 announcement:publish-all，但能发本区公告）
    const adminReg = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "ann_plain", password: "admin-pass-1", registerCode: "zone-announcement-code" },
    });
    const plainAdminId = adminReg.data && adminReg.data.admin && adminReg.data.admin.id;
    const plainToken = adminReg.data && adminReg.data.token;
    const demoted = await api(baseUrl, "PATCH", `admin/admins/${plainAdminId}`, {
      token: superToken,
      zoneId: ADMIN_ZONE,
      body: { role: "admin" },
    });
    checkEqual(demoted.data && demoted.data.role, "admin", "准备：第二个管理员降为 admin");

    // 三个玩家：1 区有号 / 2 区有号 / 一个角色都没有
    const reg1 = await api(baseUrl, "POST", "auth/register", { body: { username: "ann_p1", password: "pass1234" } });
    const token1 = reg1.data && reg1.data.token;
    const role1 = await createRole(baseUrl, token1, "一区角色");
    check(!!(role1.data && role1.data.id), "准备：玩家 1 在 1 区建了角色");

    const reg2 = await api(baseUrl, "POST", "auth/register", { body: { username: "ann_p2", password: "pass1234" } });
    const token2 = reg2.data && reg2.data.token;
    await api(baseUrl, "POST", "zones/select", { token: token2, body: { zoneId: zone2Id } });
    const role2 = await createRole(baseUrl, token2, "二区角色");
    checkEqual(role2.data && role2.data.zoneId, zone2Id, "准备：玩家 2 在 2 区建了角色");

    const reg3 = await api(baseUrl, "POST", "auth/register", { body: { username: "ann_p3", password: "pass1234" } });
    const token3 = reg3.data && reg3.data.token;
    const roles3 = await api(baseUrl, "GET", "roles", { token: token3 });
    checkEqual((roles3.data || []).length, 0, "准备：玩家 3 一个角色都没有（登录页那种状态）");

    //#endregion

    //#region 一、默认投本区
    group("一、不带 scope 就投当前区（X-Zone-Id 说了算）");

    const made1 = await api(baseUrl, "POST", "admin/announcements", {
      token: superToken,
      zoneId: 1,
      body: { title: "一区通知", content: "只给一区看" },
    });
    checkEqual(made1.data && made1.data.zoneId, 1, "在 1 区发的公告落在 1 区");

    const made2 = await api(baseUrl, "POST", "admin/announcements", {
      token: superToken,
      zoneId: zone2Id,
      body: { title: "二区通知", content: "只给二区看" },
    });
    checkEqual(made2.data && made2.data.zoneId, zone2Id, "同一个超管在 2 区发，就落在 2 区（区取请求头）");

    const publicBefore = await api(baseUrl, "GET", "announcements/active");
    checkEqual(titles(publicBefore).length, 0, "登录页（无令牌）看不到任何区公告");

    const mine1 = await api(baseUrl, "GET", "announcements/mine", { token: token1 });
    checkEqual(titles(mine1).join(","), "一区通知", "1 区的号只看到 1 区那条");
    const mine2 = await api(baseUrl, "GET", "announcements/mine", { token: token2 });
    checkEqual(titles(mine2).join(","), "二区通知", "2 区的号只看到 2 区那条");
    const mine3 = await api(baseUrl, "GET", "announcements/mine", { token: token3 });
    checkEqual(titles(mine3).length, 0, "没有角色的号看不到区公告（它没有「本区」）");

    //#endregion

    //#region 二、全服公告
    group("二、scope=all：所有区都看得到，登录页也看得到");

    const madeAll = await api(baseUrl, "POST", "admin/announcements", {
      token: superToken,
      zoneId: ADMIN_ZONE,
      body: { title: "全服维护公告", content: "所有人都看得到", scope: "all" },
    });
    checkEqual(madeAll.data && madeAll.data.zoneId, null, "scope=all → zoneId 为 null（全服）");

    const publicAfter = await api(baseUrl, "GET", "announcements/active");
    checkEqual(titles(publicAfter).join(","), "全服维护公告", "登录页只多了全服那条，区公告一条不漏进来");

    const mine1b = await api(baseUrl, "GET", "announcements/mine", { token: token1 });
    checkEqual(titles(mine1b).sort().join(","), ["一区通知", "全服维护公告"].sort().join(","), "1 区：全服 + 本区两条都在");
    const mine2b = await api(baseUrl, "GET", "announcements/mine", { token: token2 });
    checkEqual(titles(mine2b).sort().join(","), ["全服维护公告", "二区通知"].sort().join(","), "2 区：全服 + 本区两条都在");
    const mine3b = await api(baseUrl, "GET", "announcements/mine", { token: token3 });
    checkEqual(titles(mine3b).join(","), "全服维护公告", "没有角色的号也能看到全服公告");

    const adminList = await api(baseUrl, "GET", "admin/announcements?size=50", { token: superToken, zoneId: ADMIN_ZONE });
    checkEqual(adminList.data && adminList.data.total, 3, "管理端列表看得到所有区的公告（不按区筛）");
    check(
      (adminList.data.list || []).every((item) => "zoneId" in item),
      "管理端每条都带 zoneId（界面据此显示投放范围）",
    );

    //#endregion

    //#region 三、权限：「全服」是影响面权限
    group("三、非超管发不了全服");

    const plainAll = await http(baseUrl, "POST", "admin/announcements", {
      token: plainToken,
      zoneId: ADMIN_ZONE,
      body: { title: "想打全服", content: "x", scope: "all" },
    });
    checkEqual(plainAll.body && plainAll.body.code, 30006, "admin 角色发 scope=all 被拒（30006）");

    const plainZone = await api(baseUrl, "POST", "admin/announcements", {
      token: plainToken,
      zoneId: zone2Id,
      body: { title: "二区运营通知", content: "管理员在自己区发" },
    });
    checkEqual(plainZone.data && plainZone.data.zoneId, zone2Id, "admin 角色发本区公告照常（默认 scope）");

    const plainPromote = await http(baseUrl, "PATCH", `admin/announcements/${plainZone.data.id}`, {
      token: plainToken,
      zoneId: ADMIN_ZONE,
      body: { scope: "all" },
    });
    checkEqual(plainPromote.body && plainPromote.body.code, 30006, "admin 角色把公告改成全服同样被拒");

    const plainToggle = await api(baseUrl, "PATCH", `admin/announcements/${plainZone.data.id}`, {
      token: plainToken,
      zoneId: ADMIN_ZONE,
      body: { enabled: false },
    });
    checkEqual(plainToggle.data && plainToggle.data.zoneId, zone2Id, "只改 enabled 不会把投放范围搬回当前区");
    checkEqual(plainToggle.data && plainToggle.data.enabled, false, "改 enabled 本身成功");

    //#endregion

    //#region 四、改投放范围
    group("四、超管可以把一条本区公告改成全服");

    const promote = await api(baseUrl, "PATCH", `admin/announcements/${made1.data.id}`, {
      token: superToken,
      zoneId: zone2Id,
      body: { scope: "all" },
    });
    checkEqual(promote.data && promote.data.zoneId, null, "改成全服 → zoneId 变 null");

    const publicFinal = await api(baseUrl, "GET", "announcements/active");
    checkEqual(titles(publicFinal).length, 2, "改完全服后登录页能看到两条");

    const demote = await api(baseUrl, "PATCH", `admin/announcements/${made1.data.id}`, {
      token: superToken,
      zoneId: zone2Id,
      body: { scope: "zone" },
    });
    checkEqual(demote.data && demote.data.zoneId, zone2Id, "scope=zone 时落在**当前区**（2 区），不是原来的一区");

    //#endregion

    //#region 五、区参数无效
    group("五、?zoneId= 对玩家侧毫无影响（区只能由服务端算）");

    const plainResp = await api(baseUrl, "GET", "announcements/mine", { token: token1 });
    const withParam = await api(baseUrl, "GET", "announcements/mine?zoneId=2", { token: token1 });
    checkEqual(
      JSON.stringify(plainResp.data),
      JSON.stringify(withParam.data),
      "带 ?zoneId=2 与不带，响应逐字节相同",
    );

    //#endregion

    //#region 六、文档契约
    group("六、文档契约：新接口 / zoneId 字段 / scope 枚举都进了 openapi");

    const doc = await (await fetch(`${baseUrl}/api-docs-json`)).json();
    check(!!(doc.paths && doc.paths["/api/announcements/mine"]), "openapi 里有 /announcements/mine");
    const announcementSchema = (doc.components && doc.components.schemas && doc.components.schemas.AnnouncementDto) || {};
    check(
      !!(announcementSchema.properties && announcementSchema.properties.zoneId),
      "AnnouncementDto 带 zoneId（管理端据此显示投放范围）",
      Object.keys(announcementSchema.properties || {}).join(","),
    );
    const createSchema = (doc.components && doc.components.schemas && doc.components.schemas.CreateAnnouncementDto) || {};
    const scopeEnum = createSchema.properties && createSchema.properties.scope && createSchema.properties.scope.enum;
    checkEqual((scopeEnum || []).join(","), "zone,all", "发布入参的 scope 枚举是 zone / all");

    //#endregion
  } finally {
    if (server.child.exitCode === null && server.child.signalCode === null) {
      server.child.kill("SIGTERM");
      await sleep(200);
      if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill("SIGKILL");
    }
    try {
      require("node:fs").rmSync(dbPath, { force: true });
    } catch {
      /* 临时文件的清理失败不影响结论 */
    }
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"} 公告按区：#963 —— ${passed} 条通过 / ${failed} 条失败`);
  if (failed > 0) {
    console.log("\n失败项：");
    failures.forEach((item) => console.log(`  - ${item}`));
    process.exitCode = 1;
  }
})();
