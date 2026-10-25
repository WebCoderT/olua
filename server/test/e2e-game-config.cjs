#!/usr/bin/env node
/**
 * 服务端 e2e：养成配置管理（称号 / 战魂）
 *
 * 与其余几套同一套路（真实进程 + 真实 HTTP，跑 dist/ 产物）。单独成文件是因为
 * 这一模块的核心约束是「**只许改，不许增删**」——这是需求方明确要的行为边界：
 *
 * ## 三条主线
 * 1. **seed 同源**：启动时从 game-data.generated 灌库，断言行数（34/37）、默认渠道、
 *    名与价格与客户端配置逐字段一致 —— 运营看到的初始表就是玩家侧数值。
 * 2. **能力边界**：POST / DELETE 路由不存在（404），改不存在的等级 → 404 + 专属业务码；
 *    参数越界（渠道枚举外 / 负价格 / min>max）→ 400。
 * 3. **改了真生效**：PATCH 部分更新后 GET 反映；渠道筛选跟着变；观察员可读不可写。
 *
 * 用法：npm run test:e2e:game-config（前置 npm run build）
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const ADMIN_CODE = "gamecfgadmin-code";

// seed 的源头（编译产物）——断言「库里就是客户端配置」要用它对照
const shared = require(path.join(SERVER_DIR, "dist", "shared", "game-data.generated.js"));

//#region 断言小工具（与其余几套同一骨架）

const EXPECTED_ASSERTIONS = 64;

function assertExpectedCount(passedCount, failureCount) {
  if (failureCount !== 0) return;
  if (passedCount === EXPECTED_ASSERTIONS) return;
  console.log(`\n❌ 断言条数变了：期望 ${EXPECTED_ASSERTIONS}，实际 ${passedCount}`);
  console.log("   改了断言就同步这个常量，以及文档里的 e2e 总数（README.md / docs/resume.md；make audit 会比对）");
  process.exit(1);
}

let passed = 0;
let failed = 0;
const failures = [];

function group(title) {
  console.log(`\n▶ ${title}`);
}

function check(condition, label) {
  if (condition) {
    passed += 1;
    return true;
  }
  failed += 1;
  failures.push(label);
  console.log(`  ✗ ${label}`);
  return false;
}

function checkEqual(actual, expected, label) {
  return check(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}

//#endregion

/** 取一个空闲端口 */
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

/** 起一台服务并等它就绪 */
async function startServer(env) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ENTRY], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      API_PREFIX: "api",
      DB_PATH: ":memory:",
      JWT_SECRET: "e2e-gamecfg-secret",
      JWT_EXPIRES_IN: "1h",
      ADMIN_REGISTER_CODE: ADMIN_CODE,
      LOG_REQUESTS: "false",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverErrors = [];
  child.stderr.on("data", (chunk) => serverErrors.push(String(chunk)));

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务进程提前退出（code=${child.exitCode}）\n${serverErrors.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return { baseUrl, kill: () => child.kill("SIGTERM") };
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("等待服务启动超时");
}

/** 发一次请求，返回 { status, body }（body 是唯一包裹体） */
async function api(baseUrl, method, route, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}${route}`, {
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

/** 注册并登录一个管理员，返回 token（第一个注册者自动是超级管理员） */
async function registerAdmin(baseUrl, username, password) {
  const login = await api(baseUrl, "POST", "/api/admin/auth/login", { body: { username, password } });
  if (login.body?.data?.token) return login.body.data.token;
  const registered = await api(baseUrl, "POST", "/api/admin/auth/register", {
    body: { username, password, registerCode: ADMIN_CODE },
  });
  check(Boolean(registered.body?.data), `注册管理员 ${username}`);
  const retry = await api(baseUrl, "POST", "/api/admin/auth/login", { body: { username, password } });
  check(Boolean(retry.body?.data?.token), `登录管理员 ${username}`);
  return retry.body?.data?.token;
}

//#region 主流程

async function main() {
  const server = await startServer({});
  try {
    const base = server.baseUrl;
    const token = await registerAdmin(base, "gamecfgadmin", "GameCfg#1");
    check(Boolean(token), "管理员注册并登录成功（第一个注册者是超级管理员）");

    //#region 一、seed 同源：启动灌库后的初始表 = 客户端配置

    group("一、seed 同源：初始表来自 game-data.generated");

    const titles = await api(base, "GET", "/api/admin/titles", { token });
    checkEqual(titles.status, 200, "称号列表可读");
    checkEqual(titles.body?.data?.total, Object.keys(shared.TITLE_LEVEL_META).length, `称号行数 = 配置表（${Object.keys(shared.TITLE_LEVEL_META).length}）`);
    checkEqual(titles.body?.data?.list?.length, Object.keys(shared.TITLE_LEVEL_META).length, "默认一页装下全部称号");

    const firstTitle = titles.body?.data?.list?.[0];
    checkEqual(firstTitle?.level, 1, "首行是 1 级");
    checkEqual(firstTitle?.label, shared.TITLE_LABELS["0"], "1 级称号名与配置一致");
    checkEqual(firstTitle?.bindGold, shared.TITLE_LEVEL_META[0].bindGold, "1 级升级价格与配置一致");
    checkEqual(firstTitle?.acquireChannel, "unavailable", "初始渠道默认「无法获取」");
    checkEqual(
      titles.body?.data?.list?.filter((item) => item.acquireChannel === "unavailable").length,
      Object.keys(shared.TITLE_LEVEL_META).length,
      "seed 后全部称号都是无法获取（运营逐个开放）",
    );

    const souls = await api(base, "GET", "/api/admin/souls", { token });
    checkEqual(souls.status, 200, "战魂列表可读");
    checkEqual(souls.body?.data?.total, Object.keys(shared.SOUL_LEVEL_META).length, `战魂行数 = 配置表（${Object.keys(shared.SOUL_LEVEL_META).length}）`);
    checkEqual(souls.body?.data?.list?.[0]?.label, shared.SOUL_LABELS["0"], "1 阶战魂名与配置一致");
    check(Boolean(souls.body?.data?.list?.[0]?.attributes?.maxHp !== undefined), "战魂属性以嵌套结构返回");

    const titled = await api(base, "GET", `/api/admin/titles?keyword=${encodeURIComponent(shared.TITLE_LABELS["0"])}`, { token });
    checkEqual(titled.body?.data?.total, 1, "关键字能命中对应称号");

    //#endregion

    //#region 二、能力边界：只许改，不许增删

    group("二、能力边界：没有创建 / 删除");

    const postTitle = await api(base, "POST", "/api/admin/titles", { token, body: { label: "新称号" } });
    checkEqual(postTitle.status, 404, "POST 称号 → 404（路由不存在）");
    const deleteTitle = await api(base, "DELETE", "/api/admin/titles/1", { token });
    checkEqual(deleteTitle.status, 404, "DELETE 称号 → 404（路由不存在）");
    const postSoul = await api(base, "POST", "/api/admin/souls", { token, body: { label: "新战魂" } });
    checkEqual(postSoul.status, 404, "POST 战魂 → 404（路由不存在）");
    const deleteSoul = await api(base, "DELETE", "/api/admin/souls/1", { token });
    checkEqual(deleteSoul.status, 404, "DELETE 战魂 → 404（路由不存在）");

    const ghostTitle = await api(base, "PATCH", "/api/admin/titles/99", { token, body: { label: "x" } });
    checkEqual(ghostTitle.status, 404, "改不存在的称号等级 → 404");
    checkEqual(ghostTitle.body?.code, 50010, "称号未找到用专属业务码 50010");
    const ghostSoul = await api(base, "PATCH", "/api/admin/souls/99", { token, body: { label: "x" } });
    checkEqual(ghostSoul.status, 404, "改不存在的战魂阶数 → 404");
    checkEqual(ghostSoul.body?.code, 50011, "战魂未找到用专属业务码 50011");

    const badChannel = await api(base, "PATCH", "/api/admin/titles/1", { token, body: { acquireChannel: "free" } });
    checkEqual(badChannel.status, 400, "渠道枚举外 → 400");
    const negativeGold = await api(base, "PATCH", "/api/admin/titles/1", { token, body: { bindGold: -1 } });
    checkEqual(negativeGold.status, 400, "负升级价格 → 400");
    const badFrameRate = await api(base, "PATCH", "/api/admin/souls/1", { token, body: { animationFrameRate: 0 } });
    checkEqual(badFrameRate.status, 400, "帧率 0 → 400");
    const crossedRange = await api(base, "PATCH", "/api/admin/titles/1", {
      token,
      body: { attributes: { ...firstTitle.attributes, physicalAttack: { min: 10, max: 5 } } },
    });
    checkEqual(crossedRange.status, 400, "属性 min > max → 400（跨字段校验在服务端）");
    checkEqual(crossedRange.body?.code, 40000, "参数越界用 40000");

    //#endregion

    //#region 三、改了真生效：部分更新 + 渠道筛选 + 观察员权限

    group("三、更新生效与权限");

    const priced = await api(base, "PATCH", "/api/admin/titles/1", { token, body: { bindGold: 12345, acquireChannel: "upgrade" } });
    checkEqual(priced.status, 200, "PATCH 称号价格与渠道成功");
    checkEqual(priced.body?.data?.bindGold, 12345, "响应里的价格已更新");
    checkEqual(priced.body?.data?.acquireChannel, "upgrade", "响应里的渠道已更新");
    checkEqual(priced.body?.data?.label, firstTitle.label, "部分更新不动其他字段");

    const relabeled = await api(base, "PATCH", "/api/admin/titles/1", { token, body: { label: "初出茅庐·改" } });
    checkEqual(relabeled.body?.data?.label, "初出茅庐·改", "只改名称也生效");
    checkEqual(relabeled.body?.data?.bindGold, 12345, "上次改的价格保留（合并语义）");

    const upgraded = await api(base, "GET", "/api/admin/titles?acquireChannel=upgrade", { token });
    checkEqual(upgraded.body?.data?.total, 1, "按渠道筛选：upgrade 只有刚改的那条");
    const unavailable = await api(base, "GET", "/api/admin/titles?acquireChannel=unavailable", { token });
    checkEqual(unavailable.body?.data?.total, Object.keys(shared.TITLE_LEVEL_META).length - 1, "其余称号仍在无法获取里");

    const soulPriced = await api(base, "PATCH", "/api/admin/souls/1", { token, body: { bindGold: 888 } });
    checkEqual(soulPriced.body?.data?.bindGold, 888, "PATCH 战魂消耗生效");

    const attrs = priced.body?.data?.attributes;
    const attrPatched = await api(base, "PATCH", "/api/admin/titles/1", {
      token,
      body: { attributes: { ...attrs, maxHp: attrs.maxHp + 7 } },
    });
    checkEqual(attrPatched.body?.data?.attributes?.maxHp, attrs.maxHp + 7, "属性整份替换生效");

    // 观察员：能看不能改
    const viewerRegister = await api(base, "POST", "/api/admin/auth/register", {
      body: { username: "gamecfgviewer", password: "Viewer#12", registerCode: ADMIN_CODE },
    });
    check(Boolean(viewerRegister.body?.data), "注册观察员");
    const adminList = await api(base, "GET", "/api/admin/admins", { token });
    const viewerId = adminList.body?.data?.list?.find((item) => item.username === "gamecfgviewer")?.id;
    const roleSet = await api(base, "PATCH", `/api/admin/admins/${viewerId}`, { token, body: { role: "viewer" } });
    checkEqual(roleSet.status, 200, "观察员角色就位");
    const viewerLogin = await api(base, "POST", "/api/admin/auth/login", { body: { username: "gamecfgviewer", password: "Viewer#12" } });
    const viewerToken = viewerLogin.body?.data?.token;

    const viewerRead = await api(base, "GET", "/api/admin/titles", { token: viewerToken });
    checkEqual(viewerRead.body?.code, 0, "观察员能看称号配置");
    const viewerWrite = await api(base, "PATCH", "/api/admin/titles/1", { token: viewerToken, body: { bindGold: 1 } });
    checkEqual(viewerWrite.status, 403, "观察员改配置 → 403");
    checkEqual(viewerWrite.body?.code, 30006, "观察员改配置 → 30006（权限点不足）");

    //#endregion

    //#region 四、称号成长列表：upgrade 渠道进出 + 拖动排序（整串重排）

    group("四、称号成长列表");

    // 上文三已把 1 级改成 upgrade：它应已在成长列表里，序号 1
    const upgradeList1 = await api(base, "GET", "/api/admin/titles/upgrade-list", { token });
    checkEqual(upgradeList1.status, 200, "成长列表可读");
    checkEqual(JSON.stringify(upgradeList1.body?.data?.map((item) => item.level)), JSON.stringify([1]), "渠道改为 upgrade 的称号已在成长列表");
    checkEqual(upgradeList1.body?.data?.[0]?.upgradeOrder, 1, "首位序号从 1 起");

    const joinSecond = await api(base, "PATCH", "/api/admin/titles/3", { token, body: { acquireChannel: "upgrade" } });
    checkEqual(joinSecond.body?.data?.upgradeOrder, 2, "后加入的称号追加到列表尾（3 级 → 序号 2）");
    const joinThird = await api(base, "PATCH", "/api/admin/titles/2", { token, body: { acquireChannel: "upgrade" } });
    checkEqual(joinThird.body?.data?.upgradeOrder, 3, "2 级追加到列表尾（序号 3）");

    const reordered = await api(base, "PATCH", "/api/admin/titles/upgrade-order", { token, body: { levels: [2, 1, 3] } });
    checkEqual(reordered.status, 200, "整串重排成功");
    checkEqual(JSON.stringify(reordered.body?.data?.map((item) => item.level)), JSON.stringify([2, 1, 3]), "重排后成长列表按新顺序返回（与等级号无关）");
    checkEqual(JSON.stringify(reordered.body?.data?.map((item) => item.upgradeOrder)), JSON.stringify([1, 2, 3]), "重排后序号连续（1 起无空洞）");

    const dupOrder = await api(base, "PATCH", "/api/admin/titles/upgrade-order", { token, body: { levels: [2, 2, 3] } });
    checkEqual(dupOrder.status, 400, "重排带重复等级 → 400");
    const missingOrder = await api(base, "PATCH", "/api/admin/titles/upgrade-order", { token, body: { levels: [2, 1] } });
    checkEqual(missingOrder.status, 400, "重排漏了列表里的等级 → 400");
    const extraOrder = await api(base, "PATCH", "/api/admin/titles/upgrade-order", { token, body: { levels: [2, 1, 3, 4] } });
    checkEqual(extraOrder.status, 400, "重排混入不在列表的等级 → 400");

    // 切走：移出成长列表、序号清空，升级价格保留
    const leaveList = await api(base, "PATCH", "/api/admin/titles/2", { token, body: { acquireChannel: "unavailable" } });
    checkEqual(leaveList.status, 200, "渠道切走成功");
    checkEqual(leaveList.body?.data?.upgradeOrder, null, "切走后序号清空");
    const afterLeave = await api(base, "GET", "/api/admin/titles/upgrade-list", { token });
    checkEqual(JSON.stringify(afterLeave.body?.data?.map((item) => item.level)), JSON.stringify([1, 3]), "切走后成长列表少一行");
    const keptPrice = (await api(base, "GET", "/api/admin/titles?acquireChannel=unavailable", { token })).body?.data?.list?.find(
      (item) => item.level === 2,
    );
    checkEqual(keptPrice?.bindGold, shared.TITLE_LEVEL_META[1].bindGold, "切走后升级价格保留（不受进出列表影响）");

    // 再切回来：追加到尾（不恢复旧序号；序号允许留空洞，只保证相对顺序）
    const rejoin = await api(base, "PATCH", "/api/admin/titles/2", { token, body: { acquireChannel: "upgrade" } });
    checkEqual(rejoin.body?.data?.upgradeOrder, 4, "重新加入的序号 = 当前最大序号 + 1（空洞不复用）");
    const afterRejoin = await api(base, "GET", "/api/admin/titles/upgrade-list", { token });
    checkEqual(JSON.stringify(afterRejoin.body?.data?.map((item) => item.level)), JSON.stringify([1, 3, 2]), "重新加入后列表顺序（追加到尾，不恢复旧位置）");

    // 观察员：能看列表，不能重排
    const viewerUpgradeRead = await api(base, "GET", "/api/admin/titles/upgrade-list", { token: viewerToken });
    checkEqual(viewerUpgradeRead.body?.code, 0, "观察员能看成长列表");
    const viewerReorder = await api(base, "PATCH", "/api/admin/titles/upgrade-order", { token: viewerToken, body: { levels: [1, 3, 2] } });
    checkEqual(viewerReorder.status, 403, "观察员重排 → 403");
    checkEqual(viewerReorder.body?.code, 30006, "观察员重排 → 30006（权限点不足）");

    //#endregion
  } finally {
    server.kill();
  }

  console.log(`\n===== 养成配置 e2e：${passed} 通过 / ${failed} 失败 =====`);
  assertExpectedCount(passed, failed);
  if (failed > 0) {
    failures.forEach((label) => console.log(`  ✗ ${label}`));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
