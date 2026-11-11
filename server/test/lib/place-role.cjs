#!/usr/bin/env node
/**
 * 把角色摆到某张图（#859 之后 e2e 的准备动作）
 *
 * ## 为什么需要
 *
 * #859 之前，服务端对「还没有位置记录」的角色（`data.mapAt` 缺失 = 刚建号）**一律放行**，
 * 于是 e2e 里 1 级的角色可以直接 `worldJoin("1")`（10 级图）或 `worldJoin("2")`（40 级图）——
 * 那些套件测的是「进图之后」的东西，一直靠这条后门。洞堵上之后（没有位置记录只准进新手村），
 * 它们得先让服务端认为「这个人本来就在那张图」。
 *
 * 等价于运营在管理端 `PATCH /admin/roles/:id { onMap }`（它会同时写 `mapAt`）。
 * 这些套件里多数没有管理员账号，直接改库更省 —— 与 `e2e-world` 的 `seedSpawnAreas`
 * 同一取向：准备段造出来的状态不是被测逻辑。
 *
 * ## 用法
 *
 * ```js
 * const { placeRolesAt } = require("./lib/place-role.cjs");
 * placeRolesAt(dbPath, "1");               // 全部角色
 * placeRolesAt(dbPath, "2", ["combat_rwb"]); // 只摆这几个（按角色名）
 * ```
 *
 * 摆完服务端立刻看得见：`mapAt` 只从库里读（`RolesService.onlineRoleRow`），没有内存副本。
 */

const { DatabaseSync } = require("node:sqlite");

/**
 * @param {string} dbPath SQLite 文件
 * @param {string} mapId 目标地图 id
 * @param {string[]} [roleNames] 只摆这些角色（按 `roles.name`）；不传 = 摆全部
 * @returns {number} 实际改了几行
 */
function placeRolesAt(dbPath, mapId, roleNames) {
  const db = new DatabaseSync(dbPath);
  try {
    // 这是对**运行中服务端**的库做直写：服务端正握着写锁（世界持久化 / 存档落库）时，
    // 没有等待就直接抛「database is locked」—— 本机快、CI 慢，偶发假红（PR #924 分片 2）。
    // busy_timeout 让这次写入等服务端放锁；再兜一层重试防极端。
    db.exec("PRAGMA busy_timeout = 10000");
    const rows =
      roleNames && roleNames.length > 0
        ? db
            .prepare(`SELECT id, data FROM roles WHERE name IN (${roleNames.map(() => "?").join(",")})`)
            .all(...roleNames)
        : db.prepare("SELECT id, data FROM roles").all();
    let changed = 0;
    for (const row of rows) {
      let data;
      try {
        data = JSON.parse(row.data);
      } catch {
        // 存档坏掉的行不是准备段能修的，跳过
        continue;
      }
      if (!data || typeof data !== "object") continue;
      data.mapAt = mapId;
      for (let attempt = 1; ; attempt++) {
        try {
          db.prepare("UPDATE roles SET data = ? WHERE id = ?").run(JSON.stringify(data), row.id);
          break;
        } catch (error) {
          if (attempt >= 3 || !/locked/i.test(String(error && error.message))) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200 * attempt);
        }
      }
      changed += 1;
    }
    return changed;
  } finally {
    db.close();
  }
}

/**
 * 让角色「站在某个 NPC 旁边」（#862/#863 的距离校验）
 *
 * 服务端从 `role_positions` 读位置做距离判定，那张表只有实时进程会写（要真的进图并
 * 上报 `pos` 帧）。纯 HTTP 的套件没有这一步，于是准备段直接写一行 —— 与 `placeRolesAt`
 * 同一取向：**准备段造出来的状态不是被测逻辑**。
 *
 * 坐标取 `map_npcs` 的那一行（NPC 在哪就站哪），不写死数字：管理端挪了 NPC，这里跟着走。
 * 位置带时刻（`updated_at` = 现在），过 `QUEST_POS_STALE_MS`（10 秒）就自然失效 ——
 * 所以调用点要在真正发请求之前不久，别在准备段一次写完然后跑两分钟。
 *
 * @param {string} dbPath SQLite 文件
 * @param {string} mapId 目标地图 id（必须和 `map_npcs` 里那一行一致）
 * @param {string} npcId NPC id（`npcs` 表主键）
 * @param {string[]} [roleNames] 只摆这些角色（按 `roles.name`）；不传 = 摆全部
 * @returns {{cx: number, cy: number, count: number}} 摆到的坐标与行数
 */
function placeRolesNear(dbPath, mapId, npcId, roleNames) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    const spot = db.prepare("SELECT cx, cy FROM map_npcs WHERE map_id = ? AND npc_id = ?").get(mapId, npcId);
    if (!spot) {
      throw new Error(`map_npcs 里没有 (map ${mapId}, npc ${npcId}) 的点位 —— 这套 e2e 的前置数据不成立`);
    }
    const roles =
      roleNames && roleNames.length > 0
        ? db
            .prepare(`SELECT id FROM roles WHERE name IN (${roleNames.map(() => "?").join(",")})`)
            .all(...roleNames)
        : db.prepare("SELECT id FROM roles").all();
    const now = Date.now();
    let count = 0;
    for (const row of roles) {
      for (let attempt = 1; ; attempt++) {
        try {
          db.prepare(
            `INSERT INTO role_positions (role_id, map_id, x, y, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(role_id) DO UPDATE SET map_id = excluded.map_id, x = excluded.x, y = excluded.y, updated_at = excluded.updated_at`,
          ).run(row.id, mapId, spot.cx, spot.cy, now);
          break;
        } catch (error) {
          if (attempt >= 3 || !/locked/i.test(String(error && error.message))) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200 * attempt);
        }
      }
      count += 1;
    }
    return { cx: spot.cx, cy: spot.cy, count };
  } finally {
    db.close();
  }
}

module.exports = { placeRolesAt, placeRolesNear };
