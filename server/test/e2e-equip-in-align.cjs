#!/usr/bin/env node
/**
 * 服务端 e2e：装备**内观**几何（#523）
 *
 * 核心命题与外观那套一样：**管理端保存完，客户端下一次打开角色信息弹窗就能拿到同一份**。
 * 但内观多了一条必须钉住的边界 —— **两张表互不影响**：重置内观不能把外观一起清掉。
 *
 * ## 六条主线
 * 1. **空表 = 出厂值**：新建库没有行，管理端列表与玩家侧接口都是空数组。
 * 2. **保存即生效**：PUT 一条 → 管理端列表立刻反映 → **玩家侧接口拿到同样的形状**
 *    （两轴缩放各自独立、位置 y 不翻转、`inManual` 保住）。
 * 3. **幂等**：同 id 重复保存不多行（UPSERT），重置删不存在的行也返回成功。
 * 4. **边界**：id 形态（内观没有 `role:*`）、缩放区间、位置上限；不合法是 400 而不是"存进去再说"。
 * 5. **与外观独立**：存了外观再存内观、重置内观之后，外观那一行仍然在。
 * 6. **权限与审计**：只读观察员读得到写不了；每次写都留一条 `equipInAlign` 审计。
 *
 * 用法：npm run test:e2e:equip-in-align（前置 npm run build）
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const ADMIN_CODE = "equipinalign-code";

//#region 断言小工具（与其余几套同一骨架）

const EXPECTED_ASSERTIONS = 73;

function assertExpectedCount(passedCount, failureCount) {
  if (failureCount !== 0) return;
  if (passedCount === EXPECTED_ASSERTIONS) return;
  console.log(`\n❌ 断言条数变了：期望 ${EXPECTED_ASSERTIONS}，实际 ${passedCount}`);
  console.log("   改了断言就同步这个常量，以及文档里的 e2e 总数（README.md / docs/resume.md；make audit 会比对）");
  process.exit(1);
}

let passed = 0;
let failed = 0;
const failures = [];

function group(title) {
  console.log(`\n▶ ${title}`);
}

function check(condition, label) {
  if (condition) {
    passed += 1;
    return true;
  }
  failed += 1;
  failures.push(label);
  console.log(`  ✗ ${label}`);
  return false;
}

function checkEqual(actual, expected, label) {
  return check(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}

//#endregion

/** 取一个空闲端口 */
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

/** 起一台服务并等它就绪 */
async function startServer(env) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ENTRY], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      API_PREFIX: "api",
      DB_PATH: ":memory:",
      JWT_SECRET: "e2e-equipinalign-secret",
      JWT_EXPIRES_IN: "1h",
      ADMIN_REGISTER_CODE: ADMIN_CODE,
      LOG_REQUESTS: "false",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverErrors = [];
  child.stderr.on("data", (chunk) => serverErrors.push(String(chunk)));

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务进程提前退出（code=${child.exitCode}）\n${serverErrors.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return { baseUrl, kill: () => child.kill("SIGTERM") };
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("等待服务启动超时");
}

/** 发一次请求，返回 { status, body }（body 是唯一包裹体） */
async function api(baseUrl, method, route, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}${route}`, {
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

/** 注册并登录一个管理员，返回 token（第一个注册者自动是超级管理员） */
async function registerAdmin(baseUrl, username, password) {
  const login = await api(baseUrl, "POST", "/api/admin/auth/login", { body: { username, password } });
  if (login.body?.data?.token) return login.body.data.token;
  await api(baseUrl, "POST", "/api/admin/auth/register", { body: { username, password, registerCode: ADMIN_CODE } });
  const retry = await api(baseUrl, "POST", "/api/admin/auth/login", { body: { username, password } });
  return retry.body?.data?.token;
}

/** 注册并登录一个玩家，返回 token */
async function registerPlayer(baseUrl, username, password) {
  const registered = await api(baseUrl, "POST", "/api/auth/register", { body: { username, password } });
  check(Boolean(registered.body?.data), `注册玩家 ${username}`);
  const login = await api(baseUrl, "POST", "/api/auth/login", { body: { username, password } });
  return login.body?.data?.token;
}

/** 一条内观几何（两轴缩放刻意不同：衣服常有 `inScaleX ≠ inScaleY` 的素材） */
function inPayload(overrides = {}) {
  return { inScaleX: 1.3, inScaleY: 1, inPosition: { x: -72.5, y: 48 }, inManual: true, ...overrides };
}

//#region 主流程

async function main() {
  const server = await startServer({});
  try {
    const base = server.baseUrl;
    const rootToken = await registerAdmin(base, "equipinalignroot", "EquipInAlign#1");
    check(Boolean(rootToken), "超管注册并登录成功");

    //#region 一、空表 = 出厂值

    group("一、空表：没有行就代表「全都用客户端配置里的值」");

    const emptyList = await api(base, "GET", "/api/admin/equip-in-aligns", { token: rootToken });
    checkEqual(emptyList.status, 200, "管理端列表可读");
    checkEqual(emptyList.body?.data?.list?.length, 0, "新建库没有任何内观行");

    const noToken = await api(base, "GET", "/api/admin/equip-in-aligns");
    checkEqual(noToken.status, 401, "没有令牌读不到列表");

    //#endregion

    //#region 二、保存即生效

    group("二、保存 → 管理端可见 → 玩家侧拿到同一份");

    const savedCloth = await api(base, "PUT", "/api/admin/equip-in-aligns/cloth%3Acloth_1", { token: rootToken, body: inPayload() });
    checkEqual(savedCloth.status, 200, "保存 cloth:cloth_1 成功");
    checkEqual(savedCloth.body?.data?.id, "cloth:cloth_1", "返回体回显 id");
    checkEqual(savedCloth.body?.data?.inScaleX, 1.3, "返回体回显横向缩放");
    checkEqual(savedCloth.body?.data?.inScaleY, 1, "返回体回显纵向缩放（两轴各自独立）");
    checkEqual(savedCloth.body?.data?.inPosition?.x, -72.5, "返回体回显位置 x");
    checkEqual(savedCloth.body?.data?.inPosition?.y, 48, "返回体回显位置 y（y 向上，不做翻转）");
    checkEqual(savedCloth.body?.data?.inManual, true, "inManual=true 原样回显");

    const savedWeapon = await api(base, "PUT", "/api/admin/equip-in-aligns/weapon%3Aweapon_1", {
      token: rootToken,
      body: inPayload({ inScaleX: 0.85, inScaleY: 0.85, inPosition: { x: -60, y: 20 }, inManual: true }),
    });
    checkEqual(savedWeapon.status, 200, "保存 weapon:weapon_1 成功");
    checkEqual(savedWeapon.body?.data?.inScaleX, 0.85, "武器缩放回显");
    checkEqual(savedWeapon.body?.data?.inManual, true, "武器 inManual=true 保住了（客户端据此跳过自动算法）");

    const autoWeapon = await api(base, "PUT", "/api/admin/equip-in-aligns/weapon%3Aweapon_2", {
      token: rootToken,
      body: inPayload({ inManual: false }),
    });
    checkEqual(autoWeapon.status, 200, "保存 weapon:weapon_2（未开手调）成功");
    checkEqual(autoWeapon.body?.data?.inManual, false, "inManual=false 原样回显（渐进语义：仍走自动算）");

    const threeRows = await api(base, "GET", "/api/admin/equip-in-aligns", { token: rootToken });
    checkEqual(threeRows.body?.data?.list?.length, 3, "三条都在列表里");
    checkEqual(
      threeRows.body?.data?.list?.map((row) => row.id).join(","),
      "cloth:cloth_1,weapon:weapon_1,weapon:weapon_2",
      "列表按 id 升序（整份下发的字节序稳定）",
    );

    const playerToken = await registerPlayer(base, "equipinalignplayer", "123456");
    const playerView = await api(base, "GET", "/api/game-config/equip-in-align", { token: playerToken });
    checkEqual(playerView.status, 200, "玩家侧能读到内观几何");
    checkEqual(playerView.body?.data?.list?.length, 3, "玩家侧拿到同样 3 条");
    checkEqual(playerView.body?.data?.list?.[0]?.id, "cloth:cloth_1", "玩家侧 id 形态一致");
    checkEqual(playerView.body?.data?.list?.[0]?.inScaleX, 1.3, "玩家侧横向缩放与管理端一致");
    checkEqual(playerView.body?.data?.list?.[0]?.inScaleY, 1, "玩家侧纵向缩放与管理端一致");
    checkEqual(playerView.body?.data?.list?.[0]?.inPosition?.x, -72.5, "玩家侧位置分量一致");
    checkEqual(playerView.body?.data?.list?.[0]?.inManual, true, "玩家侧也拿到 inManual");
    checkEqual(playerView.body?.data?.list?.[2]?.inManual, false, "没开手调的那条玩家侧同样是 false");

    const playerNoToken = await api(base, "GET", "/api/game-config/equip-in-align");
    checkEqual(playerNoToken.status, 401, "玩家侧接口同样需要令牌");

    //#endregion

    //#region 三、幂等

    group("三、幂等：重复保存不多行、重复重置不报错");

    const again = await api(base, "PUT", "/api/admin/equip-in-aligns/cloth%3Acloth_1", {
      token: rootToken,
      body: inPayload({ inScaleX: 1.1, inScaleY: 1.1, inPosition: { x: 4, y: -6 } }),
    });
    checkEqual(again.status, 200, "同 id 再保存成功");
    checkEqual(again.body?.data?.inScaleX, 1.1, "返回新值");
    const afterAgain = await api(base, "GET", "/api/admin/equip-in-aligns", { token: rootToken });
    checkEqual(afterAgain.body?.data?.list?.length, 3, "仍是 3 行（UPSERT，不是插新行）");
    checkEqual(
      afterAgain.body?.data?.list?.find((row) => row.id === "cloth:cloth_1")?.inPosition?.x,
      4,
      "整份覆盖：位置也跟着换成新的一组",
    );

    const resetOne = await api(base, "DELETE", "/api/admin/equip-in-aligns/weapon%3Aweapon_2", { token: rootToken });
    checkEqual(resetOne.status, 200, "重置一条成功");
    const resetTwice = await api(base, "DELETE", "/api/admin/equip-in-aligns/weapon%3Aweapon_2", { token: rootToken });
    checkEqual(resetTwice.status, 200, "重复重置仍成功（幂等：它表达的是「回到默认」这个状态）");
    const afterReset = await api(base, "GET", "/api/admin/equip-in-aligns", { token: rootToken });
    checkEqual(afterReset.body?.data?.list?.length, 2, "重置后只剩 2 行");
    check(!afterReset.body?.data?.list?.some((row) => row.id === "weapon:weapon_2"), "被重置的那条不在列表里");

    //#endregion

    //#region 四、与外观独立

    group("四、与外观独立：两张表各管各的，重置内观不动外观");

    const outPayload = {
      outScale: 1.05,
      outPositions: Array.from({ length: 8 }, (_, index) => ({ x: index, y: -index })),
      outManual: true,
    };
    const savedOut = await api(base, "PUT", "/api/admin/equip-aligns/cloth%3Acloth_1", { token: rootToken, body: outPayload });
    checkEqual(savedOut.status, 200, "同一件衣服先存一份外观几何");
    const resetInOnly = await api(base, "DELETE", "/api/admin/equip-in-aligns/cloth%3Acloth_1", { token: rootToken });
    checkEqual(resetInOnly.status, 200, "再重置它的内观");
    const outStill = await api(base, "GET", "/api/admin/equip-aligns", { token: rootToken });
    check(
      outStill.body?.data?.list?.some((row) => row.id === "cloth:cloth_1" && row.outScale === 1.05),
      "外观那一行还在（重置内观不该顺手清外观）",
    );
    const inGone = await api(base, "GET", "/api/admin/equip-in-aligns", { token: rootToken });
    check(!inGone.body?.data?.list?.some((row) => row.id === "cloth:cloth_1"), "内观那一行已删");

    //#endregion

    //#region 五、边界

    group("五、边界：id 形态 / 缩放区间 / 位置上限");

    const badId = await api(base, "PUT", "/api/admin/equip-in-aligns/abc", { token: rootToken, body: inPayload() });
    checkEqual(badId.status, 400, "id 形态不合法 → 400");
    checkEqual(badId.body?.code, 40000, "业务码是 PARAM_INVALID（40000）");

    const roleId = await api(base, "PUT", "/api/admin/equip-in-aligns/role%3A1", { token: rootToken, body: inPayload() });
    checkEqual(roleId.status, 400, "内观没有 role:*（未穿衣服时弹窗不画身体）→ 400");

    const zeroScale = await api(base, "PUT", "/api/admin/equip-in-aligns/cloth%3Acloth_2", {
      token: rootToken,
      body: inPayload({ inScaleX: 0 }),
    });
    checkEqual(zeroScale.status, 400, "横向缩放为 0 → 400（会让节点直接消失）");

    const hugeScale = await api(base, "PUT", "/api/admin/equip-in-aligns/cloth%3Acloth_2", {
      token: rootToken,
      body: inPayload({ inScaleY: 11 }),
    });
    checkEqual(hugeScale.status, 400, "纵向缩放 11 超上限 → 400");

    const farAway = await api(base, "PUT", "/api/admin/equip-in-aligns/cloth%3Acloth_2", {
      token: rootToken,
      body: inPayload({ inPosition: { x: 99_999, y: 0 } }),
    });
    checkEqual(farAway.status, 400, "位置超上限 → 400（四位数说明把像素当游戏单位了）");

    const missingPosition = await api(base, "PUT", "/api/admin/equip-in-aligns/cloth%3Acloth_2", {
      token: rootToken,
      body: { inScaleX: 1, inScaleY: 1 },
    });
    checkEqual(missingPosition.status, 400, "缺 inPosition → 400");

    const badPosition = await api(base, "PUT", "/api/admin/equip-in-aligns/cloth%3Acloth_2", {
      token: rootToken,
      body: { inScaleX: 1, inScaleY: 1, inPosition: { x: "左边", y: 0 } },
    });
    checkEqual(badPosition.status, 400, "位置不是数字 → 400");

    const unknownId = await api(base, "PUT", "/api/admin/equip-in-aligns/cloth%3Acloth_999", {
      token: rootToken,
      body: inPayload(),
    });
    checkEqual(unknownId.status, 200, "未知装备 id 也允许保存（清单在客户端配置里，服务端不硬编）");

    const missingBody = await api(base, "PUT", "/api/admin/equip-in-aligns/cloth%3Acloth_3", { token: rootToken, body: {} });
    checkEqual(missingBody.status, 400, "空 body → 400");

    //#endregion

    //#region 六、权限与审计

    group("六、权限与审计");

    const viewerToken = await registerAdmin(base, "equipinalignviewer", "EquipInAlign#2");
    const viewerId = (await api(base, "GET", "/api/admin/admins", { token: rootToken })).body?.data?.list?.find(
      (row) => row.username === "equipinalignviewer",
    )?.id;
    const demote = await api(base, "PATCH", `/api/admin/admins/${viewerId}`, { token: rootToken, body: { role: "viewer" } });
    checkEqual(demote.status, 200, "把第二个管理员降为只读观察员");

    const viewerRead = await api(base, "GET", "/api/admin/equip-in-aligns", { token: viewerToken });
    checkEqual(viewerRead.status, 200, "观察员可读（有 gameConfig:read）");
    const viewerWrite = await api(base, "PUT", "/api/admin/equip-in-aligns/cloth%3Acloth_4", {
      token: viewerToken,
      body: inPayload(),
    });
    checkEqual(viewerWrite.status, 403, "观察员写被拒（403）");
    const viewerReset = await api(base, "DELETE", "/api/admin/equip-in-aligns/weapon%3Aweapon_1", { token: viewerToken });
    checkEqual(viewerReset.status, 403, "观察员重置被拒（403）");

    const audit = await api(base, "GET", "/api/admin/audit-logs?targetType=equipInAlign&size=50", { token: rootToken });
    checkEqual(audit.status, 200, "审计日志可查（新目标类型已被查询侧认识）");
    const auditRows = audit.body?.data?.list ?? [];
    check(auditRows.length >= 4, "每次保存 / 重置都留了审计（至少 4 条）");
    check(
      auditRows.some((row) => row.action === "adminEquipInAlign.save"),
      "有一条 save 动作（动作取自 operationId）",
    );
    check(
      auditRows.some((row) => row.action === "adminEquipInAlign.reset"),
      "有一条 reset 动作",
    );
    check(
      auditRows.every((row) => row.targetType === "equipInAlign"),
      "目标类型统一是 equipInAlign",
    );
    check(
      auditRows.some((row) => row.targetId === "weapon:weapon_1"),
      "目标 id 记的是内观目标（便于追「谁把这把武器挪了」）",
    );
    check(
      auditRows.some(
        (row) => row.actorName === "equipinalignroot" && row.action === "adminEquipInAlign.save" && row.success === true,
      ),
      "超管的成功保存留了审计",
    );
    check(
      auditRows.some((row) => row.action === "adminEquipInAlign.save" && JSON.stringify(row.detail ?? {}).includes("inScaleX")),
      "审计 detail 留了当时的请求体（能看出改成什么值）",
    );

    //#endregion

    //#region 七、文档契约

    group("七、文档契约：四个接口的标签 / 权限 / 响应类型");

    const docs = await fetch(`${base}/api-docs-json`);
    const doc = await docs.json();
    const adminList = doc.paths?.["/api/admin/equip-in-aligns"]?.get;
    const adminSave = doc.paths?.["/api/admin/equip-in-aligns/{id}"]?.put;
    const adminReset = doc.paths?.["/api/admin/equip-in-aligns/{id}"]?.delete;
    const playerGet = doc.paths?.["/api/game-config/equip-in-align"]?.get;
    check(Boolean(adminList && adminSave && adminReset && playerGet), "四个接口都在文档里");
    checkEqual(adminSave?.["x-olua-permissions"]?.join(","), "gameConfig:write", "保存要求 gameConfig:write");
    checkEqual(adminList?.["x-olua-permissions"]?.join(","), "gameConfig:read", "列表要求 gameConfig:read");
    checkEqual(adminList?.["x-olua-audience"], "admin", "列表归管理端受众");
    checkEqual(playerGet?.["x-olua-audience"], "player", "玩家侧接口归玩家受众");
    checkEqual(adminSave?.["x-olua-data-schema"]?.$ref, "#/components/schemas/EquipInAlignDto", "保存的响应类型是 EquipInAlignDto");
    checkEqual(adminList?.["x-olua-data-schema"]?.$ref, "#/components/schemas/EquipInAlignListDto", "列表的响应类型是 EquipInAlignListDto");
    checkEqual(adminReset?.["x-olua-data-schema"], undefined, "重置声明为无响应体（data 恒为 null）");
    check(Boolean(doc.components?.schemas?.EquipInAlignDto), "EquipInAlignDto schema 已注册进文档");
    check(Boolean(doc.components?.schemas?.SaveEquipInAlignDto), "SaveEquipInAlignDto schema 已注册进文档");
    check(
      Boolean(
        doc.components?.schemas?.SaveEquipInAlignDto?.properties?.inPosition?.allOf?.[0]?.$ref?.includes("EquipInAlignPointDto"),
      ),
      "入参 schema 里 inPosition 指向 EquipInAlignPointDto（不是随手的 object）",
    );

    //#endregion
  } finally {
    server.kill();
  }
}

//#endregion

main()
  .then(() => {
    assertExpectedCount(passed, failed);
    if (failed) {
      console.log(`\n❌ 服务端 e2e（内观对齐）：${passed} 条通过 / ${failed} 条失败`);
      console.log(failures.map((label) => `   · ${label}`).join("\n"));
      process.exit(1);
    }
    console.log(`\n✅ 服务端 e2e（内观对齐）：${passed} 条通过 / 0 条失败`);
  })
  .catch((error) => {
    console.error("\n💥 e2e 运行失败：", error);
    process.exit(1);
  });
