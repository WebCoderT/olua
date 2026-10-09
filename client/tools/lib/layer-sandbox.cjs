#!/usr/bin/env node
/**
 * 层级管理器单测的沙箱（目前 client/tools/test-dialog-top.cjs 用它）
 *
 * 与另两个沙箱的区别：
 * · configs-sandbox 只跑配置表（纯数据）；
 * · storage-sandbox 把 UI 依赖整体 stub 掉（它要跑的是数据层）；
 * · 这里要跑**真实的 ui/core/LayerManager**（弹窗清单与「点击置顶」都在它身上），所以：
 *   1. 把 LayerManager.ts 复制进沙箱，只把 `utils/input/UiHit`（命中检测，与层级无关）换成 stub；
 *   2. `cc` 垫片里最小实现 Node 的**兄弟序号语义**（addChild / removeChild / setSiblingIndex /
 *      getSiblingIndex / children / parent / destroy / isValid）—— 语义照抄引擎 3.8.7：
 *        setSiblingIndex: index = index >= 0 ? index : siblings.length + index;
 *                         oldIndex = siblings.indexOf(this);
 *                         if (index !== oldIndex) { splice(oldIndex,1); index < length ? splice(index,0,this) : push(this) }
 *      （引擎源码 cocos/scene-graph/node.ts）；渲染、事件、相机这些与层级无关的能力都不实现。
 *
 * 用法：
 *   const { prepareLayer } = require("./lib/layer-sandbox.cjs");
 *   const { LayerManager, Node, isValid } = prepareLayer("olua-dialog-top");
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { PROJECT_ROOT, findTsc } = require("./configs-sandbox.cjs");

const ASSETS = path.join(PROJECT_ROOT, "assets");

/** LayerManager 里与层级无关的 import → 沙箱内的 stub 模块（相对 src/ui/core/ 的路径） */
const STUB_IMPORTS = {
  "../utils/input/UiHit": "../../stubs/UiHit",
};

//#region cc 垫片（Node 的兄弟序号语义 + isValid）

const CC_SHIM = `/**
 * cc 运行时垫片（由 client/tools/lib/layer-sandbox.cjs 生成，请勿手改）
 * 只实现层级相关的最小行为：Node 的父子关系与兄弟序号（语义与引擎一致，见文件头说明）。
 */
class Node {
  constructor(name = "") {
    this.name = name;
    /** 子节点数组（引擎里也是 _children，这里直接用它当 children 的存储） */
    this.children = [];
    this.parent = null;
    this.layer = 0;
    /** 是否已销毁（isValid 的判据；引擎里是 _objFlags 的位判断） */
    this.destroyed = false;
  }
  addChild(child) {
    if (child.parent) child.parent.removeChild(child);
    child.parent = this;
    this.children.push(child);
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index === -1) return;
    this.children.splice(index, 1);
    child.parent = null;
  }
  removeFromParent() {
    if (this.parent) this.parent.removeChild(this);
  }
  getChildByName(name) {
    return this.children.find((child) => child.name === name) ?? null;
  }
  getSiblingIndex() {
    return this.parent ? this.parent.children.indexOf(this) : -1;
  }
  setSiblingIndex(index) {
    if (!this.parent) return;
    const siblings = this.parent.children;
    index = index >= 0 ? index : siblings.length + index;
    const oldIndex = siblings.indexOf(this);
    if (index === oldIndex) return;
    siblings.splice(oldIndex, 1);
    if (index < siblings.length) siblings.splice(index, 0, this);
    else siblings.push(this);
  }
  on() {}
  off() {}
  getComponent() {
    return null;
  }
  destroy() {
    this.destroyed = true;
    this.removeFromParent();
  }
}
Node.EventType = { CHILD_ADDED: "child-added" };
class Vec2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } }
class Vec3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } }
class Camera {}
function isValid(value) {
  return !!value && value.destroyed !== true;
}
module.exports = { Node, Vec2, Vec3, Camera, isValid };
`;

const STUBS = {
  "UiHit.ts": `/** 命中检测（与层级排序无关，单测里不需要真实实现） */
export function isPointOnUi(): boolean { return false; }
export function isPointOnWorldInteractive(): boolean { return false; }
`,
};

//#endregion

/**
 * 编译真实的 LayerManager（UI 依赖走 stub）并返回可 require 的模块
 * @param {string} sandboxName 沙箱目录名（os.tmpdir() 下）
 */
function prepareLayer(sandboxName) {
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

  // stub 模块
  for (const [file, source] of Object.entries(STUBS)) {
    const target = path.join(srcDir, "stubs", file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }

  // 真实代码：LayerManager（把与层级无关的 import 换掉）
  const layerSource = fs.readFileSync(path.join(ASSETS, "ui/core/LayerManager.ts"), "utf8");
  let rewritten = layerSource;
  for (const [specifier, replacement] of Object.entries(STUB_IMPORTS)) {
    rewritten = rewritten.split(`from "${specifier}"`).join(`from "${replacement}"`);
  }
  fs.mkdirSync(path.join(srcDir, "ui/core"), { recursive: true });
  fs.writeFileSync(path.join(srcDir, "ui/core/LayerManager.ts"), rewritten);

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
          baseUrl: PROJECT_ROOT,
          paths: { cc: [path.join(PROJECT_ROOT, "temp/declarations/cc.d.ts")] },
          types: [],
        },
        files: [path.join(srcDir, "ui/core/LayerManager.ts")],
      },
      null,
      2,
    ),
  );

  const result = spawnSync(process.execPath, [tscPath, "-p", path.join(sandbox, "tsconfig.json")], { encoding: "utf8" });
  const moduleFile = path.join(outDir, "ui/core/LayerManager.js");
  if (!fs.existsSync(moduleFile)) {
    console.error(`${result.stdout || ""}${result.stderr || ""}`);
    throw new Error(`LayerManager 编译失败（tsc 退出码 ${result.status}，且没有产物）`);
  }

  const layerModule = require(moduleFile);
  const cc = require(path.join(sandbox, "node_modules/cc/index.js"));
  return { LayerManager: layerModule.default ?? layerModule, Layer: layerModule.Layer, ...cc };
}

module.exports = { prepareLayer, STUB_IMPORTS, CC_SHIM };
