#!/usr/bin/env node
/**
 * 一次性补数据：怪物动作速度覆盖全量显式化（#1254）
 *
 *   cd server && node scripts/oneoff-seed-monster-speed-rates.cjs              # 干跑：只打印要写什么
 *   cd server && node scripts/oneoff-seed-monster-speed-rates.cjs --apply      # 真写库
 *   node scripts/oneoff-seed-monster-speed-rates.cjs --db /path/to/olua.db     # 换一个库（默认 DB_PATH / data/olua.db）
 *
 * 部署机上：
 *   docker exec olua-server node scripts/oneoff-seed-monster-speed-rates.cjs --apply
 *
 * ## 这刀写什么
 *
 * `monster_presentation.speed_rate`（JSON：动作名 → 每帧秒数）出厂数据 220 行全是 `{}`，
 * 客户端动画速度全靠 `monsterDefaultSpeedRate`（client/assets/configs/game-config.ts）兜底
 * 合成 —— 数据面没有速度这一层。#1254 起给**每一行**把怪物有帧的五个动作键补上显式值，
 * 数值与客户端默认表同值（改客户端默认表必须同步改这里的 SEED，客户端测试盯着两边一致）：
 *
 *   stand 1（4 帧 / 1 秒）· walk 1（6 帧 / 1 秒）· attack 1（6 帧 / 1 秒，普攻与施法统一播这段）
 *   injured 2（2 帧 / 0.5 秒）· die 1（10 帧 / 1 秒）
 *
 * 键全集 = `MONSTER_ACTION_KEYS`（服务端 monster.dto.ts）/ 管理端 ACTION_SPEED_KEYS /
 * 客户端 monsterActionSpecs 逐字一致；attack_near 等角色专用键怪物素材没有帧，不进这份数据。
 *
 * ## 幂等
 *
 * 只补**缺失的动作键**，已有覆盖值（管理端逐怪调过的）原样保留；五键齐全的行不重写。
 * 重跑零 diff。
 *
 * ## 快照可见性
 *
 * `--apply` 成功后 `config_version` +1（同 oneoff-rebuild-quest-line 的口径）：客户端快照按
 * 这个版本缓存，不推版本的话运行中的服务端会一直发旧数据。
 *
 * ## 不碰什么
 *
 * `monsters` / 技能 / 刷怪区等其余表一概不动；客户端 `monsterDefaultSpeedRate` 保留 ——
 * 它从「唯一来源」降级为**兜底**（库行缺键时才生效），出厂数据显式化后正常情况用不到。
 */
"use strict";

const { DatabaseSync } = require("node:sqlite");
const { resolveDbPath } = require("./lib/db-tooling.cjs");

/** 怪物有帧的五个动作键（与服务端 MONSTER_ACTION_KEYS / 客户端 monsterActionSpecs 同源） */
const ACTION_KEYS = ["stand", "walk", "attack", "injured", "die"];

/**
 * 显式默认值（每帧秒数）—— 必须与客户端 `monsterDefaultSpeedRate` 对应键同值，
 * client/tools/test-monster-config.cjs 有源码断言盯着两边一致。
 */
const SEED = { stand: 1, walk: 1, attack: 1, injured: 2, die: 1 };

function main() {
  const apply = process.argv.includes("--apply");
  const dbIndex = process.argv.indexOf("--db");
  const dbPath = resolveDbPath(dbIndex >= 0 ? process.argv[dbIndex + 1] : undefined);
  const db = new DatabaseSync(dbPath);

  try {
    const rows = db.prepare("SELECT id, speed_rate FROM monster_presentation ORDER BY id").all();
    if (rows.length === 0) {
      console.log(`库 ${dbPath} 里 monster_presentation 没有行，没东西可补。`);
      return;
    }

    const now = Date.now();
    const diffs = [];
    for (const row of rows) {
      let current = {};
      try {
        current = JSON.parse(row.speed_rate || "{}") || {};
      } catch {
        // 坏 JSON 视同空对象重造（半截写入的防御）
        current = {};
      }
      const merged = {};
      for (const key of ACTION_KEYS) {
        // 已有的覆盖值（含管理端调过的非默认值）原样保留，只补缺失键
        merged[key] = typeof current[key] === "number" ? current[key] : SEED[key];
      }
      const before = JSON.stringify(current);
      const after = JSON.stringify(merged);
      if (before !== after) diffs.push({ id: row.id, before, after });
    }

    const complete = rows.length - diffs.length;
    console.log(`monster_presentation 共 ${rows.length} 行：五键齐全 ${complete} 行，待补 ${diffs.length} 行。`);
    for (const diff of diffs.slice(0, 10)) {
      console.log(`  ${diff.id}: ${diff.before} → ${diff.after}`);
    }
    if (diffs.length > 10) console.log(`  …（其余 ${diffs.length - 10} 行同理，只补缺失键）`);

    if (diffs.length === 0) {
      console.log("没有缺口，无需写库。");
      return;
    }
    if (!apply) {
      console.log(`\n干跑结束：以上 ${diffs.length} 行待写。加 --apply 真写库（写完自动 config_version +1）。`);
      return;
    }

    // 真写：单事务，坏一半就整体回滚
    const update = db.prepare("UPDATE monster_presentation SET speed_rate = ?, updated_at = ? WHERE id = ?");
    db.exec("BEGIN");
    try {
      for (const diff of diffs) update.run(diff.after, now, diff.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    console.log(`\n已写入：${diffs.length} 行 speed_rate 显式化。`);

    // 推配置版本（同 oneoff-rebuild-quest-line 口径：直接改库绕过管理端写接口的版本拦截器）
    db.exec("INSERT OR IGNORE INTO config_version (id, version, updated_at, updated_by) VALUES (1, 0, 0, '')");
    const version = db
      .prepare("UPDATE config_version SET version = version + 1, updated_at = ?, updated_by = 'oneoff-monster-speed' WHERE id = 1 RETURNING version")
      .get(now).version;
    console.log(`config_version → ${version}（运行中的服务端会在下一次客户端请求时重建快照，无需重启）。`);

    console.log("下一步：node scripts/sync-config-sql-sections.cjs --tables monster_presentation 把出厂段同步进 config-sync.sql。");
  } finally {
    db.close();
  }
}

main();
