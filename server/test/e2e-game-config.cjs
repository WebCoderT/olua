#!/usr/bin/env node
/**
 * 服务端 e2e：养成配置管理（称号 / 战魂）
 *
 * 与其余几套同一套路（真实进程 + 真实 HTTP，跑 dist/ 产物）。单独成文件是因为
 * 这一模块的核心约束是「**只许改，不许增删**」——这是需求方明确要的行为边界：
 *
 * ## 三条主线
 * 1. **seed 同源**：启动时从配置快照（config-sync.sql）灌库，断言行数（34/37）、默认渠道、
 *    名与价格与客户端配置逐字段一致 —— 运营看到的初始表就是玩家侧数值。
 * 2. **能力边界**：装备可以新建 / 删除（#773，连带展开变体、商城在架拒删），称号 / 战魂 /
 *    军衔 / 槽位仍是「只能改」（POST / DELETE 路由不存在 → 404）；改不存在的行 → 404 + 专属
 *    业务码；参数越界（渠道枚举外 / 负价格 / min>max）→ 400。
 * 3. **改了真生效**：PATCH 部分更新后 GET 反映；渠道筛选跟着变；观察员可读不可写。
 *
 * 用法：npm run test:e2e:game-config（前置 npm run build）
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const ADMIN_CODE = "gamecfgadmin-code";

/**
 * #716「从文件夹同步」的临时素材目录：**起服务之前**就要建好并随 env 传进子进程 ——
 * 服务是独立进程，测试中途改 process.env 它看不见；中途能变的只有磁盘文件，
 * 所以「目录坏了 / 空了」的场景都靠现场增删这里的文件来演。
 */
const appearanceResTmp = fs.mkdtempSync(path.join(os.tmpdir(), "olua-appearance-res-"));
// 新目录口径（#753）：边框与背景都是 `resources/effect/*` 下的**平铺图集**（.plist + 同名 .png）
const appearanceBorderDir = path.join(appearanceResTmp, "effect", "border");
const appearanceBackgroundDir = path.join(appearanceResTmp, "effect", "background");
fs.mkdirSync(appearanceBorderDir, { recursive: true });
fs.mkdirSync(appearanceBackgroundDir, { recursive: true });
for (const serial of [99991, 99992]) {
  fs.writeFileSync(path.join(appearanceBorderDir, `border-${serial}.plist`), "");
  fs.writeFileSync(path.join(appearanceBorderDir, `border-${serial}.png`), "");
}
fs.writeFileSync(path.join(appearanceBorderDir, "border-99994.plist"), ""); // 没有同名 png：坏素材，扫描必须跳过
fs.writeFileSync(path.join(appearanceBackgroundDir, "bg-19991.plist"), "");
fs.writeFileSync(path.join(appearanceBackgroundDir, "bg-19991.png"), "");


// 出厂值的预期来源：配置快照 `server/data/config-sync.sql`
//
// #655 之后数据只有一处权威 —— 数据库；而**库的逐行投影**就是这份快照（空库启动时
// 由 bootstrapConfigSnapshot() 整份灌进去）。所以这里的断言长这样：
// **接口返回的字段 == 快照里那一列**。比原来更严格 —— 它顺带钉住了
// 「SQL → 建表 → 落库 → 读出来」这条链：快照写 60 / 接口返回 57，就说明中间丢了值。
const configSnapshot = require("./lib/config-snapshot.cjs");

/** 三线成长表（称号 / 战魂 / 军衔）：按等级升序，与「第 N 阶」一一对应 */
const titles = configSnapshot.rows("titles").sort((a, b) => a.level - b.level);
const souls = configSnapshot.rows("souls").sort((a, b) => a.level - b.level);
const ranks = configSnapshot.rows("ranks").sort((a, b) => a.level - b.level);
/** 角色等级表（每级一行：裸属性 + 升级所需经验）—— 行数就是等级上限 */
const roleLevels = configSnapshot.index("role_levels", "level");
const roleMaxLevel = configSnapshot.count("role_levels");
/** 成长标量（等级上限 / 属性区间系数 / 每级经验倍率 / 蓝回复） */
const growthScalars = Object.fromEntries(configSnapshot.rows("growth_scalars").map((row) => [row.key, row.value]));
const growthScalarKeys = Object.keys(growthScalars);
/** 运行时参数：库里是三个 JSON 列，接口按 drop / autoBattle / guild 三组下发 */
const runtimeRow = configSnapshot.rows("runtime_params")[0];
const runtime = { drop: runtimeRow.dropParams, autoBattle: runtimeRow.autoBattle, guild: runtimeRow.guildRules };
/** 战斗力权重（属性名 → 倍率） */
const weights = Object.fromEntries(configSnapshot.rows("combat_weights").map((row) => [row.key, row.weight]));
/** 新手引导：整份步骤数组存在单行表里 */
const guideSteps = configSnapshot.rows("guide_settings")[0].steps;
/** 装备：基础件 + 每件展开 15 个变体（前后缀已逐条展开，回收价也在变体行上） */
const equipBases = configSnapshot.index("equipments");
const variants = configSnapshot.index("equipment_variants");
const slotRows = configSnapshot.rows("equipment_slots").sort((a, b) => a.sortOrder - b.sortOrder);
const equipMeta = configSnapshot.rows("equipment_meta")[0];
/** 药品 / 材料（材料「大类」属客户端结构约定，不可编辑） */
const drugs = configSnapshot.index("drugs");
const items = configSnapshot.index("items");
/** 怪物：数值逐条落库（不再有曲线展开），表现几何在 monster_presentation */
const monsterRows = configSnapshot.rows("monsters").sort((a, b) => Number(a.id) - Number(b.id));
const presentations = configSnapshot.rows("monster_presentation");
const monsterSeed1 = monsterRows.find((row) => row.id === "1");
/** NPC / 时装 / 技能 / 状态 / 怪物技能挂载 / 掉落表 */
const npcRows = configSnapshot.rows("npcs");
const npcs = configSnapshot.index("npcs");
const fashions = configSnapshot.index("fashions");
const skills = configSnapshot.index("skills");
const statuses = configSnapshot.index("statuses");
const mounts = configSnapshot.group("monster_skills", "monsterKey");
const dropTables = configSnapshot.index("drop_tables");
const monsterDrops = configSnapshot.index("monster_drops", "monsterKey");
/** 商城分类（#758）：出厂带一个「默认分类」接住存量迁移的特殊价 */
const mallCategories = optionalRows("mall_categories");
/** 商城上架商品（#758）：出厂只有迁移带过来的一行（cloth_1） */
const mallGoodsSeed = optionalRows("mall_goods");

//#region 断言小工具（与其余几套同一骨架）


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

/**
 * 快照里的「JSON 文本列」还原成值
 *
 * `picks` 这类列存的是 `JSON.stringify(...)` 的结果，读出来是一段文本（`"1"` / `"[2,4]"`）。
 * 解析器只把明显的 `[` / `{` 开头的列当 JSON 解开，标量（`1`）会原样留成字符串 ——
 * 所以比对前要自己再 parse 一次，否则「存进去 1、读出来 1」会被误判成类型不一致。
 */
function jsonColumn(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * 可能为空的表（商城定价这类「运营按需加行」的表）
 *
 * `configSnapshot.rows()` 空表会抛错（防止读错表名），但出厂状态本来就是 0 行，
 * 这里把「空」当成合法结果。
 */
function optionalRows(table) {
  try {
    return configSnapshot.rows(table);
  } catch {
    return [];
  }
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
  const server = await startServer({ EQUIPMENT_APPEARANCE_RES_DIR: appearanceResTmp });
  try {
    const base = server.baseUrl;
    const token = await registerAdmin(base, "gamecfgadmin", "GameCfg#1");
    check(Boolean(token), "管理员注册并登录成功（第一个注册者是超级管理员）");

    //#region 一、seed 同源：启动灌库后的初始表 = 客户端配置

    group("一、seed 同源：初始表来自配置快照");

    const titlesRes = await api(base, "GET", "/api/admin/titles", { token });
    checkEqual(titlesRes.status, 200, "称号列表可读");
    checkEqual(titlesRes.body?.data?.total, titles.length, `称号行数 = 配置表（${titles.length}）`);
    checkEqual(titlesRes.body?.data?.list?.length, titles.length, "默认一页装下全部称号");

    const firstTitle = titlesRes.body?.data?.list?.[0];
    checkEqual(firstTitle?.level, 1, "首行是 1 级");
    checkEqual(firstTitle?.label, titles[0].label, "1 级称号名与配置一致");
    checkEqual(firstTitle?.bindGold, titles[0].bindGold, "1 级升级价格与配置一致");
    // 渠道分布按「快照怎么写就怎么返回」断言 —— 出厂种子是「运营逐个开放」，
    // 但库里的称号可能已经开了一批（快照就是库的投影，不能假设全是 unavailable）
    const snapshotUpgradeCount = titles.filter((row) => row.acquireChannel === "upgrade").length;
    checkEqual(firstTitle?.acquireChannel, titles[0].acquireChannel, "首行渠道 = 快照那一列");
    checkEqual(
      titlesRes.body?.data?.list?.filter((item) => item.acquireChannel === "unavailable").length,
      titles.length - snapshotUpgradeCount,
      `渠道分布与快照一致（upgrade ${snapshotUpgradeCount} / unavailable ${titles.length - snapshotUpgradeCount}）`,
    );

    const soulsRes = await api(base, "GET", "/api/admin/souls", { token });
    checkEqual(soulsRes.status, 200, "战魂列表可读");
    checkEqual(soulsRes.body?.data?.total, souls.length, `战魂行数 = 配置表（${souls.length}）`);
    checkEqual(soulsRes.body?.data?.list?.[0]?.label, souls[0].label, "1 阶战魂名与配置一致");
    check(Boolean(soulsRes.body?.data?.list?.[0]?.attributes?.maxHp !== undefined), "战魂属性以嵌套结构返回");

    const titled = await api(base, "GET", `/api/admin/titles?keyword=${encodeURIComponent(titles[0].label)}`, { token });
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
    // 基线 = 快照里已是 upgrade 的那批；1 级若本来就在链上，总数不变
    const titleOneWasUpgrade = titles[0].acquireChannel === "upgrade";
    const expectedUpgradeTotal = snapshotUpgradeCount + (titleOneWasUpgrade ? 0 : 1);
    checkEqual(upgraded.body?.data?.total, expectedUpgradeTotal, `按渠道筛选：upgrade 共 ${expectedUpgradeTotal} 条（快照基线 + 刚改的）`);
    const unavailable = await api(base, "GET", "/api/admin/titles?acquireChannel=unavailable", { token });
    checkEqual(unavailable.body?.data?.total, titles.length - expectedUpgradeTotal, "其余称号仍在无法获取里");

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

    // 快照是库的投影：称号可能已经开了一批在链上（出厂设计是「运营逐个开放」）。
    // 本节断言的是「进出列表 + 整串重排」的语义，先把链上现有的全部关掉，拿到干净基线，
    // 否则断言会绑定在「库里恰好开了几个」这种与代码无关的快照状态上。
    const openTitleLevels = titles
      .filter((row) => row.acquireChannel === "upgrade")
      .map((row) => row.level)
      .sort((a, b) => a - b);
    for (const level of openTitleLevels) {
      await api(base, "PATCH", `/api/admin/titles/${level}`, { token, body: { acquireChannel: "unavailable" } });
    }
    const chainReset = await api(base, "GET", "/api/admin/titles/upgrade-list", { token });
    checkEqual(
      JSON.stringify(chainReset.body?.data?.map((item) => item.level)),
      "[]",
      `链已清空（关掉快照里已开放的 ${openTitleLevels.length} 个称号）`,
    );
    const reopenFirst = await api(base, "PATCH", "/api/admin/titles/1", { token, body: { acquireChannel: "upgrade" } });
    checkEqual(reopenFirst.body?.data?.upgradeOrder, 1, "干净链上重新开放 1 级 → 序号 1");

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
    checkEqual(keptPrice?.bindGold, titles[1].bindGold, "切走后升级价格保留（不受进出列表影响）");

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

    const soulLevels = Array.from({ length: souls.length }, (_, index) => index + 1);

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

    //#region 六、成长（#256 / #655）：曲线下架 + 标量参数

    group("六、成长曲线已下架：旧路由一律 404");

    // #655：曲线采样换成了 role_levels 逐级配置 —— 旧接口必须彻底消失，
    // 留着「还能读写但不影响任何东西」的空壳，运营改完只会以为改了生效了。
    for (const path of ["/api/admin/level-exps", "/api/admin/growth-segments", "/api/admin/growth-segments/maxHp/1"]) {
      const gone = await api(base, "GET", path, { token });
      checkEqual(gone.status, 404, `${path} 已下架（404）`);
    }
    const expPatchGone = await api(base, "PATCH", "/api/admin/level-exps/1", { token, body: { exp: 1 } });
    checkEqual(expPatchGone.status, 404, "PATCH 舊经验接口 → 404");
    // 经验本身还在，只是并入 role_levels：改角色等级那一行就改了经验
    const roleLevelExp = await api(base, "GET", "/api/admin/role-levels?page=1&size=60", { token });
    checkEqual(roleLevelExp.body?.data?.list?.[0]?.exp, roleLevels[1].exp, "1 级经验与出厂值一致");
    const expByRoleLevel = await api(base, "PATCH", "/api/admin/role-levels/1", { token, body: { exp: 999 } });
    checkEqual(expByRoleLevel.status, 200, "改角色等级 1 行的经验成功");
    checkEqual(expByRoleLevel.body?.data?.exp, 999, "响应里的经验已更新");
    const roleLevelExpZero = await api(base, "PATCH", "/api/admin/role-levels/1", { token, body: { exp: 0 } });
    checkEqual(roleLevelExpZero.status, 400, "经验 0 → 400（永远升不上去）");
    const viewerRoleLevelWrite = await api(base, "PATCH", "/api/admin/role-levels/1", { token: viewerToken, body: { exp: 1 } });
    checkEqual(viewerRoleLevelWrite.status, 403, "观察员改角色等级 → 403");
    checkEqual(viewerRoleLevelWrite.body?.code, 30006, "观察员改角色等级 → 30006（权限点不足）");

    group("六、成长参数：标量（曲线下架后剩下的全局参数）");

    const scalars = await api(base, "GET", "/api/admin/growth-scalars", { token });
    checkEqual(scalars.status, 200, "标量参数列表可读");
    checkEqual(scalars.body?.data?.total, growthScalarKeys.length, `标量参数行数 = 配置（${growthScalarKeys.length}）`);
    const maxLevelRow = scalars.body?.data?.list?.find((item) => item.key === "roleMaxLevel");
    checkEqual(maxLevelRow?.value, growthScalars.roleMaxLevel, "等级上限初值与配置一致");
    check(Boolean(maxLevelRow?.description), "每个标量参数都带说明");

    // #655：`attributeRange.*` 三个换算比率随曲线下架 —— 它们已经不在了，写回旧键必须报「没有这个参数」
    const removedKey = await api(base, "PATCH", "/api/admin/growth-scalars/attributeRange.minRate", { token, body: { value: 0.8 } });
    checkEqual(removedKey.status, 404, "已下架的标量键（attributeRange.minRate）→ 404");
    checkEqual(removedKey.body?.code, 50014, "下架键按「参数未找到」拒绝，不是静默接受");
    const rateFraction = await api(base, "PATCH", "/api/admin/growth-scalars/expGain.expPerLevel", { token, body: { value: 5.5 } });
    checkEqual(rateFraction.status, 400, "整数参数传小数 → 400");
    // #605：魔法自然回复速度入表（原本写死在 role-authority，管理端改不了）
    const mpRecoverPatched = await api(base, "PATCH", "/api/admin/growth-scalars/mpRecoverPerSecond", { token, body: { value: 3.5 } });
    checkEqual(mpRecoverPatched.status, 200, "#605 魔法回复速度可改（小数合法）");
    checkEqual(mpRecoverPatched.body?.data?.value, 3.5, "回复速度按提交值生效");
    const mpRecoverNegative = await api(base, "PATCH", "/api/admin/growth-scalars/mpRecoverPerSecond", { token, body: { value: -1 } });
    checkEqual(mpRecoverNegative.status, 400, "恢复速度不能为负 → 400");
    const mpRecoverZero = await api(base, "PATCH", "/api/admin/growth-scalars/mpRecoverPerSecond", { token, body: { value: 0 } });
    checkEqual(mpRecoverZero.body?.data?.value, 0, "0 合法（关闭自然回蓝）");
    await api(base, "PATCH", "/api/admin/growth-scalars/mpRecoverPerSecond", { token, body: { value: growthScalars.mpRecoverPerSecond } });
    const maxLevelJump = await api(base, "PATCH", "/api/admin/growth-scalars/roleMaxLevel", { token, body: { value: 61 } });
    checkEqual(maxLevelJump.status, 400, "抬等级上限但等级表没有那一行 → 400（跨表校验）");
    const scalarGhost = await api(base, "PATCH", "/api/admin/growth-scalars/nope", { token, body: { value: 1 } });
    checkEqual(scalarGhost.status, 404, "改不存在的参数键 → 404");
    checkEqual(scalarGhost.body?.code, 50014, "标量参数未找到用专属业务码 50014");
    const scalarKeyword = await api(base, "GET", "/api/admin/growth-scalars?keyword=recover", { token });
    checkEqual(scalarKeyword.body?.data?.total, 1, "关键字能命中对应参数");
    const viewerScalarWrite = await api(base, "PATCH", "/api/admin/growth-scalars/roleMaxLevel", { token: viewerToken, body: { value: 50 } });
    checkEqual(viewerScalarWrite.status, 403, "观察员改标量参数 → 403");
    checkEqual(viewerScalarWrite.body?.code, 30006, "观察员改标量参数 → 30006（权限点不足）");

    //#endregion

    //#region 六·五、运行时参数（#605）：单行三组 / 部分更新 / 跨字段校验 / 权限

    group("六·五、运行时参数（掉落手感 / 自动战斗 / 帮会规则）");

    const runtimeRes = await api(base, "GET", "/api/admin/runtime-params", { token });
    checkEqual(runtimeRes.status, 200, "运行时参数可读");
    checkEqual(runtimeRes.body?.data?.drop?.autoPickupRadius, runtime.drop.autoPickupRadius, "掉落拾取半径初值 = 出厂 seed");
    checkEqual(runtimeRes.body?.data?.autoBattle?.moveByRun, runtime.autoBattle.moveByRun, "自动战斗布尔开关初值 = 出厂 seed");
    checkEqual(runtimeRes.body?.data?.guild?.nameMax, runtime.guild.nameMax, "帮会名上限初值 = 出厂 seed");
    checkEqual(runtimeRes.body?.data?.updatedAt, runtimeRow.updatedAt, "updatedAt = 快照那一列（库里被人改过就不是 0）");

    const dropPatched = await api(base, "PATCH", "/api/admin/runtime-params", { token, body: { drop: { autoPickupRadius: 72 } } });
    checkEqual(dropPatched.status, 200, "改掉落拾取半径成功");
    checkEqual(dropPatched.body?.data?.drop?.autoPickupRadius, 72, "响应里是新半径");
    checkEqual(dropPatched.body?.data?.drop?.scatterMinDistance, runtime.drop.scatterMinDistance, "同组其它字段不动（部分更新）");
    checkEqual(dropPatched.body?.data?.guild?.nameMax, runtime.guild.nameMax, "别的分组不动");

    const autoPatched = await api(base, "PATCH", "/api/admin/runtime-params", { token, body: { autoBattle: { moveByRun: false, cellSize: 24 } } });
    checkEqual(autoPatched.status, 200, "改自动战斗参数成功");
    checkEqual(autoPatched.body?.data?.autoBattle?.moveByRun, false, "布尔开关按提交值生效");
    checkEqual(autoPatched.body?.data?.autoBattle?.cellSize, 24, "网格边长按提交值生效");

    const runtimeNegative = await api(base, "PATCH", "/api/admin/runtime-params", { token, body: { drop: { autoPickupRadius: -1 } } });
    checkEqual(runtimeNegative.status, 400, "负半径 → 400（DTO 取值域）");
    const runtimeTooBig = await api(base, "PATCH", "/api/admin/runtime-params", { token, body: { autoBattle: { cellSize: 0 } } });
    checkEqual(runtimeTooBig.status, 400, "网格边长 0 → 400（下限 8）");
    const runtimeGuildInverted = await api(base, "PATCH", "/api/admin/runtime-params", { token, body: { guild: { nameMin: 14, nameMax: 12 } } });
    checkEqual(runtimeGuildInverted.status, 400, "帮会名最短 > 最长 → 400（跨字段校验）");
    checkEqual(runtimeGuildInverted.body?.code, 40000, "跨字段违反用参数非法 40000");
    const runtimeAfterReject = await api(base, "GET", "/api/admin/runtime-params", { token });
    checkEqual(runtimeAfterReject.body?.data?.guild?.nameMin, runtime.guild.nameMin, "被拒的提交没有落库（先校验后写）");
    const runtimeUnknownKey = await api(base, "PATCH", "/api/admin/runtime-params", { token, body: { drop: { bogusParam: 5 } } });
    checkEqual(runtimeUnknownKey.status, 200, "未知字段被白名单剥掉（不报错）");
    checkEqual(runtimeUnknownKey.body?.data?.drop?.autoPickupRadius, 72, "剥掉之后其余值不变");
    const viewerRuntimeWrite = await api(base, "PATCH", "/api/admin/runtime-params", { token: viewerToken, body: { drop: { autoPickupRadius: 50 } } });
    checkEqual(viewerRuntimeWrite.status, 403, "观察员改运行时参数 → 403");
    checkEqual(viewerRuntimeWrite.body?.code, 30006, "观察员改运行时参数 → 30006（权限点不足）");
    const postRuntime = await api(base, "POST", "/api/admin/runtime-params", { token, body: {} });
    checkEqual(postRuntime.status, 404, "POST → 404（单行配置没有创建）");
    const deleteRuntime = await api(base, "DELETE", "/api/admin/runtime-params", { token });
    checkEqual(deleteRuntime.status, 404, "DELETE → 404（单行配置没有删除）");

    //#endregion

    //#region 六·六、战斗力权重（#605）：七项倍率入表 / 部分更新 / 全 0 拦住 / 权限

    group("六·六、战斗力权重（生命 + 三系攻防）");

    const weightsRes = await api(base, "GET", "/api/admin/combat-weights", { token });
    checkEqual(weightsRes.status, 200, "战斗力权重可读");
    checkEqual(weightsRes.body?.data?.weights?.maxHp, weights.maxHp, "生命权重初值 = 出厂 seed");
    checkEqual(weightsRes.body?.data?.weights?.physicalAttack, weights.physicalAttack, "物攻权重初值 = 出厂 seed");
    checkEqual(weightsRes.body?.data?.updatedAt, 0, "seed 行的 updatedAt 是 0（从没被运营改过）");

    const weightPatched = await api(base, "PATCH", "/api/admin/combat-weights", { token, body: { magicAttack: 7.5 } });
    checkEqual(weightPatched.status, 200, "改魔法攻击权重成功（允许两位小数）");
    checkEqual(weightPatched.body?.data?.weights?.magicAttack, 7.5, "响应里是新倍率");
    checkEqual(weightPatched.body?.data?.weights?.maxHp, weights.maxHp, "没提交的属性保持原值（部分更新）");
    check(weightPatched.body?.data?.updatedAt > 0, "改过之后 updatedAt 才不是 0");

    const weightNegative = await api(base, "PATCH", "/api/admin/combat-weights", { token, body: { maxHp: -1 } });
    checkEqual(weightNegative.status, 400, "负权重 → 400（DTO 取值域）");
    // 单项归零是合法调法（比如「战力不看魔攻」），要**七项同时为 0** 才拦 —— 那等于所有人战力恒 0
    const weightOneZero = await api(base, "PATCH", "/api/admin/combat-weights", { token, body: { magicAttack: 0 } });
    checkEqual(weightOneZero.status, 200, "只把一项归零是合法的（战力可以不计某一项）");
    const weightAllZero = await api(base, "PATCH", "/api/admin/combat-weights", {
      token,
      body: { maxHp: 0, physicalAttack: 0, magicAttack: 0, taoistAttack: 0, physicalDefense: 0, magicDefense: 0, taoistDefense: 0 },
    });
    checkEqual(weightAllZero.status, 400, "七项全 0 → 400（会让所有地图准入失效）");
    checkEqual(weightAllZero.body?.code, 40000, "全 0 用参数非法 40000");
    const weightsAfterReject = await api(base, "GET", "/api/admin/combat-weights", { token });
    checkEqual(weightsAfterReject.body?.data?.weights?.magicAttack, 0, "被拒的整份提交没有落库（仍是上一步的 0）");
    checkEqual(weightsAfterReject.body?.data?.weights?.maxHp, weights.maxHp, "其余属性也没被这份提交改掉");
    const weightUnknown = await api(base, "PATCH", "/api/admin/combat-weights", { token, body: { hpRecover: 3 } });
    checkEqual(weightUnknown.status, 200, "未知属性被白名单剥掉（不报错）");
    checkEqual(weightUnknown.body?.data?.weights?.maxHp, weights.maxHp, "剥掉之后其余值不变");
    const viewerWeightWrite = await api(base, "PATCH", "/api/admin/combat-weights", { token: viewerToken, body: { maxHp: 20 } });
    checkEqual(viewerWeightWrite.status, 403, "观察员改战斗力权重 → 403");
    checkEqual(viewerWeightWrite.body?.code, 30006, "观察员改战斗力权重 → 30006（权限点不足）");
    const postWeights = await api(base, "POST", "/api/admin/combat-weights", { token, body: {} });
    checkEqual(postWeights.status, 404, "POST → 404（权重表没有创建）");
    const deleteWeights = await api(base, "DELETE", "/api/admin/combat-weights", { token });
    checkEqual(deleteWeights.status, 404, "DELETE → 404（权重表没有删除）");

    // 复原出厂值：后面的断言（快照 / 战力）都以出厂口径为基线
    const weightsRestored = await api(base, "PATCH", "/api/admin/combat-weights", { token, body: { magicAttack: weights.magicAttack } });
    checkEqual(weightsRestored.body?.data?.weights?.magicAttack, weights.magicAttack, "复原魔法攻击权重");

    //#endregion

    //#region 六·七、新手引导步骤（#605）：整份读写 / 枚举白名单 / 唯一标识 / 权限

    group("六·七、新手引导步骤（整份读写）");

    const guide = await api(base, "GET", "/api/admin/guide-steps", { token });
    checkEqual(guide.status, 200, "引导步骤可读");
    checkEqual(guide.body?.data?.steps?.length, guideSteps.length, "步骤数 = 出厂种子");
    checkEqual(guide.body?.data?.steps?.[0]?.id, guideSteps[0].id, "第 1 步的标识 = 出厂种子");
    checkEqual(guide.body?.data?.steps?.[0]?.spot, guideSteps[0].spot, "第 1 步的高亮位 = 出厂种子");
    checkEqual(guide.body?.data?.updatedAt, 0, "seed 行的 updatedAt 是 0（从没被运营改过）");

    const twoSteps = [
      { id: "move", title: "先动起来", desc: "走两步看看。", spot: "joystick", trigger: "move" },
      { id: "fight", title: "打一只怪", desc: "点技能出手。", spot: "shortcut", trigger: "kill" },
    ];
    const guidePatched = await api(base, "PATCH", "/api/admin/guide-steps", { token, body: { steps: twoSteps } });
    checkEqual(guidePatched.status, 200, "整份替换成功");
    checkEqual(guidePatched.body?.data?.steps?.length, 2, "响应里就是提交的两步");
    checkEqual(guidePatched.body?.data?.steps?.[1]?.id, "fight", "数组顺序 = 体验顺序");
    checkEqual(guidePatched.body?.data?.steps?.[0]?.desc, "走两步看看。", "文案按提交值生效");
    check(guidePatched.body?.data?.updatedAt > 0, "改过之后 updatedAt 才不是 0");

    const guideBadSpot = await api(base, "PATCH", "/api/admin/guide-steps", {
      token,
      body: { steps: [{ id: "x", title: "标题", desc: "正文", spot: "nav:unknown", trigger: "move" }] },
    });
    checkEqual(guideBadSpot.status, 400, "白名单外的高亮位 → 400（客户端不认识它，玩家会卡在那一步）");
    const guideBadEvent = await api(base, "PATCH", "/api/admin/guide-steps", {
      token,
      body: { steps: [{ id: "x", title: "标题", desc: "正文", spot: "joystick", trigger: "teleport" }] },
    });
    checkEqual(guideBadEvent.status, 400, "白名单外的推进事件 → 400（这个事件永远不会命中）");
    const guideDuplicate = await api(base, "PATCH", "/api/admin/guide-steps", {
      token,
      body: {
        steps: [
          { id: "same", title: "甲", desc: "正文", spot: "joystick", trigger: "move" },
          { id: "same", title: "乙", desc: "正文", spot: "joystick", trigger: "kill" },
        ],
      },
    });
    checkEqual(guideDuplicate.status, 400, "标识重复 → 400");
    checkEqual(guideDuplicate.body?.code, 40000, "标识重复用参数非法 40000");
    const guideEmpty = await api(base, "PATCH", "/api/admin/guide-steps", { token, body: { steps: [] } });
    checkEqual(guideEmpty.status, 400, "清空步骤 → 400（想关引导是让玩家走完，不是删配置）");
    const guideAfterReject = await api(base, "GET", "/api/admin/guide-steps", { token });
    checkEqual(guideAfterReject.body?.data?.steps?.length, 2, "被拒的提交没有落库（整份不动）");
    const viewerGuideWrite = await api(base, "PATCH", "/api/admin/guide-steps", { token: viewerToken, body: { steps: twoSteps } });
    checkEqual(viewerGuideWrite.status, 403, "观察员改引导步骤 → 403");
    checkEqual(viewerGuideWrite.body?.code, 30006, "观察员改引导步骤 → 30006（权限点不足）");
    const postGuide = await api(base, "POST", "/api/admin/guide-steps", { token, body: { steps: twoSteps } });
    checkEqual(postGuide.status, 404, "POST → 404（单行配置没有创建）");
    const deleteGuide = await api(base, "DELETE", "/api/admin/guide-steps", { token });
    checkEqual(deleteGuide.status, 404, "DELETE → 404（单行配置没有删除）");

    // 复原出厂表：快照断言以出厂口径为基线
    const guideRestored = await api(base, "PATCH", "/api/admin/guide-steps", { token, body: { steps: guideSteps } });
    checkEqual(guideRestored.body?.data?.steps?.length, guideSteps.length, "复原出厂步骤表");

    //#endregion

    //#region 七、军衔配置（#250）：seed 同源 / 大段筛 / 只许改 / 无成长列表重排

    group("七、军衔配置");

    const ranksRes = await api(base, "GET", "/api/admin/ranks", { token });
    checkEqual(ranksRes.status, 200, "军衔列表可读");
    const rankCount = ranks.length;
    checkEqual(ranksRes.body?.data?.total, rankCount, `军衔行数 = 配置表（${rankCount}）`);
    checkEqual(ranksRes.body?.data?.list?.length, 100, "默认一页装下全部军衔");
    const firstRank = ranksRes.body?.data?.list?.[0];
    checkEqual(firstRank?.level, 1, "首行是 1 阶");
    checkEqual(firstRank?.label, ranks[0].label, "1 阶衔名与配置一致");
    checkEqual(firstRank?.tier, ranks[0].tier, "1 阶大段名与配置一致");
    checkEqual(firstRank?.bindGold, ranks[0].bindGold, "1 阶晋升价格与配置一致");
    check(Boolean(firstRank?.attributes?.maxHp !== undefined), "军衔属性以嵌套结构返回");
    checkEqual(firstRank?.animation, undefined, "军衔没有动画字段（外观是头顶一行红字）");

    const rankTierFiltered = await api(base, "GET", `/api/admin/ranks?tier=${encodeURIComponent(ranks[0].tier)}`, { token });
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
    const equipmentCount = Object.keys(equipBases).length;
    checkEqual(equipments.body?.data?.total, equipmentCount, `装备行数 = 基础件配置表（${equipmentCount}）`);
    // 装备件数已经超过一页（默认 size = 100）——断言按**分页语义**来，不再假设一次能拿全：
    // 素材还在往里加，锁「一页装下」只会天天变红
    checkEqual(equipments.body?.data?.size, 100, "默认每页 100 条");
    checkEqual(equipments.body?.data?.list?.length, Math.min(100, equipmentCount), "第一页按 size 装满");
    // cloth_14 不在第一页（默认按等级升序，第一页是最低的那批），按 id 单独查
    const cloth14Read = await api(base, "GET", "/api/admin/equipments?keyword=cloth_14", { token });
    const cloth14 = cloth14Read.body?.data?.list?.find((row) => row.id === "cloth_14");
    check(Boolean(cloth14), "列表里有基础件 cloth_14");
    checkEqual(cloth14?.slot, equipBases["cloth_14"].slot, "cloth_14 部位与配置一致");
    checkEqual(cloth14?.level, equipBases["cloth_14"].level, "cloth_14 等级需求与配置一致");
    checkEqual(cloth14?.label, equipBases["cloth_14"].label, "cloth_14 名称与配置一致");
    checkEqual(cloth14?.sellPrice, equipBases["cloth_14"].sellPrice, "cloth_14 售卖价与配置一致");
    checkEqual(cloth14?.attributes?.maxHp, equipBases["cloth_14"].maxHp, "cloth_14 属性与配置一致（快照平铺列 → 接口嵌套结构）");
    check(cloth14 && !cloth14.id.includes("_p"), "管理端只收基础件（变体 _pXsY 不进列表）");

    const clothSlotCount = Object.values(equipBases).filter((base) => base.slot === "cloth").length;
    const equipmentSlotFiltered = await api(base, "GET", "/api/admin/equipments?slot=cloth", { token });
    checkEqual(equipmentSlotFiltered.body?.data?.total, clothSlotCount, `按部位筛：cloth 恰好 ${clothSlotCount} 件`);
    const levelBandCount = Object.values(equipBases).filter((base) => base.level >= 40 && base.level <= 50).length;
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
    // #603 第九域：名称 / 描述 / 资源 / 几何都从客户端源码搬进了 equipments 表，所以 label 现在**可改**；
    // 只有 slot（部位结构）与 id 仍然不可改 —— 白名单剥离后照旧 200，但值不变
    const equipmentStructural = await api(base, "PATCH", "/api/admin/equipments/cloth_14", { token, body: { slot: "weapon", label: "改名尝试" } });
    checkEqual(equipmentStructural.status, 200, "PATCH 结构字段不报错（白名单剥离）");
    checkEqual(equipmentStructural.body?.data?.slot, "cloth", "slot 不可编辑（部位结构固定）");
    checkEqual(equipmentStructural.body?.data?.label, "改名尝试", "label 可编辑（#603 从客户端源码搬来）");
    const equipmentRestoreLabel = await api(base, "PATCH", "/api/admin/equipments/cloth_14", {
      token,
      body: { label: equipBases["cloth_14"].label },
    });
    checkEqual(equipmentRestoreLabel.body?.data?.label, equipBases["cloth_14"].label, "名称已还原（不污染后续关键字断言）");

    // 显示字段整份提交（#603）：资源路径 / 几何 / 职业性别 / 标签 / 描述
    const eightPositions = Array.from({ length: 8 }, (_, index) => ({ x: index, y: -index }));
    const equipmentDisplay = await api(base, "PATCH", "/api/admin/equipments/cloth_14", {
      token,
      body: {
        description: "e2e 描述",
        occupation: "1",
        sex: "2",
        icon: "equipment/clothes/icon/e2e",
        inAtlas: "equipment/clothes/in/e2e",
        outAtlas: "equipment/clothes/out/e2e",
        tags: ["第一大陆", "e2e"],
        outScale: 1.25,
        inScaleX: 0.9,
        inScaleY: 0.8,
        inRotate: 15,
        inPosX: -12.5,
        inPosY: 34,
        outPositions: eightPositions,
      },
    });
    checkEqual(equipmentDisplay.status, 200, "PATCH 显示字段成功");
    checkEqual(equipmentDisplay.body?.data?.description, "e2e 描述", "描述已更新");
    checkEqual(equipmentDisplay.body?.data?.icon, "equipment/clothes/icon/e2e", "图标已更新（资源路径现在归服务端）");
    checkEqual(equipmentDisplay.body?.data?.inAtlas, "equipment/clothes/in/e2e", "内观图集已更新");
    checkEqual(equipmentDisplay.body?.data?.outAtlas, "equipment/clothes/out/e2e", "外观图集已更新");
    checkEqual(equipmentDisplay.body?.data?.tags?.length, 2, "标签整份替换（2 个）");
    checkEqual(equipmentDisplay.body?.data?.inPosX, -12.5, "内观锚点 x 已更新");
    checkEqual(equipmentDisplay.body?.data?.outPositions?.length, 8, "8 向位置整份替换（8 个）");
    checkEqual(equipmentDisplay.body?.data?.outPositions?.[3]?.y, -3, "8 向位置逐项落库（第 4 向 y = -3）");
    const badPositions = await api(base, "PATCH", "/api/admin/equipments/cloth_14", { token, body: { outPositions: eightPositions.slice(0, 4) } });
    checkEqual(badPositions.status, 400, "8 向位置不足 8 个 → 400");
    checkEqual(badPositions.body?.code, 40000, "8 向位置数量校验用 40000");
    const restoreDisplay = await api(base, "PATCH", "/api/admin/equipments/cloth_14", {
      token,
      body: {
        description: cloth14.description,
        occupation: cloth14.occupation,
        sex: cloth14.sex,
        icon: cloth14.icon,
        inAtlas: cloth14.inAtlas,
        outAtlas: cloth14.outAtlas,
        tags: cloth14.tags,
        outScale: cloth14.outScale,
        inScaleX: cloth14.inScaleX,
        inScaleY: cloth14.inScaleY,
        inRotate: cloth14.inRotate,
        inPosX: cloth14.inPosX,
        inPosY: cloth14.inPosY,
        outPositions: cloth14.outPositions,
      },
    });
    checkEqual(restoreDisplay.status, 200, "显示字段已还原（不污染快照断言）");
    const postEquipment = await api(base, "POST", "/api/admin/equipments", { token, body: { id: "cloth_new" } });
    checkEqual(postEquipment.status, 400, "POST 装备缺部位 / 名称 → 400（#773 起路由存在，校验拦下）");
    const deleteEquipment = await api(base, "DELETE", "/api/admin/equipments/cloth_999", { token });
    checkEqual(deleteEquipment.status, 404, "DELETE 不存在的装备 → 404");
    const viewerEquipmentRead = await api(base, "GET", "/api/admin/equipments", { token: viewerToken });
    checkEqual(viewerEquipmentRead.body?.code, 0, "观察员能看装备配置");
    const viewerEquipmentWrite = await api(base, "PATCH", "/api/admin/equipments/cloth_14", { token: viewerToken, body: { sellPrice: 1 } });
    checkEqual(viewerEquipmentWrite.status, 403, "观察员改装备 → 403");
    checkEqual(viewerEquipmentWrite.body?.code, 30006, "观察员改装备 → 30006（权限点不足）");
    const viewerEquipmentCreate = await api(base, "POST", "/api/admin/equipments", { token: viewerToken, body: { slot: "cloth", label: "观察员想建" } });
    checkEqual(viewerEquipmentCreate.status, 403, "观察员新建装备 → 403");
    const viewerEquipmentDelete = await api(base, "DELETE", "/api/admin/equipments/cloth_14", { token: viewerToken });
    checkEqual(viewerEquipmentDelete.status, 403, "观察员删除装备 → 403");

    //#endregion

    //#region 八·三、新建与删除装备（#773：以前是刻意的「只能改」，现在放开增删）

    group("八·三、新建与删除装备");

    const combos = equipMeta.prefixRates.length * equipMeta.suffixRates.length;

    // 部位盘点（管理端页签的计数徽章）
    const summaryBefore = await api(base, "GET", "/api/admin/equipments/summary", { token });
    checkEqual(summaryBefore.status, 200, "部位盘点可读");
    checkEqual(summaryBefore.body?.data?.total, equipmentCount, `盘点总数 = 基础件数（${equipmentCount}）`);
    checkEqual(summaryBefore.body?.data?.slots?.length, slotRows.length, `盘点覆盖全部 ${slotRows.length} 个部位（含空部位）`);
    checkEqual(summaryBefore.body?.data?.slots?.[0]?.slot, slotRows[0].key, "盘点顺序 = 槽位表 sort_order");
    checkEqual(summaryBefore.body?.data?.slots?.[0]?.label, slotRows[0].label, "盘点带部位名（管理端不用再查字典）");
    const clothCountBefore = summaryBefore.body?.data?.slots?.find((row) => row.slot === "cloth")?.count;
    checkEqual(clothCountBefore, clothSlotCount, "cloth 页签计数 = 该部位件数");

    // 新建：id 省略 → 服务端按 部位_序号 生成；资源 / 属性从模板复制；连带展开全部变体
    const newEquip = await api(base, "POST", "/api/admin/equipments", {
      token,
      body: { slot: "cloth", label: "e2e 新衣", templateId: "cloth_14" },
    });
    checkEqual(newEquip.status, 201, "新建装备 → 201");
    const newEquipId = newEquip.body?.data?.equipment?.id;
    check(/^cloth_\d+$/.test(newEquipId || ""), `id 按 部位_序号 自动生成（${newEquipId}）`);
    check(newEquipId !== "cloth_14", "自动生成的 id 不与既有装备重复");
    checkEqual(newEquip.body?.data?.equipment?.slot, "cloth", "部位已落");
    checkEqual(newEquip.body?.data?.equipment?.label, "e2e 新衣", "名称已落");
    checkEqual(newEquip.body?.data?.equipment?.level, cloth14.level, "等级跟模板");
    checkEqual(newEquip.body?.data?.equipment?.icon, cloth14.icon, "图标跟模板");
    checkEqual(newEquip.body?.data?.equipment?.outAtlas, cloth14.outAtlas, "外观图集跟模板");
    checkEqual(newEquip.body?.data?.equipment?.attributes?.maxHp, cloth14.attributes.maxHp, "八项属性跟模板");
    checkEqual(newEquip.body?.data?.equipment?.outPositions?.length, 8, "8 向位置跟模板（整份 8 个）");
    checkEqual(newEquip.body?.data?.variants, combos, `连带展开 ${combos} 个变体`);

    const newEquipVariants = await api(base, "GET", `/api/admin/equipment-variants?baseId=${newEquipId}&page=1&size=50`, { token });
    checkEqual(newEquipVariants.body?.data?.total, combos, "变体行真的进表了（客户端只认这张表）");
    const newEquipTop = newEquipVariants.body?.data?.list?.find((row) => row.prefix === 0 && row.suffix === 0);
    checkEqual(newEquipTop?.id, newEquipId, "p0s0 的变体 id 就是基础件 id");
    checkEqual(newEquipTop?.attributes?.maxHp, cloth14.attributes.maxHp, "p0s0 属性 = 基础值（倍率 1）");

    // 新建的各种拒绝路径
    const newEquipDup = await api(base, "POST", "/api/admin/equipments", { token, body: { id: newEquipId, slot: "cloth", label: "重复 id" } });
    checkEqual(newEquipDup.status, 409, "手填撞已有 id → 409");
    checkEqual(newEquipDup.body?.code, 50039, "撞 id 用 50039");
    const newEquipBadSlot = await api(base, "POST", "/api/admin/equipments", { token, body: { slot: "cape", label: "非法部位" } });
    checkEqual(newEquipBadSlot.status, 400, "未知部位 → 400（部位清单归槽位表）");
    const newEquipBadTemplate = await api(base, "POST", "/api/admin/equipments", { token, body: { slot: "cloth", label: "坏模板", templateId: "cloth_999" } });
    checkEqual(newEquipBadTemplate.status, 404, "模板不存在 → 404");
    checkEqual(newEquipBadTemplate.body?.code, 50016, "模板不存在用 50016");
    const newEquipBadId = await api(base, "POST", "/api/admin/equipments", { token, body: { id: "Cloth-9", slot: "cloth", label: "非法 id" } });
    checkEqual(newEquipBadId.status, 400, "id 形态非法 → 400");

    // 页面盘点跟着涨
    const summaryAfter = await api(base, "GET", "/api/admin/equipments/summary", { token });
    checkEqual(summaryAfter.body?.data?.total, equipmentCount + 1, "盘点总数 +1");
    checkEqual(
      summaryAfter.body?.data?.slots?.find((row) => row.slot === "cloth")?.count,
      clothCountBefore + 1,
      "cloth 页签 +1",
    );

    // 商城还在架 → 拒删（先下架）
    const listedGood = await api(base, "POST", "/api/admin/mall/goods", {
      token,
      body: { id: newEquipId, categoryId: "default", price: 12 },
    });
    checkEqual(listedGood.status, 201, "把新装备挂上商城（为验证拒删）");
    const deleteListed = await api(base, "DELETE", `/api/admin/equipments/${newEquipId}`, { token });
    checkEqual(deleteListed.status, 409, "商城在架 → 拒删");
    checkEqual(deleteListed.body?.code, 50040, "商城在架用 50040");
    const unlistedGood = await api(base, "DELETE", `/api/admin/mall/goods/${newEquipId}`, { token });
    checkEqual(unlistedGood.status, 200, "下架（还原商城）");

    // 删除：连带变体；删完再删 404
    const removed = await api(base, "DELETE", `/api/admin/equipments/${newEquipId}`, { token });
    checkEqual(removed.status, 200, "删除装备 → 200");
    checkEqual(removed.body?.data?.id, newEquipId, "回包 id 就是被删的那件");
    checkEqual(removed.body?.data?.variants, combos, `连带删掉 ${combos} 个变体`);
    const removedVariants = await api(base, "GET", `/api/admin/equipment-variants?baseId=${newEquipId}&page=1&size=50`, { token });
    checkEqual(removedVariants.body?.data?.total, 0, "变体已随之清空");
    const removedAgain = await api(base, "DELETE", `/api/admin/equipments/${newEquipId}`, { token });
    checkEqual(removedAgain.status, 404, "再删一次 → 404");
    checkEqual(removedAgain.body?.code, 50016, "删不存在的装备用 50016");
    const summaryRestored = await api(base, "GET", "/api/admin/equipments/summary", { token });
    checkEqual(summaryRestored.body?.data?.total, equipmentCount, "删完盘点回到原数（不污染后续断言）");

    //#endregion

    //#region 八·二、装备槽位与规则（#603 第九域：从客户端 equipments.ts / growth.ts 搬来）

    group("八·二、装备槽位与规则");

    const slots = await api(base, "GET", "/api/admin/equipment-slots", { token });
    checkEqual(slots.status, 200, "槽位表可读");
    checkEqual(slots.body?.data?.length, slotRows.length, `槽位行数 = 种子（${slotRows.length}）`);
    checkEqual(slots.body?.data?.[0]?.key, slotRows[0].key, "按 sort_order 升序（第一行 = 种子第一项）");
    checkEqual(slots.body?.data?.[0]?.order, 0, "排序从 0 起");
    checkEqual(slots.body?.data?.[0]?.label, slotRows[0].label, "槽位名称与种子一致");

    const slotAuthoring = await api(base, "GET", "/api/admin/equipment-slots", { token: viewerToken });
    checkEqual(slotAuthoring.body?.code, 0, "观察员能看槽位表");
    const slotWriteByViewer = await api(base, "PATCH", "/api/admin/equipment-slots/cloth", { token: viewerToken, body: { label: "衣服改" } });
    checkEqual(slotWriteByViewer.status, 403, "观察员改槽位 → 403");
    const slotPost = await api(base, "POST", "/api/admin/equipment-slots", { token, body: { key: "ghost" } });
    checkEqual(slotPost.status, 404, "POST 槽位 → 404（槽位不能新增）");
    const slotDelete = await api(base, "DELETE", "/api/admin/equipment-slots/cloth", { token });
    checkEqual(slotDelete.status, 404, "DELETE 槽位 → 404（槽位不能删除）");
    const slotGhost = await api(base, "PATCH", "/api/admin/equipment-slots/ghost", { token, body: { label: "x" } });
    checkEqual(slotGhost.status, 404, "改不存在的槽位 → 404");
    checkEqual(slotGhost.body?.code, 40400, "槽位未找到用通用业务码 40400（槽位没有专属码）");
    const slotPatched = await api(base, "PATCH", "/api/admin/equipment-slots/cloth", { token, body: { label: "衣服(e2e)", order: 5 } });
    checkEqual(slotPatched.status, 200, "PATCH 槽位成功");
    checkEqual(slotPatched.body?.data?.label, "衣服(e2e)", "槽位名称已更新");
    checkEqual(slotPatched.body?.data?.order, 5, "槽位排序已更新（背包整理序同源）");
    const slotRestored = await api(base, "PATCH", "/api/admin/equipment-slots/cloth", {
      token,
      body: { label: slotRows.find((slot) => slot.key === "cloth").label, order: slotRows.findIndex((slot) => slot.key === "cloth") },
    });
    checkEqual(slotRestored.status, 200, "槽位已还原（不污染快照断言）");

    const meta = await api(base, "GET", "/api/admin/equipment-meta", { token });
    checkEqual(meta.status, 200, "装备规则可读");
    const metaRow = meta.body?.data ?? {};
    checkEqual(metaRow.prefixRates?.length, equipMeta.prefixRates.length, `前缀倍率档数 = 种子（${equipMeta.prefixRates.length}）`);
    checkEqual(metaRow.suffixRates?.length, equipMeta.suffixRates.length, `后缀倍率档数 = 种子（${equipMeta.suffixRates.length}）`);
    checkEqual(metaRow.prefixLabels?.[0], equipMeta.prefixLabels[0], "前缀文案与种子一致");
    checkEqual(metaRow.suffixLabels?.[0], equipMeta.suffixLabels[0], "后缀文案与种子一致");
    check(metaRow.recycleCurve === undefined, "回收价曲线已从契约里退场（#655 改成逐条 sell_price）");
    const metaByViewer = await api(base, "GET", "/api/admin/equipment-meta", { token: viewerToken });
    checkEqual(metaByViewer.body?.code, 0, "观察员能看装备规则");
    const metaWriteByViewer = await api(base, "PATCH", "/api/admin/equipment-meta", { token: viewerToken, body: { prefixRates: [1] } });
    checkEqual(metaWriteByViewer.status, 403, "观察员改装备规则 → 403");

    const metaAsymmetric = await api(base, "PATCH", "/api/admin/equipment-meta", { token, body: { prefixRates: [1, 1.5], prefixLabels: ["一档"] } });
    checkEqual(metaAsymmetric.status, 400, "倍率与文案长度不一致 → 400");
    checkEqual(metaAsymmetric.body?.code, 40000, "跨字段校验用 40000（参数非法）");
    // 下架字段写回来必须验不出来（whitelist 会剥掉，接口照常 200 但值不变）
    const metaGhostField = await api(base, "PATCH", "/api/admin/equipment-meta", {
      token,
      body: { recycleCurve: [{ from: 1, to: 10, start: 1, perLevel: 1 }] },
    });
    checkEqual(metaGhostField.status, 200, "写已下架的 recycleCurve 不报错（whitelist 静默剥掉）");
    check(metaGhostField.body?.data?.recycleCurve === undefined, "响应里没有 recycleCurve（字段真的没了）");

    const metaPatched = await api(base, "PATCH", "/api/admin/equipment-meta", { token, body: { prefixRates: [1, 1.1, 1.2, 1.3, 1.5] } });
    checkEqual(metaPatched.status, 200, "PATCH 前缀倍率成功");
    checkEqual(metaPatched.body?.data?.prefixRates?.[4], 1.5, "新版倍率已落库（改它就是全局调强度）");

    // 品质文字颜色（#720）：与文案同下标等长；空数组 = 清空回落客户端内置色；坏 hex / 长度不齐 → 400
    checkEqual(Array.isArray(metaRow.prefixColors) && metaRow.prefixColors.length, 5, "出厂快照带 5 档前缀颜色（种子内置色）");
    const metaColors = await api(base, "PATCH", "/api/admin/equipment-meta", {
      token,
      body: { prefixColors: ["#112233", "#445566", "#778899", "#AABBCC", "#DDEEFF"] },
    });
    checkEqual(metaColors.status, 200, "PATCH 前缀颜色成功（#RRGGBB 整份替换）");
    checkEqual(metaColors.body?.data?.prefixColors?.[0], "#112233", "颜色已落库");
    const metaColorsMismatch = await api(base, "PATCH", "/api/admin/equipment-meta", { token, body: { prefixColors: ["#112233"] } });
    checkEqual(metaColorsMismatch.status, 400, "颜色与文案长度不一致 → 400");
    const metaColorsBadHex = await api(base, "PATCH", "/api/admin/equipment-meta", { token, body: { prefixColors: ["#11223", "#445566", "#778899", "#AABBCC", "#DDEEFF"] } });
    checkEqual(metaColorsBadHex.status, 400, "颜色不是 #RRGGBB → 400");
    const metaColorsCleared = await api(base, "PATCH", "/api/admin/equipment-meta", { token, body: { prefixColors: [] } });
    checkEqual(metaColorsCleared.status, 200, "空数组颜色 = 清空（客户端回落内置色）");
    checkEqual(metaColorsCleared.body?.data?.prefixColors?.length, 0, "清空后颜色是空数组");

    const metaRestored = await api(base, "PATCH", "/api/admin/equipment-meta", {
      token,
      body: {
        prefixRates: equipMeta.prefixRates,
        suffixRates: equipMeta.suffixRates,
        prefixLabels: equipMeta.prefixLabels,
        suffixLabels: equipMeta.suffixLabels,
        prefixColors: ["#DDDDDD", "#6EE86E", "#4DA6FF", "#C77DFF", "#FFA640"],
        suffixColors: ["#B0B0B0", "#4DE3FF", "#FFD700"],
      },
    });
    checkEqual(metaRestored.body?.data?.prefixRates?.[4], equipMeta.prefixRates[4], "倍率已还原（不污染后续结算断言）");
    checkEqual(metaRestored.body?.data?.prefixColors?.length, 5, "颜色已还原（出厂内置色，不污染快照断言）");

    //#endregion

    //#region 九、药品配置（#253）：seed 同源 / keyword 筛 / 只许改 / 百分比上限

    group("九、药品配置");

    const drugsRes = await api(base, "GET", "/api/admin/drugs", { token });
    checkEqual(drugsRes.status, 200, "药品列表可读");
    const drugCount = Object.keys(drugs).length;
    checkEqual(drugsRes.body?.data?.total, drugCount, `药品行数 = 配置表（${drugCount}）`);
    checkEqual(drugsRes.body?.data?.list?.length, drugCount, "默认一页装下全部药品");
    const drugHp1 = drugsRes.body?.data?.list?.find((row) => row.id === "drug_hp_1");
    check(Boolean(drugHp1), "列表里有药品 drug_hp_1");
    checkEqual(drugHp1?.label, drugs["drug_hp_1"].label, "drug_hp_1 名称与配置一致");
    checkEqual(drugHp1?.sellPrice, drugs["drug_hp_1"].sellPrice, "drug_hp_1 售卖价与配置一致");
    checkEqual(drugHp1?.effectHp, drugs["drug_hp_1"].effectHp, "drug_hp_1 固定回复量与配置一致（effects 求和）");
    checkEqual(drugHp1?.maxStack, drugs["drug_hp_1"].maxStack, "drug_hp_1 堆叠上限与配置一致");
    checkEqual(drugHp1?.cooldown, drugs["drug_hp_1"].cooldown, "drug_hp_1 冷却与配置一致");
    // #603 第十域：图标也入库了（客户端不再自带，拼不出 item/drug-hp-1 这类路径）
    checkEqual(drugHp1?.icon, drugs["drug_hp_1"].icon, "drug_hp_1 图标与配置一致（图标在表里）");
    const drugSun = drugsRes.body?.data?.list?.find((row) => row.id === "drug_sun");
    checkEqual(drugSun?.effectHp, drugs["drug_sun"].effectHp, "drug_sun 固定回血与配置一致");
    checkEqual(drugSun?.effectMp, drugs["drug_sun"].effectMp, "drug_sun 固定回蓝与配置一致");
    const drugPct = drugsRes.body?.data?.list?.find((row) => row.id === "drug_hp_pct");
    checkEqual(drugPct?.effectHpPercent, drugs["drug_hp_pct"].effectHpPercent, "drug_hp_pct 百分比回复与配置一致");

    const drugKeywordLabel = await api(base, "GET", "/api/admin/drugs?keyword=" + encodeURIComponent("金创"), { token });
    checkEqual(drugKeywordLabel.body?.data?.total, 5, "关键字按名称命中五档金创药");
    const drugKeywordId = await api(base, "GET", "/api/admin/drugs?keyword=drug_mp", { token });
    checkEqual(drugKeywordId.body?.data?.total, 4, "关键字按 id 命中三档魔法药 + 强效蓝药");

    const drugPatched = await api(base, "PATCH", "/api/admin/drugs/drug_hp_1", { token, body: { label: "金创药（小·改）", effectHp: 120, cooldown: 2, maxStack: 999 } });
    checkEqual(drugPatched.status, 200, "PATCH 药品成功（名称/回复量/冷却/堆叠一起改）");
    checkEqual(drugPatched.body?.data?.label, "金创药（小·改）", "响应里的名称已更新");
    checkEqual(drugPatched.body?.data?.effectHp, 120, "响应里的回复量已更新");
    checkEqual(drugPatched.body?.data?.cooldown, 2, "响应里的冷却已更新");
    checkEqual(drugPatched.body?.data?.maxStack, 999, "响应里的堆叠上限已更新");
    // 图标是显示数据，运营能改；改完立刻还原（下面还有依赖出厂图标的断言）
    const drugIconPatched = await api(base, "PATCH", "/api/admin/drugs/drug_hp_1", { token, body: { icon: "item/fs_9" } });
    checkEqual(drugIconPatched.body?.data?.icon, "item/fs_9", "图标可编辑（#603 第十域）");
    const drugIconBad = await api(base, "PATCH", "/api/admin/drugs/drug_hp_1", { token, body: { icon: "x".repeat(201) } });
    checkEqual(drugIconBad.status, 400, "图标路径超过 200 字 → 400");
    const drugIconRestore = await api(base, "PATCH", "/api/admin/drugs/drug_hp_1", { token, body: { icon: drugs["drug_hp_1"].icon } });
    checkEqual(drugIconRestore.body?.data?.icon, drugs["drug_hp_1"].icon, "图标已还原出厂值");
    const drugBadPercent = await api(base, "PATCH", "/api/admin/drugs/drug_hp_1", { token, body: { effectHpPercent: 120 } });
    checkEqual(drugBadPercent.status, 400, "百分比回复超过 100 → 400");
    checkEqual(drugBadPercent.body?.code, 40000, "百分比校验用 40000（参数非法）");
    const drugGhost = await api(base, "PATCH", "/api/admin/drugs/drug_none", { token, body: { label: "x" } });
    checkEqual(drugGhost.status, 404, "改不存在的药品 → 404");
    checkEqual(drugGhost.body?.code, 50017, "药品未找到用专属业务码 50017");
    // #643：使用等级开放编辑（只影响展示与背包排序，服务端用药不拦）
    const drugLevelPatched = await api(base, "PATCH", "/api/admin/drugs/drug_hp_1", { token, body: { level: 30 } });
    checkEqual(drugLevelPatched.status, 200, "使用等级可编辑");
    checkEqual(drugLevelPatched.body?.data?.level, 30, "使用等级已更新为 30");
    const drugLevelBad = await api(base, "PATCH", "/api/admin/drugs/drug_hp_1", { token, body: { level: 99 } });
    checkEqual(drugLevelBad.status, 400, "使用等级超过上限 60 → 400");
    checkEqual(drugLevelBad.body?.code, 40000, "使用等级越界用 40000（参数非法）");
    const drugLevelRestore = await api(base, "PATCH", "/api/admin/drugs/drug_hp_1", { token, body: { level: drugs["drug_hp_1"].level } });
    checkEqual(drugLevelRestore.body?.data?.level, drugs["drug_hp_1"].level, "使用等级已还原出厂值");
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

    const itemsRes = await api(base, "GET", "/api/admin/items", { token });
    checkEqual(itemsRes.status, 200, "物品列表可读");
    const itemCount = Object.keys(items).length;
    checkEqual(itemsRes.body?.data?.total, itemCount, `物品行数 = 配置表（${itemCount}）`);
    checkEqual(itemsRes.body?.data?.list?.length, itemCount, "默认一页装下全部物品");
    const hide = itemsRes.body?.data?.list?.find((row) => row.id === "material_hide");
    check(Boolean(hide), "列表里有物品 material_hide");
    checkEqual(hide?.type, items["material_hide"].type, "material_hide 大类与配置一致");
    checkEqual(hide?.label, items["material_hide"].label, "material_hide 名称与配置一致");
    checkEqual(hide?.sellPrice, items["material_hide"].sellPrice, "material_hide 售卖价与配置一致");
    checkEqual(hide?.maxStack, items["material_hide"].maxStack, "material_hide 堆叠上限与配置一致");
    checkEqual(hide?.icon, items["material_hide"].icon, "material_hide 图标与配置一致（图标在表里）");

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
    const itemIconPatched = await api(base, "PATCH", "/api/admin/items/material_hide", { token, body: { icon: "item/2010299" } });
    checkEqual(itemIconPatched.body?.data?.icon, "item/2010299", "物品图标可编辑（#603 第十域）");
    const itemIconRestore = await api(base, "PATCH", "/api/admin/items/material_hide", { token, body: { icon: items["material_hide"].icon } });
    checkEqual(itemIconRestore.body?.data?.icon, items["material_hide"].icon, "物品图标已还原出厂值");
    const itemGhost = await api(base, "PATCH", "/api/admin/items/material_none", { token, body: { label: "x" } });
    checkEqual(itemGhost.status, 404, "改不存在的物品 → 404");
    checkEqual(itemGhost.body?.code, 50018, "物品未找到用专属业务码 50018");
    const itemStructural = await api(base, "PATCH", "/api/admin/items/material_hide", { token, body: { type: "drug", level: 99 } });
    checkEqual(itemStructural.status, 200, "PATCH 结构字段不报错（白名单剥离）");
    checkEqual(itemStructural.body?.data?.type, items["material_hide"].type, "type 不可编辑（大类属客户端结构约定）");
    checkEqual(itemStructural.body?.data?.level, items["material_hide"].level, "level 不可编辑");
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
    const monsterCount = monsterRows.length;
    checkEqual(monsters.body?.data?.total, monsterCount, `怪物行数 = 配置表（${monsterCount}）`);
    checkEqual(monsters.body?.data?.list?.length, 100, "默认每页 100 条（220 只装不下一页）");
    const monstersPage2 = await api(base, "GET", "/api/admin/monsters?page=2", { token });
    checkEqual(monstersPage2.body?.data?.list?.length, 100, "第二页也是满的 100 条");
    const monstersPage3 = await api(base, "GET", "/api/admin/monsters?page=3", { token });
    checkEqual(monstersPage3.body?.data?.list?.length, monsterCount - 200, "第三页补齐剩余怪物");
    checkEqual(monsters.body?.data?.list?.[0]?.level, 1, "默认按等级升序（首行是 1 级怪）");

    const monster1 = monsters.body?.data?.list?.find((row) => row.id === "1");
    check(Boolean(monster1), "列表里有怪物 key \"1\"");
    checkEqual(monster1?.label, monsterSeed1.label, "怪物 1 名称与种子一致");
    checkEqual(monster1?.tier, monsterSeed1.tier, "怪物 1 定位与种子一致");
    checkEqual(monster1?.maxHp, monsterSeed1.maxHp, "怪物 1 生命上限与库里的行一致");
    checkEqual(
      JSON.stringify([monster1?.attributes?.physicalAttack?.min, monster1?.attributes?.physicalAttack?.max]),
      JSON.stringify([monsterSeed1.physicalAttackMin, monsterSeed1.physicalAttackMax]),
      "怪物 1 物攻区间与库里的行一致（单列 min/max → min/max 结构）",
    );

    const monsterKeyword = await api(base, "GET", "/api/admin/monsters?keyword=" + encodeURIComponent(monsterSeed1.label), { token });
    checkEqual(monsterKeyword.body?.data?.total, 1, "关键字按名称命中怪物 1");
    const monstersNormal = await api(base, "GET", "/api/admin/monsters?tier=normal", { token });
    const monstersBoss = await api(base, "GET", "/api/admin/monsters?tier=boss", { token });
    // 分档口径从快照现算（#436）：这条以前写的是「全部怪物，当前全是普通怪」——
    // 那是 `configs/monster.ts` 建 Map 时把 tier 解构掉又没放回的 bug 留下的印记，
    // tier 修好后 220 只怪里只有 199 只是普通怪，照抄老数字会立刻假红。
    const normalCount = monsterRows.filter((row) => row.tier === "normal").length;
    const bossCount = monsterRows.filter((row) => row.tier === "boss").length;
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
    checkEqual(monsterStructural.status, 200, "PATCH tier → 200（#751 起定位可改）");
    checkEqual(monsterStructural.body?.data?.tier, "boss", "定位已改成 boss");
    checkEqual(monsterStructural.body?.data?.maxHp, 500, "改定位不重算已展开的血量上限");
    const monsterTierBack = await api(base, "PATCH", "/api/admin/monsters/1", { token, body: { tier: monsterSeed1.tier } });
    checkEqual(monsterTierBack.body?.data?.tier, monsterSeed1.tier, "定位改回种子值");
    const monsterBadTier = await api(base, "PATCH", "/api/admin/monsters/1", { token, body: { tier: "legend" } });
    checkEqual(monsterBadTier.status, 400, "定位取值不合法 → 400（白名单外的值不再是「静默忽略」）");
    checkEqual(monsterBadTier.body?.code, 40000, "非法定位用 40000");

    // 表现参数（#751）：管理端行要带 presentation 段，几何只读、行为可写
    // 快照行是扁平 camelCase 列（快照解析器只做列名驼峰化，不还原嵌套结构）
    const presentationSeed1 = presentations.find((row) => row.id === "1");
    check(Boolean(presentationSeed1), "配置快照里有怪物 1 的表现行");
    const seed1Aggressive = Number(presentationSeed1.aggressive) === 1;
    checkEqual(monster1?.presentation?.moveSpeed, presentationSeed1.moveSpeed, "管理端行的 moveSpeed 与库里的表现行一致");
    checkEqual(monster1?.presentation?.detectRange, presentationSeed1.detectRange, "管理端行的 detectRange 与库里的表现行一致");
    checkEqual(monster1?.presentation?.aggressive, seed1Aggressive, "aggressive 以布尔下发（库里是 0/1）");
    check(Boolean(monster1?.presentation?.icon), "表现段带图标路径（客户端画怪要用）");

    const behaviorPatched = await api(base, "PATCH", "/api/admin/monsters/1", {
      token,
      body: {
        presentation: {
          aggressive: !seed1Aggressive,
          detectRange: 321,
          moveSpeed: 3.5,
          speedRate: { walk: 2 },
        },
      },
    });
    checkEqual(behaviorPatched.status, 200, "PATCH 行为参数成功（主动攻击 / 检测范围 / 移动速度 / 动作速度一起改）");
    checkEqual(behaviorPatched.body?.data?.presentation?.aggressive, !seed1Aggressive, "主动攻击已翻转");
    checkEqual(behaviorPatched.body?.data?.presentation?.detectRange, 321, "检测范围已更新");
    checkEqual(behaviorPatched.body?.data?.presentation?.moveSpeed, 3.5, "移动速度已更新（小数保留）");
    checkEqual(behaviorPatched.body?.data?.presentation?.speedRate?.walk, 2, "动作速度覆盖已写入");
    checkEqual(
      behaviorPatched.body?.data?.presentation?.outOffset?.x,
      presentationSeed1.outOffsetX,
      "只改行为不动几何：摆放偏移不变",
    );
    checkEqual(
      behaviorPatched.body?.data?.presentation?.contentSize?.width,
      presentationSeed1.contentWidth,
      "只改行为不动几何：身体宽不变",
    );
    checkEqual(behaviorPatched.body?.data?.maxHp, 500, "只传 presentation 不动上一次改的生命上限");

    // 部分更新语义：只传一个字段，其余保持（且 speedRate 不被顺手清空）
    const behaviorPartial = await api(base, "PATCH", "/api/admin/monsters/1", {
      token,
      body: { presentation: { detectRange: 250 } },
    });
    checkEqual(behaviorPartial.body?.data?.presentation?.moveSpeed, 3.5, "只传 detectRange 时移动速度保留（合并语义）");
    checkEqual(behaviorPartial.body?.data?.presentation?.speedRate?.walk, 2, "只传 detectRange 时动作速度覆盖保留");

    const behaviorBadAction = await api(base, "PATCH", "/api/admin/monsters/1", {
      token,
      body: { presentation: { speedRate: { attack_near: 2 } } },
    });
    checkEqual(behaviorBadAction.status, 400, "给没有帧的动作配速度 → 400（不装作生效）");
    checkEqual(behaviorBadAction.body?.code, 40000, "非法动作键用 40000");
    const behaviorBadRate = await api(base, "PATCH", "/api/admin/monsters/1", {
      token,
      body: { presentation: { speedRate: { walk: 0 } } },
    });
    checkEqual(behaviorBadRate.status, 400, "动作速度为 0 → 400（帧不动）");
    const behaviorBadRange = await api(base, "PATCH", "/api/admin/monsters/1", { token, body: { presentation: { detectRange: -1 } } });
    checkEqual(behaviorBadRange.status, 400, "检测范围为负 → 400");

    // 传 {} = 清空回客户端默认（与「不传 = 不改」区分开）
    const behaviorCleared = await api(base, "PATCH", "/api/admin/monsters/1", { token, body: { presentation: { speedRate: {} } } });
    checkEqual(behaviorCleared.status, 200, "动作速度传 {} → 200");
    checkEqual(behaviorCleared.body?.data?.presentation?.speedRate, undefined, "传 {} 清空回默认（speedRate 不再下发）");
    checkEqual(behaviorCleared.body?.data?.presentation?.moveSpeed, 3.5, "清空动作速度不影响移动速度");

    // 复原种子值（后面的断言与其它套件都按出厂行看）
    const behaviorRestored = await api(base, "PATCH", "/api/admin/monsters/1", {
      token,
      body: {
        presentation: {
          aggressive: seed1Aggressive,
          detectRange: presentationSeed1.detectRange,
          moveSpeed: presentationSeed1.moveSpeed,
        },
      },
    });
    checkEqual(behaviorRestored.body?.data?.presentation?.moveSpeed, presentationSeed1.moveSpeed, "行为参数已复原成种子值");
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

    const npcsRes = await api(base, "GET", "/api/admin/npcs", { token });
    checkEqual(npcsRes.status, 200, "NPC 列表可读");
    const npcCount = Object.keys(npcs).length;
    checkEqual(npcsRes.body?.data?.total, npcCount, `NPC 行数 = 配置表（${npcCount}）`);
    checkEqual(npcsRes.body?.data?.list?.length, npcCount, "默认一页装下全部 NPC");
    const npc2 = npcsRes.body?.data?.list?.find((row) => row.id === "0002");
    check(Boolean(npc2), "列表里有 NPC 0002");
    checkEqual(npc2?.label, npcs["0002"].label, "NPC 0002 名称与配置一致");
    checkEqual(npc2?.dialog, "", "对话文案 seed 为空串（客户端暂无对话数据形态）");

    // #603 第七域：外观（素材目录 / 缩放 / 偏移）也在库里 —— 客户端不再存任何 NPC 显示数据
    const npcSeed2 = npcRows.find((row) => row.id === "0002");
    const npcSeedPlain = npcRows.find((row) => row.id === "1001");
    checkEqual(npc2?.src, npcSeed2.src, "素材目录 seed 自 npc-seed（0002）");
    checkEqual(npc2?.scaleX, 1.5, "0002 横向缩放 seed 自 npc-seed");
    checkEqual(npc2?.scaleY, 1.5, "0002 纵向缩放 seed 自 npc-seed");
    checkEqual(npc2?.posX, 11, "0002 横向偏移 seed 自 npc-seed");
    checkEqual(npc2?.posY, 0, "0002 纵向偏移 seed 自 npc-seed");
    const npcPlain = npcsRes.body?.data?.list?.find((row) => row.id === "1001");
    checkEqual(npcPlain?.src, npcSeedPlain.src, "素材目录 seed 自 npc-seed（1001）");
    checkEqual(npcPlain?.scaleX, 1, "没配缩放的 NPC 落默认 1（不是 NULL）");
    checkEqual(npcPlain?.posX, 0, "没配偏移的 NPC 落默认 0（不是 NULL）");
    check(
      npcsRes.body?.data?.list?.every((row) => typeof row.src === "string" && row.src.length > 0),
      "全部 NPC 都有素材目录（空 src = 客户端查不到素材、NPC 不显示）",
    );

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
    // 外观也能改（#603）：改完客户端下次进游戏由快照整表重建
    const npcLook = await api(base, "PATCH", "/api/admin/npcs/0002", {
      token,
      body: { src: "npc/9999", scaleX: 2, scaleY: 2.5, posX: -8, posY: 6 },
    });
    checkEqual(npcLook.body?.data?.src, "npc/9999", "素材目录可改");
    checkEqual(npcLook.body?.data?.scaleX, 2, "横向缩放可改");
    checkEqual(npcLook.body?.data?.scaleY, 2.5, "纵向缩放可改");
    checkEqual(npcLook.body?.data?.posX, -8, "横向偏移可改（负数可用）");
    checkEqual(npcLook.body?.data?.posY, 6, "纵向偏移可改");
    const npcScaled = await api(base, "PATCH", "/api/admin/npcs/0002", { token, body: { scaleX: 0 } });
    checkEqual(npcScaled.status, 400, "缩放 0 → 400（节点会整个消失，不接受）");
    const npcOffset = await api(base, "PATCH", "/api/admin/npcs/0002", { token, body: { posX: 99999 } });
    checkEqual(npcOffset.status, 400, "偏移超出 ±4000 → 400");
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

    //#region 十三、商城分类与上架商品（#758）：先建分类再上架 / 商品是关联数据只改售价与等级

    group("十三、商城分类与上架商品");

    // 出厂状态：config-sync 自带「默认分类」+ 迁移过来的 cloth_1 一行
    const mallCatList = await api(base, "GET", "/api/admin/mall/categories", { token });
    checkEqual(mallCatList.status, 200, "分类列表可读");
    checkEqual(mallCatList.body?.data?.length, mallCategories.length, `分类数 = 出厂（${mallCategories.length}）`);
    checkEqual(mallCatList.body?.data?.[0]?.label, mallCategories[0]?.label, "首个分类显示名与出厂一致");
    checkEqual(mallCatList.body?.data?.[0]?.goodCount, mallGoodsSeed.length, "默认分类的商品数 = 出厂上架行数");

    // 建分类：id 服务端生成（mc_ 前缀），缺省排到最后
    const mallCatCreate = await api(base, "POST", "/api/admin/mall/categories", { token, body: { label: "热卖推荐" } });
    checkEqual(mallCatCreate.status, 201, "新建分类成功");
    const mallCatId = mallCatCreate.body?.data?.id;
    check(typeof mallCatId === "string" && mallCatId.startsWith("mc_"), "分类 id 由服务端生成（mc_ 前缀）");

    // 名字越界 → 400
    const mallCatBad = await api(base, "POST", "/api/admin/mall/categories", { token, body: { label: "" } });
    checkEqual(mallCatBad.status, 400, "空分类名 → 400");

    // 改名与排序
    const mallCatRename = await api(base, "PATCH", `/api/admin/mall/categories/${mallCatId}`, { token, body: { label: "热卖（改）", sortOrder: -1 } });
    checkEqual(mallCatRename.status, 200, "PATCH 分类成功");
    checkEqual(mallCatRename.body?.data?.label, "热卖（改）", "响应里的分类名已更新");
    const mallCatOrder = (await api(base, "GET", "/api/admin/mall/categories", { token })).body?.data;
    checkEqual(mallCatOrder?.[0]?.id, mallCatId, "排序值小者在先（-1 排到最前）");

    // 可上架目录（#763）：装备变体 + 药品，按「物品自己的分类」与等级筛
    const catalogAll = await api(base, "GET", "/api/admin/mall/catalog", { token });
    const catalogTotal = Object.keys(variants).length + Object.keys(drugs).length;
    checkEqual(catalogAll.body?.data?.total, catalogTotal, `目录 = 装备变体 + 药品（${catalogTotal} 件）`);
    check(Array.isArray(catalogAll.body?.data?.levels) && catalogAll.body.data.levels.length > 0, "回包带等级清单（给等级下拉）");
    const catalogWeapon = await api(base, "GET", "/api/admin/mall/catalog?category=weapon", { token });
    check(
      catalogWeapon.body?.data?.list?.every((row) => row.kind === "equipment" && row.slot === "weapon"),
      "按分类筛：武器下只有武器部位的装备",
    );
    const catalogDrug = await api(base, "GET", "/api/admin/mall/catalog?category=drug", { token });
    checkEqual(catalogDrug.body?.data?.total, Object.keys(drugs).length, "按分类筛：药品下只有药品");
    check(
      catalogDrug.body?.data?.list?.every((row) => row.kind === "drug" && row.slot === "" && row.prefix === 0),
      "药品没有部位与前后缀（被选中时管理端不该显示品质徽章）",
    );
    const catalogDrugLevel = await api(base, "GET", `/api/admin/mall/catalog?category=drug&level=${drugs["drug_hp_1"].level}`, { token });
    check(
      catalogDrugLevel.body?.data?.list?.some((row) => row.id === "drug_hp_1"),
      "按分类 + 等级筛：命中药物的等级档",
    );
    const catalogBadCategory = await api(base, "GET", "/api/admin/mall/catalog?category=nope", { token });
    checkEqual(catalogBadCategory.status, 400, "分类取值不合法 → 400");

    // 上架：非装备 id → 404 50021；分类不存在 → 404 50025
    const mallGhostGood = await api(base, "POST", "/api/admin/mall/goods", { token, body: { id: "nope", categoryId: mallCatId } });    checkEqual(mallGhostGood.status, 404, "给装备目录外的 id 上架 → 404");
    checkEqual(mallGhostGood.body?.code, 50021, "商品不存在用专属业务码 50021");
    const mallNoCat = await api(base, "POST", "/api/admin/mall/goods", { token, body: { id: "cloth_1_p0s1", categoryId: "mc_nope" } });
    checkEqual(mallNoCat.status, 404, "分类不存在上架 → 404");
    checkEqual(mallNoCat.body?.code, 50025, "分类不存在用专属业务码 50025");

    // 正常上架（售价 777 / 购买等级 3），重复上架 → 409 50026
    const mallListed = await api(base, "POST", "/api/admin/mall/goods", {
      token,
      body: { id: "cloth_1_p0s1", categoryId: mallCatId, price: 777, requiredLevel: 3 },
    });
    checkEqual(mallListed.status, 201, "上架成功");
    checkEqual(mallListed.body?.data?.label, variants["cloth_1_p0s1"].label, "商品显示名来自装备数据（前后缀已拼好）");
    // 同一件装备 15 个变体同名，管理端只能靠「部位 + 前后缀」分辨 —— 三个只读字段必须跟着下发
    checkEqual(mallListed.body?.data?.slot, equipBases[variants["cloth_1_p0s1"].baseId].slot, "商品展示带部位（装备数据）");
    checkEqual(mallListed.body?.data?.prefix, variants["cloth_1_p0s1"].prefix, "商品展示带前缀序号（品质）");
    checkEqual(mallListed.body?.data?.suffix, variants["cloth_1_p0s1"].suffix, "商品展示带后缀序号（阶级）");
    checkEqual(mallListed.body?.data?.price, 777, "售价已落");
    checkEqual(mallListed.body?.data?.requiredLevel, 3, "购买等级已落");
    const mallListedAgain = await api(base, "POST", "/api/admin/mall/goods", { token, body: { id: "cloth_1_p0s1", categoryId: mallCatId } });
    checkEqual(mallListedAgain.status, 409, "重复上架 → 409（一件装备只能挂一行）");
    checkEqual(mallListedAgain.body?.code, 50026, "重复上架用专属业务码 50026");

    // 列表：分类筛 / 关键字筛
    const mallGoodList = await api(base, "GET", `/api/admin/mall/goods?categoryId=${mallCatId}`, { token });
    checkEqual(mallGoodList.body?.data?.total, 1, "按分类筛命中这一件");
    checkEqual(mallGoodList.body?.data?.list?.[0]?.prefix, variants["cloth_1_p0s1"].prefix, "列表行也带前缀序号（品质列）");
    const mallGoodKeyword = await api(base, "GET", "/api/admin/mall/goods?keyword=p0s1", { token });
    checkEqual(mallGoodKeyword.body?.data?.total, 1, "关键字命中商品 id");

    // 改售价与购买等级（只开放这两个字段）；负数 → 400
    const mallGoodPatch = await api(base, "PATCH", "/api/admin/mall/goods/cloth_1_p0s1", { token, body: { price: 888, requiredLevel: 0 } });
    checkEqual(mallGoodPatch.status, 200, "PATCH 商品成功");
    checkEqual(mallGoodPatch.body?.data?.price, 888, "售价已更新");
    checkEqual(mallGoodPatch.body?.data?.requiredLevel, 0, "购买等级已更新");
    const mallGoodNegative = await api(base, "PATCH", "/api/admin/mall/goods/cloth_1_p0s1", { token, body: { price: -5 } });
    checkEqual(mallGoodNegative.status, 400, "售价负数 → 400");

    // 检索三件套之二：物品等级（#765）—— 回包带可选等级，按等级精确筛
    const clothLevel = mallListed.body?.data?.level;
    check(
      Array.isArray(mallGoodList.body?.data?.levels) && mallGoodList.body.data.levels.includes(clothLevel),
      "列表回包带物品等级（给检索下拉用）",
    );
    const mallGoodByLevel = await api(base, "GET", `/api/admin/mall/goods?level=${clothLevel}`, { token });
    check(
      (mallGoodByLevel.body?.data?.list ?? []).length > 0 &&
        (mallGoodByLevel.body?.data?.list ?? []).every((row) => row.level === clothLevel),
      "按物品等级筛：回包每一行都是这个等级",
      `Lv.${clothLevel}`,
    );
    const mallGoodByWrongLevel = await api(base, "GET", "/api/admin/mall/goods?level=9999", { token });
    checkEqual(mallGoodByWrongLevel.body?.data?.total, 0, "等级不符 → 空表（条件是生效的，不是被忽略）");

    // 改分类（#765）：商品在分类之间移动，不必下架重上（售价与购买等级都保留）
    const mallSecondCat = await api(base, "POST", "/api/admin/mall/categories", { token, body: { label: "武器特卖" } });
    const mallSecondCatId = mallSecondCat.body?.data?.id;
    const mallMoveCat = await api(base, "PATCH", "/api/admin/mall/goods/cloth_1_p0s1", { token, body: { categoryId: mallSecondCatId } });
    checkEqual(mallMoveCat.status, 200, "改分类成功");
    checkEqual(mallMoveCat.body?.data?.categoryId, mallSecondCatId, "商品挂到了新分类");
    checkEqual(mallMoveCat.body?.data?.price, 888, "改分类不动售价");
    const mallOldCatEmpty = await api(base, "GET", `/api/admin/mall/goods?categoryId=${mallCatId}`, { token });
    checkEqual(mallOldCatEmpty.body?.data?.total, 0, "原分类下已经没有这件");
    const mallNewCatHas = await api(base, "GET", `/api/admin/mall/goods?categoryId=${mallSecondCatId}`, { token });
    checkEqual(mallNewCatHas.body?.data?.total, 1, "新分类下命中");
    const mallMoveBadCat = await api(base, "PATCH", "/api/admin/mall/goods/cloth_1_p0s1", { token, body: { categoryId: "mc_nope" } });
    checkEqual(mallMoveBadCat.status, 404, "改到不存在的分类 → 404");
    checkEqual(mallMoveBadCat.body?.code, 50025, "改分类也要校验目标分类存在（50025）");
    // 移回原分类：后面的「非空分类拒删」仍以 mallCatId 为准；第二个空分类随后删掉，不留脏数据
    const mallMoveBack = await api(base, "PATCH", "/api/admin/mall/goods/cloth_1_p0s1", { token, body: { categoryId: mallCatId } });
    checkEqual(mallMoveBack.body?.data?.categoryId, mallCatId, "移回原分类");
    const mallSecondCatDelete = await api(base, "DELETE", `/api/admin/mall/categories/${mallSecondCatId}`, { token });
    checkEqual(mallSecondCatDelete.status, 200, "搬空后的分类可删");

    // 非空分类拒删 → 409 50028；删空分类成功，再删 → 404 50025
    const mallCatNotEmpty = await api(base, "DELETE", `/api/admin/mall/categories/${mallCatId}`, { token });
    checkEqual(mallCatNotEmpty.status, 409, "分类下还有商品 → 409");
    checkEqual(mallCatNotEmpty.body?.code, 50028, "非空分类用专属业务码 50028");
    const mallCatDelete = await api(base, "DELETE", `/api/admin/mall/categories/${mallCatId}`, { token });
    checkEqual(mallCatDelete.status, 409, "（上面那件还没下架，分类仍然非空）");

    // 下架后再删分类：删行 = 下架（装备本体不受影响）
    const mallDelist = await api(base, "DELETE", "/api/admin/mall/goods/cloth_1_p0s1", { token });
    checkEqual(mallDelist.status, 200, "下架成功（删行）");
    const mallDelistAgain = await api(base, "DELETE", "/api/admin/mall/goods/cloth_1_p0s1", { token });
    checkEqual(mallDelistAgain.status, 404, "下架无不可下架 → 404（不静默成功）");
    checkEqual(mallDelistAgain.body?.code, 50021, "下架无不可下架也用 50021");
    const mallCatDelete2 = await api(base, "DELETE", `/api/admin/mall/categories/${mallCatId}`, { token });
    checkEqual(mallCatDelete2.status, 200, "空分类删除成功");
    const mallCatDelete3 = await api(base, "DELETE", `/api/admin/mall/categories/${mallCatId}`, { token });
    checkEqual(mallCatDelete3.status, 404, "删无可删的分类 → 404");
    checkEqual(mallCatDelete3.body?.code, 50025, "分类不存在用 50025");

    // 观察员：能读，不能写（分类与商品两条链都要挡）
    const viewerMallRead = await api(base, "GET", "/api/admin/mall/categories", { token: viewerToken });
    checkEqual(viewerMallRead.body?.code, 0, "观察员能看分类");
    const viewerMallCatWrite = await api(base, "POST", "/api/admin/mall/categories", { token: viewerToken, body: { label: "x" } });
    checkEqual(viewerMallCatWrite.status, 403, "观察员建分类 → 403");
    checkEqual(viewerMallCatWrite.body?.code, 30006, "观察员建分类 → 30006（权限点不足）");
    const viewerMallGoodWrite = await api(base, "POST", "/api/admin/mall/goods", { token: viewerToken, body: { id: "cloth_1", categoryId: "default" } });
    checkEqual(viewerMallGoodWrite.status, 403, "观察员上架 → 403");

    //#endregion

    //#region 十四、时装配置（#257）：seed 同源 / 渠道筛 / 只许改 / 资源路径不可编辑

    group("十四、时装配置");

    const fashionsRes = await api(base, "GET", "/api/admin/fashions", { token });
    checkEqual(fashionsRes.status, 200, "时装列表可读");
    const fashionCount = Object.keys(fashions).length;
    checkEqual(fashionsRes.body?.data?.total, fashionCount, `时装行数 = 配置表（${fashionCount}）`);
    checkEqual(fashionsRes.body?.data?.list?.length, fashionCount, "默认一页装下全部时装");
    const fashion2 = fashionsRes.body?.data?.list?.find((row) => row.id === "cloth_2");
    check(Boolean(fashion2), "列表里有时装 cloth_2");
    checkEqual(fashion2?.label, fashions["cloth_2"].label, "cloth_2 名称与配置一致");
    checkEqual(fashion2?.description, fashions["cloth_2"].description, "cloth_2 描述与配置一致");
    checkEqual(fashion2?.icon, fashions["cloth_2"].icon, "cloth_2 图标路径与配置一致");
    checkEqual(fashion2?.inRes, fashions["cloth_2"].inRes, "cloth_2 内观路径与配置一致");
    checkEqual(fashion2?.outRes, fashions["cloth_2"].outRes, "cloth_2 外观路径与配置一致");
    checkEqual(fashion2?.sellPrice, 0, "售卖价 seed 为 0（原配置全零）");
    checkEqual(fashion2?.acquireChannel, "unavailable", "获得渠道 seed 默认无法获取");
    checkEqual(fashion2?.attributes?.maxHp, 0, "属性嵌套结构返回且 seed 全 0（maxHp）");
    const fashion12 = fashionsRes.body?.data?.list?.find((row) => row.id === "cloth_12");
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
      JSON.stringify(fashionsRes.body?.data?.list?.[0]?.id),
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
    // #641：资源路径开放编辑（管理端有可视化图片选择器，素材仍在客户端）
    const fashionRes = await api(base, "PATCH", "/api/admin/fashions/cloth_2", {
      token,
      body: { icon: "equipment/clothes/icon/999", inRes: "equipment/clothes/in/030", outRes: "equipment/clothes/out/030" },
    });
    checkEqual(fashionRes.status, 200, "资源路径可以改（图标 / 内观 / 外观）");
    checkEqual(fashionRes.body?.data?.icon, "equipment/clothes/icon/999", "图标按提交值落库");
    checkEqual(fashionRes.body?.data?.inRes, "equipment/clothes/in/030", "内观按提交值落库");
    checkEqual(fashionRes.body?.data?.outRes, "equipment/clothes/out/030", "外观按提交值落库");
    const fashionResEmpty = await api(base, "PATCH", "/api/admin/fashions/cloth_2", {
      token,
      body: { icon: "", inRes: "", outRes: "" },
    });
    checkEqual(fashionResEmpty.status, 200, "空串合法（= 不显示 / 不穿）");
    checkEqual(fashionResEmpty.body?.data?.icon, "", "空串能把图标清掉");
    const fashionResTooLong = await api(base, "PATCH", "/api/admin/fashions/cloth_2", { token, body: { icon: "x".repeat(201) } });
    checkEqual(fashionResTooLong.status, 400, "资源路径超长 → 400（防御性上限 200）");
    const fashionResRestored = await api(base, "PATCH", "/api/admin/fashions/cloth_2", {
      token,
      body: { icon: fashions["cloth_2"].icon, inRes: fashions["cloth_2"].inRes, outRes: fashions["cloth_2"].outRes },
    });
    checkEqual(fashionResRestored.body?.data?.inRes, fashions["cloth_2"].inRes, "复原内观路径（后面的断言以出厂口径为基线）");
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
    const seedTableCount = Object.keys(dropTables).length;
    checkEqual(dropTablesList.body?.data?.total, seedTableCount, `具名表张数 = 配置表（${seedTableCount}：common/elite/boss + 兜底 default）`);
    const commonTable = dropTablesList.body?.data?.list?.find((row) => row.id === "common");
    check(Boolean(commonTable), "列表里有具名表 common");
    checkEqual(
      JSON.stringify([commonTable?.picks, commonTable?.entries?.[0]]),
      JSON.stringify([jsonColumn(dropTables["common"].picks), dropTables["common"].entries[0]]),
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
    const monsterDropCount = Object.keys(monsterDrops).length;
    checkEqual(monsterDropsList.body?.data?.total, monsterDropCount, `每怪行数 = 配置表（${monsterDropCount}）`);
    checkEqual(monsterDropsList.body?.data?.list?.length, 20, "默认每页 20 条");
    checkEqual(monsterDropsList.body?.data?.list?.[0]?.monsterKey, "1", "默认按 key 数值升序（首行是怪 1，不是字典序的 \"1\",\"10\"…）");
    const monsterDrop1 = monsterDropsList.body?.data?.list?.find((row) => row.monsterKey === "1");
    // 来源不锁具体值：出厂虽然全是内联（entries），运营可以在管理端把任一怪指到具名掉落表
    // （config-sync 跟着库走，指过表的行 source = table、entries 为空）—— 只锁「字段自洽」
    check(
      monsterDrop1?.source === "entries" || monsterDrop1?.source === "table",
      "怪 1 的来源是 entries / table 之一（内联或指具名表）",
      JSON.stringify(monsterDrop1?.source),
    );
    if (monsterDrop1?.source === "entries") {
      checkEqual(
        JSON.stringify(monsterDrop1?.entries?.[0]),
        JSON.stringify(monsterDrops["1"].entries[0]),
        "内联行的首条目与配置一致",
      );
    } else {
      check(!!monsterDrop1?.tableId, "指表行的 tableId 存在", JSON.stringify(monsterDrop1?.tableId));
      check(
        configSnapshot.rows("drop_tables").some((row) => row.id === monsterDrop1?.tableId),
        `指表行指向的具名表存在（${monsterDrop1?.tableId}）`,
      );
    }
    const monsterDropsBySource = await api(base, "GET", "/api/admin/monster-drops?source=entries", { token });
    const inlineCount = Object.values(monsterDrops).filter((row) => row.source === "entries").length;
    checkEqual(monsterDropsBySource.body?.data?.total, inlineCount, "按来源筛 entries：内联行的数量与配置一致");
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

    // #584：怪物列表直接带掉落摘要（管理端视角），弹窗回填走单条详情
    const monstersWithDrop = await api(base, "GET", "/api/admin/monsters?size=5", { token });
    checkEqual(monstersWithDrop.status, 200, "怪物列表可读（#584 起带掉落摘要）");
    const firstMonster = monstersWithDrop.body?.data?.list?.[0];
    check(Boolean(firstMonster?.drop), "怪物行带 drop 摘要");
    check(["table", "entries", "none"].includes(firstMonster?.drop?.source), "摘要来源是三种之一（table / entries / none）");
    const dropDetail = await api(base, "GET", `/api/admin/monster-drops/${firstMonster?.id}`, { token });
    checkEqual(dropDetail.status, 200, "单条掉落详情可读（弹窗回填用）");
    checkEqual(dropDetail.body?.data?.monsterKey, firstMonster?.id, "详情的 key 与请求一致");
    checkEqual(dropDetail.body?.data?.source, firstMonster?.drop?.source, "详情来源 = 列表摘要来源（两处不会漂）");
    checkEqual(dropDetail.body?.data?.entryCount, undefined, "详情不重复造 entryCount（摘要字段只在列表上）");
    checkEqual(dropDetail.body?.data?.entries?.length ?? 0, firstMonster?.drop?.entryCount, "摘要条目数 = 详情条目数");
    const dropDetailGhost = await api(base, "GET", "/api/admin/monster-drops/999", { token });
    checkEqual(dropDetailGhost.status, 404, "查不存在的怪掉落 → 404");
    checkEqual(dropDetailGhost.body?.code, 50024, "怪物掉落未找到用 50024");
    const viewerDropDetail = await api(base, "GET", "/api/admin/monster-drops/1", { token: viewerToken });
    checkEqual(viewerDropDetail.body?.code, 0, "观察员能看单条掉落详情（只读）");

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
    // #605：运行时参数随快照下发（六·五 段把拾取半径改成了 72，这里确认它真的到得了客户端）
    checkEqual(snap.runtimeParams?.drop?.autoPickupRadius, 72, "运行时参数随快照下发（改完的值客户端拿得到）");
    checkEqual(snap.runtimeParams?.autoBattle?.stuckRetryLimit, runtime.autoBattle.stuckRetryLimit, "自动战斗参数是完整一组（不是只发改过的键）");
    checkEqual(snap.runtimeParams?.guild?.nameMax, runtime.guild.nameMax, "帮会规则也在快照里（客户端用于提前提示）");

    // #605：战斗力权重同样入表（六·六 段已复原成出厂值）—— 改一项，快照必须跟着变
    checkEqual(snap.combatWeights?.maxHp, weights.maxHp, "战斗力权重随快照下发（出厂值）");
    const weightChanged = await api(base, "PATCH", "/api/admin/combat-weights", { token, body: { maxHp: weights.maxHp + 5 } });
    checkEqual(weightChanged.status, 200, "把生命权重调高 5");
    const snapshotAfterWeight = await api(base, "GET", "/api/game-config", { token: playerToken });
    checkEqual(
      snapshotAfterWeight.body?.data?.combatWeights?.maxHp,
      weights.maxHp + 5,
      "改完的权重客户端拿得到（快照读库，不是编译期常量）",
    );
    const weightRestoredAgain = await api(base, "PATCH", "/api/admin/combat-weights", { token, body: { maxHp: weights.maxHp } });
    checkEqual(weightRestoredAgain.status, 200, "还原生命权重（后面的断言以出厂口径为基线）");
    // #605：新手引导步骤随快照下发（六·七 段已复原成出厂表）
    checkEqual(snap.guideSteps?.length, guideSteps.length, "引导步骤随快照下发（客户端不再存这张表）");
    checkEqual(snap.guideSteps?.[0]?.trigger, guideSteps[0].trigger, "第一步的推进事件与出厂种子一致");

    {
      // #604：快照是**显式契约** —— 客户端缺段直接抛错并把玩家挡在 Loading 界面。
      // 这里只钉运行时口径（键集合的一致性由 tools/audit-snapshot-contract.cjs 静态守）：
      // 1) 没有任何一段是 undefined（DTO 声明了 value 却没赋值 = 客户端拿到 undefined，
      //    静态审计看不见这种「表达式返回 undefined」）；
      // 2) 契约里 minRows=1 的几段必须有行（空 = 客户端算不出来：血蓝全 0 / 没有装备格）。
      const undefinedSections = Object.keys(snap).filter((key) => snap[key] === undefined);
      checkEqual(undefinedSections.length, 0, `快照没有 undefined 段（${undefinedSections.join("、") || "无"}）`);
      const emptySections = ["levels", "equipmentSlots", "maps", "mapTypes"].filter(
        (key) => !Array.isArray(snap[key]) || snap[key].length === 0,
      );
      checkEqual(emptySections.length, 0, `关键段都非空（${emptySections.join("、") || "levels / equipmentSlots / maps / mapTypes"}）`);
      check(
        Boolean(snap.equipmentMeta && snap.combatWeights && Array.isArray(snap.mallCategories) && Array.isArray(snap.mallGoods)),
        "装备规则 / 战斗力权重 / 商城分类与上架商品段都在",
      );
      check(
        Array.isArray(snap.equipmentMeta?.prefixRates) && snap.equipmentMeta.prefixRates.length > 0,
        "装备规则带非空倍率（空了一件变体都展开不出来，而且不报错）",
      );
    }

    // 各表行数 = 管理端列表的全量（快照的形状与列表行一致）
    checkEqual(snap.titles?.length, titles.length, "快照称号行数 = 配置表");
    checkEqual(snap.souls?.length, souls.length, "快照战魂行数 = 配置表");
    checkEqual(snap.ranks?.length, ranks.length, "快照军衔行数 = 配置表（100 阶）");
    // #655：快照发的是**变体**（每件基础件 × 5 前缀 × 3 后缀），每行都是最终数值，
    // 客户端不再按倍率展开 —— 所以这里对的是「变体总数」，不是基础件数
    const expectedVariants =
      Object.keys(equipBases).length *
      equipMeta.prefixRates.length *
      equipMeta.suffixRates.length;
    checkEqual(snap.equipments?.length, expectedVariants, `快照装备 = 全部变体（${Object.keys(equipBases).length} 基础件 × 前缀档 × 后缀档）`);
    {
      // 变体是独立行而不是现算 —— 抽查最强档，确认「迁移/seed 的展开口径」与倍率一致，
      // 否则「管理端改了一件变体」和「客户端看到的数值」会从这里开始分叉
      const baseRow = snap.equipments?.find((item) => item.id === "cloth_1") ?? {};
      const topRow = snap.equipments?.find((item) => item.id === "cloth_1_p4s2") ?? {};
      const rate = equipMeta.prefixRates[4] * equipMeta.suffixRates[2];
      checkEqual(
        topRow?.attributes?.maxHp,
        Math.round((baseRow.attributes?.maxHp ?? 0) * rate),
        "变体属性 = 基础件 × 前后缀倍率（展开口径与旧版一致）",
      );
      checkEqual(topRow?.prefix, 4, "变体行带前缀序号（客户端按它取品质文案与颜色）");
      checkEqual(topRow?.suffix, 2, "变体行带后缀序号");
    }
    {
      // #603 第九域：客户端 `configs/equipments` 已经没有装备数据 —— 显示字段全在这段里，缺字段 = 装备整表是空的
      const row = snap.equipments?.find((item) => item.id === "cloth_1") ?? {};
      check(Boolean(row.label && row.icon && row.inAtlas && row.outAtlas), "快照装备行带名称与三张资源路径（图标 / 内观 / 外观）");
      check(Array.isArray(row.outPositions) && row.outPositions.length === 8, "快照装备行带 8 向外观位置");
      check(typeof row.inPosX === "number" && typeof row.inPosY === "number", "快照装备行带内观锚点（数字）");
      check(Array.isArray(row.tags) && typeof row.attributes?.maxHp === "number", "快照装备行带标签与八项属性");
    }
    checkEqual(snap.equipmentSlots?.length, slotRows.length, `快照槽位行数 = 种子（${slotRows.length}）`);
    checkEqual(snap.equipmentMeta?.prefixRates?.length, equipMeta.prefixRates.length, "快照带前后缀倍率（客户端展开 15 个变体的依据）");
    checkEqual(snap.equipmentMeta?.prefixLabels?.[0], equipMeta.prefixLabels[0], "快照带品质文案");
    checkEqual(snap.equipmentMeta?.prefixColors?.length, 5, "快照带品质文字颜色（#720，与文案同下标）");
    check(snap.equipmentMeta?.recycleCurve === undefined, "快照不带回收价曲线（价随变体一行下发）");
    checkEqual(snap.drugs?.length, Object.keys(drugs).length, "快照药品行数 = 生成物");
    checkEqual(snap.items?.length, Object.keys(items).length, "快照物品行数 = 生成物");
    {
      // #603 第十域：客户端不带图标了 —— 快照必须带，缺了整套物品显示成白块
      const drugRow = snap.drugs?.find((row) => row.id === "drug_hp_1") ?? {};
      check(Boolean(drugRow.icon), "快照药品行带图标（客户端拼不出 item/drug-hp-1 这类路径）");
      const itemRow = snap.items?.find((row) => row.id === "material_hide") ?? {};
      check(Boolean(itemRow.icon && itemRow.type), "快照物品行带图标与大类");
    }
    checkEqual(snap.monsters?.length, monsterRows.length, "快照怪物行数 = 种子（220）");
    check(!("drop" in (snap.monsters?.[0] ?? {})), "玩家侧快照的怪物不带掉落摘要（客户端不结算掉落，#584）");
    // #588：表现段 —— 客户端零副本，icon / out / 几何 / 移速全靠这一段下发
    checkEqual(snap.monsterPresentations?.length, presentations.length, `快照表现段行数 = 生成物（${presentations.length}）`);
    {
      const first = snap.monsterPresentations?.[0] ?? {};
      check(Boolean(first.icon && first.out), "表现行带 icon / out（客户端渲染与预载的路径来源）");
      check(typeof first.outOffset?.x === "number" && typeof first.outOffset?.y === "number", "表现行 outOffset 是 {x,y}（可见身体中心对准节点原点）");
      check(typeof first.contentSize?.width === "number" && typeof first.contentSize?.height === "number", "表现行 contentSize 是 {width,height}（碰撞盒 / 血条位置）");
      check(new RegExp(`^monster/out/${first.id}$`).test(String(first.out)), "表现行的 out 按 key 拼路径（monster/out/<id>）");
      check(typeof first.moveSpeed === "number" && first.moveSpeed > 0, "表现行带正的 moveSpeed");
      check(typeof first.aggressive === "boolean" && typeof first.detectRange === "number", "表现行带 AI 参数（aggressive / detectRange）");
    }
    checkEqual(snap.npcs?.length, Object.keys(npcs).length, "快照 NPC 行数 = 种子");
    {
      // #603 第七域：快照必须带外观 —— 客户端已经没有 npc-data 兜底，缺字段 = 素材加载不到
      const row = snap.npcs?.find((item) => item.id === "0002") ?? {};
      check(Boolean(row.src), "快照 NPC 行带素材目录（客户端预载 / 建节点全靠它）");
      check(typeof row.scaleX === "number" && typeof row.scaleY === "number", "快照 NPC 行带缩放（数字）");
      check(typeof row.posX === "number" && typeof row.posY === "number", "快照 NPC 行带偏移（数字）");
    }
    checkEqual(snap.fashions?.length, Object.keys(fashions).length, "快照时装行数 = 生成物（20）");
    checkEqual(snap.levels?.length, roleMaxLevel, "快照等级行数 = 等级上限（#590：levels 段替代 levelExps + growthSegments）");
    check(
      Boolean(Array.isArray(snap.levels) && snap.levels.length > 0 && typeof snap.levels[0].exp === "number" && typeof snap.levels[0].maxHp === "number"),
      "快照等级行带最终属性与升级经验（客户端不再派生）",
    );
    check(snap.growthSegments === undefined && snap.levelExps === undefined, "旧段（growthSegments / levelExps）已随 #590 移出快照");
    check(Boolean(Array.isArray(snap.growthScalars) && snap.growthScalars.length > 0), "快照带成长标量参数");
    check(Boolean(Array.isArray(snap.mallCategories) && snap.mallCategories.length > 0), "快照带商城分类（出厂默认分类）");
    check(Boolean(Array.isArray(snap.mallGoods) && snap.mallGoods.length > 0), "快照带商城上架商品");
    checkEqual(snap.dropTables?.length, seedTableCount, `快照具名掉落表张数 = seed（${seedTableCount}）`);
    checkEqual(snap.monsterDrops?.length, Object.keys(monsterDrops).length, "快照每怪掉落行数 = 生成物（220）");
    checkEqual(snap.skills?.length, Object.keys(skills).length, "快照技能行数 = 生成物（含释放限制字段）");
    checkEqual(snap.statuses?.length, Object.keys(statuses).length, "快照状态行数 = 生成物");
    check(Boolean(snap.skills?.[0]?.castLockMs !== undefined && snap.skills?.[0]?.requireTarget !== undefined), "快照技能行带释放限制（castLockMs / requireTarget）");
    // 时装（#603 第十二域）：客户端整表重建要靠这几列，路径必须跟着快照下来
    const snapFashion2 = snap.fashions?.find((row) => row.id === "cloth_2");
    checkEqual(snap.fashions?.length, Object.keys(fashions).length, "快照时装行数 = 生成物（20 套）");
    check(Boolean(snapFashion2?.icon && snapFashion2?.inRes && snapFashion2?.outRes), "快照时装行带 icon / inRes / outRes（客户端据此整表重建，不自己拼路径）");
    check(Boolean(snapFashion2?.attributes?.physicalAttack?.min !== undefined), "快照时装行带嵌套区间属性");

    // 字段形状抽检：camelCase、与管理端列表行同形状（称号渠道不预设值——前面的 region 已改过渠道）
    const adminTitles = await api(base, "GET", "/api/admin/titles", { token });
    const firstTitleRow = adminTitles.body?.data?.list?.find((row) => row.level === snap.titles[0].level);
    checkEqual(snap.titles[0].acquireChannel, firstTitleRow?.acquireChannel, "快照称号渠道字段与列表接口同形状");
    check(Boolean(snap.monsters?.[0]?.attributes?.physicalAttack?.min !== undefined), "快照怪物行带嵌套区间属性（attributes.physicalAttack.min）");
    check(Boolean(typeof snap.mallGoods?.[0]?.price === "number" && typeof snap.mallGoods?.[0]?.requiredLevel === "number"), "快照上架商品行带 price 与 requiredLevel");

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
      body: { label: titles[0].label },
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
    // #597：建号只交三样客户端数据（title / soulOfWar / rank 出厂即 0，账本出厂即 0）
    const growthCreate = await api(base, "POST", "/api/roles", {
      token: growthPlayer,
      body: { name: "成长测试员", occupation: "1", sex: "1" },
    });
    checkEqual(growthCreate.status, 201, "创建成长线测试角色 → 201");
    const growthRoleId = growthCreate.body?.data?.id;
    let growthRevision = growthCreate.body?.data?.revision;

    // #605：战力权重进了配置表 —— 服务端算战力必须读配置（覆盖层），不能还用编译期常量。
    // 探针是「角色详情里的派生战力」（服务端现算）：翻倍生命权重 → 必须变大；还原 → 必须回原值。
    const combatBefore = (await api(base, "GET", `/api/admin/roles/${growthRoleId}`, { token })).body?.data?.derived?.attributes?.combat;
    check(Number.isFinite(combatBefore) && combatBefore > 0, "角色详情能算出战力（结算探针）", String(combatBefore));
    const heavierWeights = await api(base, "PATCH", "/api/admin/combat-weights", { token, body: { maxHp: weights.maxHp * 2 } });
    checkEqual(heavierWeights.status, 200, "把生命权重翻倍");
    const combatAfter = (await api(base, "GET", `/api/admin/roles/${growthRoleId}`, { token })).body?.data?.derived?.attributes?.combat;
    check(combatAfter > combatBefore, "生命权重翻倍后服务端算的战力立刻变大（结算读库、不是常量）", `${combatBefore} → ${combatAfter}`);
    const weightBackToSeed = await api(base, "PATCH", "/api/admin/combat-weights", { token, body: { maxHp: weights.maxHp } });
    checkEqual(weightBackToSeed.status, 200, "还原生命权重");
    const combatRestored = (await api(base, "GET", `/api/admin/roles/${growthRoleId}`, { token })).body?.data?.derived?.attributes?.combat;
    checkEqual(combatRestored, combatBefore, "还原后战力回到原值（覆盖层不是一次性的）");

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

    // 充值走**服务端权威写点**（管理端 PATCH）：`role.save` 不接受客户端改账本（#548），
    // 推上去会被回填成库里的值 —— 这也顺带解释了「为什么改包充不了钱」。
    // 同时为乐观锁用例制造一个旧 revision（PATCH 同样推进修订号）
    const rich = await api(base, "PATCH", `/api/admin/roles/${growthRoleId}`, {
      token,
      body: { bindGold: 999999999 },
    });
    checkEqual(rich.status, 200, "管理端给成长线角色充值绑定元宝（账本只有服务端写点）");
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
    checkEqual(up1.body?.data?.gainedLabel, titles[0].label, "gainedLabel = 1 阶称号名");
    checkEqual(up1.body?.data?.data?.title, 1, "存档 title 推进到 1");
    checkEqual(up1.body?.data?.data?.bindGold, 999999999 - price1, "存档 bindGold 扣减到位");
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
    // #597：建号只交三样客户端数据；满背包状态走管理端 PATCH（稀疏格子铺满 4×6）+ 0 元宝出厂值
    const mallCreate = await api(base, "POST", "/api/roles", {
      token: mallPlayer,
      body: { name: "商城测试员", occupation: "1", sex: "1" },
    });
    checkEqual(mallCreate.status, 201, "创建满背包测试角色 → 201");
    const mallRoleId = mallCreate.body?.data?.id;
    const fullBagCells = [];
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 6; col++) fullBagCells.push({ row, col, id: "cloth_1_p0s0", count: 1 });
    }
    const stuffedMall = await api(base, "PATCH", `/api/admin/roles/${mallRoleId}`, { token, body: { bag: fullBagCells } });
    checkEqual(stuffedMall.status, 200, "管理端把背包塞满（4×6 全满）");

    // #758：先上架（默认分类、售价 777）—— 不在上架清单里的商品购买直接 404
    const listForBuy = await api(base, "POST", "/api/admin/mall/goods", {
      token,
      body: { id: "cloth_1_p0s1", categoryId: "default", price: 777 },
    });
    checkEqual(listForBuy.status, 201, "上架 cloth_1_p0s1（默认分类、售价 777）");

    // 商品不在目录（既不是装备变体也不是药品）→ 404 复用 50021
    const badGood = await api(base, "POST", `/api/roles/${mallRoleId}/mall-purchase`, {
      token: mallPlayer,
      body: { goodId: "drug_hp_small" },
    });
    checkEqual(badGood.status, 404, "目录之外的 id 购买 → 404（商城只卖装备与药品）");
    checkEqual(badGood.body?.code, 50021, "商品不在目录 → 50021");

    // 背包满 → 20012（先于元宝不足：入包前先扣费的设计下顺序是 价→钱→包，但这里钱也不足……先充值再测满包）
    const richMall = await api(base, "PATCH", `/api/admin/roles/${mallRoleId}`, {
      token,
      body: { bindGold: 999999999 },
    });
    checkEqual(richMall.status, 200, "管理端充值到 999999999（背包仍是满的）");
    const fullBagBuy = await api(base, "POST", `/api/roles/${mallRoleId}/mall-purchase`, {
      token: mallPlayer,
      body: { goodId: "cloth_1_p0s1", revision: richMall.body?.data?.revision },
    });
    checkEqual(fullBagBuy.status, 409, "满背包购买 → 409");
    checkEqual(fullBagBuy.body?.code, 20012, "背包已满 → 20012");

    // 腾出背包 + 归零：账本只有服务端写点（#548），所以走管理端 PATCH 的稀疏背包（空数组 = 清空）
    const emptied = await api(base, "PATCH", `/api/admin/roles/${mallRoleId}`, {
      token,
      body: { bindGold: 0, bag: [] },
    });
    checkEqual(emptied.status, 200, "管理端清空背包 + 归零元宝（故意不足）");
    const poorBuy = await api(base, "POST", `/api/roles/${mallRoleId}/mall-purchase`, {
      token: mallPlayer,
      body: { goodId: "cloth_1_p0s1", revision: emptied.body?.data?.revision },
    });
    checkEqual(poorBuy.status, 409, "元宝不足购买 → 409");
    checkEqual(poorBuy.body?.code, 20011, "绑定元宝不足 → 20011");

    // 管理端把售价改成 888（#758：上架行就是唯一价格，改价对购买即时生效）
    const setPrice = await api(base, "PATCH", "/api/admin/mall/goods/cloth_1_p0s1", { token, body: { price: 888 } });
    checkEqual(setPrice.status, 200, "管理端改价 888");

    const recharge = await api(base, "PATCH", `/api/admin/roles/${mallRoleId}`, {
      token,
      body: { bindGold: 1000 },
    });
    checkEqual(recharge.status, 200, "管理端充 1000 元宝");
    const staleRev = recharge.body?.data?.revision;

    const staleBuy = await api(base, "POST", `/api/roles/${mallRoleId}/mall-purchase`, {
      token: mallPlayer,
      body: { goodId: "cloth_1_p0s1", revision: staleRev - 1 },
    });
    checkEqual(staleBuy.status, 409, "带旧修订号购买 → 409");
    checkEqual(staleBuy.body?.code, 20006, "乐观锁冲突 → 20006");

    // 购买等级服务端权威校验（#758）：拉到 999 后购买 → 409 50027，归零后才能买
    const lockLevel = await api(base, "PATCH", "/api/admin/mall/goods/cloth_1_p0s1", { token, body: { requiredLevel: 999 } });
    checkEqual(lockLevel.status, 200, "管理端把购买等级拉到 999");
    const levelLockedBuy = await api(base, "POST", `/api/roles/${mallRoleId}/mall-purchase`, {
      token: mallPlayer,
      body: { goodId: "cloth_1_p0s1", revision: staleRev },
    });
    checkEqual(levelLockedBuy.status, 409, "等级不足购买 → 409");
    checkEqual(levelLockedBuy.body?.code, 50027, "购买等级不足 → 50027");
    const unlockLevel = await api(base, "PATCH", "/api/admin/mall/goods/cloth_1_p0s1", { token, body: { requiredLevel: 0 } });
    checkEqual(unlockLevel.status, 200, "管理端把购买等级归零");

    const bought = await api(base, "POST", `/api/roles/${mallRoleId}/mall-purchase`, {
      token: mallPlayer,
      body: { goodId: "cloth_1_p0s1", revision: staleRev },
    });
    checkEqual(bought.status, 200, "购买成功 → 200");
    checkEqual(bought.body?.data?.consumed, 888, "consumed = 售价 888（管理端改价即时生效）");
    checkEqual(bought.body?.data?.data?.bindGold, 1000 - 888, "存档 bindGold 扣减到位");
    checkEqual(bought.body?.data?.revision, staleRev + 1, "revision 原子 +1");
    const bagAfter = bought.body?.data?.data?.bag;
    check(Array.isArray(bagAfter), "返回存档带 bag 网格");
    checkEqual(bagAfter?.[0]?.[0]?.id, "cloth_1_p0s1", "物品放在网格首个空格（行优先）");
    checkEqual(bagAfter?.[0]?.[0]?.count, 1, "放入数量 = 1");

    // 下架（还原出厂前提，避免污染后续）
    const clearPrice = await api(base, "DELETE", "/api/admin/mall/goods/cloth_1_p0s1", { token });
    checkEqual(clearPrice.status, 200, "下架商品（还原出厂）");

    // #763：药品也能上架 —— 买两瓶药，**叠在同一格**（maxStack 取自 drugs 表；装备仍一件一格）
    const drugListed = await api(base, "POST", "/api/admin/mall/goods", {
      token,
      body: { id: "drug_hp_1", categoryId: "default", price: 30 },
    });
    checkEqual(drugListed.status, 201, "上架药品 drug_hp_1（售价 30）");
    checkEqual(drugListed.body?.data?.kind, "drug", "商品视图的品类 = drug");
    checkEqual(drugListed.body?.data?.icon, drugs["drug_hp_1"].icon, "药品图标取 drugs.icon（不走装备图标解析）");
    checkEqual(drugListed.body?.data?.slot, "", "药品没有部位（管理端该显示「药品」而不是空部位）");
    const drugReady = await api(base, "PATCH", `/api/admin/roles/${mallRoleId}`, {
      token,
      body: { bindGold: 100, bag: [] },
    });
    const drugBuy1 = await api(base, "POST", `/api/roles/${mallRoleId}/mall-purchase`, {
      token: mallPlayer,
      body: { goodId: "drug_hp_1", revision: drugReady.body?.data?.revision },
    });
    checkEqual(drugBuy1.status, 200, "买第一瓶药 → 200");
    checkEqual(drugBuy1.body?.data?.data?.bag?.[0]?.[0]?.count, 1, "第一瓶占一格");
    const drugBuy2 = await api(base, "POST", `/api/roles/${mallRoleId}/mall-purchase`, {
      token: mallPlayer,
      body: { goodId: "drug_hp_1", revision: drugBuy1.body?.data?.revision },
    });
    checkEqual(drugBuy2.status, 200, "买第二瓶药 → 200");
    const drugBag = drugBuy2.body?.data?.data?.bag;
    checkEqual(drugBag?.[0]?.[0]?.id, "drug_hp_1", "药品进背包首格");
    checkEqual(drugBag?.[0]?.[0]?.count, 2, "两瓶叠在同一格（可堆叠物品不另占格子）");
    checkEqual(drugBuy2.body?.data?.data?.bindGold, 40, "两次共扣 60（100 → 40）");
    const drugDelist = await api(base, "DELETE", "/api/admin/mall/goods/drug_hp_1", { token });
    checkEqual(drugDelist.status, 200, "下架药品（还原出厂）");

    //#endregion

    //#region 十九、药品使用：回复结算与扣减在服务端（#308）

    group("十九、药品使用：回复结算与扣减在服务端");

    // 前置清理：region 五把 drug_hp_1 的回复量改成了 120 且未还原（共享 DB 顺序跑），
    // 这里显式设回 seed 口径再开测，不假设前面 region 的遗留状态
    const drugBaseline = await api(base, "PATCH", "/api/admin/drugs/drug_hp_1", { token, body: { effectHp: 60 } });
    checkEqual(drugBaseline.status, 200, "前置：drug_hp_1 回复量归位 60");

    const drugPlayer = await registerPlayer("drug_player");
    check(Boolean(drugPlayer), "药品玩家注册成功");
    // #597：建号只交三样客户端数据 —— 摆药走管理端 PATCH（服务端权威）；
    // #596 血蓝收权后「压血量」也走管理端 PATCH（hp/mp 已是服务端独占，PUT 上报无效）
    const drugCreate = await api(base, "POST", "/api/roles", {
      token: drugPlayer,
      body: { name: "药品测试员", occupation: "1", sex: "1" },
    });
    checkEqual(drugCreate.status, 201, "创建药品测试角色 → 201");
    const drugRoleId = drugCreate.body?.data?.id;
    const drugSeed = await api(base, "PATCH", `/api/admin/roles/${drugRoleId}`, {
      token,
      body: { bag: [{ row: 0, col: 0, id: "drug_hp_1", count: 2 }] },
    });
    checkEqual(drugSeed.status, 200, "管理端摆两瓶金创药（(0,0) x2）");
    const drugLow = await api(base, "PATCH", `/api/admin/roles/${drugRoleId}`, { token, body: { hp: 10 } });
    checkEqual(drugLow.status, 200, "血量压到 10（管理端旁路，供「10 + 60」断言用）");
    const drugFresh = await api(base, "GET", `/api/roles/${drugRoleId}`, { token: drugPlayer });
    checkEqual(drugFresh.status, 200, "取到最新存档（后续用药的 revision 基线）");
    const drugRev0 = drugFresh.body?.data?.revision;

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
    //
    // 背包内容自 #556 起是服务端权威：客户端存档里的 bag 会被库里那份回填（只借网格尺寸），
    // 所以「摆一格药」要走管理端结构化编辑，PUT 只负责改血量
    const refillPlaced = await api(base, "PATCH", `/api/admin/roles/${drugRoleId}`, {
      token,
      body: { bag: [{ row: 0, col: 0, id: "drug_hp_1", count: 1 }] },
    });
    checkEqual(refillPlaced.status, 200, "补一格药（管理端摆格，血量保持已满）");
    const refillSave = await api(base, "PUT", `/api/roles/${drugRoleId}`, {
      token: drugPlayer,
      body: { data: { ...drugFresh.body?.data?.data, hp: bigHeal.body?.data?.data?.hp } },
    });
    const hpFullUse = await api(base, "POST", `/api/roles/${drugRoleId}/drug-use`, {
      token: drugPlayer,
      body: { row: 0, col: 0, revision: refillSave.body?.data?.revision },
    });
    checkEqual(hpFullUse.status, 409, "血量已满再用 → 409");
    checkEqual(hpFullUse.body?.code, 20014, "无需用药 → 20014");

    // 太阳水：血满蓝不满也照用，只回蓝的部分（recoveredHp = 0）
    // #596：血蓝走管理端 PATCH 旁路（hp 给到重算上限即满，mp 压到 10）
    const drugMaxHp = drugFresh.body?.data?.data?.maxHp;
    check(Number(drugMaxHp) > 0, "前置：拿得到服务端重算的 maxHp", JSON.stringify(drugMaxHp));
    const sunPlaced = await api(base, "PATCH", `/api/admin/roles/${drugRoleId}`, {
      token,
      body: { bag: [{ row: 0, col: 1, id: "drug_sun", count: 1 }] },
    });
    checkEqual(sunPlaced.status, 200, "摆好太阳水（管理端摆格，血满蓝低）");
    const sunSave = await api(base, "PATCH", `/api/admin/roles/${drugRoleId}`, { token, body: { hp: drugMaxHp, mp: 10 } });
    checkEqual(sunSave.status, 200, "血量顶满、魔法压到 10（管理端旁路）");
    const sunFresh = await api(base, "GET", `/api/roles/${drugRoleId}`, { token: drugPlayer });
    const sunUsed = await api(base, "POST", `/api/roles/${drugRoleId}/drug-use`, {
      token: drugPlayer,
      body: { row: 0, col: 1, revision: sunFresh.body?.data?.revision },
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
    const drugMaxMp = drugFresh.body?.data?.data?.maxMp;
    const fullPlaced = await api(base, "PATCH", `/api/admin/roles/${drugRoleId}`, {
      token,
      body: { bag: [{ row: 0, col: 0, id: "drug_hp_1", count: 2 }] },
    });
    checkEqual(fullPlaced.status, 200, "摆好满血满蓝 + 一格药（管理端摆格）");
    const fullSave = await api(base, "PATCH", `/api/admin/roles/${drugRoleId}`, {
      token,
      body: { hp: drugMaxHp, mp: drugMaxMp },
    });
    const fullFresh = await api(base, "GET", `/api/roles/${drugRoleId}`, { token: drugPlayer });
    const allFullUse = await api(base, "POST", `/api/roles/${drugRoleId}/drug-use`, {
      token: drugPlayer,
      body: { row: 0, col: 0, revision: fullFresh.body?.data?.revision },
    });
    checkEqual(allFullUse.status, 409, "血蓝全满用药 → 409");
    checkEqual(allFullUse.body?.code, 20014, "血蓝全满 → 20014");
    // 失败不产生任何写入：revision 不推进、药不扣
    const afterFull = await api(base, "GET", `/api/roles/${drugRoleId}`, { token: drugPlayer });
    checkEqual(afterFull.body?.data?.revision, fullFresh.body?.data?.revision, "拒绝用药不推进 revision");
    checkEqual(afterFull.body?.data?.data?.bag?.[0]?.[0]?.count, 2, "拒绝用药不扣药（数量仍 2）");

    // 目标不合法：非药品格子 / 空格子 / 坐标越界
    const equipPlaced = await api(base, "PATCH", `/api/admin/roles/${drugRoleId}`, {
      token,
      body: { bag: [{ row: 1, col: 0, id: "cloth_1_p0s0", count: 1 }] },
    });
    checkEqual(equipPlaced.status, 200, "摆好一格装备（管理端摆格）");
    const equipSave = await api(base, "PUT", `/api/roles/${drugRoleId}`, {
      token: drugPlayer,
      body: { data: { ...drugFresh.body?.data?.data, hp: 10, mp: 10 } },
    });
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

    const skillTotal = Object.keys(skills).length;
    const roleSkillTotal = Object.values(skills).filter((row) => row.owner === "role").length;
    const statusTotal = Object.keys(statuses).length;

    const skillsRes = await api(base, "GET", "/api/admin/skills?size=100", { token });
    checkEqual(skillsRes.status, 200, "技能列表可读");
    checkEqual(skillsRes.body?.data?.total, skillTotal, `技能行数 = 配置表（${skillTotal}）`);
    checkEqual(skillsRes.body?.data?.list?.[0]?.id, "1000", "默认按 id 数值升序（角色 1000 段在前）");

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
    checkEqual(skill1000?.label, skills["1000"].label, "技能 1000 名称与配置一致");
    checkEqual(skill1000?.castLockMs, skills["1000"].castLockMs, "castLockMs seed 与配置一致");
    checkEqual(skill1000?.requireTarget, Boolean(skills["1000"].requireTarget), "requireTarget seed 与配置一致（列是 0/1，接口给布尔）");
    checkEqual(
      skill1000?.damageCoefficients?.length,
      skills["1000"].damageCoefficients.length,
      "伤害系数条数 = 配置表（下标 = 等级 - 1）",
    );
    const skill1010 = roleSkills.body?.data?.list?.find((row) => row.id === "1010");
    checkEqual(skill1010?.statusId, "2001", "状态型技能 1010 的 statusId 来自配置（不再手写映射表）");
    checkEqual(skill1010?.requireTarget, false, "状态型技能不要求目标");

    // —— 职业归属与击退（#603 第十一域）——
    // 这两项以前只活在客户端：职业写在手写的 oeccupationSkills 里、击退写在技能行上，
    // 新增技能要改两处。现在跟在技能行里，客户端按行重建那份映射。
    checkEqual(skill1000?.occupation, skills["1000"].occupation, "职业归属 seed 与配置一致");
    checkEqual(skill1000?.occupation, "1", "普攻归战士（技能栏按 occupation 重建）");
    const skill1001 = roleSkills.body?.data?.list?.find((row) => row.id === "1001");
    checkEqual(skill1001?.pushDistance, skills["1001"].pushDistance, "击退距离 seed 与配置一致");
    checkEqual(skill1001?.pushDistance, 120, "烈火剑法击退 120 像素（场上唯一能推动怪物的途径）");
    checkEqual(skill1010?.pushDistance, 0, "没配击退的技能是 0（不是「击退 0 像素」）");

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
    const badOccupation = await api(base, "PATCH", "/api/admin/skills/1000", { token, body: { occupation: "9" } });
    checkEqual(badOccupation.status, 400, "职业归属不在枚举里 → 400（DTO 拦下）");
    const badPush = await api(base, "PATCH", "/api/admin/skills/1000", { token, body: { pushDistance: -1 } });
    checkEqual(badPush.status, 400, "击退距离为负 → 400（往自己身后推没有意义）");

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

    // —— 正常更新生效：释放限制三件套 + 职业归属 / 击退 ——
    const patchSkill = await api(base, "PATCH", "/api/admin/skills/1000", {
      token,
      body: { cooldown: 2.5, mpCost: 3, castLockMs: 700, requireTarget: false, canAuto: false, occupation: "2", pushDistance: 60 },
    });
    checkEqual(patchSkill.status, 200, "PATCH 技能成功（冷却 / 耗蓝 / 动作锁 / 目标要求 / 自动释放 / 职业 / 击退）");
    checkEqual(patchSkill.body?.data?.cooldown, 2.5, "响应里的冷却已更新");
    checkEqual(patchSkill.body?.data?.castLockMs, 700, "响应里的动作锁已更新");
    checkEqual(patchSkill.body?.data?.requireTarget, false, "响应里的「要求目标」已关掉");
    checkEqual(patchSkill.body?.data?.occupation, "2", "响应里的职业归属已改成法师");
    checkEqual(patchSkill.body?.data?.pushDistance, 60, "响应里的击退距离已写入");
    const skillReread = await api(base, "GET", "/api/admin/skills?keyword=1000", { token });
    checkEqual(skillReread.body?.data?.list?.[0]?.cooldown, 2.5, "重新读取冷却已是新值（落库了）");
    checkEqual(skillReread.body?.data?.list?.[0]?.occupation, "2", "重新读取职业归属已是新值（落库了）");

    // —— 状态表 ——
    const statusesRes = await api(base, "GET", "/api/admin/statuses", { token });
    checkEqual(statusesRes.status, 200, "状态列表可读");
    checkEqual(statusesRes.body?.data?.total, statusTotal, `状态行数 = 配置表（${statusTotal}）`);
    const status2001 = statusesRes.body?.data?.list?.find((row) => row.id === "2001");
    check(Boolean(status2001), "列表里有状态 2001");
    checkEqual(status2001?.label, statuses["2001"].label, "状态 2001 名称与配置一致");
    checkEqual(status2001?.duration, statuses["2001"].duration, "持续时间 seed 与配置一致");
    checkEqual(status2001?.combat?.blockChance, 0.3, "格挡概率 seed 与配置一致");
    checkEqual(status2001?.combat?.blockFactor, 0.5, "格挡系数 seed 与配置一致");
    check(status2001?.combat?.defenseMultiplier === undefined, "没配的维度不出现在 combat 里（不是 0）");
    const status2002 = statusesRes.body?.data?.list?.find((row) => row.id === "2002");
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
    checkEqual(snapSkill1000?.occupation, "2", "快照里的技能带职业归属（客户端据此重建技能栏）");
    checkEqual(snapSkill1000?.pushDistance, 60, "快照里的技能带击退距离（客户端据此推怪）");
    const snapStatus2001 = skillSnapshot.body?.data?.statuses?.find((row) => row.id === "2001");
    checkEqual(Object.keys(snapStatus2001?.combat ?? {}).length, 0, "快照里的状态修正跟着被清空（改配置对客户端生效的通道）");

    // 还原 seed 前提（不给后续追加的断言留脏数据）
    const restoreSkill = await api(base, "PATCH", "/api/admin/skills/1000", {
      token,
      body: { cooldown: 1, mpCost: 0, castLockMs: 0, requireTarget: true, canAuto: true, occupation: "1", pushDistance: 0 },
    });
    checkEqual(restoreSkill.status, 200, "还原技能 1000 的释放限制");
    const restoreSkill1008 = await api(base, "PATCH", "/api/admin/skills/1008", { token, body: { castLockMs: 0 } });
    checkEqual(restoreSkill1008.status, 200, "还原技能 1008 的动作锁");
    const restoreStatus = await api(base, "PATCH", "/api/admin/statuses/2001", {
      token,
      body: { duration: statuses["2001"].duration, combat: { blockChance: 0.3, blockFactor: 0.5 } },
    });
    checkEqual(restoreStatus.status, 200, "还原状态 2001 的时长与修正");

    //#endregion

    //#region 二十一、怪物技能与挂载（#372）：9000 段可增删 / 挂载整份替换 / 攻击倍率

    group("二十一、怪物技能与挂载");

    const mountSeed = mounts["200"];
    const mountList = await api(base, "GET", "/api/admin/monsters/200/skills", { token });
    checkEqual(mountList.status, 200, "怪物 200 的技能挂载可读");
    checkEqual(mountList.body?.data?.total, mountSeed.length, `挂载条数 = 配置表（${mountSeed.length} 条）`);
    checkEqual(mountList.body?.data?.list?.[0]?.skillId, "9002", "按优先级升序（priority 1 的排前）");
    checkEqual(
      mountList.body?.data?.list?.map((row) => row.skillId).join(","),
      "9002,9003,9001",
      "同优先级按技能 id 升序，priority 2 的 9001 收尾",
    );
    checkEqual(mountList.body?.data?.list?.[0]?.skillLabel, skills["9002"].label, "挂载行带技能名（列表不用再查一次技能表）");
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

    //#region 二十二、装备外观（#695/#699/#700）：边框与背景拆边读写 + 每条显示效果

    group("二十二、装备外观：边框 / 背景各自整边读写，互不覆盖；条目可带显示效果");

    // 出厂预期 = 快照里那一行（JSON 列已解成数组；不锁具体数值，只锁「接口 == 快照」）
    const appearanceSeedRow = configSnapshot.rows("equipment_appearance")[0];
    check(Boolean(appearanceSeedRow), "快照里有 equipment_appearance（新表进了 config-sync）");
    checkEqual(appearanceSeedRow.borders.length, 15, "出厂边框映射 15 条");
    checkEqual(appearanceSeedRow.backgrounds.length, 15, "出厂背景映射 15 条");

    const borderRes = await api(base, "GET", "/api/admin/equipment-borders", { token });
    checkEqual(borderRes.status, 200, "边框半边可读");
    const borderPage = borderRes.body?.data ?? {};
    const backgroundRes = await api(base, "GET", "/api/admin/equipment-backgrounds", { token });
    checkEqual(backgroundRes.status, 200, "背景半边可读");
    const backgroundPage = backgroundRes.body?.data ?? {};

    const comboKey = (row) => `${row.prefix}|${row.suffix}`;
    const seedBorderByKey = new Map(appearanceSeedRow.borders.map((row) => [comboKey(row), row.key]));
    const seedBackgroundByKey = new Map(appearanceSeedRow.backgrounds.map((row) => [comboKey(row), row.key]));
    checkEqual(borderPage.assignments?.length, 15, "边框棋盘 = 快照行数");
    checkEqual(backgroundPage.assignments?.length, 15, "背景棋盘 = 快照行数");
    check(
      (borderPage.assignments ?? []).every((row) => seedBorderByKey.get(comboKey(row)) === row.key),
      "边框 key 逐组合与快照一致",
    );
    check(
      (backgroundPage.assignments ?? []).every((row) => seedBackgroundByKey.get(comboKey(row)) === row.key),
      "背景 key 逐组合与快照一致",
    );
    checkEqual(borderPage.customs?.length, appearanceSeedRow.customBorders.length, "自定义边框表 = 快照行数（出厂为空）");
    checkEqual(backgroundPage.customs?.length, appearanceSeedRow.customBackgrounds.length, "自定义背景表 = 快照行数（出厂为空）");

    // —— 边框半边的校验闭环：坏数据都不落库 ——
    const borderOk = borderPage.assignments ?? [];
    const comboDup = borderOk.slice();
    comboDup[1] = { ...comboDup[1], prefix: comboDup[0].prefix, suffix: comboDup[0].suffix };
    const comboDupRes = await api(base, "PATCH", "/api/admin/equipment-borders", { token, body: { assignments: comboDup, customs: [] } });
    checkEqual(comboDupRes.status, 400, "组合重复（两个 0|0）→ 400 且不落库");

    const missingRes = await api(base, "PATCH", "/api/admin/equipment-borders", { token, body: { assignments: borderOk.slice(0, 14), customs: [] } });
    checkEqual(missingRes.status, 400, "只有 14 条（缺一个组合）→ 400");

    const badKey = borderOk.slice();
    badKey[0] = { ...badKey[0], key: "not-a-border" };
    const badKeyRes = await api(base, "PATCH", "/api/admin/equipment-borders", { token, body: { assignments: badKey, customs: [] } });
    checkEqual(badKeyRes.status, 400, "边框 key 格式不对 → 400");

    const badEffect = borderOk.slice();
    badEffect[0] = { ...badEffect[0], effect: { x: 99999, y: 0, scale: 1 } };
    const badEffectRes = await api(base, "PATCH", "/api/admin/equipment-borders", { token, body: { assignments: badEffect, customs: [] } });
    checkEqual(badEffectRes.status, 400, "effect 偏移越界（±2000）→ 400");

    const dupCustomRes = await api(base, "PATCH", "/api/admin/equipment-borders", {
      token,
      body: {
        assignments: borderOk,
        customs: [
          { equipment: "weapon_20", key: "border-30206" },
          { equipment: "weapon_20", key: "border-30205" },
        ],
      },
    });
    checkEqual(dupCustomRes.status, 400, "自定义表装备标识重复 → 400");

    // —— 改了真生效（边框半边）：交换两个组合 + 自定义条目带显示效果 ——
    const swapped = borderOk.slice();
    const tmp = swapped[0].key;
    swapped[0] = { ...swapped[0], key: swapped[14].key, effect: { x: 3, y: -4, scale: 1.2 } };
    swapped[14] = { ...swapped[14], key: tmp };
    const customSeedBorder = "border-30206";
    const borderUpdateRes = await api(base, "PATCH", "/api/admin/equipment-borders", {
      token,
      body: {
        assignments: swapped,
        customs: [{ equipment: "weapon_20", key: customSeedBorder, effect: { x: -2, y: 6, scale: 0.9 } }],
      },
    });
    checkEqual(borderUpdateRes.status, 200, "合法整边替换 → 200");
    checkEqual(borderUpdateRes.body?.data?.assignments?.[0]?.key, swapped[0].key, "交换后的第 1 格 = 提交值");
    checkEqual(borderUpdateRes.body?.data?.assignments?.[0]?.effect?.scale, 1.2, "棋盘格的 effect 随条目落库");
    checkEqual(borderUpdateRes.body?.data?.customs?.[0]?.equipment, "weapon_20", "自定义条目落库");
    checkEqual(borderUpdateRes.body?.data?.customs?.[0]?.effect?.y, 6, "自定义条目的 effect 落库");
    check((borderUpdateRes.body?.data?.updatedAt ?? 0) > 0, "updatedAt 被 touched（0 = 从未改过）");

    const borderReread = await api(base, "GET", "/api/admin/equipment-borders", { token });
    checkEqual(borderReread.body?.data?.assignments?.[14]?.key, tmp, "GET 回读 = 提交值（整边替换生效）");

    // —— 拆边互不覆盖（#699 的核心语义）：改边框后背景那半边原样 ——
    const backgroundAfterBorder = await api(base, "GET", "/api/admin/equipment-backgrounds", { token });
    const backgroundsUnchanged = (backgroundAfterBorder.body?.data?.assignments ?? []).every(
      (row) => seedBackgroundByKey.get(comboKey(row)) === row.key,
    );
    check(backgroundsUnchanged, "改边框不动背景（背景 key 仍逐组合等于出厂值）");

    const playerForAppearance = await (async () => {
      const login = await api(base, "POST", "/api/auth/login", { body: { username: "cfgsnap_player", password: "pass1234" } });
      return login.body?.data?.token;
    })();
    const appearanceSnap = await api(base, "GET", "/api/game-config", { token: playerForAppearance });
    checkEqual(appearanceSnap.status, 200, "玩家拉快照");
    const appearanceSnapData = appearanceSnap.body?.data?.equipmentAppearance;
    check(Boolean(appearanceSnapData), "快照带 equipmentAppearance 段");
    checkEqual(appearanceSnapData?.borders?.[0]?.key, swapped[0].key, "快照里的边框 = 改过的值（客户端进图拿到的就是它）");
    checkEqual(appearanceSnapData?.borders?.[0]?.effect?.x, 3, "快照里的 effect 随条目下发");
    checkEqual(appearanceSnapData?.customBorders?.length, 1, "快照里的自定义表随行");
    checkEqual(appearanceSnapData?.backgrounds?.[0]?.key, appearanceSeedRow.backgrounds[0].key, "快照里的背景 = 未动的出厂值（拆边语义对客户端同样成立）");

    // —— #739：玩家侧「每次进图重拉」的专用接口（效果是它唯一的新鲜来源）——
    const appearanceFresh = await api(base, "GET", "/api/game-config/equipment-appearance", { token: playerForAppearance });
    checkEqual(appearanceFresh.status, 200, "玩家侧能读到装备外观（每次进图重拉）");
    checkEqual(appearanceFresh.body?.data?.borders?.[0]?.effect?.x, 3, "接口里的 effect 是改过的值（不是出厂值）");
    checkEqual(
      appearanceFresh.body?.data?.borders?.length,
      appearanceSnapData?.borders?.length,
      "接口与快照段条数一致（同一份表的两种入口）",
    );
    checkEqual(appearanceFresh.body?.data?.customBorders?.length, 1, "接口带自定义表（客户端整段覆写要用）");
    const appearanceNoToken = await api(base, "GET", "/api/game-config/equipment-appearance");
    checkEqual(appearanceNoToken.status, 401, "外观接口需要令牌（与快照同口径）");

    // —— 背景半边也走一遍写路径（背景 key 形如 bg-16000，与边框的 border-30123 各占一套格式）——
    const backgroundOk = backgroundPage.assignments ?? [];
    const badBgKey = backgroundOk.slice();
    badBgKey[0] = { ...badBgKey[0], key: "border-30123" };
    const badBgKeyRes = await api(base, "PATCH", "/api/admin/equipment-backgrounds", { token, body: { assignments: badBgKey, customs: [] } });
    checkEqual(badBgKeyRes.status, 400, "背景 key 填了边框的 key → 400（两半 key 格式各自卡）");

    const bgSwapped = backgroundOk.slice();
    const bgTmp = bgSwapped[0].key;
    bgSwapped[0] = { ...bgSwapped[0], key: bgSwapped[14].key };
    bgSwapped[14] = { ...bgSwapped[14], key: bgTmp };
    const bgUpdateRes = await api(base, "PATCH", "/api/admin/equipment-backgrounds", { token, body: { assignments: bgSwapped, customs: [] } });
    checkEqual(bgUpdateRes.status, 200, "背景整边替换 → 200");
    const borderAfterBg = await api(base, "GET", "/api/admin/equipment-borders", { token });
    checkEqual(borderAfterBg.body?.data?.assignments?.[0]?.key, swapped[0].key, "改背景不动边框（反向同样成立）");

    // —— 还原 seed 前提（两半各自写回出厂值） ——
    const restoreBorders = await api(base, "PATCH", "/api/admin/equipment-borders", {
      token,
      body: { assignments: appearanceSeedRow.borders, customs: appearanceSeedRow.customBorders },
    });
    checkEqual(restoreBorders.status, 200, "还原边框半边出厂值（seed 前提复原）");
    const restoreBackgrounds = await api(base, "PATCH", "/api/admin/equipment-backgrounds", {
      token,
      body: { assignments: appearanceSeedRow.backgrounds, customs: appearanceSeedRow.customBackgrounds },
    });
    checkEqual(restoreBackgrounds.status, 200, "还原背景半边出厂值（seed 前提复原）");

    // —— 从文件夹同步（#716）：临时素材目录为准整批增删清单，被引用的也允许移除 ——
    group("二十二·补、从文件夹同步：以磁盘素材为准整批增删清单，effect 存活保留（#716）");

    const fsSync = require("node:fs");
    const nodePath = require("node:path");
    const bordersDir = appearanceBorderDir;

    // 目录坏了（这里把 effect/border/ 整个搬走模拟挂载缺失）→ 扫描 400
    fsSync.renameSync(bordersDir, `${bordersDir}.bak`);
    const missingDirRes = await api(base, "GET", "/api/admin/equipment-borders/resources", { token });
    checkEqual(missingDirRes.status, 400, "素材目录不存在 → 扫描 400（错误里带路径，排查挂载用）");
    fsSync.renameSync(`${bordersDir}.bak`, bordersDir);

    // 同步前先把清单摆成受控状态：99991 带 effect / 别名 / 分组、15 个出厂边框不带（覆盖掉前面小节残留在库里的零散条目）
    const seedEffectPreset = await api(base, "PATCH", "/api/admin/equipment-borders", {
      token,
      body: {
        assignments: borderOk.map((row) => ({ ...row })),
        customs: [],
        items: [{ key: "border-99991", effect: { x: 5, y: 0, scale: 2 }, name: "测试边框甲", group: "e2e组" }, ...borderOk.map((row) => ({ key: row.key }))],
      },
    });
    checkEqual(seedEffectPreset.status, 200, "预置清单：99991 带 effect / 别名 / 分组（同步不得冲掉）");

    // 别名 / 分组（#718）：写读一致、空串视同没填、超长 400
    const labelRoundTrip = await api(base, "PATCH", "/api/admin/equipment-borders", {
      token,
      body: {
        assignments: borderOk.map((row) => ({ ...row })),
        customs: [],
        items: [{ key: "border-99991", effect: { x: 5, y: 0, scale: 2 }, name: "  测试边框甲  ", group: "e2e组" }, ...borderOk.map((row) => ({ key: row.key }))],
      },
    });
    checkEqual(labelRoundTrip.status, 200, "别名 / 分组提交成功（别名带空白、分组非空）");
    const label99991 = (labelRoundTrip.body?.data?.items ?? []).find((row) => row.key === "border-99991");
    checkEqual(label99991?.name, "测试边框甲", "别名 trim 后落库（读出来不带空白）");
    checkEqual(label99991?.group, "e2e组", "分组原样落库");
    // 空串视同没填：再提交一次把两条标签全清掉，读出来字段干净
    const labelClear = await api(base, "PATCH", "/api/admin/equipment-borders", {
      token,
      body: {
        assignments: borderOk.map((row) => ({ ...row })),
        customs: [],
        items: [{ key: "border-99991", effect: { x: 5, y: 0, scale: 2 }, name: "", group: "" }, ...borderOk.map((row) => ({ key: row.key }))],
      },
    });
    checkEqual(labelClear.status, 200, "空串别名 / 分组提交成功（视同没填）");
    const cleared99991 = (labelClear.body?.data?.items ?? []).find((row) => row.key === "border-99991");
    checkEqual(cleared99991?.name, undefined, "空串别名不落库（字段干净）");
    checkEqual(cleared99991?.group, undefined, "空串分组不落库（字段干净）");
    // 摆回同步前提：99991 带 effect / 别名 / 分组
    const relabel = await api(base, "PATCH", "/api/admin/equipment-borders", {
      token,
      body: {
        assignments: borderOk.map((row) => ({ ...row })),
        customs: [],
        items: [{ key: "border-99991", effect: { x: 5, y: 0, scale: 2 }, name: "测试边框甲", group: "e2e组" }, ...borderOk.map((row) => ({ key: row.key }))],
      },
    });
    checkEqual(relabel.status, 200, "摆回同步前提：99991 带 effect / 别名 / 分组");
    const labelTooLong = await api(base, "PATCH", "/api/admin/equipment-borders", {
      token,
      body: {
        assignments: borderOk.map((row) => ({ ...row })),
        customs: [],
        items: [{ key: "border-99991", name: "字".repeat(33) }, ...borderOk.map((row) => ({ key: row.key }))],
      },
    });
    checkEqual(labelTooLong.status, 400, "别名超 32 字 → 400 且整边不落库");

    const borderScanRes = await api(base, "GET", "/api/admin/equipment-borders/resources", { token });
    checkEqual(borderScanRes.status, 200, "扫描边框资源文件夹");
    const borderScan = borderScanRes.body?.data ?? {};
    checkEqual(borderScan.dir, bordersDir, "扫描目录 = env 下的 effect/border");
    checkEqual(JSON.stringify(borderScan.keys), JSON.stringify(["border-99991", "border-99992"]), "keys = 成对素材按编号升序（缺 png 的 99994 被跳过）");
    checkEqual(JSON.stringify(borderScan.added), JSON.stringify(["border-99992"]), "added = 文件夹有清单没有（99991 已在受控清单里）");
    checkEqual(borderScan.removed?.length, 15, "removed = 清单里的 15 个出厂边框（文件夹里都没有）");
    checkEqual(borderScan.removedReferenced?.length, 15, "removedReferenced = 全部 15 个（都被棋盘引用着）");

    const borderSyncRes = await api(base, "POST", "/api/admin/equipment-borders/sync", { token });
    checkEqual(borderSyncRes.status, 201, "按文件夹同步边框清单");
    const borderSync = borderSyncRes.body?.data ?? {};
    checkEqual(borderSync.kept, 2, "同步后清单 = 文件夹里的 2 个素材");
    checkEqual(borderSync.added?.length, 1, "本次新增 1 条（99992）");
    checkEqual(borderSync.removed?.length, 15, "本次移除 15 条（文件夹里没有）");
    const borderAfterSync = await api(base, "GET", "/api/admin/equipment-borders", { token });
    const borderAfterSyncItems = borderAfterSync.body?.data?.items ?? [];
    const item99991 = borderAfterSyncItems.find((row) => row.key === "border-99991");
    checkEqual(item99991?.effect?.x, 5, "存活条目的 effect 原样保留（清单是效果的唯一来源）");
    checkEqual(item99991?.name, "测试边框甲", "存活条目的别名原样保留（#718：与 effect 同一待遇）");
    checkEqual(item99991?.group, "e2e组", "存活条目的分组原样保留");
    checkEqual(borderAfterSync.body?.data?.assignments?.length, 15, "棋盘不被同步动（15 格原样）");
    checkEqual(borderAfterSync.body?.data?.items?.length, 17, "GET 清单 = 2 个文件夹素材 + 15 个仍被引用的自动并入（引用处可见，待修复）");

    // 棋盘整体改指文件夹里的素材（15 组合都指 99991），绑定指 99992 —— 引用完整性校验照常放行
    const reassignToFolder = await api(base, "PATCH", "/api/admin/equipment-borders", {
      token,
      body: {
        assignments: borderOk.map((row) => ({ prefix: row.prefix, suffix: row.suffix, key: "border-99991" })),
        customs: [{ equipment: "weapon_20", key: "border-99992" }],
      },
    });
    checkEqual(reassignToFolder.status, 200, "棋盘 / 绑定改指文件夹素材");

    // 文件夹里删掉 99992 → 再同步：仍被绑定引用的条目也移除
    fsSync.rmSync(nodePath.join(bordersDir, "border-99992.plist"));
    fsSync.rmSync(nodePath.join(bordersDir, "border-99992.png"));
    const borderRescanRes = await api(base, "GET", "/api/admin/equipment-borders/resources", { token });
    checkEqual(JSON.stringify(borderRescanRes.body?.data?.removed), JSON.stringify(["border-99992"]), "文件删除后扫描标出 removed");
    checkEqual(JSON.stringify(borderRescanRes.body?.data?.removedReferenced), JSON.stringify(["border-99992"]), "removed 里的 99992 仍被绑定引用");
    const borderResyncRes = await api(base, "POST", "/api/admin/equipment-borders/sync", { token });
    checkEqual(borderResyncRes.status, 201, "删除文件后再同步");
    checkEqual(borderResyncRes.body?.data?.removedReferenced?.length, 1, "被引用也照样移除（#716 的分歧点：同步不受「被引用不可删」约束）");
    const borderResyncedItems = (await api(base, "GET", "/api/admin/equipment-borders", { token })).body?.data?.items ?? [];
    checkEqual(borderResyncedItems.length, 2, "清单 = 1 个文件夹素材 + 1 个仍被绑定引用的自动并入");
    check(borderResyncedItems.some((row) => row.key === "border-99992"), "被引用的 99992 读取时仍在清单里（引用处显示异常，运营可见）");

    // 空目录安全阀：目录在但素材被搬空（多半是挂载配错）→ 拒绝清空清单
    fsSync.mkdirSync(`${bordersDir}.empty`, { recursive: true });
    for (const name of fsSync.readdirSync(bordersDir)) fsSync.renameSync(nodePath.join(bordersDir, name), nodePath.join(`${bordersDir}.empty`, name));
    const emptyDirRes = await api(base, "POST", "/api/admin/equipment-borders/sync", { token });
    checkEqual(emptyDirRes.status, 400, "空目录 → 同步 400 且不落库");
    const borderAfterEmpty = await api(base, "GET", "/api/admin/equipment-borders", { token });
    check((borderAfterEmpty.body?.data?.items ?? []).length > 0, "400 之后清单原样（没有被清空）");
    for (const name of fsSync.readdirSync(`${bordersDir}.empty`)) fsSync.renameSync(nodePath.join(`${bordersDir}.empty`, name), nodePath.join(bordersDir, name));
    fsSync.rmdirSync(`${bordersDir}.empty`);

    // —— 背景半边同样走一遍（子目录 / key 格式不同） ——
    const bgSyncRes = await api(base, "POST", "/api/admin/equipment-backgrounds/sync", { token });
    checkEqual(bgSyncRes.status, 201, "按文件夹同步背景清单");
    checkEqual(bgSyncRes.body?.data?.kept, 1, "背景清单 = 文件夹里的 1 个素材");
    // 清单出厂为空，同步前 GET 里的条目全部来自「棋盘引用处自动并入」→ 移除条数 = 棋盘组合数
    checkEqual(bgSyncRes.body?.data?.removed?.length, appearanceSeedRow.backgrounds.length, "背景条目全部被移除（条数取快照棋盘，不锁数值）");
    const borderAfterBgSync = await api(base, "GET", "/api/admin/equipment-borders", { token });
    checkEqual(borderAfterBgSync.body?.data?.items?.length, 2, "同步背景不动边框清单（拆边语义在同步路径上同样成立）");

    // —— 还原：清单 / 棋盘 / 绑定写回出厂值 ——
    const restoreBorderSync = await api(base, "PATCH", "/api/admin/equipment-borders", {
      token,
      body: {
        assignments: appearanceSeedRow.borders,
        customs: appearanceSeedRow.customBorders,
        items: appearanceSeedRow.borders.map((row) => ({ key: row.key })),
      },
    });
    checkEqual(restoreBorderSync.status, 200, "还原边框清单 / 棋盘 / 绑定（seed 前提复原）");
    const restoreBgSync = await api(base, "PATCH", "/api/admin/equipment-backgrounds", {
      token,
      body: {
        assignments: appearanceSeedRow.backgrounds,
        customs: appearanceSeedRow.customBackgrounds,
        items: appearanceSeedRow.backgrounds.map((row) => ({ key: row.key })),
      },
    });
    checkEqual(restoreBgSync.status, 200, "还原背景清单 / 棋盘（seed 前提复原）");
    fsSync.rmSync(appearanceResTmp, { recursive: true, force: true });

    //#endregion

    //#region 二十三、变体重建（#697）：按当前倍率整批重算，卖价保留

    group("二十三、变体重建：按当前前后缀倍率整批重算，卖价保留原值");

    const metaRes = await api(base, "GET", "/api/admin/equipment-meta", { token });
    checkEqual(metaRes.status, 200, "装备规则（前后缀档位）可读");
    const metaBefore = metaRes.body?.data ?? {};

    const variantsTotalRes = await api(base, "GET", "/api/admin/equipment-variants?page=1&size=1", { token });
    const variantsTotalBefore = variantsTotalRes.body?.data?.total ?? 0;

    const baseRes = await api(base, "GET", "/api/admin/equipments?page=1&size=1&keyword=cloth_1", { token });
    const baseRow = baseRes.body?.data?.list?.[0];
    check(Boolean(baseRow), "锚点基础件 cloth_1 可读");
    const anchorRes = await api(base, "GET", "/api/admin/equipment-variants?page=1&size=1&keyword=cloth_1_p4s2", { token });
    const anchorBefore = anchorRes.body?.data?.list?.[0];
    check(Boolean(anchorBefore), "锚点变体 cloth_1_p4s2 可读");

    const rebuildRes = await api(base, "POST", "/api/admin/equipment-variants/rebuild", { token });
    checkEqual(rebuildRes.status, 201, "重建 → 201（POST 默认码）");
    const rebuild = rebuildRes.body?.data ?? {};
    checkEqual(rebuild.combos, metaBefore.prefixRates.length * metaBefore.suffixRates.length, "组合数 = 前缀档数 × 后缀档数");
    checkEqual(rebuild.variants, variantsTotalBefore, "同档数重建行数不变（幂等）");
    checkEqual(rebuild.bases, Math.round(variantsTotalBefore / rebuild.combos), "基础件数 = 行数 ÷ 组合数");

    // 展开口径：属性 = round(基础值 × 前缀倍率 × 后缀倍率)（#655 迁移同一口径）；名称 / 等级取基础件
    const anchorAfterRes = await api(base, "GET", "/api/admin/equipment-variants?page=1&size=1&keyword=cloth_1_p4s2", { token });
    const anchorAfter = anchorAfterRes.body?.data?.list?.[0];
    const rate = metaBefore.prefixRates[4] * metaBefore.suffixRates[2];
    checkEqual(anchorAfter?.attributes?.maxHp, Math.round(baseRow.attributes.maxHp * rate), "重建后 maxHp = round(基础 × 前缀倍率 × 后缀倍率)");
    checkEqual(anchorAfter?.label, baseRow.label, "重建后名称 = 基础件名（前后缀文案由客户端拼）");
    checkEqual(anchorAfter?.level, baseRow.level, "重建后穿戴等级 = 基础件等级");
    checkEqual(anchorAfter?.sellPrice, anchorBefore?.sellPrice, "重建后卖价保留原值（出厂价签来自已下架的回收价曲线，不可复算）");

    // —— 扩一档前缀（测试档 ×2）：档位定义变 6×3，重建后行数随之扩 ——
    const metaExpandRes = await api(base, "PATCH", "/api/admin/equipment-meta", {
      token,
      body: { prefixLabels: [...metaBefore.prefixLabels, "测试档"], prefixRates: [...metaBefore.prefixRates, 2] },
    });
    checkEqual(metaExpandRes.status, 200, "扩一档前缀（测试档 ×2）→ 200");

    const rebuildExpandRes = await api(base, "POST", "/api/admin/equipment-variants/rebuild", { token });
    checkEqual(rebuildExpandRes.status, 201, "扩档后重建 → 201");
    const basesCount = variantsTotalBefore / rebuild.combos;
    checkEqual(
      rebuildExpandRes.body?.data?.variants,
      variantsTotalBefore + basesCount * metaBefore.suffixRates.length,
      "扩档后行数 = 旧行数 + 基础件数 × 后缀档数（每个基础件多出一排新组合）",
    );

    const newComboRes = await api(base, "GET", "/api/admin/equipment-variants?page=1&size=1&keyword=cloth_1_p5s0", { token });
    const newCombo = newComboRes.body?.data?.list?.[0];
    check(Boolean(newCombo), "新组合变体 cloth_1_p5s0 已展开");
    checkEqual(newCombo?.attributes?.maxHp, Math.round(baseRow.attributes.maxHp * 2), "新组合属性 = round(基础 × 新档倍率)");
    checkEqual(newCombo?.sellPrice, Math.round(10 * baseRow.level * 2), "新组合卖价按公式垫底（round(10 × 等级 × 倍率)，之后可逐条调）");

    // —— 装备外观跟着档数自愈：库存的 15 条盖不住 18 组合 → 回落公式映射（18 条）——
    const appearanceExpandedRes = await api(base, "GET", "/api/admin/equipment-borders", { token });
    checkEqual(appearanceExpandedRes.body?.data?.assignments?.length, 18, "扩档后外观表回落公式映射（18 格全覆盖）");
    const appearanceComboSet = new Set((appearanceExpandedRes.body?.data?.assignments ?? []).map((row) => `${row.prefix}|${row.suffix}`));
    check(appearanceComboSet.has("5|0") && appearanceComboSet.has("5|2"), "新档组合（5|0、5|2）在外观表里");

    // —— 还原：档位写回出厂 + 重建 + 外观表回到库存 15 条 ——
    const metaRestoreRes = await api(base, "PATCH", "/api/admin/equipment-meta", {
      token,
      body: { prefixLabels: metaBefore.prefixLabels, prefixRates: metaBefore.prefixRates },
    });
    checkEqual(metaRestoreRes.status, 200, "档位还原出厂");
    const rebuildRestoreRes = await api(base, "POST", "/api/admin/equipment-variants/rebuild", { token });
    checkEqual(rebuildRestoreRes.body?.data?.variants, variantsTotalBefore, "还原后重建行数回到出厂");
    const appearanceRestoredRes = await api(base, "GET", "/api/admin/equipment-borders", { token });
    checkEqual(appearanceRestoredRes.body?.data?.assignments?.length, 15, "还原后外观表回到库存的 15 条（仍覆盖当前档数，不再回落）");

    //#endregion

    //#region 二十四、装备列表的变体件数 + 变体弹窗口径（#781）

    group("二十四、装备列表带 variantCount、变体按 baseId 取（弹窗口径）");

    // 整表把 variantCount 加起来 == 变体总行数：件数不是前端猜的、也不是写死的 15，
    // 而是 countByBaseIds 真查出来的（漏 join / 漏并发分页都会在这里露出来）
    let countedVariants = 0;
    let countedBases = 0;
    let countedPages = 0;
    for (let pageNo = 1; pageNo <= 20; pageNo++) {
      const listRes = await api(base, "GET", `/api/admin/equipments?page=${pageNo}&size=100`, { token });
      const rows = listRes.body?.data?.list ?? [];
      countedBases += rows.length;
      countedVariants += rows.reduce((sum, row) => sum + (row.variantCount ?? 0), 0);
      countedPages += 1;
      if (pageNo * 100 >= (listRes.body?.data?.total ?? 0)) break;
    }
    checkEqual(countedVariants, variantsTotalBefore, `各基础件的 variantCount 之和 = 变体总行数（${countedPages} 页 / ${countedBases} 件）`);
    checkEqual(countedBases, Math.round(variantsTotalBefore / rebuild.combos), "基础件件数 = 变体行数 ÷ 组合数");

    const oneBaseRes = await api(base, "GET", "/api/admin/equipments?keyword=cloth_1&page=1&size=10", { token });
    const oneBase = (oneBaseRes.body?.data?.list ?? []).find((row) => row.id === "cloth_1");
    checkEqual(oneBase?.variantCount, rebuild.combos, "单件装备报出的变体件数 = 组合数（出厂 15）");

    const modalVariantsRes = await api(base, "GET", "/api/admin/equipment-variants?baseId=cloth_1&page=1&size=100", { token });
    checkEqual(modalVariantsRes.status, 200, "变体弹窗按 baseId 取 → 200");
    const modalVariants = modalVariantsRes.body?.data?.list ?? [];
    checkEqual(modalVariants.length, rebuild.combos, "弹窗拿到的行数 = 列表上写的件数（同一口径，不是两套算法）");
    checkEqual(modalVariantsRes.body?.data?.total, rebuild.combos, "总数与当前页行数一致（一屏看完，不分页）");
    check(modalVariants.every((row) => row.baseId === "cloth_1"), "弹窗里每一行都属于这件基础件");

    const sortedVariantsRes = await api(base, "GET", "/api/admin/equipment-variants?baseId=cloth_1&sort=level&order=desc&page=1&size=100", { token });
    const sortedLevels = (sortedVariantsRes.body?.data?.list ?? []).map((row) => row.level);
    check(
      sortedLevels.length > 1 && sortedLevels.every((value, index) => index === 0 || sortedLevels[index - 1] >= value),
      "sort=level&order=desc 按等级降序（排序字段是服务端白名单，不是任凭拼 SQL）",
    );

    const ghostBaseRes = await api(base, "GET", "/api/admin/equipment-variants?baseId=not_a_real_base&page=1&size=10", { token });
    checkEqual(ghostBaseRes.body?.data?.total, 0, "基础件不存在 → 0 行（孤儿变体行不会在弹窗里露出来）");

    //#endregion
  } finally {
    server.kill();
  }

  console.log(`\n===== 养成配置 e2e：${passed} 通过 / ${failed} 失败 =====`);
  if (failed > 0) {
    failures.forEach((label) => console.log(`  ✗ ${label}`));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
