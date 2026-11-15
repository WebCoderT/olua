#!/usr/bin/env node
/**
 * 运营群发 e2e（server/test/e2e-game-mail-broadcast.cjs，issue #438）
 *
 * 盯的不变量（群发是「一次影响成千上万人」的动作，改邮件写入 / 区上下文 / 权限后必须全绿）：
 *
 * 一、**批次号是幂等的唯一闸门**：同一个 `batchId` 重提返回 `duplicated: true`，
 *    一行都不再写；换一个批次号发同样的内容**照发**（内容不是身份，运营完全可能连发两条一样的）
 * 二、**按区不串**：`scope=zone` 只写当前区（`X-Zone-Id`）的角色，别区角色的收件箱里
 *    没有这个批次的任何一行
 * 三、**等级段是筛子**：给了 `minLevel` 之后，只有达到等级的角色收到（集合相等，
 *    既证明「该来的来了」也证明「不该来的没来」）；两端填反 → 400（40000），不静默发 0 封
 * 四、**「全服」是影响面权限**：`admin` 角色发 `scope=all` 被拒（403 / 30006），且
 *    **一行都没写**（不是「发了一半才被拦」）；预览全服同样被拒（先给人数再拒发会让人白高兴）
 * 五、**跨批**：批大小调成 2（`GAME_MAIL_BROADCAST_BATCH_SIZE`）后，3 个角色分两批写完，
 *    三个都收到 —— 批边界上少写 / 重复写是这类循环最典型的错
 * 六、**落库形状与单发同源**：`channel` / `kind` / 附件金额原样落到每行；
 *    群发**永久不过期**（`expires_at` 为 NULL），单发的 `batch_id` 为 NULL
 * 七、**批次可核对**：`GET /admin/game-mail/broadcasts` 里能看到刚才那几批，
 *    条件快照（`filter.scope` / `filter.zoneId`）与完成时刻都在
 *
 * 口径（见 workbuddy memory「只校验代码，不校验数据」）：
 * - 断言钉**集合 / 字段 / 可见性**，不钉「应该有几个人」这种由库算出来的数；
 * - 唯一出现的数值对比是 `targetCount === sentCount`（预览与发送必须用同一套条件，
 *   这是两条代码路径的一致性，不是数据校验）；
 * - 不赌 wall-clock：批次完成靠 `finishedAt` 非空（发送是同步的，接口返回时已落库）。
 *
 * 走的是 `dist/`，所以前置是 `npm run build`。用法：`npm run test:e2e:game-mail-broadcast`
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/** 管理端请求所在的区（管理端一次只在一个区里干活） */
const ADMIN_ZONE = 1;
/** 批大小调成 2：让「跨批」这条路径真的被走到（默认 500 永远只有一批） */
const BATCH_SIZE = 2;

//#region 断言小工具

const failures = [];
let passed = 0;
let failed = 0;

function check(ok, label, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  [OK] ${label}${detail ? " —— " + detail : ""}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  [!!] ${label}${detail ? " —— " + detail : ""}`);
  }
}

function checkEqual(actual, expected, label) {
  return check(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}

/** 两个 id 集合完全相等（既没有漏发，也没有多发） */
function checkSameIds(actual, expected, label) {
  const a = [...new Set(actual)].sort();
  const b = [...new Set(expected)].sort();
  return check(JSON.stringify(a) === JSON.stringify(b), `${label}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);
}

function group(label) {
  console.log(`\n▶ ${label}`);
}

//#endregion

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      JWT_SECRET: "e2e-game-mail-broadcast-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      ADMIN_REGISTER_CODE: "mail-broadcast-code",
      GAME_MAIL_BROADCAST_BATCH_SIZE: String(BATCH_SIZE),
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

/** 发一个请求，返回 `{ status, body }`（判定 403 要看状态码，业务码在 body 里） */
async function http(baseUrl, method, route, options = {}) {
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
  return { status: response.status, body };
}

/** 只要信封 */
async function api(baseUrl, method, route, options = {}) {
  return (await http(baseUrl, method, route, options)).body;
}

function createRole(baseUrl, token, name) {
  return api(baseUrl, "POST", "roles", { token, body: { name, occupation: "1", sex: "1" } });
}

/**
 * 直接读库
 *
 * 收件箱的玩家侧接口要求「有在线角色」，而群发的验收点恰恰是「**离线**角色也收到」——
 * 所以这里只能读库（与 e2e-game-mail 的 `insertMail` 同一个理由：邮件是服务端独占的表）。
 */
function batchRows(dbPath, batchId) {
  const db = new DatabaseSync(dbPath);
  const rows = db
    .prepare("SELECT role_id, channel, kind, title, batch_id, expires_at, bind_gold FROM role_mails WHERE batch_id = ?")
    .all(batchId);
  db.close();
  return rows.map((row) => ({ ...row }));
}

/** 某封邮件的 batch_id（单发回归用：必须为 NULL） */
function batchIdOfMail(dbPath, mailId) {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT batch_id FROM role_mails WHERE id = ?").get(mailId);
  db.close();
  return row ? row.batch_id : undefined;
}

/** 群发的正文模板（只有标题与金额，够验「落库形状」了） */
function mailBody(batchId, extra = {}) {
  return {
    batchId,
    channel: "reward",
    title: `开服福利 ${batchId}`,
    body: "感谢支持，请到消息中心领取。",
    bindGold: 100,
    scope: "zone",
    ...extra,
  };
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-game-mail-broadcast-${Date.now()}.db`);
  const server = await startServer(dbPath);
  try {
    const { baseUrl } = server;

    //#region 准备：两个区 / 超管与普通管理员 / 五个角色
    group("准备：两个区、超管与普通管理员、五个角色");

    const superReg = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "bc_super", password: "super-pass-1", registerCode: "mail-broadcast-code" },
    });
    const superToken = superReg.data && superReg.data.token;
    check(!!superToken, "准备：超级管理员已注册", superReg.message);

    const zone2 = await api(baseUrl, "POST", "admin/zones", {
      token: superToken,
      zoneId: ADMIN_ZONE,
      body: { name: "二区" },
    });
    const zone2Id = zone2.data && zone2.data.id;
    check(!!zone2Id && zone2Id >= 2, "准备：开了「二区」");

    // 普通管理员：没有 gameMail:broadcast-all，但能发本区
    const adminReg = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "bc_plain", password: "admin-pass-1", registerCode: "mail-broadcast-code" },
    });
    const plainId = adminReg.data && adminReg.data.admin && adminReg.data.admin.id;
    await api(baseUrl, "PATCH", `admin/admins/${plainId}`, {
      token: superToken,
      zoneId: ADMIN_ZONE,
      body: { role: "admin" },
    });
    const plainLogin = await api(baseUrl, "POST", "admin/auth/login", {
      body: { username: "bc_plain", password: "admin-pass-1", zoneId: ADMIN_ZONE },
    });
    const plainToken = plainLogin.data && plainLogin.data.token;
    check(!!plainToken, "准备：普通管理员已登录（无 broadcast-all）");

    // 一区三个角色：两个 1 级（凑满两批）、一个 30 级（等级段筛子用）
    const mk = async (username, zoneId) => {
      const reg = await api(baseUrl, "POST", "auth/register", {
        body: { username, password: "pass1234" },
      });
      const token = reg.data && reg.data.token;
      if (zoneId !== ADMIN_ZONE) await api(baseUrl, "POST", "zones/select", { token, body: { zoneId } });
      const role = await createRole(baseUrl, token, `${username} 的角色`);
      return role.data && role.data.id;
    };

    const roleA = await mk("bc_a", ADMIN_ZONE);
    const roleB = await mk("bc_b", ADMIN_ZONE);
    const roleC = await mk("bc_c", ADMIN_ZONE);
    const roleD = await mk("bc_d", zone2Id);
    check([roleA, roleB, roleC, roleD].every(Boolean), "准备：四个角色都建好了");

    const leveled = await api(baseUrl, "PATCH", `admin/roles/${roleC}`, {
      token: superToken,
      zoneId: ADMIN_ZONE,
      body: { level: 30 },
    });
    checkEqual(leveled.data && leveled.data.level, 30, "准备：三区的角色 C 升到 30 级");

    //#endregion

    //#region 一、影响面预估
    group("一、影响面预估：范围 / 权限 / 等级段填反");

    const previewZone = await api(baseUrl, "POST", "admin/game-mail/broadcasts/preview", {
      token: superToken,
      zoneId: ADMIN_ZONE,
      body: { scope: "zone" },
    });
    checkEqual(previewZone.code, 0, "预估本区：200");
    check(JSON.stringify(previewZone.data && previewZone.data.zoneIds) === "[1]", "预估本区：只覆盖当前区", JSON.stringify(previewZone.data && previewZone.data.zoneIds));
    check(
      typeof (previewZone.data && previewZone.data.targetCount) === "number" && previewZone.data.targetCount > 0,
      "预估本区：给出命中人数",
      String(previewZone.data && previewZone.data.targetCount),
    );

    const previewAllSuper = await api(baseUrl, "POST", "admin/game-mail/broadcasts/preview", {
      token: superToken,
      zoneId: ADMIN_ZONE,
      body: { scope: "all" },
    });
    const previewZoneIds = previewAllSuper.data && previewAllSuper.data.zoneIds;
    check(
      Array.isArray(previewZoneIds) && previewZoneIds.includes(ADMIN_ZONE) && previewZoneIds.includes(zone2Id),
      "预估全服（超管）：覆盖到两个区",
      JSON.stringify(previewZoneIds),
    );

    const previewAllPlain = await http(baseUrl, "POST", "admin/game-mail/broadcasts/preview", {
      token: plainToken,
      zoneId: ADMIN_ZONE,
      body: { scope: "all" },
    });
    checkEqual(previewAllPlain.status, 403, "预估全服（普通管理员）：403");
    checkEqual(previewAllPlain.body && previewAllPlain.body.code, 30006, "预估全服（普通管理员）：业务码 30006");

    const previewBadRange = await http(baseUrl, "POST", "admin/game-mail/broadcasts/preview", {
      token: superToken,
      zoneId: ADMIN_ZONE,
      body: { scope: "zone", minLevel: 40, maxLevel: 10 },
    });
    checkEqual(previewBadRange.status, 400, "等级段填反：400");
    checkEqual(previewBadRange.body && previewBadRange.body.code, 40000, "等级段填反：业务码 40000");

    //#endregion

    //#region 二、按区群发（批大小 2 → 三个角色跨两批）
    group("二、按区群发：只写本区、跨批不漏、落库形状与单发同源");

    const batchZone = "batch-zone-1";
    const sentZone = await http(baseUrl, "POST", "admin/game-mail/broadcasts", {
      token: superToken,
      zoneId: ADMIN_ZONE,
      body: mailBody(batchZone),
    });
    checkEqual(sentZone.status, 201, "按区群发：201");
    checkEqual(sentZone.body && sentZone.body.data.batchId, batchZone, "按区群发：批次号原样返回");
    checkEqual(sentZone.body && sentZone.body.data.duplicated, false, "按区群发：不是重复批次");
    checkEqual(
      sentZone.body && sentZone.body.data.sentCount,
      sentZone.body && sentZone.body.data.targetCount,
      "按区群发：实发 = 预估（同一套筛选条件）",
    );

    const rowsZone = batchRows(dbPath, batchZone);
    checkSameIds(rowsZone.map((row) => row.role_id), [roleA, roleB, roleC], "按区群发：三个本区角色各一封（跨两批写完）");
    check(
      rowsZone.every((row) => row.channel === "reward" && row.kind === "admin-broadcast"),
      "按区群发：channel / kind 落库正确",
      JSON.stringify(rowsZone.map((row) => `${row.channel}/${row.kind}`)),
    );
    check(
      rowsZone.every((row) => row.expires_at === null),
      "按区群发：群发邮件永久不过期（expires_at 为 NULL）",
    );
    check(
      rowsZone.every((row) => row.bind_gold === 100),
      "按区群发：附件金额原样落库",
      JSON.stringify(rowsZone.map((row) => row.bind_gold)),
    );
    check(
      !rowsZone.some((row) => row.role_id === roleD),
      "按区群发：二区的角色 D 不在这一批里",
    );

    //#endregion

    //#region 三、幂等：同批次号不重发，换号照发
    group("三、幂等：同批次号重提不写行；换号发同样内容照发");

    const resent = await http(baseUrl, "POST", "admin/game-mail/broadcasts", {
      token: superToken,
      zoneId: ADMIN_ZONE,
      body: mailBody(batchZone),
    });
    checkEqual(resent.status, 201, "同批次号重提：201（幂等成功，不是 409）");
    checkEqual(resent.body && resent.body.data.duplicated, true, "同批次号重提：duplicated = true");
    checkEqual(batchRows(dbPath, batchZone).length, rowsZone.length, "同批次号重提：一行都没多写");

    const batchZone2 = "batch-zone-2";
    const sentZone2 = await api(baseUrl, "POST", "admin/game-mail/broadcasts", {
      token: superToken,
      zoneId: ADMIN_ZONE,
      body: mailBody(batchZone2),
    });
    checkEqual(sentZone2.code, 0, "换批次号发同样内容：成功（内容不参与去重）");
    check(batchRows(dbPath, batchZone2).length > 0, "换批次号：真的写进去了");

    //#endregion

    //#region 四、等级段：只有达标的人收到
    group("四、等级段：minLevel 挡掉未达标的人");

    const batchLevel = "batch-level-30";
    const sentLevel = await api(baseUrl, "POST", "admin/game-mail/broadcasts", {
      token: superToken,
      zoneId: ADMIN_ZONE,
      body: mailBody(batchLevel, { minLevel: 30 }),
    });
    checkEqual(sentLevel.code, 0, "等级段群发：成功");
    checkSameIds(
      batchRows(dbPath, batchLevel).map((row) => row.role_id),
      [roleC],
      "等级段群发：只有 30 级那个角色收到",
    );

    const emptyRange = await http(baseUrl, "POST", "admin/game-mail/broadcasts", {
      token: superToken,
      zoneId: ADMIN_ZONE,
      body: mailBody("batch-bad-range", { minLevel: 40, maxLevel: 10 }),
    });
    checkEqual(emptyRange.status, 400, "等级段填反的群发：400（不静默发 0 封）");
    checkEqual(batchRows(dbPath, "batch-bad-range").length, 0, "等级段填反的群发：一行都没写");

    //#endregion

    //#region 五、全服：权限 + 一行不写 / 跨区都收到
    group("五、全服群发：普通管理员被拒且不留半批，超管两区都发到");

    const batchAllDenied = "batch-all-denied";
    const denied = await http(baseUrl, "POST", "admin/game-mail/broadcasts", {
      token: plainToken,
      zoneId: ADMIN_ZONE,
      body: mailBody(batchAllDenied, { scope: "all" }),
    });
    checkEqual(denied.status, 403, "普通管理员发全服：403");
    checkEqual(denied.body && denied.body.code, 30006, "普通管理员发全服：业务码 30006");
    checkEqual(batchRows(dbPath, batchAllDenied).length, 0, "普通管理员发全服：一行都没写（不是发了一半才被拦）");

    const batchAll = "batch-all-1";
    const sentAll = await api(baseUrl, "POST", "admin/game-mail/broadcasts", {
      token: superToken,
      zoneId: ADMIN_ZONE,
      body: mailBody(batchAll, { scope: "all" }),
    });
    checkEqual(sentAll.code, 0, "超管发全服：成功");
    checkSameIds(
      batchRows(dbPath, batchAll).map((row) => row.role_id),
      [roleA, roleB, roleC, roleD],
      "超管发全服：一区三个 + 二区一个都收到",
    );

    // plain 管理员发本区仍然可以（权限收窄只针对全服，没有误伤）
    const plainZone = await api(baseUrl, "POST", "admin/game-mail/broadcasts", {
      token: plainToken,
      zoneId: ADMIN_ZONE,
      body: mailBody("batch-plain-zone"),
    });
    checkEqual(plainZone.code, 0, "普通管理员发本区：仍然可以");

    //#endregion

    //#region 六、批次可核对
    group("六、批次列表：条件快照与完成时刻都在");

    const list = await api(baseUrl, "GET", "admin/game-mail/broadcasts", {
      token: superToken,
      zoneId: ADMIN_ZONE,
    });
    check(Array.isArray(list.data), "批次列表：返回数组");
    const viewAll = (list.data || []).find((item) => item.batchId === batchAll);
    const viewZone = (list.data || []).find((item) => item.batchId === batchZone);
    check(!!viewAll, "批次列表：能查到刚发的全服批次");
    checkEqual(viewAll && viewAll.filter && viewAll.filter.scope, "all", "全服批次：条件快照 scope = all");
    checkEqual(viewAll && viewAll.filter && viewAll.filter.zoneId, null, "全服批次：快照里 zoneId 为 null（不是「当时那个区」）");
    check(typeof (viewAll && viewAll.finishedAt) === "number", "全服批次：完成时刻已落库（同步发送，返回即完成）");
    checkEqual(viewZone && viewZone.filter && viewZone.filter.zoneId, ADMIN_ZONE, "本区批次：快照里记着区 id");

    //#endregion

    //#region 七、单发回归：batch_id 必须为 NULL
    group("七、单发回归：不进批次");

    const single = await api(baseUrl, "POST", `admin/game-mail/roles/${roleA}`, {
      token: superToken,
      zoneId: ADMIN_ZONE,
      body: { channel: "system", title: "客服补偿", body: "给你补一份" },
    });
    checkEqual(single.code, 0, "单发：成功");
    checkEqual(batchIdOfMail(dbPath, single.data && single.data.id), null, "单发：batch_id 为 NULL（没被群发串味）");

    //#endregion

    check(failed === 0, `全部断言通过（${passed} 条）`, failures.join(" / "));
  } finally {
    server.child.kill("SIGKILL");
    await sleep(100);
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"} 群发：${passed} 条通过 / ${failed} 条失败`);
  if (failed > 0) process.exit(1);
})();
