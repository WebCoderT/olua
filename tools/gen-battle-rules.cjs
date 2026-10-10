#!/usr/bin/env node
/**
 * 生成服务端战斗规则（`server/src/modules/combat/battle-rules.generated.ts`）
 *
 * ===========================================================================
 * 为什么要有这个文件
 * ===========================================================================
 * 服务端要成为战斗权威，就必须知道成长曲线 —— 而这与项目既有的心智模型正面相撞：
 *
 *   「服务端不认识客户端配置，从不复制一份游戏配置过来」
 *
 * 那条原则的**目的**是防止两端漂移（服务端抄一份，客户端改了没跟上）。它是用「不抄」
 * 来保证的，而这个生成器用更强的手段满足同一个目的：**让服务端引用同一份来源**。
 *
 * 做法是把它变成一条与 `gen-api.cjs` 同构的管线：编译客户端的纯配置 → 在 Node 里加载
 * → 快照成服务端源码。**单一来源仍然是 `client/assets/configs`**，服务端手里只是一份
 * 带 `@generated` 头的快照，与其它生成物一样不许手改。
 *
 * 之所以能这么做，是因为服务端要用的那几份配置恰好**不依赖 Cocos 引擎**：
 *   growth / level / battle / soul / title / rank   —— 零 cc 依赖
 *   equipments                                      —— cc 只用于表现层（配色 Color、贴图偏移 Vec2），
 *                                                      shim 接住这两个类就能读到真实战斗数值
 *
 * ===========================================================================
 * 不在生成范围内的东西（以及为什么）
 * ===========================================================================
 * - **技能**：`configs/skill.ts` import 了 `assets/skills/zhan.ts`（技能运行时实现），
 *   后者要操作 Cocos 节点，垫片给不全。根因是**技能数值与技能实现耦合**了，
 *   得先把数值从 `zhan.ts` 里剥出来才能进这条管线（见 skill 那条 issue）。
 * - **怪物**：`configs/monster.ts` 同理还没验证，且与「服务端持有刷怪实例」是同一件事，
 *   等世界权威那一刀一起做。
 *
 * 所以本生成器只产出「角色属性汇总」所需的部分 —— 这是服务端算伤害的输入，先落地。
 *
 * 用法：node tools/gen-battle-rules.cjs
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const ASSETS = path.join(ROOT, "client", "assets");
const OUT = path.join(ROOT, "server", "src", "modules", "combat", "battle-rules.generated.ts");

/** 参与生成的客户端配置（单一来源；顺序只影响编译，不影响产物） */
const SOURCE_FILES = ["level", "battle", "soul", "title", "rank", "equipments"].map((name) => path.join(ASSETS, "configs", `${name}.ts`));

/** `configs/equipments` 按部位导出的七个装备表（顺序即快照顺序） */
const EQUIPMENT_MAPS = ["clothes", "weapons", "rings", "nicklaces", "shoes", "helmets", "belts"];

/**
 * 最小 Cocos 垫片
 *
 * 只有被拉进来的配置文件在**运行时**真的构造了才能用到；纯类型用途的 import 会被
 * TypeScript 擦掉，不需要垫。`equipments` 实际用到的只有这两个表现层类：
 * Color 给前后缀配色、Vec2 给贴图偏移 —— 都不参与战斗数值，垫住就能读到真值。
 */
const CC_SHIM = `"use strict";
class Color { constructor(value) { this.value = value; } }
class Vec2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } }
class Size { constructor(width = 0, height = 0) { this.width = width; this.height = height; } }
module.exports = { Color, Vec2, Size };
`;

/** 参与属性汇总的战斗属性（与 BattleAttributes 对应；hpRecover 单值，不在六项里） */
const RANGE_KEYS = ["physicalAttack", "magicAttack", "taoistAttack", "physicalDefense", "magicDefense", "taoistDefense"];
/** 单值属性 */
const SINGLE_KEYS = ["maxHp", "hpRecover"];

function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "olua-battle-rules-"));
  writeShim(work);
  compile(work);

  const cfg = load(work);
  const snapshot = buildSnapshot(cfg);
  const source = render(snapshot);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, source, "utf8");

  console.log(`✔ 已生成 ${path.relative(ROOT, OUT)}`);
  console.log(`  等级 ${snapshot.roleLevels.length} 级 · 战斗力权重 ${Object.keys(snapshot.combatWeights).length} 项`);
  console.log(`  战魂 ${snapshot.soulLevels.length} 级 · 称号 ${snapshot.titleLevels.length} 级 · 军衔 ${snapshot.rankLevels.length} 级`);
  console.log(`  装备（含前后缀变体）${snapshot.equipmentAttributes.length} 件`);
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
 * 报 `Cannot find module 'cc'` 是**预期内的**：客户端配置处在 Cocos 工程里，
 * 这里没有引擎类型。缺类型不影响 JS 产物（下面要用的是运行时的值，不是类型）。
 * 真正的失败（语法错误 / 找不到源文件）不会被吞掉。
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
    // tsc 会因为「找不到 cc」报 TS2307 而以非零码退出，但 JS 产物照样写了出来 —— 这正是我们要的
    log = execFileSync(tsc, ["-p", tsconfig], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    log = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }

  // 只看最重要的前几条：这里报错通常意味着客户端配置文件本身移动了或改名了
  const fatal = log.split("\n").filter((line) => line.includes("error TS") && !line.includes("Cannot find module 'cc'"));
  if (fatal.length > 0) throw new Error(`编译客户端配置失败：\n${fatal.slice(0, 3).join("\n")}`);
}

function load(work) {
  const dir = path.join(work, "out", "configs");
  const cfg = (name) => require(path.join(dir, `${name}.js`));
  const equipments = cfg("equipments");
  return {
    level: cfg("level"),
    battle: cfg("battle"),
    soul: cfg("soul"),
    title: cfg("title"),
    rank: cfg("rank"),
    equipmentMaps: EQUIPMENT_MAPS.map((name) => [name, equipments[name]]),
  };
}

/**
 * 抽成一个与引擎、与 TS 类型都无关的纯数据快照
 *
 * 只保留**参与战斗计算**的字段。表现层的东西（称号文案、颜色、贴图偏移）一概不进，
 * 否则服务端会被一堆用不上的字段淹没，而且每次改文案都要重生成。
 */
function pickAttributes(source) {
  if (!source) return null;
  const out = {};
  for (const key of SINGLE_KEYS) out[key] = round(source[key] ?? 0);
  for (const key of RANGE_KEYS) out[key] = tuple(source[key]);
  return out;
}

function buildSnapshot(cfg) {
  return {
    roleLevels: pickMap(cfg.level.levelMap, (value) => {
      const out = pickAttributes(value);
      out.maxMp = round(value.maxMp ?? 0);
      out.exp = round(value.exp ?? 0);
      return out;
    }),
    combatWeights: pickMap(cfg.battle.combatCalc),
    soulLevels: pickList(cfg.soul.soulLevels, (item) => pickAttributes(item.attributes)),
    titleLevels: pickList(cfg.title.titleLevels, (item) => pickAttributes(item.attributes)),
    rankLevels: pickList(cfg.rank.rankLevels, (item) => pickAttributes(item.attributes)),
    equipmentAttributes: pickEquipments(cfg.equipmentMaps),
  };
}

/**
 * 七个部位的装备 Map → [[物品 id, 属性]]
 *
 * 快照**展开后的全量表**（基础件 × 前缀 × 后缀），而不是「基础件 + 倍率」让服务端现算：
 * 变体每条属性是 round(基础值 × 前缀倍率 × 后缀倍率)，六项区间还要各算一次 ——
 * 让服务端照抄一遍展开规则，等于把「4.5 该不该进位」这类口径复制了出去，
 * 而这正是这条管线要消灭的东西。全量几百件不过上百 KB，一次查表取到客户端同一份数值，便宜得多。
 *
 * id 重复要在**这里**挡掉：落到 `Record` 里就是 TS1117「重复属性名」，
 * 报错点离真因很远（曾经为了它查过一轮）。
 */
function pickEquipments(maps) {
  const out = [];
  const seen = new Set();
  for (const [name, map] of maps) {
    if (!map) throw new Error(`configs/equipments 里没有 ${name}（导出改名或删了？）`);
    map.forEach((item, id) => {
      if (seen.has(id)) throw new Error(`装备 id 重复：${id}（同一 id 不能出现在两个部位表里）`);
      seen.add(id);
      out.push([id, pickAttributes(item)]);
    });
  }
  return out;
}

/**
 * Map → [[键, 值]]，**保持 Map 的自然顺序**
 *
 * 不排序是有意的：Map 的插入顺序来自配置文件本身（写就成了既稳定又符合作者意图的顺序），
 * 再排一次反而可能把键的类型搞错 —— 权重表的键是**属性名**（字符串），
 * 拿 Number() 去转会得到 NaN，然后在 JSON 里落成 `null`（真踩过）。
 */
function pickMap(map, project) {
  const out = [];
  map.forEach((value, key) => out.push([key, project ? project(value) : round(value)]));
  return out;
}

/** T[] → 下标数组（保留 0 基下标：getSoulLevel(n) 的入参就是它） */
function pickList(list, project) {
  return (list || []).map((item, index) => [index, project(item)]);
}

const tuple = (value) => (Array.isArray(value) ? [round(value[0]), round(value[1])] : [0, 0]);
const round = (value) => (Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0);

/** 渲染成服务端源码 */
function render(snapshot) {
  const literal = (value, indent) => JSON.stringify(value).replace(/,/g, `,\n${indent}`);
  const table = (name, comment, rows) => {
    const body = rows.map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`).join("\n");
    return `/** ${comment}（下标 / 键 = 来源等级） */\nexport const ${name} = {\n${body}\n};\n`;
  };

  return `/**
 * ⚠️ 生成物，请勿手改 —— @generated by tools/gen-battle-rules.cjs
 *
 * 来源 = 客户端 \`client/assets/configs\`（level / battle / soul / title / rank / equipments）。
 * 想改数值请改那里，然后 \`node tools/gen-battle-rules.cjs\` 重新生成。
 *
 * 为什么服务端要有这份数据：要做**战斗权威**，服务端得自己算得出玩家的战斗属性，
 * 而角色属性的全部来源只有五个 —— 等级、战魂、称号、军衔，加上身上穿的装备。
 * 放在这里而不是各写一版，是为了让两端永远不可能算得不一样（这条原则的成本由
 * 生成器承担，不由人承担）。
 *
 * 形状：键一律是**等级 / 下标 / 物品 id**，值一律是纯数字或 [下限, 上限] 元组 —— 不含
 * 文案、颜色、贴图偏移这类表现层字段，也不含 Cocos 类型。装备那张表的键是**展开后**的
 * 物品 id（基础件的原 key，或带前后缀的 \`_pXsY\`），与客户端 \`getEquipment(id)\` 同口径。
 */

/** 六项区间型战斗属性。如 ["physicalAttack","magicAttack",...] */
export const COMBAT_RANGE_KEYS = ${literal(RANGE_KEYS, "  ")};

/** 单值型战斗属性。maxHp 参与战斗力，hpRecover 不参与（见 configs/battle 的说明） */
export const COMBAT_SINGLE_KEYS = ${literal(SINGLE_KEYS, "  ")};

${table("ROLE_LEVEL_ATTRIBUTES", "等级 → 战斗属性", snapshot.roleLevels)}
${table("COMBAT_WEIGHTS", "战斗力权重（属性 → 倍率）", snapshot.combatWeights)}
${table("SOUL_LEVEL_ATTRIBUTES", "战魂等级 → 整份属性加成", snapshot.soulLevels)}
${table("TITLE_LEVEL_ATTRIBUTES", "称号等级 → 整份属性加成", snapshot.titleLevels)}
${table("RANK_LEVEL_ATTRIBUTES", "军衔等级 → 整份属性加成", snapshot.rankLevels)}
${table("EQUIPMENT_ATTRIBUTES", "装备 id → 战斗属性（已含前后缀变体，id 里带品质后缀，如 cloth_1_p3s2）", snapshot.equipmentAttributes)}
`;
}

main();
