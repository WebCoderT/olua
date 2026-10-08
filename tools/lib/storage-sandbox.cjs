#!/usr/bin/env node
/**
 * 存储层单测的共用沙箱（目前 tools/test-role-delete.cjs 用它）
 *
 * 与 configs-sandbox.cjs 的区别：那个只编译**配置表**（纯数据），这个要编译 **StorageManager**
 * —— 它是核心代码，import 了 UI 层（GameUiHelper / LayerManager / RoleUIManager …），
 * 直接编译会把整个界面层拉进来（还要过 cc 的 Node / Sprite / Label 声明），在 node 里跑不起来。
 *
 * 做法：
 * 1. 把 StorageManager.ts 连同它**真正需要**的部分（entities/Role + configs + types）复制到沙箱，
 *    configs 目录整份复制但只编译被 import 链摸到的文件（tsc 从入口顺着 import 走，不编译无关文件）；
 * 2. import 到 UI 层的那几行按 STUB_IMPORTS 改写成 stub 模块 —— 于是能在 node 里
 *    require **真实的 StorageManager** 跑断言，而不是复刻一份存储逻辑；
 * 3. `cc` 垫片在这个沙箱里额外提供 `sys.localStorage`（内存实现），存档读写因此真实发生。
 *
 * 用法：
 *   const { prepareStorage } = require("./lib/storage-sandbox.cjs");
 *   const { StorageManager, createRole } = prepareStorage("olua-role-delete");
 *
 * tsc 探测规则与 configs-sandbox 相同（环境变量 TSC → 工程 node_modules → Cocos 自带）。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { PROJECT_ROOT, findTsc } = require("./configs-sandbox.cjs");

const ASSETS = path.join(PROJECT_ROOT, "assets");

/**
 * StorageManager 里指向 UI / 环依赖的 import → 沙箱内的 stub 模块（相对 src/ui/core/ 的路径）
 * 加一条 = 让更多真代码进沙箱（前提是它不 import cc 的界面类）；删一条 = 还原成真实模块
 */
const STUB_IMPORTS = {
  "./RoleUIManager": "../../stubs/RoleUIManager",
  "./SceneManager": "../../stubs/SceneManager",
  "./SkillManager": "../../stubs/SkillManager",
  "./GameHelper": "../../stubs/GameHelper",
  "./LayerManager": "../../stubs/LayerManager",
  "../helpers/GameUiHelper": "../../stubs/GameUiHelper",
  // 角色落盘会写穿服务端（见 ui/utils/net）：同步请求与场景/飘字无关，
  // 这里顶成「记账式」替身 —— 只记下安排过同步，真语义由 tools/test-client-net.cjs 验证
  "../utils/net/RoleSync": "../../stubs/RoleSync",
  "../utils/net/Session": "../../stubs/Session",
  // configs/skill 会 import skills/zhan → ui/core/*（配置反向依赖 UI 的历史遗留），必须顶掉
  "../../configs/skill": "../../stubs/configs-skill",
};

//#region cc 垫片（比配置层多一个 sys.localStorage，存档读写走内存）

const CC_SHIM = `/**
 * cc 运行时垫片（由 tools/lib/storage-sandbox.cjs 生成，请勿手改）
 * Vec2 / Vec3 / Size / Color：配置表的数据构造需要；
 * sys.localStorage：StorageManager 的存档读写需要（内存实现，随进程结束丢弃）。
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
const memory = new Map();
const sys = {
  localStorage: {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => { memory.set(key, String(value)); },
    removeItem: (key) => { memory.delete(key); },
    clear: () => { memory.clear(); },
  },
};
module.exports = { Vec2, Vec3, Size, Color, sys, __memory: memory };
`;

//#endregion

//#region stub 模块（只保留 StorageManager 真正调用到的成员，签名对齐即可）

const STUBS = {
  "RoleUIManager.ts": `export default class RoleUIManager {
  static updateRoleData(_role: unknown): void {}
  static refreshBag(): void {}
  static updateRoleOutShow(_role: unknown): void {}
  static updateEquipmentDialog(_slot: unknown): void {}
  static updateShortcutIcon(_key: unknown, _icon?: unknown, _onClick?: unknown, _skillId?: unknown): void {}
}
`,
  "SceneManager.ts": `export default class SceneManager {
  static loadScene(_name: string): void {}
}
`,
  "SkillManager.ts": `export default class SkillManager {
  static release(_skillId: unknown): boolean { return false; }
}
`,
  "GameHelper.ts": `export default class GameHelper {
  static combatCalc(_role: unknown): any { return {}; }
  static getEquipmentRejectReason(_equipment: unknown): any { return null; }
  static getMapEnterRejectReason(_mapId: unknown): any { return null; }
}
`,
  "LayerManager.ts": `export default class LayerManager {
  static addToUILayer(_node: unknown): void {}
}
`,
  "GameUiHelper.ts": `export default class GameUiHelper {
  static createTip(_key: string, _params?: unknown): void {}
  static createErrorTip(_key: string, _params?: unknown): void {}
  static createUpgradeEffect(): unknown { return null; }
}
`,
  "RoleSync.ts": `/** 替身：只记下「安排过同步」，防抖/静默/失败提示的真语义见 tools/test-client-net.cjs */
export default class RoleSync {
  static onFailed: unknown = null;
  /** 依次记录被安排同步的角色（测试据此断言接线，不依赖真实请求） */
  static scheduled: unknown[] = [];
  static schedule(role: unknown): void { this.scheduled.push(role); }
  static async flush(): Promise<void> {}
}
`,
  "Session.ts": `/** 替身：只记下 clear 次数（会话的真实读写见 tools/test-client-net.cjs） */
export default class Session {
  static cleared = 0;
  static clear(): void { this.cleared += 1; }
}
`,
  "configs-skill.ts": `export const skills = new Map<string, any>();
`,
};

//#endregion

/**
 * 复制文件，可选地改写它的 import 指向
 * @param {string} from 源文件绝对路径
 * @param {string} to 目标文件绝对路径
 * @param {boolean} rewriteStubs 是否把 UI 依赖改写为 stub（只有 StorageManager.ts 需要）
 */
function copy(from, to, rewriteStubs = false) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  let source = fs.readFileSync(from, "utf8");
  if (rewriteStubs) {
    for (const [specifier, replacement] of Object.entries(STUB_IMPORTS)) {
      source = source.split(`from "${specifier}"`).join(`from "${replacement}"`);
    }
  }
  fs.writeFileSync(to, source);
}

/** 整目录复制（只带 .ts，跳过 .meta —— 沙箱不需要资源元数据） */
function copyDir(fromDir, toDir) {
  for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
    if (entry.name.endsWith(".meta")) continue;
    const from = path.join(fromDir, entry.name);
    const to = path.join(toDir, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.name.endsWith(".ts")) copy(from, to);
  }
}

/**
 * 编译 StorageManager（真实代码，UI 依赖走 stub）并返回可 require 的模块
 * @param {string} sandboxName 沙箱目录名（os.tmpdir() 下）
 * @param {string[]} extraEntries 额外的入口文件（相对 assets/，例如 "ui/core/SkillManager.ts"）
 * @returns {{ StorageManager: any, Role: any, outDir: string, shim: any, RoleSync: any, Session: any }}
 */
function prepareStorage(sandboxName, extraEntries = []) {
  const tscPath = findTsc();
  if (!tscPath) throw new Error("找不到 tsc（可用环境变量 TSC 指定）");

  const sandbox = path.join(os.tmpdir(), sandboxName);
  const srcDir = path.join(sandbox, "src");
  const outDir = path.join(sandbox, "out");
  fs.rmSync(sandbox, { recursive: true, force: true });

  // cc 垫片（node_modules 解析，与工程里的 "cc" 同名）
  fs.mkdirSync(path.join(sandbox, "node_modules/cc"), { recursive: true });
  fs.writeFileSync(path.join(sandbox, "node_modules/cc/index.js"), CC_SHIM);
  fs.writeFileSync(path.join(sandbox, "node_modules/cc/package.json"), JSON.stringify({ name: "cc", main: "index.js" }, null, 2));

  // stub 模块
  for (const [file, source] of Object.entries(STUBS)) {
    const target = path.join(srcDir, "stubs", file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }

  // 真实代码：configs / types 整份复制（只编译被摸到的），entities + StorageManager 按需
  copyDir(path.join(ASSETS, "configs"), path.join(srcDir, "configs"));
  copyDir(path.join(ASSETS, "types"), path.join(srcDir, "types"));
  copy(path.join(ASSETS, "entities/Role.ts"), path.join(srcDir, "entities/Role.ts"));
  copy(path.join(ASSETS, "ui/utils/battle/MpHelper.ts"), path.join(srcDir, "ui/utils/battle/MpHelper.ts"));
  copy(path.join(ASSETS, "ui/core/StorageManager.ts"), path.join(srcDir, "ui/core/StorageManager.ts"), true);

  const entries = [path.join(srcDir, "ui/core/StorageManager.ts"), ...extraEntries.map((rel) => path.join(srcDir, rel))];
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
          rootDir: srcDir,
          outDir,
          baseUrl: PROJECT_ROOT,
          // 类型仍用工程声明（只影响编译期），运行期走上面的垫片
          paths: { cc: [path.join(PROJECT_ROOT, "temp/declarations/cc.d.ts")] },
          types: [],
        },
        files: entries,
      },
      null,
      2,
    ),
  );

  const result = spawnSync(process.execPath, [tscPath, "-p", path.join(sandbox, "tsconfig.json")], { encoding: "utf8" });
  // 编译期报错不一定致命（stub 签名与真实模块可能有差异），但要把输出透出来，避免静默跑空
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  const moduleFile = path.join(outDir, "ui/core/StorageManager.js");
  if (!fs.existsSync(moduleFile)) {
    console.error(output);
    throw new Error(`StorageManager 编译失败（tsc 退出码 ${result.status}，且没有产物）`);
  }
  const errors = output.split("\n").filter((line) => /error TS\d+/.test(line));
  if (errors.length) {
    console.log(`  [note] 编译期有 ${errors.length} 条类型提示（stub 签名差异，不影响运行）：`);
    errors.slice(0, 5).forEach((line) => console.log(`         ${line}`));
  }

  const storageModule = require(moduleFile);
  const StorageManager = storageModule.default ?? storageModule;
  const Role = require(path.join(outDir, "entities/Role.js")).Role ?? require(path.join(outDir, "entities/Role.js")).default;
  // 垫片内存（测试用它直接核对 localStorage 里到底写了什么，而不是从业务接口倒推）
  const shim = require(path.join(sandbox, "node_modules/cc/index.js"));
  // 网络层替身（测试可断言「落盘是否安排了同步 / 清存档是否连带清会话」这类接线）
  const stubOf = (name) => {
    const mod = require(path.join(outDir, `stubs/${name}.js`));
    return mod.default ?? mod;
  };
  return { StorageManager, Role, outDir, shim, RoleSync: stubOf("RoleSync"), Session: stubOf("Session") };
}

module.exports = { prepareStorage, STUB_IMPORTS, STUBS, CC_SHIM };
