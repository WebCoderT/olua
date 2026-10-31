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

const EXPECTED_ASSERTIONS = 639;

function assertExpectedCount(passedCount, failureCount) {
  if (failureCount !== 0) return;
  if (passedCount === EXPECTED_ASSERTIONS) return;
  console.log(`\n❌ 断言条数变了：期望 ${EXPECTED_ASSERTIONS}，实际 ${passedCount}`);
  console.log("   改了断言就同步这个常量，以及文档里的 e2e 总数（README.md；make audit 会比对）");
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

    //#region 十、物品与材料配置（#255）：seed 同源 / 大类筛 / 只许改 / 结构字段不可编辑

    group("十、物品与材料配置");

    const items = await api(base, "GET", "/api/admin/items", { token });
    checkEqual(items.status, 200, "物品列表可读");
    const itemCount = Object.keys(shared.ITEM_BASES).length;
    checkEqual(items.body?.data?.total, itemCount, `物品行数 = 配置表（${itemCount}）`);
    checkEqual(items.body?.data?.list?.length, itemCount, "默认一页装下全部物品");
    const hide = items.body?.data?.list?.find((row) => row.id === "material_hide");
    check(Boolean(hide), "列表里有物品 material_hide");
    checkEqual(hide?.type, shared.ITEM_BASES["material_hide"].type, "material_hide 大类与配置一致");
    checkEqual(hide?.label, shared.ITEM_BASES["material_hide"].label, "material_hide 名称与配置一致");
    checkEqual(hide?.sellPrice, shared.ITEM_BASES["material_hide"].sellPrice, "material_hide 售卖价与配置一致");
    checkEqual(hide?.maxStack, shared.ITEM_BASES["material_hide"].maxStack, "material_hide 堆叠上限与配置一致");

    const itemsTyped = await api(base, "GET", "/api/admin/items?type=material", { token });
    checkEqual(itemsTyped.body?.data?.total, itemCount, "按大类筛 material：恰好全部物品");
    const itemsOther = await api(base, "GET", "/api/admin/items?type=other", { token });
    checkEqual(itemsOther.body?.data?.total, 0, "other 大类当前无条目（合法筛选，空列表）");
    const itemKeyword = await api(base, "GET", "/api/admin/items?keyword=" + encodeURIComponent("铁矿"), { token });
    checkEqual(itemKeyword.body?.data?.total, 1, "关键字能命中名称（铁矿）");

    const itemPatched = await api(base, "PATCH", "/api/admin/items/material_hide", { token, body: { label: "兽皮（改）", sellPrice: 8, maxStack: 500 } });
    checkEqual(itemPatched.status, 200, "PATCH 物品成功（名称/售价/堆叠一起改）");
    checkEqual(itemPatched.body?.data?.label, "兽皮（改）", "响应里的名称已更新");
    checkEqual(itemPatched.body?.data?.sellPrice, 8, "响应里的售卖价已更新");
    checkEqual(itemPatched.body?.data?.maxStack, 500, "响应里的堆叠上限已更新");
    const itemGhost = await api(base, "PATCH", "/api/admin/items/material_none", { token, body: { label: "x" } });
    checkEqual(itemGhost.status, 404, "改不存在的物品 → 404");
    checkEqual(itemGhost.body?.code, 50018, "物品未找到用专属业务码 50018");
    const itemStructural = await api(base, "PATCH", "/api/admin/items/material_hide", { token, body: { type: "drug", level: 99 } });
    checkEqual(itemStructural.status, 200, "PATCH 结构字段不报错（白名单剥离）");
    checkEqual(itemStructural.body?.data?.type, shared.ITEM_BASES["material_hide"].type, "type 不可编辑（大类属客户端结构约定）");
    checkEqual(itemStructural.body?.data?.level, shared.ITEM_BASES["material_hide"].level, "level 不可编辑");
    const postItem = await api(base, "POST", "/api/admin/items", { token, body: { id: "material_new" } });
    checkEqual(postItem.status, 404, "POST 物品 → 404（路由不存在）");
    const deleteItem = await api(base, "DELETE", "/api/admin/items/material_hide", { token });
    checkEqual(deleteItem.status, 404, "DELETE 物品 → 404（路由不存在）");
    const viewerItemRead = await api(base, "GET", "/api/admin/items", { token: viewerToken });
    checkEqual(viewerItemRead.body?.code, 0, "观察员能看物品配置");
    const viewerItemWrite = await api(base, "PATCH", "/api/admin/items/material_hide", { token: viewerToken, body: { sellPrice: 1 } });
    checkEqual(viewerItemWrite.status, 403, "观察员改物品 → 403");
    checkEqual(viewerItemWrite.body?.code, 30006, "观察员改物品 → 30006（权限点不足）");

    //#endregion

    //#region 十一、怪物基础数据（#258）：seed 同源 / tier 筛 / 只许改 / 改的是结算直读的表

    group("十一、怪物基础数据");

    const monsters = await api(base, "GET", "/api/admin/monsters", { token });
    checkEqual(monsters.status, 200, "怪物列表可读");
    const monsterCount = Object.keys(shared.MONSTERS).length;
    checkEqual(monsters.body?.data?.total, monsterCount, `怪物行数 = 配置表（${monsterCount}）`);
    checkEqual(monsters.body?.data?.list?.length, 100, "默认每页 100 条（220 只装不下一页）");
    const monstersPage2 = await api(base, "GET", "/api/admin/monsters?page=2", { token });
    checkEqual(monstersPage2.body?.data?.list?.length, 100, "第二页也是满的 100 条");
    const monstersPage3 = await api(base, "GET", "/api/admin/monsters?page=3", { token });
    checkEqual(monstersPage3.body?.data?.list?.length, monsterCount - 200, "第三页补齐剩余怪物");
    checkEqual(monsters.body?.data?.list?.[0]?.level, 1, "默认按等级升序（首行是 1 级怪）");

    const monster1 = monsters.body?.data?.list?.find((row) => row.id === "1");
    check(Boolean(monster1), "列表里有怪物 key \"1\"");
    checkEqual(monster1?.label, shared.MONSTERS["1"].label, "怪物 1 名称与配置一致");
    checkEqual(monster1?.tier, shared.MONSTERS["1"].tier, "怪物 1 定位与配置一致");
    checkEqual(monster1?.maxHp, shared.MONSTERS["1"].maxHp, "怪物 1 生命上限与配置一致");
    checkEqual(
      JSON.stringify([monster1?.attributes?.physicalAttack?.min, monster1?.attributes?.physicalAttack?.max]),
      JSON.stringify(shared.MONSTERS["1"].physicalAttack),
      "怪物 1 物攻区间与配置一致（快照数组 → min/max 结构）",
    );

    const monsterKeyword = await api(base, "GET", "/api/admin/monsters?keyword=" + encodeURIComponent(shared.MONSTERS["1"].label), { token });
    checkEqual(monsterKeyword.body?.data?.total, 1, "关键字按名称命中怪物 1");
    const monstersNormal = await api(base, "GET", "/api/admin/monsters?tier=normal", { token });
    const monstersBoss = await api(base, "GET", "/api/admin/monsters?tier=boss", { token });
    // 分档口径从快照现算（#436）：这条以前写的是「全部怪物，当前全是普通怪」——
    // 那是 `configs/monster.ts` 建 Map 时把 tier 解构掉又没放回的 bug 留下的印记，
    // tier 修好后 220 只怪里只有 199 只是普通怪，照抄老数字会立刻假红。
    const normalCount = Object.values(shared.MONSTERS).filter((row) => row.tier === "normal").length;
    const bossCount = Object.values(shared.MONSTERS).filter((row) => row.tier === "boss").length;
    checkEqual(
      `${monstersNormal.body?.data?.total}/${monstersBoss.body?.data?.total}`,
      `${normalCount}/${bossCount}`,
      `tier 筛：普通怪 ${normalCount} 只 / BOSS ${bossCount} 只（档位按快照分，不是「全是普通怪」）`,
    );
    const monstersElite = await api(base, "GET", "/api/admin/monsters?tier=elite", { token });
    checkEqual(monstersElite.body?.data?.total, 0, "tier=elite：空列表（合法筛选）");
    const monstersBadSort = await api(base, "GET", "/api/admin/monsters?sort=evil", { token });
    checkEqual(monstersBadSort.body?.data?.list?.[0]?.level, 1, "白名单外的 sort 退回默认排序（防注入）");

    const monsterPatched = await api(base, "PATCH", "/api/admin/monsters/1", {
      token,
      body: { label: "赤焰斗鸡（改）", level: 5, maxHp: 500 },
    });
    checkEqual(monsterPatched.status, 200, "PATCH 怪物成功（名称/等级/生命一起改）");
    checkEqual(monsterPatched.body?.data?.label, "赤焰斗鸡（改）", "响应里的名称已更新");
    checkEqual(monsterPatched.body?.data?.maxHp, 500, "响应里的生命上限已更新");
    const monsterAttrs = monsterPatched.body?.data?.attributes;
    const monsterAttrPatched = await api(base, "PATCH", "/api/admin/monsters/1", {
      token,
      body: { attributes: { ...monsterAttrs, physicalAttack: { min: 30, max: 88 } } },
    });
    checkEqual(
      JSON.stringify([monsterAttrPatched.body?.data?.attributes?.physicalAttack?.min, monsterAttrPatched.body?.data?.attributes?.physicalAttack?.max]),
      JSON.stringify([30, 88]),
      "六项区间整份替换生效",
    );
    checkEqual(monsterAttrPatched.body?.data?.maxHp, 500, "上次改的生命上限保留（合并语义）");
    const monsterBadHp = await api(base, "PATCH", "/api/admin/monsters/1", { token, body: { maxHp: 0 } });
    checkEqual(monsterBadHp.status, 400, "生命上限 0 → 400");
    const monsterCrossed = await api(base, "PATCH", "/api/admin/monsters/1", {
      token,
      body: { attributes: { ...monsterAttrs, magicDefense: { min: 9, max: 2 } } },
    });
    checkEqual(monsterCrossed.status, 400, "属性 min > max → 400（跨字段校验在服务端）");
    checkEqual(monsterCrossed.body?.code, 40000, "参数越界用 40000");
    const monsterGhost = await api(base, "PATCH", "/api/admin/monsters/nope", { token, body: { label: "x" } });
    checkEqual(monsterGhost.status, 404, "改不存在的怪物 → 404");
    checkEqual(monsterGhost.body?.code, 50019, "怪物未找到用专属业务码 50019");
    const monsterStructural = await api(base, "PATCH", "/api/admin/monsters/1", { token, body: { tier: "boss" } });
    checkEqual(monsterStructural.status, 200, "PATCH 结构字段不报错（白名单剥离）");
    checkEqual(monsterStructural.body?.data?.tier, shared.MONSTERS["1"].tier, "tier 不可编辑（已展开数值才是结算依据）");
    const postMonster = await api(base, "POST", "/api/admin/monsters", { token, body: { id: "999" } });
    checkEqual(postMonster.status, 404, "POST 怪物 → 404（路由不存在）");
    const deleteMonster = await api(base, "DELETE", "/api/admin/monsters/1", { token });
    checkEqual(deleteMonster.status, 404, "DELETE 怪物 → 404（路由不存在）");
    const viewerMonsterRead = await api(base, "GET", "/api/admin/monsters", { token: viewerToken });
    checkEqual(viewerMonsterRead.body?.code, 0, "观察员能看怪物配置");
    const viewerMonsterWrite = await api(base, "PATCH", "/api/admin/monsters/1", { token: viewerToken, body: { maxHp: 1 } });
    checkEqual(viewerMonsterWrite.status, 403, "观察员改怪物 → 403");
    checkEqual(viewerMonsterWrite.body?.code, 30006, "观察员改怪物 → 30006（权限点不足）");

    //#endregion

    //#region 十二、NPC 基础数据（#258）：seed 同源 / keyword 筛 / 只许改 / 对话列后台可维护

    group("十二、NPC 基础数据");

    const npcs = await api(base, "GET", "/api/admin/npcs", { token });
    checkEqual(npcs.status, 200, "NPC 列表可读");
    const npcCount = Object.keys(shared.NPCS).length;
    checkEqual(npcs.body?.data?.total, npcCount, `NPC 行数 = 配置表（${npcCount}）`);
    checkEqual(npcs.body?.data?.list?.length, npcCount, "默认一页装下全部 NPC");
    const npc2 = npcs.body?.data?.list?.find((row) => row.id === "0002");
    check(Boolean(npc2), "列表里有 NPC 0002");
    checkEqual(npc2?.label, shared.NPCS["0002"].label, "NPC 0002 名称与配置一致");
    checkEqual(npc2?.dialog, "", "对话文案 seed 为空串（客户端暂无对话数据形态）");

    const npcKeyword = await api(base, "GET", "/api/admin/npcs?keyword=" + encodeURIComponent("传送官"), { token });
    checkEqual(npcKeyword.body?.data?.total, 2, "关键字按名称命中两个传送官");

    const npcPatched = await api(base, "PATCH", "/api/admin/npcs/0002", {
      token,
      body: { label: "大陆传送官（改）", dialog: "要传送去哪张地图？" },
    });
    checkEqual(npcPatched.status, 200, "PATCH NPC 成功（名称/对话一起改）");
    checkEqual(npcPatched.body?.data?.label, "大陆传送官（改）", "响应里的名称已更新");
    checkEqual(npcPatched.body?.data?.dialog, "要传送去哪张地图？", "响应里的对话已更新");
    const npcCleared = await api(base, "PATCH", "/api/admin/npcs/0002", { token, body: { dialog: "" } });
    checkEqual(npcCleared.body?.data?.dialog, "", "对话传空串 = 清空");
    const npcGhost = await api(base, "PATCH", "/api/admin/npcs/9999", { token, body: { label: "x" } });
    checkEqual(npcGhost.status, 404, "改不存在的 NPC → 404");
    checkEqual(npcGhost.body?.code, 50020, "NPC 未找到用专属业务码 50020");
    const postNpc = await api(base, "POST", "/api/admin/npcs", { token, body: { id: "9999" } });
    checkEqual(postNpc.status, 404, "POST NPC → 404（路由不存在）");
    const deleteNpc = await api(base, "DELETE", "/api/admin/npcs/0002", { token });
    checkEqual(deleteNpc.status, 404, "DELETE NPC → 404（路由不存在）");
    const viewerNpcRead = await api(base, "GET", "/api/admin/npcs", { token: viewerToken });
    checkEqual(viewerNpcRead.body?.code, 0, "观察员能看 NPC 配置");
    const viewerNpcWrite = await api(base, "PATCH", "/api/admin/npcs/0002", { token: viewerToken, body: { label: "x" } });
    checkEqual(viewerNpcWrite.status, 403, "观察员改 NPC → 403");
    checkEqual(viewerNpcWrite.body?.code, 30006, "观察员改 NPC → 30006（权限点不足）");

    //#endregion

    //#region 十三、商城定价（#251）：统一价 seed / 特殊价动态增删 / 商品清单来自生成物 / 未定价走统一价

    group("十三、商城定价");

    const mallGoodsTotal = Object.keys(shared.EQUIPMENT_ATTRIBUTES).length;
    const mallSettings = await api(base, "GET", "/api/admin/mall/settings", { token });
    checkEqual(mallSettings.status, 200, "统一价可读");
    checkEqual(mallSettings.body?.data?.defaultPrice, shared.MALL.defaultPrice, `统一价 seed 与配置一致（${shared.MALL.defaultPrice}）`);

    const mallSettingsPatched = await api(base, "PATCH", "/api/admin/mall/settings", { token, body: { defaultPrice: 3 } });
    checkEqual(mallSettingsPatched.status, 200, "PATCH 统一价成功");
    checkEqual(mallSettingsPatched.body?.data?.defaultPrice, 3, "响应里的统一价已更新");
    const mallSettingsReread = await api(base, "GET", "/api/admin/mall/settings", { token });
    checkEqual(mallSettingsReread.body?.data?.defaultPrice, 3, "重新读取统一价已是新值");
    const mallBadPrice = await api(base, "PATCH", "/api/admin/mall/settings", { token, body: { defaultPrice: -1 } });
    checkEqual(mallBadPrice.status, 400, "统一价负数 → 400");

    const mallPrices = await api(base, "GET", "/api/admin/mall/prices", { token });
    checkEqual(mallPrices.status, 200, "定价列表可读");
    checkEqual(mallPrices.body?.data?.total, mallGoodsTotal, `商品数 = 生成物装备全量（${mallGoodsTotal}）`);
    checkEqual(mallPrices.body?.data?.list?.length, 20, "默认每页 20 条");
    const mallFirst = mallPrices.body?.data?.list?.[0];
    checkEqual(mallFirst?.id, "cloth_1", "首行是有货部位里最靠前的商品（部位序 → 等级 → id）");
    checkEqual(mallFirst?.price, null, "seed 后没有任何特殊价（未定价走统一价）");
    checkEqual(mallFirst?.updatedAt, null, "未定价的更新时间为 null");
    checkEqual(mallFirst?.label, shared.EQUIPMENT_DISPLAY_NAMES["cloth_1"], "商品显示名来自生成物（前后缀已拼好）");
    const mallLastPage = await api(base, "GET", "/api/admin/mall/prices?page=28&size=20", { token });
    checkEqual(mallLastPage.body?.data?.list?.length, mallGoodsTotal - 27 * 20, "末页补齐剩余商品");

    const mallPut = await api(base, "PUT", "/api/admin/mall/prices/cloth_1", { token, body: { price: 99 } });
    checkEqual(mallPut.status, 200, "PUT 单件特殊价成功（upsert 的「增」）");
    checkEqual(mallPut.body?.data?.price, 99, "响应里的特殊价已设置");
    check(mallPut.body?.data?.updatedAt !== null, "特殊价的更新时间已落");
    const mallPriced = await api(base, "GET", "/api/admin/mall/prices?priced=true", { token });
    checkEqual(mallPriced.body?.data?.total, 1, "priced=true 只看到这一条特殊价");
    const mallPricedKeyword = await api(base, "GET", "/api/admin/mall/prices?priced=true&keyword=cloth_1", { token });
    checkEqual(mallPricedKeyword.body?.data?.total, 1, "关键字 + 定价状态组合筛命中");
    const mallPricedWeapon = await api(base, "GET", "/api/admin/mall/prices?slot=weapon&priced=true", { token });
    checkEqual(mallPricedWeapon.body?.data?.total, 0, "按部位 + 定价状态组合筛：武器部没有特殊价");
    const mallPutAgain = await api(base, "PUT", "/api/admin/mall/prices/cloth_1", { token, body: { price: 88 } });
    checkEqual(mallPutAgain.status, 200, "再次 PUT 同一商品成功（upsert 的「改」）");
    checkEqual(mallPutAgain.body?.data?.price, 88, "改价生效");
    const mallPricedAfterUpsert = await api(base, "GET", "/api/admin/mall/prices?priced=true", { token });
    checkEqual(mallPricedAfterUpsert.body?.data?.total, 1, "upsert 不会长出第二行");

    const mallPutGhost = await api(base, "PUT", "/api/admin/mall/prices/nope", { token, body: { price: 1 } });
    checkEqual(mallPutGhost.status, 404, "给清单外的 id 定价 → 404");
    checkEqual(mallPutGhost.body?.code, 50021, "商品不存在用专属业务码 50021");
    const mallPutNegative = await api(base, "PUT", "/api/admin/mall/prices/cloth_1", { token, body: { price: -5 } });
    checkEqual(mallPutNegative.status, 400, "特殊价负数 → 400");

    const mallDelete = await api(base, "DELETE", "/api/admin/mall/prices/cloth_1", { token });
    checkEqual(mallDelete.status, 200, "DELETE 特殊价成功（动态增删的「删」）");
    const mallPricedAfterDelete = await api(base, "GET", "/api/admin/mall/prices?priced=true", { token });
    checkEqual(mallPricedAfterDelete.body?.data?.total, 0, "删除后回到未定价（走统一价）");
    const mallDeleteAgain = await api(base, "DELETE", "/api/admin/mall/prices/cloth_1", { token });
    checkEqual(mallDeleteAgain.status, 404, "删无可删 → 404（不静默成功）");
    checkEqual(mallDeleteAgain.body?.code, 50021, "删无可删也用 50021");

    const viewerMallSettingsRead = await api(base, "GET", "/api/admin/mall/settings", { token: viewerToken });
    checkEqual(viewerMallSettingsRead.body?.code, 0, "观察员能看统一价");
    const viewerMallSettingsWrite = await api(base, "PATCH", "/api/admin/mall/settings", { token: viewerToken, body: { defaultPrice: 9 } });
    checkEqual(viewerMallSettingsWrite.status, 403, "观察员改统一价 → 403");
    checkEqual(viewerMallSettingsWrite.body?.code, 30006, "观察员改统一价 → 30006（权限点不足）");
    const viewerMallPut = await api(base, "PUT", "/api/admin/mall/prices/cloth_1", { token: viewerToken, body: { price: 9 } });
    checkEqual(viewerMallPut.status, 403, "观察员设特殊价 → 403");
    const viewerMallDelete = await api(base, "DELETE", "/api/admin/mall/prices/cloth_1", { token: viewerToken });
    checkEqual(viewerMallDelete.status, 403, "观察员删特殊价 → 403");

    //#endregion

    //#region 十四、时装配置（#257）：seed 同源 / 渠道筛 / 只许改 / 资源路径不可编辑

    group("十四、时装配置");

    const fashions = await api(base, "GET", "/api/admin/fashions", { token });
    checkEqual(fashions.status, 200, "时装列表可读");
    const fashionCount = Object.keys(shared.FASHIONS).length;
    checkEqual(fashions.body?.data?.total, fashionCount, `时装行数 = 配置表（${fashionCount}）`);
    checkEqual(fashions.body?.data?.list?.length, fashionCount, "默认一页装下全部时装");
    const fashion2 = fashions.body?.data?.list?.find((row) => row.id === "cloth_2");
    check(Boolean(fashion2), "列表里有时装 cloth_2");
    checkEqual(fashion2?.label, shared.FASHIONS["cloth_2"].label, "cloth_2 名称与配置一致");
    checkEqual(fashion2?.description, shared.FASHIONS["cloth_2"].description, "cloth_2 描述与配置一致");
    checkEqual(fashion2?.icon, shared.FASHIONS["cloth_2"].icon, "cloth_2 图标路径与配置一致");
    checkEqual(fashion2?.inRes, shared.FASHIONS["cloth_2"].in, "cloth_2 内观路径与配置一致");
    checkEqual(fashion2?.outRes, shared.FASHIONS["cloth_2"].out, "cloth_2 外观路径与配置一致");
    checkEqual(fashion2?.sellPrice, 0, "售卖价 seed 为 0（原配置全零）");
    checkEqual(fashion2?.acquireChannel, "unavailable", "获得渠道 seed 默认无法获取");
    checkEqual(fashion2?.attributes?.maxHp, 0, "属性嵌套结构返回且 seed 全 0（maxHp）");
    const fashion12 = fashions.body?.data?.list?.find((row) => row.id === "cloth_12");
    checkEqual(fashion12?.inRes, "", "cloth_12 无内观（seed 空串）");

    const fashionKeyword = await api(base, "GET", "/api/admin/fashions?keyword=" + encodeURIComponent("巫女"), { token });
    checkEqual(fashionKeyword.body?.data?.total, 1, "关键字按名称命中妖绯巫女");
    const fashionsUnavailable = await api(base, "GET", "/api/admin/fashions?acquireChannel=unavailable", { token });
    checkEqual(fashionsUnavailable.body?.data?.total, fashionCount, "按渠道筛 unavailable：全部时装（seed 默认）");
    const fashionsGrant = await api(base, "GET", "/api/admin/fashions?acquireChannel=grant", { token });
    checkEqual(fashionsGrant.body?.data?.total, 0, "按渠道筛 grant：空列表（合法筛选）");
    const fashionBadSort = await api(base, "GET", "/api/admin/fashions?sort=evil", { token });
    checkEqual(
      JSON.stringify(fashionBadSort.body?.data?.list?.[0]?.id),
      JSON.stringify(fashions.body?.data?.list?.[0]?.id),
      "白名单外的 sort 退回默认排序（防注入）",
    );

    const fashionPatched = await api(base, "PATCH", "/api/admin/fashions/cloth_2", {
      token,
      body: { label: "妖绯巫女（改）", description: "新描述", sellPrice: 188, acquireChannel: "upgrade" },
    });
    checkEqual(fashionPatched.status, 200, "PATCH 时装成功（名称/描述/售价/渠道一起改）");
    checkEqual(fashionPatched.body?.data?.label, "妖绯巫女（改）", "响应里的名称已更新");
    checkEqual(fashionPatched.body?.data?.description, "新描述", "响应里的描述已更新");
    checkEqual(fashionPatched.body?.data?.sellPrice, 188, "响应里的售卖价已更新");
    checkEqual(fashionPatched.body?.data?.acquireChannel, "upgrade", "响应里的获得渠道已更新");
    const fashionChannelReread = await api(base, "GET", "/api/admin/fashions?acquireChannel=upgrade", { token });
    checkEqual(fashionChannelReread.body?.data?.total, 1, "渠道改动后按新渠道能筛到");

    const fashionAttrs = fashionPatched.body?.data?.attributes;
    const fashionAttrPatched = await api(base, "PATCH", "/api/admin/fashions/cloth_2", {
      token,
      body: { attributes: { ...fashionAttrs, maxHp: 100, physicalAttack: { min: 5, max: 12 } } },
    });
    checkEqual(fashionAttrPatched.body?.data?.attributes?.maxHp, 100, "八项属性整份替换生效（maxHp）");
    checkEqual(fashionAttrPatched.body?.data?.attributes?.physicalAttack?.min, 5, "八项属性整份替换生效（物攻下限）");
    checkEqual(fashionAttrPatched.body?.data?.sellPrice, 188, "上次改的售卖价保留（合并语义）");

    const fashionBadPrice = await api(base, "PATCH", "/api/admin/fashions/cloth_2", { token, body: { sellPrice: -1 } });
    checkEqual(fashionBadPrice.status, 400, "售卖价负数 → 400");
    const fashionCrossed = await api(base, "PATCH", "/api/admin/fashions/cloth_2", {
      token,
      body: { attributes: { ...fashionAttrs, magicDefense: { min: 9, max: 2 } } },
    });
    checkEqual(fashionCrossed.status, 400, "属性 min > max → 400（跨字段校验在服务端）");
    checkEqual(fashionCrossed.body?.code, 40000, "参数越界用 40000");
    const fashionBadChannel = await api(base, "PATCH", "/api/admin/fashions/cloth_2", { token, body: { acquireChannel: "magic" } });
    checkEqual(fashionBadChannel.status, 400, "渠道取值不合法 → 400");
    const fashionGhost = await api(base, "PATCH", "/api/admin/fashions/cloth_99", { token, body: { label: "x" } });
    checkEqual(fashionGhost.status, 404, "改不存在的时装 → 404");
    checkEqual(fashionGhost.body?.code, 50022, "时装未找到用专属业务码 50022");
    const fashionStructural = await api(base, "PATCH", "/api/admin/fashions/cloth_2", { token, body: { icon: "clothes/icon/999", inRes: "x", outRes: "y" } });
    checkEqual(fashionStructural.status, 200, "PATCH 资源路径不报错（白名单剥离）");
    checkEqual(fashionStructural.body?.data?.icon, shared.FASHIONS["cloth_2"].icon, "icon 不可编辑（资源路径属表现层）");
    checkEqual(fashionStructural.body?.data?.inRes, shared.FASHIONS["cloth_2"].in, "inRes 不可编辑");
    checkEqual(fashionStructural.body?.data?.outRes, shared.FASHIONS["cloth_2"].out, "outRes 不可编辑");
    const postFashion = await api(base, "POST", "/api/admin/fashions", { token, body: { id: "cloth_99" } });
    checkEqual(postFashion.status, 404, "POST 时装 → 404（路由不存在）");
    const deleteFashion = await api(base, "DELETE", "/api/admin/fashions/cloth_2", { token });
    checkEqual(deleteFashion.status, 404, "DELETE 时装 → 404（路由不存在）");
    const viewerFashionRead = await api(base, "GET", "/api/admin/fashions", { token: viewerToken });
    checkEqual(viewerFashionRead.body?.code, 0, "观察员能看时装配置");
    const viewerFashionWrite = await api(base, "PATCH", "/api/admin/fashions/cloth_2", { token: viewerToken, body: { sellPrice: 1 } });
    checkEqual(viewerFashionWrite.status, 403, "观察员改时装 → 403");
    checkEqual(viewerFashionWrite.body?.code, 30006, "观察员改时装 → 30006（权限点不足）");

    //#endregion

    //#region 十五、掉落配置（#254）：具名表 CRUD / 引用保护 / 每怪整份替换三选一 / seed 同源

    group("十五、掉落配置");

    const dropTablesList = await api(base, "GET", "/api/admin/drop-tables", { token });
    checkEqual(dropTablesList.status, 200, "具名掉落表列表可读");
    const seedTableCount = Object.keys(shared.DROP_TABLES).length + Object.keys(shared.DROP_DEFAULT).length;
    checkEqual(dropTablesList.body?.data?.total, seedTableCount, `具名表张数 = seed（${seedTableCount}：common/elite/boss + 兜底 default）`);
    const commonTable = dropTablesList.body?.data?.list?.find((row) => row.id === "common");
    check(Boolean(commonTable), "列表里有具名表 common");
    checkEqual(
      JSON.stringify([commonTable?.picks, commonTable?.entries?.[0]]),
      JSON.stringify([shared.DROP_TABLES["common"].picks, shared.DROP_TABLES["common"].entries[0]]),
      "common 表的抽取次数与首条目和配置一致",
    );
    check(Boolean(dropTablesList.body?.data?.list?.find((row) => row.id === "default")), "兜底表 default 也在列表里");

    const dropTableCreate = await api(base, "POST", "/api/admin/drop-tables", {
      token,
      body: { id: "event_gold", picks: [2, 4], entries: [{ goodId: "material_iron", weight: 10, count: [2, 5] }] },
    });
    checkEqual(dropTableCreate.status, 201, "POST 创建具名表成功（201 Created）");
    checkEqual(dropTableCreate.body?.data?.id, "event_gold", "响应里的表 id 已落");
    checkEqual(JSON.stringify(dropTableCreate.body?.data?.entries?.[0]), JSON.stringify({ goodId: "material_iron", weight: 10, chance: 1, count: [2, 5] }), "缺省 chance / count 已规整为全显式");
    const dropTableDuplicate = await api(base, "POST", "/api/admin/drop-tables", { token, body: { id: "event_gold", entries: [{ goodId: "material_iron" }] } });
    checkEqual(dropTableDuplicate.status, 400, "重复 id 创建 → 400");
    const dropTableBadId = await api(base, "POST", "/api/admin/drop-tables", { token, body: { id: "Bad_Id!", entries: [{ goodId: "material_iron" }] } });
    checkEqual(dropTableBadId.status, 400, "非法 id（大写/特殊字符）→ 400");
    const dropTableBadGood = await api(base, "POST", "/api/admin/drop-tables", { token, body: { id: "event_bad", entries: [{ goodId: "no_such_good" }] } });
    checkEqual(dropTableBadGood.status, 400, "goodId 不在物品总表 → 400");
    checkEqual(dropTableBadGood.body?.code, 40000, "物品不存在用 40000");
    const dropTableEmpty = await api(base, "POST", "/api/admin/drop-tables", { token, body: { id: "event_empty", entries: [] } });
    checkEqual(dropTableEmpty.status, 400, "空条目池 → 400");
    const dropTableBadCount = await api(base, "POST", "/api/admin/drop-tables", { token, body: { id: "event_bad2", entries: [{ goodId: "material_iron", count: [5, 2] }] } });
    checkEqual(dropTableBadCount.status, 400, "count 下限大于上限 → 400");
    const dropTableBadPicks = await api(base, "POST", "/api/admin/drop-tables", { token, body: { id: "event_bad3", picks: "lots", entries: [{ goodId: "material_iron" }] } });
    checkEqual(dropTableBadPicks.status, 400, "picks 非数字/区间 → 400");

    const dropTablePatched = await api(base, "PATCH", "/api/admin/drop-tables/event_gold", { token, body: { picks: 3 } });
    checkEqual(dropTablePatched.body?.data?.picks, 3, "PATCH 抽取次数生效");
    checkEqual(dropTablePatched.body?.data?.entries?.length, 1, "PATCH 不传 entries 时条目保留（合并语义）");
    const dropTableEntriesPatched = await api(base, "PATCH", "/api/admin/drop-tables/event_gold", {
      token,
      body: { entries: [{ goodId: "material_gem", weight: 5, chance: 0.5, count: [1, 2] }] },
    });
    checkEqual(dropTableEntriesPatched.body?.data?.entries?.length, 1, "PATCH entries 整份替换");
    checkEqual(dropTableEntriesPatched.body?.data?.entries?.[0]?.goodId, "material_gem", "替换后的首条目是新物品");
    const dropTableGhost = await api(base, "PATCH", "/api/admin/drop-tables/nope", { token, body: { picks: 1 } });
    checkEqual(dropTableGhost.status, 404, "改不存在的具名表 → 404");
    checkEqual(dropTableGhost.body?.code, 50023, "具名表未找到用专属业务码 50023");

    const dropTableRemoved = await api(base, "DELETE", "/api/admin/drop-tables/event_gold", { token });
    checkEqual(dropTableRemoved.status, 200, "DELETE 未被引用的具名表成功");
    const dropTableRemovedAgain = await api(base, "DELETE", "/api/admin/drop-tables/event_gold", { token });
    checkEqual(dropTableRemovedAgain.status, 404, "再删已删除的表 → 404");

    const monsterDropsList = await api(base, "GET", "/api/admin/monster-drops", { token });
    checkEqual(monsterDropsList.status, 200, "每怪掉落列表可读");
    const monsterDropCount = Object.keys(shared.MONSTER_DROPS).length;
    checkEqual(monsterDropsList.body?.data?.total, monsterDropCount, `每怪行数 = 配置表（${monsterDropCount}）`);
    checkEqual(monsterDropsList.body?.data?.list?.length, 20, "默认每页 20 条");
    checkEqual(monsterDropsList.body?.data?.list?.[0]?.monsterKey, "1", "默认按 key 数值升序（首行是怪 1，不是字典序的 \"1\",\"10\"…）");
    const monsterDrop1 = monsterDropsList.body?.data?.list?.find((row) => row.monsterKey === "1");
    checkEqual(monsterDrop1?.source, "entries", "seed 全内联（source = entries）");
    checkEqual(
      JSON.stringify(monsterDrop1?.entries?.[0]),
      JSON.stringify(shared.MONSTER_DROPS["1"].entries[0]),
      "怪 1 的首条目与配置一致",
    );
    const monsterDropsBySource = await api(base, "GET", "/api/admin/monster-drops?source=entries", { token });
    checkEqual(monsterDropsBySource.body?.data?.total, monsterDropCount, "按来源筛 entries：全部怪物（seed 全内联）");
    const monsterDropsKeyword = await api(base, "GET", "/api/admin/monster-drops?keyword=220", { token });
    checkEqual(monsterDropsKeyword.body?.data?.total, 1, "关键字精确命中怪 220");
    const monsterDropsBadSort = await api(base, "GET", "/api/admin/monster-drops?sort=evil", { token });
    checkEqual(monsterDropsBadSort.body?.data?.list?.[0]?.monsterKey, "1", "白名单外的 sort 退回默认排序（防注入）");

    const monsterDropRef = await api(base, "PATCH", "/api/admin/monster-drops/1", { token, body: { tableId: "common", picks: [2, 5] } });
    checkEqual(monsterDropRef.status, 200, "PATCH 引用具名表成功（picks 覆盖件数）");
    checkEqual(monsterDropRef.body?.data?.source, "table", "来源已切到 table");
    checkEqual(monsterDropRef.body?.data?.tableId, "common", "引用的表 id 已落");
    checkEqual(monsterDropRef.body?.data?.entries, null, "引用具名表时内联条目清空");
    const monsterDropsTableOnly = await api(base, "GET", "/api/admin/monster-drops?source=table", { token });
    checkEqual(monsterDropsTableOnly.body?.data?.total, 1, "按来源筛 table：只有怪 1");
    const dropTableRemoveReferenced = await api(base, "DELETE", "/api/admin/drop-tables/common", { token });
    checkEqual(dropTableRemoveReferenced.status, 400, "删除被引用中的具名表 → 400（引用保护）");
    check(dropTableRemoveReferenced.body?.message?.includes("1 只怪物"), "引用保护的报错带引用计数");

    const monsterDropRefBoth = await api(base, "PATCH", "/api/admin/monster-drops/1", { token, body: { tableId: "common", entries: [{ goodId: "material_iron" }] } });
    checkEqual(monsterDropRefBoth.status, 400, "tableId 与 entries 同时传 → 400");
    const monsterDropInline = await api(base, "PATCH", "/api/admin/monster-drops/1", {
      token,
      body: { tableId: null, picks: [1, 2], entries: [{ goodId: "drug_hp_2", weight: 40, count: [1, 3] }] },
    });
    checkEqual(monsterDropInline.status, 200, "PATCH 换回内联条目成功");
    checkEqual(monsterDropInline.body?.data?.source, "entries", "来源已切回 entries");
    checkEqual(monsterDropInline.body?.data?.tableId, null, "表引用已清空");
    const monsterDropInlineNoPicks = await api(base, "PATCH", "/api/admin/monster-drops/1", { token, body: { tableId: null, entries: [{ goodId: "drug_hp_2" }] } });
    checkEqual(monsterDropInlineNoPicks.status, 400, "内联条目缺抽取次数 → 400");
    const monsterDropClear = await api(base, "PATCH", "/api/admin/monster-drops/1", { token, body: { tableId: null, entries: null } });
    checkEqual(monsterDropClear.body?.data?.source, "none", "清空后来源 = none（走兜底表）");
    const monsterDropClearWithPicks = await api(base, "PATCH", "/api/admin/monster-drops/1", { token, body: { tableId: null, entries: null, picks: 2 } });
    checkEqual(monsterDropClearWithPicks.status, 400, "清空时带抽取次数 → 400");
    const monsterDropBadTable = await api(base, "PATCH", "/api/admin/monster-drops/1", { token, body: { tableId: "nope", picks: 1 } });
    checkEqual(monsterDropBadTable.status, 404, "引用不存在的具名表 → 404");
    checkEqual(monsterDropBadTable.body?.code, 50023, "引用的表不存在用 50023");
    const monsterDropGhost = await api(base, "PATCH", "/api/admin/monster-drops/999", { token, body: { tableId: null, entries: null } });
    checkEqual(monsterDropGhost.status, 404, "改不存在的怪 → 404");
    checkEqual(monsterDropGhost.body?.code, 50024, "怪物掉落未找到用专属业务码 50024");

    const postMonsterDrop = await api(base, "POST", "/api/admin/monster-drops", { token, body: { monsterKey: "999" } });
    checkEqual(postMonsterDrop.status, 404, "POST 每怪掉落 → 404（路由不存在，行与怪物一一对应）");
    const deleteMonsterDrop = await api(base, "DELETE", "/api/admin/monster-drops/1", { token });
    checkEqual(deleteMonsterDrop.status, 404, "DELETE 每怪掉落 → 404（路由不存在）");
    const viewerDropRead = await api(base, "GET", "/api/admin/drop-tables", { token: viewerToken });
    checkEqual(viewerDropRead.body?.code, 0, "观察员能看具名掉落表");
    const viewerDropWrite = await api(base, "POST", "/api/admin/drop-tables", { token: viewerToken, body: { id: "nope", entries: [{ goodId: "material_iron" }] } });
    checkEqual(viewerDropWrite.status, 403, "观察员建具名表 → 403");
    checkEqual(viewerDropWrite.body?.code, 30006, "观察员建具名表 → 30006（权限点不足）");
    const viewerMonsterDropWrite = await api(base, "PATCH", "/api/admin/monster-drops/1", { token: viewerToken, body: { tableId: null, entries: null } });
    checkEqual(viewerMonsterDropWrite.status, 403, "观察员改每怪掉落 → 403");

    //#endregion
    //#region 十六、玩家侧配置快照（#294）：一次下发全部运营配置 / 管理端改值进快照 / 需要玩家令牌

    group("十六、玩家侧配置快照");

    const registerPlayer = async (name) => {
      const login = await api(base, "POST", "/api/auth/login", { body: { username: name, password: "pass1234" } });
      if (login.body?.data?.token) return login.body.data.token;
      const registered = await api(base, "POST", "/api/auth/register", { body: { username: name, password: "pass1234" } });
      check(Boolean(registered.body?.data?.token), `注册玩家 ${name}`);
      return registered.body?.data?.token;
    };

    const noToken = await api(base, "GET", "/api/game-config");
    checkEqual(noToken.status, 401, "无令牌拉快照 → 401（配置属于玩法数据，不开放给未登录请求）");

    const playerToken = await registerPlayer("cfgsnap_player");
    check(Boolean(playerToken), "玩家注册并登录成功");

    const snapshot = await api(base, "GET", "/api/game-config", { token: playerToken });
    checkEqual(snapshot.status, 200, "玩家令牌拉快照 → 200");
    const snap = snapshot.body?.data ?? {};

    // 各表行数 = 管理端列表的全量（快照的形状与列表行一致）
    checkEqual(snap.titles?.length, Object.keys(shared.TITLE_LEVEL_META).length, "快照称号行数 = 配置表");
    checkEqual(snap.souls?.length, Object.keys(shared.SOUL_LEVEL_META).length, "快照战魂行数 = 配置表");
    checkEqual(snap.ranks?.length, Object.keys(shared.RANK_LEVEL_META).length, "快照军衔行数 = 配置表（100 阶）");
    checkEqual(snap.equipments?.length, Object.keys(shared.EQUIPMENT_BASES).length, "快照装备基础件行数 = 生成物");
    checkEqual(snap.drugs?.length, Object.keys(shared.DRUGS).length, "快照药品行数 = 生成物");
    checkEqual(snap.items?.length, Object.keys(shared.ITEM_BASES).length, "快照物品行数 = 生成物");
    checkEqual(snap.monsters?.length, Object.keys(shared.MONSTERS).length, "快照怪物行数 = 生成物（220）");
    checkEqual(snap.npcs?.length, Object.keys(shared.NPCS).length, "快照 NPC 行数 = 生成物");
    checkEqual(snap.fashions?.length, Object.keys(shared.FASHIONS).length, "快照时装行数 = 生成物（20）");
    checkEqual(snap.levelExps?.length, Object.keys(shared.ROLE_LEVEL_ATTRIBUTES).length, "快照升级经验行数 = 等级数");
    check(Boolean(Array.isArray(snap.growthSegments) && snap.growthSegments.length > 0), "快照带成长曲线分段");
    check(Boolean(Array.isArray(snap.growthScalars) && snap.growthScalars.length > 0), "快照带成长标量参数");
    check(Boolean(snap.mallSettings?.defaultPrice > 0), "快照带商城统一价");
    check(Boolean(Array.isArray(snap.mallPrices) && snap.mallPrices.length > 0), "快照带商城定价目录");
    checkEqual(snap.dropTables?.length, seedTableCount, `快照具名掉落表张数 = seed（${seedTableCount}）`);
    checkEqual(snap.monsterDrops?.length, Object.keys(shared.MONSTER_DROPS).length, "快照每怪掉落行数 = 生成物（220）");
    checkEqual(snap.skills?.length, Object.keys(shared.SKILLS).length, "快照技能行数 = 生成物（含释放限制字段）");
    checkEqual(snap.statuses?.length, Object.keys(shared.STATUSES).length, "快照状态行数 = 生成物");
    check(Boolean(snap.skills?.[0]?.castLockMs !== undefined && snap.skills?.[0]?.requireTarget !== undefined), "快照技能行带释放限制（castLockMs / requireTarget）");

    // 字段形状抽检：camelCase、与管理端列表行同形状（称号渠道不预设值——前面的 region 已改过渠道）
    const adminTitles = await api(base, "GET", "/api/admin/titles", { token });
    const firstTitleRow = adminTitles.body?.data?.list?.find((row) => row.level === snap.titles[0].level);
    checkEqual(snap.titles[0].acquireChannel, firstTitleRow?.acquireChannel, "快照称号渠道字段与列表接口同形状");
    check(Boolean(snap.monsters?.[0]?.attributes?.physicalAttack?.min !== undefined), "快照怪物行带嵌套区间属性（attributes.physicalAttack.min）");
    check(Boolean(snap.mallPrices?.[0]?.price === null || typeof snap.mallPrices?.[0]?.price === "number"), "快照定价行带 price（null = 统一价）");

    // 改值进快照：管理端 PATCH 后，重新拉快照反映新值
    const patchLabel = await api(base, "PATCH", `/api/admin/titles/${snap.titles[0].level}`, {
      token,
      body: { label: "快照验证·改名" },
    });
    checkEqual(patchLabel.status, 200, "管理端 PATCH 称号名成功");
    const snapshot2 = await api(base, "GET", "/api/game-config", { token: playerToken });
    checkEqual(snapshot2.body?.data?.titles?.[0]?.label, "快照验证·改名", "管理端改值后重新拉快照反映新值（改配置对客户端生效的通道）");
    const restore = await api(base, "PATCH", `/api/admin/titles/${snap.titles[0].level}`, {
      token,
      body: { label: shared.TITLE_LABELS["0"] },
    });
    checkEqual(restore.status, 200, "还原称号名（不污染其他断言）");

    //#endregion

    //#region 十七、成长线升级：称号 / 战魂 / 军衔的扣费与推进在服务端（#248/#249/#250）
    group("十七、成长线升级：扣费与阶位推进在服务端");

    // 前面 region 玩过称号渠道且未还原 —— 这里把 1/2/3 阶复原为 unavailable，
    // 让「升级链从空开始成形」的前提成立（也验证渠道即链的开关语义）
    for (const level of [1, 2, 3]) {
      const reset = await api(base, "PATCH", `/api/admin/titles/${level}`, { token, body: { acquireChannel: "unavailable" } });
      checkEqual(reset.status, 200, `前置清理：${level} 阶称号渠道还原为 unavailable`);
    }

    const growthPlayer = await registerPlayer("growth_player");
    check(Boolean(growthPlayer), "成长线玩家注册成功");
    const growthCreate = await api(base, "POST", "/api/roles", {
      token: growthPlayer,
      body: {
        data: {
          id: "growth_role_1",
          name: "成长测试员",
          occupation: "1",
          sex: "1",
          level: 1,
          bindGold: 0,
          gold: 0,
          title: 0,
          soulOfWar: 0,
          rank: 0,
        },
      },
    });
    checkEqual(growthCreate.status, 201, "创建成长线测试角色 → 201");
    const growthRoleId = growthCreate.body?.data?.id;
    let growthRevision = growthCreate.body?.data?.revision;

    // seed 后全部称号渠道 unavailable → 升级链为空 → 即使 0 阶也没有下一阶
    const lockedTitle = await api(base, "POST", `/api/roles/${growthRoleId}/growth-upgrade`, {
      token: growthPlayer,
      body: { kind: "title", targetLevel: 1 },
    });
    checkEqual(lockedTitle.status, 409, "称号渠道全未开放时升级 → 409");
    checkEqual(lockedTitle.body?.code, 20008, "升级链为空 → 20008（目标不合法：没有下一阶）");

    // 运营把 1、2 阶称号切到 upgrade 渠道 → 成长链成形（顺序 = upgrade_order）
    const open1 = await api(base, "PATCH", `/api/admin/titles/1`, { token, body: { acquireChannel: "upgrade" } });
    const open2 = await api(base, "PATCH", `/api/admin/titles/2`, { token, body: { acquireChannel: "upgrade" } });
    checkEqual(open1.status, 200, "运营开放 1 阶称号（upgrade 渠道）");
    checkEqual(open2.status, 200, "运营开放 2 阶称号（upgrade 渠道）");

    const skipJump = await api(base, "POST", `/api/roles/${growthRoleId}/growth-upgrade`, {
      token: growthPlayer,
      body: { kind: "title", targetLevel: 2 },
    });
    checkEqual(skipJump.status, 409, "跳级升 2 阶 → 409");
    checkEqual(skipJump.body?.code, 20008, "跳级 → 20008（下一阶是 1 阶，不是 2 阶）");

    const poor = await api(base, "POST", `/api/roles/${growthRoleId}/growth-upgrade`, {
      token: growthPlayer,
      body: { kind: "title", targetLevel: 1 },
    });
    checkEqual(poor.status, 409, "绑定元宝不足时升级 → 409");
    checkEqual(poor.body?.code, 20009, "元宝不足 → 20009");

    // 充值走既有 role.save（带 revision 基线；同时为乐观锁用例制造一个旧 revision）
    const rich = await api(base, "PUT", `/api/roles/${growthRoleId}`, {
      token: growthPlayer,
      body: { revision: growthRevision, data: { ...growthCreate.body?.data?.data, bindGold: 1000000000 } },
    });
    checkEqual(rich.status, 200, "role.save 充值绑定元宝成功");
    growthRevision = rich.body?.data?.revision;

    const stale = await api(base, "POST", `/api/roles/${growthRoleId}/growth-upgrade`, {
      token: growthPlayer,
      body: { kind: "title", targetLevel: 1, revision: growthRevision - 1 },
    });
    checkEqual(stale.status, 409, "带旧修订号升级 → 409");
    checkEqual(stale.body?.code, 20006, "乐观锁冲突 → 20006");

    // 价格从管理端列表动态读（不写死 seed 值）
    const titlesNow = await api(base, "GET", "/api/admin/titles", { token });
    const price1 = titlesNow.body?.data?.list?.find((row) => row.level === 1)?.bindGold;
    const price2 = titlesNow.body?.data?.list?.find((row) => row.level === 2)?.bindGold;

    const up1 = await api(base, "POST", `/api/roles/${growthRoleId}/growth-upgrade`, {
      token: growthPlayer,
      body: { kind: "title", targetLevel: 1, revision: growthRevision },
    });
    checkEqual(up1.status, 200, "升 1 阶称号 → 200");
    checkEqual(up1.body?.data?.consumed, price1, "consumed = 库里 1 阶价格");
    checkEqual(up1.body?.data?.gainedLevel, 1, "gainedLevel = 1");
    checkEqual(up1.body?.data?.gainedLabel, shared.TITLE_LABELS["0"], "gainedLabel = 1 阶称号名");
    checkEqual(up1.body?.data?.data?.title, 1, "存档 title 推进到 1");
    checkEqual(up1.body?.data?.data?.bindGold, 1000000000 - price1, "存档 bindGold 扣减到位");
    checkEqual(up1.body?.data?.revision, growthRevision + 1, "revision 原子 +1");
    growthRevision = up1.body?.data?.revision;

    const up2 = await api(base, "POST", `/api/roles/${growthRoleId}/growth-upgrade`, {
      token: growthPlayer,
      body: { kind: "title", targetLevel: 2, revision: growthRevision },
    });
    checkEqual(up2.status, 200, "升 2 阶称号 → 200");
    checkEqual(up2.body?.data?.consumed, price2, "consumed = 库里 2 阶价格（升级链按 upgrade_order 前进）");
    checkEqual(up2.body?.data?.data?.title, 2, "存档 title 推进到 2");
    growthRevision = up2.body?.data?.revision;

    // 运营把 2 阶称号切出 upgrade 渠道 → 玩家当前阶掉出升级链 → 无法续升
    const cutOff = await api(base, "PATCH", `/api/admin/titles/2`, { token, body: { acquireChannel: "grant" } });
    checkEqual(cutOff.status, 200, "运营把 2 阶称号切到 grant 渠道");
    const offChain = await api(base, "POST", `/api/roles/${growthRoleId}/growth-upgrade`, {
      token: growthPlayer,
      body: { kind: "title", targetLevel: 3, revision: growthRevision },
    });
    checkEqual(offChain.status, 409, "当前阶掉出升级链后升级 → 409");
    checkEqual(offChain.body?.code, 20010, "称号不在升级链上 → 20010（渠道锁定）");
    const restore2 = await api(base, "PATCH", `/api/admin/titles/2`, { token, body: { acquireChannel: "upgrade" } });
    checkEqual(restore2.status, 200, "还原 2 阶称号渠道");

    // 战魂：37 阶全量持序，0 阶升 1 阶
    // （前面 region 把成长列表重排成了 [2,1,3,...] —— 先还原为阶数序，升级链再从 1 阶起步）
    const restoreSoulOrder = await api(base, "PATCH", "/api/admin/souls/upgrade-order", { token, body: { levels: soulLevels } });
    checkEqual(restoreSoulOrder.status, 200, "前置清理：战魂成长列表还原为阶数序");
    const soulPrice = (
      await api(base, "GET", "/api/admin/souls", { token })
    ).body?.data?.list?.find((row) => row.level === 1)?.bindGold;
    const upSoul = await api(base, "POST", `/api/roles/${growthRoleId}/growth-upgrade`, {
      token: growthPlayer,
      body: { kind: "soul", targetLevel: 1, revision: growthRevision },
    });
    checkEqual(upSoul.status, 200, "升 1 阶战魂 → 200");
    checkEqual(upSoul.body?.data?.consumed, soulPrice, "战魂 consumed = 库里 1 阶价格");
    checkEqual(upSoul.body?.data?.data?.soulOfWar, 1, "存档 soulOfWar 推进到 1");
    checkEqual(upSoul.body?.data?.data?.title, 2, "战魂升级不动称号（字段隔离）");
    growthRevision = upSoul.body?.data?.revision;

    // 军衔：天然按阶（无 upgrade_order 概念），0 阶升 1 阶
    const rankPrice = (
      await api(base, "GET", "/api/admin/ranks", { token })
    ).body?.data?.list?.find((row) => row.level === 1)?.bindGold;
    const upRank = await api(base, "POST", `/api/roles/${growthRoleId}/growth-upgrade`, {
      token: growthPlayer,
      body: { kind: "rank", targetLevel: 1, revision: growthRevision },
    });
    checkEqual(upRank.status, 200, "升 1 阶军衔 → 200");
    checkEqual(upRank.body?.data?.consumed, rankPrice, "军衔 consumed = 库里 1 阶价格");
    checkEqual(upRank.body?.data?.data?.rank, 1, "存档 rank 推进到 1");
    checkEqual(upRank.body?.data?.data?.soulOfWar, 1, "军衔升级不动战魂（字段隔离）");

    // kind 越界 → DTO 拒收
    const badKind = await api(base, "POST", `/api/roles/${growthRoleId}/growth-upgrade`, {
      token: growthPlayer,
      body: { kind: "fashion", targetLevel: 1 },
    });
    checkEqual(badKind.status, 400, "kind 越界 → 400（whitelist 拒收）");

    // 还原称号渠道（不污染其他断言的 seed 前提）
    const restore1 = await api(base, "PATCH", `/api/admin/titles/1`, { token, body: { acquireChannel: "unavailable" } });
    checkEqual(restore1.status, 200, "还原 1 阶称号渠道（seed 前提复原）");

    //#endregion

    //#region 十八、商城购买：扣费与入包在服务端（#304）
    group("十八、商城购买：扣费与入包在服务端");

    const mallPlayer = await registerPlayer("mall_player");
    check(Boolean(mallPlayer), "商城玩家注册成功");
    // 满背包网格（bagRow×bagCol 由客户端配置重塑；这里构造全满 4×6）+ 0 元宝
    const fullBag = Array.from({ length: 4 }, () => Array.from({ length: 6 }, () => ({ id: "cloth_1_p0s0", count: 1 })));
    const emptyBag = Array.from({ length: 4 }, () => Array.from({ length: 6 }, () => null));
    const mallCreate = await api(base, "POST", "/api/roles", {
      token: mallPlayer,
      body: {
        data: {
          id: "mall_role_1",
          name: "商城测试员",
          occupation: "1",
          sex: "1",
          level: 1,
          bindGold: 0,
          gold: 0,
          bag: fullBag,
        },
      },
    });
    checkEqual(mallCreate.status, 201, "创建满背包测试角色 → 201");
    const mallRoleId = mallCreate.body?.data?.id;

    // 商品不在目录（非装备变体）→ 404 复用 50021
    const badGood = await api(base, "POST", `/api/roles/${mallRoleId}/mall-purchase`, {
      token: mallPlayer,
      body: { goodId: "drug_hp_small" },
    });
    checkEqual(badGood.status, 404, "非装备 id 购买 → 404（商城只卖装备变体）");
    checkEqual(badGood.body?.code, 50021, "商品不在目录 → 50021");

    // 背包满 → 20012（先于元宝不足：入包前先扣费的设计下顺序是 价→钱→包，但这里钱也不足……先充值再测满包）
    const richMall = await api(base, "PUT", `/api/roles/${mallRoleId}`, {
      token: mallPlayer,
      body: { data: { ...mallCreate.body?.data?.data, bindGold: 1000000000, bag: fullBag } },
    });
    checkEqual(richMall.status, 200, "充值并保持满背包");
    const fullBagBuy = await api(base, "POST", `/api/roles/${mallRoleId}/mall-purchase`, {
      token: mallPlayer,
      body: { goodId: "cloth_1_p0s1", revision: richMall.body?.data?.revision },
    });
    checkEqual(fullBagBuy.status, 409, "满背包购买 → 409");
    checkEqual(fullBagBuy.body?.code, 20012, "背包已满 → 20012");

    // 腾出背包：换成空网格；统一价是 1（MALL.defaultPrice），0 元宝必不足
    const emptied = await api(base, "PUT", `/api/roles/${mallRoleId}`, {
      token: mallPlayer,
      body: { data: { ...mallCreate.body?.data?.data, bindGold: 0, bag: emptyBag } },
    });
    checkEqual(emptied.status, 200, "改为空网格 + 0 元宝（故意不足）");
    const poorBuy = await api(base, "POST", `/api/roles/${mallRoleId}/mall-purchase`, {
      token: mallPlayer,
      body: { goodId: "cloth_1_p0s1", revision: emptied.body?.data?.revision },
    });
    checkEqual(poorBuy.status, 409, "元宝不足购买 → 409");
    checkEqual(poorBuy.body?.code, 20011, "绑定元宝不足 → 20011");

    // 管理端给 cloth_1_p0s1 设特殊价 777（改价对购买即时生效的直接证明）
    const setPrice = await api(base, "PUT", "/api/admin/mall/prices/cloth_1_p0s1", { token, body: { price: 777 } });
    checkEqual(setPrice.status, 200, "管理端设特殊价 777");

    const recharge = await api(base, "PUT", `/api/roles/${mallRoleId}`, {
      token: mallPlayer,
      body: { data: { ...mallCreate.body?.data?.data, bindGold: 1000, bag: emptyBag } },
    });
    checkEqual(recharge.status, 200, "充值 1000 元宝");
    const staleRev = recharge.body?.data?.revision;

    const staleBuy = await api(base, "POST", `/api/roles/${mallRoleId}/mall-purchase`, {
      token: mallPlayer,
      body: { goodId: "cloth_1_p0s1", revision: staleRev - 1 },
    });
    checkEqual(staleBuy.status, 409, "带旧修订号购买 → 409");
    checkEqual(staleBuy.body?.code, 20006, "乐观锁冲突 → 20006");

    const bought = await api(base, "POST", `/api/roles/${mallRoleId}/mall-purchase`, {
      token: mallPlayer,
      body: { goodId: "cloth_1_p0s1", revision: staleRev },
    });
    checkEqual(bought.status, 200, "购买成功 → 200");
    checkEqual(bought.body?.data?.consumed, 777, "consumed = 特殊价 777（管理端改价即时生效）");
    checkEqual(bought.body?.data?.data?.bindGold, 1000 - 777, "存档 bindGold 扣减到位");
    checkEqual(bought.body?.data?.revision, staleRev + 1, "revision 原子 +1");
    const bagAfter = bought.body?.data?.data?.bag;
    check(Array.isArray(bagAfter), "返回存档带 bag 网格");
    checkEqual(bagAfter?.[0]?.[0]?.id, "cloth_1_p0s1", "物品放在网格首个空格（行优先）");
    checkEqual(bagAfter?.[0]?.[0]?.count, 1, "放入数量 = 1");

    // 清掉特殊价（还原统一价前提，避免污染后续）
    const clearPrice = await api(base, "DELETE", "/api/admin/mall/prices/cloth_1_p0s1", { token });
    checkEqual(clearPrice.status, 200, "清掉特殊价（还原统一价）");

    //#endregion

    //#region 十九、药品使用：回复结算与扣减在服务端（#308）

    group("十九、药品使用：回复结算与扣减在服务端");

    // 前置清理：region 五把 drug_hp_1 的回复量改成了 120 且未还原（共享 DB 顺序跑），
    // 这里显式设回 seed 口径再开测，不假设前面 region 的遗留状态
    const drugBaseline = await api(base, "PATCH", "/api/admin/drugs/drug_hp_1", { token, body: { effectHp: 60 } });
    checkEqual(drugBaseline.status, 200, "前置：drug_hp_1 回复量归位 60");

    const drugPlayer = await registerPlayer("drug_player");
    check(Boolean(drugPlayer), "药品玩家注册成功");
    const drugBag = Array.from({ length: 4 }, () => Array.from({ length: 6 }, () => null));
    drugBag[0][0] = { id: "drug_hp_1", count: 2 };
    const drugCreate = await api(base, "POST", "/api/roles", {
      token: drugPlayer,
      body: {
        data: {
          id: "drug_role_1",
          name: "药品测试员",
          occupation: "1",
          sex: "1",
          level: 1,
          hp: 10,
          mp: 10,
          bag: drugBag,
        },
      },
    });
    checkEqual(drugCreate.status, 201, "创建药品测试角色 → 201");
    const drugRoleId = drugCreate.body?.data?.id;
    const drugRev0 = drugCreate.body?.data?.revision;

    // seed 回复量：drug_hp_1 固定回 60（1 级角色 maxHp 远大于 70，不会触顶）
    const drugUsed = await api(base, "POST", `/api/roles/${drugRoleId}/drug-use`, {
      token: drugPlayer,
      body: { row: 0, col: 0, revision: drugRev0 },
    });
    checkEqual(drugUsed.status, 200, "使用金创药（小）→ 200");
    checkEqual(drugUsed.body?.data?.recoveredHp, 60, "recoveredHp = seed 回复量 60（结算走 drugs 表）");
    checkEqual(drugUsed.body?.data?.data?.hp, 70, "存档 hp = 10 + 60");
    checkEqual(drugUsed.body?.data?.data?.bag?.[0]?.[0]?.count, 1, "格子数量 2 → 1（服务端扣减）");
    checkEqual(drugUsed.body?.data?.revision, drugRev0 + 1, "revision 原子 +1");

    const staleDrug = await api(base, "POST", `/api/roles/${drugRoleId}/drug-use`, {
      token: drugPlayer,
      body: { row: 0, col: 0, revision: drugRev0 },
    });
    checkEqual(staleDrug.status, 409, "带旧修订号用药 → 409");
    checkEqual(staleDrug.body?.code, 20006, "乐观锁冲突 → 20006");

    // 管理端改回复量即时生效（#253 数值读库，与怪物数值同一取向）
    const editDrug = await api(base, "PATCH", "/api/admin/drugs/drug_hp_1", { token, body: { effectHp: 100000 } });
    checkEqual(editDrug.status, 200, "管理端把回复量改成 100000");
    const bigHeal = await api(base, "POST", `/api/roles/${drugRoleId}/drug-use`, {
      token: drugPlayer,
      body: { row: 0, col: 0, revision: drugUsed.body?.data?.revision },
    });
    checkEqual(bigHeal.status, 200, "改后再用 → 200");
    check(bigHeal.body?.data?.recoveredHp > 0, "大回复量生效（recoveredHp > 0）");
    checkEqual(bigHeal.body?.data?.data?.bag?.[0]?.[0], null, "数量减到 0 → 格子清空");
    // 上面 100000 已被 maxHp 封顶（hp 已满）→ 再用必拒：同时证明回复被资源上限封住
    // （大回复那一次已把格子用空，先补一格药并保持血量已满）
    const refillBag = Array.from({ length: 4 }, () => Array.from({ length: 6 }, () => null));
    refillBag[0][0] = { id: "drug_hp_1", count: 1 };
    const refillSave = await api(base, "PUT", `/api/roles/${drugRoleId}`, {
      token: drugPlayer,
      body: { data: { ...drugCreate.body?.data?.data, hp: bigHeal.body?.data?.data?.hp, bag: refillBag } },
    });
    checkEqual(refillSave.status, 200, "补一格药（血量保持已满）");
    const hpFullUse = await api(base, "POST", `/api/roles/${drugRoleId}/drug-use`, {
      token: drugPlayer,
      body: { row: 0, col: 0, revision: refillSave.body?.data?.revision },
    });
    checkEqual(hpFullUse.status, 409, "血量已满再用 → 409");
    checkEqual(hpFullUse.body?.code, 20014, "无需用药 → 20014");

    // 太阳水：血满蓝不满也照用，只回蓝的部分（recoveredHp = 0）
    const sunBag = Array.from({ length: 4 }, () => Array.from({ length: 6 }, () => null));
    sunBag[0][1] = { id: "drug_sun", count: 1 };
    const sunSave = await api(base, "PUT", `/api/roles/${drugRoleId}`, {
      token: drugPlayer,
      body: { data: { ...drugCreate.body?.data?.data, hp: 999999, mp: 10, bag: sunBag } },
    });
    checkEqual(sunSave.status, 200, "摆好太阳水（血满蓝低）");
    const sunUsed = await api(base, "POST", `/api/roles/${drugRoleId}/drug-use`, {
      token: drugPlayer,
      body: { row: 0, col: 1, revision: sunSave.body?.data?.revision },
    });
    checkEqual(sunUsed.status, 200, "血满蓝不满用太阳水 → 200");
    checkEqual(sunUsed.body?.data?.recoveredHp, 0, "血量已满 → recoveredHp = 0");
    check(sunUsed.body?.data?.recoveredMp > 0, "魔法分量照回（recoveredMp > 0）");
    checkEqual(
      sunUsed.body?.data?.data?.mp,
      10 + sunUsed.body?.data?.recoveredMp,
      "存档 mp = 用前 + 实际回复（服务端 maxMp 封顶后）",
    );

    // 血蓝全满 → 拒用不扣药
    const fullSave = await api(base, "PUT", `/api/roles/${drugRoleId}`, {
      token: drugPlayer,
      body: { data: { ...drugCreate.body?.data?.data, hp: 999999, mp: 999999, bag: drugBag } },
    });
    checkEqual(fullSave.status, 200, "摆好满血满蓝 + 一格药");
    const allFullUse = await api(base, "POST", `/api/roles/${drugRoleId}/drug-use`, {
      token: drugPlayer,
      body: { row: 0, col: 0, revision: fullSave.body?.data?.revision },
    });
    checkEqual(allFullUse.status, 409, "血蓝全满用药 → 409");
    checkEqual(allFullUse.body?.code, 20014, "血蓝全满 → 20014");
    // 失败不产生任何写入：revision 不推进、药不扣
    const afterFull = await api(base, "GET", `/api/roles/${drugRoleId}`, { token: drugPlayer });
    checkEqual(afterFull.body?.data?.revision, fullSave.body?.data?.revision, "拒绝用药不推进 revision");
    checkEqual(afterFull.body?.data?.data?.bag?.[0]?.[0]?.count, 2, "拒绝用药不扣药（数量仍 2）");

    // 目标不合法：非药品格子 / 空格子 / 坐标越界
    const equipBag = Array.from({ length: 4 }, () => Array.from({ length: 6 }, () => null));
    equipBag[1][0] = { id: "cloth_1_p0s0", count: 1 };
    const equipSave = await api(base, "PUT", `/api/roles/${drugRoleId}`, {
      token: drugPlayer,
      body: { data: { ...drugCreate.body?.data?.data, hp: 10, mp: 10, bag: equipBag } },
    });
    checkEqual(equipSave.status, 200, "摆好一格装备");
    const equipUse = await api(base, "POST", `/api/roles/${drugRoleId}/drug-use`, {
      token: drugPlayer,
      body: { row: 1, col: 0, revision: equipSave.body?.data?.revision },
    });
    checkEqual(equipUse.status, 409, "用装备格子 → 409");
    checkEqual(equipUse.body?.code, 20013, "非药品 → 20013");
    const emptyUse = await api(base, "POST", `/api/roles/${drugRoleId}/drug-use`, {
      token: drugPlayer,
      body: { row: 3, col: 5 },
    });
    checkEqual(emptyUse.status, 409, "空格子 → 409");
    checkEqual(emptyUse.body?.code, 20013, "格子为空 → 20013");
    const badRow = await api(base, "POST", `/api/roles/${drugRoleId}/drug-use`, {
      token: drugPlayer,
      body: { row: -1, col: 0 },
    });
    checkEqual(badRow.status, 400, "row 为负 → 400（DTO 拦下）");
    const bigRow = await api(base, "POST", `/api/roles/${drugRoleId}/drug-use`, {
      token: drugPlayer,
      body: { row: 999, col: 0 },
    });
    checkEqual(bigRow.status, 400, "row 越界 → 400（DTO 拦下）");

    // 还原药品回复量（不污染其他断言的 seed 前提）
    const restoreDrug = await api(base, "PATCH", "/api/admin/drugs/drug_hp_1", { token, body: { effectHp: 60 } });
    checkEqual(restoreDrug.status, 200, "还原 drug_hp_1 回复量 60（seed 前提复原）");

    //#endregion

    //#region 二十、技能与状态配置（#367）：同表分归属 / 释放限制 / 跨字段约束 / 下发快照

    group("二十、技能与状态配置");

    const skillTotal = Object.keys(shared.SKILLS).length;
    const roleSkillTotal = Object.values(shared.SKILLS).filter((row) => row.owner === "role").length;
    const statusTotal = Object.keys(shared.STATUSES).length;

    const skills = await api(base, "GET", "/api/admin/skills?size=100", { token });
    checkEqual(skills.status, 200, "技能列表可读");
    checkEqual(skills.body?.data?.total, skillTotal, `技能行数 = 配置表（${skillTotal}）`);
    checkEqual(skills.body?.data?.list?.[0]?.id, "1000", "默认按 id 数值升序（角色 1000 段在前）");

    const roleSkills = await api(base, "GET", "/api/admin/skills?owner=role&size=100", { token });
    checkEqual(roleSkills.body?.data?.total, roleSkillTotal, `owner=role 筛出全部角色技能（${roleSkillTotal}）`);
    const monsterSkills = await api(base, "GET", "/api/admin/skills?owner=monster", { token });
    checkEqual(
      monsterSkills.body?.data?.total,
      skillTotal - roleSkillTotal,
      `owner=monster 筛出全部怪物技能（${skillTotal - roleSkillTotal} 个，9000 段）`,
    );
    const badOwner = await api(base, "GET", "/api/admin/skills?owner=boss", { token });
    checkEqual(badOwner.status, 400, "owner 不在枚举里 → 400");

    const skill1000 = roleSkills.body?.data?.list?.find((row) => row.id === "1000");
    check(Boolean(skill1000), "列表里有技能 1000");
    checkEqual(skill1000?.label, shared.SKILLS["1000"].label, "技能 1000 名称与配置一致");
    checkEqual(skill1000?.castLockMs, shared.SKILLS["1000"].castLockMs, "castLockMs seed 与配置一致");
    checkEqual(skill1000?.requireTarget, shared.SKILLS["1000"].requireTarget, "requireTarget seed 与配置一致");
    checkEqual(
      skill1000?.damageCoefficients?.length,
      shared.SKILLS["1000"].damageCoefficients.length,
      "伤害系数条数 = 配置表（下标 = 等级 - 1）",
    );
    const skill1010 = roleSkills.body?.data?.list?.find((row) => row.id === "1010");
    checkEqual(skill1010?.statusId, "2001", "状态型技能 1010 的 statusId 来自配置（不再手写映射表）");
    checkEqual(skill1010?.requireTarget, false, "状态型技能不要求目标");

    const skillKeyword = await api(base, "GET", "/api/admin/skills?keyword=" + encodeURIComponent("逐日"), { token });
    checkEqual(skillKeyword.body?.data?.total, 1, "关键字按技能名命中「逐日剑法」");

    // —— 能力边界：角色技能清单固定（只可改），怪物技能可增删（#372） ——
    const postRoleSkill = await api(base, "POST", "/api/admin/skills", { token, body: { id: "1012", owner: "role" } });
    checkEqual(postRoleSkill.status, 400, "POST 角色技能 → 400（只许建怪物技能）");
    const deleteRoleSkill = await api(base, "DELETE", "/api/admin/skills/1000", { token });
    checkEqual(deleteRoleSkill.status, 400, "DELETE 角色技能 → 400（技能栏 / 存档按 id 引用）");
    const ghostSkill = await api(base, "PATCH", "/api/admin/skills/9999", { token, body: { label: "x" } });
    checkEqual(ghostSkill.status, 404, "改不存在的技能 → 404");
    checkEqual(ghostSkill.body?.code, 50029, "技能未找到用专属业务码 50029");
    const patchOwner = await api(base, "PATCH", "/api/admin/skills/1000", { token, body: { owner: "monster" } });
    checkEqual(patchOwner.status, 200, "请求体里塞 owner 不会报错（白名单直接剥掉）");
    checkEqual(patchOwner.body?.data?.owner, "role", "owner 是行身份，改不了");

    const badCooldown = await api(base, "PATCH", "/api/admin/skills/1000", { token, body: { cooldown: -1 } });
    checkEqual(badCooldown.status, 400, "冷却为负 → 400（DTO 拦下）");
    const badCategory = await api(base, "PATCH", "/api/admin/skills/1000", { token, body: { category: "9" } });
    checkEqual(badCategory.status, 400, "分类不在枚举里 → 400（DTO 拦下）");

    // —— 跨字段约束：状态型必须挂状态 / 主动必须能打出伤害 / 状态必须真实存在 ——
    const statusWithoutId = await api(base, "PATCH", "/api/admin/skills/1000", { token, body: { category: "2", statusId: "" } });
    checkEqual(statusWithoutId.status, 400, "状态型技能不给 statusId → 400");
    checkEqual(statusWithoutId.body?.code, 40000, "状态型技能缺状态 → 40000（跨字段约束）");
    const noCoefficients = await api(base, "PATCH", "/api/admin/skills/1000", { token, body: { damageCoefficients: [] } });
    checkEqual(noCoefficients.status, 400, "主动技能把倍率清空 → 400");
    checkEqual(noCoefficients.body?.code, 40000, "主动技能零倍率 → 40000（伤害会恒为 0）");
    const ghostStatusRef = await api(base, "PATCH", "/api/admin/skills/1000", { token, body: { statusId: "9999" } });
    checkEqual(ghostStatusRef.status, 404, "statusId 指向不存在的状态 → 404");
    checkEqual(ghostStatusRef.body?.code, 50030, "状态未找到用专属业务码 50030");
    // 与约束无关的字段照常可改：1008 是「分类主动但倍率空」的历史行，不该连改名都改不了
    const patchLock = await api(base, "PATCH", "/api/admin/skills/1008", { token, body: { castLockMs: 500 } });
    checkEqual(patchLock.status, 200, "历史不一致行改释放限制字段不被跨字段约束拦下");
    checkEqual(patchLock.body?.data?.castLockMs, 500, "动作锁已写入");
    checkEqual(patchLock.body?.data?.damageCoefficients?.length, 0, "顺带断言：1008 的倍率保持原样（空）");

    // —— 正常更新生效：释放限制三件套 ——
    const patchSkill = await api(base, "PATCH", "/api/admin/skills/1000", {
      token,
      body: { cooldown: 2.5, mpCost: 3, castLockMs: 700, requireTarget: false, canAuto: false },
    });
    checkEqual(patchSkill.status, 200, "PATCH 技能成功（冷却 / 耗蓝 / 动作锁 / 目标要求 / 自动释放）");
    checkEqual(patchSkill.body?.data?.cooldown, 2.5, "响应里的冷却已更新");
    checkEqual(patchSkill.body?.data?.castLockMs, 700, "响应里的动作锁已更新");
    checkEqual(patchSkill.body?.data?.requireTarget, false, "响应里的「要求目标」已关掉");
    const skillReread = await api(base, "GET", "/api/admin/skills?keyword=1000", { token });
    checkEqual(skillReread.body?.data?.list?.[0]?.cooldown, 2.5, "重新读取冷却已是新值（落库了）");

    // —— 状态表 ——
    const statuses = await api(base, "GET", "/api/admin/statuses", { token });
    checkEqual(statuses.status, 200, "状态列表可读");
    checkEqual(statuses.body?.data?.total, statusTotal, `状态行数 = 配置表（${statusTotal}）`);
    const status2001 = statuses.body?.data?.list?.find((row) => row.id === "2001");
    check(Boolean(status2001), "列表里有状态 2001");
    checkEqual(status2001?.label, shared.STATUSES["2001"].label, "状态 2001 名称与配置一致");
    checkEqual(status2001?.duration, shared.STATUSES["2001"].duration, "持续时间 seed 与配置一致");
    checkEqual(status2001?.combat?.blockChance, 0.3, "格挡概率 seed 与配置一致");
    checkEqual(status2001?.combat?.blockFactor, 0.5, "格挡系数 seed 与配置一致");
    check(status2001?.combat?.defenseMultiplier === undefined, "没配的维度不出现在 combat 里（不是 0）");
    const status2002 = statuses.body?.data?.list?.find((row) => row.id === "2002");
    checkEqual(status2002?.combat?.defenseMultiplier, 1.5, "状态 2002 的防御倍率 seed 与配置一致");
    checkEqual(status2002?.effectHoldLast, false, "特效不停尾帧（脉冲类才勾）");

    const patchStatus = await api(base, "PATCH", "/api/admin/statuses/2001", {
      token,
      body: { duration: 20, combat: { blockChance: 0.4, blockFactor: 0.4, defenseMultiplier: 1.2 } },
    });
    checkEqual(patchStatus.status, 200, "PATCH 状态成功（时长 + 三项修正整份替换）");
    checkEqual(patchStatus.body?.data?.duration, 20, "响应里的持续时间已更新");
    checkEqual(patchStatus.body?.data?.combat?.blockChance, 0.4, "响应里的格挡概率已更新");
    checkEqual(patchStatus.body?.data?.combat?.defenseMultiplier, 1.2, "响应里新增的防御倍率已写入");
    const clearCombat = await api(base, "PATCH", "/api/admin/statuses/2001", { token, body: { combat: {} } });
    checkEqual(clearCombat.status, 200, "combat 传空对象 → 200");
    checkEqual(Object.keys(clearCombat.body?.data?.combat ?? {}).length, 0, "空对象 = 纯表现状态（整份替换，不是合并）");
    const badBlock = await api(base, "PATCH", "/api/admin/statuses/2001", { token, body: { combat: { blockChance: 1.5 } } });
    checkEqual(badBlock.status, 400, "格挡概率 > 1 → 400（DTO 拦下）");
    const ghostStatusPatch = await api(base, "PATCH", "/api/admin/statuses/9999", { token, body: { label: "x" } });
    checkEqual(ghostStatusPatch.status, 404, "改不存在的状态 → 404");
    checkEqual(ghostStatusPatch.body?.code, 50030, "不存在状态 → 50030");
    const postStatus = await api(base, "POST", "/api/admin/statuses", { token, body: { id: "3001" } });
    checkEqual(postStatus.status, 404, "POST 状态 → 404（路由不存在）");
    const deleteStatus = await api(base, "DELETE", "/api/admin/statuses/2001", { token });
    checkEqual(deleteStatus.status, 404, "DELETE 状态 → 404（路由不存在）");

    // —— 权限：观察员可读不可写 ——
    const viewerSkillRead = await api(base, "GET", "/api/admin/skills", { token: viewerToken });
    checkEqual(viewerSkillRead.body?.code, 0, "观察员能看技能配置");
    const viewerSkillWrite = await api(base, "PATCH", "/api/admin/skills/1000", { token: viewerToken, body: { label: "x" } });
    checkEqual(viewerSkillWrite.status, 403, "观察员改技能 → 403");
    checkEqual(viewerSkillWrite.body?.code, 30006, "观察员改技能 → 30006（权限点不足）");

    // —— 下发通道：管理端改完，客户端快照跟着变 ——
    const skillSnapshot = await api(base, "GET", "/api/game-config", { token: playerToken });
    const snapSkill1000 = skillSnapshot.body?.data?.skills?.find((row) => row.id === "1000");
    checkEqual(snapSkill1000?.cooldown, 2.5, "快照里的技能已是管理端改过的冷却");
    checkEqual(snapSkill1000?.castLockMs, 700, "快照里的技能带释放动作锁（客户端按它锁出手）");
    const snapStatus2001 = skillSnapshot.body?.data?.statuses?.find((row) => row.id === "2001");
    checkEqual(Object.keys(snapStatus2001?.combat ?? {}).length, 0, "快照里的状态修正跟着被清空（改配置对客户端生效的通道）");

    // 还原 seed 前提（不给后续追加的断言留脏数据）
    const restoreSkill = await api(base, "PATCH", "/api/admin/skills/1000", {
      token,
      body: { cooldown: 1, mpCost: 0, castLockMs: 0, requireTarget: true, canAuto: true },
    });
    checkEqual(restoreSkill.status, 200, "还原技能 1000 的释放限制");
    const restoreSkill1008 = await api(base, "PATCH", "/api/admin/skills/1008", { token, body: { castLockMs: 0 } });
    checkEqual(restoreSkill1008.status, 200, "还原技能 1008 的动作锁");
    const restoreStatus = await api(base, "PATCH", "/api/admin/statuses/2001", {
      token,
      body: { duration: shared.STATUSES["2001"].duration, combat: { blockChance: 0.3, blockFactor: 0.5 } },
    });
    checkEqual(restoreStatus.status, 200, "还原状态 2001 的时长与修正");

    //#endregion

    //#region 二十一、怪物技能与挂载（#372）：9000 段可增删 / 挂载整份替换 / 攻击倍率

    group("二十一、怪物技能与挂载");

    const mountSeed = shared.MONSTER_SKILLS["200"];
    const mountList = await api(base, "GET", "/api/admin/monsters/200/skills", { token });
    checkEqual(mountList.status, 200, "怪物 200 的技能挂载可读");
    checkEqual(mountList.body?.data?.total, mountSeed.length, `挂载条数 = 配置表（${mountSeed.length} 条）`);
    checkEqual(mountList.body?.data?.list?.[0]?.skillId, "9002", "按优先级升序（priority 1 的排前）");
    checkEqual(
      mountList.body?.data?.list?.map((row) => row.skillId).join(","),
      "9002,9003,9001",
      "同优先级按技能 id 升序，priority 2 的 9001 收尾",
    );
    checkEqual(mountList.body?.data?.list?.[0]?.skillLabel, shared.SKILLS["9002"].label, "挂载行带技能名（列表不用再查一次技能表）");
    check(mountList.body?.data?.list?.[0]?.cooldown === null, "没配冷却覆写时是 null（= 回落到技能自身的 cooldown）");

    const ghostMount = await api(base, "GET", "/api/admin/monsters/monster_nope/skills", { token });
    checkEqual(ghostMount.status, 404, "未知怪物的挂载 → 404");
    checkEqual(ghostMount.body?.code, 50019, "怪物不存在 → 50019");

    // —— 整份替换：请求体就是全部，没写到等于删除 ——
    const replaceOne = await api(base, "PUT", "/api/admin/monsters/200/skills", {
      token,
      body: { skills: [{ skillId: "9001", priority: 5, cooldown: 3 }] },
    });
    checkEqual(replaceOne.status, 200, "PUT 整份替换 → 200");
    checkEqual(replaceOne.body?.data?.total, 1, "响应就是替换后的清单（1 条）");
    checkEqual(replaceOne.body?.data?.list?.[0]?.priority, 5, "优先级已写入");
    checkEqual(replaceOne.body?.data?.list?.[0]?.cooldown, 3, "冷却覆写已写入");
    const rereadMount = await api(base, "GET", "/api/admin/monsters/200/skills", { token });
    checkEqual(rereadMount.body?.data?.list?.[0]?.skillId, "9001", "重新读取只剩这一条（原清单被整份换掉）");

    const roleMount = await api(base, "PUT", "/api/admin/monsters/200/skills", {
      token,
      body: { skills: [{ skillId: "1000", priority: 1 }] },
    });
    checkEqual(roleMount.status, 400, "把角色技能挂给怪 → 400");
    checkEqual(roleMount.body?.code, 40000, "角色技能没有怪物释放路径 → 40000");
    const dupMount = await api(base, "PUT", "/api/admin/monsters/200/skills", {
      token,
      body: { skills: [{ skillId: "9001", priority: 1 }, { skillId: "9001", priority: 2 }] },
    });
    checkEqual(dupMount.status, 400, "同一只怪重复挂同一个技能 → 400");
    checkEqual(dupMount.body?.code, 40000, "重复挂载 → 40000（会让 AI 白跑一轮冷却）");
    const ghostSkillMount = await api(base, "PUT", "/api/admin/monsters/200/skills", { token, body: { skills: [{ skillId: "9999" }] } });
    checkEqual(ghostSkillMount.status, 404, "挂不存在的技能 → 404");
    checkEqual(ghostSkillMount.body?.code, 50029, "技能不存在 → 50029");
    const clearMount = await api(base, "PUT", "/api/admin/monsters/200/skills", { token, body: { skills: [] } });
    checkEqual(clearMount.body?.data?.total, 0, "空数组 = 清空挂载（AI 回退到普攻）");

    // —— 9000 段技能的增删 ——
    const created = await api(base, "POST", "/api/admin/skills", {
      token,
      body: {
        id: "9004",
        label: "测试撕咬",
        category: "0",
        targetType: "1",
        damageCoefficients: [{ baseType: "physicalAttack", baseTypeRate: 1.2 }],
        cooldown: 4,
        distance: 80,
      },
    });
    checkEqual(created.status, 201, "POST 新建怪物技能 → 201");
    checkEqual(created.body?.data?.owner, "monster", "新建的行归属怪物");
    const dupId = await api(base, "POST", "/api/admin/skills", { token, body: { id: "9004", label: "重复" } });
    checkEqual(dupId.status, 400, "重复 id → 400");
    checkEqual(dupId.body?.code, 40000, "重复 id → 40000");
    const outOfRange = await api(base, "POST", "/api/admin/skills", { token, body: { id: "8888", label: "越界" } });
    checkEqual(outOfRange.status, 400, "id 不在 9000 段 → 400（DTO 拦下，角色技能不许造）");
    const stateNoStatus = await api(base, "POST", "/api/admin/skills", { token, body: { id: "9005", label: "缺状态", category: "2" } });
    checkEqual(stateNoStatus.status, 400, "状态型不给状态 → 400");
    checkEqual(stateNoStatus.body?.code, 40000, "状态型不给状态 → 40000（建行时全量校验）");
    const mountCreated = await api(base, "PUT", "/api/admin/monsters/200/skills", {
      token,
      body: { skills: [{ skillId: "9004", priority: 1 }] },
    });
    checkEqual(mountCreated.body?.data?.total, 1, "新建的技能可以挂给怪（挂载只看 owner=monster）");
    const delReferenced = await api(base, "DELETE", "/api/admin/skills/9004", { token });
    checkEqual(delReferenced.status, 400, "删被挂载引用中的技能 → 400");
    checkEqual(delReferenced.body?.code, 40000, "被引用拒删 → 40000（先解绑）");
    await api(base, "PUT", "/api/admin/monsters/200/skills", { token, body: { skills: [] } });
    const delOk = await api(base, "DELETE", "/api/admin/skills/9004", { token });
    checkEqual(delOk.status, 200, "解绑后删除 → 200");
    check(delOk.body?.data === null, "删除接口 data 为 null（@ApiVoidResponse 口径）");
    const ghostAfterDelete = await api(base, "GET", "/api/admin/skills?keyword=9004", { token });
    checkEqual(ghostAfterDelete.body?.data?.total, 0, "删掉后列表里查不到（真的出库了）");

    // —— 攻击倍率：怪物状态真的乘在出手伤害上 ——
    const allStatuses = await api(base, "GET", "/api/admin/statuses?size=100", { token });
    const fury = allStatuses.body?.data?.list?.find((row) => row.id === "9001");
    checkEqual(fury?.combat?.attackMultiplier, 1.5, "狂怒的攻击倍率 seed 与配置一致");
    const patchFury = await api(base, "PATCH", "/api/admin/statuses/9001", { token, body: { combat: { attackMultiplier: 2 } } });
    checkEqual(patchFury.body?.data?.combat?.attackMultiplier, 2, "攻击倍率可改（服务端 AI 按它乘出手伤害）");
    const badFury = await api(base, "PATCH", "/api/admin/statuses/9001", { token, body: { combat: { attackMultiplier: 50 } } });
    checkEqual(badFury.status, 400, "攻击倍率 > 10 → 400（DTO 拦下）");

    const monsterSnap = await api(base, "GET", "/api/game-config", { token: playerToken });
    const snapFury = monsterSnap.body?.data?.statuses?.find((row) => row.id === "9001");
    checkEqual(snapFury?.combat?.attackMultiplier, 2, "快照里的攻击倍率跟着改（客户端与 AI 同一份数值）");
    const snapMonsterSkill = monsterSnap.body?.data?.skills?.find((row) => row.id === "9003");
    check(snapMonsterSkill?.owner === "monster", "怪物技能随快照下发（客户端按它播 casts 的动作与特效）");

    // 还原 seed 前提（本节改过状态修正与挂载清单）
    const restoreFury = await api(base, "PATCH", "/api/admin/statuses/9001", { token, body: { combat: { attackMultiplier: 1.5 } } });
    checkEqual(restoreFury.status, 200, "还原狂怒的攻击倍率");
    const restoreMounts = await api(base, "PUT", "/api/admin/monsters/200/skills", { token, body: { skills: mountSeed } });
    checkEqual(restoreMounts.body?.data?.total, mountSeed.length, "还原怪物 200 的挂载（seed 前提复原）");

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
