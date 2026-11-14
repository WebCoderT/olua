#!/usr/bin/env node
/**
 * 时装收权专项端到端验证（服务端，#596）
 *
 * 时装的权威链路：拥有清单 `fashionsOwned` 是**独占字段**（客户端上报一律删除），
 * 穿着态 `fashionCloth` 归服务端（客户端上报回填库值）；获取走两条路 ——
 * 购买 POST /roles/:id/fashion-buy（渠道 upgrade 且有售价，扣绑定元宝），
 * 发放走管理端 PATCH fashionsOwned（grant 语义）。穿 / 脱走 POST /roles/:id/fashion-wear。
 * 这份只盯「客户端改包拿不到时装、花钱和清单都由服务端算」这一块：
 *
 * · save：上报 fashionCloth 被库值回填、上报 fashionsOwned 被删除
 * · 老档迁移：清单没建过时，第一次穿 / 脱把当前穿着认领进清单
 * · wear：未拥有拒收（20017）；拥有后穿上成功（revision+1）；null 脱下幂等
 * · buy：未开放渠道拒收（20016）；管理端开放后绑定元宝不足拒收（20011）；
 *   扣费与清单落账正确；重复购买拒收
 * · 管理端：PATCH fashionsOwned 发放 / 回收（grant 语义）
 * · 文档：fashionBuy / fashionWear 落在「玩家」分组，模型已登记
 *
 * 用法：先 `npm run build`，再 `node --disable-warning=ExperimentalWarning test/e2e-role-fashion.cjs`
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
const { saveRole, revOfWith } = require("./lib/role-save.cjs");

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

/** 取角色当前修订号（#820 / B62：写接口必须带基线，缺了就是 400 / 40000） */
const revOf = (roleId, token) => revOfWith(api, roleId, token);

/** 存档文档（PUT 全量覆盖用；时装字段会被服务端覆盖，写什么都用来验「上报无效」） */
function roleData(id, name, overrides = {}) {
  return {
    id,
    name,
    occupation: "1",
    sex: "1",
    level: 1,
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
    body: { username: "gm_fashion", password: "pass1234", registerCode: "test-admin-code" },
  });
  const adminToken = superAdmin.data.token;
  const player = await api("POST", "auth/register", { body: { username: "fashion_player", password: "pass1234" } });
  const token = player.data.token;

  const created = await api("POST", "roles", { token, body: { name: "时装", occupation: "1", sex: "1" } });
  const roleId = created.data.id;
  check(created.code === 0, "准备：建号成功", created.message);
  await saveRole(api, token, roleId, roleData(roleId, "时装"));
  const detail = await api("GET", `roles/${roleId}`, { token });
  check(detail.data.data.fashionCloth === null, "准备：新号未穿时装", JSON.stringify(detail.data.data.fashionCloth));
  check(detail.data.data.fashionsOwned === undefined, "准备：新号没有拥有清单（老档形状）", JSON.stringify(detail.data.data.fashionsOwned));

  //#region 一、save：上报时装字段一律无效

  console.log("— 一、save：时装字段不再照单全收 —");

  // 改包自穿 + 自填清单：穿着态被库值回填、独占清单直接删除（新字段无老档，防第一次 PUT 填满清单）
  const hacked = await saveRole(
    api,
    token,
    roleId,
    roleData(roleId, "时装", { fashionCloth: "cloth_2", fashionsOwned: ["cloth_2", "cloth_3", "cloth_4"] }),
  );
  check(hacked.code === 0, "改包上报的存档被接受（回填 / 删除而不是拒收，role-authority 纪律）");
  const afterHack = await api("GET", `roles/${roleId}`, { token });
  check(afterHack.data.data.fashionCloth === null, "上报的穿着态被库值回填（库里没穿就还是没穿）", JSON.stringify(afterHack.data.data.fashionCloth));
  check(afterHack.data.data.fashionsOwned === undefined, "上报的拥有清单被整份删除（独占字段）", JSON.stringify(afterHack.data.data.fashionsOwned));

  //#endregion

  //#region 二、wear：拥有才给穿，老档迁移认领穿着

  console.log("— 二、穿 / 脱接口（POST /roles/:id/fashion-wear）—");

  // 老档迁移：管理端直接写穿着态（历史合法来源）→ 清单没建过 → 第一次穿 / 脱把穿着认领进去
  await api("PATCH", `admin/roles/${roleId}`, { token: adminToken, zoneId: ADMIN_ZONE, body: { fashionCloth: "cloth_2" } });
  const wearNothing = await api("POST", `roles/${roleId}/fashion-wear`, { token, body: { fashionId: null, revision: await revOf(roleId, token) } });
  check(wearNothing.code === 0, "老档迁移：无清单时第一次穿 / 脱成功（当前穿着被认领）", wearNothing.message);
  check(
    Array.isArray(wearNothing.data.owned) && wearNothing.data.owned.indexOf("cloth_2") !== -1,
    "老档迁移：当前穿着被认领进清单",
    JSON.stringify(wearNothing.data.owned),
  );
  check(wearNothing.data.fashionCloth === null, "脱下后穿着态为 null", JSON.stringify(wearNothing.data.fashionCloth));

  const afterMigrate = await api("GET", `roles/${roleId}`, { token });
  check(
    Array.isArray(afterMigrate.data.data.fashionsOwned) && afterMigrate.data.data.fashionsOwned.indexOf("cloth_2") !== -1,
    "迁移结果落库（换设备 / 重进后清单仍在）",
    JSON.stringify(afterMigrate.data.data.fashionsOwned),
  );

  // 未拥有拒收
  const wearUnowned = await api("POST", `roles/${roleId}/fashion-wear`, { token, body: { fashionId: "cloth_3", revision: await revOf(roleId, token) } });
  check(wearUnowned.code === 20017 && wearUnowned.status === 409, "未拥有的时装拒收（20017 / 409）", `${wearUnowned.code}/${wearUnowned.status}`);

  // 管理端发放（grant 语义）后可穿
  const grant = await api("PATCH", `admin/roles/${roleId}`, { token: adminToken, zoneId: ADMIN_ZONE, body: { fashionsOwned: ["cloth_2", "cloth_3"] } });
  check(grant.code === 0, "管理端 PATCH fashionsOwned 发放成功", grant.message);
  const detailAfterGrant = await api("GET", `roles/${roleId}`, { token });
  check(
    JSON.stringify(detailAfterGrant.data.data.fashionsOwned) === JSON.stringify(["cloth_2", "cloth_3"]),
    "发放结果落库（整份覆盖 + 去重归服务端管）",
    JSON.stringify(detailAfterGrant.data.data.fashionsOwned),
  );

  const revisionBefore = detailAfterGrant.data.revision;
  const wearOwned = await api("POST", `roles/${roleId}/fashion-wear`, { token, body: { fashionId: "cloth_3", revision: await revOf(roleId, token) } });
  check(wearOwned.code === 0, "拥有后穿上成功", wearOwned.message);
  check(wearOwned.data.fashionCloth === "cloth_3", "穿着态照搬服务端落账值", JSON.stringify(wearOwned.data.fashionCloth));
  check(wearOwned.data.revision === revisionBefore + 1, "穿着态是进度型写入，revision +1", `${wearOwned.data.revision} vs ${revisionBefore}`);

  // 穿上不改数值（时装只换外观）：血蓝与绑定元宝都不动
  const afterWear = await api("GET", `roles/${roleId}`, { token });
  check(afterWear.data.revision === wearOwned.data.revision, "库里 revision 与应答一致");
  check(typeof afterWear.data.data.hp === "number" && afterWear.data.data.hp > 0, "穿上时装不动血量（只换外观）", JSON.stringify(afterWear.data.data.hp));

  // 脱下幂等：没穿时再脱一次也是成功
  const unwear = await api("POST", `roles/${roleId}/fashion-wear`, { token, body: { fashionId: null, revision: await revOf(roleId, token) } });
  check(unwear.code === 0 && unwear.data.fashionCloth === null, "null 脱下成功");
  const unwearAgain = await api("POST", `roles/${roleId}/fashion-wear`, { token, body: { fashionId: null, revision: await revOf(roleId, token) } });
  check(unwearAgain.code === 0 && unwearAgain.data.fashionCloth === null, "没穿时再脱一次仍成功（幂等）", unwearAgain.message);

  //#endregion

  //#region 三、buy：渠道与扣费都在服务端

  console.log("— 三、购买接口（POST /roles/:id/fashion-buy）—");

  // 出厂渠道 unavailable → 拒收
  const buyLocked = await api("POST", `roles/${roleId}/fashion-buy`, { token, body: { fashionId: "cloth_5", revision: await revOf(roleId, token) } });
  check(buyLocked.code === 20016 && buyLocked.status === 409, "未开放渠道拒收（20016 / 409）", `${buyLocked.code}/${buyLocked.status}`);

  // 管理端开放渠道与定价（运营动作），绑定元宝不足拒收
  const openSale = await api("PATCH", "admin/fashions/cloth_5", { token: adminToken, zoneId: ADMIN_ZONE, body: { sellPrice: 50, acquireChannel: "upgrade" } });
  check(openSale.code === 0, "管理端开放 cloth_5 购买（价 50）", openSale.message);
  const buyPoor = await api("POST", `roles/${roleId}/fashion-buy`, { token, body: { fashionId: "cloth_5", revision: await revOf(roleId, token) } });
  check(buyPoor.code === 20011 && buyPoor.status === 409, "绑定元宝不足拒收（20011 / 409）", `${buyPoor.code}/${buyPoor.status}`);

  // 管理端发绑定元宝 → 购买成功：扣费、清单、revision 三处落账
  await api("PATCH", `admin/roles/${roleId}`, { token: adminToken, zoneId: ADMIN_ZONE, body: { bindGold: 120 } });
  const revisionBeforeBuy = (await api("GET", `roles/${roleId}`, { token })).data.revision;
  const bought = await api("POST", `roles/${roleId}/fashion-buy`, { token, body: { fashionId: "cloth_5", revision: await revOf(roleId, token) } });
  check(bought.code === 0, "购买成功", bought.message);
  check(bought.data.price === 50 && bought.data.bindGold === 70, "扣费正确（120 - 50 = 70）", JSON.stringify(bought.data));
  check(
    Array.isArray(bought.data.owned) && bought.data.owned.indexOf("cloth_5") !== -1,
    "拥有清单带上新时装",
    JSON.stringify(bought.data.owned),
  );
  check(bought.data.revision === revisionBeforeBuy + 1, "购买推进 revision（进度型写入）", `${bought.data.revision} vs ${revisionBeforeBuy}`);

  const afterBuy = await api("GET", `roles/${roleId}`, { token });
  check(afterBuy.data.data.bindGold === 70, "扣费落库", JSON.stringify(afterBuy.data.data.bindGold));

  // 重复购买拒收（不做已拥有转退款）
  const buyAgain = await api("POST", `roles/${roleId}/fashion-buy`, { token, body: { fashionId: "cloth_5", revision: await revOf(roleId, token) } });
  check(buyAgain.code === 20016, "重复购买拒收（20016）", `${buyAgain.code}`);

  // 乐观锁：带旧 revision 的购买拒收（20006）
  const staleBuy = await api("POST", `roles/${roleId}/fashion-buy`, { token, body: { fashionId: "cloth_5", revision: revisionBeforeBuy } });
  check(staleBuy.code === 20006, "旧 revision 的购买拒收（20006）", `${staleBuy.code}`);

  //#endregion

  //#region 四、文档契约

  console.log("— 四、openapi 契约 —");

  const openapi = require("../openapi.json");
  const buyOp = openapi.paths && openapi.paths["/roles/{id}/fashion-buy"] && openapi.paths["/roles/{id}/fashion-buy"].post;
  const wearOp = openapi.paths && openapi.paths["/roles/{id}/fashion-wear"] && openapi.paths["/roles/{id}/fashion-wear"].post;
  check(!!buyOp && buyOp.operationId === "role.fashionBuy", "fashionBuy 路径与 operationId 已登记");
  check(!!wearOp && wearOp.operationId === "role.fashionWear", "fashionWear 路径与 operationId 已登记");
  check(openapi.components.schemas && !!openapi.components.schemas.FashionBuyResultDto, "FashionBuyResultDto 模型已登记");
  check(openapi.components.schemas && !!openapi.components.schemas.FashionWearResultDto, "FashionWearResultDto 模型已登记");

  const patchSchema = openapi.components.schemas && openapi.components.schemas.AdminPatchRoleDto;
  check(
    patchSchema && patchSchema.properties && patchSchema.properties.fashionCloth !== undefined && patchSchema.properties.fashionsOwned !== undefined,
    "PATCH dto 已开放 fashionCloth / fashionsOwned（运营发放旁路）",
  );

  //#endregion

  await app.close();
  finish("e2e-role-fashion 全部通过");
})().catch((error) => {
  console.error("e2e 执行失败：", error);
  process.exit(1);
});
