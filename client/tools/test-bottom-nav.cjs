#!/usr/bin/env node
/**
 * 底部导航入口单测（client/tools/test-bottom-nav.cjs，issue #485）
 *
 * 盯的不变量：
 *   1. 每条入口都**显式**声明 `comingSoon`（布尔）——不允许缺省，缺省就意味着「没人想过它是没是没做」；
 *   2. `comingSoon === true` 的集合与登记的名单完全一致 —— 新增入口要么接上回调（改成 false），
 *      要么把它加进这份名单（同时就会得到「正在开发中」的提示），不会出现「点了完全没反应」；
 *   3. 等级门槛与解锁提示的口径：`openLevel` 必须是 ≥ 1 的整数（0 / 负数会让图标永远置灰或永远亮）。
 *
 * 为什么放在单测而不是运行期断言：`BottomBar` 的回调表在类里、依赖 cc 与十几个弹窗，
 * 单测跑不了；但「入口该不该做」是**数据**问题，读 `configs/bottomNav.ts` 就够。
 *
 * 用法：node client/tools/test-bottom-nav.cjs
 */
const path = require("path");
const { prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

/**
 * 已登记「入口放出、功能未做」的 key
 *
 * 接上回调后要把它从这里删掉（并把 bottomNav.ts 里的 comingSoon 改成 false）；
 * 新增入口忘了接回调却也没登记 → 这里会红，逼人做一次明确决定。
 */
const EXPECTED_COMING_SOON = ["friend", "horse", "config"];

try {
  const outDir = prepare("olua-bottom-nav", ["configs/bottomNav.ts"]);
  const { bottomNavItems } = require(path.join(outDir, "configs/bottomNav.js"));

  console.log("\n— A. 每条入口的元数据 —");
  {
    const missing = bottomNavItems.filter((item) => typeof item.comingSoon !== "boolean").map((item) => item.key);
    check(missing.length === 0, "每条入口都显式声明了 comingSoon（布尔）", missing.length ? `缺省：${missing.join(", ")}` : "");
    const badLevel = bottomNavItems
      .filter((item) => !Number.isInteger(item.openLevel) || item.openLevel < 1)
      .map((item) => `${item.key}=${item.openLevel}`);
    check(badLevel.length === 0, "openLevel 都是 ≥ 1 的整数", badLevel.join(", "));
    const empty = bottomNavItems.filter((item) => !item.label || !item.icon || !item.shortcutKey).map((item) => item.key);
    check(empty.length === 0, "label / icon / shortcutKey 都不为空", empty.join(", "));
    const dup = bottomNavItems.map((item) => item.key).filter((key, i, all) => all.indexOf(key) !== i);
    check(dup.length === 0, "key 不重复", dup.join(", "));
  }

  console.log("\n— B. 「未做」名单与登记一致 —");
  {
    const actual = bottomNavItems.filter((item) => item.comingSoon === true).map((item) => item.key);
    check(
      JSON.stringify(actual.slice().sort()) === JSON.stringify(EXPECTED_COMING_SOON.slice().sort()),
      `comingSoon 集合 = 登记名单（实际 ${JSON.stringify(actual)}）`,
    );
    // 反向：登记了但数据里没标 → 说明有人删了入口却忘了改名单
    const ghost = EXPECTED_COMING_SOON.filter((key) => !bottomNavItems.some((item) => item.key === key));
    check(ghost.length === 0, "登记名单里没有已删除的入口", ghost.join(", "));
  }
} catch (error) {
  fail(error);
}

finish("✅ 底部导航入口单测全绿");
