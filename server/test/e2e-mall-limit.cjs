#!/usr/bin/env node
/**
 * 服务端 e2e：商城的每日限购与全服库存（#846 · docs/37 B25）
 *
 * 病灶：购买接口既没有频率限制也没有任何「卖出去多少」的记账 ——
 * 「每日限购」「限量发售」这类运营手段根本做不出来，改包连点还能把限量款买爆。
 *
 * 口径（C4 + 2026-11-10 拍板）：
 * - `mall_goods.daily_limit` / `stock` 是**配置**（进快照，客户端用来显示与置灰）；
 * - 「今天买了几个」在 `mall_sales`（按角色 / 商品 / 天号，05:00 切日，与日常任务同一把尺子）；
 * - 「全服卖了几件」在 `mall_stock`（只记 sold，总量仍是配置里的 stock）；
 * - 占位与扣款**同一个事务**：买失败不能白吃名额，卖了不能没扣钱。
 *
 * 这套测试钉七件事： *
 * 〇、准备：玩家 / 角色 / 管理员，建分类、上架商品（限购 2、不限量）
 * 一、每日限购：第 3 次 50029，**不扣钱不发货**，回执带 bought / dailyLimit
 * 二、切日：把计数行的天号改成昨天，同一个角色又能买（不需要任何结算动作）
 * 三、全服库存：stock=1 时第二个人 50030；stock=0 立刻售罄；重置库存后重新可买；
 *     顺手钉「下架即清已售」—— 否则重新上架沿用旧 sold，配个小 stock 就「刚上架就售罄」
 * 四、两个都关掉（0 / -1）：连买三次都成功，行为与加字段之前一致
 * 五、回执与只读视图 `GET /roles/:id/mall-limits` 同源（bought / limit / sold / stock / purchasable）
 * 六、占位与扣款同一个事务：背包满（20012）时库存与今日名额要一起退回
 *
 * 走的是 `dist/`，所以前置是 `npm run build`。
 * 用法：npm run test:e2e:mall-limit
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const ADMIN_CODE = "e2e-mall-admin";

//#region 断言小工具（与 e2e-use-cooldown 同款口径）

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
      JWT_SECRET: "e2e-mall-secret",
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

/** 取当前修订号（写接口都要基线，见 #820 / B62） */
async function revOf(baseUrl, roleId, token) {
  const role = await api(baseUrl, "GET", `roles/${roleId}`, { token });
  return role.data && role.data.revision;
}

async function registerAdmin(baseUrl, username, password) {
  await api(baseUrl, "POST", "admin/auth/register", { body: { username, password, registerCode: ADMIN_CODE } });
  const login = await api(baseUrl, "POST", "admin/auth/login", { body: { username, password } });
  return login.data && login.data.token;
}

/** 直接改库的小工具（服务端已起来之后再调：空库首启会用 config-sync.sql 整表灌一遍） */
function withDb(dbPath, work) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    work(db);
  } finally {
    db.close();
  }
}

/** 背包里某个物品的总件数（买到的东西在 bag 网格里，可能叠在一格） */
function countOf(bag, goodId) {
  let total = 0;
  (bag || []).forEach((row) => {
    (row || []).forEach((cell) => {
      if (cell && cell.id === goodId) total += Number(cell.count) || 0;
    });
  });
  return total;
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-mall-limit-${Date.now()}.db`);
  const server = await startServer(dbPath);
  try {
    const { baseUrl } = server;

    //#region 〇、准备

    group("准备：玩家 / 角色 / 管理员 / 上架商品");
    const registered = await api(baseUrl, "POST", "auth/register", { body: { username: "mall_player", password: "pass1234" } });
    const token = registered.data && registered.data.token;
    const created = await api(baseUrl, "POST", "roles", { token, body: { name: "囤货的", occupation: "1", sex: "1" } });
    const roleId = created.data && created.data.id;
    check(created.code === 0 && created.data.online === true, "准备：角色已创建并自动在线", created.message);

    // 第二个人：用来验「全服库存」是共享的（限购才是每人一份）
    const registered2 = await api(baseUrl, "POST", "auth/register", { body: { username: "mall_player2", password: "pass1234" } });
    const token2 = registered2.data && registered2.data.token;
    const created2 = await api(baseUrl, "POST", "roles", { token: token2, body: { name: "后来的", occupation: "1", sex: "1" } });
    const roleId2 = created2.data && created2.data.id;
    check(created2.code === 0, "准备：第二个角色已创建", created2.message);

    const adminToken = await registerAdmin(baseUrl, "mall_admin", "Admin#123456");
    check(!!adminToken, "准备：管理员已登录");

    /** 钱包（绑定元宝是唯一货币：#304 商城只扣 bindGold） */
    const setGold = async (id, bindGold) => {
      const result = await api(baseUrl, "PATCH", `admin/roles/${id}`, { token: adminToken, body: { bindGold } });
      check(result.code === 0, `准备：角色 ${id} 绑定元宝置为 ${bindGold}`, result.message);
    };
    /**
     * 背包网格：建号时 `bag` 是空数组（#597 不赠送任何物品），`putGoodIntoBag` 一格都找不到 → 20012。
     * 管理端稀疏格子只**往大扩**（`applyBagCells` 从原网格尺寸起步），所以拿最末一格放一件陪衬物
     * 把网格换成 4×6 空网格 —— 之后放商品走行优先首格。
     */
    const seedBag = async (id, label) => {
      const result = await api(baseUrl, "PATCH", `admin/roles/${id}`, {
        token: adminToken,
        body: { bag: [{ row: 3, col: 5, id: "cloth_1_p0s0", count: 1 }] },
      });
      check(result.code === 0, `准备：${label} 背包铺出 4×6 网格`, result.message);
    };
    /** 售价取 777：与 e2e-game-config 同一件商品同一档价，定价不变式（回收价 ≤ 售价×50%）已验证过 */
    const PRICE = 777;
    const WALLET = 10_000;
    await setGold(roleId, WALLET);
    await setGold(roleId2, WALLET);
    await seedBag(roleId, "囤货的");
    await seedBag(roleId2, "后来的");

    const category = await api(baseUrl, "POST", "admin/mall/categories", { token: adminToken, body: { label: "限购测试" } });
    const categoryId = category.data && category.data.id;
    check(category.code === 0 && !!categoryId, "准备：商城分类已建", category.message);

    /** 上架一件商品（recycle ≤ price×50% 才过定价不变式，price 取 100 稳妥） */
    const GOOD = "cloth_1_p0s1";
    const listGood = async (body) => {
      const result = await api(baseUrl, "POST", "admin/mall/goods", {
        token: adminToken,
        body: { id: GOOD, categoryId, price: PRICE, ...body },
      });
      check(result.code === 0, `准备：上架 ${JSON.stringify(body)}`, result.message);
      return result.data;
    };
    const patchGood = async (body) => {
      const result = await api(baseUrl, "PATCH", `admin/mall/goods/${GOOD}`, { token: adminToken, body });
      check(result.code === 0, `准备：改商品 ${JSON.stringify(body)}`, result.message);
      return result.data;
    };
    const listed = await listGood({ dailyLimit: 2 });
    checkEqual(listed.dailyLimit, 2, "上架时每日限购已落库");
    checkEqual(listed.stock, -1, "没给库存 → -1（不限量），与加字段之前的行为一致");
    checkEqual(listed.sold, 0, "新上架商品已售 0 件");

    const buy = async (id, tk) =>
      api(baseUrl, "POST", `roles/${id}/mall-purchase`, {
        token: tk,
        body: { goodId: GOOD, revision: await revOf(baseUrl, id, tk) },
      });
    const limitsOf = async (id, tk) => {
      const result = await api(baseUrl, "GET", `roles/${id}/mall-limits`, { token: tk });
      check(result.code === 0, "读 mall-limits", result.message);
      const row = (result.data.list || []).find((entry) => entry.goodId === GOOD);
      check(!!row, `mall-limits 里有 ${GOOD}`);
      return row || {};
    };
    const goldOf = async (id, tk) => {
      const role = await api(baseUrl, "GET", `roles/${id}`, { token: tk });
      return Number(role.data.data.bindGold) || 0;
    };
    const bagCountOf = async (id, tk) => {
      const role = await api(baseUrl, "GET", `roles/${id}`, { token: tk });
      return countOf(role.data.data.bag, GOOD);
    };

    //#endregion

    //#region 一、每日限购

    group("一、每日限购：买满 2 件后 50029，且不扣钱不发货");
    const first = await buy(roleId, token);
    checkEqual(first.code, 0, "第 1 件买成功");
    checkEqual(first.data && first.data.dailyBought, 1, "回执带「今天已买 1 件」");
    checkEqual(first.data && first.data.dailyLimit, 2, "回执带「每日限购 2 件」");
    checkEqual(first.data && first.data.stock, -1, "回执带库存 -1（不限量）");
    checkEqual(await goldOf(roleId, token), WALLET - PRICE, "第 1 件扣了售价那么多绑定元宝");
    checkEqual(await bagCountOf(roleId, token), 1, "第 1 件进了背包");

    const second = await buy(roleId, token);
    checkEqual(second.code, 0, "第 2 件买成功");
    checkEqual(second.data && second.data.dailyBought, 2, "回执带「今天已买 2 件」");
    checkEqual(await goldOf(roleId, token), WALLET - PRICE * 2, "第 2 件也扣了同样的钱");

    const third = await buy(roleId, token);
    checkEqual(third.code, 50029, "第 3 件 → 50029（今日限购已满）");
    checkEqual(third.details && third.details.bought, 2, "50029 的 details 带「已买 2 件」");
    checkEqual(third.details && third.details.dailyLimit, 2, "50029 的 details 带「限购 2 件」");
    checkEqual(await goldOf(roleId, token), WALLET - PRICE * 2, "**被限购拒掉的那次不扣钱**（余额没再减）");
    checkEqual(await bagCountOf(roleId, token), 2, "**被限购拒掉的那次不发货**（仍是 2 件）");

    const limitedView = await limitsOf(roleId, token);
    checkEqual(limitedView.dailyBought, 2, "mall-limits 里今日已购 2 件");
    checkEqual(limitedView.dailyLimit, 2, "mall-limits 里限购 2 件");
    checkEqual(limitedView.purchasable, false, "买满之后 purchasable = false（客户端据此置灰）");

    // 另一个人不受这件商品的影响：限购是**每人**一份
    const otherFirst = await buy(roleId2, token2);
    checkEqual(otherFirst.code, 0, "换一个人照样能买（限购是每人一份，不是全服）");

    //#endregion

    //#region 二、切日

    group("二、切日：把计数行的天号改成昨天，同一个角色又能买");
    withDb(dbPath, (db) => {
      const row = db.prepare("SELECT day FROM mall_sales WHERE role_id = ? AND good_id = ?").get(roleId, GOOD);
      check(!!row, "准备：mall_sales 里有这个角色的计数行");
      db.prepare("UPDATE mall_sales SET day = day - 1 WHERE role_id = ? AND good_id = ?").run(roleId, GOOD);
    });
    const afterDay = await buy(roleId, token);
    checkEqual(afterDay.code, 0, "跨天后又能买了（天号对不上 = 新的一天，不需要任何结算动作）");
    checkEqual(afterDay.data && afterDay.data.dailyBought, 1, "新的一天从 1 数起");
    checkEqual(await goldOf(roleId, token), WALLET - PRICE * 3, "这次确实又扣了一次钱");

    //#endregion

    //#region 三、全服库存

    group("三、全服库存：卖完即售罄，重置后重新开卖");
    await setGold(roleId, WALLET);
    await patchGood({ dailyLimit: 0, stock: 1 });
    const goldBefore = await goldOf(roleId2, token2);
    const bagBefore = await bagCountOf(roleId2, token2);
    const stockFirst = await buy(roleId, token);
    checkEqual(stockFirst.code, 0, "库存 1 时第一个人买到");
    checkEqual(stockFirst.data && stockFirst.data.sold, 1, "回执带「全服已售 1 件」");
    checkEqual(stockFirst.data && stockFirst.data.stock, 1, "回执带「库存 1 件」");

    const stockSecond = await buy(roleId2, token2);
    checkEqual(stockSecond.code, 50030, "库存卖完之后第二个人 → 50030（售罄）");
    checkEqual(stockSecond.details && stockSecond.details.sold, 1, "50030 的 details 带「已售 1 件」");
    checkEqual(stockSecond.details && stockSecond.details.stock, 1, "50030 的 details 带「库存 1 件」");
    // 基线要在这次购买之前取：roleId2 在第一段「换个人照样能买」里已经花过一份钱、拿过一件
    checkEqual(await goldOf(roleId2, token2), goldBefore, "**售罄被拒的那次一分没扣**");
    checkEqual(await bagCountOf(roleId2, token2), bagBefore, "**售罄被拒的那次也没发货**");

    const soldOutView = await limitsOf(roleId2, token2);
    checkEqual(soldOutView.sold, 1, "mall-limits 里已售 1 件");
    checkEqual(soldOutView.purchasable, false, "售罄后 purchasable = false");

    await patchGood({ stock: 0 });
    const zero = await buy(roleId2, token2);
    checkEqual(zero.code, 50030, "库存改成 0 = 立刻停售（50030，不用等下架）");

    const reset = await api(baseUrl, "POST", `admin/mall/goods/${GOOD}/stock-reset`, { token: adminToken });
    checkEqual(reset.code, 0, "管理端重置库存成功");
    checkEqual(reset.data && reset.data.sold, 0, "重置后已售归零");
    await patchGood({ stock: 1 });
    const afterReset = await buy(roleId2, token2);
    checkEqual(afterReset.code, 0, "补货（重置 + 改库存）之后又能买了");
    checkEqual(afterReset.data && afterReset.data.sold, 1, "新一轮从 1 开始计数");

    // 下架应该把已售一起清掉：否则重新上架会沿用旧 sold，配个小 stock 就「刚上架就售罄」
    const del = await api(baseUrl, "DELETE", `admin/mall/goods/${GOOD}`, { token: adminToken });
    checkEqual(del.code, 0, "下架成功");
    await listGood({ dailyLimit: 0, stock: 5 });
    // 断言不能只看上架接口的回执（新建行的 sold 恒 0，那样改不改 resetStock 都绿）：
    // 真读一次管理端列表与玩家侧只读视图，两处都得是 0
    const relistPage = await api(baseUrl, "GET", "admin/mall/goods", { token: adminToken });
    const relistRow = ((relistPage.data && relistPage.data.list) || []).find((entry) => entry.id === GOOD) || {};
    checkEqual(relistRow.sold, 0, "**下架再上架 sold 归零**（重新上架 = 新的一轮，管理端列表真读库）");
    const relistView = await limitsOf(roleId2, token2);
    checkEqual(relistView.sold, 0, "玩家的 mall-limits 也跟着归零");

    //#endregion

    //#region 四、两个都关掉

    group("四、不限购不限量（0 / -1）：行为与加字段之前完全一致");
    await patchGood({ dailyLimit: 0, stock: -1 });
    await setGold(roleId, WALLET);
    for (let i = 1; i <= 3; i += 1) {
      const result = await buy(roleId, token);
      checkEqual(result.code, 0, `不限购不限量：第 ${i} 次买成功`);
    }
    checkEqual(await goldOf(roleId, token), WALLET - PRICE * 3, "三次各扣一次钱");
    const freeLimits = await limitsOf(roleId, token);
    checkEqual(freeLimits.dailyLimit, 0, "mall-limits 里限购 0 = 不限购");
    checkEqual(freeLimits.stock, -1, "mall-limits 里库存 -1 = 不限量");
    checkEqual(freeLimits.purchasable, true, "不限购不限量时恒可买");

    //#endregion

    //#region 五、回执与只读视图同源

    group("五、回执与只读视图同源（都读同一张运行时表）");
    await patchGood({ dailyLimit: 5, stock: 10 });
    const beforeView = await limitsOf(roleId, token);
    const boughtNow = beforeView.dailyBought;
    const once = await buy(roleId, token);
    checkEqual(once.code, 0, "买一件成功");
    checkEqual(once.data.dailyBought, boughtNow + 1, "回执的已购数 = 视图里的已购数 + 1");
    const afterView = await limitsOf(roleId, token);
    checkEqual(afterView.dailyBought, boughtNow + 1, "视图跟着涨");
    checkEqual(afterView.sold, 1, "视图里已售 1 件（下架后重新计数）");

    //#endregion

    //#region 六、占位与扣款同一个事务

    group("六、买失败（背包满 20012）要把库存与今日名额一起退回去");
    const txBaseline = await limitsOf(roleId, token);
    const txBaselineGold = await goldOf(roleId, token);
    const FULL_BAG = [];
    for (let row = 0; row < 4; row += 1) {
      for (let col = 0; col < 6; col += 1) FULL_BAG.push({ row, col, id: "cloth_1_p0s0", count: 1 });
    }
    const stuffed = await api(baseUrl, "PATCH", `admin/roles/${roleId}`, { token: adminToken, body: { bag: FULL_BAG } });
    checkEqual(stuffed.code, 0, "管理端把背包塞满（4×6 全满）");

    const failBuy = await buy(roleId, token);
    checkEqual(failBuy.code, 20012, "背包满 → 20012（占位在入包之前，此时库存与名额已经先 +1 过）");
    const afterFail = await limitsOf(roleId, token);
    checkEqual(afterFail.sold, txBaseline.sold, "**失败的那次没吃库存**（sold 退回买入前的数）");
    checkEqual(afterFail.dailyBought, txBaseline.dailyBought, "**失败的那次也没吃今日名额**");
    checkEqual(await goldOf(roleId, token), txBaselineGold, "失败的那次也没扣钱");

    // 清空背包（空数组 = 清空，网格保留 4×6）后再买：名额确实还在，不是「占了就没了」
    const emptied = await api(baseUrl, "PATCH", `admin/roles/${roleId}`, { token: adminToken, body: { bag: [] } });
    checkEqual(emptied.code, 0, "清空背包（网格尺寸保留）");
    const retry = await buy(roleId, token);
    checkEqual(retry.code, 0, "腾出空间后再买成功");
    checkEqual(retry.data && retry.data.sold, txBaseline.sold + 1, "这次才真的占掉一件库存");
    checkEqual(retry.data && retry.data.dailyBought, txBaseline.dailyBought + 1, "这次才真的占掉一个今日名额");

    //#endregion

    if (failed > 0) {
      console.log(`\n❌ 商城限购 / 库存 e2e：${failed} 项断言不通过（共 ${passed + failed} 条）`);
      failures.forEach((label) => console.log(`  - ${label}`));
      console.log("\n服务端日志尾部：");
      console.log(server.logs().split("\n").slice(-30).join("\n"));
      process.exitCode = 1;
    } else {
      console.log(`\n✅ 商城限购 / 库存 e2e：${passed} 条断言全绿`);
    }
  } catch (error) {
    console.error("\n💥 用例执行异常：", error && error.message ? error.message : error);
    console.error(server.logs().split("\n").slice(-30).join("\n"));
    process.exitCode = 1;
  } finally {
    server.child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
})();
