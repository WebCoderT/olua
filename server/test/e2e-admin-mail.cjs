#!/usr/bin/env node
/**
 * 管理端游戏消息补发专项 e2e（server/test/e2e-admin-mail.cjs，issue #437）
 *
 * 盯的不变量（改补发入口 / 频道收窄 / 发奖路径后必须全绿）：
 * 一、鉴权：观察员 403 / 玩家令牌 401 —— 发给玩家东西是运营动作，不是看数据
 * 二、入参：频道只认 system / reward（social / combat 是系统事实记录 → 400）、
 *     角色不存在 404、缺标题 / 物品数量非法 400
 * 三、补发成功：落库走 GameMailService.send 同一个口子（channel / kind / 附件同形）、
 *     附件金额与物品可被客户端领到手（与任务交付同一个发奖入口）
 * 四、频道落位：reward 发的进「奖励」栏
 * 五、离线收件：不要求在线角色，换绑在线角色后收件箱里就是那封
 * 六、审计：谁在什么时候给哪个角色发了什么（action = adminGameMail.send，target = 角色）
 * 七、文档：新接口落在「管理端」分组且带 gameMail:send 权限点标注
 *
 * 用法：先 `npm run build`，再 `node test/e2e-admin-mail.cjs`
 */
process.env.DB_PATH = ":memory:";
process.env.ADMIN_REGISTER_CODE = "test-admin-code";
process.env.JWT_SECRET = "test-secret";
process.env.LOG_REQUESTS = "false";
process.env.CORS_ORIGINS = "*";

const { NestFactory } = require("@nestjs/core");
const { ValidationPipe } = require("@nestjs/common");
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
/** 管理端请求所在的区（#960）：一个 e2e 进程只在一个区里干活，管理端请求统一带它 */
const ADMIN_ZONE = 1;

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

/** 补发一次的快捷封装（body 部分字段缺省也能发） */
function sendMail(roleId, token, body) {
  return api("POST", `admin/game-mail/roles/${roleId}`, { token, body: { title: "运营补发", channel: "system", ...body } });
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

  try {
    //#region 准备

    console.log("— 准备：超管 + 观察员 + 两个玩家 —");

    const superAdmin = await api("POST", "admin/auth/register", {
      body: { username: "gm_mail", password: "pass1234", registerCode: "test-admin-code" },
    });
    const adminToken = superAdmin.data.token;
    check(superAdmin.code === 0 && !!adminToken, "准备：注册超管拿到令牌", superAdmin.message);

    const viewer = await api("POST", "admin/auth/register", { body: { username: "gm_mail_view", password: "pass1234", registerCode: "test-admin-code" } });
    const viewerToken = viewer.data.token;
    await api("PATCH", `admin/admins/${viewer.data.admin.id}`, { token: adminToken, zoneId: ADMIN_ZONE, body: { role: "viewer" } });
    const viewerMe = await api("GET", "admin/auth/me", { token: viewerToken, zoneId: ADMIN_ZONE });
    check(viewerMe.data.role === "viewer", "准备：只读观察员已就位", viewerMe.data && viewerMe.data.role);

    const playerA = await api("POST", "auth/register", { body: { username: "mailsend_a", password: "pass1234" } });
    const tokenA = playerA.data.token;
    // #597 起建号只交三样客户端数据，角色 id 由服务端生成
    const roleA = await api("POST", "roles", { token: tokenA, body: { name: "收件人甲", occupation: "1", sex: "1" } });
    const roleAId = roleA.data && roleA.data.id;
    check(roleA.code === 0 && roleA.data.online === true, "准备：玩家甲的在线角色已就位", roleA.message);

    // 乙建两个角色：第一个自动成为在线角色（建号只在「还没有在线角色」时自动上），第二个就是「离线角色」样本
    const playerB = await api("POST", "auth/register", { body: { username: "mailsend_b", password: "pass1234" } });
    const tokenB = playerB.data.token;
    await api("POST", "roles", { token: tokenB, body: { name: "收件人乙一号", occupation: "1", sex: "1" } });
    const roleB2 = await api("POST", "roles", { token: tokenB, body: { name: "收件人乙二号", occupation: "1", sex: "1" } });
    const roleB2Id = roleB2.data && roleB2.data.id;
    check(roleB2.code === 0 && roleB2.data.online === false, "准备：玩家乙建了两个角色（一号在线、二号离线）");
    // #597 起初始 bag 是空数组（没有网格），而服务端不扩容 —— 先存一张规范化空网格（4×10），
    // 后面「领物品附件进背包」才有格子可落
    const initialA = await api("GET", `roles/${roleAId}`, { token: tokenA });
    const griddedA = await api("PUT", `roles/${roleAId}`, {
      token: tokenA,
      body: {
        revision: initialA.data && initialA.data.revision,
        data: { ...(initialA.data.data || {}), bag: Array.from({ length: 4 }, () => Array.from({ length: 10 }, () => null)) },
      },
    });
    check(griddedA.code === 0, "准备：存档带上规范化空网格（服务端不扩容语义的前提）", griddedA.message);

    //#endregion

    //#region 一、鉴权

    console.log("— 一、鉴权：观察员 403、玩家令牌 401 —");

    const denied = await sendMail(roleAId, viewerToken, {});
    check(denied.status === 403 && denied.code === 30006, "观察员补发被拒（403 / 30006：观察员没有 gameMail:send）", `${denied.status}/${denied.code}`);
    const playerDenied = await sendMail(roleAId, tokenA, {});
    check(playerDenied.status === 401, "玩家令牌调管理端接口被拒（401：audience 不符）", `${playerDenied.status}`);

    //#endregion

    //#region 二、入参

    console.log("— 二、入参：频道收窄 / 角色存在性 / 形状校验 —");

    const social = await sendMail(roleAId, adminToken, { channel: "social" });
    check(social.status === 400 && social.code === 40000, "channel=social → 400（社交栏是系统事实记录，人工不发）", `${social.status}/${social.code}`);
    const combat = await sendMail(roleAId, adminToken, { channel: "combat" });
    check(combat.status === 400 && combat.code === 40000, "channel=combat → 400（战斗栏同理）", `${combat.status}/${combat.code}`);

    const missingRole = await sendMail("role_nope", adminToken, {});
    check(missingRole.status === 404 && missingRole.code === 20002, "收件角色不存在 → 404（20002）", `${missingRole.status}/${missingRole.code}`);

    const noTitle = await api("POST", "admin/game-mail/roles/${roleAId}", { token: adminToken, zoneId: ADMIN_ZONE, body: { channel: "system" } });
    check(noTitle.status === 400, "缺标题 → 400（标题必填）", `${noTitle.status}`);
    const longTitle = await sendMail(roleAId, adminToken, { title: "长".repeat(61) });
    check(longTitle.status === 400, "标题超 60 字 → 400", `${longTitle.status}`);
    const badCount = await sendMail(roleAId, adminToken, { items: [{ goodId: "material_iron", count: 0 }] });
    check(badCount.status === 400, "物品数量 0 → 400（数量至少 1）", `${badCount.status}`);

    //#endregion

    //#region 三、补发成功与领取

    console.log("— 三、补发成功：落库同形、附件可领到手 —");

    const bindGoldBefore = await api("GET", `roles/${roleAId}`, { token: tokenA });
    const sent = await sendMail(roleAId, adminToken, {
      title: "开服补偿",
      body: "感谢支持。",
      bindGold: 500,
      exp: 200,
      items: [{ goodId: "material_iron", count: 2 }],
    });
    check(sent.code === 0 && !!sent.data.id, "补发成功，返回落库后的那封", sent.message);
    check(
      sent.data.channel === "system" && sent.data.kind === "admin" && sent.data.title === "开服补偿",
      "返回的频道 system / 来源标签 admin / 标题原样",
      JSON.stringify(sent.data),
    );
    check(
      sent.data.bindGold === 500 && sent.data.exp === 200 && sent.data.attachments.length === 1 && sent.data.attachments[0].count === 2,
      "附件（绑定元宝 / 经验 / 物品）原样落库并下发",
      JSON.stringify(sent.data.attachments),
    );

    const box = await api("GET", "mails/me", { token: tokenA });
    const inBox = (box.data.mails || []).find((row) => row.id === sent.data.id);
    check(!!inBox && inBox.claimed === false, "玩家收件箱里就是那一封（未领取）");

    const claim = await api("POST", `mails/${sent.data.id}/claim`, { token: tokenA });
    check(claim.code === 0 && claim.data.bindGold === 500 && claim.data.items.length === 1, "领取成功：绑定元宝 500 + 物品 1 条", claim.message);
    check(claim.data.items[0] && claim.data.items[0].goodId === "material_iron", "领到手的物品 id 正确（material_iron）", JSON.stringify(claim.data.items));
    const bindGoldAfter = await api("GET", `roles/${roleAId}`, { token: tokenA });
    check(
      (bindGoldAfter.data.data.bindGold || 0) - (bindGoldBefore.data.data.bindGold || 0) === 500,
      "绑定元宝真的进了角色存档（差额 500）",
      `${bindGoldBefore.data.data.bindGold} → ${bindGoldAfter.data.data.bindGold}`,
    );

    //#endregion

    //#region 四、频道落位

    console.log("— 四、频道落位：reward 发的进「奖励」栏 —");

    const rewardSent = await sendMail(roleAId, adminToken, { channel: "reward", title: "奖励栏补发" });
    check(rewardSent.code === 0, "reward 频道补发成功", rewardSent.message);
    const rewardBox = await api("GET", "mails/me", { token: tokenA });
    const rewardSummary = (rewardBox.data.channels || []).find((row) => row.channel === "reward");
    const rewardMails = (rewardBox.data.mails || []).filter((row) => row.channel === "reward" && row.kind === "admin");
    check(
      !!rewardSummary && rewardSummary.total === rewardMails.length && rewardMails.some((row) => row.id === rewardSent.data.id),
      "「奖励」栏角标与列表一致（人工补发那封在 reward）",
      JSON.stringify(rewardSummary),
    );

    //#endregion

    //#region 五、离线收件

    console.log("— 五、离线收件：不要求在线角色 —");

    const offline = await sendMail(roleB2Id, adminToken, { title: "离线也能收" });
    check(offline.code === 0, "发给离线角色成功（邮件本来就是异步的）", offline.message);
    const switchOnline = await api("POST", `admin/roles/${roleB2Id}/select`, { token: adminToken, zoneId: ADMIN_ZONE });
    check(switchOnline.code === 0, "管理端把玩家乙的在线角色切到一号", switchOnline.message);
    const offlineBox = await api("GET", "mails/me", { token: tokenB });
    check(
      (offlineBox.data.mails || []).some((row) => row.id === offline.data.id),
      "换绑在线角色后，离线期间收到的补发就在收件箱里",
    );

    //#endregion

    //#region 六、审计

    console.log("— 六、审计：谁给哪个角色发了什么 —");

    const audit = await api("GET", "admin/audit-logs?action=adminGameMail.send&size=50", { token: adminToken, zoneId: ADMIN_ZONE });
    const entry = (audit.data.list || []).find((row) => row.targetId === roleAId);
    check(!!entry, "审计日志里有 adminGameMail.send 的记录", audit.message);
    check(
      !!entry && entry.targetType === "role" && entry.success === true && entry.actorName === "gm_mail",
      "审计目标 = 角色、操作人 = 发送的管理员",
      JSON.stringify(entry),
    );

    //#endregion

    //#region 七、文档

    console.log("— 七、文档：管理端分组 + 权限点标注 —");

    const docResponse = await fetch(`${baseUrl.replace(/\/api$/, "")}/api-docs-json`);
    const doc = await docResponse.json();
    const operation = (doc.paths["/api/admin/game-mail/roles/{id}"] || {}).post;
    check(!!operation, "文档里有 POST /api/admin/game-mail/roles/{id}");
    check(
      !!operation && operation.tags && operation.tags.length === 1 && operation.tags[0] === "管理端",
      "恰好一个分组且是「管理端」",
      JSON.stringify(operation && operation.tags),
    );
    check(
      !!operation && Array.isArray(operation["x-olua-permissions"]) && operation["x-olua-permissions"].indexOf("gameMail:send") !== -1,
      "标注了 gameMail:send 权限点",
      JSON.stringify(operation && operation["x-olua-permissions"]),
    );

    //#endregion
  } catch (error) {
    failures.push(String(error && error.stack ? error.stack : error));
    console.log(`\n✗ 未捕获异常：${error && error.stack ? error.stack : error}`);
  }

  finish("e2e-admin-mail 全绿");
})();
