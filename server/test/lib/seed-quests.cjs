#!/usr/bin/env node
/**
 * 给临时库重建「出厂主线 + 日常」的任务行（#1177 全清的测试侧配套）
 *
 * ## 为什么需要
 *
 * #1177 全清后，出厂快照（config-sync.sql）里的 quests 归零、一次性链脚本与链守点套件
 * 一并下线 —— 任务由运营在管理端重建。依赖「出厂就有任务」的 e2e 套件用本库在
 * **服务端就绪之后**直插这几行（quest 仓储每次现读库、无缓存，插完立即可见）。
 *
 * ## 为什么是这几条
 *
 * 原 #1084 出厂链的头部（8001 talk → 8002 kill → 8003 collect → 8004 talk·战魂使者）
 * 加一条日常（8101 kill）。逐列取自 master 的 config-sync.sql（2026-11-22 导出），
 * **逐行显式值**，不引用任何运行时生成。
 *
 * ## 用法
 *
 * ```js
 * const { seedQuests } = require("./lib/seed-quests.cjs");
 * seedQuests(dbPath);   // 必须在 startServer 之后（空库自启会整份替换配置表）
 * ```
 */

const { DatabaseSync } = require("node:sqlite");

/** 列清单与行值都来自 master 的 config-sync.sql（快照格式 = 列名行 + VALUES 行） */
const QUEST_COLUMNS =
  '("id", "kind", "label", "description", "prev_quest_id", "min_level", "npc_id", "objective_type", "objective_target", "objective_count", "reward_bind_gold", "reward_exp", "reward_items", "updated_at")';

const QUEST_ROWS = [
  "('8001', 'main', '初入大陆', '拜访大陆传送官，了解这片大陆的现状。', '', 1, '0002', 'talk', '0002', 1, 500, 100, '[]', 0)",
  "('8002', 'main', '除鸡令', '村外的赤焰斗鸡扰民已久，替传送官清理 5 只。', '8001', 1, '0002', 'kill', '1', 5, 800, 200, '[{\"goodId\":\"material_hide\",\"count\":2}]', 0)",
  "('8003', 'main', '皮料筹措', '传送官要修补货车，交付 3 张兽皮（material_hide）。', '8002', 1, '0002', 'collect', 'material_hide', 3, 1000, 300, '[{\"goodId\":\"material_iron\",\"count\":1}]', 0)",
  "('8004', 'main', '战魂之门', '带着铁料去见战魂使者，开启战魂之路。', '8003', 1, '9002', 'talk', '9002', 1, 1500, 500, '[]', 0)",
  "('8101', 'daily', '日常巡猎', '每日例行：猎杀 10 只金斑雄鹿，维持村郊安宁。', '', 1, '0002', 'kill', '2', 10, 500, 150, '[]', 0)",
];

/**
 * @param {string} dbPath SQLite 文件（服务端运行中：与 place-role.cjs 同一套直写口径）
 */
function seedQuests(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("DELETE FROM quests WHERE id IN ('8001','8002','8003','8004','8101')");
    for (const row of QUEST_ROWS) {
      db.exec(`INSERT INTO quests ${QUEST_COLUMNS} VALUES ${row}`);
    }
  } finally {
    db.close();
  }
}

module.exports = { seedQuests };
