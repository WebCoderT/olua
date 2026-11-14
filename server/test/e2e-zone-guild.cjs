#!/usr/bin/env node
/**
 * 帮会带区 e2e（server/test/e2e-zone-guild.cjs，issue #958 / docs/39 §3.5）
 *
 * 盯的不变量：
 * 一、建帮绑区：`guilds.zone_id` 取帮主的角色区，**不接受前端传区**
 * 二、列表只本区：二区的人看不到一区的帮会（同一条表格查询，靠 `WHERE zone_id = ?`）
 * 三、跨区申请 / 审批拒：别的区拿 guildId 来申请 → 50101（不存在，不是 403）
 * 四、名字全局唯一：二区不能再建一个同名帮会（跨区同名会让搜索 / 举报 / 客服无法区分）
 * 五、存量迁移：跨区成员被移出 + 收到系统邮件；帮会区仍按帮主；再启一次不重复处理（幂等）
 *
 * 第五组是本套的主角：那一批「帮会绑区之前进来的别区成员」只会在升级时出现一次，
 * 新库路径永远走不到 —— 只有造一个**去掉 guilds.zone_id 的旧库**才验得到。
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { relaxGuildGate } = require("./lib/guild-gate.cjs");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const ADMIN_REGISTER_CODE = "zone-guild-admin-code";

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
      JWT_SECRET: "e2e-zone-guild-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      ADMIN_REGISTER_CODE,
      WORLD_MAP_IDLE_MS: "0",
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

/** 管理端请求所在的区（#960）：一个 e2e 进程只在一个区里干活，管理端请求统一带它 */
const ADMIN_ZONE = 1;

async function api(baseUrl, method, route, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  // 管理端单区上下文（#960）：控制台前端在请求拦截器里统一带 X-Zone-Id，测试里对等模拟
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
  return body;
}

async function preparePlayer(baseUrl, username, roleName) {
  const reg = await api(baseUrl, "POST", "auth/register", { body: { username, password: "pass1234" } });
  const token = reg.data && reg.data.token;
  const created = await api(baseUrl, "POST", "roles", { token, body: { name: roleName, occupation: "1", sex: "1" } });
  return { token, roleId: created.data && created.data.id, zoneId: created.data && created.data.zoneId };
}

/** 直接读库（迁移那组要验行级结果，HTTP 看不到「谁被移出了」） */
function withDb(dbPath, work) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    return work(db);
  } finally {
    db.close();
  }
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-zone-guild-${Date.now()}.db`);
  let server = await startServer(dbPath);
  let guildId = "";
  let memberRoleId = "";
  try {
    const { baseUrl } = server;

    //#region 准备：一区 A/B、二区 C

    group("准备：一区 A/B、二区 C");
    const adminReg = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "zone_guild_super", password: "super-pass-1", registerCode: ADMIN_REGISTER_CODE },
    });
    const adminToken = adminReg.data && adminReg.data.token;
    const zone2 = await api(baseUrl, "POST", "admin/zones", { token: adminToken, zoneId: ADMIN_ZONE, body: { name: "二区" } });
    const zone2Id = zone2.data && zone2.data.id;
    check(!!zone2Id, "开一个二区", JSON.stringify(zone2.data));

    const A = await preparePlayer(baseUrl, "zg_player_a", "帮甲");
    const B = await preparePlayer(baseUrl, "zg_player_b", "帮乙");
    const C = await preparePlayer(baseUrl, "zg_player_c", "帮丙");
    check(!!(A.roleId && B.roleId && C.roleId), "三个账号都建好在线角色");
    memberRoleId = B.roleId;

    await api(baseUrl, "POST", "zones/select", { token: C.token, body: { zoneId: zone2Id } });
    const cRole = await api(baseUrl, "POST", "roles", { token: C.token, body: { name: "帮丙二区", occupation: "1", sex: "1" } });
    checkEqual(cRole.data && cRole.data.zoneId, zone2Id, "C 在二区建了角色");

    // 建帮门槛（等级 / 绑定元宝）不是这一套要验的，归零
    relaxGuildGate(dbPath);

    //#endregion

    //#region 一、建帮绑区

    group("一、建帮绑区：区取帮主的角色");
    const created = await api(baseUrl, "POST", "guilds", { token: A.token, body: { name: "带区帮" } });
    checkEqual(created.code, 0, "A 在一区建帮成功", created.message);
    guildId = created.data && created.data.id;
    checkEqual(created.data && created.data.zoneId, 1, "返回的帮会 zoneId = 1（建帮人的角色区）");
    checkEqual(
      withDb(dbPath, (db) => db.prepare("SELECT zone_id FROM guilds WHERE id = ?").get(guildId).zone_id),
      1,
      "库里 guilds.zone_id = 1（不是默认值巧合 —— 二区才是默认测试路径）",
    );

    // 同一区的人申请入帮 → 正常
    const applyB = await api(baseUrl, "POST", `guilds/${guildId}/applications`, { token: B.token, body: { message: "同区" } });
    checkEqual(applyB.code, 0, "同区的 B 申请入帮成功", applyB.message);
    const approved = await api(baseUrl, "POST", `guilds/me/applications/${B.roleId}/review`, {
      token: A.token,
      body: { approve: true },
    });
    checkEqual(approved.code, 0, "A 通过 B 的申请", approved.message);
    checkEqual(approved.data && approved.data.memberCount, 2, "帮会现在 2 人");

    //#endregion

    //#region 二、列表只本区

    group("二、列表只本区");
    const listA = await api(baseUrl, "GET", "guilds", { token: A.token });
    check(
      Array.isArray(listA.data) && listA.data.some((guild) => guild.id === guildId),
      "一区的 A 在列表里看到「带区帮」",
      JSON.stringify(listA.data && listA.data.map((guild) => guild.name)),
    );
    check(
      Array.isArray(listA.data) && listA.data.every((guild) => guild.zoneId === 1),
      "一区列表里每一行都是 1 区的帮会",
    );
    const listC = await api(baseUrl, "GET", "guilds", { token: C.token });
    check(
      Array.isArray(listC.data) && !listC.data.some((guild) => guild.id === guildId),
      "二区的 C 在列表里看不到「带区帮」",
      JSON.stringify(listC.data && listC.data.map((guild) => guild.name)),
    );

    //#endregion

    //#region 三、跨区申请 / 重名

    group("三、跨区申请拒、名字全局唯一");
    const crossApply = await api(baseUrl, "POST", `guilds/${guildId}/applications`, {
      token: C.token,
      body: { message: "我是二区的" },
    });
    checkEqual(crossApply.code, 50101, "二区的 C 拿一区 guildId 申请 → 50101（不存在，不是 403）", crossApply.message);

    const sameName = await api(baseUrl, "POST", "guilds", { token: C.token, body: { name: "带区帮" } });
    checkEqual(sameName.code, 50102, "二区再建一个同名帮会 → 50102（名字全局唯一）", sameName.message);

    //#endregion

    //#region 四、存量迁移：跨区成员被移出 + 邮件

    group("四、存量迁移：跨区成员被移出并发邮件");
    // 造出「帮会绑区之前」的样子：B 的角色被标成 2 区（历史遗留的跨区成员），
    // 再把 guilds.zone_id 整列去掉 —— 迁移只在**没有这一列**时跑，新库永远走不到。
    withDb(dbPath, (db) => {
      db.prepare("UPDATE roles SET zone_id = 2 WHERE id = ?").run(B.roleId);
      db.exec("ALTER TABLE guilds DROP COLUMN zone_id");
      const columns = db.prepare("PRAGMA table_info(guilds)").all().map((row) => row.name);
      if (columns.includes("zone_id")) throw new Error("DROP COLUMN 没生效，这套 e2e 的前置不成立");
    });
    check(true, "已把乙的角色改成 2 区，并去掉 guilds.zone_id（模拟旧库）");

    server.child.kill();
    await sleep(400);
    server = await startServer(dbPath);
    check(true, "旧库升级启动成功（迁移没有炸）");

    const state = withDb(dbPath, (db) => ({
      guildZone: db.prepare("SELECT zone_id FROM guilds WHERE id = ?").get(guildId).zone_id,
      members: db.prepare("SELECT role_id FROM guild_members WHERE guild_id = ?").all(guildId).map((row) => row.role_id),
      mails: db
        .prepare("SELECT role_id, kind, title FROM role_mails WHERE role_id = ? ORDER BY created_at ASC")
        .all(B.roleId),
    }));
    checkEqual(state.guildZone, 1, "帮会区按**帮主**回填成 1（不是按成员）");
    check(!state.members.includes(B.roleId), "跨区的乙被移出帮会", JSON.stringify(state.members));
    check(state.members.includes(A.roleId), "同区的帮主仍在帮里");
    checkEqual(state.mails.length, 1, "乙收到一封系统邮件");
    checkEqual(state.mails[0] && state.mails[0].kind, "guild_zone_reset", "邮件 kind = guild_zone_reset");
    check(
      !!(state.mails[0] && String(state.mails[0].title).includes("帮会")),
      "邮件标题是人话（玩家得知道自己为什么被移出）",
      state.mails[0] && state.mails[0].title,
    );

    //#endregion

    //#region 五、幂等

    group("五、再启一次：迁移不再重复处理");
    server.child.kill();
    await sleep(400);
    server = await startServer(dbPath);
    const again = withDb(dbPath, (db) => ({
      members: db.prepare("SELECT role_id FROM guild_members WHERE guild_id = ?").all(guildId).map((row) => row.role_id),
      mailCount: db.prepare("SELECT COUNT(1) AS total FROM role_mails WHERE role_id = ?").get(B.roleId).total,
    }));
    check(!again.members.includes(B.roleId), "乙仍然不在帮里（没有复活）");
    checkEqual(again.mailCount, 1, "邮件没有重复发（迁移只跑一次）");

    //#endregion
  } finally {
    server.child.kill();
  }

  if (failed > 0) {
    console.log(`\n❌ 帮会带区 e2e：${failed} 条失败`);
    for (const item of failures) console.log(`   - ${item}`);
    process.exitCode = 1;
  } else {
    console.log(`\n✅ 帮会带区 e2e：${passed} 条全绿`);
  }
})();
