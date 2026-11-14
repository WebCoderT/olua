#!/usr/bin/env node
/**
 * 管理端单区上下文 e2e（server/test/e2e-admin-zone-context.cjs，issue #960 / docs/39 §3.8）
 *
 * 盯的不变量（管理端从「全区一把梭」收成「一次只在一个区里干活」之后必须全绿）：
 * 一、必填：受控接口不带 `X-Zone-Id` / 头里区不存在 / 头里区已合并 → 400 `ZONE_REQUIRED(50029)`
 * 二、按区过滤：A 区的角色列表、账号列表、账号详情只含 A 区的东西，B 区的进不来
 * 三、跨区写要 404：拿着 A 区的头去改 B 区的角色 —— 不是 403（那会泄露「这个 id 存在」）
 * 四、能切：同一个管理员换个头就换区，不需要重新登录，也不受「上次选的区」限制
 * 五、账号级操作不按区：删号 / 封禁仍在账号上（全区生效），但 `purgeRoles` 只清当前区
 * 六、白名单接口不带 `X-Zone-Id` 仍然 200（配置 / 管理员 / 区目录 / 审计）
 * 七、登录页的选区：`POST /admin/auth/login` 必带 `zoneId`；`GET /admin/auth/zones` 免登录可读。
 *     口令错时**先回 401** —— 区校验排在凭证之后，否则不知道密码的人也能拿响应差异探区 id
 * 八、审计行带区：在哪个区里点的就记哪个区，`?zoneId=` 能筛
 *
 * 为什么单独一条：`e2e-zone-*` 那些验的是**玩家侧**的区分片（聊天 / 帮会 / 榜 / 组队）；
 * 管理端是另一扇门 —— 它本来就能看所有区，错法不是「越权」，而是**上下文串了**
 * （A 区页面上点了个按钮，改到了 B 区）。这种错在别的套件里一条也照不出来。
 *
 * 走的是 `dist/`，所以前置是 `npm run build`。用法：`npm run test:e2e:admin-zone-context`
 */
const { spawn } = require("child_process");
const net = require("net");
const os = require("os");
const path = require("path");
const fs = require("fs");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/** 管理端注册邀请码 */
const ADMIN_CODE = "e2e-admin-zone-context";
/** 不能带默认区：这一套的全部断言都在「带 / 不带 / 带错」这个维度上 */
const NO_ZONE = undefined;

//#region 断言小工具（与 e2e-zone-leaderboard / e2e-zone-chat 同款口径）

const failures = [];
let passed = 0;
let failed = 0;

function check(ok, label, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  [OK] ${label}${detail ? " —— " + detail : ""}`);
    return true;
  }
  failed += 1;
  failures.push(label);
  console.log(`  [!!] ${label}${detail ? " —— " + detail : ""}`);
  return false;
}

function checkEqual(actual, expected, label) {
  return check(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}

function group(label) {
  console.log(`\n▶ ${label}`);
}

//#endregion

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      JWT_SECRET: "e2e-admin-zone-context-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      ADMIN_REGISTER_CODE: ADMIN_CODE,
      LEADERBOARD_REFRESH_MS: "0",
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

/** 管理端请求默认所在的区（#960）：本套的数据都建在 1 区，个别调用自己覆盖 */
const ADMIN_ZONE = 1;

/** 发一次请求，返回 { status, body }（唯一包裹体：code / message / data） */
async function api(baseUrl, method, route, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  // 不传 zoneId = 请求上**没有** X-Zone-Id（这套要专门验缺失的情形，不能给默认值）
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

/** 注册一个玩家账号（注册只建账号，不选区） */
async function registerAccount(baseUrl, username) {
  const registered = await api(baseUrl, "POST", "auth/register", { body: { username, password: "pass1234" } });
  const token = registered.body?.data?.token;
  if (!token) throw new Error(`注册失败 ${username}：${registered.body && registered.body.message}`);
  return token;
}

/** 在指定区建一个角色（先 `zones/select` 换区，再建角 —— 建角继承当前区，不选） */
async function createRole(baseUrl, token, roleName, zoneId) {
  if (zoneId !== undefined) {
    const selected = await api(baseUrl, "POST", "zones/select", { token, body: { zoneId } });
    if (!selected.body || selected.body.code !== 0) {
      throw new Error(`切区失败 ${roleName} → ${zoneId}：${selected.body && selected.body.message}`);
    }
  }
  const created = await api(baseUrl, "POST", "roles", { token, body: { name: roleName, occupation: "1", sex: "1" } });
  const role = created.body?.data;
  if (!role) throw new Error(`建角失败 ${roleName}：${created.body && created.body.message}`);
  return { roleId: role.id, zoneId: role.zoneId, name: roleName };
}

const namesOf = (page) => (page ? page.list.map((entry) => entry.name).join(",") : "");
const usernamesOf = (page) => (page ? page.list.map((entry) => entry.username).join(",") : "");

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "olua-admin-zone-"));
  const dbPath = path.join(dir, "world.db");
  let server;

  try {
    server = await startServer(dbPath);
    const { baseUrl } = server;

    //#region 准备

    group("准备：开二区，一个账号在一区建「甲」、在二区建「乙」，再开一个待合并的三区");

    const registered = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "zone_ctx_admin", password: "Admin#1234", registerCode: ADMIN_CODE },
    });
    checkEqual(registered.body?.code, 0, "管理员注册成功（注册不需要区）");

    const loginNoZone = await api(baseUrl, "POST", "admin/auth/login", {
      body: { username: "zone_ctx_admin", password: "Admin#1234" },
    });
    checkEqual(loginNoZone.status, 400, "登录不带 zoneId 是 400（管理端一次只在一个区里干活）");
    checkEqual(loginNoZone.body?.code, 50029, "登录不带 zoneId 的码是 ZONE_REQUIRED(50029)");

    const loginBadZone = await api(baseUrl, "POST", "admin/auth/login", {
      body: { username: "zone_ctx_admin", password: "Admin#1234", zoneId: 9999 },
    });
    checkEqual(loginBadZone.body?.code, 50029, "登录选了不存在的区也是 50029");

    const wrongPwdBadZone = await api(baseUrl, "POST", "admin/auth/login", {
      body: { username: "zone_ctx_admin", password: "wrong-pass", zoneId: 9999 },
    });
    checkEqual(
      wrongPwdBadZone.status,
      401,
      "口令错时先回 401（区校验排在凭证之后，不然不知道密码的人也能探区 id）",
    );

    const login = await api(baseUrl, "POST", "admin/auth/login", {
      body: { username: "zone_ctx_admin", password: "Admin#1234", zoneId: 1 },
    });
    const adminToken = login.body?.data?.token;
    check(!!adminToken, "带 zoneId=1 登录成功");
    checkEqual(login.body?.data?.admin?.lastZoneId, 1, "登录回结果里记住上次选区（换浏览器也回到同一个区）");

    const zoneOptions = await api(baseUrl, "GET", "admin/auth/zones", {});
    checkEqual(zoneOptions.status, 200, "GET /admin/auth/zones 免登录可读（登录页下拉要用）");
    const firstOption = (zoneOptions.body?.data ?? [])[0];
    check(!!firstOption && typeof firstOption.name === "string", "区选项带名字", JSON.stringify(firstOption));

    const zone2 = await api(baseUrl, "POST", "admin/zones", { token: adminToken, zoneId: ADMIN_ZONE, body: { name: "二区" } });
    const zone2Id = zone2.body?.data?.id;
    const zone3 = await api(baseUrl, "POST", "admin/zones", { token: adminToken, zoneId: ADMIN_ZONE, body: { name: "三区" } });
    const zone3Id = zone3.body?.data?.id;
    check(!!zone2Id && !!zone3Id, "开二区、三区（区目录本身就是全区的，不需要 X-Zone-Id）", `${zone2Id}/${zone3Id}`);

    // 同一个账号在两区各建一个角（跨区账号 = 账号详情要折叠的那种）
    const multiToken = await registerAccount(baseUrl, "zone_ctx_multi");
    const a = await createRole(baseUrl, multiToken, "甲");
    const b = await createRole(baseUrl, multiToken, "乙", zone2Id);
    const otherToken = await registerAccount(baseUrl, "zone_ctx_other");
    const other = await createRole(baseUrl, otherToken, "丙", zone2Id);
    checkEqual(a.zoneId, 1, "甲在一区");
    checkEqual(b.zoneId, zone2Id, "乙在二区（同一个账号）");
    checkEqual(other.zoneId, zone2Id, "丙在二区（另一个账号，用来验列表不含别区账号）");

    //#endregion

    //#region 一、必填

    group("一、受控接口不带 X-Zone-Id / 头无效 / 区已合并 → 400 50029");

    for (const route of ["admin/accounts", "admin/roles", "admin/stats", "admin/guilds", "admin/reports"]) {
      const missing = await api(baseUrl, "GET", route, { token: adminToken, zoneId: NO_ZONE });
      checkEqual(missing.status, 400, `${route} 不带 X-Zone-Id 是 400`);
      checkEqual(missing.body?.code, 50029, `${route} 不带 X-Zone-Id 的码是 50029`);
    }

    for (const route of ["admin/roles", "admin/guilds"]) {
      const bad = await api(baseUrl, "GET", route, { token: adminToken, zoneId: 9999 });
      checkEqual(bad.status, 400, `${route} 头里区不存在是 400`);
      checkEqual(bad.body?.code, 50029, `${route} 头里区不存在的码是 50029`);
    }

    const merged = await api(baseUrl, "POST", "admin/zones/merge", {
      token: adminToken, zoneId: ADMIN_ZONE,
      body: { fromZoneId: zone3Id, toZoneId: zone2Id },
    });
    checkEqual(merged.body?.code, 0, "把三区并入二区");
    const onMerged = await api(baseUrl, "GET", "admin/roles", { token: adminToken, zoneId: zone3Id });
    checkEqual(onMerged.status, 400, "头指向已合并的区是 400（数据已经搬走了，在它下面看什么都是空的）");
    checkEqual(onMerged.body?.code, 50029, "已合并区的码也是 50029");

    const optionsAfterMerge = await api(baseUrl, "GET", "admin/auth/zones", {});
    check(
      !(optionsAfterMerge.body?.data ?? []).some((zone) => zone.id === zone3Id),
      "登录页下拉不再出现已合并的区",
    );

    //#endregion

    //#region 二、按区过滤

    group("二、A 区只看得到 A 区的东西（列表 / 账号详情 / 分布）");

    const roles1 = await api(baseUrl, "GET", "admin/roles?size=50", { token: adminToken, zoneId: 1 });
    checkEqual(namesOf(roles1.body?.data), "甲", "一区角色列表只有甲");

    const roles2 = await api(baseUrl, "GET", "admin/roles?size=50", { token: adminToken, zoneId: zone2Id });
    checkEqual((roles2.body?.data?.list ?? []).map((row) => row.name).sort().join(","), "丙,乙", "二区角色列表是乙和丙（不含一区的甲）");

    const accounts1 = await api(baseUrl, "GET", "admin/accounts?size=50", { token: adminToken, zoneId: 1 });
    checkEqual(usernamesOf(accounts1.body?.data), "zone_ctx_multi", "一区账号列表只有在本区有角色的那个账号");
    check(
      !(accounts1.body?.data?.list ?? []).some((row) => row.username === "zone_ctx_other"),
      "只在二区建过角的账号不出现在一区列表里",
    );

    const accounts2 = await api(baseUrl, "GET", "admin/accounts?size=50", { token: adminToken, zoneId: zone2Id });
    checkEqual(
      (accounts2.body?.data?.list ?? []).map((row) => row.username).sort().join(","),
      "zone_ctx_multi,zone_ctx_other",
      "二区账号列表是这两个（同一个账号在两区都建过角，按本区算）",
    );

    const multiId = (accounts1.body?.data?.list ?? []).find((row) => row.username === "zone_ctx_multi")?.id;
    check(!!multiId, "取到跨区账号的 id", String(multiId));

    const detail1 = await api(baseUrl, "GET", `admin/accounts/${multiId}`, { token: adminToken, zoneId: 1 });
    checkEqual(
      (detail1.body?.data?.roles ?? []).map((row) => row.name).join(","),
      "甲",
      "一区的账号详情只列本区角色",
    );
    checkEqual(detail1.body?.data?.otherZoneCount, 1, "并告诉界面「另在 1 个区还有角色」（点切换再展开）");

    const detail2 = await api(baseUrl, "GET", `admin/accounts/${multiId}`, { token: adminToken, zoneId: zone2Id });
    checkEqual(
      (detail2.body?.data?.roles ?? []).map((row) => row.name).join(","),
      "乙",
      "切到二区后同一个账号的详情变成乙",
    );
    checkEqual(detail2.body?.data?.otherZoneCount, 1, "二区看它也是「另在 1 个区还有角色」");

    const breakdown1 = await api(baseUrl, "GET", "admin/stats/breakdown", { token: adminToken, zoneId: 1 });
    checkEqual(breakdown1.body?.code, 0, "分布统计在区上下文里正常返回（形状不变，只是范围是本区）");
    const breakdownData = breakdown1.body?.data ?? {};
    check(
      ["levels", "occupations", "sexes", "maps"].every((key) => Array.isArray(breakdownData[key])),
      "分布统计仍带四组分布（levels / occupations / sexes / maps）",
    );

    //#endregion

    //#region 三、跨区写要 404

    group("三、拿着 A 区的头去动 B 区的东西 —— 404，不是 403");

    const crossPatch = await api(baseUrl, "PATCH", `admin/roles/${b.roleId}`, {
      token: adminToken, zoneId: ADMIN_ZONE,
      zoneId: 1,
      body: { level: 5 },
    });
    checkEqual(crossPatch.status, 404, "一区头改二区角色是 404");
    checkEqual(crossPatch.body?.data, null, "失败时 data 恒为 null");

    const stillThere = await api(baseUrl, "GET", `admin/roles/${b.roleId}`, { token: adminToken, zoneId: zone2Id });
    checkEqual(stillThere.body?.data?.level, 1, "乙的等级没被改（跨区写确实没生效）");

    const rightZone = await api(baseUrl, "PATCH", `admin/roles/${b.roleId}`, {
      token: adminToken, zoneId: ADMIN_ZONE,
      zoneId: zone2Id,
      body: { level: 5 },
    });
    checkEqual(rightZone.body?.code, 0, "换到二区的头，同一个 PATCH 就成功了");
    checkEqual(rightZone.body?.data?.level, 5, "这次真的改了乙");

    const crossGuild = await api(baseUrl, "DELETE", "admin/guilds/nope", { token: adminToken, zoneId: 1 });
    checkEqual(crossGuild.status, 404, "别区 / 不存在的帮会一律 404（同一套归属判据）");

    //#endregion

    //#region 四、能切

    group("四、同一个管理员换个头就换区（不需要重新登录）");

    const again1 = await api(baseUrl, "GET", "admin/roles?size=50", { token: adminToken, zoneId: 1 });
    checkEqual(namesOf(again1.body?.data), "甲", "又切回一区，看到的还是一区");
    const again2 = await api(baseUrl, "GET", "admin/roles?size=50", { token: adminToken, zoneId: zone2Id });
    checkEqual(namesOf(again2.body?.data), "乙,丙", "再切到二区，看到的是二区（同一个令牌，没有重登）");

    // 管理员没有「新建」接口（注册走 auth/register），降级到 viewer 走 admins/:id
    const viewerReg = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "zone_ctx_viewer", password: "Viewer#1234", registerCode: ADMIN_CODE },
    });
    checkEqual(viewerReg.body?.code, 0, "造一个只读观察员（注册）");
    const viewerId = viewerReg.body?.data?.admin?.id;
    const demoted = await api(baseUrl, "PATCH", `admin/admins/${viewerId}`, {
      token: adminToken, zoneId: ADMIN_ZONE,
      body: { role: "viewer" },
    });
    checkEqual(demoted.body?.code, 0, "降级成 viewer");
    const viewerLogin = await api(baseUrl, "POST", "admin/auth/login", {
      body: { zoneId: ADMIN_ZONE, username: "zone_ctx_viewer", password: "Viewer#1234", zoneId: zone2Id },
    });
    const viewerToken = viewerLogin.body?.data?.token;
    checkEqual(viewerLogin.body?.code, 0, "观察员登录时选二区");
    const viewerRead = await api(baseUrl, "GET", "admin/roles?size=50", { token: viewerToken, zoneId: 1 });
    checkEqual(viewerRead.status, 200, "观察员照样能看一区（口径：不绑区，区不是权限）");
    checkEqual(namesOf(viewerRead.body?.data), "甲", "看到的就是一区的内容");

    //#endregion

    //#region 五、账号级操作不按区

    group("五、账号级操作仍在账号上，但清空角色只清当前区");

    const banned = await api(baseUrl, "PATCH", `admin/accounts/${multiId}/status`, {
      token: adminToken, zoneId: ADMIN_ZONE,
      zoneId: 1,
      body: { status: "disabled", reason: "e2e" },
    });
    checkEqual(banned.body?.code, 0, "封禁不需要区也照样成功（账号级，与当前区无关）");
    checkEqual(banned.body?.data?.status, "disabled", "账号变成 disabled（封禁）");
    const unban = await api(baseUrl, "PATCH", `admin/accounts/${multiId}/status`, {
      token: adminToken, zoneId: ADMIN_ZONE,
      zoneId: 1,
      body: { status: "active" },
    });
    checkEqual(unban.body?.data?.status, "active", "解封回 active（继续后面的步骤）");

    const purged = await api(baseUrl, "DELETE", `admin/accounts/${multiId}/roles`, { token: adminToken, zoneId: 1 });
    checkEqual(purged.body?.code, 0, "一区头清空角色成功");
    checkEqual(purged.body?.data?.deleted, 1, "只删了 1 个角色（一区的甲）");
    const leftInZone2 = await api(baseUrl, "GET", "admin/roles?size=50&accountId=" + multiId, {
      token: adminToken, zoneId: ADMIN_ZONE,
      zoneId: zone2Id,
    });
    checkEqual(namesOf(leftInZone2.body?.data), "乙", "二区的乙还在（一次误点不该毁掉所有区的存档）");

    //#endregion

    //#region 六、白名单

    group("六、白名单接口不带 X-Zone-Id 仍然 200");

    const whitelist = [
      ["admin/zones", "区目录"],
      ["admin/admins", "管理员"],
      ["admin/audit-logs", "操作日志（刻意跨区）"],
      ["admin/event-logs", "玩家流水（全服排查视图）"],
      ["admin/items", "游戏配置"],
      ["admin/maps", "地图配置"],
    ];
    for (const [route, label] of whitelist) {
      const response = await api(baseUrl, "GET", route, { token: adminToken, zoneId: NO_ZONE });
      checkEqual(response.status, 200, `${label}（${route}）不带 X-Zone-Id 仍 200`);
    }

    //#endregion

    //#region 七、审计带区

    group("七、审计行记「在哪个区里点的」，且能按区筛");

    const auditAll = await api(baseUrl, "GET", "admin/audit-logs?size=50", { token: adminToken, zoneId: NO_ZONE });
    const auditRows = auditAll.body?.data?.list ?? [];
    check(auditRows.length > 0, "审计列表能读到行（不带 X-Zone-Id 也行，它刻意跨区）");
    const zoneRow = auditRows.find((row) => row.zoneId === zone2Id);
    check(!!zoneRow, "有一条审计记的是二区（刚才在二区改过乙的等级）", String(zoneRow && zoneRow.action));

    const auditZone2 = await api(baseUrl, "GET", `admin/audit-logs?size=50&zoneId=${zone2Id}`, {
      token: adminToken, zoneId: ADMIN_ZONE,
      zoneId: NO_ZONE,
    });
    const zone2Rows = auditZone2.body?.data?.list ?? [];
    check(zone2Rows.length > 0, "按 zoneId 筛能筛出二区的行");
    check(
      zone2Rows.every((row) => row.zoneId === zone2Id),
      "筛出来的每一行都属于二区（没有别区混进来）",
    );

    const auditZone1 = await api(baseUrl, "GET", "admin/audit-logs?size=50&zoneId=1", {
      token: adminToken, zoneId: ADMIN_ZONE,
      zoneId: NO_ZONE,
    });
    check(
      !(auditZone1.body?.data?.list ?? []).some((row) => row.id === (zoneRow && zoneRow.id)),
      "二区那条不会出现在一区的筛选结果里",
    );

    //#endregion
  } catch (error) {
    failed += 1;
    failures.push("运行期异常");
    console.error(`\n[!!] 运行期异常：${error && error.stack ? error.stack : error}`);
    if (server) console.error(server.logs());
  } finally {
    if (server) server.child.kill("SIGTERM");
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log("");
  if (failed === 0) {
    console.log(`✅ 管理端单区上下文 e2e 全绿（${passed} 通过 / 0 失败）`);
    process.exit(0);
  }
  console.log(`❌ 管理端单区上下文 e2e：${passed} 通过 / ${failed} 失败`);
  for (const item of failures) console.log(`   - ${item}`);
  process.exit(1);
})();
