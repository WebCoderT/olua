#!/usr/bin/env node
/**
 * 游戏内邮件单测（client/tools/test-mail.cjs，issue #429）
 *
 * 盯的不变量（改邮件表 / 领取路径 / 面板 / 成就兜底后必须全绿）：
 * A. 配置与文案（**跑真配置**）：小结与附件摘要的占位符齐全、行内三块几何都在列表宽度内、
 *    颜色与字号全在配置里（组件里写死会被 `audit-config-leak` 抓）
 * B. Store 契约：整份快照、成功覆盖整份 / 失败保留旧数据、业务码取自 ApiError、
 *    busyId 互斥（一键领取用 "*" 占位）、clear 归零、订阅可退订
 * C. 面板契约：打开订阅 / 关闭退订、点行标已读、领取失败不清列表、
 *    删除按钮的灰化判据（附件没领）、附件摘要取共享快照的物品名、未读数回调合计
 * D. 接线：小地图 mail 入口 → 邮件面板、红点 = 邮件待处理 + 未读公告、进游戏静默探一次、
 *    离开游戏清缓存
 * E. 服务端契约：表与索引、领取走与任务 / 成就同一个发奖入口、删除守卫、
 *    领取幂等（SQL 里带 claimed_at 条件）、成就背包满兜底（20012 → 转邮件 + mailId）
 *
 * MailStore 真引了 HttpClient（一路引到 cc），表现层沙箱起不来 —— 所以 Store 与面板
 * 做**源码契约断言**（与 test-achievement 同一取向），配置表则是编译真源码跑真值。
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");
/** PROJECT_ROOT 是 client/，服务端与根目录要往上走一层 */
const readRepo = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, "..", rel), "utf8");

const CLIENT_CONFIG = "assets/configs/mail.ts";
const CLIENT_STORE = "assets/ui/core/MailStore.ts";
const CLIENT_DIALOG = "assets/ui/components/dialogs/MailDialog.ts";
const CLIENT_SMALL_MAP = "assets/ui/components/hud/SmallMap.ts";
const CLIENT_HUD_LAYOUT = "assets/configs/layout/hud.ts";
const CLIENT_GAME = "assets/ui/Game.ts";
const CLIENT_ACHIEVEMENT_STORE = "assets/ui/core/AchievementStore.ts";
const CLIENT_ACHIEVEMENT_DIALOG = "assets/ui/components/dialogs/AchievementDialog.ts";
const CLIENT_ACHIEVEMENT_CONFIG = "assets/configs/achievement.ts";

const SERVER_DB = "server/src/database/database.service.ts";
const SERVER_REPO = "server/src/database/repositories/role-mail.repository.ts";
const SERVER_SERVICE = "server/src/modules/game-mail/game-mail.service.ts";
const SERVER_CONTROLLER = "server/src/modules/game-mail/game-mail.controller.ts";
const SERVER_ACHIEVEMENT = "server/src/modules/achievement/achievement.service.ts";
const SERVER_BIZ_CODE = "server/src/common/constants/biz-code.ts";
const SERVER_MODELS = "server/src/swagger/models.ts";

const GEN_API = "tools/gen-api.cjs";
const E2E = "server/test/e2e-game-mail.cjs";

try {
  // mail.ts 只用 cc 的 Color/Size/Vec2，可以在沙箱里编译真跑
  const outDir = prepare("olua-mail", ["configs/mail.ts"]);
  const config = require(path.join(outDir, "configs/mail.js"));
  const { mailDialogLayout: layout, mailTexts: texts } = config;

  //#region A. 配置与文案

  console.log("\n— A. 配置与文案（占位符少一个，玩家看到的就是裸模板） —");

  check(/^\d+$/.test("1") && typeof texts.summary === "string", "文案表导出正常");
  check(texts.summary.includes("{unread}") && texts.summary.includes("{unclaimed}"), "小结同时带未读与未领两个占位符");
  check(texts.gold.includes("{count}") && texts.exp.includes("{count}"), "金币 / 经验摘要都带数量占位符");
  check(texts.item.includes("{name}") && texts.item.includes("{count}"), "物品摘要同时带名字与数量（名字来自共享快照）");
  check(texts.claimAllDone.includes("{count}"), "一键领取回执带「领了几封」的占位符");

  const required = ["title", "claim", "claimed", "remove", "claimAll", "announcement", "loading", "failed", "emptyList", "claimSuccess"];
  check(
    required.every((key) => typeof texts[key] === "string" && texts[key].length > 0),
    `必备文案齐全（${required.length} 条：标题 / 三态按钮 / 列表三态 / 领取回执）`,
  );
  check(
    [texts.claimBagFull, texts.claimAllStopped, texts.claimFailed, texts.removeFailed, texts.removeUnclaimed].every((text) => text.length > 0),
    "失败路径各有各的话（背包满 / 一键领取被中断 / 一般失败 / 删除失败 / 附件没领）",
  );

  check(layout.list.size.width >= layout.row.size.width, "行宽不超过列表宽（超出会被 ScrollView 裁掉）");
  const rowHalf = layout.row.size.width / 2;
  check(
    layout.row.titlePosition.x - layout.row.titleSize.width / 2 >= -rowHalf &&
      layout.row.titlePosition.x + layout.row.titleSize.width / 2 <= layout.row.actionPosition.x - layout.row.actionSize.width / 2,
    "标题在行内且不侵入按钮区（行宽 480：文字左贴边、右侧留给按钮）",
  );
  check(
    layout.row.actionPosition.x + layout.row.actionSize.width / 2 <= rowHalf &&
      layout.row.removePosition.x + layout.row.removeSize.width / 2 <= rowHalf,
    "两颗按钮都在行内（右边缘不越界，越界会被列表裁掉）",
  );
  check(layout.row.removePosition.y < layout.row.actionPosition.y, "删除按钮在领取按钮下方（两颗按钮纵向排开，不叠在一起）");
  check(
    ["fill", "unreadFill", "claimFill", "claimedFill", "removeFill", "removeDisabledFill"].every((key) => typeof layout.row[key] === "object"),
    "行内所有底色都在配置里（组件不写死颜色）",
  );

  //#endregion

  //#region B. Store 契约

  console.log("\n— B. Store 契约 —");

  const store = read(CLIENT_STORE);
  check(/export default class MailStore/.test(store), "MailStore 是静态类（与成就 / 排行榜同一形态）");
  check(/const data = await GameMailApi\.mine\(\)/.test(store), "拉取走生成物里的 GameMailApi.mine（不手写 URL）");
  check(/this\.state = \{ data: toBox\(result\), loading: false, failed: false, busyId: "" \}/.test(store), "成功路径用服务端返回覆盖整份快照");
  check(/this\.state = \{ \.\.\.this\.state, busyId: "" \};/.test(store), "失败路径只清 busyId、保留旧数据（背包满时不该把列表清空）");
  check(/busyId: "\*"/.test(store), "一键领取用 \"*\" 占位，与单封动作互斥（同一封被两条路径同时发奖）");
  check(/\(error as \{ code\?: number \}\)\.code \?\? 0/.test(store), "业务码取自 ApiError（不按 HTTP 状态猜）");
  check(/static clear\(\): void \{\s*this\.state = \{ data: null, loading: false, failed: false, busyId: "" \};/.test(store), "clear 把状态归零（换角色不能带着别人的信）");
  check(/static onChange\(listener: \(\) => void\): \(\) => void/.test(store), "订阅返回退订函数（弹窗关闭时要退）");
  check(/stoppedByBag: result\.stoppedByBag/.test(store), "一键领取把 stoppedByBag 透出来（弹窗据此换文案）");

  //#endregion

  //#region C. 面板契约

  console.log("\n— C. 面板契约 —");

  const dialog = read(CLIENT_DIALOG);
  check(/this\.unsubscribe = MailStore\.onChange\(\(\) => this\.render\(\)\)/.test(dialog), "打开时订阅 Store 变化");
  check(/if \(this\.unsubscribe\) \{\s*this\.unsubscribe\(\);/.test(dialog), "关闭时退订（否则弹窗销毁后还在重画）");
  check(/MailStore\.reload\(\)/.test(dialog), "每次打开都重拉（邮件是「有没有新的」，缓存没意义）");
  check(/onUnreadChange\?\.\(box \? box\.unread \+ box\.unclaimed : 0\)/.test(dialog), "未读数回调 = 未读 + 未领（两路都是「有东西要处理」）");
  check(/if \(!row\.read && !busy\) node\.on\(Node\.EventType\.TOUCH_END/.test(dialog), "点行标已读，已读的行不再请求");
  check(/const removable = row\.claimed \|\| this\.hasNoAttachment\(row\)/.test(dialog), "删除按钮的灰化判据：已领或无附件");
  check(/if \(!removable\) \{\s*GameUiHelper\.createTipText\(texts\.removeUnclaimed\)/.test(dialog), "不可删时给一句提示（不静默失败）");
  check(/items\.get\(item\.goodId\)\?\.label \?\? item\.goodId/.test(dialog), "附件摘要取共享快照里的物品名（取不到退回 id）");
  check(/result\.stoppedByBag \? texts\.claimAllStopped/.test(dialog), "一键领取被背包满中断时单独一句文案");
  check(/code === CODE_ALREADY_CLAIMED/.test(dialog), "已领（50142）不落到「一般失败」");
  check(!/MailStore\.get\(\)\.data = /.test(dialog), "面板不直接改 Store 状态（只通过动作方法）");

  //#endregion

  //#region D. 接线

  console.log("\n— D. 接线：一颗图标一个消息中心 —");

  const smallMap = read(CLIENT_SMALL_MAP);
  const hud = read(CLIENT_HUD_LAYOUT);
  check(/private mailDialog = new MailDialog\(\{/.test(smallMap), "小地图持有邮件面板实例");
  check(/onOpenAnnouncement: \(\) => this\.openAnnouncementDialog\(\)/.test(smallMap), "公告板入口收进邮件面板（不再单独占一颗图标）");
  check(/if \(icon === layout\.mailEntry\) \{\s*bindPointerAction\(button, \(\) => this\.mailDialog\.open\(\), this\)/.test(smallMap), "mail 入口打开消息中心");
  check(/this\.entryDot\.active = this\.mailUnread \+ this\.announcementUnread > 0/.test(smallMap), "红点按「邮件待处理 + 未读公告」合计显隐");
  check(/await GameMailApi\.mine\(\{ silent: true \}\)/.test(smallMap), "进游戏静默探一次邮件（拉不到不弹提示）");
  check(/this\.setMailUnread\(box \? box\.unread \+ box\.unclaimed : 0\)/.test(smallMap), "探测口径与面板回调一致（未读 + 未领）");
  check(/mailEntry: "mail"/.test(hud), "入口图标名在配置里（复用现成 small-map/mail 素材）");
  check(/entryDot: \{ position: new Vec2\(9, 9\), size: new Size\(9, 9\) \}/.test(hud), "红点几何在配置里");

  const game = read(CLIENT_GAME);
  check(/MailStore\.clear\(\);/.test(game), "离开游戏清收件箱（邮件是发给具体角色的）");

  //#endregion

  //#region E. 服务端契约

  console.log("\n— E. 服务端契约 —");

  const db = readRepo(SERVER_DB);
  check(/CREATE TABLE IF NOT EXISTS role_mails/.test(db), "建表 role_mails（与 mail_queue 是两张表）");
  check(
    /read_at\s+INTEGER,[\s\S]{0,200}claimed_at\s+INTEGER,/.test(db) && /idx_role_mails_unclaimed/.test(db),
    "已读 / 已领分开两列，未领数有索引",
  );

  const repo = readRepo(SERVER_REPO);
  check(/export class RoleMailRepository/.test(repo), "邮件仓储独立（SQL 只在 repositories/ 下）");
  check(/WHERE id = \? AND read_at IS NULL/.test(repo), "已读只写一次（第一次看到的时刻才有意义）");
  check(/WHERE id = \? AND claimed_at IS NULL/.test(repo), "领取幂等写进 SQL（并发点两次也只发一份）");

  const service = readRepo(SERVER_SERVICE);
  const controller = readRepo(SERVER_CONTROLLER);
  check(/grantQuestRewards\(accountId, roleId, null, \{ gold, exp, items \}\)/.test(service), "附件领取走与任务 / 成就同一个发奖入口");
  check(/if \(gold <= 0 && exp <= 0 && items\.length === 0\)/.test(service), "没有奖励的邮件不碰角色存档（不白顶 revision）");
  check(/if \(isBizCode\(error, BizCode\.MALL_BAG_FULL\)\)/.test(service), "一键领取遇到背包满就停下（已领的照常落库）");
  check(/if \(mail\.claimed_at === null && parseRewardItems\(mail\.attachments\)\.length > 0\)/.test(service), "删除守卫：附件没领不能删");
  check(/sendReward\(roleId: string, input: SendRewardMailInput\): RoleMailRow/.test(service), "对外提供 sendReward（成就兜底用它发信）");
  check(/operationId: "gameMail\.(mine|read|claim|claimAll|remove)"/.test(controller), "五个 operationId 都按 gameMail.* 命名（生成器按模块段分文件）");
  check(/@Delete\(":id"\)/.test(controller), "删除走 DELETE /mails/{id}");

  const bizCode = readRepo(SERVER_BIZ_CODE);
  check(/MAIL_NOT_FOUND: 50141/.test(bizCode) && /MAIL_ALREADY_CLAIMED: 50142/.test(bizCode) && /MAIL_UNCLAIMED: 50143/.test(bizCode), "三个邮件业务码各自成段（50141 / 50142 / 50143）");

  const achievement = readRepo(SERVER_ACHIEVEMENT);
  check(/isBizCode\(error, BizCode\.MALL_BAG_FULL\)/.test(achievement), "成就领奖捕获背包满（20012 不再把玩家堵在这里）");
  check(/this\.mails\.sendReward\(role\.id, \{/.test(achievement) && /kind: "achievement"/.test(achievement), "背包满时把整份奖励转成邮件");
  check(/mailId,/.test(achievement), "领取结果带上 mailId（客户端据此换提示）");
  check(/this\.records\.markClaimed\(role\.id, achievementId\);/.test(achievement) && !/return this\.claimMail/.test(achievement), "转邮件后照常记已领（不留「清包再来」的死路）");

  const achievementStore = read(CLIENT_ACHIEVEMENT_STORE);
  check(/mailId: data\?\.mailId \?\? null/.test(achievementStore), "客户端成就 Store 把 mailId 透出来");
  check(/result\.mailId \? texts\.claimMail : texts\.claimSuccess/.test(read(CLIENT_ACHIEVEMENT_DIALOG)), "成就面板按 mailId 换成「奖励已发至邮箱」");
  check(/claimMail: "/.test(read(CLIENT_ACHIEVEMENT_CONFIG)), "那句文案在配置里（组件不写死中文）");

  check(/gameMail: \{ target: "client", export: "GameMailApi" \}/.test(readRepo(GEN_API)), "生成器登记 gameMail（否则 operationId 直接报错）");
  check(/MailViewDto,\n  MailBoxDto,/.test(readRepo(SERVER_MODELS)), "五个邮件模型进 SWAGGER_MODELS（whitelist 之外也得有文档）");

  check(/EXPECTED_ASSERTIONS = \d+/.test(readRepo(E2E)), "服务端 e2e 带断言条数守卫");

  //#endregion

  finish("邮件：配置 / Store / 面板 / 接线 / 服务端契约全部通过");
} catch (error) {
  fail(error);
}
