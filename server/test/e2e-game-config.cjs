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

const EXPECTED_ASSERTIONS = 196;

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

    //#region 五、战魂成长列表：全量 37 阶 + 拖动排序（整串重排）

    group("五、战魂成长列表");

    const soulLevels = Array.from({ length: Object.keys(shared.SOUL_LEVEL_META).length }, (_, index) => index + 1);

    // seed 后全量在列表里，初值顺序 = 阶数
    const soulUpgrade1 = await api(base, "GET", "/api/admin/souls/upgrade-list", { token });
    checkEqual(soulUpgrade1.status, 200, "战魂成长列表可读");
    checkEqual(
      JSON.stringify(soulUpgrade1.body?.data?.map((item) => item.level)),
      JSON.stringify(soulLevels),
      "seed 后 37 阶全量在成长列表（顺序 = 阶数）",
    );
    checkEqual(JSON.stringify(soulUpgrade1.body?.data?.map((item) => item.upgradeOrder)), JSON.stringify(soulLevels), "初值序号 = 阶数");

    // 整串重排（与阶数解耦）：前三位换 [2,1,3]，其余不动
    const soulReordered = await api(base, "PATCH", "/api/admin/souls/upgrade-order", {
      token,
      body: { levels: [2, 1, 3, ...soulLevels.slice(3)] },
    });
    checkEqual(soulReordered.status, 200, "整串重排成功");
    checkEqual(
      JSON.stringify(soulReordered.body?.data?.map((item) => item.level)),
      JSON.stringify([2, 1, 3, ...soulLevels.slice(3)]),
      "重排后成长列表按新顺序返回（与阶数无关）",
    );
    checkEqual(
      JSON.stringify(soulReordered.body?.data?.map((item) => item.upgradeOrder)),
      JSON.stringify(soulLevels),
      "重排后序号连续（1 起无空洞）",
    );

    const soulDup = await api(base, "PATCH", "/api/admin/souls/upgrade-order", { token, body: { levels: [2, 2, ...soulLevels.slice(2)] } });
    checkEqual(soulDup.status, 400, "重排带重复阶数 → 400");
    const soulMissing = await api(base, "PATCH", "/api/admin/souls/upgrade-order", { token, body: { levels: soulLevels.slice(1) } });
    checkEqual(soulMissing.status, 400, "重排漏了阶数 → 400");
    const soulExtra = await api(base, "PATCH", "/api/admin/souls/upgrade-order", { token, body: { levels: [...soulLevels, 99] } });
    checkEqual(soulExtra.status, 400, "重排混入不存在的阶数 → 400");

    // 成长列表与主列表同源：上文三改过的 1 阶消耗（888）在这里能看到
    const soulPriceSeen = soulReordered.body?.data?.find((item) => item.level === 1);
    checkEqual(soulPriceSeen?.bindGold, 888, "成长列表里的消耗与主列表一致（行内改价走同一份 bindGold）");

    // 观察员：能看列表，不能重排
    const viewerSoulRead = await api(base, "GET", "/api/admin/souls/upgrade-list", { token: viewerToken });
    checkEqual(viewerSoulRead.body?.code, 0, "观察员能看战魂成长列表");
    const viewerSoulReorder = await api(base, "PATCH", "/api/admin/souls/upgrade-order", { token: viewerToken, body: { levels: soulLevels } });
    checkEqual(viewerSoulReorder.status, 403, "观察员重排战魂 → 403");
    checkEqual(viewerSoulReorder.body?.code, 30006, "观察员重排战魂 → 30006（权限点不足）");

    //#endregion

    //#region 六、成长曲线（#256）：等级经验 / 曲线分段 / 标量参数

    group("六、成长曲线：等级经验");

    const levelExps = await api(base, "GET", "/api/admin/level-exps", { token });
    checkEqual(levelExps.status, 200, "升级经验列表可读");
    const levelCount = Object.keys(shared.ROLE_LEVEL_ATTRIBUTES).length;
    checkEqual(levelExps.body?.data?.total, levelCount, `升级经验行数 = 等级上限（${levelCount}）`);
    const firstExp = levelExps.body?.data?.list?.[0];
    checkEqual(firstExp?.level, 1, "首行是 1 级");
    checkEqual(firstExp?.exp, shared.ROLE_LEVEL_ATTRIBUTES["1"].exp, "1 级经验与配置一致");

    const expPatched = await api(base, "PATCH", "/api/admin/level-exps/1", { token, body: { exp: 999 } });
    checkEqual(expPatched.status, 200, "PATCH 升级经验成功");
    checkEqual(expPatched.body?.data?.exp, 999, "响应里的经验已更新");
    const expGhost = await api(base, "PATCH", "/api/admin/level-exps/999", { token, body: { exp: 1 } });
    checkEqual(expGhost.status, 404, "改不存在的等级经验 → 404");
    checkEqual(expGhost.body?.code, 50012, "等级经验未找到用专属业务码 50012");
    const expZero = await api(base, "PATCH", "/api/admin/level-exps/1", { token, body: { exp: 0 } });
    checkEqual(expZero.status, 400, "经验 0 → 400（永远升不上去）");
    const postExp = await api(base, "POST", "/api/admin/level-exps", { token, body: { level: 61, exp: 1 } });
    checkEqual(postExp.status, 404, "POST 升级经验 → 404（路由不存在）");
    const deleteExp = await api(base, "DELETE", "/api/admin/level-exps/1", { token });
    checkEqual(deleteExp.status, 404, "DELETE 升级经验 → 404（路由不存在）");
    const viewerExpRead = await api(base, "GET", "/api/admin/level-exps", { token: viewerToken });
    checkEqual(viewerExpRead.body?.code, 0, "观察员能看升级经验");
    const viewerExpWrite = await api(base, "PATCH", "/api/admin/level-exps/1", { token: viewerToken, body: { exp: 1 } });
    checkEqual(viewerExpWrite.status, 403, "观察员改升级经验 → 403");
    checkEqual(viewerExpWrite.body?.code, 30006, "观察员改升级经验 → 30006（权限点不足）");

    group("六、成长曲线：分段");

    const segmentsAll = await api(base, "GET", "/api/admin/growth-segments", { token });
    checkEqual(segmentsAll.status, 200, "曲线分段列表可读");
    const curveKeys = Object.keys(shared.GROWTH_CURVES);
    const segmentTotal = curveKeys.reduce((sum, key) => sum + shared.GROWTH_CURVES[key].length, 0);
    checkEqual(segmentsAll.body?.data?.total, segmentTotal, `分段行数 = 曲线段总和（${segmentTotal}）`);
    const segmentsMaxHp = await api(base, "GET", "/api/admin/growth-segments?curve=maxHp", { token });
    checkEqual(segmentsMaxHp.body?.data?.list?.[0]?.fromLevel, 1, "首段从 1 级开始（连续覆盖）");
    const badCurve = await api(base, "GET", "/api/admin/growth-segments?curve=mp", { token });
    checkEqual(badCurve.status, 400, "曲线键枚举外筛选 → 400");

    const seg1 = segmentsMaxHp.body?.data?.list?.[0];
    const seg6 = segmentsMaxHp.body?.data?.list?.find((item) => item.seq === 6);
    const segBreakFirst = await api(base, "PATCH", "/api/admin/growth-segments/maxHp/1", {
      token,
      body: { fromLevel: 2, toLevel: seg1.toLevel, startValue: seg1.startValue, perLevel: seg1.perLevel },
    });
    checkEqual(segBreakFirst.status, 400, "首段 from 改成 2 → 400（必须从 1 连续覆盖）");
    const segBreakLast = await api(base, "PATCH", "/api/admin/growth-segments/maxHp/6", {
      token,
      body: { fromLevel: seg6.fromLevel, toLevel: seg6.toLevel - 1, startValue: seg6.startValue, perLevel: seg6.perLevel },
    });
    checkEqual(segBreakLast.status, 400, "末段 to 少 1 级 → 400（必须覆盖到 roleMaxLevel）");
    const segOk = await api(base, "PATCH", "/api/admin/growth-segments/maxHp/1", {
      token,
      body: { fromLevel: 1, toLevel: seg1.toLevel, startValue: 120, perLevel: seg1.perLevel },
    });
    checkEqual(segOk.status, 200, "合法的分段修改成功");
    checkEqual(segOk.body?.data?.startValue, 120, "响应里的起始值已更新");
    const segGhost = await api(base, "PATCH", "/api/admin/growth-segments/mp/1", {
      token,
      body: { fromLevel: 1, toLevel: 10, startValue: 1, perLevel: 1 },
    });
    checkEqual(segGhost.status, 404, "改不存在的曲线 → 404");
    checkEqual(segGhost.body?.code, 50013, "曲线分段未找到用专属业务码 50013");
    const segPartial = await api(base, "PATCH", "/api/admin/growth-segments/maxHp/1", { token, body: { startValue: 130 } });
    checkEqual(segPartial.status, 400, "分段部分提交 → 400（四个字段整份提交）");
    const viewerSegWrite = await api(base, "PATCH", "/api/admin/growth-segments/maxHp/1", {
      token: viewerToken,
      body: { fromLevel: 1, toLevel: 10, startValue: 1, perLevel: 1 },
    });
    checkEqual(viewerSegWrite.status, 403, "观察员改曲线 → 403");
    checkEqual(viewerSegWrite.body?.code, 30006, "观察员改曲线 → 30006（权限点不足）");

    group("六、成长曲线：标量参数");

    const scalars = await api(base, "GET", "/api/admin/growth-scalars", { token });
    checkEqual(scalars.status, 200, "标量参数列表可读");
    checkEqual(scalars.body?.data?.total, Object.keys(shared.GROWTH_SCALARS).length, `标量参数行数 = 配置（${Object.keys(shared.GROWTH_SCALARS).length}）`);
    const maxLevelRow = scalars.body?.data?.list?.find((item) => item.key === "roleMaxLevel");
    checkEqual(maxLevelRow?.value, shared.GROWTH_SCALARS["roleMaxLevel"], "等级上限初值与配置一致");
    check(Boolean(maxLevelRow?.description), "每个标量参数都带说明");

    const ratePatched = await api(base, "PATCH", "/api/admin/growth-scalars/attributeRange.minRate", { token, body: { value: 0.8 } });
    checkEqual(ratePatched.status, 200, "PATCH 比率参数成功");
    checkEqual(ratePatched.body?.data?.value, 0.8, "响应里的比率已更新");
    const rateOver = await api(base, "PATCH", "/api/admin/growth-scalars/attributeRange.minRate", { token, body: { value: 1.5 } });
    checkEqual(rateOver.status, 400, "比率超出取值域（>1）→ 400");
    const rateFraction = await api(base, "PATCH", "/api/admin/growth-scalars/expGain.expPerLevel", { token, body: { value: 5.5 } });
    checkEqual(rateFraction.status, 400, "整数参数传小数 → 400");
    const maxLevelJump = await api(base, "PATCH", "/api/admin/growth-scalars/roleMaxLevel", { token, body: { value: 61 } });
    checkEqual(maxLevelJump.status, 400, "抬等级上限但曲线末段没跟上 → 400（跨表校验）");
    const scalarGhost = await api(base, "PATCH", "/api/admin/growth-scalars/nope", { token, body: { value: 1 } });
    checkEqual(scalarGhost.status, 404, "改不存在的参数键 → 404");
    checkEqual(scalarGhost.body?.code, 50014, "标量参数未找到用专属业务码 50014");
    const scalarKeyword = await api(base, "GET", "/api/admin/growth-scalars?keyword=minRate", { token });
    checkEqual(scalarKeyword.body?.data?.total, 1, "关键字能命中对应参数");
    const viewerScalarWrite = await api(base, "PATCH", "/api/admin/growth-scalars/roleMaxLevel", { token: viewerToken, body: { value: 50 } });
    checkEqual(viewerScalarWrite.status, 403, "观察员改标量参数 → 403");
    checkEqual(viewerScalarWrite.body?.code, 30006, "观察员改标量参数 → 30006（权限点不足）");

    //#endregion

    //#region 七、军衔配置（#250）：seed 同源 / 大段筛 / 只许改 / 无成长列表重排

    group("七、军衔配置");

    const ranks = await api(base, "GET", "/api/admin/ranks", { token });
    checkEqual(ranks.status, 200, "军衔列表可读");
    const rankCount = Object.keys(shared.RANK_LEVEL_META).length;
    checkEqual(ranks.body?.data?.total, rankCount, `军衔行数 = 配置表（${rankCount}）`);
    checkEqual(ranks.body?.data?.list?.length, 100, "默认一页装下全部军衔");
    const firstRank = ranks.body?.data?.list?.[0];
    checkEqual(firstRank?.level, 1, "首行是 1 阶");
    checkEqual(firstRank?.label, shared.RANK_LABELS["0"].label, "1 阶衔名与配置一致");
    checkEqual(firstRank?.tier, shared.RANK_LABELS["0"].tier, "1 阶大段名与配置一致");
    checkEqual(firstRank?.bindGold, shared.RANK_LEVEL_META[0].bindGold, "1 阶晋升价格与配置一致");
    check(Boolean(firstRank?.attributes?.maxHp !== undefined), "军衔属性以嵌套结构返回");
    checkEqual(firstRank?.animation, undefined, "军衔没有动画字段（外观是头顶一行红字）");

    const rankTierFiltered = await api(base, "GET", `/api/admin/ranks?tier=${encodeURIComponent(shared.RANK_LABELS["0"].tier)}`, { token });
    checkEqual(rankTierFiltered.body?.data?.total, 10, "按大段筛：每段恰好 10 阶");

    const rankPriced = await api(base, "PATCH", "/api/admin/ranks/1", { token, body: { bindGold: 500 } });
    checkEqual(rankPriced.status, 200, "PATCH 军衔晋升价格成功");
    checkEqual(rankPriced.body?.data?.bindGold, 500, "响应里的价格已更新");
    const rankGhost = await api(base, "PATCH", "/api/admin/ranks/101", { token, body: { label: "x" } });
    checkEqual(rankGhost.status, 404, "改不存在的军衔阶数 → 404");
    checkEqual(rankGhost.body?.code, 50015, "军衔未找到用专属业务码 50015");
    const postRank = await api(base, "POST", "/api/admin/ranks", { token, body: { label: "新军衔" } });
    checkEqual(postRank.status, 404, "POST 军衔 → 404（路由不存在）");
    const deleteRank = await api(base, "DELETE", "/api/admin/ranks/1", { token });
    checkEqual(deleteRank.status, 404, "DELETE 军衔 → 404（路由不存在）");
    const rankUpgradeList = await api(base, "GET", "/api/admin/ranks/upgrade-list", { token });
    checkEqual(rankUpgradeList.status, 404, "军衔没有成长列表接口（顺序天然按阶，不需要重排）");
    const viewerRankRead = await api(base, "GET", "/api/admin/ranks", { token: viewerToken });
    checkEqual(viewerRankRead.body?.code, 0, "观察员能看军衔配置");
    const viewerRankWrite = await api(base, "PATCH", "/api/admin/ranks/1", { token: viewerToken, body: { bindGold: 1 } });
    checkEqual(viewerRankWrite.status, 403, "观察员改军衔 → 403");
    checkEqual(viewerRankWrite.body?.code, 30006, "观察员改军衔 → 30006（权限点不足）");

    //#endregion

    //#region 八、装备基础件配置（#252）：seed 同源 / 部位与等级段筛 / 只许改 / 变体不进管理端

    group("八、装备基础件配置");

    const equipments = await api(base, "GET", "/api/admin/equipments", { token });
    checkEqual(equipments.status, 200, "装备列表可读");
    const equipmentCount = Object.keys(shared.EQUIPMENT_BASES).length;
    checkEqual(equipments.body?.data?.total, equipmentCount, `装备行数 = 基础件配置表（${equipmentCount}）`);
    checkEqual(equipments.body?.data?.list?.length, equipmentCount, "默认一页装下全部基础件");
    const cloth14 = equipments.body?.data?.list?.find((row) => row.id === "cloth_14");
    check(Boolean(cloth14), "列表里有基础件 cloth_14");
    checkEqual(cloth14?.slot, shared.EQUIPMENT_BASES["cloth_14"].slot, "cloth_14 部位与配置一致");
    checkEqual(cloth14?.level, shared.EQUIPMENT_BASES["cloth_14"].level, "cloth_14 等级需求与配置一致");
    checkEqual(cloth14?.label, shared.EQUIPMENT_BASES["cloth_14"].label, "cloth_14 名称与配置一致");
    checkEqual(cloth14?.sellPrice, shared.EQUIPMENT_BASES["cloth_14"].sellPrice, "cloth_14 售卖价与配置一致");
    checkEqual(cloth14?.attributes?.maxHp, shared.EQUIPMENT_BASES["cloth_14"].attributes.maxHp, "cloth_14 属性与配置一致（嵌套结构）");
    check(cloth14 && !cloth14.id.includes("_p"), "管理端只收基础件（变体 _pXsY 不进列表）");

    const clothSlotCount = Object.values(shared.EQUIPMENT_BASES).filter((base) => base.slot === "cloth").length;
    const equipmentSlotFiltered = await api(base, "GET", "/api/admin/equipments?slot=cloth", { token });
    checkEqual(equipmentSlotFiltered.body?.data?.total, clothSlotCount, `按部位筛：cloth 恰好 ${clothSlotCount} 件`);
    const levelBandCount = Object.values(shared.EQUIPMENT_BASES).filter((base) => base.level >= 40 && base.level <= 50).length;
    const equipmentBandFiltered = await api(base, "GET", "/api/admin/equipments?minLevel=40&maxLevel=50", { token });
    checkEqual(equipmentBandFiltered.body?.data?.total, levelBandCount, `按等级段筛（40..50 含端）：恰好 ${levelBandCount} 件`);
    const equipmentKeyword = await api(base, "GET", "/api/admin/equipments?keyword=" + encodeURIComponent("青铜"), { token });
    checkEqual(equipmentKeyword.body?.data?.total, 1, "关键字能命中名称（青铜重甲）");

    const equipmentPriced = await api(base, "PATCH", "/api/admin/equipments/cloth_14", { token, body: { sellPrice: 100 } });
    checkEqual(equipmentPriced.status, 200, "PATCH 装备售卖价成功");
    checkEqual(equipmentPriced.body?.data?.sellPrice, 100, "响应里的售卖价已更新");
    const equipmentReread = await api(base, "GET", "/api/admin/equipments?keyword=cloth_14", { token });
    checkEqual(equipmentReread.body?.data?.list?.[0]?.sellPrice, 100, "重读反映新售卖价");

    const equipmentBadRange = await api(base, "PATCH", "/api/admin/equipments/cloth_14", {
      token,
      body: { attributes: { ...cloth14.attributes, physicalAttack: { min: 10, max: 5 } } },
    });
    checkEqual(equipmentBadRange.status, 400, "属性下限大于上限 → 400");
    checkEqual(equipmentBadRange.body?.code, 40000, "属性区间校验用 40000（参数非法）");
    const equipmentGhost = await api(base, "PATCH", "/api/admin/equipments/cloth_999", { token, body: { level: 1 } });
    checkEqual(equipmentGhost.status, 404, "改不存在的装备基础件 → 404");
    checkEqual(equipmentGhost.body?.code, 50016, "装备未找到用专属业务码 50016");
    const equipmentStructural = await api(base, "PATCH", "/api/admin/equipments/cloth_14", { token, body: { slot: "weapon", label: "改名尝试" } });
    checkEqual(equipmentStructural.status, 200, "PATCH 结构字段不报错（白名单剥离）");
    checkEqual(equipmentStructural.body?.data?.slot, "cloth", "slot 不可编辑（部位结构固定）");
    checkEqual(equipmentStructural.body?.data?.label, shared.EQUIPMENT_BASES["cloth_14"].label, "label 不可编辑");
    const postEquipment = await api(base, "POST", "/api/admin/equipments", { token, body: { id: "cloth_new" } });
    checkEqual(postEquipment.status, 404, "POST 装备 → 404（路由不存在）");
    const deleteEquipment = await api(base, "DELETE", "/api/admin/equipments/cloth_14", { token });
    checkEqual(deleteEquipment.status, 404, "DELETE 装备 → 404（路由不存在）");
    const viewerEquipmentRead = await api(base, "GET", "/api/admin/equipments", { token: viewerToken });
    checkEqual(viewerEquipmentRead.body?.code, 0, "观察员能看装备配置");
    const viewerEquipmentWrite = await api(base, "PATCH", "/api/admin/equipments/cloth_14", { token: viewerToken, body: { sellPrice: 1 } });
    checkEqual(viewerEquipmentWrite.status, 403, "观察员改装备 → 403");
    checkEqual(viewerEquipmentWrite.body?.code, 30006, "观察员改装备 → 30006（权限点不足）");

    //#endregion

    //#region 九、药品配置（#253）：seed 同源 / keyword 筛 / 只许改 / 百分比上限

    group("九、药品配置");

    const drugs = await api(base, "GET", "/api/admin/drugs", { token });
    checkEqual(drugs.status, 200, "药品列表可读");
    const drugCount = Object.keys(shared.DRUGS).length;
    checkEqual(drugs.body?.data?.total, drugCount, `药品行数 = 配置表（${drugCount}）`);
    checkEqual(drugs.body?.data?.list?.length, drugCount, "默认一页装下全部药品");
    const drugHp1 = drugs.body?.data?.list?.find((row) => row.id === "drug_hp_1");
    check(Boolean(drugHp1), "列表里有药品 drug_hp_1");
    checkEqual(drugHp1?.label, shared.DRUGS["drug_hp_1"].label, "drug_hp_1 名称与配置一致");
    checkEqual(drugHp1?.sellPrice, shared.DRUGS["drug_hp_1"].sellPrice, "drug_hp_1 售卖价与配置一致");
    checkEqual(drugHp1?.effectHp, shared.DRUGS["drug_hp_1"].hp, "drug_hp_1 固定回复量与配置一致（effects 求和）");
    checkEqual(drugHp1?.maxStack, shared.DRUGS["drug_hp_1"].maxStack, "drug_hp_1 堆叠上限与配置一致");
    checkEqual(drugHp1?.cooldown, shared.DRUGS["drug_hp_1"].cooldown, "drug_hp_1 冷却与配置一致");
    const drugSun = drugs.body?.data?.list?.find((row) => row.id === "drug_sun");
    checkEqual(drugSun?.effectHp, shared.DRUGS["drug_sun"].hp, "drug_sun 固定回血与配置一致");
    checkEqual(drugSun?.effectMp, shared.DRUGS["drug_sun"].mp, "drug_sun 固定回蓝与配置一致");
    const drugPct = drugs.body?.data?.list?.find((row) => row.id === "drug_hp_pct");
    checkEqual(drugPct?.effectHpPercent, shared.DRUGS["drug_hp_pct"].hpPercent, "drug_hp_pct 百分比回复与配置一致");

    const drugKeywordLabel = await api(base, "GET", "/api/admin/drugs?keyword=" + encodeURIComponent("金创"), { token });
    checkEqual(drugKeywordLabel.body?.data?.total, 3, "关键字按名称命中三档金创药");
    const drugKeywordId = await api(base, "GET", "/api/admin/drugs?keyword=drug_mp", { token });
    checkEqual(drugKeywordId.body?.data?.total, 3, "关键字按 id 命中三档蓝药");

    const drugPatched = await api(base, "PATCH", "/api/admin/drugs/drug_hp_1", { token, body: { label: "金创药（小·改）", effectHp: 120, cooldown: 2, maxStack: 999 } });
    checkEqual(drugPatched.status, 200, "PATCH 药品成功（名称/回复量/冷却/堆叠一起改）");
    checkEqual(drugPatched.body?.data?.label, "金创药（小·改）", "响应里的名称已更新");
    checkEqual(drugPatched.body?.data?.effectHp, 120, "响应里的回复量已更新");
    checkEqual(drugPatched.body?.data?.cooldown, 2, "响应里的冷却已更新");
    checkEqual(drugPatched.body?.data?.maxStack, 999, "响应里的堆叠上限已更新");
    const drugBadPercent = await api(base, "PATCH", "/api/admin/drugs/drug_hp_1", { token, body: { effectHpPercent: 120 } });
    checkEqual(drugBadPercent.status, 400, "百分比回复超过 100 → 400");
    checkEqual(drugBadPercent.body?.code, 40000, "百分比校验用 40000（参数非法）");
    const drugGhost = await api(base, "PATCH", "/api/admin/drugs/drug_none", { token, body: { label: "x" } });
    checkEqual(drugGhost.status, 404, "改不存在的药品 → 404");
    checkEqual(drugGhost.body?.code, 50017, "药品未找到用专属业务码 50017");
    const drugStructural = await api(base, "PATCH", "/api/admin/drugs/drug_hp_1", { token, body: { level: 99 } });
    checkEqual(drugStructural.status, 200, "PATCH 结构字段不报错（白名单剥离）");
    checkEqual(drugStructural.body?.data?.level, shared.DRUGS["drug_hp_1"].level, "level 不可编辑（使用等级属客户端定标）");
    const postDrug = await api(base, "POST", "/api/admin/drugs", { token, body: { id: "drug_new" } });
    checkEqual(postDrug.status, 404, "POST 药品 → 404（路由不存在）");
    const deleteDrug = await api(base, "DELETE", "/api/admin/drugs/drug_hp_1", { token });
    checkEqual(deleteDrug.status, 404, "DELETE 药品 → 404（路由不存在）");
    const viewerDrugRead = await api(base, "GET", "/api/admin/drugs", { token: viewerToken });
    checkEqual(viewerDrugRead.body?.code, 0, "观察员能看药品配置");
    const viewerDrugWrite = await api(base, "PATCH", "/api/admin/drugs/drug_hp_1", { token: viewerToken, body: { effectHp: 1 } });
    checkEqual(viewerDrugWrite.status, 403, "观察员改药品 → 403");
    checkEqual(viewerDrugWrite.body?.code, 30006, "观察员改药品 → 30006（权限点不足）");

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
