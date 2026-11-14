#!/usr/bin/env node
/**
 * 血蓝收权专项端到端验证（服务端，#596）
 *
 * 血蓝的权威链路：受击（实时侧 applyMonsterHit）/ 用药（useDrug）/ 升级补满（applyKillExp）
 * 各有服务端写点，**自然回复**由 settleVitalsAuthority 在每次服务端写档时按经过时间补齐，
 * **复活**走 POST /roles/:id/revive。这份只盯「客户端上报的血蓝不再被照单全收」这一块：
 *
 * · save：离谱上报（超上限 / 负数）被夹回上限与 0 —— 当前值以服务端结算为准
 * · save：结算游标（vitalsSettledAt）由服务端维护，客户端伪造无效
 * · save：死亡状态（hp=0）不回复 —— 上报满血不能把人「救活」
 * · revive：未死亡拒收（20015）；死亡时补满血蓝、上限是服务端重算值
 * · revive：revision 不推进（血量型写入走实时帧，与 applyMonsterHit 同一纪律）
 * · 管理端 PATCH hp/mp：运营旁路（救卡死号），改值同时重置结算游标
 * · 自然回复速度：#605 起读 `growth_scalars.mpRecoverPerSecond`（管理端可改），改 0 不回蓝、改 20 明显回蓝
 * · 文档：revive 落在「玩家」分组，模型已登记
 *
 * 用法：先 `npm run build`，再 `node --disable-warning=ExperimentalWarning test/e2e-role-vitals.cjs`
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
// 存档 PUT 的公共帮手（#820 起 revision 必填：先 GET 拿修订号再 PUT）
const { saveRole } = require("./lib/role-save.cjs");

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

/** 等一段时间（自然回复按真实流逝时间结算，只能用真等待来验；断言都取「至少/必须为」的单边，不怕机器慢） */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

//#endregion

let baseUrl = "";

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

/** 存档文档（PUT 全量覆盖用；血蓝字段会被服务端覆盖，写什么都能用来验「上报无效」） */
function roleData(id, name, occupation, level, overrides = {}) {
  return {
    id,
    name,
    occupation,
    sex: "1",
    level,
    bindGold: 0,
    exp: 0,
    bag: [[null, null], [null, null]],
    equipments: { WEAPON: null, HELMET: null },
    skills: { "1001": 1 },
    shortcutKeys: [],
    onMap: "0",
    ...overrides,
  };
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

  const superAdmin = await api("POST", "admin/auth/register", {
    body: { username: "gm_vitals", password: "pass1234", registerCode: "test-admin-code" },
  });
  const adminToken = superAdmin.data.token;
  const player = await api("POST", "auth/register", { body: { username: "vitals_player", password: "pass1234" } });
  const token = player.data.token;

  const created = await api("POST", "roles", { token, body: { name: "血蓝", occupation: "1", sex: "1" } });
  const roleId = created.data.id;
  check(created.code === 0, "准备：建号成功", created.message);
  // 提到 5 级，让成长曲线给出非 1 级的 maxHp（断言「上限是服务端重算值」才有区分度）。
  // 先随便存一档再取上限：存档路径做权威重算，取值要在重算之后
  await api("PATCH", `admin/roles/${roleId}`, { token: adminToken, zoneId: ADMIN_ZONE, body: { level: 5 } });
  await saveRole(api, token, roleId, roleData(roleId, "血蓝", "1", 5));
  const detail = await api("GET", `roles/${roleId}`, { token });
  const maxHp = detail.data.data.maxHp;
  const maxMp = detail.data.data.maxMp;
  check(maxHp > 0 && maxMp > 0, "准备：详情带服务端重算的资源上限", `${maxHp}/${maxMp}`);

  //#region 一、save：上报血蓝一律被服务端结算值覆盖

  console.log("— 一、save：上报血蓝不再照单全收 —");

  // 建号即满血；把存活角色「改包」成超上限血量 → 结算基线取库里的满血，夹回上限
  const inflated = await saveRole(api, token, roleId, roleData(roleId, "血蓝", "1", 5, { hp: maxHp + 99999, mp: maxMp + 99999 }));
  check(inflated.code === 0, "超上限血蓝的存档本身被接受（回填而不是拒收，见 role-authority 纪律 1）", inflated.message);
  const afterInflated = await api("GET", `roles/${roleId}`, { token });
  check(afterInflated.data.data.hp <= maxHp, "超上报的血量被夹回上限（当前值以服务端为准）", `${afterInflated.data.data.hp}/${maxHp}`);
  check(afterInflated.data.data.mp <= maxMp, "超上报的魔法被夹回上限", `${afterInflated.data.data.mp}/${maxMp}`);

  // 负数同理：基线取库里的值，负上报不会把人扣到负
  // （注意基线不是满血：提级只重算上限，当前血量还是建号时的 1 级满血 —— 结算不凭空补血）
  const baselineHp = afterInflated.data.data.hp;
  const negative = await saveRole(api, token, roleId, roleData(roleId, "血蓝", "1", 5, { hp: -50, mp: -50 }));
  check(negative.code === 0, "负数血蓝的存档被接受");
  const afterNegative = await api("GET", `roles/${roleId}`, { token });
  check(afterNegative.data.data.hp >= 0 && afterNegative.data.data.hp <= maxHp, "负上报后血量仍在 [0, 上限]", `${afterNegative.data.data.hp}`);
  // 基线是库里的值：负上报不会真的把人扣掉（改包「自残」无效）
  check(afterNegative.data.data.hp === baselineHp, "负上报不改变服务端基线（仍是库里上次落账值）", `${afterNegative.data.data.hp} vs ${baselineHp}`);

  // 结算游标：服务端写档后落库，客户端伪造无效
  check(typeof afterNegative.data.data.vitalsSettledAt === "number", "vitalsSettledAt 由服务端落库", JSON.stringify(afterNegative.data.data.vitalsSettledAt));
  const forged = await saveRole(api, token, roleId, roleData(roleId, "血蓝", "1", 5, { vitalsSettledAt: 1 }));
  check(forged.code === 0, "伪造结算游标的存档被接受（游标不是客户端可写字段）");
  const afterForged = await api("GET", `roles/${roleId}`, { token });
  check(
    afterForged.data.data.vitalsSettledAt > 1,
    "伪造的游标被服务端时间覆盖",
    JSON.stringify(afterForged.data.data.vitalsSettledAt),
  );

  //#endregion

  //#region 一·五、自然回复速度读运营配置（#605）

  console.log("— 一·五、魔法自然回复速度读 growth_scalars（#605）—");

  // 这一段**故意 sleep**：要证明的是「配置值真的进了结算公式」，只断言接口回读等于提交值
  // 只能证明存进去了、证明不了用上了。两段各 1.2 秒（合计约 2.4s），断言全取单边
  // （「必须为 0」「至少 +20」），机器再慢也不会假红 —— 这是对上面「e2e 不 sleep」的有意例外。
  const scalarPath = "admin/growth-scalars/mpRecoverPerSecond";
  const lowMp = Math.max(1, Math.floor(maxMp / 4));
  /** 把蓝清到 lowMp 并等一段时间，再走一次存档触发结算 —— 返回结算后的蓝量 */
  const settleAfter = async (waitMs) => {
    await api("PATCH", `admin/roles/${roleId}`, { token: adminToken, zoneId: ADMIN_ZONE, body: { mp: lowMp } });
    await sleep(waitMs);
    await saveRole(api, token, roleId, roleData(roleId, "血蓝", "1", 5));
    const detailAfter = await api("GET", `roles/${roleId}`, { token });
    return detailAfter.data.data.mp;
  };

  const offPatched = await api("PATCH", scalarPath, { token: adminToken, zoneId: ADMIN_ZONE, body: { value: 0 } });
  check(offPatched.code === 0, "回复速度可改（0 = 关闭自然回蓝）", offPatched.message);
  const mpWhenOff = await settleAfter(1200);
  // 累加器在结算后必然 < 1（服务端只留小数部分），所以速度为 0 时一点都不该涨
  check(mpWhenOff === lowMp, "速度为 0 时不回蓝（配置真的进了结算）", `${mpWhenOff} vs ${lowMp}`);

  await api("PATCH", scalarPath, { token: adminToken, zoneId: ADMIN_ZONE, body: { value: 20 } });
  const mpWhenFast = await settleAfter(1200);
  check(mpWhenFast >= Math.min(maxMp, lowMp + 20), "速度为 20 时 1.2 秒至少回 20 点（越改越快的方向也对）", `${mpWhenFast}`);

  // 还原出厂值：同一进程里后面还有复活/管理端旁路的断言，别把速度留在 20
  const restored = await api("PATCH", scalarPath, { token: adminToken, zoneId: ADMIN_ZONE, body: { value: 2 } });
  check(restored.code === 0, "还原出厂回复速度", restored.message);

  //#endregion

  //#region 二、复活：未死亡拒收，死亡时满血

  console.log("— 二、复活接口（POST /roles/:id/revive）—");

  const reviveAlive = await api("POST", `roles/${roleId}/revive`, { token });
  check(reviveAlive.code === 20015 && reviveAlive.status === 409, "未死亡时复活被拒（20015 / 409）", `${reviveAlive.code}/${reviveAlive.status}`);

  // 管理端旁路把人打死（PATCH hp=0；同时会重置结算游标）——这也是运营救卡死号的路径
  const killed = await api("PATCH", `admin/roles/${roleId}`, { token: adminToken, zoneId: ADMIN_ZONE, body: { hp: 0, mp: 0 } });
  check(killed.code === 0 && killed.data.data.hp === 0, "管理端 PATCH hp=0 生效（运营旁路）", JSON.stringify(killed.data && killed.data.data && killed.data.data.hp));

  // 死亡后改包上报满血：save 结算基线取库里的 0，死亡不回复 —— 上报无效
  const fakeReviveSave = await saveRole(api, token, roleId, roleData(roleId, "血蓝", "1", 5, { hp: maxHp, mp: maxMp }));
  check(fakeReviveSave.code === 0, "死亡状态下上报满血的存档被接受");
  const afterFake = await api("GET", `roles/${roleId}`, { token });
  check(afterFake.data.data.hp === 0, "死亡状态不回复：上报满血无效（复活必须走接口）", `${afterFake.data.data.hp}`);

  const revisionBefore = afterFake.data.revision;
  const revived = await api("POST", `roles/${roleId}/revive`, { token });
  check(revived.code === 0, "死亡状态复活成功", revived.message);
  check(revived.data.hp === revived.data.maxHp && revived.data.maxHp === maxHp, "复活满血，上限是服务端重算值", JSON.stringify(revived.data));
  check(revived.data.mp === revived.data.maxMp, "复活满蓝");

  const afterRevive = await api("GET", `roles/${roleId}`, { token });
  check(afterRevive.data.data.hp === maxHp, "复活后库里的血量也是满的", `${afterRevive.data.data.hp}`);
  check(afterRevive.data.revision === revisionBefore, "复活不推进 revision（血量型写入走实时帧）", `${afterRevive.data.revision} vs ${revisionBefore}`);

  //#endregion

  //#region 三、自然回复：结算游标推进后按经过时间补齐

  console.log("— 三、自然回复按经过时间结算（lazy，无需定时器）—");

  // 用管理端把血量打下来（同时重置游标）→ 立即 PUT 一次（推进游标）→ 查库确认血量没变；
  // 回复量 = hpRecover × 秒。断言「结算不会凭空给血」与「游标在走」，
  // 真实回复由客户端长连接场景验证，e2e 不 sleep。
  await api("PATCH", `admin/roles/${roleId}`, { token: adminToken, zoneId: ADMIN_ZONE, body: { hp: 1 } });
  const hurtSave = await saveRole(api, token, roleId, roleData(roleId, "血蓝", "1", 5, { hp: 1 }));
  check(hurtSave.code === 0, "准备：残血状态保存成功");
  const hurt = await api("GET", `roles/${roleId}`, { token });
  check(hurt.data.data.hp === 1, "残血基线已落库（结算窗口为 0 时不凭空回血）", `${hurt.data.data.hp}`);
  check(hurt.data.data.hpRecoverAccumulator !== undefined, "回复累加器由服务端维护", JSON.stringify(hurt.data.data.hpRecoverAccumulator));
  check(
    hurt.data.data.hpRecoverAccumulator >= 0 && hurt.data.data.hpRecoverAccumulator < 1,
    "累加器保留不足 1 点的零头（不丢也不冒）",
    JSON.stringify(hurt.data.data.hpRecoverAccumulator),
  );

  //#endregion

  //#region 四、文档契约

  console.log("— 四、openapi 契约 —");

  const openapi = require("../openapi.json");
  const reviveOp = openapi.paths && openapi.paths["/roles/{id}/revive"] && openapi.paths["/roles/{id}/revive"].post;
  check(!!reviveOp, "revive 路径已在 openapi 登记");
  check(reviveOp && reviveOp.operationId === "role.revive", "operationId = role.revive（生成到 RoleApi.revive）");
  check(openapi.components.schemas && !!openapi.components.schemas.ReviveResultDto, "ReviveResultDto 模型已随 @ApiDataResponse 登记");

  const patchSchema = openapi.components.schemas && openapi.components.schemas.AdminPatchRoleDto;
  check(patchSchema && patchSchema.properties && patchSchema.properties.hp !== undefined && patchSchema.properties.mp !== undefined, "PATCH dto 已开放 hp / mp（运营旁路）");

  //#endregion

  finish("血蓝收权（save 覆盖 / 复活接口 / lazy 回复结算 / 管理端旁路 / 契约）全部通过");
})();
