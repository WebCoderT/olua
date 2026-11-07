#!/usr/bin/env node
/**
 * 升级卷轴（硬性 +1 级）回归单测（#787）
 *
 * 跑的是**真实配置表与真实索引函数**（configs-sandbox 编译 CommonJS + cc 垫片），
 * 数据来自 `server/data/config-sync.sql`（`factory-data.cjs` 读成快照 DTO 形状）——
 * 与线上进游戏后 `applyContentSnapshot` 落的是同一条路。
 *
 * 盯的不变量（改卷轴表 / 背包整理 / 使用链路后必须全绿）：
 * · 五张物品表（装备 / 药品 / 货币 / **卷轴** / 材料）都进了「id → 物品」总表，卷轴能被 getItem 解析
 * · 区间坏掉的行（下限 < 1、上限 < 下限）整条丢弃 —— 服务端会拒用，客户端也不该留幽灵道具
 * · 整表重建：快照里没有的行客户端就没有（运营删掉一卷，背包里那格就解析不出）
 * · 背包整理的大类顺序里卷轴排在货币之后、材料之前（「可使用的消耗品」定位一致）
 * · 使用链路接线：useGood 分发到 useLevelScroll → 本地预检区间（不在区间不发请求）→
 *   发 levelScrollUse（带 revision）→ **两层解包**（DTO 的 data 才是角色存档）→
 *   照服务端返回写回等级 / 血蓝上限 / 战斗力 / 背包 / revision；文案参数与服务端字段同名
 *
 * 用法：node client/tools/test-level-scroll.cjs
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");
/** 出厂值来源：快照（库里权威，快照是它的逐行投影） */
const factory = require("./lib/factory-data.cjs");

function main() {
  let outDir;
  try {
    outDir = prepare("olua-level-scroll");
  } catch (error) {
    fail(String(error.message ?? error));
    return;
  }

  const itemsMod = require(path.join(outDir, "configs/items.js"));
  const gameConfig = require(path.join(outDir, "configs/game-config.js"));
  const goodMod = require(path.join(outDir, "types/good.js"));
  const { getItem, getItemsByType, bagTidyTypeOrder } = itemsMod;
  const { isLevelScroll, isMoneyItem, isDrug, isEquipment, GOOD_TYPE } = goodMod;

  const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");
  const rows = factory.levelScrolls();

  //#region 一、出厂行都进得了物品总表

  console.log("=== 一、出厂行都进得了物品总表 ===");
  check(rows.length > 0, "快照里有升级卷轴（否则后面全是假绿）", `${rows.length} 条`);
  check(rows.length === 7, "出厂 7 卷（覆盖 1 ~ 6999 级）", `${rows.length} 条`);
  let resolved = 0;
  const unresolved = [];
  for (const row of rows) {
    const good = getItem(row.id);
    if (!good) {
      unresolved.push(`${row.id}(解析不出)`);
      continue;
    }
    if (!isLevelScroll(good)) {
      unresolved.push(`${row.id}(不是升级卷轴)`);
      continue;
    }
    if (Number(good.minLevel) !== Number(row.minLevel) || Number(good.maxLevel) !== Number(row.maxLevel)) {
      unresolved.push(`${row.id}(区间不对 ${good.minLevel}~${good.maxLevel})`);
      continue;
    }
    resolved += 1;
  }
  check(resolved === rows.length, "每条都能被 getItem 解析成升级卷轴，区间取自快照", unresolved.join("、"));

  const ordered = rows.slice().sort((a, b) => Number(a.minLevel) - Number(b.minLevel));
  let contiguous = true;
  for (let index = 1; index < ordered.length; index += 1) {
    // 出厂切法：上一卷用完的那一级正好是下一卷的起点（Lv1 1~999 → Lv2 1000~1999）
    if (Number(ordered[index].minLevel) !== Number(ordered[index - 1].maxLevel) + 1) contiguous = false;
  }
  check(contiguous, "区间首尾相接（上一卷用满那一级，正好是下一卷的起点）");
  checkEqualRange(ordered[0], { min: 1, max: 999 }, "Lv1 的区间是 1 ~ 999");

  const first = rows.find((row) => Number(row.minLevel) === 1) ?? rows[0];
  const firstGood = getItem(first.id);
  check(firstGood && firstGood.label === first.label, "名称取自库（客户端不另写一份）", `${firstGood && firstGood.label}`);
  check(firstGood && firstGood.icon === first.icon, "图标路径取自库（`item/scroll/...`）", `${firstGood && firstGood.icon}`);
  check(firstGood && firstGood.stackable === true, "升级卷轴可叠加（攒着一起用）");
  check(
    firstGood && Number(firstGood.maxStack) === Number(first.maxStack),
    "叠加上限跟着库里的 maxStack 走",
    `${firstGood && firstGood.maxStack} / ${first.maxStack}`,
  );
  check(
    rows.every((row) => String(row.icon).startsWith("item/scroll/")),
    "出厂图标的目录口径统一是 item/scroll/（素材放这里，见 client/RESOURCES.md）",
  );

  //#endregion

  //#region 二、大类与索引

  console.log("\n=== 二、大类与索引 ===");
  const byType = getItemsByType(GOOD_TYPE.SCROLL);
  check(byType.length === rows.length, "getItemsByType(scroll) 的条数与快照一致", `${byType.length} / ${rows.length}`);
  check(byType.every((good) => isLevelScroll(good)), "按大类取出来的都是升级卷轴");
  check(
    byType.every((good) => !isDrug(good) && !isEquipment(good) && !isMoneyItem(good)),
    "升级卷轴既不是装备 / 药品，也不是货币道具（四类互斥）",
  );
  check(GOOD_TYPE.SCROLL === "scroll", "大类常量与配置里的 type 字符串同值", GOOD_TYPE.SCROLL);
  const copy = getItem(first.id);
  copy.label = "改副本不该影响配置";
  check(getItem(first.id).label === first.label, "getItem 返回副本（改它不会污染配置表）");
  const tidyOrder = (type) => bagTidyTypeOrder.get(type);
  check(
    tidyOrder(GOOD_TYPE.MONEY) < tidyOrder(GOOD_TYPE.SCROLL) && tidyOrder(GOOD_TYPE.SCROLL) < tidyOrder(GOOD_TYPE.MATERIAL),
    "背包整理：卷轴排在货币之后、材料之前",
    `money=${tidyOrder(GOOD_TYPE.MONEY)} scroll=${tidyOrder(GOOD_TYPE.SCROLL)} material=${tidyOrder(GOOD_TYPE.MATERIAL)}`,
  );

  //#endregion

  //#region 三、坏数据被丢弃 / 整表重建

  console.log("\n=== 三、坏数据丢弃与整表重建 ===");
  const dirty = [
    { id: "level_scroll_bad_min", minLevel: 0, maxLevel: 100 },
    { id: "level_scroll_bad_order", minLevel: 900, maxLevel: 500 },
    { id: "", minLevel: 1, maxLevel: 999 },
    { id: "level_scroll_ok_row", minLevel: 100, maxLevel: 200 },
  ];
  gameConfig.applyLevelScrollData(dirty);
  const afterDirty = gameConfig.levelScrolls;
  check(
    afterDirty.length === 1 && afterDirty[0].id === "level_scroll_ok_row",
    "下限 < 1 / 上限 < 下限 / 没有 id 的行整条丢弃，只留合法那条",
    `${afterDirty.length} 条`,
  );
  const okRow = afterDirty[0];
  check(
    !!okRow && okRow.minLevel === 100 && okRow.maxLevel === 200,
    "保留下来的那行区间原样（不夹、不换算）",
    okRow && `${okRow.minLevel}~${okRow.maxLevel}`,
  );
  gameConfig.applyLevelScrollData([]);
  check(gameConfig.levelScrolls.length === 0, "整表重建：快照里一条都没有时客户端就是空的（不留上一版）");
  // 复原，后面的源码断言不依赖表内容
  gameConfig.applyLevelScrollData(rows);
  check(gameConfig.levelScrolls.length === rows.length, "重新落库能把整表还原回来");

  //#endregion

  //#region 四、使用链路的接线

  console.log("\n=== 四、使用链路接线（StorageManager + 快照顺序 + 文案）===");
  const storageSource = read("assets/ui/core/StorageManager.ts");
  const textsSource = read("assets/configs/texts.ts");
  const applySource = read("assets/configs/apply-snapshot.ts");
  check(/isLevelScroll\(good\)\)\s*return await this\.useLevelScroll\(row, col\)/.test(storageSource), "useGood 把升级卷轴分发到 useLevelScroll");
  check(/static async useLevelScroll\(row: number, col: number\)/.test(storageSource), "useLevelScroll 方法存在（签名与用药同一套坐标入参）");
  check(
    /if \(level < good\.minLevel \|\| level > good\.maxLevel\)/.test(storageSource),
    "本地预检区间：不在区间就**不发请求**，直接提示该换哪一卷",
  );
  check(
    /RoleApi\.levelScrollUse\(role\.id, \{ row, col, revision: role\.revision \}\)/.test(storageSource),
    "请求带 revision（乐观锁）且只报格子坐标 —— 等级与区间不往上报",
  );
  check(
    /const data = \(result\.data \?\? \{\}\) as Record<string, unknown>/.test(storageSource),
    "角色存档取 DTO 的 `data`（等级 / 血蓝 / bag 都在里面）",
  );
  check(
    /typeof result\.level === "number"\) role\.level = result\.level/.test(storageSource),
    "等级取 DTO **顶层**那一列（行上的 level 是唯一权威；存档里的 level 升级时不跟）",
  );
  check(
    ["maxHp", "maxMp", "hpRecover", "combat", "hp", "mp"].every((field) =>
      new RegExp(`typeof data\\.${field} === "number"\\) role\\.${field} = data\\.${field}`).test(storageSource),
    ),
    "血蓝上限 / 回复 / 战斗力 / 当前血蓝都照搬服务端（不本地自己算一遍）",
  );
  check(/Array\.isArray\(data\.bag\)\) role\.bag = data\.bag/.test(storageSource), "背包以服务端那份整体替换（格子扣减看得见）");
  check(/RoleUIManager\.refreshBag\(\)/.test(storageSource), "用完刷新背包（格子数量变了）");
  // 注释里也出现 `rebuildItemIndex()`，所以带分号匹配真正的调用语句（否则会匹配到上方的说明文字）
  check(
    applySource.indexOf("applyLevelScrollRows(snapshot.levelScrolls)") > 0 &&
      applySource.indexOf("applyLevelScrollRows(snapshot.levelScrolls)") < applySource.indexOf("rebuildItemIndex();"),
    "快照落库顺序：卷轴在 rebuildItemIndex 之前（否则物品总表里没有它）",
  );
  check(/key: "levelScrolls", label: "升级卷轴", kind: "array"/.test(read("assets/configs/game-config.ts")), "快照契约里登记了 levelScrolls 段（漏了会被契约校验抓到）");
  check(
    textsSource.includes("level_scroll_use_success_tip") &&
      textsSource.includes("level_scroll_use_invalid_tip") &&
      textsSource.includes("level_scroll_level_out_of_range_tip"),
    "三条提示文案都登记在 configs/texts（代码里不写中文）",
  );
  const successLine = textsSource.split("\n").find((line) => line.includes("level_scroll_use_success_tip")) ?? "";
  check(
    ["{name}", "{from}", "{level}"].every((token) => successLine.includes(token)),
    "成功文案的占位符与调用处传的参数一一对应",
    successLine.trim(),
  );
  const rangeLine = textsSource.split("\n").find((line) => line.includes("level_scroll_level_out_of_range_tip")) ?? "";
  check(
    ["{name}", "{min}", "{max}", "{level}"].every((token) => rangeLine.includes(token)),
    "「该换卷了」的文案把区间和当前等级都说出来",
    rangeLine.trim(),
  );

  //#endregion

  finish("PASS：升级卷轴（#787）");
}

/** 区间断言小工具（两次比较给两个标签，失败时只报那一条） */
function checkEqualRange(row, expected, label) {
  check(
    !!row && Number(row.minLevel) === expected.min && Number(row.maxLevel) === expected.max,
    label,
    row && `${row.minLevel}~${row.maxLevel}`,
  );
}

main();
