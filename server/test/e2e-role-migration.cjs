#!/usr/bin/env node
/**
 * 存档结构版本专项 e2e（server/test/e2e-role-migration.cjs，issue #818 / B60）
 *
 * 盯的不变量（改存档结构 / 迁移链 / 选角链路后必须全绿）：
 * 一、新号带版本号：建号那一刻 `data.schemaVersion` 就是当前版本（否则版本分布永远挂一档假老档）
 * 二、老档进游戏即迁移：v1（无该字段）→ `select` → 落库 v2，**金币 / 背包原样、revision 不推进**
 * 三、版本超前拒登：v99 → 20028 + 「联系客服」，库里一个字节不动，**在线标记也不置**
 * 四、坏档不洗白：JSON 都解析不出来的行，本闸不碰（那是 #819 的事）——
 *     绝不能顺手把 `{}` 迁成 v2 写回去，那会把坏档洗成空档、证据一起没了
 * 五、保存路径盖章：客户端交上来的老形状被迁到当前版本才落库；带更新的版本号直接拒
 * 六、迁移脚本：`--dry-run` 只报告不写库；真跑把落后的行迁完；有迁不动的行 → 退出码 1
 *
 * 走的是 `dist/`，所以前置是 `npm run build`（迁移脚本也 require dist 里的同一条链）。
 * 用法：npm run test:e2e:role-migration
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const SCRIPT = path.join(SERVER_DIR, "scripts", "migrate-role-data.cjs");

/** 与 ROLE_DATA_VERSION 对齐；写死是有意的 —— 版本号变了测试必须跟着改（顺便提醒改文档） */
const CURRENT_VERSION = 2;

//#region 断言小工具（与 e2e-quest 同款口径）

let passed = 0;
let failed = 0;
const failures = [];

function group(title) {
  console.log(`\n▶ ${title}`);
}

function check(condition, label, detail = "") {
  if (condition) {
    passed += 1;
    return true;
  }
  failed += 1;
  failures.push(label);
  console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ""}`);
  return false;
}

function checkEqual(actual, expected, label) {
  return check(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}

//#endregion

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startServer(dbPath) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ENTRY], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      API_PREFIX: "api",
      DB_PATH: dbPath,
      JWT_SECRET: "e2e-role-migration-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(String(chunk)));
  child.stderr.on("data", (chunk) => chunks.push(String(chunk)));

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务进程提前退出（code=${child.exitCode}）\n${chunks.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return { baseUrl, port, child, logs: () => chunks.join("") };
    } catch {
      /* 还没起来 */
    }
    await sleep(100);
  }
  throw new Error("等待服务启动超时");
}

/** 发一次请求，返回 `{ status, code, message, data }`（状态码也要看：20028 是 409） */
async function api(baseUrl, method, route, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}/api/${route}`, {
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
  return {
    status: response.status,
    code: body ? body.code : -1,
    message: body ? body.message : "",
    data: body ? body.data : null,
  };
}

//#region 直接开库（造老档 / 核落库结果；e2e-quest 同款手法）

function withDb(dbPath, run) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function roleRow(dbPath, roleId) {
  return withDb(dbPath, (db) => db.prepare("SELECT id, data, revision FROM roles WHERE id = ?").get(roleId));
}

function accountRow(dbPath, username) {
  return withDb(dbPath, (db) => db.prepare("SELECT id, online_role_id FROM accounts WHERE username = ?").get(username));
}

/** 把一份存档原样写回（**故意不走接口**：这些都是客户端改不出来的形状） */
function writeRawData(dbPath, roleId, raw) {
  withDb(dbPath, (db) => db.prepare("UPDATE roles SET data = ? WHERE id = ?").run(raw, roleId));
}

/** 读存档对象并做一次改动后写回（保留其它字段，模拟「某版本之前的老档」） */
function mutateData(dbPath, roleId, mutate) {
  const row = roleRow(dbPath, roleId);
  const data = JSON.parse(row.data);
  mutate(data);
  writeRawData(dbPath, roleId, JSON.stringify(data));
  return data;
}

//#endregion

/** 跑迁移脚本，返回 `{ code, output }` */
function runMigrateScript(dbPath, extraArgs = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", SCRIPT, "--db", dbPath, ...extraArgs], {
      cwd: SERVER_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(String(chunk)));
    child.stderr.on("data", (chunk) => chunks.push(String(chunk)));
    child.on("close", (code) => resolve({ code, output: chunks.join("") }));
  });
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-role-migration-${Date.now()}.db`);
  let server = null;
  try {
    server = await startServer(dbPath);
    const { baseUrl } = server;

    //#region 准备：账号 + 三个角色

    group("准备：账号与三个角色");
    const registered = await api(baseUrl, "POST", "auth/register", { body: { username: "mig_player", password: "pass1234" } });
    const token = registered.data && registered.data.token;
    check(!!token, "准备：玩家注册成功", registered.message);

    const first = await api(baseUrl, "POST", "roles", { token, body: { name: "老档甲", occupation: "1", sex: "1" } });
    const roleA = first.data && first.data.id;
    const second = await api(baseUrl, "POST", "roles", { token, body: { name: "老档乙", occupation: "1", sex: "1" } });
    const roleB = second.data && second.data.id;
    const third = await api(baseUrl, "POST", "roles", { token, body: { name: "坏档丙", occupation: "1", sex: "1" } });
    const roleC = third.data && third.data.id;
    check(!!roleA && !!roleB && !!roleC, "准备：三个角色已创建", first.message);

    //#endregion

    //#region 一、新号从第一天就带版本号

    group("一、新号带当前版本号");
    const newRow = roleRow(dbPath, roleA);
    const newData = JSON.parse(newRow.data);
    checkEqual(newData.schemaVersion, CURRENT_VERSION, "建号落库即为当前版本（不是等第一次存档才盖）");

    //#endregion

    //#region 二、老档进游戏即迁移

    group("二、老档（v1）进游戏即迁移并落库");
    // 造一份 v1：删掉版本号，塞一个可辨认的账本值与一格背包
    mutateData(dbPath, roleA, (data) => {
      delete data.schemaVersion;
      data.gold = 12345;
      data.bag = [[{ id: "drug_hp_1", count: 5 }, null], [null, null]];
    });
    const beforeSelect = roleRow(dbPath, roleA);
    check(!("schemaVersion" in JSON.parse(beforeSelect.data)), "造档：库里确实没有 schemaVersion（v1）");

    const selected = await api(baseUrl, "POST", `roles/${roleA}/select`, { token });
    checkEqual(selected.code, 0, "老档可以进游戏（惰性迁移后可玩，不是拒登）");

    const afterSelect = roleRow(dbPath, roleA);
    const migrated = JSON.parse(afterSelect.data);
    checkEqual(migrated.schemaVersion, CURRENT_VERSION, "进游戏后落库即为当前版本");
    checkEqual(migrated.gold, 12345, "迁移不动账本（金币原样）");
    checkEqual(JSON.stringify(migrated.bag), JSON.stringify([[{ id: "drug_hp_1", count: 5 }, null], [null, null]]), "迁移不动背包");
    checkEqual(afterSelect.revision, beforeSelect.revision, "迁移不推进 revision（否则客户端下次存档白撞 20006）");

    const detail = await api(baseUrl, "GET", `roles/${roleA}`, { token });
    checkEqual(detail.data && detail.data.data && detail.data.data.schemaVersion, CURRENT_VERSION, "详情接口拿到的也是当前版本");

    //#endregion

    //#region 三、版本超前拒登

    group("三、版本超前（回滚发布）拒登");
    const onlineBefore = accountRow(dbPath, "mig_player").online_role_id;
    mutateData(dbPath, roleB, (data) => {
      data.schemaVersion = 99; // 造一份「更新版本的代码写的档」
    });
    const aheadRowBefore = roleRow(dbPath, roleB);
    const rejected = await api(baseUrl, "POST", `roles/${roleB}/select`, { token });
    checkEqual(rejected.code, 20028, "版本超前被拒（20028）");
    checkEqual(rejected.status, 409, "HTTP 状态是冲突（409）而不是 400");
    check(rejected.message.includes("联系客服"), "提示文案带「联系客服」", rejected.message);
    checkEqual(roleRow(dbPath, roleB).data, aheadRowBefore.data, "被拒时库里一个字节不动（不把新字段当未知键丢掉）");
    checkEqual(accountRow(dbPath, "mig_player").online_role_id, onlineBefore, "被拒的选角不置在线标记");

    //#endregion

    //#region 四、坏档不洗白

    group("四、坏档（JSON 解析失败）本闸不碰");
    const brokenRaw = '{"id":"' + roleC + '","gold":';
    writeRawData(dbPath, roleC, brokenRaw);
    const brokenSelect = await api(baseUrl, "POST", `roles/${roleC}/select`, { token });
    // 本闸只判版本：解析不出来就原样放行，坏档闸是 #819 的事。
    // 这里真正要钉住的是「没有顺手把 {} 迁成 v2 写回去」
    check(brokenSelect.code === 0 || brokenSelect.code === 20003, "坏档不改判据（放行或按存档非法拒，两者都可接受）", `${brokenSelect.code}`);
    checkEqual(roleRow(dbPath, roleC).data, brokenRaw, "坏档字节原样保留（没有被洗成空档）");
    // 选角会把在线标记挪到 C 上，后面还要用 A 存档 —— 选回来
    const reselectA = await api(baseUrl, "POST", `roles/${roleA}/select`, { token });
    checkEqual(reselectA.code, 0, "准备：把在线标记选回 A", reselectA.message);

    //#endregion

    //#region 五、保存路径盖章

    group("五、保存路径：老形状先迁移再落库");
    const current = roleRow(dbPath, roleA);
    const currentData = JSON.parse(current.data);
    delete currentData.schemaVersion; // 模拟「客户端本地那份还是老形状」
    // 用一个**客户端书写**的字段验「内容照常生效」：金币 / 经验是服务端账本，
    // PUT 上来一律按库里的值回填（role-authority 的收权）
    const saved = await api(baseUrl, "PUT", `roles/${roleA}`, {
      token,
      body: { revision: current.revision, data: { ...currentData, soulShow: true } },
    });
    checkEqual(saved.code, 0, "老形状存档可以正常保存", saved.message);
    checkEqual(JSON.parse(roleRow(dbPath, roleA).data).schemaVersion, CURRENT_VERSION, "保存时盖当前版本");
    checkEqual(JSON.parse(roleRow(dbPath, roleA).data).soulShow, true, "保存的内容照常生效（客户端书写的字段）");

    const newerSave = await api(baseUrl, "PUT", `roles/${roleA}`, {
      token,
      body: { revision: saved.data && saved.data.revision, data: { ...currentData, schemaVersion: 99 } },
    });
    checkEqual(newerSave.code, 20028, "带更新的版本号存档被拒（20028）");
    checkEqual(JSON.parse(roleRow(dbPath, roleA).data).schemaVersion, CURRENT_VERSION, "被拒的存档没写进库");

    //#endregion

    //#region 六、迁移脚本

    group("六、迁移脚本（make migrate）");
    // 先把第四段留下的坏档修好（坏档是 #819 的闸，脚本只负责报出来，不该混进版本分布的用例里），
    // 再把第三段造的超前档拉回当前版本 —— 这一段的 dry-run 要验「只有落后行时」的正常路径
    writeRawData(dbPath, roleC, JSON.stringify({ id: roleC, name: "坏档丙", occupation: "1", sex: "1", level: 1, gold: 0, schemaVersion: CURRENT_VERSION }));
    mutateData(dbPath, roleB, (data) => {
      data.schemaVersion = CURRENT_VERSION;
    });
    // 造一次「库里有落后的行」：A 退回 v1
    mutateData(dbPath, roleA, (data) => {
      delete data.schemaVersion;
    });

    const dryRun = await runMigrateScript(dbPath, ["--dry-run"]);
    checkEqual(dryRun.code, 0, "dry-run 退出码 0（有落后行不算失败）", dryRun.output.split("\n").slice(-4).join(" / "));
    check(dryRun.output.includes("角色总数：3"), "dry-run 报告角色总数", dryRun.output);
    check(/版本分布：.*v1 = 1/.test(dryRun.output), "dry-run 报告版本分布（含 v1 = 1）", dryRun.output);
    check(dryRun.output.includes("需要迁移：1"), "dry-run 报告需要迁移的行数", dryRun.output);
    check(!("schemaVersion" in JSON.parse(roleRow(dbPath, roleA).data)), "dry-run **不写库**（A 仍是 v1）");

    // 造一个迁不动的行：版本超前
    mutateData(dbPath, roleB, (data) => {
      data.schemaVersion = 99;
    });
    const withAhead = await runMigrateScript(dbPath);
    checkEqual(withAhead.code, 1, "有迁不动的行时退出码 1（发布流程拿它当闸门）");
    check(withAhead.output.includes("迁不动"), "报告迁不动的分组", withAhead.output);
    check(withAhead.output.includes(roleB), "点出具体角色 id", withAhead.output);
    checkEqual(JSON.parse(roleRow(dbPath, roleB).data).schemaVersion, 99, "超前的行没有被改写");
    check(!("schemaVersion" in JSON.parse(roleRow(dbPath, roleA).data)), "全有或全无：有迁不动的行时**一行都不写**（A 仍是 v1）");

    // 把 B 拉回当前版本，再跑一次应当全绿
    mutateData(dbPath, roleB, (data) => {
      data.schemaVersion = CURRENT_VERSION;
    });
    const clean = await runMigrateScript(dbPath);
    checkEqual(clean.code, 0, "没有坏档 / 超前行时退出码 0", clean.output.split("\n").slice(-4).join(" / "));
    check(clean.output.includes("已迁移：1"), "真跑把落后的行迁掉（已迁移：1）", clean.output);
    checkEqual(JSON.parse(roleRow(dbPath, roleA).data).schemaVersion, CURRENT_VERSION, "脚本把 A 写成当前版本");
    checkEqual(JSON.parse(roleRow(dbPath, roleA).data).soulShow, true, "脚本不动其它字段（soulShow 仍是保存时的值）");

    const rerun = await runMigrateScript(dbPath);
    checkEqual(rerun.code, 0, "重跑退出码 0（幂等）");
    check(rerun.output.includes("需要迁移：0"), "重跑没有待迁移的行", rerun.output);

    //#endregion

    group("汇总");
    console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
    if (failed > 0) {
      console.log("\n❌ 存档版本 e2e：以下断言不通过");
      failures.forEach((label) => console.log(`  - ${label}`));
      console.log("\n服务端日志尾部：");
      console.log(server.logs().split("\n").slice(-30).join("\n"));
      process.exitCode = 1;
    }
  } catch (error) {
    console.error("\n❌ 存档版本 e2e 崩溃：", error);
    if (server) console.error(server.logs().split("\n").slice(-30).join("\n"));
    process.exitCode = 1;
  } finally {
    if (server) server.child.kill("SIGTERM");
    // WAL 的兄弟文件一起收掉，免得 /tmp 里攒一堆
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
})();
