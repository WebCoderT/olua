/**
 * 出售 / 回收 e2e（#397，epic #394）
 *
 * 钉的是「经济出口由服务端结算」这条线：
 *
 * 一、卖装备：价按共享快照（回收价曲线 × 前后缀倍率），绑定元宝入账、格子消失、revision +1
 * 二、同 id 多格合并：一键回收会把一件装备的多个格子拆成多条报上来，服务端先合并再扣
 * 三、客户端报价无效：body 里多带 price 字段不会改变结算（白名单 + 服务端只读快照）
 * 四、不可卖：快照里没有价签的 id → 20018（任务物 / 关键道具就靠这条拦住）
 * 五、数量不够 → 20019，且**整单拒绝**（一条合法 + 一条不够 → 存档一个字节都不动）
 * 六、乐观锁：带错 revision → 20006，存档不动
 * 七、归属：拿别人的角色 id 卖 → 40300
 *
 * 走的是 `dist/`，所以前置是 `npm run build`。
 * 用法：npm run test:e2e:sell
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/** 价签唯一来源（服务端结算读的就是这份生成物） */
const { SELL_PRICES } = require(path.join(SERVER_DIR, "dist", "shared", "game-data.generated.js"));

//#region 断言小工具（与 e2e-quest 同款口径）

const EXPECTED_ASSERTIONS = 24;

let passed = 0;
let failed = 0;
const failures = [];

function assertExpectedCount() {
  if (failed !== 0) return;
  if (passed === EXPECTED_ASSERTIONS) return;
  console.log(`\n❌ 断言条数变了：期望 ${EXPECTED_ASSERTIONS}，实际 ${passed}`);
  console.log("   改了断言就同步这个常量，以及文档里的 e2e 总数（make audit 会比对）");
  process.exit(1);
}

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
      JWT_SECRET: "e2e-sell-secret",
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
 * 一份最小可建号的角色文档：背包 4×10，塞好本套要卖的东西
 *
 * · cloth_1 ×1（1 级衣服，回收价 = 曲线 10）
 * · material_hide 两格（2 + 3）：验证「同 id 多格合并」
 * · material_iron ×1：验证「数量不够整单拒绝」时它得原样留着
 */
function roleData(id, name) {
  const bag = Array.from({ length: 4 }, () => Array.from({ length: 10 }, () => null));
  bag[0][0] = { id: "cloth_1", count: 1 };
  bag[0][1] = { id: "material_hide", count: 2 };
  bag[0][2] = { id: "material_hide", count: 3 };
  bag[1][0] = { id: "material_iron", count: 1 };
  return { id, name, occupation: "1", sex: "1", level: 1, hp: 100, mp: 50, equipments: {}, bag, skills: { 1000: 1 } };
}

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

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-sell-${Date.now()}.db`);
  const server = await startServer(dbPath);
  let serverChild = null;
  try {
    const { baseUrl } = server;
    serverChild = server.child;

    //#region 准备：两个账号（一个卖东西，一个用来验越权）

    group("准备：玩家与角色");
    const registered = await api(baseUrl, "POST", "auth/register", { body: { username: "sell_player", password: "pass1234" } });
    const token = registered.data && registered.data.token;
    const created = await api(baseUrl, "POST", "roles", { token, body: { data: roleData("sell_r1", "卖货的") } });
    const roleId = created.data && created.data.id;
    check(created.code === 0 && created.data.online === true, "准备：角色已创建并自动在线", created.message);
    check(countInBag(created.data.data.bag, "cloth_1") === 1, "准备：背包里有一件 cloth_1");

    const other = await api(baseUrl, "POST", "auth/register", { body: { username: "sell_other", password: "pass1234" } });
    const otherToken = other.data && other.data.token;
    check(!!otherToken, "准备：第二个账号已注册（越权用）");

    //#endregion

    //#region 一、卖装备：价按快照、余额涨、格子消失、revision +1

    group("一、卖装备（服务端按快照价结算）");
    const before = await api(baseUrl, "GET", `roles/${roleId}`, { token });
    const bindGoldBefore = Number((before.data.data || {}).bindGold || 0);
    const revisionBefore = before.data.revision;
    const clothPrice = SELL_PRICES["cloth_1"];

    const sold = await api(baseUrl, "POST", `roles/${roleId}/sell`, { token, body: { entries: [{ goodId: "cloth_1", count: 1 }] } });
    check(sold.code === 0, "卖出一件 cloth_1 成功", sold.message);
    checkEqual(Number((sold.data.data || {}).bindGold || 0), bindGoldBefore + clothPrice, "绑定元宝按快照价入账");
    checkEqual(sold.data.sold[0].unitPrice, clothPrice, "结算明细里的单价 = 共享快照价");
    checkEqual(sold.data.total, clothPrice, "合计 = 单价 × 件数");
    checkEqual(countInBag((sold.data.data || {}).bag, "cloth_1"), 0, "背包里 cloth_1 已消失");
    checkEqual(sold.data.revision, revisionBefore + 1, "revision +1（客户端据此对齐基线）");

    //#endregion

    //#region 二、同 id 多格合并

    group("二、同 id 多格合并（一键回收的报法）");
    const hidePrice = SELL_PRICES["material_hide"];
    const merged = await api(baseUrl, "POST", `roles/${roleId}/sell`, {
      token,
      body: { entries: [{ goodId: "material_hide", count: 2 }, { goodId: "material_hide", count: 3 }] },
    });
    check(merged.code === 0, "两格兽皮（2 + 3）一起卖成功", merged.message);
    checkEqual(merged.data.sold.length, 1, "同 id 合成一行结算");
    checkEqual(merged.data.sold[0].count, 5, "合并后的件数是 5");
    checkEqual(merged.data.total, hidePrice * 5, "合计 = 单价 × 5");
    checkEqual(countInBag((merged.data.data || {}).bag, "material_hide"), 0, "两格兽皮都已清空");

    //#endregion

    //#region 三、客户端报价无效

    group("三、客户端报价无效（价格只认快照）");
    const ironPrice = SELL_PRICES["material_iron"];
    const cheat = await api(baseUrl, "POST", `roles/${roleId}/sell`, {
      token,
      body: { entries: [{ goodId: "material_iron", count: 1, price: 999999, unitPrice: 999999 }], total: 999999 },
    });
    check(cheat.code === 0, "多带 price / unitPrice / total 也照常出售（白名单剥掉未知字段）", cheat.message);
    checkEqual(cheat.data.total, ironPrice, "结算金额仍是快照价（客户端报的 999999 无效）");

    //#endregion

    //#region 四、不可卖

    group("四、不可卖（快照里没有价签）");
    const notSellable = await api(baseUrl, "POST", `roles/${roleId}/sell`, { token, body: { entries: [{ goodId: "no_such_good", count: 1 }] } });
    checkEqual(notSellable.code, 20018, "没有价签的物品 → 20018");
    const afterNotSellable = await api(baseUrl, "GET", `roles/${roleId}`, { token });
    checkEqual(afterNotSellable.data.revision, cheat.data.revision, "被拒的请求不改存档（revision 没动）");

    //#endregion

    //#region 五、数量不够 → 整单拒绝

    group("五、数量不够（整单拒绝，不做部分扣除）");
    // 重新放一件装备进包，用来验证「合法那条也不会被扣」
    const refill = await api(baseUrl, "POST", `roles/${roleId}/mall-purchase`, { token, body: { goodId: "cloth_1" } });
    check(refill.code === 0, "准备：从商城买一件 cloth_1（补回背包）", refill.message);

    const mixed = await api(baseUrl, "POST", `roles/${roleId}/sell`, {
      token,
      body: { entries: [{ goodId: "cloth_1", count: 1 }, { goodId: "cloth_1", count: 99 }] },
    });
    checkEqual(mixed.code, 20019, "持有 1 件却报 100 件 → 20019");
    const afterMixed = await api(baseUrl, "GET", `roles/${roleId}`, { token });
    checkEqual(countInBag(afterMixed.data.data.bag, "cloth_1"), 1, "合法那条也没被扣（整单拒绝）");
    checkEqual(afterMixed.data.revision, refill.data.revision, "存档 revision 没动");

    //#endregion

    //#region 六、乐观锁

    group("六、乐观锁");
    const stale = await api(baseUrl, "POST", `roles/${roleId}/sell`, {
      token,
      body: { revision: afterMixed.data.revision - 1, entries: [{ goodId: "cloth_1", count: 1 }] },
    });
    checkEqual(stale.code, 20006, "revision 落后 → 20006");

    //#endregion

    //#region 七、归属

    group("七、归属（拿别人的角色 id 卖）");
    const foreign = await api(baseUrl, "POST", `roles/${roleId}/sell`, { token: otherToken, body: { entries: [{ goodId: "cloth_1", count: 1 }] } });
    checkEqual(foreign.code, 40300, "别人的角色 → 40300（越权一律拒绝）");

    //#endregion

    if (failed > 0) {
      console.log(`\n❌ 出售 e2e：${failed} 项断言不通过`);
      failures.forEach((label) => console.log(`  - ${label}`));
      console.log("\n服务端日志尾部：");
      console.log(server.logs().split("\n").slice(-30).join("\n"));
      process.exitCode = 1;
    }
    assertExpectedCount();
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
