#!/usr/bin/env node
/**
 * 装备对齐器 · 自检脚本
 *
 * 不开浏览器也能回归工具的核心链路（解析与写回是唯二会破坏项目文件的环节）：
 *   1. 解析自检：用 index.html 里的同一份解析代码读真实 configs，
 *      验证装备条目数、方向顺序、动作帧长与帧号公式。
 *   2. 往返一致：把全部装备的当前值导出成 offsets.json，再走 apply-offsets.cjs 写回
 *      一份临时副本 —— 结果必须与源文件**逐字节相同**（解析口径与写回格式完全对齐）。
 *   3. 改值写回：对一件装备写入与现状不同的值，确认 diff 只落在该装备的 outPositions/outScale。
 *
 * 用法：node equip-aligner/selfcheck.cjs
 * 退出码 0 = 全部通过。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

const TOOL_DIR = __dirname;
const ROOT = path.resolve(TOOL_DIR, "..");

let failed = 0;
function check(name, condition, detail) {
  const ok = !!condition;
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail && !ok ? `（${detail}）` : ""}`);
}

/** 从 index.html 里原样抽出第 1~5 节（扫描工具 / 状态 / 图片 / 配置解析 / 取值口径）在 vm 里执行 */
function loadAlignerCore() {
  const html = fs.readFileSync(path.join(TOOL_DIR, "index.html"), "utf8");
  const start = html.indexOf("/* ---------------------------- 1. 源码扫描工具");
  const end = html.indexOf("/* ---------------------------- 6. 修改与持久化");
  if (start < 0 || end < 0) throw new Error("index.html 的代码分区定位失败（分区注释被改过？）");
  const code = html.slice(start, end);
  let result = null;
  const sandbox = {
    console, require, process, Promise, Map, Set, Array, Object, Number, String, Boolean,
    Math, JSON, Date, RegExp, Error, isNaN, parseInt, parseFloat,
    Image: function Image() {},
    print: (data) => { result = data; },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${code}
function setStatus(){}
function requestDraw(){}
fetchText = async function (p) { return require("fs").readFileSync(${JSON.stringify(ROOT)} + "/" + p, "utf8"); };
__run();
async function __run(){
  const ok = await loadConfig();
  const entries = {};
  state.entries.forEach((entry) => {
    entries[entry.key] = { label: entry.label, out: entry.out, outScale: entry.outScale, outPositions: entry.outPositions };
  });
  state.action = state.actionValues.STAND || "stand";
  state.directionIndex = state.directions.indexOf("down");
  state.frameIndex = 0;
  print({ ok, entries, directions: state.directions, slots: state.slots, frameLengths: state.frameLengths, frameNo: currentFrameNo(), defaultClothOut: state.defaultClothOut });
}`, sandbox, { filename: "aligner-core.js" });
  // __run 是异步的（fetchText 读文件也要等微任务），轮询等结果
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (result) { resolve(result); return; }
      if (Date.now() - started > 5000) { reject(new Error("解析超时（5s）")); return; }
      setTimeout(poll, 20);
    };
    setTimeout(poll, 20);
  });
}

async function main() {
  console.log(`项目根：${ROOT}`);

  console.log("\n[1/3] 解析自检（index.html 的解析代码 × 真实 configs）");
  const core = await loadAlignerCore();
  check("configs 载入成功", core && core.ok);
  const keys = Object.keys(core.entries);
  check("装备条目 37 件（基础件）", keys.length === 37, `实际 ${keys.length}`);
  check("方向顺序 8 项且首项 up", core.directions.length === 8 && core.directions[0] === "up", core.directions.join(","));
  check("帧号公式 stand/down#0 = 32", core.frameNo === 32, `实际 ${core.frameNo}`);
  check("站立案每方向 8 帧", core.frameLengths.stand === 8);
  check("受伤案每方向 2 帧", core.frameLengths.injured === 2);
  const withOut = keys.filter((key) => core.entries[key].out);
  const posOk = keys.every((key) => core.entries[key].outPositions.length === 8);
  check("全部条目 outPositions 补齐 8 项", posOk);
  console.log(`    （${withOut.length} 件有外观素材，默认外观目录 ${core.defaultClothOut}）`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aligner-selfcheck-"));
  try {
    console.log("\n[2/3] 往返一致（全量导出 → 写回临时副本 → 逐字节比较）");
    const source = fs.readFileSync(path.join(ROOT, "assets/configs/equipments.ts"), "utf8");
    const payload = { tool: "olua-equip-aligner", version: 1, directions: core.directions, entries: core.entries };
    const jsonPath = path.join(tmp, "offsets.json");
    fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");
    const copy = path.join(tmp, "equipments.roundtrip.ts");
    fs.writeFileSync(copy, source, "utf8");
    const out = execFileSync("node", [path.join(TOOL_DIR, "apply-offsets.cjs"), jsonPath, "--file", copy], { cwd: ROOT, encoding: "utf8" });
    check("写回脚本正常退出", !out.includes("✗"));
    check("全部条目判定「无变化」", (out.match(/（无变化）/g) || []).length === keys.length, "有条目被误改");
    check("写回结果与源文件逐字节相同", fs.readFileSync(copy, "utf8") === source);

    console.log("\n[3/3] 改值写回（cloth_1 改成 8 向不同 + 缩放 1.2）");
    const changed = JSON.parse(JSON.stringify(payload));
    const positions = [[1, 2], [1, 2], [3, 4], [1, 2], [1, 2], [1, 2], [1, 2], [5, 6]];
    changed.entries = {
      cloth_1: { label: "", out: "clothes/out/005", outScale: 1.2, outPositions: positions },
    };
    const changedPath = path.join(tmp, "offsets-changed.json");
    fs.writeFileSync(changedPath, JSON.stringify(changed, null, 2), "utf8");
    const copy2 = path.join(tmp, "equipments.changed.ts");
    fs.writeFileSync(copy2, source, "utf8");
    execFileSync("node", [path.join(TOOL_DIR, "apply-offsets.cjs"), changedPath, "--file", copy2], { cwd: ROOT, encoding: "utf8" });
    const after = fs.readFileSync(copy2, "utf8");
    check("cloth_1 的 outPositions 已替换", after.includes("new Vec2(1, 2), // up") && after.includes("new Vec2(5, 6), // left_up"));
    check("cloth_1 的 outScale 已替换", after.includes("outScale: 1.2"));
    check("只改了 1 个方向块 + 1 个缩放（其余条目不动）", (after.match(/new Vec2\(1, 2\)/g) || []).length === 6 && (after.match(/outScale: 1\.2/g) || []).length === 1);
    const removed = after.split("cloth_1").length - 1;
    check("条目数不变", removed === source.split("cloth_1").length - 1, `写回后 cloth_1 出现 ${removed} 次`);

    console.log(`\n${failed ? "✗ 有失败项" : "✓ 全部通过"}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
