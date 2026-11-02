/**
 * 客户端配置编译管线（gen-shared-data / gen-equip-align-catalog 共用）
 *
 * 客户端 `client/assets/configs` 是三端数据的唯一来源，但它 `import { Vec2 } from "cc"`
 * —— 管理端 / 服务端读不到。两个生成器都要走同一条路：把配置源文件用 tsc 编译进临时目录、
 * 用 cc 垫片让它在 Node 里加载起来、再快照成各自的产物。这套「编译 + 垫片」就收在这里，
 * 生成器只保留自己的 SOURCE_FILES 与 load/快照逻辑。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const ASSETS = path.join(ROOT, "client", "assets");

/** cc 垫片：配置层只用到这几个表现层类 */
const CC_SHIM = `
class Color { constructor(value) { this.value = value; } }
class Vec2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } }
class Size { constructor(width = 0, height = 0) { this.width = width; this.height = height; } }
class Vec3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } }
module.exports = { Color, Vec2, Size, Vec3 };
`;

/** 建临时工作目录并把 cc 垫片伪装成一个可 require 的包 */
function createWork(label) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `olua-${label}-`));
  const shimDir = path.join(work, "out", "node_modules", "cc");
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(path.join(shimDir, "index.js"), CC_SHIM, "utf8");
  fs.writeFileSync(path.join(shimDir, "package.json"), '{"name":"cc","version":"0.0.0","main":"index.js"}', "utf8");
  return work;
}

/**
 * 编译客户端配置到工作目录
 *
 * 报 `Cannot find module 'cc'` 是**预期内的**（引擎类型不在任何工程里），缺类型不影响
 * JS 产物；真正的失败（语法错误 / 找不到源文件）不会被吞掉，直接抛。
 */
function compileClientConfig(work, sourceFiles) {
  const tsconfig = path.join(work, "tsconfig.json");
  fs.writeFileSync(
    tsconfig,
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "CommonJS",
          moduleResolution: "node",
          outDir: path.join(work, "out"),
          rootDir: ASSETS,
          skipLibCheck: true,
          esModuleInterop: true,
          strict: false,
          noEmitOnError: false,
        },
        files: sourceFiles,
      },
      null,
      2,
    ),
    "utf8",
  );

  const tsc = path.join(ROOT, "server", "node_modules", ".bin", "tsc");
  if (!fs.existsSync(tsc)) throw new Error(`找不到 tsc：${tsc}（先在 server/ 下装依赖）`);

  let log = "";
  try {
    log = execFileSync(tsc, ["-p", tsconfig], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    log = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }

  const fatal = log.split("\n").filter((line) => line.includes("error TS") && !line.includes("Cannot find module 'cc'"));
  if (fatal.length > 0) {
    console.error(fatal.slice(0, 20).join("\n"));
    throw new Error(`编译客户端配置失败（${fatal.length} 条错误，见上）`);
  }
}

/** 配置产物加载器：configs 目录下按名 require（layout 子目录也支持） */
function configLoader(work) {
  const dir = path.join(work, "out", "configs");
  return {
    /** require `configs/<name>.js` 的导出 */
    cfg: (name) => require(path.join(dir, `${name}.js`)),
    /** require `configs/layout/<name>.js` 的导出 */
    layoutCfg: (name) => require(path.join(dir, "layout", `${name}.js`)),
  };
}

/** 生成结束清理临时目录 */
function cleanupWork(work) {
  fs.rmSync(work, { recursive: true, force: true });
}

/**
 * 编译服务端 `server/src/shared/equipment-seed.ts` 并返回模块（#603 第九域）
 *
 * 装备 / 槽位 / 前后缀倍率 / 回收价曲线的唯一书写处已经搬到服务端，客户端
 * `configs/equipments` 与 `configs/growth` 加载期是**空表**。要在 Node 里生成任何
 * 「装备清单 / 装备数值」类产物，都得先把种子拿过来 —— 与 `prepare()` 里的
 * `hydrateSnapshotTables`（单测沙箱）同一条思路。
 */
function loadEquipmentSeed(work) {
  return loadSharedSeed(work, "equipment-seed.ts", "equipment-seed");
}

/** 编译服务端 `server/src/shared/item-seed.ts`（#603 第十域：药品 / 材料出厂行） */
function loadItemSeed(work) {
  return loadSharedSeed(work, "item-seed.ts", "item-seed");
}

/** 编译服务端 `server/src/shared/skill-seed.ts`（#603 第十一域：技能出厂行） */
function loadSkillSeed(work) {
  return loadSharedSeed(work, "skill-seed.ts", "skill-seed");
}

/**
 * 编一个 `server/src/shared` 下的纯数据种子并 require 回来
 * @param {string} work createWork() 的临时目录
 * @param {string} file 相对 server/src/shared 的文件名（如 "item-seed.ts"）
 * @param {string} tag 产物子目录名（同一 work 里编多个种子时不互相覆盖）
 */
function loadSharedSeed(work, file, tag) {
  const sharedDir = path.join(ROOT, "server", "src", "shared");
  const tsconfig = path.join(work, `tsconfig.${tag}.json`);
  const outDir = path.join(work, `${tag}-out`);
  fs.writeFileSync(
    tsconfig,
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "CommonJS",
          moduleResolution: "node",
          outDir,
          rootDir: sharedDir,
          skipLibCheck: true,
          esModuleInterop: true,
          strict: false,
          noEmitOnError: false,
          types: [],
        },
        files: [path.join(sharedDir, file)],
      },
      null,
      2,
    ),
    "utf8",
  );
  const tsc = path.join(ROOT, "server", "node_modules", ".bin", "tsc");
  if (!fs.existsSync(tsc)) throw new Error(`找不到 tsc：${tsc}（先在 server/ 下装依赖）`);
  execFileSync(tsc, ["-p", tsconfig], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return require(path.join(outDir, file.replace(/\.ts$/, ".js")));
}

/**
 * 用装备种子把客户端那几张空表填起来（#603 第九域）
 *
 * 与线上同一条路：先装规则（倍率决定展开档数），再装槽位与品质文案，最后用
 * `applyEquipmentSeed` 展开 555 条变体并写进物品总表（编了 `configs/items` 才写）。
 * **展开规则只写一份**（客户端 `buildEquipmentMap`），所以生成物与线上客户端算出来的
 * 一定是同一组数字。
 */
function hydrateEquipment(cfg, equipmentSeed) {
  const equipments = cfg("equipments");
  const growth = cfg("growth");

  growth.applyEquipmentRules(equipmentSeed.EQUIPMENT_PREFIX_RATE_SEEDS, equipmentSeed.EQUIPMENT_SUFFIX_RATE_SEEDS, equipmentSeed.EQUIPMENT_RECYCLE_CURVE_SEED);
  equipments.applyEquipmentQualityLabels(equipmentSeed.EQUIPMENT_PREFIX_LABEL_SEEDS, equipmentSeed.EQUIPMENT_SUFFIX_LABEL_SEEDS);
  // 槽位的 order 就是种子数组下标（`equipment_slots.sort_order` 的出厂值同源）
  equipments.applyEquipmentSlots(equipmentSeed.EQUIPMENT_SLOT_SEEDS.map((slot, order) => ({ ...slot, order })));

  const variants = equipments.applyEquipmentSeed(equipmentSeed.EQUIPMENT_SEED_ROWS);
  if (variants.length === 0) throw new Error("装备一件都没展开出来（倍率种子为空？）");
  return variants;
}

/**
 * 用 `item-seed.ts` 把药品 / 材料那两张空表填起来（#603 第十域）
 *
 * 与线上同一条路：`applyDrugData` / `applyItemBaseData` 整表重建（客户端那两个函数就是
 * 快照落库用的同一份实现），最后 `rebuildItemIndex()` 重建「id → 物品」总表。
 *
 * **必须在 `hydrateEquipment` 之后调**：总表顺序是「装备 → 药品 → 材料」,
 * 装备先进部位表，重建时才会排在最前。
 */
function hydrateItems(cfg, itemSeed) {
  cfg("drug").applyDrugData(itemSeed.DRUG_SEED_ROWS);
  cfg("material").applyItemBaseData(itemSeed.ITEM_BASE_SEED_ROWS);
  const items = cfg("items");
  if (typeof items.rebuildItemIndex === "function") items.rebuildItemIndex();
  return items.items;
}

/**
 * 用 `skill-seed.ts` 把客户端那张空的技能表填起来（#603 第十一域）
 *
 * 与线上同一条路：`applySkillData` 整表重建技能行并重算「职业 → 技能 id」（快照落库用的
 * 就是同一份实现）。**释放实现不在这一层**：`configs/skill` 的 onClick 要靠
 * `skills/warrior` 接上，沙箱里只关心数值。
 */
function hydrateSkills(cfg, skillSeed) {
  const skillData = cfg("skill-data");
  skillData.applySkillData(skillSeed.SKILL_SEED_ROWS);
  return skillData.skillData;
}

module.exports = {
  ROOT,
  ASSETS,
  createWork,
  compileClientConfig,
  configLoader,
  cleanupWork,
  loadEquipmentSeed,
  hydrateEquipment,
  loadItemSeed,
  hydrateItems,
  loadSkillSeed,
  hydrateSkills,
};
