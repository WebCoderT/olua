#!/usr/bin/env node
/**
 * 配置表 / 运行时表的**唯一分类处**
 *
 * ===========================================================================
 * 这张清单决定「哪些数据能跟着 git 走」
 * ===========================================================================
 * 多人协作各自跑本地服务端时，配置（物品 / 怪物 / 掉落 / 技能…）要能对齐，而
 * 账号、角色存档、审计日志绝不能进仓库（`olua` 是 PUBLIC 仓库，里面有 scrypt 密码
 * 哈希、邮箱、登录 IP）。这两类数据现在混在**同一个 SQLite 文件**里，所以「导出哪些表」
 * 必须有一份显式清单 —— 靠「表名前缀」或「猜」都会漏。
 *
 * ## 判据
 *
 * **配置表** = 「管理端能改、改完要下发给客户端或参与结算」的表。三条都算：
 * 1. 进 `GET /game-config` 快照的（物品 / 怪物 / 技能 / 称号 / 地图 …）；
 * 2. 不进快照但服务端现算要用的（`growth_scalars` 标量、`monster_skills`、
 *    `map_spawn_areas` 刷怪区）；
 * 3. 走独立接口下发的外观几何（`equip_aligns` / `equip_in_aligns`）。
 *
 * **运行时表** = 一行代表「某个玩家 / 某台服务器此刻的状态」：账号、角色、公会成员、
 * 队伍、邮件队列、审计、世界怪物实例、区服、公告。这些换个机器本来就该不一样。
 *
 * ## 为什么强制「每张表都必须归类」
 *
 * 新加一张表时最容易犯的错是**忘了分类**。忘了的后果分两种，都很隐蔽：
 * - 配置表漏了 → 别人同步过来少一张，页面上显示「一个都没有」，看起来像数据没配；
 * - 运行时表误加 → 账号 hash 跟着 git 走，**发出去就收不回来**。
 *
 * 所以 `assertAllClassified()` 在导出时对实际库表做一次全量比对：库里每张表都必须在
 * 两个清单之一（`sqlite_%` 系统表除外），多一张就当场报错并指名道姓。这比「按清单
 * 挨个导、导完不管」强 —— 后者永远绿。
 */
"use strict";

/**
 * 配置表（会写进同步文件）
 *
 * 按字母序：导出文件里的节顺序就是这份顺序，加表时插到正确位置即可，不会因为
 * 「谁先谁后」产生无意义的 diff。
 */
const CONFIG_TABLES = Object.freeze([
  "achievements",
  "audio_settings",
  "combat_weights",
  "drop_tables",
  "drugs",
  "equip_aligns",
  "equip_in_aligns",
  "equipment_appearance",
  "equipment_meta",
  "equipment_slots",
  "equipment_variants",
  "equipments",
  "fashions",
  "growth_scalars",
  "guide_settings",
  "items",
  "mall_prices",
  "mall_settings",
  "map_collisions",
  "map_npcs",
  "map_spawn_areas",
  "maps",
  "monster_drops",
  "monster_presentation",
  "monster_skills",
  "monsters",
  "npcs",
  "quests",
  "ranks",
  "role_levels",
  "runtime_params",
  "skills",
  "souls",
  "statuses",
  "titles",
  "ui_effects",
]);

/**
 * 运行时表（绝不写进同步文件）
 *
 * 分组只是为了读起来清楚，导出时按字母序处理：
 * - 身份：accounts / admins / audit_logs / announcements
 * - 存档：roles / role_* / quest_progress
 * - 社交：guilds / guild_members / guild_applications / parties / party_members
 * - 投递：mail_queue
 * - 监控投影：map_monitor_state / map_monitor_events（#665 实时地图监控，重启丢也无所谓）
 * - 世界：world_monsters / world_meta / zones
 */
const RUNTIME_TABLES = Object.freeze([
  "accounts",
  "admins",
  "announcements",
  "audit_logs",
  "config_meta",
  "guild_applications",
  "guild_members",
  "guilds",
  "mail_queue",
  "map_monitor_events",
  "map_monitor_state",
  "parties",
  "party_members",
  "quest_progress",
  "role_achievements",
  "role_blocks",
  "role_enemies",
  "role_friends",
  "role_mails",
  "role_reports",
  "roles",
  "world_meta",
  "world_monsters",
  "zones",
]);

/** 同步文件的格式标记（导入时校验，防止拿错文件把配置清空） */
const FORMAT_TAG = "-- olua config snapshot v1";

/** 文件里的表清单行（`-- tables: a,b,c`）—— 导入时靠它判断「这份文件是全量的」 */
const TABLES_LINE_PREFIX = "-- tables: ";

/**
 * 校验库里每张表都已归类
 *
 * `options` 只给测试用（注入一份小规模清单，省得在测试里建 52 张表）。
 * **生产路径不传**：全量清单是守点，不能被调用方随手缩小 —— 传了就等于自己关掉检查。
 *
 * @param {string[]} actualTables 库里实际存在的表（sqlite_master，已排除 sqlite_%）
 * @param {{config?: readonly string[], runtime?: readonly string[]}} [options]
 * @returns {{config: string[], runtime: string[]}} 实际命中的两类表
 */
function assertAllClassified(actualTables, options = {}) {
  const configTables = options.config ?? CONFIG_TABLES;
  const runtimeTables = options.runtime ?? RUNTIME_TABLES;
  const actual = new Set(actualTables);
  const known = new Set([...configTables, ...runtimeTables]);

  const unknown = actualTables.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `库里这些表还没归类：${unknown.join(", ")}\n` +
        `  修法：在 server/scripts/lib/config-tables.cjs 里判断它是「配置」还是「运行时」，加进对应清单。\n` +
        `  判据：一行代表某个玩家 / 某台服务器的此刻状态 → 运行时；管理端能改、要下发或参与结算 → 配置。`,
    );
  }

  const missing = configTables.filter((name) => !actual.has(name));
  if (missing.length > 0) {
    throw new Error(
      `库里缺少这些配置表：${missing.join(", ")}\n` +
        `  说明这个文件不是 olua 的库，或者服务端版本比脚本旧（先启动一次服务端建表）。`,
    );
  }

  return {
    config: configTables.filter((name) => actual.has(name)),
    runtime: runtimeTables.filter((name) => actual.has(name)),
  };
}

module.exports = {
  CONFIG_TABLES,
  FORMAT_TAG,
  RUNTIME_TABLES,
  TABLES_LINE_PREFIX,
  assertAllClassified,
};
