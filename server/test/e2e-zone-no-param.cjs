#!/usr/bin/env node
/**
 * 玩家侧零区参数 e2e（server/test/e2e-zone-no-param.cjs，issue #957 / docs/39 §2.4 规则 1）
 *
 * 盯的不变量：**区只能由服务端推导，客户端传了也不读**。
 *
 * 做法是「同一请求打两遍，一次带 `?zoneId=<别区>`」—— 两条响应必须**逐字节相同**。
 * 这比「传了别区就报错」更严：报错还能说明代码里读了这个参数，而这里要的是
 * 「代码里根本没有这个读点」。
 *
 * 覆盖：角色列表 / 在线角色 / 角色详情 / 存进度 / 我的区服 / 帮会列表（#958）/ 排行榜（#959），
 * 外加一条反证 —— 拿别区角色 id 去打，即使 `?zoneId=` 指的正是那个区，也还是 20002（不认参数）。
 *
 * 与 e2e-zone 同款：临时文件库 + 独立端口。
 */
const { spawn } = require("child_process");
const net = require("net");
const os = require("os");
const path = require("path");
const { relaxGuildGate } = require("./lib/guild-gate.cjs");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

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

/** 带参 / 不带参两次响应必须一模一样 */
function checkSame(label, plain, withParam) {
  const a = JSON.stringify(plain && plain.data);
  const b = JSON.stringify(withParam && withParam.data);
  return check(a === b, label, a === b ? `${a && a.length} 字节` : `不带=${a} / 带=${b}`);
}

function group(label) {
  console.log(`\n▶ ${label}`);
}

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
      JWT_SECRET: "e2e-zone-no-param-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      ADMIN_REGISTER_CODE: "zone-no-param-admin-code",
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

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-zone-no-param-${Date.now()}.db`);
  const server = await startServer(dbPath);
  try {
    const { baseUrl } = server;

    //#region 准备：两个账号，两个区，各有一个同名角色

    group("准备：一区两个角色 / 二区一个同名角色");
    const regA = await api(baseUrl, "POST", "auth/register", { body: { username: "no_param_a", password: "pass1234" } });
    const tokenA = regA.data && regA.data.token;
    const roleA1 = await api(baseUrl, "POST", "roles", { token: tokenA, body: { name: "影子", occupation: "1", sex: "1" } });
    const roleA2 = await api(baseUrl, "POST", "roles", { token: tokenA, body: { name: "本体", occupation: "2", sex: "2" } });
    const zone1RoleId = roleA1.data && roleA1.data.id;
    check(!!zone1RoleId && !!(roleA2.data && roleA2.data.id), "一区账号 A 建了 2 个角色");

    const adminReg = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "no_param_super", password: "super-pass-1", registerCode: "zone-no-param-admin-code" },
    });
    const adminToken = adminReg.data && adminReg.data.token;
    const zone2 = await api(baseUrl, "POST", "admin/zones", { token: adminToken, body: { name: "二区" } });
    const zone2Id = zone2.data && zone2.data.id;

    const regB = await api(baseUrl, "POST", "auth/register", { body: { username: "no_param_b", password: "pass1234" } });
    const tokenB = regB.data && regB.data.token;
    await api(baseUrl, "POST", "zones/select", { token: tokenB, body: { zoneId: zone2Id } });
    // 同名 + 同职业：「按参数查」和「忽略参数」在这里才分得开 —— 若哪天真读了 ?zoneId，
    // 一区的账号 A 会拿到二区这个「影子」或者凭空多出一个条目
    const roleB = await api(baseUrl, "POST", "roles", { token: tokenB, body: { name: "影子", occupation: "1", sex: "1" } });
    const zone2RoleId = roleB.data && roleB.data.id;
    check(!!zone2RoleId && zone2RoleId !== zone1RoleId, "二区账号 B 建了同名角色「影子」（跨区同名允许）", zone2RoleId);

    // 帮会列表也要有内容，否则「带不带参数」两边都是空数组，断言等于没测（#958）
    relaxGuildGate(dbPath);
    const guildA = await api(baseUrl, "POST", "guilds", { token: tokenA, body: { name: "一区帮" } });
    const guildB = await api(baseUrl, "POST", "guilds", { token: tokenB, body: { name: "二区帮" } });
    check(!!(guildA.data && guildA.data.id) && !!(guildB.data && guildB.data.id), "两个区各建一个帮会");

    //#endregion

    //#region 一、读接口：带与不带逐字节相同

    group("一、读接口带 ?zoneId=<别区> 与不带完全一致");
    checkSame(
      "GET /roles?zoneId=<二区> 与不带一致",
      await api(baseUrl, "GET", "roles", { token: tokenA }),
      await api(baseUrl, "GET", `roles?zoneId=${zone2Id}`, { token: tokenA }),
    );
    checkSame(
      "GET /roles/online?zoneId=<二区> 与不带一致",
      await api(baseUrl, "GET", "roles/online", { token: tokenA }),
      await api(baseUrl, "GET", `roles/online?zoneId=${zone2Id}`, { token: tokenA }),
    );
    checkSame(
      "GET /zones/mine?zoneId=<二区> 与不带一致",
      await api(baseUrl, "GET", "zones/mine", { token: tokenA }),
      await api(baseUrl, "GET", `zones/mine?zoneId=${zone2Id}`, { token: tokenA }),
    );
    checkSame(
      "GET /guilds?zoneId=<二区> 与不带一致",
      await api(baseUrl, "GET", "guilds", { token: tokenA }),
      await api(baseUrl, "GET", `guilds?zoneId=${zone2Id}`, { token: tokenA }),
    );
    const guildListA = await api(baseUrl, "GET", `guilds?zoneId=${zone2Id}`, { token: tokenA });
    check(
      Array.isArray(guildListA.data) && guildListA.data.length === 1 && guildListA.data[0].name === "一区帮",
      "带 ?zoneId=<二区> 拿到的仍是**一区**的帮会列表（参数不读，只在服务端推导的区里查）",
      JSON.stringify(guildListA.data && guildListA.data.map((guild) => guild.name)),
    );
    checkSame(
      "GET /leaderboards/level?zoneId=<二区> 与不带一致",
      await api(baseUrl, "GET", "leaderboards/level", { token: tokenA }),
      await api(baseUrl, "GET", `leaderboards/level?zoneId=${zone2Id}`, { token: tokenA }),
    );
    const boardA = await api(baseUrl, "GET", `leaderboards/level?zoneId=${zone2Id}`, { token: tokenA });
    const boardRoleIds = new Set(
      (boardA.data && boardA.data.list ? boardA.data.list : []).map((entry) => entry.roleId),
    );
    check(
      boardA.data && boardA.data.total === 2 && boardRoleIds.has(zone1RoleId) && !boardRoleIds.has(zone2RoleId),
      "带 ?zoneId=<二区> 拿到的仍是**一区**的榜（只有一区那 2 个角色，二区的同名角色不在里面）",
      JSON.stringify([...boardRoleIds]),
    );
    checkSame(
      "GET /roles/:id?zoneId=<二区> 与不带一致",
      await api(baseUrl, "GET", `roles/${zone1RoleId}`, { token: tokenA }),
      await api(baseUrl, "GET", `roles/${zone1RoleId}?zoneId=${zone2Id}`, { token: tokenA }),
    );

    //#endregion

    //#region 二、写接口：参数同样不读

    group("二、写接口：?zoneId= 不改变落点");
    const detail = await api(baseUrl, "GET", `roles/${zone1RoleId}`, { token: tokenA });
    const saved = await api(baseUrl, "PUT", `roles/${zone1RoleId}?zoneId=${zone2Id}`, {
      token: tokenA,
      body: { data: detail.data.data, revision: detail.data.revision },
    });
    checkEqual(saved.data && saved.data.id, zone1RoleId, "带 ?zoneId=<二区> 存进度，写的仍是本区那个角色");
    checkEqual(saved.data && saved.data.zoneId, 1, "存完 zoneId 没被参数改成二区");

    const created = await api(baseUrl, "POST", "roles", {
      token: tokenA,
      body: { name: "带参建角", occupation: "1", sex: "1", zoneId: zone2Id },
    });
    check(!!(created.data && created.data.id), "请求体里塞 zoneId 也能建角（白名单把它剥掉，不是 400）", created.message);
    checkEqual(created.data && created.data.zoneId, 1, "建角落在当前浏览区（body 里的 zoneId 被忽略）");

    //#endregion

    //#region 三、反证：参数指的正是别区，也照样「不存在」

    group("三、反证：?zoneId= 指向目标所在区，跨区访问仍然 20002");
    const crossWithParam = await api(baseUrl, "GET", `roles/${zone2RoleId}?zoneId=${zone2Id}`, { token: tokenA });
    checkEqual(crossWithParam.code, 20002, "带 ?zoneId=<二区> 取二区角色 → 仍是 ROLE_NOT_FOUND", crossWithParam.message);
    const crossSaveWithParam = await api(baseUrl, "PUT", `roles/${zone2RoleId}?zoneId=${zone2Id}`, {
      token: tokenA,
      body: { data: detail.data.data, revision: 0 },
    });
    checkEqual(crossSaveWithParam.code, 20002, "带 ?zoneId=<二区> 存二区角色 → 仍是 ROLE_NOT_FOUND", crossSaveWithParam.message);

    //#endregion
  } finally {
    server.child.kill();
  }

  if (failed > 0) {
    console.log(`\n❌ 零区参数 e2e：${failed} 条失败`);
    for (const item of failures) console.log(`   - ${item}`);
    process.exitCode = 1;
  } else {
    console.log(`\n✅ 零区参数 e2e 全绿（${passed} 条断言）`);
  }
})();
