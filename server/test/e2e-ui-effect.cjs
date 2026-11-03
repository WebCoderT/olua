#!/usr/bin/env node
/**
 * 特效配置专项 e2e（server/test/e2e-ui-effect.cjs，issue #594 / #634）
 *
 * 盯的不变量（改特效管理接口 / 快照下发 / seed 后必须全绿）：
 * 一、鉴权：观察员可读不可写（403）/ 玩家令牌 401 —— 改特效是运营动作，不是看数据
 * 二、seed：行由启动 seed 按出厂值补出（upgrade + 掉落光效 light_1~light_6、updatedAt = 0 =
 *     从没改过、列表按 seed 顺序而不是字典序）、没有新建 / 删除接口（POST / DELETE 404，
 *     行只来自客户端的消费代码）
 * 三、入参：缩放 / 时长越界 400、key 不认识 404（50145，不是参数错）
 * 四、保存成功：整份覆盖、返回更新值 + 追账字段（updatedBy / updatedAt > 0）
 * 五、快照即最新：GET /game-config 的 uiEffects 段带保存后的值（enabled=false 也在）
 * 六、审计：action = adminUiEffect.save、targetType = uiEffect、actorName 对得上
 * 七、文档：新接口落在「管理端」分组、PATCH 带 gameConfig:write 标注
 *
 * 用法：先 `npm run build`，再 `node test/e2e-ui-effect.cjs`
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
  return {
    status: response.status,
    code: envelope ? envelope.code : -1,
    message: envelope ? envelope.message : "",
    data: envelope ? envelope.data : null,
  };
}

/** 保存一次的快捷封装（字段缺省 = 出厂值） */
function saveEffect(key, token, body) {
  return api("PATCH", `admin/ui-effects/${key}`, {
    token,
    body: { offsetX: 0, offsetY: 90, scaleX: 1, scaleY: 1, rotate: 0, durationMs: 1000, enabled: true, ...body },
  });
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

    console.log("— 准备：超管 + 观察员 + 一个玩家 —");

    const superAdmin = await api("POST", "admin/auth/register", {
      body: { username: "gm_effect", password: "pass1234", registerCode: "test-admin-code" },
    });
    const adminToken = superAdmin.data.token;
    check(superAdmin.code === 0 && !!adminToken, "准备：注册超管拿到令牌", superAdmin.message);

    const viewer = await api("POST", "admin/auth/register", { body: { username: "gm_effect_view", password: "pass1234", registerCode: "test-admin-code" } });
    const viewerToken = viewer.data.token;
    await api("PATCH", `admin/admins/${viewer.data.admin.id}`, { token: adminToken, body: { role: "viewer" } });
    const viewerMe = await api("GET", "admin/auth/me", { token: viewerToken });
    check(viewerMe.data.role === "viewer", "准备：只读观察员已就位", viewerMe.data && viewerMe.data.role);

    const player = await api("POST", "auth/register", { body: { username: "effect_player", password: "pass1234" } });
    const playerToken = player.data.token;
    // #597 起建号只交三样客户端数据，角色 id 由服务端生成
    const role = await api("POST", "roles", { token: playerToken, body: { name: "特效体验官", occupation: "1", sex: "1" } });
    check(role.code === 0 && role.data.online === true, "准备：玩家在线角色已就位", role.message);

    //#endregion

    //#region 一、鉴权

    console.log("— 一、鉴权：观察员可读不可写、玩家令牌 401 —");

    const viewerList = await api("GET", "admin/ui-effects", { token: viewerToken });
    check(viewerList.code === 0 && viewerList.data.total >= 1, "观察员能看特效列表（gameConfig:read 观察员有）", `${viewerList.status}`);
    const viewerSave = await saveEffect("upgrade", viewerToken, { offsetY: 200 });
    check(viewerSave.status === 403 && viewerSave.code === 30006, "观察员保存被拒（403 / 30006：没有 gameConfig:write）", `${viewerSave.status}/${viewerSave.code}`);
    const playerDenied = await api("GET", "admin/ui-effects", { token: playerToken });
    check(playerDenied.status === 401, "玩家令牌调管理端接口被拒（401：audience 不符）", `${playerDenied.status}`);

    //#endregion

    //#region 二、seed 与「没有新建 / 删除」

    console.log("— 二、seed：七行（升级 + 六档光柱）按登记顺序补出、没有新建 / 删除接口 —");

    const list = await api("GET", "admin/ui-effects", { token: adminToken });
    const upgradeRow = (list.data.list || []).find((row) => row.key === "upgrade");
    check(list.code === 0 && !!upgradeRow, "seed 补出了 upgrade 行", JSON.stringify(list.data));
    // 摆位（偏移 / 缩放 / 时长）是运营在后台能调的数据，**不在这条断言里锁值** ——
    // 这里只验字段格式：数值列是有限数字、开关是布尔、updatedAt 是时间戳
    const shapeOk = (row, keys) =>
      !!row &&
      keys.every((key) => Number.isFinite(row[key])) &&
      typeof row.enabled === "boolean" &&
      typeof row.key === "string";
    const MOTION_KEYS = ["offsetX", "offsetY", "scaleX", "scaleY", "rotate", "durationMs", "updatedAt"];
    check(shapeOk(upgradeRow, MOTION_KEYS), "upgrade 行字段格式正常（数值列是数字 / enabled 是布尔 / updatedAt 是时间戳）", JSON.stringify(upgradeRow));

    const created = await api("POST", "admin/ui-effects", { token: adminToken, body: { key: "ghost" } });
    check(created.status === 404, "没有新建接口（POST → 404：key 的存在性由客户端消费代码决定）", `${created.status}`);
    const removed = await api("DELETE", "admin/ui-effects/upgrade", { token: adminToken });
    check(removed.status === 404, "没有删除接口（DELETE → 404：运营不能把特效删没）", `${removed.status}`);

    // #634：掉落光效六档也由 seed 补出（一档一行，六张图集是六份美术、各自可调）
    const allRows = list.data.list || [];
    const lightRows = allRows.filter((row) => row.key.startsWith("light_"));
    check(lightRows.length === 6, "seed 补出了 6 档掉落光效（light_1~light_6）", lightRows.map((row) => row.key).join("、"));
    check(
      lightRows.every((row) => shapeOk(row, MOTION_KEYS)),
      "六档光效的字段格式都正常（摆位数值不锁值，运营改了也照绿）",
      JSON.stringify(lightRows[0] || null),
    );
    check(
      lightRows.every((row) => row.durationMs === (row.key === "light_1" ? 1400 : 1500)),
      "掉落光效出厂时长 = 帧数 × 100ms（1 号 14 帧 = 1400，2~6 号各 15 帧 = 1500）",
      lightRows.map((row) => `${row.key}:${row.durationMs}`).join(" "),
    );
    check(allRows[0] && allRows[0].key === "upgrade", "列表按 seed 顺序（升级特效在最前；字典序会把 light_* 顶上来）", allRows[0] && allRows[0].key);

    //#endregion

    //#region 三、入参

    console.log("— 三、入参：数值边界与 key 存在性 —");

    const zeroScale = await saveEffect("upgrade", adminToken, { scaleX: 0 });
    check(zeroScale.status === 400, "缩放 0 → 400（最小 0.1，缩成 0 等于隐形）", `${zeroScale.status}`);
    const bigScale = await saveEffect("upgrade", adminToken, { scaleY: 6 });
    check(bigScale.status === 400, "缩放 6 → 400（最大 5）", `${bigScale.status}`);
    const shortDuration = await saveEffect("upgrade", adminToken, { durationMs: 50 });
    check(shortDuration.status === 400, "时长 50ms → 400（最小 100，闪一下谁也看不见）", `${shortDuration.status}`);
    const farOffset = await saveEffect("upgrade", adminToken, { offsetX: 3000 });
    check(farOffset.status === 400, "偏移 3000 → 400（超出 ±2000）", `${farOffset.status}`);
    const unknownKey = await saveEffect("drop", adminToken, {});
    check(unknownKey.status === 404 && unknownKey.code === 50145, "key 不认识 → 404（50145：客户端没有消费代码的 key 存了也没用）", `${unknownKey.status}/${unknownKey.code}`);

    //#endregion

    //#region 四、保存成功

    console.log("— 四、保存成功：整份覆盖 + 追账字段 —");

    const saved = await saveEffect("upgrade", adminToken, {
      offsetX: 12,
      offsetY: 120,
      scaleX: 1.5,
      scaleY: 0.8,
      rotate: -15,
      durationMs: 1500,
      enabled: false,
    });
    check(saved.code === 0 && saved.data.key === "upgrade", "保存成功，返回落库后的那一行", saved.message);
    check(
      saved.data.offsetX === 12 && saved.data.offsetY === 120 && saved.data.scaleX === 1.5 && saved.data.scaleY === 0.8 && saved.data.rotate === -15 && saved.data.durationMs === 1500,
      "七个表现字段整份覆盖（缩放保留小数）",
      JSON.stringify(saved.data),
    );
    check(saved.data.enabled === false && saved.data.updatedBy === "gm_effect" && saved.data.updatedAt > 0, "开关落位 + 追账字段（updatedBy / updatedAt）", JSON.stringify(saved.data));

    const relisted = await api("GET", "admin/ui-effects", { token: adminToken });
    const relistedRow = (relisted.data.list || []).find((row) => row.key === "upgrade");
    check(relistedRow && relistedRow.offsetX === 12 && relistedRow.enabled === false, "重读列表是新值（不是只改了返回值）", JSON.stringify(relistedRow));

    // #634：掉落光效走的是同一套接口与同一套字段（没有「光效专用」的第二条路）
    const savedLight = await saveEffect("light_4", adminToken, { offsetY: -12, scaleX: 0.5, scaleY: 0.5, rotate: 45, durationMs: 900, enabled: false });
    check(
      savedLight.code === 0 &&
        savedLight.data.key === "light_4" &&
        savedLight.data.offsetY === -12 &&
        savedLight.data.scaleX === 0.5 &&
        savedLight.data.rotate === 45 &&
        savedLight.data.durationMs === 900 &&
        savedLight.data.enabled === false,
      "掉落光效保存（偏移 / 缩放 / 旋转 / 时长 / 开关整份覆盖）",
      JSON.stringify(savedLight.data),
    );

    //#endregion

    //#region 五、快照即最新

    console.log("— 五、配置快照下发：玩家拉到的就是刚保存的 —");

    const snapshot = await api("GET", "game-config", { token: playerToken });
    const snapshotRow = (snapshot.data.uiEffects || []).find((row) => row.key === "upgrade");
    check(snapshot.code === 0 && !!snapshotRow, "快照带 uiEffects 段", snapshot.message);
    check(
      snapshotRow && snapshotRow.offsetX === 12 && snapshotRow.scaleX === 1.5 && snapshotRow.durationMs === 1500 && snapshotRow.enabled === false,
      "快照里的 upgrade 行就是刚保存的参数（enabled=false 也在 —— 客户端据此不播）",
      JSON.stringify(snapshotRow),
    );
    check(!("updatedBy" in (snapshotRow || {})), "快照行不带追账字段（玩家侧只需要表现参数）", JSON.stringify(snapshotRow));

    // #634：掉落光效的参数也随快照下发（客户端 applyEquipmentLight 就按这一行演）
    const snapshotLight = (snapshot.data.uiEffects || []).find((row) => row.key === "light_4");
    check(!!snapshotLight, "快照里带掉落光效的行", JSON.stringify((snapshot.data.uiEffects || []).map((row) => row.key)));
    check(
      snapshotLight && snapshotLight.offsetY === -12 && snapshotLight.scaleX === 0.5 && snapshotLight.rotate === 45 && snapshotLight.durationMs === 900 && snapshotLight.enabled === false,
      "快照里的 light_4 就是刚保存的那组参数（enabled=false 时客户端连节点都不建）",
      JSON.stringify(snapshotLight),
    );

    //#endregion

    //#region 六、审计

    console.log("— 六、审计：谁在什么时候改了哪个特效 —");

    const audit = await api("GET", "admin/audit-logs?action=adminUiEffect.save&page=1&size=10", { token: adminToken });
    // 前面入参边界节里的 unknown key 保存尝试（404）也会落审计行，且排序可能排在成功行前面 —— 只认成功那条
    const entries = audit.data.list || [];
    const entry = entries.find((e) => e.statusCode === 200 && e.targetId === "upgrade");
    check(!!entry && entry.targetType === "uiEffect" && entry.targetId === "upgrade", "审计落了 adminUiEffect.save（targetType uiEffect / targetId upgrade）", JSON.stringify(entries[0] || null));
    check(!!entry && entry.actorName === "gm_effect", "审计里的操作人与保存者一致", entry && entry.actorName);

    //#endregion

    //#region 七、文档

    console.log("— 七、文档：接口分组与权限点标注 —");

    const docResponse = await fetch(`${baseUrl.replace(/\/api$/, "")}/api-docs-json`);
    const docs = await docResponse.json();
    const listOp = (docs.paths["/api/admin/ui-effects"] || {}).get;
    const saveOp = (docs.paths["/api/admin/ui-effects/{id}"] || {}).patch;
    check(!!listOp && !!saveOp, "api-docs-json 里有两个特效接口", "paths 缺 /api/admin/ui-effects");
    check(
      !!saveOp && JSON.stringify(saveOp).includes("gameConfig:write") && JSON.stringify(listOp).includes("gameConfig:read"),
      "PATCH 标 gameConfig:write / GET 标 gameConfig:read",
      JSON.stringify(saveOp && saveOp["x-olua-permissions"]),
    );
    check(
      !!saveOp && (saveOp.tags || []).includes("管理端") && ((docs.paths["/api/game-config"] || {}).get || { tags: [] }).tags.includes("客户端"),
      "分组落位（特效在「管理端」，快照在「客户端」）",
      JSON.stringify(saveOp && saveOp.tags),
    );

    //#endregion
  } catch (error) {
    console.error("e2e 异常：", error);
    process.exit(1);
  } finally {
    await app.close();
  }

  finish("特效配置（升级特效 + 六档掉落光效；列表 / seed / 边界 / 保存 / 快照 / 审计 / 文档）全部通过");
})();
