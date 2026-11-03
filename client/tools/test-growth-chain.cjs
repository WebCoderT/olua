#!/usr/bin/env node
/**
 * 三条成长线（称号 / 战魂 / 军衔）与后台「升级路径」的对齐回归
 *
 * 背景：升级路径由运营在管理端配置 —— 称号的「成长列表」= 获得渠道为「称号升级」的行，
 * 顺序可拖动（`upgrade_order`，与等级号解耦）；战魂 37 阶全量在链上但顺序可拖；
 * 军衔 100 阶天然按阶。这些字段随配置快照下发，客户端**必须按链走**：
 *
 * · **列表只列链上的档** —— 运营没放出的等级不该让玩家看见「点得到的空档」
 * · **下一档 = 链上下一个** —— 不是 `level + 1`（链可能跳号 / 顺序被拖过）
 * · **三态要分开** —— 满级（到链尾）/ 断链（当前档不在链上）/ 未开放（链为空）
 *   ，把后两者说成「已满级」等于把运营改配置的后果伪装成玩家的进度
 *
 * 数据用**真实服务端种子**（title-seed / soul-seed / rank-seed）展开，只在测试里改
 * `acquireChannel` / `upgradeOrder` 两个运营字段 —— 不复刻任何一行数值。
 *
 * 用法：node client/tools/test-growth-chain.cjs
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, compileServerShared, check, finish, fail } = require("./lib/configs-sandbox.cjs");

/** 快照行里的属性是 {min,max} 对象（种子是 [min,max] 元组） */
const toRangeAttributes = (attributes) => ({
  maxHp: attributes.maxHp,
  hpRecover: attributes.hpRecover,
  physicalAttack: { min: attributes.physicalAttack[0], max: attributes.physicalAttack[1] },
  magicAttack: { min: attributes.magicAttack[0], max: attributes.magicAttack[1] },
  taoistAttack: { min: attributes.taoistAttack[0], max: attributes.taoistAttack[1] },
  physicalDefense: { min: attributes.physicalDefense[0], max: attributes.physicalDefense[1] },
  magicDefense: { min: attributes.magicDefense[0], max: attributes.magicDefense[1] },
  taoistDefense: { min: attributes.taoistDefense[0], max: attributes.taoistDefense[1] },
});

/** 源码断言（读真实文件，盯「接线」而不是复刻实现） */
const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");

function main() {
  let outDir;
  try {
    outDir = prepare("olua-growth-chain", ["configs/game-config.ts"]);
  } catch (error) {
    fail(String(error.message ?? error));
    return;
  }

  const cfg = require(path.join(outDir, "configs/game-config.js"));
  const titleSeed = require(compileServerShared("title-seed.ts", "olua-chain-title"));
  const soulSeed = require(compileServerShared("soul-seed.ts", "olua-chain-soul"));
  const rankSeed = require(compileServerShared("rank-seed.ts", "olua-chain-rank"));

  /**
   * 称号行：默认按服务端 seedTitles 的口径（渠道「无法获取」、无链序），
   * patch 只改运营字段，不动任何数值
   */
  const titleRows = (patch) =>
    titleSeed.TITLE_SEEDS.map((row) => {
      const base = { ...row, attributes: toRangeAttributes(row.attributes), acquireChannel: "unavailable", upgradeOrder: null };
      return patch ? { ...base, ...patch(row) } : base;
    });
  const soulRows = (patch) =>
    soulSeed.SOUL_SEEDS.map((row) => {
      const base = { ...row, attributes: toRangeAttributes(row.attributes), upgradeOrder: row.level };
      return patch ? { ...base, ...patch(row) } : base;
    });
  const rankRows = () => rankSeed.RANK_SEEDS.map((row) => ({ ...row, attributes: toRangeAttributes(row.attributes) }));

  console.log("\n=== A. 出厂：一档都没开放 ===");
  cfg.applyTitleRows(titleRows());
  check(cfg.titleLevels.length === titleSeed.TITLE_SEEDS.length, "称号表仍是全量（头顶名牌 / 当前称号展示要用）", String(cfg.titleLevels.length));
  check(cfg.titleUpgradeChain.length === 0, "升级链为空 —— 出厂全部「无法获取」，客户端不该显示它们");
  const closed = cfg.nextTitleUpgrade(0);
  check(closed.kind === "closed", "链空时下一步 = closed（未开放），不能报成 maxed（满级）", closed.kind);

  console.log("\n=== B. 运营开放三档、且故意打乱顺序 ===");
  // 只开放 1 / 3 / 7 三档，链序 7 → 3 → 1（与等级号相反，钉住「链序 ≠ 等级号」）
  const OPEN_ORDER = { 7: 1, 3: 2, 1: 3 };
  cfg.applyTitleRows(
    titleRows((row) => (OPEN_ORDER[row.level] ? { acquireChannel: "upgrade", upgradeOrder: OPEN_ORDER[row.level] } : {})),
  );
  const chain = cfg.titleUpgradeChain;
  check(chain.length === 3, "链只含开出的三档（其余 31 阶不进列表）", chain.map((c) => c.level).join(","));
  check(chain.map((c) => c.level).join(",") === "7,3,1", "链序 = upgradeOrder（运营拖动的顺序，不是等级号顺序）", chain.map((c) => c.level).join(","));
  check(cfg.nextTitleUpgrade(0).config.level === 7, "还没激活（0 阶）→ 链首 7 阶", String(cfg.nextTitleUpgrade(0).config?.level));
  check(cfg.nextTitleUpgrade(7).config.level === 3, "7 阶的下一档 = 链上第 2 位 3 阶（不是 8 阶）", String(cfg.nextTitleUpgrade(7).config?.level));
  check(cfg.nextTitleUpgrade(3).config.level === 1, "3 阶的下一档 = 链上第 3 位 1 阶（链可能倒着走）", String(cfg.nextTitleUpgrade(3).config?.level));
  check(cfg.nextTitleUpgrade(1).kind === "maxed", "链尾 1 阶 → maxed（真的到总头了）", cfg.nextTitleUpgrade(1).kind);
  check(cfg.nextTitleUpgrade(2).kind === "locked", "2 阶不在链上 → locked（断链，不能报满级）", cfg.nextTitleUpgrade(2).kind);
  check(cfg.getTitleLevel(1).label === titleSeed.TITLE_SEEDS[0].label, "getTitleLevel 仍按等级号取（预览 / 头顶名牌不看链序）");
  check(cfg.getTitleLevel(2) !== null, "未开放的 2 阶在表里仍然存在（玩家已获得时头顶照样显示）");

  console.log("\n=== B2. 只有渠道、没有链序的行也要进链（与服务端 listUpgrade 同口径）===");
  cfg.applyTitleRows(titleRows((row) => (row.level === 4 ? { acquireChannel: "upgrade" } : { acquireChannel: row.level === 9 ? "upgrade" : "unavailable", upgradeOrder: row.level === 9 ? 5 : null })));
  check(cfg.titleUpgradeChain.length === 2, "渠道 = upgrade 的两行都在链上（不因为缺链序被顺手过滤掉）", cfg.titleUpgradeChain.map((c) => c.level).join(","));
  check(cfg.titleUpgradeChain[0].level === 4, "缺链序的行排最前（SQLite `ORDER BY upgrade_order ASC` 也是 NULL 在前）", cfg.titleUpgradeChain.map((c) => c.level).join(","));

  console.log("\n=== C. 链随快照整表重建（引用不变，不留幽灵档）===");
  const chainRef = cfg.titleUpgradeChain;
  cfg.applyTitleRows(titleRows((row) => (row.level === 2 ? { acquireChannel: "upgrade", upgradeOrder: 1 } : {})));
  check(cfg.titleUpgradeChain === chainRef, "链数组引用不变（消费方存的引用不会失效）");
  check(cfg.titleUpgradeChain.map((c) => c.level).join(",") === "2", "第二份快照整份替换链（运营关掉 1/3/7、只开 2 → 链只剩 2）", cfg.titleUpgradeChain.map((c) => c.level).join(","));

  console.log("\n=== D. 战魂：全量在链上，但顺序跟运营拖 ===");
  cfg.applySoulRows(soulRows());
  check(cfg.soulUpgradeChain.length === soulSeed.SOUL_SEEDS.length, "战魂 37 阶全量进链（没有获得渠道概念）", String(cfg.soulUpgradeChain.length));
  check(cfg.soulUpgradeChain[0].level === 1 && cfg.nextSoulUpgrade(0).config.level === 1, "出厂链序 = 阶数（0 阶 → 1 阶）");
  // 把 5 阶拖到最前：5 → 1，其余整体后移一位
  cfg.applySoulRows(soulRows((row) => ({ upgradeOrder: row.level === 5 ? 1 : row.level + 1 })));
  check(cfg.soulUpgradeChain[0].level === 5, "拖动后链首 = 被拖上去的 5 阶", String(cfg.soulUpgradeChain[0].level));
  check(cfg.nextSoulUpgrade(0).config.level === 5, "0 阶 → 链首 5 阶");
  check(cfg.nextSoulUpgrade(5).config.level === 1, "5 阶的下一阶 = 链上第 2 位（1 阶），不是 6 阶", String(cfg.nextSoulUpgrade(5).config?.level));
  const soulLast = cfg.soulUpgradeChain[cfg.soulUpgradeChain.length - 1];
  check(cfg.nextSoulUpgrade(soulLast.level).kind === "maxed", `链尾 ${soulLast.level} 阶 → maxed`, cfg.nextSoulUpgrade(soulLast.level).kind);
  check(cfg.nextSoulUpgrade(999).kind === "locked", "表里没有的阶 → locked", cfg.nextSoulUpgrade(999).kind);

  console.log("\n=== E. 军衔：100 阶天然按阶 ===");
  cfg.applyRankRows(rankRows());
  check(cfg.nextRankUpgrade(0).config.level === 1, "未授衔（0 阶）→ 1 阶");
  check(cfg.nextRankUpgrade(99).config.level === 100, "99 阶 → 100 阶");
  check(cfg.nextRankUpgrade(100).kind === "maxed", "100 阶 → maxed");
  check(cfg.nextRankUpgrade(101).kind === "locked", "101 阶（表里没有）→ locked");

  console.log("\n=== F. 接线：三个弹窗只认链，没人再写 + 1 ===");
  const stage = (rel) => read(path.join("assets/ui", rel));
  const titleDialog = stage("components/dialogs/TitleUpgradeDialog.ts");
  const soulDialog = stage("components/dialogs/WarSoulDialog.ts");
  const rankDialog = stage("components/dialogs/RankUpgradeDialog.ts");
  const storageSource = stage("core/StorageManager.ts");
  const uiHelperSource = stage("helpers/GameUiHelper.ts");
  const textsSource = read("assets/configs/texts.ts");

  check(/titleUpgradeChain\.forEach\(/.test(titleDialog) && !/titleLevels\.forEach\(/.test(titleDialog), "称号弹窗列表遍历升级链（不再全量 titleLevels）");
  check(/nextTitleUpgrade\(role\.title\)/.test(titleDialog) && /nextTitleUpgrade\(this\.selectedLevel\)/.test(titleDialog), "称号弹窗的按钮与「下一级增量」都取链上下一个");
  check(/soulUpgradeChain\.forEach\(/.test(soulDialog) && !/soulLevels\.forEach\(/.test(soulDialog), "战魂弹窗列表遍历升级链（不再全量 soulLevels）");
  check(/nextSoulUpgrade\(role\.soulOfWar\)/.test(soulDialog) && /nextSoulUpgrade\(this\.selectedLevel\)/.test(soulDialog), "战魂弹窗的按钮与「下一阶增量」都取链上下一个");
  check(/nextRankUpgrade\(role\.rank\)/.test(rankDialog) && /nextRankUpgrade\(this\.selectedLevel\)/.test(rankDialog), "军衔弹窗走同一套三态口径（结果与 +1 阶等价）");
  check(/nextTitleUpgrade\(role\.title\)/.test(storageSource) && /nextSoulUpgrade\(role\.soulOfWar\)/.test(storageSource) && /nextRankUpgrade\(role\.rank\)/.test(storageSource), "三条线的升级预检都按链取目标档");
  check(!/getTitleLevel\(role\.title \+ 1\)/.test(storageSource) && !/getSoulLevel\(role\.soulOfWar \+ 1\)/.test(storageSource) && !/getRankLevel\(role\.rank \+ 1\)/.test(storageSource), "不再有 `current + 1` 取档（等级号与链序解耦）");
  check(/kind === "closed"/.test(storageSource) && /kind === "locked"/.test(storageSource), "预检区分「未开放」与「断链」（提示不同，不冒充满级）");
  check(/createTitleCard\(item, reached\(item\)/.test(titleDialog) && /createSoulCard\(item, reached\(item\)/.test(soulDialog), "卡片激活态由调用方按链序算好传进去（卡片内不再拿等级号比）");
  check(!/config\.level <= currentLevel/.test(uiHelperSource), "卡片函数不再自己比等级号（激活判定只有一处口径）");
  check(/createChainEmptyLabel/.test(uiHelperSource) && (titleDialog.match(/createChainEmptyLabel/g) || []).length === 1, "链为空时列表有占位（不铺一排假卡片）");

  const labelKeys = [
    "title_chain_locked_tip",
    "soul_chain_locked_tip",
    "rank_chain_locked_tip",
    "title_growth_closed_tip",
    "soul_growth_closed_tip",
    "rank_growth_closed_tip",
    "label_growth_chain_empty",
  ];
  for (const key of labelKeys) check(textsSource.includes(`${key}:`), `文案 key 已登记：${key}`);
  check(/lockedText/.test(read("assets/configs/layout/dialogs.ts")), "按钮有「不可续升」文案位（满级 / 断链 / 未开放共用置灰态，文案分开）");

  finish("PASS：三条成长线与后台升级路径（渠道 / 顺序 / 下一档 / 三态）全部对齐。");
}

main();
