#!/usr/bin/env node
/**
 * 客户端网络层单测的沙箱（tools/test-client-net.cjs 用它）
 *
 * 跑的是**真实**请求层：assets/ui/utils/net/{ApiRoutes,ApiError,Session,HttpClient,Api,RoleSync}.ts
 * 与 configs/{network,texts}.ts、types/common.ts 一起复制进沙箱编译，只换掉两个与游戏世界的耦合点：
 *
 * 1. `entities/Role`（在 RoleSync 里只当类型用）→ 空壳 stub，
 *    避免把 configs/equipments 那条重依赖链拖进来（那与请求语义无关）；
 * 2. `cc` 垫片只给 `sys.localStorage`（内存 Map，语义照引擎：getItem / setItem / removeItem / clear），
 *    因为 Session 用它存令牌。
 *
 * `XMLHttpRequest` **刻意不垫**：由测试自己注入，好逐条断言发出去的 url / 请求头 / body。
 *
 * 用法：
 *   const { prepareNet } = require("./lib/net-sandbox.cjs");
 *   const net = prepareNet("olua-client-net");
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { PROJECT_ROOT, findTsc } = require("./configs-sandbox.cjs");

const ASSETS = path.join(PROJECT_ROOT, "assets");

/** 需要编进沙箱的真实文件（相对 assets/） */
const FILES = [
  "configs/network.ts",
  "configs/texts.ts",
  "types/common.ts",
  "ui/utils/net/ApiRoutes.ts",
  "ui/utils/net/ApiModels.ts",
  "ui/utils/net/ApiCodes.ts",
  "ui/utils/net/ApiError.ts",
  "ui/utils/net/Session.ts",
  "ui/utils/net/HttpClient.ts",
  "ui/utils/net/Api.ts",
  "ui/utils/net/RoleSync.ts",
];

/** 真实 import → 沙箱内的替身模块（键相对 ui/utils/net/） */
const STUB_IMPORTS = {
  "../../../entities/Role": "../../stubs/Role",
};

//#region cc 垫片（只要 sys.localStorage）

const CC_SHIM = `/**
 * cc 运行时垫片（由 tools/lib/net-sandbox.cjs 生成，请勿手改）
 * 网络层只用到 sys.localStorage（Session 存令牌），其余能力一概不实现。
 */
const store = new Map();
const sys = {
  localStorage: {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  },
  /** 测试用：直接拿到底层 Map（清场用） */
  __store: store,
};
module.exports = { sys };
`;

/** 替身模块源码 */
const STUBS = {
  "Role.ts": `/** 替身：Role 在 RoleSync 里只当类型用（真实类会拖进 configs/equipments 那条依赖链） */
export class Role {}
`,
};

//#endregion

/** 取模块的默认导出（编译成 CommonJS 后是 exports.default） */
function pick(module) {
  return module && module.default !== undefined ? module.default : module;
}

/**
 * 编译真实的网络层并返回可 require 的模块集合
 * @param {string} sandboxName 沙箱目录名（os.tmpdir() 下）
 */
function prepareNet(sandboxName) {
  const tscPath = findTsc();
  if (!tscPath) throw new Error("找不到 tsc（可用环境变量 TSC 指定）");

  const sandbox = path.join(os.tmpdir(), sandboxName);
  const srcDir = path.join(sandbox, "src");
  const outDir = path.join(sandbox, "out");
  fs.rmSync(sandbox, { recursive: true, force: true });

  // cc 垫片
  fs.mkdirSync(path.join(sandbox, "node_modules/cc"), { recursive: true });
  fs.writeFileSync(path.join(sandbox, "node_modules/cc/index.js"), CC_SHIM);
  fs.writeFileSync(path.join(sandbox, "node_modules/cc/package.json"), JSON.stringify({ name: "cc", main: "index.js" }, null, 2));

  // 替身模块
  for (const [file, source] of Object.entries(STUBS)) {
    const target = path.join(srcDir, "stubs", file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }

  // 真实代码（把与请求语义无关的 import 换成替身）
  const copied = [];
  for (const rel of FILES) {
    const source = fs.readFileSync(path.join(ASSETS, rel), "utf8");
    let rewritten = source;
    if (rel.startsWith("ui/utils/net/")) {
      for (const [specifier, replacement] of Object.entries(STUB_IMPORTS)) {
        rewritten = rewritten.split(`from "${specifier}"`).join(`from "${replacement}"`);
      }
    }
    const target = path.join(srcDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, rewritten);
    copied.push(target);
  }

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
          noEmitOnError: false,
          rootDir: srcDir,
          outDir,
          types: [],
        },
        files: copied,
      },
      null,
      2,
    ),
  );

  const result = spawnSync(process.execPath, [tscPath, "-p", path.join(sandbox, "tsconfig.json")], { encoding: "utf8" });
  const moduleFile = path.join(outDir, "ui/utils/net/HttpClient.js");
  if (!fs.existsSync(moduleFile)) {
    console.error(`${result.stdout || ""}${result.stderr || ""}`);
    throw new Error(`网络层编译失败（tsc 退出码 ${result.status}，且没有产物）`);
  }

  const load = (rel) => require(path.join(outDir, rel));
  const network = load("configs/network.js");
  const routes = load("ui/utils/net/ApiRoutes.js");
  const codes = load("ui/utils/net/ApiCodes.js");
  const errors = load("ui/utils/net/ApiError.js");
  return {
    sandbox,
    /** 真实配置（测试可以改 roleSyncDelay 之类的值：as const 只是类型层面的约束） */
    networkConfig: network.networkConfig,
    HttpClient: pick(load("ui/utils/net/HttpClient.js")),
    ApiError: pick(errors),
    ApiErrorKind: errors.ApiErrorKind,
    describeError: errors.describeError,
    Session: pick(load("ui/utils/net/Session.js")),
    Api: load("ui/utils/net/Api.js"),
    /** 生成物：服务端 DTO 的镜像 */
    ApiModels: load("ui/utils/net/ApiModels.js"),
    RoleSync: pick(load("ui/utils/net/RoleSync.js")),
    ApiRoutes: routes.ApiRoutes,
    /** 请求层常量（OpenAPI 表达不了，手写在 ApiCodes） */
    ApiErrorTextKey: codes.ApiErrorTextKey,
    RELOGIN_BIZ_CODES: codes.RELOGIN_BIZ_CODES,
    /** 角色同步要特殊处理的业务码（乐观锁冲突 / 角色不存在） */
    ROLE_SYNC_BIZ_CODES: codes.ROLE_SYNC_BIZ_CODES,
    /** 真实的 getText（断言兜底文案时比对，避免测试里写死中文） */
    getText: load("configs/texts.js").getText,
    /** cc 垫片（测试用 __store 清场） */
    sys: require(path.join(sandbox, "node_modules/cc/index.js")).sys,
    /** 是否编译期有诊断（信息用） */
    diagnostics: `${result.stdout || ""}${result.stderr || ""}`.trim(),
  };
}

module.exports = { prepareNet, FILES, STUB_IMPORTS, CC_SHIM };
