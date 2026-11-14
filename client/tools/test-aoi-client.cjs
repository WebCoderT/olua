#!/usr/bin/env node
/**
 * AOI 客户端落点单测（client/tools/test-aoi-client.cjs，issue #810）
 *
 * 服务端把广播按格子裁了之后，客户端多了一对「进出视野」的帧（`entityEnter` / `entityLeave`）。
 * 这一套盯的就是这对帧的**落地链条**，从协议形状到拆建节点：
 *
 * A. 协议两端同形：server 的 `RealtimeEntityEnterData` / `RealtimeEntityLeaveData` 与 client 的
 *    `EntityEnterFrame` / `EntityLeaveFrame` 字段逐一对齐（两份定义是手抄的，漂移了都能各自编译过）
 * B. 帧能到达落点：dispatch 校验两个数组 → 两个 on* 出口 → RealtimeClient 路由 → Game.ts 接线/解绑
 * C. 落点语义：enter 是**幂等 upsert**（重复 enter 不能重建节点）、leave **不演死亡**（它没死）、
 *    world 快照里「缺席」也不再演死亡（裁剪后缺席多数只是「在视野外」）
 *
 * 表现层依赖 cc 引擎（Node / UITransform / Animation），沙箱起不来 —— 与 test-other-player.cjs
 * 同一口径，这里只做源码契约断言；行为正确性由 server/test/e2e-aoi.cjs 与实机双窗口验证。
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");
/** PROJECT_ROOT 是 client/ 目录，服务端与根目录下的文件要往上走一层（与 test-other-player.cjs 同口径） */
const readRepo = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, "..", rel), "utf8");

/** 去注释（行注释与块注释都剥掉，字段抽取与「方法体里有没有某句」只看代码形状） */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** 从一个 interface 块里抽取字段名 + 可选性 */
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

/**
 * 取一个方法（或函数）的**方法体**源码
 *
 * 按签名的正则找到起点，再从第一个 `{` 起做括号配对 —— 只在这一段里找断言目标，
 * 避免「同一个词在别的方法里出现」造成的假绿（源码断言必须钉方法体，不能全文件搜）。
 */
function bodyOf(src, signature) {
  const m = signature.exec(src);
  if (!m) return null;
  const open = src.indexOf("{", m.index + m[0].length - 1);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

const SERVER_PROTOCOL = "server/src/modules/realtime/realtime.protocol.ts";
const CLIENT_CHANNEL = "assets/ui/utils/net/CombatChannel.ts";

try {
  const serverSrc = stripComments(readRepo(SERVER_PROTOCOL));
  const channelSrc = stripComments(read(CLIENT_CHANNEL));
  const realtimeSrc = stripComments(read("assets/ui/utils/net/RealtimeClient.ts"));
  const gameSrc = stripComments(read("assets/ui/Game.ts"));
  const monsterSrc = stripComments(read("assets/ui/core/MonsterManager.ts"));
  const otherSrc = stripComments(read("assets/ui/core/OtherPlayerManager.ts"));

  //#region A. 协议两端同形（#810）

  const PAIRS = [
    ["RealtimeEntityEnterData", "EntityEnterFrame"],
    ["RealtimeEntityLeaveData", "EntityLeaveFrame"],
  ];
  for (const [serverName, clientName] of PAIRS) {
    const serverFields = fieldsOfInterface(serverSrc, serverName);
    const clientFields = fieldsOfInterface(channelSrc, clientName);
    check(serverFields !== null, `服务端 ${serverName} 存在（载荷单独命名，才能按接口名抽字段）`);
    check(clientFields !== null, `客户端 ${clientName} 存在`);
    if (serverFields && clientFields) {
      check(
        JSON.stringify(serverFields) === JSON.stringify(clientFields),
        `${clientName} ↔ ${serverName} 字段清单一致（期望 ${JSON.stringify(serverFields)}，实际 ${JSON.stringify(clientFields)}）`,
      );
    }
  }
  // enter 的怪条目**复用 world 快照的形状**：客户端拿它直接建节点，不需要第二套字段映射
  const enterData = fieldsOfInterface(serverSrc, "RealtimeEntityEnterData") ?? [];
  check(enterData.includes("monsters") && enterData.includes("players"), "enter 载荷按类型分两个数组（monsters / players）");
  const enterBody = serverSrc.slice(serverSrc.indexOf("interface RealtimeEntityEnterData"));
  check(
    /monsters: RealtimeWorldMonster\[\]/.test(enterBody.slice(0, 600)),
    "enter 的怪物条目复用 RealtimeWorldMonster（进图建节点与走进视野建节点是同一段代码）",
  );
  check(
    /players: RealtimePlayerEntry\[\]/.test(enterBody.slice(0, 600)),
    "enter 的玩家条目复用 RealtimePlayerEntry（与 players 帧同一形状，upsert 无需分支）",
  );

  //#endregion

  //#region B. 帧能到达落点（dispatch → 出口 → 路由 → 接线）

  check(/static onEntityEnter: \(\(data: EntityEnterFrame\) => void\) \| null = null;/.test(channelSrc), "CombatChannel 有 onEntityEnter 出口");
  check(/static onEntityLeave: \(\(data: EntityLeaveFrame\) => void\) \| null = null;/.test(channelSrc), "CombatChannel 有 onEntityLeave 出口");

  const dispatchEnter = bodyOf(channelSrc, /static dispatchEntityEnter\(data: unknown\): void/);
  const dispatchLeave = bodyOf(channelSrc, /static dispatchEntityLeave\(data: unknown\): void/);
  check(dispatchEnter !== null, "dispatchEntityEnter 存在");
  check(dispatchLeave !== null, "dispatchEntityLeave 存在");
  check(
    !!dispatchEnter && /Array\.isArray\(frame\.monsters\)/.test(dispatchEnter) && /Array\.isArray\(frame\.players\)/.test(dispatchEnter),
    "dispatchEntityEnter 校验两个数组都在（畸形帧直接丢）",
  );
  check(
    !!dispatchLeave && /Array\.isArray\(frame\.monsters\)/.test(dispatchLeave) && /Array\.isArray\(frame\.players\)/.test(dispatchLeave),
    "dispatchEntityLeave 校验两个数组都在",
  );
  check(!!dispatchEnter && /if \(!this\.onEntityEnter\) return;/.test(dispatchEnter), "dispatchEntityEnter 没接线时静默返回（旧构建收到这帧是正常的）");
  check(!!dispatchLeave && /if \(!this\.onEntityLeave\) return;/.test(dispatchLeave), "dispatchEntityLeave 没接线时静默返回");

  check(
    /frame\.type === "entityEnter"[\s\S]{0,180}CombatChannel\.dispatchEntityEnter\(frame\.data\)/.test(realtimeSrc),
    "RealtimeClient 把 entityEnter 路由到 dispatchEntityEnter",
  );
  check(
    /frame\.type === "entityLeave"[\s\S]{0,180}CombatChannel\.dispatchEntityLeave\(frame\.data\)/.test(realtimeSrc),
    "RealtimeClient 把 entityLeave 路由到 dispatchEntityLeave",
  );

  const enterWire = bodyOf(gameSrc, /CombatChannel\.onEntityEnter = \(frame\) =>/);
  check(enterWire !== null, "Game.ts 接线 onEntityEnter");
  check(
    !!enterWire && /MonsterManager\.applyEntityEnter\(frame\)/.test(enterWire) && /OtherPlayerManager\.applyEntityEnter\(frame\.players/.test(enterWire),
    "entityEnter 分发给两个管理器（怪与玩家各自认领自己那半）",
  );
  const leaveWire = bodyOf(gameSrc, /CombatChannel\.onEntityLeave = \(frame\) =>/);
  check(
    !!leaveWire && /MonsterManager\.applyEntityLeave\(frame\)/.test(leaveWire) && /OtherPlayerManager\.applyEntityLeave\(frame\.players\)/.test(leaveWire),
    "entityLeave 分发给两个管理器",
  );
  check(
    /CombatChannel\.onEntityEnter = null;/.test(gameSrc) && /CombatChannel\.onEntityLeave = null;/.test(gameSrc),
    "场景卸载时两个出口都置空（与 onPlayers / onMonsterAi 同口径）",
  );

  //#endregion

  //#region C. 落点语义（upsert / 不演死亡 / 缺席不演死亡）

  const monsterEnter = bodyOf(monsterSrc, /static applyEntityEnter\(frame: EntityEnterFrame\)/);
  const monsterLeave = bodyOf(monsterSrc, /static applyEntityLeave\(frame: EntityLeaveFrame\)/);
  const despawn = bodyOf(monsterSrc, /private static despawn\(instanceId: string\)/);
  check(monsterEnter !== null, "MonsterManager.applyEntityEnter 存在");
  check(
    !!monsterEnter && /if \(!entry\.alive\) continue;/.test(monsterEnter),
    "enter 跳过死亡中的怪（建出来会是一只打不死的怪）",
  );
  check(
    !!monsterEnter && /if \(this\.instanceIndex\.has\(entry\.instanceId\)\) continue;/.test(monsterEnter),
    "enter 对已在场的实例是空操作（进图那份全量 world 之后还会重复 enter 一遍）",
  );
  check(
    !!monsterEnter && /this\.spawn\(entry\.monsterKey, new Vec3\(entry\.x, entry\.y\), entry\.instanceId, entry\.hp\)/.test(monsterEnter),
    "enter 用服务端实例 id 建节点（实例身份不本地发牌）",
  );
  check(!!monsterLeave && !/applyDamage\(/.test(monsterLeave), "leave **不演死亡**（怪没死，只是走远了）");
  check(!!monsterLeave && /this\.despawn\(instanceId\)/.test(monsterLeave), "leave 走 despawn");
  check(despawn !== null, "MonsterManager.despawn 存在（拆节点唯一去处）");
  check(
    !!despawn &&
      /this\.instanceIndex\.delete\(instanceId\)/.test(despawn) &&
      /this\.monsterMap\.delete\(node\)/.test(despawn) &&
      /this\.statusEffects\.delete\(instanceId\)/.test(despawn) &&
      /CursorManager\.unregisterHover\(node\)/.test(despawn),
    "despawn 把四本账一起清（实例索引 / 数据 / 状态特效 / 悬停注册）",
  );

  // world 快照里「缺席」：裁剪之后多数只是「在视野外」，不能再演死亡
  const worldBody = bodyOf(monsterSrc, /static applyWorldState\(snapshot: WorldSnapshot\)/);
  check(worldBody !== null, "MonsterManager.applyWorldState 存在");
  check(
    !!worldBody && /if \(seen\.has\(instanceId\)\) continue;\s*this\.despawn\(instanceId\);/.test(worldBody),
    "world 快照里缺席的怪走 despawn（裁剪后缺席 ≠ 死亡，演死亡会让远处的怪凭空倒地）",
  );
  check(
    !!worldBody && !/if \(seen\.has\(instanceId\)\) return;\s*const monster = this\.monsterMap\.get\(node\);\s*if \(monster && monster\.hp > 0\) this\.applyDamage\(node, monster, 0, 0, true\);/.test(worldBody),
    "旧的「缺席即死亡」兜底已删除（否则 AOI 裁剪会误杀视野外的怪）",
  );

  const otherEnter = bodyOf(otherSrc, /static applyEntityEnter\(players: PlayerEntry\[\], selfAccountId: string\): void/);
  const otherLeave = bodyOf(otherSrc, /static applyEntityLeave\(accountIds: string\[\]\): void/);
  check(otherEnter !== null, "OtherPlayerManager.applyEntityEnter 存在");
  check(
    !!otherEnter && /if \(entry\.a === selfAccountId\) continue;/.test(otherEnter) && /this\.upsert\(entry\)/.test(otherEnter),
    "玩家 enter 跳过自己并复用 upsert（首次 / 更新同一段代码）",
  );
  check(
    !!otherEnter && /if \(players\.length === 0\) return;/.test(otherEnter),
    "玩家 enter 空数组直接返回（不白拉社交快照）",
  );
  check(
    !!otherLeave && /this\.remove\(accountId\)/.test(otherLeave),
    "玩家 leave 与 players 帧的 left 收敛到同一个 remove",
  );

  //#endregion

  finish("PASS：AOI 客户端落点（协议同形 / 帧链路 / upsert 与不演死亡）全部通过");
} catch (error) {
  fail(`AOI 客户端单测异常：${error.message}`);
  process.exitCode = 1;
}
