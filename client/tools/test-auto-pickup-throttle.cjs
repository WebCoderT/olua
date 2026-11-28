#!/usr/bin/env node
/**
 * 自动拾取 / 自动回收卡顿修复回归（#1385：拾取洪峰限量、背包满本地预判、picked 刷包合帧、回收闸共享）
 *
 * 四道修法全是「客户端时序」改动，没有可拆出来的纯函数 —— 判据以**源码断言**为主
 * （与 test-auto-bag 的触发层断言同一口径：锁结构、锁先后顺序，不锁数值）。
 * 末段带**反证自证**：把被锁的代码从源码串里删掉，同一判据必须翻红 ——
 * 防止判据写成恒真（check 参数反序 / 正则过于宽松都是这类假绿）。
 *
 * 盯的不变量（改回去必须红）：
 * · autoPickup 每帧限量：只数 requestPick **实发**的帧，发满 AUTO_PICK_PER_FRAME 即 break；
 * · autoPickup 背包满本地预判：发 pick 前先 isBagFull(role.bag)，满了只节流提示、不发批量；
 * · requestPick 返回 boolean（实发 / 被去重与离线挡下要区分开）；
 * · applyPickResult 刷包走 scheduleBagRefresh（合帧），不再逐条 refreshBag；
 * · scheduleBagRefresh 的 pending 闸：先复位再刷（刷新途中新变化能排上下一拍）；
 * · runOnce 回收段带 `!recycling` 前置（bag_full 路径与防抖路径不叠单）。
 *
 * 用法：node client/tools/test-auto-pickup-throttle.cjs
 */
const fs = require("fs");
const path = require("path");
const { check, finish, fail } = require("./lib/configs-sandbox.cjs");

/**
 * 抓取类成员方法体。与 test-auto-bag 的「按大括号配对」同口径，多一层防御：
 * **参数列表里的内联对象类型**（如 `placed: Array<{ row; col; ... }>`）自带一对 `{}`，
 * 直接从第一个 `{` 配对会把方法体截断在类型上（抓到的是半截签名，正则恒不中 = 假红；
 * 反过来若判据写在半截上就恒不绿）。所以先跳到参数列表收口的 `)`，再取其后的方法体 `{`。
 * 本文件抓的四个方法参数里都没有裸 `)`，取「签名后第一个 `)`」即参数列表收口。
 */
function extractMethod(src, signature) {
  const start = src.indexOf(signature);
  if (start === -1) return null;
  const closeParen = src.indexOf(")", start);
  if (closeParen === -1) return null;
  const open = src.indexOf("{", closeParen);
  if (open === -1) return null;
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

const readAsset = (rel) => fs.readFileSync(path.join(__dirname, "..", "assets", rel), "utf8");

function main() {
  let dmSrc;
  let roleUiSrc;
  let applierSrc;
  let serviceSrc;
  try {
    dmSrc = readAsset("ui/core/DropManager.ts");
    roleUiSrc = readAsset("ui/core/RoleUIManager.ts");
    applierSrc = readAsset("ui/core/storage/battle-applier.ts");
    serviceSrc = readAsset("ui/core/storage/auto-bag-service.ts");
  } catch (error) {
    fail(String(error.message ?? error));
    return;
  }

  //#region A. autoPickup：每帧限量 + 背包满本地预判

  console.log("\n=== autoPickup：洪峰限量 + 满包预判 ===");
  {
    const autoBody = extractMethod(dmSrc, "static autoPickup(");
    const requestPickBody = extractMethod(dmSrc, "private static requestPick(");
    check(!!autoBody, "autoPickup 方法体抓得到");
    check(!!requestPickBody, "requestPick 方法体抓得到");
    if (!autoBody || !requestPickBody) return;

    // 限量常量存在且为正整数（不锁具体值：手感数值可调，结构不许丢）
    check(/const AUTO_PICK_PER_FRAME = \d+;/.test(dmSrc), "AUTO_PICK_PER_FRAME 常量存在（数值不锁）");
    // 限量三件套：实发计数 + 上限判等 + break
    const capDetector = (src) =>
      /if \(this\.requestPick\(drop\)\)/.test(src) &&
      /sent >= AUTO_PICK_PER_FRAME/.test(src) &&
      /break;/.test(src);
    check(capDetector(autoBody), "每帧限量：只数实发、发满即 break（#1385）");
    // 满包预判：isBagFull 出现在 pick 循环**之前**（顺序错了预判就是空话）
    const precheckAt = autoBody.indexOf("isBagFull(role.bag)");
    const loopAt = autoBody.indexOf("for (const drop");
    check(precheckAt !== -1 && loopAt !== -1 && precheckAt < loopAt, "满包预判在 pick 循环之前");
    const precheckBranch = autoBody.slice(precheckAt, loopAt);
    check(/notifyBagFull\(\)/.test(precheckBranch) && /return;/.test(precheckBranch), "满包分支只节流提示、不发批量");
    // 限量计数器在预判之后（满了根本不进循环）
    check(autoBody.indexOf("let sent = 0;") > precheckAt, "限量计数器在满包预判之后");
    // requestPick 返回 boolean：实发 true / 在途与离线 false（限量按实发计的前提）
    check(
      /return false;/.test(requestPickBody) && /return true;/.test(requestPickBody),
      "requestPick 返回 boolean（实发与被挡要区分）",
    );

    // ── 反证自证：把限量与预判从源码串里删掉，同一判据必须翻红 ──
    const noCap = autoBody
      .replace(/\s*sent\+\+;\s*if \(sent >= AUTO_PICK_PER_FRAME\) break;/, "")
      .replace(/if \(this\.requestPick\(drop\)\) \{/, "this.requestPick(drop); {");
    check(!capDetector(noCap), "反证自证：删掉限量后判据翻红");
    const noPrecheck = autoBody.replace(
      /const role = RoleCache\.findOnlineRole\(\);[\s\S]*?if \(role && isBagFull\(role\.bag\)\) \{\s*this\.notifyBagFull\(\);\s*return;\s*\}/,
      "",
    );
    check(!/isBagFull\(role\.bag\)/.test(noPrecheck), "反证自证：删掉满包预判后判据翻红");
  }

  //#endregion

  //#region B. picked 刷包合帧

  console.log("\n=== picked 应答：刷包合帧 ===");
  {
    const applyBody = extractMethod(applierSrc, "static applyPickResult(");
    check(!!applyBody, "applyPickResult 方法体抓得到");
    check(
      !!applyBody && /RoleUIManager\.scheduleBagRefresh\(\)/.test(applyBody),
      "applyPickResult 走 scheduleBagRefresh（合帧）",
    );
    check(
      !!applyBody && !/RoleUIManager\.refreshBag\(\)/.test(applyBody),
      "applyPickResult 不再逐条 refreshBag（几十条 picked = 几十次整包重建，已撤）",
    );

    const scheduleBody = extractMethod(roleUiSrc, "static scheduleBagRefresh(");
    check(!!scheduleBody, "scheduleBagRefresh 方法体抓得到");
    check(
      !!scheduleBody && /if \(RoleUIManager\.bagRefreshScheduled\) return;/.test(scheduleBody),
      "合帧有在途闸（重复合并请求直接忽略）",
    );
    // pending 闸先复位再刷：刷新途中新到的变化能排上下一拍，不丢
    const resetAt = scheduleBody ? scheduleBody.indexOf("bagRefreshScheduled = false;") : -1;
    const refreshAt = scheduleBody ? scheduleBody.indexOf("this.refreshBag()") : -1;
    check(resetAt !== -1 && refreshAt !== -1 && resetAt < refreshAt, "pending 闸先复位再刷（顺序不反）");
    check(
      !!scheduleBody && /setTimeout\(/.test(scheduleBody),
      "合并到下一个宏任务执行（同拍多条只重建一次）",
    );
  }

  //#endregion

  //#region C. 回收闸共享

  console.log("\n=== 自动回收：两路触发共用在途闸 ===");
  {
    const runOnceBody = extractMethod(serviceSrc, "static async runOnce()");
    check(!!runOnceBody, "runOnce 方法体抓得到");
    check(
      !!runOnceBody && /!AutoBagService\.recycling && AutoBagPrefs\.getAutoRecycle\(role\.id\) && isBagFull\(role\.bag\)/.test(runOnceBody),
      "runOnce 回收段带 `!recycling` 前置（与 bag_full 拒绝路径不叠单）",
    );
    // #1373 的「满才回收」前置不回潮（回收不许在未满时触发）
    check(
      !!runOnceBody && /isBagFull\(role\.bag\)/.test(runOnceBody),
      "「背包已满才回收」前置仍在（#1373）",
    );
    // 反证自证：删掉 !recycling 后判据翻红
    const noGate = runOnceBody ? runOnceBody.replace("!AutoBagService.recycling && ", "") : "";
    check(
      !/!AutoBagService\.recycling && AutoBagPrefs\.getAutoRecycle/.test(noGate),
      "反证自证：删掉 recycling 闸后判据翻红",
    );
  }

  //#endregion

  finish("自动拾取限量 / 满包预判 / picked 合帧 / 回收闸共享 全部断言通过（含反证自证）");
}

main();
