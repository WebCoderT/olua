#!/usr/bin/env node
/**
 * 公告（玩家侧展示）单测（client/tools/test-announcement.cjs）
 *
 * 盯的不变量（改公告展示后必须全绿）：
 * · 排序：重要在前，同级**保持服务端给的相对次序**（客户端不自造时间口径，见 configs/announcement）
 * · 未读标记：只由本地已读记录决定，读不到记录一律当未读
 * · 时间窗文案：null 分别读作「立即生效」「不设截止」，不折算成具体时间
 * · 登录页提醒：只取重要公告（不按已读过滤），没有重要公告就不弹
 * · 已读记录（真实读写）：脏数据兜底、只在「本次生效中的 id 全集」里保留、不重复堆积
 * · StorageManager.clear()：只清角色缓存 + 会话，**不连带清掉与账号无关的展示状态**
 * · 界面接线：登录页拉公告并挂弹窗、小地图「公告」入口 + 未读红点、无裸中文/裸资源路径
 *
 * 用法：node client/tools/test-announcement.cjs
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, check, finish, fail } = require("./lib/configs-sandbox.cjs");

let sandbox;
try {
  // 同一个沙箱里既编纯函数（configs/announcement）也编真实的已读记录（ui/core/AnnouncementReadStore）
  sandbox = require("./lib/storage-sandbox.cjs").prepareStorage("olua-announcement", [
    "ui/core/AnnouncementReadStore.ts",
    "configs/announcement.ts",
  ]);
} catch (error) {
  fail(`沙箱准备失败：${error.message}`);
  process.exitCode = 1;
}

if (sandbox) {
  const { StorageManager, outDir, shim, Session } = sandbox;
  const store = require(path.join(outDir, "ui/core/AnnouncementReadStore.js"));
  const AnnouncementReadStore = store.default ?? store;
  const announcement = require(path.join(outDir, "configs/announcement.js"));
  const { buildAnnouncementViews, countUnread, formatAnnouncementTime, formatAnnouncementWindow, getAnnouncementLevelTextKey, pickNoticeAnnouncements, sortAnnouncements } = announcement;
  const { getText } = require(path.join(outDir, "configs/texts.js"));

  const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");
  const loginSource = read("assets/ui/Login.ts");
  const smallMapSource = read("assets/ui/components/hud/SmallMap.ts");
  const boardSource = read("assets/ui/components/dialogs/AnnouncementBoardDialog.ts");
  const noticeSource = read("assets/ui/components/dialogs/AnnouncementNoticeDialog.ts");
  const storeSource = read("assets/ui/core/AnnouncementReadStore.ts");
  const storageSource = read("assets/ui/core/StorageManager.ts");
  const configSource = read("assets/configs/announcement.ts");
  const textsSource = read("assets/configs/texts.ts");
  const dialogsSource = read("assets/configs/layout/dialogs.ts");
  const hudSource = read("assets/configs/layout/hud.ts");
  /** 去掉注释后的源码（用来断言「代码里没有裸中文文案」） */
  const strip = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  /** 造一条公告（只给展示用到的字段，与服务端公共接口同口径） */
  function make(id, level, startsAt = null, endsAt = null) {
    return { id, title: `标题-${id}`, content: `正文-${id}`, level, startsAt, endsAt };
  }

  //#region A. 排序：重要在前，同级保持服务端次序

  console.log("\n— A. 排序（重要在前 / 同级保持服务端次序）—");
  {
    const list = [make("a", "normal"), make("b", "important"), make("c", "normal"), make("d", "important")];
    const sorted = sortAnnouncements(list);
    check(sorted.length === list.length, "排序不丢条目");
    check(sorted[0].id === "b" && sorted[1].id === "d", "两条重要公告排在最前，且保持它们原有的相对次序（b → d）");
    check(sorted[2].id === "a" && sorted[3].id === "c", "普通公告在后，同样保持原有相对次序（a → c）");
    check(list[0].id === "a", "不改动入参数组（返回的是新数组）");
    check(sortAnnouncements([]).length === 0, "空列表 → 空结果");
    // 未知级别按普通处理（服务端以后加级别时，客户端不应把它排到重要之前，也不该丢）
    const unknown = sortAnnouncements([make("u", "critical"), make("i", "important")]);
    check(unknown[0].id === "i", "未知级别不排到重要公告之前");
    check(unknown.length === 2, "未知级别的公告不会被丢掉");
    check(getAnnouncementLevelTextKey("critical") === getAnnouncementLevelTextKey("normal"), "未知级别的标签回落成普通");
  }

  //#endregion

  //#region B. 未读标记

  console.log("\n— B. 未读标记（只看本地已读记录）—");
  {
    const list = [make("a", "normal"), make("b", "important")];
    const allUnread = buildAnnouncementViews(list, []);
    check(allUnread.every((view) => view.unread), "没有已读记录时全部是未读");
    const partly = buildAnnouncementViews(list, ["a"]);
    check(partly.filter((view) => view.id === "a")[0].unread === false, "记录里的那条算已读");
    check(partly.filter((view) => view.id === "b")[0].unread === true, "没记录的那条仍是未读");
    check(
      buildAnnouncementViews(list, ["not-exist"]).every((view) => view.unread),
      "记录里有不存在的 id 不影响判定（不会把别的公告误标为已读）",
    );
    check(countUnread(allUnread) === 2 && countUnread(partly) === 1, "未读计数与逐条标记一致");
    check(countUnread(buildAnnouncementViews([], [])) === 0, "空列表未读数为 0");
  }

  //#endregion

  //#region C. 时间窗文案

  console.log("\n— C. 时间窗文案（null = 立即生效 / 不设截止）—");
  {
    const start = new Date(2026, 9, 9, 8, 5).getTime();
    const end = new Date(2026, 11, 31, 23, 59).getTime();
    check(formatAnnouncementTime(start) === "10-09 08:05", "时间点按 MM-DD HH:mm 与本地时区格式化（一位数补零）", formatAnnouncementTime(start));
    check(formatAnnouncementWindow(null, null) === "立即生效 → 长期有效", "两侧都为 null（两个名字分别是「立即生效」「不设截止」）", formatAnnouncementWindow(null, null));
    check(formatAnnouncementWindow(start, null) === "10-09 08:05 → 长期有效", "只设开始时间");
    check(formatAnnouncementWindow(null, end) === "立即生效 → 12-31 23:59", "只设结束时间");
    check(/^\d{2}-\d{2} \d{2}:\d{2} → \d{2}-\d{2} \d{2}:\d{2}$/.test(formatAnnouncementWindow(start, end)), "两侧都有时是「开始 → 结束」");
    const view = buildAnnouncementViews([make("a", "normal", null, null)], [])[0];
    check(view.timeText === "立即生效 → 长期有效", "渲染数据里的时间窗用的是同一套文案");
    check(!view.timeText.includes("{"), "时间窗文案没有残留未替换的占位符");
    check(getText(view.levelTextKey) !== view.levelTextKey, "级别标签的文案 key 已登记进 configs/texts", view.levelTextKey);
    const meta = getText("label_announcement_item_meta", { level: getText(view.levelTextKey), window: view.timeText });
    check(meta === "普通 · 立即生效 → 长期有效", "条目的第二行由配置模板拼出（级别 · 时间窗）", meta);
  }

  //#endregion

  //#region D. 登录页提醒：只取重要公告

  console.log("\n— D. 登录页提醒（只摊开重要公告）—");
  {
    const views = buildAnnouncementViews([make("a", "normal"), make("b", "important"), make("c", "important")], []);
    const notice = pickNoticeAnnouncements(views);
    check(notice.length === 2, "只取重要公告（两条）", `${notice.length} 条`);
    check(notice.every((view) => view.level === "important"), "取到的都是重要级别");
    check(pickNoticeAnnouncements(buildAnnouncementViews([make("a", "normal")], [])).length === 0, "只有普通公告时提醒列表为空（调用方据此不弹窗）");
    const readAll = buildAnnouncementViews([make("b", "important")], ["b"]);
    check(pickNoticeAnnouncements(readAll).length === 1, "已读过的重要公告**仍然**进提醒列表（登录页不看已读）");
  }

  //#endregion

  //#region E. 已读记录：真实读写（内存版 localStorage）

  console.log("\n— E. 已读记录（真实读写 + 脏数据兜底）—");
  {
    const KEY = "olua.announcementRead";
    shim.__memory.clear();
    check(Array.isArray(AnnouncementReadStore.getReadIds()) && AnnouncementReadStore.getReadIds().length === 0, "没有记录时返回空数组");

    AnnouncementReadStore.markRead(["a", "b"], ["a", "b", "c"]);
    check(JSON.parse(shim.__memory.get(KEY)).join(",") === "a,b", "标记已读写入本机（只写 id 列表）", shim.__memory.get(KEY));
    AnnouncementReadStore.markRead(["b", "c"], ["a", "b", "c"]);
    check(JSON.parse(shim.__memory.get(KEY)).join(",") === "a,b,c", "重复标记不产生重复项（幂等）");

    // 只在「本次生效中的 id 全集」里保留：公告过期后记录自然被丢掉，不会无限堆积
    AnnouncementReadStore.markRead(["z"], ["z"]);
    check(JSON.parse(shim.__memory.get(KEY)).join(",") === "z", "不在本次生效列表里的旧记录被丢掉（记录不会越积越多）");

    shim.__memory.set(KEY, "{坏掉的 json");
    check(AnnouncementReadStore.getReadIds().length === 0, "脏数据按「没读过」处理（不让一条坏记录干掉整个公告板）");
    shim.__memory.set(KEY, JSON.stringify({ a: 1 }));
    check(AnnouncementReadStore.getReadIds().length === 0, "存的不是数组时同样按没读过处理");
    shim.__memory.set(KEY, JSON.stringify([1, "a", null, "b"]));
    check(AnnouncementReadStore.getReadIds().join(",") === "a,b", "数组里混进非字符串时只保留字符串 id");
    shim.__memory.clear();
  }

  //#endregion

  //#region F. clear()：只清角色缓存与会话

  console.log("\n— F. StorageManager.clear()（不清与账号无关的展示状态）—");
  {
    shim.__memory.clear();
    shim.__memory.set("roles", "[]");
    shim.__memory.set("selectedRole", "r1");
    shim.__memory.set("olua.announcementRead", JSON.stringify(["a"]));
    const before = Session.cleared;
    StorageManager.clear();
    // 直接看垫片内存「键还在不在」：缺失键在 Map 上是 undefined（真实的 getItem 才折算成 null）
    check(!shim.__memory.has("roles"), "清掉角色缓存");
    check(!shim.__memory.has("selectedRole"), "清掉当前在线角色标记");
    check(Session.cleared === before + 1, "连带清会话（换账号不再串登录态）");
    check(shim.__memory.get("olua.announcementRead") === JSON.stringify(["a"]), "**保留**公告已读记录（它不是角色缓存，进登录页清缓存不该带走它）");
    check(!/localStorage\.clear\(\)/.test(strip(storageSource)), "clear() 不调 localStorage.clear()（那会连带抹掉所有本机键）");
    shim.__memory.clear();
  }

  //#endregion

  //#region G. 界面接线

  console.log("\n— G. 界面接线与配置 —");
  {
    // 登录页：拉公告并弹提醒
    check(/import AnnouncementNoticeDialog from "\.\/components\/dialogs\/AnnouncementNoticeDialog";/.test(loginSource), "登录场景引了公告提醒弹窗");
    check(/private announcementNotice = new AnnouncementNoticeDialog\(\);/.test(loginSource), "登录场景持有提醒弹窗实例");
    check(/this\.announcementNotice\.open\(this\.node\)/.test(loginSource), "登录页把公告提醒挂在本场景节点上（登录场景没有 UI 图层容器）");
    check(/void this\.announcementNotice\.open/.test(loginSource), "拉公告不阻塞登录页出现");

    // 游戏内：小地图「公告」入口 + 未读红点
    check(/import AnnouncementBoardDialog from "\.\.\/dialogs\/AnnouncementBoardDialog";/.test(smallMapSource), "小地图引了公告板弹窗");
    check(/icon === layout\.announcementEntry/.test(smallMapSource), "「公告」入口由配置指定（layout.announcementEntry）");
    check(/bindPointerAction\(button, \(\) => this\.openAnnouncementDialog\(\), this\)/.test(smallMapSource), "公告入口接线到公告板");
    check(/this\.announcementDialog\.open\(\)/.test(smallMapSource), "公告入口真的打开公告板");
    check(/this\.announcementDot = this\.createAnnouncementDot\(button\)/.test(smallMapSource), "公告入口上挂了未读红点节点");
    check(/AnnouncementApi\.active\(\{ silent: true \}\)/.test(smallMapSource), "进游戏探未读走静默请求（拉不到不弹提示）");
    check(/countUnread\(buildAnnouncementViews\(list, AnnouncementReadStore\.getReadIds\(\)\)\)/.test(smallMapSource), "未读红点用与公告板同一套口径（已读记录 + 渲染数据）");
    check(/this\.announcementDot\.active = unread > 0/.test(smallMapSource), "红点按未读数显隐");

    // 公告板：拉取 → 渲染 → 整批标已读 → 回调未读数
    check(/import \{ AnnouncementApi \} from "\.\.\/\.\.\/utils\/net\/Api";/.test(boardSource), "公告板走统一请求层（生成物里的 AnnouncementApi）");
    check(/AnnouncementApi\.active\(\{ silent: true \}\)/.test(boardSource), "公告拉取失败走静默（不弹全局提示）");
    check(/buildAnnouncementViews\(list, AnnouncementReadStore\.getReadIds\(\)\)/.test(boardSource), "渲染数据由 configs/announcement 组装");
    check(/this\.markAllRead\(views\)/.test(boardSource), "打开公告板即把这一批标为已读");
    check(
      boardSource.indexOf("views.forEach((view, index) => this.listContent.addChild(this.createItem(view, index)))") < boardSource.indexOf("this.markAllRead(views)"),
      "标记已读发生在**渲染之后**（本次打开仍看得到哪几条是新的）",
    );
    check(/AnnouncementReadStore\.markRead\(ids, ids\)/.test(boardSource), "已读落盘走 AnnouncementReadStore（不碰角色数据）");
    check(/this\.onUnreadChange\?\.\(0\)/.test(boardSource), "标已读后回调未读数（入口红点随即消失）");
    check(/blockClickThrough\(card\)/.test(boardSource), "手写的条目按钮在鼠标通道上补了命中拦截");
    check(/this\.bodyContent\.getComponent\(Layout\)\.updateLayout\(true\)/.test(boardSource), "切换公告先强制排版再滚回顶部（新正文高度要排版后才知道）");
    check(/this\.bodyScroll\.getComponent\(ScrollView\)\.scrollToTop\(0\)/.test(boardSource), "切换公告把正文滚回顶部");

    // 提醒弹窗：没有重要公告就不建节点
    check(/if \(views\.length === 0\) return;/.test(noticeSource), "没有重要公告时静默返回（不建节点、不遮屏）");
    check(/AnnouncementApi\.active\(\{ silent: true \}\)/.test(noticeSource), "登录页拉公告失败也静默");
    check(/buildAnnouncementViews\(list, \[\]\)/.test(noticeSource), "提醒弹窗不参与已读判定（传空记录）");
    check(/blockClickThrough\(dialog\)/.test(noticeSource) && /propagationStopped = true/.test(noticeSource), "提醒弹窗独占触摸：不穿透到下面的账号密码框");

    // 配置与文案：弹窗里没有裸中文 / 裸资源路径
    [["AnnouncementBoardDialog", boardSource], ["AnnouncementNoticeDialog", noticeSource], ["AnnouncementReadStore", storeSource], ["configs/announcement", configSource]].forEach(([name, source]) => {
      const code = strip(source);
      check(!/[\u4e00-\u9fa5]/.test(code), `${name} 里没有裸中文（文案全部走 configs/texts）`);
    });
    [["AnnouncementBoardDialog", boardSource], ["AnnouncementNoticeDialog", noticeSource]].forEach(([name, source]) => {
      const code = strip(source);
      check(!/["'`](common|main|buttons|tips|small-map|effect|mall)\//.test(code), `${name} 里没有裸资源路径（图片走 configs 的 uiImages）`);
      check(!/new Node\(["']/.test(code), `${name} 里没有裸节点名（节点名由配置派生）`);
    });

    // 文案 key 全部登记
    [
      "label_announcement_level_normal",
      "label_announcement_level_important",
      "label_announcement_immediate",
      "label_announcement_longterm",
      "label_announcement_window",
      "label_announcement_item_meta",
      "label_announcement_empty",
      "label_announcement_load_failed",
    ].forEach((key) => check(new RegExp(`^\\s*${key}:`, "m").test(textsSource), `configs/texts 登记了${key}`));

    // 布局配置块
    const boardBlock = dialogsSource.slice(dialogsSource.indexOf("export const announcementBoardDialogLayout"), dialogsSource.indexOf("//#endregion", dialogsSource.indexOf("export const announcementBoardDialogLayout")));
    check(boardBlock.length > 0, "能定位 announcementBoardDialogLayout 配置块");
    ["name", "title", "size", "list", "detail"].forEach((key) => check(new RegExp(`\\b${key}:`).test(boardBlock), `announcementBoardDialogLayout 配了 ${key}`));
    check(/itemSize: new Size\(268, 58\)/.test(boardBlock), "条目行高固定（正文在右栏，列表只扫标题）");
    check(/itemDot: \{ position: new Vec2\(-126, 13\)/.test(boardBlock), "未读圆点几何在配置里");
    check(/selectedFill: new Color\(70, 60, 44, 220\)/.test(boardBlock), "选中底色在配置里（Graphics 自绘）");
    check(/unreadTitleColor[\s\S]{0,200}readTitleColor[\s\S]{0,200}itemMetaColor/.test(boardBlock), "未读/已读/元信息三套文字颜色都在配置里");
    check(/body: \{ name: "announcement_body", fontSize: 13, lineHeight: 20, width: 364/.test(boardBlock), "正文宽度与行高在配置里（换行文本靠 lineHeight 撑高）");

    const noticeBlock = dialogsSource.slice(dialogsSource.indexOf("export const announcementNoticeDialogLayout"), dialogsSource.indexOf("//#endregion", dialogsSource.indexOf("export const announcementNoticeDialogLayout")));
    check(noticeBlock.length > 0, "能定位 announcementNoticeDialogLayout 配置块");
    ["name", "title", "maskColor", "panel", "titleLabel", "list", "item", "confirmButton"].forEach((key) => check(new RegExp(`\\b${key}:`).test(noticeBlock), `announcementNoticeDialogLayout 配了 ${key}`));
    check(/confirmButton: \{ name: "announcement_notice_confirm_button", text: "我知道了"/.test(noticeBlock), "「我知道了」的几何与文案都在配置里");
    check(/item: \{[\s\S]{0,400}itemGap: 22/.test(noticeBlock), "条目间距在配置里（提醒弹窗一条条纵向摊开）");

    // 小地图入口与红点
    check(/announcementEntry: "mail"/.test(hudSource), "公告入口指定为 small-map 的 mail 图标（素材已存在，不新增资源）");
    check(/entryIcons: \["world", "achievement", "mail", "config", "sound", "屏蔽 副本"\]/.test(hudSource), "mail 本来就在入口图标列表里");
    check(/announcementDot: \{ position: new Vec2\(9, 9\), size: new Size\(9, 9\) \}/.test(hudSource), "未读红点几何在配置里");
    check(fs.existsSync(path.join(PROJECT_ROOT, "assets/resources/small-map/mail.png")), "公告入口素材存在（resources/small-map/mail.png）");

    // 新增脚本都带 .meta（进 Cocos 工程的前提）
    [
      "assets/configs/announcement.ts.meta",
      "assets/ui/core/AnnouncementReadStore.ts.meta",
      "assets/ui/components/dialogs/AnnouncementBoardDialog.ts.meta",
      "assets/ui/components/dialogs/AnnouncementNoticeDialog.ts.meta",
    ].forEach((rel) => check(fs.existsSync(path.join(PROJECT_ROOT, rel)), `${rel} 已生成`));
  }

  //#endregion

  finish("PASS: 公告排序、未读标记、时间窗文案、已读记录与两端界面接线全部通过");
}
