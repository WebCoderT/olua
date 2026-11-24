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
const battleSource = fs.readFileSync(path.join(root, "assets/ui/core/storage/battle-applier.ts"), "utf8");
const roleCacheSource = fs.readFileSync(path.join(root, "assets/ui/core/storage/role-cache.ts"), "utf8");

/**
 * 按大括号配对切出方法体（#1236）
 *
 * 不按缩进、也不用「从前缀往后截 N 个字符」—— 后者会把下一个方法一起算进来，
 * 守点就退化成「整文件里有没有这一行」的假绿。签名找不到时返回**空串**：
 * 调用方必须判空，方法改名了也要红，而不是静悄悄通过。
 */
function methodBody(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) return "";
  const open = source.indexOf("{", start);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return "";
}

// 反证：切法本身可信 —— 方法名对不上必须拿到空串（否则下面几条断言可能是假绿）
check(methodBody(battleSource, "private noSuchMethodAtAll(") === "", "反证：方法名不存在时切出空串（切法可信）");

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

console.log("— roleUpdate 帧要落本地缓存（#1236）—");
// 帧只刷 UI 不写缓存时，缓存里的 mp 停在上次真落盘的时刻；击杀奖励 / 拾取读缓存把旧蓝刷上屏，
// 一秒后被下一帧拉回 —— 就是「打死怪蓝量涨一截又回去」。这条只钉「必须写回」，不钉顺序。
const applyUpdateBody = methodBody(battleSource, "static applyServerRoleUpdate(");
check(applyUpdateBody.length > 0, "切到 applyServerRoleUpdate 方法体（方法还在、名字没改）");
check(/RoleCache\.writeBack\(role\)/.test(applyUpdateBody), "applyServerRoleUpdate 把帧内容写回本地缓存（RoleCache.writeBack）");
// 写回是「只落本地」：帧的内容就是服务端现状，推上去只是白占一个防抖节拍
const writeBackBody = methodBody(roleCacheSource, "static writeBack(");
check(writeBackBody.length > 0, "切到 RoleCache.writeBack 方法体");
check(/mergeIntoCache\(role\)/.test(writeBackBody), "writeBack 走 mergeIntoCache 落本地");
check(!/RoleSync\.schedule/.test(writeBackBody), "writeBack 不触发服务端同步（不 schedule）");
// 合并逻辑只有一份：revision 基线规则从 updateOnlineRole 抽到 mergeIntoCache，别两处漂
const mergeBody = methodBody(roleCacheSource, "static mergeIntoCache(");
check(/typeof role\.revision === "number" \? role\.revision : i\.revision/.test(mergeBody), "mergeIntoCache 保留 revision 基线合并规则");
check(/mergeIntoCache\(role\)/.test(methodBody(roleCacheSource, "static updateOnlineRole(")), "updateOnlineRole 也走同一份合并逻辑");

console.log("");
if (failures.length === 0) {
  console.log(`PASS：血蓝收权客户端接线（共 ${passed} 条断言）`);
  process.exit(0);
}
console.log(`FAIL：${failures.length} 条断言未通过（通过 ${passed} 条）`);
process.exit(1);
