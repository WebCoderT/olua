#!/usr/bin/env node
/**
 * 游戏内邮件专项 e2e（server/test/e2e-game-mail.cjs，issue #429）
 *
 * 盯的不变量（改邮件表 / 领取路径 / 成就兜底后必须全绿）：
 * 一、收件箱：整份下发、未读数与未领数各算各的、新的在前
 * 二、已读：重复标已读不改写第一次的时刻
 * 三、领取：金币 / 经验 / 物品一次落库（走与任务交付同一个发奖入口）；重复领 50142、不存在 50141、
 *     纯文本邮件（没有附件）领取不碰角色存档
 * 四、删除：**附件没领不能删**（50143），已领的可以删
 * 五、一键领取：逐封领到背包满为止 —— 已领的照常落库，`stoppedByBag` 说明还有剩
 * 六、成就兜底：领奖时背包满 → 整份奖励转成一封邮件、成就照常记已领，清包后从邮件领到手
 *
 * 走的是 `dist/`，所以前置是 `npm run build`。
 * 用法：npm run test:e2e:game-mail
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

//#region 断言小工具（与 e2e-achievement 同款口径）

const EXPECTED_ASSERTIONS = 39;

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** 起一台服务（文件库） */
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
      JWT_SECRET: "e2e-game-mail-secret",
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

/** 空背包（4×10 格） */
function emptyBag() {
  return Array.from({ length: 4 }, () => Array.from({ length: 10 }, () => null));
}

/** 一份最小可建号的角色文档（e2e-achievement 同款） */
function roleData(id, name) {
  return { id, name, occupation: "1", sex: "1", level: 1, hp: 100, mp: 50, equipments: {}, bag: emptyBag(), skills: { 1000: 1 } };
}

/**
 * 直插一封邮件
 *
 * **邮件的唯一生产者是服务端**（成就兜底 / 以后的运营补发），客户端没有发信口子 ——
 * 所以 e2e 里造数据只能走库。表结构由服务端启动时的 migrate 建好，插之前服务已经起来了。
 */
function insertMail(dbPath, mail) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.prepare(
    `INSERT INTO role_mails (id, role_id, kind, title, body, gold, exp, attachments, read_at, claimed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    mail.id,
    mail.roleId,
    mail.kind ?? "system",
    mail.title ?? "系统邮件",
    mail.body ?? "",
    mail.gold ?? 0,
    mail.exp ?? 0,
    JSON.stringify(mail.attachments ?? []),
    mail.readAt ?? null,
    mail.claimedAt ?? null,
    mail.createdAt ?? Date.now(),
  );
  db.close();
}

/** 直接开库读一行的两个时刻（没有 HTTP 出口的列只能直读） */
function mailTimestamps(dbPath, mailId) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT read_at, claimed_at FROM role_mails WHERE id = ?").get(mailId);
  db.close();
  return row || null;
}

/** 直接开库改角色等级 */
function setRoleLevel(dbPath, roleId, level) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE roles SET level = ? WHERE id = ?").run(level, roleId);
  db.close();
}

/** 成就记录的两个时刻（#401 的表，兜底断言用） */
function achievementTimestamps(dbPath, roleId, achievementId) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  const row = db
    .prepare("SELECT progress, achieved_at, claimed_at FROM role_achievements WHERE role_id = ? AND achievement_id = ?")
    .get(roleId, achievementId);
  db.close();
  return row || null;
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-game-mail-${Date.now()}.db`);
  const server = await startServer(dbPath);
  let serverChild = null;
  try {
    const { baseUrl } = server;
    serverChild = server.child;

    //#region 准备

    group("准备：玩家与在线角色");
    const registered = await api(baseUrl, "POST", "auth/register", { body: { username: "mail_player", password: "pass1234" } });
    const token = registered.data && registered.data.token;
    const roleDoc = roleData("mail_r1", "收信人");
    const created = await api(baseUrl, "POST", "roles", { token, body: { data: roleDoc } });
    const roleId = created.data && created.data.id;
    check(created.code === 0 && created.data.online === true, "准备：角色已创建并自动在线", created.message);

    //#endregion

    //#region 一、收件箱

    group("一、收件箱：整份下发、未读 / 未领各算各的、新的在前");
    const empty = await api(baseUrl, "GET", "mails/me", { token });
    check(
      empty.code === 0 && empty.data.mails.length === 0 && empty.data.unread === 0 && empty.data.unclaimed === 0,
      "空箱子：0 封、未读 0、未领 0",
      JSON.stringify(empty.data),
    );

    const now = Date.now();
    insertMail(dbPath, {
      id: "mail_reward",
      roleId,
      kind: "reward",
      title: "补偿邮件",
      body: "给你一点补偿。",
      gold: 500,
      exp: 200,
      attachments: [{ goodId: "material_iron", count: 2 }],
      createdAt: now - 3000,
    });
    insertMail(dbPath, { id: "mail_plain", roleId, title: "停机公告", body: "今晚维护。", createdAt: now - 2000 });
    insertMail(dbPath, { id: "mail_done", roleId, title: "已领过的", body: "", createdAt: now - 1000, claimedAt: now - 500 });

    const box = await api(baseUrl, "GET", "mails/me", { token });
    checkEqual(box.data.mails.length, 3, "插 3 封 → 接口给 3 封");
    checkEqual(box.data.unread, 3, "未读数 3（三封都没读过）");
    checkEqual(box.data.unclaimed, 2, "未领数 2（已领过的那封不算）");
    checkEqual(box.data.mails[0].id, "mail_done", "新的在前（created_at 倒序）");
    const rewardView = box.data.mails.find((row) => row.id === "mail_reward");
    check(
      rewardView.gold === 500 && rewardView.exp === 200 && rewardView.attachments.length === 1 && rewardView.attachments[0].count === 2,
      "附件（金币 / 经验 / 物品）原样下发",
      JSON.stringify(rewardView),
    );

    //#endregion

    //#region 二、已读

    group("二、已读：重复标不改写第一次的时刻");
    const readOnce = await api(baseUrl, "POST", "mails/mail_reward/read", { token });
    checkEqual(readOnce.data.unread, 2, "标已读后未读数 2");
    const firstReadAt = mailTimestamps(dbPath, "mail_reward");
    check(firstReadAt && firstReadAt.read_at !== null, "库里记下了已读时刻");
    await api(baseUrl, "POST", "mails/mail_reward/read", { token });
    const secondReadAt = mailTimestamps(dbPath, "mail_reward");
    checkEqual(secondReadAt && secondReadAt.read_at, firstReadAt && firstReadAt.read_at, "重复标已读不覆盖第一次的时刻");

    //#endregion

    //#region 三、领取

    group("三、领取：金币 / 经验 / 物品一次落库，三种拒绝");
    const beforeClaim = await api(baseUrl, "GET", `roles/${roleId}`, { token });
    const goldBefore = (beforeClaim.data && beforeClaim.data.data && beforeClaim.data.data.gold) || 0;
    const claimed = await api(baseUrl, "POST", "mails/mail_reward/claim", { token });
    checkEqual(claimed && claimed.code, 0, "领取成功");
    checkEqual(claimed && claimed.data && claimed.data.gold, 500, "本次到手金币 500");
    checkEqual(claimed && claimed.data && claimed.data.items.length, 1, "本次到手物品 1 条");
    const afterClaim = await api(baseUrl, "GET", `roles/${roleId}`, { token });
    checkEqual((afterClaim.data.data.gold || 0) - goldBefore, 500, "金币真的进了角色存档（差额 500）");
    const again = await api(baseUrl, "POST", "mails/mail_reward/claim", { token });
    checkEqual(again && again.code, 50142, "重复领取被拒（50142）");
    const missing = await api(baseUrl, "POST", "mails/mail_nope/claim", { token });
    checkEqual(missing && missing.code, 50141, "不存在的邮件报 50141");
    const revisionBeforePlain = afterClaim.data && afterClaim.data.revision;
    const plainClaim = await api(baseUrl, "POST", "mails/mail_plain/claim", { token });
    checkEqual(plainClaim && plainClaim.code, 0, "纯文本邮件（没有附件）也能「领取」（语义是已处理）");
    const afterPlain = await api(baseUrl, "GET", `roles/${roleId}`, { token });
    checkEqual(afterPlain.data && afterPlain.data.revision, revisionBeforePlain, "没有奖励的邮件不碰角色存档（revision 不动）");

    //#endregion

    //#region 四、删除

    group("四、删除：附件没领不能删");
    insertMail(dbPath, {
      id: "mail_keep",
      roleId,
      title: "还没领的",
      gold: 100,
      attachments: [{ goodId: "material_gem", count: 1 }],
    });
    const keepDelete = await api(baseUrl, "DELETE", "mails/mail_keep", { token });
    checkEqual(keepDelete && keepDelete.code, 50143, "有未领附件 → 拒删（50143）");
    const doneDelete = await api(baseUrl, "DELETE", "mails/mail_done", { token });
    checkEqual(doneDelete && doneDelete.code, 0, "已领的邮件可以删");
    checkEqual(doneDelete.data.mails.length, 3, "删除后箱子剩 3 封");

    //#endregion

    //#region 五、一键领取

    group("五、一键领取：逐封领到背包满为止");
    const batchAt = Date.now();
    insertMail(dbPath, { id: "mail_b1", roleId, title: "批量 1", gold: 120, createdAt: batchAt + 1 });
    insertMail(dbPath, {
      id: "mail_b2",
      roleId,
      title: "批量 2",
      gold: 80,
      attachments: [{ goodId: "material_herb", count: 3 }],
      createdAt: batchAt + 2,
    });
    const batch = await api(baseUrl, "POST", "mails/claim-all", { token });
    checkEqual(batch && batch.code, 0, "一键领取成功");
    checkEqual(batch.data.claimedCount, 3, "三封未领的都领了（含还没领的 mail_keep）");
    checkEqual(batch.data.stoppedByBag, false, "背包没满 → 没被中断");
    checkEqual(batch.data.gold, 300, "金币合计 120 + 80 + 100");
    check(
      batch.data.items.some((item) => item.goodId === "material_herb" && item.count === 3),
      "物品合计按 id 合并后给出",
      JSON.stringify(batch.data.items),
    );
    checkEqual(batch.data.unclaimed, 0, "领完后未领数归零");

    //#endregion

    //#region 六、背包满

    group("六、背包满：一键领取领到满为止，单封领取 20012");
    const fullBag = Array.from({ length: 4 }, () => Array.from({ length: 10 }, () => ({ id: "material_hide", count: 99 })));
    const stuffed = await api(baseUrl, "PUT", `roles/${roleId}`, { token, body: { data: { ...roleDoc, bag: fullBag } } });
    checkEqual(stuffed && stuffed.code, 0, "准备：背包塞满（40 格兽皮）");
    insertMail(dbPath, {
      id: "mail_full_a",
      roleId,
      title: "满了 1",
      attachments: [{ goodId: "material_gem", count: 1 }],
      createdAt: Date.now(),
    });
    insertMail(dbPath, {
      id: "mail_full_b",
      roleId,
      title: "满了 2",
      attachments: [{ goodId: "material_gem", count: 2 }],
      createdAt: Date.now() + 1,
    });
    const blocked = await api(baseUrl, "POST", "mails/claim-all", { token });
    checkEqual(blocked && blocked.code, 0, "一键领取不是整单失败");
    checkEqual(blocked.data.stoppedByBag, true, "背包满 → stoppedByBag 为 true");
    checkEqual(blocked.data.claimedCount, 0, "一封都没领到（每封都要物品）");
    checkEqual(blocked.data.unclaimed, 2, "两封原样留在箱里");
    const singleBlocked = await api(baseUrl, "POST", "mails/mail_full_a/claim", { token });
    checkEqual(singleBlocked && singleBlocked.code, 20012, "单封领取撞背包满 → 20012");

    //#endregion

    //#region 七、成就兜底

    group("七、成就兜底：领奖时背包满 → 整份奖励转邮件");
    setRoleLevel(dbPath, roleId, 10);
    const achClaim = await api(baseUrl, "POST", "achievements/claim", { token, body: { achievementId: "ach_level_10" } });
    checkEqual(achClaim && achClaim.code, 0, "背包满时成就也能领（不再堵在 20012）");
    check(!!(achClaim && achClaim.data && achClaim.data.mailId), "返回的 mailId 非空（奖励转进了邮箱）");
    const achTimestamps = achievementTimestamps(dbPath, roleId, "ach_level_10");
    check(achTimestamps && achTimestamps.claimed_at !== null, "成就照常记已领（claimed_at 非空）");
    const achievementMail = await api(baseUrl, "GET", "mails/me", { token });
    const fallback = achievementMail.data.mails.find((row) => row.id === (achClaim.data && achClaim.data.mailId));
    check(
      !!fallback && fallback.kind === "achievement" && fallback.gold === 1000 && fallback.attachments.length === 1,
      "邮件内容是那份成就奖励（kind = achievement、金币 1000、1 条物品附件）",
      JSON.stringify(fallback),
    );
    const oneFree = emptyBag();
    oneFree[0][0] = { id: "material_hide", count: 99 };
    await api(baseUrl, "PUT", `roles/${roleId}`, { token, body: { data: { ...roleDoc, level: 10, bag: oneFree } } });
    const fallbackClaim = await api(baseUrl, "POST", `mails/${fallback.id}/claim`, { token });
    checkEqual(fallbackClaim && fallbackClaim.code, 0, "清出一格后从邮件领到手上");
    checkEqual(fallbackClaim && fallbackClaim.data && fallbackClaim.data.items.length, 1, "成就的物品附件真的进了背包");

    //#endregion
  } catch (error) {
    failed += 1;
    failures.push(String(error && error.stack ? error.stack : error));
    console.log(`\n✗ 未捕获异常：${error && error.stack ? error.stack : error}`);
  } finally {
    if (serverChild) serverChild.kill("SIGKILL");
  }

  assertExpectedCount();
  console.log(`\n${failed === 0 ? "✔" : "✗"} ${passed} 通过 / ${failed} 失败`);
  if (failed > 0) {
    console.log("失败项：");
    for (const label of failures) console.log(`  - ${label}`);
    process.exit(1);
  }
})();
