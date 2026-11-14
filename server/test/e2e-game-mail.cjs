#!/usr/bin/env node
/**
 * 游戏内邮件专项 e2e（server/test/e2e-game-mail.cjs，issue #429）
 *
 * 盯的不变量（改邮件表 / 领取路径 / 成就兜底后必须全绿）：
 * 一、收件箱：整份下发、未读数与未领数各算各的 —— **待领 = 未领且有奖励**，
 *     公告 / 纯文本邮件不算（#869，否则红点永远清不掉），新的在前
 * 二、已读：重复标已读不改写第一次的时刻
 * 三、领取：绑定元宝 / 经验 / 物品一次落库（走与任务交付同一个发奖入口）；重复领 50142、不存在 50141、
 *     纯文本邮件（没有奖励）领取不碰角色存档
 * 四、删除：**绑定元宝 / 经验 / 附件任一未领就不能删**（#866，50143）；纯公告可以删，已领的可以删
 * 五、一键领取：逐封领取，全部成功时 `failedCount` 为 0
 * 六、一封失败不拖累其他封（#870）：非背包异常（20003）与背包满（20012）都**只挡那一封**，
 *     排在后面的纯绑定元宝邮件照样到手；「标已领」与发奖在同一事务里（#868），失败不留标记
 * 七、成就兜底：领奖时背包满 → 整份奖励转成一封邮件、成就照常记已领，清包后从邮件领到手
 * 八、频道（#436）：四个频道角标固定且与列表一致、按频道一键领取不越界、非法频道 40000、
 *     好友申请落社交频道、BOSS 击杀落战斗频道（普通怪不落）
 *
 * 走的是 `dist/`，所以前置是 `npm run build`。
 * 用法：npm run test:e2e:game-mail
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { placeRolesAt } = require("./lib/place-role.cjs");
// 实时通道用 ws 包（Node 内置的 WebSocket 只有 addEventListener，没有 .on）
const WebSocket = require("ws");
const { paceCast } = require("./lib/cast-pace.cjs");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

//#region 断言小工具（与 e2e-achievement 同款口径）


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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询等一个条件成立（WS 帧是异步到的，只能等） */
const waitFor = async (label, predicate, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(20);
  }
  check(false, `${label}（等待超时）`);
  return last;
};

/** 一条会话化的 WS 连接：击杀组只需要 world 帧与 settle 帧 */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    settles: [],
    worlds: [],
    async waitForSettle(castId, timeoutMs = 5_000) {
      return waitFor(
        `castId=${castId} 的 settle`,
        async () => {
          const hits = session.settles.filter((frame) => frame.castId === castId);
          return hits.length > 0 ? hits[hits.length - 1] : null;
        },
        timeoutMs,
      );
    },
    async joinWorld(mapId, timeoutMs = 5_000) {
      const before = session.worlds.length;
      session.socket.send(JSON.stringify({ type: "worldJoin", data: { mapId } }));
      return waitFor(
        `mapId=${mapId} 的 world 帧`,
        async () => {
          const hits = session.worlds.slice(before).filter((frame) => frame.mapId === mapId);
          return hits.length > 0 ? hits[hits.length - 1] : null;
        },
        timeoutMs,
      );
    },
  };
  socket.on("open", () => {
    session.opened = true;
  });
  socket.on("message", (raw) => {
    try {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "settle") session.settles.push(frame.data);
      if (frame.type === "world") session.worlds.push(frame.data);
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("close", () => {});
  socket.on("error", () => {});
  return session;
}

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
      WORLD_RESPAWN_MS: "1500",
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

/** 空背包（4×10 格） */
function emptyBag() {
  return Array.from({ length: 4 }, () => Array.from({ length: 10 }, () => null));
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
    `INSERT INTO role_mails (id, role_id, channel, kind, title, body, bind_gold, exp, attachments, read_at, claimed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    mail.id,
    mail.roleId,
    mail.channel ?? "system",
    mail.kind ?? "system",
    mail.title ?? "系统邮件",
    mail.body ?? "",
    mail.bindGold ?? 0,
    mail.exp ?? 0,
    JSON.stringify(mail.attachments ?? []),
    mail.readAt ?? null,
    mail.claimedAt ?? null,
    mail.createdAt ?? Date.now(),
  );
  db.close();
}

/** 清空这个角色的收件箱（频道组要一个干净起点，才谈得上「只领了这一栏」） */
function clearMails(dbPath, roleId) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.prepare("DELETE FROM role_mails WHERE role_id = ?").run(roleId);
  db.close();
}

/** 把一只怪调成「一击必死」：血量 1、三种防御清零（BOSS 血量几万，不这么做打不动） */
function makeFrail(dbPath, monsterKey) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.prepare(
    `UPDATE monsters
        SET max_hp = 1,
            physical_defense_min = 0, physical_defense_max = 0,
            magic_defense_min = 0, magic_defense_max = 0,
            taoist_defense_min = 0, taoist_defense_max = 0
      WHERE id = ?`,
  ).run(monsterKey);
  db.close();
}

/**
 * 往临时库里插刷怪区（boss 201 与普通怪 1 各一区，击杀组用）
 *
 * **必须在服务端启动之后调**：`bootstrapConfigSnapshot()` 在空库首启时会把
 * `map_spawn_areas` 整表替换成出厂快照（地图 1 是「赤焰斗鸡 ×12」，没有 boss），
 * 启动前插进去的行一个都留不下 —— 于是 `killByKey("201")` 永远等不到那只怪。
 * 先 DELETE 掉地图 1 的出厂区，再插这一套要的两行。
 */
function seedSpawnAreas(dbPath) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("DELETE FROM map_spawn_areas WHERE map_id = '1'");
  const insert = db.prepare(
    `INSERT INTO map_spawn_areas (map_id, name, monster_key, min, max, cx, cy, w, h, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run("1", "BOSS 区", "201", 0, 1, 200, 300, 400, 400, Date.now());
  insert.run("1", "杂兵区", "1", 0, 2, 700, 300, 400, 400, Date.now());
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

/**
 * 直接改库里的背包（#556 起 `bag` 是服务端权威：客户端存档里的那份会被库里回填）
 *
 * 与 `setRoleLevel` / `insertMail` 同一口径：这个文件没有管理员令牌，造状态只能落到库上。
 * 写进去的就是服务端认的那一份 —— 之后任何 `PUT /roles/:id` 都改不动它，所以别再用存档造背包。
 * @returns 写进去的格子（调用方读回核对，别只看「没报错」）
 */
function stuffBag(dbPath, roleId, bag) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT data FROM roles WHERE id = ?").get(roleId);
  const data = row && row.data ? JSON.parse(row.data) : {};
  data.bag = bag;
  db.prepare("UPDATE roles SET data = ? WHERE id = ?").run(JSON.stringify(data), roleId);
  db.close();
  return bag;
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
    // 出厂快照已把刷怪区灌好 —— 换成这一套要的两行（见 seedSpawnAreas 注释）
    seedSpawnAreas(dbPath);
    // 击杀组要能一击打死（BOSS 本身几万血）；改库必须赶在 joinWorld 播种之前
    makeFrail(dbPath, "201");
    makeFrail(dbPath, "1");

    //#region 准备

    group("准备：玩家与在线角色");
    const registered = await api(baseUrl, "POST", "auth/register", { body: { username: "mail_player", password: "pass1234" } });
    const token = registered.data && registered.data.token;
    const created = await api(baseUrl, "POST", "roles", { token, body: { name: "收信人", occupation: "1", sex: "1" } });
    // #859 起「没有位置记录」的角色只准进新手村 —— 这一套要进 1 图，
    // 准备段先按运营摆位把位置写进去（等价管理端 PATCH onMap，见 lib/place-role.cjs）
    placeRolesAt(dbPath, "1");
    const roleId = created.data && created.data.id;
    check(created.code === 0 && created.data.online === true, "准备：角色已创建并自动在线", created.message);
    // #597 起初始 bag 是空数组（没有网格），而服务端不扩容 —— 先存一张规范化空网格（4×10），
    // 后面「领附件进背包」的用例才有空格可落
    const initial = await api(baseUrl, "GET", `roles/${roleId}`, { token });
    const gridded = await api(baseUrl, "PUT", `roles/${roleId}`, {
      token,
      body: { revision: initial.data && initial.data.revision, data: { ...(initial.data.data || {}), bag: emptyBag() } },
    });
    check(gridded.code === 0, "准备：存档带上规范化空网格（服务端不扩容语义的前提）", gridded.message);

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
      bindGold: 500,
      exp: 200,
      attachments: [{ goodId: "material_iron", count: 2 }],
      createdAt: now - 3000,
    });
    insertMail(dbPath, { id: "mail_plain", roleId, title: "停机公告", body: "今晚维护。", createdAt: now - 2000 });
    insertMail(dbPath, { id: "mail_done", roleId, title: "已领过的", body: "", createdAt: now - 1000, claimedAt: now - 500 });

    const box = await api(baseUrl, "GET", "mails/me", { token });
    checkEqual(box.data.mails.length, 3, "插 3 封 → 接口给 3 封");
    checkEqual(box.data.unread, 3, "未读数 3（三封都没读过）");
    // #869：待领的判据是「未领 **且** 有奖励」。停机公告没有绑定元宝/经验/附件，
    // 它永远领不了 —— 算进待领等于给玩家一个清不掉的红点、一个永远亮着的一键领取按钮
    checkEqual(box.data.unclaimed, 1, "未领数 1（公告没有奖励不算待领，已领过的那封也不算）");
    const systemChannel = box.data.channels.find((row) => row.channel === "system");
    checkEqual(systemChannel.unclaimed, 1, "频道角标同一口径（系统栏只数那封有奖励的）");
    checkEqual(systemChannel.total, 3, "频道 total 仍按「有几封」算，不受待领口径影响");
    checkEqual(box.data.mails[0].id, "mail_done", "新的在前（created_at 倒序）");
    const rewardView = box.data.mails.find((row) => row.id === "mail_reward");
    check(
      rewardView.bindGold === 500 && rewardView.exp === 200 && rewardView.attachments.length === 1 && rewardView.attachments[0].count === 2,
      "附件（绑定元宝 / 经验 / 物品）原样下发",
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

    group("三、领取：绑定元宝 / 经验 / 物品一次落库，三种拒绝");
    const beforeClaim = await api(baseUrl, "GET", `roles/${roleId}`, { token });
    const bindGoldBefore = (beforeClaim.data && beforeClaim.data.data && beforeClaim.data.data.bindGold) || 0;
    const claimed = await api(baseUrl, "POST", "mails/mail_reward/claim", { token });
    checkEqual(claimed && claimed.code, 0, "领取成功");
    checkEqual(claimed && claimed.data && claimed.data.bindGold, 500, "本次到手绑定元宝 500");
    checkEqual(claimed && claimed.data && claimed.data.items.length, 1, "本次到手物品 1 条");
    const afterClaim = await api(baseUrl, "GET", `roles/${roleId}`, { token });
    checkEqual((afterClaim.data.data.bindGold || 0) - bindGoldBefore, 500, "绑定元宝真的进了角色存档（差额 500）");
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

    group("四、删除：还有没领的奖励就不能删（绑定元宝也算奖励，纯公告可以删）");
    insertMail(dbPath, {
      id: "mail_keep",
      roleId,
      title: "还没领的",
      bindGold: 100,
      attachments: [{ goodId: "material_gem", count: 1 }],
    });
    const keepDelete = await api(baseUrl, "DELETE", "mails/mail_keep", { token });
    checkEqual(keepDelete && keepDelete.code, 50143, "有未领附件 → 拒删（50143）");

    // #866：判据是「绑定元宝 / 经验 / 附件任一未领」，不是「附件非空」。
    // 老实现会把「补偿 500 绑定元宝」当成一封空信，玩家一点删除奖励就没了。
    insertMail(dbPath, { id: "mail_bind_gold_only", roleId, title: "只补绑定元宝", bindGold: 500 });
    const bindGoldOnlyDelete = await api(baseUrl, "DELETE", "mails/mail_bind_gold_only", { token });
    checkEqual(bindGoldOnlyDelete && bindGoldOnlyDelete.code, 50143, "只带绑定元宝、没有附件 → 同样拒删（#866）");
    checkEqual(mailTimestamps(dbPath, "mail_bind_gold_only")?.claimed_at, null, "拒删后库里那行原样还在");

    // 反面：没有奖励的公告必须能删 —— 否则玩家永远清不掉的正是这种信
    insertMail(dbPath, { id: "mail_notice", roleId, title: "纯公告", body: "周五维护。" });
    const noticeDelete = await api(baseUrl, "DELETE", "mails/mail_notice", { token });
    checkEqual(noticeDelete && noticeDelete.code, 0, "纯公告没有奖励 → 可以删");

    const doneDelete = await api(baseUrl, "DELETE", "mails/mail_done", { token });
    checkEqual(doneDelete && doneDelete.code, 0, "已领的邮件可以删");
    checkEqual(doneDelete.data.mails.length, 4, "删除后箱子剩 4 封");

    //#endregion

    //#region 五、一键领取

    group("五、一键领取：逐封领取，全部成功时 failedCount 为 0");
    const batchAt = Date.now();
    insertMail(dbPath, { id: "mail_b1", roleId, title: "批量 1", bindGold: 120, createdAt: batchAt + 1 });
    insertMail(dbPath, {
      id: "mail_b2",
      roleId,
      title: "批量 2",
      bindGold: 80,
      attachments: [{ goodId: "material_herb", count: 3 }],
      createdAt: batchAt + 2,
    });
    const batch = await api(baseUrl, "POST", "mails/claim-all", { token });
    checkEqual(batch && batch.code, 0, "一键领取成功");
    checkEqual(batch.data.claimedCount, 4, "四封未领的都领了（mail_keep / mail_bind_gold_only / 两封批量）");
    checkEqual(batch.data.failedCount, 0, "全部领到 → 失败清单为空（#870）");
    checkEqual(batch.data.failures.length, 0, "failures 数组也是空");
    checkEqual(batch.data.stoppedByBag, false, "背包没满 → stoppedByBag 为 false");
    checkEqual(batch.data.bindGold, 800, "绑定元宝合计 120 + 80 + 100 + 500");
    check(
      batch.data.items.some((item) => item.goodId === "material_herb" && item.count === 3),
      "物品合计按 id 合并后给出",
      JSON.stringify(batch.data.items),
    );
    checkEqual(batch.data.unclaimed, 0, "领完后未领数归零");

    //#endregion

    //#region 六、背包满

    group("六、一封失败不拖累其他封：跳过继续领，标已领随发奖回滚（#870 / #868）");

    // ① 非背包原因：附件里放一个配置不存在的物品 → 20003。老实现会直接往上抛，
    //    前面已领的落库、后面的一封没动，客户端只看到一句「领取失败」。
    insertMail(dbPath, {
      id: "mail_bad_item",
      roleId,
      title: "附件配错了",
      attachments: [{ goodId: "no_such_item", count: 1 }],
      createdAt: Date.now(),
    });
    insertMail(dbPath, { id: "mail_after_bad", roleId, title: "排它后面", bindGold: 500, createdAt: Date.now() + 1 });
    const skipped = await api(baseUrl, "POST", "mails/claim-all", { token });
    checkEqual(skipped && skipped.code, 0, "一键领取整体成功（不再整单抛错）");
    // 下面几行一律用可选链：整单抛错时 data 是 null，断言该优雅失败而不是抛 TypeError
    checkEqual(skipped.data?.claimedCount, 1, "坏附件那封失败，排在它后面的照领");
    checkEqual(skipped.data?.failedCount, 1, "失败清单 1 条");
    checkEqual(skipped.data?.failures?.[0]?.mailId, "mail_bad_item", "失败清单指名道姓（mailId）");
    checkEqual(skipped.data?.failures?.[0]?.code, 20003, "失败码是 20003（奖励物品不存在）");
    check(
      typeof skipped.data?.failures?.[0]?.reason === "string" && skipped.data.failures[0].reason.length > 0,
      "失败原因可直接展示（不是空串）",
      JSON.stringify(skipped.data?.failures?.[0]),
    );
    checkEqual(skipped.data?.bindGold, 500, "后面那封的绑定元宝到手");
    checkEqual(mailTimestamps(dbPath, "mail_bad_item")?.claimed_at, null, "失败那封的「已领」已随事务回滚（#868）");

    // ② 背包满：只挡「要放物品」的，纯绑定元宝照样领到 —— 这才是「跳过继续」与老 break 的区别
    // ① 造的那封坏附件信验完就清掉：它仍然未领，会继续在 ② 里算一条失败，把「几封被挡」的账搅乱
    clearMails(dbPath, roleId);
    const fullBag = Array.from({ length: 4 }, () => Array.from({ length: 10 }, () => ({ id: "material_hide", count: 99 })));
    const stuffed = stuffBag(dbPath, roleId, fullBag);
    checkEqual(
      stuffed.flat().filter((cell) => cell && cell.id === "material_hide").length,
      40,
      "准备：背包塞满（40 格兽皮，直接落库）",
    );
    const fullAt = Date.now();
    insertMail(dbPath, {
      id: "mail_full_a",
      roleId,
      title: "满了 1",
      attachments: [{ goodId: "material_gem", count: 1 }],
      createdAt: fullAt,
    });
    insertMail(dbPath, { id: "mail_full_bind_gold", roleId, title: "满了但只给钱", bindGold: 300, createdAt: fullAt + 1 });
    insertMail(dbPath, {
      id: "mail_full_b",
      roleId,
      title: "满了 2",
      attachments: [{ goodId: "material_gem", count: 2 }],
      createdAt: fullAt + 2,
    });
    const blocked = await api(baseUrl, "POST", "mails/claim-all", { token });
    checkEqual(blocked && blocked.code, 0, "一键领取不是整单失败");
    checkEqual(blocked.data.stoppedByBag, true, "背包满 → stoppedByBag 为 true");
    checkEqual(blocked.data.claimedCount, 1, "只有纯绑定元宝那封领到（要物品的两封被挡）");
    checkEqual(blocked.data.failedCount, 2, "失败清单 2 条");
    checkEqual(blocked.data.bindGold, 300, "纯绑定元宝那封的 300 真的到手了");
    checkEqual(blocked.data.unclaimed, 2, "两封要物品的原样留在箱里");
    checkEqual(mailTimestamps(dbPath, "mail_full_a")?.claimed_at, null, "失败那封没留下「已领」标记（事务回滚）");
    const singleBlocked = await api(baseUrl, "POST", "mails/mail_full_a/claim", { token });
    checkEqual(singleBlocked && singleBlocked.code, 20012, "单封领取撞背包满 → 20012");
    checkEqual(mailTimestamps(dbPath, "mail_full_a")?.claimed_at, null, "单封领取失败同样不留「已领」标记");

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
      !!fallback && fallback.kind === "achievement" && fallback.bindGold === 1000 && fallback.attachments.length === 1,
      "邮件内容是那份成就奖励（kind = achievement、绑定元宝 1000、1 条物品附件）",
      JSON.stringify(fallback),
    );
    // 清出一格：同样走库（背包是服务端权威，存档改不动），只剩 (0,0) 一件
    const oneFree = emptyBag();
    oneFree[0][0] = { id: "material_hide", count: 99 };
    stuffBag(dbPath, roleId, oneFree);
    const fallbackClaim = await api(baseUrl, "POST", `mails/${fallback.id}/claim`, { token });
    checkEqual(fallbackClaim && fallbackClaim.code, 0, "清出一格后从邮件领到手上");
    checkEqual(fallbackClaim && fallbackClaim.data && fallbackClaim.data.items.length, 1, "成就的物品附件真的进了背包");

    //#endregion

    //#region 八、频道

    group("八、频道：四条角标 / 按栏领取 / 社交与战斗投递");
    const channelKeys = (achievementMail.data.channels || []).map((item) => item.channel);
    checkEqual(channelKeys.join(","), "system,reward,social,combat", "四条频道角标固定且顺序稳定");
    const rewardSummary = (achievementMail.data.channels || []).find((item) => item.channel === "reward");
    const rewardMails = achievementMail.data.mails.filter((row) => row.channel === "reward");
    check(
      !!rewardSummary && rewardSummary.total === rewardMails.length && rewardMails.every((row) => row.kind === "achievement"),
      "「奖励」栏角标与列表一致（成就兜底那封归在 reward）",
      JSON.stringify(rewardSummary),
    );

    clearMails(dbPath, roleId);
    const emptyBox = await api(baseUrl, "GET", "mails/me", { token });
    check(
      emptyBox.data.mails.length === 0 && emptyBox.data.channels.every((item) => item.total === 0 && item.unread === 0),
      "清空后四条角标全 0（没有消息的频道也要出现）",
      JSON.stringify(emptyBox.data.channels),
    );

    // 社交频道：另一个号加我 → 我这条消息落 social / friend
    const other = await api(baseUrl, "POST", "auth/register", { body: { username: "mail_other", password: "pass1234" } });
    const otherToken = other.data && other.data.token;
    const otherRole = await api(baseUrl, "POST", "roles", { token: otherToken, body: { name: "加人的人", occupation: "1", sex: "1" } });
    const friendRequest = await api(baseUrl, "POST", "social/friends", { token: otherToken, body: { roleId } });
    checkEqual(friendRequest && friendRequest.code, 0, "另一个号发出好友申请");
    const socialBox = await api(baseUrl, "GET", "mails/me", { token });
    const socialMail = socialBox.data.mails.find((row) => row.channel === "social");
    check(
      !!socialMail && socialMail.kind === "friend" && socialMail.body.includes("加人的人"),
      "好友申请落进社交频道（kind = friend，正文带申请人名字）",
      JSON.stringify(socialMail),
    );

    // 按频道一键领取：reward 栏领掉，system 栏原样
    clearMails(dbPath, roleId);
    insertMail(dbPath, { id: "mail_ch_reward", roleId, channel: "reward", kind: "reward", title: "奖励栏", bindGold: 100 });
    insertMail(dbPath, { id: "mail_ch_system", roleId, channel: "system", kind: "system", title: "系统栏", bindGold: 200 });
    const scoped = await api(baseUrl, "POST", "mails/claim-all?channel=reward", { token });
    checkEqual(scoped && scoped.data && scoped.data.claimedCount, 1, "按频道一键领取只领了「奖励」这一栏");
    checkEqual(scoped && scoped.data && scoped.data.bindGold, 100, "到手绑定元宝只算奖励栏那封");
    checkEqual(scoped && scoped.data && scoped.data.unclaimed, 1, "系统栏那封仍在待领（没被顺手动到）");
    const badChannel = await api(baseUrl, "POST", "mails/claim-all?channel=nope", { token });
    checkEqual(badChannel && badChannel.code, 40000, "非法频道 → 40000（不静默当成「全部」）");

    // 战斗频道：真打一只 BOSS 与一只普通怪
    const ticket = await api(baseUrl, "POST", "realtime/ticket", { token });
    const session = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`);
    await waitFor("握手成功", async () => (session.opened ? session : null));
    let castSeq = 0;
    const castAt = async (mob) => {
      // 出手前等一个间隔（#813 冷却闸：服务端按真客户端口径判 250ms/刀）
      await paceCast();
      castSeq += 1;
      const castId = castSeq;
      session.socket.send(
        JSON.stringify({ type: "cast", data: { castId, skillId: "1000", targetId: mob.instanceId, monsterKey: mob.monsterKey } }),
      );
      return session.waitForSettle(castId);
    };
    const killByKey = async (monsterKey, attempts = 20) => {
      for (let attempt = 0; attempt < attempts; attempt++) {
        const snap = await session.joinWorld("1");
        const mob = snap && snap.monsters.find((m) => m.alive && m.monsterKey === monsterKey);
        if (mob) {
          const result = await castAt(mob);
          if (result && result.ok && result.killed) return result;
        }
        await sleep(200);
      }
      return null;
    };
    const bossKill = await killByKey("201");
    check(!!(bossKill && bossKill.killed), "准备：打死一只 BOSS（白骨弓手）");
    const combatBox = await api(baseUrl, "GET", "mails/me", { token });
    const combatMail = combatBox.data.mails.find((row) => row.channel === "combat");
    check(
      !!combatMail && combatMail.kind === "boss" && combatMail.title.includes("白骨弓手"),
      "BOSS 击杀落进战斗频道（kind = boss，标题带怪物名）",
      JSON.stringify(combatMail),
    );
    const combatBefore = combatBox.data.mails.filter((row) => row.channel === "combat").length;
    await killByKey("1");
    const afterTrash = await api(baseUrl, "GET", "mails/me", { token });
    checkEqual(
      afterTrash.data.mails.filter((row) => row.channel === "combat").length,
      combatBefore,
      "普通怪击杀不落战斗频道（否则一次扫图几十条）",
    );

    //#endregion
  } catch (error) {
    failed += 1;
    failures.push(String(error && error.stack ? error.stack : error));
    console.log(`\n✗ 未捕获异常：${error && error.stack ? error.stack : error}`);
  } finally {
    if (process.env.E2E_DEBUG === "1") console.log(`\n--- 服务端日志 ---\n${server.logs()}`);
    if (serverChild) serverChild.kill("SIGKILL");
  }

  console.log(`\n${failed === 0 ? "✔" : "✗"} ${passed} 通过 / ${failed} 失败`);
  if (failed > 0) {
    console.log("失败项：");
    for (const label of failures) console.log(`  - ${label}`);
    process.exit(1);
  }
})();
