#!/usr/bin/env node
/**
 * 服务端 e2e：升级卷轴（#787）
 *
 * 卷轴是**第一条会改角色等级的道具**（药品改血蓝、货币道具改账本），
 * 所以这套测试钉的是三条线：
 *
 * 1. **等级只在服务端涨**：客户端只报「用哪一格」，区间与 +1 一律读库 ——
 *    同一个格子在不同等级下结果不同（999 级能用、1000 级被 20025 拒），改包跳不出区间。
 * 2. **区间是两个可改的列，不是写死的「每 1000 级」**：出厂切法（1~999 / 1000~1999 / …）
 *    只是给运营的默认值；管理端改一次区间，同一个格子下一次就按新区间判。
 * 3. **增删改真的接线**：新建 / 改区间 / 删除之后，列表、快照下发、使用结算全都跟着变；
 *    删掉配置行之后背包里那个旧格子变成「认不出的道具」（20024，不崩、不白升级）。
 *
 * 〇、出厂清单：快照里 7 卷，区间 `LvN = (N-1)×1000 ~ N×1000-1`，列表 / 快照 / 排序三处口径一致
 * 一、使用（999 → 1000）：等级 +1、经验原样、属性按新等级重算、血蓝补满、扣格子、revision+1
 * 二、区间：1000 级再用 Lv1 → 20025；换 Lv2 → 1001
 * 三、失败路径：空格 / 非卷轴道具 / 乐观锁落后 / 别人的角色 / 行号越界
 * 四、新建：只填区间派生 id / 名称 / 图标；撞 id → 50044；下限 > 上限 → 40000；怪区间照收
 * 五、改区间即时生效（同一个格子：放宽后能用、收回后 20025）
 * 六、等级上限：`roleMaxLevel` 那一级再用 → 20026
 * 七、删除：只删配置行，游戏里再用那个格子 → 20024；快照里也不再下发
 *
 * 走的是 `dist/`，所以前置是 `npm run build`。
 * 用法：npm run test:e2e:level-scroll
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/** 管理员注册码（管理端接口要它） */
const ADMIN_CODE = "e2e-level-scroll-admin";

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

/** 取一个空闲端口（避免与开发中的服务撞端口） */
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

/** 起一台服务（临时文件库） */
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
      JWT_SECRET: "e2e-level-scroll-secret",
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

/** 发一次请求，返回唯一包裹体（code / message / data） */
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

/** 背包里某物品的总数（按格子里的 count 累加） */
function countInBag(bag, goodId) {
  let total = 0;
  for (const line of bag || []) {
    for (const cell of line || []) {
      if (cell && cell.id === goodId) total += Math.max(0, Math.floor(cell.count) || 0);
    }
  }
  return total;
}

/** 背包某格（越界返回 undefined，便于断言「确实是空的」） */
function cellAt(bag, row, col) {
  return (bag || [])[row] ? bag[row][col] : undefined;
}

/** 注册并登录一个管理员（配置读写要 `gameConfig:*`） */
async function registerAdmin(baseUrl, username, password) {
  await api(baseUrl, "POST", "admin/auth/register", { body: { username, password, registerCode: ADMIN_CODE } });
  const login = await api(baseUrl, "POST", "admin/auth/login", { body: { username, password } });
  return login.data && login.data.token;
}

/** 出厂值来源：配置快照（库里权威，快照是它的逐行投影） */
const snap = require("./lib/config-snapshot.cjs");
const SEED_SCROLLS = snap.rows("level_scrolls");
const SEED_SCROLL_BY_ID = snap.index("level_scrolls");
/** 等级上限来自 `growth_scalars`（不写死 100 万 —— 运营随时会调） */
const CAP_LEVEL = Math.max(1, Math.floor(Number(snap.index("growth_scalars", "key").roleMaxLevel.value) || 1));

/** 找一条出厂行（按卷号） */
function seedOf(index) {
  const row = SEED_SCROLL_BY_ID[`level_scroll_${index}`];
  if (!row) throw new Error(`快照里没有 level_scroll_${index}`);
  return row;
}

const LV1 = seedOf(1);
const LV2 = seedOf(2);

/** 出厂切法的区间（1~999 / 1000~1999 / …） */
const expectedRangeOf = (index) => ({
  min: index === 1 ? 1 : (index - 1) * 1000,
  max: index * 1000 - 1,
});

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-level-scroll-${Date.now()}.db`);
  const server = await startServer(dbPath);
  let serverChild = null;
  try {
    const { baseUrl } = server;
    serverChild = server.child;

    //#region 〇、准备

    group("准备：玩家 / 角色 / 管理员");
    const registered = await api(baseUrl, "POST", "auth/register", { body: { username: "scroll_player", password: "pass1234" } });
    const token = registered.data && registered.data.token;
    const created = await api(baseUrl, "POST", "roles", { token, body: { name: "卷宗", occupation: "1", sex: "1" } });
    const roleId = created.data && created.data.id;
    check(created.code === 0 && created.data.online === true, "准备：角色已创建并自动在线", created.message);
    const adminToken = await registerAdmin(baseUrl, "scroll_admin", "Admin#123456");
    check(!!adminToken, "准备：管理员已登录");

    const other = await api(baseUrl, "POST", "auth/register", { body: { username: "scroll_other", password: "pass1234" } });
    const otherToken = other.data && other.data.token;

    /**
     * 造背包：管理端整份覆盖（客户端改不了 bag，造状态只能走这条路）
     *
     * ⚠ `applyBagCells` 是**从空格子重建**：每调一次，上一次塞的格子全没了。
     * 所以要同时验两个格子（比如「A 被拒之后 A 还在、B 也能用」）必须一次塞齐。
     */
    const seedBag = async (cells) => {
      const result = await api(baseUrl, "PATCH", `admin/roles/${roleId}`, { token: adminToken, body: { bag: cells } });
      check(result.code === 0, `准备：管理端注入 ${cells.length} 格物品`, result.message);
      return result;
    };

    /** 把角色摆到某级（卷轴的判定全看等级，e2e 里只能从管理端摆位） */
    const patchRole = async (body) => {
      const result = await api(baseUrl, "PATCH", `admin/roles/${roleId}`, { token: adminToken, body });
      check(result.code === 0, `准备：管理端改角色 ${JSON.stringify(body)}`, result.message);
      return result;
    };

    /** 读角色当前状态（等级 / 经验 / 血蓝 / 背包 / revision） */
    const readRole = async () => (await api(baseUrl, "GET", `roles/${roleId}`, { token })).data;

    //#endregion

    //#region 一、出厂清单

    group("一、出厂清单与列表口径");
    checkEqual(SEED_SCROLLS.length, 7, "快照里出厂 7 卷");
    let rangeOk = true;
    for (let index = 1; index <= 7; index += 1) {
      const row = SEED_SCROLL_BY_ID[`level_scroll_${index}`];
      const expected = expectedRangeOf(index);
      if (!row || Number(row.minLevel) !== expected.min || Number(row.maxLevel) !== expected.max) rangeOk = false;
    }
    check(rangeOk, "区间切法 = LvN 的 (N-1)×1000 ~ N×1000-1（Lv1 = 1~999、Lv7 = 6000~6999）");
    checkEqual(Number(LV2.minLevel), 1000, "Lv2 的起点正好是 Lv1 用完之后的那一级（1000）");

    const listed = await api(baseUrl, "GET", "admin/level-scrolls?page=1&size=100", { token: adminToken });
    checkEqual(listed.code, 0, "管理端能读升级卷轴列表", listed.message);
    checkEqual(listed.data.total, SEED_SCROLLS.length, "列表总数与快照行数一致");
    checkEqual(listed.data.list[0].id, "level_scroll_1", "列表按等级下限升序（第一卷在最前）");
    checkEqual(listed.data.list[0].label, SEED_SCROLL_BY_ID.level_scroll_1.label, "名称取自库（不是代码里另写一份）");
    checkEqual(listed.data.list[0].icon, SEED_SCROLL_BY_ID.level_scroll_1.icon, "图标路径取自库");
    const keywordHit = await api(baseUrl, "GET", "admin/level-scrolls?page=1&size=100&keyword=level_scroll_1", {
      token: adminToken,
    });
    checkEqual(keywordHit.data.total, 1, "关键字精确匹配 id（level_scroll_1 只命中一卷，不是前缀模糊到 1/2…）");
    // 管理端「按最高档续开一卷」靠这条取全表最高档（不从当前页凑 —— 卷轴能开到上万卷）
    const top = await api(baseUrl, "GET", "admin/level-scrolls?page=1&size=1&sort=minLevel&order=desc", {
      token: adminToken,
    });
    checkEqual(top.code, 0, "支持 size=1 + 指定排序（排序键在白名单里）", top.message);
    checkEqual(top.data.list.length, 1, "只回一行");
    checkEqual(top.data.list[0].id, "level_scroll_7", "取到的是最高档 Lv7");
    checkEqual(top.data.list[0].maxLevel, 6999, "最高档上限 = 6999（下一卷从 7000 起）");

    const snapshot = await api(baseUrl, "GET", "game-config", { token });
    checkEqual(snapshot.code, 0, "客户端能拉配置快照", snapshot.message);
    checkEqual((snapshot.data.levelScrolls || []).length, SEED_SCROLLS.length, "快照里下发同样 7 卷（客户端按它建物品索引）");
    const snapshotLv1 = (snapshot.data.levelScrolls || []).find((item) => item.id === LV1.id);
    check(!!snapshotLv1, "快照里能找到 Lv1");
    checkEqual(snapshotLv1 && snapshotLv1.minLevel, LV1.minLevel, "快照里的等级下限与库一致");
    checkEqual(snapshotLv1 && snapshotLv1.maxLevel, LV1.maxLevel, "快照里的等级上限与库一致");

    //#endregion

    //#region 二、使用：999 → 1000

    group("二、使用（999 级用 Lv1 → 1000 级）");
    await seedBag([{ row: 0, col: 0, id: LV1.id, count: 3 }]);
    await patchRole({ level: 999, exp: 777 });
    const before = await readRole();
    checkEqual(before.level, 999, "角色已摆到 999 级");
    checkEqual(Number(before.data.exp), 777, "经验已摆成 777（便于验证卷轴不扣经验）");

    const used = await api(baseUrl, "POST", `roles/${roleId}/level-scroll-use`, { token, body: { row: 0, col: 0 } });
    checkEqual(used.code, 0, "使用一个 Lv1 卷轴", used.message);
    checkEqual(used.data.itemId, LV1.id, "响应带回用的是哪一卷");
    checkEqual(used.data.fromLevel, 999, "fromLevel = 使用前等级");
    checkEqual(used.data.toLevel, 1000, "toLevel = 1000（硬性 +1，不看经验够不够）");
    checkEqual(used.data.level, 1000, "角色等级列同步到 1000（等级的唯一来源就是这一列，与击杀升级同一纪律）");
    checkEqual(Number(used.data.exp), 777, "经验原样保留（卷轴不消耗经验）");
    checkEqual(Number(used.data.data.exp), 777, "存档里的 exp 也没被动过");
    check(Number(used.data.expNeed) > 0, "带回「升到下一级所需经验」（客户端进度条用）", String(used.data.expNeed));
    check(
      Number(used.data.data.maxHp) > 0 && Number(used.data.data.maxHp) !== Number(before.data.maxHp),
      "属性按新等级重算（血上限换成 1000 级的权威值，不再是客户端上报的旧值）",
      `${before.data.maxHp} → ${used.data.data.maxHp}`,
    );
    checkEqual(Number(used.data.data.hp), Number(used.data.data.maxHp), "升级惯例：血量补满到新上限");
    checkEqual(Number(used.data.data.mp), Number(used.data.data.maxMp), "蓝量同样补满");
    checkEqual((cellAt(used.data.data.bag, 0, 0) || {}).count, 2, "背包那一格从 3 个变成 2 个");
    checkEqual(used.data.revision, before.revision + 1, "revision +1（客户端据此做乐观锁）");

    //#endregion

    //#region 三、区间：同一格在 1000 级就用不了了

    group("三、等级区间（用完就该换卷了）");
    const wrongRange = await api(baseUrl, "POST", `roles/${roleId}/level-scroll-use`, { token, body: { row: 0, col: 0 } });
    checkEqual(wrongRange.code, 20025, "1000 级再用 Lv1 → 20025（等级不在区间内）");
    check(
      typeof wrongRange.message === "string" && wrongRange.message.includes(LV1.label),
      "提示里带上卷轴名（运营/玩家都能看懂该换哪一卷）",
      wrongRange.message,
    );
    const afterWrong = await readRole();
    checkEqual(afterWrong.level, 1000, "被拒之后等级没变");
    checkEqual(countInBag(afterWrong.data.bag, LV1.id), 2, "被拒之后卷轴还在包里（没被吞掉）");

    await seedBag([{ row: 0, col: 1, id: LV2.id, count: 1 }]);
    const useLv2 = await api(baseUrl, "POST", `roles/${roleId}/level-scroll-use`, { token, body: { row: 0, col: 1 } });
    checkEqual(useLv2.code, 0, "换成 Lv2 就能用了", useLv2.message);
    checkEqual(useLv2.data.fromLevel, 1000, "fromLevel = 1000");
    checkEqual(useLv2.data.toLevel, 1001, "toLevel = 1001");
    check(
      Number(useLv2.data.data.maxHp) > Number(used.data.data.maxHp),
      "每升一级属性都跟着涨（1000 → 1001 的血上限严格变大）",
      `${used.data.data.maxHp} → ${useLv2.data.data.maxHp}`,
    );
    checkEqual(cellAt(useLv2.data.data.bag, 0, 1), null, "用光后那一格清空");

    //#endregion

    //#region 四、失败路径

    group("四、失败路径（都不许升级）");
    const emptyCell = await api(baseUrl, "POST", `roles/${roleId}/level-scroll-use`, { token, body: { row: 5, col: 5 } });
    checkEqual(emptyCell.code, 20024, "空格子 → 20024");
    await seedBag([
      { row: 0, col: 0, id: LV1.id, count: 2 },
      { row: 0, col: 2, id: "drug_hp_1", count: 1 },
    ]);
    const notScroll = await api(baseUrl, "POST", `roles/${roleId}/level-scroll-use`, { token, body: { row: 0, col: 2 } });
    checkEqual(notScroll.code, 20024, "格子里是药品 → 20024（不是卷轴就不给升级）");
    const afterNotScroll = await readRole();
    checkEqual(afterNotScroll.level, 1001, "被拒之后一级都没涨");
    checkEqual(countInBag(afterNotScroll.data.bag, "drug_hp_1"), 1, "被拒之后那瓶药还在包里");

    const stale = await api(baseUrl, "POST", `roles/${roleId}/level-scroll-use`, {
      token,
      body: { row: 0, col: 0, revision: afterNotScroll.revision - 1 },
    });
    checkEqual(stale.code, 20006, "revision 落后 → 20006（乐观锁）");
    const foreign = await api(baseUrl, "POST", `roles/${roleId}/level-scroll-use`, { token: otherToken, body: { row: 0, col: 0 } });
    checkEqual(foreign.code, 40300, "别人的角色 → 40300");
    const outOfRange = await api(baseUrl, "POST", `roles/${roleId}/level-scroll-use`, { token, body: { row: 100, col: 0 } });
    checkEqual(outOfRange.code, 40000, "行号越界 → 40000（DTO 上界拦截，不进业务）");

    //#endregion

    //#region 五、新建

    group("五、新建（只填等级区间）");
    const createdNext = await api(baseUrl, "POST", "admin/level-scrolls", {
      token: adminToken,
      body: { minLevel: 7000, maxLevel: 7999 },
    });
    checkEqual(createdNext.code, 0, "只填区间就能建", createdNext.message);
    checkEqual(createdNext.data.id, "level_scroll_8", "区间落在出厂切法上 → id 按卷号派生");
    checkEqual(createdNext.data.label, "升级卷轴 Lv8", "名称同样按卷号派生");
    checkEqual(createdNext.data.icon, LV1.icon, "图标缺省与出厂同一张（运营可以逐卷换图）");
    checkEqual(createdNext.data.maxStack, 999, "叠加上限缺省 999");
    checkEqual(createdNext.data.sellPrice, 0, "售价缺省 0（不可出售）");

    const duplicate = await api(baseUrl, "POST", "admin/level-scrolls", {
      token: adminToken,
      body: { minLevel: 7000, maxLevel: 7999 },
    });
    checkEqual(duplicate.code, 50044, "同区间再建一次 → 50044（派生的 id 撞了）");
    const reversed = await api(baseUrl, "POST", "admin/level-scrolls", {
      token: adminToken,
      body: { minLevel: 3000, maxLevel: 2000 },
    });
    checkEqual(reversed.code, 40000, "下限 > 上限 → 40000（参数校验）");
    const badId = await api(baseUrl, "POST", "admin/level-scrolls", {
      token: adminToken,
      body: { id: "Scroll-BAD", minLevel: 8000, maxLevel: 8999 },
    });
    checkEqual(badId.code, 40000, "id 大写 / 连字符 → 40000（只许小写字母数字下划线）");

    const custom = await api(baseUrl, "POST", "admin/level-scrolls", {
      token: adminToken,
      body: { minLevel: 500, maxLevel: 800, label: "残缺卷轴" },
    });
    checkEqual(custom.code, 0, "区间不按 1000 切也能建（运营可以开怪卷）", custom.message);
    checkEqual(custom.data.id, "level_scroll_500_800", "非标准区间 → id 用「下限_上限」");
    checkEqual(custom.data.label, "残缺卷轴", "指定了名称就用指定的");

    const listAfterCreate = await api(baseUrl, "GET", "admin/level-scrolls?page=1&size=100", { token: adminToken });
    checkEqual(listAfterCreate.data.total, SEED_SCROLLS.length + 2, "列表多了两条（Lv8 + 怪卷）");
    const minLevels = listAfterCreate.data.list.map((item) => Number(item.minLevel));
    check(
      minLevels.every((value, index) => index === 0 || minLevels[index - 1] <= value),
      "列表仍按下限升序（怪卷 500 排到 Lv1 前面）",
      minLevels.join(","),
    );
    const topAfterCreate = await api(baseUrl, "GET", "admin/level-scrolls?page=1&size=1&sort=minLevel&order=desc", {
      token: adminToken,
    });
    checkEqual(topAfterCreate.data.list[0].id, "level_scroll_8", "新建的 Lv8 成了全表最高档（「续开」下一次从 8000 起）");

    //#endregion

    //#region 六、改区间即时生效

    group("六、改区间即时生效（同一个格子按新区间判）");
    await seedBag([{ row: 0, col: 3, id: "level_scroll_8", count: 1 }]);
    const levelNow = (await readRole()).level;
    const beforePatch8 = await api(baseUrl, "POST", `roles/${roleId}/level-scroll-use`, { token, body: { row: 0, col: 3 } });
    checkEqual(beforePatch8.code, 20025, `当前 ${levelNow} 级用 Lv8（7000~7999）→ 20025`);
    const patched8 = await api(baseUrl, "PATCH", "admin/level-scrolls/level_scroll_8", {
      token: adminToken,
      body: { minLevel: 1000, maxLevel: 1999 },
    });
    checkEqual(patched8.code, 0, "把 Lv8 的区间改到 1000~1999", patched8.message);
    checkEqual(Number(patched8.data.minLevel), 1000, "改完的下限立即回显");
    const useAfterPatch = await api(baseUrl, "POST", `roles/${roleId}/level-scroll-use`, { token, body: { row: 0, col: 3 } });
    checkEqual(useAfterPatch.code, 0, "同一个格子再点就能用了（区间读库，不用重启）", useAfterPatch.message);
    checkEqual(useAfterPatch.data.toLevel, levelNow + 1, "等级 +1");

    await seedBag([{ row: 0, col: 4, id: "level_scroll_8", count: 2 }]);
    const patched8Back = await api(baseUrl, "PATCH", "admin/level-scrolls/level_scroll_8", {
      token: adminToken,
      body: { minLevel: 7000, maxLevel: 7999 },
    });
    checkEqual(patched8Back.code, 0, "把区间改回去（7000~7999）", patched8Back.message);
    const useAfterPatchBack = await api(baseUrl, "POST", `roles/${roleId}/level-scroll-use`, { token, body: { row: 0, col: 4 } });
    checkEqual(useAfterPatchBack.code, 20025, "改回去之后立刻又用不了 → 20025");
    const patchReversed = await api(baseUrl, "PATCH", "admin/level-scrolls/level_scroll_8", {
      token: adminToken,
      body: { minLevel: 9000 },
    });
    checkEqual(patchReversed.code, 40000, "只改下限把区间改反 → 40000（按合成后的结果校验）");
    const patchMissing = await api(baseUrl, "PATCH", "admin/level-scrolls/level_scroll_not_exists", {
      token: adminToken,
      body: { minLevel: 1 },
    });
    checkEqual(patchMissing.code, 50043, "改不存在的行 → 50043");

    //#endregion

    //#region 七、等级上限

    group("七、到了等级上限就不给升（20026）");
    const capScrollId = "level_scroll_1_" + CAP_LEVEL;
    const capScroll = await api(baseUrl, "POST", "admin/level-scrolls", {
      token: adminToken,
      body: { minLevel: 1, maxLevel: CAP_LEVEL, label: "通天卷轴" },
    });
    checkEqual(capScroll.code, 0, "建一卷覆盖到等级上限的（minLevel 1 ~ roleMaxLevel）", capScroll.message);
    checkEqual(capScroll.data.id, capScrollId, "id 用「下限_上限」派生（区间不在出厂切法上）");
    // 管理端注入是**整份覆盖**（applyBagCells 从空格子重建）：第六节那格 Lv8 要跟通天卷轴一起再塞一遍
    await seedBag([
      { row: 0, col: 4, id: "level_scroll_8", count: 2 },
      { row: 0, col: 5, id: capScrollId, count: 1 },
    ]);
    await patchRole({ level: CAP_LEVEL });
    checkEqual((await readRole()).level, CAP_LEVEL, `角色已摆到等级上限（${CAP_LEVEL}）`);
    const atCap = await api(baseUrl, "POST", `roles/${roleId}/level-scroll-use`, { token, body: { row: 0, col: 5 } });
    checkEqual(atCap.code, 20026, "在等级上限再用 → 20026（与「换一卷」不是同一件事）");
    checkEqual(countInBag((await readRole()).data.bag, capScrollId), 1, "被拒之后卷轴还在包里");

    //#endregion

    //#region 八、删除

    group("八、删除（只删配置，不碰存档）");
    const removed = await api(baseUrl, "DELETE", "admin/level-scrolls/level_scroll_8", { token: adminToken });
    checkEqual(removed.code, 0, "删掉 Lv8", removed.message);
    checkEqual(Number(removed.data.removed), 1, "实际删了 1 行");
    const removeAgain = await api(baseUrl, "DELETE", "admin/level-scrolls/level_scroll_8", { token: adminToken });
    checkEqual(removeAgain.code, 50043, "再删一次 → 50043（已经没了）");
    const useRemoved = await api(baseUrl, "POST", `roles/${roleId}/level-scroll-use`, { token, body: { row: 0, col: 4 } });
    checkEqual(useRemoved.code, 20024, "配置删了之后再用那个格子 → 20024（不白升级）");
    checkEqual(countInBag((await readRole()).data.bag, "level_scroll_8"), 2, "那格东西还在（没被吞掉）");
    const snapshotAfter = await api(baseUrl, "GET", "game-config", { token });
    const ids = (snapshotAfter.data.levelScrolls || []).map((item) => item.id);
    check(!ids.includes("level_scroll_8"), "快照里不再下发被删的那卷（客户端索引里它就消失了）");
    check(ids.includes("level_scroll_500_800"), "怪卷照样下发");
    check(ids.includes(capScrollId), "通天卷轴照样下发");

    //#endregion

    if (failed > 0) {
      console.log(`\n❌ 升级卷轴 e2e：${failed} 项断言不通过`);
      failures.forEach((label) => console.log(`  - ${label}`));
      console.log("\n服务端日志尾部：");
      console.log(server.logs().split("\n").slice(-30).join("\n"));
      process.exitCode = 1;
    } else {
      console.log(`\n✓ 升级卷轴 e2e 全部通过（${passed} 项断言）`);
    }
  } finally {
    if (serverChild) serverChild.kill("SIGTERM");
    await sleep(300);
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* 临时库随缘清理 */
    }
  }
})();
