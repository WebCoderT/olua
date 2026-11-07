#!/usr/bin/env node
/**
 * 一次性脚本：把 `resources/item/` 根目录下的散图按语义归位（#777）
 *
 * ## 为什么是脚本
 * `item/` 根目录混着两类图：9 张其实是**装备图标**的数字图（当年拿它当占位，连
 * `items` 表里的「兽皮 / 铁矿 / 粗布 / 宝石 / 药草」也指着它们），12 张 `drug-*.png`
 * 药品图。手工搬必然漏 `.meta` —— Cocos 的 uuid 载体在 `.meta` 里，meta 不带过去，
 * 图片就变成「磁盘上在、工程里不认识」，引用处静默空白。
 *
 * ## 两类规则
 * 1. **装备图标 → `equipment/<部位>/`**：编号第 5 位是类型位，实测对应
 *    2=戒指 / 3=项链 / 4=鞋子 / 6=护腕 / 7=头盔 / 8=腰带（逐个开图标确认过）。
 *    已知的就这 9 张，写成显式表 —— 别拿「第 5 位数字」去猜，猜错就是一件装备顶着
 *    别的部位的图，而且看不出来。
 * 2. **药品图 → `item/consumable/drugs/`**：`drug-*.png` 全量匹配，药品本身就是
 *    「消耗品」这一大类下的一种，留一层 `consumable/` 给以后的卷轴 / 食物。
 *
 * 目录 `.meta` 现算（`ver 1.2.0` + `importer: directory` + 随机 uuid）—— Cocos 打开
 * 工程时认这个；不建的话编辑器会当成「新导入的目录」重排一次 uuid，之前引用过该
 * 目录内资源的 prefab 就断了。
 *
 * 用法：
 *   node tools/oneoff-regroup-item-assets.cjs            # 干跑：打印计划与冲突
 *   node tools/oneoff-regroup-item-assets.cjs --apply    # 落盘
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const ITEM = path.join(ROOT, "client", "assets", "resources", "item");
const EQUIPMENT = path.join(ROOT, "client", "assets", "resources", "equipment");

const apply = process.argv.includes("--apply");

/** 装备图标：item 根目录下的编号 → equipment 下的部位目录（第 5 位类型位，逐个看图确认） */
const EQUIPMENT_ICONS = {
  "2010210": "rings",
  "2020210": "rings",
  "2030210": "rings",
  "2010310": "necklaces",
  "2020310": "necklaces",
  "2030310": "necklaces",
  "2030610": "wristbands",
  "2030702": "helmets",
  "2030810": "belts",
};

/** 药品：`drug-*.png` 全量进这个目录（item 下唯一保留的子目录形态） */
const DRUG_DIR = path.join(ITEM, "consumable", "drugs");

const DIRECTORY_META = (uuid) =>
  JSON.stringify(
    { ver: "1.2.0", importer: "directory", imported: true, uuid, files: [], subMetas: {}, userData: {} },
    null,
    2,
  ) + "\n";

const plan = [];

/** 记一对搬迁（素材 + 它的 .meta） */
function move(from, to) {
  plan.push({ from, to });
  if (fs.existsSync(`${from}.meta`)) plan.push({ from: `${from}.meta`, to: `${to}.meta` });
}

function main() {
  if (!fs.existsSync(ITEM)) {
    console.error(`找不到 ${ITEM}`);
    process.exitCode = 1;
    return;
  }

  for (const [serial, slotDir] of Object.entries(EQUIPMENT_ICONS)) {
    const from = path.join(ITEM, `${serial}.png`);
    if (!fs.existsSync(from)) {
      console.warn(`跳过 ${serial}.png（item 下已没有）`);
      continue;
    }
    move(from, path.join(EQUIPMENT, slotDir, `${serial}.png`));
  }

  const drugs = fs
    .readdirSync(ITEM)
    .filter((name) => /^drug-.*\.png$/.test(name))
    .sort();
  for (const name of drugs) move(path.join(ITEM, name), path.join(DRUG_DIR, name));

  // —— 冲突检查：目标已存在就整批不做（半截搬迁最难收拾）——
  const conflicts = plan.filter((item) => fs.existsSync(item.to));
  if (conflicts.length > 0) {
    console.error("目标已存在，先人工确认：");
    for (const c of conflicts) console.error(`  ${path.relative(ROOT, c.to)}`);
    process.exitCode = 1;
    return;
  }

  const dirs = [...new Set(plan.map((item) => path.dirname(item.to)))];
  console.log(`计划搬迁 ${plan.length} 个文件（${plan.filter((i) => !i.from.endsWith(".meta")).length} 素材 + meta）`);
  for (const dir of dirs) console.log(`  目标目录：${path.relative(ROOT, dir)}`);

  if (!apply) {
    console.log("\n干跑结束。加 --apply 落盘。");
    return;
  }

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
    const metaPath = `${dir}.meta`;
    if (!fs.existsSync(metaPath)) fs.writeFileSync(metaPath, DIRECTORY_META(crypto.randomUUID()));
  }
  for (const item of plan) fs.renameSync(item.from, item.to);

  // item/ 根下搬空了就只剩子目录 + meta，不用删目录本身（Cocos 侧仍然需要它）
  const rest = fs.readdirSync(ITEM).filter((name) => !name.endsWith(".meta"));
  console.log(`\n完成。item/ 根目录剩余：${rest.join("、") || "（空）"}`);
}

main();
