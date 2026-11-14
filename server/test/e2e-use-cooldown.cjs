#!/usr/bin/env node
/**
 * 服务端 e2e：道具使用的服务端冷却（#847 货币道具 / #848 药品）
 *
 * 这两条 bug 的病灶是同一个：**服务端不记冷却，改包就能连点**。
 * 药品的间隔在 `drugs.cooldown`（单位**秒**，0 = 无冷却），货币道具用常量 1 秒
 * （`MONEY_ITEM_COOLDOWN_MS`）；键都是「角色 + 道具 id」，所以红的喝完不影响蓝的。
 *
 * 这套测试钉四件事：
 *
 * 〇、准备：玩家 / 角色 / 管理员，摆药与压血都走管理端旁路（存档是服务端权威）
 * 一、药品冷却：连点第二次 20030，**药不被扣**，等够时长后能再用
 * 二、冷却不误伤：换一种药照样能用（键含道具 id）
 * 三、失败不吃冷却：血已满（20014）/ 乐观锁落后（20006）之后，紧接着的正确请求要能成功
 * 四、货币道具冷却：连点第二次 20031，等 1 秒后可用；不同道具互不影响
 *
 * 走的是 `dist/`，所以前置是 `npm run build`。
 * 用法：npm run test:e2e:use-cooldown
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const ADMIN_CODE = "e2e-cooldown-admin";

//#region 断言小工具（与 e2e-money-item / e2e-sell 同款口径）

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
      JWT_SECRET: "e2e-cooldown-secret",
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
  return body;
}

/** 取当前修订号（写接口都要基线，见 #820 / B62） */
async function revOf(baseUrl, roleId, token) {
  const role = await api(baseUrl, "GET", `roles/${roleId}`, { token });
  return role.data && role.data.revision;
}

/** 背包某格 */
function cellAt(bag, row, col) {
  return (bag || [])[row] ? bag[row][col] : undefined;
}

async function registerAdmin(baseUrl, username, password) {
  await api(baseUrl, "POST", "admin/auth/register", { body: { username, password, registerCode: ADMIN_CODE } });
  const login = await api(baseUrl, "POST", "admin/auth/login", { body: { zoneId: ADMIN_ZONE, username, password } });
  return login.data && login.data.token;
}

/** 出厂值来源：配置快照（库里权威，快照是它的逐行投影） */
const snap = require("./lib/config-snapshot.cjs");
const DRUGS = snap.index("drugs");
const MONEY = snap.rows("money_items");

/** 药品冷却（秒）——从快照读，别把 1 秒写死在断言里（运营随时可能改数） */
const HP_DRUG_ID = "drug_hp_1";
const HP_DRUG_COOLDOWN_S = Math.max(0, Number(DRUGS[HP_DRUG_ID] && DRUGS[HP_DRUG_ID].cooldown) || 0);
const HP_DRUG_WAIT = HP_DRUG_COOLDOWN_S * 1000 + 250;
/** 货币道具 1 秒冷却（服务端常量 `MONEY_ITEM_COOLDOWN_MS`） */
const MONEY_WAIT = 1250;
const BIND_ROW = MONEY.find((row) => row.currency === "bindGold" && Number(row.amount) === 100);
const BIND_ROW_50 = MONEY.find((row) => row.currency === "bindGold" && Number(row.amount) === 50);

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-cooldown-${Date.now()}.db`);
  const server = await startServer(dbPath);
  try {
    const { baseUrl } = server;

    //#region 〇、准备

    group("准备：玩家 / 角色 / 管理员");
    const registered = await api(baseUrl, "POST", "auth/register", { body: { username: "cd_player", password: "pass1234" } });
    const token = registered.data && registered.data.token;
    const created = await api(baseUrl, "POST", "roles", { token, body: { name: "耐性", occupation: "1", sex: "1" } });
    const roleId = created.data && created.data.id;
    check(created.code === 0 && created.data.online === true, "准备：角色已创建并自动在线", created.message);
    const adminToken = await registerAdmin(baseUrl, "cd_admin", "Admin#123456");
    check(!!adminToken, "准备：管理员已登录");
    check(HP_DRUG_COOLDOWN_S > 0, `前置：快照里 ${HP_DRUG_ID} 的 cooldown > 0（不然这套测试没得测）`, String(HP_DRUG_COOLDOWN_S));

    /** 摆背包（管理端整份覆盖：客户端改不了 bag） */
    const seedBag = async (cells) => {
      const result = await api(baseUrl, "PATCH", `admin/roles/${roleId}`, { token: adminToken, zoneId: ADMIN_ZONE, body: { bag: cells } });
      check(result.code === 0, `准备：管理端注入 ${cells.length} 格物品`, result.message);
      return result;
    };
    /** 压血 / 压蓝（服务端权威，见 #596） */
    const patchVitals = async (hp, mp) => {
      const body = {};
      if (hp !== undefined) body.hp = hp;
      if (mp !== undefined) body.mp = mp;
      const result = await api(baseUrl, "PATCH", `admin/roles/${roleId}`, { token: adminToken, zoneId: ADMIN_ZONE, body });
      check(result.code === 0, `准备：血蓝压到 hp=${hp} mp=${mp}`, result.message);
      return result;
    };
    const useDrug = async (row, col) =>
      api(baseUrl, "POST", `roles/${roleId}/drug-use`, {
        token,
        body: { row, col, revision: await revOf(baseUrl, roleId, token) },
      });
    const useMoney = async (row, col) =>
      api(baseUrl, "POST", `roles/${roleId}/money-use`, {
        token,
        body: { row, col, revision: await revOf(baseUrl, roleId, token) },
      });

    await patchVitals(10, 10);

    //#endregion

    //#region 一、药品冷却

    group("一、药品冷却：连点第二次被拒，药不被扣");
    await seedBag([{ row: 0, col: 0, id: HP_DRUG_ID, count: 2 }]);
    const first = await useDrug(0, 0);
    checkEqual(first.code, 0, "第一次用药成功", first.message);
    checkEqual((cellAt(first.data.data.bag, 0, 0) || {}).count, 1, "第一次扣掉一瓶（2 → 1）");

    const tooFast = await useDrug(0, 0);
    checkEqual(tooFast.code, 20030, "紧接着再点 → 20030 冷却中", tooFast.message);
    const remaining = Number(tooFast.details && tooFast.details.remainingMs);
    // 上界（= 药品 cooldown 全长）是配置算出来的，不判；判「带一个正的剩余毫秒」
    check(remaining > 0, "回执带剩余毫秒（客户端据此灰按钮）", String(remaining));
    const afterBlocked = await api(baseUrl, "GET", `roles/${roleId}`, { token });
    checkEqual((cellAt(afterBlocked.data.data.bag, 0, 0) || {}).count, 1, "**被冷却拒掉的那次不扣药**（仍是 1 瓶）");

    await sleep(HP_DRUG_WAIT);
    const afterWait = await useDrug(0, 0);
    checkEqual(afterWait.code, 0, "等够 cooldown 之后能再用", afterWait.message);
    checkEqual(cellAt(afterWait.data.data.bag, 0, 0) ?? null, null, "用光了 → 格子清空");

    //#endregion

    //#region 二、冷却不误伤别的药

    group("二、换一种药照样能用（键是「角色 + 药品 id」）");
    await sleep(HP_DRUG_WAIT); // 上一段刚用过金创药，先等它自己的冷却过去
    await seedBag([
      { row: 0, col: 0, id: HP_DRUG_ID, count: 1 },
      { row: 0, col: 1, id: "drug_sun", count: 1 },
    ]);
    await patchVitals(10, 10);
    const hpUsed = await useDrug(0, 0);
    checkEqual(hpUsed.code, 0, "先用金创药 → 成功", hpUsed.message);
    const sunUsed = await useDrug(0, 1);
    checkEqual(sunUsed.code, 0, "立刻用太阳水 → 也成功（不同的药各记各的冷却）", sunUsed.message);

    //#endregion

    //#region 三、失败不吃冷却

    group("三、失败不消耗冷却（20014 / 20006 各有一次机会）");
    await sleep(HP_DRUG_WAIT); // 上一段刚用过金创药
    await seedBag([{ row: 0, col: 0, id: HP_DRUG_ID, count: 2 }]);
    // 血蓝全满 → 20014；随后压血再点，必须能成功（说明 20014 那次没占冷却）
    const fresh = await api(baseUrl, "GET", `roles/${roleId}`, { token });
    await patchVitals(fresh.data.data.maxHp, fresh.data.data.maxMp);
    const fullUse = await useDrug(0, 0);
    checkEqual(fullUse.code, 20014, "血蓝已满 → 20014", fullUse.message);
    await patchVitals(10, 10);
    const afterFull = await useDrug(0, 0);
    checkEqual(afterFull.code, 0, "压血后立刻再点 → 成功（20014 那次没吃掉冷却）", afterFull.message);

    // 乐观锁落后 → 20006；紧接着带最新 revision 再点，必须能成功
    const staleRev = (await revOf(baseUrl, roleId, token)) - 1;
    const stale = await api(baseUrl, "POST", `roles/${roleId}/drug-use`, { token, body: { row: 0, col: 0, revision: staleRev } });
    checkEqual(stale.code, 20006, "带旧修订号用药 → 20006", stale.message);
    await sleep(HP_DRUG_WAIT);
    await patchVitals(10, 10);
    const afterStale = await useDrug(0, 0);
    checkEqual(afterStale.code, 0, "冷却过后能再用（冷却没被 20006 那次占死）", afterStale.message);

    //#endregion

    //#region 四、货币道具冷却

    group("四、货币道具冷却 1 秒，不同道具互不影响");
    check(!!BIND_ROW && !!BIND_ROW_50, "前置：快照里有绑定元宝道具（两档面值）");
    await seedBag([
      { row: 0, col: 0, id: BIND_ROW.id, count: 2 },
      { row: 0, col: 1, id: BIND_ROW_50.id, count: 1 },
    ]);
    const bindFirst = await useMoney(0, 0);
    checkEqual(bindFirst.code, 0, "第一次用绑定元宝道具 → 成功", bindFirst.message);
    const bindFast = await useMoney(0, 0);
    checkEqual(bindFast.code, 20031, "紧接着再点同一个 → 20031 冷却中", bindFast.message);
    check(Number(bindFast.details && bindFast.details.remainingMs) > 0, "回执带剩余毫秒");
    const bagAfterFast = await api(baseUrl, "GET", `roles/${roleId}`, { token });
    checkEqual((cellAt(bagAfterFast.data.data.bag, 0, 0) || {}).count, 1, "被拒的那次不扣道具（仍是 1 个）");

    const row50During = await useMoney(0, 1);
    checkEqual(row50During.code, 0, "同一道具冷却期间用另一档面值 → 照常成功（不同道具不同键）", row50During.message);

    await sleep(MONEY_WAIT);
    const bindAgain = await useMoney(0, 0);
    checkEqual(bindAgain.code, 0, "等 1 秒后绑定元宝道具能再用", bindAgain.message);

    //#endregion

    //#region 收尾

    group("收尾");
    console.log(`\n${failed === 0 ? "✓" : "✗"} 道具冷却 e2e ${failed === 0 ? "全绿" : "有失败"}（共 ${passed + failed} 条断言，通过 ${passed} 条）`);
    if (failed > 0) {
      console.log("失败项：");
      failures.forEach((label, index) => console.log(`  ${index + 1}. ${label}`));
      process.exitCode = 1;
    }

    //#endregion
  } finally {
    server.child.kill("SIGTERM");
    await sleep(200);
    try {
      require("node:fs").rmSync(dbPath, { force: true });
      require("node:fs").rmSync(`${dbPath}-wal`, { force: true });
      require("node:fs").rmSync(`${dbPath}-shm`, { force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  }
})().catch((error) => {
  console.error("e2e-use-cooldown 崩了：", error);
  process.exitCode = 1;
});
