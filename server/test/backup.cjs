#!/usr/bin/env node
/**
 * 备份 / 恢复 e2e
 *
 * **为什么要起真服务**：备份的价值全在「服务正在写的时候也能拿到一致快照」——
 * 离线拷文件谁都会，那件事不值得测。所以这里验三件真事：
 *
 * 1. **运行中备份**：不占锁、不关服，拿到的备份里能查到刚写入的数据
 *    （库是 WAL 模式，直接 `cp` 主文件会丢掉还在 `-wal` 里的那批提交）；
 * 2. **恢复 + 留档**：恢复后数据回来，且被换下来的库留在 `.before-restore-*` 里；
 * 3. **保护性拒绝**：坏文件不换库；数据文件旁边有 `-wal`（= 服务可能还在跑）时默认不动手。
 *
 * 用法：npm run test:e2e:backup（前置 npm run build）
 */
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const BACKUP_SCRIPT = path.join(SERVER_DIR, "scripts", "backup.cjs");
const RESTORE_SCRIPT = path.join(SERVER_DIR, "scripts", "restore.cjs");
const ADMIN_CODE = "backup-admin-code";

//#region 断言小工具

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

/** 子进程环境：清掉受限终端注入的 NODE_OPTIONS（那个垫片会让 node 子进程静默起不来） */
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_OPTIONS;
  return env;
}

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

async function startServer(env) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ENTRY], {
    cwd: SERVER_DIR,
    env: cleanEnv({ ...env, NODE_ENV: "test", PORT: String(port), API_PREFIX: "api", LOG_REQUESTS: "false" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(String(chunk)));
  child.stdout.on("data", () => {});

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务进程提前退出（code=${child.exitCode}）\n${errors.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return { baseUrl, child };
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("等待服务启动超时");
}

async function stopServer(child) {
  child.kill("SIGTERM");
  const deadline = Date.now() + 10_000;
  while (child.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

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

/** 跑一个脚本，返回 { status, stdout, stderr } */
function runScript(script, args) {
  const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", script, ...args], {
    cwd: SERVER_DIR,
    env: cleanEnv(),
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * 直接开库查一个数（校验备份/恢复后的内容）
 *
 * 用**读写**方式打开：只读连接会留下它自己建的空 `-wal` / `-shm` 却无力清理
 * （见 scripts/lib/db-tooling 里 `inspect` 的注释），而下面第四段正是拿这对文件
 * 当「服务是不是还在跑」的信号 —— 被自己污染就测不出真东西了。
 */
function countIn(dbPath, sql, params = []) {
  const db = new DatabaseSync(dbPath);
  try {
    return Number(Object.values(db.prepare(sql).get(...params))[0] ?? 0);
  } finally {
    db.close();
  }
}

/** 服务刚被 kill，进程退出与句柄释放有一小段延迟 —— 重试几次再动手 */
async function withFileLockRetry(work) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      return work();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error("拿不到数据文件的写锁（服务没退干净？）");
}

/** 备份目录里最新的那份 */
function latestBackup(dir) {
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".db"))
    .sort();
  return files.length ? path.join(dir, files[files.length - 1]) : null;
}

async function main() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "olua-backup-"));
  const dbPath = path.join(workDir, "olua.db");
  const backupDir = path.join(workDir, "backups");

  group("一、准备：文件库 + 真实数据");
  const server = await startServer({
    DB_PATH: dbPath,
    JWT_SECRET: "backup-e2e-secret",
    ADMIN_REGISTER_CODE: ADMIN_CODE,
  });
  let backupFile = null;
  try {
    for (const name of ["backup_player_a", "backup_player_b"]) {
      const registered = await api(server.baseUrl, "POST", "/api/auth/register", {
        body: { username: name, password: "backup-plyr-1" },
      });
      checkEqual(registered.body.code, 0, `准备：注册玩家 ${name}`);
    }
    const admin = await api(server.baseUrl, "POST", "/api/admin/auth/register", {
      body: { username: "backup_super", password: "backup-mpvk-1", registerCode: ADMIN_CODE },
    });
    checkEqual(admin.body.code, 0, "准备：注册超管");

    // —— 一、服务运行中备份 ——
    group("二、运行中备份：不动服务、拿到的是一致快照");
    const running = runScript(BACKUP_SCRIPT, ["--db", dbPath, "--out", backupDir]);
    checkEqual(running.status, 0, `服务运行中执行备份成功（stderr：${running.stderr.trim()}）`);
    check(running.stdout.includes("数据备份完成"), "备份脚本打印了完成摘要");

    backupFile = latestBackup(backupDir);
    check(Boolean(backupFile), "备份目录里出现了备份文件");
    if (backupFile) {
      checkEqual(countIn(backupFile, "SELECT COUNT(1) AS total FROM accounts"), 2, "备份里含运行中写入的 2 个账号");
      checkEqual(countIn(backupFile, "SELECT COUNT(1) AS total FROM admins"), 1, "备份里含 1 个管理员");
      check(fs.statSync(backupFile).size > 0, "备份文件不是空文件");
    }
  } finally {
    await stopServer(server.child);
  }

  // —— 二、恢复 ——
  group("三、恢复：数据回来，且被换下来的库留了档");
  await withFileLockRetry(() => {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("DELETE FROM accounts");
      db.exec("DELETE FROM admins");
    } finally {
      db.close();
    }
  });
  checkEqual(countIn(dbPath, "SELECT COUNT(1) AS total FROM accounts"), 0, "准备：把库里的账号清空（模拟误删 / 数据损坏）");

  const restore = runScript(RESTORE_SCRIPT, [backupFile, "--db", dbPath]);
  checkEqual(restore.status, 0, `执行恢复成功（stderr：${restore.stderr.trim()}）`);
  check(restore.stdout.includes("数据恢复完成"), "恢复脚本打印了完成摘要");
  checkEqual(countIn(dbPath, "SELECT COUNT(1) AS total FROM accounts"), 2, "恢复后账号回来了");
  checkEqual(countIn(dbPath, "SELECT COUNT(1) AS total FROM admins"), 1, "恢复后管理员回来了");

  const kept = fs.readdirSync(workDir).filter((name) => name.includes(".before-restore-"));
  checkEqual(kept.length, 1, "被换下来的库留在 `.before-restore-*` 里（恢复错了能退回去）");
  check(restore.stdout.includes(".before-restore-"), "恢复摘要里打印了留档路径");
  check(!fs.existsSync(`${dbPath}.restoring`), "临时暂存文件已经改名到位，没有残留");

  // —— 三、保护性拒绝 ——
  group("四、保护性拒绝：坏文件不换库 / 服务可能在跑就不动手");

  const junk = path.join(workDir, "not-a-db.db");
  fs.writeFileSync(junk, "这不是一个 SQLite 文件");
  const badFile = runScript(RESTORE_SCRIPT, [junk, "--db", dbPath]);
  check(badFile.status !== 0, "拿一个非数据库文件恢复 → 拒绝（退出码非 0）");
  check(badFile.stderr.includes("恢复失败"), "拒绝时给出明确失败原因");
  checkEqual(countIn(dbPath, "SELECT COUNT(1) AS total FROM accounts"), 2, "拒绝之后正式库被动过没？没有（数据还在）");

  // 库旁边出现 -wal = 服务可能正在跑（或上次没干净退出）
  const fakeWal = `${dbPath}-wal`;
  fs.writeFileSync(fakeWal, "");
  const noForce = runScript(RESTORE_SCRIPT, [backupFile, "--db", dbPath]);
  check(noForce.status !== 0, "数据文件旁边有 -wal 时默认拒绝恢复");
  check(noForce.stderr.includes("--force"), "拒绝时告诉运维怎么继续（--force）");
  const forced = runScript(RESTORE_SCRIPT, [backupFile, "--db", dbPath, "--force"]);
  checkEqual(forced.status, 0, "确认服务已停时 --force 可以继续");
  check(!fs.existsSync(fakeWal), "旧库的 -wal 被清掉了（留着会按它回放，直接损坏新库）");
  checkEqual(countIn(dbPath, "SELECT COUNT(1) AS total FROM accounts"), 2, "--force 恢复后数据同样是好的");

  fs.rmSync(workDir, { recursive: true, force: true });

  console.log(`\n${failed === 0 ? "✅" : "❌"} 备份 / 恢复：${passed} 条通过 / ${failed} 条失败`);
  if (failed) {
    console.log("失败项：\n" + failures.map((item) => `  - ${item}`).join("\n"));
    process.exitCode = 1;
  }
}

void main();
