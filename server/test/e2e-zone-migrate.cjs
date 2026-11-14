#!/usr/bin/env node
/**
 * 区字段迁移 e2e（server/test/e2e-zone-migrate.cjs，issue #957 / docs/39 §四 M1 + M8）
 *
 * 盯的不变量 —— 升级一台**已经有数据的旧库**时，这三件事必须一次做对：
 *
 * 一、`accounts.zone_id` → `active_zone_id` **就地改名**（值不丢，不是「加新列丢旧列」）
 * 二、`roles.zone_id` 加列并按「账号当时所在的区」回填（不是一律 1）
 * 三、唯一索引换成 `(account_id, zone_id, name)`，旧的两列索引必须不在了
 *
 * 为什么单独一条：新库的路径每个 e2e 都在跑，**旧库路径只有一次机会** —— 迁移写错
 * （比如回填语句还在用改名前的列名）本地全绿，一上线就是启动失败。
 * 最后再起一次服务：同一步迁移跑两遍结果必须一致（幂等）。
 */
const { spawn } = require("child_process");
const net = require("net");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

const failures = [];
let passed = 0;
let failed = 0;

function check(ok, label, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  [OK] ${label}${detail ? " —— " + detail : ""}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  [!!] ${label}${detail ? " —— " + detail : ""}`);
  }
}

function checkEqual(actual, expected, label) {
  return check(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}

function group(label) {
  console.log(`\n▶ ${label}`);
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
      JWT_SECRET: "e2e-zone-migrate-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      WORLD_MAP_IDLE_MS: "0",
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
  child.kill();
  throw new Error(`等待服务启动超时\n${chunks.join("")}`);
}

/** 造一个「#957 之前」的库：accounts 有 zone_id、roles 没有 zone_id，且已经有数据 */
function seedLegacyDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE accounts (
      id             TEXT PRIMARY KEY,
      username       TEXT NOT NULL UNIQUE,
      password       TEXT NOT NULL,
      email          TEXT,
      status         TEXT NOT NULL DEFAULT 'active',
      online_role_id TEXT,
      online_heartbeat_at INTEGER,
      token_version  INTEGER NOT NULL DEFAULT 0,
      ban_reason     TEXT,
      ban_until      INTEGER,
      banned_by      TEXT,
      banned_at      INTEGER,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      last_login_at  INTEGER,
      zone_id        INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE roles (
      id         TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      occupation TEXT NOT NULL DEFAULT '',
      sex        TEXT NOT NULL DEFAULT '',
      level      INTEGER NOT NULL DEFAULT 1,
      kills      INTEGER NOT NULL DEFAULT 0,
      data       TEXT NOT NULL,
      revision   INTEGER NOT NULL DEFAULT 1,
      corrupted  INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const now = Date.now();
  const insertAccount = db.prepare(
    "INSERT INTO accounts (id, username, password, created_at, updated_at, last_login_at, zone_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  // 两个账号分别停在 1 区 / 2 区：回填必须各按各的区，不能一律写 1
  insertAccount.run("acc-1", "legacy_one", "x", now, now, now, 1);
  insertAccount.run("acc-2", "legacy_two", "x", now, now, now, 2);
  const insertRole = db.prepare(
    "INSERT INTO roles (id, account_id, name, occupation, sex, level, kills, data, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insertRole.run("role-1", "acc-1", "老号甲", "1", "1", 1, 0, "{}", 1, now, now);
  insertRole.run("role-2", "acc-2", "老号乙", "1", "1", 1, 0, "{}", 1, now, now);
  insertRole.run("role-3", "acc-2", "老号丙", "2", "2", 1, 0, "{}", 1, now, now);
  db.close();
}

function readMigrationState(dbPath) {
  const db = new DatabaseSync(dbPath);
  const accountColumns = db.prepare("PRAGMA table_info(accounts)").all().map((row) => row.name);
  const roleColumns = db.prepare("PRAGMA table_info(roles)").all().map((row) => row.name);
  const roles = db.prepare("SELECT id, zone_id FROM roles ORDER BY id ASC").all();
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'roles'").all();
  db.close();
  return { accountColumns, roleColumns, roles, indexes: indexes.map((row) => row.name) };
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-zone-migrate-${Date.now()}.db`);
  seedLegacyDb(dbPath);

  group("一、首次启动：改名 + 加列 + 回填");
  let server = await startServer(dbPath);
  try {
    const state = readMigrationState(dbPath);
    check(state.accountColumns.includes("active_zone_id"), "accounts 有 active_zone_id", JSON.stringify(state.accountColumns));
    check(!state.accountColumns.includes("zone_id"), "accounts 已经没有旧的 zone_id 列（是改名，不是加一列）");
    check(state.roleColumns.includes("zone_id"), "roles 已加上 zone_id 列");
    const byId = new Map(state.roles.map((row) => [row.id, row.zone_id]));
    checkEqual(byId.get("role-1"), 1, "一区账号的角色回填成 1");
    checkEqual(byId.get("role-2"), 2, "二区账号的角色回填成 2（不是一律写 1）");
    checkEqual(byId.get("role-3"), 2, "同一个二区账号的第二个角色也是 2");
    check(state.indexes.includes("idx_roles_account_zone_name"), "三列唯一索引已建立", JSON.stringify(state.indexes));
    check(!state.indexes.includes("idx_roles_account_name"), "旧的两列唯一索引已删掉（否则同账号跨区同名建不了）");
  } finally {
    server.child.kill();
    await sleep(300);
  }

  group("二、再启一次：同一步迁移幂等");
  server = await startServer(dbPath);
  try {
    const state = readMigrationState(dbPath);
    const byId = new Map(state.roles.map((row) => [row.id, row.zone_id]));
    checkEqual(state.roles.length, 3, "角色行没有被多迁/丢行");
    checkEqual(byId.get("role-1"), 1, "第二次启动后 role-1 仍是 1");
    checkEqual(byId.get("role-2"), 2, "第二次启动后 role-2 仍是 2（回填不会拿当前浏览区覆盖归属）");
    check(state.indexes.includes("idx_roles_account_zone_name"), "索引仍在（CREATE ... IF NOT EXISTS 幂等）");
  } finally {
    server.child.kill();
  }

  if (failed > 0) {
    console.log(`\n❌ 区字段迁移 e2e：${failed} 条失败`);
    for (const item of failures) console.log(`   - ${item}`);
    process.exitCode = 1;
  } else {
    console.log(`\n✅ 区字段迁移 e2e 全绿（${passed} 条断言）`);
  }
})();
