#!/usr/bin/env node
/**
 * 角色带区 e2e（server/test/e2e-zone-roles.cjs，issue #957 / docs/39 §3.1）
 *
 * 盯的不变量（P1 之后必须全绿）：
 * 一、每区 6 个角色位：一区建满 6 个，第 7 个拒（20018）；同名跨区允许、同区重名拒（20005）
 * 二、`GET /roles` 只出**当前浏览区**的角色（账号只是身份，区是角色的属性）
 * 三、跨区角色一律当不存在：拿别区的 roleId 查详情 / 存进度 → 20002（不是 403，不泄露存在性）
 * 四、合区搬角色：同账号两区同名 → 源区那个**系统自动改名**（后缀 = 源区名），
 *     改名清单进合并报告；角色条数不丢、`active_zone_id` 搬到目标区
 *
 * 与 e2e-zone 同款：**临时文件库**（合并区要验库里的行级改写）。
 */
const { spawn } = require("child_process");
const net = require("net");
const os = require("os");
const path = require("path");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

//#region 断言小工具（与 e2e-zone 同款口径）

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
      JWT_SECRET: "e2e-zone-roles-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      ADMIN_REGISTER_CODE: "zone-roles-admin-code",
      WORLD_TICK_MS: "300",
      WORLD_PERSIST_MS: "500",
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

async function api(baseUrl, method, route, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
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
  return body;
}

/** 建角（名字按传入的原样，不做额外处理） */
function createRole(baseUrl, token, name) {
  return api(baseUrl, "POST", "roles", { token, body: { name, occupation: "1", sex: "1" } });
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-zone-roles-${Date.now()}.db`);
  const server = await startServer(dbPath);
  try {
    const { baseUrl } = server;

    //#region 准备

    group("准备：一个账号 / 两个区");
    const reg = await api(baseUrl, "POST", "auth/register", { body: { username: "zone_roles_a", password: "pass1234" } });
    const token = reg.data && reg.data.token;
    check(!!token, "注册成功（注册不再选哪个区）");
    check(
      !!(reg.data && reg.data.account) && !("zoneId" in reg.data.account),
      "注册响应里已经没有 account.zoneId（账号不属于任何区）",
      JSON.stringify(reg.data && reg.data.account),
    );

    const adminReg = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "zone_roles_super", password: "super-pass-1", registerCode: "zone-roles-admin-code" },
    });
    const adminToken = adminReg.data && adminReg.data.token;
    const zone2 = await api(baseUrl, "POST", "admin/zones", { token: adminToken, body: { name: "二区" } });
    const zone2Id = zone2.data && zone2.data.id;
    check(!!zone2Id && zone2Id >= 2, "开新区「二区」成功", JSON.stringify(zone2.data));

    const mine0 = await api(baseUrl, "GET", "zones/mine", { token });
    const mine0List = Array.isArray(mine0.data) ? mine0.data : [];
    checkEqual(mine0List.length, 2, "GET /zones/mine 列出两个活区");
    check(
      mine0List.every((zone) => zone.roleCount === 0),
      "新账号在两区的角色数都是 0",
      JSON.stringify(mine0List),
    );
    checkEqual(mine0List.filter((zone) => zone.current).length, 1, "GET /zones/mine 只有一个 current");

    //#endregion

    //#region 一、每区 6 个角色位

    group("一、角色位按区算：一区 6 个 / 第 7 个拒 / 同名跨区允许");
    const mine1 = await api(baseUrl, "GET", "zones/mine", { token });
    const currentZoneId = (mine1.data || []).find((zone) => zone.current).id;

    const zone1Names = ["角色一", "角色二", "角色三", "角色四", "角色五", "角色六"];
    const zone1Roles = [];
    for (const name of zone1Names) {
      const created = await createRole(baseUrl, token, name);
      zone1Roles.push(created.data && created.data.id);
      check(!!(created.data && created.data.id), `一区建角「${name}」成功`, created.message);
      checkEqual(created.data && created.data.zoneId, currentZoneId, `建角落在当前浏览区（${name}）`);
    }

    const seventh = await createRole(baseUrl, token, "角色七");
    checkEqual(seventh.code, 20018, "一区第 7 个角色被拒（ROLE_LIMIT_EXCEEDED 20018）", seventh.message);

    const dupSameZone = await createRole(baseUrl, token, "角色一");
    checkEqual(dupSameZone.code, 20005, "同区重名被拒（ROLE_NAME_EXISTS 20005）", dupSameZone.message);

    // 切到二区：同一套名字可以再建（区是独立服）
    const select2 = await api(baseUrl, "POST", "zones/select", { token, body: { zoneId: zone2Id } });
    checkEqual(select2.data && select2.data.zoneId, zone2Id, "POST /zones/select 切到二区");

    const mine2 = await api(baseUrl, "GET", "zones/mine", { token });
    const zone2Row = (mine2.data || []).find((zone) => zone.id === zone2Id);
    check(!!zone2Row && zone2Row.current === true, "GET /zones/mine 的 current 跟着切成二区");
    checkEqual(zone2Row && zone2Row.roleCount, 0, "二区角色数仍是 0（角色没有跟着人走）");

    const crossZoneSameName = await createRole(baseUrl, token, "角色一");
    check(
      !!(crossZoneSameName.data && crossZoneSameName.data.id),
      "同名跨区允许（唯一索引是 account + zone + name）",
      crossZoneSameName.message,
    );
    checkEqual(crossZoneSameName.data && crossZoneSameName.data.zoneId, zone2Id, "二区那个同名角色落在二区");
    const zone2RoleId = crossZoneSameName.data && crossZoneSameName.data.id;

    //#endregion

    //#region 二、列表只出当前浏览区

    group("二、GET /roles 只出当前浏览区的角色");
    const listZone2 = await api(baseUrl, "GET", "roles", { token });
    const zone2List = Array.isArray(listZone2.data) ? listZone2.data : [];
    checkEqual(zone2List.length, 1, "当前在二区：列表只有二区那 1 个角色", JSON.stringify(zone2List.map((r) => r.name)));
    check(
      zone2List.every((row) => row.zoneId === zone2Id),
      "列表里每个角色都带 zoneId 且都是二区",
      JSON.stringify(zone2List.map((r) => r.zoneId)),
    );

    await api(baseUrl, "POST", "zones/select", { token, body: { zoneId: currentZoneId } });
    const listZone1 = await api(baseUrl, "GET", "roles", { token });
    const zone1List = Array.isArray(listZone1.data) ? listZone1.data : [];
    checkEqual(zone1List.length, 6, "切回一区：列表是那 6 个角色");
    check(
      zone1List.every((row) => row.zoneId === currentZoneId) && !zone1List.some((row) => row.id === zone2RoleId),
      "二区的角色不在当前列表里（不是把两区拼在一起）",
      JSON.stringify(zone1List.map((r) => r.zoneId)),
    );

    //#endregion

    //#region 三、跨区角色当不存在

    group("三、跨区角色一律当不存在（20002，不是 403）");
    const crossDetail = await api(baseUrl, "GET", `roles/${zone2RoleId}`, { token });
    checkEqual(crossDetail.code, 20002, "拿二区 roleId 在一区查详情 → ROLE_NOT_FOUND（不泄露存在性）", crossDetail.message);

    const crossSave = await api(baseUrl, "PUT", `roles/${zone2RoleId}`, { token, body: { data: {}, revision: 0 } });
    checkEqual(crossSave.code, 20002, "拿二区 roleId 在一区存进度 → ROLE_NOT_FOUND", crossSave.message);

    const selfDetail = await api(baseUrl, "GET", `roles/${zone1Roles[0]}`, { token });
    checkEqual(selfDetail.data && selfDetail.data.id, zone1Roles[0], "本区角色照旧查得到");

    //#endregion

    //#region 四、合区搬角色 + 同名自动改名

    group("四、合区：角色改挂目标区，同账号同名系统自动改名");
    // 再建一个账号，两区各一个同名角色：合区时它才是「撞名」的那个
    const regB = await api(baseUrl, "POST", "auth/register", { body: { username: "zone_roles_b", password: "pass1234" } });
    const tokenB = regB.data && regB.data.token;
    const bZone1 = await createRole(baseUrl, tokenB, "撞名");
    check(!!(bZone1.data && bZone1.data.id), "账号 B 在一区建「撞名」");
    await api(baseUrl, "POST", "zones/select", { token: tokenB, body: { zoneId: zone2Id } });
    const bZone2 = await createRole(baseUrl, tokenB, "撞名");
    check(!!(bZone2.data && bZone2.data.id), "账号 B 在二区建同名「撞名」（跨区允许）");

    const merged = await api(baseUrl, "POST", "admin/zones/merge", { token: adminToken, body: { fromZoneId: zone2Id, toZoneId: currentZoneId } });
    checkEqual(merged.data && merged.data.mergedInto, currentZoneId, "二区并入一区成功");

    const mineAfter = await api(baseUrl, "GET", "zones/mine", { token: tokenB });
    const mineAfterList = Array.isArray(mineAfter.data) ? mineAfter.data : [];
    checkEqual(mineAfterList.length, 1, "合区后活区只剩一个");
    checkEqual(mineAfterList[0] && mineAfterList[0].current, true, "合并区的账号 current 已搬到目标区（active_zone_id 跟着搬）");
    checkEqual(mineAfterList[0] && mineAfterList[0].roleCount, 2, "账号 B 的两个角色都在一区了（每条都搬，不丢）");

    const bRoles = await api(baseUrl, "GET", "roles", { token: tokenB });
    const bNames = (Array.isArray(bRoles.data) ? bRoles.data : []).map((row) => row.name).sort();
    check(bNames.length === 2, "账号 B 合并后仍有 2 个角色", JSON.stringify(bNames));
    check(
      bNames.includes("撞名") && bNames.includes("撞名·二区"),
      "源区那个同名角色被系统改名（原名 + ·源区名），目标区那个保持原名",
      JSON.stringify(bNames),
    );
    check(
      (bRoles.data || []).every((row) => row.zoneId === currentZoneId),
      "搬过来的角色 zoneId 已是目标区",
      JSON.stringify((bRoles.data || []).map((row) => row.zoneId)),
    );

    const aRolesAfter = await api(baseUrl, "GET", "roles", { token });
    const aNamesAfter = (Array.isArray(aRolesAfter.data) ? aRolesAfter.data : []).map((row) => row.name);
    checkEqual(aNamesAfter.length, 7, "账号 A 合并后 7 个角色（一区 6 + 二区 1，同名那个也改名了）");
    check(
      aNamesAfter.filter((name) => name.startsWith("角色一")).length === 2,
      "账号 A 的两个「角色一」一个原名一个带后缀（区名后缀）",
      JSON.stringify(aNamesAfter.filter((name) => name.startsWith("角色一"))),
    );

    //#endregion

    //#region 五、选服边界

    group("五、POST /zones/select 边界");
    const selectMissing = await api(baseUrl, "POST", "zones/select", { token, body: { zoneId: 999 } });
    checkEqual(selectMissing.code, 50025, "选不存在的区被拒（ZONE_NOT_FOUND 50025）", selectMissing.message);
    const selectMerged = await api(baseUrl, "POST", "zones/select", { token, body: { zoneId: zone2Id } });
    checkEqual(selectMerged.code, 50026, "选已合并的区被拒（ZONE_MERGED 50026）", selectMerged.message);

    //#endregion
  } finally {
    server.child.kill();
  }

  if (failed > 0) {
    console.log(`\n❌ 角色带区 e2e：${failed} 条失败`);
    for (const item of failures) console.log(`   - ${item}`);
    process.exitCode = 1;
  } else {
    console.log(`\n✅ 角色带区 e2e 全绿（${passed} 条断言）`);
  }
})();
