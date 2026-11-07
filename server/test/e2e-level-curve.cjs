#!/usr/bin/env node
/**
 * 服务端 e2e：等级曲线 + 等级属性计算器（#786）
 *
 * 背景：#655 曾把等级存成 `role_levels` 一行一级（60 行），#786 要开到 100 万级 ——
 * 逐级存要 60MB 库 / 1.5GB 快照 / 客户端几百 MB 内存，所以改回**参数化曲线**：
 * 4 条（exp / hp / attack_max / defense_max）× 6 段 = 24 行，1..100 万级全靠公式算。
 * 原来的 `role_levels` 表已删、管理端「角色等级」页已删。
 *
 * 这套测试钉五条线：
 *
 * 〇、**曲线复现旧表**：1 / 60 级的裸属性与旧 60 行逐位相同（改了公式立刻红）
 * 一、**计算器**：任意等级现算，0 / 负数 / 非数字拒收；100 万级不是 Infinity
 * 二、**改段即时生效**：改一段的每级增量，下一次 preview 就是新值（不用重启）
 * 三、**段的结构约束**：结束等级不能小于起点、不能把下一段挤空、曲线键不能拼错
 * 四、**上限联动**：改 roleMaxLevel 会把四条曲线的末段一起拉过去（两处数字永远一致）
 *
 * 走的是 `dist/`，前置是 `npm run build`。
 * 用法：npm run test:e2e:level-curve
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const ADMIN_CODE = "e2e-level-admin";

//#region 断言小工具（与 e2e-money-item / e2e-bag 同款口径）

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
      JWT_SECRET: "e2e-level-secret",
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

async function registerAdmin(baseUrl, username, password) {
  await api(baseUrl, "POST", "admin/auth/register", { body: { username, password, registerCode: ADMIN_CODE } });
  const login = await api(baseUrl, "POST", "admin/auth/login", { body: { username, password } });
  return login.data && login.data.token;
}

/** 出厂段（从配置快照读，避免把段参数写死在测试里 —— 运营随时可能调） */
const snap = require("./lib/config-snapshot.cjs");
const SEED_CURVES = snap.rows("role_level_curves");

/** 某条曲线某段的出厂值 */
function seedSegment(curve, seq) {
  const row = SEED_CURVES.find((item) => item.curve === curve && Number(item.seq) === seq);
  if (!row) throw new Error(`快照里没有曲线 ${curve} 第 ${seq} 段`);
  return row;
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-level-${Date.now()}.db`);
  const server = await startServer(dbPath);
  try {
    const { baseUrl } = server;
    const adminToken = await registerAdmin(baseUrl, "level_admin", "Admin#123456");
    check(!!adminToken, "准备：管理员已登录");

    const preview = async (level) => api(baseUrl, "GET", `admin/level-curves/preview?level=${level}`, { token: adminToken });
    const patchSegment = async (curve, seq, body) =>
      api(baseUrl, "PATCH", `admin/level-curves/${curve}/${seq}`, { token: adminToken, body });
    const listCurves = async () => api(baseUrl, "GET", "admin/level-curves", { token: adminToken });

    //#region 〇、出厂 24 段 + 复现旧 60 行

    group("〇、出厂：4 条曲线 × 6 段，逐位复现旧 60 行");
    const listed = await listCurves();
    checkEqual(listed.code, 0, "曲线列表可读");
    const curves = (listed.data && listed.data.list) || [];
    checkEqual(curves.length, SEED_CURVES.length, "段数 = 出厂行数");
    const curveKeys = Array.from(new Set(curves.map((row) => row.curve))).sort();
    checkEqual(curveKeys.join(","), "attack_max,defense_max,exp,hp", "只有 4 条独立曲线");

    const lv1 = await preview(1);
    checkEqual(lv1.code, 0, "1 级算得出来");
    checkEqual(lv1.data.maxHp, 100, "1 级生命 = 100（旧表第 1 行）");
    checkEqual(lv1.data.maxMp, 50, "1 级魔法 = 生命/2");
    checkEqual(lv1.data.hpRecover, 1, "1 级回血 = 生命/100");
    checkEqual(lv1.data.exp, 100, "1 级升级经验 = 100");
    checkEqual(lv1.data.physicalAttack.min, 14, "1 级物攻下限 = 上限×0.7");
    checkEqual(lv1.data.physicalAttack.max, 20, "1 级物攻上限 = 20");
    checkEqual(
      lv1.data.magicAttack.max === lv1.data.physicalAttack.max && lv1.data.taoistAttack.max === lv1.data.physicalAttack.max,
      true,
      "三系攻同值（出厂就是这样）",
    );

    const lv60 = await preview(60);
    checkEqual(lv60.data.maxHp, 98720, "60 级生命 = 98720（旧表末行，曲线零误差）");
    checkEqual(lv60.data.maxMp, 49360, "60 级魔法 = 49360");
    checkEqual(lv60.data.hpRecover, 987, "60 级回血 = 987");
    checkEqual(lv60.data.exp, 106750, "60 级升级经验 = 106750");
    checkEqual(lv60.data.physicalAttack.max, 12540, "60 级物攻上限 = 12540");
    checkEqual(lv60.data.physicalDefense.max, 3762, "60 级物防上限 = 3762");

    //#endregion

    //#region 一、计算器：任意等级 + 边界

    group("一、等级属性计算器");
    const lvTop = await preview(1000000);
    checkEqual(lvTop.code, 0, "100 万级算得出来");
    check(
      Number.isFinite(lvTop.data.maxHp) && lvTop.data.maxHp > 0,
      "100 万级生命是有限正数（不是 Infinity）",
      String(lvTop.data.maxHp),
    );
    check(Number.isFinite(lvTop.data.exp) && lvTop.data.exp > 0, "100 万级升级经验也是有限数", String(lvTop.data.exp));
    check(lvTop.data.maxHp > lv60.data.maxHp, "100 万级生命 > 60 级生命（单调）");

    const overMax = await preview(2000000);
    checkEqual(overMax.code, 0, "超出末段按公式外推（调大上限不用改曲线）");
    check(overMax.data.maxHp > lvTop.data.maxHp, "200 万级比 100 万级更大");

    const badLevel = await preview(0);
    checkEqual(badLevel.code, 40000, "0 级拒收（参数校验）");
    const badLevel2 = await preview("abc");
    checkEqual(badLevel2.code, 40000, "非数字等级拒收");

    //#endregion

    //#region 二、改一段，下一次计算就是新值

    group("二、改段即时生效");
    const hpLast = seedSegment("hp", 6);
    const from = Number(hpLast.fromLevel);
    const before = lvTop.data.maxHp;
    const bumped = await patchSegment("hp", 6, { perLevel: Number(hpLast.perLevel) + 1000 });
    checkEqual(bumped.code, 0, "改 hp 末段每级增量成功");
    const afterBump = await preview(1000000);
    checkEqual(afterBump.data.maxHp, before + 1000 * (1000000 - from), "100 万级生命按新增量重算（不用重启）");
    checkEqual((await preview(1)).data.maxHp, lv1.data.maxHp, "1 级不受影响（改的是第 6 段，51 级起）");

    const restored = await patchSegment("hp", 6, { perLevel: Number(hpLast.perLevel) });
    checkEqual(restored.code, 0, "改回原增量");
    checkEqual((await preview(1000000)).data.maxHp, before, "100 万级生命恢复原值");

    // 改经验段：1 级升级经验跟着变
    const expFirst = seedSegment("exp", 1);
    await patchSegment("exp", 1, { startValue: Number(expFirst.startValue) + 50 });
    checkEqual((await preview(1)).data.exp, Number(expFirst.startValue) + 50, "1 级升级经验 = 改后的起始值");
    await patchSegment("exp", 1, { startValue: Number(expFirst.startValue) });
    checkEqual((await preview(1)).data.exp, Number(expFirst.startValue), "改回来也即时生效");

    //#endregion

    //#region 三、段的结构约束

    group("三、段的结构约束（错了会「某段等级没属性」）");
    const belowStart = await patchSegment("hp", 2, { toLevel: 5 });
    checkEqual(belowStart.code, 40000, "结束等级小于本段起点 → 拒收");

    // 末段先压到 51，再把第 5 段拉到 51：第 6 段会被挤空
    await patchSegment("hp", 6, { toLevel: 51 });
    const squeeze = await patchSegment("hp", 5, { toLevel: 51 });
    checkEqual(squeeze.code, 40000, "把下一段挤空 → 拒收");
    const repaired = await patchSegment("hp", 6, { toLevel: Number(hpLast.toLevel) });
    checkEqual(repaired.code, 0, "末段恢复出厂结束等级");

    const badCurve = await patchSegment("hpp", 1, { perLevel: 1 });
    checkEqual(badCurve.code, 40000, "曲线键拼错 → 拒收（不能静默不生效）");
    const missingSeq = await patchSegment("hp", 99, { perLevel: 1 });
    checkEqual(missingSeq.code, 50013, "段不存在 → 50013");

    // 非末段改结束等级会连带挪下一段起点
    const moved = await patchSegment("hp", 5, { toLevel: 45 });
    checkEqual(moved.code, 0, "第 5 段结束等级改到 45");
    const afterMove = (await listCurves()).data.list;
    checkEqual(
      afterMove.filter((row) => row.curve === "hp" && row.seq === 6)[0].fromLevel,
      46,
      "第 6 段起点联动到 46（不留空隙）",
    );
    await patchSegment("hp", 5, { toLevel: Number(seedSegment("hp", 5).toLevel) });
    checkEqual(
      (await listCurves()).data.list.filter((row) => row.curve === "hp" && row.seq === 6)[0].fromLevel,
      51,
      "改回去，第 6 段起点也跟着回 51",
    );

    //#endregion

    //#region 四、上限联动

    group("四、等级上限与末段永远一致");
    const bumpMax = await api(baseUrl, "PATCH", "admin/growth-scalars/roleMaxLevel", {
      token: adminToken,
      body: { value: 2000000 },
    });
    checkEqual(bumpMax.code, 0, "上限改成 200 万");
    const afterMax = (await listCurves()).data.list;
    const lastOfAll = ["exp", "hp", "attack_max", "defense_max"].map((curve) => {
      const segments = afterMax.filter((row) => row.curve === curve).sort((a, b) => a.seq - b.seq);
      return segments[segments.length - 1].toLevel;
    });
    check(
      lastOfAll.every((value) => value === 2000000),
      "四条曲线的末段结束等级都跟着变成 200 万",
      lastOfAll.join(","),
    );
    await api(baseUrl, "PATCH", "admin/growth-scalars/roleMaxLevel", { token: adminToken, body: { value: 1000000 } });
    checkEqual((await preview(1)).code, 0, "上限调回 100 万后计算器仍正常");

    //#endregion

    //#region 五、旧表与旧接口确实没了

    group("五、逐级表与旧接口已下线");
    const gone = await api(baseUrl, "GET", "admin/role-levels?page=1&size=10", { token: adminToken });
    check(gone === null || gone.code !== 0, "旧接口 admin/role-levels 已不存在", JSON.stringify(gone && gone.code));
    const health = await fetch(`${baseUrl}/api/health`);
    check(health.ok, "服务仍然健康（删表没有把它打挂）");

    //#endregion

    const logs = server.logs();
    check(/role_levels/.test(logs) === false || /DROP TABLE/.test(logs) === false, "启动日志里没有残留的逐级表装载");
  } finally {
    server.child.kill("SIGTERM");
    await sleep(200);
    if (fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
    if (fs.existsSync(`${dbPath}-wal`)) fs.rmSync(`${dbPath}-wal`, { force: true });
    if (fs.existsSync(`${dbPath}-shm`)) fs.rmSync(`${dbPath}-shm`, { force: true });
  }

  console.log(`\n${failed === 0 ? "✓" : "✗"} 断言 ${passed} 通过 / ${failed} 失败`);
  if (failed > 0) {
    console.log("失败项：\n  - " + failures.join("\n  - "));
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error("e2e 崩了：", error);
  process.exitCode = 1;
});
