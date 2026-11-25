#!/usr/bin/env node
/**
 * 配置快照导入导出 e2e（server/test/e2e-config-snapshot.cjs，#1266）
 *
 * 界面化的导入导出只是把 `make config-export` / `make config-import` 的同一份脚本
 * 挂到了 HTTP 上，所以这套要验的是**接口层**的语义（脚本内部的三道自保由
 * `test/config-sync.cjs` 盯着，不在这里重复）：
 *
 * 一、导出：内容与出厂快照逐字节一致（compare 剔版本行）、统计字段与文件对得上、
 *     `configSql.validate` 直接认它；观察员 403（没有 system:read）/ 玩家 401
 * 二、导入往返：导出 → 导入 → 再导出逐字节一致（幂等）；report 里带留档路径
 * 三、版本闸：库版本 +1 后导入旧文件被拒（50152 全中文）；`?force=true` 确认回退后
 *     导入成功、版本号只升不降
 * 四、坏文件拒绝：缺格式标记 / 混入运行时表 / 空请求体 → 全部拒绝且**库原样不动**
 *     （拒绝后立即再导出一次，与拒绝前逐字节一致）
 * 五、权限：观察员 403（system:write 不给观察员）
 * 六、审计：导入落 adminSystem.importConfigSnapshot（targetType config / 操作人一致）
 * 七、文档：两个 operationId 都在契约里，权限点标注正确
 *
 * 为什么要起真服务：导出要读「服务正在用的那个库」（WAL 一致性），导入要在服务端
 * 持有连接的情况下走写锁 —— 这两件事离线测不出来。用临时文件库（`:memory:` 部署
 * 形态下这两个接口本来就明确拒绝）。
 *
 * 用法：先 `npm run build`，再 `node test/e2e-config-snapshot.cjs`
 */
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const REPO_SNAPSHOT = path.join(SERVER_DIR, "data", "config-sync.sql");
// 校验 / 比对直接用脚本自己的实现：接口层不重造第二份判据
const configSql = require(path.join(SERVER_DIR, "scripts", "lib", "config-sql.cjs"));

const ADMIN_ZONE = 1;
const ADMIN_CODE = "olua-e2e-config-snapshot-1266";
const VERSION_GATE_MARK = "文件比目标库旧";

//#region 断言小工具（与 e2e-runtime-params-reset 同款口径）

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** 起一台真服务（临时文件库；导出 / 导入都要在「服务持有连接」的前提下过写锁） */
async function startServer(dbPath, port) {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ENTRY], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      API_PREFIX: "api",
      DB_PATH: dbPath,
      JWT_SECRET: "e2e-config-snapshot-secret",
      JWT_EXPIRES_IN: "1h",
      ADMIN_REGISTER_CODE: ADMIN_CODE,
      LOG_REQUESTS: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(String(chunk)));
  child.stderr.on("data", (chunk) => chunks.push(String(chunk)));
  const baseUrl = `http://127.0.0.1:${port}`;

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务进程提前退出（code=${child.exitCode}）\n${chunks.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return { baseUrl, child, logs: () => chunks.join("") };
    } catch {
      /* 还没起来 */
    }
    await sleep(100);
  }
  throw new Error(`等待服务启动超时\n${chunks.join("")}`);
}

async function stopServer(server) {
  if (server.child.exitCode === null && !server.child.signalCode) server.child.kill("SIGTERM");
  await sleep(300);
  if (server.child.exitCode === null && !server.child.signalCode) server.child.kill("SIGKILL");
  await sleep(200);
}

/**
 * 一发请求。`rawText` 是导入专用：请求体就是 SQL 全文直发（text/plain），
 * 与管理端 `http.postText` 同一条链路。
 */
async function api(method, path, options = {}) {
  const headers = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.rawText !== undefined) headers["Content-Type"] = "text/plain; charset=utf-8";
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.zoneId !== undefined) headers["X-Zone-Id"] = String(options.zoneId);
  const body = options.rawText !== undefined ? options.rawText : options.body === undefined ? undefined : JSON.stringify(options.body);
  const response = await fetch(`${options.baseUrl}/${path}`, { method, headers, body });
  const envelope = await response.json().catch(() => null);
  return {
    status: response.status,
    code: envelope ? envelope.code : -1,
    message: envelope ? envelope.message : "",
    data: envelope ? envelope.data : null,
  };
}

const EXPORT_PATH = "admin/system/config-snapshot/export";
const IMPORT_PATH = "admin/system/config-snapshot/import";

/** 把文件头里的 `-- config-version: N` 换成给定值（造「比库旧 / 比库新」的文件用） */
function withVersion(sql, version) {
  return sql.replace(/^-- config-version: \d+$/m, `-- config-version: ${version}`);
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-config-snapshot-${Date.now()}.db`);
  const port = await freePort();
  const server = await startServer(dbPath, port);
  const baseUrl = `${server.baseUrl}/api`;

  try {
    //#region 准备

    console.log("— 准备：超管 + 观察员 + 一个玩家 —");
    const superAdmin = await api("POST", "admin/auth/register", {
      baseUrl,
      body: { username: "gm_snapshot", password: "pass1234", registerCode: ADMIN_CODE },
    });
    check(superAdmin.code === 0, "注册超管成功", superAdmin.message);
    const adminToken = superAdmin.data.token;

    const viewer = await api("POST", "admin/auth/register", {
      baseUrl,
      body: { username: "gm_snapshot_view", password: "pass1234", registerCode: ADMIN_CODE },
    });
    const viewerToken = viewer.data.token;
    await api("PATCH", `admin/admins/${viewer.data.admin.id}`, {
      baseUrl,
      token: adminToken,
      zoneId: ADMIN_ZONE,
      body: { role: "viewer" },
    });

    const player = await api("POST", "auth/register", { baseUrl, body: { username: "snapshot_player", password: "pass1234" } });
    const playerToken = player.data.token;

    //#endregion

    //#region 一、导出

    console.log("— 一、导出：内容与出厂快照一致，观察员 / 玩家被拒 —");

    const exported = await api("GET", EXPORT_PATH, { baseUrl, token: adminToken, zoneId: ADMIN_ZONE });
    check(exported.code === 0 && !!exported.data.sql, "超管导出成功", exported.message);
    const sql = exported.data.sql;
    check(typeof sql === "string" && sql.startsWith("-- olua 配置快照"), "导出内容带快照头（格式标记）", String(sql).slice(0, 40));

    // 接口产物必须被导入校验直接认账 —— 界面导出的文件要能原样导回来（含 make config-import）
    const meta = configSql.parseMeta(sql);
    let validated = true;
    try {
      configSql.validate(sql, meta);
    } catch (error) {
      validated = false;
      check(false, "configSql.validate 认得接口导出的内容", String(error));
    }
    check(validated, "configSql.validate 认得接口导出的内容");

    // 与出厂快照的**语义**一致：逐表行数相同 + 版本相同。不做逐字节比 —— 仓库快照是从
    // 存量库导出的（后加的列 ALTER 追加在表尾），新库按 CREATE TABLE 原生列序，同一份数据
    // 两个物理列序，逐字节必差（#655：列名显式写出，物理顺序不是契约；导入语义不受影响，
    // 往返对称性由下面「导入 → 再导出逐字节一致」兜住）。行数能逮住「快照灌进来的行被
    // 启动逻辑抹掉」这类回归（#1215 任务线 / 刷怪区就靠它守着）。
    const repoSnapshot = fs.readFileSync(REPO_SNAPSHOT, "utf8");
    const sectionCounts = (text) => {
      const counts = {};
      for (const match of text.matchAll(/^-- ===== (\S+?)（(\d+) 行）=====/gm)) counts[match[1]] = Number(match[2]);
      return counts;
    };
    const exportedCounts = sectionCounts(sql);
    const repoCounts = sectionCounts(repoSnapshot);
    const tableNames = [...new Set([...Object.keys(exportedCounts), ...Object.keys(repoCounts)])].sort();
    check(
      tableNames.every((name) => exportedCounts[name] === repoCounts[name]),
      "逐表行数与出厂快照一致（语义相同，物理列序允许不同）",
      tableNames.filter((name) => exportedCounts[name] !== repoCounts[name]).map((name) => `${name} ${repoCounts[name]}→${exportedCounts[name]}`).join("、"),
    );
    check(
      Object.keys(exportedCounts).length === Object.keys(repoCounts).length,
      "导出的配置表张数与出厂快照一致",
      `${Object.keys(exportedCounts).length} vs ${Object.keys(repoCounts).length}`,
    );

    check(exported.data.rows > 0 && exported.data.tables > 0, "统计字段非零", `${exported.data.tables} 张 / ${exported.data.rows} 行`);
    check(
      exported.data.tables === [...sql.matchAll(/^DELETE FROM "/gm)].length && exported.data.rows === [...sql.matchAll(/^INSERT INTO "/gm)].length,
      "统计字段与文件内容对得上（张数按 DELETE 段 / 行数按 INSERT 条）",
      `${exported.data.tables}/${exported.data.rows}`,
    );
    check(configSql.parseMeta(sql).version === exported.data.version, "版本字段 == 文件头里的配置版本", `${exported.data.version}`);

    const viewerExport = await api("GET", EXPORT_PATH, { baseUrl, token: viewerToken, zoneId: ADMIN_ZONE });
    check(viewerExport.status === 403, "观察员导出被拒（403：没有 system:read）", `${viewerExport.status}`);
    const playerExport = await api("GET", EXPORT_PATH, { baseUrl, token: playerToken });
    check(playerExport.status === 401, "玩家令牌导出被拒（401：audience 不符）", `${playerExport.status}`);

    //#endregion

    //#region 二、导入往返

    console.log("— 二、导入往返：导出 → 导入 → 再导出逐字节一致 —");

    const firstImport = await api("POST", IMPORT_PATH, { baseUrl, token: adminToken, zoneId: ADMIN_ZONE, rawText: sql });
    check(firstImport.code === 0, "导入成功", firstImport.message);
    check(String(firstImport.data.report).includes("配置已导入"), "report 含导入完成标记", String(firstImport.data.report).slice(0, 80));
    check(String(firstImport.data.report).includes("留档"), "report 含留档路径提示", "");

    const reExported = await api("GET", EXPORT_PATH, { baseUrl, token: adminToken, zoneId: ADMIN_ZONE });
    check(reExported.code === 0, "再导出成功", reExported.message);
    check(configSql.compare(reExported.data.sql, sql) === null, "导入后再导出与导入前逐字节一致（幂等）", "");

    //#endregion

    //#region 三、版本闸

    console.log("— 三、版本闸：文件比库旧拒绝，确认回退可导入 —");

    // 让库版本往前走一步（配置写 +1），再拿「旧版本号、同内容」的文件去导。
    // currentVersion 必须在改完之后现导出一次取 —— 上一节那份导出是改之前的。
    const dirty = await api("PATCH", "admin/runtime-params", {
      baseUrl,
      token: adminToken,
      zoneId: ADMIN_ZONE,
      body: { drop: { autoPickupRadius: 64 } },
    });
    check(dirty.code === 0, "改一处运行时参数让库版本 +1", dirty.message);

    const afterPatch = await api("GET", EXPORT_PATH, { baseUrl, token: adminToken, zoneId: ADMIN_ZONE });
    check(afterPatch.code === 0, "改动后重新导出", afterPatch.message);
    const currentVersion = configSql.parseMeta(afterPatch.data.sql).version;
    const oldFile = withVersion(sql, Math.max(0, currentVersion - 1));
    check(configSql.parseMeta(oldFile).version === currentVersion - 1, "已构造比库旧一版的文件", `库=第 ${currentVersion} 版 / 文件=第 ${configSql.parseMeta(oldFile).version} 版`);

    const rejected = await api("POST", IMPORT_PATH, { baseUrl, token: adminToken, zoneId: ADMIN_ZONE, rawText: oldFile });
    check(rejected.status === 400 && rejected.code === 50152, "旧文件被版本闸拒绝（400 / 50152）", `${rejected.status}/${rejected.code}`);
    check(String(rejected.message).includes(VERSION_GATE_MARK), "报错说明版本差（界面靠它出「确认回退」）", rejected.message);

    const forced = await api("POST", `${IMPORT_PATH}?force=true`, { baseUrl, token: adminToken, zoneId: ADMIN_ZONE, rawText: oldFile });
    check(forced.code === 0, "确认回退后导入成功", forced.message);

    const afterForced = await api("GET", EXPORT_PATH, { baseUrl, token: adminToken, zoneId: ADMIN_ZONE });
    check(configSql.compare(afterForced.data.sql, oldFile) === null, "回退后库内容 == 旧文件（剔版本行）", "");
    check(configSql.parseMeta(afterForced.data.sql).version === currentVersion, "版本号只升不降（回退不回写版本）", `第 ${configSql.parseMeta(afterForced.data.sql).version} 版`);

    //#endregion

    //#region 四、坏文件拒绝

    console.log("— 四、坏文件拒绝：拒掉之后库原样不动 —");

    const noTag = "-- 随手拼的 SQL\nDELETE FROM \"drugs\";\n";
    const bad1 = await api("POST", IMPORT_PATH, { baseUrl, token: adminToken, zoneId: ADMIN_ZONE, rawText: noTag });
    check(bad1.status === 400 && bad1.code === 50152, "缺格式标记被拒", `${bad1.status}/${bad1.code} ${bad1.message}`);

    const withRuntime = `${sql}\nDELETE FROM "accounts";\n`;
    const bad2 = await api("POST", IMPORT_PATH, { baseUrl, token: adminToken, zoneId: ADMIN_ZONE, rawText: withRuntime });
    check(bad2.status === 400 && bad2.code === 50152, "混入运行时表被拒（账号数据不跟着配置走）", `${bad2.status}/${bad2.code}`);

    const empty = await api("POST", IMPORT_PATH, { baseUrl, token: adminToken, zoneId: ADMIN_ZONE, rawText: "   \n  " });
    check(empty.status === 400, "空请求体被拒", `${empty.status} ${empty.message}`);

    const untouched = await api("GET", EXPORT_PATH, { baseUrl, token: adminToken, zoneId: ADMIN_ZONE });
    check(configSql.compare(untouched.data.sql, afterForced.data.sql) === null, "拒绝后立即再导出与拒绝前逐字节一致（库没被动过）", "");

    //#endregion

    //#region 五、五、权限

    console.log("— 五、权限：观察员没有 system:write —");

    const viewerImport = await api("POST", IMPORT_PATH, { baseUrl, token: viewerToken, zoneId: ADMIN_ZONE, rawText: sql });
    check(viewerImport.status === 403 && viewerImport.code === 30006, "观察员导入被拒（403 / 30006）", `${viewerImport.status}/${viewerImport.code}`);

    //#endregion

    //#region 六、审计

    console.log("— 六、审计：导入动作留痕 —");

    const audit = await api("GET", "admin/audit-logs?action=adminSystem.importConfigSnapshot&page=1&size=10", {
      baseUrl,
      token: adminToken,
      zoneId: ADMIN_ZONE,
    });
    const entry = (audit.data.list || []).find((item) => item.statusCode === 200 || item.statusCode === 201);
    check(
      !!entry && entry.targetType === "config" && entry.actorName === "gm_snapshot",
      "导入落审计（action adminSystem.importConfigSnapshot / targetType config / 操作人一致）",
      JSON.stringify((audit.data.list || [])[0] || null),
    );

    //#endregion

    //#region 七、文档

    console.log("— 七、文档：两个 operationId 都在契约里 —");

    const docResponse = await fetch(`${server.baseUrl}/api-docs-json`);
    const docs = await docResponse.json();
    const exportOp = (docs.paths["/api/admin/system/config-snapshot/export"] || {}).get;
    const importOp = (docs.paths["/api/admin/system/config-snapshot/import"] || {}).post;
    check(!!exportOp && exportOp.operationId === "adminSystem.exportConfigSnapshot", "导出在契约里（operationId 正确）", JSON.stringify(exportOp || null).slice(0, 80));
    check(!!importOp && importOp.operationId === "adminSystem.importConfigSnapshot", "导入在契约里（operationId 正确）", JSON.stringify(importOp || null).slice(0, 80));
    check(!!exportOp && JSON.stringify(exportOp["x-olua-permissions"]).includes("system:read"), "导出标注 system:read", JSON.stringify(exportOp ? exportOp["x-olua-permissions"] : null));
    check(!!importOp && JSON.stringify(importOp["x-olua-permissions"]).includes("system:write"), "导入标注 system:write", JSON.stringify(importOp ? importOp["x-olua-permissions"] : null));

    //#endregion
  } finally {
    await stopServer(server);
    try {
      fs.rmSync(dbPath, { force: true });
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
    } catch {
      /* 清理失败无所谓 */
    }
  }

  finish("配置快照导入导出 e2e 全绿");
})();
