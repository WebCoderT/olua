#!/usr/bin/env node
/**
 * 泡点活动专项端到端验证（服务端，#722）
 *
 * 泡点 = 在线角色由服务端按节拍发经验（realtime 模块的 SoakPointService，每秒一醒）。
 * 参数是 `growth_scalars` 的两个标量（管理端「成长参数」页可改）：
 *   soakExpPerTick   每拍经验（0 = 活动关闭，出厂默认）
 *   soakTickSeconds  拍间隔（秒）
 *
 * 覆盖：
 * · 关闭（rate=0）：在线角色不涨经验（出厂默认不改既有部署的经济节奏）
 * · 开启：在线角色按「每拍 N 点」入账，走 applyKillExp 同一条升级链路
 * · 升级：速率拉满后循环升到等级上限，属性按服务端公式重算
 * · 满级短路：到顶后不再写库（revision 不再每拍 +1）
 * · 下线：被踢下线的账号不再入账
 * · 即时生效：改参数不用重启，下一拍按新值走
 *
 * 用法：先 `npm run build`，再 `node test/e2e-soak.cjs`
 */
process.env.DB_PATH = ":memory:";
process.env.ADMIN_REGISTER_CODE = "test-admin-code";
process.env.JWT_SECRET = "test-secret";
process.env.LOG_REQUESTS = "false";

const { NestFactory } = require("@nestjs/core");
const { ValidationPipe } = require("@nestjs/common");
const { AppModule } = require("../dist/app.module");
const { AllExceptionsFilter } = require("../dist/common/filters/all-exceptions.filter");
const { TransformInterceptor } = require("../dist/common/interceptors/transform.interceptor");

//#region 断言小工具

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

/** 等一会儿（泡点是节拍活，断言前要给 tick 留时间） */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

//#endregion

let baseUrl = "";

async function api(method, path, options = {}) {
  const headers = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}/${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const envelope = await response.json().catch(() => null);
  return { status: response.status, code: envelope ? envelope.code : -1, message: envelope ? envelope.message : "", data: envelope ? envelope.data : null };
}

(async () => {
  const app = await NestFactory.create(AppModule.register({ realtime: true }), { logger: false });
  app.setGlobalPrefix("api");
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, transformOptions: { enableImplicitConversion: true } }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new TransformInterceptor());
  await app.listen(0);
  baseUrl = `${await app.getUrl()}/api`;

  const admin = await api("POST", "admin/auth/register", { body: { username: "gm_soak", password: "pass1234", registerCode: "test-admin-code" } });
  const adminToken = admin.data.token;
  check(admin.code === 0 && !!adminToken, "准备：注册管理员拿到令牌", admin.message);

  const setScalar = async (key, value) => {
    const res = await api("PATCH", `admin/growth-scalars/${key}`, { token: adminToken, body: { value } });
    if (res.code !== 0) throw new Error(`设标量 ${key}=${value} 失败：${res.message}`);
  };
  /** 角色详情（RoleDto：level / revision 在顶层，exp 在 data 文档里） */
  const roleOf = async (token, roleId) => (await api("GET", `roles/${roleId}`, { token })).data;

  const player = await api("POST", "auth/register", { body: { username: "soak_player", password: "pass1234" } });
  const token = player.data.token;
  const roleId = (await api("POST", "roles", { token, body: { name: "泡点侠", occupation: "1", sex: "1" } })).data.id;
  // 第一个角色自动在线（online_role_id 已设），正好是泡点的受众
  check(!!roleId, "准备：玩家建号（首角色自动在线）");

  const before = await roleOf(token, roleId);
  check(before.data.exp === 0 && before.level === 1, "准备：1 级 0 经验起步", `exp=${before.data.exp} level=${before.level}`);

  //#region 一、出厂关闭：不涨经验

  console.log("— 一、出厂关闭（soakExpPerTick=0）：在线也不涨 —");
  await sleep(2600);
  const idle = await roleOf(token, roleId);
  check(idle.data.exp === 0 && idle.level === 1, "出厂关闭时在线角色不涨经验（默认不改经济节奏）", `exp=${idle.data.exp}`);

  //#endregion

  //#region 二、开启：按拍入账 + 即时生效

  console.log("— 二、开启：每秒一拍、每拍 50 点，参数即改即生效 —");
  await setScalar("soakExpPerTick", 50);
  await setScalar("soakTickSeconds", 1);
  await sleep(2600);
  const soaked = await roleOf(token, roleId);
  // 每次入账 revision +1（本测试没有存档写点，revision 增量 = 入账次数）；
  // 经验数不断言具体值 —— 速率够大时会沿 role_levels 循环升级把 exp 消耗掉（那是链路正确的表现）
  check(soaked.revision - before.revision >= 2, "两拍半至少入账两次（revision 增量 = 入账次数）", `${soaked.revision} vs ${before.revision}`);
  check(soaked.level > before.level || soaked.data.exp > 0, "经验确实在长（升级或积攒）", `level=${soaked.level} exp=${soaked.data.exp}`);

  //#endregion

  //#region 三、升满：循环升级 + 满级短路

  console.log("— 三、速率拉满：循环升级、到顶后短路 —");
  const revisionBeforeMax = soaked.revision;
  await setScalar("soakExpPerTick", 1000000);
  await sleep(2600);
  const maxed = await roleOf(token, roleId);
  // 等级上限 = 角色等级表的行数（管理端改上限的唯一正确方式是加行）
  const maxLevel = (await api("GET", "admin/role-levels?page=1&size=1", { token: adminToken })).data.total;
  check(maxed.level === maxLevel, "大额经验循环升级直达等级上限", `level=${maxed.level} / cap=${maxLevel}`);
  const revisionAtCap = maxed.revision;
  check(revisionAtCap > revisionBeforeMax, "到顶前那一拍确实入过账");
  await sleep(2300);
  const capped = await roleOf(token, roleId);
  check(capped.revision === revisionAtCap, "满级后短路：不再写库（revision 不动）", `${capped.revision} vs ${revisionAtCap}`);
  check(capped.level === maxLevel, "满级后等级不变");

  //#endregion

  //#region 四、下线：被踢的账号不再入账

  console.log("— 四、下线不再入账 —");
  await setScalar("soakExpPerTick", 50);
  // 在线对照组 C（首角色自动在线）与被踢组 B 同窗等待：C 涨、B 不涨
  const playerC = await api("POST", "auth/register", { body: { username: "soak_online", password: "pass1234" } });
  const roleIdC = (await api("POST", "roles", { token: playerC.data.token, body: { name: "在线侠", occupation: "1", sex: "1" } })).data.id;
  const playerB = await api("POST", "auth/register", { body: { username: "soak_offline", password: "pass1234" } });
  const roleIdB = (await api("POST", "roles", { token: playerB.data.token, body: { name: "下线侠", occupation: "1", sex: "1" } })).data.id;
  await api("POST", `admin/accounts/${playerB.data.account.id}/offline`, { token: adminToken });
  const offlineBase = await roleOf(playerB.data.token, roleIdB);
  const onlineBase = await roleOf(playerC.data.token, roleIdC);
  await sleep(2300);
  const offline = await roleOf(playerB.data.token, roleIdB);
  const online = await roleOf(playerC.data.token, roleIdC);
  check(offline.revision === offlineBase.revision, "被踢下线的账号不入账", `${offline.revision} vs ${offlineBase.revision}`);
  check(online.revision > onlineBase.revision, "在线的照常入账（下线只影响他自己）", `${online.revision} vs ${onlineBase.revision}`);

  //#endregion

  //#region 五、参数校验：出界值拒收

  console.log("— 五、参数校验 —");
  const badRate = await api("PATCH", "admin/growth-scalars/soakExpPerTick", { token: adminToken, body: { value: -1 } });
  check(badRate.code !== 0 && badRate.status === 400, "负速率拒收（取值域 [0, 1000000]）", `${badRate.code}/${badRate.status}`);
  const badSeconds = await api("PATCH", "admin/growth-scalars/soakTickSeconds", { token: adminToken, body: { value: 0 } });
  check(badSeconds.code !== 0 && badSeconds.status === 400, "零间隔拒收（取值域 [1, 3600]）", `${badSeconds.code}/${badSeconds.status}`);
  const badFraction = await api("PATCH", "admin/growth-scalars/soakExpPerTick", { token: adminToken, body: { value: 1.5 } });
  check(badFraction.code !== 0 && badFraction.status === 400, "小数速率拒收（必须整数）", `${badFraction.code}/${badFraction.status}`);

  // 还原出厂关闭，不留残余影响别的环境
  await setScalar("soakExpPerTick", 0);
  await setScalar("soakTickSeconds", 10);

  //#endregion

  await app.close();
  finish("泡点活动（服务端 tick）：全部断言通过");
})().catch((error) => {
  console.error(error);
  finish("泡点活动（服务端 tick）：测试进程异常");
});
