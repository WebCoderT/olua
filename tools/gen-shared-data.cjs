#!/usr/bin/env node
/**
 * 生成公共游戏数据（`server/src/shared/game-data.generated.ts`）
 *
 * ===========================================================================
 * 这个文件解决什么
 * ===========================================================================
 * 装备 / 战魂 / 称号 / 军衔 / 技能 这些数据**三端都要**，而它们的唯一来源只有一个 ——
 * 客户端 `client/assets/configs`。此前只有「战斗数值」那部分被服务端共享，于是：
 *
 *   - 管理端**自己抄了一份**职业名与性别名（`src/api/types.ts` 的 `OCCUPATION_LABELS` /
 *     `SEX_LABELS`），装备槽位、技能、战魂 / 称号 / 军衔、地图、物品**只有裸 id**，
 *     运营改角色等于「拿 id 猜装备」；
 *   - 服务端手里那份快照只够算战斗属性，想要个名字就得再抄一份。
 *
 * 本生成器把这件事收成**一条管线**：编译客户端配置 → 在 Node 里加载 → 快照成一份
 * 引擎无关、id 索引、**带名字**的公共数据。两端都只读这一份，谁都不许自己维护。
 * 想改数值/文案就改客户端配置，然后重新生成。
 *
 * 与 `gen-api.cjs` 同构：产物带 `@generated` 头，`audit-shared-data.cjs` 重生成后逐字节比对。
 *
 * ===========================================================================
 * 为什么生成物放在 `server/src/shared/` 而不是顶层 `shared/`
 * ===========================================================================
 * 服务端是 `tsc -p tsconfig.build.json` 单包编译，源码根就是 `server/src`（产物 `dist/main.js`）。
 * 把一份 .ts 放到 `server/` 之外，TypeScript 会因 `rootDir` 把它算进公共根目录，
 * 产物会变成 `dist/server/src/main.js` —— 连带 7 套 e2e、Dockerfile、deploy 脚本一起改。
 * 代价与收益不匹配，所以文件放在服务端源码树内的**中立位置**（`src/shared/`，与 modules 平级），
 * 管理端按相对路径直接 import 同一份（Vite 打包，无 rootDir 约束）。
 * **只有这一个文件** —— 两端读的是同一个文件，不是「两份同步的副本」。
 *
 * ===========================================================================
 * 形状约定
 * ===========================================================================
 * - 键一律是**物品 id / 等级 / 下标 / 枚举值**，值一律是纯数字、字符串、元组或
 *   `{label, …}` 这类纯对象 —— **不含** `Color` / `Vec2` / `Size` 这些表现层类，也不含 Cocos 类型；
 * - 数据表本身可以 import `cc`（客户端要跑），垫片只负责让它在 Node 里加载得起来；
 * - 装备的变异体 id（`cloth_1_p3s2`）与**显示名**都在这里展开好，不让消费方自己去拼
 *   「前缀 + 名字 + 后缀」—— 那等于把命名口径复制出去，正是这条管线要消灭的事。
 *
 * ===========================================================================
 * 不在范围内（以及为什么）
 * ===========================================================================
 * - **怪物 / 掉落**：`configs/monster.ts` 依赖 UI 模块（Pointer / UiHit），垫片顶不住；
 *   它和「服务端持有刷怪实例」是同一件事，等世界权威那一刀一起做。
 * - **时装**：`configs/fashionClothes.ts` 目前整份被注释掉（零导出），没有活的来源 ——
 *   等它被启用再说，不在这里凭空造一份。
 *
 * 用法：node tools/gen-shared-data.cjs
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const ASSETS = path.join(ROOT, "client", "assets");
const OUT = path.join(ROOT, "server", "src", "shared", "game-data.generated.ts");

/**
 * 参与生成的客户端配置（**唯一来源**；顺序只影响编译，不影响产物）
 *
 * `items` 会把 `drug` / `material` / `equipments` 一起拉进来（它建的是一张物品总表），
 * `role` 带职业表，`map` 带地图表。列在这里是为了「少一张就报错」，不是为了让编译器找到它们。
 */
const SOURCE_FILES = ["level", "battle", "soul", "title", "rank", "equipments", "skill-data", "role", "items", "map"].map(
  (name) => path.join(ASSETS, "configs", `${name}.ts`),
);

/**
 * 客户端类型文件（**不参与编译**，只按注释读枚举名）
 *
 * 职业码的「全职业」与三个性别名在客户端就只存在这一处 —— `types/role.ts` 的枚举成员注释里，
 * 没有对应的配置表。想要一份「三端共用」的名字，只能引用它（不许各端自己译一遍）。
 * 解析失败会抛错，不是静默少一张表。
 */
const TYPES_ROLE = path.join(ASSETS, "types", "role.ts");

/** 七个部位的装备表（顺序即快照顺序；每个部位的键就是物品 id） */
const EQUIPMENT_MAPS = ["clothes", "weapons", "rings", "nicklaces", "shoes", "helmets", "belts"];

/** 参与属性汇总的战斗属性（与 BattleAttributes 对应；hpRecover 是单值，不在六项里） */
const RANGE_KEYS = ["physicalAttack", "magicAttack", "taoistAttack", "physicalDefense", "magicDefense", "taoistDefense"];
const SINGLE_KEYS = ["maxHp", "hpRecover"];

/**
 * 进快照的技能字段（只留参与战斗计算的）
 *
 * 不进的：`icon` / `description` / `action` / `effect` 是表现层，
 * `push` / `effectIsOnSelf` 是**实现层**参数（击退距离、特效挂谁身上），由客户端技能实现自己解释。
 * `damageCoefficients` 整条数组原样带过来（下标 = 技能等级），不按等级摊平。
 */
const SKILL_KEYS = ["level", "type", "targetType", "cooldown", "mpCost", "distance"];

/**
 * 最小 Cocos 垫片
 *
 * 只有被拉进来的配置在**运行时**真的构造了才能用到；纯类型用途的 import 会被 TypeScript 擦掉。
 * `equipments` 用到 Color（前后缀配色）与 Vec2（贴图偏移），`role` 用到 Size（职业介绍图尺寸），
 * `items`/`map` 本身不用 —— 都在表现层，不参与任何数值。
 */
const CC_SHIM = `"use strict";
class Color { constructor(value) { this.value = value; } }
class Vec2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } }
class Size { constructor(width = 0, height = 0) { this.width = width; this.height = height; } }
module.exports = { Color, Vec2, Size };
`;

function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "olua-shared-data-"));
  writeShim(work);
  compile(work);

  const cfg = load(work);
  const snapshot = buildSnapshot(cfg);
  const source = render(snapshot);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, source, "utf8");

  const count = (rows) => rows.length;
  console.log(`✔ 已生成 ${path.relative(ROOT, OUT)}`);
  console.log(`  身形：等级 ${count(snapshot.roleLevels)} 级 · 战魂 ${count(snapshot.soulLabels)} 阶 · 称号 ${count(snapshot.titleLabels)} 级 · 军衔 ${count(snapshot.rankLabels)} 阶`);
  console.log(`  装备：${count(snapshot.equipmentAttributes)} 件（含前后缀变体）· 槽位 ${count(snapshot.equipmentSlots)} 个`);
  console.log(`  物品 ${count(snapshot.itemLabels)} 件 · 技能 ${count(snapshot.skillLabels)} 个 · 地图 ${count(snapshot.mapLabels)} 张 · 职业 ${count(snapshot.occupationLabels)} 个`);
  fs.rmSync(work, { recursive: true, force: true });
}

/** 把 cc 垫片伪装成一个可被 require 的包 */
function writeShim(work) {
  const shimDir = path.join(work, "out", "node_modules", "cc");
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(path.join(shimDir, "index.js"), CC_SHIM, "utf8");
  fs.writeFileSync(path.join(shimDir, "package.json"), '{"name":"cc","version":"0.0.0","main":"index.js"}', "utf8");
}

/**
 * 编译客户端配置到临时目录
 *
 * 报 `Cannot find module 'cc'` 是**预期内的**：客户端配置处在 Cocos 工程里，这里没有引擎类型。
 * 缺类型不影响 JS 产物（下面要的是运行时的值）。真正的失败（语法 / 找不到源文件）不会被吞掉。
 */
function compile(work) {
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
        files: SOURCE_FILES,
      },
      null,
      2,
    ),
    "utf8",
  );

  const tsc = path.join(ROOT, "server", "node_modules", ".bin", "tsc");
  if (!fs.existsSync(tsc)) {
    throw new Error(`找不到 tsc：${tsc}（先在 server/ 下装依赖）`);
  }

  let log = "";
  try {
    log = execFileSync(tsc, ["-p", tsconfig], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    log = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }

  const fatal = log.split("\n").filter((line) => line.includes("error TS") && !line.includes("Cannot find module 'cc'"));
  if (fatal.length > 0) throw new Error(`编译客户端配置失败：\n${fatal.slice(0, 3).join("\n")}`);
}

function load(work) {
  const dir = path.join(work, "out", "configs");
  const cfg = (name) => require(path.join(dir, `${name}.js`));
  const equipments = cfg("equipments");
  const missing = (name, value) => {
    if (!value) throw new Error(`configs/${name} 的导出为空 —— 改名或删了？（生成物少一张表比报错危险得多）`);
    return value;
  };
  return {
    level: cfg("level"),
    battle: cfg("battle"),
    soul: missing("soul", cfg("soul").soulLevels),
    title: missing("title", cfg("title").titleLevels),
    rank: missing("rank", cfg("rank").rankLevels),
    equipments,
    equipmentMaps: EQUIPMENT_MAPS.map((name) => [name, missing(`equipments.${name}`, equipments[name])]),
    skillData: missing("skill-data", cfg("skill-data").skillData),
    occupations: missing("role.occupations", cfg("role").occupations),
    items: missing("items", cfg("items").items),
    maps: missing("map.maps", cfg("map").maps),
  };
}

/** 抽成一个与引擎、与 TS 类型都无关的纯数据快照 */
function buildSnapshot(cfg) {
  return {
    // —— 战斗数值（服务端算属性用；与它之前那份独立的 battle-rules 快照**逐值相同**，已合并）——
    roleLevels: pickMap(cfg.level.levelMap, (value) => {
      const out = pickAttributes(value);
      out.maxMp = round(value.maxMp ?? 0);
      out.exp = round(value.exp ?? 0);
      return out;
    }),
    combatWeights: pickMap(cfg.battle.combatCalc),
    soulLevels: pickList(cfg.soul, (item) => pickAttributes(item.attributes)),
    titleLevels: pickList(cfg.title, (item) => pickAttributes(item.attributes)),
    rankLevels: pickList(cfg.rank, (item) => pickAttributes(item.attributes)),
    equipmentAttributes: pickEquipments(cfg.equipmentMaps),
    skills: pickSkills(cfg.skillData),

    // —— 名字与元数据（三端做界面用）——
    occupationLabels: pickOccupationLabels(cfg.occupations, TYPES_ROLE),
    sexLabels: readEnumLabels(TYPES_ROLE, "SEX"),
    itemLabels: pickMap(cfg.items, (value) => String(value.label ?? "")),
    itemTypes: pickMap(cfg.items, (value) => value.type ?? null),
    equipmentSlots: pickMap(cfg.equipments.equipmentSlots, (value) => String(value.label ?? "")),
    equipmentSlotOrder: pickMap(cfg.equipments.equipmentSlotOrder),
    equipmentPrefixLabels: cfg.equipments.equipmentPrefixLabels.map(String),
    equipmentSuffixLabels: cfg.equipments.equipmentSuffixLabels.map(String),
    equipmentDisplayNames: pickEquipmentNames(cfg.equipmentMaps, cfg.equipments),
    equipmentSlotOf: pickEquipmentSlots(cfg.equipmentMaps),
    soulLabels: pickList(cfg.soul, (item) => String(item.label ?? "")),
    titleLabels: pickList(cfg.title, (item) => String(item.label ?? "")),
    rankLabels: pickList(cfg.rank, (item) => ({ tier: String(item.tier ?? ""), label: String(item.label ?? "") })),
    skillLabels: pickSkillsLabels(cfg.skillData),
    mapLabels: pickMap(cfg.maps, (value) => String(value.label ?? "")),
  };
}

/**
 * 装备 id → **显示名**（含前后缀，如「精良的·天级 屠龙」）
 *
 * 名字由客户端的 `getEquipmentNameParts` 自己拆（前缀文案 / 名字 / 后缀文案），
 * 生成器只负责拼接 —— 消费方永远不需要知道「名字怎么拼出来的」。
 */
function pickEquipmentNames(maps, equipments) {
  const parts = equipments.getEquipmentNameParts;
  if (typeof parts !== "function") throw new Error("configs/equipments 没有导出 getEquipmentNameParts（改名了？）");
  const out = [];
  for (const [name, map] of maps) {
    map.forEach((item, id) => {
      const piece = parts(item);
      out.push([id, `${piece.prefix.label}·${piece.suffix.label} ${piece.label}`]);
      void name;
    });
  }
  return out;
}

/**
 * 装备 id → 它属于哪个槽位（供管理端显示「部位」）
 *
 * 槽位取自**装备条目自己的 `slot` 字段**，不按分表名硬编码映射 ——
 * 「哪个分表对应哪个槽位」这件事客户端自己就写着（`configs/equipments` 的 `equipmentSlotData`），
 * 在这里再抄一份就是第三个副本。
 */
function pickEquipmentSlots(maps) {
  const out = [];
  for (const [, map] of maps) {
    map.forEach((item, id) => {
      if (item.slot === undefined || item.slot === null) throw new Error(`装备 ${id} 没有 slot 字段（配置结构变了？）`);
      out.push([id, item.slot]);
    });
  }
  return out;
}

/**
 * 七个部位的装备 Map → [[物品 id, 属性]]
 *
 * 快照**展开后的全量表**（基础件 × 前缀 × 后缀），而不是「基础件 + 倍率」让服务端现算：
 * 变体每条属性是 round(基础值 × 前缀倍率 × 后缀倍率)，六项区间还要各算一次 ——
 * 让消费方照抄一遍展开规则，等于把「4.5 该不该进位」这类口径复制出去。
 *
 * id 重复要在**这里**挡掉：落到 `Record` 里就是 TS1117「重复属性名」，报错点离真因很远。
 */
function pickEquipments(maps) {
  const out = [];
  const seen = new Set();
  for (const [name, map] of maps) {
    map.forEach((item, id) => {
      if (seen.has(id)) throw new Error(`装备 id 重复：${id}（同一 id 不能出现在两个部位表里）`);
      seen.add(id);
      out.push([id, pickAttributes(item)]);
    });
    void name;
  }
  return out;
}

/**
 * 技能表 → [[技能 id, 战斗数值]]
 *
 * id 重复同样在这里挡掉（落进 `Record` 就是 TS1117）。
 */
function pickSkills(list) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || !item.id) throw new Error("configs/skill-data 里有缺 id 的条目");
    if (seen.has(item.id)) throw new Error(`技能 id 重复：${item.id}`);
    seen.add(item.id);
    const row = {};
    for (const key of SKILL_KEYS) row[key] = item[key] ?? 0;
    row.damageCoefficients = (item.damageCoefficients ?? []).map((c) => ({ baseType: c.baseType, baseTypeRate: round(c.baseTypeRate) }));
    out.push([item.id, row]);
  }
  return out;
}

/** 技能 id → 技能名 */
function pickSkillsLabels(list) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || !item.id) throw new Error("configs/skill-data 里有缺 id 的条目");
    if (seen.has(item.id)) throw new Error(`技能 id 重复：${item.id}`);
    seen.add(item.id);
    out.push([item.id, String(item.label ?? "")]);
  }
  return out;
}

/**
 * 职业码 → 名
 *
 * 以 `configs/role.occupations` 为准（那是客户端界面用的职业名），枚举注释补上配置表里没有的码 ——
 * 「全职业」（码 `4`）只写在 `types/role.ts` 的枚举注释里，而管理端的职业下拉框需要这一项。
 */
function pickOccupationLabels(occupations, typesFile) {
  const merged = new Map(pickMap(occupations, (value) => String(value.name ?? "")));
  for (const [key, label] of readEnumLabels(typesFile, "OECCUPATION")) {
    if (!merged.has(key)) merged.set(key, label);
  }
  return [...merged];
}

/**
 * 从客户端类型文件的枚举**注释**里读「码 → 名」
 *
 * 客户端把名字写成每个枚举成员前面的一条块注释（`SEX` 的 `BOY` 那行前面写着「男」），
 * 所以这里按 `块注释 + 成员名 = "码"` 的形状抽。抓不到就抛错：这属于「客户端的权威定义
 * 换写法了」，必须有人来看一眼，而不是静默产出一张空表（消费方拿到的是空下拉框）。
 */
function readEnumLabels(file, enumName) {
  const text = fs.readFileSync(file, "utf8");
  const block = new RegExp(`export enum ${enumName} \\{([\\s\\S]*?)\\n\\}`).exec(text);
  if (!block) throw new Error(`${path.relative(ROOT, file)} 里没有枚举 ${enumName}（改名了？）`);
  const out = [];
  for (const match of block[1].matchAll(/\/\*\*\s*([^*]+?)\s*\*\/\s+\w+\s*=\s*"([^"]+)"/g)) {
    out.push([match[2], match[1]]);
  }
  if (out.length === 0) throw new Error(`枚举 ${enumName} 的成员注释一个都没解析出来（注释换风格了？）`);
  return out;
}

function pickAttributes(source) {
  if (!source) return null;
  const out = {};
  for (const key of SINGLE_KEYS) out[key] = round(source[key] ?? 0);
  for (const key of RANGE_KEYS) out[key] = tuple(source[key]);
  return out;
}

/**
 * Map → [[键, 值]]，**保持 Map 的自然顺序**
 *
 * 不排序是有意的：Map 的插入顺序来自配置文件本身（既稳定又符合作者意图）。
 * 再排一次反而可能把键的类型搞错 —— 权重表的键是**属性名**（字符串），
 * 拿 Number() 去转会得到 NaN，然后在 JSON 里落成 `null`（真踩过）。
 */
function pickMap(map, project) {
  const out = [];
  map.forEach((value, key) => out.push([key, project ? project(value) : round(value)]));
  return out;
}

/** T[] → [[下标, 值]]（保留 0 基下标：查表 API 的入参就是它） */
function pickList(list, project) {
  return (list || []).map((item, index) => [index, project(item)]);
}

const tuple = (value) => (Array.isArray(value) ? [round(value[0]), round(value[1])] : [0, 0]);
const round = (value) => (Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0);

/** 渲染成 TS 源码 */
function render(s) {
  const literal = (value, indent) => JSON.stringify(value).replace(/,/g, `,\n${indent}`);
  const numTable = (name, comment, rows) =>
    `/** ${comment} */\nexport const ${name} = {\n${rows
      .map(([key, value]) => `  ${JSON.stringify(String(key))}: ${JSON.stringify(value)},`)
      .join("\n")}\n};\n`;
  const textTable = (name, comment, rows) =>
    `/** ${comment} */\nexport const ${name}: Record<string, string> = {\n${rows
      .map(([key, value]) => `  ${JSON.stringify(String(key))}: ${JSON.stringify(value)},`)
      .join("\n")}\n};\n`;

  return `/**
 * ⚠️ 生成物，请勿手改 —— @generated by tools/gen-shared-data.cjs
 *
 * 来源 = 客户端 \`client/assets/configs\`（level / battle / soul / title / rank / equipments /
 * skill-data / role / items / map）与 \`client/assets/types/role.ts\` 的枚举注释（职业码「全职业」、
 * 三个性别名在客户端只存在于那里）。**唯一来源是客户端那份定义**，这里只是它的引擎无关快照：
 * 想改数值或名字，改客户端配置，然后 \`node tools/gen-shared-data.cjs\` 重新生成。
 *
 * 为什么要有这一份：装备 / 战魂 / 称号 / 军衔 / 技能这些数据**三端都要**，而此前只有
 * 「战斗数值」那一小块被共享 —— 管理端只好自己抄一份职业名与性别名，装备槽位、技能、
 * 地图、物品更是只有裸 id。这份生成物是两端**同一个文件**（服务端直接 import，管理端按相对
 * 路径 import 后由 Vite 打包），谁都不许再自己维护一份。守卫：\`tools/audit-shared-data.cjs\`
 * 重生成后逐字节比对，改了客户端配置忘了重新生成就是这个审计 FAIL。
 *
 * 形状：键一律是**物品 id / 等级 / 下标 / 枚举值**，值一律是纯数字、字符串、元组或
 * \`{label, …}\` 这类纯对象 —— 不含 \`Color\` / \`Vec2\` / \`Size\` 这些表现层类，也不含 Cocos 类型。
 * 装备的键是**展开后**的物品 id（基础件原 key，或带前后缀的 \`_pXsY\`），与客户端
 * \`getEquipment(id)\` 同口径；\`EQUIPMENT_DISPLAY_NAMES\` 里的名字已经拼好，消费方不必自己拼。
 *
 * 不在范围：怪物 / 掉落（\`configs/monster\` 依赖 UI 模块，等世界权威那一刀）、
 * 时装（\`configs/fashionClothes\` 整份被注释，没有活的来源）。
 */

/** 六项区间型战斗属性。如 ["physicalAttack","magicAttack",...] */
export const COMBAT_RANGE_KEYS: string[] = ${literal(RANGE_KEYS, "  ")};

/** 单值型战斗属性。maxHp 参与战斗力，hpRecover 不参与（见 configs/battle 的说明） */
export const COMBAT_SINGLE_KEYS: string[] = ${literal(SINGLE_KEYS, "  ")};

//#region 战斗数值（服务端算角色属性用）

${numTable("ROLE_LEVEL_ATTRIBUTES", "等级 → 战斗属性（下标 / 键 = 来源等级）", s.roleLevels)}
${numTable("COMBAT_WEIGHTS", "战斗力权重（属性名 → 倍率）", s.combatWeights)}
${numTable("SOUL_LEVEL_ATTRIBUTES", "战魂等级 → 整份属性加成", s.soulLevels)}
${numTable("TITLE_LEVEL_ATTRIBUTES", "称号等级 → 整份属性加成", s.titleLevels)}
${numTable("RANK_LEVEL_ATTRIBUTES", "军衔等级 → 整份属性加成", s.rankLevels)}
${numTable("EQUIPMENT_ATTRIBUTES", "装备 id → 战斗属性（已含前后缀变体，id 里带品质后缀，如 cloth_1_p3s2）", s.equipmentAttributes)}
${numTable("SKILLS", "技能 id → 战斗数值。damageCoefficients 的下标 = 技能等级，baseType 是取哪种属性当基数", s.skills)}

//#endregion

//#region 名字与元数据（三端做界面用）

${textTable("OCCUPATION_LABELS", "职业码 → 名（含「全职业」；配置表没有的码取自 types/role.ts 的枚举注释）", s.occupationLabels)}
${textTable("SEX_LABELS", "性别码 → 名（唯一的来源是 types/role.ts 的 SEX 枚举注释）", s.sexLabels)}
${textTable("ITEM_LABELS", "物品 id → 名（装备 / 药品 / 材料都在内，含装备的前后缀变体）", s.itemLabels)}
${numTable("ITEM_TYPES", "物品 id → 物品大类（GOOD_TYPE）", s.itemTypes)}
${textTable("EQUIPMENT_SLOTS", "装备槽位 → 中文名（如 1 → 衣服）", s.equipmentSlots)}
${numTable("EQUIPMENT_SLOT_ORDER", "装备槽位 → 整理序号（背包「一键整理」的部位顺序）", s.equipmentSlotOrder)}
${textTable("EQUIPMENT_DISPLAY_NAMES", "装备 id → 显示名（已拼好前后缀，如「精良的·天级 屠龙」）", s.equipmentDisplayNames)}
${textTable("EQUIPMENT_SLOT_OF", "装备 id → 所属槽位（配 EQUIPMENT_SLOTS 显示部位）", s.equipmentSlotOf)}
${textTable("SOUL_LABELS", "战魂阶数（下标 + 1 即阶）→ 名", s.soulLabels)}
${textTable("TITLE_LABELS", "称号等级（下标 + 1 即等级）→ 名", s.titleLabels)}
${numTable("RANK_LABELS", "军衔阶数（下标 + 1 即阶）→ { tier 大段名, label 衔名 }", s.rankLabels)}
${textTable("SKILL_LABELS", "技能 id → 技能名", s.skillLabels)}
${textTable("MAP_LABELS", "地图 id → 地图名", s.mapLabels)}

/** 装备前缀名（下标 = 前缀序号，如 0 → 普通的） */
export const EQUIPMENT_PREFIX_LABELS: string[] = ${literal(s.equipmentPrefixLabels, "  ")};

/** 装备后缀名（下标 = 后缀序号，如 0 → 人级） */
export const EQUIPMENT_SUFFIX_LABELS: string[] = ${literal(s.equipmentSuffixLabels, "  ")};

//#endregion
`;
}

main();
