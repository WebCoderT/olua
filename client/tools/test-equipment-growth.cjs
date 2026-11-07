#!/usr/bin/env node
/**
 * 装备数值回归单测（issue #16；#655 起重写）
 *
 * ===========================================================================
 * 为什么重写
 * ===========================================================================
 * #655 之前装备数值是**运行时按公式算**的（`growth-seed.equipmentStats(level, slot)`），
 * 本文件那时逐条验证公式性质。现在公式整条下线：每件装备的八项属性 + 回收价都是
 * `equipment_variants` 表里的一行（每件基础件展开 15 个前后缀变体），由管理端逐条可改。
 *
 * 所以这里改成验证**表本身的性质** —— 公式没了，但这些体感约定还得成立，
 * 改坏了照样是玩家能立刻感觉到的那种错：
 *
 * · 同等级不同部位有清晰强度差（武器攻高防低 / 衣服血防主源 / 回血只在衣服）
 * · 属性是固定值（区间两端同数，详情弹窗只显示一个数）
 * · 低等级小份额部位保底 1（不因取整把项链的防御抹成 0）
 * · 同部位属性随装备等级单调不减（等级升属性不降）
 * · 低级与高级装备拉开明显差距（成长可感知）
 * · 前后缀阶梯里每件基础件的 15 个变体行都在（值不比对，见 #655）
 * · 客户端从快照拿到的那件 = 表里那行（灌表链路真的接通了）
 * · 每个部位的等级覆盖不断层（#777 补完 #18 的缺口后，至少一处够得着等级上限）
 *
 * ⚠️ 一律不锁件数与数值：#777 起基础件从 37 件扩到 685 件（按素材目录批量生成，
 * 占位名 + 等级按编号线性映射），其中 648 件的八项属性还是 0（等运营配）——
 * 「曲线单调」「部位强度差」这类断言只在**已配数值**的件上成立，见 hasStats。
 *
 * 用法：node client/tools/test-equipment-growth.cjs
 */
const path = require("path");
const { prepare, seedRuntimeTables, check, finish, fail } = require("./lib/configs-sandbox.cjs");
/** #655 起配置的唯一来源是数据库快照（server/data/config-sync.sql） */
const factory = require("./lib/factory-data.cjs");

const SLOTS = ["weapon", "cloth", "helmet", "belt", "shoes", "necklace", "ring"];
const RANGE_KEYS = ["physicalAttack", "magicAttack", "taoistAttack", "physicalDefense", "magicDefense", "taoistDefense"];
/** 表里是 {min,max}（DTO 形状），这里统一取上限 / 下限 */
const upper = (value) => (Array.isArray(value) ? value[1] : value?.max ?? value);
const lower = (value) => (Array.isArray(value) ? value[0] : value?.min ?? value);

function main() {
  let outDir;
  try {
    outDir = prepare("olua-equipment-growth", ["configs/items.ts", "configs/game-config.ts", "configs/equipments.ts"]);
  } catch (error) {
    fail(String(error.message ?? error));
    return;
  }
  seedRuntimeTables(outDir);

  const variants = factory.equipmentVariants();
  const meta = factory.equipmentMeta();
  const { items, getItem } = require(path.join(outDir, "configs/items.js"));
  const { isEquipment } = require(path.join(outDir, "types/good.js"));
  const prefixRates = meta.prefixRates;
  const suffixRates = meta.suffixRates;

  /** 基础件（无前缀无后缀）—— 部位与等级的「标准件」 */
  const bases = variants.filter((row) => row.prefix === 0 && row.suffix === 0);
  /**
   * 是否「已经配了数值」的基础件
   *
   * #777 起按素材目录批量新增了 648 件占位件（八项属性全 0、卖价按等级垫底）——
   * 它们存在、能穿、能上架，但数值还没人配。曲线类的断言只对**已配数值**的件成立：
   * 拿占位件去比单调性只会得到「等级 2 的 0 攻击低于等级 1 的 21 攻击」这种噪音。
   * 运营给占位件填了数之后它们自动纳入断言（那时违反才是真错）。
   */
  const hasStats = (row) => Boolean(row.attributes.maxHp || upper(row.attributes.physicalAttack) || upper(row.attributes.physicalDefense));
  // 同等级可能有多件（占位件与手调件混在一起），取「配了数值」的那件当该部位该级的代表
  const baseOf = (slot, level) => bases.find((row) => row.slot === slot && row.level === level && hasStats(row));
  const baseOfSlot = (slot) => bases.filter((row) => row.slot === slot).sort((a, b) => a.level - b.level);

  console.log("\n=== 表规模：每个部位都有基础件 ===");
  // 不锁件数（运营随时加装备）：锁的是「每件基础件展开成 前缀档 × 后缀档 个变体」这条展开规则
  check(
    bases.length > 0 && variants.length === bases.length * prefixRates.length * suffixRates.length,
    `装备变体 ${variants.length} 行 = ${bases.length} 件基础件 × ${prefixRates.length} 前缀 × ${suffixRates.length} 后缀`,
  );
  const missingSlot = SLOTS.filter((slot) => !bases.some((row) => row.slot === slot));
  check(missingSlot.length === 0, "七个部位都有基础件", missingSlot.join(","));

  console.log("\n=== 部位强度差：同为 1 级的七件（唯一都有的等级）===");
  const lv1 = Object.fromEntries(SLOTS.map((slot) => [slot, baseOf(slot, 1)]));
  check(upper(lv1.weapon.attributes.physicalAttack) > upper(lv1.cloth.attributes.physicalAttack) * 2, "武器攻击远高于衣服（部位定位：武器是攻击主源）");
  check(
    lv1.cloth.attributes.maxHp > lv1.weapon.attributes.maxHp && upper(lv1.cloth.attributes.physicalDefense) > upper(lv1.weapon.attributes.physicalDefense),
    "衣服血防都高于武器（部位定位：衣服是血防主源）",
  );
  check(lv1.weapon.attributes.maxHp === 0 && lv1.weapon.attributes.hpRecover === 0, "武器不给血量与回血");
  check(lv1.cloth.attributes.hpRecover > 0, "衣服提供回血（回血是防具的收益）");
  check(lv1.necklace.attributes.hpRecover === 0 && lv1.ring.attributes.hpRecover === 0, "首饰不提供回血");
  check(
    lv1.cloth.attributes.maxHp > lv1.helmet.attributes.maxHp && lv1.helmet.attributes.maxHp > lv1.necklace.attributes.maxHp,
    "血量随部位份额递减（衣服 > 头盔 > 项链）",
  );

  console.log("\n=== 全表性质：固定值 / 保底 ===");
  const notFixed = variants.filter((row) => RANGE_KEYS.some((key) => lower(row.attributes[key]) !== upper(row.attributes[key])));
  check(notFixed.length === 0, `全部 ${variants.length} 行的属性都是固定值（区间两端同数，详情弹窗只显示一个数）`, notFixed.slice(0, 3).map((row) => row.id).join(","));
  check(lv1.necklace.attributes.physicalDefense.min >= 1, "1 级项链防御 ≥ 1（取整不会把首饰的防御抹成 0）");

  console.log("\n=== 曲线性质：同部位随等级单调不减 ===");
  let monotonicOk = true;
  const broken = [];
  const curvePoints = {};
  for (const slot of SLOTS) {
    // 只看配了数值的件（占位件不参与，见 hasStats 的说明）
    const rows = baseOfSlot(slot).filter(hasStats);
    curvePoints[slot] = rows.length;
    for (let index = 1; index < rows.length; index++) {
      const prev = rows[index - 1];
      const next = rows[index];
      if (next.attributes.maxHp < prev.attributes.maxHp) { monotonicOk = false; broken.push(`${slot}@${next.level} maxHp`); }
      for (const key of ["physicalAttack", "physicalDefense"]) {
        if (upper(next.attributes[key]) < upper(prev.attributes[key])) { monotonicOk = false; broken.push(`${slot}@${next.level} ${key}`); }
      }
    }
  }
  check(monotonicOk, "同部位属性随装备等级单调不减（逐级校验，含档界）", broken.slice(0, 5).join(","));
  // 防止上一条变成空断言：一旦所有件都成了占位件（或曲线被删空），「单调」会退化成永真
  const curveSlots = SLOTS.filter((slot) => curvePoints[slot] >= 5);
  check(
    curveSlots.length >= 2,
    `至少两个部位有成型的等级曲线（各 ≥ 5 个已配数值的等级点，实际 ${curveSlots.join("/") || "无"}）`,
    SLOTS.map((slot) => `${slot}:${curvePoints[slot]}`).join(" "),
  );

  console.log("\n=== 成长差距：低级 vs 高级 / 前后缀阶梯 ===");
  const weapon1 = baseOf("weapon", 1);
  const weapon60 = baseOf("weapon", 60);
  const cloth1 = baseOf("cloth", 1);
  const cloth60 = baseOf("cloth", 60);
  // 「拉开多少倍」是对数据比例的断言，运营调任意一级都会红 —— 只留「高级 > 低级」的方向判断
  check(upper(weapon60.attributes.physicalAttack) > upper(weapon1.attributes.physicalAttack), "60 级武器的攻击上限高于 1 级（值不锁）");
  check(cloth60.attributes.maxHp > cloth1.attributes.maxHp, "60 级衣服的血量高于 1 级（值不锁）");

  // #655 起每个变体行的属性就是最终值（不再按「基础 × 前后缀倍率」现算），
  // 所以这里不校验阶梯倍率，只校验「行都在 + 属性是数字」
  let ladderOk = true;
  for (let p = 0; p < prefixRates.length; p++) {
    for (let s = 0; s < suffixRates.length; s++) {
      const row = variants.find((item) => item.id === `weapon_1${p === 0 && s === 0 ? "" : `_p${p}s${s}`}`);
      if (!row || !Number.isFinite(upper(row.attributes.physicalAttack))) ladderOk = false;
    }
  }
  check(ladderOk, "weapon_1 的 15 个变体行都在，且攻击上限都能读成数字（值不比对）");
  const best = upper(variants.find((item) => item.id === "weapon_1_p4s2")?.attributes.physicalAttack);
  check(Number.isFinite(best) && best > 0, `顶配变体（超神·神级）攻击上限 = ${best}（数值以库里为准）`);
  const topVariant = variants.find((item) => item.id === "weapon_1_p4s2");
  check(
    !!topVariant && typeof topVariant.label === "string" && topVariant.label.length > 0,
    "变体的 label 是库里的那一列（管理端改了名称，玩家看到的跟着变）",
  );

  console.log("\n=== 客户端拿到的那件 = 表里那行（灌表链路）===");
  const clientWeapon1 = getItem("weapon_1");
  check(Boolean(clientWeapon1), "客户端 items 里有 weapon_1");
  check(
    JSON.stringify(clientWeapon1?.physicalAttack) === JSON.stringify([weapon1.attributes.physicalAttack.min, weapon1.attributes.physicalAttack.max]),
    "weapon_1 的攻击区间 = 表里的那行（{min,max} → 客户端元组）",
    JSON.stringify(clientWeapon1?.physicalAttack),
  );
  const clientBest = getItem("weapon_1_p4s2");
  check(Boolean(clientBest), "客户端 items 里有顶配变体 weapon_1_p4s2");
  check(clientBest?.level === 1 && clientBest?.prefix === 4 && clientBest?.suffix === 2, "变体的前后缀序号随行下发（客户端据此挑名字与美术）");

  console.log("\n=== 全套口径：实际可及 vs 内容缺口 ===");
  const itemList = Array.from(items.values());
  const activeSlots = SLOTS.filter((slot) => itemList.some((item) => isEquipment(item) && item.slot === slot));
  check(activeSlots.length === 7, `配置里有装备的部位共 ${activeSlots.length} 个（weapon/cloth/helmet/belt/shoes/necklace/ring）`);
  const reachable = Object.fromEntries(
    activeSlots.map((slot) => {
      const rows = baseOfSlot(slot);
      return [slot, rows.length > 0 ? rows[rows.length - 1].level : 0];
    }),
  );
  const levelReport = activeSlots.map((slot) => `${slot}@${reachable[slot]}`).join(" ");
  // issue #18 的「五个部位 1 级封顶」缺口已由 #777 按素材补齐 —— 现在锁的是「别再退回断层」：
  // 每个部位都得有能穿到中后期的件，且至少一处够得着等级上限附近
  check(activeSlots.every((slot) => reachable[slot] >= 50), "每个部位的最高装备等级都已成型（≥ 50 级）", levelReport);
  const topSlots = activeSlots.filter((slot) => reachable[slot] >= 59);
  check(topSlots.length >= 1, `至少一个部位够得着等级上限（≥ 59 级：${topSlots.join("/") || "无"}）`, levelReport);

  finish("PASS：装备数值表的部位强度差 / 前后缀阶梯 / 等级成长 / 单调性 / 灌表链路全部成立。");
}

main();
