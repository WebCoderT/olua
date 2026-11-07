#!/usr/bin/env node
/**
 * 配置快照覆写（成长底座）回归单测（#361 建、#590 重写）
 *
 * #590 起曲线 / 标量 / 经验公式全部搬去服务端（server/src/shared/growth-seed.ts 是唯一书写处），
 * 客户端不再有任何派生 —— 断言口径随之翻转：
 * · **零本地数据** —— 模块加载期 levelMap / titleLevels / soulLevels / rankLevels 全是空表
 * · **整表重建** —— 快照 `levels` / `titles` / `souls` / `ranks` 段到达后先清空再按行填
 *   （数组与 Map 的**引用不变**），服务端没有的行客户端就没有
 * · **上限走标量** —— roleMaxLevel / mpRecoverPerSecond 由 growthScalars 下发；未知标量键忽略不炸
 * · **兜底不炸** —— 空快照（旧服务端）保留当前值；同一份快照重复覆写幂等
 *
 * 行数据用**真实配置快照**（factory-data 从 server/data/config-sync.sql 读出 /
 * soul-seed / rank-seed）展开，不在测试里复刻一行数值。
 *
 * 用法：node client/tools/test-config-snapshot-growth.cjs
 */
const path = require("path");
const { prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");
/** #655 起配置的唯一来源是数据库快照（server/data/config-sync.sql） */
const factory = require("./lib/factory-data.cjs");

function main() {
  let outDir;
  try {
    outDir = prepare("olua-snapshot-growth", ["configs/apply-snapshot.ts"]);
  } catch (error) {
    fail(String(error.message ?? error));
    return;
  }

  const growth = require(path.join(outDir, "configs/game-config.js"));
  const level = require(path.join(outDir, "configs/game-config.js"));
  const title = require(path.join(outDir, "configs/game-config.js"));
  const soul = require(path.join(outDir, "configs/game-config.js"));
  const rank = require(path.join(outDir, "configs/game-config.js"));
  const snapshotApi = require(path.join(outDir, "configs/apply-snapshot.js"));

  const { titleLevels } = title;
  const { soulLevels } = soul;
  const { rankLevels } = rank;
  // roleMaxLevel 是 `export let`：CommonJS 下解构会拷成快照，必须按属性读
  const maxLevel = () => growth.roleMaxLevel;

  // #786：等级不再逐级下发，快照只给 4 条曲线 × 6 段；「第 N 级多少」由 levelConfigOf 现算
  const levelConfigOf = (n) => level.levelConfigOf(n);
  const levelCurves = level.levelCurves;

  /** 模拟运营改了 hp 曲线（起始值与每级增量整体放大）后下发的新参数 */
  const curveRows = (hpScale = 1) =>
    factory.levelCurves().map((row) =>
      row.curve === "hp"
        ? { ...row, startValue: Math.round(row.startValue * hpScale), perLevel: Math.round(row.perLevel * hpScale) }
        : row,
    );
  const titleRows = () => factory.titles().map(({ updatedAt, ...row }) => row);
  const soulRows = () => factory.souls().map(({ updatedAt, ...row }) => row);
  const rankRows = () => factory.ranks().map(({ updatedAt, ...row }) => row);

  console.log("\n=== 零本地数据：加载期全是空表 ===");
  check(levelCurves.length === 0, "levelCurves 加载期为空（等级唯一来源 = 快照 levelCurves 段）", String(levelCurves.length));
  check(levelConfigOf(1) === null, "曲线没到 → levelConfigOf 返回 null（不凭空造属性）");
  check(titleLevels.length === 0, "titleLevels 加载期为空");
  check(soulLevels.length === 0, "soulLevels 加载期为空");
  check(rankLevels.length === 0, "rankLevels 加载期为空");

  console.log("\n=== levelCurves 段整表重建 ===");
  snapshotApi.applyGrowthSnapshot({ growthScalars: [], levelCurves: curveRows() });
  check(levelCurves.length === factory.levelCurves().length, "段数 = 快照行数（4 条 × 6 段）", String(levelCurves.length));
  check(levelConfigOf(1).maxHp === 100, "1 级生命 = 出厂值（曲线复现旧逐级表）", String(levelConfigOf(1).maxHp));
  check(levelConfigOf(60).maxHp === 98720, "60 级生命 = 旧表末值（曲线与旧 60 行零误差）", String(levelConfigOf(60).maxHp));
  check(levelConfigOf(1).exp === 100, "1 级升级经验 = 出厂值", String(levelConfigOf(1).exp));
  check(Array.isArray(levelConfigOf(1).physicalAttack), "区间转回客户端元组 [min, max]", JSON.stringify(levelConfigOf(1).physicalAttack));

  // 模拟服务端改曲线后下发的新值：hp 段起始值与增量整体放大一倍
  snapshotApi.applyGrowthSnapshot({ growthScalars: [], levelCurves: curveRows(2) });
  check(levelConfigOf(1).maxHp === 200, "第二份快照整表替换（曲线改了，算出来的值跟着变）", String(levelConfigOf(1).maxHp));

  console.log("\n=== 三条成长线：titles / souls / ranks 段 ===");
  title.applyTitleRows(titleRows());
  soul.applySoulRows(soulRows());
  rank.applyRankRows(rankRows());
  check(titleLevels.length === titleRows().length, "称号阶数 = 快照行数", String(titleLevels.length));
  check(titleLevels[0].attributes.physicalAttack[0] === titleRows()[0].attributes.physicalAttack.min, "称号属性 = 快照值（客户端零派生）");
  check(soulLevels.length === soulRows().length, "战魂阶数 = 快照行数", String(soulLevels.length));
  check(rankLevels.length === rankRows().length, "军衔阶数 = 快照行数（1 连续到 100）", String(rankLevels.length));
  check(rankLevels[0].tier === rankRows()[0].tier, "军衔大段名（tier）随快照下发", rankLevels[0].tier);
  check(titleMax() === titleLevels.length, "titleMaxLevel() 读的是运行时表", String(titleMax()));
  check(soulMax() === soulLevels.length, "soulMaxLevel() 读的是运行时表", String(soulMax()));
  check(rankMax() === rankLevels.length, "rankMaxLevel() 读的是运行时表", String(rankMax()));

  console.log("\n=== 标量：roleMaxLevel 下发 ===");
  snapshotApi.applyGrowthScalars([{ key: "roleMaxLevel", value: 70, description: "", updatedAt: 0 }]);
  check(maxLevel() === 70, "等级上限读到服务端的 70", String(maxLevel()));
  snapshotApi.applyGrowthScalars([{ key: "attributeRange.unknownRate", value: 999, description: "", updatedAt: 0 }]);
  check(maxLevel() === 70, "未知标量键被忽略，不影响其余参数", String(maxLevel()));

  console.log("\n=== 标量：mpRecoverPerSecond 下发（#605）===");
  // 与 roleMaxLevel 一样是 `export let`：CommonJS 下解构会拷成快照，必须按属性读
  const roleConfig = require(path.join(outDir, "configs/role.js"));
  const mpRate = () => roleConfig.mpRecoverPerSecond;
  check(roleConfig.mpRecoverPerSecond === 0, "初始 0（#724 无本地兜底：快照没到不做回蓝预测）", String(roleConfig.mpRecoverPerSecond));
  snapshotApi.applyGrowthScalars([{ key: "mpRecoverPerSecond", value: 5, description: "", updatedAt: 0 }]);
  check(mpRate() === 5, "回复速度随快照覆写成 5（客户端演出与结算同速）", String(mpRate()));
  snapshotApi.applyGrowthScalars([{ key: "mpRecoverPerSecond", value: -3, description: "", updatedAt: 0 }]);
  check(mpRate() === 0, "负数按 0 处理（配置拍错时宁可不回蓝，也不能倒扣）", String(mpRate()));
  snapshotApi.applyGrowthScalars([{ key: "roleMaxLevel", value: 70, description: "", updatedAt: 0 }]);
  check(mpRate() === 0, "只下发别的标量时回复速度保持不变（不是每次整份重置）", String(mpRate()));

  console.log("\n=== 标量：soakExpPerTick 下发（#722 泡点）===");
  check(growth.soakExpPerTick === 0, "出厂值 0（活动默认关闭，不误飘提示）", String(growth.soakExpPerTick));
  snapshotApi.applyGrowthScalars([{ key: "soakExpPerTick", value: 100, description: "", updatedAt: 0 }]);
  check(growth.soakExpPerTick === 100, "泡点速率随快照覆写（客户端只读它决定要不要报喜）", String(growth.soakExpPerTick));
  snapshotApi.applyGrowthScalars([{ key: "soakExpPerTick", value: -5, description: "", updatedAt: 0 }]);
  check(growth.soakExpPerTick === 0, "负数按 0 处理（拍错配置宁可不报喜，也不虚报）", String(growth.soakExpPerTick));
  snapshotApi.applyGrowthScalars([{ key: "soakExpPerTick", value: 2.7, description: "", updatedAt: 0 }]);
  check(growth.soakExpPerTick === 2, "小数向下取整（每拍经验是整数点）", String(growth.soakExpPerTick));

  console.log("\n=== 100 万级与边界 ===");
  snapshotApi.applyGrowthSnapshot({ growthScalars: [], levelCurves: curveRows() });
  const top = levelConfigOf(1000000);
  check(top !== null && Number.isFinite(top.maxHp) && top.maxHp > 0, "100 万级算得出且不是 Infinity", String(top && top.maxHp));
  check(Number.isFinite(top.exp) && top.exp > 0, "100 万级的升级经验也是有限数", String(top && top.exp));
  check(levelConfigOf(0) === null && levelConfigOf(-5) === null, "0 级与负数级返回 null（不参与结算）");
  check(levelConfigOf(2000000) !== null, "超出末段自动外推（调大上限不用改曲线）");

  console.log("\n=== 契约（#604）：空快照必须炸，不再「保留当前值」 ===");
  snapshotApi.applyGrowthSnapshot({ growthScalars: [], levelCurves: curveRows() });
  const hpBefore = levelConfigOf(1).maxHp;
  let contractError = "";
  try {
    snapshotApi.applyConfigSnapshot({});
  } catch (error) {
    contractError = String((error && error.message) || error);
  }
  check(contractError.indexOf("levelCurves") >= 0 || contractError.indexOf("等级曲线") >= 0,
    "空快照抛错，错误里点名 levelCurves 段", contractError.slice(0, 60));
  check(levelConfigOf(1).maxHp === hpBefore, "抛错前不落库（曲线还是上一份快照的样子）");
  check(maxLevel() === 70, "抛错不动等级上限", String(maxLevel()));

  const reapply = () => {
    snapshotApi.applyGrowthSnapshot({ growthScalars: [], levelCurves: curveRows(2) });
    title.applyTitleRows(titleRows());
    soul.applySoulRows(soulRows());
    rank.applyRankRows(rankRows());
  };
  reapply();
  const once = JSON.stringify([levelCurves, levelConfigOf(1), levelConfigOf(999999)]);
  reapply();
  const twice = JSON.stringify([levelCurves, levelConfigOf(1), levelConfigOf(999999)]);
  check(once === twice, "同一份快照连续覆写两次结果一致（幂等，重进游戏不会滚雪球）");
  check(titleLevels.length === titleRows().length && rankLevels.length === rankRows().length, "幂等同样覆盖三条成长线");

  function titleMax() { return title.titleMaxLevel(); }
  function soulMax() { return soul.soulMaxLevel(); }
  function rankMax() { return rank.rankMaxLevel(); }

  finish("配置快照成长底座：全部断言通过");
}

main();
