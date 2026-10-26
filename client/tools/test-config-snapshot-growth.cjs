#!/usr/bin/env node
/**
 * 配置快照覆写（成长底座）回归单测（#361）
 *
 * 跑的是**真实配置表与真实派生函数**（configs-sandbox 编译 CommonJS + cc 垫片），不是复刻：
 * 断言「服务端下发成长曲线 / 标量 / 经验表之后，客户端的等级表真的换了」。
 *
 * 盯的四条口径：
 * · 曲线整条替换 —— 段数、边界、斜率都跟着服务端走，采样结果随之变
 * · 重建等级表 —— 每级属性与升级经验都由曲线派生，不重建就是旧值留底
 * · 经验表压轴 —— 管理端直接改经验表时以服务端为准（与曲线解耦）
 * · 兜底不炸 —— 缺表 / 未知曲线键 / 未知标量键一律跳过，保留本地值
 *
 * 用法：node client/tools/test-config-snapshot-growth.cjs
 */
const path = require("path");
const { prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

function main() {
  let outDir;
  try {
    outDir = prepare("olua-snapshot-growth", ["configs/apply-snapshot.ts"]);
  } catch (error) {
    fail(String(error.message ?? error));
    return;
  }

  const growth = require(path.join(outDir, "configs/growth.js"));
  const level = require(path.join(outDir, "configs/level.js"));
  const snapshotApi = require(path.join(outDir, "configs/apply-snapshot.js"));

  const { levelMap, expGain } = level;
  const { roleGrowth, attributeRange, getRoleLevelAttributes } = growth;
  // roleMaxLevel 是 `export let`：CommonJS 下解构会把它拷成快照，必须每次按属性读（客户端源码是
  // ESM 命名导入，编译后是 `growth_1.roleMaxLevel` 属性访问，天然是 live 的）
  const maxLevel = () => growth.roleMaxLevel;

  /** 把一条曲线整体翻倍（段数与边界照抄本地，只有值变） */
  const doubled = (curve) =>
    roleGrowth[curve].map((segment, index) => ({
      curve,
      seq: index + 1,
      fromLevel: segment.from,
      toLevel: segment.to,
      startValue: segment.start * 2,
      perLevel: segment.perLevel * 2,
    }));

  // 快照内容在覆写**之前**算好：覆写会改 roleGrowth 本身，边覆写边派生会一代代滚雪球
  const doubledSegments = [...doubled("maxHp"), ...doubled("attack"), ...doubled("defense")];
  const levelScalars = [
    { key: "roleMaxLevel", value: 70, description: "", updatedAt: 0 },
    { key: "attributeRange.hpRecoverRate", value: 0.02, description: "", updatedAt: 0 },
    { key: "expGain.expPerLevel", value: 10, description: "", updatedAt: 0 },
    // 未知键：服务端新增参数时旧客户端应当忽略而不是炸掉
    { key: "attributeRange.unknownRate", value: 999, description: "", updatedAt: 0 },
  ];

  // —— 基线：模块加载期的本地值 ——
  const localHp1 = getRoleLevelAttributes(1).maxHp;
  const localHp60 = getRoleLevelAttributes(60).maxHp;
  const localExp1 = levelMap.get(1).exp;
  const localExp2 = levelMap.get(2).exp;
  const localSize = levelMap.size;

  console.log("\n=== 曲线整条替换：每级属性跟着走 ===");
  snapshotApi.applyConfigSnapshot({
    growthSegments: doubledSegments,
    growthScalars: [],
    levelExps: [],
  });
  check(roleGrowth.maxHp[0].start === 200, "曲线第一段的 start 已换成服务端的值", JSON.stringify(roleGrowth.maxHp[0]));
  check(getRoleLevelAttributes(1).maxHp === localHp1 * 2, "1 级 maxHp 翻倍（重建等级表后派生函数读到新曲线）", `${localHp1} → ${getRoleLevelAttributes(1).maxHp}`);
  check(getRoleLevelAttributes(60).maxHp === localHp60 * 2, "60 级 maxHp 同样翻倍（不是只换第一段）", `${localHp60} → ${getRoleLevelAttributes(60).maxHp}`);
  check(levelMap.get(1).maxHp === localHp1 * 2, "levelMap 里的每级血量同步（重建生效，不是只改了曲线对象）", `${levelMap.get(1).maxHp}`);
  check(growth.monsterStats(60, "normal").maxHp > 0, "怪物属性派生函数在新曲线上仍算得出（曲线是它的基数）");

  console.log("\n=== 标量：上限 / 回血率 / 经验节奏 ===");
  const localRecover1 = levelMap.get(1).hpRecover;
  snapshotApi.applyConfigSnapshot({
    growthSegments: [],
    growthScalars: levelScalars,
    levelExps: [],
  });
  check(maxLevel() === 70, "等级上限读到服务端的 70", String(maxLevel()));
  check(levelMap.size === 70, "重建后等级表扩到 70 行", `${localSize} → ${levelMap.size}`);
  check(levelMap.has(70) && !levelMap.has(71), "70 级有行、71 级没有（上限是闭区间）");
  check(
    levelMap.get(1).hpRecover === Math.round(levelMap.get(1).maxHp * 0.02),
    "每秒回血按新比例重算（= maxHp × hpRecoverRate）",
    `${localRecover1} → ${levelMap.get(1).hpRecover}`,
  );
  check(attributeRange.hpRecoverRate === 0.02, "标量写回了 attributeRange");
  check(expGain.expPerLevel === 10, "每级基准经验写回了 expGain");
  check(levelMap.get(1).exp > localExp1, "曲线口径下的升级经验跟着新 expPerLevel 变大", `${localExp1} → ${levelMap.get(1).exp}`);
  check(maxLevel() === 70 && levelMap.size === 70, "未知标量键被忽略，不影响其余参数");

  console.log("\n=== 经验表压轴：以服务端为准 ===");
  const curveExp1 = levelMap.get(1).exp;
  const curveExp2 = levelMap.get(2).exp;
  snapshotApi.applyConfigSnapshot({
    growthSegments: [],
    growthScalars: [],
    levelExps: [
      { level: 1, exp: 12_345, updatedAt: 0 },
      { level: 2, exp: 0, updatedAt: 0 },
      // 超出上限的行：上限调小后服务端仍会发更大 level 的行，不该凭空造出等级
      { level: 999, exp: 1, updatedAt: 0 },
    ],
  });
  check(levelMap.get(1).exp === 12_345, "经验表覆盖了曲线算出的值", `${curveExp1} → ${levelMap.get(1).exp}`);
  check(levelMap.get(2).exp === 0, "经验表里写 0 也照单全收（不存在「0 当没填」的歧义）", String(levelMap.get(2).exp));
  check(!levelMap.has(999), "超出上限的经验行被跳过（不凭空造等级）");
  check(levelMap.size === 70, "行数不受经验表影响（等级表由上限决定）", String(levelMap.size));
  check(curveExp2 > 0, "未被覆盖的等级仍保留曲线口径的经验", String(curveExp2));

  console.log("\n=== 兜底：缺表不炸、重复覆写幂等 ===");
  const hpBefore = levelMap.get(1).maxHp;
  snapshotApi.applyConfigSnapshot({});
  check(levelMap.get(1).maxHp === hpBefore, "空快照（旧服务端）保留当前值，回落到已有配置");
  check(maxLevel() === 70 && levelMap.size === 70, "空快照不动等级上限");

  const reapply = () =>
    snapshotApi.applyConfigSnapshot({
      growthSegments: doubledSegments,
      growthScalars: levelScalars,
      levelExps: [{ level: 1, exp: 12_345, updatedAt: 0 }],
    });
  reapply();
  const once = JSON.stringify([...levelMap.keys()].map((key) => levelMap.get(key)));
  reapply();
  const twice = JSON.stringify([...levelMap.keys()].map((key) => levelMap.get(key)));
  check(once === twice, "同一份快照连续覆写两次结果一致（幂等，重进游戏不会滚雪球）");
  check(levelMap.get(1).exp === 12_345, "幂等之后经验表仍是最终权威");

  finish("配置快照成长底座：全部断言通过");
}

main();
