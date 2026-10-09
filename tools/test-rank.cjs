#!/usr/bin/env node
/**
 * 军衔系统单测（tools/test-rank.cjs）
 *
 * 盯的不变量（改军衔系统后必须全绿）：
 * · 序列完整性：100 阶（10 大段 × 10 阶）、阶数连续、衔名唯一、大段顺序与段内强度递增
 * · 属性曲线：每阶属性 = 等效等级(浮点)的角色裸属性 × rate × 大段 factor（与 configs/soul/title 同一套做法）；
 *   血量逐阶严格递增、六维单调不降（低阶相邻两阶的攻防增量不足 1 点，四舍五入会打平，这是预期）
 * · 强度定位：满衔介于满阶称号与满阶战魂之间（0.39 < 0.525 < 0.675），rate 也夹在两者之间
 * · 价格曲线：晋到 N 阶 = priceBase × N²，逐阶递增，价格基数比称号/战魂都便宜
 * · 头顶红字：军衔是头上那行红字（排在角色名称与血条之间），文案模板带 {rank} 占位、未授衔为空串
 * · 接线：存档迁移（旧档 rank 补 0）、晋升链路、属性计入 combatCalc、入口按钮在角色信息弹窗（不走 NPC）
 * · 工程口径：100 阶列表只在打开时建一次，切换选中不重建（避免重演商城「打开就卡」那个坑）
 *
 * 数据层跑在沙箱里（真实的 configs/rank + growth + title + soul，见 lib/configs-sandbox.cjs），源码断言直接读文件。
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish } = require("./lib/configs-sandbox.cjs");

const outDir = prepare("olua-rank", ["configs/rank.ts", "configs/title.ts", "configs/soul.ts"]);
const { rankLevels, rankMaxLevel, rankTotal, rankTierSize, rankGrowth, rankUpgradePrice, getRankLevel, rankAttributeLabels } = require(path.join(outDir, "configs/rank.js"));
const { titleLevels, titleGrowth } = require(path.join(outDir, "configs/title.js"));
const { soulLevels, soulGrowth } = require(path.join(outDir, "configs/soul.js"));
const { getRoleLevelAttributes } = require(path.join(outDir, "configs/growth.js"));

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");

console.log("\n— A. 序列完整性（100 阶 = 10 大段 × 10 阶）—");
check(rankTotal === 100, `总阶数是 100（${rankTotal}）`);
check(rankMaxLevel === rankLevels.length && rankLevels.length === 100, "rankMaxLevel 与序列等长且为 100");
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
check(
  tiers.every((item) => item.levels.length === rankTierSize && item.levels[0] - 1 === (tiers.indexOf(item)) * rankTierSize),
  `每段正好 ${rankTierSize} 阶、且按顺序首尾相接（${tiers.map((item) => item.tier).join(" / ")}）`,
);
check(new Set(tiers.map((item) => item.tier)).size === 10, "大段名称唯一");

console.log("\n— B. 属性曲线（等效等级裸属性 × rate × 大段 factor）—");
const FAMILY_FACTORS = [1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.35, 1.4, 1.5];
const factorOf = (level) => FAMILY_FACTORS[Math.floor((level - 1) / rankTierSize)];
function expectedAttributes(level) {
  // 与 configs/rank 同一套换算（阶 → 等效角色等级 → 两侧整数等级插值 → 裸属性打折；等效等级不取整）
  const equivalentLevel = rankGrowth.fromLevel + ((level - 1) / Math.max(1, rankLevels.length - 1)) * (rankGrowth.toLevel - rankGrowth.fromLevel);
  const lower = Math.floor(equivalentLevel);
  const ratio = equivalentLevel - lower;
  const a = getRoleLevelAttributes(lower);
  const b = getRoleLevelAttributes(lower + 1);
  const mix = (x, y) => x + (y - x) * ratio;
  const mixRange = (x, y) => [mix(x[0], y[0]), mix(x[1], y[1])];
  const base = {
    maxHp: mix(a.maxHp, b.maxHp),
    // 回血与血量同一口径：也要按两侧整数等级插值（裸回血由曲线派生，有同样的跳档边界）
    hpRecover: mix(a.hpRecover, b.hpRecover),
    physicalAttack: mixRange(a.physicalAttack, b.physicalAttack),
    magicAttack: mixRange(a.magicAttack, b.magicAttack),
    taoistAttack: mixRange(a.taoistAttack, b.taoistAttack),
    physicalDefense: mixRange(a.physicalDefense, b.physicalDefense),
    magicDefense: mixRange(a.magicDefense, b.magicDefense),
    taoistDefense: mixRange(a.taoistDefense, b.taoistDefense),
  };
  const rate = rankGrowth.rate * factorOf(level);
  const scale = (range) => [Math.round(range[0] * rate), Math.round(range[1] * rate)];
  return { maxHp: Math.round(base.maxHp * rate), hpRecover: Math.round(base.hpRecover * rate), physicalAttack: scale(base.physicalAttack), magicAttack: scale(base.magicAttack), taoistAttack: scale(base.taoistAttack), physicalDefense: scale(base.physicalDefense), magicDefense: scale(base.magicDefense), taoistDefense: scale(base.taoistDefense) };
}
const mismatched = rankLevels.filter((config) => JSON.stringify(config.attributes) !== JSON.stringify(expectedAttributes(config.level)));
check(!mismatched.length, "每阶属性都严格按「等效等级裸属性 × rate × 大段 factor」生成", mismatched.map((config) => config.level).join("、") || "100 阶全部命中");

// 分数等效等级直接喂分段曲线会在档位边界回落（15 阶攻击会掉回 19），必须走两侧整数等级插值
const rankSource = read("assets/configs/rank.ts");
check(/getEquivalentAttributes\(getEquivalentLevel\(level\)\)/.test(rankSource), "属性走「两侧整数等级插值」取裸属性");
check(!/getRoleLevelAttributes\(getEquivalentLevel\(/.test(rankSource), "不把分数等效等级直接喂给 getRoleLevelAttributes（分段曲线在档位边界会对分数级回推、算出更低的属性）");
const fractional = getRoleLevelAttributes(10.2);
const integerTen = getRoleLevelAttributes(10);
check(fractional.physicalAttack[1] < integerTen.physicalAttack[1], `实测记录该陷阱：getRoleLevelAttributes(10.2) 的攻击上限 ${fractional.physicalAttack[1]} < 10 级的 ${integerTen.physicalAttack[1]}（所以必须插值）`);

const hpStrictlyIncreasing = rankLevels.every((config, index) => index === 0 || config.attributes.maxHp > rankLevels[index - 1].attributes.maxHp);
check(hpStrictlyIncreasing, "血量逐阶严格递增（升一阶必有可见变化）");
const attrKeys = ["physicalAttack", "magicAttack", "taoistAttack", "physicalDefense", "magicDefense", "taoistDefense"];
const nonDecreasing = rankLevels.every((config, index) => index === 0 || attrKeys.every((key) => config.attributes[key][1] >= rankLevels[index - 1].attributes[key][1] && config.attributes[key][0] >= rankLevels[index - 1].attributes[key][0]));
check(nonDecreasing, "六维属性单调不降（低阶时相邻两阶攻防增量不足 1 点、四舍五入会打平，属预期）");
check(rankLevels.every((config) => attrKeys.every((key) => config.attributes[key][0] <= config.attributes[key][1])), "区间属性下限 ≤ 上限");
check(JSON.stringify(rankAttributeLabels.map((item) => item.key)) === JSON.stringify(["maxHp", ...attrKeys, "hpRecover"]), "属性显示顺序表覆盖全部字段且顺序固定");

// 大段跳档：跨段那一阶的涨幅要明显大于段内相邻阶的涨幅（「换衔」的推进感）
const boundaryJumps = [];
for (let boundary = rankTierSize + 1; boundary < rankMaxLevel; boundary += rankTierSize) {
  const ratio = (index) => rankLevels[index].attributes.maxHp / rankLevels[index - 1].attributes.maxHp - 1;
  boundaryJumps.push({ boundary, jump: ratio(boundary - 1), normal: ratio(boundary - 2) });
}
check(
  boundaryJumps.every((item) => item.jump > item.normal),
  "跨大段那一阶的涨幅大于段内相邻阶（换段如换衔）",
  boundaryJumps.map((item) => `${item.boundary}阶 +${(item.jump * 100).toFixed(1)}% > ${(item.normal * 100).toFixed(1)}%`).join("；"),
);

const bareMaxHp = getRoleLevelAttributes(rankGrowth.toLevel).maxHp;
const rankMaxHp = rankLevels[rankLevels.length - 1].attributes.maxHp;
const titleMaxHp = titleLevels[titleLevels.length - 1].attributes.maxHp;
const soulMaxHp = soulLevels[soulLevels.length - 1].attributes.maxHp;
check(rankMaxHp > titleMaxHp, `满衔强于满阶称号（满衔血量 ${rankMaxHp} > 称号 ${titleMaxHp}）`);
check(rankMaxHp < soulMaxHp, `满衔弱于满阶战魂（满衔血量 ${rankMaxHp} < 战魂 ${soulMaxHp}）`);
check(rankMaxHp < bareMaxHp, `满衔仍低于 60 级角色裸血（${rankMaxHp} < ${bareMaxHp}），不会盖过角色本人`);
check(rankGrowth.rate > titleGrowth.rate && rankGrowth.rate < soulGrowth.rate, `折扣率夹在称号与战魂之间（${titleGrowth.rate} < ${rankGrowth.rate} < ${soulGrowth.rate}）`);

console.log("\n— C. 价格曲线（晋到 N 阶 = priceBase × N²，货币 = 绑定元宝）—");
check(rankLevels.every((config) => config.bindGold === rankUpgradePrice(config.level)), "每阶 bindGold 与价格曲线一致");
check(rankLevels.every((config) => config.bindGold === Math.round(rankGrowth.priceBase * config.level * config.level)), "价格 = priceBase × N²（与战魂/称号同形态）");
check(rankLevels.every((config, index) => index === 0 || config.bindGold > rankLevels[index - 1].bindGold), "价格逐阶递增");
check(rankGrowth.priceBase < titleGrowth.priceBase && rankGrowth.priceBase < 300, `价格基数比称号/战魂都便宜（${rankGrowth.priceBase}）`);
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
check(/role_rank/.test(headBody) && headBody.indexOf("role_rank") < headBody.indexOf("role_hp_bar"), "军衔红字排在血条之前（即血条上方）");
check(!/"role_name"/.test(headBody), "角色名称已移出头顶信息栏（显示在人物区域正中间，见 createRoleName）");
check(/static createRoleName\(role: Role\)/.test(uiHelperSource) && /UiHelper\.createLabel\("role_name", role\.name, layout\.color, layout\.fontSize, layout\.position, layout\.size\)/.test(uiHelperSource), "createRoleName 用 roleShowLayout.name 建名称节点（与怪物名称同一套「身体正中心」口径）");
check(/name: \{ position: new Vec2\(0, roleBody\.size\.height \/ 2\)/.test(hudSource), "roleShowLayout.name 纵坐标 = roleBody 高度的一半（由推导保证「人物区域正中间」）");
check(/roleShowLayout\.rank\.(color|fontSize|size)/.test(headBody), "红字的颜色/字号/尺寸取自 configs（不写死在代码里）");
check(/rank: \{ fontSize: \d+, size: new Size\([\d.]+, [\d.]+\)[\s\S]{0,40}new Color\(255, 60, 60\)/.test(hudSource), "roleShowLayout.rank 是红色（军衔是杀出来的功名，与白色名称区分）");
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
const npcSource = read("assets/configs/npc.ts");

check(/rank: number = 0;/.test(roleSource) && /军衔阶数/.test(roleSource), "Role 有 rank 字段（0 = 未授衔）");
check(/typeof role\.rank !== "number"\) role\.rank = 0;/.test(storageSource), "旧存档迁移：rank 缺失补 0（ensureRoleDefaults）");
check(/static upgradeRank\(\): boolean/.test(storageSource) && /getRankLevel\(role\.rank \+ 1\)/.test(storageSource), "StorageManager.upgradeRank 按下一阶配置晋升");
check(/createTip\("rank_max_tip"\)/.test(storageSource) && /rank_bind_gold_tip/.test(storageSource) && /rank_upgrade_tip/.test(storageSource), "晋升失败/成功都走浮动提示（configs/texts）");
check(/Object\.assign\(role, GameHelper\.combatCalc\(role\)\)/.test(storageSource.split("static upgradeRank")[1].split("static ")[0]), "晋升后重算属性与战斗力");
check(/role\.bindGold -= next\.bindGold;/.test(storageSource.split("static upgradeRank")[1].split("static ")[0]) && /role\.rank = next\.level;/.test(storageSource), "晋升走「先扣绑定元宝再落阶」");
check(/getRankLevel\(role\.rank\)/.test(helperSource) && /\(rank\?\.attributes\.maxHp \?\? 0\)/.test(helperSource) && /if \(rank\) sources\.push\(rank\.attributes\[key\]\);/.test(helperSource), "combatCalc 把军衔属性计入血量与六维");
check(/createHead\("role_head", this\.role\.hp, this\.role\.maxHp, this\.role\.rank\)/.test(displaySource), "RoleDisplay 建头部信息栏时把军衔一并传进去（进图即显示）");
check(/this\.addChild\(GameUiHelper\.createRoleName\(this\.role\)\)/.test(displaySource), "RoleDisplay 把名称节点挂在角色身上（在 appearance 之后添加 → 绘制在角色之上）");
check(/getChildByName\("role_rank"\)/.test(displaySource) && /GameUiHelper\.getRankHeadText\(role\.rank\)/.test(displaySource), "RoleDisplay.updateHead 按名字刷新军衔红字（晋升后无需重进图）");

check(/static createRankCard/.test(uiHelperSource) && /static updateRankCard/.test(uiHelperSource) && /static createRankAttributeList/.test(uiHelperSource) && /static createRankBadge/.test(uiHelperSource), "GameUiHelper 有军衔四零件（卡片 / 卡片状态刷新 / 属性表 / 徽记）");
check(/rankUpgradeDialogLayout\.list\.cardSize/.test(uiHelperSource) && /rankAttributeLabels/.test(uiHelperSource) && /getText\("label_rank_progress"/.test(uiHelperSource), "军衔零件的几何、属性顺序与文案都来自 configs（不写死）");
check(/new RankUpgradeDialog\(\)\.open\(\)/.test(roleInfoSource) && /roleInfoDialogLayout\.rankButton/.test(roleInfoSource), "角色信息弹窗有「军衔」按钮打开军衔弹窗（唯一入口）");
check(!/RankUpgradeDialog/.test(npcSource), "军衔不走 NPC（入口只在角色信息弹窗）");
check(/createRankCard|updateRankCard|createRankBadge|upgradeRank\(\)/.test(dialogSource), "军衔弹窗接线：零件 + 晋升 + 状态刷新");
check(/buildList\(role\?\.rank \?\? 0\);/.test(dialogSource) && !/buildList/.test(dialogSource.split("private selectLevel")[1].split("private updateCardStates")[0]), "100 阶列表只在打开时建一次，切换选中不重建（避免「点一下建 400 个节点」）");
check(/updateRankCard\(card, config, currentLevel, target === this\.selectedLevel\)/.test(dialogSource), "切换选中只刷受影响的两张卡片外观");
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

  if (rankPos && titlePos && soulPos && buttonSize) {
    const [buttonWidth, buttonHeight] = [Number(buttonSize[1]), Number(buttonSize[2])];
    const gapSoulToTitle = soulPos[1] - titlePos[1] - buttonHeight;
    const gapRankToSoul = rankPos[1] - soulPos[1] - buttonHeight;
    check(rankPos[0] === titlePos[0] && titlePos[0] === soulPos[0], "三个按钮同一列（横坐标一致 → 视觉上相邻成组）");
    check(gapSoulToTitle > 0 && gapRankToSoul > 0 && gapSoulToTitle === gapRankToSoul, `三格等距且不重叠（军衔↔战魂 ${gapRankToSoul}px、战魂↔称号 ${gapSoulToTitle}px、按钮高 ${buttonHeight}）`);

    const rightGroup = panelsSource.match(/right: \{ name: "equipment_slots_right", position: new Vec2\((-?[\d.]+), (-?[\d.]+)\), size: new Size\((-?[\d.]+), (-?[\d.]+)\)/);
    const bottomGroup = panelsSource.match(/bottom: \{ name: "equipment_slots_bottom", position: new Vec2\((-?[\d.]+), (-?[\d.]+)\), size: new Size\((-?[\d.]+), (-?[\d.]+)\)/);
    check(!!rightGroup && !!bottomGroup, "能读到左右/底部装备槽分组几何（configs/layout/panels.equipmentSlotLayout）");
    if (rightGroup && bottomGroup) {
      const buttonLeft = rankPos[0] - buttonWidth / 2;
      const rightGroupRight = Number(rightGroup[1]) + Number(rightGroup[3]) / 2;
      const bottomGroupRight = Number(bottomGroup[1]) + Number(bottomGroup[3]) / 2;
      check(buttonLeft > rightGroupRight, `入口按钮在右列装备槽右侧（按钮左缘 ${buttonLeft} > 槽位右缘 ${rightGroupRight}）`);
      check(buttonLeft > bottomGroupRight, `入口按钮在底部装备槽右侧（按钮左缘 ${buttonLeft} > 槽位右缘 ${bottomGroupRight}）`);
      const bottomGroupTop = Number(bottomGroup[2]) + Number(bottomGroup[4]) / 2;
      const rankButtonBottom = rankPos[1] - buttonHeight / 2;
      check(rankButtonBottom >= bottomGroupTop || buttonLeft > bottomGroupRight, "三个按钮（含最高的军衔）与底部装备槽不同时占据同一区域");
    }
  }
}

finish("PASS：军衔 100 阶序列、属性/价格曲线、头顶红字与弹窗接线、入口几何全部通过。");
