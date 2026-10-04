/**
 * 生成 assets/configs/monsterDrops.ts
 * 规则：每只怪按「自身等级段」取各部位装备（level ≤ L 且 L-level ≤ 10，最多 2 档），
 * 每件基础装备展开 15 个前后缀变体，权重按前后缀稀有度衰减；药品/材料沿用等级分档规则。
 */
const fs = require("fs");
const path = require("path");

const ROOT = "/Users/tz/workspace/olua";
const EQ_SRC = fs.readFileSync(path.join(ROOT, "assets/configs/equipments.ts"), "utf8");
const MON_SRC = fs.readFileSync(path.join(ROOT, "assets/configs/monster.ts"), "utf8");

// ---------- 1. 基础装备 ----------
const SLOT_BLOCKS = [
  ["WEAPON", "weaponsData", "武器"],
  ["CLOTH", "clothesData", "衣服"],
  ["HELMET", "helmetsData", "头盔"],
  ["BELT", "beltsData", "腰带"],
  ["SHOES", "shoesData", "鞋子"],
  ["NECKLACE", "nicklacesData", "项链"],
  ["RING", "ringsData", "戒指"],
];
const baseEquipment = []; // { key, level, slot, label, tierName }
for (const [slot, varName, cn] of SLOT_BLOCKS) {
  const re = new RegExp("const " + varName + ": EquipmentData\\[\\] = \\[([\\s\\S]*?)\\n\\];");
  const m = EQ_SRC.match(re);
  if (!m) throw new Error("找不到 " + varName);
  const body = m[1];
  const reItem = /key:\s*"([^"]+)",\s*\n\s*level:\s*(\d+),[\s\S]*?label:\s*"([^"]*)"/g;
  let x;
  while ((x = reItem.exec(body))) {
    baseEquipment.push({ key: x[1], level: +x[2], slot, slotLabel: cn, label: x[3] });
  }
}
console.log("基础装备:", baseEquipment.length);

// ---------- 2. 怪物 ----------
const monsters = [];
const reMon = /\{\s*\n\s*key:\s*"([^"]+)",\s*\n\s*level:\s*(\d+),([\s\S]*?)contentSize:/g;
let mm;
while ((mm = reMon.exec(MON_SRC))) {
  const tail = mm[3];
  const tier = /tier:\s*"(\w+)"/.exec(tail);
  const label = /label:\s*"([^"]*)"/.exec(tail);
  monsters.push({ key: mm[1], level: +mm[2], tier: tier ? tier[1] : "normal", label: label ? label[1] : "" });
}
console.log("怪物:", monsters.length);

// ---------- 3. 权重参数 ----------
const PREFIX_LABELS = ["普通的", "强化的", "精良的", "极品的", "超神的"];
const SUFFIX_LABELS = ["人级", "天级", "神级"];
/** 前缀稀有度权重倍率（下标 = EQUIPMENT_PREFIX） */
const PREFIX_MUL = [1, 0.7, 0.45, 0.25, 0.12];
/** 后缀稀有度权重倍率（下标 = EQUIPMENT_SUFFIX） */
const SUFFIX_MUL = [1, 0.5, 0.22];
/** 部位权重倍率（武器/衣服是主力，首饰略低） */
const SLOT_MUL = { WEAPON: 1, CLOTH: 1, HELMET: 0.9, BELT: 0.9, SHOES: 0.9, NECKLACE: 0.8, RING: 0.8 };
/** 各定位下「装备条目权重合计」预算（与药品材料权重同一量纲） */
const TIER_EQUIP_BUDGET = { normal: 44, elite: 70, boss: 96 };
/** 各定位的掉落件数区间（[最小, 最大]，每次结算随机取整数） */
const TIER_PICKS = { normal: [1, 3], elite: [2, 6], boss: [3, 10] };
/** 装备等级窗口：纳入 level ≤ 怪物等级、且低于怪物等级不超过该值的装备 */
const EQUIP_LEVEL_GAP = 10;
/** 每个部位最多纳入几档 */
const MAX_TIER_PER_SLOT = 2;

const round2 = (n) => Math.round(n * 100) / 100;
const fmt = (n) => (Number.isInteger(n) ? String(n) : String(round2(n)));

/** 药品 / 材料条目（按怪物等级分档，沿用原 monsterDrops 规则） */
function drugMaterialEntries(level) {
  const hpDrug = level <= 20 ? "drug_hp_1" : level <= 40 ? "drug_hp_2" : "drug_hp_3";
  const mpDrug = level <= 20 ? "drug_mp_1" : "drug_mp_2";
  const rows = [
    [`{ goodId: "${hpDrug}", weight: 30, count: [1, 2] },`, "药品：" + (level <= 20 ? "小" : level <= 40 ? "中" : "大") + "红"],
    [`{ goodId: "${mpDrug}", weight: 18, count: [1, 2] },`, "药品：" + (level <= 20 ? "小" : "中") + "蓝"],
    [`{ goodId: "material_hide", weight: 10, count: [1, 2] },`, "材料：兽皮"],
    [`{ goodId: "material_cloth", weight: 8, count: [1, 2] },`, "材料：粗布"],
    [`{ goodId: "material_herb", weight: 8, count: [1, 2] },`, "材料：药草"],
  ];
  if (level >= 10) rows.push([`{ goodId: "material_iron", weight: 6, count: [1, 2] },`, "材料：铁矿（10 级起）"]);
  if (level >= 21) {
    rows.push([`{ goodId: "drug_sun", weight: 4, chance: 0.3 },`, "药品：太阳水（21 级起）"]);
    rows.push([`{ goodId: "material_gem", weight: 4, chance: 0.4, count: [1, 2] },`, "材料：宝石（21 级起）"]);
  }
  return rows;
}

/** 该怪物等级可及的装备（按部位取最近 MAX_TIER_PER_SLOT 档） */
function equipmentWindow(level) {
  const picked = [];
  for (const [, , cn] of SLOT_BLOCKS) {
    const slot = SLOT_BLOCKS.find((s) => s[2] === cn)[0];
    const cand = baseEquipment
      .filter((e) => e.slot === slot && e.level <= level && level - e.level <= EQUIP_LEVEL_GAP)
      .sort((a, b) => b.level - a.level)
      .slice(0, MAX_TIER_PER_SLOT);
    picked.push(...cand);
  }
  return picked;
}

// ---------- 4. 生成文件 ----------
const lines = [];
lines.push(`import type { DropEntry, DropPicks } from "../types/drop";`);
lines.push("");
lines.push("/**");
lines.push(" * 怪物独立掉落表（**每只怪一份**，key = configs/monster 的怪物 key）");
lines.push(" *");
lines.push(" * 与 configs/drop 的关系：");
lines.push(" * - configs/drop 只提供具名表（common/elite/boss）与兜底生成器 monsterDrops，");
lines.push(" *   **实际掉落以本文件为准**（configs/monster 建表时优先取这里的条目与抽取次数）");
lines.push(" * - 这里的每一条都是显式数据，改某只怪掉什么、掉多重，直接改对应 key 的 entries");
lines.push(" *");
lines.push(" * 条目构成（按怪物等级 / 定位自动铺好，可手改）：");
lines.push(" * 1. 药品 / 材料：按等级分档（≤20 小药、21~40 中药、41+ 大药；铁矿 10 级起、宝石 21 级起），");
lines.push(" *    红 30 / 蓝 18 / 兽皮 10 / 粗布 8 / 药草 8 / 铁矿 6 / 太阳水 4 / 宝石 4");
lines.push(" * 2. 装备：取「本怪等级可及」的部位档位（level ≤ 怪物等级且不超过 10 级，每部位最多 2 档），");
lines.push(" *    每件基础装备展开全部 15 个前后缀变体（5 前缀 × 3 后缀），**变体 id = 基础 id + _p前缀s后缀**，");
lines.push(" *    普通的·人级沿用基础 id；权重按稀有度衰减：");
lines.push(" *      前缀 ×[1, 0.7, 0.45, 0.25, 0.12]（普通的→超神的）");
lines.push(" *      后缀 ×[1, 0.5, 0.22]（人级→神级）");
lines.push(" *      部位 ×{ 武器/衣服 1，头盔/腰带/鞋子 0.9，项链/戒指 0.8 }");
lines.push(" *      单件基础装备的权重合计 = 该定位的装备预算 ÷ 该怪窗口内基础装备件数");
lines.push(" *      （定位预算：普通 44 / 精英 70 / BOSS 96，与药品材料权重同一量纲）");
lines.push(" * 3. 掉落件数 picks：**每只怪可单独配**，数字 = 固定件数，[最小, 最大] = 件数区间");
lines.push(" *    （例 [3, 10] = 本次掉 3~10 件；每次抽取独立随机、可重复命中同一条目），");
lines.push(" *    默认按定位：普通 [1, 3] / 精英 [2, 6] / BOSS [3, 10]");
lines.push(" *");
lines.push(" * 想整体调节奏（装备更欧 / 更肝 / 一次掉几件）→ 改上面的权重倍率、预算与件数区间后重新生成；");
lines.push(" * 想只改某只怪 → 直接在 configs/monster 该条目里写 drops / dropPicks 覆盖本表。");
lines.push(" */");
lines.push("export interface MonsterDropConfig {");
lines.push("  /** 掉落件数（= 抽取次数）：数字 = 固定件数，[最小, 最大] = 件数区间（每只怪可单独配） */");
lines.push("  picks: DropPicks;");
lines.push("  /** 掉落条目池：每条独立配 weight（权重）/ chance（概率）/ count（数量区间） */");
lines.push("  entries: DropEntry[];");
lines.push("}");
lines.push("");
lines.push("/** 每只怪的独立掉落配置（数组为源，尾部建 Map） */");
lines.push("const monsterDropData: Array<{ key: string } & MonsterDropConfig> = [");

for (const mon of monsters) {
  const tierCn = mon.tier === "boss" ? "BOSS" : mon.tier === "elite" ? "精英" : "普通";
  const win = equipmentWindow(mon.level);
  const perBase = TIER_EQUIP_BUDGET[mon.tier] / win.length;
  const picks = TIER_PICKS[mon.tier];
  lines.push(
    `  /** ${mon.key} · ${mon.label || "未命名"} · ${mon.level} 级 · ${tierCn}（装备 ${win.length} 件基础件 × 15 变体，掉落 ${picks[0]}~${picks[1]} 件） */`
  );
  lines.push("  {");
  lines.push(`    key: "${mon.key}",`);
  lines.push(`    picks: [${picks[0]}, ${picks[1]}],`);
  lines.push("    entries: [");
  for (const [code, note] of drugMaterialEntries(mon.level)) {
    lines.push(`      ${code} // ${note}`);
  }
  lines.push("      // ---- 装备（本等级段可及档位 × 全部前后缀变体） ----");
  for (const eq of win) {
    lines.push(`      // ${eq.slotLabel} · ${eq.label}（${eq.level} 级）`);
    for (let p = 0; p < PREFIX_LABELS.length; p++) {
      for (let s = 0; s < SUFFIX_LABELS.length; s++) {
        const id = p === 0 && s === 0 ? eq.key : `${eq.key}_p${p}s${s}`;
        const w = Math.max(0.1, round2(perBase * PREFIX_MUL[p] * SUFFIX_MUL[s] * SLOT_MUL[eq.slot]));
        lines.push(`      { goodId: "${id}", weight: ${fmt(w)} }, // ${PREFIX_LABELS[p]}·${SUFFIX_LABELS[s]}`);
      }
    }
  }
  lines.push("    ],");
  lines.push("  },");
}
lines.push("];");
lines.push("");
lines.push("/** 怪物独立掉落表（key → 掉落配置） */");
lines.push("export const monsterDropTables = new Map<string, MonsterDropConfig>();");
lines.push("for (const drop of monsterDropData) {");
lines.push("  monsterDropTables.set(drop.key, drop);");
lines.push("}");
lines.push("");
lines.push("/** 取某只怪的独立掉落配置（未配置返回 undefined，由调用方兜底） */");
lines.push("export function getMonsterDropConfig(key: string): MonsterDropConfig | undefined {");
lines.push("  return monsterDropTables.get(key);");
lines.push("}");
lines.push("");

const out = lines.join("\n");
const outPath = path.join(ROOT, "assets/configs/monsterDrops.ts");
fs.writeFileSync(outPath, out, "utf8");
console.log("写入:", outPath);
console.log("行数:", lines.length, " 大小:", (Buffer.byteLength(out) / 1024).toFixed(1), "KB");

// 覆盖校验：所有基础件 + 全部 15 变体是否至少被一只怪掉落
const covered = new Set();
for (const mon of monsters) {
  const win = equipmentWindow(mon.level);
  for (const eq of win) {
    for (let p = 0; p < 5; p++) for (let s = 0; s < 3; s++) covered.add(p === 0 && s === 0 ? eq.key : `${eq.key}_p${p}s${s}`);
  }
}
const all = [];
for (const eq of baseEquipment) for (let p = 0; p < 5; p++) for (let s = 0; s < 3; s++) all.push(p === 0 && s === 0 ? eq.key : `${eq.key}_p${p}s${s}`);
const missing = all.filter((id) => !covered.has(id));
console.log("全量装备:", all.length, " 覆盖:", covered.size, " 缺口:", missing.length, missing.slice(0, 10).join(","));
const perMonster = monsters.map((m) => {
  const win = equipmentWindow(m.level);
  return { key: m.key, level: m.level, tier: m.tier, base: win.length, entries: win.length * 15 + drugMaterialEntries(m.level).length };
});
console.log("条目数 min/max/avg:", Math.min(...perMonster.map((x) => x.entries)), Math.max(...perMonster.map((x) => x.entries)), Math.round(perMonster.reduce((a, b) => a + b.entries, 0) / perMonster.length));
console.log("总条目:", perMonster.reduce((a, b) => a + b.entries, 0));
fs.writeFileSync("/tmp/olua-monster-drop-stats.json", JSON.stringify(perMonster, null, 1));
