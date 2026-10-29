#!/usr/bin/env node
/**
 * 服务端 e2e：装备对齐几何（#513）
 *
 * 这套的核心命题只有一个：**管理端保存完，客户端下一次进游戏就能拿到同一份几何**。
 * 其余断言都是围绕它的边界 —— 谁能写、能写什么、写坏了会怎样。
 *
 * ## 五条主线
 * 1. **空表 = 出厂值**：新建库一张行都没有，管理端列表与玩家侧接口都是空数组
 *    （客户端「按 id 对齐、缺省不动」，所以空表等于「全都用 configs 里的值」）。
 * 2. **保存即生效**：PUT 一条 → 管理端列表立刻反映 → **玩家侧接口拿到同样的形状**。
 * 3. **幂等**：同 id 重复保存不会变成两行（UPSERT），重置删不存在的行也返回成功。
 * 4. **边界**：id 形态、8 个方向、缩放区间、位置上限；参数不合法是 400 而不是"存进去再说"。
 * 5. **权限与审计**：只读观察员读得到、写不了；每次写都留一条 `equipAlign` 审计。
 *
 * 用法：npm run test:e2e:equip-align（前置 npm run build）
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const ADMIN_CODE = "equipalign-code";

//#region 断言小工具（与其余几套同一骨架）

const EXPECTED_ASSERTIONS = 67;

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
      JWT_SECRET: "e2e-equipalign-secret",
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

/** 8 个方向的位置（每项 +0.5，便于断言"原样回显"） */
function eightPositions(base = 0) {
  return Array.from({ length: 8 }, (_, index) => ({ x: base + index + 0.5, y: base - index - 0.5 }));
}

//#region 主流程

async function main() {
  const server = await startServer({});
  try {
    const base = server.baseUrl;
    const rootToken = await registerAdmin(base, "equipalignroot", "EquipAlign#1");
    check(Boolean(rootToken), "超管注册并登录成功");

    //#region 一、空表 = 出厂值

    group("一、空表：没有行就代表「全都用客户端配置里的值」");

    const emptyList = await api(base, "GET", "/api/admin/equip-aligns", { token: rootToken });
    checkEqual(emptyList.status, 200, "管理端列表可读");
    checkEqual(emptyList.body?.data?.list?.length, 0, "新建库没有任何对齐行");

    const noToken = await api(base, "GET", "/api/admin/equip-aligns");
    checkEqual(noToken.status, 401, "没有令牌读不到列表");

    //#endregion

    //#region 二、保存即生效

    group("二、保存 → 管理端可见 → 玩家侧拿到同一份");

    const clothPayload = { outScale: 1.1, outPositions: eightPositions(0), outManual: false };
    const savedCloth = await api(base, "PUT", "/api/admin/equip-aligns/cloth%3Acloth_1", { token: rootToken, body: clothPayload });
    checkEqual(savedCloth.status, 200, "保存 cloth:cloth_1 成功");
    checkEqual(savedCloth.body?.data?.id, "cloth:cloth_1", "返回体回显 id");
    checkEqual(savedCloth.body?.data?.outScale, 1.1, "返回体回显缩放");
    checkEqual(savedCloth.body?.data?.outPositions?.length, 8, "返回体带 8 个方向");
    checkEqual(savedCloth.body?.data?.outPositions?.[3]?.x, 3.5, "第 4 个方向的 x 原样回显");
    checkEqual(savedCloth.body?.data?.outPositions?.[3]?.y, -3.5, "第 4 个方向的 y 原样回显（y 向上，不做翻转）");
    checkEqual(savedCloth.body?.data?.outManual, false, "outManual=false 原样回显");

    const weaponPayload = { outScale: 0.85, outPositions: eightPositions(5), outManual: true };
    const savedWeapon = await api(base, "PUT", "/api/admin/equip-aligns/weapon%3Aweapon_1", { token: rootToken, body: weaponPayload });
    checkEqual(savedWeapon.status, 200, "保存 weapon:weapon_1 成功");
    checkEqual(savedWeapon.body?.data?.outManual, true, "武器的 outManual=true 保住了（渐进语义）");

    const rolePayload = { outScale: 1, outPositions: eightPositions(0), outManual: true };
    const savedRole = await api(base, "PUT", "/api/admin/equip-aligns/role%3A2", { token: rootToken, body: rolePayload });
    checkEqual(savedRole.status, 200, "保存 role:2（女裸模）成功");

    const threeRows = await api(base, "GET", "/api/admin/equip-aligns", { token: rootToken });
    checkEqual(threeRows.body?.data?.list?.length, 3, "三条都在列表里");
    checkEqual(
      threeRows.body?.data?.list?.map((row) => row.id).join(","),
      "cloth:cloth_1,role:2,weapon:weapon_1",
      "列表按 id 升序（整份下发的字节序稳定）",
    );

    const playerToken = await registerPlayer(base, "equipalignplayer", "123456");
    const playerView = await api(base, "GET", "/api/game-config/equip-align", { token: playerToken });
    checkEqual(playerView.status, 200, "玩家侧能读到对齐几何");
    checkEqual(playerView.body?.data?.list?.length, 3, "玩家侧拿到同样 3 条");
    checkEqual(playerView.body?.data?.list?.[0]?.id, "cloth:cloth_1", "玩家侧 id 形态一致");
    checkEqual(playerView.body?.data?.list?.[0]?.outScale, 1.1, "玩家侧缩放与管理端一致");
    checkEqual(playerView.body?.data?.list?.[0]?.outPositions?.length, 8, "玩家侧也是 8 个方向");
    checkEqual(playerView.body?.data?.list?.[0]?.outPositions?.[0]?.x, 0.5, "玩家侧位置分量一致");
    checkEqual(playerView.body?.data?.list?.[2]?.outManual, true, "玩家侧也拿到 outManual（客户端据此决定走不走自动算法）");

    const playerNoToken = await api(base, "GET", "/api/game-config/equip-align");
    checkEqual(playerNoToken.status, 401, "玩家侧接口同样需要令牌");

    //#endregion

    //#region 三、幂等

    group("三、幂等：重复保存不多行、重复重置不报错");

    const again = await api(base, "PUT", "/api/admin/equip-aligns/cloth%3Acloth_1", {
      token: rootToken,
      body: { outScale: 1.25, outPositions: eightPositions(1), outManual: false },
    });
    checkEqual(again.status, 200, "同 id 再保存成功");
    checkEqual(again.body?.data?.outScale, 1.25, "返回新值");
    const afterAgain = await api(base, "GET", "/api/admin/equip-aligns", { token: rootToken });
    checkEqual(afterAgain.body?.data?.list?.length, 3, "仍是 3 行（UPSERT，不是插新行）");
    checkEqual(
      afterAgain.body?.data?.list?.find((row) => row.id === "cloth:cloth_1")?.outPositions?.[0]?.x,
      1.5,
      "整份覆盖：位置也跟着换成新的一组",
    );

    const resetOne = await api(base, "DELETE", "/api/admin/equip-aligns/role%3A2", { token: rootToken });
    checkEqual(resetOne.status, 200, "重置一条成功");
    const resetTwice = await api(base, "DELETE", "/api/admin/equip-aligns/role%3A2", { token: rootToken });
    checkEqual(resetTwice.status, 200, "重复重置仍成功（幂等：它表达的是「回到默认」这个状态）");
    const afterReset = await api(base, "GET", "/api/admin/equip-aligns", { token: rootToken });
    checkEqual(afterReset.body?.data?.list?.length, 2, "重置后只剩 2 行");
    check(!afterReset.body?.data?.list?.some((row) => row.id === "role:2"), "被重置的那条不在列表里");

    //#endregion

    //#region 四、边界

    group("四、边界：id 形态 / 8 个方向 / 缩放区间 / 位置上限");

    const badId = await api(base, "PUT", "/api/admin/equip-aligns/abc", { token: rootToken, body: clothPayload });
    checkEqual(badId.status, 400, "id 形态不合法 → 400");
    checkEqual(badId.body?.code, 40000, "业务码是 PARAM_INVALID（40000）");

    const badSex = await api(base, "PUT", "/api/admin/equip-aligns/role%3A3", { token: rootToken, body: rolePayload });
    checkEqual(badSex.status, 400, "role:3 不存在这个性别 → 400");

    const sevenDirs = await api(base, "PUT", "/api/admin/equip-aligns/cloth%3Acloth_2", {
      token: rootToken,
      body: { outScale: 1, outPositions: eightPositions(0).slice(0, 7), outManual: false },
    });
    checkEqual(sevenDirs.status, 400, "只有 7 个方向 → 400（少一个说明页面与配置已错位）");

    const nineDirs = await api(base, "PUT", "/api/admin/equip-aligns/cloth%3Acloth_2", {
      token: rootToken,
      body: { outScale: 1, outPositions: [...eightPositions(0), { x: 0, y: 0 }], outManual: false },
    });
    checkEqual(nineDirs.status, 400, "9 个方向 → 400");

    const zeroScale = await api(base, "PUT", "/api/admin/equip-aligns/cloth%3Acloth_2", {
      token: rootToken,
      body: { outScale: 0, outPositions: eightPositions(0), outManual: false },
    });
    checkEqual(zeroScale.status, 400, "缩放为 0 → 400（会让整件作品消失）");

    const hugeScale = await api(base, "PUT", "/api/admin/equip-aligns/cloth%3Acloth_2", {
      token: rootToken,
      body: { outScale: 11, outPositions: eightPositions(0), outManual: false },
    });
    checkEqual(hugeScale.status, 400, "缩放 11 超上限 → 400");

    const farAway = await api(base, "PUT", "/api/admin/equip-aligns/cloth%3Acloth_2", {
      token: rootToken,
      body: { outScale: 1, outPositions: eightPositions(0).map(() => ({ x: 99_999, y: 0 })), outManual: false },
    });
    checkEqual(farAway.status, 400, "位置超上限 → 400（四位数说明把像素当游戏单位了）");

    const unknownId = await api(base, "PUT", "/api/admin/equip-aligns/cloth%3Acloth_999", {
      token: rootToken,
      body: { outScale: 1, outPositions: eightPositions(0), outManual: false },
    });
    checkEqual(unknownId.status, 200, "未知装备 id 也允许保存（清单在客户端配置里，服务端不硬编）");

    const missingBody = await api(base, "PUT", "/api/admin/equip-aligns/cloth%3Acloth_3", { token: rootToken, body: {} });
    checkEqual(missingBody.status, 400, "缺 outScale / outPositions → 400");

    //#endregion

    //#region 五、权限与审计

    group("五、权限与审计");

    const viewerToken = await registerAdmin(base, "equipalignviewer", "EquipAlign#2");
    const viewerId = (await api(base, "GET", "/api/admin/admins", { token: rootToken })).body?.data?.list?.find(
      (row) => row.username === "equipalignviewer",
    )?.id;
    const demote = await api(base, "PATCH", `/api/admin/admins/${viewerId}`, { token: rootToken, body: { role: "viewer" } });
    checkEqual(demote.status, 200, "把第二个管理员降为只读观察员");

    const viewerRead = await api(base, "GET", "/api/admin/equip-aligns", { token: viewerToken });
    checkEqual(viewerRead.status, 200, "观察员可读（有 gameConfig:read）");
    const viewerWrite = await api(base, "PUT", "/api/admin/equip-aligns/cloth%3Acloth_4", {
      token: viewerToken,
      body: { outScale: 1, outPositions: eightPositions(0), outManual: false },
    });
    checkEqual(viewerWrite.status, 403, "观察员写被拒（403）");
    const viewerReset = await api(base, "DELETE", "/api/admin/equip-aligns/cloth%3Acloth_1", { token: viewerToken });
    checkEqual(viewerReset.status, 403, "观察员重置被拒（403）");

    const audit = await api(base, "GET", "/api/admin/audit-logs?targetType=equipAlign&size=50", { token: rootToken });
    checkEqual(audit.status, 200, "审计日志可查");
    const auditRows = audit.body?.data?.list ?? [];
    check(auditRows.length >= 4, "每次保存 / 重置都留了审计（至少 4 条）");
    check(
      auditRows.some((row) => row.action === "adminEquipAlign.save"),
      "有一条 save 动作（动作取自 operationId）",
    );
    check(
      auditRows.some((row) => row.action === "adminEquipAlign.reset"),
      "有一条 reset 动作",
    );
    check(
      auditRows.every((row) => row.targetType === "equipAlign"),
      "目标类型统一是 equipAlign",
    );
    check(
      auditRows.some((row) => row.targetId === "cloth:cloth_1"),
      "目标 id 记的是对齐目标（便于追「上周谁把这件拖歪了」）",
    );
    check(
      auditRows.some(
        (row) => row.actorName === "equipalignroot" && row.action === "adminEquipAlign.save" && row.success === true,
      ),
      "超管的成功保存留了审计",
    );
    // 位置改动只有请求体里有，detail 缺了就等于「知道谁调了、不知道调成什么」
    check(
      auditRows.some((row) => row.action === "adminEquipAlign.save" && JSON.stringify(row.detail ?? {}).includes("outScale")),
      "审计 detail 留了当时的请求体（能看出改成什么值）",
    );

    //#endregion

    //#region 六、文档契约

    group("六、文档契约：三个接口的标签 / 权限 / 响应类型");

    const docs = await fetch(`${base}/api-docs-json`);
    const doc = await docs.json();
    const adminList = doc.paths?.["/api/admin/equip-aligns"]?.get;
    const adminSave = doc.paths?.["/api/admin/equip-aligns/{id}"]?.put;
    const adminReset = doc.paths?.["/api/admin/equip-aligns/{id}"]?.delete;
    const playerGet = doc.paths?.["/api/game-config/equip-align"]?.get;
    check(Boolean(adminList && adminSave && adminReset && playerGet), "四个接口都在文档里");
    checkEqual(adminSave?.["x-olua-permissions"]?.join(","), "gameConfig:write", "保存要求 gameConfig:write");
    checkEqual(adminList?.["x-olua-permissions"]?.join(","), "gameConfig:read", "列表要求 gameConfig:read");
    checkEqual(adminList?.["x-olua-audience"], "admin", "列表归管理端受众");
    checkEqual(playerGet?.["x-olua-audience"], "player", "玩家侧接口归玩家受众");
    checkEqual(adminSave?.["x-olua-data-schema"]?.$ref, "#/components/schemas/EquipAlignDto", "保存的响应类型是 EquipAlignDto");
    checkEqual(adminList?.["x-olua-data-schema"]?.$ref, "#/components/schemas/EquipAlignListDto", "列表的响应类型是 EquipAlignListDto");
    checkEqual(adminReset?.["x-olua-data-schema"], undefined, "重置声明为无响应体（data 恒为 null）");
    check(Boolean(doc.components?.schemas?.EquipAlignDto), "EquipAlignDto schema 已注册进文档");
    check(Boolean(doc.components?.schemas?.SaveEquipAlignDto), "SaveEquipAlignDto schema 已注册进文档");
    checkEqual(doc.components?.schemas?.SaveEquipAlignDto?.properties?.outPositions?.minItems, 8, "入参 schema 标明至少 8 个方向");
    checkEqual(doc.components?.schemas?.SaveEquipAlignDto?.properties?.outPositions?.maxItems, 8, "入参 schema 标明最多 8 个方向");

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
      console.log(`\n❌ 服务端 e2e（装备对齐）：${passed} 条通过 / ${failed} 条失败`);
      console.log(failures.map((label) => `   · ${label}`).join("\n"));
      process.exit(1);
    }
    console.log(`\n✅ 服务端 e2e（装备对齐）：${passed} 条通过 / 0 条失败`);
  })
  .catch((error) => {
    console.error("\n💥 e2e 运行失败：", error);
    process.exit(1);
  });
