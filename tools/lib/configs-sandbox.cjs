#!/usr/bin/env node
/**
 * 配置层单测的共用沙箱（tools/test-bag-*.cjs 都用它，改这里即可让所有配置层单测跟着变）
 *
 * 做法：把 `assets/configs/items.ts`（连同它依赖的 equipments / drug / material / growth / role / types）
 * 编译成 CommonJS 到临时目录，再用一个只实现 `Vec2` / `Vec3` / `Size` / `Color` 的 `cc` 垫片顶替引擎 ——
 * 配置表只用到这四个纯数据类，没有任何引擎行为，于是 node 里就能直接 require **真实的配置表与真实函数**
 * 跑断言（不是复刻一份逻辑）。
 *
 * 用法：
 *   const { prepare } = require("./lib/configs-sandbox.cjs");
 *   const outDir = prepare("olua-bag-tidy");  // 沙箱目录名，各脚本取不同的名字互不干扰
 *   const { tidyBagGrid } = require(path.join(outDir, "configs/items.js"));
 *
 * tsc 自动探测（工程里不必装 typescript，Cocos 自带的就够用）：
 *   环境变量 TSC → 工程 node_modules → /Applications/Cocos/Creator/<版本>/…/typescript/bin/tsc
 * 手动指定：TSC=/path/to/tsc node tools/test-bag-tidy.cjs
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

//#region cc 垫片（只给 node 跑 configs 用：四个纯数据类，构造 + 读字段）

const CC_SHIM = `/**
 * cc 运行时垫片（由 tools/lib/configs-sandbox.cjs 生成，请勿手改）
 * assets/configs 只用 Vec2 / Vec3 / Size / Color 做数据构造，没有任何引擎行为，最小实现即可。
 * Color 要能吃 new Color(255,255,255) 与 new Color("#DDDDDD") 两种写法（配置表两种都用）。
 */
class Vec2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } }
class Vec3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } }
class Size { constructor(width = 0, height = 0) { this.width = width; this.height = height; } }
class Color {
  constructor(r = 255, g = 255, b = 255, a = 255) {
    if (typeof r === "string") { this.hex = r; this.r = 0; this.g = 0; this.b = 0; this.a = 255; return; }
    this.r = r; this.g = g; this.b = b; this.a = a;
  }
}
Color.WHITE = new Color(255, 255, 255, 255);
Color.BLACK = new Color(0, 0, 0, 255);
module.exports = { Vec2, Vec3, Size, Color };
`;

//#endregion

//#region 找 tsc

function findTsc() {
  const candidates = [process.env.TSC, path.join(PROJECT_ROOT, "node_modules/typescript/bin/tsc")];
  // Cocos Creator 各版本自带的 typescript
  for (const creatorRoot of ["/Applications/Cocos/Creator", "/Applications/CocosCreator"]) {
    if (!fs.existsSync(creatorRoot)) continue;
    for (const version of fs.readdirSync(creatorRoot)) {
      const base = path.join(creatorRoot, version, "CocosCreator.app/Contents/Resources/app.asar.unpacked/node_modules/typescript/bin");
      candidates.push(path.join(base, "tsc"), path.join(base, "tsc.js"));
    }
  }
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) ?? null;
}

//#endregion

/**
 * 编译配置表并返回产物目录（同一进程内重复调用同一名字会重建沙箱）
 * @param {string} sandboxName 沙箱目录名（os.tmpdir() 下），各脚本互不干扰
 * @returns {string} CommonJS 产物目录（里面有 configs/items.js 等）
 */
function prepare(sandboxName) {
  const tscPath = findTsc();
  if (!tscPath) {
    console.error("找不到 tsc：请在工程里装 typescript，或用环境变量指定，例如");
    console.error("  TSC=/Applications/Cocos/Creator/3.8.7/CocosCreator.app/Contents/Resources/app.asar.unpacked/node_modules/typescript/bin/tsc node tools/test-bag-tidy.cjs");
    throw new Error("缺少 tsc");
  }
  console.log(`tsc: ${tscPath}`);

  const sandbox = path.join(os.tmpdir(), sandboxName);
  const outDir = path.join(sandbox, "out");
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(path.join(sandbox, "node_modules/cc"), { recursive: true });
  fs.writeFileSync(path.join(sandbox, "node_modules/cc/index.js"), CC_SHIM);
  fs.writeFileSync(path.join(sandbox, "node_modules/cc/package.json"), JSON.stringify({ name: "cc", main: "index.js" }, null, 2));
  fs.writeFileSync(
    path.join(sandbox, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2019",
          module: "CommonJS",
          moduleResolution: "node",
          strict: false,
          skipLibCheck: true,
          esModuleInterop: true,
          experimentalDecorators: true,
          noEmitOnError: false,
          rootDir: path.join(PROJECT_ROOT, "assets"),
          outDir,
          baseUrl: PROJECT_ROOT,
          // 类型仍用工程自己的声明（只影响编译期），运行期走上面的垫片
          paths: { cc: [path.join(PROJECT_ROOT, "temp/declarations/cc.d.ts")] },
          types: [],
        },
        files: [path.join(PROJECT_ROOT, "assets/configs/items.ts")],
      },
      null,
      2,
    ),
  );
  const result = spawnSync(process.execPath, [tscPath, "-p", path.join(sandbox, "tsconfig.json")], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(result.stdout || "");
    console.error(result.stderr || "");
    throw new Error(`配置表编译失败（tsc 退出码 ${result.status}）`);
  }
  return outDir;
}

//#region 断言小工具（各脚本共用，打印风格一致）

let failed = 0;

function check(ok, label, detail = "") {
  if (ok) console.log(`  [OK] ${label}${detail ? " —— " + detail : ""}`);
  else {
    failed++;
    console.log(`  [!!] ${label}${detail ? " —— " + detail : ""}`);
  }
}

/** 末尾统一收口：打印总结，有失败项时把退出码置 1 */
function finish(passMessage) {
  if (failed) {
    console.log(`\n!! 有 ${failed} 项断言不通过`);
    process.exitCode = 1;
    return false;
  }
  console.log(`\n${passMessage}`);
  return true;
}

/** 前置检查失败（例如找不到 tsc）时用：直接结束并置失败退出码 */
function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

//#endregion

module.exports = { PROJECT_ROOT, findTsc, prepare, check, finish, fail };
