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
    counts = inspectExports();
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
}

/**
 * 把生成物编译成 JS 再逐表数条目
 *
 * 这个编译单元**没有** Cocos 依赖（生成物本身不含引擎类型），所以任何 error TS 都是真错误 ——
 * 与 `audit-combat-parity.cjs` 那边要挑错码不同，这里一律当失败。
 *
 * @returns 形如 `["ROLE_LEVEL_ATTRIBUTES=60", …]`
 */
function inspectExports() {
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

  const tsc = path.join(ROOT, "server", "node_modules", ".bin", "tsc");
  if (!fs.existsSync(tsc)) throw new Error(`找不到 tsc：${tsc}（先在 server/ 下装依赖）`);

  let log = "";
  try {
    log = execFileSync(tsc, ["-p", tsconfig], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    log = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  const fatal = log.split("\n").filter((line) => line.includes("error TS"));
  if (fatal.length > 0) {
    throw new Error(`生成物编译不过（${path.relative(ROOT, GENERATED)} 自己坏了）：\n  ${fatal.slice(0, 3).join("\n  ")}`);
  }

  const mod = require(path.join(outdir, "shared", "game-data.generated.js"));

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

  fs.rmSync(work, { recursive: true, force: true });
  return counts;
}

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

main();
