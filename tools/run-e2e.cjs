#!/usr/bin/env node
/**
 * 服务端 e2e 运行器（全量 / 分片）
 *
 * ===========================================================================
 * 为什么要有这个（而不是在 Makefile 里列 26 个 target）
 * ===========================================================================
 * 门禁清单靠人维护就会漂：`server/package.json` 有 29 个 `test:e2e*` 脚本，
 * 而 Makefile 里硬编码的 `make ci` 只列了 26 个 —— `e2e-admin-mail` /
 * `e2e-mail-expiry` / `e2e-ui-effect` 三套**从来没在 CI 跑过**，谁也没发现，
 * 因为「清单少一行」和「清单是对的」在输出里长得一模一样。
 *
 * 现在唯一来源是 `server/package.json`：加了 `test:e2e:xxx` 脚本就自动进 CI，
 * 不需要再来改这里或 Makefile。**扫到 0 套直接报错**（宁可红，不许假绿）。
 *
 * ===========================================================================
 * 分片（按耗时装箱，不是平均切）
 * ===========================================================================
 * 套件的耗时差一个数量级（backup 52s vs map 7s），按个数均分会出现「一片 2 分钟、
 * 三片半分钟」—— 墙钟时间等于最慢那片，等于没并行。所以这里按 WEIGHT 做贪心装箱：
 * 重的先放、每次丢给当前最轻的一片。
 *
 * WEIGHT 只是**相对档位**（本机实测 max/7s 取整），作用仅限于均衡：
 *   - 没登记的套件按 1 算 —— 新增脚本照样会被分到某一片，**不需要来登记**
 *   - 登记错了最坏只是某片慢几秒，不会漏跑（覆盖由清单决定，与权重无关）
 *
 * ===========================================================================
 * 用法
 * ===========================================================================
 *   node tools/run-e2e.cjs              全部套件串行跑（本机 `make ci` 用）
 *   node tools/run-e2e.cjs --shard=0/4  只跑第 0 片（CI 的矩阵 job 用）
 *   node tools/run-e2e.cjs --list       只打印清单与装箱结果，不执行
 *
 * 退出码：全过 = 0；有一套失败 = 1（停在该套，余下的不跑 —— 修好再重跑）。
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SERVER = path.join(ROOT, "server");

// 受限终端注入的 NODE_OPTIONS 会让 node 子进程静默起不来（e2e 等启动超时）—— 摘掉
delete process.env.NODE_OPTIONS;

//#region 套件清单

/**
 * 相对耗时档位（本机实测 2026-11-03，基准 ≈ 7s = 1 档）
 *
 * 只用于分片均衡，不参与「跑哪些」的决定。想加档位就加，忘了加也只是薄厚不均。
 */
const WEIGHT = {
  "test:e2e:backup": 7,
  "test:e2e:guard": 6,
  "test:e2e:mail": 5,
  "test:e2e:combat": 5,
  "test:e2e:party": 4,
  "test:e2e:realtime": 4,
  "test:e2e:achievement": 2,
  "test:e2e:world": 2,
  "test:e2e:dual": 2,
  "test:e2e:chat": 2,
  "test:e2e:rank": 2,
  "test:e2e:quest": 2,
  // 两张图各起一次世界、三段区域施放中间都要等群体技能的冷却（1.3s × 3）
  "test:e2e:area-skill": 3,
  // 三组共 18 刀，每刀前都要先 PATCH 一次技能行（写库 + 刷快照），刀数不多但来回多
  "test:e2e:crit": 3,
  // 撞飞端点四轮 PATCH + 等级闸两次等怪物 TTL + 群体段两次冷却，来回偏多
  "test:e2e:push": 3,
  // 六段各要等一次「怪的下一次出手」（9001 冷却 6 秒）+ 三处 3 秒级观测窗 + 五次 PATCH
  "test:e2e:status": 10,
  // 起一次实时连接 + 三刀（每刀前按真客户端冷却等 1.1 秒）+ 两次技能 PATCH 与两次 1.2 秒 TTL 等待
  "test:e2e:skill-upgrade": 4,
  // 泡点升级要等经验节拍（1 秒一拍）+ 建号后把点数一一点进一项 + 两次重启（存量补发幂等）
  "test:e2e:attr-points": 5,
  // 纯 HTTP：五格播种 + 十来次穿戴/卸下 + 十次配置 PATCH（每次都要重装结算层）
  "test:e2e:equip-rules": 2,
  // 一条实时连接 + 十几次 pos 帧（每帧等一个 50ms 广播节拍）+ 七次配置 PATCH + 一处 700ms 等待
  "test:e2e:map-movement": 2,
  // 一条实时连接 + 六次寻路（每次留 150ms 防刷间隔与一次回执）+ 一次格参数 PATCH
  "test:e2e:map-path": 2,
};

function weightOf(script) {
  return WEIGHT[script] ?? 1;
}

/** 全部 e2e 套件（脚本名，如 `test:e2e:map`），按名字排序 —— 稳定，切片才可复现 */
function allSuites() {
  const pkg = JSON.parse(fs.readFileSync(path.join(SERVER, "package.json"), "utf8"));
  return Object.keys(pkg.scripts)
    .filter((key) => /^test:e2e(:|$)/.test(key))
    .sort();
}

/**
 * 贪心装箱：重的先放，每次丢进当前最轻的一片
 *
 * 返回第 `shard` 片的套件（重的在前 —— fail-fast 时先撞上慢的那套，早死早超生）。
 */
function shardOf(suites, shard, total) {
  const order = [...suites].sort((a, b) => weightOf(b) - weightOf(a) || a.localeCompare(b));
  const bins = Array.from({ length: total }, () => ({ load: 0, items: [] }));
  for (const script of order) {
    let target = bins[0];
    for (const bin of bins) if (bin.load < target.load) target = bin;
    target.items.push(script);
    target.load += weightOf(script);
  }
  return bins[shard].items;
}

//#endregion

//#region 参数

function parseArgs(argv) {
  const options = { shard: 0, total: 1, list: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--list") {
      options.list = true;
      continue;
    }
    const shardMatch = arg.match(/^--shard=(\d+)\/(\d+)$/);
    if (shardMatch) {
      options.shard = Number(shardMatch[1]);
      options.total = Number(shardMatch[2]);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log("用法：node tools/run-e2e.cjs [--shard=i/N] [--list]");
      process.exit(0);
    }
    console.error(`未知参数：${arg}`);
    console.error("用法：node tools/run-e2e.cjs [--shard=i/N] [--list]");
    process.exit(2);
  }
  if (!Number.isInteger(options.total) || options.total < 1) {
    console.error("分片总数必须 ≥ 1");
    process.exit(2);
  }
  if (!Number.isInteger(options.shard) || options.shard < 0 || options.shard >= options.total) {
    console.error(`分片下标必须在 0 ~ ${options.total - 1} 之间`);
    process.exit(2);
  }
  return options;
}

//#endregion

//#region 执行

function runSuite(script) {
  const started = Date.now();
  // 每套自己起服务、自己收尾；stdio 直通，失败时日志原样留在 CI 输出里
  const result = spawnSync("npm", ["run", script], { cwd: SERVER, stdio: "inherit" });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  return { ok: result.status === 0, seconds };
}

function main() {
  const options = parseArgs(process.argv);
  const suites = allSuites();

  // 扫到 0 套一定是路径/清单写错了 —— 不许当成「没什么要跑」悄悄过
  if (suites.length === 0) {
    console.error("✗ server/package.json 里没有 test:e2e* 脚本 —— 清单来源不对，中止（不当作通过）");
    process.exit(1);
  }

  const mine = shardOf(suites, options.shard, options.total);
  const scope =
    options.total === 1
      ? `全部 ${suites.length} 套`
      : `第 ${options.shard}/${options.total} 片 · 本片 ${mine.length} 套 / 共 ${suites.length} 套`;

  console.log(`==> 服务端 e2e —— ${scope}`);
  for (const script of mine) console.log(`    ${script}`);

  if (options.list) return;

  if (mine.length === 0) {
    console.log("  本片没有分配到套件（片数多于套件数），视为通过");
    return;
  }

  console.log("");
  const failed = [];
  for (const script of mine) {
    console.log(`\n==> ${script}`);
    const { ok, seconds } = runSuite(script);
    if (ok) {
      console.log(`  ✓ ${script}（${seconds}s）`);
      continue;
    }
    failed.push(script);
    console.error(`  ✗ ${script}（${seconds}s）`);
    break; // fail-fast：一套红了先修，余下的重跑时自然会跑到
  }

  if (failed.length > 0) {
    const skipped = mine.slice(mine.indexOf(failed[0]) + 1);
    if (skipped.length > 0) console.error(`\n  未跑（失败后跳过）：${skipped.join("、")}`);
    console.error(`\n✗ e2e 失败：${failed.join("、")} —— ${scope}`);
    process.exit(1);
  }

  console.log(`\n✓ e2e 全过：${mine.length} 套 —— ${scope}`);
}

main();

//#endregion
