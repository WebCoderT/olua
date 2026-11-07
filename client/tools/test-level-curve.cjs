#!/usr/bin/env node
/**
 * 角色等级曲线回归单测（#786：等级上限 60 → 100 万级）
 *
 * 跑的是**真实配置函数**（`configs/game-config` 的 `applyLevelCurves` / `levelConfigOf`），
 * 段参数来自 `server/data/config-sync.sql`（`factory-data.cjs` 读成快照 DTO 形状）——
 * 与进游戏后 `applyGrowthSnapshot` 落的是同一条路。
 *
 * 盯的不变量（改曲线 / 改等级消费方后必须全绿）：
 * · **零本地数据**：快照没到 → `levelConfigOf` 返回 null，客户端不凭空造属性（#724 同一条口径）
 * · **公式一致**：1..60 逐级与 `factory-data` 里独立写的一份基准逐位相同（typo 级漂移也抓得住）
 * · **段边界**：每段起点值精确等于该段 `startValue`（段间允许跳变，不承接上一段）
 * · **段内递推**：相邻差的差 = `accel`（`exp` 二阶、其余一阶），`k` 的 off-by-one 会被抓
 * · **派生关系**：蓝 = 血/2、回血 = 血/100、攻防下限 = 上限×0.7，三系同值 —— 任何等级都成立
 * · **外推**：100 万级是有限数（旧指数曲线在这里 `Infinity`），超出末段继续按末段公式长
 * · **坏行丢弃 / 缺曲线返回 null**：半截属性比「没配」更难查，宁可不演
 * · **跨端同公式**：客户端比例常量与 `server/src/common/constants/role-level-curve.ts` 对得上
 *
 * 用法：node client/tools/test-level-curve.cjs
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");
/** 出厂段参数来源：快照（库里权威，快照是它的逐行投影） */
const factory = require("./lib/factory-data.cjs");

function main() {
  let outDir;
  try {
    outDir = prepare("olua-level-curve");
  } catch (error) {
    fail(String(error.message ?? error));
    return;
  }

  const cfg = require(path.join(outDir, "configs/game-config.js"));
  const { levelConfigOf, levelCurves, applyLevelCurves, getCurrentLevelExpRate } = cfg;
  const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");
  /** 服务端源码（PROJECT_ROOT 是 client/，跨端断言要往上一级） */
  const readServer = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, "..", rel), "utf8");

  /** 段参数（出厂） */
  const segments = factory.levelCurves();
  /** 曲线键 → `levelConfigOf` 结果里的取值（exp 直接读，其余读上限） */
  const VALUE_OF = {
    exp: (config) => config.exp,
    hp: (config) => config.maxHp,
    attack_max: (config) => config.physicalAttack[1],
    defense_max: (config) => config.physicalDefense[1],
  };
  const valueOf = (level, curve) => {
    const config = levelConfigOf(level);
    return config ? VALUE_OF[curve](config) : null;
  };
  /** 某级落在哪一段（取 `fromLevel` 不超过它的最后一段） */
  const segmentAt = (curve, level) => {
    let picked = null;
    for (const row of levelCurves) {
      if (row.curve !== curve || row.fromLevel > level) continue;
      if (!picked || row.fromLevel > picked.fromLevel) picked = row;
    }
    return picked;
  };

  // 曲线键以服务端为唯一权威（客户端不另存一份清单）
  const serverCurveSource = readServer("server/src/common/constants/role-level-curve.ts");
  const curveKeys = (() => {
    const matched = /ROLE_LEVEL_CURVES\s*=\s*\[([^\]]+)\]/.exec(serverCurveSource);
    if (!matched) return [];
    return matched[1]
      .split(",")
      .map((item) => item.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
  })();

  //#region 一、零本地数据 + 出厂段落得下来

  console.log("=== 一、零本地数据与出厂段 ===");
  check(levelCurves.length === 0, "加载期曲线为空（等级唯一来源 = 快照 levelCurves 段）", String(levelCurves.length));
  check(levelConfigOf(1) === null, "曲线没到 → levelConfigOf 返回 null（不凭空造属性）");
  check(curveKeys.length === 4, "服务端登记了 4 条独立曲线", curveKeys.join("/"));
  check(
    curveKeys.every((curve) => typeof VALUE_OF[curve] === "function"),
    "每条曲线在本测试里都有对应的取值口径（新增曲线要同步这里）",
  );

  applyLevelCurves(segments);
  check(levelCurves.length === segments.length, "段数 = 快照行数（4 条 × 6 段）", String(levelCurves.length));
  const keysInTable = [];
  for (const row of levelCurves) if (!keysInTable.includes(row.curve)) keysInTable.push(row.curve);
  check(
    keysInTable.length === curveKeys.length && curveKeys.every((curve) => keysInTable.includes(curve)),
    "表里的曲线键与服务端清单一致（不多不少）",
    keysInTable.join("/"),
  );
  check(
    levelCurves.every((row, index) => index === 0 || levelCurves[index - 1].fromLevel <= row.fromLevel || levelCurves[index - 1].curve !== row.curve),
    "同一条曲线内按 fromLevel 升序（求值取「不超过该级的最后一段」靠这个前提）",
  );
  check(levelConfigOf(1) !== null, "灌入后 1 级算得出来");

  //#endregion

  //#region 二、公式：与独立基准逐位比对

  console.log("\n=== 二、1..60 逐级与独立基准一致 ===");
  const drifted = [];
  for (let level = 1; level <= 60; level += 1) {
    for (const curve of curveKeys) {
      const expected = factory.curveAt(segments, curve, level);
      if (expected === null) continue;
      if (valueOf(level, curve) !== expected) drifted.push(`${curve}#${level} 客户端 ${valueOf(level, curve)} / 基准 ${expected}`);
    }
  }
  check(drifted.length === 0, "1..60 级 × 4 条曲线逐位相同（客户端与服务端同一公式）", drifted.slice(0, 5).join("；"));

  const bigLevels = [999, 100000, 1000000, 2000000];
  const bigDrift = [];
  for (const level of bigLevels) {
    for (const curve of curveKeys) {
      const expected = factory.curveAt(segments, curve, level);
      if (expected === null) continue;
      if (valueOf(level, curve) !== expected) bigDrift.push(`${curve}#${level} 客户端 ${valueOf(level, curve)} / 基准 ${expected}`);
    }
  }
  check(bigDrift.length === 0, "大等级（999 / 10 万 / 100 万 / 200 万）同样逐位相同", bigDrift.slice(0, 5).join("；"));

  //#endregion

  //#region 三、段边界与段内递推

  console.log("\n=== 三、段边界与段内递推 ===");
  const boundaryBad = [];
  for (const row of levelCurves) {
    if (valueOf(row.fromLevel, row.curve) !== row.startValue) {
      boundaryBad.push(`${row.curve}#${row.fromLevel} 算出 ${valueOf(row.fromLevel, row.curve)} / 参数 ${row.startValue}`);
    }
  }
  check(boundaryBad.length === 0, "每段起点值精确等于该段 startValue（k=0，段间不承接上一段）", boundaryBad.slice(0, 5).join("；"));

  const slopeBad = [];
  for (const row of levelCurves) {
    const lens = Math.min(3, Math.max(0, row.toLevel - row.fromLevel));
    for (let step = 1; step <= lens; step += 1) {
      const level = row.fromLevel + step;
      const delta = valueOf(level, row.curve) - valueOf(level - 1, row.curve);
      const expected = row.perLevel + row.accel * (step - 1);
      if (delta !== expected) slopeBad.push(`${row.curve}#${level} 差 ${delta} / 参数 ${expected}`);
    }
  }
  check(slopeBad.length === 0, "段内相邻差 = perLevel + accel×(k-1)（exp 二阶、其余一阶）", slopeBad.slice(0, 5).join("；"));

  const secondOrder = curveKeys.filter((curve) => {
    const row = segmentAt(curve, 1);
    return row && row.accel !== 0;
  });
  check(secondOrder.includes("exp"), "升级经验是二阶曲线（越涨越快，只调上限不改结构）", secondOrder.join("/"));

  //#endregion

  //#region 四、派生关系与单调性

  console.log("\n=== 四、派生关系与单调性 ===");
  const deriveBad = [];
  for (const level of [1, 2, 7, 33, 60, 999, 123456, 1000000]) {
    const config = levelConfigOf(level);
    if (!config) {
      deriveBad.push(`${level}(null)`);
      continue;
    }
    if (config.maxMp !== Math.round(config.maxHp / 2)) deriveBad.push(`${level} 蓝=${config.maxMp}`);
    if (config.hpRecover !== Math.round(config.maxHp / 100)) deriveBad.push(`${level} 回血=${config.hpRecover}`);
    if (config.physicalAttack[0] !== Math.round(config.physicalAttack[1] * 0.7)) deriveBad.push(`${level} 物攻下限`);
    if (config.physicalDefense[0] !== Math.round(config.physicalDefense[1] * 0.7)) deriveBad.push(`${level} 物防下限`);
    for (const pair of ["physical", "magic", "taoist"]) {
      if (config[`${pair}Attack`][0] !== config.physicalAttack[0]) deriveBad.push(`${level} ${pair}攻`);
      if (config[`${pair}Defense`][0] !== config.physicalDefense[0]) deriveBad.push(`${level} ${pair}防`);
    }
  }
  check(deriveBad.length === 0, "蓝/回血/攻防下限与三系同值都按比例派生（任意等级）", deriveBad.slice(0, 5).join("；"));
  check(Array.isArray(levelConfigOf(1).physicalAttack) && levelConfigOf(1).physicalAttack.length === 2, "区间是客户端元组 [min, max]（不是快照的 {min,max} 对象）");

  const notGrowing = [];
  for (let level = 2; level <= 60; level += 1) {
    for (const curve of curveKeys) {
      if (valueOf(level, curve) < valueOf(level - 1, curve)) notGrowing.push(`${curve}#${level}`);
    }
  }
  check(notGrowing.length === 0, "1..60 级四条曲线都单调不减（曲线调歪成负增长会被抓住）", notGrowing.slice(0, 5).join("；"));

  //#endregion

  //#region 五、100 万级与外推

  console.log("\n=== 五、100 万级与外推 ===");
  const top = levelConfigOf(1000000);
  check(top !== null, "100 万级算得出来");
  check(Number.isFinite(top.maxHp) && top.maxHp > 0, "100 万级生命是有限正数（旧指数曲线在这里 Infinity）", String(top && top.maxHp));
  check(Number.isFinite(top.exp) && top.exp > 0, "100 万级升级经验也是有限正数", String(top && top.exp));
  check(top.maxHp > levelConfigOf(60).maxHp && top.exp > levelConfigOf(60).exp, "100 万级远大于 60 级（确实在长，不是封顶值）");
  const beyond = levelConfigOf(2000000);
  check(beyond !== null && beyond.maxHp > top.maxHp, "超出末段自动外推（调大上限不用改末段 toLevel）", `${top && top.maxHp} → ${beyond && beyond.maxHp}`);
  check(levelConfigOf(0) === null && levelConfigOf(-5) === null, "0 级与负数级返回 null（不参与结算）");
  check(levelConfigOf(1.9).maxHp === levelConfigOf(1).maxHp, "小数等级按整数处理（向下取整，不会算出半级）");
  check(levelConfigOf(Number.NaN) === null, "NaN 等级返回 null（不把 NaN 传进结算）");

  // 超出 memo 上限（4096）后仍要算得对：整体清空不能把结果算错
  for (let level = 1; level <= 5000; level += 1) levelConfigOf(level);
  check(
    valueOf(4321, "hp") === factory.curveAt(segments, "hp", 4321),
    "连算 5000 级（memo 清过一次）结果仍然正确",
    String(valueOf(4321, "hp")),
  );

  //#endregion

  //#region 六、坏行丢弃 / 缺曲线 / 整表重建

  console.log("\n=== 六、坏行丢弃、缺曲线与整表重建 ===");
  const withoutDefense = segments.filter((row) => row.curve !== "defense_max");
  applyLevelCurves(withoutDefense);
  check(levelConfigOf(1) === null, "缺一条曲线 → 返回 null（半截属性比「没配」更难查）");
  check(levelCurves.length === withoutDefense.length, "缺曲线时不补默认值（客户端零兜底）", String(levelCurves.length));

  const dirty = [
    null,
    { curve: "", seq: 1, fromLevel: 1, toLevel: 10, startValue: 1, perLevel: 1, accel: 0 },
    { curve: "hp", seq: 1, fromLevel: 0, toLevel: 10, startValue: 1, perLevel: 1, accel: 0 },
    { curve: "hp", seq: 1, fromLevel: Number.NaN, toLevel: 10, startValue: 1, perLevel: 1, accel: 0 },
    { curve: "hp", seq: 1, fromLevel: 1, toLevel: 10, startValue: 50, perLevel: 5, accel: 0 },
  ];
  applyLevelCurves(dirty);
  check(levelCurves.length === 1 && levelCurves[0].curve === "hp", "缺键 / 等级非正的坏行整条丢弃，只留合法那条", `${levelCurves.length} 条`);
  check(levelConfigOf(5) === null, "只剩一条曲线时仍返回 null（缺 exp 就不演）");
  check(levelCurves[0].startValue === 50 && levelCurves[0].perLevel === 5, "合法那行原样保留（数值不被改写）");

  applyLevelCurves([]);
  check(levelCurves.length === 0 && levelConfigOf(1) === null, "整表重建：快照里一条都没有时客户端就是空的（不留上一版）");

  applyLevelCurves(segments);
  const scaled = segments.map((row) => (row.curve === "hp" ? { ...row, startValue: row.startValue * 2, perLevel: row.perLevel * 2 } : row));
  const hpBefore = levelConfigOf(1).maxHp;
  applyLevelCurves(scaled);
  check(levelConfigOf(1).maxHp === hpBefore * 2, "重新落库后立即生效（memo 跟着清空，不会留旧值）", `${hpBefore} → ${levelConfigOf(1).maxHp}`);

  applyLevelCurves(segments);
  const once = JSON.stringify([levelCurves, levelConfigOf(1), levelConfigOf(60), levelConfigOf(1000000)]);
  applyLevelCurves(segments);
  const twice = JSON.stringify([levelCurves, levelConfigOf(1), levelConfigOf(60), levelConfigOf(1000000)]);
  check(once === twice, "同一份快照连续落两次结果一致（幂等，重进游戏不会滚雪球）");
  check(levelConfigOf(1) === levelConfigOf(1), "同一级重复求值返回同一个对象（memo 生效，界面刷新不重复算）");

  //#endregion

  //#region 七、经验进度与跨端同公式

  console.log("\n=== 七、经验进度与跨端同公式 ===");
  const need = levelConfigOf(3).exp;
  check(getCurrentLevelExpRate(3, need / 2) === 0.5, "经验进度 = 当前经验 / 该级所需", String(getCurrentLevelExpRate(3, need / 2)));
  check(getCurrentLevelExpRate(3, need * 5) === 1, "超出所需封顶 1（不显示 500%）");
  check(getCurrentLevelExpRate(3, -10) === 0, "负经验按 0（脏存档不显示负进度）");
  check(getCurrentLevelExpRate(0, 100) === 0, "未知等级返回 0 而不是抛错（面板显示 0% 比崩好）");

  const clientSource = read("assets/configs/game-config.ts");
  check(
    /LEVEL_RATIO_MP_OF_HP = 0\.5/.test(clientSource) &&
      /LEVEL_RATIO_HP_RECOVER_OF_HP = 0\.01/.test(clientSource) &&
      /LEVEL_RATIO_FLOOR_OF_MAX = 0\.7/.test(clientSource),
    "客户端比例常量就是 0.5 / 0.01 / 0.7",
  );
  const serverRatios = /ROLE_LEVEL_RATIOS\s*=\s*\{([\s\S]*?)\}/.exec(serverCurveSource);
  check(
    serverRatios && /mpOfHp:\s*0\.5/.test(serverRatios[1]) && /hpRecoverOfHp:\s*0\.01/.test(serverRatios[1]) && /floorOfMax:\s*0\.7/.test(serverRatios[1]),
    "服务端 ROLE_LEVEL_RATIOS 与客户端同值（改一边要两边一起改）",
  );
  check(/k \* \(k - 1\)/.test(clientSource) && /k \* \(k - 1\)/.test(serverCurveSource), "两端的段内公式形状一致（accel×k×(k-1)/2）");
  // 逐级表下线：`levelMap` 只允许留在注释里（真代码里再出现 = 有人把逐行表加回来了）
  const levelMapHits = read("assets/configs/apply-snapshot.ts")
    .split("\n")
    .filter((line) => line.includes("levelMap") && !/^\s*(\*|\/\/)/.test(line));
  check(levelMapHits.length === 0, "assets/ 里 levelMap 只剩注释（逐级表已随 #786 下线）", levelMapHits.join(" | "));
  check(/levelConfigOf\(role\.level\)/.test(read("assets/ui/utils/battle/HpHelper.ts")), "HpHelper 走 levelConfigOf 现算");
  check(/levelConfigOf\(role\.level\)/.test(read("assets/ui/utils/battle/MpHelper.ts")), "MpHelper 走 levelConfigOf 现算");

  //#endregion

  finish("PASS：角色等级曲线（#786）");
}

main();
