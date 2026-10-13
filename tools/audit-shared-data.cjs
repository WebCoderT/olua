#!/usr/bin/env node
/**
 * 守卫：公共游戏数据生成物是否与客户端来源一致
 *
 * ===========================================================================
 * 为什么必须有这个
 * ===========================================================================
 * `game-data.generated.ts` 是客户端配置的**快照**。快照这种东西，生成完没人管就会腐化：
 * 有人改了 `client/assets/configs/equipments.ts` 的装备数值、或者改了个称号名，服务端与
 * 管理端手里那份还停在旧值上 —— 管理端给运营看的装备名是旧的，服务端算出来的伤害与
 * 客户端显示的也对不上。**双方都不会报错，只是一端慢慢偏离另一端。**
 *
 * 所以照 `audit-api-generated.cjs` 的做法，用「重新生成一遍 + 逐字节比对」把它钉死。
 * 过期时不需要人去判断「要不要更新」—— 答案永远是「重新生成」，因为来源在客户端，
 * 这边没有别的正确答案可选。
 *
 * ===========================================================================
 * 除了逐字节，还查什么
 * ===========================================================================
 * 逐字节比对只能发现「产物与生成器不一致」，发现不了「生成器自己少产了一张表」——
 * 后者是同一份代码生成的，比对必然通过，而消费方拿到的是 `undefined`（管理端页面上
 * 就是空白、服务端查表就是 0）。所以这里再补两条：
 *
 *   1. **必需导出清单**：每张表都得在（漏一张 = FAIL，并指名道姓）；
 *   2. **非空**：每张表至少有一条数据（空表几乎一定是抽错了来源数组）。
 *
 * ===========================================================================
 * 还有一条更难的：**内容被抄进源码**
 * ===========================================================================
 * 「谁也不许自己维护一份」这句话，破法有两种：
 *
 *   a. **复制一张表到本地**（`const OCCUPATION_LABELS = {`）—— 判据是「与生成物**同名**的定义」，
 *      转发写法（`export { X } from "…"`）不会误报；
 *   b. **换个名字把同一份内容写一遍**（手写的 `["1","2","3","4"]` 清单、DTO 描述里那一行
 *      `1 战士 / 2 魔法师 / …`）—— 同名判据抓不到，而且它**全靠人记得同步**。
 *
 * b 才是真正会腐化的那种（#122：服务端的 `ROLE_OCCUPATIONS` 注释里写着「与客户端一致」，
 * 而这两个文件之间没有任何机械连接）。判据按「短标签表」定：
 *
 *   - **完整键列表被写成数组字面量**：`["1", "2", "3", "4"]`；
 *   - **行文被抄**：同一张表里出现 ≥ 2 条 `码 名`（如 `1 战士`、`2 魔法师`）。
 *
 * 只对「键数 ≤ 8 且值全是字符串」的表做这两条：那是枚举清单的形状，
 * 逐条抄进源码是真实发生过的破法；而物品 / 装备那种几百行的表本来就抄不动，
 * 硬去匹配只会带来误报。**带 `@generated` 标记的文件一律跳过** ——
 * 两端的 `ApiModels.ts` / `models.ts` 里本来就镜像着 DTO 描述，那是生成出来的，不是维护的。
 *
 * ===========================================================================
 * 第三种破法：**同一个数，两端各写一份**
 * ===========================================================================
 * 「三端只有一份」不只管数据表。角色数量上限就是同一个数写在两个地方：客户端
 * `configs/role.ts` 手写 `maxRoleCount = 3`，服务端 `.env` 的 `ROLE_MAX_PER_ACCOUNT` ——
 * 两者之间只有一句「两边要一起改」的注释（#124）。
 *
 * 现在客户端那份**没有数字了**：界面能画几个角色，唯一来源是选角布局的**站位数组**
 * （`roleSelectorLayout.rolePositions`，有几个站位就画几个），客户端创建前的拦截是
 * 「站位满了」而不是另一份上限；服务端那个是**业务上限**，它只能**调低** ——
 * 调过站位数量，玩家就能建出界面上没处放的角色（多出来的取不到站位，会叠在原点）。
 *
 * 这一节守的就是这条：仓库里的默认值不大于站位数量，且客户端不许再冒出第二份上限数字。
 *
 * **看不到的部分写在明处**：部署那台的 `.env` 是本地文件（不进仓库），守卫读不到 ——
 * 所以「只能调低」必须写在文档里，客户端另有一条运行期告警兜着（角色数 > 站位数量时打日志）。
 *
 * ===========================================================================
 * 与 `audit-combat-parity.cjs` 的分工
 * ===========================================================================
 * 这条守「**数据**没漂移」，parity 那条守「**算法**写得对不对」—— 表一模一样，
 * 也可能有人在服务端把 maxHp 忘了加装备。两条都要有。
 *
 * 用法：node tools/audit-shared-data.cjs
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SERVER_SRC = path.join(ROOT, "server", "src");
const GENERATED = path.join(SERVER_SRC, "shared", "game-data.generated.ts");
const GENERATOR = path.join(ROOT, "tools", "gen-shared-data.cjs");

/** 选角布局（站位数量的唯一来源）与客户端那个「曾经的第二份上限」所在文件 */
const ASSETS = path.join(ROOT, "client", "assets");
const CLIENT_LAYOUT = path.join(ASSETS, "configs", "layout", "scenes.ts");
const CLIENT_ROLE_CONFIG = path.join(ASSETS, "configs", "role.ts");

/** 服务端「角色上限」的两处仓库默认值（运行时的 .env 是部署本地的，读不到） */
const ENV_EXAMPLE = path.join(ROOT, "server", ".env.example");
const SERVER_CONFIG = path.join(SERVER_SRC, "config", "configuration.ts");

/**
 * 必须存在的导出 —— 每张表都要在，且至少一条数据
 *
 * 清单与 `gen-shared-data.cjs` 的 `render()` 一一对应；加一张表就加一行。
 * 少写一行不会让别的检查失效，只会让「这张表整个消失」这件事没人管 —— 所以列全。
 */
const REQUIRED_EXPORTS = [
  // 战斗数值（服务端算角色属性用）
  "COMBAT_RANGE_KEYS",
  "COMBAT_SINGLE_KEYS",
  "ROLE_LEVEL_ATTRIBUTES",
  "COMBAT_WEIGHTS",
  "SOUL_LEVEL_ATTRIBUTES",
  "TITLE_LEVEL_ATTRIBUTES",
  "RANK_LEVEL_ATTRIBUTES",
  "EQUIPMENT_ATTRIBUTES",
  "SKILLS",
  // 名字与元数据（三端做界面用）
  "OCCUPATION_LABELS",
  "SEX_LABELS",
  "ITEM_LABELS",
  "ITEM_TYPES",
  "EQUIPMENT_SLOTS",
  "EQUIPMENT_SLOT_ORDER",
  "EQUIPMENT_DISPLAY_NAMES",
  "EQUIPMENT_SLOT_OF",
  "SOUL_LABELS",
  "TITLE_LABELS",
  "RANK_LABELS",
  "SKILL_LABELS",
  "MAP_LABELS",
  "EQUIPMENT_PREFIX_LABELS",
  "EQUIPMENT_SUFFIX_LABELS",
];

function main() {
  if (!fs.existsSync(GENERATED)) {
    fail(`生成物不存在：${path.relative(ROOT, GENERATED)}\n  先跑 node tools/gen-shared-data.cjs`);
  }

  const before = fs.readFileSync(GENERATED, "utf8");

  // 就地重生成：gen 脚本的输出路径是固定的，跑完把结果读回来比对即可
  try {
    execFileSync(process.execPath, [GENERATOR], {
      cwd: ROOT,
      stdio: "ignore",
      env: { ...process.env, NODE_OPTIONS: "" },
    });
  } catch (error) {
    fail(
      "重新生成公共游戏数据失败 —— 生成器跑不过去（来源配置改坏了？）\n" +
        `  自己跑一遍看报错：node ${path.relative(ROOT, GENERATOR)}\n` +
        `  ${String(error.message).split("\n")[0]}`,
    );
  }
  const after = fs.readFileSync(GENERATED, "utf8");

  const failures = [];
  if (before !== after) {
    failures.push(
      "公共游戏数据生成物已过期（客户端 configs 改了，但快照没跟上）\n" +
        "  修法只有一种：重新生成\n" +
        "    node tools/gen-shared-data.cjs",
    );
  }

  // 必需导出 + 非空：编译一份**真的产物**再数键数
  // （在源码上按缩进数条目会连嵌套的 damageCoefficients 一起算进来，那不是「一张表几条」）
  let counts = [];
  try {
    const mod = compileGenerated();
    counts = inspectExports(mod);
    // 消费方自查：两端都不许再手写同一份数据（同名字典 / 清单字面量 / 抄来的文案）
    failures.push(...findLocalCopies());
    failures.push(...findHandWrittenData(mod));
  } catch (error) {
    failures.push(String(error.message));
  }

  // 跨端数值约定：角色数量上限（客户端界面容量 vs 服务端上限）—— 见 #124
  let roleLimit = null;
  try {
    roleLimit = findRoleLimitDrift();
    failures.push(...roleLimit.problems);
  } catch (error) {
    failures.push(String(error.message));
  }

  if (failures.length > 0) fail(failures.join("\n\n"));

  // 去掉末尾那个换行再数：直接 split("\n") 会因末尾的空串多算一行，
  // 报出来的数会比 wc -l 大 1 —— 而 PR 里报产物行数用的是 wc -l，两个数字对不上就得解释半天
  const lines = after.replace(/\n$/, "").split("\n").length;
  const kb = Math.round(fs.statSync(GENERATED).size / 1024);
  console.log(`✔ 公共游戏数据一致（重新生成后逐字节相同，${lines} 行 / ${kb} KB）`);
  console.log(`  表 ${REQUIRED_EXPORTS.length} 张：${counts.join(" · ")}`);
  if (roleLimit) {
    const defaults = roleLimit.defaults.map((item) => `${item.label}=${item.value}`).join(" · ");
    console.log(`  角色上限：服务端默认（${defaults}）≤ 选角站位 ${roleLimit.capacity} 个 ✓`);
  }
}

/**
 * 把生成物编译成 JS 并 `require` 回来（后面两条检查都要**真的值**，不是源码文本）
 *
 * 这个编译单元**没有** Cocos 依赖（生成物本身不含引擎类型），所以任何 error TS 都是真错误 ——
 * 与 `audit-combat-parity.cjs` 那边要挑错码不同，这里一律当失败。
 */
function compileGenerated() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "olua-shared-audit-"));
  const outdir = path.join(work, "out");
  const tsconfig = path.join(work, "tsconfig.json");
  fs.writeFileSync(
    tsconfig,
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "CommonJS",
          moduleResolution: "node",
          outDir: outdir,
          rootDir: SERVER_SRC,
          skipLibCheck: true,
          esModuleInterop: true,
          strict: false,
          noEmitOnError: false,
        },
        files: [GENERATED],
      },
      null,
      2,
    ),
    "utf8",
  );

  runTsc(tsconfig, `生成物编译不过（${path.relative(ROOT, GENERATED)} 自己坏了）`);

  const mod = require(path.join(outdir, "shared", "game-data.generated.js"));
  fs.rmSync(work, { recursive: true, force: true });
  return mod;
}

/**
 * 跑一次 tsc，只把 `error TS` 当失败
 *
 * 两个编译单元共用。生成物那个**没有** Cocos 依赖，任何 error TS 都是真错误；
 * 布局那个 import 了 `cc`（本机没有引擎类型），所以 `Cannot find module 'cc'`
 * 要放过 —— 与 `gen-shared-data.cjs` 同口径：缺类型不影响 JS 产物，下面要的是运行时的值。
 */
function runTsc(tsconfig, failMessage, ignoreMissingCc = false) {
  const tsc = path.join(ROOT, "server", "node_modules", ".bin", "tsc");
  if (!fs.existsSync(tsc)) throw new Error(`找不到 tsc：${tsc}（先在 server/ 下装依赖）`);

  let log = "";
  try {
    log = execFileSync(tsc, ["-p", tsconfig], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    log = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  const fatal = log
    .split("\n")
    .filter((line) => line.includes("error TS") && !(ignoreMissingCc && line.includes("Cannot find module 'cc'")));
  if (fatal.length > 0) {
    throw new Error(`${failMessage}：\n  ${fatal.slice(0, 3).join("\n  ")}`);
  }
}

/** 逐表数条目，顺带查「表在不在、空不空」 */
function inspectExports(mod) {
  const problems = [];
  const counts = [];
  for (const name of REQUIRED_EXPORTS) {
    const value = mod[name];
    if (value === undefined) {
      problems.push(`生成物缺少导出 ${name}（生成器漏产了一张表，消费方拿到的是 undefined）`);
      continue;
    }
    const rows = Array.isArray(value) ? value.length : Object.keys(value).length;
    if (rows === 0) {
      problems.push(`${name} 是空表（0 条）—— 来源数组抽错了，还是客户端配置被清空了？`);
      continue;
    }
    counts.push(`${name}=${rows}`);
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return counts;
}

/**
 * 遍历两端源码（只 `.ts` / `.tsx`），跳过依赖目录与**生成物**
 *
 * 跳过生成物的判据是文件里有 `@generated` 标记 —— 不能按目录名跳：
 * `server/src/shared/` 里除了生成物还有手写的门面（`game-data.ts`），那个要扫。
 *
 * 给的 `source` 已经**剥掉注释**（见 stripComments）。
 */
function* eachSource() {
  const roots = [path.join(ROOT, "admin", "src"), SERVER_SRC];
  const skipDirs = new Set(["node_modules", "dist", "build"]);

  function* walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) yield* walk(path.join(dir, entry.name));
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const file = path.join(dir, entry.name);
      const raw = fs.readFileSync(file, "utf8");
      if (raw.includes("@generated")) continue;
      yield { file, rel: path.relative(ROOT, file), source: stripComments(raw) };
    }
  }

  for (const root of roots) if (fs.existsSync(root)) yield* walk(root);
}

/**
 * 剥掉注释（块注释换成等量空格、行注释删到行尾），**行号与列位置不变**
 *
 * 为什么必须剥：注释里写反例是正常的 —— 「不要写成 `["1","2","3","4"]`」这种说明
 * 恰恰应该写在被禁止的地方旁边（本文件头注释与 `game-data.ts` 里就各有一处），
 * 不剥的话守卫会把说明当成副本，然后逼着人把文档改丑。**真副本在代码与字符串里**：
 * 手写的清单是代码、DTO 的 `description` 是字符串字面量，剥注释都删不掉。
 *
 * 代价（已知，接受）：字符串里出现 `//`（比如 URL）会把该行后面截掉，
 * 于是那一行不再被扫。这类行里放游戏数据副本的概率可以忽略。
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

/** 报错时的落点（`文件:行号`） */
function locate(source, index) {
  return source.slice(0, index).split("\n").length;
}

/**
 * 抓 a 类：**与生成物同名的字典型定义**（复制一张表到本地）
 *
 * 判据是 `const X = {` / `const X: Record<...> = {`（X 与生成物导出同名）。
 * 转发写法（`export { X } from "…"`）不匹配，所以正解不会被误报。
 */
function findLocalCopies() {
  const pattern = new RegExp(`(?:export\\s+)?const\\s+(${REQUIRED_EXPORTS.join("|")})\\s*[:=]`);
  const problems = [];

  for (const { rel, source } of eachSource()) {
    const match = pattern.exec(source);
    if (!match) continue;
    problems.push(
      `${rel}:${locate(source, match.index)} 自己定义了一份 ${match[1]} —— ` +
        `游戏数据只有一份（server/src/shared/game-data.generated.ts），` +
        `要从它引用（管理端经 admin/src/api/gameData.ts、服务端经 server/src/shared/game-data.ts），不许复制`,
    );
  }
  return problems;
}

/** 短标签表的键数上限：超过这个数就不是「枚举清单」的形状，逐条抄进源码不现实 */
const SHORT_TABLE_MAX_KEYS = 8;

/**
 * 抓 b 类：**换个名字把内容写了一遍**（手写清单 / 抄来的文案）
 *
 * 见文件头「内容被抄进源码」一节。只查「键数 ≤ 8 且值全是字符串」的表，
 * 免得物品 / 装备那种大表把误报引进来。
 */
function findHandWrittenData(mod) {
  const tables = [];
  for (const [name, value] of Object.entries(mod)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const keys = Object.keys(value);
    if (keys.length === 0 || keys.length > SHORT_TABLE_MAX_KEYS) continue;
    if (!Object.values(value).every((item) => typeof item === "string")) continue;
    tables.push([name, keys, Object.values(value)]);
  }

  const problems = [];
  for (const { rel, source } of eachSource()) {
    for (const [name, keys, values] of tables) {
      // ① 完整键列表被写成数组字面量（`["1", "2", "3", "4"]`）
      const listPattern = new RegExp(`\\[\\s*${keys.map(quote).join("\\s*,\\s*")}\\s*\\]`);
      const list = listPattern.exec(source);
      if (list) {
        problems.push(
          `${rel}:${locate(source, list.index)} 手写了一遍 ${name} 的键清单 —— ` +
            `这份清单必须从公共数据取（用 Object.keys(…) 取键），否则客户端加了码这边不会知道`,
        );
      }

      // ② 行文被抄（`1 战士` / `2 魔法师`：同一张表至少两条才判）
      const hits = [];
      for (let index = 0; index < keys.length; index++) {
        const hit = new RegExp(`${escapeRegExp(keys[index])}\\s*${escapeRegExp(values[index])}`).exec(source);
        if (hit) hits.push({ index: hit.index, text: `${keys[index]} ${values[index]}` });
      }
      if (hits.length >= 2) {
        problems.push(
          `${rel}:${locate(source, hits[0].index)} 抄了 ${name} 的行文（${hits.map((hit) => hit.text).join(" / ")}…）—— ` +
            `这类文案要用 shared/game-data 的枚举一览常量，别手写`,
        );
      }
    }
  }

  problems.push(...findRequiresDerived());
  return problems;
}

/**
 * ③ 服务端**校验用**的那两条清单必须是从公共数据派生的
 *
 * 与 ① 的分工：① 抓「内容被抄了一遍」，这条抓「清单的来源」—— 只要右侧不是从公共数据
 * 算出来的（写回字面量、或换成别的本地常量），这里就报。它是这三条里唯一读**具体文件**的，
 * 因为「职业 / 性别的允许值」只有这一处入口，而它正是 #122 那个「注释里写着与客户端一致」
 * 的现场。
 */
function findRequiresDerived() {
  const file = path.join(SERVER_SRC, "modules", "roles", "role-data.util.ts");
  if (!fs.existsSync(file)) {
    throw new Error(`找不到 ${path.relative(ROOT, file)}（改名了？改了就来同步这条判据）`);
  }
  const source = fs.readFileSync(file, "utf8");
  const rel = path.relative(ROOT, file);
  const problems = [];

  if (!/from\s+"[^"]*shared\/game-data"/.test(source)) {
    problems.push(`${rel} 没有引用公共游戏数据（shared/game-data）—— 职业 / 性别清单必须从那里取`);
  }
  for (const name of ["ROLE_OCCUPATIONS", "ROLE_SEXES"]) {
    const match = new RegExp(`export const ${name}\\b[^=]*=\\s*([^;\\n]*)`).exec(source);
    if (!match) {
      problems.push(`${rel} 里找不到 ${name} 的定义（改名了？改了就来同步这条判据）`);
      continue;
    }
    if (/^\s*\[/.test(match[1])) {
      problems.push(`${rel} 的 ${name} 又写成字面量清单了：${match[1].trim().slice(0, 40)} —— 要从公共数据取键`);
    }
  }
  return problems;
}

/**
 * 跨端数值约定：**角色数量上限**（见 #124、文件头「同一个数两端各写一份」）
 *
 * 客户端那边没有「上限」这个数字 —— 界面能画几个角色，唯一来源是选角布局的**站位数组**
 * `roleSelectorLayout.rolePositions`（站几个就画几个，见 `ui/RoleSelector.createRole`）。
 * 服务端的 `ROLE_MAX_PER_ACCOUNT` 是**业务上限**，它只能**调低**。
 *
 * 判据两条：
 *   1. 仓库里的服务端默认值（`.env.example` 与 `configuration.ts` 的兜底）**不大于**站位数量；
 *   2. 客户端不许再冒出第二份上限数字（那个数字一出现，这条关系就又回到「靠记性」了）。
 *
 * @returns `{ problems, capacity, defaults }`（后两个只用于成功时把实测值打出来）
 */
function findRoleLimitDrift() {
  const problems = [];
  const capacity = readRoleStandCapacity();
  const defaults = readServerRoleLimitDefaults();

  for (const { label, value } of defaults) {
    if (value > capacity) {
      problems.push(
        `${label} 的角色上限是 ${value}，超过了客户端选角界面的站位数量 ${capacity}（` +
          `${path.relative(ROOT, CLIENT_LAYOUT)} 的 roleSelectorLayout.rolePositions）—— ` +
          `调大了玩家能建出界面上没处放的角色。要么调回来，要么先去布局里加站位`,
      );
    }
  }

  const source = stripComments(fs.readFileSync(CLIENT_ROLE_CONFIG, "utf8"));
  const copy = /(?:export\s+)?const\s+(maxRoleCount|MAX_ROLE_COUNT|roleMaxPerAccount)\s*[:=]/.exec(source);
  if (copy) {
    problems.push(
      `${path.relative(ROOT, CLIENT_ROLE_CONFIG)}:${locate(source, copy.index)} 又定义了 ${copy[1]} —— ` +
        `客户端能画几个角色取决于 roleSelectorLayout.rolePositions（站位有几个就画几个），` +
        `业务上限在服务端，这里不该有第二个数字`,
    );
  }

  return { problems, capacity, defaults };
}

/**
 * 读「选角界面能画几个角色」= 站位数组的长度
 *
 * **编译后取真值**，不去源码里数 `new Vec2(`：站位数组将来可能由别的数组拼出来，
 * 数文本就会错。编译单元很小（布局只依赖 `cc` 与 `./images`），代价可以接受。
 */
function readRoleStandCapacity() {
  if (!fs.existsSync(CLIENT_LAYOUT)) {
    throw new Error(`找不到 ${path.relative(ROOT, CLIENT_LAYOUT)}（改名了？改了就来同步这条判据）`);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "olua-stands-"));
  const outdir = path.join(work, "out");

  // 布局 import 了 `cc`（Vec2 / Size / Color 都是在**运行时**构造的），给它一个最小垫片
  // （`gen-shared-data.cjs` 里那份的同款；放 out/node_modules 是为了让子目录里的 require 找得到）
  const shim = path.join(outdir, "node_modules", "cc");
  fs.mkdirSync(shim, { recursive: true });
  fs.writeFileSync(
    path.join(shim, "index.js"),
    "class Color { constructor(value) { this.value = value; } }\n" +
      "class Vec2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } }\n" +
      "class Size { constructor(width = 0, height = 0) { this.width = width; this.height = height; } }\n" +
      "module.exports = { Color, Vec2, Size };\n",
    "utf8",
  );
  fs.writeFileSync(path.join(shim, "package.json"), '{"name":"cc","version":"0.0.0","main":"index.js"}', "utf8");

  const tsconfig = path.join(work, "tsconfig.json");
  fs.writeFileSync(
    tsconfig,
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "CommonJS",
          moduleResolution: "node",
          outDir: outdir,
          rootDir: ASSETS,
          skipLibCheck: true,
          esModuleInterop: true,
          strict: false,
          noEmitOnError: false,
        },
        files: [CLIENT_LAYOUT],
      },
      null,
      2,
    ),
    "utf8",
  );

  runTsc(tsconfig, `选角布局编译不过（${path.relative(ROOT, CLIENT_LAYOUT)} 自己坏了）`, true);

  const layout = require(path.join(outdir, "configs", "layout", "scenes.js")).roleSelectorLayout;
  fs.rmSync(work, { recursive: true, force: true });

  const stands = layout?.rolePositions;
  if (!Array.isArray(stands) || stands.length === 0) {
    throw new Error(`roleSelectorLayout.rolePositions 不是非空数组（改结构了？改了就来同步这条判据）`);
  }
  return stands.length;
}

/**
 * 服务端那两处**提交在仓库里**的默认值
 *
 * 两处都要读：`.env.example` 是 `make env` 拷出来那份（部署照它改），
 * `configuration.ts` 的 `?? N` 是没配 `.env` 时的兜底。任一处调过站位数量，
 * 超限请求都会被真的放行，所以两处都是判据。
 *
 * 读不到就抛错（不是静默跳过）：这属于「上游换写法了」，必须有人来看一眼 ——
 * 静默跳过等于这条守卫悄悄失效。
 */
function readServerRoleLimitDefaults() {
  const out = [];

  const envSource = fs.readFileSync(ENV_EXAMPLE, "utf8");
  const envMatch = /^\s*ROLE_MAX_PER_ACCOUNT\s*=\s*(\d+)\s*$/m.exec(envSource);
  if (!envMatch) {
    throw new Error(`${path.relative(ROOT, ENV_EXAMPLE)} 里读不到 ROLE_MAX_PER_ACCOUNT（改名或删了？改了就来同步这条判据）`);
  }
  out.push({ label: path.relative(ROOT, ENV_EXAMPLE), value: Number(envMatch[1]) });

  const configSource = stripComments(fs.readFileSync(SERVER_CONFIG, "utf8"));
  const fallback = /roleMaxPerAccount\s*:\s*Number\(\s*process\.env\.ROLE_MAX_PER_ACCOUNT\s*\?\?\s*(\d+)\s*\)/.exec(
    configSource,
  );
  if (!fallback) {
    throw new Error(
      `${path.relative(ROOT, SERVER_CONFIG)} 里读不到 roleMaxPerAccount 的兜底值（改写过了？改了就来同步这条判据）`,
    );
  }
  out.push({ label: `${path.relative(ROOT, SERVER_CONFIG)} 兜底`, value: Number(fallback[1]) });

  return out;
}

const quote = (text) => `"${text}"`;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

main();
