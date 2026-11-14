#!/usr/bin/env node
/**
 * 战斗状态专项 e2e（#826 第三批：眩晕 / 麻痹 / 灼烧 / 两段连击 / 拉人 / 等级压制）
 *
 * docs/22 §2.1 第 6 条与 §2.2 那张表写的是「状态改变结算」与「越级打不动」，此前
 * 只有 `role_status` 这一层空转：`statuses` 表上没有控制标记、没有周期结算，`skills`
 * 上也没有两段系数与拉人距离。这一套盯的是**接线之后的两侧行为**（用户口径「两侧都做」）：
 *
 * 一、**等级压制**（docs/22 §2.2）：`sup = max(0, 1 − 0.05 × 越级数)`，越 20 级伤害恒 0，
 *     回执带 `suppressed` —— 客户端据此显示「压制」而不是「伤害 0」
 * 二、**两段连击**：`skills.second_hit_ratio` 配 0.5 时第二段 = 第一段 × 0.5（不单独掷区间、
 *     不单独判暴击），系数 0 时不补第二段（反证）
 * 三、**灼烧打在怪身上**：`statuses.tick_ms + tick_effect` 按拍扣血、叠层封顶、
 *     **不致死**（留 1 血，见 `applyStatusTicks` 的归属说明）
 * 四、**玩家被控制**：怪打人挂 `status_id` → 本人收到 `statuses` 帧、出手被
 *     `rejected: "stunned"`、`pos` 帧坐标不被采纳
 * 五、**玩家被灼烧**：每秒按最大生命百分比掉血，且**不推 revision**（否则客户端的
 *     `roleUpdate` 会把血量变化当成存档被改，属性面板跟着抖）
 * 六、**怪被控制**：眩晕的怪不出手、不移动；拉人（`pull_distance`）与击退互斥，
 *     回执给的是**实际**位移
 *
 * 数值一律不锁出厂值：等级 / 血量 / 物攻在准备段改库（怪物数值 1 秒 TTL 现取），
 * 技能与状态的参数走管理端 PATCH（这两个是「启动装载 + 写操作触发刷新」的缓存，
 * 直改库读不到 —— 与 `map_spawn_areas` 的播种口径不同）。
 *
 * 走 `dist/`，前置 `npm run build`。用法：npm run test:e2e:status
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { placeRolesAt } = require("./lib/place-role.cjs");
const WebSocket = require("ws");
const { paceCast } = require("./lib/cast-pace.cjs");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

const MAP_ID = "1";
/** 输出靶（被动怪，不主动打人）：压制 / 两段 / 被控不动 */
const TARGET = { key: "3", x: 200, y: -200 };
/** 灼烧靶（远到不会干扰别的靶）：只给「灼烧打在怪身上」用 */
const BURN = { key: "4", x: 2000, y: -1800 };
/** 会放技能、会主动打人的怪：玩家侧状态全部由它制造 */
const BOSS = { key: "200", x: 400, y: -400 };

/** 靶子血厚到整场打不死（承伤断言全都用「差量」，不依赖绝对值） */
const TARGET_HP = 100_000;
/** 怪打人只掉 1 点：这一套要的是「挂状态」，不是「把玩家打死」 */
const MONSTER_ATTACK = 1;

const SKILL_BASE = "1000"; // 基础剑术：裸伤害，用来取「这一刀之前」的血量基准
const SKILL_BURN = "1001"; // 烈火剑法：出厂 status_id = 2003（灼烧）
const SKILL_DOUBLE = "1003"; // 莲月剑法：出厂 second_hit_ratio = 0.5
const SKILL_PULL = "1004"; // 擒龙手：出厂 status_id = 2004（眩晕）+ pull_distance = 300
const MONSTER_SKILL = "9001"; // 跃鼠猛击：BOSS 的伤害技能，出厂 status_id = 2004

const STATUS_BURN = "2003";
const STATUS_STUN = "2004";
/** 灼烧每拍的比例（与出厂 `statuses.tick_effect` 同源，断言用它算期望值） */
const BURN_HP_PERCENT = 0.02;
/** 灼烧封顶层数（与出厂 `statuses.max_stacks` 同源） */
const BURN_MAX_STACKS = 3;

//#region 断言小工具（与 e2e-push / e2e-monster-ai 同款口径）

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

//#region 库直读（准备段造状态、断言读权威值）

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

/** 角色存档里的血量与 revision（周期结算「不推 revision」只能拿它证明） */
function readRole(dbPath, roleId) {
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
      hp: Math.floor(Number(data.hp) || 0),
      maxHp: Math.max(1, Math.floor(Number(data.maxHp) || 0)),
    };
  });
}

/** 这个角色身上是不是挂着某条状态（权威来源就是 `role_status`，不看内存） */
function hasStatus(dbPath, roleId, statusId) {
  return withDb(dbPath, (db) => {
    const row = db.prepare("SELECT stacks FROM role_status WHERE role_id = ? AND status_id = ?").get(roleId, statusId);
    return row ? { stacks: Math.max(1, Number(row.stacks) || 1) } : null;
  });
}

/** 清掉角色身上的状态（眩晕是 20 秒的，不清掉后面的出手全会被 `stunned` 挡住） */
function clearStatuses(dbPath, roleId) {
  withDb(dbPath, (db) => {
    db.prepare("DELETE FROM role_status WHERE role_id = ?").run(roleId);
  });
}

/** 改怪等级（`monsters` 1 秒 TTL 现取库：改完等 1.2s 生效） */
function setMonsterLevel(dbPath, key, level) {
  withDb(dbPath, (db) => {
    db.prepare("UPDATE monsters SET level = ? WHERE id = ?").run(level, key);
  });
}

//#endregion

/**
 * 准备世界：三个 0×0 刷怪区（位置确定，断言才有意义）+ 全套数值改造
 *
 * 必须在服务端就绪**之后**写：空库首启会用 `config-sync.sql` 把配置表整表灌一遍，
 * 启动前写的行会被覆盖掉。
 */
function prepareWorld(dbPath) {
  withDb(dbPath, (db) => {
    db.prepare("DELETE FROM map_spawn_areas WHERE map_id = ?").run(MAP_ID);
    const seed = db.prepare(
      `INSERT INTO map_spawn_areas (map_id, name, monster_key, min, max, cx, cy, w, h, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    for (const spot of [TARGET, BURN, BOSS]) {
      // 0×0：`pickPointInArea` 的落点恒等于中心点
      seed.run(MAP_ID, `状态靶 ${spot.key}`, spot.key, 1, 1, spot.x, spot.y, 0, 0, now);
    }

    // 三只靶：0 级（压制测试自己会改）、10 万血、四防归零、物攻压到 1
    // 物攻必须压：1 级角色挨 BOSS 出厂 59~84 两下就死，死了 `controlOf` 与出手判据全变样
    const setMonster = db.prepare(
      `UPDATE monsters SET level = 0, max_hp = ?,
         physical_attack_min = ?, physical_attack_max = ?,
         magic_attack_min = 0, magic_attack_max = 0, taoist_attack_min = 0, taoist_attack_max = 0,
         physical_defense_min = 0, physical_defense_max = 0,
         magic_defense_min = 0, magic_defense_max = 0, taoist_defense_min = 0, taoist_defense_max = 0
       WHERE id = ?`,
    );
    for (const key of [TARGET.key, BURN.key, BOSS.key]) setMonster.run(TARGET_HP, MONSTER_ATTACK, MONSTER_ATTACK, key);

    // BOSS 要追人（「被眩晕后不追了」靠位移看）；两个被动靶站住不动（位置断言干净）。
    // 检测范围放大到 1200：最后一段要「人在攻击距离外、但仍在检测范围内」——
    // 那时它正在赶过来打你，被定住之后「不位移 + 不出手」两件事才都有区分力
    // （出厂 200 的范围下，人在攻击距离外就等于出了检测范围，它会直接脱战回家）。
    const setPresentation = db.prepare(
      "UPDATE monster_presentation SET move_speed = ?, aggressive = ?, detect_range = ? WHERE id = ?",
    );
    setPresentation.run(300, 1, 1_200, BOSS.key);
    setPresentation.run(0, 0, 200, TARGET.key);
    setPresentation.run(0, 0, 200, BURN.key);

    // 攻击间隔放宽到 3 秒：普攻只在「证明被打过」时出现，别把血量断言搅成噪声；
    // 攻击距离加大到 120（9001 的 distance 是 90，要让它够得着）；
    // 待机游走关掉（被动靶不该自己走开，否则坐标断言跟着漂）
    const row = db.prepare("SELECT monster_ai FROM runtime_params WHERE id = 1").get();
    const raw = row && row.monster_ai ? JSON.parse(row.monster_ai) : {};
    db.prepare("UPDATE runtime_params SET monster_ai = ? WHERE id = 1").run(
      JSON.stringify({
        ...raw,
        attackInterval: 3_000,
        attackRange: 120,
        idleMoveInterval: [600_000, 600_000],
      }),
    );
  });
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
      JWT_SECRET: "e2e-status-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      // AI tick 拉快（追击位移要看得见）、广播 100ms（断言采样够密）
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

/**
 * 一条会话化的 WS 连接
 *
 * 除了 settle / world / monster-ai 三类帧，还要收 `statuses`（#826 第三批新增：
 * 怪给玩家挂状态时把整份快照推给本人，否则他要等下一次出手被 `stunned` 拒了才知道自己被控）。
 */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    settles: [],
    worlds: [],
    aiFrames: [],
    statusFrames: [],
    seq: 0,
    /**
     * 发一次出手并等它的 settle 帧（间隔按真客户端冷却走，#813）
     *
     * `paceCast` 只按基础剑术（action = attack_near，4 次/秒）算 290ms；这一套用的
     * 1003 / 1004 的 action 不在 `speedRate` 里，服务端按 rate = 1 折成整 1 秒冷却。
     * 统一等 1.1 秒，两种口径都不会撞上 `rejected: "cooldown"`。
     */
    async cast(skillId, targetId, monsterKey) {
      await paceCast();
      await sleep(1_100);
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
    /** 某只怪在 fromIndex 之后的最新一条 AI 位置 */
    latestAi(instanceId, fromIndex = 0) {
      for (let i = session.aiFrames.length - 1; i >= fromIndex; i -= 1) {
        // #768 缩字段：monster-ai 条目的实例 id 是 `i`（world 快照那边才叫 instanceId）
        const entry = (session.aiFrames[i].monsters || []).find((mob) => mob.i === instanceId);
        if (entry) return entry;
      }
      return null;
    },
    /** fromIndex 起这只怪的全部 AI 条目（血量 / 位移序列） */
    aiEntries(instanceId, fromIndex = 0) {
      const out = [];
      for (let i = fromIndex; i < session.aiFrames.length; i += 1) {
        for (const entry of session.aiFrames[i].monsters || []) {
          if (entry.i === instanceId) out.push(entry);
        }
      }
      return out;
    },
    /** fromIndex 起所有命中事件（**全图广播**，判定归属要按 accountId 过滤） */
    hitsFrom(fromIndex = 0) {
      const out = [];
      for (let i = fromIndex; i < session.aiFrames.length; i += 1) out.push(...(session.aiFrames[i].hits || []));
      return out;
    },
    /** fromIndex 起所有技能释放事件 */
    castsFrom(fromIndex = 0) {
      const out = [];
      for (let i = fromIndex; i < session.aiFrames.length; i += 1) out.push(...(session.aiFrames[i].casts || []));
      return out;
    },
    /** fromIndex 起收到的状态快照（每条是整份 `statuses` 数组） */
    statusesFrom(fromIndex = 0) {
      return session.statusFrames.slice(fromIndex);
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
      if (frame.type === "statuses") session.statusFrames.push((frame.data && frame.data.statuses) || []);
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  return session;
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-status-${Date.now()}.db`);
  const server = await startServer(dbPath);
  try {
    prepareWorld(dbPath);
    const { baseUrl } = server;

    //#region 准备
    group("准备：管理员 / 玩家 / 三只靶子");

    const superAdmin = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "gm_status", password: "pass1234", registerCode: "test-admin-code" },
    });
    check(superAdmin.code === 0 && !!superAdmin.data.token, "准备：注册管理员拿到令牌", superAdmin.message);
    const adminToken = superAdmin.data && superAdmin.data.token;

    const registered = await api(baseUrl, "POST", "auth/register", { body: { username: "status_player", password: "pass1234" } });
    const token = registered.data && registered.data.token;
    const created = await api(baseUrl, "POST", "roles", { token, body: { name: "状态测试", occupation: "1", sex: "1" } });
    const roleId = created.data && created.data.id;
    check(!!(token && roleId), "准备：账号与角色已建好", created.message);

    const me = await api(baseUrl, "GET", "auth/me", { token });
    const accountId = me.data && me.data.id;
    check(typeof accountId === "string" && accountId.length > 0, "准备：拿到账号 id（命中帧是全图广播，按它过滤归属）");

    const ticket = await api(baseUrl, "POST", "realtime/ticket", { token });
    const session = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`);
    await waitFor("实时连接握手", async () => (session.opened ? true : null));

    // 怪物数值 1 秒 TTL：等它过期，播种时才会读到 prepareWorld 写的那三只
    await sleep(1_200);
    // #859 起「没有位置记录」的角色只准进新手村 —— 要进 1 图得先让服务端认为他本来就在
    placeRolesAt(dbPath, "1");
    const world = await session.joinWorld(MAP_ID);
    const monsters = ((world && world.monsters) || []).filter((mob) => mob.alive);
    const target = monsters.find((mob) => mob.monsterKey === TARGET.key);
    const burn = monsters.find((mob) => mob.monsterKey === BURN.key);
    const boss = monsters.find((mob) => mob.monsterKey === BOSS.key);
    check(!!(target && burn && boss), "准备：三只靶子都已播种", JSON.stringify(monsters.map((mob) => mob.monsterKey)));
    if (!target || !burn || !boss) throw new Error("靶子没播种，后面没法测");

    /**
     * 瞬移到某点：连发三帧
     *
     * 位置仲裁按速度上限拒「瞬移」单帧，但**连续两帧超速就信任并重置基线**（#861）。
     * 只发一帧的话人还站在上一处 —— 后面所有按玩家坐标算的东西（拉人方向、索敌）全会错位。
     */
    let playerPos = { x: TARGET.x - 5, y: TARGET.y };
    const stand = async (x, y) => {
      playerPos = { x, y };
      for (let index = 0; index < 3; index += 1) {
        session.sendPos(x, y, 1_000_000);
        await sleep(120);
      }
    };

    /** 分步走（在场表只信任不会被判成瞬移的帧；60px / 110ms ≈ 545px/s） */
    const walk = async (to, stepPx = 60, intervalMs = 110) => {
      const from = { ...playerPos };
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const frames = Math.max(1, Math.ceil(Math.hypot(dx, dy) / stepPx));
      for (let index = 1; index <= frames; index += 1) {
        playerPos = { x: from.x + (dx * index) / frames, y: from.y + (dy * index) / frames };
        session.sendPos(playerPos.x, playerPos.y, 1_000_000);
        await sleep(intervalMs);
      }
    };

    /** 改技能（管理端写操作触发缓存刷新，下一刀生效） */
    const patchSkill = async (skillId, body) => {
      const result = await api(baseUrl, "PATCH", `admin/skills/${skillId}`, { token: adminToken, body });
      checkEqual(result && result.code, 0, `准备：改技能 ${skillId} ${JSON.stringify(body)}`);
      return result && result.data;
    };

    /** 改状态（同上） */
    const patchStatus = async (statusId, body) => {
      const result = await api(baseUrl, "PATCH", `admin/statuses/${statusId}`, { token: adminToken, body });
      checkEqual(result && result.code, 0, `准备：改状态 ${statusId} ${JSON.stringify(body)}`);
      return result && result.data;
    };

    /** 打一刀；先补一帧位置（在场表 3 秒收不到 pos 就把人当离场） */
    const strike = async (skillId, monster) => {
      session.sendPos(playerPos.x, playerPos.y, 1_000_000);
      return session.cast(skillId, monster.instanceId, monster.monsterKey);
    };

    /**
     * 等待期间保持位置上报
     *
     * 在场表 3 秒收不到 `pos` 就把人当离场删掉（#855/#861），怪随即丢目标 ——
     * 而「怪打人」这条链每一步都要有人在场上。等 20 秒的地方不续报，等于让怪自己走开。
     */
    const keepAliveDuring = async (fn) => {
      let alive = true;
      const reporter = (async () => {
        while (alive) {
          session.sendPos(playerPos.x, playerPos.y, 1_000_000);
          await sleep(400);
        }
      })();
      try {
        return await fn();
      } finally {
        alive = false;
        await reporter;
      }
    };

    await stand(playerPos.x, playerPos.y);
    //#endregion

    //#region 一、等级压制（docs/22 §2.2）
    group("一、等级压制：越 20 级伤害恒 0（玩家 1 级）");

    const flat = await strike(SKILL_BASE, target);
    check(!!(flat && flat.ok), "同等级（怪 0 级）一刀结算成功", flat && flat.message);
    check(!!flat && !(flat.suppressed === true), "同等级不带压制标记（打低级怪既不吃惩罚也不加成）", flat && JSON.stringify(flat.suppressed));
    check(!!flat && flat.damage > 0, "同等级伤害 > 0", flat && `damage=${flat.damage}`);

    // 越 20 级：sup = max(0, 1 − 0.05 × 20) = 0 —— 打不动，且这是「压制」不是「防御吃满」
    setMonsterLevel(dbPath, TARGET.key, 21);
    await sleep(1_200);
    const crushed = await strike(SKILL_BASE, target);
    check(!!(crushed && crushed.ok), "越 20 级这一刀照样结算（不是被闸拒掉）", crushed && crushed.message);
    checkEqual(crushed && crushed.damage, 0, "越 20 级伤害恒为 0");
    check(!!crushed && crushed.suppressed === true, "越 20 级回执带 suppressed（客户端据此显示「压制」而不是「伤害 0」）");

    // 越 10 级：sup = 0.5 —— 有伤害但确实被压着（只断言标记，不锁具体数值）
    setMonsterLevel(dbPath, TARGET.key, 11);
    await sleep(1_200);
    const squeezed = await strike(SKILL_BASE, target);
    check(!!squeezed && squeezed.suppressed === true, "越 10 级同样带压制标记", squeezed && `damage=${squeezed.damage}`);

    setMonsterLevel(dbPath, TARGET.key, 0);
    await sleep(1_200);
    const recovered = await strike(SKILL_BASE, target);
    check(!!recovered && !(recovered.suppressed === true), "等级改回 0 之后压制解除（系数是现算的，不是缓存的）");
    //#endregion

    //#region 二、两段连击
    group("二、两段连击：第二段 = 第一段 × 配置系数，系数 0 时不补");

    await patchSkill(SKILL_DOUBLE, { secondHitRatio: 0.5 });
    // 血量差要有个干净的基准：用上面那一刀（基础剑术）的结算血量做 before
    const beforeDouble = recovered && recovered.hp;
    const doubled = await strike(SKILL_DOUBLE, target);
    check(!!(doubled && doubled.ok), "带两段的技能结算成功", doubled && doubled.message);
    const expectSecond = Math.round(((doubled && doubled.damage) || 0) * 0.5);
    check(
      !!doubled && doubled.secondDamage === expectSecond,
      "第二段 = 第一段 × 0.5（不单独掷区间、不单独判暴击）",
      doubled && `第一段 ${doubled.damage} + 第二段 ${doubled.secondDamage}（期望 ${expectSecond}）`,
    );
    check(
      typeof beforeDouble === "number" && !!doubled && beforeDouble - doubled.hp === doubled.damage + (doubled.secondDamage || 0),
      "血量差等于两段之和（第二段真的落到了世界状态上，不是只写进回执）",
      doubled && `${beforeDouble} → ${doubled.hp}（差 ${beforeDouble - doubled.hp}）`,
    );

    // 反证：系数 0 → 不补第二段（回执里连字段都不出现）
    await patchSkill(SKILL_DOUBLE, { secondHitRatio: 0 });
    const beforeSingle = doubled && doubled.hp;
    const single = await strike(SKILL_DOUBLE, target);
    check(!!(single && single.ok), "系数 0 之后照样结算", single && single.message);
    check(!!single && single.secondDamage === undefined, "系数 0 时回执不带 secondDamage");
    check(
      typeof beforeSingle === "number" && !!single && beforeSingle - single.hp === single.damage,
      "血量差只等于第一段（没有偷偷补一刀）",
      single && `${beforeSingle} → ${single.hp}（差 ${beforeSingle - single.hp}）`,
    );
    await patchSkill(SKILL_DOUBLE, { secondHitRatio: 0.5 });
    //#endregion

    //#region 三、灼烧打在怪身上
    group("三、灼烧（怪）：按拍扣血、叠层封顶、不致死");

    await stand(BURN.x - 5, BURN.y);
    const lit = await strike(SKILL_BURN, burn);
    check(!!(lit && lit.ok), "烈火剑法（status_id = 2003 灼烧）结算成功", lit && lit.message);
    checkEqual(lit && lit.targetStatus, STATUS_BURN, "回执 targetsStatus = 2003（状态挂在**目标**身上，不是自己）");

    /** 量一段窗口里怪被烧掉多少（只算这个窗口内 AI 帧的血量下降，不依赖绝对血量） */
    const burnRate = async (windowMs) => {
      const from = session.aiFrames.length;
      const start = session.latestAi(burn.instanceId, 0);
      await sleep(windowMs);
      const entries = session.aiEntries(burn.instanceId, from);
      const last = entries.length ? entries[entries.length - 1] : null;
      return {
        drop: start && last ? start.hp - last.hp : 0,
        lastHp: last ? last.hp : null,
        lastAlive: !!last,
        maxHp: start ? start.m : TARGET_HP,
      };
    };

    // 一层：2.2 秒 ≈ 2 拍，每拍 2% 最大生命
    const oneStack = await burnRate(2_200);
    const oneTick = Math.round(oneStack.maxHp * BURN_HP_PERCENT);
    check(
      oneStack.drop >= oneTick * 1.5 && oneStack.drop <= oneTick * 3.5,
      "一层灼烧 2.2 秒烧掉约 2 拍 × 2% 最大生命",
      `掉 ${oneStack.drop}（每拍 ${oneTick}，期望 2 拍）`,
    );

    // 叠到封顶：再补三刀（同 id 再加一层），速率应当接近 3 倍但不再往上长
    for (let index = 0; index < 3; index += 1) {
      const extra = await strike(SKILL_BURN, burn);
      if (extra && extra.ok) await sleep(1_100);
    }
    const stacked = await burnRate(2_200);
    const perTickStacked = oneTick * BURN_MAX_STACKS;
    check(
      stacked.drop >= perTickStacked * 1.5 && stacked.drop <= perTickStacked * 3.5,
      `叠满 ${BURN_MAX_STACKS} 层后每拍约 ${BURN_MAX_STACKS} × 2% 最大生命（层数乘在总量上，不是每拍扣多次）`,
      `掉 ${stacked.drop}（每拍上限 ${perTickStacked}）`,
    );

    // 不致死：把每拍改成 -100%（一拍就扣光），血量必须停在 1 —— 状态伤害没有 castId，
    // 让它打死就会留下「地上有东西但客户端不知道 castId」的死账（重开条件见 applyStatusTicks）
    await patchStatus(STATUS_BURN, { tickEffect: { hpPercent: -1 } });
    const lethal = await strike(SKILL_BURN, burn);
    check(!!(lethal && lethal.ok), "把灼烧改成每拍 -100% 之后还能挂上", lethal && lethal.message);
    await sleep(1_800);
    const afterLethal = session.latestAi(burn.instanceId, 0);
    check(!!afterLethal, "灼烧靶还在 AI 帧里（没有从广播里消失 = 没被状态伤害打死）");
    checkEqual(afterLethal && afterLethal.hp, 1, "血量夹在 1（最后一击留给玩家，掉落账本不落死账）");
    await patchStatus(STATUS_BURN, { tickEffect: { hpPercent: -BURN_HP_PERCENT } });
    //#endregion

    //#region 四、玩家被控制（眩晕）
    group("四、玩家被眩晕：statuses 帧 / 出手被拒 / pos 帧不被采纳");

    // 出厂 1.5 秒太短，看不清「锁住」这件事（要跨过至少一个 3 秒的攻击间隔）
    await patchStatus(STATUS_STUN, { duration: 20 });

    await stand(BOSS.x + 150, BOSS.y);
    const statusFrom = session.statusFrames.length;
    const stunHit = await keepAliveDuring(() =>
      waitFor(
        `BOSS 的 ${MONSTER_SKILL} 命中玩家（它会挂 ${STATUS_STUN}）`,
        async () => {
          // 命中帧是全图广播：按 accountId 过滤，否则别的目标挨打也会算成自己被控
          const hit = session
            .hitsFrom(0)
            .filter((entry) => entry.i === boss.instanceId && entry.a === accountId)
            .pop();
          return hit ?? null;
        },
        20_000,
      ),
    );
    check(!!stunHit, "BOSS 真的对玩家放了技能并命中", stunHit && `damage=${stunHit.d}`);

    const stunnedFrame = await waitFor(
      "本人收到 statuses 帧",
      async () => {
        for (const snapshot of session.statusesFrom(statusFrom)) {
          const entry = snapshot.find((item) => item.id === STATUS_STUN);
          if (entry) return entry;
        }
        return null;
      },
      8_000,
    );
    check(!!stunnedFrame, "被挂状态时本人立刻收到 statuses 帧（不用等下一次出手被拒才知道）", stunnedFrame && `id=${stunnedFrame.id} stacks=${stunnedFrame.stacks}`);
    check(!!stunnedFrame && stunnedFrame.stacks >= 1, "帧里带真实层数（不是恒 1 的占位）", stunnedFrame && JSON.stringify(stunnedFrame));
    const storedStun = hasStatus(dbPath, roleId, STATUS_STUN);
    check(!!storedStun, "角色侧状态落了库（跨进程 / 跨重启都要活着）", storedStun && `stacks=${storedStun.stacks}`);

    // 眩晕 = 既不能动也不能出手（用户口径：眩晕与麻痹都禁一切，只是来源与图标不同）
    const blocked = await session.cast(SKILL_BASE, target.instanceId, target.monsterKey);
    check(!!blocked && blocked.ok === false, "眩晕期间出手被拒", blocked && blocked.message);
    checkEqual(blocked && blocked.rejected, "stunned", "拒绝原因是 stunned");

    // 移动锁：连发 25 帧「往外走」，坐标一律不采纳（连仲裁基线都不动）。
    // 判据放在 AI 侧观测：人真的被走开了就会超出牵引半径 600px 而脱战，再也不会挨打。
    // 反过来，锁生效 → 人还在原地 → BOSS 继续命中 —— 这条窗口跨过了一整个攻击间隔
    const walkFrom = session.aiFrames.length;
    await walk({ x: BOSS.x + 1_650, y: BOSS.y });
    const stillHit = await keepAliveDuring(() =>
      waitFor(
        "眩晕期间「走远」之后 BOSS 还在命中玩家（位置没被采纳，人还在原地）",
        async () => {
        // 眩晕自己是 20 秒，但期间会不断被刷新；直接看窗口里有没有新的命中
          const hits = session
            .hitsFrom(walkFrom)
            .filter((entry) => entry.i === boss.instanceId && entry.a === accountId);
          return hits.length > 0 ? hits[hits.length - 1] : null;
        },
        12_000,
      ),
    );
    check(
      !!stillHit,
      "眩晕期间上报的坐标不被采纳（人没走开，怪还够得着 —— 若锁失效早就超出牵引半径脱战了）",
      stillHit && `damage=${stillHit.d}`,
    );

    // 清场：状态行直删（`snapshotOf` 现读库，删完立刻生效）。
    // 「删完立刻能出手」这条**不在这里验**：BOSS 还在贴身打，删完 300ms 内又会挨一记
    // 9001 把眩晕挂回去 —— 那条断言挪到五段末尾（那时 9001 挂的是灼烧，不控人）
    clearStatuses(dbPath, roleId);
    await stand(BOSS.x + 150, BOSS.y);
    //#endregion

    //#region 五、玩家被灼烧（周期结算）
    group("五、玩家被灼烧：每秒按最大生命百分比掉血，且不推 revision");

    await patchSkill(MONSTER_SKILL, { statusId: STATUS_BURN });
    const burnStored = await keepAliveDuring(() =>
      waitFor(
        "BOSS 的下一次技能命中给玩家挂上灼烧（role_status 出现 2003）",
        async () => hasStatus(dbPath, roleId, STATUS_BURN),
        25_000,
      ),
    );
    check(!!burnStored, "怪打人这一侧也会挂状态（与玩家打怪同一个口径）", burnStored && `stacks=${burnStored.stacks}`);

    const beforeTick = readRole(dbPath, roleId);
    check(!!beforeTick, "读到玩家存档（周期结算的权威值）", beforeTick && `hp=${beforeTick.hp}/${beforeTick.m} revision=${beforeTick.revision}`);
    // 窗口取 6.4 秒，不是 3 秒 —— 两条都在削这个数：
    // ① 结算是每秒一拍、定时器相位随机，3 秒窗口在慢时钟机器上可能只覆盖到一拍（CI 实测掉 1）；
    // ② 自然回血（`hpRecoverOfHp` = 1%/秒）会在每次受击结算时把血补回来，血量其实是**锯齿**
    //    （实测 100 → 98 → 96 → 99 → 97…）。所以「窗口前后净下降多少」根本不是可靠判据 ——
    //    这里改成**数下降次数**：每拍掉 2 点、回血只会把它补回一部分，数到两次「比上一次低」
    //    就说明周期结算真的在跑。这一段要断的是「在跑」，不是「2% 这个数字」（数值归运营）
    const burnTicks = await keepAliveDuring(async () => {
      let last = beforeTick ? beforeTick.hp : 0;
      let drops = 0;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && drops < 2) {
        await sleep(300);
        const sample = readRole(dbPath, roleId);
        if (!sample) break;
        if (sample.hp < last) drops += 1;
        last = sample.hp;
      }
      return drops;
    });
    const afterTick = readRole(dbPath, roleId);
    const tickExpect = beforeTick ? Math.round(beforeTick.maxHp * BURN_HP_PERCENT) : 0;
    check(
      burnTicks >= 2,
      "血量按拍下降（周期结算真的在跑，不是只挂了个图标）",
      `观测到 ${burnTicks} 次下降（每拍毛 ${tickExpect}，自然回血会补回一部分）`,
    );
    checkEqual(afterTick && afterTick.revision, beforeTick && beforeTick.revision, "血量变化不推 revision（客户端不该把它当成存档被改）");

    // 控制判据现读库（没有内存副本）：把状态行删掉，同一只手立刻能出刀
    clearStatuses(dbPath, roleId);
    const afterClear = await session.cast(SKILL_BASE, target.instanceId, target.monsterKey);
    check(!!afterClear && afterClear.ok, "状态行删掉之后出手恢复（控制判据现读库，没有内存副本）", afterClear && afterClear.message);
    //#endregion

    //#region 六、怪被控制：不出手 / 不移动
    group("六、怪被眩晕：不再出手，也不再追人");

    // 清掉 9001 的状态（这一段的怪会成为「纯伤害技能」的怪，玩家不该再被控）
    await patchSkill(MONSTER_SKILL, { statusId: "" });
    await stand(BOSS.x + 150, BOSS.y);
    const quietFrom = session.aiFrames.length;
    const stillHitting = await keepAliveDuring(() =>
      waitFor(
        "清空 statusId 之后 BOSS 照样打人（反证：状态是技能挂的，不是命中自带）",
        async () => {
          const hits = session
            .hitsFrom(quietFrom)
            .filter((entry) => entry.i === boss.instanceId && entry.a === accountId);
          return hits.length > 0 ? hits[hits.length - 1] : null;
        },
        20_000,
      ),
    );
    check(!!stillHitting, "纯伤害的 9001 仍然命中玩家", stillHitting && `damage=${stillHitting.d}`);
    check(!hasStatus(dbPath, roleId, STATUS_STUN), "反证：清空 statusId 之后命中不再挂眩晕");

    // 后退到攻击距离外（但仍在检测范围 1200 内）：BOSS 会一路追过来准备打你。
    // 「追过来」这件事必须是**眩晕前就在发生**的，否则「定住之后不动」没有区分力
    // （贴脸站定出手的怪本来就不动）。
    const chaseFrom = session.aiFrames.length;
    await walk({ x: playerPos.x + 500, y: playerPos.y });
    const chaseEntries = session.aiEntries(boss.instanceId, chaseFrom);
    const chaseShift = chaseEntries.reduce(
      (acc, entry) => ({ minX: Math.min(acc.minX, entry.x), maxX: Math.max(acc.maxX, entry.x) }),
      { minX: Infinity, maxX: -Infinity },
    );
    check(
      chaseEntries.length > 1 && chaseShift.maxX - chaseShift.minX > 30,
      "眩晕之前 BOSS 正在追人（位移可见 —— 挡住它的那一刀才有意义）",
      chaseEntries.length ? `x ∈ [${chaseShift.minX.toFixed(1)}, ${chaseShift.maxX.toFixed(1)}]` : "没有位置帧",
    );

    // 用擒龙手（配了 status_id = 2004 + pull_distance）把 BOSS 定住
    const grappled = await strike(SKILL_PULL, boss);
    check(!!(grappled && grappled.ok), "擒龙手结算成功", grappled && grappled.message);
    checkEqual(grappled && grappled.targetStatus, STATUS_STUN, "回执 targetStatus = 2004（眩晕挂到了怪身上）");
    check(
      !!grappled && grappled.pullDistance > 0 && grappled.pullDistance <= 300,
      "拉人：回执给的是**实际**位移（≤ 配置 300，超出的距离被截掉）",
      grappled && `pullDistance=${grappled.pullDistance}`,
    );
    check(!!grappled && grappled.pushDistance === undefined, "拉人与击退互斥：同一刀不会既推又拉");

    // 拉人的位移要 200ms 才走完，先让它落定再开观测窗
    await sleep(800);
    const frozenBefore = session.latestAi(boss.instanceId, 0);
    const stillWindow = session.aiFrames.length;
    await sleep(3_500);
    const quietHits = session
      .hitsFrom(stillWindow)
      .filter((entry) => entry.i === boss.instanceId && entry.a === accountId);
    checkEqual(quietHits.length, 0, "眩晕期间 BOSS 一次都没打中玩家（禁一切：既不出手也不放技能）");
    const quietCasts = session.castsFrom(stillWindow).filter((cast) => cast.i === boss.instanceId);
    checkEqual(quietCasts.length, 0, "眩晕期间也不再释放任何技能", JSON.stringify(quietCasts.slice(0, 3)));

    // 位置冻结：这一段窗口里 BOSS 的坐标必须一动不动。
    // **别把「没有 AI 帧」当成失败**：广播只发有变化的怪（位置 / 移动标记 / 血量任一变了才发），
    // 被定住的怪坐标不变、玩家也没打它，于是整段窗口里它根本不该出现在帧里 ——
    // 那恰好是最强的那种证据。所以判据是「窗口前后的坐标一致」，帧数只作补充说明。
    const frozenAfter = session.latestAi(boss.instanceId, 0);
    const frozenShift =
      frozenBefore && frozenAfter ? Math.hypot(frozenAfter.x - frozenBefore.x, frozenAfter.y - frozenBefore.y) : NaN;
    const frozenEntries = session.aiEntries(boss.instanceId, stillWindow);
    check(
      !!frozenBefore && !!frozenAfter && frozenShift <= 3,
      "眩晕期间坐标冻结（被定住的怪不会一边「不能动」一边飘；3.5 秒不拦它够走 1000px）",
      Number.isFinite(frozenShift)
        ? `位移 ${frozenShift.toFixed(2)}px（窗口内 ${frozenEntries.length} 条位置帧 —— 0 条就是「什么都没变」）`
        : "没取到 BOSS 的坐标",
    );
    //#endregion

    //#region 汇总
    console.log(`\n===== e2e-status：${passed} 条通过 / ${failed} 条失败 =====`);
    if (failed > 0) {
      console.log("失败清单：");
      for (const label of failures) console.log(`  - ${label}`);
      console.log("\n=== 服务端日志尾部 ===");
      console.log(server.logs().slice(-3_000));
      process.exitCode = 1;
    }
    //#endregion
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (server.child.exitCode === null && !server.child.signalCode) {
      server.child.kill("SIGTERM");
      await sleep(300);
      if (server.child.exitCode === null && !server.child.signalCode) server.child.kill("SIGKILL");
    }
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
})();
