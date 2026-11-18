#!/usr/bin/env node
/**
 * 掉落预判与掉地链路单测（client/tools/test-drop-rule.cjs）
 *
 * 盯的不变量（#804）：
 * · `DropRule.canPickLocally` 的每条分支：自己的恒可捡、判不出来放行、保护期内拦、
 *   保护期过了放行、本地过期判 expired、同队放行 —— **fail-open 是本单测的主角**
 *   （收紧它不会更安全，只会让「明明能捡却捡不起来」藏进客户端，也会卡死新手引导第 3 步）
 * · `timelineOf` 用相对量算本地时间轴（服务端绝对时间一个都不读），缺字段时 `hasExpiry=false`
 * · `protectSecondsLeft` 向上取整（还剩 0.4 秒要说「1 秒」，不是「0 秒」）
 * · 结构：铺地只剩服务端一条路（`spawnResults` / `spawnRemoteDrops` / 散落函数都不在了）、
 *   三条帧接进了组合根、`applyPickedFrame` 的 ok 分支仍 notify 引导、pick 帧只带 dropId
 *
 * 纯逻辑跑在沙箱里（真实的 `ui/utils/drop/DropRule.ts`，见 lib/configs-sandbox.cjs），
 * 源码断言直接读文件。方法体一律按**大括号配对**切（#966 的假绿教训：缩进不可靠）。
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish } = require("./lib/configs-sandbox.cjs");

const outDir = prepare("olua-drop-rule", ["ui/utils/drop/DropRule.ts"]);
const rule = require(path.join(outDir, "ui/utils/drop/DropRule.js"));

/** GameUiHelper 已按域拆到 helpers/parts/（#1115 批次 1）：断言用源码 = barrel + 全部 parts 拼接 */
function gameUiSourceCombined(helperTsPath) {
  const dir = path.join(path.dirname(helperTsPath), "parts");
  return [fs.readFileSync(helperTsPath, "utf8"),
    ...fs.readdirSync(dir).filter((x) => x.endsWith(".ts")).sort().map((x) => fs.readFileSync(path.join(dir, x), "utf8"))].join("\n");
}


const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");

/**
 * 从源码里取某个静态方法的完整方法体（按大括号配对，不按缩进）
 *
 * 找不到就返回空串 —— 调用方一律把空串判成失败，否则「方法改名」会让断言变成永远成立。
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

console.log("=== 时间轴：相对量 + 本地时钟（不读服务端绝对时间） ===");
{
  const timeline = rule.timelineOf(1_000, 180_000, 30_000);
  check(timeline.hasExpiry === true, "两个相对量都给 → hasExpiry = true");
  check(timeline.expireAtLocal === 181_000, "到期时刻 = 收到时刻 + expireInMs", `expireAtLocal=${timeline.expireAtLocal}`);
  check(timeline.protectUntilLocal === 31_000, "保护期结束 = 收到时刻 + protectInMs", `protectUntilLocal=${timeline.protectUntilLocal}`);
  check(timeline.fallbackHideAt === 184_000, "兜底隐藏 = 到期时刻 + 3 秒宽限", `fallbackHideAt=${timeline.fallbackHideAt}`);

  const missing = rule.timelineOf(1_000, undefined, undefined);
  check(missing.hasExpiry === false, "相对量缺失 → hasExpiry = false（不是当成 0 毫秒后过期）");

  const longer = rule.timelineOf(0, 10_000, 60_000);
  check(longer.protectUntilLocal === 10_000, "保护期比过期还长时按过期截断（与服务端 min(protect, ttl) 同口径）");
}

console.log("\n=== 保护期剩余秒数：向上取整 ===");
{
  check(rule.protectSecondsLeft(1_200, 0) === 2, "剩 1.2 秒 → 2 秒");
  check(rule.protectSecondsLeft(400, 0) === 1, "剩 0.4 秒 → 1 秒（不说「0 秒」，那读起来像现在就能捡）");
  check(rule.protectSecondsLeft(0, 100) === 0, "已过保护期 → 0");
}

console.log("\n=== canPickLocally：每条分支（fail-open 优先） ===");
{
  const base = {
    now: 10_000,
    me: "acc-me",
    myPartyId: "",
    drop: {
      hasExpiry: true,
      expireAtLocal: 190_000,
      protectUntilLocal: 40_000,
      ownerAccountId: "acc-other",
      partyId: "",
    },
  };
  const verdict = (patch) => rule.canPickLocally({ ...base, ...patch, drop: { ...base.drop, ...(patch.drop ?? {}) } });

  check(verdict({ drop: { ownerAccountId: "acc-me" } }) === true, "自己的掉落 → 恒可捡（新手引导第 3 步靠这条）");
  check(verdict({ me: "" }) === true, "还不知道自己是谁 → 放行（判不出来就放行）");
  check(verdict({ drop: { ownerAccountId: "" } }) === true, "归属者账号缺失 → 放行");
  check(verdict({ drop: { hasExpiry: false } }) === true, "时间戳没算出来 → 放行");
  check(verdict({}) === "protected", "别人的 + 还在保护期 → 本地拦（只为省请求）");
  check(verdict({ drop: { protectUntilLocal: 9_000 } }) === true, "保护期已过 → 放行");
  check(verdict({ drop: { expireAtLocal: 9_000 } }) === "expired", "本地已过期 → expired（点它时提示「已消失」）");
  check(verdict({ myPartyId: "party-1", drop: { partyId: "party-1" } }) === true, "掉落时同队 → 放行（不必等服务端拒一次）");
  check(verdict({ myPartyId: "party-1", drop: { partyId: "party-2" } }) === "protected", "不同队 → 仍按保护期拦");
}

console.log("\n=== 结构：铺地只剩服务端一条路 ===");
{
  const dropManager = read("assets/ui/core/DropManager.ts");
  const monsterManager = read("assets/ui/core/MonsterManager.ts");
  const combatChannel = read("assets/ui/utils/net/CombatChannel.ts");
  const realtimeClient = read("assets/ui/utils/net/RealtimeClient.ts");
  const game = read("assets/ui/Game.ts");

  check(!dropManager.includes("spawnResults"), "DropManager 不再有 spawnResults（自己杀的掉落不再由 settle 铺地）");
  check(!dropManager.includes("spawnRemoteDrops"), "DropManager 不再有 spawnRemoteDrops（别人的掉落不再走 monster-ai）");
  check(!dropManager.includes("scatterDropPositions"), "DropManager 不自己算散落（坐标由服务端给）");
  check(!fs.existsSync(path.join(PROJECT_ROOT, "assets/ui/utils/drop/DropScatter.ts")), "DropScatter.ts 已删除");
  check(!monsterManager.includes("DropManager."), "MonsterManager 不再碰掉落（只清怪）");
  check(dropManager.includes("this.items.has(snapshot.dropId)"), "同一件掉落重复广播时不重复铺（幂等）");

  check(combatChannel.includes('RealtimeClient.send({ type: "pick", data: { dropId } })'), "pick 帧只带 dropId（不再发 castId + 下标）");
  check(combatChannel.includes("dispatchDropSpawn") && combatChannel.includes("dispatchDropRemove") && combatChannel.includes("dispatchDropNotice"), "三条掉落帧都有分发入口");
  check(
    realtimeClient.includes('frame.type === "dropSpawn"') &&
      realtimeClient.includes('frame.type === "dropRemove"') &&
      realtimeClient.includes('frame.type === "dropNotice"'),
    "RealtimeClient 路由了 dropSpawn / dropRemove / dropNotice",
  );
  check(game.includes("DropManager.applySnapshot(snapshot.drops, snapshot.mapId)"), "world 帧的 drops 走 applySnapshot（进图 / 重连重建）");
  check(
    game.includes("CombatChannel.onDropSpawn") && game.includes("CombatChannel.onDropRemove") && game.includes("CombatChannel.onDropNotice"),
    "组合根接了三条掉落帧",
  );
  check(game.includes("DropManager.update()"), "每帧驱动 update（到期兜底 + 撤归属标记）");

  // 引导契约（docs/18 §6.6）：ok 分支里那三行只搬位置、不改语义
  const pickedBody = methodBody(dropManager, "static applyPickedFrame(");
  check(pickedBody.length > 0, "applyPickedFrame 方法体能取到（方法改名会让这条先红）");
  check(pickedBody.includes("GuideStore.notify(GUIDE_EVENT.PICKUP)"), "ok 分支仍 notify 引导 PICKUP（位置不变）");
  const rejectionBody = methodBody(dropManager, "private static handlePickRejection(");
  check(rejectionBody.length > 0, "handlePickRejection 方法体能取到");
  for (const code of ["bag_full", "protected", "already_picked", "expired", "too_far", "not_on_map", "item_gone", "unknown_drop", "no_role"]) {
    check(rejectionBody.includes(`case "${code}"`), `拒绝码 ${code} 有自己的分支（九种都有话说）`);
  }
  check(!/opacity|setScale|scale = /.test(dropManager), "末尾不加任何呼吸灯 / 缩放脉冲（已定项：零提示）");
}

console.log("\n=== 结构：文案与归属标记 ===");
{
  const texts = read("assets/configs/texts.ts");
  for (const key of [
    "drop_protected_tip",
    "drop_already_picked_tip",
    "drop_expired_tip",
    "drop_too_far_tip",
    "drop_not_on_map_tip",
    "drop_unknown_tip",
    "drop_item_gone_tip",
    "drop_login_abnormal_tip",
    "drop_pick_failed_tip",
    "drop_owner_prefix",
    "drop_notice_tip",
  ]) {
    check(new RegExp(`^\\s*${key}:`, "m").test(texts), `文案 ${key} 已登记（核心代码里不写中文）`);
  }

  const helper = gameUiSourceCombined(path.join(PROJECT_ROOT, "assets/ui/helpers/GameUiHelper.ts"));
  const ownerMarkBody = methodBody(helper, "function createDropOwnerMark(");
  check(ownerMarkBody.length > 0, "createDropOwnerMark 方法体能取到");
  check(ownerMarkBody.includes("Mask.Type.GRAPHICS_ELLIPSE"), "归属头像是圆形的（Mask GRAPHICS_ELLIPSE 裁方图）");
  check(ownerMarkBody.includes("owner.occupation && owner.sex"), "缺职业或性别就不画头像（不画空框）");
  check(helper.includes("avatarImage(owner.occupation, owner.sex)"), "头像走现有素材 ui/avatar/{职业}-{性别}（不新增美术）");
}

finish("掉落预判与掉地链路：全部断言通过");
