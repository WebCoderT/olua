#!/usr/bin/env node
/**
 * 乐观锁专项 e2e（server/test/e2e-role-optimistic.cjs，issue #820 / B62 / I2）
 *
 * 盯的不变量（改任何「写存档」的路径后必须全绿）：
 * 一、**不带 revision 一律 400**：save 与三条非 save 写入路径（商城 / 背包 / 成长线）
 *     都必须在参数校验层被拦下（400 / 40000），且一行都不写库
 * 二、**过期基线 → 409 / 20006**：同样是四条路径，且库里的值保持「别人的改动」
 * 三、**并发两次保存**：两个客户端拿同一个基线同时推，只有第一个成功，
 *     第二个 20006；revision 只 +1（不是 +2，也不是两边都写进一半）
 * 四、**落库语句本身带条件**：`role.repository` 的 UPDATE 必须含 `AND revision = ?` ——
 *     业务层的比对只覆盖「读的那一刻」，这条 WHERE 才覆盖「读 → 算 → 写」整段
 *
 * 为什么要有这份：`revision` 原本是**可选**的，不传就最后写入者胜 ——
 * 管理端刚改的数值会被客户端那份改之前的存档整体覆盖，既查不到也不报错。
 * 这条后门一旦被人「顺手放宽」（比如为了兼容老客户端把 `@IsOptional()` 加回来），
 * 上面四条会立刻红，而不是等运营发现数值不对。
 *
 * 走的是 `dist/`，所以前置是 `npm run build`。
 * 用法：npm run test:e2e:role-optimistic
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const ADMIN_CODE = "e2e-optimistic-admin";

//#region 断言小工具（与 e2e-role-corrupted 同款口径）

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
      JWT_SECRET: "e2e-optimistic-secret",
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
  throw new Error("等待服务超时");
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

/** 直接开库核落库结果（#820 的断言要看「有没有真写进去」，不能只看响应） */
function roleRow(dbPath, roleId) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare("SELECT id, data, revision FROM roles WHERE id = ?").get(roleId);
  } finally {
    db.close();
  }
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-optimistic-${Date.now()}.db`);
  let server = null;
  try {
    server = await startServer(dbPath);
    const { baseUrl } = server;

    //#region 准备

    group("准备：玩家 + 管理员 + 一个角色");
    const registered = await api(baseUrl, "POST", "auth/register", {
      body: { username: "optimistic_player", password: "pass1234" },
    });
    const token = registered.data && registered.data.token;
    const created = await api(baseUrl, "POST", "roles", { token, body: { name: "锁一号", occupation: "1", sex: "1" } });
    const roleId = created.data && created.data.id;
    check(!!token && !!roleId, "准备：账号与角色已创建", created.message);
    checkEqual(created.data && created.data.revision, 1, "新号 revision 从 1 起");

    await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "optimistic_admin", password: "pass1234", registerCode: ADMIN_CODE },
    });
    const adminLogin = await api(baseUrl, "POST", "admin/auth/login", {
      body: { zoneId: ADMIN_ZONE, username: "optimistic_admin", password: "pass1234" },
    });
    const adminToken = adminLogin.data && adminLogin.data.token;
    check(!!adminToken, "准备：管理员已登录");

    /** 取当前存档文档（改一点客户端可写字段再推回去用） */
    const currentDoc = async () => {
      const detail = await api(baseUrl, "GET", `roles/${roleId}`, { token });
      return { revision: detail.data.revision, doc: JSON.parse(JSON.stringify(detail.data.data)) };
    };

    //#endregion

    //#region 一、不带 revision 一律 400

    group("一、不带 revision：四条写入路径全在参数校验层被拒（400 / 40000）");
    const baseline = await currentDoc();

    const noRevSave = await api(baseUrl, "PUT", `roles/${roleId}`, { token, body: { data: baseline.doc } });
    checkEqual(noRevSave.status, 400, "save 不带 revision → HTTP 400");
    checkEqual(noRevSave.code, 40000, "save 不带 revision → 40000（参数校验不通过，不是业务码）");

    const noRevMall = await api(baseUrl, "POST", `roles/${roleId}/mall-purchase`, { token, body: { goodId: "cloth_1_p0s1" } });
    checkEqual(noRevMall.status, 400, "商城购买不带 revision → HTTP 400");
    checkEqual(noRevMall.code, 40000, "商城购买不带 revision → 40000");

    const noRevBag = await api(baseUrl, "POST", `roles/${roleId}/bag-op`, { token, body: { action: "tidy" } });
    checkEqual(noRevBag.status, 400, "背包操作不带 revision → HTTP 400");
    checkEqual(noRevBag.code, 40000, "背包操作不带 revision → 40000");

    const noRevGrowth = await api(baseUrl, "POST", `roles/${roleId}/growth-upgrade`, {
      token,
      body: { kind: "title", targetLevel: 2 },
    });
    checkEqual(noRevGrowth.status, 400, "成长线升级不带 revision → HTTP 400");
    checkEqual(noRevGrowth.code, 40000, "成长线升级不带 revision → 40000");

    const afterNoRev = roleRow(dbPath, roleId);
    checkEqual(afterNoRev.revision, baseline.revision, "被拒的这几次一行都没写库（revision 原地不动）");

    //#endregion

    //#region 二、过期基线 → 409 / 20006

    group("二、过期基线：同样是四条路径，全部 20006 且不写库");
    const staleRevision = baseline.revision;
    // 先让服务端自己往前走一步（管理端改数值），让上面那份基线变成「过期」
    const patched = await api(baseUrl, "PATCH", `admin/roles/${roleId}`, { token: adminToken, zoneId: ADMIN_ZONE, body: { bindGold: 777 } });
    checkEqual(patched.code, 0, "准备：管理端把绑定元宝改成 777（服务端 revision 前进一格）");
    const afterPatch = roleRow(dbPath, roleId);
    checkEqual(afterPatch.revision, staleRevision + 1, "管理端改数值推进了 revision");

    const staleSave = await api(baseUrl, "PUT", `roles/${roleId}`, {
      token,
      body: { data: { ...baseline.doc, bindGold: 123 }, revision: staleRevision },
    });
    checkEqual(staleSave.status, 409, "save 用过期基线 → HTTP 409");
    checkEqual(staleSave.code, 20006, "save 用过期基线 → 20006");
    check(JSON.parse(roleRow(dbPath, roleId).data).bindGold === 777, "后台改的绑定元宝还在（旧存档没有覆盖它）");

    const staleMall = await api(baseUrl, "POST", `roles/${roleId}/mall-purchase`, {
      token,
      body: { goodId: "cloth_1_p0s1", revision: staleRevision },
    });
    checkEqual(staleMall.code, 20006, "商城购买用过期基线 → 20006");

    const staleBag = await api(baseUrl, "POST", `roles/${roleId}/bag-op`, {
      token,
      body: { action: "tidy", revision: staleRevision },
    });
    checkEqual(staleBag.code, 20006, "背包操作用过期基线 → 20006");

    const staleGrowth = await api(baseUrl, "POST", `roles/${roleId}/growth-upgrade`, {
      token,
      body: { kind: "title", targetLevel: 2, revision: staleRevision },
    });
    checkEqual(staleGrowth.code, 20006, "成长线升级用过期基线 → 20006");

    checkEqual(roleRow(dbPath, roleId).revision, staleRevision + 1, "这四条被拒之后 revision 仍然只有 +1（管理端那一次）");

    //#endregion

    //#region 三、并发两次保存

    group("三、并发两次保存：同一基线只有一个赢家");
    const race = await currentDoc();
    const raceDoc = { ...race.doc, onMap: "1" };
    const [first, second] = await Promise.all([
      api(baseUrl, "PUT", `roles/${roleId}`, { token, body: { data: raceDoc, revision: race.revision } }),
      api(baseUrl, "PUT", `roles/${roleId}`, { token, body: { data: raceDoc, revision: race.revision } }),
    ]);
    const codes = [first.code, second.code].sort((a, b) => a - b);
    checkEqual(codes[0], 0, "并发的两次里有一次成功（0）");
    checkEqual(codes[1], 20006, "另一次撞上乐观锁（20006），不是两个都写进去");
    checkEqual(
      roleRow(dbPath, roleId).revision,
      race.revision + 1,
      "revision 只 +1（两次都成功会是 +2，那是丢更新的典型症状）",
    );

    // 拿最新基线再推一次就成功：冲突不是死锁，客户端拉一次详情就能继续
    const fresh = await currentDoc();
    const resumed = await api(baseUrl, "PUT", `roles/${roleId}`, {
      token,
      body: { data: { ...fresh.doc, onMap: "2" }, revision: fresh.revision },
    });
    checkEqual(resumed.code, 0, "换到最新基线后立刻能继续保存（不会自锁死循环）");

    //#endregion

    //#region 四、落库语句本身带 revision 条件

    group("四、静态：replace 的 UPDATE 带 WHERE revision = ?（顺序保证在数据库那一层）");
    const repoJs = fs.readFileSync(path.join(SERVER_DIR, "dist", "database", "repositories", "role.repository.js"), "utf8");
    const updateMatch = repoJs.match(/UPDATE roles SET name[\s\S]*?WHERE id = \? AND revision = \?/);
    check(!!updateMatch, "role.repository 的全量覆盖 UPDATE 含 `WHERE id = ? AND revision = ?`");
    const repoParams = updateMatch ? updateMatch[0] : "";
    check(
      /revision = revision \+ 1/.test(repoParams),
      "同一条语句里 revision 自增（不是「读出来加一再写回」）",
      repoParams.slice(0, 120),
    );

    //#endregion
  } catch (error) {
    failed += 1;
    failures.push(`执行异常：${error && error.message ? error.message : String(error)}`);
    console.log(`\n✗ 执行异常：${error && error.stack ? error.stack : String(error)}`);
  } finally {
    if (server && server.child) server.child.kill("SIGTERM");
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"} 乐观锁 e2e：${passed} 条通过 / ${failed} 条失败`);
  if (failed) {
    console.log("失败项：\n" + failures.map((item) => `  - ${item}`).join("\n"));
    process.exitCode = 1;
  }
})();
