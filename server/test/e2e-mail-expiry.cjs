#!/usr/bin/env node
/**
 * 收件箱保质期专项 e2e（server/test/e2e-mail-expiry.cjs，issue #439）
 *
 * 盯的不变量（改 expires_at 语义 / 清理 SQL / 读口过滤后必须全绿）：
 * 一、写入：send 的 ttlMs → expires_at = 发送时刻 + ttl；**不传 = 默认 30 天**（#867 起），
 *     显式 `0` = 永久（NULL）—— 「忘了给」与「故意永久」必须能分开
 * 二、读口：过期的行在收件箱里**立即消失**（不等清理任务），未读 / 未领数跟着不算它；
 *     单封操作（领取）对过期的行按「不存在」处理
 * 三、清理：一次 sweep 只删「已领、或者压根没有奖励」且真过期的行 ——
 *     **只要还有没领的奖励（绑定元宝 / 经验 / 附件任一）就不允许物理删除**（#867 把判据从
 *     `attachments` 扩到三样任一：纯绑定元宝补偿邮件以前会被删掉，奖励凭空蒸发）；
 *     expires_at 为空的行永远不删
 * 四、批量：一轮 sweep 删的条数**不超过 MAIL_PURGE_BATCH**（测试里调成 2 验证跨批）
 *
 * 用 in-process 起 Nest（与 e2e-roles 同款）：sweep() 要直调调度器，spawn 起的进程够不着。
 * 用法：先 `npm run build`，再 `node test/e2e-mail-expiry.cjs`
 */
const os = require("node:os");
const path = require("node:path");

// 直插样本要用文件库（:memory: 在两个连接之间不共享同一份数据）
process.env.DB_PATH = path.join(os.tmpdir(), `olua-e2e-mail-expiry-${Date.now()}.db`);
process.env.ADMIN_REGISTER_CODE = "unused";
process.env.MAIL_PURGE_BATCH = "2";
process.env.MAIL_PURGE_INTERVAL_MS = "3600000";
process.env.JWT_SECRET = "test-secret";
process.env.LOG_REQUESTS = "false";
process.env.CORS_ORIGINS = "*";

const { NestFactory } = require("@nestjs/core");
const { ValidationPipe } = require("@nestjs/common");
const { DatabaseSync } = require("node:sqlite");
const { AppModule } = require("../dist/app.module");
const { AllExceptionsFilter } = require("../dist/common/filters/all-exceptions.filter");
const { TransformInterceptor } = require("../dist/common/interceptors/transform.interceptor");
const { setupSwagger } = require("../dist/swagger/setup");

//#region 断言小工具（与 e2e-roles 同款口径）


let passed = 0;
const failures = [];

function check(condition, label, extra) {
  if (condition) {
    passed += 1;
    return true;
  }
  failures.push(extra === undefined ? label : `${label}（实际：${extra}）`);
  return false;
}

function finish(message) {
  console.log("");
  if (failures.length === 0) {
    console.log(`${message}（共 ${passed} 条断言）`);
    process.exit(0);
  }
  console.log(`FAIL：${failures.length} 条断言未通过（通过 ${passed} 条）`);
  failures.forEach((item, index) => console.log(`  ${index + 1}. ${item}`));
  process.exit(1);
}

//#endregion

let baseUrl = "";

/** 发一次请求，返回归一后的结果 */
async function api(method, path, options = {}) {
  const headers = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  // 管理端单区上下文（#960）：控制台前端在请求拦截器里统一带 X-Zone-Id，测试里对等模拟
  if (options.zoneId !== undefined) headers["X-Zone-Id"] = String(options.zoneId);
  const response = await fetch(`${baseUrl}/${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const envelope = await response.json().catch(() => null);
  return {
    status: response.status,
    code: envelope ? envelope.code : -1,
    message: envelope ? envelope.message : "",
    data: envelope ? envelope.data : null,
  };
}

/** 直插一行邮件（expiresAt 想怎么伪造就怎么伪造：清理判据的样本只能走库） */
function insertMail(dbPath, mail) {
  const db = new DatabaseSync(dbPath);
  db.prepare(
    `INSERT INTO role_mails (id, role_id, channel, kind, title, body, bind_gold, exp, attachments, read_at, claimed_at, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    mail.id,
    mail.roleId,
    mail.channel ?? "system",
    mail.kind ?? "system",
    mail.title ?? "保质期样本",
    mail.body ?? "",
    mail.bindGold ?? 0,
    mail.exp ?? 0,
    JSON.stringify(mail.attachments ?? []),
    mail.readAt ?? null,
    mail.claimedAt ?? null,
    mail.expiresAt ?? null,
    mail.createdAt ?? Date.now(),
  );
  db.close();
}

/** 直读一行的 expires_at / 存在性 */
function mailRow(dbPath, mailId) {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT expires_at, claimed_at FROM role_mails WHERE id = ?").get(mailId);
  db.close();
  return row || null;
}

(async () => {
  const app = await NestFactory.create(AppModule.register({ realtime: true }), { logger: false });
  app.setGlobalPrefix("api");
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, transformOptions: { enableImplicitConversion: true } }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new TransformInterceptor());
  setupSwagger(app);
  await app.listen(0);
  baseUrl = `${await app.getUrl()}/api`;
  const dbPath = process.env.DB_PATH;
  const purge = app.get(require("../dist/modules/game-mail/game-mail-purge.service").GameMailPurgeService);
  const mailService = app.get(require("../dist/modules/game-mail/game-mail.service").GameMailService);

  try {
    //#region 准备

    console.log("— 准备：玩家与在线角色 —");
    const player = await api("POST", "auth/register", { body: { username: "expiry_player", password: "pass1234" } });
    const token = player.data.token;
    // #597 起建号只交三样客户端数据，角色 id 由服务端生成
    const role = await api("POST", "roles", { token, body: { name: "保质期甲", occupation: "1", sex: "1" } });
    check(role.code === 0 && role.data.online === true, "准备：在线角色已就位", role.message);
    const roleId = role.data && role.data.id;

    //#endregion

    //#region 一、写入

    console.log("— 一、写入：ttlMs → expires_at，不传 = 30 天，0 = 永久 —");

    const withTtl = mailService.send(roleId, { channel: "system", kind: "system", title: "限时通知", ttlMs: 60_000 });
    check(
      withTtl.expires_at !== null && Math.abs(withTtl.expires_at - (withTtl.created_at + 60_000)) < 5,
      "带 ttlMs 的行：expires_at = 发送时刻 + ttl",
      JSON.stringify(withTtl.expires_at),
    );
    const withoutTtl = mailService.send(roleId, { channel: "system", kind: "system", title: "没给 TTL" });
    check(
      withoutTtl.expires_at !== null && Math.abs(withoutTtl.expires_at - (withoutTtl.created_at + 30 * 24 * 60 * 60 * 1000)) < 5,
      "不传 ttlMs 的行：默认 30 天（#867 起；以前是「永久」—— 谁忘了给就永远挂在箱子里）",
      JSON.stringify(withoutTtl.expires_at),
    );
    const forever = mailService.send(roleId, { channel: "system", kind: "system", title: "显式永久", ttlMs: 0 });
    check(forever.expires_at === null, "ttlMs: 0 → expires_at 为 NULL（永久，人工补发走这条）");

    //#endregion

    //#region 二、读口

    console.log("— 二、读口：过期的行立即消失，单封操作按不存在处理 —");

    insertMail(dbPath, { id: "mail_dead", roleId, title: "已过期", expiresAt: Date.now() - 1000 });
    insertMail(dbPath, { id: "mail_alive", roleId, title: "还没过期", expiresAt: Date.now() + 60_000 });
    const box = await api("GET", "mails/me", { token });
    const ids = (box.data.mails || []).map((row) => row.id);
    check(
      !ids.includes("mail_dead") && ids.includes("mail_alive") && ids.includes(withTtl.id) && ids.includes(withoutTtl.id),
      "过期的行不在列表里，未过期的、默认 30 天的与永久的都在",
      JSON.stringify(ids),
    );
    checkEqualUnread(box, 4);

    const deadClaim = await api("POST", "mails/mail_dead/claim", { token });
    check(deadClaim.code === 50141, "对过期的行领取 → 按不存在处理（50141）", `${deadClaim.code}`);

    // 清理任务还没跑（上一轮 sweep 与本节之间没调用），行还在库里：读口滤掉 ≠ 已物理删除
    check(!!mailRow(dbPath, "mail_dead"), "读口滤掉 ≠ 已删除（物理删除交给清理任务）");

    //#endregion

    //#region 三、清理判据

    console.log("— 三、清理：已领 / 压根没奖励才删，还有没领奖励的过期行删不掉 —");

    insertMail(dbPath, { id: "mail_pure_dead", roleId, title: "无奖励已过期", expiresAt: Date.now() - 2000 });
    insertMail(dbPath, { id: "mail_claimed_dead", roleId, title: "已领已过期", bindGold: 100, expiresAt: Date.now() - 2000, claimedAt: Date.now() - 3000 });
    insertMail(dbPath, { id: "mail_reward_dead", roleId, title: "带未领附件已过期", bindGold: 100, attachments: [{ goodId: "material_iron", count: 1 }], expiresAt: Date.now() - 2000 });
    // #867：只有绑定元宝、没有附件的那批 —— 老判据（`attachments = '[]'`）会把它连奖励一起删掉
    insertMail(dbPath, { id: "mail_bind_gold_dead", roleId, title: "纯绑定元宝未领已过期", bindGold: 100, expiresAt: Date.now() - 2000 });
    insertMail(dbPath, { id: "mail_forever", roleId, title: "永不过期", expiresAt: null });

    // 本节开头已有 3 条可清样本（mail_dead / mail_pure_dead / mail_claimed_dead），
    // 批上限 = 2，正好在这里就把「跨批」钉死：一轮 2 条、下一轮 1 条
    let removed = purge.sweep();
    check(removed === 2, "MAIL_PURGE_BATCH=2 → 一轮正好删 2 条（跨批：还剩 1 条可清）", `${removed}`);
    removed = purge.sweep();
    check(removed === 1, "下一轮把剩下的 1 条清干净", `${removed}`);
    check(!mailRow(dbPath, "mail_dead") && !mailRow(dbPath, "mail_pure_dead") && !mailRow(dbPath, "mail_claimed_dead"), "无奖励已过期 / 已领已过期的行被物理删除");
    check(!!mailRow(dbPath, "mail_reward_dead"), "带未领附件的行即使过期也不删（过期不等于替玩家扔奖励）");
    check(!!mailRow(dbPath, "mail_bind_gold_dead"), "**纯绑定元宝未领**的行即使过期也不删（#867：老判据把它连奖励一起删了）");
    check(!!mailRow(dbPath, "mail_forever"), "expires_at 为空的行永不删");

    //#endregion

    //#region 四、批量

    console.log("— 四、批量：一轮不超过 MAIL_PURGE_BATCH（本次进程调成 2） —");

    const extra = [];
    for (let i = 0; i < 3; i++) {
      insertMail(dbPath, { id: `mail_batch_${i}`, roleId, title: `批量 ${i}`, expiresAt: Date.now() - 3000 - i });
      extra.push(`mail_batch_${i}`);
    }
    removed = purge.sweep();
    check(removed === 2, "MAIL_PURGE_BATCH=2 → 一轮正好删 2 条", `${removed}`);
    const remaining = extra.filter((id) => mailRow(dbPath, id)).length;
    check(remaining === 1, "第三条留到下一轮（跨批）", `${remaining}`);
    removed = purge.sweep();
    check(removed >= 1 && extra.every((id) => !mailRow(dbPath, id)), "再扫一轮把剩下的清干净", `${removed}`);

    //#endregion
  } catch (error) {
    failures.push(String(error && error.stack ? error.stack : error));
    console.log(`\n✗ 未捕获异常：${error && error.stack ? error.stack : error}`);
  }

  finish("e2e-mail-expiry 全绿");

  /** 未读数断言（boxOf 从同一份列表算，过期的不算它） */
  function checkEqualUnread(box, expected) {
    check(box.data.unread === expected, `未读数 ${expected}（过期的不算）`, JSON.stringify(box.data.unread));
  }
})();
