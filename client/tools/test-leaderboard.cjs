#!/usr/bin/env node
/**
 * 排行榜守卫单测（client/tools/test-leaderboard.cjs，issue #400）
 *
 * 盯的不变量（改榜口径 / 弹窗 / 入口接线后必须全绿）：
 * A. 榜的种类与取值三端一致：服务端常量、客户端 Store、弹窗页签、布局文案
 * B. 「切页就重拉」：榜单是分钟级快照，切页还读缓存会让玩家以为「我升级了没动」
 * C. 打开订阅 / 关闭退订：接口/弹窗的生命周期不泄漏
 * D. 底部「我的名次」：榜外的人也要看得到自己（文案与判据都在）
 * E. 入口：小地图那颗「排行榜」标签绑了点击，且 Game 离开游戏时清缓存
 * F. Store 的网络纪律：列表与名次并发拉（同一份快照）、失败不清旧数据
 *
 * 表现层依赖 cc（Node / Graphics / Label），沙箱起不来；LeaderboardStore 又真引了
 * HttpClient（一路引到 cc）—— 所以这里做**源码契约断言**，界面行为由真机验证。
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, check, finish } = require("./lib/configs-sandbox.cjs");

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");
/** PROJECT_ROOT 是 client/，服务端与根目录要往上走一层 */
const readRepo = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, "..", rel), "utf8");

const SERVER_CONST = "server/src/common/constants/leaderboard.ts";
const SERVER_SERVICE = "server/src/modules/leaderboard/leaderboard.service.ts";
const SERVER_CONTROLLER = "server/src/modules/leaderboard/leaderboard.controller.ts";
const CLIENT_STORE = "assets/ui/core/LeaderboardStore.ts";
const CLIENT_DIALOG = "assets/ui/components/dialogs/LeaderboardDialog.ts";
const CLIENT_LAYOUT = "assets/configs/layout/dialogs.ts";
const CLIENT_SMALL_MAP = "assets/ui/components/hud/SmallMap.ts";
const CLIENT_GAME = "assets/ui/Game.ts";

/** 数一个字符串出现次数 */
const count = (source, needle) => source.split(needle).length - 1;

try {
  const serverConst = readRepo(SERVER_CONST);
  const serverService = readRepo(SERVER_SERVICE);
  const serverController = readRepo(SERVER_CONTROLLER);
  const store = read(CLIENT_STORE);
  const dialog = read(CLIENT_DIALOG);
  const layout = read(CLIENT_LAYOUT);
  // 只取排行榜那一段：布局文件里有十几个弹窗，同样的 `columns` / `tabs` 关键字到处都是
  const boardLayout = layout.slice(layout.indexOf("leaderboardDialogLayout"));
  const smallMap = read(CLIENT_SMALL_MAP);
  const game = read(CLIENT_GAME);

  console.log("\n— A. 榜的种类：服务端常量 ↔ 客户端 Store ↔ 弹窗页签 ↔ 布局文案 —");

  // 服务端：三个榜的取值写死在这里（协议里的 :board 就是这三个字符串）
  check(
    /LEVEL: "level"/.test(serverConst) && /COMBAT: "combat"/.test(serverConst) && /KILLS: "kills"/.test(serverConst),
    "服务端三个榜的取值是 level / combat / kills",
  );
  check(
    count(serverConst, "LEADERBOARD_BOARD.") >= 3 && /LEADERBOARD_BOARDS: LeaderboardBoard\[\] = \[/.test(serverConst),
    "服务端有一份「全部榜」清单（物化与文档顺序都读它）",
  );
  check(
    /LEVEL: "level"/.test(store) && /COMBAT: "combat"/.test(store) && /KILLS: "kills"/.test(store),
    "客户端的三个榜取值与服务端逐字相同（路径参数只能靠约定对齐）",
  );
  check(/LEADERBOARD_BOARDS: LeaderboardBoard\[\] = \[[^\]]*LEVEL[^\]]*COMBAT[^\]]*KILLS/.test(store), "客户端的榜清单顺序是 等级 → 战力 → 击杀");

  // 布局：三列页签 + 三份文案 + 三份数值模板（少一份就会有一个页签没字）
  const tabColumnMatch = /columns: \[(-?\d+), (-?\d+), (-?\d+)\]/.exec(boardLayout);
  check(!!tabColumnMatch, "布局里排行榜页签有三列坐标", tabColumnMatch && tabColumnMatch[0]);
  const tabsTextMatch = /tabs: \["([^"]+)", "([^"]+)", "([^"]+)"\]/.exec(boardLayout);
  check(!!tabsTextMatch, "布局里有三条页签文案", tabsTextMatch && tabsTextMatch[0]);
  check(
    /levelMeta:/.test(boardLayout) && /combatMeta:/.test(boardLayout) && /killsMeta:/.test(boardLayout),
    "三个榜各有一份数值行模板（当前榜的数放最前）",
  );
  check(/selfIn:/.test(boardLayout) && /selfOut:/.test(boardLayout), "底部「我的名次」有「有名字 / 没名字」两套文案");
  check(/LEADERBOARD_BOARD\.LEVEL, LEADERBOARD_BOARD\.COMBAT, LEADERBOARD_BOARD\.KILLS\]/.test(dialog), "弹窗页签顺序与 Store 的榜清单一致");

  console.log("\n— B. 切页就重拉：榜单是分钟级快照，不能读缓存 —");

  check(/LeaderboardStore\.reload\(board\)/.test(dialog), "切页签时强制重拉（reload，不读缓存）");
  check(!/LeaderboardStore\.ensure\(/.test(store), "仓里没有「有数据就不拉」的 ensure（留着它会让人以为切页可以省一次请求）");
  check(/size: 50/.test(store), "一次拉 50 条（榜本身最多 LEADERBOARD_TOP_N 条，尾巴靠「我的名次」）");

  console.log("\n— C. 打开订阅 / 关闭退订 —");

  check(/this\.unsubscribe = LeaderboardStore\.onChange\(/.test(dialog), "打开时订阅榜单变化");
  check(/if \(this\.unsubscribe\) \{[\s\S]{0,80}this\.unsubscribe\(\);/.test(dialog), "关闭时退订（返回的函数真的被调用）");
  check(/private leaderboardDialog = new LeaderboardDialog\(\)/.test(smallMap), "小地图持有一个排行榜弹窗实例（不是每次点都 new）");

  console.log("\n— D. 底部「我的名次」：榜外的人也要看得到自己 —");

  check(/rank > 0 && entry \? layout\.texts\.selfIn/.test(dialog), "名次大于 0 才显示「第 N 名」，否则显示「还没有名次」");
  check(/layout\.texts\.selfIn\.split\("\{rank\}"\)/.test(dialog), "「我的名次」用 rank 占位符填，不拼字符串");
  check(/entry\.roleId === self\.roleId/.test(dialog), "「哪一行是我」用服务端返回的 entry.roleId 判（本地角色 id 会在切角色时过期）");

  console.log("\n— E. 入口与清缓存 —");

  check(
    /bindPointerAction\(rankingEntry, \(\) => this\.leaderboardDialog\.open\(\), this\)/.test(smallMap),
    "小地图那颗「排行榜」标签绑了点击（美术稿里本来就有的入口）",
  );
  check(/uiImages\.smallMapRankingList/.test(smallMap), "入口用的是 small-map/ranking-list 这张现成图（不新增素材）");
  check(/LeaderboardStore\.clear\(\)/.test(game), "离开游戏时清榜单缓存（否则底部那行会写上一个角色的名次）");

  console.log("\n— F. Store 的网络纪律 —");

  check(/Promise\.all\(\[/.test(store), "列表与「我的名次」并发拉（两者必须是同一份快照）");
  check(/failed: true \}\)/.test(store) && /\.\.\.this\.state\(board\), loading: false, failed: true/.test(store), "请求失败只置 failed，**不清旧数据**");
  check(/if \(this\.state\(board\)\.loading\) return;/.test(store), "正在拉的同一榜不叠加请求（防连点把接口打穿）");
  check(/static clear\(\): void \{[\s\S]{0,80}this\.states\.clear\(\);/.test(store), "clear 清掉三个榜的状态");

  console.log("\n— G. 服务端口径与接口 —");

  check(/LEADERBOARD_NO_RANK = 0/.test(readRepo("server/src/common/constants/leaderboard.ts")), "「没有名次」用 0 表示（客户端判 rank > 0）");
  check(/if \(previous === null \|\| score !== previous\) rank = index \+ 1/.test(serverService), "并列同分同名次（竞赛排名 1、2、2、4）");
  check(
    /left\.roleId < right\.roleId \? -1/.test(serverService),
    "同分二次键是 roleId 升序（两次重算之间同分者次序不抖）",
  );
  check(/leaderboard\/:board\/me/.test(serverController) === false && /@Get\(":board\/me"\)/.test(serverController), "me 路由声明在 :board 之前（否则会被通配吃掉）");
  check(/assertBoard\(board\)/.test(serverController), "非法榜走 assertBoard（40000 + 列出可选值）");
} catch (error) {
  console.log(`\n[!!] 脚本异常：${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
}

finish("PASS：排行榜（#400）");
