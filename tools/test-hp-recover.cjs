#!/usr/bin/env node
/**
 * 每秒血量回复（hpRecover）单测（tools/test-hp-recover.cjs）
 *
 * 盯的不变量（改回血相关配置/接线后必须全绿）：
 * · 等级：裸回血 = 最大生命上限 × attributeRange.hpRecoverRate（逐级核对），逐级单调不降
 * · 装备：**只有防御部位**有回血（衣服/头盔/腰带/鞋子），武器与首饰恒为 0；
 *   防位的回血权重合计 100，穿满防位 = 裸回血 × equipmentGrowth.setPowerRate；
 *   前后缀变体与血量同一口径缩放（超神·神级 = 普通·人级 × 4.2）
 * · 三条成长线：战魂 / 称号 / 军衔各自都有回血，满阶 > 0、且都低于同级裸回血；显示名表把 hpRecover 收进去且顺序固定
 * · 怪物：monsterStats 恒返回 hpRecover = 0（回血是玩家养成的收益，磨血流不许被怪自己回血破坏）
 * · 显示：装备详情按槽位的展示清单（configs/good.goodShowAttributes）取属性，
 *   防御部位与全属性部位列「每秒回血」，只列攻击三属性的首饰不列（口径与最大血量一致）
 * · 结算（真实 HpHelper）：满血不回、死亡不回（不能被回血「复活」）、按经过时间回复、
 *   不足 1 点的余数留在累加器、无回血时不动、回满即封顶
 * · 接线：Role 有字段并按等级初始化、StorageManager.ensureRoleDefaults 补旧存档、
 *   GameHelper.combatCalc 把五处来源相加且不把它当区间属性、Game.update 的每秒块同时结算血与蓝
 *
 * 数据层跑在沙箱里（真实的 configs/growth + soul + title + rank + equipments + good + 真实 HpHelper，
 * 见 lib/configs-sandbox.cjs），源码断言直接读文件。
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish } = require("./lib/configs-sandbox.cjs");

const outDir = prepare("olua-hp-recover", [
  "configs/good.ts",
  "configs/soul.ts",
  "configs/title.ts",
  "configs/rank.ts",
  "configs/equipments.ts",
  "ui/utils/battle/HpHelper.ts",
]);
const { getRoleLevelAttributes, equipmentStats, equipmentSlotShare, equipmentGrowth, monsterStats, attributeRange, roleMaxLevel } = require(path.join(outDir, "configs/growth.js"));
const { soulLevels, soulAttributeLabels } = require(path.join(outDir, "configs/soul.js"));
const { titleLevels, titleAttributeLabels } = require(path.join(outDir, "configs/title.js"));
const { rankLevels, rankAttributeLabels } = require(path.join(outDir, "configs/rank.js"));
const { goodShowAttributes, goodShowAttributesLabel } = require(path.join(outDir, "configs/good.js"));
const { clothes, getEquipmentVariantKey } = require(path.join(outDir, "configs/equipments.js"));
const { EQUIPMENT_TYPE } = require(path.join(outDir, "types/good.js"));
const { default: HpHelper } = require(path.join(outDir, "ui/utils/battle/HpHelper.js"));

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");
const percent = (value) => `${(value * 100).toFixed(1)}%`;

//#region A. 等级：裸回血按血量上限派生

console.log("\n— A. 等级裸回血（= 最大生命 × hpRecoverRate，逐级单调不降）—");
check(attributeRange.hpRecoverRate > 0, `回血率已开启（每秒 ${percent(attributeRange.hpRecoverRate)} 最大生命）`);

const attributes = Array.from({ length: roleMaxLevel }, (_, index) => getRoleLevelAttributes(index + 1));
const last = attributes[attributes.length - 1];
const offBy = attributes.filter((attr) => Math.abs(attr.hpRecover - attr.maxHp * attributeRange.hpRecoverRate) > 0.5);
check(
  offBy.length === 0,
  "每一级的裸回血都等于「最大生命 × 回血率」（四舍五入内）",
  offBy.length ? offBy.map((attr) => `${attr.maxHp}→${attr.hpRecover}`).join("、") : `1 级 ${attributes[0].hpRecover}/秒 → ${roleMaxLevel} 级 ${last.hpRecover}/秒`,
);
check(attributes.every((attr, index) => index === 0 || attr.hpRecover >= attributes[index - 1].hpRecover), "裸回血逐级单调不降（升一级绝不会变少）");
check(attributes[0].hpRecover >= 1, `1 级就有 ${attributes[0].hpRecover} 点/秒，新手期不是死值 0`);

//#endregion

//#region B. 装备：只有防御部位给回血

console.log("\n— B. 装备回血（只有防御部位，穿满 = 裸回血 × setPowerRate）—");
const DEFENSIVE = ["cloth", "helmet", "belt", "shoes"];
const JEWELRY = [EQUIPMENT_TYPE.WEAPON, EQUIPMENT_TYPE.NECKLACE, EQUIPMENT_TYPE.RING, EQUIPMENT_TYPE.ACCESSORIES];
const shareEntries = Object.entries(equipmentSlotShare);
const recoverSlots = shareEntries.filter(([, share]) => share.recover > 0).map(([slot]) => slot).sort();
check(
  JSON.stringify(recoverSlots) === JSON.stringify([...DEFENSIVE].sort()),
  `回血只挂在防御部位（${recoverSlots.join(" / ")}）`,
  shareEntries.filter(([, share]) => share.recover === 0 && share.maxHp > 0).map(([slot]) => `${slot}（有血但无回血）`).join("、") || "无",
);
check(shareEntries.reduce((total, [, share]) => total + share.recover, 0) === 100, "回血权重列合计 100（与血量/攻击/防御三列同一口径，全套不会超 setPowerRate）");
check(DEFENSIVE.every((slot) => equipmentSlotShare[slot].maxHp > 0), "给回血的部位都是血部位（回血由血量派生，不给血的部位不该有回血）");

const jewelryRecover = JEWELRY.map((slot) => `${slot} ${equipmentStats(60, slot).hpRecover}`).join(" / ");
check(JEWELRY.every((slot) => equipmentStats(60, slot).hpRecover === 0), "武器与首饰（武器/项链/戒指/饰品）不回血", jewelryRecover);

const fullDefense = DEFENSIVE.reduce((total, slot) => total + equipmentStats(60, slot).hpRecover, 0);
const bareRecover60 = last.hpRecover;
const expectedFullDefense = bareRecover60 * equipmentGrowth.setPowerRate;
check(
  Math.abs(fullDefense - expectedFullDefense) <= Math.max(2, expectedFullDefense * 0.01),
  `60 级穿满防御部位的回血 ≈ 裸回血的 ${equipmentGrowth.setPowerRate} 倍`,
  `${fullDefense} vs ${expectedFullDefense}（每件各自四舍五入，容差 1%）`,
);
check(equipmentStats(1, EQUIPMENT_TYPE.HELMET).hpRecover === 0, "1 级防具不给回血（几十点血凑不出 1 点/秒，也不做「保底 1」——否则 1 级穿满防具就无敌了）");

// 前后缀变体：回血与血量同一口径缩放（超神·神级 = 4.2 倍）
// 注意装备对象本身不带 id（Map 的 key 才是 id），所以按「基础件（前后缀全 0）」的条件取条目
const baseClothEntry = Array.from(clothes.entries()).find(([, item]) => item.prefix === 0 && item.suffix === 0 && item.level >= 50);
const variantId = getEquipmentVariantKey(baseClothEntry[0], 4, 2);
const variant = clothes.get(variantId);
const variantRate = 1.4 * 3; // equipmentPrefixRates[4] × equipmentSuffixRates[2] = 4.2（超神·神级）
check(
  !!variant && variant.hpRecover === Math.round(baseClothEntry[1].hpRecover * variantRate),
  `前后缀变体的回血按同一倍率缩放（${baseClothEntry[0]} ${baseClothEntry[1].hpRecover} → ${variantId} ${variant && variant.hpRecover}）`,
);

//#endregion

//#region C. 三条成长线

console.log("\n— C. 三条成长线（战魂 / 称号 / 军衔）都有回血 —");
const LINES = [
  { name: "战魂", levels: soulLevels, labels: soulAttributeLabels },
  { name: "称号", levels: titleLevels, labels: titleAttributeLabels },
  { name: "军衔", levels: rankLevels, labels: rankAttributeLabels },
];
const LABEL_KEYS = ["maxHp", "physicalAttack", "magicAttack", "taoistAttack", "physicalDefense", "magicDefense", "taoistDefense", "hpRecover"];
for (const line of LINES) {
  const values = line.levels.map((config) => config.attributes.hpRecover);
  const top = values[values.length - 1];
  check(top > 0 && top < bareRecover60, `${line.name}：满阶 ${top}/秒 > 0 且低于 ${roleMaxLevel} 级裸回血 ${bareRecover60}/秒（不盖过角色本人）`);
  check(values.every((value, index) => index === 0 || value >= values[index - 1]), `${line.name}：回血逐阶单调不降`);
  check(
    JSON.stringify(line.labels.map((item) => item.key)) === JSON.stringify(LABEL_KEYS),
    `${line.name}：属性显示顺序表把 hpRecover 收进去且顺序固定`,
  );
}

//#endregion

//#region D. 显示口径

console.log("\n— D. 显示口径（装备详情与角色属性列表）—");
check(goodShowAttributesLabel.get("hpRecover") === "每秒回血", `装备/角色属性列表里的名字是「${goodShowAttributesLabel.get("hpRecover")}」`);
const defensiveShown = DEFENSIVE.filter((slot) => (goodShowAttributes.get(slot) ?? []).includes("hpRecover"));
check(defensiveShown.length === DEFENSIVE.length, `防御部位的装备详情列出回血（${defensiveShown.join(" / ")}）`);
check(
  JEWELRY.every((slot) => !(goodShowAttributes.get(slot) ?? []).includes("hpRecover")),
  "只列攻击三属性的首饰不列回血（与它们不列最大血量同一口径）",
);
check(
  [EQUIPMENT_TYPE.CLOTH, EQUIPMENT_TYPE.OTHER1, EQUIPMENT_TYPE.OTHER2].every((slot) => (goodShowAttributes.get(slot) ?? []).includes("hpRecover")),
  "全属性部位（衣服 / 其他1 / 其他2）的详情列出回血",
);
const uiHelperSource = read("assets/ui/helpers/GameUiHelper.ts");
check(
  /for \(const element of goodShowAttributesLabel\.keys\(\)\)/.test(uiHelperSource) && /\(goodShowAttributes\.get\(good\.slot\) \?\? \[\]\)\.forEach/.test(uiHelperSource),
  "角色属性列表与装备详情都遍历配置里的属性表（新增一条属性不用改界面代码）",
);

//#endregion

//#region E. 结算（真实 HpHelper）

console.log("\n— E. 结算（真实 HpHelper）—");
const makeRole = (patch) => Object.assign({ level: roleMaxLevel, hp: 5000, maxHp: 10000, hpRecover: 100, hpRecoverAccumulator: 0 }, patch);

let role = makeRole({ hp: 10000 });
check(HpHelper.recover(role, 1000) === false && role.hp === 10000, "满血不回血（不刷屏也不落盘）");

role = makeRole({});
check(HpHelper.recover(role, 1000) === true && role.hp === 5100, "每秒回复量 = 角色的 hpRecover 属性（100/秒 → 1 秒回 100）");

role = makeRole({ hp: 9995 });
check(HpHelper.recover(role, 1000) === true && role.hp === 10000, "回复不会超过最大生命（封顶）");

role = makeRole({ hpRecover: 1 });
check(HpHelper.recover(role, 400) === false && Math.abs(role.hpRecoverAccumulator - 0.4) < 1e-6, "不足 1 点的余数留在累加器里（0.4 秒 → 攒 0.4 点，不放血）");
check(HpHelper.recover(role, 600) === true && role.hp === 5001 && Math.abs(role.hpRecoverAccumulator) < 1e-6, "余数攒够 1 点就回 1 点并清零累加器");

role = makeRole({ hp: 0 });
check(HpHelper.recover(role, 10000) === false && role.hp === 0, "死亡（血量 0）不回血：回血绝不能把角色从死亡流程里「拉起来」");

role = makeRole({ hpRecover: 0 });
check(HpHelper.recover(role, 10000) === false && role.hp === 5000, "无回血属性时什么也不做");

const legacy = { level: 1, hp: 100, maxHp: 100 };
HpHelper.ensureDefaults(legacy);
check(
  legacy.hpRecover === attributes[0].hpRecover && legacy.hpRecoverAccumulator === 0,
  `每秒回血上线前的旧存档会被补齐（缺失字段按 1 级裸回血 ${attributes[0].hpRecover}/秒 兜底）`,
);

// 量级：满养成合计回血 vs 同级普通怪的每秒输出（怪普攻间隔从 configs/monster 源码取，避免整份怪物配置进沙箱）
const monster = monsterStats(roleMaxLevel);
const attackInterval = Number((read("assets/configs/monster.ts").match(/attackInterval:\s*(\d+)/) ?? [])[1]) || 2000;
const average = ([min, max]) => (min + max) / 2;
const monsterDps = Math.max(1, average(monster.physicalAttack) - average(last.physicalDefense)) / (attackInterval / 1000);
const maxInvestment =
  bareRecover60 +
  fullDefense +
  soulLevels[soulLevels.length - 1].attributes.hpRecover +
  titleLevels[titleLevels.length - 1].attributes.hpRecover +
  rankLevels[rankLevels.length - 1].attributes.hpRecover;
check(attackInterval > 0 && monsterDps > 0, `怪物普攻间隔取自配置（${attackInterval}ms → 同级普通怪每秒约 ${Math.round(monsterDps)} 点输出）`);
const bareCoverage = bareRecover60 / monsterDps;
check(
  bareCoverage > 0.15 && bareCoverage < 0.4,
  "裸属性下回血抵消同级怪输出的两成上下（生存时间被拉长，但裸装仍然会死）",
  `${bareRecover60}/秒 抵掉 ${percent(bareCoverage)}，同级裸血生存 ${Math.round(last.maxHp / (monsterDps - bareRecover60))}s（无回血时 ${Math.round(last.maxHp / monsterDps)}s）`,
);
check(
  maxInvestment / monsterDps > 0.6 && maxInvestment / monsterDps < 1.6,
  "满养成合计回血与同级普通怪输出同一量级（能稳住挂机，但不该高出一个数量级）",
  `满养成 ${maxInvestment}/秒（裸 ${bareRecover60} + 防具 ${fullDefense} + 战魂 ${soulLevels[soulLevels.length - 1].attributes.hpRecover} + 称号 ${titleLevels[titleLevels.length - 1].attributes.hpRecover} + 军衔 ${rankLevels[rankLevels.length - 1].attributes.hpRecover}）vs 怪输出 ${Math.round(monsterDps)}/秒`,
);

//#endregion

//#region F. 接线（源码断言）

console.log("\n— F. 接线（源码断言）—");
const roleSource = read("assets/entities/Role.ts");
check(/hpRecover: number;/.test(roleSource) && /hpRecoverAccumulator: number = 0;/.test(roleSource), "Role 有 hpRecover 与 hpRecoverAccumulator 字段");
check(/this\.hpRecover = levelMap\.get\(this\.level\)\.hpRecover;/.test(roleSource), "新建角色按等级初始化回血");

const helperSource = read("assets/ui/core/GameHelper.ts");
check(
  /levelConfig\.hpRecover/.test(helperSource) &&
    /total \+ equipment\.hpRecover, 0\)/.test(helperSource) &&
    /\(soul\?\.attributes\.hpRecover \?\? 0\)/.test(helperSource) &&
    /\(title\?\.attributes\.hpRecover \?\? 0\)/.test(helperSource) &&
    /\(rank\?\.attributes\.hpRecover \?\? 0\)/.test(helperSource),
  "combatCalc 把等级 + 装备 + 战魂 + 称号 + 军衔五处回血相加",
);
check(
  /keyof Omit<BattleAttributes, "maxHp" \| "hpRecover">/.test(helperSource),
  "combatCalc 里 hpRecover 不算区间属性（与 maxHp 一样单独相加，否则会被当成 [min,max] 相加）",
);
check(/Exclude<keyof BattleAttributes, "hpRecover">/.test(read("assets/configs/battle.ts")), "战斗力权重表把 hpRecover 排除在外（回血不计入战斗力/地图门槛）");

check(/HpHelper\.ensureDefaults\(role\);/.test(read("assets/ui/core/StorageManager.ts")), "StorageManager.ensureRoleDefaults 补旧存档的回血字段");
const hpHelperSource = read("assets/ui/utils/battle/HpHelper.ts");
check(/if \(typeof role\.hpRecover !== "number"\)/.test(hpHelperSource), "HpHelper 自己也会兜底缺失字段（不依赖调用方先跑 ensureRoleDefaults）");
check(/if \(role\.hp <= 0 \|\| role\.maxHp <= 0\) return false;/.test(hpHelperSource), "HpHelper 死亡不回复（有守卫）");

const gameSource = read("assets/ui/Game.ts");
check(/const hpChanged = HpHelper\.recover\(role, this\.recoverTimer \* 1000\);/.test(gameSource), "Game.update 的每秒块结算血量回复");
check(
  /const mpChanged = MpHelper\.recover\(role, this\.recoverTimer \* 1000\);[\s\S]*?if \(mpChanged \|\| hpChanged\) \{[\s\S]*?StorageManager\.updateOnlineRole\(role\);[\s\S]*?RoleUIManager\.updateRoleData\(role\);/.test(gameSource),
  "血与蓝共用同一次落盘与刷新（同一秒里写两次存档没意义，还会挤掉同步防抖窗口）",
);
check(/private recoverTimer = 0;/.test(gameSource) && !/mpRecoverTimer/.test(gameSource), "计时器已改名 recoverTimer（不再是「只服务魔法值」的名字）");

const growthSource = read("assets/configs/growth.ts");
check(/"maxHp" \| "physicalAttack"[\s\S]*?"hpRecover">/.test(growthSource) && /hpRecover: 0,/.test(growthSource), "monsterStats 恒返回 hpRecover = 0（并在 MonsterBaseStats 的 Pick 里带上它）");

//#endregion

finish("每秒血量回复验证通过");
