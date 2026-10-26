#!/usr/bin/env node
/**
 * 百分比药品单测（client/tools/test-drug-percent.cjs，issue #159）
 *
 * 盯的不变量（改强效血/蓝药的口径后必须全绿）：
 * · drug_hp_pct / drug_mp_pct 注册进物品总表，效果是百分比（hpPercent/mpPercent），图标指向真实存在的 60×60 PNG
 * · resolveDrugRecovery（纯函数）：固定值与百分比各自累加、按 maxHp/maxMp 折算、四舍五入、负值按 0、空效果归零
 * · **所有怪物均可掉落**：configs/monsterDrops 每只怪的条目池都含这两个 id；configs/drop 的
 *   三张具名表（common/elite/boss）与 defaultDropTable 也不缺（兜底口径一致）
 * · 接线：StorageManager.useDrug 走 resolveDrugRecovery（不另抄一份回复量口径），魔法满值提示文案存在
 *
 * 数据层跑在沙箱里（真实的 configs/items + monsterDrops + drop，见 lib/configs-sandbox.cjs）。
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish } = require("./lib/configs-sandbox.cjs");

// monsterDrops.ts / drop.ts 只依赖 types（type-only），可与 items 同批编译
const outDir = prepare("olua-drug-percent", ["configs/monsterDrops.ts", "configs/drop.ts"]);
const { items, resolveDrugRecovery } = require(path.join(outDir, "configs/items.js"));
const { monsterDropTables } = require(path.join(outDir, "configs/monsterDrops.js"));
const { dropTables, defaultDropTable } = require(path.join(outDir, "configs/drop.js"));
const { GOOD_TYPE, isDrug } = require(path.join(outDir, "types/good.js"));

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");

console.log("\n— A. 新药注册与配置 —");
const HP_ID = "drug_hp_pct";
const MP_ID = "drug_mp_pct";
const hpDrug = items.get(HP_ID);
const mpDrug = items.get(MP_ID);
check(!!hpDrug && isDrug(hpDrug), `${HP_ID} 已注册且是药品`);
check(!!mpDrug && isDrug(mpDrug), `${MP_ID} 已注册且是药品`);
if (hpDrug && mpDrug) {
  check(hpDrug.type === GOOD_TYPE.DRUG && mpDrug.type === GOOD_TYPE.DRUG, "两条都挂在 GOOD_TYPE.DRUG 大类下");
  check(
    hpDrug.effects.length === 1 && hpDrug.effects[0].hpPercent > 0 && !hpDrug.effects[0].hp,
    "强效血药按 hpPercent 百分比回复（不带固定值）",
    `hpPercent = ${hpDrug.effects[0].hpPercent}`,
  );
  check(
    mpDrug.effects.length === 1 && mpDrug.effects[0].mpPercent > 0 && !mpDrug.effects[0].mp,
    "强效蓝药按 mpPercent 百分比回复（不带固定值）",
    `mpPercent = ${mpDrug.effects[0].mpPercent}`,
  );
  check(hpDrug.stackable && mpDrug.stackable, "两条都可叠加");
}

console.log("\n— B. resolveDrugRecovery 纯函数口径 —");
const close = (a, b) => Math.abs(a - b) < 1e-9;
{
  const r = resolveDrugRecovery([{ hp: 60 }], 1000, 500);
  check(close(r.hp, 60) && close(r.mp, 0), "固定值 hp 原样生效", `hp=${r.hp} mp=${r.mp}`);
}
{
  const r = resolveDrugRecovery([{ hpPercent: 50 }], 1000, 500);
  check(close(r.hp, 500) && close(r.mp, 0), "hpPercent 按角色 maxHp 折算", `hp=${r.hp}`);
}
{
  const r = resolveDrugRecovery([{ mpPercent: 50 }], 1000, 500);
  check(close(r.hp, 0) && close(r.mp, 250), "mpPercent 按角色 maxMp 折算", `mp=${r.mp}`);
}
{
  const r = resolveDrugRecovery([{ hp: 60 }, { hpPercent: 50 }], 1000, 500);
  check(close(r.hp, 560), "固定值与百分比同条叠加（60 + 50%×1000 = 560）", `hp=${r.hp}`);
}
{
  const r = resolveDrugRecovery([{ hpPercent: 33 }], 100, 100);
  check(close(r.hp, 33), "结果四舍五入取整", `hp=${r.hp}`);
}
{
  const r = resolveDrugRecovery([{ hp: -5, hpPercent: -50 }], 1000, 500);
  check(close(r.hp, 0) && close(r.mp, 0), "负值一律按 0（配置写错不倒扣）", `hp=${r.hp}`);
}
{
  const r = resolveDrugRecovery([], 1000, 500);
  check(close(r.hp, 0) && close(r.mp, 0), "空效果归零（useDrug 会走「未开放」提示）");
}

console.log("\n— C. 所有怪物均可掉落 —");
let monsterCount = 0;
let missingHp = 0;
let missingMp = 0;
monsterDropTables.forEach((config) => {
  monsterCount += 1;
  const ids = new Set(config.entries.map((entry) => entry.goodId));
  if (!ids.has(HP_ID)) missingHp += 1;
  if (!ids.has(MP_ID)) missingMp += 1;
});
check(monsterCount > 0, `每怪独立掉落表非空（${monsterCount} 只怪）`);
check(missingHp === 0 && missingMp === 0, `每只怪的条目池都含强效血/蓝药（缺血 ${missingHp} / 缺蓝 ${missingMp}）`);
["common", "elite", "boss"].forEach((id) => {
  const ids = new Set(dropTables.get(id).entries.map((entry) => entry.goodId));
  check(ids.has(HP_ID) && ids.has(MP_ID), `具名掉落表 ${id} 也含两条强效药`);
});
{
  const ids = new Set(defaultDropTable.entries.map((entry) => entry.goodId));
  check(ids.has(HP_ID) && ids.has(MP_ID), "defaultDropTable 兜底同样含两条强效药");
}

console.log("\n— D. 图标素材 —");
[HP_ID, MP_ID].forEach((id) => {
  const good = items.get(id);
  const rel = good ? path.join("assets", "resources", `${good.icon}.png`) : "";
  const file = path.join(PROJECT_ROOT, rel);
  if (!good || !fs.existsSync(file)) {
    check(false, `${id} 的图标文件存在`, rel);
    return;
  }
  const head = fs.readFileSync(file).subarray(0, 8);
  const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  check(isPng, `${id} 图标扩展名与真实格式一致（PNG 魔数）`, rel);
  // 垫片没有引擎 Image，直接读 PNG 头的 IHDR 宽高（大端，偏移 16/20）
  const buf = fs.readFileSync(file);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  check(width === 60 && height === 60, `${id} 图标为 60×60`, `${width}×${height}`);
  check(good.icon.startsWith("item/"), `${id} 的 icon 走 resources/item 目录`, good.icon);
});

console.log("\n— E. 接线与文案 —");
{
  const code = read(path.join("assets", "ui", "core", "StorageManager.ts"));
  // 只看 useDrug 的方法体，别被文件里其他 resolveDrugRecovery 引用干扰
  // （#308 之后签名是 `static async useDrug(...)`，定位不能用 "static useDrug(" 这种同步写法）
  const start = code.search(/static (?:async )?useDrug\(/);
  const body = start < 0 ? "" : code.slice(start, code.indexOf("static ", start + 10));
  check(body.includes("resolveDrugRecovery"), "useDrug 走 resolveDrugRecovery（回复量口径只有一份）");
  check(!/effects\.reduce\(/.test(body), "useDrug 不再手抄 reduce 累加旧口径");
  check(/RoleApi\.drugUse\(role\.id, \{ row, col, revision: role\.revision \}\)/.test(body), "用药收权：扣格与回血由服务端算（客户端只报格子 + 修订号）");
}
{
  const texts = read(path.join("assets", "configs", "texts.ts"));
  check(texts.includes("drug_mp_full_tip"), "魔法满值提示文案存在（drug_mp_full_tip）");
}

finish("百分比药品：全部断言通过");
