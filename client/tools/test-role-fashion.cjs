#!/usr/bin/env node
/**
 * 时装收权 · 客户端接线守点（#596）
 *
 * 服务端侧的购买 / 穿脱 / 独占清单语义由 server/test/e2e-role-fashion.cjs 钉死；
 * 这里只钉客户端的**接线**：
 * · 购买 / 穿脱必须走服务端接口（RoleApi.fashionBuy / fashionWear），成功才改本地
 * · 拥有清单只读 role.fashionsOwned（独占字段，本地不造）
 * · 衣柜卡片按获取渠道分流：可购买显示价格并接购买，未开放置灰
 * · roleUpdate 帧带回的时装字段要落本地档（换设备云同步）
 *
 * 用法：先 `make client-config-compile`（或 make client-check，会顺带编译），再 node 本文件
 */
const fs = require("fs");
const path = require("path");

let passed = 0;
const failures = [];

function check(condition, label, extra) {
  if (condition) {
    passed += 1;
    console.log(`  [OK] ${label}`);
    return true;
  }
  failures.push(extra === undefined ? label : `${label}（实际：${extra}）`);
  console.log(`  [!!] ${failures[failures.length - 1]}`);
  return false;
}

const root = path.join(__dirname, "..");

const storageSource = fs.readFileSync(path.join(root, "assets/ui/core/StorageManager.ts"), "utf8");
const dialogSource = fs.readFileSync(path.join(root, "assets/ui/components/dialogs/FashionDialog.ts"), "utf8");
const layoutSource = fs.readFileSync(path.join(root, "assets/configs/layout/dialogs.ts"), "utf8");
const apiSource = fs.readFileSync(path.join(root, "assets/ui/utils/net/Api.ts"), "utf8");
const channelSource = fs.readFileSync(path.join(root, "assets/ui/utils/net/CombatChannel.ts"), "utf8");
const configSource = fs.readFileSync(path.join(root, "assets/configs/game-config.ts"), "utf8");

console.log("— 购买 / 穿脱走服务端（StorageManager）—");
check(/RoleApi\.fashionBuy\(role\.id/.test(storageSource), "buyFashion 调用 RoleApi.fashionBuy（扣费与清单在服务端）");
check(/RoleApi\.fashionWear\(role\.id/.test(storageSource), "wearFashion / unwearFashion 走 RoleApi.fashionWear");
check(/result\.owned/.test(storageSource) && /result\.bindGold/.test(storageSource), "购买后照搬服务端返回的清单与余额");
check(/ownsFashion/.test(storageSource) && /const owned = this\.findOnlineRole\(\)\?\.fashionsOwned/.test(storageSource), "拥有判断只读 role.fashionsOwned（独占字段）");

console.log("— 衣柜按渠道分流（FashionDialog）—");
check(/acquireChannel === "upgrade"/.test(dialogSource), "可购买分支认 upgrade 渠道");
check(/stateText\.buyable/.test(dialogSource) && /\{price\}/.test(layoutSource), "可购买卡片显示价格（{price} 占位）");
check(/stateText\.locked/.test(dialogSource) && /lockedTint/.test(layoutSource), "未开放卡片置灰（lockedTint / locked 文案）");
check(/StorageManager\.buyFashion\(fashion\.id\)/.test(dialogSource), "点卡片购买接到 StorageManager.buyFashion");
check(/ok && this\.refresh\(\)/.test(dialogSource.replace(/\s+/g, " ")), "购买 / 穿脱成功后才整批刷新（失败不动卡片）");

console.log("— 帧云同步（roleUpdate 带回时装）—");
check(/fashionCloth\?:/.test(channelSource) && /fashionsOwned\?:/.test(channelSource), "RoleAuthorityUpdate 带时装字段");
check(/update\.fashionCloth !== undefined/.test(storageSource) && /Array\.isArray\(update\.fashionsOwned\)/.test(storageSource), "applyServerRoleUpdate 落账时装字段");
check(/fashionChanged\) this\.applyFashionChange\(role\)/.test(storageSource), "穿着态变化走 applyFashionChange（换外观不换数值）");

console.log("— 渠道进配置（game-config）—");
check(/acquireChannel: string/.test(configSource) && /FashionSeedLike/.test(configSource), "FashionDataEntry 带 acquireChannel（快照整表重建）");
check(/fashionBuy: \(id: string/.test(apiSource) && /fashionWear: \(id: string/.test(apiSource), "RoleApi.fashionBuy / fashionWear 已由 gen-api 生成");

console.log("");
if (failures.length === 0) {
  console.log(`PASS：时装收权客户端接线（共 ${passed} 条断言）`);
  process.exit(0);
}
console.log(`FAIL：${failures.length} 条断言未通过（通过 ${passed} 条）`);
process.exit(1);
