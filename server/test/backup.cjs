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
 * 后面三段是自动备份（#22）加的，验三件事：
 *
 * 4. **定时是真的**：服务进程自己会产出备份，全程不敲备份命令；
 * 5. **跑没跑成看得见**：结果写进日志也露在系统信息页 —— 静默失败的备份等于没有备份；
 * 6. **淘汰留一手**：无论怎么按策略清理，目录里至少留着最新那一份。
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
const BACKUP_FILE = /^olua-\d{8}-\d{6}\.db$/;

// 到点判定 / 目录解析 / 文件名解析是纯函数，直接 require 编译产物跑边界值（不必起服务）
const backupUtil = require(path.join(SERVER_DIR, "dist", "common", "utils", "backup.util.js"));
const { BackupService } = require(path.join(SERVER_DIR, "dist", "modules", "system", "backup.service.js"));

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

/** 备份文件名字是按时间排的，同一秒里跑两次会撞名 —— 等过这一秒再跑下一次 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 目录里的备份文件（只认文件名合规的那些；目录还不存在时算「没有」） */
function backupFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => BACKUP_FILE.test(name)).sort();
}

/**
 * 跑一次备份脚本，**并且要求它成功**
 *
 * 每次之前先等过一秒：备份文件名精确到秒，同一秒里跑两次脚本会直接报错退出
 * （而失败的那次不会触发淘汰，后面所有关于「清理」的断言就都失去了对象）。
 */
async function backupOnce(dbPath, outDir, extra = [], label = "备份") {
  await sleep(1100);
  const result = runScript(BACKUP_SCRIPT, ["--db", dbPath, "--out", outDir, ...extra]);
  checkEqual(result.status, 0, `${label}成功（stderr：${result.stderr.trim()}）`);
  return result;
}

/** 造一个「多久以前」的备份文件名：淘汰看的是文件名里的戳，不是文件时间 */
function backupNameAgo(ms) {
  const date = new Date(Date.now() - ms);
  const pad = (value) => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `olua-${day}-${time}.db`;
}

/** 轮询等某件事成立（返回最新的值；超时返回最后一次的结果） */
async function waitFor(work, predicate, timeoutMs = 40_000, stepMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last = await work();
  while (Date.now() < deadline) {
    if (predicate(last)) return last;
    await sleep(stepMs);
    last = await work();
  }
  return last;
}

/**
 * 造一个 BackupService 实例（**绕过 Nest 容器**）
 *
 * 它只用到 `get` 这一个方法，所以这里给一个窄到只有备份需要的假配置对象 ——
 * 这样「失败时状态怎么记」这种分支不必依赖起服务的运气。
 */
function fakeBackupService(overrides) {
  const values = {
    dbPath: "",
    backupIntervalHours: 1,
    backupKeepCount: 1,
    backupRetentionDays: 0,
    backupDir: "",
    ...overrides,
  };
  return new BackupService({ get: (field) => values[field] });
}

/**
 * 五、保留策略
 *
 * 三条信念在这里被钉住：
 * - 份数与天数是**两道独立的闸**（只按某一维配，另一维不该偷偷生效）；
 * - **清理只发生在推出新备份之后**，所以目录永远不会被清空；
 * - 淘汰看文件名里的戳而不是文件时间（拷贝会改掉 mtime，scp 之后老文件会假装是新文件）。
 */
async function runRetentionSuite(dbPath, workDir) {
  group("五、保留策略：份数与天数两道闸，且绝不会把目录清空");

  const policyDir = path.join(workDir, "policy");
  fs.mkdirSync(policyDir, { recursive: true });

  // —— 份数闸 ——
  await backupOnce(dbPath, policyDir, ["--keep", "1"], "第一次备份（keep=1）");
  await backupOnce(dbPath, policyDir, ["--keep", "1"], "第二次备份（keep=1）");
  const keepOne = backupFiles(policyDir);
  checkEqual(keepOne.length, 1, "keep=1 连跑两次 → 只留最近 1 份");
  checkEqual(latestBackup(policyDir), path.join(policyDir, keepOne[0]), "留下的是最新的那份");

  // —— 天数闸（份数不限）——
  // 只有天数：放一份 5 天前的老备份进去，keep=0 时它不该因为「份数」被保住
  const oldName = backupNameAgo(5 * 24 * 60 * 60 * 1000);
  fs.writeFileSync(path.join(policyDir, oldName), "（占位：淘汰只看文件名里的戳）");
  await backupOnce(dbPath, policyDir, ["--keep", "0", "--days", "1"], "第三次备份（只按天数淘汰）");
  const afterDays = backupFiles(policyDir);
  check(!afterDays.includes(oldName), "days=1 时 5 天前的老备份被清掉");
  checkEqual(afterDays.length, 2, "本次产出与刚才留下的那份都还在（两道闸各管各的）");

  // —— 「唯一的备份」不会被删掉 ——
  // 目录里只有一份 10 天前的老备份，days=1 + keep=1；清理之后至少还得有一份
  const lonelyDir = path.join(workDir, "lonely");
  fs.mkdirSync(lonelyDir, { recursive: true });
  const lonely = backupNameAgo(10 * 24 * 60 * 60 * 1000);
  fs.writeFileSync(path.join(lonelyDir, lonely), "（占位）");
  await backupOnce(dbPath, lonelyDir, ["--keep", "1", "--days", "1"], "唯一的备份到期时照样备份");
  const files = backupFiles(lonelyDir);
  checkEqual(files.length, 1, "清理之后目录里还剩 1 份（没被清空）");
  check(files[0] !== lonely, "留下的是本次新产出的那份，不是那个早该过期却唯一的旧备份");

  // —— 两道闸都关 ——
  const keepAllDir = path.join(workDir, "keep-all");
  fs.mkdirSync(keepAllDir, { recursive: true });
  runScript(BACKUP_SCRIPT, ["--db", dbPath, "--out", keepAllDir, "--keep", "0", "--days", "0"]);
  await sleep(1100);
  runScript(BACKUP_SCRIPT, ["--db", dbPath, "--out", keepAllDir, "--keep", "0", "--days", "0"]);
  checkEqual(backupFiles(keepAllDir).length, 2, "keep=0 / days=0 → 两份都留着（0 = 不管这一维）");

  // —— 参数校验：错误的配置必须报错，而不是静默当成某个默认值 ——
  for (const bad of [["--keep", "-1"], ["--days", "-1"], ["--keep", "abc"]]) {
    const rejected = runScript(BACKUP_SCRIPT, ["--db", dbPath, "--out", keepAllDir, bad[0], bad[1]]);
    check(rejected.status !== 0, `${bad[0]} ${bad[1]} 被拒绝（退出码非 0）`);
  }
}

/**
 * 六、自动备份（真实进程）
 *
 * 这一组回答「不敲命令会不会备份」：全程只起服务、查系统信息页，一次备份脚本都不手动跑。
 * 间隔配成 0.003 小时（约 10.8 秒）是为了在可接受的时间里看到**第二次**产出 ——
 * 只看到一次只能证明「启动时会备一次」，证明不了「会定期备」。
 */
async function runAutoBackupSuite() {
  group("六、自动备份：不敲命令也会产出，结果在系统信息页");

  // 关着的一台与开着的一台各用各的库：避免「第二个服务注册超管时第一个已经占用了同一个库」的冲突
  await runClosedAutoBackup();

  const autoDir = fs.mkdtempSync(path.join(os.tmpdir(), "olua-auto-backup-"));
  const dbPath = path.join(autoDir, "olua.db");
  const expectedDir = path.join(autoDir, "backups");

  const server = await startServer({
    DB_PATH: dbPath,
    JWT_SECRET: "backup-e2e-secret",
    ADMIN_REGISTER_CODE: ADMIN_CODE,
    BACKUP_INTERVAL_HOURS: "0.003",
    BACKUP_KEEP_COUNT: "2",
  });
  try {
    await registerAdmin(server.baseUrl);
    const token = await loginAdmin(server.baseUrl);

    // 第一次：服务启动后该自己备一份
    const first = await waitFor(
      () => systemBackup(server.baseUrl, token),
      (state) => state.lastAttemptAt !== null,
    );
    check(first.lastAttemptAt !== null, "服务自己跑了一次备份（全程没敲备份命令）");
    checkEqual(first.enabled, true, "自动备份是开着的状态");
    checkEqual(first.dir, expectedDir, "备份目录跟着数据文件走（容器里才会落在同一个持久卷上）");
    checkEqual(first.lastOk, true, "第一次备份成功");
    check(BACKUP_FILE.test(first.lastFile ?? ""), `产出文件名合规（${first.lastFile}）`);
    check(first.lastSizeBytes > 0, "记下了产出文件的体积");
    check(first.lastDurationMs >= 0, "记下了耗时（备份越来越慢是数据量在涨的信号）");
    checkEqual(first.intervalMs, 10_800, "间隔按小时换算成毫秒（0.003 小时 = 10.8 秒）");
    check(first.intervalText.includes("每"), `间隔给人话版本（${first.intervalText}）`);
    checkEqual(first.keepCount, 2, "保留份数按配置报出来");
    checkEqual(first.count, 1, "目录里有 1 份备份");
    checkEqual(backupFiles(expectedDir).length, 1, "磁盘上的份数与信息页说的一致");
    check(Math.abs(first.nextAt - first.lastAttemptAt - 10_800) < 5_000, "下一次的时刻 = 这一次 + 间隔");
    checkEqual(first.lastError, null, "成功时不留错误信息");

    // 第二次：证明是**周期性的**，而不是只在启动时备一次
    const secondFile = first.lastFile;
    const second = await waitFor(
      () => systemBackup(server.baseUrl, token),
      (state) => state.lastFile !== secondFile,
      30_000,
    );
    check(second.lastFile !== secondFile, "间隔到了之后又自己备了一次（周期性）");
    checkEqual(second.count, 2, "两次产出都在（还没触发份数上限）");
    check(second.lastAttemptAt > first.lastAttemptAt, "最后一次尝试的时刻在往后走");
    checkEqual(second.lastSuccessAt, second.lastAttemptAt, "成功时「尝试」与「成功」是同一时刻");
  } finally {
    await stopServer(server.child);
  }

  fs.rmSync(autoDir, { recursive: true, force: true });
}

/** 开关关着时不该有任何动作（自己开一个独立的库验，免得跟上面的等待互相干扰） */
async function runClosedAutoBackup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "olua-auto-backup-closed-"));
  const closedDb = path.join(dir, "olua.db");
  const closed = await startServer({
    DB_PATH: closedDb,
    JWT_SECRET: "backup-e2e-secret-closed",
    ADMIN_REGISTER_CODE: ADMIN_CODE,
    BACKUP_INTERVAL_HOURS: "0",
  });
  try {
    await registerAdmin(closed.baseUrl);
    const token = await loginAdmin(closed.baseUrl);
    const state = await systemBackup(closed.baseUrl, token);
    checkEqual(state.enabled, false, "BACKUP_INTERVAL_HOURS=0 → 自动备份关闭");
    check(state.reason.includes("BACKUP_INTERVAL_HOURS=0"), "关着时如实说明是开关没开（而不是报「内存库」）");
    await sleep(1500);
    checkEqual(backupFiles(path.join(dir, "backups")).length, 0, "关着的时候一份备份都不产出");
  } finally {
    await stopServer(closed.child);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

/** 注册超管（系统信息页要 system:read，只有超管有），顺便断言注册成功 */
async function registerAdmin(baseUrl) {
  const registered = await api(baseUrl, "POST", "/api/admin/auth/register", {
    body: { username: "backup_super", password: "backup-mpvk-1", registerCode: ADMIN_CODE },
  });
  checkEqual(registered.body.code, 0, "准备：注册超管（读系统信息页要 system:read）");
  return registered.body.code;
}

async function loginAdmin(baseUrl) {
  const login = await api(baseUrl, "POST", "/api/admin/auth/login", {
    body: { username: "backup_super", password: "backup-mpvk-1" },
  });
  return login.body.data?.token ?? "";
}

/** 读系统信息页里的自动备份一段 */
async function systemBackup(baseUrl, token) {
  const read = await api(baseUrl, "GET", "/api/admin/system", { token });
  return read.body.data?.backup ?? {};
}

/**
 * 七、失败必须看得见
 *
 * 静默失败的备份等于没有备份 —— 所以要有这样一组：库文件压根不存在时，
 * 留在状态里的应该是**原因**，而不是「上一次成功还是上周」这种让人安心的错觉。
 */
async function runFailureVisibilitySuite(workDir) {
  group("七、失败看得见：库不存在时报的是原因，不是沉默");
  const service = fakeBackupService({ dbPath: path.join(workDir, "no-such-dir", "missing.db") });
  const ok = await service.runOnce();
  checkEqual(ok, false, "库不存在时备份失败（不假装成功）");
  const snapshot = service.snapshot();
  checkEqual(snapshot.lastOk, false, "最后一次结果记为失败（不是 null 也不是 true）");
  check(typeof snapshot.lastError === "string" && snapshot.lastError.length > 0, "失败原因留在状态里");
  check(snapshot.lastError.includes("不存在"), "原因说的是人能看懂的话（数据文件不存在）");
  check(snapshot.lastAttemptAt !== null, "尝试过（时间点留在账上，好知道多久没成了）");
  checkEqual(snapshot.lastSuccessAt, null, "从没成功过就不能报「成功过」");
}

/**
 * 八、到点判定与目录解析（纯函数）
 *
 * 这里测的是边界而不是流程：还没跑过算不算到点、正好差一毫秒算不算到点、
 * 开关关着会不会永不到点、间隔配得离谱会不会变成忙循环 —— 这些都不必起服务，
 * 也不必真去等一个间隔。
 */
function runScheduleSuite() {
  group("八、到点判定与目录解析：纯函数的边界值");
  const { isBackupDue, backupCheckMs, backupIntervalMs, resolveBackupDir, parseBackupStamp, BACKUP_CHECK_MAX_MS, BACKUP_CHECK_MIN_MS, HOUR_MS } = backupUtil;

  checkEqual(backupIntervalMs(24), 24 * HOUR_MS, "24 小时换算成毫秒");
  checkEqual(backupIntervalMs(0), 0, "0 小时 = 关闭（不是「立即备份」）");
  checkEqual(backupIntervalMs(-1), 0, "负数按关闭处理");

  checkEqual(isBackupDue(null, 1_000, 24), true, "从没跑过 → 到点（新部署不该空等一个周期）");
  checkEqual(isBackupDue(0, 24 * HOUR_MS - 1, 24), false, "差 1 毫秒不算到点");
  checkEqual(isBackupDue(0, 24 * HOUR_MS, 24), true, "正好一个间隔 → 到点");
  checkEqual(isBackupDue(1_000, 500, 24), false, "时钟回拨（上次比现在还晚）不算到点");
  checkEqual(isBackupDue(0, 1_000, 0), false, "开关关着 → 永不到点");

  checkEqual(backupCheckMs(0), 0, "关着就不要起定时器");
  checkEqual(backupCheckMs(24), BACKUP_CHECK_MAX_MS, "间隔再长也最迟一分钟瞄一眼");
  checkEqual(backupCheckMs(0.0001), BACKUP_CHECK_MIN_MS, "间隔配得离谱时被下限夹住（防忙循环）");
  checkEqual(backupCheckMs(0.005), 18_000, "短于上限就按自身周期");

  checkEqual(resolveBackupDir(":memory:", "", "/srv"), null, "内存库没有备份目录");
  checkEqual(resolveBackupDir("/data/olua.db", "", "/srv"), "/data/backups", "默认跟着数据文件走（容器里才会落在同一个持久卷）");
  checkEqual(resolveBackupDir("/data/olua.db", "bk", "/srv"), "/srv/bk", "显式配的相对目录按基准解析");
  checkEqual(resolveBackupDir("/data/olua.db", "/abs/bk", "/srv"), "/abs/bk", "绝对路径原样用");

  checkEqual(parseBackupStamp("olua-20261009-153000.db"), new Date(2026, 9, 9, 15, 30, 0).getTime(), "文件名解析出时间戳");
  checkEqual(parseBackupStamp("olua-20261009-153000.db.bak"), null, "带尾巴的文件名不算备份");
  checkEqual(parseBackupStamp("accounts.db"), null, "别的文件不会被当成备份");
}

async function main() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "olua-backup-"));
  const dbPath = path.join(workDir, "olua.db");
  const backupDir = path.join(workDir, "backups");

  group("一、准备：文件库 + 真实数据");
  // 这台只负责灌测试数据，**关掉自动备份**（interval=0）：否则它一启动就会往同一份
  // backups/ 里写文件，与下面「运行中手工备份」抢同一个秒级文件名 → 偶发「同名备份已存在」。
  // 自动备份行为由第六组单独验，这里不该有。
  const server = await startServer({
    DB_PATH: dbPath,
    JWT_SECRET: "backup-e2e-secret",
    ADMIN_REGISTER_CODE: ADMIN_CODE,
    BACKUP_INTERVAL_HOURS: "0",
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

  await runRetentionSuite(dbPath, workDir);
  await runAutoBackupSuite();
  await runFailureVisibilitySuite(workDir);
  runScheduleSuite();

  fs.rmSync(workDir, { recursive: true, force: true });

  console.log(`\n${failed === 0 ? "✅" : "❌"} 备份 / 恢复：${passed} 条通过 / ${failed} 条失败`);
  if (failed) {
    console.log("失败项：\n" + failures.map((item) => `  - ${item}`).join("\n"));
    process.exitCode = 1;
  }
}

void main();
