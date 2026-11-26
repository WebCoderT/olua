#!/usr/bin/env node
/**
 * 服务端 e2e：批量使用背包物品（#1304，`role.bagUseBatch`）
 *
 * 这套接口的用途是自动使用的热路径 —— 一次请求把「能用的都用了」。它把三条单条接口
 * （drug-use / money-use / level-scroll-use）的规则**原样复用**，所以这套测试盯的是三件事：
 *
 * 1. **规则没变**：满血用药还是 20014、卷轴还是按区间 +1 级、货币道具还是读库里面值；
 *    单条接口的错码不会被批量吞成一句「失败」。
 * 2. **逐条失败不整单回滚**：空格 / 不可使用的物品记 `ok:false` 跳过，同批里能用的照用；
 *    **但一条都没成功时仍按第一条的码抛错**。
 * 3. **一次落库**：一次批量只推进 1 个 revision（这是它存在的理由 —— 单条路径 N 件就是
 *    N 次全量解析 + N 次 UPDATE）。`count` 是「这一格最多用几件」，用不动就停在那一格。
 *
 * 走的是 `dist/`，所以前置是 `npm run build`。
 * 用法：npm run test:e2e:bag-use-batch
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
// 写角色接口的基线帮手（#820 / B62：revision 必填）
const { revOfWith } = require("./lib/role-save.cjs");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/** 管理员注册码（管理端接口要它） */
const ADMIN_CODE = "e2e-bag-batch-admin";

//#region 断言小工具（与 e2e-money-item / e2e-level-scroll 同款口径）

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
      JWT_SECRET: "e2e-bag-batch-secret",
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

/** 管理端请求所在的区（#960）：一个 e2e 进程只在一个区里干活 */
const ADMIN_ZONE = 1;

async function api(baseUrl, method, route, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.zoneId !== undefined) headers["X-Zone-Id"] = String(options.zoneId);
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

/** 取角色当前修订号（写接口必须带基线，缺了就是 400 / 40000） */
const revOf = (baseUrl, roleId, token) =>
  revOfWith((method, route, options) => api(baseUrl, method, route, options), roleId, token);

/** 注册并登录一个管理员（造背包 / 改血量要管理端） */
async function registerAdmin(baseUrl, username, password) {
  await api(baseUrl, "POST", "admin/auth/register", { body: { username, password, registerCode: ADMIN_CODE } });
  const login = await api(baseUrl, "POST", "admin/auth/login", { body: { zoneId: ADMIN_ZONE, username, password } });
  return login.data && login.data.token;
}

/** 背包里某物品的总件数 */
function countInBag(bag, goodId) {
  let total = 0;
  for (const line of bag || []) {
    for (const cell of line || []) {
      if (cell && cell.id === goodId) total += Math.max(0, Math.floor(cell.count) || 0);
    }
  }
  return total;
}

// 出厂值一律从配置快照取（运营随时可能改数值/增删行，别把具体数字写死在测试里）
const snap = require("./lib/config-snapshot.cjs");
const DRUG = snap.rows("drugs").find((row) => Number(row.effectHp) > 0);
/** 第二瓶药：冷却键是「角色 + 药品」，换一瓶就不受上一段那 1 秒冷却影响 */
const DRUG2 = snap.rows("drugs").filter((row) => Number(row.effectHp) > 0)[1];
const SCROLL = snap.rows("level_scrolls").find((row) => Number(row.minLevel) <= 1);
const MONEY = snap.rows("money_items").find((row) => row.currency === "bindGold");
const MATERIAL = snap.rows("items").find((row) => row.type === "material");

(async () => {
  if (!DRUG || !DRUG2 || !SCROLL || !MONEY || !MATERIAL) {
    console.error("配置快照里缺少测试所需的出厂数据（drugs / level_scrolls / money_items / items=material）");
    process.exit(1);
  }
  const dbPath = path.join(os.tmpdir(), `olua-e2e-bag-batch-${Date.now()}.db`);
  const server = await startServer(dbPath);
  try {
    const { baseUrl } = server;

    //#region 准备
    group("准备：玩家 / 角色 / 管理员");
    const registered = await api(baseUrl, "POST", "auth/register", { body: { username: "batch_player", password: "pass1234" } });
    const token = registered.data && registered.data.token;
    const created = await api(baseUrl, "POST", "roles", { token, body: { name: "批量", occupation: "1", sex: "1" } });
    const roleId = created.data && created.data.id;
    check(created.code === 0 && !!roleId, "准备：角色已创建", created.message);
    const adminToken = await registerAdmin(baseUrl, "batch_admin", "Admin#123456");
    check(!!adminToken, "准备：管理员已登录");
    const other = await api(baseUrl, "POST", "auth/register", { body: { username: "batch_other", password: "pass1234" } });
    const otherToken = other.data && other.data.token;

    /** 造背包 / 改血量：管理端是唯一的旁路写点（客户端改不了 bag / hp） */
    const patchRole = async (body) => {
      const result = await api(baseUrl, "PATCH", `admin/roles/${roleId}`, { token: adminToken, zoneId: ADMIN_ZONE, body });
      check(result.code === 0, `准备：管理端写入 ${JSON.stringify(Object.keys(body))}`, result.message);
      return result;
    };
    /** 整份覆盖背包（cells 稀疏） */
    const seedBag = (cells) => patchRole({ bag: cells });
    /** 读角色（含 data 存档） */
    const readRole = async () => (await api(baseUrl, "GET", `roles/${roleId}`, { token })).data;
    /** 发一次批量使用 */
    const useBatch = async (uses, revision, tk = token) =>
      api(baseUrl, "POST", `roles/${roleId}/bag-use-batch`, { token: tk, body: { uses, revision } });
    //#endregion

    //#region 一、请求形状
    group("一、请求形状（40000 中文校验）");
    {
      const rev = await revOf(baseUrl, roleId, token);
      const empty = await useBatch([], rev);
      checkEqual(empty.code, 40000, "uses 为空数组 → 40000（ArrayMinSize）");
      const zeroCount = await useBatch([{ row: 0, col: 0, count: 0 }], rev);
      checkEqual(zeroCount.code, 40000, "count = 0 → 40000（Min(1)）");
      const outOfRange = await useBatch([{ row: 99, col: 0 }], rev);
      checkEqual(outOfRange.code, 40000, "行号越界 → 40000（Max(轴上限-1)）");
    }
    //#endregion

    //#region 二、一条都没成功 → 仍按第一条的码抛
    group("二、一条都没成功：单条接口的错码语义不变");
    {
      await seedBag([{ row: 0, col: 0, id: DRUG.id, count: 2 }]);
      // 满血：用药该被 20014 拒（与单条 drug-use 同一个判定式）
      const role = await readRole();
      await patchRole({ hp: Number(role.data.maxHp) || 1 });
      const full = await useBatch([{ row: 0, col: 0, count: 1 }], await revOf(baseUrl, roleId, token));
      checkEqual(full.code, 20014, "满血用药 → 20014（血蓝已满）");
      const after = await readRole();
      checkEqual(countInBag(after.data.bag, DRUG.id), 2, "被拒时一件都没扣（不落库）");
    }
    //#endregion

    //#region 三、批量用药：一次 revision、冷却逐条生效
    group("三、批量用药：一次落库 + 冷却逐条判");
    {
      await seedBag([{ row: 0, col: 0, id: DRUG.id, count: 5 }]);
      await patchRole({ hp: 1 });
      const revBefore = await revOf(baseUrl, roleId, token);
      const before = await readRole();
      // count 2：出厂药都带冷却（drugs.cooldown 秒），所以第二瓶必然被冷却拦住 ——
      // 这正是「逐条判、用不动就停」的语义，与单条连点两次的结果一致
      const used = await useBatch([{ row: 0, col: 0, count: 2 }], revBefore);
      checkEqual(used.code, 0, "批量用药成功", used.message);
      checkEqual(used.data.uses.length, 1, "逐条结果与请求一一对应");
      checkEqual(used.data.uses[0].kind, "drug", "kind = drug（按 id 落到药品表）");
      check(used.data.uses[0].ok === true, "这一格至少用成了一件");
      checkEqual(used.data.usedCount, used.data.uses[0].count, "usedCount = 各条实际件数之和");
      check(used.data.recoveredHp > 0, "回了血（回复量由服务端按库配置算）", String(used.data.recoveredHp));
      const revAfter = await revOf(baseUrl, roleId, token);
      checkEqual(revAfter - revBefore, 1, "整批只推进 1 个 revision（一次落库）");
      const after = await readRole();
      checkEqual(countInBag(after.data.bag, DRUG.id), 5 - used.data.usedCount, "扣掉的件数与结果一致");
      check(Number(after.data.hp) > Number(before.data.hp), "角色血量确实变高了", `${before.data.hp} → ${after.data.hp}`);
      // 冷却键是「角色 + 药品」：紧接着再来一批同一瓶药，应当被 20030 拒（一条都没成功 → 抛错）
      const cooling = await useBatch([{ row: 0, col: 0, count: 1 }], revAfter);
      checkEqual(cooling.code, 20030, "同一瓶药紧接着再用 → 20030（服务端冷却，键与单条接口相同）");
    }
    //#endregion

    //#region 四、批量用升级卷轴：count 逐次生效，等级列与存档同步
    group("四、批量用升级卷轴：count = 连升几级");
    {
      await seedBag([{ row: 0, col: 0, id: SCROLL.id, count: 3 }]);
      const before = await readRole();
      const revBefore = await revOf(baseUrl, roleId, token);
      const used = await useBatch([{ row: 0, col: 0, count: 3 }], revBefore);
      checkEqual(used.code, 0, "批量用卷轴成功", used.message);
      checkEqual(used.data.uses[0].kind, "levelScroll", "kind = levelScroll");
      checkEqual(used.data.levelsGained, 3, "levelsGained = 实际用掉件数（3 卷 = 3 级）");
      checkEqual(used.data.uses[0].count, 3, "同一格连用 3 次");
      checkEqual(Number(used.data.level), Number(before.level) + 3, "DTO 顶层的等级 = 使用前 + 3");
      checkEqual(Number(used.data.data.level), Number(used.data.level), "存档里的 level 与列同步（B11）");
      checkEqual((await revOf(baseUrl, roleId, token)) - revBefore, 1, "连升 3 级仍只推进 1 个 revision");
      const after = await readRole();
      checkEqual(countInBag(after.data.bag, SCROLL.id), 0, "3 卷全部用掉（清格）");
    }
    //#endregion

    //#region 五、批量用货币道具：入账金额读库
    group("五、批量用货币道具：面值只在服务端");
    {
      await seedBag([{ row: 0, col: 0, id: MONEY.id, count: 3 }]);
      const before = await readRole();
      const bindBefore = Math.max(0, Number(before.data.bindGold) || 0);
      const revBefore = await revOf(baseUrl, roleId, token);
      // count 3：货币道具固定 1 秒冷却（键「角色 + 道具」），所以只成 1 件
      const used = await useBatch([{ row: 0, col: 0, count: 3 }], revBefore);
      checkEqual(used.code, 0, "批量用货币道具成功", used.message);
      checkEqual(used.data.uses[0].kind, "money", "kind = money");
      checkEqual(used.data.bindGoldGained, Number(MONEY.amount), "入账合计 = 库里面值 × 实际件数");
      const after = await readRole();
      checkEqual(
        Math.max(0, Number(after.data.bindGold) || 0),
        bindBefore + used.data.bindGoldGained,
        "账本余额 = 使用前 + 本次入账合计",
      );
      checkEqual((await revOf(baseUrl, roleId, token)) - revBefore, 1, "只推进 1 个 revision");
    }
    //#endregion

    //#region 六、逐条失败不整单回滚
    group("六、逐条失败不整单回滚（空格 / 不可使用的物品）");
    {
      // 换第二瓶药：上一段刚用过 DRUG，冷却键还没过期（键 = 角色 + 药品）
      await seedBag([
        { row: 0, col: 0, id: DRUG2.id, count: 2 },
        { row: 0, col: 1, id: MATERIAL.id, count: 1 },
      ]);
      await patchRole({ hp: 1 });
      const revBefore = await revOf(baseUrl, roleId, token);
      // 顺序：能用的药 / 不能用的材料 / 空格
      const used = await useBatch(
        [
          { row: 0, col: 0, count: 1 },
          { row: 0, col: 1, count: 1 },
          { row: 5, col: 5, count: 1 },
        ],
        revBefore,
      );
      checkEqual(used.code, 0, "有一条能用 → 整单成功", used.message);
      const uses = (used.data && used.data.uses) || [];
      checkEqual(uses.length, 3, "三条结果都在");
      checkEqual(used.data && used.data.usedCount, 1, "只有药那一格用掉了");
      check(uses[0] && uses[0].ok === true, "药那一格 ok=true", JSON.stringify(uses[0]));
      check(!!uses[1] && uses[1].ok === false && uses[1].code === 20020, "材料格 ok=false 且 code=20020", JSON.stringify(uses[1]));
      check(!!uses[1] && !!uses[1].message, "失败原因带中文文案", String(uses[1] && uses[1].message));
      check(!!uses[2] && uses[2].ok === false && uses[2].code === 20020, "空格子 ok=false 且 code=20020", JSON.stringify(uses[2]));
      const after = await readRole();
      checkEqual(countInBag(after.data.bag, DRUG2.id), 1, "药扣掉 1 件");
      checkEqual(countInBag(after.data.bag, MATERIAL.id), 1, "材料原封不动");
      checkEqual((await revOf(baseUrl, roleId, token)) - revBefore, 1, "部分成功也只推进 1 个 revision");
    }
    //#endregion

    //#region 七、归属与乐观锁
    group("七、归属与乐观锁");
    {
      await seedBag([{ row: 0, col: 0, id: DRUG.id, count: 1 }]);
      const rev = await revOf(baseUrl, roleId, token);
      const foreign = await useBatch([{ row: 0, col: 0, count: 1 }], rev, otherToken);
      checkEqual(foreign.code, 40300, "别人的角色 → 40300（无权操作该角色）");
      const stale = await useBatch([{ row: 0, col: 0, count: 1 }], rev - 1);
      checkEqual(stale.code, 20006, "revision 落后 → 20006（乐观锁）");
    }
    //#endregion
  } finally {
    server.child.kill("SIGTERM");
    await sleep(200);
    try {
      require("node:fs").rmSync(dbPath, { force: true });
      require("node:fs").rmSync(`${dbPath}-wal`, { force: true });
      require("node:fs").rmSync(`${dbPath}-shm`, { force: true });
    } catch {
      /* 临时库删不掉不影响结论 */
    }
  }

  if (failed > 0) {
    console.log(`\n批量使用 e2e 失败 ${failed} 条：\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`\n批量使用 e2e 全部通过（${passed} 条断言）`);
})();
