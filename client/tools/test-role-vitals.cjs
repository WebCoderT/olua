#!/usr/bin/env node
/**
 * 血蓝收权 · 客户端接线守点（#596）
 *
 * 服务端侧的结算语义由 server/test/e2e-role-vitals.cjs 钉死；这里只钉客户端的**接线**：
 * · 复活必须走服务端接口（RoleApi.revive），成功后才起身，失败保持死亡弹窗可重试
 * · reviveRole 不再本地把血改满（`role.hp = role.maxHp` 的复活路径已删）
 * · 失败提示文案存在（revive_failed_tip）
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

const gameSource = fs.readFileSync(path.join(root, "assets/ui/Game.ts"), "utf8");
const textsSource = fs.readFileSync(path.join(root, "assets/configs/texts.ts"), "utf8");
const apiSource = fs.readFileSync(path.join(root, "assets/ui/utils/net/Api.ts"), "utf8");

console.log("— 复活走服务端（Game.reviveRole）—");
check(/RoleApi\.revive\(role\.id\)/.test(gameSource), "reviveRole 调用 RoleApi.revive（满血由服务端落账）");
check(/current\.hp = result\.hp/.test(gameSource) && /current\.mp = result\.mp/.test(gameSource), "复活后照搬服务端返回的血蓝");
check(/revive_failed_tip/.test(gameSource), "失败时提示复活失败（保持死亡弹窗可重试）");
check(/deathDialog\?\.destroy\(\);\s*\n\s*this\.deathDialog = null;/.test(gameSource.replace(/\r/g, "")), "成功路径才销毁死亡弹窗");
// 本地满血路径必须已经不在 reviveRole 里（血蓝收权后客户端不再自己决定满血）
const reviveRoleBody = gameSource.slice(gameSource.indexOf("private reviveRole"), gameSource.indexOf("private reviveRole") + 1800);
check(!/role\.hp = role\.maxHp/.test(reviveRoleBody), "reviveRole 里不再有本地满血（role.hp = role.maxHp）");

console.log("— 文案与生成接口 —");
check(/revive_failed_tip:\s*"/.test(textsSource), "texts.ts 登记 revive_failed_tip");
check(/revive: \(id: string/.test(apiSource), "RoleApi.revive 已由 gen-api 生成");

console.log("");
if (failures.length === 0) {
  console.log(`PASS：血蓝收权客户端接线（共 ${passed} 条断言）`);
  process.exit(0);
}
console.log(`FAIL：${failures.length} 条断言未通过（通过 ${passed} 条）`);
process.exit(1);
