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

module.exports = { placeRolesAt };
