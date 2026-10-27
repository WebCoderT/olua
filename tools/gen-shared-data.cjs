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
 * - ~~怪物 / NPC~~：**#34 / #258 起已纳入**——实测 `configs/monster` 在 cc 垫片（Vec2/Size/Vec3/Color）下
 *   能干净编译加载（此前记的「依赖 UI 模块」已不成立），战斗数值按
 *   「monsterStats(level, tier) 打底 + 条目覆盖」展开后进快照（`MONSTERS`，#258 起带名称）；
 *   NPC 走 `configs/npc-data`（**数据与行为分家**：原 npc.ts 引 UI 弹窗链，Node 加载会炸 ——
 *   实证 `Pointer.js` 的 `sys.hasFeature` 即炸，onClick 接线留在 npc.ts），快照只有 id / label。
 * - ~~时装~~：**#257 起已纳入**——`configs/fashionClothes` 恢复为纯数据文件（原整份注释、
 *   零导出零消费，表现层参数全是常量未随恢复保留，见该文件头），快照 FASHION
 *   带 id / 名称 / 文案 / 资源路径 / 售卖价 / 属性（当前全 0，管理端可改）。
 * - **掉落**：掉落结算还没上服务端（等世界权威那一刀），等它被启用再说。
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
const SOURCE_FILES = ["level", "growth", "battle", "soul", "title", "rank", "equipments", "skill-data", "role", "items", "map", "monster", "drug", "material", "npc-data", "mall", "fashionClothes", "drop", "monsterDrops", "status", "monster-skills", "quest-data"].map(
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
class Vec3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } }
module.exports = { Color, Vec2, Size, Vec3 };
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
  console.log(`  装备：${count(snapshot.equipmentAttributes)} 件（含前后缀变体）· 基础件 ${count(snapshot.equipmentBases)} 件 · 槽位 ${count(snapshot.equipmentSlots)} 个`);
  console.log(`  物品 ${count(snapshot.itemLabels)} 件 · 技能 ${count(snapshot.skillLabels)} 个 · 状态 ${count(snapshot.statuses)} 个 · 怪物技能挂载 ${count(snapshot.monsterSkills)} 只怪 · 地图 ${count(snapshot.mapLabels)} 张 · 职业 ${count(snapshot.occupationLabels)} 个 · 怪物 ${count(snapshot.monsters)} 只 · NPC ${count(snapshot.npcs)} 个 · 药品 ${count(snapshot.drugs)} 种 · 时装 ${count(snapshot.fashions)} 套 · 掉落表 ${count(snapshot.dropTables)} 张具名 + ${count(snapshot.monsterDrops)} 只怪 · 任务 ${count(snapshot.quests)} 个`);
  console.log(`  成长曲线 ${count(snapshot.growthCurves)} 条 · 标量参数 ${count(snapshot.growthScalars)} 个`);
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
    // 成长曲线参数（#256）：分段线性曲线本体 + 标量参数，管理端收口成可改数据
    growth: cfg("growth"),
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
    monsters: missing("monster.monsters", cfg("monster").monsters),
    // 怪物 AI 节奏参数（#323：AI 收权后服务端 tick 也要用同一套数值）
    monsterAi: missing("monster.monsterAI", cfg("monster").monsterAI),
    npcs: missing("npc-data.npcData", cfg("npc-data").npcData),
    // 时装（#257）：管理端「时装配置」的 seed 来源 —— 纯数据（id/名称/文案/资源路径/
    // 售卖价/属性），表现层参数未随恢复保留（见 fashionClothes.ts 文件头）
    fashions: missing("fashionClothes.fashionData", cfg("fashionClothes").fashionData),
    // 掉落（#254）：具名表（common/elite/boss）、兜底表与每怪独立表 —— 管理端
    // 「掉落配置」的 seed 来源；条目缺省值（weight=1 / chance=1 / count=[1,1]）
    // 在生成器规整为全显式，消费方不复制缺省规则
    dropTables: missing("drop.dropTables", cfg("drop").dropTables),
    dropDefault: missing("drop.defaultDropTable", cfg("drop").defaultDropTable),
    monsterDropTables: missing("monsterDrops.monsterDropTables", cfg("monsterDrops").monsterDropTables),
    // 商城统一价（#251）：全场默认售价（绑定元宝/件），服务端 mall_settings 的 seed 来源；
    // 特殊价是运营数据不进快照（动态增删，归 mall_prices 表）
    mallPrice: missing("mall.mallPrice", cfg("mall").mallPrice),
    // 状态（#367）：管理端「状态配置」的 seed 来源 —— 角色与怪物同表，owner 区分
    statuses: missing("status.statuses", cfg("status").statuses),
    // 怪物技能挂载（#372）：哪只怪放哪些技能、优先级、冷却覆写 —— 服务端 AI 读表
    monsterSkills: missing("monster-skills.monsterSkills", cfg("monster-skills").monsterSkills),
    drugs: missing("drug.drugs", cfg("drug").drugs),
    materials: missing("material.materials", cfg("material").materials),
    // 任务（#396）：管理端「任务配置」的 seed 来源 —— 单目标（kill/talk/collect）+ 奖励
    questData: missing("quest-data", cfg("quest-data").questData),
  };
}

/** 抽成一个与引擎、与 TS 类型都无关的纯数据快照 */
function buildSnapshot(cfg) {
  // 技能行两处要用：快照本身 + 怪物挂载校验（挂的必须是 owner=monster 的技能）
  const skills = pickSkills(cfg.skillData);
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
    // —— 养成配置元数据（管理端 seed 用：名称之外，还带文案 / 价格 / 动画资源）——
    soulMeta: pickList(cfg.soul, pickConfigMeta),
    titleMeta: pickList(cfg.title, pickConfigMeta),
    // 军衔（#250）：没有动画资源，只带文案与晋升价格
    rankMeta: pickList(cfg.rank, pickRankMeta),
    equipmentAttributes: pickEquipments(cfg.equipmentMaps),
    // 装备基础件（#252）：普通的·人级那一档，管理端「装备配置」的 seed 来源 ——
    // 变体（_pXsY）的属性与回收价都是基础件乘倍率展开的，运营只改基础件这一份
    equipmentBases: pickEquipmentBases(cfg.equipmentMaps),
    skills,
    // 状态（#367）：角色状态的数值修正 / 时长 / 图标特效，管理端收口成可改数据
    statuses: pickStatuses(cfg.statuses),
    // 怪物技能挂载（#372）：怪物 key → 技能清单（服务端 AI 的释放依据，管理端可增删改）
    monsterSkills: pickMonsterSkills(cfg.monsterSkills, cfg.monsters, skills),
    monsters: pickMonsters(cfg.monsters),
    // 怪物 AI 节奏参数（#323：服务端 AI tick 与客户端同一套手感数值）
    monsterAi: pickMonsterAi(cfg.monsterAi),
    npcs: pickNpcs(cfg.npcs),
    fashions: pickFashions(cfg.fashions),
    // —— 掉落（#254：管理端可改的具名表 / 每怪表 / 兜底表）——
    dropTables: pickDropTables(cfg.dropTables),
    dropDefault: [["default", pickDropTable("default", cfg.dropDefault)]],
    monsterDrops: pickMonsterDrops(cfg.monsterDropTables, cfg.monsters),
    mallDefaultPrice: round(cfg.mallPrice ?? 0),
    // 药品（#253）：管理端「药品配置」的 seed 来源。effects 数组按键**求和**拍平 ——
    // 客户端 resolveDrugRecovery 对多项 effects 就是累加生效，求和与逐项累加等价
    drugs: pickDrugs(cfg.drugs),
    // 物品与材料（#255）：管理端「物品配置」的 seed 来源 —— 只收 **MATERIAL / OTHER** 大类
    //（装备 / 药品字段形态不同，各有自己的表与 issue）；type 带上原值，未来 OTHER 条目直接进
    itemBases: pickItemBases(cfg.materials),
    // —— 成长曲线（#256：管理端可改的曲线本体与标量参数）——
    growthCurves: pickGrowthCurves(cfg.growth.roleGrowth),
    growthScalars: pickGrowthScalars(cfg.growth, cfg.level.expGain),
    // 任务（#396）：管理端可改的任务配置（主线链 / 日常 / 单目标 / 奖励）
    quests: pickQuests(cfg.questData),

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
 * 七个部位的装备 Map → [[基础件 id, 管理端元数据]]（#252）
 *
 * 只取**基础件**（普通的·人级，前后缀全 0、沿用原 key）：变体是基础件 × 前后缀倍率
 * 展开的（展开规则在客户端 configs/equipments.buildEquipmentMap，属代码不是运营数据），
 * 快照与 seed 都只收基础件这一份，变体不进管理端。
 *
 * sellPrice 来自条目的 `sellPirce`（客户端字段名历史上拼成了 Pirce，这里统一规整成
 * sellPrice，两端生成物与库里都用正确拼写）；回收价是「曲线 × 倍率」的派生值，不进快照。
 */
function pickEquipmentBases(maps) {
  const out = [];
  const seen = new Set();
  for (const [name, map] of maps) {
    map.forEach((item, id) => {
      if (item.prefix !== 0 || item.suffix !== 0) return; // 只要基础件
      if (seen.has(id)) throw new Error(`装备基础件 id 重复：${id}`);
      seen.add(id);
      if (item.slot === undefined || item.slot === null) throw new Error(`装备 ${id} 没有 slot 字段（配置结构变了？）`);
      out.push([
        id,
        {
          slot: item.slot,
          level: round(item.level ?? 0),
          sellPrice: round(item.sellPirce ?? 0),
          label: String(item.label ?? ""),
          attributes: pickAttributes(item),
        },
      ]);
    });
    void name;
  }
  if (out.length === 0) throw new Error("装备基础件一条都没取到（configs/equipments 的 Map 结构变了？）");
  return out;
}

/**
 * 怪物表 → [[怪物 key, 战斗数值]]
 *
 * 与装备同一取舍：快照里放**展开后**的战斗数值（monsterStats(level, tier) 打底 + 条目覆盖
 * 已在 configs/monster 建 Map 时合成完毕），服务端不做「按等级现算」——那等于把成长曲线的
 * 口径复制出去。只留参与伤害结算的字段（maxHp + 六项攻防区间 + 等级 / 定位），
 * 外观 / 几何 / 掉落 / AI 参数都是表现或世界层，不进。
 */
/**
 * 怪物表 → [[key, 行]]（#258 起战斗数值；#323 起补 AI 参数）
 *
 * 攻防区间**已在 configs/monster 建 Map 时合成完毕**，服务端不做「按等级现算」——
 * 那等于把成长曲线的口径复制出去。#323 起 AI 收权到服务端，`aggressive / detectRange /
 * moveSpeed` 从「表现层参数」变成「行为权威的输入」，一并进快照（几何 / 外观 / 掉落仍不进）。
 */
function pickMonsters(monsters) {
  const out = [];
  const seen = new Set();
  monsters.forEach((item, key) => {
    if (seen.has(key)) throw new Error(`怪物 key 重复：${key}`);
    seen.add(key);
    const row = {
      label: String(item.label ?? ""),
      level: round(item.level ?? 0),
      tier: String(item.tier ?? "normal"),
      maxHp: round(item.maxHp ?? 0),
      // AI 参数（#323）：主动怪判定 / 检测范围 / 移动速度（服务端 tick 按它推进位置）
      aggressive: Boolean(item.aggressive),
      detectRange: round(item.detectRange ?? 0),
      moveSpeed: round(item.moveSpeed ?? 0),
    };
    for (const key2 of RANGE_KEYS) {
      const value = item[key2];
      if (!Array.isArray(value) || value.length < 2) throw new Error(`怪物 ${key} 缺少区间属性 ${key2}（monsterStats 没铺到？）`);
      row[key2] = [round(value[0]), round(value[1])];
    }
    out.push([key, row]);
  });
  return out;
}

/**
 * 怪物 AI 全局节奏参数（#323）：configs/monster 的 monsterAI 里**服务端 tick 用得到的数值**
 * （普攻间隔 / 普攻距离 / 待机游走节奏）。动作池与击退时长是纯表现层，不进。
 */
function pickMonsterAi(monsterAi) {
  const picked = {
    attackInterval: round(monsterAi.attackInterval ?? 0),
    attackRange: round(monsterAi.attackRange ?? 0),
    idleMoveInterval: [round(monsterAi.idleMoveInterval?.[0] ?? 0), round(monsterAi.idleMoveInterval?.[1] ?? 0)],
    idleMoveDuration: [round(monsterAi.idleMoveDuration?.[0] ?? 0), round(monsterAi.idleMoveDuration?.[1] ?? 0)],
    idleMoveSpeedScale: Number(monsterAi.idleMoveSpeedScale ?? 0.5),
    wanderRadius: round(monsterAi.wanderRadius ?? 0),
  };
  return Object.entries(picked);
}

/**
 * NPC 表 → [[NPC id, 元数据]]（#258）
 *
 * 来源是 `configs/npc-data`（数据与行为分家后的纯数据文件，见文件头）。只收
 * id 与 label：src / scale / position 是表现层资源与几何，不进快照；对话文案
 * 客户端目前没有数据形态（都写死在弹窗组件里），管理端在 npcs 表上新增
 * dialog 列运营可改，客户端消费等对接（#248/#249）。
 */
function pickNpcs(npcs) {
  const out = [];
  const seen = new Set();
  for (const item of npcs || []) {
    if (!item || !item.id) throw new Error("configs/npc-data 里有缺 id 的条目");
    if (seen.has(item.id)) throw new Error(`NPC id 重复：${item.id}`);
    seen.add(item.id);
    out.push([item.id, { label: String(item.label ?? "") }]);
  }
  if (out.length === 0) throw new Error("configs/npc-data 的 npcData 为空（改名或清空了？生成物少一张表比报错危险得多）");
  return out;
}

/**
 * 任务表 → [[任务 id, 整行配置]]（#396）
 *
 * 目标与奖励缺省值在此规整为全显式（count ≥ 1 / rewards 全 0 / items 空数组），
 * 消费方不复制缺省规则；prevQuestId 引用不存在的任务在这里就报错。
 */
function pickQuests(quests) {
  const out = [];
  const seen = new Set();
  const kinds = new Set(["main", "daily"]);
  const types = new Set(["kill", "talk", "collect"]);
  for (const item of quests || []) {
    if (!item || !item.id) throw new Error("configs/quest-data 里有缺 id 的条目");
    if (seen.has(item.id)) throw new Error(`任务 id 重复：${item.id}`);
    seen.add(item.id);
    if (!kinds.has(item.kind)) throw new Error(`任务 ${item.id} 的 kind 非法：${item.kind}`);
    const objective = item.objective ?? {};
    if (!types.has(objective.type)) throw new Error(`任务 ${item.id} 的目标类型非法：${objective.type}`);
    if (!objective.target) throw new Error(`任务 ${item.id} 的目标为空`);
    const rewards = item.rewards ?? {};
    const items = (rewards.items ?? []).map((entry) => ({
      goodId: String(entry?.goodId ?? ""),
      count: Math.max(1, round(entry?.count ?? 1)),
    }));
    if (items.some((entry) => !entry.goodId)) throw new Error(`任务 ${item.id} 的奖励物品缺 goodId`);
    out.push([
      item.id,
      {
        kind: item.kind,
        label: String(item.label ?? ""),
        description: String(item.description ?? ""),
        prevQuestId: String(item.prevQuestId ?? ""),
        minLevel: Math.max(1, round(item.minLevel ?? 1)),
        npcId: String(item.npcId ?? ""),
        objective: {
          type: objective.type,
          target: String(objective.target),
          count: Math.max(1, round(objective.count ?? 1)),
        },
        rewards: {
          gold: Math.max(0, round(rewards.gold ?? 0)),
          exp: Math.max(0, round(rewards.exp ?? 0)),
          items,
        },
      },
    ]);
  }
  if (out.length === 0) throw new Error("configs/quest-data 的 questData 为空（改名或清空了？生成物少一张表比报错危险得多）");
  for (const [, row] of out) {
    if (row.prevQuestId && !seen.has(row.prevQuestId)) {
      throw new Error(`任务 ${row.id} 的 prevQuestId 引用了不存在的任务：${row.prevQuestId}`);
    }
  }
  return out;
}

/**
 * 药品表 → [[药品 id, 管理端元数据]]（#253）
 *
 * effects 数组按键求和拍平（hp / mp / hpPercent / mpPercent）：客户端
 * `resolveDrugRecovery` 对多项 effects 逐项累加，当前配置每药至多一条，
 * 求和与逐项累加严格等价；`duration` 是增益类字段，当前配置没有用到，不进快照。
 * sellPrice 来自条目的 `sellPirce`（客户端字段名历史拼写如此，与装备同一规整口径）。
 */
function pickDrugs(drugs) {
  const out = [];
  const seen = new Set();
  for (const item of drugs || []) {
    if (!item || !item.id) throw new Error("configs/drug 里有缺 id 的条目");
    if (seen.has(item.id)) throw new Error(`药品 id 重复：${item.id}`);
    seen.add(item.id);
    const effects = Array.isArray(item.effects) ? item.effects : [];
    const sum = (key) => effects.reduce((acc, effect) => acc + (Number(effect?.[key]) || 0), 0);
    out.push([
      item.id,
      {
        label: String(item.label ?? ""),
        description: String(item.description ?? ""),
        level: round(item.level ?? 0),
        sellPrice: round(item.sellPirce ?? 0),
        maxStack: round(item.maxStack ?? 99),
        cooldown: round(item.cooldown ?? 0),
        hp: round(sum("hp")),
        mp: round(sum("mp")),
        hpPercent: round(sum("hpPercent")),
        mpPercent: round(sum("mpPercent")),
      },
    ]);
  }
  if (out.length === 0) throw new Error("configs/drug 的 drugs 为空（改名或清空了？生成物少一张表比报错危险得多）");
  return out;
}

/**
 * 材料（与未来的其他物品）表 → [[物品 id, 管理端元数据]]（#255）
 *
 * 只收 **MATERIAL / OTHER** 大类：装备 / 药品字段形态不同，各有自己的表与 issue。
 * type 带原值（GOOD_TYPE 的枚举值字符串）；sellPrice 来自条目的 `sellPirce`
 * （客户端字段名历史拼写如此，与装备 / 药品同一规整口径）。
 */
function pickItemBases(materials) {
  const out = [];
  const seen = new Set();
  for (const item of materials || []) {
    if (!item || !item.id) throw new Error("configs/material 里有缺 id 的条目");
    if (seen.has(item.id)) throw new Error(`物品 id 重复：${item.id}`);
    seen.add(item.id);
    out.push([
      item.id,
      {
        type: String(item.type ?? ""),
        label: String(item.label ?? ""),
        description: String(item.description ?? ""),
        level: round(item.level ?? 0),
        sellPrice: round(item.sellPirce ?? 0),
        maxStack: round(item.maxStack ?? 99),
      },
    ]);
  }
  if (out.length === 0) throw new Error("configs/material 的 materials 为空（改名或清空了？生成物少一张表比报错危险得多）");
  return out;
}

/**
 * 时装表 → [[时装 id, 管理端元数据]]（#257）
 *
 * 来源是 `configs/fashionClothes`（#257 恢复为纯数据文件，见文件头）。名称 / 文案 /
 * 资源路径 / 售卖价 / 属性进快照（sellPrice 来自可选字段，缺省 0）；属性经
 * pickAttributes 拍平（当前配置全缺省 = 0，管理端可改，客户端消费等穿戴功能）。
 */
function pickFashions(fashions) {
  const out = [];
  const seen = new Set();
  for (const item of fashions || []) {
    if (!item || !item.id) throw new Error("configs/fashionClothes 里有缺 id 的条目");
    if (seen.has(item.id)) throw new Error(`时装 id 重复：${item.id}`);
    seen.add(item.id);
    const row = {
      label: String(item.label ?? ""),
      description: String(item.description ?? ""),
      icon: String(item.icon ?? ""),
      in: String(item.in ?? ""),
      out: String(item.out ?? ""),
      sellPrice: round(item.sellPrice ?? 0),
      // attributes 全缺省时 pickAttributes(undefined) 会返回 null —— 这里保证拍平形状恒在（全 0）
      ...pickAttributes(item.attributes ?? {}),
    };
    out.push([item.id, row]);
  }
  if (out.length === 0) throw new Error("configs/fashionClothes 的 fashionData 为空（改名或清空了？生成物少一张表比报错危险得多）");
  return out;
}

/**
 * 掉落条目规整（#254）
 *
 * 客户端 DropEntry 的缺省规则（weight=1 / chance=1 / count=[1,1]）在这里**规整成全显式**：
 * 消费方（服务端校验 / 管理端编辑器回填）不必各自抄一遍「缺省是多少」。weight 保留小数
 * （monsterDrops 生成的装备权重是 6.29 / 0.63 这类），chance / count 用 round。
 */
function pickDropEntry(entry, where) {
  if (!entry || typeof entry !== "object" || !entry.goodId) throw new Error(`${where} 里有缺 goodId 的掉落条目`);
  const count = Array.isArray(entry.count) && entry.count.length >= 2 ? [round(entry.count[0]), round(entry.count[1])] : [1, 1];
  return {
    goodId: String(entry.goodId),
    weight: Number.isFinite(entry.weight) ? round(entry.weight) : 1,
    chance: Number.isFinite(entry.chance) ? round(entry.chance) : 1,
    count,
  };
}

/** 抽取次数规整：数字 = 固定件数；[min, max] = 件数区间（原样快照） */
function pickDropPicks(picks, where) {
  if (Array.isArray(picks)) {
    if (picks.length < 2) throw new Error(`${where} 的 picks 区间不足两位`);
    return [round(picks[0]), round(picks[1])];
  }
  const value = round(picks ?? 1);
  return value;
}

/** 单张掉落表 → { picks, entries }（entries 逐条规整，空表报错） */
function pickDropTable(id, table) {
  if (!table || !Array.isArray(table.entries)) throw new Error(`掉落表 ${id} 没有 entries 数组（configs/drop 改坏了？）`);
  if (table.entries.length === 0) throw new Error(`掉落表 ${id} 的 entries 为空（掉不出东西的表不如报错）`);
  return {
    picks: pickDropPicks(table.picks, `掉落表 ${id}`),
    entries: table.entries.map((entry, index) => pickDropEntry(entry, `掉落表 ${id}[${index}]`)),
  };
}

/** 具名掉落表 Map → [[表 id, { picks, entries }]]（#254） */
function pickDropTables(tables) {
  const out = [];
  const seen = new Set();
  tables.forEach((table, id) => {
    if (seen.has(id)) throw new Error(`具名掉落表 id 重复：${id}`);
    seen.add(id);
    out.push([id, pickDropTable(id, table)]);
  });
  if (out.length === 0) throw new Error("configs/drop 的 dropTables 为空（改名或清空了？生成物少一张表比报错危险得多）");
  return out;
}

/**
 * 每怪独立掉落表 Map → [[怪物 key, { picks, entries }]]（#254）
 *
 * key 必须是 configs/monster 里的怪物（掉落挂在怪身上，key 对不上就是配置漂移，
 * 在生成器这里挡掉比落到表里再查省一个回合）。
 */
function pickMonsterDrops(monsterDropTables, monsters) {
  const out = [];
  const seen = new Set();
  monsterDropTables.forEach((table, key) => {
    if (seen.has(key)) throw new Error(`怪物掉落 key 重复：${key}`);
    seen.add(key);
    if (!monsters.has(key)) throw new Error(`怪物掉落 key ${key} 不在 configs/monster 里（配置漂移，先对齐两份配置）`);
    out.push([key, pickDropTable(key, table)]);
  });
  if (out.length === 0) throw new Error("configs/monsterDrops 的 monsterDropTables 为空（改名或清空了？生成物少一张表比报错危险得多）");
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
    const row = {
      // #372：归属来自配置（角色技能缺省 role，怪物技能显式写 monster）。
      // 技能行本身对两边同构 —— 分表只会让「同一个技能既给人又给怪」复制两份并漂移
      owner: item.owner === "monster" ? "monster" : "role",
      label: String(item.label ?? ""),
      icon: String(item.icon ?? ""),
      // category 就是客户端的 SkillType（"0" 主动 / "1" 被动 / "2" 状态 / "3" 回复），存原值不另起一套
      category: String(item.type ?? "0"),
      targetType: String(item.targetType ?? "1"),
      action: String(item.action ?? ""),
      effect: String(item.effect ?? ""),
      effectOnSelf: item.effectIsOnSelf === true,
      cooldown: round(item.cooldown ?? 0),
      mpCost: round(item.mpCost ?? 0),
      distance: round(item.distance ?? 0),
      // level 在原表里是「学习/开启等级」，落库叫 level_req（避免与「技能等级」混读）
      levelReq: round(item.level ?? 1),
      description: String(item.description ?? ""),
      damageCoefficients: (item.damageCoefficients ?? []).map((c) => ({ baseType: c.baseType, baseTypeRate: round(c.baseTypeRate) })),
      statusId: String(item.statusId ?? ""),
      castLockMs: round(item.castLockMs ?? 0),
      // 缺省 true：绝大多数技能都要有目标才能放；自身 / 状态型技能在配置里显式写 false
      requireTarget: item.requireTarget !== false,
      canAuto: item.canAuto === true,
    };
    if (!Array.isArray(row.damageCoefficients)) throw new Error(`技能 ${item.id} 的 damageCoefficients 不是数组`);
    out.push([item.id, row]);
  }
  return out;
}

/**
 * 状态表 → [[状态 id, 整行]]
 *
 * `configs/status` 的 `statuses` 是 `Map<StatusId, StatusConfig>`；source 是枚举字符串，
 * 原样带过来（服务端 DTO 的取值域与之逐值一致）。
 */
function pickStatuses(map) {
  const out = [];
  map.forEach((status, id) => {
    if (!id) throw new Error("configs/status 里有缺 id 的状态");
    out.push([
      String(id),
      {
        // #367：角色状态固定 role；怪物状态由管理端自建（同表 owner=monster）
        owner: "role",
        label: String(status.label ?? ""),
        icon: String(status.icon ?? ""),
        duration: round(status.duration ?? 0),
        source: String(status.source ?? "other"),
        description: String(status.description ?? ""),
        effect: String(status.effect ?? ""),
        effectHoldLast: status.effectHoldLast === true,
        combat: status.combat ?? {},
      },
    ]);
  });
  return out;
}

/**
 * 怪物技能挂载 → [[怪物 key, 条目数组]]（#372）
 *
 * 三类脏数据在这里挡掉 —— 生成物是唯一 seed 源，坏数据进去就是服务端 AI 每 tick 白跑：
 * - 挂载的怪物 key 不在怪物表里（世界播种永远碰不到这只怪，等于配了个哑技能）；
 * - 技能 id 不存在，或该技能 owner 不是 monster（把角色技能挂给怪，客户端演出查不到实现）；
 * - priority 不是数字（AI 按它排顺序，NaN 会让排序退化成配置顺序）。
 *
 * `cooldown` 可选：覆写技能自身的冷却，同一技能给不同怪不同节奏时用。
 */
function pickMonsterSkills(map, monsters, skills) {
  const owners = new Map(skills.map(([id, row]) => [id, row.owner]));
  const out = [];
  for (const [monsterKey, entries] of Object.entries(map || {})) {
    if (!monsters.has(monsterKey)) throw new Error(`configs/monster-skills 里的怪物 ${monsterKey} 不在怪物表里`);
    if (!Array.isArray(entries) || entries.length === 0) throw new Error(`configs/monster-skills 的怪物 ${monsterKey} 挂载清单为空`);
    const seen = new Set();
    const rows = entries.map((entry) => {
      const skillId = String(entry?.skillId ?? "");
      if (!skillId) throw new Error(`怪物 ${monsterKey} 的挂载条目缺 skillId`);
      if (seen.has(skillId)) throw new Error(`怪物 ${monsterKey} 重复挂载技能 ${skillId}`);
      seen.add(skillId);
      const owner = owners.get(skillId);
      if (!owner) throw new Error(`怪物 ${monsterKey} 挂了不存在的技能 ${skillId}`);
      if (owner !== "monster") throw new Error(`怪物 ${monsterKey} 挂了角色技能 ${skillId}（owner=${owner}）—— 怪物技能必须是 owner=monster`);
      const priority = Number(entry?.priority ?? 0);
      if (!Number.isFinite(priority)) throw new Error(`怪物 ${monsterKey} 的技能 ${skillId} 的 priority 不是数字`);
      const row = { skillId, priority: round(priority) };
      if (entry?.cooldown !== undefined) {
        const cooldown = Number(entry.cooldown);
        if (!Number.isFinite(cooldown) || cooldown < 0) throw new Error(`怪物 ${monsterKey} 的技能 ${skillId} 的 cooldown 非法：${entry.cooldown}`);
        row.cooldown = round(cooldown);
      }
      return row;
    });
    out.push([monsterKey, rows]);
  }
  if (out.length === 0) throw new Error("configs/monster-skills 为空（改名或清空了？生成物少一张表比报错危险得多）");
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

/**
 * 养成等级配置的元数据（战魂阶 / 称号等级共用一条形状）
 *
 * `attributes` 已由 `pickAttributes` 单独快照，这里只带**管理端要展示与编辑**的
 * 四个字段：文案、升到该级的价格、动画资源与帧率 —— 全部取自等级条目本身，
 * 不在这里重算（客户端 configs 怎么写，快照就是什么）。
 */
function pickConfigMeta(item) {
  return {
    description: String(item.description ?? ""),
    bindGold: round(item.bindGold ?? 0),
    animation: String(item.animation ?? ""),
    animationFrameRate: round(item.animationFrameRate ?? 0),
  };
}

/** 军衔阶的元数据（#250）：军衔没有动画，只带文案与晋升价格（rankUpgradePrice 派生的 bindGold） */
function pickRankMeta(item) {
  return {
    description: String(item.description ?? ""),
    bindGold: round(item.bindGold ?? 0),
  };
}

/**
 * 成长曲线（#256）→ [[曲线键, 分段数组]]
 *
 * curves 键是 configs/growth 的 roleGrowth 四条曲线（maxHp / attack / defense / killsPerLevel），
 * 每段 {from, to, start, perLevel} 原样快照 —— 分段线性插值的口径留在客户端，
 * 这里只搬数据，不复制「怎么取样」。
 */
function pickGrowthCurves(roleGrowth) {
  const out = [];
  for (const [key, segments] of Object.entries(roleGrowth)) {
    if (!Array.isArray(segments) || segments.length === 0) throw new Error(`成长曲线 ${key} 为空（configs/growth 改坏了？）`);
    out.push([
      key,
      segments.map((segment) => ({
        from: round(segment.from ?? 0),
        to: round(segment.to ?? 0),
        start: round(segment.start ?? 0),
        perLevel: round(segment.perLevel ?? 0),
      })),
    ]);
  }
  return out;
}

/**
 * 成长标量参数（#256）→ [[键, 数值]]
 *
 * 键用「来源.字段」的扁平形状，消费方按字符串取值；管理端 seed 时逐行落库、
 * 逐行编辑 —— 所以这里必须是**纯数值**，任何结构化的东西都该进 curves。
 */
function pickGrowthScalars(growth, expGain) {
  const out = [];
  const push = (key, value) => {
    if (!Number.isFinite(value)) throw new Error(`成长标量 ${key} 不是有限数值（configs 改坏了？）`);
    out.push([key, round(value)]);
  };
  push("roleMaxLevel", growth.roleMaxLevel);
  push("attributeRange.minRate", growth.attributeRange.minRate);
  push("attributeRange.mpRate", growth.attributeRange.mpRate);
  push("attributeRange.hpRecoverRate", growth.attributeRange.hpRecoverRate);
  push("expGain.expPerLevel", expGain.expPerLevel);
  push("expGain.maxLevelGap", expGain.maxLevelGap);
  return out;
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
  // 值是任意纯 JSON（如成长曲线的分段数组）时的通用形状
  const jsonTable = (name, comment, rows) =>
    `/** ${comment} */\nexport const ${name}: Record<string, unknown> = {\n${rows
      .map(([key, value]) => `  ${JSON.stringify(String(key))}: ${JSON.stringify(value)},`)
      .join("\n")}\n};\n`;

  return `/**
 * ⚠️ 生成物，请勿手改 —— @generated by tools/gen-shared-data.cjs
 *
 * 来源 = 客户端 \`client/assets/configs\`（level / battle / soul / title / rank / equipments /
 * skill-data / role / items / map / monster）与 \`client/assets/types/role.ts\` 的枚举注释（职业码「全职业」、
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
 * 不在范围：掉落（掉落结算还没上服务端，等世界权威那一刀）。
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
${numTable("SKILLS", "技能 id → 整行配置（#367：owner / 分类 / 动作 / 特效 / 冷却 / 耗蓝 / 距离 / 等级 / 伤害系数 / 挂载状态 / 释放限制）。damageCoefficients 的下标 = 技能等级", s.skills)}
${jsonTable("STATUSES", "状态 id → 整行配置（#367：owner / 时长 / 图标特效 / 战斗数值修正 combat）。combat 的口径实现在客户端 BattleMath", s.statuses)}
${jsonTable("MONSTERS", "怪物 key → 名称与战斗数值（#258；monsterStats 打底 + 条目覆盖，已展开；tier 仅作标注）+ AI 参数 aggressive/detectRange/moveSpeed（#323）", s.monsters)}
${jsonTable("MONSTER_AI", "怪物 AI 全局节奏参数（#323：普攻间隔/普攻距离/待机游走节奏，服务端 AI tick 与客户端同源）", s.monsterAi)}
${jsonTable("MONSTER_SKILLS", "怪物 key → 技能挂载清单（#372：skillId / priority / 可选 cooldown 覆写）。服务端 AI 按它释放，管理端可增删改", s.monsterSkills)}
${jsonTable("NPCS", "NPC id → 名称（#258；对话文案不在配置里，管理端 npcs 表的 dialog 列运营可改）", s.npcs)}
${jsonTable("FASHIONS", "时装 id → { label, description, icon 图标, in 内观, out 外观, sellPrice 售卖价, maxHp 与六项攻防区间 }（#257；属性当前全 0，管理端可改）", s.fashions)}
${jsonTable("DROP_TABLES", "具名掉落表 id → { picks 抽取次数, entries 条目池 }（#254；weight/chance/count 已规整为全显式，缺省规则不在消费方复制）", s.dropTables)}
${jsonTable("MONSTER_DROPS", "怪物 key → 独立掉落表 { picks, entries }（#254；实际掉落以此为准，key 与 MONSTERS 对齐）", s.monsterDrops)}
${jsonTable("DROP_DEFAULT", "兜底掉落表（#254；怪物既无独立表也没引用具名表时使用）", s.dropDefault)}
${jsonTable("GROWTH_CURVES", "成长曲线键 → 分段线性曲线（#256；段形状 {from,to,start,perLevel}，插值口径在客户端 configs/growth）", s.growthCurves)}
${numTable("GROWTH_SCALARS", "成长标量参数键 → 数值（#256；roleMaxLevel / attributeRange.* / expGain.*）", s.growthScalars)}

/** 商城统一价（#251）：全场默认售价（绑定元宝/件），服务端 mall_settings 的 seed 来源；特殊价是运营数据不进快照 */
export const MALL: Record<string, number> = {
  "defaultPrice": ${s.mallDefaultPrice},
};

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
${jsonTable("EQUIPMENT_BASES", "装备基础件 id → { slot 部位, level 等级需求, sellPrice 售卖价, label 名称, attributes 八项属性 }（#252；只收普通的·人级，变体是它乘前后缀倍率展开的）", s.equipmentBases)}
${jsonTable("DRUGS", "药品 id → { label, description, level 使用等级, sellPrice, maxStack, cooldown, hp/mp 固定回复量, hpPercent/mpPercent 百分比回复 }（#253；effects 数组已按键求和，与客户端 resolveDrugRecovery 的累加口径等价）", s.drugs)}
${jsonTable("ITEM_BASES", "物品 id → { type 物品大类, label, description, level, sellPrice, maxStack }（#255；只收 MATERIAL / OTHER 大类，装备与药品各有自己的表）", s.itemBases)}
${jsonTable("QUESTS", "任务 id → { kind main|daily, label, description, prevQuestId 主线链前置, minLevel, npcId 发布 NPC, objective 单目标 kill|talk|collect, rewards { gold, exp, items } }（#396；服务端 quests 表的 seed 来源）", s.quests)}
${textTable("SOUL_LABELS", "战魂阶数（下标 + 1 即阶）→ 名", s.soulLabels)}
${textTable("TITLE_LABELS", "称号等级（下标 + 1 即等级）→ 名", s.titleLabels)}
${numTable("SOUL_LEVEL_META", "战魂阶数（下标 + 1 即阶）→ { description 文案, bindGold 升到该阶消耗, animation 动画资源, animationFrameRate 帧率 }", s.soulMeta)}
${numTable("TITLE_LEVEL_META", "称号等级（下标 + 1 即等级）→ { description 文案, bindGold 升到该级价格, animation 动画资源, animationFrameRate 帧率 }", s.titleMeta)}
${numTable("RANK_LABELS", "军衔阶数（下标 + 1 即阶）→ { tier 大段名, label 衔名 }", s.rankLabels)}
${numTable("RANK_LEVEL_META", "军衔阶数（下标 + 1 即阶）→ { description 文案, bindGold 晋到该阶消耗 }", s.rankMeta)}
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
