/**
 * 背包与穿戴 e2e（#556）
 *
 * 钉的是「背包和装备从客户端手里收回来」这条线 —— 收权只有一条判据：
 * **客户端说什么都不算，服务端按库里的样子算**。所以每一段都成对：
 * 一个「正常操作成功」，紧跟一个「改包/越界被拒且存档不动」。
 *
 * 〇、准备：一个 1 级角色（#597 起建号背包为空，四样物品由管理端 PATCH 注入，网格被撑到 2×5）
 * 一、穿戴：装备离包、进槽位、属性**当场重算**（maxHp = 裸模 100 + 衣服 60）
 * 二、等级门槛：穿 10 级衣服 → 20021，且东西还在包里
 * 三、换装：旧装备回到刚腾出的那一格（格数守恒），属性跟着换成新衣服的
 * 四、卸下：服务端自己找第一个空格，属性回落到裸模
 * 五、丢弃：整格清空；空格子 → 20020
 * 六、整理 / 搬运：只验守恒 —— 多一件、少一件都 → 20022，守恒排布照收
 * 七、权威边界：把 bag / equipments / skills 塞进存档（PUT）→ 全部按库里的值回填
 * 八、网格尺寸：bag 的尺寸归客户端配置（改大能长个，内容不丢）
 * 九、乐观锁与归属：错 revision → 20006；别人的角色 → 40300
 * 十、装备堆叠（#837）：「装备任何情况下不允许重叠」—— 纯函数级拆散 + 管理端创建侧堵死
 * 十一、单格上限（#841/#842）：maxStack 按物品所属表读（money 999 / drug 99），搬运不许超
 * 十二、管理端 PATCH（#836）：部位与存在性校验、属性当场重算、背包元数据认领与超叠拦截
 *
 * 走的是 `dist/`，所以前置是 `npm run build`。
 * 用法：npm run test:e2e:bag
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

/** 管理员注册码（提等级要用；等级只能走管理端，见 #550 / #554） */
const ADMIN_CODE = "e2e-bag-admin";

//#region 断言小工具（与 e2e-sell 同款口径）


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
      JWT_SECRET: "e2e-bag-secret",
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

/**
 * 开局注入的四格物品（#597 起建号背包为空，造状态只能走管理端 PATCH）
 *
 * · (0,0) cloth_1   1 级衣服：验证穿戴成功 + 属性重算
 * · (0,4) cloth_10  10 级衣服：验证等级门槛（1 级穿不上）与换装
 * · (1,0)/(1,1) 两样材料：整理 / 搬运的守恒对象
 *
 * 稀疏格子会把空网格扩到刚好放下 → 网格是 2 行 × 5 列，不是客户端的 4×10。
 */
const BAG_SEED_CELLS = [
  { row: 0, col: 0, id: "cloth_1", count: 1 },
  { row: 0, col: 4, id: "cloth_10", count: 1 },
  { row: 1, col: 0, id: "material_hide", count: 2 },
  { row: 1, col: 1, id: "material_iron", count: 1 },
];

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

/** 背包 → 稀疏格子（整理 / 搬运提交的形状） */
function sparseCells(bag) {
  const cells = [];
  (bag || []).forEach((line, row) =>
    (line || []).forEach((cell, col) => {
      if (cell) cells.push({ row, col, id: cell.id, count: Math.max(1, Math.floor(cell.count) || 1) });
    }),
  );
  return cells;
}

/** 把一串物品按行优先铺开，返回稀疏格子（造「换了个顺序」的排布用） */
function layoutCells(items, cols = 10) {
  return items.map((item, index) => ({
    row: Math.floor(index / cols),
    col: index % cols,
    id: item.id,
    count: item.count,
  }));
}

/** 注册并登录一个管理员（提等级要 `ROLE_WRITE`） */
async function registerAdmin(baseUrl, username, password) {
  await api(baseUrl, "POST", "admin/auth/register", { body: { username, password, registerCode: ADMIN_CODE } });
  const login = await api(baseUrl, "POST", "admin/auth/login", { body: { zoneId: ADMIN_ZONE, username, password } });
  return login.data && login.data.token;
}

/** 属性与门槛的出厂值来源：配置快照（#655 后数据只有库里一份，快照是它的逐行投影） */
const snap = require("./lib/config-snapshot.cjs");
/** 裸模血量逐级不同 —— 等级曲线的 `hp` 那一条决定它，别拿 1 级那份去比 10 级 */
const BARE_MAX_HP = snap.curveValue("hp", 1);
const BARE_MAX_HP_AT_10 = snap.curveValue("hp", 10);
/** 装备属性也在库里逐条展开（基础件 = 前后缀都为 0 的那一行） */
const equipBases = snap.index("equipments");
const CLOTH_1_MAX_HP = equipBases["cloth_1"].maxHp;
const CLOTH_10_MAX_HP = equipBases["cloth_10"].maxHp;

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-bag-${Date.now()}.db`);
  const server = await startServer(dbPath);
  let serverChild = null;
  try {
    const { baseUrl } = server;
    serverChild = server.child;

    //#region 〇、准备

    group("准备：玩家与角色");
    const registered = await api(baseUrl, "POST", "auth/register", { body: { username: "bag_player", password: "pass1234" } });
    const token = registered.data && registered.data.token;
    const created = await api(baseUrl, "POST", "roles", { token, body: { name: "背包客", occupation: "1", sex: "1" } });
    const roleId = created.data && created.data.id;
    check(created.code === 0 && created.data.online === true, "准备：角色已创建并自动在线", created.message);
    const adminToken = await registerAdmin(baseUrl, "bag_admin", "Admin#123456");
    check(!!adminToken, "准备：管理员已登录（造状态 / 提等级只有这条路）");
    const seeded = await api(baseUrl, "PATCH", `admin/roles/${roleId}`, { token: adminToken, zoneId: ADMIN_ZONE, body: { bag: BAG_SEED_CELLS } });
    check(seeded.code === 0, "准备：管理端把四样物品注入背包", seeded.message);
    const snapshot = await api(baseUrl, "GET", `roles/${roleId}`, { token });
    checkEqual(countInBag(snapshot.data.data.bag, "cloth_1"), 1, "准备：背包里有一件 cloth_1（1 级衣服）");

    const other = await api(baseUrl, "POST", "auth/register", { body: { username: "bag_other", password: "pass1234" } });
    const otherToken = other.data && other.data.token;

    //#endregion

    //#region 一、穿戴：离包、进槽位、属性当场重算

    group("一、穿戴（服务端自己算）");
    const equipped = await api(baseUrl, "POST", `roles/${roleId}/bag-op`, { token, body: { action: "equip", row: 0, col: 0, revision: await revOf(baseUrl, roleId, token) } });
    check(equipped.code === 0, "穿上背包第一格的衣服", equipped.message);
    checkEqual(equipped.data.slot, "cloth", "响应带回本次涉及的槽位（客户端据此刷新内观）");
    // #816 起槽位存 `{ id, bound?, from? }` 对象，不是裸 id
    checkEqual((equipped.data.data.equipments.cloth || {}).id, "cloth_1", "槽位里是这件衣服（槽位值是对象，id 指向它）");
    check(
      typeof equipped.data.data.equipments.cloth === "object" && !Array.isArray(equipped.data.data.equipments.cloth),
      "槽位值是对象而不是裸字符串（#816 的存档形状）",
      JSON.stringify(equipped.data.data.equipments.cloth),
    );
    checkEqual(cellAt(equipped.data.data.bag, 0, 0), null, "那一格已经空了（装备离包）");
    checkEqual(
      equipped.data.data.maxHp,
      BARE_MAX_HP + CLOTH_1_MAX_HP,
      "属性当场重算（裸模 maxHp + 衣服，不是客户端报的那份）",
    );

    //#endregion

    //#region 二、等级门槛

    group("二、等级门槛（1 级穿 10 级衣服）");
    const tooHigh = await api(baseUrl, "POST", `roles/${roleId}/bag-op`, { token, body: { action: "equip", row: 0, col: 4, revision: await revOf(baseUrl, roleId, token) } });
    checkEqual(tooHigh.code, 20021, "等级不够 → 20021（穿不上）");
    const afterTooHigh = await api(baseUrl, "GET", `roles/${roleId}`, { token });
    checkEqual(countInBag(afterTooHigh.data.data.bag, "cloth_10"), 1, "被拒之后那件衣服还在包里");
    const emptyCell = await api(baseUrl, "POST", `roles/${roleId}/bag-op`, { token, body: { action: "equip", row: 3, col: 9, revision: await revOf(baseUrl, roleId, token) } });
    checkEqual(emptyCell.code, 20020, "空格子 → 20020（目标不合法）");

    //#endregion

    //#region 三、换装：旧装备回到刚腾出的格子

    group("三、换装（格数守恒）");
    const raised = await api(baseUrl, "PATCH", `admin/roles/${roleId}`, { token: adminToken, zoneId: ADMIN_ZONE, body: { level: 10 } });
    checkEqual(raised.code, 0, "管理端把等级提到 10（提级是管理端特权）");
    const swapped = await api(baseUrl, "POST", `roles/${roleId}/bag-op`, { token, body: { action: "equip", row: 0, col: 4, revision: await revOf(baseUrl, roleId, token) } });
    check(swapped.code === 0, "穿上 10 级衣服（把身上的换下来）", swapped.message);
    checkEqual((swapped.data.data.equipments.cloth || {}).id, "cloth_10", "槽位换成了新衣服");
    // 旧衣服回到「刚腾出来的那一格」—— 也就是新衣服原来所在的 (0,4)
    checkEqual((cellAt(swapped.data.data.bag, 0, 4) || {}).id, "cloth_1", "旧装备回到刚腾出的格子（换装不吞装备）");
    checkEqual(
      swapped.data.data.maxHp,
      BARE_MAX_HP_AT_10 + CLOTH_10_MAX_HP,
      "属性跟着换成新衣服那份",
    );

    //#endregion

    //#region 四、卸下

    group("四、卸下（服务端自己找第一个空格）");
    const unequipped = await api(baseUrl, "POST", `roles/${roleId}/bag-op`, { token, body: { action: "unequip", slot: "cloth", revision: await revOf(baseUrl, roleId, token) } });
    check(unequipped.code === 0, "脱下衣服", unequipped.message);
    checkEqual(unequipped.data.data.equipments.cloth, null, "槽位清空（对象形式下也是 null）");
    checkEqual(cellAt(unequipped.data.data.bag, 0, 0).id, "cloth_10", "落点是第一个空格（0,0）");
    checkEqual(unequipped.data.data.maxHp, BARE_MAX_HP_AT_10, "属性回落到裸模（10 级那条曲线）");

    //#endregion

    //#region 五、丢弃

    group("五、丢弃（整格清空，不返还）");
    const discarded = await api(baseUrl, "POST", `roles/${roleId}/bag-op`, { token, body: { action: "discard", row: 0, col: 0, revision: await revOf(baseUrl, roleId, token) } });
    check(discarded.code === 0, "丢掉第一格的装备", discarded.message);
    checkEqual(cellAt(discarded.data.data.bag, 0, 0), null, "那一格空了");
    const discardEmpty = await api(baseUrl, "POST", `roles/${roleId}/bag-op`, { token, body: { action: "discard", row: 3, col: 9, revision: await revOf(baseUrl, roleId, token) } });
    checkEqual(discardEmpty.code, 20020, "丢空格子 → 20020");

    //#endregion

    //#region 六、整理 / 搬运：只验守恒

    group("六、整理 / 搬运（只验守恒）");
    const current = await api(baseUrl, "GET", `roles/${roleId}`, { token });
    const bagNow = current.data.data.bag;

    // 多一件：把 material_hide 从 2 改成 3 报上去
    const inflated = sparseCells(bagNow).map((cell) =>
      cell.id === "material_hide" ? { ...cell, count: cell.count + 1 } : cell,
    );
    const cheatMore = await api(baseUrl, "POST", `roles/${roleId}/bag-op`, { token, body: { action: "tidy", cells: inflated, revision: await revOf(baseUrl, roleId, token) } });
    checkEqual(cheatMore.code, 20022, "凭空多一件 → 20022（内容对不上）");

    // 少一件：把它整个删掉
    const missing = sparseCells(bagNow).filter((cell) => cell.id !== "material_hide");
    const cheatLess = await api(baseUrl, "POST", `roles/${roleId}/bag-op`, { token, body: { action: "move", cells: missing, revision: await revOf(baseUrl, roleId, token) } });
    checkEqual(cheatLess.code, 20022, "少一件 → 20022");

    // 守恒排布：把内容**倒过来**铺一遍（顺序变了、件数一件没变）
    const cellsNow = sparseCells(bagNow);
    const reversed = layoutCells([...cellsNow].reverse());
    const tidyCall = await api(baseUrl, "POST", `roles/${roleId}/bag-op`, { token, body: { action: "tidy", cells: cellsNow, revision: await revOf(baseUrl, roleId, token) } });
    check(tidyCall.code === 0, "守恒排布照收（整理只看件数守恒）", tidyCall.message);
    const moved = await api(baseUrl, "POST", `roles/${roleId}/bag-op`, { token, body: { action: "move", cells: reversed, revision: await revOf(baseUrl, roleId, token) } });
    checkEqual((cellAt(moved.data.data.bag, 0, 0) || {}).id, reversed[0].id, "位置真的按客户端那份排布改了（内容还是那几件）");
    checkEqual(countInBag(moved.data.data.bag, "material_hide"), 2, "整理 / 搬运之后材料一件不少");

    //#endregion

    //#region 七、权威边界：存档写不进背包 / 装备 / 技能

    group("七、权威边界（PUT 存档改不动背包与穿戴）");
    const fresh = await api(baseUrl, "GET", `roles/${roleId}`, { token });
    const tampered = JSON.parse(JSON.stringify(fresh.data.data));
    // ① 往背包里塞一件 28 级顶级衣服（网格是 2×5，(1,4) 是空格）
    tampered.bag[1][4] = { id: "cloth_17", count: 1 };
    // ② 直接把衣服穿上（不走接口）
    tampered.equipments = { ...(tampered.equipments || {}), cloth: "cloth_17" };
    // ③ 技能全点满
    tampered.skills = { 1000: 99 };
    const saved = await api(baseUrl, "PUT", `roles/${roleId}`, { token, body: { data: tampered, revision: fresh.data.revision } });
    check(saved.code === 0, "存档照常受理（回填而不是拒收）", saved.message);
    checkEqual(countInBag(saved.data.data.bag, "cloth_17"), 0, "塞进背包的顶级衣服被回填掉（库里没有就是没有）");
    checkEqual(saved.data.data.equipments.cloth, null, "存档里直接穿的装备被回填成库里的值（当前没穿）");
    checkEqual(saved.data.data.skills[1000], 1, "技能等级被回填成库里的 1 级");

    //#endregion

    //#region 八、网格尺寸归客户端配置

    group("八、网格尺寸（bag 的特例）");
    // 存档不许重排：`adoptBagShape` 早先按行优先把物品「压紧」进新网格，等于每次存档都把
    // 玩家拖好的位置挤回左上角。这里先搬一件到偏后的格子，再存一次档，位置必须原样还在
    const beforeShift = await api(baseUrl, "GET", `roles/${roleId}`, { token });
    const shiftCells = sparseCells(beforeShift.data.data.bag);
    let farSlot = null;
    const gridNow = beforeShift.data.data.bag;
    for (let r = gridNow.length - 1; r >= 0 && !farSlot; r--) {
      for (let c = gridNow[r].length - 1; c >= 0 && !farSlot; c--) if (!gridNow[r][c]) farSlot = { row: r, col: c };
    }
    const shiftLayout = shiftCells.map((cell, index) => (index === 0 ? { ...farSlot, id: cell.id, count: cell.count } : cell));
    const shifted = await api(baseUrl, "POST", `roles/${roleId}/bag-op`, {
      token,
      body: { action: "move", cells: shiftLayout, revision: beforeShift.data.revision },
    });
    checkEqual((cellAt(shifted.data.data.bag, farSlot.row, farSlot.col) || {}).id, shiftCells[0].id, "搬过去的物品落在偏后的格子");
    const reshapedAgain = await api(baseUrl, "PUT", `roles/${roleId}`, { token, body: { data: shifted.data.data, revision: shifted.data.revision } });
    checkEqual(
      (cellAt(reshapedAgain.data.data.bag, farSlot.row, farSlot.col) || {}).id,
      shiftCells[0].id,
      "再存一次档，物品没被挪回左上角（服务端不替玩家整理背包）",
    );
    const beforeResize = await api(baseUrl, "GET", `roles/${roleId}`, { token });
    const wider = JSON.parse(JSON.stringify(beforeResize.data.data));
    // 配置把背包多加一行（行宽随现有网格）：内容取库里的、尺寸取这一次的
    wider.bag = [...wider.bag, Array.from({ length: wider.bag[0].length }, () => null)];
    const resized = await api(baseUrl, "PUT", `roles/${roleId}`, { token, body: { data: wider, revision: beforeResize.data.revision } });
    checkEqual(resized.data.data.bag.length, beforeResize.data.data.bag.length + 1, "背包跟着配置长一行（内容仍取库里的）");
    checkEqual(countInBag(resized.data.data.bag, "material_hide"), 2, "长大个的过程中一件东西都没丢");

    //#endregion

    //#region 九、乐观锁与归属

    group("九、乐观锁与归属");
    const latest = await api(baseUrl, "GET", `roles/${roleId}`, { token });
    const stale = await api(baseUrl, "POST", `roles/${roleId}/bag-op`, {
      token,
      body: { action: "discard", row: 3, col: 3, revision: latest.data.revision - 1 },
    });
    checkEqual(stale.code, 20006, "revision 落后 → 20006");
    // 基线用**属主**的 token 取：这条验的是「越权 → 40300」，不能让它先在取基线那一步
    // 403 掉、把请求退化成「缺 revision 的 400」，那样越权判据就被掩盖了（#820）
    const foreign = await api(baseUrl, "POST", `roles/${roleId}/bag-op`, { token: otherToken, body: { action: "discard", row: 0, col: 0, revision: await revOf(baseUrl, roleId, token) } });
    checkEqual(foreign.code, 40300, "别人的角色 → 40300（越权一律拒绝）");

    //#endregion

    //#region 十、装备堆叠（#837：装备任何情况下都不允许重叠）

    group("十、装备堆叠（#837）");
    // 创建侧全部堵死之后，接口层造不出 count>1 的装备格 —— 「拆散」修复的是史前老档 /
    // 改包直改库的历史脏数据，只有纯函数层能构造这个输入（e2e-map 先例：直接调 dist 纯函数）
    const inv = require(path.join(SERVER_DIR, "dist", "modules", "roles", "role-inventory.js"));
    const emptyGrid = () => Array.from({ length: 2 }, () => Array.from({ length: 5 }, () => null));

    // ① 一格 3 件 → 穿走一件，其余两件各占一格（元数据原样跟着走）
    const stackedGrid = emptyGrid();
    stackedGrid[0][0] = { id: "cloth_1", count: 3, bound: true, from: { monster: "m1", at: 1 } };
    const stackedWorn = {};
    const replacedId = inv.equipAt(stackedGrid, stackedWorn, 0, 0, "cloth");
    checkEqual(replacedId, null, "纯函数：槽位原本是空的（没有换下来的）");
    check(
      stackedWorn.cloth && stackedWorn.cloth.id === "cloth_1" && stackedWorn.cloth.bound === true && !!stackedWorn.cloth.from,
      "纯函数：穿走的那件连 bound / from 一起进槽位",
      JSON.stringify(stackedWorn.cloth),
    );
    const stackedCells = stackedGrid.flat().filter((cell) => cell && cell.id === "cloth_1");
    check(
      stackedCells.length === 2 && stackedCells.every((cell) => cell.count === 1),
      "纯函数：剩余两件被拆散，各占一格（背包里不存在 count>1 的装备格）",
      JSON.stringify(stackedCells),
    );
    check(
      stackedCells.every((cell) => cell.bound === true && !!cell.from),
      "纯函数：拆出来的每一件都带着 bound / from（元数据不因拆散丢失）",
      JSON.stringify(stackedCells),
    );

    // ② count=1 的正常穿戴不变（换下来的旧装备回到刚腾出的那一格）
    const normalGrid = emptyGrid();
    normalGrid[0][0] = { id: "cloth_1", count: 1 };
    const wornOld = { cloth: { id: "cloth_10" } };
    const normalReplaced = inv.equipAt(normalGrid, wornOld, 0, 0, "cloth");
    checkEqual(normalReplaced, "cloth_10", "纯函数：换下来的是 10 级衣服");
    checkEqual((normalGrid[0][0] || {}).id, "cloth_10", "纯函数：旧装备回到刚腾出的那一格（原有语义不变）");

    // ③ 空格不够拆 → 整步失败（20012），绝不把「装备叠在一格」写回存档
    const crowdedGrid = emptyGrid();
    for (let i = 0; i < 9; i++) crowdedGrid[Math.floor(i / 5)][i % 5] = { id: "cloth_1", count: 1 };
    crowdedGrid[1][4] = { id: "cloth_1", count: 3 };
    let crowdedError = null;
    try {
      inv.equipAt(crowdedGrid, {}, 1, 4, "cloth");
    } catch (error) {
      crowdedError = error;
    }
    check(
      !!crowdedError && /背包已满/.test(String(crowdedError.message || "")),
      "纯函数：空格不够拆散 → 20012 背包已满（操作整体失败）",
      String(crowdedError && crowdedError.message),
    );

    // ④ 接口层：创建侧堵死 —— 管理端 PATCH 塞 count>1 的装备直接 20003（#836 的超叠拦截）
    const stackedRole = await api(baseUrl, "POST", "roles", { token, body: { name: "背包客二", occupation: "1", sex: "1" } });
    const stackedRoleId = stackedRole.data && stackedRole.data.id;
    check(stackedRole.code === 0, "准备：第二个角色已创建", stackedRole.message);
    // 建号只把**第一个**角色置为在线；后面这段要对角色二做背包操作，先把它选成在线角色
    //（bagOp 有「在线角色才能改背包」的闸，不选就是 20007）
    const selected2 = await api(baseUrl, "POST", `roles/${stackedRoleId}/select`, { token });
    checkEqual(selected2.code, 0, "准备：角色二已选为在线角色");
    const cheatSeed = await api(baseUrl, "PATCH", `admin/roles/${stackedRoleId}`, {
      token: adminToken, zoneId: ADMIN_ZONE,
      body: { bag: [{ row: 0, col: 0, id: "cloth_1", count: 3 }] },
    });
    checkEqual(cheatSeed.code, 20003, "管理端塞 count=3 的装备 → 20003（创建侧不允许造出重叠）");
    const afterCheatSeed = await api(baseUrl, "GET", `roles/${stackedRoleId}`, { token });
    checkEqual(countInBag(afterCheatSeed.data.data.bag, "cloth_1"), 0, "被拒的堆叠装备没有落库");

    //#endregion

    //#region 十一、单格上限（#841 按表读 / #842 搬运不许超）

    group("十一、单格上限（#841 / #842）");
    // 货币道具的表值是 999：两格 500+499 能注入（若 maxStack 还按 99 分堆，500 一格早就被拒）
    const moneySeed = await api(baseUrl, "PATCH", `admin/roles/${stackedRoleId}`, {
      token: adminToken, zoneId: ADMIN_ZONE,
      body: { bag: [{ row: 0, col: 0, id: "money_bind_gold_10", count: 500 }, { row: 0, col: 1, id: "money_bind_gold_10", count: 499 }] },
    });
    checkEqual(moneySeed.code, 0, "货币道具 500+499 注入成功（#841：money_items 的 999 生效）", moneySeed.message);
    const moneyMerged = await api(baseUrl, "POST", `roles/${stackedRoleId}/bag-op`, {
      token,
      body: {
        action: "tidy",
        cells: [{ row: 0, col: 0, id: "money_bind_gold_10", count: 999 }],
        revision: await revOf(baseUrl, stackedRoleId, token),
      },
    });
    checkEqual(moneyMerged.code, 0, "合并成一格 999（正好贴着表值上限）通过", moneyMerged.message);
    checkEqual(
      (cellAt(moneyMerged.data.data.bag, 0, 0) || {}).count,
      999,
      "这一格真的装了 999（老实现按 99 早该拒了）",
    );

    // 药品的表值是 99：两格 99+99 守恒没问题，但报成一格 198 超上限 → 20022
    const drugSeed = await api(baseUrl, "PATCH", `admin/roles/${stackedRoleId}`, {
      token: adminToken, zoneId: ADMIN_ZONE,
      body: { bag: [{ row: 0, col: 0, id: "drug_hp_1", count: 99 }, { row: 0, col: 1, id: "drug_hp_1", count: 99 }] },
    });
    checkEqual(drugSeed.code, 0, "药品 99+99 注入成功", drugSeed.message);
    const drugMerged = await api(baseUrl, "POST", `roles/${stackedRoleId}/bag-op`, {
      token,
      body: {
        action: "tidy",
        cells: [{ row: 0, col: 0, id: "drug_hp_1", count: 198 }],
        revision: await revOf(baseUrl, stackedRoleId, token),
      },
    });
    checkEqual(drugMerged.code, 20022, "药品 198 压一格 → 20022（搬运不许造出超上限的格子）");
    const drugAfter = await api(baseUrl, "GET", `roles/${stackedRoleId}`, { token });
    checkEqual(countInBag(drugAfter.data.data.bag, "drug_hp_1"), 198, "总量一件不少（守恒没有被超限检查破坏）");

    // 管理端同样拦：塞 100 瓶一格 → 20003（#836 与玩家同一把尺）
    const adminOver = await api(baseUrl, "PATCH", `admin/roles/${stackedRoleId}`, {
      token: adminToken, zoneId: ADMIN_ZONE,
      body: { bag: [{ row: 0, col: 0, id: "drug_hp_1", count: 100 }] },
    });
    checkEqual(adminOver.code, 20003, "管理端塞 100 瓶一格 → 20003（运营也造不出超上限的格子）");

    //#endregion

    //#region 十二、管理端 PATCH（#836：校验 + 属性重算）

    group("十二、管理端 PATCH（#836）");
    // ① 部位不符：weapon_1 存在，但它是武器不能塞进 cloth 槽
    const wrongSlot = await api(baseUrl, "PATCH", `admin/roles/${stackedRoleId}`, {
      token: adminToken, zoneId: ADMIN_ZONE,
      body: { equipments: { cloth: "weapon_1" } },
    });
    checkEqual(wrongSlot.code, 20003, "PATCH 装备部位不符 → 20003（不再静默落库等清洗）");
    // ② 物品不存在 / 不是装备
    const unknownEquip = await api(baseUrl, "PATCH", `admin/roles/${stackedRoleId}`, {
      token: adminToken, zoneId: ADMIN_ZONE,
      body: { equipments: { cloth: "cloth_99" } },
    });
    checkEqual(unknownEquip.code, 20003, "PATCH 不存在的装备 id → 20003");
    // ③ 合法 PATCH：属性当场重算（运营改装备后面板现算与落库值不再分裂）
    const legitPatch = await api(baseUrl, "PATCH", `admin/roles/${stackedRoleId}`, {
      token: adminToken, zoneId: ADMIN_ZONE,
      body: { equipments: { cloth: "cloth_1" } },
    });
    checkEqual(legitPatch.code, 0, "PATCH 合法装备成功", legitPatch.message);
    checkEqual(
      legitPatch.data.data.maxHp,
      BARE_MAX_HP + CLOTH_1_MAX_HP,
      "PATCH 之后属性当场重算（maxHp = 裸模 + 这件衣服，不是沿用旧值）",
    );
    checkEqual(
      (legitPatch.data.data.equipments.cloth || {}).id,
      "cloth_1",
      "落库的槽位值是对象 { id }（#816 形状）",
    );

    //#endregion

    if (failed > 0) {
      console.log(`\n❌ 背包 e2e：${failed} 项断言不通过`);
      failures.forEach((label) => console.log(`  - ${label}`));
      console.log("\n服务端日志尾部：");
      console.log(server.logs().split("\n").slice(-30).join("\n"));
      process.exitCode = 1;
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
