#!/usr/bin/env node
/**
 * 过期前自动入包专项 e2e（server/test/e2e-mail-auto-claim.cjs，issue #867）
 *
 * 盯的不变量（改自动入包 / 清理判据 / 发奖入口后必须全绿）：
 * 一、**到点才动**：到期还早（10 天后）的邮件一轮下来纹丝不动；到期前 3 天内的
 *     金币 / 经验 / 物品一次进包，邮件同时标已领 + `auto_claimed_at` + 正文追加一句
 * 二、**纯金币也入包**（#867 的核心）：`attachments = '[]'` 但 `gold > 0` 的行也必须在候选里 ——
 *     只认附件的实现会让这批补偿邮件到期后被 `purgeExpired` 物理删除，奖励凭空蒸发
 * 三、**只对离线角色做**：`accounts.online_role_id` 指着的角色不动（在线存档在客户端手里，
 *     服务端改库会被下一次全量覆盖冲掉）；下线后下一轮才入包
 * 四、**背包满失败不删**：`auto_attempts + 1`、`claimed_at` 仍为空、邮件还在箱里；
 *     清出格子后下一轮自己入包
 * 五、**幂等**：同一封连跑两轮只发一次（`markClaimed` 命中 0 行 = 已在别处领走）
 * 六、**清理闸**：入包成功（已领）的过期行可以被清掉；没入包的过期行清不掉 ——
 *     两半合起来才是「过期不删、自动入包」
 *
 * 用 in-process 起 Nest（与 e2e-mail-expiry 同款）：`sweep()` 要直调，spawn 起的进程够不着。
 * 用法：先 `npm run build`，再 `node test/e2e-mail-auto-claim.cjs`
 */
const os = require("node:os");
const path = require("node:path");

// 直插样本要用文件库（:memory: 在两个连接之间不共享同一份数据）
process.env.DB_PATH = path.join(os.tmpdir(), `olua-e2e-mail-auto-claim-${Date.now()}.db`);
process.env.ADMIN_REGISTER_CODE = "unused";
// 定时器调成 1 小时：本套件全程直调 sweep()，不让后台那一轮插进断言之间
process.env.MAIL_AUTO_CLAIM_INTERVAL_MS = "3600000";
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

//#region 断言小工具（与 e2e-mail-expiry 同款口径）

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

const DAY = 24 * 60 * 60 * 1000;

let baseUrl = "";

async function api(method, route, options = {}) {
  const headers = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}/${route}`, {
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

/** 直插一行邮件（`expires_at` 想怎么伪造就怎么伪造：候选判据的样本只能走库） */
function insertMail(dbPath, mail) {
  const db = new DatabaseSync(dbPath);
  db.prepare(
    `INSERT INTO role_mails (id, role_id, channel, kind, title, body, gold, exp, attachments, read_at, claimed_at, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    mail.id,
    mail.roleId,
    mail.channel ?? "system",
    mail.kind ?? "system",
    mail.title ?? "自动入包样本",
    mail.body ?? "",
    mail.gold ?? 0,
    mail.exp ?? 0,
    JSON.stringify(mail.attachments ?? []),
    mail.readAt ?? null,
    mail.claimedAt ?? null,
    mail.expiresAt ?? null,
    mail.createdAt ?? Date.now(),
  );
  db.close();
}

/** 直读一行的领取 / 自动入包状态 */
function mailRow(dbPath, mailId) {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT claimed_at, auto_claimed_at, auto_attempts, body FROM role_mails WHERE id = ?").get(mailId);
  db.close();
  return row || null;
}

/** 角色的金币与背包（发奖是否真的落进存档，只有直读能看见） */
function roleState(dbPath, roleId) {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT data FROM roles WHERE id = ?").get(roleId);
  db.close();
  const data = row && row.data ? JSON.parse(row.data) : {};
  const cells = [];
  for (const line of Array.isArray(data.bag) ? data.bag : []) {
    if (Array.isArray(line)) cells.push(...line);
  }
  // 邮件的 `gold` 奖励入的是 bindGold（唯一货币，#843/#844）—— 下游断言里的 `.gold` 都读它
  return { gold: Number(data.bindGold) || 0, exp: Number(data.exp) || 0, cells, data };
}

/** 写角色存档的背包（塞满 / 清空都走它） */
function setBag(dbPath, roleId, bag) {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT data FROM roles WHERE id = ?").get(roleId);
  const data = row && row.data ? JSON.parse(row.data) : {};
  data.bag = bag;
  db.prepare("UPDATE roles SET data = ? WHERE id = ?").run(JSON.stringify(data), roleId);
  db.close();
}

/** 把账号的「在线角色」设成某个角色 / 清空（自动入包的在线闸就看这一列） */
function setOnlineRole(dbPath, roleId, online) {
  const db = new DatabaseSync(dbPath);
  if (online) {
    db.prepare("UPDATE accounts SET online_role_id = ? WHERE id = (SELECT account_id FROM roles WHERE id = ?)").run(roleId, roleId);
  } else {
    db.prepare("UPDATE accounts SET online_role_id = NULL WHERE id = (SELECT account_id FROM roles WHERE id = ?)").run(roleId);
  }
  db.close();
}

/** 4×10 全空 */
function emptyBag() {
  return Array.from({ length: 4 }, () => Array.from({ length: 10 }, () => null));
}

/** 4×10 全塞同一种材料（背包满） */
function fullBag() {
  return Array.from({ length: 4 }, () => Array.from({ length: 10 }, () => ({ id: "material_hide", count: 99 })));
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
  const autoClaim = app.get(require("../dist/modules/game-mail/game-mail-auto-claim.service").GameMailAutoClaimService);
  const purge = app.get(require("../dist/modules/game-mail/game-mail-purge.service").GameMailPurgeService);
  const mailService = app.get(require("../dist/modules/game-mail/game-mail.service").GameMailService);

  try {
    //#region 准备

    console.log("— 准备：玩家 / 角色 / 先下线（自动入包只对离线角色做）—");
    const player = await api("POST", "auth/register", { body: { username: "auto_claim_player", password: "pass1234" } });
    const token = player.data.token;
    const role = await api("POST", "roles", { token, body: { name: "自动入包甲", occupation: "1", sex: "1" } });
    check(role.code === 0 && !!role.data.id, "准备：角色已建好", role.message);
    const roleId = role.data.id;
    setBag(dbPath, roleId, emptyBag());
    setOnlineRole(dbPath, roleId, false);
    const before = roleState(dbPath, roleId);

    //#endregion

    //#region 一、到点才动

    console.log("— 一、到点才动：还早的不碰，3 天内的一次进包 —");
    const now = Date.now();
    insertMail(dbPath, { id: "mail_later", roleId, title: "还早", gold: 100, expiresAt: now + 10 * DAY });
    insertMail(dbPath, {
      id: "mail_soon",
      roleId,
      title: "快到期",
      body: "补偿如下",
      gold: 500,
      exp: 20,
      attachments: [{ goodId: "material_iron", count: 2 }],
      expiresAt: now + 2 * DAY,
    });

    const round1 = autoClaim.sweep(now);
    check(round1.scanned === 1, "候选只含快到期那一封（还早的 10 天后不在窗口内）", JSON.stringify(round1));
    check(round1.claimed === 1 && round1.failed === 0, "快到期那封入包成功", JSON.stringify(round1));

    const afterSoon = roleState(dbPath, roleId);
    check(afterSoon.gold === before.gold + 500, "金币 +500 真的落进存档", `${before.gold} → ${afterSoon.gold}`);
    check(
      afterSoon.cells.filter((cell) => cell && cell.id === "material_iron").reduce((sum, cell) => sum + cell.count, 0) === 2,
      "附件 2 件进背包",
      JSON.stringify(afterSoon.cells.filter(Boolean)),
    );
    const soonRow = mailRow(dbPath, "mail_soon");
    check(soonRow && soonRow.claimed_at !== null, "邮件被标已领（清理才敢删它）", JSON.stringify(soonRow));
    check(soonRow && soonRow.auto_claimed_at > 0, "记下了「是系统替玩家领的」（auto_claimed_at）", JSON.stringify(soonRow));
    check(
      soonRow && soonRow.body.includes("自动入包") && soonRow.body.startsWith("补偿如下"),
      "正文末尾追加了一句、原文不动",
      JSON.stringify(soonRow && soonRow.body),
    );
    const laterRow = mailRow(dbPath, "mail_later");
    check(laterRow && laterRow.claimed_at === null && laterRow.auto_attempts === 0, "还早的那封纹丝不动", JSON.stringify(laterRow));

    //#endregion

    //#region 二、纯金币也入包

    console.log("— 二、纯金币邮件也入包（#867 的核心：只认 attachments 就会漏掉这一批）—");
    insertMail(dbPath, { id: "mail_gold_only", roleId, title: "纯金币补偿", gold: 300, expiresAt: now + 1 * DAY });
    const round2 = autoClaim.sweep(now);
    check(round2.claimed === 1, "纯金币那封进了候选并成功入包", JSON.stringify(round2));
    check(roleState(dbPath, roleId).gold === afterSoon.gold + 300, "金币再 +300", `${roleState(dbPath, roleId).gold}`);
    check(mailRow(dbPath, "mail_gold_only").claimed_at !== null, "纯金币那封也被标已领");

    //#endregion

    //#region 三、只对离线角色做

    console.log("— 三、在线角色不动（在线存档在客户端手里，服务端改了会被覆盖）—");
    setOnlineRole(dbPath, roleId, true);
    insertMail(dbPath, { id: "mail_online", roleId, title: "在线时的快到期", gold: 700, expiresAt: now + 1 * DAY });
    const goldBeforeOnline = roleState(dbPath, roleId).gold;
    const round3 = autoClaim.sweep(now);
    check(round3.scanned === 0 && round3.claimed === 0, "在线角色的快到期邮件不进候选", JSON.stringify(round3));
    check(roleState(dbPath, roleId).gold === goldBeforeOnline, "金币一分没动", `${roleState(dbPath, roleId).gold}`);
    check(mailRow(dbPath, "mail_online").claimed_at === null, "邮件仍未被领");

    setOnlineRole(dbPath, roleId, false);
    const round4 = autoClaim.sweep(now);
    check(round4.claimed === 1, "下线后下一轮就入包了", JSON.stringify(round4));
    check(roleState(dbPath, roleId).gold === goldBeforeOnline + 700, "金币 +700", `${roleState(dbPath, roleId).gold}`);

    //#endregion

    //#region 四、背包满失败不删

    console.log("— 四、背包满：记次数、邮件留着，清出格子后自己入包 —");
    setBag(dbPath, roleId, fullBag());
    const goldBeforeFull = roleState(dbPath, roleId).gold;
    insertMail(dbPath, {
      id: "mail_full",
      roleId,
      title: "要放物品但包满",
      gold: 50,
      attachments: [{ goodId: "material_iron", count: 1 }],
      expiresAt: now + 1 * DAY,
    });
    const round5 = autoClaim.sweep(now);
    check(round5.failed === 1 && round5.claimed === 0, "背包满 → 这一封失败", JSON.stringify(round5));
    const fullRow = mailRow(dbPath, "mail_full");
    check(fullRow && fullRow.auto_attempts === 1, "失败次数记成 1（且没被事务回滚抹掉）", JSON.stringify(fullRow));
    check(fullRow && fullRow.claimed_at === null, "「已领」随事务回滚，仍是未领", JSON.stringify(fullRow));
    check(roleState(dbPath, roleId).gold === goldBeforeFull, "金币一分没发出去（整封回滚）", `${roleState(dbPath, roleId).gold}`);

    const round6 = autoClaim.sweep(now);
    check(round6.failed === 1, "再跑一轮还是失败（包还是满的）", JSON.stringify(round6));
    check(mailRow(dbPath, "mail_full").auto_attempts === 2, "失败次数累加到 2", `${mailRow(dbPath, "mail_full").auto_attempts}`);

    setBag(dbPath, roleId, emptyBag());
    const round7 = autoClaim.sweep(now);
    check(round7.claimed === 1, "清出格子后下一轮自己入包", JSON.stringify(round7));
    const healedRow = mailRow(dbPath, "mail_full");
    check(healedRow.claimed_at !== null && healedRow.auto_attempts === 2, "成功时不再清失败次数（留下「曾经卡过」的痕迹）", JSON.stringify(healedRow));
    check(roleState(dbPath, roleId).gold === goldBeforeFull + 50, "金币 +50", `${roleState(dbPath, roleId).gold}`);

    //#endregion

    //#region 五、幂等

    console.log("— 五、幂等：同一封连跑两轮只发一次 —");
    const goldBeforeIdem = roleState(dbPath, roleId).gold;
    const round8 = autoClaim.sweep(now);
    check(round8.scanned === 0 && round8.claimed === 0, "已领的行不再进候选（claimed_at 非空）", JSON.stringify(round8));
    check(roleState(dbPath, roleId).gold === goldBeforeIdem, "金币没有第二次入账", `${roleState(dbPath, roleId).gold}`);

    //#endregion

    //#region 六、清理闸

    console.log("— 六、清理闸：入包过的能删，没入包的删不掉 —");
    insertMail(dbPath, {
      id: "mail_expired_claimed",
      roleId,
      title: "入包后已过期",
      gold: 10,
      expiresAt: now - 1000,
      claimedAt: now - 500,
    });
    insertMail(dbPath, { id: "mail_expired_unclaimed", roleId, title: "过期但没入包", gold: 10, expiresAt: now - 1000 });
    purge.sweep(now);
    check(!mailRow(dbPath, "mail_expired_claimed"), "已领的过期行被物理清掉（回收磁盘）");
    check(!!mailRow(dbPath, "mail_expired_unclaimed"), "还有没领奖励的过期行**不允许**删（奖励不能凭空蒸发）");

    //#endregion

    //#region 七、默认保质期

    console.log("— 七、默认保质期：不传 = 30 天，显式 0 = 永久 —");
    const defaulted = mailService.send(roleId, { channel: "system", kind: "system", title: "没给 TTL" });
    check(
      defaulted.expires_at !== null && Math.abs(defaulted.expires_at - (defaulted.created_at + 30 * DAY)) < 5,
      "不传 ttlMs → 30 天后过期（#867 之前是「永久」，谁忘了给就永远挂在箱子里）",
      JSON.stringify(defaulted.expires_at),
    );
    const forever = mailService.send(roleId, { channel: "system", kind: "system", title: "显式永久", ttlMs: 0 });
    check(forever.expires_at === null, "ttlMs: 0 → 永久（人工补发走这条）", JSON.stringify(forever.expires_at));

    //#endregion
  } finally {
    await app.close();
  }

  finish("邮件过期前自动入包（#867）全部通过");
})().catch((error) => {
  console.error("");
  console.error("e2e 崩了：", error && error.stack ? error.stack : error);
  process.exit(1);
});
