#!/usr/bin/env node
/**
 * 把建帮门槛归零（#872 之后 e2e 的准备动作）
 *
 * ## 为什么需要
 *
 * #872 起建帮有门槛：**等级 10 + 绑定元宝 10 万**（`runtime_params.guild_rules`
 * 的 `createLevelMin` / `createCostBindGold`，出厂就开着）。e2e 里绝大多数账号是刚建号的
 * 1 级、钱包 0，而 `e2e-chat` / `e2e-social` 建帮只是为了**造一个「在帮会里的人」**
 * 来验频道准入与互见帧原料 —— 不该被门槛拦住。
 *
 * 门槛本身由 `e2e-guild` 第六组专门验（那里走管理端接口打开、逐条踩边界）。
 *
 * ## 为什么直接改库而不是打接口
 *
 * 这两套没有管理员账号，注册一个只为了改两个数会把准备段撑得比被测逻辑还长 ——
 * 与 `lib/place-role.cjs` 同一取向（准备段造出来的状态不是被测逻辑）。
 * `RuntimeParamsService` 明确「每次现读库、不缓存」，所以直写立刻生效，不用重启。
 *
 * ## 用法
 *
 * ```js
 * const { relaxGuildGate } = require("./lib/guild-gate.cjs");
 * relaxGuildGate(dbPath);
 * ```
 */

const { DatabaseSync } = require("node:sqlite");

/**
 * @param {string} dbPath SQLite 文件（正在被服务端使用的那份）
 * @returns {boolean} 是否改到了行（false = 表里没有 id=1 的行，调用方自行判断要不要在意）
 */
function relaxGuildGate(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    // 服务端握着写锁时直写会抛「database is locked」：等它放锁（同 place-role 的理由）
    db.exec("PRAGMA busy_timeout = 10000");
    const row = db.prepare("SELECT guild_rules FROM runtime_params WHERE id = 1").get();
    if (!row) return false;
    let rules = {};
    try {
      rules = JSON.parse(row.guild_rules) || {};
    } catch {
      // 存档坏掉的 JSON 不是准备段能修的 —— 直接按空对象重写，反正要的就是两个 0
      rules = {};
    }
    rules.createLevelMin = 0;
    rules.createCostBindGold = 0;
    db.prepare("UPDATE runtime_params SET guild_rules = ? WHERE id = 1").run(JSON.stringify(rules));
    return true;
  } finally {
    db.close();
  }
}

module.exports = { relaxGuildGate };
