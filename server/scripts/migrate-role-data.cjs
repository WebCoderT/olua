#!/usr/bin/env node
/**
 * 存档结构迁移：把全部角色存档迁到 `ROLE_DATA_VERSION`（#818 / B60）
 *
 *   make migrate                       # 读默认库，把落后版本的存档就地升级
 *   make migrate ARGS="--dry-run"      # 只看分布，一个字节都不写
 *   node server/scripts/migrate-role-data.cjs --db /tmp/x.db --dry-run
 *
 * ## 为什么需要它
 *
 * 服务端在**进入游戏**（`POST /roles/:id/select`）时也会迁（惰性迁移，见
 * `RolesService.migrateBeforeEnter`），所以这个脚本不是「不跑就进不去」的硬前置。
 * 它解决的是另一件事：**让库里的版本号真的前进**。
 *
 * 惰性迁移只在有人登录时才发生，而「某个角色半年没上线」是完全正常的 —— 版本分布会长期
 * 挂着好几档。发布前跑一次，等于告诉运维三件事：现在库里各版本各有多少、这次迁移动了多少行、
 * 有没有**迁不动**的档（版本比代码新 = 回滚发布；JSON 坏了 = 坏档）。
 * 后两类是必须人工介入的，脚本以**非零退出码**报出来 —— 发布流程拿它当闸门（I2）。
 *
 * ## 为什么 require dist 而不是自己写一份迁移链
 *
 * 迁移链只能有一处真相。脚本自己抄一份，等于给「迁移把绑定元宝清零」这种事故留了第二扇门
 * （改了 TS 忘了改 CJS，脚本跑出来的结果与线上不一致）。所以这里读编译产物，
 * 找不到就明确要求先 build —— `make migrate` 已经把它串成前置。
 *
 * ## 幂等 / 并发
 *
 * 判据是存档里的 `schemaVersion`：已经是当前版本的行原样跳过，重跑无副作用。
 * 写的是 `data` 一列、**不动 `updated_at` 与 `revision`** —— 迁移不是玩家进度，
 * 推进修订号只会让刚登录的客户端下一次存档白撞 20006。
 * 并且是**全有或全无**：只要有坏档 / 版本超前的行，一行都不写，直接非零退出 ——
 * 「迁一半再中止」会让下一次跑的版本分布更难读，而这几行迟早要人工处理。
 * 服务在跑也能跑（SQLite WAL），但建议在停机窗口做：迁移期间登录的角色会同时撞到
 * 惰性迁移，两边写的是同一份结果（幂等），只是白多做一次。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const tooling = require("./lib/db-tooling.cjs");

/** 编译产物里的迁移链（唯一真相） */
const MIGRATION_MODULE = path.join(tooling.SERVER_DIR, "dist", "modules", "roles", "role-migration.js");

function loadMigration() {
  if (!fs.existsSync(MIGRATION_MODULE)) {
    console.error(
      `找不到编译产物：${path.relative(process.cwd(), MIGRATION_MODULE)}\n` +
        "先编译服务端（`cd server && npm run build`，或直接用 `make migrate` —— 它会先构建）。",
    );
    process.exit(1);
  }
  // eslint-disable-next-line import/no-dynamic-require
  return require(MIGRATION_MODULE);
}

/**
 * 解析一行存档
 *
 * 返回 `{ ok: true, data }` / `{ ok: false, reason }`：**坏档不迁移、不覆盖**。
 * 坏行留在库里等人工处理 —— 脚本把它写成 `{}` 才是真正的破坏（那等于把「坏档」洗成「空档」）。
 */
function parseRow(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "不是对象" };
    return { ok: true, data: parsed };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** 版本分布 `{ 1: 8, 2: 3 }` → `v1 = 8，v2 = 3` */
function describeDistribution(distribution) {
  const versions = Object.keys(distribution)
    .map(Number)
    .sort((a, b) => a - b);
  if (versions.length === 0) return "（无）";
  return versions.map((version) => `v${version} = ${distribution[version]}`).join("，");
}

/**
 * v2→v3 的「绑定回填」要问配置（#816）：把装备基础件装进运行时快照，之后 `bindOnDropOf`
 * 就能回答「这件装备是不是掉落即绑定」。
 *
 * 为什么脚本里也要做：`make migrate` 与「玩家登录时的惰性迁移」必须给出**同一份结果** ——
 * 否则「先跑过脚本的那批角色」穿着强制绑定件会被当成未绑定，而没跑过的那批是对的，
 * 这种不一致最难查。装不进去（没编译 / 表不在）就退回「不回填」，并明说。
 */
function loadWornBoundResolver(db) {
  try {
    // eslint-disable-next-line import/no-dynamic-require
    const runtime = require(path.join(tooling.SERVER_DIR, "dist", "common", "runtime-config-cache.js"));
    // `SELECT *` 而不是点名要 `bind_on_drop`：库比代码旧（列还没加）时，缺列只是「按未绑定」，
    // 不该让整段回填直接退化 —— 那种库本来就该先让服务端起一次把列补齐
    const bases = db.prepare("SELECT * FROM equipments").all();
    runtime.applyEquipmentBases(bases);
    return (id) => runtime.bindOnDropOf(id);
  } catch (error) {
    console.warn(
      `读不到装备配置（${error instanceof Error ? error.message : String(error)}）—— ` +
        "本次迁移**不回填**绑定，装备槽位只做形状变换（裸 id → { id }）。",
    );
    return () => false;
  }
}

function main() {
  const args = tooling.parseArgs(process.argv.slice(2), { db: "db", "dry-run": "dryRun" });
  const dryRun = args.dryRun === true;
  // 先加载迁移链再碰库：require 失败（没编译）时不该让人以为「库有问题」
  const { ROLE_DATA_VERSION, schemaVersionOf, migrateRoleData } = loadMigration();

  tooling.loadServerEnv();
  const dbPath = tooling.resolveDbPath(args.db);
  console.log(`数据文件：${dbPath}`);
  console.log(`目标版本：v${ROLE_DATA_VERSION}${dryRun ? "（dry-run：只报告，不写库）" : ""}\n`);

  const db = new DatabaseSync(dbPath);
  try {
    const hasRoles = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'roles'").get();
    if (!hasRoles) {
      console.error("库里没有 roles 表 —— 这个文件不是 olua 的库，或服务端还没启动过。");
      process.exitCode = 1;
      return;
    }

    const wornBoundOf = loadWornBoundResolver(db);

    const rows = db.prepare("SELECT id, name, data FROM roles ORDER BY created_at ASC").all();
    const distribution = {};
    const corrupted = [];
    const ahead = [];
    const pending = [];

    for (const row of rows) {
      const parsed = parseRow(row.data);
      if (!parsed.ok) {
        corrupted.push({ id: row.id, name: row.name, reason: parsed.reason });
        continue;
      }
      const version = schemaVersionOf(parsed.data);
      distribution[version] = (distribution[version] || 0) + 1;
      if (version === ROLE_DATA_VERSION) continue;
      if (version > ROLE_DATA_VERSION) {
        ahead.push({ id: row.id, name: row.name, version });
        continue;
      }
      try {
        const outcome = migrateRoleData(parsed.data, { wornBoundOf });
        pending.push({ id: row.id, name: row.name, from: outcome.from, to: outcome.to, data: JSON.stringify(outcome.data) });
      } catch (error) {
        // 链缺环（代码事故）：与「版本超前」同一条出口 —— 打印出来，退出码 1
        ahead.push({ id: row.id, name: row.name, version, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    console.log(`角色总数：${rows.length}`);
    console.log(`版本分布：${describeDistribution(distribution)}`);
    console.log(`需要迁移：${pending.length}`);

    if (corrupted.length > 0 || ahead.length > 0) {
      // 全有或全无：只要有迁不动的行，就一行都不写。发布流程拿退出码当中止信号（I2），
      // 「迁一半然后中止」只会让下一次跑的分布更难读，而这几行迟早要人工处理
      console.error(`\n有 ${corrupted.length + ahead.length} 行迁不动，本次**未写任何一行**。`);
      if (corrupted.length > 0) {
        console.error(`\n坏档（JSON 解析失败）：${corrupted.length}`);
        for (const item of corrupted) console.error(`  - ${item.id}（${item.name}）：${item.reason}`);
        console.error("  坏档的处理是 #819 的事（拒登录 + 隔离 + 人工恢复），这里只负责报出来。");
      }
      if (ahead.length > 0) {
        console.error(`\n版本比代码新 / 链缺环：${ahead.length}`);
        for (const item of ahead) {
          console.error(`  - ${item.id}（${item.name}）：v${item.version}${item.reason ? ` —— ${item.reason}` : ""}`);
        }
        console.error("  版本比代码新 = 库里是更新版本的代码写的档（回滚发布？）：先确认发布方向，别急着迁。");
      }
      process.exitCode = 1;
      return;
    }

    if (pending.length > 0 && !dryRun) {
      const update = db.prepare("UPDATE roles SET data = ? WHERE id = ?");
      db.prepare("BEGIN").run();
      try {
        for (const item of pending) update.run(item.data, item.id);
        db.prepare("COMMIT").run();
      } catch (error) {
        db.prepare("ROLLBACK").run();
        throw error;
      }
      console.log(`已迁移：${pending.length}`);
    } else if (pending.length > 0) {
      console.log(`已迁移：0（dry-run；这次会写 ${pending.length} 行）`);
    }
  } finally {
    db.close();
  }
}

main();
