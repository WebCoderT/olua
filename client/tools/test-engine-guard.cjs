#!/usr/bin/env node
/**
 * 引擎兜底回归单测（#1184）
 *
 * 被测对象是**真实模块** `ui/utils/node/SiblingSortGuard.ts`（在沙箱里编译后 require，
 * 不复制一份逻辑）。`cc` 垫片提供最小形状：Node（name / parent / _children / _updateSiblingIndex /
 * emit）、isValid、UITransform（priorityChangeNodeMap / _sortChildrenSibling / _sortSiblings）
 * —— 语义照抄引擎 3.8.7 的 `_sortSiblings`（兜底就嵌在这条链上）：
 *
 *     priorityChangeNodeMap.forEach((node) => { _sortChildrenSibling(node); node._updateSiblingIndex();
 *                                               node.emit('childrenSiblingOrderChanged') })
 *     priorityChangeNodeMap.clear()
 *
 * 四条语义（缺一条这个兜底就变噪音源）：
 * 1. 活节点照常重排（不能因为兜底把正常排序也吞了）
 * 2. 已销毁节点（`_children` 已是 null，引擎 `_destruct` 的现场）跳过：不抛异常、不打扰同队列的其他节点
 *    （重排收尾那句 `childrenSiblingOrderChanged` 也吞掉，否则会撞已销毁的 `_eventProcessor`）
 * 3. 安装幂等：重复调用只包一层（不会出现「补丁套补丁」）
 * 4. 打印有上限：同一现场只报一次，且总数封顶（引擎 bug 的兜底日志不能刷屏）
 *
 * 用法：node client/tools/test-engine-guard.cjs
 */
const fs = require("fs");
const path = require("path");
const { prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const ASSETS = path.resolve(__dirname, "..", "assets");

/** 读一份 assets 下的源码（接线断言用） */
function readSrc(rel) {
  return fs.readFileSync(path.join(ASSETS, rel), "utf8");
}

/**
 * cc 垫片追加段：Node / UITransform / director / Director
 *
 * 注意：`_children` 是引擎内部字段（已销毁时为 null），不是公开的 `children` 数组 ——
 * 兜底的判据就是它，垫片必须同形。
 */
const CC_EXTRA = `
class Node {
  constructor(name = "") {
    this.name = name;
    this.parent = null;
    this._children = [];
    /** 是否已销毁（引擎里是 _objFlags 的 Destroyed 位；isValid 的判据） */
    this.destroyed = false;
    /** 收到 childrenSiblingOrderChanged 的次数（排序真的跑了才 +1） */
    this.orderChanged = 0;
  }
  emit(type) {
    if (this.destroyed) throw new Error("已销毁节点不应该收到 emit（_eventProcessor 已销毁）");
    if (type === "childrenSiblingOrderChanged") this.orderChanged += 1;
  }
  _updateSiblingIndex() {
    for (let i = 0; i < this._children.length; i += 1) this._children[i]._siblingIndex = i;
  }
}
class UITransform {
  static priorityChangeNodeMap = new Map();
  static sortedNodes = [];
  static _sortChildrenSibling(node) {
    UITransform.sortedNodes.push(node.name);
  }
  static _sortSiblings() {
    UITransform.priorityChangeNodeMap.forEach((node) => {
      UITransform._sortChildrenSibling(node);
      node._updateSiblingIndex();
      node.emit("childrenSiblingOrderChanged");
    });
    UITransform.priorityChangeNodeMap.clear();
  }
}
const director = {
  handlers: new Map(),
  on(event, fn) {
    const list = this.handlers.get(event) || [];
    list.push(fn);
    this.handlers.set(event, list);
  },
  off(event, fn) {
    const list = (this.handlers.get(event) || []).filter((item) => item !== fn);
    this.handlers.set(event, list);
  },
  emit(event) {
    for (const fn of [...(this.handlers.get(event) || [])]) fn();
  },
  listenerCount(event) {
    return (this.handlers.get(event) || []).length;
  },
};
class Director {
  static EVENT_AFTER_UPDATE = "after-update";
}
function isValid(target) {
  return !!target && !target.destroyed;
}
module.exports.Node = Node;
module.exports.isValid = isValid;
module.exports.UITransform = UITransform;
module.exports.director = director;
module.exports.Director = Director;
`;

function main() {
  let outDir;
  try {
    outDir = prepare("olua-engine-guard", ["ui/utils/node/SiblingSortGuard.ts"], CC_EXTRA);
  } catch (error) {
    fail(String(error.message ?? error));
    return;
  }

  const cc = require(path.join(path.dirname(outDir), "node_modules", "cc"));
  const { installSiblingSortGuard, resetSiblingSortGuardReports } = require(path.join(outDir, "ui/utils/node/SiblingSortGuard.js"));

  // 引擎在模块加载时已经把 _sortSiblings 注册成 AFTER_UPDATE 监听 —— 垫片里补一次同样的注册，
  // 复现「兜底装好之前引擎自己那一份已经在跑」这个真实前提
  cc.director.on(cc.Director.EVENT_AFTER_UPDATE, cc.UITransform._sortSiblings);

  console.log("\n=== 安装：幂等（监听仍只有引擎那一份，补丁包在 Node 方法上）===");
  installSiblingSortGuard();
  installSiblingSortGuard();
  check(cc.director.listenerCount(cc.Director.EVENT_AFTER_UPDATE) === 1, "AFTER_UPDATE 上仍只有一个监听（兜底不往 director 上叠东西）");

  console.log("\n=== 语义 1/2：活节点照常重排，已销毁节点跳过且不连累同队列 ===");
  const alive = new cc.Node("alive");
  const dead = new cc.Node("dead");
  // 引擎销毁现场：_destruct 把 _children 置 null，对象标记为已销毁
  dead._children = null;
  dead.destroyed = true;
  cc.UITransform.priorityChangeNodeMap.set("alive-id", alive);
  cc.UITransform.priorityChangeNodeMap.set("dead-id", dead);
  cc.UITransform.sortedNodes.length = 0;
  let threw = false;
  try {
    cc.director.emit(cc.Director.EVENT_AFTER_UPDATE);
  } catch (error) {
    threw = true;
  }
  check(!threw, "队列里混着已销毁节点时不抛异常（这就是修复的那个崩溃）");
  check(cc.UITransform.sortedNodes.includes("alive") && alive.orderChanged === 1, "活节点照常重排并收到 childrenSiblingOrderChanged");
  check(dead.orderChanged === 0, "已销毁节点没有参与重排");
  check(cc.UITransform.priorityChangeNodeMap.size === 0, "队列照常清空（不残留、下一帧不会再撞同一个节点）");

  console.log("\n=== 语义 2b：已销毁节点上的 emit 被吞掉（重排收尾不再撞 _eventProcessor）===");
  let emitThrew = false;
  try {
    dead.emit("childrenSiblingOrderChanged");
  } catch (error) {
    emitThrew = true;
  }
  check(!emitThrew, "直接对已销毁节点 emit 不抛异常（垫片里已销毁节点 emit 会主动抛，说明补丁真的拦住了）");

  console.log("\n=== 语义 4：打印有上限（不刷屏）===");
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    resetSiblingSortGuardReports();
    // 同一个现场反复出现：只该报一次
    for (let i = 0; i < 3; i += 1) {
      const node = new cc.Node("repeat");
      node._children = null;
      node.destroyed = true;
      cc.UITransform.priorityChangeNodeMap.set(`repeat-${i}`, node);
      cc.director.emit(cc.Director.EVENT_AFTER_UPDATE);
    }
    check(warnings.length === 1, `同一现场重复出现只报一次（实际 ${warnings.length} 条）`);
    // 不同的现场：最多报 REPORT_LIMIT（20）条
    for (let i = 0; i < 40; i += 1) {
      const node = new cc.Node(`distinct-${i}`);
      node._children = null;
      node.destroyed = true;
      cc.UITransform.priorityChangeNodeMap.set(`distinct-id-${i}`, node);
      cc.director.emit(cc.Director.EVENT_AFTER_UPDATE);
    }
    check(warnings.length <= 20, `打印总数封顶 20（实际 ${warnings.length} 条）`);
    check(warnings.every((text) => text.includes("[engine-guard]")), "日志带 [engine-guard] 前缀（控制台里能一眼认出是兜底）");
  } finally {
    console.warn = originalWarn;
  }

  console.log("\n=== 接线：两个入口场景都装了兜底 ===");
  const loading = readSrc("ui/Loading.ts");
  const game = readSrc("ui/Game.ts");
  check(/installSiblingSortGuard\(\)/.test(loading), "Loading.ts 模块顶层安装（正常进游戏的第一帧之前）");
  check(/installSiblingSortGuard\(\)/.test(game), "Game.ts 模块顶层安装（编辑器里单独跑 Game 场景也能兜住）");

  finish("PASS：已销毁节点不再让 AFTER_UPDATE 崩溃，活节点排序不受影响，兜底日志有上限。");
}

main();
