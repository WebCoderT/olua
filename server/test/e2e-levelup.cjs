#!/usr/bin/env node
/**
 * 服务端 e2e：升级路径统一（#829 / #830 / #831 / #832 = docs/37 的 B11 / B12 / B13 / B14，A7 / A8）
 *
 * 这一套盯的是「一次升级到底改了什么」，四条口径各一段：
 *
 * - **B11**：等级有两份权威（`roles.level` 列 + `data.level` 文档字段），升级后必须一起变。
 *   以前只写列，文档里那份停在旧值，管理端详情与客户端本地看到两个数字；
 * - **A7 / B13**：升级**统一回满**血蓝。以前击杀补、发奖不补 —— 同一个「升级」两种结果，
 *   玩家看不出规律；
 * - **A8 / B12**：满级后经验**封顶**（不再是「攒着但没用」的无限累加）；
 * - **B14**：`growth_scalars.roleMaxLevel` 缺失时不能回落成 1 级（那等于**全服永久 1 级**）——
 *   兜底改成「曲线配到的最高级」，并记一条 error。
 *
 * 三段各走一条真实路径，不直接调 service：
 * - 发奖（`grantQuestRewards`）：管理端补发带经验的 reward 邮件 → 玩家领取；
 * - 击杀同一条链路（`applyKillExp`）：开泡点（`soakExpPerTick`）让服务端自己按拍入账 ——
 *   泡点与击杀共用 `applyKillExp`，不必真去打怪（伤害结算另有一套 e2e 守着）；
 * - 升级卷轴：管理端塞一格 `level_scroll_1` → 玩家使用。
 *
 * 用临时文件库，跑 `dist/`，前置 `npm run build`。用法：npm run test:e2e:levelup
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const ADMIN_CODE = "levelup-admin";

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

const checkEqual = (actual, expected, label) =>
  check(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
function group(label) {
  console.log(`\n▶ ${label}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (label, predicate, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(100);
  }
  check(false, `${label}（等待超时）`);
  return last;
};

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

/** 直接改库：血蓝压低（验证「升级回满」必须从「不满」开始）、删掉等级上限那行（B14） */
function withDb(dbPath, run) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

const setRoleVitals = (dbPath, roleId, hp, mp) =>
  withDb(dbPath, (db) =>
    db.prepare("UPDATE roles SET data = json_set(data, '$.hp', ?, '$.mp', ?) WHERE id = ?").run(hp, mp, roleId),
  );

const dropGrowthScalar = (dbPath, key) => withDb(dbPath, (db) => db.prepare("DELETE FROM growth_scalars WHERE key = ?").run(key));

/** 把被删掉的标量补回库（后面的段还要用管理端改它；管理端 PATCH 只改值，不新建） */
const restoreGrowthScalar = (dbPath, key, value) =>
  withDb(dbPath, (db) =>
    db
      .prepare("INSERT INTO growth_scalars (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value),
  );

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
      JWT_SECRET: "e2e-levelup-secret",
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

async function stopServer(server) {
  if (server.child.exitCode === null && !server.child.signalCode) {
    server.child.kill("SIGTERM");
    await sleep(300);
    if (server.child.exitCode === null && !server.child.signalCode) server.child.kill("SIGKILL");
  }
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
  try {
    return await response.json();
  } catch {
    return null;
  }
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-levelup-${Date.now()}.db`);
  let server = await startServer(dbPath);
  let baseUrl = server.baseUrl;
  try {
    //#region 准备
    group("准备：管理员、玩家、角色、在线");

    const adminReg = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "levelup_admin", password: "super-pass-1", registerCode: ADMIN_CODE },
    });
    const adminToken = adminReg.data && adminReg.data.token;
    checkEqual(adminReg.data && adminReg.data.admin.role, "super_admin", "准备：超级管理员已注册");

    const reg = await api(baseUrl, "POST", "auth/register", { body: { username: "levelup_player", password: "pass1234" } });
    const token = reg.data && reg.data.token;
    const created = await api(baseUrl, "POST", "roles", { token, body: { name: "升级测试", occupation: "1", sex: "1" } });
    const roleId = created.data && created.data.id;
    check(!!(token && roleId), "账号与角色已建好", String(roleId));

    // 在线 = `accounts.online_role_id`（泡点与卷轴都以它为前置）
    const selected = await api(baseUrl, "POST", `roles/${roleId}/select`, { token });
    checkEqual(selected.code, 0, "准备：角色已选中（在线）", selected.message);

    const readRole = async () => (await api(baseUrl, "GET", `roles/${roleId}`, { token })).data;
    const patchRole = async (body, label) => {
      const result = await api(baseUrl, "PATCH", `admin/roles/${roleId}`, { token: adminToken, zoneId: ADMIN_ZONE, body });
      check(result.code === 0, `准备：${label}`, result.message);
      return result;
    };
    const patchScalar = async (key, value) => {
      const result = await api(baseUrl, "PATCH", `admin/growth-scalars/${key}`, { token: adminToken, zoneId: ADMIN_ZONE, body: { value } });
      check(result.code === 0, `准备：把 ${key} 改成 ${value}`, result.message);
      return result;
    };
    /** 发一封带经验的邮件并领取（发奖路径的入口：admin 补发 → 玩家 claim） */
    const grantExpByMail = async (exp) => {
      const sent = await api(baseUrl, "POST", `admin/game-mail/roles/${roleId}`, {
        token: adminToken, zoneId: ADMIN_ZONE,
        body: { channel: "reward", title: "升级测试", body: "经验附件", exp },
      });
      checkEqual(sent.code, 0, `发一封带 ${exp} 经验的补发邮件`, sent.message);
      const mailId = sent.data && sent.data.id;
      const claimed = await api(baseUrl, "POST", `mails/${mailId}/claim`, { token });
      checkEqual(claimed.code, 0, "玩家领取成功", claimed.message);
      return claimed;
    };

    const first = await readRole();
    checkEqual(first.level, 1, "新角色 1 级");
    checkEqual(first.data && first.data.level, 1, "文档里的 level 也是 1（建号时两边一致）");
    //#endregion

    //#region 一、发奖升级：data.level 同步 + 回满血蓝
    group("一、发奖路径升级（任务 / 成就 / 邮件领取共用 grantQuestRewards）");

    setRoleVitals(dbPath, roleId, 5, 1);
    const damaged = await readRole();
    check(Number(damaged.data.hp) === 5 && Number(damaged.data.maxHp) > 5, "准备：血蓝已压低（当前 5 血 / 1 蓝）");

    await grantExpByMail(5000);
    const afterGrant = await readRole();
    check(afterGrant.level > 1, "领取经验后升级了", `level=${afterGrant.level}`);
    checkEqual(
      afterGrant.data && afterGrant.data.level,
      afterGrant.level,
      "B11：`data.level` 与 `roles.level` 列同步（升级写文档，不再只写列）",
    );
    checkEqual(afterGrant.data && afterGrant.data.hp, afterGrant.data && afterGrant.data.maxHp, "A7：升级回满血");
    checkEqual(afterGrant.data && afterGrant.data.mp, afterGrant.data && afterGrant.data.maxMp, "A7：升级回满蓝");
    const leftoverExp = Number(afterGrant.data && afterGrant.data.exp);
    check(
      Number.isFinite(leftoverExp) && leftoverExp >= 0 && leftoverExp < 5000,
      "经验被升级循环吃掉后只剩一小截（不是把 5000 原样堆着）",
      `exp=${leftoverExp}`,
    );
    //#endregion

    //#region 二、泡点升级：与击杀共用 applyKillExp
    group("二、泡点路径升级（泡点与击杀共用 applyKillExp）");

    const levelBeforeSoak = (await readRole()).level;
    setRoleVitals(dbPath, roleId, 3, 1);
    await patchScalar("soakExpPerTick", 20000);
    await patchScalar("soakTickSeconds", 1);
    const soaked = await waitFor(
      "泡点把角色顶上去（每拍 2 万经验，1 秒一拍）",
      async () => {
        const now = await readRole();
        return now.level > levelBeforeSoak ? now : null;
      },
      20_000,
    );
    await patchScalar("soakExpPerTick", 0); // 关掉，别污染后面的断言
    check(!!soaked, "泡点让角色升级了", soaked && `level=${soaked.level}`);
    checkEqual(
      soaked && soaked.data && soaked.data.level,
      soaked && soaked.level,
      "B11：泡点升级同样写 `data.level`（四条路一套代码）",
    );
    checkEqual(soaked && soaked.data && soaked.data.hp, soaked && soaked.data && soaked.data.maxHp, "A7：泡点升级也回满血");
    //#endregion

    //#region 三、roleMaxLevel 缺失不再回落 1 级
    group("三、`roleMaxLevel` 缺失：兜底到曲线末段，不能全服卡在 1 级（B14）");

    // 必须**重启**才能验证：进程内的运行时缓存装载时就把这一行读进去了，
    // 只删库的话 `growthScalarOf` 仍然命中缓存，测不到兜底分支
    const levelBeforeRestart = (await readRole()).level;
    await stopServer(server);
    dropGrowthScalar(dbPath, "roleMaxLevel");
    server = await startServer(dbPath);
    baseUrl = server.baseUrl;
    check(true, "已停服、删掉 `growth_scalars.roleMaxLevel` 那一行、重新启服");

    const afterRestart = await readRole();
    checkEqual(afterRestart.level, levelBeforeRestart, "跨重启等级没丢（列与文档都在）");

    // 卷轴是最省事的探针：上限为 1 级时它必定 20026（`fromLevel >= cap`）
    await patchRole({ bag: [{ row: 0, col: 0, id: "level_scroll_1", count: 1 }] }, "塞一格 Lv1 卷轴");
    const revisionNow = (await readRole()).revision;
    const scrolled = await api(baseUrl, "POST", `roles/${roleId}/level-scroll-use`, {
      token,
      body: { row: 0, col: 0, revision: revisionNow },
    });
    checkEqual(scrolled.code, 0, "缺上限时卷轴仍可用（兜底不是 1 级）", scrolled.message);
    checkEqual(scrolled.data && scrolled.data.level, levelBeforeRestart + 1, "卷轴把等级 +1");
    checkEqual(
      scrolled.data && scrolled.data.data && scrolled.data.data.level,
      levelBeforeRestart + 1,
      "B11：卷轴路径同样写 `data.level`",
    );
    check(
      server.logs().includes("缺 roleMaxLevel"),
      "服务端把「上限缺失」记成 error 并说清怎么补（不是静默按 1 级跑）",
    );
    //#endregion

    //#region 四、满级经验封顶
    group("四、满级后经验封顶（A8 / B12）");

    const capLevel = (await readRole()).level;
    // 上一段把这一行删了，这段要改它（管理端 PATCH 只改值、不新建），先按出厂值补回库。
    // 注意：改上限会把曲线末段一起拉过来（服务端刻意保持两处一致），所以这段必须放在最后
    restoreGrowthScalar(dbPath, "roleMaxLevel", 1000000);
    await patchScalar("roleMaxLevel", capLevel);
    const beforeCap = await readRole();
    checkEqual(beforeCap.level, capLevel, "角色已在上限上（升级循环不再前进）");

    await grantExpByMail(999999);
    const afterCap = await readRole();
    checkEqual(afterCap.level, capLevel, "满级后再拿经验也不升级");
    checkEqual(Number(afterCap.data.exp), 0, "满级后经验封顶为 0（不再无限累加，B12 / A8）");
    checkEqual(afterCap.data && afterCap.data.level, afterCap.level, "满级后 `data.level` 仍与列一致");
    //#endregion
  } finally {
    await stopServer(server);
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }

  console.log(`\n${failed === 0 ? "✅" : "FAIL："} 升级路径统一（#829/#830/#831/#832）：${passed} 条通过 / ${failed} 条失败`);
  if (failed > 0) {
    console.log("失败项：");
    for (const item of failures) console.log(`- ${item}`);
    console.log("\n服务端日志（尾部）：");
    console.log(server.logs().split("\n").slice(-30).join("\n"));
    process.exit(1);
  }
})();
