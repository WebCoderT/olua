#!/usr/bin/env node
/**
 * 客户端单测 / 工具链的「出厂数据」：`server/data/config-sync.sql` → 快照 DTO 形状的行
 *
 * ===========================================================================
 * 为什么不再 compileServerShared("xxx-seed.ts")
 * ===========================================================================
 * #655 把出厂数据整体搬进了库：`server/src/shared/` 那个目录已经删除，数据只有一处
 * 权威 —— 数据库；而**库的逐行投影**就是仓库里这份快照（`make config-export` 生成，
 * 空库启动时由 `bootstrapConfigSnapshot()` 整份灌进去）。
 *
 * 所以单测要「灌一份出厂数据进客户端表」，来源只能是它。灌的时候走**线上同一条路**：
 * `applyConfigSnapshot` 用的那些 `apply*` 函数，入参是快照 DTO 形状（`GET /game-config`
 * 的那一份）。这个文件只做一件事：把 SQL 的列变成 DTO 的字段（`physical_attack_min/max`
 * → `physicalAttack: { min, max }`、`0/1` → `boolean`、TEXT → 数组），**不造任何数值**。
 *
 * 三端列名契约在服务端 `modules/game-config/dto/*.ts` 的 `from()` 里，那边加字段这里跟。
 * 少映射一个字段的症状是「单测里那个字段是 undefined」，不是静默错值。
 */
"use strict";

const path = require("node:path");
const { readRowsCamel, readSnapshotText } = require(
  path.join(__dirname, "..", "..", "..", "tools", "lib", "snapshot-sql.cjs"),
);

/** 六项区间属性的键（maxHp / hpRecover 是单值，不在这里） */
const RANGE_KEYS = ["physicalAttack", "magicAttack", "taoistAttack", "physicalDefense", "magicDefense", "taoistDefense"];

const text = () => readSnapshotText();

/** 某张表的原始行（camelCase 列名，JSON 列已解开） */
function rows(table) {
  const result = readRowsCamel(text(), table);
  if (result.length === 0) throw new Error(`快照里没有表 ${table} 的行（跑一次 make config-export？）`);
  return result;
}

/** 某张表的「主键 → 行」索引 */
function index(table, key = "id") {
  const result = {};
  for (const row of rows(table)) result[String(row[key])] = row;
  return result;
}

//#region 形状换算（SQL 列 → 快照 DTO 字段）

/** 八项属性块（区间是 `{ min, max }` 对象，不是元组） */
function attributes(row) {
  const block = { maxHp: row.maxHp, hpRecover: row.hpRecover };
  for (const key of RANGE_KEYS) {
    block[key] = { min: row[`${key}Min`] ?? 0, max: row[`${key}Max`] ?? 0 };
  }
  return block;
}

/** 只有六项区间的属性块（等级表 / 怪物属性表：maxHp 在外层单列） */
function ranges(row) {
  const block = {};
  for (const key of RANGE_KEYS) {
    block[key] = { min: row[`${key}Min`] ?? 0, max: row[`${key}Max`] ?? 0 };
  }
  return block;
}

const bool = (value) => value === 1 || value === true || value === "1";

//#endregion

//#region 各域（名字对齐快照段的语义，不跟 SQL 表名走）

/** 称号表（行序 = 等级升序，与「第 N 阶」一一对应） */
function titles() {
  return rows("titles")
    .sort((a, b) => a.level - b.level)
    .map((row) => ({
      level: row.level,
      label: row.label,
      description: row.description,
      animation: row.animation,
      animationFrameRate: row.animationFrameRate,
      bindGold: row.bindGold,
      acquireChannel: row.acquireChannel,
      upgradeOrder: row.upgradeOrder ?? null,
      attributes: attributes(row),
      updatedAt: row.updatedAt,
    }));
}

/** 战魂表 */
function souls() {
  return rows("souls")
    .sort((a, b) => a.level - b.level)
    .map((row) => ({
      level: row.level,
      label: row.label,
      description: row.description,
      animation: row.animation,
      animationFrameRate: row.animationFrameRate,
      bindGold: row.bindGold,
      upgradeOrder: row.upgradeOrder,
      attributes: attributes(row),
      updatedAt: row.updatedAt,
    }));
}

/** 军衔表 */
function ranks() {
  return rows("ranks")
    .sort((a, b) => a.level - b.level)
    .map((row) => ({
      level: row.level,
      label: row.label,
      tier: row.tier,
      description: row.description,
      bindGold: row.bindGold,
      attributes: attributes(row),
      updatedAt: row.updatedAt,
    }));
}

/**
 * 等级曲线段（#786：4 条 × 6 段 = 24 行，取代原来的逐级表）
 *
 * 断言里**不在测试侧重算公式** —— 「第 N 级多少血」是行为契约，直接写期望值
 * （1 级 100、60 级 98720…），公式本身由 `test-level-curve` 与服务端逐年比对。
 */
function levelCurves() {
  return rows("role_level_curves")
    .sort((a, b) => (a.curve === b.curve ? a.seq - b.seq : String(a.curve).localeCompare(String(b.curve))))
    .map((row) => ({
      curve: row.curve,
      seq: row.seq,
      fromLevel: row.fromLevel,
      toLevel: row.toLevel,
      startValue: row.startValue,
      perLevel: row.perLevel,
      accel: row.accel,
      updatedAt: row.updatedAt,
    }));
}

/** 曲线求值（与 `client/assets/configs/game-config.ts` 的 `curveValueOf` 同一公式，只给测试当基准） */
function curveAt(segments, curve, level) {
  let picked = null;
  for (const row of segments) {
    if (row.curve !== curve || row.fromLevel > level) continue;
    if (!picked || row.fromLevel > picked.fromLevel) picked = row;
  }
  if (!picked) return null;
  const k = level - picked.fromLevel;
  return Math.round(picked.startValue + picked.perLevel * k + (picked.accel * k * (k - 1)) / 2);
}

/**
 * 前 `limit` 级的裸属性阶梯（默认 60 级 = 旧逐级表的对照区间）
 *
 * 标题 / 军衔 / 战魂那几个测试要拿「角色本体裸血」当上限基准 ——
 * 用 60 级这一档做基准，与 #786 之前完全一致（上限改成 100 万不影响「次级成长线不该盖过本体」）。
 */
function levelRows(limit = 60) {
  const segments = levelCurves();
  const list = [];
  for (let level = 1; level <= limit; level += 1) {
    const hp = curveAt(segments, "hp", level);
    const attackMax = curveAt(segments, "attack_max", level);
    const defenseMax = curveAt(segments, "defense_max", level);
    const exp = curveAt(segments, "exp", level);
    if (hp === null || attackMax === null || defenseMax === null || exp === null) continue;
    list.push({
      level,
      maxHp: hp,
      maxMp: Math.round(hp / 2),
      hpRecover: Math.round(hp / 100),
      exp,
    });
  }
  return list;
}

/**
 * 装备变体（每件基础件 15 行，**每行自带最终属性**）
 *
 * 变体行只有「和基础件不同的那几列」—— 部位 / 图标 / 几何 / 展示名都在基础件上，
 * 所以要按 `baseId` 拼一次（服务端 `EquipmentVariantDto.fromVariant` 同一口径）。
 */
function equipmentVariants() {
  const bases = index("equipments");
  const list = [];
  for (const row of rows("equipment_variants")) {
    const base = bases[row.baseId];
    if (!base) continue;
    list.push({
      id: row.id,
      baseId: row.baseId,
      prefix: row.prefix,
      suffix: row.suffix,
      slot: base.slot,
      description: base.description,
      occupation: base.occupation,
      sex: base.sex,
      icon: base.icon,
      inAtlas: base.inAtlas,
      outAtlas: base.outAtlas,
      tags: base.tags ?? [],
      outScale: base.outScale,
      inScaleX: base.inScaleX,
      inScaleY: base.inScaleY,
      inRotate: base.inRotate,
      inPosX: base.inPosX,
      inPosY: base.inPosY,
      outPositions: base.outPositions ?? [],
      label: row.label,
      level: row.level,
      sellPrice: row.sellPrice,
      attributes: attributes(row),
      updatedAt: row.updatedAt,
    });
  }
  return list;
}

/** 装备槽位（行序 = 排序号，客户端 `order` 就是它） */
function equipmentSlots() {
  return rows("equipment_slots")
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((row) => ({
      key: row.key,
      label: row.label,
      imageSrc: row.imageSrc,
      position: row.position,
      order: row.sortOrder,
      updatedAt: row.updatedAt,
    }));
}

/** 装备规则（前后缀倍率 / 品质文案与配色；回收价 #655 起逐条在 equipment_variants.sell_price） */
function equipmentMeta() {
  const row = rows("equipment_meta")[0];
  return {
    prefixRates: row.prefixRates,
    suffixRates: row.suffixRates,
    prefixLabels: row.prefixLabels,
    suffixLabels: row.suffixLabels,
    prefixColors: row.prefixColors ?? [],
    suffixColors: row.suffixColors ?? [],
    updatedAt: row.updatedAt,
  };
}

/** 药品 */
function drugs() {
  return rows("drugs").map((row) => ({
    id: row.id,
    label: row.label,
    description: row.description,
    icon: row.icon,
    level: row.level,
    sellPrice: row.sellPrice,
    maxStack: row.maxStack,
    cooldown: row.cooldown,
    effectHp: row.effectHp,
    effectMp: row.effectMp,
    effectHpPercent: row.effectHpPercent,
    effectMpPercent: row.effectMpPercent,
    updatedAt: row.updatedAt,
  }));
}

/** 材料 / 杂物 */
function items() {
  return rows("items").map((row) => ({
    id: row.id,
    type: row.type,
    label: row.label,
    description: row.description,
    icon: row.icon,
    level: row.level,
    sellPrice: row.sellPrice,
    maxStack: row.maxStack,
    updatedAt: row.updatedAt,
  }));
}

/**
 * 货币道具（#785）：绑定元宝（唯一货币）
 *
 * 与药品同一套字段（快照 DTO 就是表行的驼峰版），多带 `currency`（入账到哪个账本字段）
 * 与 `amount`（一件加多少）。
 */
function moneyItems() {
  return rows("money_items").map((row) => ({
    id: row.id,
    label: row.label,
    description: row.description,
    icon: row.icon,
    currency: row.currency,
    amount: row.amount,
    maxStack: row.maxStack,
    sellPrice: row.sellPrice,
    updatedAt: row.updatedAt,
  }));
}

/**
 * 升级卷轴（#787）：与快照 `levelScrolls` 段同形（表行的驼峰版）
 *
 * 多带两列等级区间（`minLevel` / `maxLevel`）—— 客户端只用于本地预检与陈列，
 * 真正的 +1 与区间判定在服务端（`role.levelScrollUse`）。
 */
function levelScrolls() {
  return rows("level_scrolls").map((row) => ({
    id: row.id,
    label: row.label,
    description: row.description,
    icon: row.icon,
    minLevel: row.minLevel,
    maxLevel: row.maxLevel,
    maxStack: row.maxStack,
    sellPrice: row.sellPrice,
    updatedAt: row.updatedAt,
  }));
}

/** 怪物（数值已逐条落库，六项区间在 attributes 里） */function monsters() {
  return rows("monsters")
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((row) => ({
      id: row.id,
      label: row.label,
      tier: row.tier,
      level: row.level,
      maxHp: row.maxHp,
      attributes: ranges(row),
      updatedAt: row.updatedAt,
    }));
}

/** 怪物表现（几何 / 手感；`aggressive` 是布尔，库里是 0/1） */
function monsterPresentations() {
  return rows("monster_presentation").map((row) => ({
    id: row.id,
    icon: row.icon,
    out: row.out,
    outOffset: { x: row.outOffsetX, y: row.outOffsetY },
    contentSize: { width: row.contentWidth, height: row.contentHeight },
    moveSpeed: row.moveSpeed,
    aggressive: bool(row.aggressive),
    detectRange: row.detectRange,
    speedRate: row.speedRate ?? null,
  }));
}

/** NPC（名称 / 对话 / 素材目录 / 缩放 / 偏移） */
function npcs() {
  return rows("npcs").map((row) => ({
    id: row.id,
    label: row.label,
    dialog: row.dialog,
    src: row.src,
    scaleX: row.scaleX,
    scaleY: row.scaleY,
    posX: row.posX,
    posY: row.posY,
    updatedAt: row.updatedAt,
  }));
}

/** 时装 */
function fashions() {
  return rows("fashions").map((row) => ({
    id: row.id,
    label: row.label,
    description: row.description,
    icon: row.icon,
    inRes: row.inRes,
    outRes: row.outRes,
    sellPrice: row.sellPrice,
    acquireChannel: row.acquireChannel,
    attributes: attributes(row),
    updatedAt: row.updatedAt,
  }));
}

/** 技能（三个开关列在库里是 0/1） */
function skills() {
  return rows("skills").map((row) => ({
    id: row.id,
    owner: row.owner,
    label: row.label,
    icon: row.icon,
    category: row.category,
    targetType: row.targetType,
    action: row.action,
    effect: row.effect,
    effectOnSelf: bool(row.effectOnSelf),
    cooldown: row.cooldown,
    mpCost: row.mpCost,
    distance: row.distance,
    levelReq: row.levelReq,
    description: row.description,
    damageCoefficients: row.damageCoefficients ?? [],
    statusId: row.statusId ?? "",
    castLockMs: row.castLockMs,
    requireTarget: bool(row.requireTarget),
    canAuto: bool(row.canAuto),
    occupation: row.occupation,
    pushDistance: row.pushDistance,
    updatedAt: row.updatedAt,
  }));
}

/** 状态（`combat` 是 JSON 列） */
function statuses() {
  return rows("statuses").map((row) => ({
    id: row.id,
    owner: row.owner,
    label: row.label,
    icon: row.icon,
    duration: row.duration,
    source: row.source,
    description: row.description,
    effect: row.effect,
    effectHoldLast: bool(row.effectHoldLast),
    combat: row.combat ?? {},
    updatedAt: row.updatedAt,
  }));
}

/** 任务（目标 / 奖励在库里是平铺的六列，DTO 上是两个嵌套对象） */
function quests() {
  return rows("quests").map((row) => ({
    id: row.id,
    kind: row.kind,
    label: row.label,
    description: row.description,
    prevQuestId: row.prevQuestId,
    minLevel: row.minLevel,
    npcId: row.npcId,
    objective: { type: row.objectiveType, target: row.objectiveTarget, count: row.objectiveCount },
    rewards: { bindGold: row.rewardBindGold, exp: row.rewardExp, items: row.rewardItems ?? [] },
    updatedAt: row.updatedAt,
  }));
}

/** 成就 */
function achievements() {
  return rows("achievements").map((row) => ({
    id: row.id,
    category: row.category,
    label: row.label,
    description: row.description,
    conditionType: row.conditionType,
    conditionTarget: row.conditionTarget,
    conditionCount: row.conditionCount,
    rewardGold: row.rewardBindGold,
    rewardExp: row.rewardExp,
    rewardItems: row.rewardItems ?? [],
    sortOrder: row.sortOrder,
    hidden: bool(row.hidden),
    updatedAt: row.updatedAt,
  }));
}

/** 具名掉落表（`picks` / `entries` 是 JSON 列） */
function dropTables() {
  return rows("drop_tables").map((row) => ({
    id: row.id,
    picks: row.picks ?? [],
    entries: row.entries ?? [],
    updatedAt: row.updatedAt,
  }));
}

/** 每只怪的掉落（`source` 决定用本行的 entries 还是引用具名表） */
function monsterDrops() {
  return rows("monster_drops").map((row) => ({
    monsterKey: row.monsterKey,
    source: row.source,
    tableId: row.tableId ?? "",
    picks: row.picks ?? [],
    entries: row.entries ?? [],
    updatedAt: row.updatedAt,
  }));
}

/** 新手引导步骤（整份数组存在单行表里） */
function guideSteps() {
  return rows("guide_settings")[0].steps ?? [];
}

/** 战斗力权重（属性名 → 倍率） */
function combatWeights() {
  return Object.fromEntries(rows("combat_weights").map((row) => [row.key, row.weight]));
}

/** 成长标量（等级上限 / 属性区间系数 / 每级经验倍率 / 蓝回复） */
function growthScalars() {
  return Object.fromEntries(rows("growth_scalars").map((row) => [row.key, row.value]));
}

//#endregion

module.exports = {
  RANGE_KEYS,
  rows,
  index,
  attributes,
  ranges,
  titles,
  souls,
  ranks,
  levelCurves,
  curveAt,
  levelRows,
  equipmentVariants,
  equipmentSlots,
  equipmentMeta,
  drugs,
  items,
  moneyItems,
  levelScrolls,
  monsters,
  monsterPresentations,
  npcs,
  fashions,
  skills,
  statuses,
  quests,
  achievements,
  dropTables,
  monsterDrops,
  guideSteps,
  combatWeights,
  growthScalars,
};
