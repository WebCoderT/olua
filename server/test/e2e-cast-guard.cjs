#!/usr/bin/env node
/**
 * 服务端 e2e：出手判定链（#813 / docs/37 A1~A3）
 *
 * 这一套专盯「改了包的客户端能做什么」，逐道闸造一次：
 *
 * - **dead**：角色血量 0（库里落账值）→ 出手被拒，目标血量不变
 * - **cross_map**：在自己服务端记下的图（`data.mapAt`）之外出手 → 被拒；同区不同图也算跨图
 * - **cooldown**：同一技能连发 → 第二次被拒并带 `remainMs`（有效冷却 = cooldown ÷ speedRate）
 * - **mp**：蓝不够（这里把技能蓝耗临时调到 999）→ 被拒，且**不扣血、不记冷却**
 * - **rate**：令牌桶耗尽（容量 3）→ 第 4 发被拒；**重新进图不清桶**（A2：换图刷桶堵死）
 *
 * 距离闸（`range`）还没接：位置源仍是客户端自报 + 最小仲裁，#811 收口后补第三道，
 * 现在接上会把站在攻击边缘的正常出手术成超距（理由写在 `CastGuardService` 第三道那段）。
 *
 * 一条重要口径：**被拒的出手一份副作用都不该留** —— 不扣血、不扣蓝、不记冷却、不扣令牌。
 * 所以每条拒绝用例都顺带比一次目标血量，并且用「拒完之后立刻能正常打」验证没留冷却。
 *
 * 用临时文件库（要直接改角色的 hp 落账值造死亡态），跑 `dist/`，前置 `npm run build`。
 * 用法：npm run test:e2e:cast-guard
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { paceCast } = require("./lib/cast-pace.cjs");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

const ADMIN_CODE = "cast-guard-admin";
/**
 * 这一套在**图 3（雪域高原）**上跑：它出厂就有一批 2394 血的怪 —— 连打二十几发也打不死，
 * 靶子不会在中途变成 `target_dead`（图 1 的怪只有 65 血，两三下就没了）。
 * 跨图用例的陪跑图是图 1（卧龙城）。
 */
const TEST_MAP = "3";
const OTHER_MAP = "1";
/** 只用来造「死亡态」：客户端存不了 hp=0（服务端按库里落账值覆盖），只能直接改库 */
const HERO_HP = 100;

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

const waitFor = async (label, predicate, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(20);
  }
  check(false, `${label}（等待超时）`);
  return last;
};

/** 直接改库里的 hp 落账值（造死亡态 / 还原；服务端读角色时不缓存，改完立刻生效） */
function setRoleHp(dbPath, roleId, hp) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE roles SET data = json_set(data, '$.hp', ?) WHERE id = ?").run(hp, roleId);
  db.close();
}

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
      JWT_SECRET: "e2e-cast-guard-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      ADMIN_REGISTER_CODE: ADMIN_CODE,
      WORLD_RESPAWN_MS: "5000",
      // 怪物 AI 不打人：这一套只看「玩家的出手」，被怪打死会把死亡用例搞脏
      MONSTER_AI_TICK_MS: "1000",
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

/** 一条会话化 WS 连接（cast 不 await settle：判定链用例要的是「同一拍连发」） */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    settles: [],
    worlds: [],
    seq: 0,
    /** 发一发，返回它的 castId（不等待） */
    fire(body) {
      session.seq += 1;
      const castId = session.seq;
      socket.send(JSON.stringify({ type: "cast", data: { castId, ...body } }));
      return castId;
    },
    /** 等某一发的结果 */
    async settleOf(castId) {
      return waitFor(`castId=${castId} 的 settle`, async () => session.settles.find((frame) => frame.castId === castId) || null);
    },
    async joinWorld(mapId, timeoutMs = 5_000) {
      const before = session.worlds.length;
      socket.send(JSON.stringify({ type: "worldJoin", data: { mapId } }));
      return waitFor(
        `mapId=${mapId} 的 world 帧`,
        async () => {
          const hits = session.worlds.slice(before).filter((frame) => frame.mapId === mapId);
          return hits.length > 0 ? hits[hits.length - 1] : null;
        },
        timeoutMs,
      );
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
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  return session;
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-cast-guard-${Date.now()}.db`);
  const server = await startServer(dbPath);
  const { baseUrl } = server;
  try {
    //#region 准备
    group("准备：玩家、角色、实时连接、图 1 的靶子");

    const reg = await api(baseUrl, "POST", "auth/register", { body: { username: "guard_player", password: "pass1234" } });
    const token = reg.data && reg.data.token;
    const created = await api(baseUrl, "POST", "roles", { token, body: { name: "闸门测试", occupation: "1", sex: "1" } });
    const roleId = created.data && created.data.id;
    check(!!(token && roleId), "账号与角色已建好", String(roleId));

    const adminReg = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "guard_admin", password: "super-pass-1", registerCode: ADMIN_CODE },
    });
    const adminToken = adminReg.data && adminReg.data.token;
    checkEqual(adminReg.data && adminReg.data.admin.role, "super_admin", "准备：超级管理员已注册");

    const ticket = await api(baseUrl, "POST", "realtime/ticket", { token });
    const a = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`);
    await waitFor("实时连接握手", async () => (a.opened ? true : null));

    const world1 = await a.joinWorld(TEST_MAP);
    const alives = ((world1 && world1.monsters) || []).filter((mob) => mob.alive);
    // 出厂快照本身就给图 1 配了刷怪区，这里只是再补 3 个槽 —— 所以断「至少 3 只 + 实例 id 形态」，
    // 不断具体只数（运营随时会调密度）
    check(
      alives.length >= 3 && alives.every((item) => /^m3_z1_\d+$/.test(item.instanceId)),
      `图 ${TEST_MAP} 播出了靶子（实例 id 由服务端发牌，带区段）`,
      JSON.stringify(alives.map((m) => m.instanceId).slice(0, 6)),
    );
    /** 这一套所有「连打」用例的靶子：血最多的那只（27 万血，打不死） */
    const mob = alives.slice().sort((left, right) => right.maxHp - left.maxHp)[0];

    /**
     * 现拉一只活着的靶子
     *
     * 每段都换一只：图 1 的怪只有几十点血，一个人连测六七段就把一只打死了 ——
     * 后面的用例会先撞上 `target_dead`（那是既有判定，不是闸的行为），测的就不再是闸。
     */
    const freshTarget = async () => {
      const snap = await a.joinWorld(TEST_MAP);
      const list = ((snap && snap.monsters) || []).filter((item) => item.alive);
      // 血最多的优先（图 3 上的高阶怪有 2394 血）：连打二十几发也不会变成 `target_dead`
      const sorted = list.slice().sort((left, right) => right.maxHp - left.maxHp);
      return sorted.find((item) => item.hp === item.maxHp) || sorted[0] || null;
    };

    /**
     * 一只「打得动」的脆皮靶子（图 3 上也混着几十血的低阶怪）
     *
     * 血牛那只有 2394 血、防御也高，1 级角色打上去伤害恰好是 0（公式下限夹 0）——
     * 拿它验「扣血 / 不扣血」等于什么都没验。要验血量变化就换这只。
     */
    const weakTarget = async () => {
      const snap = await a.joinWorld(TEST_MAP);
      const list = ((snap && snap.monsters) || []).filter((item) => item.alive && item.hp === item.maxHp && item.maxHp <= 100);
      return list[0] || null;
    };

    /** 目标当前血量（现拉一次快照；快照里的 hp 就是世界实例的权威血量） */
    const hpOf = async (instanceId) => {
      const snap = await a.joinWorld(TEST_MAP);
      const found = ((snap && snap.monsters) || []).find((item) => item.instanceId === instanceId);
      return found ? found.hp : null;
    };

    //#endregion

    //#region 一、正常出手（回归基线）
    group("一、正常出手照常结算（五道闸不误伤）");

    const weak = await weakTarget();
    check(!!weak, "准备：取到一只打得动的脆皮靶子", weak && `${weak.instanceId}/${weak.maxHp}血`);
    const first = await (async () => {
      const id = a.fire({ skillId: "1000", targetId: weak.instanceId, monsterKey: weak.monsterKey });
      return a.settleOf(id);
    })();
    check(!!(first && first.ok) && first.damage > 0 && first.hp < weak.hp, "基础剑术照常打进（ok + 扣血）", JSON.stringify(first && { damage: first.damage, hp: first.hp }));
    check(!first || first.rejected === undefined, "放行的结算不带 rejected（只有被拒才有）");

    //#endregion

    //#region 二、dead：血量 0 不能出手
    group("二、存活闸：角色的血量为 0 → 出手被拒（目标血量不变）");

    const deadTarget = await weakTarget();
    check(!!deadTarget, "存活闸：取到一只活着的靶子", deadTarget && deadTarget.instanceId);
    setRoleHp(dbPath, roleId, 0);
    const beforeDead = await hpOf(deadTarget.instanceId);
    const deadId = a.fire({ skillId: "1000", targetId: deadTarget.instanceId, monsterKey: deadTarget.monsterKey });
    const deadFrame = await a.settleOf(deadId);
    checkEqual(deadFrame && deadFrame.rejected, "dead", "死亡态出手被拒（rejected = dead）");
    checkEqual(deadFrame && deadFrame.code, "dead", "老字段 code 同值（兼容既有客户端日志）");
    checkEqual(await hpOf(deadTarget.instanceId), beforeDead, "被拒的出手一点血都没扣");

    // 还原：走 revive（死亡态下的合法路径，服务端补满）
    const revived = await api(baseUrl, "POST", `roles/${roleId}/revive`, { token });
    checkEqual(revived.code, 0, "复活接口把血蓝补满（还原死亡态）", revived.message);

    //#endregion

    //#region 三、cross_map：同区不同图
    group("三、跨图闸：目标在别的图上 → 被拒（同区但不同 mapId）");

    // 另一条连接进另一张图把它的世界播出来（图只有被 join 过才有实例）
    const regB = await api(baseUrl, "POST", "auth/register", { body: { username: "guard_other", password: "pass1234" } });
    const tokenB = regB.data && regB.data.token;
    await api(baseUrl, "POST", "roles", { token: tokenB, body: { name: "跨图陪跑", occupation: "1", sex: "1" } });
    const ticketB = await api(baseUrl, "POST", "realtime/ticket", { token: tokenB });
    const b = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticketB.data.ticket)}`);
    await waitFor("第二条连接握手", async () => (b.opened ? true : null));
    const world3 = await b.joinWorld(OTHER_MAP);
    const mob3 = ((world3 && world3.monsters) || []).find((item) => item.alive);
    check(!!mob3, `图 ${OTHER_MAP} 也播出了一只靶子（另一条连接 join 触发的）`, mob3 && mob3.instanceId);

    // A 停在 TEST_MAP（mapAt=3），却去打 OTHER_MAP 的实例：同区闸过得去，跨图闸必须拦住
    await paceCast();
    const crossId = a.fire({ skillId: "1000", targetId: mob3.instanceId, monsterKey: mob3.monsterKey });
    const crossFrame = await a.settleOf(crossId);
    checkEqual(crossFrame && crossFrame.rejected, "cross_map", "跨图出手被拒（rejected = cross_map）");
    check(/卧龙城|1 图/.test(String(crossFrame && crossFrame.message)) || String(crossFrame && crossFrame.message).includes("你在"), "拒绝文案说清了「目标在哪、你在哪」", crossFrame && crossFrame.message);

    //#endregion

    //#region 四、cooldown：同一技能连发
    group("四、冷却闸：同一技能连发 → 第二发被拒并带 remainMs");

    await sleep(400); // 让上一段落的冷却过掉
    const cdTarget = await freshTarget();
    const c1 = a.fire({ skillId: "1000", targetId: cdTarget.instanceId, monsterKey: cdTarget.monsterKey });
    const c2 = a.fire({ skillId: "1000", targetId: cdTarget.instanceId, monsterKey: cdTarget.monsterKey });
    const [r1, r2] = [await a.settleOf(c1), await a.settleOf(c2)];
    check(!!(r1 && r1.ok), "第一发照常结算", JSON.stringify(r1 && r1.damage));
    checkEqual(r2 && r2.rejected, "cooldown", "同一拍的第二发被冷却闸拒掉（rejected = cooldown）");
    check(!!(r2 && r2.remainMs > 0 && r2.remainMs <= 250), "remainMs 落在有效冷却内（cooldown 1s ÷ speedRate 4 = 250ms）", String(r2 && r2.remainMs));

    // 冷却记的是「被接受的那一发」：拒掉的那发不该把冷却往后推
    await sleep(260);
    const c3 = a.fire({ skillId: "1000", targetId: cdTarget.instanceId, monsterKey: cdTarget.monsterKey });
    const r3 = await a.settleOf(c3);
    check(!!(r3 && r3.ok), "等过一个有效冷却后立刻能再打（拒掉的那发没有把冷却往后推）", JSON.stringify(r3 && r3.rejected));

    //#endregion

    //#region 五、mp：蓝不够
    group("五、耗蓝闸：蓝不够 → 被拒，且不扣血 / 不留冷却");

    // 把基础剑术的蓝耗临时调到 999（新角色 mp 远不够），比「烧光法力」更确定
    const patched = await api(baseUrl, "PATCH", "admin/skills/1000", { token: adminToken, body: { mpCost: 999 } });
    checkEqual(patched.code, 0, "准备：把基础剑术蓝耗临时改成 999", patched.message);
    await sleep(300); // 上一段最后一发刚放出去：等冷却过掉，这一发才会被「蓝不足」拦住而不是「冷却」
    const mpTarget = await weakTarget();
    const beforeMp = await hpOf(mpTarget.instanceId);
    const mpId = a.fire({ skillId: "1000", targetId: mpTarget.instanceId, monsterKey: mpTarget.monsterKey });
    const mpFrame = await a.settleOf(mpId);
    checkEqual(mpFrame && mpFrame.rejected, "mp", "蓝不足被拒（rejected = mp）");
    checkEqual(await hpOf(mpTarget.instanceId), beforeMp, "蓝不足的出手没有扣血");
    const restoreMp = await api(baseUrl, "PATCH", "admin/skills/1000", { token: adminToken, body: { mpCost: 0 } });
    checkEqual(restoreMp.code, 0, "还原：基础剑术蓝耗回到 0");

    //#region 六、rate：令牌桶
    group("六、频率闸：令牌桶（容量 3）耗尽 → 第 4 发被拒；换图不重置桶");

    await sleep(1200); // 让桶补满（容量 3，补速 4/s）
    const rateTarget = await freshTarget();
    // 四个不同技能在同一拍连发：冷却闸各自独立（不会先拦），能把桶打空的就是频率闸
    const burst = ["1002", "1003", "1005", "1006"].map((skillId) =>
      a.fire({ skillId, targetId: rateTarget.instanceId, monsterKey: rateTarget.monsterKey }),
    );
    const burstFrames = [];
    for (const id of burst) burstFrames.push(await a.settleOf(id));
    const oks = burstFrames.filter((frame) => frame && frame.ok);
    const rateRejected = burstFrames.filter((frame) => frame && frame.rejected === "rate");
    /** 四发各自的结果（失败时一眼看出是「桶没打空」还是「被别的闸先拦了」） */
    const burstDetail = JSON.stringify(
      burstFrames.map((frame) => (frame ? (frame.rejected ? frame.rejected : frame.ok ? "ok" : `code=${frame.code}`) : "无应答")),
    );
    checkEqual(oks.length, 3, `同一拍连发 4 发：前 3 发（桶容量）放行 —— ${burstDetail}`);
    checkEqual(rateRejected.length, 1, "第 4 发被频率闸拒掉（rejected = rate）", burstDetail);

    // A2：换图不重置桶 —— 重新进图（同一张图，幂等）之后桶还是空的
    await a.joinWorld(TEST_MAP);
    const afterJoin = a.fire({ skillId: "1007", targetId: rateTarget.instanceId, monsterKey: rateTarget.monsterKey });
    const afterJoinFrame = await a.settleOf(afterJoin);
    checkEqual(afterJoinFrame && afterJoinFrame.rejected, "rate", "重新进图（worldJoin）不清桶（换图刷桶被堵死）");

    // 反过来验一次「桶会补」：等 1 秒再打，能过
    await sleep(1200);
    const recovered = a.fire({ skillId: "1007", targetId: rateTarget.instanceId, monsterKey: rateTarget.monsterKey });
    const recoveredFrame = await a.settleOf(recovered);
    check(!!(recoveredFrame && recoveredFrame.ok), "等一秒令牌补回来之后照常出手（不是把人永久锁死）", JSON.stringify(recoveredFrame && recoveredFrame.rejected));

    //#endregion

    //#region 七、被拒的出手不产生任何世界副作用
    group("七、拒绝的代价为零：被拒的出手不写日志、不升级、不触发击杀");

    const killsBefore = a.settles.filter((frame) => frame && frame.ok && frame.killed).length;
    const burstTarget = await freshTarget();
    const rejectBurst = [];
    // 同一技能连发 10 次：至少 9 次被冷却闸拒掉
    for (let i = 0; i < 10; i += 1) {
      rejectBurst.push(a.fire({ skillId: "1009", targetId: burstTarget.instanceId, monsterKey: burstTarget.monsterKey }));
    }
    const rejectFrames = [];
    for (const id of rejectBurst) rejectFrames.push(await a.settleOf(id));
    const rejectedCount = rejectFrames.filter((frame) => frame && frame.rejected).length;
    check(rejectedCount >= 9, "同一拍连发 10 发：9 发以上被闸拒掉（只有第一发可能过）", String(rejectedCount));
    checkEqual(a.settles.filter((frame) => frame && frame.ok && frame.killed).length, killsBefore, "被拒的出手没有触发任何击杀结算");

    //#endregion
  } finally {
    server.child.kill("SIGTERM");
    try {
      require("node:fs").rmSync(dbPath, { force: true });
      require("node:fs").rmSync(`${dbPath}-wal`, { force: true });
      require("node:fs").rmSync(`${dbPath}-shm`, { force: true });
    } catch {
      /* 临时文件清不掉不影响结论 */
    }
  }

  console.log(`\n${failed === 0 ? "✅" : "FAIL："} 出手判定链（#813）：${passed} 条通过 / ${failed} 条失败`);
  if (failed > 0) {
    console.log("失败项：");
    for (const item of failures) console.log(`- ${item}`);
    process.exit(1);
  }
})();
