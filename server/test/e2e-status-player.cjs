#!/usr/bin/env node
/**
 * 服务端 e2e：角色状态层（#822 / docs/22 A4 / docs/37 B5）
 *
 * 这一套盯的是「状态型技能不再当伤害结算，且状态真的改结算」：
 *
 * - **不再核弹**：`1010 护体神盾`（`category = "2"`）以前按 `damageCoefficients` 打出 300%，
 *   现在只施加状态 —— 目标血量一点不少、回执带 `statusOnly` 与整份 `statuses`；
 * - **落库**：`role_status` 多一行，`expire_at` ≈ 现在 + `statuses.duration`；
 * - **刷新**：重复施放不新增行（主键 (role_id, status_id)），只把到期往后推；
 * - **到期**：把 `expire_at` 改到过去，下一次回执的 `statuses` 里就没有它了（惰性清理）；
 * - **死亡清空**：被打到 hp = 0 之后 `role_status` 一行不剩（复活不带旧 buff）；
 * - **格挡真的生效**：把 2001 的 `blockChance` 通过管理端改成 1（100% 格挡），
 *   之后每一次怪物命中的 `hits` 帧都带 `blocked: true` —— 这是「状态数值进了受击结算」
 *   的直接证据，且不依赖随机数（概率 1 就是必中）。
 *
 * 为什么用管理端改 `combat` 而不是直接 UPDATE：`blockChance` 走的是运行时配置缓存
 * （`runtime-config-cache`），管理端写操作末尾会 `refreshAll()`；直接改库要等实时进程
 * 10 秒一次的定期重装，e2e 会变成靠等待时间赌。
 *
 * 用临时文件库，跑 `dist/`，前置 `npm run build`。用法：npm run test:e2e:status-player
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");
const ADMIN_CODE = "status-admin";
/** 图 3 的怪血厚（2394），连打带站都不会把它打死，靶子始终有效 */
const TEST_MAP = "3";

//#region 断言小工具

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

const checkEqual = (actual, expected, label) => check(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
function group(label) {
  console.log(`\n▶ ${label}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (label, predicate, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(50);
  }
  check(false, `${label}（等待超时）`);
  return last;
};

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

/** 直接读 / 改库：状态行与血量落账值（服务端不缓存，改完下一拍就能看到） */
function withDb(dbPath, run) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

const statusRows = (dbPath, roleId) =>
  withDb(dbPath, (db) => db.prepare("SELECT * FROM role_status WHERE role_id = ?").all(roleId));

const setExpireAt = (dbPath, roleId, statusId, at) =>
  withDb(dbPath, (db) => db.prepare("UPDATE role_status SET expire_at = ? WHERE role_id = ? AND status_id = ?").run(at, roleId, statusId));

const setRoleHp = (dbPath, roleId, hp) =>
  withDb(dbPath, (db) => db.prepare("UPDATE roles SET data = json_set(data, '$.hp', ?) WHERE id = ?").run(hp, roleId));

/** 同时把蓝拉满：连续放 1011（15 蓝一发）会撞耗蓝闸，而这一套测的不是蓝 */
const setRoleMp = (dbPath, roleId, mp) =>
  withDb(dbPath, (db) => db.prepare("UPDATE roles SET data = json_set(data, '$.mp', ?) WHERE id = ?").run(mp, roleId));

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
      JWT_SECRET: "e2e-status-player-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      ADMIN_REGISTER_CODE: ADMIN_CODE,
      // 怪物 AI 跑快一点：这一套要等「怪打人」的命中帧
      MONSTER_AI_TICK_MS: "200",
      MONSTER_AI_BROADCAST_MS: "100",
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

async function api(baseUrl, method, route, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}/api/${route}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** 一条会话化的 WS 连接（settle / world / monster-ai 三个帧都要收） */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    settles: [],
    worlds: [],
    aiFrames: [],
    seq: 0,
    fire(body) {
      session.seq += 1;
      const castId = session.seq;
      socket.send(JSON.stringify({ type: "cast", data: { castId, ...body } }));
      return castId;
    },
    async settleOf(castId) {
      return waitFor(`castId=${castId} 的 settle`, async () => session.settles.find((frame) => frame.castId === castId) || null);
    },
    /** 施放一次并等结果 */
    async cast(skillId, targetId = "", monsterKey = "") {
      const castId = session.fire({ skillId, targetId, monsterKey });
      return session.settleOf(castId);
    },
    async joinWorld(mapId, timeoutMs = 5_000) {
      const before = session.worlds.length;
      socket.send(JSON.stringify({ type: "worldJoin", data: { mapId } }));
      return waitFor(
        `mapId=${mapId} 的 world 帧`,
        async () => {
          const frames = session.worlds.slice(before).filter((frame) => frame.mapId === mapId);
          return frames.length > 0 ? frames[frames.length - 1] : null;
        },
        timeoutMs,
      );
    },
    sendPos(mapId, x, y, hp) {
      socket.send(JSON.stringify({ type: "pos", data: { mapId, x, y, hp, moving: false } }));
    },
    hitsFrom(fromIndex = 0) {
      const out = [];
      for (let i = fromIndex; i < session.aiFrames.length; i += 1) out.push(...(session.aiFrames[i].hits || []));
      return out;
    },
  };
  socket.on("open", () => {
    session.opened = true;
  });
  socket.on("message", (raw) => {
    try {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "settle") session.settles.push(frame.data);
      if (frame.type === "world") session.worlds.push(frame.data);
      if (frame.type === "monster-ai") session.aiFrames.push(frame.data);
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  return session;
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-status-player-${Date.now()}.db`);
  const server = await startServer(dbPath);
  const { baseUrl } = server;
  try {
    //#region 准备
    group("准备：玩家、角色、实时连接、图 3 的靶子");

    const reg = await api(baseUrl, "POST", "auth/register", { body: { username: "status_player", password: "pass1234" } });
    const token = reg.data && reg.data.token;
    const created = await api(baseUrl, "POST", "roles", { token, body: { name: "状态测试", occupation: "1", sex: "1" } });
    const roleId = created.data && created.data.id;
    check(!!(token && roleId), "账号与角色已建好", String(roleId));

    const adminReg = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "status_admin", password: "super-pass-1", registerCode: ADMIN_CODE },
    });
    const adminToken = adminReg.data && adminReg.data.token;
    checkEqual(adminReg.data && adminReg.data.admin.role, "super_admin", "准备：超级管理员已注册");

    const ticket = await api(baseUrl, "POST", "realtime/ticket", { token });
    const a = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`);
    await waitFor("实时连接握手", async () => (a.opened ? true : null));

    const snap = await a.joinWorld(TEST_MAP);
    const alives = ((snap && snap.monsters) || []).filter((mob) => mob.alive);
    // 血最多的那只：这一套要站在它旁边挨打，脆皮怪会被自己打死的可能性也要避开
    const mob = alives.slice().sort((left, right) => right.maxHp - left.maxHp)[0];
    check(!!mob, `准备：图 ${TEST_MAP} 播出了靶子`, mob && `${mob.instanceId}/${mob.maxHp}血`);
    //#endregion

    //#region 一、状态技能不再结算伤害
    group("一、状态型技能不掷伤害：护体神盾不再是 300% 核弹");

    // 先把 2001 的格挡改成 100%（后面第五段要确定性验证「状态数值进了受击结算」）：
    // 概率 1 就是必中，不靠掷骰碰运气。
    // duration 同时拉到 60 秒（#905）：出厂 10 秒在 CI 慢时钟下会在「等格挡帧」的中途过期，
    // blocked 帧从此不再出现，这一段只能等到超时。断言读回执里的 duration，不锁 10。
    const patched = await api(baseUrl, "PATCH", "admin/statuses/2001", {
      token: adminToken,
      body: { combat: { blockChance: 1, blockFactor: 0.5 }, duration: 60 },
    });
    checkEqual(patched && patched.data && patched.data.combat && patched.data.combat.blockChance, 1, "管理端把 2001 改成 100% 格挡（写操作触发 refreshAll，即时生效）");
    const durationMs = (patched && patched.data && patched.data.duration || 0) * 1000;
    check(durationMs >= 60_000, "duration 已拉到 60 秒（等格挡帧的窗口内 buff 不会过期）", `${durationMs}ms`);

    const hpBefore = mob.hp;
    // 故意**带上目标**（老客户端就是这么发的）：服务端必须按 category 分流，
    // 而不是因为「没给目标」才不扣血 —— 后者等于把判定押在客户端身上
    const buff = await a.cast("1010", mob.instanceId, mob.monsterKey);
    check(!!(buff && buff.ok), "放 1010 成功（ok）", JSON.stringify(buff && { code: buff.code, message: buff.message }));
    checkEqual(buff && buff.statusOnly, true, "回执标记 statusOnly（客户端据此不按这帧改血条）");
    checkEqual(buff && buff.appliedStatus, "2001", "回执带 appliedStatus = 2001（护体神盾）");
    checkEqual(buff && buff.damage, 0, "这一发没有伤害（以前是 300% 核弹）");
    const snapAfterBuff = await a.joinWorld(TEST_MAP);
    const mobAfterBuff = ((snapAfterBuff && snapAfterBuff.monsters) || []).find((item) => item.instanceId === mob.instanceId);
    checkEqual(mobAfterBuff && mobAfterBuff.hp, hpBefore, "目标血量一点没少（世界状态没被状态技能碰）");
    //#endregion

    //#region 二、状态落库（role_status）
    group("二、状态落库：role_status 一行，expire_at = 现在 + duration");

    const rows = statusRows(dbPath, roleId);
    const shield = rows.find((row) => row.status_id === "2001");
    check(!!shield, "role_status 里多了一行 2001", JSON.stringify(rows));
    checkEqual(shield && shield.stacks, 1, "层数 1（本轮不做叠层）");
    checkEqual(shield && shield.source_skill, "1010", "source_skill 记了技能 id（复盘用）");
    // duration 从管理端回执读（#905：不锁出厂的 10 秒），允许 1 秒误差
    const remainMs = shield ? shield.expire_at - Date.now() : 0;
    check(remainMs > durationMs - 1_000 && remainMs <= durationMs + 500, "expire_at 约等于「现在 + duration」", `${remainMs}ms / duration=${durationMs}ms`);
    check(!!(buff && buff.statuses && buff.statuses.some((entry) => entry.id === "2001")), "回执的 statuses 里有 2001（客户端图标的权威来源）", JSON.stringify(buff && buff.statuses));
    //#endregion

    //#region 三、重复施放＝刷新，不新增行（2002 金刚护体，冷却 1 秒）
    group("三、重复施放：刷新到期，不新增行（主键 (role_id, status_id)）");

    // 用 1011（金刚护体，cooldown = 1s）验刷新：1010 的冷却有 60 秒，一套用例里放不了第二次
    const guard1 = await a.cast("1011");
    check(!!(guard1 && guard1.ok && guard1.appliedStatus === "2002"), "放 1011 挂上金刚护体（2002）", JSON.stringify(guard1 && guard1.appliedStatus));
    const firstExpire = (statusRows(dbPath, roleId).find((row) => row.status_id === "2002") || {}).expire_at || 0;
    await sleep(1_200);
    const guard2 = await a.cast("1011");
    check(!!(guard2 && guard2.ok), "过了冷却再放一次 1011 成功", JSON.stringify(guard2 && { code: guard2.code }));
    const rowsAgain = statusRows(dbPath, roleId).filter((row) => row.status_id === "2002");
    checkEqual(rowsAgain.length, 1, "2002 仍然只有一行（覆盖而不是新增）");
    check(rowsAgain[0] && rowsAgain[0].expire_at > firstExpire, "到期时刻被往后推了（刷新）", `${firstExpire} → ${rowsAgain[0] && rowsAgain[0].expire_at}`);
    //#endregion

    //#region 四、格挡真的生效（受击结算读状态）
    group("四、格挡：2001 是 100% 格挡，所以每一次命中都带 blocked");

    // 先打一下这只怪（被动怪要靠挨打才记恨），再站到它身上持续上报位置：近了就开打
    await a.cast("1000", mob.instanceId, mob.monsterKey);
    const hpMax = 100;
    setRoleHp(dbPath, roleId, hpMax);
    const fromIndex = a.aiFrames.length;
    let keepReporting = true;
    const reporter = (async () => {
      while (keepReporting) {
        a.sendPos(TEST_MAP, mob.x, mob.y, hpMax);
        // 格挡不是免伤：blocked 帧的伤害是原伤害 × blockFactor（实测 ~67/刀，100 血两刀就死），
        // 怪物最快 10 刀/秒 —— 补血必须每轮做，隔 2 秒补一次都来得及死两回（#905：CI 慢时钟下曾被打死）
        setRoleHp(dbPath, roleId, hpMax);
        await sleep(100);
      }
    })();
    const blockedHit = await waitFor(
      "怪物命中帧（带 blocked）",
      async () => a.hitsFrom(fromIndex).find((hit) => hit.blocked === true) ?? null,
      25_000,
    );
    keepReporting = false;
    await reporter;
    check(!!blockedHit, "100% 格挡时命中被格挡（hits 帧带 blocked: true）", blockedHit && `damage=${blockedHit.damage}`);
    check(!!blockedHit && blockedHit.damage >= 0, "格挡后的伤害是非负整数（乘 blockFactor 后四舍五入）", blockedHit && `damage=${blockedHit.damage}`);
    //#endregion

    //#region 五、到期即消失（惰性清理）
    group("五、到期：下一次回执的 statuses 里没有它");

    // 把到期时刻改到过去：下一次结算（这里用一发普通攻击，它自己不会再施加状态）
    // 读取前会先删过期行，快照里就不该再有 2001；另一条 2002 还得留着（别把别人一起删了）
    setExpireAt(dbPath, roleId, "2001", Date.now() - 1_000);
    const afterExpiry = await a.cast("1000", mob.instanceId, mob.monsterKey);
    check(!!(afterExpiry && afterExpiry.ok), "到期后打出一次普通攻击（伤害型结算也带状态快照）");
    const listed = (afterExpiry && afterExpiry.statuses) || [];
    check(!listed.some((entry) => entry.id === "2001"), "过期的 2001 没有出现在快照里（读取前先删过期行）", JSON.stringify(listed));
    check(listed.some((entry) => entry.id === "2002"), "同一时刻仍生效的 2002 还在快照里（没有误删）", JSON.stringify(listed));
    checkEqual(statusRows(dbPath, roleId).filter((row) => row.status_id === "2001").length, 0, "库里的过期行也被删掉了");
    //#endregion

    //#region 六、死亡清空状态
    group("六、死亡：hp 归零时状态全清（复活不带旧 buff）");

    // 2002 是 8 秒的 buff，到期前把它刷新一次，保证「死前身上确实有状态」；
    // 蓝先补满（1011 一发 15 蓝，前面已经放了几发）
    setRoleMp(dbPath, roleId, 999);
    await sleep(1_200);
    const revived = await a.cast("1011");
    check(!!(revived && revived.ok), "死亡用例前重新挂一次金刚护体", JSON.stringify(revived && { code: revived.code }));
    const beforeDeath = statusRows(dbPath, roleId);
    check(beforeDeath.length >= 1, "准备：死前身上确实有状态", JSON.stringify(beforeDeath.map((row) => row.status_id)));
    // 血量压到 1，再站到怪身上：一次命中就归零
    setRoleHp(dbPath, roleId, 1);
    const deathFrom = a.aiFrames.length;
    keepReporting = true;
    const reporter2 = (async () => {
      while (keepReporting) {
        a.sendPos(TEST_MAP, mob.x, mob.y, 1);
        await sleep(100);
      }
    })();
    const deathHit = await waitFor(
      "把玩家打到 hp = 0 的那一帧",
      async () => a.hitsFrom(deathFrom).find((hit) => hit.hp === 0) ?? null,
      25_000,
    );
    keepReporting = false;
    await reporter2;
    check(!!deathHit, "玩家被打到 hp = 0");
    checkEqual(statusRows(dbPath, roleId).length, 0, "role_status 一行不剩（死亡即清空）");
    //#endregion
  } finally {
    if (server.child.exitCode === null && !server.child.signalCode) {
      server.child.kill("SIGTERM");
      await sleep(300);
      if (server.child.exitCode === null && !server.child.signalCode) server.child.kill("SIGKILL");
    }
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }

  console.log(`\n${failed === 0 ? "✅" : "FAIL："} 角色状态层（#822）：${passed} 条通过 / ${failed} 条失败`);
  if (failed > 0) {
    console.log("失败项：");
    for (const item of failures) console.log(`- ${item}`);
    console.log("\n服务端日志（尾部）：");
    console.log(server.logs().split("\n").slice(-30).join("\n"));
    process.exit(1);
  }
})();
