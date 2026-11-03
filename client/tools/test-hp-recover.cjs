#!/usr/bin/env node
/**
 * 每秒血量回复（hpRecover）单测（client/tools/test-hp-recover.cjs）
 *
 * 盯的不变量（改回血相关配置/接线后必须全绿）：
 * · 等级：每级 `hp_recover` 是**那一行自己的列值**（#655 起不再按回血率现算），
 *   这里只校验「是非负数字 + 逐级不降」——**具体数值以库里的为准，运营改了也照绿**
 * · 装备 / 三条成长线：同样只看字段形态（非负数字 + 显示表齐全），不比数值、不比倍率
 * · 怪物：monsterStats 恒返回 hpRecover = 0（回血是玩家养成的收益，磨血流不许被怪自己回血破坏）
 * · 怪物：monsterStats 恒返回 hpRecover = 0（回血是玩家养成的收益，磨血流不许被怪自己回血破坏）
 * · 显示：装备详情按槽位的展示清单（configs/good.goodShowAttributes）取属性，
 *   防御部位与全属性部位列「每秒回血」，只列攻击三属性的首饰不列（口径与最大血量一致）
 * · 结算（真实 HpHelper）：满血不回、死亡不回（不能被回血「复活」）、按经过时间回复、
 *   不足 1 点的余数留在累加器、无回血时不动、回满即封顶
 * · 接线：Role 有字段并按等级初始化、StorageManager.ensureRoleDefaults 补旧存档、
 *   GameHelper.combatCalc 把五处来源相加且不把它当区间属性、Game.update 的每秒块同时结算血与蓝
 *
 * 数据层跑在沙箱里（真实的 configs/game-config + soul + title + rank + equipments + good + 真实 HpHelper，
 * 见 lib/configs-sandbox.cjs），源码断言直接读文件。
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, seedRuntimeTables, check, finish } = require("./lib/configs-sandbox.cjs");
/** #655 起配置的唯一来源是数据库快照（server/data/config-sync.sql） */
const factory = require("./lib/factory-data.cjs");

const outDir = prepare("olua-hp-recover", [
  "configs/good.ts",
  "configs/game-config.ts",
  "configs/game-config.ts",
  "configs/game-config.ts",
  "configs/equipments.ts",
  "ui/utils/battle/HpHelper.ts",
]);
// #655：曲线 / 装备数值 / 怪物数值全部在库里（快照 = server/data/config-sync.sql）；
// 三条成长线与装备条目用快照灌进运行时表（客户端加载期是空表 / 零值占位）
seedRuntimeTables(outDir);
const roleLevels = factory.levels();
const equipmentVariants = factory.equipmentVariants();
const { equipmentPrefixRates, equipmentSuffixRates } = require(path.join(outDir, "configs/game-config.js"));
void equipmentPrefixRates;
void equipmentSuffixRates;
const { soulLevels, soulAttributeLabels } = require(path.join(outDir, "configs/game-config.js"));
const { titleLevels, titleAttributeLabels } = require(path.join(outDir, "configs/game-config.js"));
const { rankLevels, rankAttributeLabels } = require(path.join(outDir, "configs/game-config.js"));
const { goodShowAttributes, goodShowAttributesLabel } = require(path.join(outDir, "configs/good.js"));
const { clothes, getEquipmentVariantKey } = require(path.join(outDir, "configs/equipments.js"));
const { EQUIPMENT_TYPE } = require(path.join(outDir, "types/good.js"));
const { default: HpHelper } = require(path.join(outDir, "ui/utils/battle/HpHelper.js"));

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");
const percent = (value) => `${(value * 100).toFixed(1)}%`;

//#region A. 等级：裸回血的数据形态

console.log("\n— A. 等级裸回血（字段是数字且逐级单调不降；具体数值以库里为准）—");

const attributes = roleLevels;
const last = attributes[attributes.length - 1];
// #655 起每级回血是「那一行自己的列值」，不再由「血量 × 回血率」现算 ——
// 运营改过哪一级就是哪一级，所以这里**不比对任何基准值**，只校验字段形态与单调性
check(
  attributes.every((attr) => Number.isFinite(attr.hpRecover) && attr.hpRecover >= 0),
  "每一级的 hpRecover 都是非负数字（字段格式正常）",
  `1 级 ${attributes[0].hpRecover}/秒 → ${last.level} 级 ${last.hpRecover}/秒`,
);
check(attributes.every((attr, index) => index === 0 || attr.hpRecover >= attributes[index - 1].hpRecover), "裸回血逐级单调不降（升一级绝不会变少）");
check(attributes[0].hpRecover >= 0, `1 级回血 ${attributes[0].hpRecover} 点/秒（不低于 0）`);

//#endregion

//#region B. 装备：回血字段形态

console.log("\n— B. 装备回血字段（逐件配在 equipment_variants.hp_recover 上）—");
const DEFENSIVE = ["cloth", "helmet", "belt", "shoes"];
const JEWELRY = [EQUIPMENT_TYPE.WEAPON, EQUIPMENT_TYPE.NECKLACE, EQUIPMENT_TYPE.RING, EQUIPMENT_TYPE.ACCESSORIES];
const baseVariants = equipmentVariants.filter((row) => row.prefix === 0 && row.suffix === 0);

// #655 起回血是**每一行自己的列值**（曲线 / 权重表都下架了），运营想让哪个部位给就给 ——
// 所以这里不比数值、也不比「谁必须为 0」，只校验字段形态
check(
  equipmentVariants.every((row) => Number.isFinite(row.attributes.hpRecover) && row.attributes.hpRecover >= 0),
  "所有变体行的 hpRecover 都是非负数字（字段格式正常）",
  `${equipmentVariants.length} 行`,
);
check(
  baseVariants.every((row) => Number.isFinite(row.attributes.maxHp) && Number.isFinite(row.attributes.hpRecover)),
  "基础件（p0s0）的血量与回血列都能读出数字（不是缺列 / 空串）",
  `${baseVariants.length} 行`,
);

//#endregion

//#region C. 三条成长线

console.log("\n— C. 三条成长线（战魂 / 称号 / 军衔）的属性显示表 —");
const LINES = [
  { name: "战魂", levels: soulLevels, labels: soulAttributeLabels },
  { name: "称号", levels: titleLevels, labels: titleAttributeLabels },
  { name: "军衔", levels: rankLevels, labels: rankAttributeLabels },
];
const LABEL_KEYS = ["maxHp", "physicalAttack", "magicAttack", "taoistAttack", "physicalDefense", "magicDefense", "taoistDefense", "hpRecover"];
for (const line of LINES) {
  const values = line.levels.map((config) => config.attributes.hpRecover);
  // 每阶数值都是运营自己的（库里逐行），这里只验「能读成数字 + 显示表把 hpRecover 收进去」
  check(
    values.length > 0 && values.every((value) => Number.isFinite(value) && value >= 0),
    `${line.name}：每阶的回血都是非负数字（字段格式正常，值不比对）`,
  );
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
const makeRole = (patch) => Object.assign({ level: roleLevels.length, hp: 5000, maxHp: 10000, hpRecover: 100, hpRecoverAccumulator: 0 }, patch);

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

// 量级探针（「裸回血抵掉同级怪输出两成」「满养成同量级」）随 #655 一并删掉：
// 它比的是「几套数据之间的比例」，运营调任意一处数值都会红，属于多余的数值断言。
// 想知道量级，看管理端「角色等级 / 装备变体 / 战魂 / 称号 / 军衔」五张表的当前值即可。

//#endregion

//#region F. 接线（源码断言）

console.log("\n— F. 接线（源码断言）—");
const roleSource = read("assets/entities/Role.ts");
check(/hpRecover: number;/.test(roleSource) && /hpRecoverAccumulator: number = 0;/.test(roleSource), "Role 有 hpRecover 与 hpRecoverAccumulator 字段");
check(!/levelMap/.test(roleSource), "Role 不再按等级本地算回血（#597 起数值全由服务端算，读档由 HpHelper 兜底）");

const helperSource = read("assets/ui/core/GameHelper.ts");
check(!/combatCalc/.test(helperSource), "GameHelper 里没有本地属性计算（#541 服务端权威：hpRecover 由 roleUpdate 帧下发，客户端只消费）");
check(/Exclude<keyof BattleAttributes, "hpRecover">/.test(read("assets/configs/game-config.ts")), "战斗力权重表把 hpRecover 排除在外（回血不计入战斗力/地图门槛）");

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

// #655：怪物数值在 monsters 表里 —— 表结构里根本没有回血列（怪不回血），
// 断言这条是为了防止有人「顺手」给怪物加一列 hp_recover
check(
  factory.monsters().every((row) => !("hpRecover" in row) && !("hpRecover" in (row.attributes ?? {}))),
  "怪物表不含回血（怪不回血，回血是玩家养成的收益）",
);

//#endregion

finish("每秒血量回复验证通过");
