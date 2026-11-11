#!/usr/bin/env node
/**
 * 货币道具（绑定元宝，唯一货币）回归单测（#785；#843/#844 收敛后只有 bindGold 一种）
 *
 * 跑的是**真实配置表与真实索引函数**（configs-sandbox 编译 CommonJS + cc 垫片），
 * 数据来自 `server/data/config-sync.sql`（`factory-data.cjs` 读成快照 DTO 形状）——
 * 与线上进游戏后 `applyContentSnapshot` 落的是同一条路。
 *
 * 盯的不变量（改物品表 / 背包整理 / 使用链路后必须全绿）：
 * · 三张物品表（装备 / 药品 / **货币** / 材料）都进了「id → 物品」总表，货币道具能被 getItem 解析
 * · 币种只认 bindGold —— 库里冒出别的值（含 legacy gold / silver）就整条丢掉（不往一个不存在的账本字段上写钱）
 * · 整表重建：快照里没有的行客户端就没有（运营删掉一条面值，背包里那格就解析不出）
 * · 背包整理的大类顺序里货币排在药品之后、材料之前（与「可使用的消耗品」定位一致）
 * · 使用链路接线：useGood 分发到 useMoneyItem → 发 moneyUse（带 revision）→
 *   照服务端返回写回**对应那一个**账本字段 + 背包 + revision；文案参数与服务端字段同名
 *
 * 用法：node client/tools/test-money-item.cjs
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");
/** 出厂值来源：快照（库里权威，快照是它的逐行投影） */
const factory = require("./lib/factory-data.cjs");

function main() {
  let outDir;
  try {
    outDir = prepare("olua-money-item");
  } catch (error) {
    fail(String(error.message ?? error));
    return;
  }

  const itemsMod = require(path.join(outDir, "configs/items.js"));
  const gameConfig = require(path.join(outDir, "configs/game-config.js"));
  const goodMod = require(path.join(outDir, "types/good.js"));
  const { getItem, getItemsByType, bagTidyTypeOrder, MONEY_CURRENCY_LABELS } = itemsMod;
  const { isMoneyItem, isDrug, isEquipment, GOOD_TYPE } = goodMod;

  const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");
  const rows = factory.moneyItems();

  //#region 一、出厂行都进得了物品总表

  console.log("=== 一、出厂行都进得了物品总表 ===");
  check(rows.length > 0, "快照里有货币道具（否则后面全是假绿）", `${rows.length} 条`);
  check(rows.length === 8, "出厂唯一货币 bindGold × 8 档面值 = 8 条", `${rows.length} 条`);
  let resolved = 0;
  const unresolved = [];
  for (const row of rows) {
    const good = getItem(row.id);
    if (!good) {
      unresolved.push(`${row.id}(解析不出)`);
      continue;
    }
    if (!isMoneyItem(good)) {
      unresolved.push(`${row.id}(不是货币道具)`);
      continue;
    }
    if (good.currency !== row.currency || Number(good.amount) !== Number(row.amount)) {
      unresolved.push(`${row.id}(币种/面值不对)`);
      continue;
    }
    resolved += 1;
  }
  check(resolved === rows.length, "每条都能被 getItem 解析成货币道具，币种与面值取自快照", unresolved.join("、"));
  const first = rows[0];
  const firstGood = getItem(first.id);
  check(firstGood && firstGood.label === first.label, "名称取自库（客户端不另写一份）", `${firstGood && firstGood.label}`);
  check(firstGood && firstGood.icon === first.icon, "图标路径取自库（`item/currency/...`）", `${firstGood && firstGood.icon}`);
  check(firstGood && firstGood.stackable === true, "货币道具可叠加（不占格子）");
  check(
    firstGood && Number(firstGood.maxStack) === Number(first.maxStack),
    "叠加上限跟着库里的 maxStack 走",
    `${firstGood && firstGood.maxStack} / ${first.maxStack}`,
  );
  check(
    rows.every((row) => String(row.icon).startsWith("item/currency/")),
    "出厂图标的目录口径统一是 item/currency/（素材放这里，见 client/RESOURCES.md）",
  );

  //#endregion

  //#region 二、大类与索引

  console.log("\n=== 二、大类与索引 ===");
  const byType = getItemsByType(GOOD_TYPE.MONEY);
  check(byType.length === rows.length, "getItemsByType(money) 的条数与快照一致", `${byType.length} / ${rows.length}`);
  check(byType.every((good) => isMoneyItem(good)), "按大类取出来的都是货币道具");
  check(byType.every((good) => !isDrug(good) && !isEquipment(good)), "货币道具既不是装备也不是药品（三类互斥）");
  const copy = getItem(first.id);
  copy.label = "改副本不该影响配置";
  check(getItem(first.id).label === first.label, "getItem 返回副本（改它不会污染配置表）");
  check(
    MONEY_CURRENCY_LABELS.bindGold === "绑定元宝",
    "货币的中文名与界面文案一致（收敛后只有绑定元宝一种）",
  );
  const tidyOrder = (type) => bagTidyTypeOrder.get(type);
  check(
    tidyOrder(GOOD_TYPE.DRUG) < tidyOrder(GOOD_TYPE.MONEY) && tidyOrder(GOOD_TYPE.MONEY) < tidyOrder(GOOD_TYPE.MATERIAL),
    "背包整理：货币排在药品之后、材料之前",
    `drug=${tidyOrder(GOOD_TYPE.DRUG)} money=${tidyOrder(GOOD_TYPE.MONEY)} material=${tidyOrder(GOOD_TYPE.MATERIAL)}`,
  );

  //#endregion

  //#region 三、坏数据被丢弃 / 整表重建

  console.log("\n=== 三、坏数据丢弃与整表重建 ===");
  const dirty = [
    { id: "money_bad_currency", currency: "diamond", amount: 100 },
    { id: "", currency: "bindGold", amount: 100 },
    { id: "money_legacy_gold", currency: "gold", amount: 5 },
    { id: "money_legacy_silver", currency: "silver", amount: 5 },
    { id: "money_ok_row", currency: "bindGold", amount: 5 },
  ];
  gameConfig.applyMoneyItemData(dirty);
  const afterDirty = gameConfig.moneyItems;
  check(afterDirty.length === 1 && afterDirty[0].id === "money_ok_row", "币种不在取值域内（含 legacy gold / silver）/ 没有 id 的行整条丢弃，只留合法那条", `${afterDirty.length} 条`);
  gameConfig.applyMoneyItemData([]);
  check(gameConfig.moneyItems.length === 0, "整表重建：快照里一条都没有时客户端就是空的（不留上一版）");
  // 复原，后面的源码断言不依赖表内容
  gameConfig.applyMoneyItemData(rows);
  check(gameConfig.moneyItems.length === rows.length, "重新落库能把整表还原回来");

  //#endregion

  //#region 四、使用链路的接线

  console.log("\n=== 四、使用链路接线（StorageManager + 文案）===");
  const storageSource = read("assets/ui/core/StorageManager.ts");
  const textsSource = read("assets/configs/texts.ts");
  check(/isMoneyItem\(good\)\)\s*return await this\.useMoneyItem\(row, col\)/.test(storageSource), "useGood 把货币道具分发到 useMoneyItem");
  check(/static async useMoneyItem\(row: number, col: number\)/.test(storageSource), "useMoneyItem 方法存在（签名与用药同一套坐标入参）");
  check(/RoleApi\.moneyUse\(role\.id, \{ row, col, revision: role\.revision \}\)/.test(storageSource), "请求带 revision（乐观锁）且只报格子坐标 —— 金额与币种不往上报");
  check(
    /if \(currency === "bindGold"\)/.test(storageSource) && /role\[currency\] = Number/.test(storageSource),
    "按服务端返回的 currency 写回**对应那一个**账本字段（收敛后唯一 bindGold）",
  );
  check(/RoleUIManager\.refreshBag\(\)/.test(storageSource), "用完刷新背包（格子数量变了）");
  check(textsSource.includes("money_use_success_tip") && textsSource.includes("money_use_invalid_tip"), "两条提示文案都登记在 configs/texts（代码里不写中文）");
  const successLine = textsSource.split("\n").find((line) => line.includes("money_use_success_tip")) ?? "";
  check(
    ["{name}", "{amount}", "{currency}", "{balance}"].every((token) => successLine.includes(token)),
    "成功文案的占位符与调用处传的参数一一对应",
    successLine.trim(),
  );

  //#endregion

  finish("PASS：货币道具（#785）");
}

main();
