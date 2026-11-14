#!/usr/bin/env node
/**
 * 坏档专项 e2e（server/test/e2e-role-corrupted.cjs，issue #819 / B61 / I6）
 *
 * 盯的不变量（改存档解析 / 收权边界 / 选角链路后必须全绿）：
 * 一、坏档拒登：`roles.data` 解析不出来 → 选角返 20029（409）+「联系客服」，
 *     `roles.corrupted=1`，坏 JSON **原样保留**（不删行、不洗成空档）
 * 二、修好即解封：把 data 修成合法 JSON → 下一次选角直接能进，`corrupted` 自动清回 0
 * 三、在线期间变坏档：存档写入也被拒（20029），模拟「管理员改库改坏了」之后的防御
 * 四、缺字段不再采信客户端（#819 的核心回归）：库里没有 `bindGold` 时上报 999999，
 *     落库是空值 0，而不是把客户端那份当唯一来源
 * 五、客户端改绑定元宝仍然被拒（老规矩回归，别为了修坏档把收权改松）
 *
 * 走的是 `dist/`，所以前置是 `npm run build`。
 * 用法：npm run test:e2e:role-corrupted
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const ADMIN_CODE = "e2e-corrupted-admin";
const CURRENT_VERSION = 2;

//#region 断言小工具（与 e2e-quest 同款口径）

let passed = 0;
let failed = 0;
const failures = [];

function group(title) {
  console.log(`\n▶ ${title}`);
}

function check(condition, label, detail = "") {
  if (condition) {
    passed += 1;
    return true;
  }
  failed += 1;
  failures.push(label);
  console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ""}`);
  return false;
}

function checkEqual(actual, expected, label) {
  return check(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
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
      JWT_SECRET: "e2e-corrupted-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      ADMIN_REGISTER_CODE: ADMIN_CODE,
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
  return {
    status: response.status,
    code: body ? body.code : -1,
    message: body ? body.message : "",
    data: body ? body.data : null,
  };
}

//#region 直接开库（造坏档 / 核落库结果）

function withDb(dbPath, run) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function roleRow(dbPath, roleId) {
  return withDb(dbPath, (db) => db.prepare("SELECT id, data, revision, corrupted FROM roles WHERE id = ?").get(roleId));
}

function writeRawData(dbPath, roleId, raw) {
  withDb(dbPath, (db) => db.prepare("UPDATE roles SET data = ? WHERE id = ?").run(raw, roleId));
}

function readData(dbPath, roleId) {
  return JSON.parse(roleRow(dbPath, roleId).data);
}

function writeData(dbPath, roleId, data) {
  writeRawData(dbPath, roleId, JSON.stringify(data));
}

//#endregion

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-corrupted-${Date.now()}.db`);
  let server = null;
  try {
    server = await startServer(dbPath);
    const { baseUrl } = server;

    //#region 准备

    group("准备：玩家 + 管理员");
    const registered = await api(baseUrl, "POST", "auth/register", { body: { username: "corrupt_player", password: "pass1234" } });
    const token = registered.data && registered.data.token;
    const created = await api(baseUrl, "POST", "roles", { token, body: { name: "坏档者", occupation: "1", sex: "1" } });
    const roleId = created.data && created.data.id;
    check(!!token && !!roleId, "准备：账号与角色已创建", created.message);

    await api(baseUrl, "POST", "admin/auth/register", { body: { username: "corrupt_admin", password: "pass1234", registerCode: ADMIN_CODE } });
    const adminLogin = await api(baseUrl, "POST", "admin/auth/login", { body: { zoneId: ADMIN_ZONE, username: "corrupt_admin", password: "pass1234" } });
    const adminToken = adminLogin.data && adminLogin.data.token;
    check(!!adminToken, "准备：管理员已登录（看 corrupted 标记要用它）");

    //#endregion

    //#region 一、坏档拒登

    group("一、坏档拒登并标记 isolated");
    const good = readData(dbPath, roleId);
    const brokenRaw = `{"id":"${roleId}","bindGold":`;
    writeRawData(dbPath, roleId, brokenRaw);
    const rejected = await api(baseUrl, "POST", `roles/${roleId}/select`, { token });
    checkEqual(rejected.code, 20029, "坏档选角被拒（20029）");
    checkEqual(rejected.status, 409, "HTTP 状态是冲突（409）");
    check(rejected.message.includes("联系客服"), "提示文案带「联系客服」", rejected.message);
    const afterReject = roleRow(dbPath, roleId);
    checkEqual(afterReject.corrupted, 1, "库里标了 corrupted=1（可被运维检索）");
    checkEqual(afterReject.data, brokenRaw, "坏 JSON 原样保留（不删行、不洗成空档）");

    const adminView = await api(baseUrl, "GET", `admin/roles/${roleId}`, { token: adminToken, zoneId: ADMIN_ZONE });
    checkEqual(adminView.data && adminView.data.corrupted, true, "管理端详情能看到 corrupted（运维不用查库）");

    const again = await api(baseUrl, "POST", `roles/${roleId}/select`, { token });
    checkEqual(again.code, 20029, "再试一次仍然被拒（不因为标过记就放行）");

    //#endregion

    //#region 二、修好即解封

    group("二、人工修好 JSON 后自动解封");
    writeData(dbPath, roleId, { ...good, schemaVersion: CURRENT_VERSION, bindGold: 321 });
    const repaired = await api(baseUrl, "POST", `roles/${roleId}/select`, { token });
    checkEqual(repaired.code, 0, "修好后能正常进游戏", repaired.message);
    checkEqual(roleRow(dbPath, roleId).corrupted, 0, "corrupted 自动清回 0（不用运维再点一次）");
    checkEqual(readData(dbPath, roleId).bindGold, 321, "修好的内容原样保留");

    //#endregion

    //#region 三、在线期间变坏档：存档写入也被拒

    group("三、在线期间存档变坏 → 写入被拒");
    writeRawData(dbPath, roleId, "{坏掉的档");
    const saveRejected = await api(baseUrl, "PUT", `roles/${roleId}`, {
      token,
      body: { revision: roleRow(dbPath, roleId).revision, data: { ...good, bindGold: 1 } },
    });
    checkEqual(saveRejected.code, 20029, "坏档时存档被拒（20029）");
    checkEqual(roleRow(dbPath, roleId).corrupted, 1, "存档被拒时也标了 corrupted");
    checkEqual(roleRow(dbPath, roleId).data, "{坏掉的档", "坏 JSON 仍然原样保留");

    writeData(dbPath, roleId, { ...good, schemaVersion: CURRENT_VERSION });
    const saveOk = await api(baseUrl, "PUT", `roles/${roleId}`, {
      token,
      body: { revision: roleRow(dbPath, roleId).revision, data: { ...good, schemaVersion: CURRENT_VERSION, soulShow: true } },
    });
    checkEqual(saveOk.code, 0, "修好后存档恢复正常", saveOk.message);
    checkEqual(roleRow(dbPath, roleId).corrupted, 0, "存档路径也会清掉 corrupted");

    //#endregion

    //#region 四、缺字段不再采信客户端

    group("四、库里缺字段 → 按空值回填（不采信客户端那份）");
    const withoutBindBindGold = readData(dbPath, roleId);
    delete withoutBindBindGold.bindGold;
    writeData(dbPath, roleId, withoutBindBindGold);
    const reported = await api(baseUrl, "PUT", `roles/${roleId}`, {
      token,
      body: { revision: roleRow(dbPath, roleId).revision, data: { ...withoutBindBindGold, bindGold: 999999 } },
    });
    checkEqual(reported.code, 0, "缺字段的档可以正常保存（回填而不是拒收）", reported.message);
    checkEqual(readData(dbPath, roleId).bindGold, 0, "落库的是空值 0（客户端上报的 999999 被丢弃）");
    check(server.logs().includes("bindGold"), "服务端日志记了这次回填（可排查）");

    //#endregion

    //#region 五、客户端改账本仍然被拒（回归）

    group("五、客户端改绑定元宝仍然被拒");
    const ledger = readData(dbPath, roleId);
    ledger.bindGold = 100;
    writeData(dbPath, roleId, ledger);
    const cheat = await api(baseUrl, "PUT", `roles/${roleId}`, {
      token,
      body: { revision: roleRow(dbPath, roleId).revision, data: { ...ledger, bindGold: 999999 } },
    });
    checkEqual(cheat.code, 0, "改账本的存档照常落库（回填而非拒收）", cheat.message);
    checkEqual(readData(dbPath, roleId).bindGold, 100, "绑定元宝以库里为准（100，不是 999999）");

    //#endregion

    group("汇总");
    console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
    if (failed > 0) {
      console.log("\n❌ 坏档 e2e：以下断言不通过");
      failures.forEach((label) => console.log(`  - ${label}`));
      console.log("\n服务端日志尾部：");
      console.log(server.logs().split("\n").slice(-30).join("\n"));
      process.exitCode = 1;
    }
  } catch (error) {
    console.error("\n❌ 坏档 e2e 崩溃：", error);
    if (server) console.error(server.logs().split("\n").slice(-30).join("\n"));
    process.exitCode = 1;
  } finally {
    if (server) server.child.kill("SIGTERM");
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
})();
