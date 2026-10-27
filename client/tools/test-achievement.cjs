#!/usr/bin/env node
/**
 * 成就单测（client/tools/test-achievement.cjs，issue #401）
 *
 * 盯的不变量（改成就条件 / 配置表 / 面板 / 事件总线后必须全绿）：
 * A. 配置表（**跑真数据**）：id 唯一、分类与条件类型在枚举内、`kill` 的 target 是
 *    `"*"` 或真实怪物 key、`collect` 的 target 是真实物品 id、奖励物品真实存在 ——
 *    这些错在运行时的表现都是「玩家怎么打都不解锁」，运营在管理端看不出来
 * B. 布局与文案（**跑真配置**）：三个分类页签三处对齐（分类 / 页签名 / 坐标）、
 *    小结与进度的占位符齐全、三态按钮与列表三态各有文案
 * C. Store 契约：整份快照、切页重拉（不做「有数据就不拉」）、领取成功覆盖整份 /
 *    失败保留旧数据、业务码取自 ApiError、clear 归零、busyId 防连点
 * D. 面板契约：打开订阅 / 关闭退订、按分类过滤、三态按钮、隐藏成就未达成不剧透、
 *    进度只画不算、20012 飘「背包放不下」
 * E. 接线：小地图「成就」入口（现成素材）、离开游戏清缓存
 * F. 服务端：击杀采集点唯一（结算只 emit，任务与成就各自订阅）、达成与领取分离、
 *    状态型不落进度、进度钳到门槛、生成期与管理端双重复核引用
 *
 * AchievementStore 真引了 HttpClient（一路引到 cc），表现层沙箱起不来 —— 所以
 * Store 与面板做**源码契约断言**（与 test-leaderboard 同一取向），配置表与数据表
 * 则是**编译真源码跑真函数**。界面行为由真机验证。
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");
/** PROJECT_ROOT 是 client/，服务端与根目录要往上走一层 */
const readRepo = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, "..", rel), "utf8");

const SERVER_EVENTS = "server/src/common/events/game-events.service.ts";
const SERVER_EVENTS_MODULE = "server/src/common/events/game-events.module.ts";
const SERVER_SETTLE = "server/src/modules/realtime/combat-settlement.service.ts";
const SERVER_QUEST = "server/src/modules/quest/quest.service.ts";
const SERVER_ACHIEVEMENT = "server/src/modules/achievement/achievement.service.ts";
const SERVER_ACHIEVEMENT_REPO = "server/src/database/repositories/role-achievement.repository.ts";
const SERVER_CONFIG = "server/src/modules/game-config/game-config.service.ts";
const SERVER_ADMIN_CONTROLLER = "server/src/modules/game-config/admin-achievement.controller.ts";
const SERVER_BIZ_CODE = "server/src/common/constants/biz-code.ts";
const SERVER_GENERATED = "server/src/shared/game-data.generated.ts";

const CLIENT_DATA = "assets/configs/achievement-data.ts";
const CLIENT_CONFIG = "assets/configs/achievement.ts";
const CLIENT_STORE = "assets/ui/core/AchievementStore.ts";
const CLIENT_DIALOG = "assets/ui/components/dialogs/AchievementDialog.ts";
const CLIENT_SMALL_MAP = "assets/ui/components/hud/SmallMap.ts";
const CLIENT_HUD_LAYOUT = "assets/configs/layout/hud.ts";
const CLIENT_GAME = "assets/ui/Game.ts";

/** 数一个字符串出现次数 */
const count = (source, needle) => source.split(needle).length - 1;

/** 抽一段生成物里某张表的 key（形状：`  "key": {…},`） */
function snapshotKeys(source, exportName) {
  const head = source.indexOf(`export const ${exportName}`);
  if (head < 0) return [];
  const tail = source.indexOf("\n};", head);
  const body = source.slice(head, tail < 0 ? source.length : tail);
  return Array.from(body.matchAll(/^ {2}"([^"]+)": /gm)).map((match) => match[1]);
}

try {
  // 两张纯数据表都能在沙箱里真跑：achievement.ts 只用 cc 的 Color/Size/Vec2，
  // achievement-data.ts 连 import 都没有（它要给三端生成快照，见文件头注释）
  const outDir = prepare("olua-achievement", ["configs/achievement.ts", "configs/achievement-data.ts"]);
  const config = require(path.join(outDir, "configs/achievement.js"));
  const data = require(path.join(outDir, "configs/achievement-data.js"));

  const { achievementCategories, achievementDialogLayout: layout, achievementTexts: texts } = config;
  const { achievementData } = data;

  const generated = readRepo(SERVER_GENERATED);
  const monsterKeys = new Set(snapshotKeys(generated, "MONSTERS"));
  const itemKeys = new Set(snapshotKeys(generated, "ITEM_LABELS"));
  const achievementKeys = snapshotKeys(generated, "ACHIEVEMENTS");

  //#region A. 配置表

  console.log("\n— A. 配置表：引用必须真实存在（写错的表现是「怎么打都不解锁」） —");

  check(Array.isArray(achievementData) && achievementData.length === 8, `配置表有 8 条成就（实得 ${achievementData.length}）`);
  check(monsterKeys.size > 0 && itemKeys.size > 0, `快照里能取到怪物（${monsterKeys.size}）与物品（${itemKeys.size}）的 key`);

  const ids = achievementData.map((item) => item.id);
  check(new Set(ids).size === ids.length, "成就 id 唯一（id 是主键，重复只会静默覆盖一条）");
  check(
    ids.every((id) => /^ach_[a-z0-9_]+$/.test(id)),
    "成就 id 都是 ach_ 前缀的语义串（不是序号）",
  );

  const badCategory = achievementData.filter((item) => !achievementCategories.includes(item.category));
  check(badCategory.length === 0, "每条成就的分类都在面板页签里（否则那条永远不显示）", badCategory.map((item) => item.id).join(","));

  const CONDITION_TYPES = ["kill", "quest", "level", "combat", "collect"];
  const badType = achievementData.filter((item) => !CONDITION_TYPES.includes(item.condition.type));
  check(badType.length === 0, "条件类型都在枚举内（kill/quest 累计型，level/combat/collect 状态型）", badType.map((item) => item.id).join(","));

  const killRows = achievementData.filter((item) => item.condition.type === "kill");
  const badKill = killRows.filter((item) => item.condition.target !== "*" && !monsterKeys.has(item.condition.target));
  check(badKill.length === 0, "kill 的 target 是 \"*\" 或真实怪物 key", badKill.map((item) => `${item.id}:${item.condition.target}`).join(","));
  check(
    killRows.some((item) => item.condition.target === "*") && killRows.some((item) => item.condition.target !== "*"),
    "两种 kill 口径都有样例（任意怪 + 指定怪，客户端不区分但服务端两条分支都要跑到）",
  );

  const collectRows = achievementData.filter((item) => item.condition.type === "collect");
  const badCollect = collectRows.filter((item) => !itemKeys.has(item.condition.target));
  check(badCollect.length === 0, "collect 的 target 是真实物品 id（背包里数不到不存在的物品）", badCollect.map((item) => item.id).join(","));

  const badTarget = achievementData.filter(
    (item) => !["kill", "collect"].includes(item.condition.type) && item.condition.target !== "",
  );
  check(badTarget.length === 0, "level / combat / quest 的 target 留空（门槛只看 count，留着会让人以为要填）");

  const badCount = achievementData.filter((item) => !Number.isInteger(item.condition.count) || item.condition.count < 1);
  check(badCount.length === 0, "门槛 count 都是 ≥1 的整数（0 会被服务端 Math.max(1, …) 兜住，但配置就不该写）");

  const badReward = achievementData.filter((item) => item.rewards.items.some((reward) => !itemKeys.has(reward.goodId)));
  check(badReward.length === 0, "奖励里的物品都真实存在（发不出去的奖励到领取那一步才炸）", badReward.map((item) => item.id).join(","));
  check(
    achievementData.every((item) => item.rewards.gold > 0 || item.rewards.exp > 0 || item.rewards.items.length > 0),
    "每条都有奖励（空奖励的成就领了等于没反应）",
  );
  check(
    achievementData.every((item) => item.rewards.items.every((reward) => Number.isInteger(reward.count) && reward.count > 0)),
    "奖励物品的数量是正整数",
  );

  const byCategory = new Map(achievementCategories.map((category) => [category, []]));
  achievementData.forEach((item) => byCategory.get(item.category)?.push(item.order));
  const dupOrder = achievementCategories.filter((category) => new Set(byCategory.get(category)).size !== byCategory.get(category).length);
  check(dupOrder.length === 0, "同分类内 order 不重复（排序并列时次序会随查询漂移）", dupOrder.join(","));
  check(
    achievementCategories.every((category) => byCategory.get(category).length > 0),
    "三个分类下都有成就（空页签会让人以为功能坏了）",
  );
  check(
    achievementData.every((item) => item.label.length > 0 && item.description.length > 0 && typeof item.hidden === "boolean"),
    "名称 / 描述 / hidden 都填了",
  );

  // 快照与配置表逐条对齐：生成物是服务端与客户端的唯一来源，两边错位等于改配置没生效
  check(achievementKeys.length === achievementData.length, `快照收录 ${achievementData.length} 条成就（实得 ${achievementKeys.length}）`);
  check(
    ids.every((id) => achievementKeys.includes(id)),
    "配置表里的每条成就都进了快照（漏一条在客户端就是「面板少一条」）",
  );

  //#endregion

  //#region B. 布局与文案

  console.log("\n— B. 布局与文案：三处对齐（分类 / 页签名 / 坐标） —");

  check(achievementCategories.length === 3, "三个分类（战斗 / 成长 / 探索）");
  check(
    texts.tabs.length === achievementCategories.length,
    "页签文案数与分类数一致（少一条会有一个页签没字）",
    `${texts.tabs.length} vs ${achievementCategories.length}`,
  );
  check(
    layout.tabs.columns.length === achievementCategories.length,
    "页签坐标数与分类数一致（少一条会有一个页签叠在 0 位）",
    `${layout.tabs.columns.length} vs ${achievementCategories.length}`,
  );
  check(new Set(layout.tabs.columns).size === layout.tabs.columns.length, "页签横坐标互不相同");

  check(
    ["{achieved}", "{total}", "{claimed}"].every((token) => texts.summary.includes(token)),
    "顶部小结的三个占位符齐全（已达成 / 总数 / 已领）",
  );
  check(texts.progress.includes("{progress}") && texts.progress.includes("{target}"), "进度模板有两个占位符");
  check(
    new Set([texts.claim, texts.claimed, texts.locked]).size === 3,
    "三种按钮状态文案互不相同（否则玩家分不出「能不能领」）",
  );
  check(new Set([texts.loading, texts.failed, texts.emptyList]).size === 3, "列表三态文案互不相同（加载中 / 失败 / 空不能都显示成空）");
  check(texts.claimSuccess.length > 0 && texts.claimBagFull.length > 0 && texts.claimFailed.length > 0, "领取反馈三句都有（成功 / 背包满 / 其它失败）");
  check(texts.hiddenHint.length > 0 && !texts.hiddenHint.includes("{"), "隐藏成就的提示是一句静态文案（不剧透条件）");

  check(layout.name.length > 0 && layout.list.name.length > 0, "弹窗与列表的节点名在配置里（组件不写死节点名）");
  check(
    layout.row.size.height > 0 && layout.list.size.height >= layout.row.size.height,
    "行高不超过列表高度（否则一屏放不下一行）",
    `row ${layout.row.size.height} / list ${layout.list.size.height}`,
  );
  check(
    layout.row.actionSize.width > 0 && layout.row.actionPosition.x > 0,
    "状态按钮有自己的尺寸与横向位置（靠右，不与进度重叠）",
  );

  //#endregion

  //#region C. Store 契约

  console.log("\n— C. Store：整份快照 + 切页重拉 + 失败不清旧数据 —");

  const store = read(CLIENT_STORE);
  check(/data: MyAchievements \| null/.test(store), "存的是整份快照（不按条增量缓存）");
  check(/if \(this\.state\.loading\) return;/.test(store), "正在拉的请求不叠加（防连点把接口打穿）");
  check(!/static ensure\(/.test(store), "没有「有数据就不拉」的 ensure（状态型的进度取决于角色当前状态，缓存没意义）");
  check(
    /this\.state = \{ data: data \?\? this\.state\.data, loading: false, failed: false, busyId: "" \}/.test(store),
    "领取成功用返回值覆盖整份（服务端返回的就是最新全量，不在本地拼装）",
  );
  check(
    /this\.state = \{ \.\.\.this\.state, busyId: "" \};/.test(store),
    "领取失败只清 busyId，**保留旧数据**（背包满时清完格子能直接再点）",
  );
  check(
    /const code = \(error as \{ code\?: number \}\)\.code \?\? 0;/.test(store),
    "业务码取自 ApiError.code（20012 = 背包放不下，调用方据此飘不同的字）",
  );
  check(
    /static clear\(\): void \{[\s\S]{0,120}data: null, loading: false, failed: false, busyId: ""/.test(store),
    "clear 把四个字段一起归零（成就墙是「这个角色」的）",
  );
  check(
    /return \(\) => \{[\s\S]{0,120}this\.listeners\.filter\(\(item\) => item !== listener\)/.test(store),
    "onChange 返回真能退订的函数（弹窗关掉就摘掉）",
  );
  check(
    /if \(this\.state\.busyId\) return \{ ok: false, code: 0, mailId: null \};/.test(store),
    "领取中再点直接返回（不重复提交）",
  );

  //#endregion

  //#region D. 面板契约

  console.log("\n— D. 面板：订阅生命周期 / 分类过滤 / 三态按钮 —");

  const dialog = read(CLIENT_DIALOG);
  check(/this\.unsubscribe = AchievementStore\.onChange\(/.test(dialog), "打开时订阅进度变化");
  check(/if \(this\.unsubscribe\) \{[\s\S]{0,80}this\.unsubscribe\(\);/.test(dialog), "关闭时退订（返回的函数真的被调用）");
  check(/AchievementStore\.reload\(\)/.test(dialog), "切页签强制重拉（不读缓存）");
  check(
    /state\.data\.achievements\.filter\(\(row\) => row\.category === this\.category\)/.test(dialog),
    "列表按当前分类过滤（三个页签是同一份数据的三种筛法）",
  );
  check(!/\.achieved = /.test(dialog) && !/progress \+=/.test(dialog), "面板不自己算达成 / 进度（服务端给的是已钳好的 progress 与 achieved）");
  check(
    /claimable \? config\.claimFill : row\.claimed \? config\.claimedFill : config\.lockedFill/.test(dialog),
    "按钮三态各有底色（可领 / 已领 / 未达成）",
  );
  check(/if \(claimable && !busy\) \{/.test(dialog), "只有「可领且不在领取中」才绑点击（已领 / 未达成 / busy 都不可点）");
  check(
    /row\.hidden && !row\.achieved \? texts\.hiddenHint : row\.description/.test(dialog),
    "隐藏成就未达成时描述换成提示（不剧透条件）",
  );
  check(
    /texts\.progress\.split\("\{progress\}"\)\.join\(`\$\{row\.progress\}`\)/.test(dialog),
    "进度用服务端给的 progress / target 拼（客户端不夹、不算）",
  );
  check(/texts\.summary[\s\S]{0,200}split\("\{achieved\}"\)/.test(dialog), "小结的三个数字都来自服务端 summary");
  check(
    /const text = loading \? texts\.loading : failed \? texts\.failed : texts\.emptyList;/.test(dialog),
    "列表三态分别有文案（加载中不显示成「一条都没有」）",
  );
  check(
    /result\.code === CODE_BAG_FULL \? texts\.claimBagFull : texts\.claimFailed/.test(dialog) && /const CODE_BAG_FULL = 20012;/.test(dialog),
    "背包满（20012）飘「先清出格子」，其它失败飘通用失败",
  );
  check(/isOpen\(\)/.test(dialog), "面板能回答「我还开着吗」（领取回来后先判一次，节点已销毁就不再飘字）");

  //#endregion

  //#region E. 接线

  console.log("\n— E. 接线：小地图「成就」入口（现成素材）+ 离开游戏清缓存 —");

  const smallMap = read(CLIENT_SMALL_MAP);
  const hudLayout = read(CLIENT_HUD_LAYOUT);
  check(
    /if \(icon === "achievement"\) bindPointerAction\(button, \(\) => this\.achievementDialog\.open\(\), this\);/.test(smallMap),
    "「成就」入口绑了点击（打开成就面板）",
  );
  check(/private achievementDialog = new AchievementDialog\(\);/.test(smallMap), "小地图持有一个成就面板实例（不是每次点都 new）");
  check(/entryIcons: \["world", "achievement"/.test(hudLayout), "入口清单里有 achievement，且排在第二颗（美术稿的竖排顺序）");
  check(!/uiImages\.achievement/.test(smallMap), "入口用的是 small-map 现成图（不新增素材）");
  check(
    /AchievementStore\.clear\(\);/.test(read(CLIENT_GAME)),
    "离开游戏时清成就缓存（否则切角色会看到上一个角色的成就墙）",
  );

  //#endregion

  //#region F. 服务端

  console.log("\n— F. 服务端：击杀采集点唯一 / 达成与领取分离 / 状态型不落进度 —");

  const events = readRepo(SERVER_EVENTS);
  const settle = readRepo(SERVER_SETTLE);
  const quest = readRepo(SERVER_QUEST);
  const achievement = readRepo(SERVER_ACHIEVEMENT);
  const repo = readRepo(SERVER_ACHIEVEMENT_REPO);
  const gameConfig = readRepo(SERVER_CONFIG);
  const bizCode = readRepo(SERVER_BIZ_CODE);

  check(
    /this\.events\.emit\("monster:killed"/.test(settle) && !/quests\.onMonsterKilled\(/.test(settle),
    "结算只 emit 一次击杀事件（不再直接调任务服务）",
  );
  check(!/QuestService/.test(settle), "结算不认识 QuestService（加消费者不必再改结算）");
  check(
    /this\.events\.on\("monster:killed", \(event\) => this\.onMonsterKilled\(event\)\);/.test(quest),
    "任务服务订阅 monster:killed（采集点唯一）",
  );
  check(
    /this\.events\.on\("monster:killed"/.test(achievement) && /this\.events\.on\("quest:claimed"/.test(achievement),
    "成就服务订阅两条事件（击杀 + 交付）",
  );
  check(/emit<K extends GameEventType>/.test(events) && count(events, "catch (error)") >= 1, "总线逐个订阅方兜异常（写库失败不回滚世界状态）");
  check(/listenerCount\(/.test(events), "总线能回答「这条事件真有人接吗」（启动自检与单测用）");
  check(/@Global\(\)/.test(readRepo(SERVER_EVENTS_MODULE)), "总线模块是 @Global（订阅方分散三处，漏 imports 会变成静默故障）");

  check(/const CUMULATIVE_TYPES = new Set\(\["kill", "quest"\]\)/.test(achievement), "累计型只有 kill / quest（其余现算）");
  check(
    /if \(CUMULATIVE_TYPES\.has\(row\.condition_type\)\) return Math\.max\(0, record\?\.progress \?\? 0\);/.test(achievement),
    "累计型读记账，状态型走 switch 现算",
  );
  check(/Math\.min\(raw, target\)/.test(achievement), "进度一律钳到门槛（137/100 没有意义）");
  check(
    /if \(!record \|\| record\.achieved_at === null\) this\.records\.markAchieved\(role\.id, achievementId\);/.test(achievement),
    "状态型的 achieved_at 在领取时补写（它没有单一达成时刻）",
  );
  check(
    /mine\(accountId: string\): MyAchievementsDto \{[\s\S]{0,200}return \{ achievements: views, summary: this\.summaryOf\(views\) \};/.test(achievement),
    "查询接口不写库（读接口顺手改数据会让「刷新一下进度变了」解释不完）",
  );
  check(
    /if \(!view\.achieved\) \{[\s\S]{0,120}throw BizException\.conflict\(BizCode\.ACHIEVEMENT_NOT_ACHIEVED/.test(achievement) &&
      /if \(view\.claimed\) \{[\s\S]{0,120}throw BizException\.conflict\(BizCode\.ACHIEVEMENT_CLAIMED/.test(achievement),
    "先校验（未达成 / 已领）再发奖，异常路径不落库",
  );
  check(
    /if \(record\?\.achieved_at\) return;/.test(achievement),
    "达成后不再累加（这一列不会无限涨）",
  );
  check(/ON CONFLICT\(role_id, achievement_id\) DO UPDATE SET/.test(repo), "计数用 UPSERT 自增（并发两次击杀不丢一次）");
  check(
    count(bizCode, "ACHIEVEMENT_NOT_FOUND") + count(bizCode, "ACHIEVEMENT_NOT_ACHIEVED") + count(bizCode, "ACHIEVEMENT_CLAIMED") === 3,
    "三个成就业务码各定义一次（重复定义会被后面的覆盖）",
  );
  check(
    /private assertAchievementConsistency\(row: AchievementRow\): void \{/.test(gameConfig) &&
      /不是已配置的怪物（任意怪请写 \*）/.test(gameConfig),
    "管理端保存时复核引用（生成期校验之外的第二道）",
  );
  check(
    /operationId: "adminAchievement\.(list|create|update|remove)"/.test(readRepo(SERVER_ADMIN_CONTROLLER)),
    "管理端接口有 operationId（生成器据此产出 achievementsApi）",
  );

  //#endregion
} catch (error) {
  fail(`\n[!!] 脚本异常：${error && error.stack ? error.stack : error}`);
}

finish("PASS：成就（#401）");
