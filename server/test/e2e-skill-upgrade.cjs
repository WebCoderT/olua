#!/usr/bin/env node
/**
 * 服务端 e2e：技能升级（#828 / docs/37 G1）
 *
 * 在此之前 `data.skills` 是**服务端独占却没有任何写点**的字段：建号全 1 级、控制器没有升级接口，
 * 于是 11 档伤害系数只有第 1 档活着 —— 整条技能成长线是死的。这一套钉的是六件事：
 *
 * 一、**建号口径**：`data.skills` 全是 1 级、`data.skillPoints` = 1（用户口径「给 1 点」）
 * 二、**升级成功**：技能等级 +1、扣 `当前等级` 点、revision 原子 +1、存档与回执同步
 * 三、**点数不足**：20035，`details` 带 need / owned，且**一点都没动**（等级与 revision 都不变）
 * 四、**目标不合法**：20034 —— 怪物技能（没学过）/ 认不出的 id / 系数为空（1008 十步一杀）
 * 五、**伤害系数真的取下一档**：把 1000 的两档改成 1× 与 20×，升级前后各砍一刀，
 *     伤害必须差出量级（不是「字段改了但结算还读第一档」）
 * 六、**到顶**：上限 = 系数档数，练满之后再升 → 20036
 *
 * 另加两条：
 * - **权威边界**：客户端 PUT 存档时自己写 `skillPoints` / `skills`，会被服务端用库里的值回填
 *   （改包无法白得技能等级，也无法白得点数）；
 * - **存量库补发**（`DatabaseService.seedSkillPointsOnce`）：老档案没有 `skillPoints` →
 *   启动时按等级补一次；marker 在的时候重启**不再补**（否则花光点重启就回满）。
 *
 * 数值一律不锁出厂值：技能系数走管理端 PATCH（`skills` 是「启动装载 + 写操作触发刷新」的缓存，
 * 直改库读不到），技能点用库直写补（管理端 PATCH 角色没有这个字段）。
 *
 * 走的是 `dist/`，所以前置是 `npm run build`。用法：npm run test:e2e:skill-upgrade
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { placeRolesAt } = require("./lib/place-role.cjs");
const { paceCast } = require("./lib/cast-pace.cjs");
const { saveRole } = require("./lib/role-save.cjs");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

const MAP_ID = "1";
/** 输出靶：被动怪（不主动打人），血厚到整场打不死 */
const TARGET = { key: "3", x: 200, y: -200 };
const TARGET_HP = 100_000;

const SKILL_BASE = "1000"; // 基础剑术：伤害系数随等级递增（出厂 11 档 1.0 ~ 2.0）
const SKILL_FIRE = "1001"; // 烈火剑法：本套用来测「升一级」与「点数不足」
const SKILL_NO_COEF = "1008"; // 十步一杀：出厂 damage_coefficients 是空数组
const SKILL_MONSTER = "9001"; // 跃鼠猛击：owner = monster，玩家的 data.skills 里没有
const SKILL_UNKNOWN = "999999";

/** 系数改造：第 1 档 1 倍、第 2 档 20 倍 —— 升一级的差别必须是量级差，避免随机区间掩盖问题 */
const COEF_LOW = 1;
const COEF_HIGH = 20;

//#region 断言小工具（与 e2e-status / e2e-push 同款口径）

let passed = 0;
let failed = 0;
const failures = [];

function check(ok, label, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  [OK] ${label}${detail ? ` —— ${detail}` : ""}`);
    return true;
  }
  failed += 1;
  failures.push(label);
  console.log(`  [!!] ${label}${detail ? ` —— ${detail}` : ""}`);
  return false;
}

const checkEqual = (actual, expected, label) =>
  check(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);

function group(title) {
  console.log(`\n▶ ${title}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(50);
  }
  check(false, `${label}（等待超时）`);
  return last;
}

//#endregion

//#region 库直读 / 直写（准备段补技能点、断言读权威值）

/**
 * 打开临时库做一件事
 *
 * 服务端正握着写锁时直接写会抛 `database is locked`（本机快、CI 慢，偶发假红）——
 * `busy_timeout` 让这次写入等服务端放锁，与 `lib/place-role.cjs` 同一取向。
 */
function withDb(dbPath, run) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    return run(db);
  } finally {
    db.close();
  }
}

/** 读库里的技能等级与点数（断言「服务端真的落库了」，不看 HTTP 回执的自述） */
function readSkillsInDb(dbPath, roleId) {
  return withDb(dbPath, (db) => {
    const row = db.prepare("SELECT revision, data FROM roles WHERE id = ?").get(roleId);
    if (!row) return null;
    let data = {};
    try {
      data = JSON.parse(row.data);
    } catch {
      /* 坏档不是这一套要修的 */
    }
    return {
      revision: Number(row.revision),
      skills: data.skills && typeof data.skills === "object" ? data.skills : {},
      skillPoints: Math.max(0, Math.floor(Number(data.skillPoints) || 0)),
    };
  });
}

/**
 * 直接给角色补技能点（准备段用）
 *
 * 管理端 PATCH 角色**没有** `skillPoints` 字段（那一版只开放了等级 / 元宝 / 装备 / 技能表），
 * 而本套要验「点数够时能升到顶」，只能从库里补。补的是**存档里的余额**，
 * 与 `settleLevelUp` 写的是同一个字段 —— 所以服务端读到就是它。
 */
function grantSkillPoints(dbPath, roleId, points) {
  withDb(dbPath, (db) => {
    const row = db.prepare("SELECT data FROM roles WHERE id = ?").get(roleId);
    const data = JSON.parse(row.data);
    data.skillPoints = points;
    db.prepare("UPDATE roles SET data = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(data), Date.now(), roleId);
  });
}

/** 准备世界：一个 0×0 刷怪区（落点恒等于中心点）+ 一只血厚、不还手的靶子 */
function prepareWorld(dbPath) {
  withDb(dbPath, (db) => {
    db.prepare("DELETE FROM map_spawn_areas WHERE map_id = ?").run(MAP_ID);
    db.prepare(
      `INSERT INTO map_spawn_areas (map_id, name, monster_key, min, max, cx, cy, w, h, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(MAP_ID, "技能靶", TARGET.key, 1, 1, TARGET.x, TARGET.y, 0, 0, Date.now());

    // 血厚 + 四防归零 + 物攻压到 1：这一套要的是「打出的伤害」，不是「打死谁」
    db.prepare(
      `UPDATE monsters SET level = 0, max_hp = ?,
         physical_attack_min = 1, physical_attack_max = 1,
         magic_attack_min = 0, magic_attack_max = 0, taoist_attack_min = 0, taoist_attack_max = 0,
         physical_defense_min = 0, physical_defense_max = 0,
         magic_defense_min = 0, magic_defense_max = 0, taoist_defense_min = 0, taoist_defense_max = 0
       WHERE id = ?`,
    ).run(TARGET_HP, TARGET.key);
    // 不追人、不动：位置与血量断言才干净
    db.prepare("UPDATE monster_presentation SET move_speed = 0, aggressive = 0, detect_range = 200 WHERE id = ?").run(
      TARGET.key,
    );
  });
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
      ADMIN_REGISTER_CODE: "test-admin-code",
      JWT_SECRET: "e2e-skill-upgrade-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      MONSTER_AI_TICK_MS: "50",
      MONSTER_AI_BROADCAST_MS: "100",
      WORLD_RESPAWN_MS: "600000",
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

/** 一条会话化的 WS 连接（只收 settle / world 帧，够这一套出手用） */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    settles: [],
    worlds: [],
    seq: 0,
    async cast(skillId, targetId, monsterKey) {
      // 与真客户端同一口径的出手间隔（#813）：连发会被 `rejected: "cooldown"` 拒掉
      await paceCast();
      session.seq += 1;
      const castId = session.seq;
      socket.send(JSON.stringify({ type: "cast", data: { castId, skillId, targetId, monsterKey } }));
      return waitFor(`castId=${castId} 的 settle`, async () => session.settles.find((frame) => frame.castId === castId) ?? null);
    },
    async joinWorld(mapId, timeoutMs = 10_000) {
      const before = session.worlds.length;
      socket.send(JSON.stringify({ type: "worldJoin", data: { mapId } }));
      return waitFor(
        `mapId=${mapId} 的 world 帧`,
        async () => session.worlds.slice(before).filter((frame) => frame.mapId === mapId).pop() ?? null,
        timeoutMs,
      );
    },
    sendPos(x, y, hp) {
      socket.send(JSON.stringify({ type: "pos", data: { mapId: MAP_ID, x, y, hp, moving: false } }));
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
  const dbPath = path.join(os.tmpdir(), `olua-e2e-skill-upgrade-${Date.now()}.db`);
  // `let`：第八段要重启一次服务（存量库补发只有在「启动时」才会跑）
  let server = await startServer(dbPath);
  try {
    prepareWorld(dbPath);
    const { baseUrl } = server;

    //#region 〇、准备

    group("准备：管理员 / 玩家 / 输出靶");
    const superAdmin = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "gm_skill", password: "pass1234", registerCode: "test-admin-code" },
    });
    const adminToken = superAdmin.data && superAdmin.data.token;
    check(superAdmin.code === 0 && !!adminToken, "准备：注册管理员拿到令牌", superAdmin.message);

    const registered = await api(baseUrl, "POST", "auth/register", { body: { username: "skill_player", password: "pass1234" } });
    const token = registered.data && registered.data.token;
    const created = await api(baseUrl, "POST", "roles", { token, body: { name: "练技者", occupation: "1", sex: "1" } });
    const roleId = created.data && created.data.id;
    check(!!(token && roleId), "准备：账号与角色已建好", created.message);

    /** 读角色当前状态（含存档与 revision） */
    const readRole = async () => (await api(baseUrl, "GET", `roles/${roleId}`, { token })).data;

    const ticket = await api(baseUrl, "POST", "realtime/ticket", { token });
    const session = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`);
    await waitFor("实时连接握手", async () => (session.opened ? true : null));

    // 怪物数值 / 刷怪区都是 1 秒 TTL 现取库：等它过期，播种时才读得到 prepareWorld 写的那只靶子
    await sleep(1_200);
    // #859 起「没有位置记录」的角色只准进新手村 —— 要进 1 图得先让服务端认为他本来就在
    placeRolesAt(dbPath, "1");
    const world = await session.joinWorld(MAP_ID);
    const target = ((world && world.monsters) || []).find((mob) => mob.alive && mob.monsterKey === TARGET.key);
    check(!!target, "准备：输出靶已播种", JSON.stringify(((world && world.monsters) || []).map((mob) => mob.monsterKey)));
    if (!target) throw new Error("靶子没播种，后面没法测");

    /** 站桩（连发三帧：位置仲裁按速度上限拒单帧瞬移，但连续两帧超速就信任并重置基线） */
    const stand = async (x, y) => {
      for (let index = 0; index < 3; index += 1) {
        session.sendPos(x, y, 1_000_000);
        await sleep(120);
      }
    };
    const playerPos = { x: TARGET.x - 5, y: TARGET.y };
    await stand(playerPos.x, playerPos.y);

    /** 升级一次技能（写接口：revision 必填） */
    const upgrade = async (skillId, revision) => {
      const rev = revision === undefined ? (await readRole()).revision : revision;
      return api(baseUrl, "POST", `roles/${roleId}/skill-upgrade`, { token, body: { skillId, revision: rev } });
    };

    /** 砍一刀；先补一帧位置（在场表 3 秒收不到 pos 就把人当离场） */
    const strike = async (skillId) => {
      session.sendPos(playerPos.x, playerPos.y, 1_000_000);
      return session.cast(skillId, target.instanceId, target.monsterKey);
    };

    //#endregion

    //#region 一、建号口径

    group("一、建号口径：技能全 1 级、技能点 1 点");
    const fresh = await readRole();
    checkEqual(fresh.data.skillPoints, 1, "新角色带 1 点技能点（用户口径：给 1 点，开局就能看见升级按钮是活的）");
    checkEqual(Number(fresh.data.skills[SKILL_BASE]), 1, "基础剑术 1 级");
    checkEqual(Number(fresh.data.skills[SKILL_FIRE]), 1, "烈火剑法 1 级");
    check(!(SKILL_MONSTER in fresh.data.skills), "怪物技能（9001）不在玩家的技能表里");

    //#endregion

    //#region 二、升级成功

    group("二、升级成功：1001 从 1 级升到 2 级，花 1 点");
    const upgraded = await upgrade(SKILL_FIRE);
    checkEqual(upgraded.code, 0, "升级接口放行", upgraded.message);
    checkEqual(upgraded.data.skillId, SKILL_FIRE, "回执带回升的是哪个技能");
    checkEqual(upgraded.data.fromLevel, 1, "fromLevel = 1");
    checkEqual(upgraded.data.toLevel, 2, "toLevel = 2（恒 +1）");
    checkEqual(upgraded.data.cost, 1, "花费 = 当前等级 = 1 点");
    checkEqual(upgraded.data.remainPoints, 0, "扣完只剩 0 点");
    checkEqual(Number(upgraded.data.data.skills[SKILL_FIRE]), 2, "回执里的存档已经是 2 级（客户端整份照搬就够）");
    checkEqual(Number(upgraded.data.data.skillPoints), 0, "回执里的存档点数已扣");
    check(Number(upgraded.data.maxLevel) > 1, "带回该技能的等级上限（= 系数档数）", String(upgraded.data.maxLevel));
    checkEqual(upgraded.data.nextCost, 2, "带回「再升一级要 2 点」（= 1 + 新等级）");
    checkEqual(upgraded.data.revision, fresh.revision + 1, "revision 原子 +1");

    const afterUpgrade = readSkillsInDb(dbPath, roleId);
    checkEqual(Number(afterUpgrade.skills[SKILL_FIRE]), 2, "库里落的是 2 级（不是只改了回执）");
    checkEqual(afterUpgrade.skillPoints, 0, "库里的点数已扣干净");
    checkEqual(afterUpgrade.revision, fresh.revision + 1, "库里的 revision 也是 +1");
    checkEqual(Number(afterUpgrade.skills[SKILL_BASE]), 1, "别的技能一点没动");

    //#endregion

    //#region 三、点数不足

    group("三、点数不足：20035，且一点都没动");
    const poor = await upgrade(SKILL_FIRE);
    checkEqual(poor.code, 20035, "点数为 0 时升 2→3（要 2 点）→ 20035", poor.message);
    // need 的具体点数由技能系数档位算出来（配置数据），只判「带 need 与 owned 两个字段且 need 为正」
    check(!!poor.details && Number(poor.details.need) > 0 && poor.details.owned === 0, "details 带 need / owned（客户端据此提示差额）", JSON.stringify(poor.details));
    checkEqual(poor.data, null, "失败响应 data 恒为 null");
    const afterPoor = readSkillsInDb(dbPath, roleId);
    checkEqual(Number(afterPoor.skills[SKILL_FIRE]), 2, "失败不扣等级（还是 2 级）");
    checkEqual(afterPoor.skillPoints, 0, "失败不扣点（也没变成负数）");
    checkEqual(afterPoor.revision, afterUpgrade.revision, "失败不推 revision（否则客户端每点一次就撞一次乐观锁）");

    //#endregion

    //#region 四、目标不合法

    group("四、目标不合法：20034");
    const notLearned = await upgrade(SKILL_MONSTER);
    checkEqual(notLearned.code, 20034, "怪物技能（没学过）→ 20034", notLearned.message);
    const unknown = await upgrade(SKILL_UNKNOWN);
    checkEqual(unknown.code, 20034, "技能表里认不出的 id → 20034", unknown.message);
    const noSlots = await upgrade(SKILL_NO_COEF);
    checkEqual(noSlots.code, 20034, "系数为空（1008 十步一杀）→ 20034（不是 20036「已到顶」）", noSlots.message);
    check(
      typeof noSlots.message === "string" && noSlots.message.includes("档"),
      "提示说的是「没有可升的档位」（攒点也没用，运营要加档）",
      noSlots.message,
    );
    const afterInvalid = readSkillsInDb(dbPath, roleId);
    checkEqual(afterInvalid.revision, afterUpgrade.revision, "三次非法请求都没推 revision");

    //#endregion

    //#region 五、伤害系数取下一档

    group("五、伤害系数真的取下一档：把两档改成 1× / 20×，升级前后各砍一刀");
    // 管理端写操作会触发技能缓存刷新（直改库读不到 —— 与 map_spawn_areas 的播种口径不同）
    const patched = await api(baseUrl, "PATCH", `admin/skills/${SKILL_BASE}`, {
      token: adminToken,
      body: {
        damageCoefficients: [
          { baseType: "physicalAttack", baseTypeRate: COEF_LOW },
          { baseType: "physicalAttack", baseTypeRate: COEF_HIGH },
        ],
      },
    });
    checkEqual(patched && patched.code, 0, `准备：把 ${SKILL_BASE} 的两档改成 ${COEF_LOW}× / ${COEF_HIGH}×`, patched && patched.message);

    const lowHit = await strike(SKILL_BASE);
    check(!!(lowHit && lowHit.ok), "1 级砍一刀结算成功", lowHit && lowHit.message);
    check(!!lowHit && lowHit.damage > 0, "1 级这一刀有伤害（1× 档）", lowHit && `damage=${lowHit.damage}`);

    grantSkillPoints(dbPath, roleId, 5);
    const levelUp = await upgrade(SKILL_BASE);
    checkEqual(levelUp.code, 0, "补 5 点之后把基础剑术升到 2 级", levelUp.message);
    checkEqual(levelUp.data.cost, 1, "1→2 花 1 点");
    checkEqual(levelUp.data.remainPoints, 4, "5 − 1 = 4 点");
    checkEqual(levelUp.data.maxLevel, 2, "上限跟着系数档数走（2 档 = 2 级）");

    const highHit = await strike(SKILL_BASE);
    check(!!(highHit && highHit.ok), "2 级再砍同一只怪，结算成功", highHit && highHit.message);
    check(
      !!highHit && !!lowHit && highHit.damage > lowHit.damage * 5,
      "伤害按 20× 档打出（量级差，不是「字段改了但结算还读第 1 档」）",
      `1 级 ${lowHit && lowHit.damage} → 2 级 ${highHit && highHit.damage}`,
    );

    //#endregion

    //#region 六、到顶

    group("六、到顶：20036");
    const capped = await upgrade(SKILL_BASE);
    checkEqual(capped.code, 20036, "2 档练满之后再升 → 20036", capped.message);
    checkEqual(capped.data, null, "失败响应 data 恒为 null");
    const afterCapped = readSkillsInDb(dbPath, roleId);
    checkEqual(Number(afterCapped.skills[SKILL_BASE]), 2, "等级停在 2 级");
    checkEqual(afterCapped.skillPoints, 4, "点了不扣（到顶与点数无关，再攒也没用）");

    //#endregion

    //#region 七、权威边界

    group("七、权威边界：客户端 PUT 存档改不了技能等级与点数");
    const beforeSave = await readRole();
    const tampered = {
      ...beforeSave.data,
      skillPoints: 999,
      skills: { ...beforeSave.data.skills, [SKILL_BASE]: 9, [SKILL_FIRE]: 9 },
    };
    const saved = await saveRole((method, route, options) => api(baseUrl, method, route, options), token, roleId, tampered);
    checkEqual(saved && saved.code, 0, "带改过的技能表存档（结构合法，服务端放行）", saved && saved.message);
    checkEqual(Number(saved.data.data.skillPoints), 4, "点数被回填成库里的 4（改包白拿不到点）");
    checkEqual(Number(saved.data.data.skills[SKILL_BASE]), 2, "技能等级被回填成库里的 2 级（改包白拿不到倍率）");
    checkEqual(Number(saved.data.data.skills[SKILL_FIRE]), 2, "烈火剑法同样是库里的 2 级");

    //#endregion

    //#region 八、存量库补发

    group("八、存量库补发：老档案没有 skillPoints → 按等级补一次，重启不重复补");
    /**
     * 造一个「#828 之前的老号」：删掉存档里的 `skillPoints`、等级摆到 7，
     * 并把一次性迁移的 marker 一起清掉 —— 模拟「第一次升到这一版」。
     */
    const makeLegacyRole = (resetMarker) =>
      withDb(dbPath, (db) => {
        const current = db.prepare("SELECT data FROM roles WHERE id = ?").get(roleId);
        const data = JSON.parse(current.data);
        delete data.skillPoints;
        db.prepare("UPDATE roles SET data = ?, level = 7 WHERE id = ?").run(JSON.stringify(data), roleId);
        if (resetMarker) db.prepare("DELETE FROM config_meta WHERE key = 'skill_points_seeded'").run();
      });

    /** 重启服务（切到新端口；同一个库） */
    const restart = async () => {
      server.child.kill("SIGTERM");
      await waitFor("旧进程退出", async () => (server.child.exitCode !== null || server.child.signalCode ? true : null), 10_000);
      server = await startServer(dbPath);
      return server.baseUrl;
    };

    await makeLegacyRole(true);
    const url2 = await restart();
    const granted = await api(url2, "GET", `roles/${roleId}`, { token });
    checkEqual(granted.code, 0, "补发后角色详情可读", granted.message);
    checkEqual(granted.data.level, 7, "角色还是 7 级（补发不动等级列）");
    checkEqual(Number(granted.data.data.skillPoints), 7, "补发的点数 = 等级（每级 1 点，与新号口径一致）");

    // 反证：marker 在的时候重启不再补 —— 否则玩家把点花光后重启服务就又有满点
    await makeLegacyRole(false);
    const url3 = await restart();
    const notGranted = await api(url3, "GET", `roles/${roleId}`, { token });
    checkEqual(typeof notGranted.data.data.skillPoints, "undefined", "marker 已存在时重启不再补发（点数仍是缺省）");

    //#endregion

    console.log(`\n${failed === 0 ? "✅" : "❌"} 技能升级：${passed} 条通过 / ${failed} 条失败`);
    if (failed > 0) {
      console.log("\n失败项：");
      failures.forEach((item) => console.log(`  - ${item}`));
      console.log("\n服务端日志（尾部）：");
      console.log(server.logs().split("\n").slice(-30).join("\n"));
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
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
})();
