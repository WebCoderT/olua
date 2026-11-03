#!/usr/bin/env node
/**
 * 守卫：数据权威与跨端约定（#655 起「代码里没有第二份数据」）
 *
 * ===========================================================================
 * 这个审计守什么（#655 之前它守的是「生成物与客户端 configs 逐字节一致」）
 * ===========================================================================
 * 那时三端共用的数据是 `server/src/shared/game-data.generated.ts` —— 从客户端 configs
 * 扫描出来的快照。于是必须有守卫盯着「改了客户端配置、忘了重新生成」。
 *
 * #655 删掉了整条生成链：**数据只在库里，仓库里那份是 `server/data/config-sync.sql`**。
 * 文件名还叫 shared-data（三端共用的这份数据），守的东西换成了四条：
 *
 *   1. **快照完整性**：文件在、是本工具生成的、表清单与 `config-tables.cjs` 完全一致、
 *      每张配置表都有行。少一张表 = 别人 `config-import` 之后那张表整张空掉，
 *      而界面上只表现为「这一页什么都没有」。
 *   2. **枚举仍然只有一份**：职业 / 性别 / 装备部位 / 引导位与事件 / 怪物定位这几个
 *      **枚举**（加一个值就要改代码的那类）手写在 `common/constants/game-enums.ts`，
 *      客户端 `assets/types/*` 各有一份**同名同值**的声明 —— 这里逐值比对。
 *      「两份声明」没法消掉（一端 TS 编译、一端 Cocos 编译），所以至少要机械对齐。
 *   3. **不许把枚举抄进业务代码**：把 `["1","2","3","4"]` 或 `"1": "战士"` 这类东西写进
 *      页面 / DTO / 配置表，是「第二份数据」最常见的复活方式（#122 就是这么来的）。
 *      判据要精确（只认那几组已知键），宁可漏也不许误报 —— 误报的守卫活不过一个季度。
 *   4. **跨端常量**：实时通道关闭码（#111）与组队等级门槛（#497）两端各有一份，
 *      对不上不会报错，只会让行为悄悄变错（把 4000 当成普通掉线去抢连 = 两个客户端互相踢）。
 *
 * 不查什么：库与快照是否同步（那是 `make config-check` 的活，要连库）；
 * 客户端 configs 自身的完整性（那是 `audit-equip-align-catalog` 与客户端单测的活）。
 *
 * 用法：node tools/audit-shared-data.cjs
 * 退出码：全部通过 = 0；任一问题 = 1（`make audit` 据此判定 FAIL）
 */

const fs = require("node:fs");
const path = require("node:path");

const { CONFIG_TABLES, FORMAT_TAG, TABLES_LINE_PREFIX } = require("../server/scripts/lib/config-tables.cjs");
const { readRows, readSnapshotText } = require("./lib/snapshot-sql.cjs");

const ROOT = path.resolve(__dirname, "..");
const SERVER_SRC = path.join(ROOT, "server", "src");
const ASSETS = path.join(ROOT, "client", "assets");
const ADMIN_SRC = path.join(ROOT, "admin", "src");

/** 枚举的唯一手写处 */
const GAME_ENUMS = path.join(SERVER_SRC, "common", "constants", "game-enums.ts");
/** 客户端枚举声明（逐值比对的对象） */
const CLIENT_TYPES = {
  role: path.join(ASSETS, "types", "role.ts"),
  good: path.join(ASSETS, "types", "good.ts"),
  guide: path.join(ASSETS, "types", "guide.ts"),
  monster: path.join(ASSETS, "types", "monster.ts"),
};
const SERVER_CONFIG = path.join(SERVER_SRC, "config", "configuration.ts");
const SOCIAL_CONSTANTS = path.join(SERVER_SRC, "common", "constants", "social.ts");
const CLIENT_NAV = path.join(ASSETS, "configs", "bottomNav.ts");
const REALTIME_PROTOCOL = path.join(SERVER_SRC, "modules", "realtime", "realtime.protocol.ts");
const CLIENT_API_CODES = path.join(ASSETS, "ui", "utils", "net", "ApiCodes.ts");

const problems = [];
const fail = (message) => problems.push(message);

/** 读文件（不存在直接报问题，别静默跳过） */
function read(file, label) {
  if (!fs.existsSync(file)) {
    fail(`找不到 ${label}（${path.relative(ROOT, file)}）—— 判据被删了就等于没有守点`);
    return "";
  }
  return fs.readFileSync(file, "utf8");
}

/** 剥注释（守卫判据一律读「代码」，不读注释里的例子） */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

//#region 1. 快照完整性

function checkSnapshot() {
  const text = readSnapshotText();
  if (!text) {
    fail("server/data/config-sync.sql 不存在 —— 出厂数据没了，空库启动会直接没有配置（跑一次 make config-export）");
    return;
  }
  if (!text.includes(FORMAT_TAG)) {
    fail(`快照缺少格式标记（${FORMAT_TAG}）—— 这不是 make config-export 的产物`);
    return;
  }

  const header = text.split("\n", 12);
  const tablesLine = header.find((line) => line.startsWith(TABLES_LINE_PREFIX));
  const declared = tablesLine ? tablesLine.slice(TABLES_LINE_PREFIX.length).split(",").filter(Boolean) : [];
  const declaredSet = new Set(declared);
  const expectedSet = new Set(CONFIG_TABLES);
  const missing = CONFIG_TABLES.filter((name) => !declaredSet.has(name));
  const extra = declared.filter((name) => !expectedSet.has(name));
  if (missing.length || extra.length) {
    fail(
      `快照的表清单与 config-tables.cjs 不一致：${[
        missing.length ? `缺 ${missing.join(", ")}` : "",
        extra.length ? `多 ${extra.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("；")}\n  说明这份快照是旧版本导出的（中间加 / 删过配置表）—— 重新 make config-export。`,
    );
  }

  // 逐表数行：空表几乎一定是导出前就空着（或表名写错），消费方拿到的是「一页空白」
  const countsLine = header.find((line) => line.startsWith("-- counts: ")) ?? "";
  const declaredCounts = new Map(
    countsLine
      .slice("-- counts: ".length)
      .split(",")
      .filter(Boolean)
      .map((pair) => [pair.split("=")[0], Number(pair.split("=")[1])]),
  );
  const empty = [];
  let total = 0;
  for (const table of CONFIG_TABLES) {
    const rows = readRows(text, table).length;
    total += rows;
    if (rows === 0) empty.push(table);
    const declaredCount = declaredCounts.get(table);
    if (declaredCount !== undefined && declaredCount !== rows) {
      fail(`快照头部写的 ${table}=${declaredCount} 与实际行数 ${rows} 不符 —— 文件被手工改过？重新导出`);
    }
  }
  if (empty.length > 0) {
    fail(
      `这些配置表在快照里一行都没有：${empty.join(", ")}\n` +
        `  空表 = 别人 config-import 之后那张表整张空掉，而界面上只表现为「这一页什么都没有」。`,
    );
  }

  console.log(`  快照：${CONFIG_TABLES.length} 张配置表 / ${total} 行`);
}

//#endregion

//#region 2. 枚举逐值比对

/** 从 `export const NAME: Record<string,string> = { "1": "战士", … }` 里取键（键是码） */
function readLabelKeys(source, name) {
  const start = source.indexOf(`export const ${name}`);
  if (start < 0) return null;
  const open = source.indexOf("{", start);
  const close = source.indexOf("};", open);
  if (open < 0 || close < 0) return null;
  return [...stripComments(source.slice(open, close)).matchAll(/"([^"]+)"\s*:/g)].map((match) => match[1]);
}

/** 从 `export const NAME: string[] = [ "a", "b" ]`（可带 as const）里取值 */
function readStringArray(source, name) {
  const start = source.indexOf(`export const ${name}`);
  if (start < 0) return null;
  // 从 `=` 之后找 `[`：类型标注里的 `string[]` 会先命中一个方括号
  const equals = source.indexOf("=", start);
  const open = source.indexOf("[", equals < 0 ? start : equals);
  const close = source.indexOf("]", open);
  if (open < 0 || close < 0) return null;
  return [...stripComments(source.slice(open, close)).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/** 从 `export const NAME = { A: "x", … } as const` 里取值（客户端那份引导白名单是对象形式） */
function readObjectValues(source, name) {
  const start = source.indexOf(`export const ${name}`);
  if (start < 0) return null;
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  if (open < 0 || close < 0) return null;
  return [...stripComments(source.slice(open, close)).matchAll(/:\s*"([^"]+)"/g)].map((match) => match[1]);
}

/** 从 `export enum NAME { A = "x", … }` 里取值 */
function readStringEnum(source, name) {
  const start = source.indexOf(`export enum ${name} {`);
  if (start < 0) return null;
  const close = source.indexOf("}", start);
  if (close < 0) return null;
  return [...stripComments(source.slice(start, close)).matchAll(/=\s*"([^"]+)"/g)].map((match) => match[1]);
}

/** 从 `export type NAME = "a" | "b"` 里取值 */
function readStringUnion(source, name) {
  const matched = new RegExp(`export type ${name}\\s*=([^;]+);`).exec(source);
  if (!matched) return null;
  return [...matched[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/** 两组值必须完全相同（不看顺序，但看数量） */
function compareValues(label, server, client, serverFile, clientFile) {
  if (!server || server.length === 0) {
    fail(`${path.relative(ROOT, serverFile)} 里解析不出 ${label}（写法变了？改了就同步改本审计的判据）`);
    return;
  }
  if (!client || client.length === 0) {
    fail(`${path.relative(ROOT, clientFile)} 里解析不出 ${label} 的对应声明（写法变了？）`);
    return;
  }
  const serverSet = new Set(server);
  const clientSet = new Set(client);
  const onlyServer = [...serverSet].filter((value) => !clientSet.has(value));
  const onlyClient = [...clientSet].filter((value) => !serverSet.has(value));
  if (onlyServer.length || onlyClient.length) {
    fail(
      `${label} 两端不一致：\n` +
        `  ${path.relative(ROOT, serverFile)} 多出 ${onlyServer.join(", ") || "（无）"}\n` +
        `  ${path.relative(ROOT, clientFile)} 多出 ${onlyClient.join(", ") || "（无）"}\n` +
        `  枚举加一个值意味着客户端也要认识它（否则界面打不开、服务端保存被拒）。`,
    );
  }
}

function checkEnums() {
  const enums = read(GAME_ENUMS, "common/constants/game-enums.ts");
  if (!enums) return;

  const roleTypes = read(CLIENT_TYPES.role, "types/role.ts");
  const goodTypes = read(CLIENT_TYPES.good, "types/good.ts");
  const guideTypes = read(CLIENT_TYPES.guide, "types/guide.ts");
  const monsterTypes = read(CLIENT_TYPES.monster, "types/monster.ts");

  compareValues("职业码", readLabelKeys(enums, "OCCUPATION_LABELS"), readStringEnum(roleTypes, "OECCUPATION"), GAME_ENUMS, CLIENT_TYPES.role);
  compareValues("性别码", readLabelKeys(enums, "SEX_LABELS"), readStringEnum(roleTypes, "SEX"), GAME_ENUMS, CLIENT_TYPES.role);
  compareValues("装备部位", readStringArray(enums, "EQUIPMENT_SLOT_KEYS"), readStringEnum(goodTypes, "EQUIPMENT_TYPE"), GAME_ENUMS, CLIENT_TYPES.good);
  compareValues("引导高亮位", readStringArray(enums, "GUIDE_SPOTS"), readObjectValues(guideTypes, "GUIDE_SPOT"), GAME_ENUMS, CLIENT_TYPES.guide);
  compareValues("引导推进事件", readStringArray(enums, "GUIDE_EVENTS"), readObjectValues(guideTypes, "GUIDE_EVENT"), GAME_ENUMS, CLIENT_TYPES.guide);
  compareValues("怪物定位", readStringArray(enums, "MONSTER_TIERS"), readStringUnion(monsterTypes, "MonsterTier"), GAME_ENUMS, CLIENT_TYPES.monster);
}

//#endregion

//#region 3. 不许把枚举抄进业务代码

/** 允许出现「完整键清单」的地方：枚举的唯一手写处（这份文件本身就是权威） */
const ENUM_HOME = path.relative(ROOT, GAME_ENUMS);

/** 递归列出目录下的 .ts / .tsx */
function listSources(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        stack.push(full);
        continue;
      }
      if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(full);
    }
  }
  return out;
}

function checkNoCopies() {
  const enums = read(GAME_ENUMS, "common/constants/game-enums.ts");
  if (!enums) return;

  /** 要防的几组：完整键清单被写成数组字面量、或者码 → 名被写成字典 */
  const groups = [
    { name: "职业码", values: readLabelKeys(enums, "OCCUPATION_LABELS") ?? [], labelled: true },
    { name: "性别码", values: readLabelKeys(enums, "SEX_LABELS") ?? [], labelled: true },
    { name: "装备部位", values: readStringArray(enums, "EQUIPMENT_SLOT_KEYS") ?? [], labelled: false },
  ].filter((group) => group.values.length >= 3);

  const targets = [
    ...listSources(SERVER_SRC),
    ...listSources(ADMIN_SRC),
    ...listSources(path.join(ASSETS, "configs")),
  ];
  for (const file of targets) {
    const rel = path.relative(ROOT, file);
    if (rel === ENUM_HOME) continue;
    const source = stripComments(fs.readFileSync(file, "utf8"));
    for (const group of groups) {
      // 完整键清单：`["1", "2", "3", "4"]`（顺序无关，只要全都出现且没有别的）
      for (const matched of source.matchAll(/\[([^\]\n]{10,400})\]/g)) {
        const values = [...matched[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
        if (values.length !== group.values.length) continue;
        if (group.values.every((value) => values.includes(value))) {
          fail(
            `${rel} 里手抄了${group.name}的完整清单（${values.join(", ")}）—— ` +
              `从 common/constants/game-enums 取，别维护第二份`,
          );
        }
      }
      // 码 → 名字典：必须**键集完全等于**这组码才算抄（`{"0":"主动","1":"被动",…}` 这类
      // 技能分类字典里有 1/2/3，但它们不是职业码 —— 宽松判据会把它误报成抄职业名）
      if (group.labelled) {
        for (const matched of source.matchAll(/\{[^{}]{10,800}\}/g)) {
          const keys = [...matched[0].matchAll(/"([^"]+)"\s*:\s*"/g)].map((item) => item[1]);
          if (keys.length !== group.values.length) continue;
          const keySet = new Set(keys);
          if (group.values.every((value) => keySet.has(value))) {
            fail(
              `${rel} 里手抄了${group.name} → 名字的字典（${keys.join(", ")}）—— ` +
                `名字也在 game-enums，别另写一份`,
            );
          }
        }
      }
    }
  }
}

//#endregion

//#region 4. 跨端常量

/** 从 `export const NAME = { A: 4000, … }`（或 `} as const;`）里取「键 → 数字」 */
function readNumericEnum(source, name) {
  const start = source.indexOf(`export const ${name} = {`);
  if (start === -1) return null;
  const rest = source.slice(start);
  const close = /}\s*(?:as\s+const\s*)?;/.exec(rest);
  if (!close) return null;
  const out = new Map();
  for (const match of stripComments(rest.slice(0, close.index)).matchAll(/([A-Za-z_]\w*)\s*:\s*(\d+)\s*,/g)) {
    out.set(match[1], Number(match[2]));
  }
  return out;
}

/** 实时通道关闭码：服务端定义，客户端 `ApiCodes.ts` 是手写镜像，逐键比对 */
function checkRealtimeClose() {
  const server = readNumericEnum(read(REALTIME_PROTOCOL, "realtime.protocol.ts"), "REALTIME_CLOSE");
  const client = readNumericEnum(read(CLIENT_API_CODES, "ui/utils/net/ApiCodes.ts"), "REALTIME_CLOSE");
  if (!server || server.size === 0) {
    fail("realtime.protocol.ts 里解析不出 REALTIME_CLOSE（写法变了？改了就同步改本审计）");
    return;
  }
  if (!client || client.size === 0) {
    fail("ApiCodes.ts 里解析不出 REALTIME_CLOSE（客户端那份手写镜像没了？两个客户端互相踢的 bug 会回来）");
    return;
  }
  for (const [key, value] of server) {
    if (!client.has(key)) {
      fail(`ApiCodes.ts 的 REALTIME_CLOSE 少了 ${key}（服务端是 ${value}）`);
      continue;
    }
    if (client.get(key) !== value) {
      fail(`REALTIME_CLOSE.${key} 两端不一致：服务端 ${value}、客户端 ${client.get(key)}`);
    }
  }
  for (const key of client.keys()) {
    if (!server.has(key)) fail(`ApiCodes.ts 的 REALTIME_CLOSE 多了 ${key} —— 服务端没有这个码，客户端在判一个不存在的东西`);
  }
}

/** 组队等级门槛：服务端常量与客户端「组队」入口的 openLevel 必须相等 */
function checkPartyMinLevel() {
  const social = read(SOCIAL_CONSTANTS, "common/constants/social.ts");
  const serverMatch = /export const PARTY_MIN_LEVEL_DEFAULT\s*=\s*(\d+)\s*;/.exec(social);
  if (!serverMatch) {
    fail("找不到 PARTY_MIN_LEVEL_DEFAULT（common/constants/social.ts）—— 组队门槛的唯一来源没了");
    return;
  }
  const groupLine = read(CLIENT_NAV, "configs/bottomNav.ts")
    .split("\n")
    .find((line) => line.includes('key: "group"'));
  const clientMatch = groupLine && /openLevel:\s*(\d+)/.exec(groupLine);
  if (!clientMatch) {
    fail('找不到组队入口的 openLevel（configs/bottomNav.ts 里 key: "group" 那一行）');
    return;
  }
  const server = Number(serverMatch[1]);
  const client = Number(clientMatch[1]);
  if (server !== client) {
    fail(
      "组队等级门槛两端不一致（#497）：\n" +
        `  服务端 PARTY_MIN_LEVEL_DEFAULT = ${server}\n` +
        `  客户端 bottomNav「组队」openLevel = ${client}\n` +
        "  客户端高了，服务端放行的邀请对方打不开面板；客户端低了，玩家能进却一律被拒。",
    );
  }
  const configurable =
    /partyMinLevel:\s*Number\(\s*process\.env\.PARTY_MIN_LEVEL\s*\?\?\s*PARTY_MIN_LEVEL_DEFAULT\s*\)/.test(
      read(SERVER_CONFIG, "config/configuration.ts"),
    );
  if (!configurable) {
    fail("configuration.ts 的 partyMinLevel 默认值必须引用 PARTY_MIN_LEVEL_DEFAULT（不许再写一份字面量）");
  }
}

//#endregion

console.log("检查数据权威与跨端约定…");
checkSnapshot();
checkEnums();
checkNoCopies();
checkRealtimeClose();
checkPartyMinLevel();

if (problems.length === 0) {
  console.log(
    "✓ 配置快照完整（表齐、每张非空、行数与头部一致）、枚举与客户端逐值一致、业务代码里没有第二份枚举、跨端常量（关闭码 / 组队门槛）对齐",
  );
  process.exit(0);
}

console.error(`\n✗ 数据权威守卫有 ${problems.length} 处问题：\n`);
problems.forEach((item, index) => console.error(`  ${index + 1}. ${item}`));
console.error("");
process.exit(1);
