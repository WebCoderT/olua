#!/usr/bin/env node
/**
 * 军衔系统单测（client/tools/test-rank.cjs）
 *
 * 盯的不变量（改军衔系统后必须全绿）：
 * · 序列完整性：100 阶（10 大段 × 10 阶）、阶数连续、衔名唯一、大段顺序与段内强度递增
 * · 数据链路（#590）：客户端是**空运行时表**，唯一数据来源 = 服务端 rank-seed（经快照整表下发）——
 *   客户端行必须与服务端种子逐行一致；血量逐阶严格递增、六维单调不降（低阶相邻两阶的攻防
 *   增量不足 1 点，四舍五入会打平，这是预期）
 * · 强度定位：满衔介于满阶称号与满阶战魂之间（0.39 < 0.525 < 0.675），rate 也夹在两者之间
 * · 价格曲线：晋到 N 阶 = priceBase × N²，逐阶递增，价格基数比称号/战魂都便宜
 * · 头顶红字：军衔是头上那行红字（排在角色名称与血条之间），文案模板带 {rank} 占位、未授衔为空串
 * · 接线：存档迁移（旧档 rank 补 0）、晋升链路、属性加成在服务端权威重算（#541）、入口按钮在角色信息弹窗（不走 NPC）
 * · 工程口径：100 阶列表只在打开时建一次，切换选中不重建（避免重演商城「打开就卡」那个坑）
 *
 * 数据层跑在沙箱里（configs/game-config 的运行时表用**真实服务端种子**灌——见 lib/configs-sandbox.cjs
 * 的 seedRuntimeTables；插值公式断言直接读 server/src/shared/rank-seed.ts 源码），其余源码断言直接读文件。
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, seedRuntimeTables, check, finish } = require("./lib/configs-sandbox.cjs");
/** #655 起配置的唯一来源是数据库快照（server/data/config-sync.sql） */
const factory = require("./lib/factory-data.cjs");

const outDir = prepare("olua-rank", ["configs/game-config.ts", "configs/game-config.ts", "configs/game-config.ts"]);
seedRuntimeTables(outDir);
const rankRows = factory.ranks();
const titleRows = factory.titles();
const soulRows = factory.souls();
const roleLevels = factory.levels();
const { rankLevels, rankMaxLevel, getRankLevel, rankAttributeLabels } = require(path.join(outDir, "configs/game-config.js"));
const { titleLevels } = require(path.join(outDir, "configs/game-config.js"));
const { soulLevels } = require(path.join(outDir, "configs/game-config.js"));

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");
/** 快照行是 {min,max}，客户端运行时表是元组 [min,max] */
const tuple = (range) => (Array.isArray(range) ? range : [range.min, range.max]);
const tupleAttributes = (attributes) => ({
  maxHp: attributes.maxHp,
  hpRecover: attributes.hpRecover,
  physicalAttack: tuple(attributes.physicalAttack),
  magicAttack: tuple(attributes.magicAttack),
  taoistAttack: tuple(attributes.taoistAttack),
  physicalDefense: tuple(attributes.physicalDefense),
  magicDefense: tuple(attributes.magicDefense),
  taoistDefense: tuple(attributes.taoistDefense),
});

console.log("\n— A. 序列完整性（100 阶 = 10 大段 × 10 阶；数据唯一来源 = 库里 rank 表）—");
check(rankRows.length === 100, `军衔表 100 行（实得 ${rankRows.length}）`);
check(rankMaxLevel() === rankLevels.length && rankLevels.length === 100, "rankMaxLevel() 与运行时表等长且为 100");
check(rankLevels.length === rankRows.length, "客户端运行时表行数 = 快照行数（整表重建）");
const seedMismatch = rankLevels.filter((config) => {
  const row = rankRows[config.level - 1];
  return JSON.stringify(config) !== JSON.stringify({
    level: row.level,
    label: row.label,
    tier: row.tier,
    description: row.description,
    bindGold: row.bindGold,
    attributes: tupleAttributes(row.attributes),
  });
});
check(!seedMismatch.length, "客户端每行与快照逐行一致（属性/衔名/大段/价格）", seedMismatch.map((config) => config.level).join("、") || "100 阶全部命中");
check(rankLevels.every((config, index) => config.level === index + 1), "阶数从 1 起连续（下标 + 1 即阶数）");
check(new Set(rankLevels.map((config) => config.label)).size === rankLevels.length, "衔名唯一（100 个各不相同）");
check(rankLevels[0].label === "新兵" && rankLevels[99].label === "兵主临世", `首阶与末阶符合设计（${rankLevels[0].label} → ${rankLevels[99].label}）`);
check(rankLevels.every((config) => config.description.length > 0), "每阶都有描述");
check(rankLevels.every((config) => config.tier.length > 0), "每阶都归属一个大段");

const tiers = [];
rankLevels.forEach((config) => {
  const last = tiers[tiers.length - 1];
  if (!last || last.tier !== config.tier) tiers.push({ tier: config.tier, levels: [config.level] });
  else last.levels.push(config.level);
});
check(tiers.length === 10, `大段数量为 10（${tiers.length}）`);
// 段宽从数据本身量（大段配置在服务端 rank-seed，客户端只收展开后的行）
const rankTierSize = tiers[0]?.levels.length ?? 0;
check(rankTierSize === 10, `每段 10 阶（实测 ${rankTierSize}）`);
check(
  tiers.every((item) => item.levels.length === rankTierSize && item.levels[0] - 1 === (tiers.indexOf(item)) * rankTierSize),
  `每段正好 ${rankTierSize} 阶、且按顺序首尾相接（${tiers.map((item) => item.tier).join(" / ")}）`,
);
check(new Set(tiers.map((item) => item.tier)).size === 10, "大段名称唯一");

console.log("\n— B. 属性曲线（曲线已下架，属性逐阶写在表里；这里盯体感性质）—");

const hpStrictlyIncreasing = rankLevels.every((config, index) => index === 0 || config.attributes.maxHp > rankLevels[index - 1].attributes.maxHp);
check(hpStrictlyIncreasing, "血量逐阶严格递增（升一阶必有可见变化）");
const attrKeys = ["physicalAttack", "magicAttack", "taoistAttack", "physicalDefense", "magicDefense", "taoistDefense"];
const nonDecreasing = rankLevels.every((config, index) => index === 0 || attrKeys.every((key) => config.attributes[key][1] >= rankLevels[index - 1].attributes[key][1] && config.attributes[key][0] >= rankLevels[index - 1].attributes[key][0]));
check(nonDecreasing, "六维属性单调不降（低阶时相邻两阶攻防增量不足 1 点、四舍五入会打平，属预期）");
check(rankLevels.every((config) => attrKeys.every((key) => config.attributes[key][0] <= config.attributes[key][1])), "区间属性下限 ≤ 上限");
check(JSON.stringify(rankAttributeLabels.map((item) => item.key)) === JSON.stringify(["maxHp", ...attrKeys, "hpRecover"]), "属性显示顺序表覆盖全部字段且顺序固定");

// 大段跳档：跨段那一阶的涨幅要明显大于段内相邻阶的涨幅（「换衔」的推进感）
const boundaryJumps = [];
for (let boundary = rankTierSize + 1; boundary < rankMaxLevel(); boundary += rankTierSize) {
  const ratio = (index) => rankLevels[index].attributes.maxHp / rankLevels[index - 1].attributes.maxHp - 1;
  boundaryJumps.push({ boundary, jump: ratio(boundary - 1), normal: ratio(boundary - 2) });
}
check(
  boundaryJumps.every((item) => item.jump > item.normal),
  "跨大段那一阶的涨幅大于段内相邻阶（换段如换衔）",
  boundaryJumps.map((item) => `${item.boundary}阶 +${(item.jump * 100).toFixed(1)}% > ${(item.normal * 100).toFixed(1)}%`).join("；"),
);

const bareMaxHp = roleLevels[roleLevels.length - 1].maxHp;
const rankMaxHp = rankLevels[rankLevels.length - 1].attributes.maxHp;
const titleMaxHp = titleLevels[titleLevels.length - 1].attributes.maxHp;
const soulMaxHp = soulLevels[soulLevels.length - 1].attributes.maxHp;
check(rankMaxHp > titleMaxHp, `满衔强于满阶称号（满衔血量 ${rankMaxHp} > 称号 ${titleMaxHp}）`);
check(rankMaxHp < soulMaxHp, `满衔弱于满阶战魂（满衔血量 ${rankMaxHp} < 战魂 ${soulMaxHp}）`);
check(rankMaxHp < bareMaxHp, `满衔仍低于 60 级角色裸血（${rankMaxHp} < ${bareMaxHp}），不会盖过角色本人`);
console.log("\n— C. 价格曲线（晋到 N 阶 = priceBase × N²，货币 = 绑定元宝）—");
check(rankLevels.every((config) => config.bindGold === rankRows[config.level - 1].bindGold), "价格逐阶来自表（不再由 priceBase × N² 现算）");
check(rankLevels.every((config, index) => index === 0 || config.bindGold > rankLevels[index - 1].bindGold), "价格逐阶递增");
check(rankLevels[0].bindGold < titleRows[0].bindGold && rankLevels[0].bindGold < soulRows[0].bindGold, `首阶价格比称号/战魂都便宜（${rankLevels[0].bindGold} < ${titleRows[0].bindGold} / ${soulRows[0].bindGold}）`);
const totalCost = rankLevels.reduce((total, config) => total + config.bindGold, 0);
check(totalCost > 5000000 && totalCost < 20000000, `100 阶全程合计 ≈ ${(totalCost / 10000).toFixed(0)} 万绑定元宝（长线目标，量级与其它成长线同档）`);

console.log("\n— D. 头顶红字（军衔的唯一外显）—");
check(getRankLevel(0) === null && getRankLevel(-1) === null && getRankLevel(1)?.level === 1 && getRankLevel(101) === null, "getRankLevel：0/负数/越界返回 null，1 起有效");
const uiHelperSource = read("assets/ui/helpers/GameUiHelper.ts");
const hudSource = read("assets/configs/layout/hud.ts");
const textsSource = read("assets/configs/texts.ts");
const headBody = uiHelperSource.split("static createHead(")[1].split("static createRoleName")[0];
check(/static getRankHeadText\(rank: number\)/.test(uiHelperSource) && /getText\("label_rank_head", \{ rank: config\.label \}\)/.test(uiHelperSource), "头顶红字文案统一走 GameUiHelper.getRankHeadText（未授衔返回空串）");
check(/"role_rank"/.test(headBody), "createHead 建出军衔红字节点（role_rank）");
check(!/"role_name"/.test(headBody), "角色名称已移出头顶信息栏（显示在人物区域正中间，见 createRoleName）");
check(/static createRoleName\(role: Role\)/.test(uiHelperSource) && /UiHelper\.createLabel\("role_name", role\.name, layout\.color, layout\.fontSize, layout\.position, layout\.size\)/.test(uiHelperSource), "createRoleName 用 roleShowLayout.name 建名称节点（与怪物名称同一套「身体正中心」口径）");
check(/roleShowLayout\.rank\.(color|fontSize|size)/.test(headBody), "红字的颜色/字号/尺寸取自 configs（不写死在代码里）");
// 红字排列顺序、名称纵坐标、具体色值都是显示效果，靠人眼看，不做断言
check(/label_rank_head: "【\{rank\}】"/.test(textsSource), "头顶红字模板 label_rank_head 带 {rank} 占位（文案唯一来源在 configs/texts）");

console.log("\n— E. 接线（源码断言）—");
const roleSource = read("assets/entities/Role.ts");
const storageSource = read("assets/ui/core/StorageManager.ts");
const helperSource = read("assets/ui/core/GameHelper.ts");
const displaySource = read("assets/ui/components/role/RoleDisplay.ts");
const roleInfoSource = read("assets/ui/components/dialogs/RoleInfoDialog.ts");
const dialogSource = read("assets/ui/components/dialogs/RankUpgradeDialog.ts");
const dialogsLayoutSource = read("assets/configs/layout/dialogs.ts");
const sizesSource = read("assets/configs/layout/sizes.ts");
const panelsSource = read("assets/configs/layout/panels.ts");
const npcSource = read("assets/configs/game-config.ts");
// #603 第七域：NPC 点击行为在 npcClicks（数据在服务端）
const npcClicksSource = read("assets/configs/npcClicks.ts");

check(/rank: number = 0;/.test(roleSource) && /军衔阶数/.test(roleSource), "Role 有 rank 字段（0 = 未授衔）");
check(/typeof role\.rank !== "number"\) role\.rank = 0;/.test(storageSource), "旧存档迁移：rank 缺失补 0（ensureRoleDefaults）");
check(/static async upgradeRank\(\): Promise<boolean>/.test(storageSource) && /nextRankUpgrade\(role\.rank\)/.test(storageSource), "StorageManager.upgradeRank 按链上下一阶预检（军衔按阶，三条线同一口径）");
check(/createTip\("rank_max_tip"\)/.test(storageSource) && /rank_bind_gold_tip/.test(storageSource) && /rank_upgrade_tip/.test(storageSource), "晋升失败/成功都走浮动提示（configs/texts）");
// #250：扣费与落阶都搬到服务端，客户端走三条成长线共用的 upgradeGrowthOnServer
const growthBody = storageSource.slice(storageSource.indexOf("private static async upgradeGrowthOnServer"), storageSource.indexOf("static async upgradeSoul"));
check(/upgradeGrowthOnServer\(role, "rank", next\.level, "rank_upgrade_tip"\)/.test(storageSource), "晋升交给共用的服务端升级流程（本地不再扣费落阶）");
check(/RoleApi\.growthUpgrade\(role\.id, \{ kind, targetLevel: nextLevel, revision: role\.revision \}\)/.test(growthBody), "升级请求带修订号做乐观锁（后台改过 → 20006 被拒）");
check(/role\.bindGold = Number\(data\.bindGold \?\? role\.bindGold\)/.test(growthBody) && /role\.rank = Number\(data\.rank \?\? nextLevel\)/.test(growthBody), "以服务端返回的余额与阶位为准（客户端那套「先扣钱再落阶」已下线）");
check(!/combatCalc/.test(growthBody), "晋升后**不在客户端重算**属性与战斗力（#541 服务端权威：服务端重算落库，roleUpdate 帧带回）");
check(/createHead\("role_head", this\.role\.hp, this\.role\.maxHp, this\.role\.rank\)/.test(displaySource), "RoleDisplay 建头部信息栏时把军衔一并传进去（进图即显示）");
check(/this\.addChild\(GameUiHelper\.createRoleName\(this\.role\)\)/.test(displaySource), "RoleDisplay 把名称节点挂在角色身上（在 appearance 之后添加 → 绘制在角色之上）");
check(/getChildByName\("role_rank"\)/.test(displaySource) && /GameUiHelper\.getRankHeadText\(role\.rank\)/.test(displaySource), "RoleDisplay.updateHead 按名字刷新军衔红字（晋升后无需重进图）");

check(/static createRankCard/.test(uiHelperSource) && /static updateRankCard/.test(uiHelperSource) && /static createRankAttributeList/.test(uiHelperSource) && /static createRankBadge/.test(uiHelperSource), "GameUiHelper 有军衔四零件（卡片 / 卡片状态刷新 / 属性表 / 徽记）");
check(/rankUpgradeDialogLayout\.list\.cardSize/.test(uiHelperSource) && /rankAttributeLabels/.test(uiHelperSource) && /getText\("label_rank_progress"/.test(uiHelperSource), "军衔零件的几何、属性顺序与文案都来自 configs（不写死）");
check(/new RankUpgradeDialog\(\)\.open\(\)/.test(roleInfoSource) && /roleInfoDialogLayout\.rankButton/.test(roleInfoSource), "角色信息弹窗有「军衔」按钮打开军衔弹窗（唯一入口）");
check(!/RankUpgradeDialog/.test(npcClicksSource), "军衔不走 NPC（入口只在角色信息弹窗）");
check(/createRankCard|updateRankCard|createRankBadge|upgradeRank\(\)/.test(dialogSource), "军衔弹窗接线：零件 + 晋升 + 状态刷新");
check(/buildList\(role\?\.rank \?\? 0\);/.test(dialogSource) && !/buildList/.test(dialogSource.split("private selectLevel")[1].split("private updateCardStates")[0]), "100 阶列表只在打开时建一次，切换选中不重建（避免「点一下建 400 个节点」）");
check(/updateRankCard\(card, target <= currentLevel, target === this\.selectedLevel\)/.test(dialogSource), "切换选中只刷受影响的两张卡片外观");
check(/Layout\)\?\.updateLayout\(true\)/.test(dialogSource) && /scrollToOffset\(new Vec2\(0, -card\.position\.y/.test(dialogSource), "打开/晋升后把列表滚到选中那一阶（先强制排版再按卡片实际位置算偏移）");
check(/rank_upgrade_dialog/.test(dialogsLayoutSource) && /rankButton: \{ name: "role_rank_button"/.test(dialogsLayoutSource), "弹窗布局与入口按钮都在 configs/layout/dialogs");
for (const key of ["rank_max_tip", "rank_bind_gold_tip", "rank_upgrade_tip", "label_rank_active", "label_rank_locked", "label_rank_current", "label_rank_none", "label_rank_progress", "label_rank_head"]) {
  check(textsSource.includes(`${key}:`), `文案 key 已登记：${key}`);
}

// 三个入口按钮在角色信息弹窗里竖排相邻（几何全部从配置算，防止日后挪位撞在一起）
console.log("\n— F. 入口几何（军衔 / 称号 / 战魂 三格竖排相邻）—");
{
  const numberPair = (regex) => {
    const hit = dialogsLayoutSource.match(regex);
    return hit ? [Number(hit[1]), Number(hit[2])] : null;
  };
  const rankPos = numberPair(/rankButton: \{ name: "role_rank_button", position: new Vec2\((-?[\d.]+), (-?[\d.]+)\)/);
  const titlePos = numberPair(/titleButton: \{ name: "role_title_button", position: new Vec2\((-?[\d.]+), (-?[\d.]+)\)/);
  const soulPos = numberPair(/soulButton: \{ name: "role_soul_button", position: new Vec2\((-?[\d.]+), (-?[\d.]+)\)/);
  const buttonSize = sizesSource.match(/middleButtonSize: new Size\((-?[\d.]+), (-?[\d.]+)\)/);
  check(!!rankPos && !!titlePos && !!soulPos, "军衔/称号/战魂三个入口按钮都在 configs/layout/dialogs 里（成对齐全）");
  check(!!buttonSize, "能读到中号按钮尺寸（uiSize.middleButtonSize）");
  // 三个按钮的同列/等距/不压装备槽属于显示效果，靠人眼看，不做断言
}

finish("PASS：军衔 100 阶序列、属性/价格曲线、头顶红字与弹窗接线、入口几何全部通过。");
