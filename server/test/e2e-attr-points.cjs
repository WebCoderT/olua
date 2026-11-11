#!/usr/bin/env node
/**
 * 服务端 e2e：属性点与自由加点（#833 / docs/37 G2）
 *
 * 在此之前全仓搜不到 `attrPoints` / `attrs`：玩家升到 60 级也只有一条「等级给的属性」，
 * 除了练级没有任何养成选择。这一套钉的是这几件事：
 *
 * 一、**建号口径**：`data.attrPoints` = 1、`data.attrs` 四项全 0（用户口径「每级 1 点」）
 * 二、**空请求**：四项都是 0 / 什么都不传 → 20038，且不推 revision
 * 二·五、**非法入参**：负数 / 小数 → 40000（HTTP 400）；白名单外的字段被丢掉（20038），
 *     四种坏请求一条都没写库（issue 验收里的「非法字段返 400」）
 * 三、**加点成功**：四维 +1、余点 −1、revision 原子 +1、存档与回执同步
 * 四、**点数不足**：20037，`details` 带 need / owned，且**一点都没动**
 * 五、**权威边界**：客户端 PUT 存档写 `attrs` / `attrPoints` 会被服务端回填成库里的值
 * 六、**升级给点**：走泡点（服务端自己的经验节拍）升上去，属性点必须**等于等级**
 *     —— 与技能点同一条尺子，也是「总点数 = 等级」这条不变式的唯一证据
 * 七、**四维真的进面板**：把系数调大之后加点，`physicalAttack` 上限 / `maxHp` 必须变大，
 *     洗点后回到基线（不是「字段改了但属性没重算」）
 * 八、**洗点**：四维归零、点数全退、扣绑定元宝；钱不够 20009；没加过点 20039
 * 九、**洗点价格可配**：`attrResetCost = 0` 时免费（价格不写死在代码里）
 * 十、**存量库补发**：老档案没有 `attrPoints` → 按等级补一次；marker 在时重启**不再补**
 *     （否则点完 → 洗点 → 重启，点数又按等级补一遍 = 无限属性点）
 *
 * 数值一律不锁出厂值：系数 / 洗点价格走管理端 PATCH（`growth_scalars` 每拍现查库），
 * 点数用泡点挣、余额用管理端 PATCH 给 —— 不直改库就不会踩「缓存没刷新」那类假红。
 *
 * 走的是 `dist/`，所以前置是 `npm run build`。用法：npm run test:e2e:attr-points
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { saveRole } = require("./lib/role-save.cjs");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/** 四维的键（与服务端 ATTR_KEYS / 客户端 AttrPointKey 逐项一致） */
const ATTR_KEYS = ["str", "agi", "vit", "spi"];

//#region 断言小工具（与 e2e-skill-upgrade 同款口径）

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

async function waitFor(label, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(100);
  }
  check(false, `${label}（等待超时）`);
  return last;
}

//#endregion

//#region 库直读

/** 打开临时库做一件事（`busy_timeout` 让这次读等服务端放锁，避免 CI 上偶发 locked） */
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

/** 读库里的四维与余点（断言「服务端真的落库了」，不看 HTTP 回执的自述） */
function readAttrsInDb(dbPath, roleId) {
  return withDb(dbPath, (db) => {
    const row = db.prepare("SELECT revision, level, data FROM roles WHERE id = ?").get(roleId);
    if (!row) return null;
    let data = {};
    try {
      data = JSON.parse(row.data);
    } catch {
      /* 坏档不是这一套要修的 */
    }
    const attrs = {};
    for (const key of ATTR_KEYS) attrs[key] = Math.max(0, Math.floor(Number((data.attrs || {})[key]) || 0));
    return {
      revision: Number(row.revision),
      level: Number(row.level),
      attrs,
      attrPoints: Math.max(0, Math.floor(Number(data.attrPoints) || 0)),
      bindGold: Math.max(0, Math.floor(Number(data.bindGold) || 0)),
      physicalAttackMax: Number((data.physicalAttack || [0, 0])[1]) || 0,
      maxHp: Number(data.maxHp) || 0,
    };
  });
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
      ADMIN_REGISTER_CODE: "test-admin-code",
      JWT_SECRET: "e2e-attr-points-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      WORLD_RESPAWN_MS: "600000",
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
  try {
    // `status` 一起带回来：业务码只说「错在哪」，issue #833 的验收还要求
    // 「非法入参返 400」，那是 HTTP 层的事（40000 由 AllExceptionsFilter 映射成 400）
    return { ...(await response.json()), status: response.status };
  } catch {
    return null;
  }
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-attr-points-${Date.now()}.db`);
  // `let`：第九段要重启一次服务（存量库补发只有在「启动时」才会跑）
  let server = await startServer(dbPath);
  try {
    const { baseUrl } = server;

    //#region 〇、准备

    group("准备：管理员 / 玩家 / 角色");
    const superAdmin = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "gm_attr", password: "pass1234", registerCode: "test-admin-code" },
    });
    const adminToken = superAdmin.data && superAdmin.data.token;
    check(superAdmin.code === 0 && !!adminToken, "准备：注册管理员拿到令牌", superAdmin.message);

    const registered = await api(baseUrl, "POST", "auth/register", { body: { username: "attr_player", password: "pass1234" } });
    const token = registered.data && registered.data.token;
    const created = await api(baseUrl, "POST", "roles", { token, body: { name: "加点者", occupation: "1", sex: "1" } });
    const roleId = created.data && created.data.id;
    check(!!(token && roleId), "准备：账号与角色已建好", created.message);

    /** 读角色当前状态（含存档与 revision） */
    const readRole = async () => (await api(baseUrl, "GET", `roles/${roleId}`, { token })).data;

    /** 加点（写接口：revision 必填） */
    const allocate = async (delta, revision) => {
      const rev = revision === undefined ? (await readRole()).revision : revision;
      return api(baseUrl, "POST", `roles/${roleId}/attrs/allocate`, { token, body: { ...delta, revision: rev } });
    };
    /** 洗点（写接口：revision 必填） */
    const reset = async (revision) => {
      const rev = revision === undefined ? (await readRole()).revision : revision;
      return api(baseUrl, "POST", `roles/${roleId}/attrs/reset`, { token, body: { revision: rev } });
    };
    /** 管理端改一个成长标量（服务端每拍现查库，改完即生效） */
    const setScalar = (key, value) =>
      api(baseUrl, "PATCH", `admin/growth-scalars/${key}`, { token: adminToken, body: { value } });

    //#endregion

    //#region 一、建号口径

    group("一、建号口径：属性点 1 点、四维全 0");
    const fresh = await readRole();
    checkEqual(fresh.data.attrPoints, 1, "新角色带 1 点属性点（每级 1 点，1 级 = 1 点）");
    check(!!fresh.data.attrs && typeof fresh.data.attrs === "object", "存档里有 attrs 对象（面板不用兜底）", JSON.stringify(fresh.data.attrs));
    check(
      ATTR_KEYS.every((key) => Number(fresh.data.attrs[key]) === 0),
      "四维四项都是 0（新号不预分配）",
      JSON.stringify(fresh.data.attrs),
    );

    //#endregion

    //#region 二、空请求

    group("二、空请求：四项都没加 → 20038，且不推 revision");
    const empty = await allocate({});
    checkEqual(empty.code, 20038, "一次一点都没加 → 20038", empty.message);
    checkEqual(empty.data, null, "失败响应 data 恒为 null");
    const zeroed = await allocate({ str: 0, agi: 0, vit: 0, spi: 0 });
    checkEqual(zeroed.code, 20038, "四项显式传 0 同样是 20038", zeroed.message);
    checkEqual(readAttrsInDb(dbPath, roleId).revision, fresh.revision, "空请求不推 revision（否则每点一次就撞一次乐观锁）");

    //#endregion

    //#region 二·五、非法入参

    group("二·五、非法入参：负数 / 小数一律 400，白名单外的字段被丢掉");
    const negative = await allocate({ str: -1 });
    checkEqual(negative.code, 40000, "力量传 -1 → 40000（校验失败）", negative.message);
    checkEqual(negative.status, 400, "40000 走 HTTP 400（不是 500 / 200）");
    const fractional = await allocate({ agi: 1.5 });
    checkEqual(fractional.code, 40000, "敏捷传 1.5 → 40000（只收整数点）", fractional.message);
    const unknownKey = await allocate({ luck: 5 });
    checkEqual(unknownKey.code, 20038, "白名单外的字段（luck）被丢掉，等于什么都没加 → 20038", unknownKey.message);
    checkEqual(unknownKey.status, 400, "20038「一点都没加」也是 HTTP 400");
    checkEqual(readAttrsInDb(dbPath, roleId).revision, fresh.revision, "上面三次都没写库（四维与 revision 一点没动）");

    //#endregion

    //#region 三、加点成功

    group("三、加点成功：力量 +1，余点 1 → 0");
    const first = await allocate({ str: 1 });
    checkEqual(first.code, 0, "加点放行", first.message);
    checkEqual(first.data.attrs.str, 1, "回执里的四维已经是 1（客户端整份照搬就够）");
    check(ATTR_KEYS.every((key) => key === "str" || first.data.attrs[key] === 0), "其它三项仍是 0（只加被点名的那一项）", JSON.stringify(first.data.attrs));
    checkEqual(first.data.attrPoints, 0, "余点 1 − 1 = 0");
    checkEqual(first.data.spent, 1, "本次消耗 1 点");
    checkEqual(first.data.refund, 0, "加点不退还");
    checkEqual(first.data.cost, 0, "加点不花绑定元宝");
    checkEqual(first.data.revision, fresh.revision + 1, "revision 原子 +1");

    const afterFirst = readAttrsInDb(dbPath, roleId);
    checkEqual(afterFirst.attrs.str, 1, "库里落的是 1 点力量（不是只改了回执）");
    checkEqual(afterFirst.attrPoints, 0, "库里的余点已扣干净");
    checkEqual(afterFirst.revision, fresh.revision + 1, "库里的 revision 也是 +1");

    //#endregion

    //#region 四、点数不足

    group("四、点数不足：20037，且一点都没动");
    const poor = await allocate({ vit: 2 });
    checkEqual(poor.code, 20037, "余点 0 时加 2 点 → 20037", poor.message);
    check(!!poor.details && poor.details.need === 2 && poor.details.owned === 0, "details 带 need / owned（客户端据此提示差额）", JSON.stringify(poor.details));
    checkEqual(poor.data, null, "失败响应 data 恒为 null");
    const afterPoor = readAttrsInDb(dbPath, roleId);
    checkEqual(afterPoor.attrs.vit, 0, "失败不加点（体质还是 0）");
    checkEqual(afterPoor.revision, afterFirst.revision, "失败不推 revision");

    //#endregion

    //#region 五、权威边界

    group("五、权威边界：PUT 存档改不了四维与余点");
    const beforeSave = await readRole();
    const tampered = {
      ...beforeSave.data,
      attrPoints: 999,
      attrs: { str: 99, agi: 99, vit: 99, spi: 99 },
    };
    const saved = await saveRole((method, route, options) => api(baseUrl, method, route, options), token, roleId, tampered);
    checkEqual(saved && saved.code, 0, "带改过的四维存档（结构合法，服务端放行）", saved && saved.message);
    checkEqual(Number(saved.data.data.attrPoints), 0, "余点被回填成库里的 0（改包白拿不到点）");
    checkEqual(Number(saved.data.data.attrs.str), 1, "力量被回填成库里的 1（改包白拿不到面板）");
    checkEqual(Number(saved.data.data.attrs.agi), 0, "敏捷被回填成库里的 0");
    checkEqual(Number(saved.data.data.attrs.spi), 0, "精神被回填成库里的 0");

    //#endregion

    //#region 六、升级给点

    group("六、升级给点：泡点升几级，属性点必须等于等级");
    // 泡点走服务端自己的经验节拍（与击杀共用 settleLevelUp），每拍现查库 → 改完即生效
    const soakRate = await setScalar("soakExpPerTick", 200000);
    checkEqual(soakRate && soakRate.code, 0, "准备：打开泡点（每拍 20 万经验）", soakRate && soakRate.message);
    const soakTick = await setScalar("soakTickSeconds", 1);
    checkEqual(soakTick && soakTick.code, 0, "准备：拍间隔 1 秒", soakTick && soakTick.message);

    const leveled = await waitFor(
      "泡点把角色顶上去",
      async () => {
        const role = await readRole();
        return role && role.level > 1 ? role : null;
      },
      20_000,
    );
    check(!!(leveled && leveled.level > 1), "角色升级了（泡点与击杀同一套结算）", leveled && `level=${leveled.level}`);
    // 再等一拍：升级是「每拍入账」的，断言前先让它把最后一拍也写完
    await sleep(1_200);
    const afterLevel = await readRole();
    // 不变式是「**余点 + 已分配 = 等级**」，不是「余点 = 等级」——
    // 前面几段已经花掉 1 点力量，拿余点直接比等级会差 1（这条口径本身就说明加点真的扣了）
    const allotted = ATTR_KEYS.reduce((sum, key) => sum + Math.max(0, Math.floor(Number(afterLevel.data.attrs?.[key]) || 0)), 0);
    checkEqual(
      Number(afterLevel.data.attrPoints) + allotted,
      afterLevel.level,
      "余点 + 已分配 = 等级（建号 1 点 + 每级 1 点；这是「总点数 = 等级」的唯一证据）",
    );
    checkEqual(Number(afterLevel.data.skillPoints), afterLevel.level, "技能点也是同一个数（两条线同频，别一边多一边少）");
    // 泡点的活干完了：关掉它。不关的话后面「加点后面板变大」「洗点后回到基线」都会
    // 混进「还在升级」带来的增长，断言就说不清是谁变的
    const soakOff = await setScalar("soakExpPerTick", 0);
    checkEqual(soakOff && soakOff.code, 0, "准备：关掉泡点（后面的面板断言只看四维）", soakOff && soakOff.message);

    //#endregion

    //#region 七、四维真的进面板

    group("七、四维真的进面板：系数调大后加点，物攻上限与生命上限都要变大");
    // 系数调大是为了让「1 点」在面板上看得见：出厂 0.5% 在 60 级也只是几百点，
    // 而这里要证明的是**链路通**，不是某个具体数值
    const ratio = await setScalar("attrPointRatio", 0.5);
    checkEqual(ratio && ratio.code, 0, "准备：每点系数调到 0.5（500%）", ratio && ratio.message);

    const panelBefore = readAttrsInDb(dbPath, roleId);
    /** 把余点全砸进一项（一一点，因为界面就是「+」） */
    const dumpAll = async (key) => {
      let role = await readRole();
      let guard = 0;
      while (Number(role.data.attrPoints) > 0 && guard < 200) {
        const spent = await allocate({ [key]: 1 });
        if (!spent || spent.code !== 0) throw new Error(`加点失败：${spent && spent.message}`);
        role = await readRole();
        guard += 1;
      }
      return role;
    };

    const dumped = await dumpAll("vit");
    check(Number(dumped.data.attrs.vit) > 0, "点数全砸进了体质", `vit=${dumped.data.attrs.vit}`);
    const panelAfter = readAttrsInDb(dbPath, roleId);
    check(
      panelAfter.maxHp > panelBefore.maxHp,
      "生命上限真的变大了（体质进了属性聚合，不是只改了存档字段）",
      `${panelBefore.maxHp} → ${panelAfter.maxHp}`,
    );
    // 物防：体质同时放大它；曲线下限 = 上限 × 0.7，两端一起放大
    const dumpedStr = await allocate({ str: 1 });
    checkEqual(dumpedStr.code, 20037, "点数已经花光，再点力量 → 20037（余点是真的在服务端算的）", dumpedStr.message);

    //#endregion

    //#region 八、洗点

    group("八、洗点：钱不够 20009 / 够了就归零退点 / 没加过点 20039");
    const noMoney = await reset();
    checkEqual(noMoney.code, 20009, "绑定元宝为 0 时洗点 → 20009（与成长线升级同码，不是商城的 20011）", noMoney.message);
    checkEqual(readAttrsInDb(dbPath, roleId).attrs.vit, dumped.data.attrs.vit, "钱不够时四维一点没动");

    const rich = await api(baseUrl, "PATCH", `admin/roles/${roleId}`, { token: adminToken, body: { bindGold: 10000 } });
    checkEqual(rich && rich.code, 0, "准备：给 1 万绑定元宝", rich && rich.message);

    const beforeReset = readAttrsInDb(dbPath, roleId);
    const pointSum = beforeReset.attrs.str + beforeReset.attrs.agi + beforeReset.attrs.vit + beforeReset.attrs.spi;
    const resetResult = await reset();
    checkEqual(resetResult.code, 0, "洗点放行", resetResult.message);
    check(
      ATTR_KEYS.every((key) => resetResult.data.attrs[key] === 0),
      "回执里的四维已归零",
      JSON.stringify(resetResult.data.attrs),
    );
    checkEqual(resetResult.data.refund, pointSum, "退还的点数 = 洗点前四维之和");
    checkEqual(resetResult.data.spent, 0, "洗点不消耗属性点");
    checkEqual(
      resetResult.data.attrPoints,
      Number((await readRole()).data.attrPoints),
      "回执的余点与存档一致（客户端照搬即可）",
    );
    checkEqual(resetResult.data.cost, 500, "洗点花了出厂价 500（`growth_scalars.attrResetCost`）");

    const afterReset = readAttrsInDb(dbPath, roleId);
    check(
      ATTR_KEYS.every((key) => afterReset.attrs[key] === 0),
      "库里四维已归零",
      JSON.stringify(afterReset.attrs),
    );
    checkEqual(afterReset.attrPoints, pointSum, "点数全退（余点 = 洗点前四维之和）");
    checkEqual(afterReset.bindGold, beforeReset.bindGold - 500, "绑定元宝扣了 500（扣钱与归零在同一次写档里）");
    check(
      afterReset.maxHp <= beforeReset.maxHp,
      "面板跟着回到基线（生命上限降回去了，说明重算真的跑了）",
      `${beforeReset.maxHp} → ${afterReset.maxHp}`,
    );

    const nothing = await reset();
    checkEqual(nothing.code, 20039, "四维全 0 时再洗 → 20039（不白扣一次钱）", nothing.message);

    //#endregion

    //#region 九、价格可配

    group("九、洗点价格可配：`attrResetCost = 0` 时免费");
    const free = await setScalar("attrResetCost", 0);
    checkEqual(free && free.code, 0, "准备：洗点价格改成 0", free && free.message);
    const spentOneMore = await allocate({ spi: 1 });
    checkEqual(spentOneMore && spentOneMore.code, 0, "准备：再花 1 点（没有点可洗时洗点会被 20039 拒掉）", spentOneMore && spentOneMore.message);
    const freeReset = await reset();
    checkEqual(freeReset.code, 0, "免费洗点放行", freeReset.message);
    checkEqual(freeReset.data.cost, 0, "回执里的花费是 0（价格读库，不是写死的 500）");
    checkEqual(readAttrsInDb(dbPath, roleId).bindGold, afterReset.bindGold, "绑定元宝一点没扣");

    //#endregion

    //#region 十、存量库补发

    group("十、存量库补发：老档案没有 attrPoints → 按等级补一次，重启不重复补");
    /**
     * 造一个「#833 之前的老号」：删掉存档里的 `attrPoints`、等级摆到 7，
     * 并把一次性迁移的 marker 一起清掉 —— 模拟「第一次升到这一版」。
     */
    const makeLegacyRole = (clearMarker) =>
      withDb(dbPath, (db) => {
        const current = db.prepare("SELECT data FROM roles WHERE id = ?").get(roleId);
        const data = JSON.parse(current.data);
        delete data.attrPoints;
        db.prepare("UPDATE roles SET data = ?, level = 7 WHERE id = ?").run(JSON.stringify(data), roleId);
        if (clearMarker) db.prepare("DELETE FROM config_meta WHERE key = 'attr_points_seeded'").run();
      });

    const restart = async () => {
      server.child.kill("SIGTERM");
      await waitFor("旧进程退出", async () => (server.child.exitCode !== null || server.child.signalCode ? true : null), 10_000);
      server = await startServer(dbPath);
      return server.baseUrl;
    };

    // 泡点在第六段末尾已经关掉：补发前后等级不会再被经验节拍改写，断言只看补发这一件事

    await makeLegacyRole(true);
    const url2 = await restart();
    const granted = await api(url2, "GET", `roles/${roleId}`, { token });
    checkEqual(granted.code, 0, "补发后角色详情可读", granted.message);
    checkEqual(granted.data.level, 7, "角色还是 7 级（补发不动等级列）");
    checkEqual(Number(granted.data.data.attrPoints), 7, "补发的点数 = 等级（每级 1 点，与新号口径一致）");
    check(
      Number(granted.data.data.attrs?.str || 0) === 0 && Number(granted.data.data.attrs?.vit || 0) === 0,
      "补的是「可分配点数」，不会替玩家加到某一项上",
      JSON.stringify(granted.data.data.attrs),
    );

    // 反证：marker 在的时候重启不再补 —— 否则点完洗点再重启，点数又按等级补一遍
    await makeLegacyRole(false);
    const url3 = await restart();
    const notGranted = await api(url3, "GET", `roles/${roleId}`, { token });
    checkEqual(typeof notGranted.data.data.attrPoints, "undefined", "marker 已存在时重启不再补发（点数仍是缺省）");

    //#endregion

    console.log(`\n${failed === 0 ? "✅" : "❌"} 属性点：${passed} 条通过 / ${failed} 条失败`);
    if (failed > 0) {
      console.log("\n失败项：");
      failures.forEach((item) => console.log(`  - ${item}`));
      console.log("\n服务端日志（尾部）：");
      console.log(server.logs().split("\n").slice(-30).join("\n"));
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (server.child.exitCode === null && !server.child.signalCode) {
      server.child.kill("SIGTERM");
      await sleep(300);
      if (server.child.exitCode === null && !server.child.signalCode) server.child.kill("SIGKILL");
    }
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
})();
