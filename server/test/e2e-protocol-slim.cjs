#!/usr/bin/env node
/**
 * 协议契约专项 e2e（server/test/e2e-protocol-slim.cjs，issue #768）
 *
 * ## 这一套在测什么
 *
 * #768 的帧瘦身把 monster-ai / players 两帧的字段名改成了缩写（`i`=instanceId、
 * `m`=maxHp、`mv`=moving……完整映射表见 docs/11）。协议类型在服务端
 * `realtime.protocol.ts` 与客户端 `CombatChannel.ts` **物理上是两份定义**，
 * 改名必须同批 —— 这里用源码级断言把两侧行段钉住，防止以后单侧漂移：
 *
 * 1. **两侧接口逐字段比对**：按接口名抽取两侧的字段清单（strip 掉注释与可选标记），
 *    要求完全一致（含可选性）。比 JSON 相等弱、比 grep 单串强 —— 加字段/删字段/改可选都会红；
 * 2. **world 帧保持原名**：`RealtimeWorldMonster` / `WorldMonsterSnapshot` 仍是 `instanceId`
 *    （进图一次性，瘦身收益低，拍板不改）；
 * 3. **提频默认值钉在源码上**：服务端两个广播节拍兜底 100（configuration.ts + 两个服务）、
 *    env 示例登记 100；客户端上报节拍 `POSITION_INTERVAL = 100` 且 `sendPosition` 取整。
 *
 * 纯静态断言，不起服务端（协议形状的运行时行为由各 e2e 照旧覆盖）。
 *
 * 用法：npm run test:e2e:protocol-slim（无需 build）
 */
const fs = require("node:fs");
const path = require("node:path");

const SERVER_DIR = path.join(__dirname, "..");
const REPO_DIR = path.join(SERVER_DIR, "..");

const SERVER_PROTOCOL = path.join(SERVER_DIR, "src", "modules", "realtime", "realtime.protocol.ts");
const CLIENT_CHANNEL = path.join(REPO_DIR, "client", "assets", "ui", "utils", "net", "CombatChannel.ts");

let passed = 0;
let failed = 0;
const failures = [];

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
  return check(JSON.stringify(actual) === JSON.stringify(expected), `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}

function group(label) {
  console.log(`\n▶ ${label}`);
}

/** 去注释后的源码（行注释与块注释都剥掉，字段抽取只看代码形状） */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** 从一个 interface 块里抽取字段名 + 可选性（`name?` 记作 `name?`） */
function fieldsOfInterface(src, interfaceName) {
  const start = src.indexOf(`interface ${interfaceName} `);
  if (start < 0) return null;
  const open = src.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = src.slice(open + 1, end);
  const fields = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    const m = /^(readonly\s+)?(\w+)(\?)?:/.exec(line);
    if (m) fields.push(`${m[2]}${m[3] ?? ""}`);
  }
  return fields;
}

const serverSrc = stripComments(fs.readFileSync(SERVER_PROTOCOL, "utf8"));
const clientSrc = stripComments(fs.readFileSync(CLIENT_CHANNEL, "utf8"));

(async () => {
  //#region 一、monster-ai / players 帧两侧接口逐字段一致（#768 缩写）

  group("一、两侧协议接口逐字段一致（服务端 realtime.protocol.ts ↔ 客户端 CombatChannel.ts）");
  const PAIRS = [
    ["RealtimeMonsterAiEntry", "MonsterAiEntry"],
    ["RealtimeMonsterHit", "MonsterHitEntry"],
    ["RealtimeMonsterCast", "MonsterCastEntry"],
    ["RealtimeMonsterKill", "MonsterKillEntry"],
    ["RealtimePlayerEntry", "PlayerEntry"],
    ["RealtimePlayerAppearance", "PlayerAppearance"],
    ["RealtimePlayerAction", "PlayerActionEntry"],
  ];
  for (const [serverName, clientName] of PAIRS) {
    const serverFields = fieldsOfInterface(serverSrc, serverName);
    const clientFields = fieldsOfInterface(clientSrc, clientName);
    check(serverFields !== null, `服务端 ${serverName} 存在`);
    check(clientFields !== null, `客户端 ${clientName} 存在`);
    if (serverFields && clientFields) {
      checkEqual(clientFields, serverFields, `${clientName} ↔ ${serverName} 字段清单一致`);
    }
  }

  //#endregion

  //#region 二、#768 缩写落在两侧接口里（字段名真的缩了，不是忘了改）

  group("二、缩写字段真的在两侧（抽查关键缩写）");
  const entry = fieldsOfInterface(serverSrc, "RealtimeMonsterAiEntry");
  const playerEntry = fieldsOfInterface(serverSrc, "RealtimePlayerEntry");
  const appearance = fieldsOfInterface(serverSrc, "RealtimePlayerAppearance");
  check(!!entry && entry.includes("i") && entry.includes("mv") && entry.includes("m"), "怪物条目缩写 i/mv/m 在服务端", JSON.stringify(entry));
  check(!!playerEntry && playerEntry.includes("a") && playerEntry.includes("n") && playerEntry.includes("ap"), "玩家条目缩写 a/n/ap 在服务端", JSON.stringify(playerEntry));
  check(!!appearance && appearance.includes("sx") && appearance.includes("c") && appearance.includes("w") && appearance.includes("f"), "外观缩写 sx/c/w/f 在服务端", JSON.stringify(appearance));

  //#endregion

  //#region 三、world 帧保持原名（拍板：进图一次性，不缩）

  group("三、world 帧保持原名（不参与 #768 瘦身）");
  const worldMonster = fieldsOfInterface(serverSrc, "RealtimeWorldMonster");
  check(!!worldMonster && worldMonster.includes("instanceId"), "服务端 RealtimeWorldMonster 仍是 instanceId（world 帧不缩）", JSON.stringify(worldMonster));
  const clientWorld = stripComments(fs.readFileSync(path.join(REPO_DIR, "client", "assets", "ui", "utils", "net", "CombatChannel.ts"), "utf8"));
  const clientWorldMonster = fieldsOfInterface(clientWorld, "WorldMonsterSnapshot");
  check(!!clientWorldMonster && clientWorldMonster.includes("instanceId"), "客户端 WorldMonsterSnapshot 仍是 instanceId（world 帧不缩）", JSON.stringify(clientWorldMonster));

  //#endregion

  //#region 四、提频默认值钉在源码上（#768：200 → 100）

  group("四、10Hz 默认值守门");
  const configSrc = fs.readFileSync(path.join(SERVER_DIR, "src", "config", "configuration.ts"), "utf8");
  const aiSrc = fs.readFileSync(path.join(SERVER_DIR, "src", "modules", "realtime", "monster-ai.service.ts"), "utf8");
  const presenceSrc = fs.readFileSync(path.join(SERVER_DIR, "src", "modules", "realtime", "player-presence.service.ts"), "utf8");
  const channelSrc = fs.readFileSync(CLIENT_CHANNEL, "utf8");
  const envExample = fs.readFileSync(path.join(SERVER_DIR, ".env.example"), "utf8");
  check(
    /MONSTER_AI_BROADCAST_MS\s*\?\?\s*100/.test(configSrc) && /PLAYER_SYNC_BROADCAST_MS\s*\?\?\s*100/.test(configSrc),
    "configuration.ts 两个广播节拍默认 100（env 可覆写）",
  );
  check(/monsterAiBroadcastMs"\)\s*\?\?\s*100/.test(aiSrc), "monster-ai.service.ts 兜底 100");
  check(/playerSyncBroadcastMs"\)\s*\?\?\s*100/.test(presenceSrc), "player-presence.service.ts 兜底 100");
  check(
    /MONSTER_AI_BROADCAST_MS=100/.test(envExample) && /PLAYER_SYNC_BROADCAST_MS=100/.test(envExample),
    ".env.example 登记 100（改默认必须改示例，静态审计盯这里）",
  );
  check(/POSITION_INTERVAL = 100/.test(channelSrc), "客户端上报节拍 POSITION_INTERVAL = 100（10Hz）");
  check(/Math\.round\(x\), y: Math\.round\(y\)/.test(channelSrc), "客户端 sendPosition 坐标整数化（#768 帧瘦身）");

  //#endregion

  console.log(`\n${failed === 0 ? "✅" : "❌"} 协议契约：${passed} 条通过 / ${failed} 条失败`);
  if (failed > 0) {
    console.log("\n失败项：");
    failures.forEach((item) => console.log(`  - ${item}`));
    process.exitCode = 1;
  }
})();
