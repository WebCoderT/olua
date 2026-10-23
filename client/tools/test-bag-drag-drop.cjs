// 背包拖动落子回归（issue #193）
//
// 根因：Cocos 3.8.7 的 touch 通道里，TOUCH_START 命中的节点独占整段触摸，而引擎派发
// TOUCH_END 前会对「认领节点自身」再做一次命中测试（node-event-processor._handleTouchEnd），
// 松手点不在认领节点上时事件被改判成 TOUCH_CANCEL。拖到别的格子上松手，起点格收到的
// 恰恰是 CANCEL —— 只把落子挂在 TOUCH_END、把 CANCEL 当取消的话，物品永远拖不动。
//
// 手势本身（节点事件派发）无法在 Node 沙箱里复现，这里按项目先例做两层断言：
// 1) 数据层真实行为：moveBagCellGrid 的移动/合并/交换（借 configs-sandbox 跑真实 configs）；
// 2) 手势接线：读源码静态断言 END 与 CANCEL 接到同一个落子收尾，CANCEL 不再是裸 endDrag。

const fs = require("fs");
const path = require("path");
const { prepare } = require("./lib/configs-sandbox.cjs");

const ROOT = path.join(__dirname, "..");
let passed = 0;
let failed = 0;

function check(ok, label) {
  if (ok) {
    passed++;
    console.log(`✅ ${label}`);
  } else {
    failed++;
    console.log(`❌ ${label}`);
  }
}

function finish(summary) {
  console.log(`\n${summary}`);
  console.log(`通过 ${passed} 条，失败 ${failed} 条`);
  if (failed > 0) process.exit(1);
}

function readSrc(rel) {
  return fs.readFileSync(path.join(ROOT, "assets", rel), "utf8");
}

/** 抓取类成员方法体（从方法签名行起，到下一个同级 JSDoc/成员或类结尾前的平衡大括号） */
function extractMethod(src, signature) {
  const start = src.indexOf(signature);
  if (start === -1) return null;
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

function main() {
  console.log("=== 数据层：moveBagCellGrid 移动/合并/交换（真实配置）===");
  const outDir = prepare("olua-bag-drag-drop", ["configs/items.ts"]);
  const { moveBagCellGrid } = require(path.join(outDir, "configs/items.js"));

  // 造一个 2×3 背包：A 在 (0,0)，B 在 (1,2)（同种可叠加 ×2 与 ×3）
  const mk = (id, count) => ({ id, count });
  const bag = [
    [mk("drug_hp_1", 2), null, null],
    [null, null, mk("drug_hp_1", 3)],
  ];
  
  // 移动到空格
  const moved = moveBagCellGrid(bag, { row: 0, col: 0 }, { row: 0, col: 2 });
  check(moved && moved.moved && moved.bag[0][2]?.id === "drug_hp_1" && !moved.bag[0][0], "拖到空格 = 移动（源格清空、目标格落位）");

  // 同种可叠加 = 合并
  const merged = moveBagCellGrid(moved.bag, { row: 0, col: 2 }, { row: 1, col: 2 });
  check(merged && merged.moved && merged.bag[1][2]?.count === 5 && !merged.bag[0][2], "拖到同种可叠加格 = 合并（2+3=5、源格清空）");

  // 其余 = 交换（装备不可叠加；拿装备去换药格）
  const swapBag = [[mk("drug_hp_1", 2), null], [null, mk("weapon_1", 1)]];
  const swapped = moveBagCellGrid(swapBag, { row: 0, col: 0 }, { row: 1, col: 1 });
  check(
    swapped && swapped.moved && swapped.bag[1][1]?.id === "drug_hp_1" && swapped.bag[0][0]?.id === "weapon_1",
    "拖到占用的不可叠加格 = 交换（两格互换）",
  );

  // 越界 / 同格 / 空源 = 不动
  check(!moveBagCellGrid(bag, { row: 0, col: 0 }, { row: 9, col: 9 })?.moved, "越界落点不移动");
  check(!moveBagCellGrid(bag, { row: 0, col: 0 }, { row: 0, col: 0 })?.moved, "拖回原格不移动");
  check(!moveBagCellGrid(bag, { row: 0, col: 1 }, { row: 0, col: 0 })?.moved, "空格起拖不移动");

  console.log("\n=== 手势接线：END 与 CANCEL 共用落子收尾（读源码静态断言）===");
  const gridSrc = readSrc("ui/components/panel/BagGridView.ts");
  const refreshBody = extractMethod(gridSrc, "refresh(role: Role)");
  check(!!refreshBody, "BagGridView.refresh 存在");
  check(
    !!refreshBody && /TOUCH_END, \(event: EventTouch\) => this\.onCellTouchEnd\(event\)/.test(refreshBody),
    "TOUCH_END 接到落子收尾 onCellTouchEnd",
  );
  check(
    !!refreshBody && /TOUCH_CANCEL, \(event: EventTouch\) => this\.onCellTouchEnd\(event\)/.test(refreshBody),
    "TOUCH_CANCEL 也接到同一个落子收尾（引擎把「松手在起点格外」改判成 CANCEL，#193）",
  );
  check(!/TOUCH_CANCEL, \(\) => this\.endDrag\(\)/.test(gridSrc), "CANCEL 不再是裸 endDrag（那会让拖动永不落子）");
  check(
    /_handleTouchEnd/.test(gridSrc) && /TOUCH_CANCEL/.test(gridSrc),
    "类注释记录了引擎改判行为（node-event-processor._handleTouchEnd），防止后人改回去",
  );
  const endBody = extractMethod(gridSrc, "onCellTouchEnd(event: EventTouch)");
  check(!!endBody && /StorageManager\.moveBagGood\(/.test(endBody), "收尾内调用 StorageManager.moveBagGood 落子");
  check(
    !!endBody && /isOutsideDropArea\(point\)/.test(endBody),
    "收尾保留「拖出弹窗 = 丢弃确认」的优先判定",
  );
  check(
    !!endBody && /hitCell\(point\)/.test(endBody) && /drag\.target/.test(endBody),
    "落点以松手点为准（命中检测 + 拖动中最后落点兜底）",
  );

  finish("PASS：数据层搬运规则真实可用，手势 END/CANCEL 共用落子收尾、引擎改判行为已记录在案。");
}

main();
