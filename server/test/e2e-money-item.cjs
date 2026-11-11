#!/usr/bin/env node
/**
 * 服务端 e2e：货币道具（#785）
 *
 * 这张表是**唯一可以增删改面的道具表**（装备 / 药品 / 物品的 id 清单是固定的），
 * 而且它直接往角色账本写钱 —— 所以这套测试钉的是两条线：
 *
 * 1. **数值只在服务端**：客户端只报「用哪一格」，面值与币种一律读库。改一次面值，
 *    同一个背包格子再点一次加的钱就变了（改包改不出钱）。
 * 2. **增删改真的接线**：管理端建 / 改 / 删之后，列表、快照下发、使用结算全都跟着变；
 *    删掉配置行之后背包里那个旧格子变成「认不出的道具」（20023，不崩、不白给）。
 *
 * 〇、出厂清单：快照里 8 条（唯一货币 bindGold × 8 档；#843/#844 收敛后只有一种），
 *     列表 / 快照 / 筛选三处口径一致
 * 一、使用入账：加钱、扣格子、revision+1；叠 2 个就点两次
 * 二、失败路径：空格 / 非货币道具 / 别人的角色 / 乐观锁落后 / 被踢
 * 三、新建：只填货币 + 面值，id / 名称 / 图标按派生规则生成；撞 id → 50042
 * 四、改名改面值：改完即时生效（同一个格子再点，加的是新面值）
 * 五、删除：只删配置行，游戏里再用那个格子 → 20023；快照里也不再下发
 *
 * 走的是 `dist/`，所以前置是 `npm run build`。
 * 用法：npm run test:e2e:money-item
 */
const { spawn } = require("node:child_process");
// 写角色接口的基线帮手（#820 / B62：revision 必填）
const { revOfWith } = require("./lib/role-save.cjs");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/** 管理员注册码（管理端接口要它） */
const ADMIN_CODE = "e2e-money-admin";

//#region 断言小工具（与 e2e-bag / e2e-sell 同款口径）

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
      JWT_SECRET: "e2e-money-secret",
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

/**
 * 取角色当前修订号（#820 / B62：写接口必须带基线，缺了就是 400 / 40000）
 *
 * 本文件的 api() 是「baseUrl 打头」的形态，所以这里也带上 baseUrl。
 */
const revOf = (baseUrl, roleId, token) =>
  revOfWith((method, route, options) => api(baseUrl, method, route, options), roleId, token);

/** 背包里某物品的总数（按 id 数格子） */
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
const SEED_MONEY = snap.rows("money_items");
const SEED_MONEY_BY_ID = snap.index("money_items");

/** 找一条出厂行（避免把面值写死在测试里 —— 运营随时可能改数） */
function seedOf(currency, amount) {
  const row = SEED_MONEY.find((item) => item.currency === currency && Number(item.amount) === amount);
  if (!row) throw new Error(`快照里没有 ${currency} ${amount} 这档面值`);
  return row;
}

const BIND_ROW = seedOf("bindGold", 100);
const BIND_ROW_50 = seedOf("bindGold", 50);

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-money-${Date.now()}.db`);
  const server = await startServer(dbPath);
  let serverChild = null;
  try {
    const { baseUrl } = server;
    serverChild = server.child;

    //#region 〇、准备

    group("准备：玩家 / 角色 / 管理员");
    const registered = await api(baseUrl, "POST", "auth/register", { body: { username: "money_player", password: "pass1234" } });
    const token = registered.data && registered.data.token;
    const created = await api(baseUrl, "POST", "roles", { token, body: { name: "钱袋", occupation: "1", sex: "1" } });
    const roleId = created.data && created.data.id;
    check(created.code === 0 && created.data.online === true, "准备：角色已创建并自动在线", created.message);
    const adminToken = await registerAdmin(baseUrl, "money_admin", "Admin#123456");
    check(!!adminToken, "准备：管理员已登录");

    const other = await api(baseUrl, "POST", "auth/register", { body: { username: "money_other", password: "pass1234" } });
    const otherToken = other.data && other.data.token;

    /** 造背包：管理端整份覆盖（客户端改不了 bag，造状态只能走这条路） */
    const seedBag = async (cells) => {
      const result = await api(baseUrl, "PATCH", `admin/roles/${roleId}`, { token: adminToken, body: { bag: cells } });
      check(result.code === 0, `准备：管理端注入 ${cells.length} 格物品`, result.message);
      return result;
    };

    //#endregion

    //#region 一、出厂清单：8 条 × 三处口径一致

    group("一、出厂清单与筛选");
    checkEqual(SEED_MONEY.length, 8, "快照里出厂 8 条（唯一货币 bindGold × 8 档面值）");
    const listed = await api(baseUrl, "GET", "admin/money-items?page=1&size=100", { token: adminToken });
    checkEqual(listed.code, 0, "管理端能读货币物品列表", listed.message);
    checkEqual(listed.data.total, SEED_MONEY.length, "列表总数与快照行数一致");
    const firstListed = listed.data.list[0];
    checkEqual(
      firstListed.label,
      SEED_MONEY_BY_ID[firstListed.id].label,
      "列表里第一条的名称取自库（不是代码里另写一份）",
    );
    const bindOnly = await api(baseUrl, "GET", "admin/money-items?page=1&size=100&currency=bindGold", { token: adminToken });
    checkEqual(bindOnly.data.total, 8, "按 currency=bindGold 筛出 8 条");
    check(
      bindOnly.data.list.every((item) => item.currency === "bindGold"),
      "筛选结果里没有别的币种",
      bindOnly.data.list.map((item) => item.currency).join(","),
    );
    const badCurrencyFilter = await api(baseUrl, "GET", "admin/money-items?page=1&size=100&currency=legacy", { token: adminToken });
    checkEqual(badCurrencyFilter.code, 40000, "未知币种筛 → 40000（取值域只有 bindGold）");
    const keywordHit = await api(baseUrl, "GET", "admin/money-items?page=1&size=100&keyword=money_bind_gold", { token: adminToken });
    checkEqual(keywordHit.data.total, 8, "关键字模糊匹配 id 前缀（money_bind_gold → 8 条）");
    const snapshot = await api(baseUrl, "GET", "game-config", { token });
    checkEqual(snapshot.code, 0, "客户端能拉配置快照", snapshot.message);
    checkEqual((snapshot.data.moneyItems || []).length, SEED_MONEY.length, "快照里下发同样 8 条（客户端按它建物品索引）");
    const snapshotBind = (snapshot.data.moneyItems || []).find((item) => item.id === BIND_ROW.id);
    check(!!snapshotBind, "快照里能找到绑定元宝那一档");
    checkEqual(Number(snapshotBind && snapshotBind.amount), Number(BIND_ROW.amount), "快照里的面值与库一致");

    //#endregion

    //#region 二、使用入账

    group("二、使用入账（加钱、扣格子）");
    await seedBag([{ row: 0, col: 0, id: BIND_ROW.id, count: 2 }]);
    const before = await api(baseUrl, "GET", `roles/${roleId}`, { token });
    const bindBefore = Math.max(0, Number(before.data.data.bindGold) || 0);
    const used = await api(baseUrl, "POST", `roles/${roleId}/money-use`, { token, body: { row: 0, col: 0, revision: await revOf(baseUrl, roleId, token) } });
    checkEqual(used.code, 0, "使用一个绑定元宝道具", used.message);
    checkEqual(used.data.currency, "bindGold", "响应带回入账的账本字段（唯一货币）");
    checkEqual(Number(used.data.amount), Number(BIND_ROW.amount), "入账金额 = 库里的面值");
    checkEqual(Number(used.data.balance), bindBefore + Number(BIND_ROW.amount), "余额 = 原有 + 面值");
    checkEqual(Number(used.data.data.bindGold), bindBefore + Number(BIND_ROW.amount), "角色存档里的 bindGold 同步加钱");
    checkEqual((cellAt(used.data.data.bag, 0, 0) || {}).count, 1, "背包那一格从 2 个变成 1 个");
    checkEqual(used.data.revision, before.data.revision + 1, "revision +1（客户端据此做乐观锁）");
    // 服务端冷却（#847）：同一个道具 1 秒内只能点一次 —— 先撞一下闸，再等过去
    const tooFast = await api(baseUrl, "POST", `roles/${roleId}/money-use`, { token, body: { row: 0, col: 0, revision: await revOf(baseUrl, roleId, token) } });
    checkEqual(tooFast.code, 20031, "紧接着再点同一个道具 → 20031 冷却中", tooFast.message);
    check(Number(tooFast.details && tooFast.details.remainingMs) > 0, "冷却回执带剩余毫秒（客户端据此灰按钮）");
    await sleep(1250);
    const usedAgain = await api(baseUrl, "POST", `roles/${roleId}/money-use`, { token, body: { row: 0, col: 0, revision: await revOf(baseUrl, roleId, token) } });
    checkEqual(usedAgain.code, 0, "等过冷却后再点一次（把手里的用光）", usedAgain.message);
    checkEqual(cellAt(usedAgain.data.data.bag, 0, 0), null, "用光后格子清空");
    checkEqual(
      Number(usedAgain.data.data.bindGold),
      bindBefore + Number(BIND_ROW.amount) * 2,
      "两次入账累加（没有漏记也没有双记）",
    );

    group("二·补：另一档面值照规矩走");
    await seedBag([{ row: 0, col: 1, id: BIND_ROW_50.id, count: 1 }]);
    const row50Use = await api(baseUrl, "POST", `roles/${roleId}/money-use`, { token, body: { row: 0, col: 1, revision: await revOf(baseUrl, roleId, token) } });
    checkEqual(row50Use.code, 0, "使用 50 档的绑定元宝道具", row50Use.message);
    checkEqual(row50Use.data.currency, "bindGold", "入账字段同样是 bindGold（唯一货币）");
    checkEqual(Number(row50Use.data.data.bindGold), bindBefore + Number(BIND_ROW.amount) * 2 + Number(BIND_ROW_50.amount), "两档面值叠加进同一本账");

    //#endregion

    //#region 三、失败路径

    group("三、失败路径（都不许入账）");
    const emptyCell = await api(baseUrl, "POST", `roles/${roleId}/money-use`, { token, body: { row: 5, col: 5, revision: await revOf(baseUrl, roleId, token) } });
    checkEqual(emptyCell.code, 20023, "空格子 → 20023");
    await seedBag([{ row: 0, col: 0, id: "drug_hp_1", count: 1 }]);
    const notMoney = await api(baseUrl, "POST", `roles/${roleId}/money-use`, { token, body: { row: 0, col: 0, revision: await revOf(baseUrl, roleId, token) } });
    checkEqual(notMoney.code, 20023, "格子里是药品 → 20023（不是货币道具就不给钱）");
    const afterNotMoney = await api(baseUrl, "GET", `roles/${roleId}`, { token });
    checkEqual(
      Number(afterNotMoney.data.data.bindGold),
      bindBefore + Number(BIND_ROW.amount) * 2 + Number(BIND_ROW_50.amount),
      "被拒之后一分钱都没多（bindGold 没变）",
    );
    checkEqual(countInBag(afterNotMoney.data.data.bag, "drug_hp_1"), 1, "被拒之后那瓶药还在包里");

    await seedBag([{ row: 0, col: 0, id: BIND_ROW.id, count: 1 }]);
    const latest = await api(baseUrl, "GET", `roles/${roleId}`, { token });
    const stale = await api(baseUrl, "POST", `roles/${roleId}/money-use`, {
      token,
      body: { row: 0, col: 0, revision: latest.data.revision - 1 },
    });
    checkEqual(stale.code, 20006, "revision 落后 → 20006（乐观锁）");
    // 基线用**属主**的 token 取：这条验的是「越权 → 40300」，不能让它先在取基线那一步
    // 403 掉、把请求退化成「缺 revision 的 400」，那样越权判据就被掩盖了（#820）
    const foreign = await api(baseUrl, "POST", `roles/${roleId}/money-use`, { token: otherToken, body: { row: 0, col: 0, revision: await revOf(baseUrl, roleId, token) } });
    checkEqual(foreign.code, 40300, "别人的角色 → 40300");
    const outOfRange = await api(baseUrl, "POST", `roles/${roleId}/money-use`, { token, body: { row: 100, col: 0, revision: await revOf(baseUrl, roleId, token) } });
    checkEqual(outOfRange.code, 40000, "行号越界 → 40000（DTO 上界拦截，不进业务）");

    //#endregion

    //#region 四、新建：只填货币 + 面值

    group("四、新建货币物品（派生 id / 名称 / 图标）");
    const createdItem = await api(baseUrl, "POST", "admin/money-items", { token: adminToken, body: { currency: "bindGold", amount: 8888 } });
    checkEqual(createdItem.code, 0, "只填货币 + 面值就能建", createdItem.message);
    checkEqual(createdItem.data.id, "money_bind_gold_8888", "id 按「货币 + 面值」派生");
    checkEqual(createdItem.data.label, "绑定元宝（8888）", "名称缺省 = 货币中文名（面值）");
    checkEqual(createdItem.data.icon, "item/currency/bind-gold-8888", "图标路径按资源命名纪律派生");
    checkEqual(createdItem.data.maxStack, 999, "叠加上限缺省 999");
    checkEqual(createdItem.data.sellPrice, 0, "售价缺省 0（不可出售）");
    const afterCreate = await api(baseUrl, "GET", "admin/money-items?page=1&size=100", { token: adminToken });
    checkEqual(afterCreate.data.total, SEED_MONEY.length + 1, "列表多了一条");
    const duplicate = await api(baseUrl, "POST", "admin/money-items", { token: adminToken, body: { currency: "bindGold", amount: 8888 } });
    checkEqual(duplicate.code, 50042, "同货币同面值再建一次 → 50042（id 撞了）");
    const badCurrency = await api(baseUrl, "POST", "admin/money-items", { token: adminToken, body: { currency: "diamond", amount: 10 } });
    checkEqual(badCurrency.code, 40000, "币种不在取值域之内 → 40000（参数校验）");
    const legacyCurrency = await api(baseUrl, "POST", "admin/money-items", { token: adminToken, body: { id: "money_legacy_coin", currency: "legacy", amount: 10 } });
    checkEqual(legacyCurrency.code, 40000, "未知币种进不来 → 40000（取值域只有 bindGold）");
    const badAmount = await api(baseUrl, "POST", "admin/money-items", { token: adminToken, body: { currency: "bindGold", amount: 0 } });
    checkEqual(badAmount.code, 40000, "面值 0 → 40000（参数校验）");
    const customId = await api(baseUrl, "POST", "admin/money-items", {
      token: adminToken,
      body: { id: "money_test_custom", currency: "bindGold", amount: 7, label: "七枚小绑定元宝" },
    });
    checkEqual(customId.code, 0, "也可以自己指定 id 与名称", customId.message);
    checkEqual(customId.data.label, "七枚小绑定元宝", "指定了名称就用指定的");
    const badId = await api(baseUrl, "POST", "admin/money-items", { token: adminToken, body: { id: "Money-BAD", currency: "bindGold", amount: 9 } });
    checkEqual(badId.code, 40000, "id 大写 / 连字符 → 40000（只许小写字母数字下划线）");

    //#endregion

    //#region 五、用新建的那条 / 改面值即时生效

    group("五、新建的能入账，改面值即时生效");
    await seedBag([{ row: 0, col: 0, id: "money_bind_gold_8888", count: 2 }]);
    const bindGoldBefore = Number((await api(baseUrl, "GET", `roles/${roleId}`, { token })).data.data.bindGold);
    const useNew = await api(baseUrl, "POST", `roles/${roleId}/money-use`, { token, body: { row: 0, col: 0, revision: await revOf(baseUrl, roleId, token) } });
    checkEqual(useNew.code, 0, "新建的道具能直接使用", useNew.message);
    checkEqual(Number(useNew.data.data.bindGold), bindGoldBefore + 8888, "入账 8888（按库里的面值）");

    const patched = await api(baseUrl, "PATCH", "admin/money-items/money_bind_gold_8888", {
      token: adminToken,
      body: { amount: 1234, label: "绑定元宝（改名版）" },
    });
    checkEqual(patched.code, 0, "改面值 + 改名", patched.message);
    checkEqual(Number(patched.data.amount), 1234, "面值改成 1234");
    await sleep(1250); // 同一个道具 1 秒冷却（#847），等过去再看「改完即时生效」
    const usePatched = await api(baseUrl, "POST", `roles/${roleId}/money-use`, { token, body: { row: 0, col: 0, revision: await revOf(baseUrl, roleId, token) } });
    checkEqual(usePatched.code, 0, "同一个格子再点一次", usePatched.message);
    checkEqual(
      Number(usePatched.data.balance),
      bindGoldBefore + 8888 + 1234,
      "这次加的是新面值 1234（存量格子跟着配置走，客户端改包也没用）",
    );
    const patchMissing = await api(baseUrl, "PATCH", "admin/money-items/money_not_exists", { token: adminToken, body: { amount: 1 } });
    checkEqual(patchMissing.code, 50041, "改不存在的行 → 50041");

    //#endregion

    //#region 六、删除

    group("六、删除（只删配置，不碰存档）");
    const removed = await api(baseUrl, "DELETE", "admin/money-items/money_bind_gold_8888", { token: adminToken });
    checkEqual(removed.code, 0, "删掉刚才那条", removed.message);
    checkEqual(Number(removed.data.removed), 1, "实际删了 1 行");
    const removeAgain = await api(baseUrl, "DELETE", "admin/money-items/money_bind_gold_8888", { token: adminToken });
    checkEqual(removeAgain.code, 50041, "再删一次 → 50041（已经没了）");
    const listAfterRemove = await api(baseUrl, "GET", "admin/money-items?page=1&size=100", { token: adminToken });
    checkEqual(listAfterRemove.data.total, SEED_MONEY.length + 1, "列表少了一条（还剩自定义那条）");
    // 背包里那格已经被用光；再放一个旧 id 进去，验证「认不出的道具」不崩也不给钱
    await seedBag([{ row: 0, col: 0, id: "money_bind_gold_8888", count: 1 }]);
    const useRemoved = await api(baseUrl, "POST", `roles/${roleId}/money-use`, { token, body: { row: 0, col: 0, revision: await revOf(baseUrl, roleId, token) } });
    checkEqual(useRemoved.code, 20023, "配置删了之后再用那个格子 → 20023（不白给钱）");
    const afterRemoved = await api(baseUrl, "GET", `roles/${roleId}`, { token });
    checkEqual(countInBag(afterRemoved.data.data.bag, "money_bind_gold_8888"), 1, "那格东西还在（没被吞掉）");
    const snapshotAfter = await api(baseUrl, "GET", "game-config", { token });
    const ids = (snapshotAfter.data.moneyItems || []).map((item) => item.id);
    check(!ids.includes("money_bind_gold_8888"), "快照里不再下发被删的那条（客户端索引里它就消失了）");
    check(ids.includes("money_test_custom"), "自定义那条照样下发");

    //#endregion

    if (failed > 0) {
      console.log(`\n❌ 货币道具 e2e：${failed} 项断言不通过`);
      failures.forEach((label) => console.log(`  - ${label}`));
      console.log("\n服务端日志尾部：");
      console.log(server.logs().split("\n").slice(-30).join("\n"));
      process.exitCode = 1;
    } else {
      console.log(`\n✓ 货币道具 e2e 全部通过（${passed} 项断言）`);
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
