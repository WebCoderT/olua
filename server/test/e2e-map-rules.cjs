#!/usr/bin/env node
/**
 * e2e：地图规则接入（#812 / docs/20 §2.2 + §5.5）
 *
 * ===========================================================================
 * 这一套验什么
 * ===========================================================================
 * `map_rules` 表在 #809 就建好了（15 列），但**一个字段都没接进链路**。这一刀只接三项：
 *
 * - `expRate`：击杀经验 × 倍率（**队友分成同口径**）；
 * - `dropRate`：乘在掉落表的 `chance` 闸上，封顶 1；
 * - `allowDrop`：false = 这张图的怪一件都不掉。
 *
 * 另加两个「不该悄悄坏掉」的守点：
 * - 规则行不存在（inherited）= 全默认，且与 `DEFAULT_MAP_RULES` **逐字段**相等；
 * - 客户端快照里带上 `maxPlayersPerRoom` / `maxChannels` / `transferCostMoney` 三项
 *   （**倍率不进快照** —— 否则客户端算的经验与服务端给的迟早会漂）。
 *
 * ===========================================================================
 * 为什么经验只断「两倍关系」，不断具体数值
 * ===========================================================================
 * 经验基数由策划调（`growth_scalars.expGain.*`），把「杀掉一只要给 40 点」写进断言，
 * 策划调一次曲线就假红。所以做法是：**同一把尺子量两次** —— 两个新号（同为 1 级、0 经验）
 * 打**同 key 的怪**，一个在 `expRate=1` 下打、一个在 `expRate=2` 下打，比较两次的 `exp`。
 * 输入完全相同，只有倍率不同，于是 `exp2 === exp1 × 2` 是这条代码路径的恒等式，
 * 而不是抄了一份配置表。
 *
 * `expRate = 0` 的用例是纯存在性断言：`reward.exp === 0` 且没有升级 —— 不依赖任何数值。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { placeRolesAt } = require("./lib/place-role.cjs");
const { paceCast, sleep } = require("./lib/cast-pace.cjs");
const WebSocket = require("ws");

const SERVER_DIR = path.resolve(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

const ADMIN_ZONE = 1;
const ADMIN_CODE = "olua-e2e-map-rules-admin";
const MAP_ID = "1";

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

const waitFor = async (label, predicate, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(25);
  }
  check(false, `${label}（等待超时）`);
  return last;
};

async function startServer(dbPath, port) {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ENTRY], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      API_PREFIX: "api",
      DB_PATH: dbPath,
      JWT_SECRET: "e2e-map-rules-secret",
      JWT_EXPIRES_IN: "1h",
      ADMIN_REGISTER_CODE: ADMIN_CODE,
      LOG_REQUESTS: "false",
      WORLD_TICK_MS: "300",
      WORLD_PERSIST_MS: "500",
      // 每段都要重新打同一种怪：重生越快越省事（这一套打的是「同 key」，不是同一只实例）
      WORLD_RESPAWN_MS: "1200",
      WORLD_MAP_IDLE_MS: "0",
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
      if (response.ok) return { baseUrl, port, child, logs: () => chunks.join("") };
    } catch {
      /* 还没起来 */
    }
    await sleep(100);
  }
  throw new Error("等待服务启动超时");
}

async function stopServer(server) {
  if (server.child.exitCode === null && !server.child.signalCode) server.child.kill("SIGTERM");
  await sleep(300);
  if (server.child.exitCode === null && !server.child.signalCode) server.child.kill("SIGKILL");
  await sleep(200);
}

async function api(baseUrl, method, route, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.zoneId !== undefined) headers["X-Zone-Id"] = String(options.zoneId);
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

/** 一条会话化的连接（只要 world / settle 两类帧） */
function connect(url) {
  const socket = new WebSocket(url);
  const session = {
    socket,
    opened: false,
    worlds: [],
    settles: [],
    async joinWorld(mapId, timeoutMs = 10_000) {
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
    async waitSettle(castId, timeoutMs = 5_000) {
      return waitFor(
        `castId=${castId} 的 settle`,
        async () => {
          const hits = session.settles.filter((frame) => frame.castId === castId);
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
      if (frame.type === "world") session.worlds.push(frame.data);
      if (frame.type === "settle") session.settles.push(frame.data);
    } catch {
      /* 非 JSON 帧不记 */
    }
  });
  socket.on("error", () => {});
  return session;
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-map-rules-${Date.now()}.db`);
  const port = await freePort();
  const server = await startServer(dbPath, port);
  try {
    const { baseUrl } = server;

    // 权威默认值直接读 dist（不手抄一份进测试）：`DEFAULT_MAP_RULES` 改了两边一起变
    const { DEFAULT_MAP_RULES } = require(path.join(SERVER_DIR, "dist", "database", "repositories", "map-rule.repository.js"));
    const { scaleExp, scaleDropChance } = require(path.join(SERVER_DIR, "dist", "modules", "realtime", "combat-settlement.service.js"));

    //#region 准备

    group("准备：管理员 / 三个新号（同为 1 级 0 经验）/ 都在图 1");

    await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "rules_admin", password: "Rules#12345", registerCode: ADMIN_CODE },
    });
    const adminLogin = await api(baseUrl, "POST", "admin/auth/login", {
      body: { zoneId: ADMIN_ZONE, username: "rules_admin", password: "Rules#12345" },
    });
    const adminToken = adminLogin.data && adminLogin.data.token;
    check(!!adminToken, "准备：管理员已登录", adminLogin.message);

    async function newPlayer(name) {
      const registered = await api(baseUrl, "POST", "auth/register", { body: { username: name, password: "pass1234" } });
      const token = registered.data && registered.data.token;
      const created = await api(baseUrl, "POST", "roles", { token, body: { name, occupation: "1", sex: "1" } });
      // #859：没有位置记录的新号只准进新手村 —— 必须**先建号再摆位**（摆一个还不存在的角色名等于没摆）
      placeRolesAt(dbPath, MAP_ID, [name]);
      const ticket = await api(baseUrl, "POST", "realtime/ticket", { token });
      const session = connect(`${baseUrl.replace("http", "ws")}/api/realtime?ticket=${encodeURIComponent(ticket.data.ticket)}`);
      await waitFor(`${name} 握手成功`, async () => (session.opened ? session : null));
      return { token, roleId: created.data && created.data.id, name, session };
    }

    const [alpha, beta, gamma] = [await newPlayer("rules_a"), await newPlayer("rules_b"), await newPlayer("rules_c")];

    const worlds = await Promise.all([alpha.session.joinWorld(MAP_ID), beta.session.joinWorld(MAP_ID), gamma.session.joinWorld(MAP_ID)]);
    check(
      worlds.every((world) => world && world.mapId === MAP_ID),
      "准备：三个号都进了图 1",
      JSON.stringify(worlds.map((world) => world && world.mapId)),
    );

    /** 读 / 存规则（GET 拿全量再整份提交 —— 与页面同一个口径，15 个字段不许漏） */
    const rulesOf = async () => {
      const response = await api(baseUrl, "GET", `admin/maps/${MAP_ID}/rules`, { token: adminToken, zoneId: ADMIN_ZONE });
      return response && response.data;
    };
    const saveRules = async (patch) => {
      const current = await rulesOf();
      const body = {
        expRate: current.expRate,
        dropRate: current.dropRate,
        moneyRate: current.moneyRate,
        allowPk: current.allowPk,
        allowAutoBattle: current.allowAutoBattle,
        allowRecall: current.allowRecall,
        allowDrop: current.allowDrop,
        maxPlayersPerRoom: current.maxPlayersPerRoom,
        maxChannels: current.maxChannels,
        transferCostMoney: current.transferCostMoney,
        transferCooldownMs: current.transferCooldownMs,
        denyTransferInCombat: current.denyTransferInCombat,
        respawnMsOverride: current.respawnMsOverride,
        simulateWhenEmpty: current.simulateWhenEmpty,
        ...patch,
      };
      const response = await api(baseUrl, "PATCH", `admin/maps/${MAP_ID}/rules`, {
        token: adminToken,
        zoneId: ADMIN_ZONE,
        body,
      });
      return response && response.data;
    };

    /** 把某只怪的掉落改成「必掉 1 件」（picks 1 × chance 1 → 结果确定，掉落倍率才量得出来） */
    const patchGuaranteedDrop = (monsterKey) =>
      api(baseUrl, "PATCH", `admin/monster-drops/${monsterKey}`, {
        token: adminToken,
        zoneId: ADMIN_ZONE,
        body: { tableId: null, picks: 1, entries: [{ goodId: "drug_hp_1", weight: 100, chance: 1, count: [1, 1] }], bindDrops: false },
      });

    let castSeq = 0;

    /**
     * 打一只怪（可指定怪物 key），返回 `{ exp, drops, monsterKey, level... }`
     *
     * 找不到指定的 key 就静默重试（重生 1200ms 一拍）：调用方拿 `null` 去断言「这一枪没打成」，
     * 不在准备阶段就判失败 —— 那样会把「怪还没刷出来」说成「倍率没生效」。
     */
    const killOne = async (player, wantedKey = null) => {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const snapshot = await player.session.joinWorld(MAP_ID);
        const monsters = (snapshot && snapshot.monsters) || [];
        const mob = monsters.find((monster) => monster.alive && (!wantedKey || monster.monsterKey === wantedKey));
        if (mob) {
          const stand = JSON.stringify({ type: "pos", data: { mapId: MAP_ID, x: mob.x, y: mob.y, hp: 100 } });
          player.session.socket.send(stand);
          player.session.socket.send(stand);
          for (let i = 0; i < 60; i += 1) {
            await paceCast();
            const castId = ++castSeq;
            player.session.socket.send(
              JSON.stringify({ type: "cast", data: { castId, skillId: "1000", targetId: mob.instanceId, monsterKey: mob.monsterKey } }),
            );
            const settle = await player.session.waitSettle(castId);
            if (!settle || !settle.ok) return null;
            if (settle.killed) return { ...settle.reward, monsterKey: mob.monsterKey, settle };
          }
          return null;
        }
        await sleep(400);
      }
      return null;
    };

    //#endregion

    //#region 一、规则行不存在 = 全默认 + 三项进快照

    group("一、inherited：一行都没有时全默认，且与 DEFAULT_MAP_RULES 逐字段相等");

    const inherited = await rulesOf();
    check(!!inherited && inherited.inherited === true, "A：没配过的图 `inherited: true`", JSON.stringify(inherited && inherited.inherited));
    const driftedFields = inherited
      ? Object.entries(DEFAULT_MAP_RULES).filter(([key, value]) => inherited[key] !== value).map(([key]) => key)
      : ["(no data)"];
    check(
      driftedFields.length === 0,
      "A：15 个字段与 dist 里的 DEFAULT_MAP_RULES 逐字段相等（不手抄默认值）",
      driftedFields.join(","),
    );

    group("一、客户端快照：只带三项，倍率一个都不带");

    const snapshotResponse = await api(baseUrl, "GET", "game-config", { token: alpha.token });
    const snapshotMap = ((snapshotResponse && snapshotResponse.data && snapshotResponse.data.maps) || []).find(
      (row) => row && row.id === MAP_ID,
    );
    check(
      !!snapshotMap && snapshotMap.maxPlayersPerRoom === DEFAULT_MAP_RULES.maxPlayersPerRoom,
      "B：快照里的人数上限 = 出厂默认",
      JSON.stringify(snapshotMap && snapshotMap.maxPlayersPerRoom),
    );
    check(
      !!snapshotMap && snapshotMap.maxChannels === DEFAULT_MAP_RULES.maxChannels,
      "B：快照里的分线数 = 出厂默认",
      JSON.stringify(snapshotMap && snapshotMap.maxChannels),
    );
    check(
      !!snapshotMap && snapshotMap.transferCostMoney === DEFAULT_MAP_RULES.transferCostMoney,
      "B：快照里的传送费 = 出厂默认",
      JSON.stringify(snapshotMap && snapshotMap.transferCostMoney),
    );
    check(
      !!snapshotMap && !("expRate" in snapshotMap) && !("dropRate" in snapshotMap),
      "B：倍率**不在**客户端快照里（只在服务端结算时乘）",
      JSON.stringify(Object.keys(snapshotMap || {}).filter((key) => key.includes("Rate"))),
    );

    group("一、保存后 inherited 变 false，15 个字段回读一致");

    // 6 个开关**显式**给一遍：`whitelist: true` 会剥掉「没有校验装饰器」的入参，
    // #809 那一版 DTO 只在布尔字段上挂 `@ApiProperty` → 保存一次就把所有开关静默写成 0。
    // 这一条正是抓那个 bug 的守点，别把它简化成只比数字。
    const savedAll = await saveRules({
      expRate: 1.5,
      dropRate: 1,
      maxPlayersPerRoom: 42,
      maxChannels: 2,
      transferCostMoney: 7,
      allowPk: false,
      allowAutoBattle: true,
      allowRecall: true,
      allowDrop: true,
      denyTransferInCombat: false,
      simulateWhenEmpty: false,
    });
    check(!!savedAll && savedAll.inherited === false, "C：保存后 `inherited: false`", JSON.stringify(savedAll && savedAll.inherited));
    const readBack = await rulesOf();
    const comparedFields = [
      "expRate",
      "dropRate",
      "maxPlayersPerRoom",
      "maxChannels",
      "transferCostMoney",
      "allowPk",
      "allowAutoBattle",
      "allowRecall",
      "allowDrop",
      "denyTransferInCombat",
      "simulateWhenEmpty",
    ];
    const mismatched = comparedFields.filter((key) => readBack[key] !== savedAll[key]);
    check(mismatched.length === 0, "C：写进去的 11 个字段回读一致（整份覆盖没丢字段、开关没被静默关掉）", mismatched.join(","));
    check(readBack.updatedBy === "rules_admin", "C：落款记下是谁改的", String(readBack.updatedBy));

    // 后面的倍率用例回到 1，避免这一段的 1.5 干扰
    await saveRules({ expRate: 1, maxPlayersPerRoom: DEFAULT_MAP_RULES.maxPlayersPerRoom, maxChannels: 1, transferCostMoney: 0 });

    //#endregion

    //#region 二、经验倍率

    group("二、expRate：同一把尺子量两次（同 key 的怪，两个 1 级 0 经验的新号）");

    const baseline = await killOne(alpha);
    check(!!baseline, "A：alpha 在 expRate=1 下打死一只", baseline ? baseline.monsterKey : "(没打成)");
    check(!!baseline && baseline.exp > 0, "A：这一枪有经验（否则后面的两倍关系无从谈起）", String(baseline && baseline.exp));

    const monsterKey = baseline && baseline.monsterKey;
    // 两个号必须是「同 key 的怪」：怪物等级来自 monsters 表，key 一样等级才一样
    check(!!monsterKey, "A：记下被打死那只的 key（后面要求同 key）", String(monsterKey));

    await saveRules({ expRate: 2 });
    const doubled = monsterKey ? await killOne(beta, monsterKey) : null;
    check(!!doubled, "B：beta 在 expRate=2 下打死同 key 的一只", doubled ? doubled.monsterKey : "(没打成)");
    check(
      !!(doubled && baseline) && doubled.exp === baseline.exp * 2,
      "B：exp 是 1 倍图里的两倍（两个号同级同经验，只有倍率不同）",
      JSON.stringify({ one: baseline && baseline.exp, two: doubled && doubled.exp }),
    );

    group("二、expRate = 0：不给经验（存在性断言，不依赖任何数值）");

    await saveRules({ expRate: 0 });
    const muted = monsterKey ? await killOne(gamma, monsterKey) : null;
    check(!!muted, "C：gamma 在 expRate=0 下打死一只", muted ? muted.monsterKey : "(没打成)");
    check(!!muted && muted.exp === 0, "C：结算里 exp 恒 0", String(muted && muted.exp));
    check(!!muted && muted.leveledUp === false, "C：也没有升级", JSON.stringify(muted && muted.leveledUp));

    await saveRules({ expRate: 1 });

    //#endregion

    //#region 三、掉落倍率与开关

    group("三、allowDrop / dropRate：必掉 1 件的怪，逐档验证");

    check(!!monsterKey, "准备：沿用同一只怪的 key（掉落表按 key 配）", String(monsterKey));
    const patchedDrop = monsterKey ? await patchGuaranteedDrop(monsterKey) : null;
    check(
      !!(patchedDrop && patchedDrop.data && Array.isArray(patchedDrop.data.entries) && patchedDrop.data.entries.length === 1),
      "准备：这只怪的掉落已改成「必掉 1 件」（PATCH 回读确认，否则后面的空数组什么也证明不了）",
      JSON.stringify(patchedDrop && (patchedDrop.message || patchedDrop.data)),
    );

    const normalDrop = monsterKey ? await killOne(alpha, monsterKey) : null;
    check(
      !!(normalDrop && normalDrop.drops && normalDrop.drops.length === 1),
      "A：dropRate=1 且 allowDrop=true → 掉 1 件（必掉表）",
      JSON.stringify(normalDrop && normalDrop.drops),
    );

    await saveRules({ dropRate: 0 });
    const noChance = monsterKey ? await killOne(beta, monsterKey) : null;
    check(
      !!(noChance && noChance.drops && noChance.drops.length === 0),
      "B：dropRate=0 → 一件都不掉（chance 被乘成 0）",
      JSON.stringify(noChance && noChance.drops),
    );

    await saveRules({ dropRate: 1, allowDrop: false });
    const noDropMap = monsterKey ? await killOne(gamma, monsterKey) : null;
    check(
      !!(noDropMap && noDropMap.drops && noDropMap.drops.length === 0),
      "C：allowDrop=false → 一件都不掉（这张图不掉东西）",
      JSON.stringify(noDropMap && noDropMap.drops),
    );

    await saveRules({ dropRate: 3, allowDrop: true });
    const tripled = monsterKey ? await killOne(alpha, monsterKey) : null;
    check(
      !!(tripled && tripled.drops && tripled.drops.length === 1),
      "D：dropRate=3 时 chance=1 的条目仍是**必掉 1 件**（封顶 1，不会变成抽三次）",
      JSON.stringify(tripled && tripled.drops),
    );

    await saveRules({ dropRate: 1 });

    //#endregion

    //#region 四、纯函数（不走真实击杀，直接对表）

    group("四、纯函数：倍率怎么算，钉在这里");

    check(scaleExp(10, 2) === 20, "scaleExp(10, 2) = 20", String(scaleExp(10, 2)));
    check(scaleExp(10, 0) === 0, "scaleExp(10, 0) = 0（活动图不给经验）", String(scaleExp(10, 0)));
    check(scaleExp(7, 1.5) === 10, "scaleExp(7, 1.5) = 10（取整向下）", String(scaleExp(7, 1.5)));
    check(scaleExp(10, -3) === 0, "scaleExp(10, -3) = 0（负数倍率当 0，不反扣）", String(scaleExp(10, -3)));

    check(scaleDropChance(0.5, 2) === 1, "scaleDropChance(0.5, 2) = 1（封顶）", String(scaleDropChance(0.5, 2)));
    check(scaleDropChance(0.5, 0.5) === 0.25, "scaleDropChance(0.5, 0.5) = 0.25", String(scaleDropChance(0.5, 0.5)));
    check(scaleDropChance(0.3, 10) === 1, "scaleDropChance(0.3, 10) = 1（封顶，不是 3.0）", String(scaleDropChance(0.3, 10)));
    check(scaleDropChance(1, 0.1) === 0.1, "scaleDropChance(1, 0.1) = 0.1（必掉也吃倍率）", String(scaleDropChance(1, 0.1)));
    check(scaleDropChance(1, 0) === 0, "scaleDropChance(1, 0) = 0（掉率 0 就是不掉）", String(scaleDropChance(1, 0)));

    //#endregion

    console.log(`\n${failed === 0 ? "✅" : "❌"} 地图规则（map_rules 接入）：${passed} 条通过 / ${failed} 条失败`);
    if (failed > 0) {
      console.log("\n失败项：");
      failures.forEach((item) => console.log(`  - ${item}`));
      console.log("\n服务端日志（尾部）：");
      console.log(server.logs().split("\n").slice(-40).join("\n"));
      // 排查用：`E2E_DEBUG_LOGS=1` 打全量服务端日志（默认只留 40 行，免得刷屏）
      if (process.env.E2E_DEBUG_LOGS === "1") console.log(server.logs());
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await stopServer(server);
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
})();
