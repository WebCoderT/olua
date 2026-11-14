#!/usr/bin/env node
/**
 * 服务端 e2e：装备穿戴的职业 / 性别限制（#838 / docs/37 G4）
 *
 * ===========================================================================
 * 这一套盯的是什么
 * ===========================================================================
 * `equipments` 表从建库起就有 `occupation` / `sex` 两列（出厂 685 行全是 `4` / `3` = 不限），
 * 客户端也一直拿配置快照在 `GameHelper.getEquipmentRejectReason` 里做预检 —— 但**服务端
 * 只校验了等级**。也就是说改包（或者任何跳过客户端预检的路）就能让战士穿上法师专属装备。
 *
 * 这一套把「穿戴规则」钉在服务端：判据的唯一副本是 `roles/equip-rules.ts` 的
 * `equipRefusalOf`，`bagOp` 的 `equip` 分支调它。分十段：
 *
 * 一、**出厂口径**：武器 20 行全是 `occupation=4` / `sex=3`，于是「现状一件都不拦」（基线）
 * 二、**等级优先于性别与职业**：1 级战士穿 10 级法师女装，先报「需要等级 10」
 * 三、**等级满足后才轮到性别**（同一个角色提级再穿，报「女角色才能穿戴」）
 * 四、**职业**：性别放开后报「职业不符，只有魔法师…」；改成 `4` 立刻穿得上
 * 五、**性别**：男角色穿女装被拒；改回 `1` 立刻穿得上
 * 六、**配置是现读的**：穿着时把该件改成女装 → 卸下照样成功（卸下不校验），再穿就被拒
 * 七、**变体跟着基础件**：`cloth_1` 改成法师装，`cloth_1_p1s1` 一起穿不上（变体没有自己的职业列）
 * 八、**空值不误伤**：直写库把两列清空（只有手改库能造出来）→ 按「不限制」放行
 * 九、**非装备仍走原口径**：材料 id 进背包去穿 → 20021
 * 十、**角色侧读库**：管理端把角色改成女性 → 男装立刻穿不上（判据不吃存档里的旧值）
 *
 * ===========================================================================
 * 明确不测的部分
 * ===========================================================================
 * - **双手武器 / 副手互斥**：issue 原文的第二条验收。本作**没有副手槽**（用户口径
 *   2026-11-11「没有副手，以后也不会有」），`hand_type` 一并暂时放置，重开条件见
 *   `docs/37` G4。这一段在 issue 里已按实测收窄。
 * - **客户端预检**：用户 2026-11-12 口径「不补」。客户端那份只做等级 / 性别 / 职业的
 *   提前提示（本来就有），本套全部直连 API —— 等于「改包跳过预检」也拦得住。
 *
 * 文案只断**关键词**（`需要等级 10` / `女角色才能穿戴` / `职业不符`），不锁整句：
 * 运营改文案不该让门禁变红（与「锁格式与行为，不锁数值」同一条纪律）。
 *
 * 走的是 `dist/`，所以前置是 `npm run build`。用法：npm run test:e2e:equip-rules
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const ADMIN_CODE = "test-admin-code";

//#region 断言小工具

let passed = 0;
let failed = 0;
const failures = [];

function check(ok, label, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  [OK] ${label}${detail ? ` —— ${detail}` : ""}`);
    return true;
  }
  failed += 1;
  failures.push(label);
  console.log(`  [!!] ${label}${detail ? ` —— ${detail}` : ""}`);
  return false;
}

const checkEqual = (actual, expected, label) =>
  check(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);

function group(title) {
  console.log(`\n▶ ${title}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

//#endregion

/** 打开临时库做一件事（`busy_timeout` 让这次写等服务端放锁，避免 CI 上偶发 locked） */
function withDb(dbPath, run) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    return run(db);
  } finally {
    db.close();
  }
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
      ADMIN_REGISTER_CODE: ADMIN_CODE,
      JWT_SECRET: "e2e-equip-rules-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
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
  try {
    return { ...(await response.json()), status: response.status };
  } catch {
    return null;
  }
}

/**
 * 开局塞进背包的四件东西（#597 起建号背包为空，造状态只能走管理端 PATCH）
 *
 * · (0,0) cloth_1        1 级衣服：两边都不限的基线
 * · (0,1) cloth_10       10 级衣服：等级优先 / 职业两段都用它
 * · (0,2) helmet_1       1 级头盔：性别一段用它
 * · (0,3) cloth_1_p1s1   cloth_1 的变体：验「变体跟着基础件」
 * · (1,0) material_hide  材料：非装备仍走原口径
 */
const BAG_SEED_CELLS = [
  { row: 0, col: 0, id: "cloth_1", count: 1 },
  { row: 0, col: 1, id: "cloth_10", count: 1 },
  { row: 0, col: 2, id: "helmet_1", count: 1 },
  { row: 0, col: 3, id: "cloth_1_p1s1", count: 1 },
  { row: 1, col: 0, id: "material_hide", count: 2 },
];

/** 背包五格里的东西（断言「还在包里 / 已经离包」一律按 id 找，不按坐标） */

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-equip-rules-${Date.now()}.db`);
  const server = await startServer(dbPath);
  try {
    const { baseUrl } = server;

    //#region 〇、准备

    group("准备：管理员 / 战士角色 / 背包里的五格东西");
    const superAdmin = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "gm_equip", password: "pass1234", registerCode: ADMIN_CODE },
    });
    const adminToken = superAdmin.data && superAdmin.data.token;
    check(superAdmin.code === 0 && !!adminToken, "准备：注册管理员拿到令牌", superAdmin.message);

    const registered = await api(baseUrl, "POST", "auth/register", {
      body: { username: "equip_player", password: "pass1234" },
    });
    const token = registered.data && registered.data.token;
    // 战士 · 男 —— 后面所有「该被拒」的装备都相对这个身份说话
    const created = await api(baseUrl, "POST", "roles", {
      token,
      body: { name: "穿装测试", occupation: "1", sex: "1" },
    });
    const roleId = created.data && created.data.id;
    check(!!(token && roleId), "准备：账号与角色已建好（战士 / 男）", created.message);

    const seeded = await api(baseUrl, "PATCH", `admin/roles/${roleId}`, { token: adminToken, zoneId: ADMIN_ZONE, body: { bag: BAG_SEED_CELLS } });
    check(seeded.code === 0, "准备：管理端把五格东西注入背包", seeded.message);

    /** 当前修订号（每次写接口都要带基线，#820） */
    const revOf = async () => {
      const detail = await api(baseUrl, "GET", `roles/${roleId}`, { token });
      return detail && detail.data && detail.data.revision;
    };
    /** 穿戴：返回服务端响应（失败时是 20021） */
    const equip = async (row, col) =>
      api(baseUrl, "POST", `roles/${roleId}/bag-op`, {
        token,
        body: { action: "equip", row, col, revision: await revOf() },
      });
    const unequip = async (slot) =>
      api(baseUrl, "POST", `roles/${roleId}/bag-op`, {
        token,
        body: { action: "unequip", slot, revision: await revOf() },
      });
    /** 改装备的两列（写操作会顺手重装结算层，改完下一次穿戴即生效） */
    const patchEquipment = (id, body) => api(baseUrl, "PATCH", `admin/equipments/${id}`, { token: adminToken, zoneId: ADMIN_ZONE, body });

    /**
     * 背包里某个 id 现在在哪一格（找不到返回 null）
     *
     * 为什么不写死坐标：穿戴 / 卸下会改变背包排布（`unequip` 落点是**第一个空格**），
     * 写死 (row,col) 的断言会在第二步就指向空格子 —— 那是断言自己错了，不是功能坏了。
     */
    const cellOf = async (id) => {
      const detail = await api(baseUrl, "GET", `roles/${roleId}`, { token });
      const bag = (detail.data && detail.data.data && detail.data.data.bag) || [];
      for (let row = 0; row < bag.length; row++) {
        for (let col = 0; col < (bag[row] || []).length; col++) {
          const cell = bag[row][col];
          if (cell && cell.id === id) return { row, col, cell };
        }
      }
      return null;
    };
    /** 按 id 穿戴（背包里没有 → 返回一个假响应，断言会老实地红） */
    const equipItem = async (id) => {
      const at = await cellOf(id);
      if (!at) return { code: -1, message: `背包里找不到 ${id}` };
      return equip(at.row, at.col);
    };

    //#endregion

    //#region 一、出厂口径：一件都不拦

    group("一、出厂口径（occupation=4 / sex=3 → 现状一件都不拦）");
    const weapons = await api(baseUrl, "GET", "admin/equipments?slot=weapon&page=1&size=100", { token: adminToken, zoneId: ADMIN_ZONE });
    const weaponRows = (weapons.data && weapons.data.list) || [];
    check(weaponRows.length > 0, "管理端能读到武器列表", `rows=${weaponRows.length}`);
    check(
      weaponRows.every((row) => row.occupation === "4" && row.sex === "3"),
      "出厂的武器全是「全职业 / 全性别」（所以改之前谁都能穿）",
      JSON.stringify(weaponRows.filter((row) => row.occupation !== "4" || row.sex !== "3").map((row) => row.id)),
    );

    const baseline = await equipItem("cloth_1");
    checkEqual(baseline.code, 0, "1 级战士穿上 1 级衣服（两边都不限）");
    checkEqual(baseline.data && baseline.data.slot, "cloth", "响应带回槽位（客户端据此刷新内观）");
    const baselineOff = await unequip("cloth");
    checkEqual(baselineOff.code, 0, "脱下来（基线闭环，后面每段都从空槽开始）");

    //#endregion

    //#region 二、等级优先于性别与职业

    group("二、等级优先（先报「需要等级」，不是「职业不符」）");
    const mageCloth = await patchEquipment("cloth_10", { occupation: "2", sex: "2" });
    checkEqual(mageCloth.code, 0, "把 10 级衣服改成「法师 · 女」专属");
    const revBefore = await revOf();
    const tooLow = await equipItem("cloth_10");
    checkEqual(tooLow.code, 20021, "1 级穿 10 级 → 20021（穿不上）");
    const lowMessage = (tooLow && tooLow.message) || "";
    check(lowMessage.includes("需要等级 10"), "理由先报等级（不是先报职业）", lowMessage);
    check(!lowMessage.includes("职业") && !lowMessage.includes("女角色"), "同一句里没有职业 / 性别的话（顺序对了）", lowMessage);
    checkEqual(await revOf(), revBefore, "被拒之后修订号没变（拒绝不落库）");

    // 提级到 10：等级这一项满足，就轮到性别说话
    const raised = await api(baseUrl, "PATCH", `admin/roles/${roleId}`, { token: adminToken, zoneId: ADMIN_ZONE, body: { level: 10 } });
    checkEqual(raised.code, 0, "管理端把角色提到 10 级");
    const wrongSex = await equipItem("cloth_10");
    checkEqual(wrongSex.code, 20021, "10 级战士穿「法师 · 女」→ 20021");
    check(((wrongSex && wrongSex.message) || "").includes("女角色才能穿戴"), "理由是性别（排在职业前面）", wrongSex.message);
    check(
      !((wrongSex && wrongSex.message) || "").includes("职业不符"),
      "还没轮到职业那一项（顺序：等级 → 性别 → 职业）",
      wrongSex.message,
    );

    //#endregion

    //#region 三、职业

    group("三、职业限制");
    const sexOpen = await patchEquipment("cloth_10", { sex: "3" });
    checkEqual(sexOpen.code, 0, "把性别放开成「全性别」");
    const wrongJob = await equipItem("cloth_10");
    checkEqual(wrongJob.code, 20021, "战士穿法师装 → 20021");
    check(((wrongJob && wrongJob.message) || "").includes("职业不符"), "理由是职业", wrongJob.message);
    check(((wrongJob && wrongJob.message) || "").includes("魔法师"), "理由里点名要哪个职业（玩家知道该换什么角色）", wrongJob.message);
    const stillThere = await cellOf("cloth_10");
    check(!!stillThere, "被拒之后那件还在包里", JSON.stringify(stillThere && stillThere.cell));

    const allJobs = await patchEquipment("cloth_10", { occupation: "4" });
    checkEqual(allJobs.code, 0, "把职业放开成「全职业」");
    const nowFits = await equipItem("cloth_10");
    checkEqual(nowFits.code, 0, "改完立刻穿得上（配置是现读的，不用重启）");
    checkEqual((nowFits.data.data.equipments.cloth || {}).id, "cloth_10", "槽位里换成了这件");
    check(!!(await cellOf("cloth_1")), "换下来的旧衣服还在包里（换装不吞装备）");
    await unequip("cloth");

    //#endregion

    //#region 四、性别

    group("四、性别限制");
    const girlyHelmet = await patchEquipment("helmet_1", { sex: "2" });
    checkEqual(girlyHelmet.code, 0, "把 1 级头盔改成「女」专属");
    const boyWear = await equipItem("helmet_1");
    checkEqual(boyWear.code, 20021, "男角色穿女装 → 20021");
    check(((boyWear && boyWear.message) || "").includes("女角色才能穿戴"), "理由是性别", boyWear.message);

    const boyHelmet = await patchEquipment("helmet_1", { sex: "1" });
    checkEqual(boyHelmet.code, 0, "改成「男」专属");
    const boyFits = await equipItem("helmet_1");
    checkEqual(boyFits.code, 0, "男角色穿男装 → 穿得上");
    checkEqual((boyFits.data.data.equipments.helmet || {}).id, "helmet_1", "槽位里是这顶头盔");

    //#endregion

    //#region 五、配置现读 + 卸下不校验

    group("五、配置现读（穿着时改配置）与卸下不校验");
    const turnedGirly = await patchEquipment("helmet_1", { sex: "2" });
    checkEqual(turnedGirly.code, 0, "头上戴着的头盔被改成「女」专属");
    const stillOn = await api(baseUrl, "GET", `roles/${roleId}`, { token });
    checkEqual((stillOn.data.data.equipments.helmet || {}).id, "helmet_1", "已经戴着的不会被追溯扒掉（不吃装备）");
    const offAgain = await unequip("helmet");
    checkEqual(offAgain.code, 0, "卸下照样成功（卸下不看限制，否则玩家会被锁死）");
    const reEquip = await equipItem("helmet_1");
    checkEqual(reEquip.code, 20021, "再穿就被拒（配置是现读的，不是启动时快照）");
    await patchEquipment("helmet_1", { sex: "1" });

    //#endregion

    //#region 六、变体跟着基础件

    group("六、变体取基础件的职业（cloth_1_p1s1 与 cloth_1 同一份限制）");
    const baseMage = await patchEquipment("cloth_1", { occupation: "2" });
    checkEqual(baseMage.code, 0, "把 cloth_1 改成法师装");
    const variantWear = await equipItem("cloth_1_p1s1");
    checkEqual(variantWear.code, 20021, "穿它的变体 cloth_1_p1s1 同样被拒（变体没有自己的职业列）");
    check(((variantWear && variantWear.message) || "").includes("职业不符"), "理由也是职业", variantWear.message);
    await patchEquipment("cloth_1", { occupation: "4" });
    const variantFits = await equipItem("cloth_1_p1s1");
    checkEqual(variantFits.code, 0, "改回全职业后变体也立刻穿得上");
    checkEqual((variantFits.data.data.equipments.cloth || {}).id, "cloth_1_p1s1", "槽位里是那件变体");
    await unequip("cloth");

    //#endregion

    //#region 七、空值不误伤

    group("七、两列被清空（手改库的脏数据）→ 按「不限制」放行");
    // 管理端 DTO 用枚举锁了取值，正常路径造不出空值 —— 只能直写库
    withDb(dbPath, (db) => {
      db.prepare("UPDATE equipments SET occupation = '', sex = '' WHERE id = 'cloth_1'").run();
    });
    // 任意一次配置写都会重装结算层（`touchRuntime`）；这里写回同值，只为触发重装
    await patchEquipment("helmet_1", { sex: "1" });
    const dirtyFit = await equipItem("cloth_1");
    checkEqual(dirtyFit.code, 0, "职业/性别为空的装备仍然穿得上（不替运营清理脏数据，也不误伤玩家）");
    await unequip("cloth");

    //#endregion

    //#region 八、非装备仍走原口径

    group("八、非装备 → 20021（既有口径没被改坏）");
    const notEquipment = await equipItem("material_hide");
    checkEqual(notEquipment.code, 20021, "材料进背包去穿 → 20021");
    check(((notEquipment && notEquipment.message) || "").includes("不是装备"), "理由说清楚是「不是装备」", notEquipment.message);

    //#endregion

    //#region 九、角色侧读库

    group("九、角色侧读库（判据不吃存档里的旧值）");
    const toGirl = await api(baseUrl, "PATCH", `admin/roles/${roleId}`, { token: adminToken, zoneId: ADMIN_ZONE, body: { sex: "2" } });
    checkEqual(toGirl.code, 0, "管理端把角色改成女性");
    const boyOnly = await equipItem("helmet_1");
    checkEqual(boyOnly.code, 20021, "女性穿「男」专属头盔 → 20021");
    check(((boyOnly && boyOnly.message) || "").includes("男角色才能穿戴"), "理由是性别（读的是角色表的 sex，不是存档）", boyOnly.message);
    await api(baseUrl, "PATCH", `admin/roles/${roleId}`, { token: adminToken, zoneId: ADMIN_ZONE, body: { sex: "1" } });
    const backToBoy = await equipItem("helmet_1");
    checkEqual(backToBoy.code, 0, "改回男性后立刻穿得上");

    //#endregion

    // 收尾：这一套自己改的配置自己还原（服装 4/3 出厂口径），别影响复跑
    await patchEquipment("cloth_1", { occupation: "4", sex: "3" });
    await patchEquipment("cloth_10", { occupation: "4", sex: "3" });
  } finally {
    server.child.kill();
    try {
      require("node:fs").rmSync(dbPath, { force: true });
    } catch {
      /* 临时库删不掉不影响结论 */
    }
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"} 装备穿戴规则：${passed} 条通过 / ${failed} 条失败`);
  if (failed > 0) {
    console.log("失败项：");
    for (const label of failures) console.log(`  - ${label}`);
  }
  process.exit(failed === 0 ? 0 : 1);
})();
