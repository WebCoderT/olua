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

module.exports = { ROOT, ASSETS, createWork, compileClientConfig, configLoader, cleanupWork };
