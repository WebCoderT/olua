#!/usr/bin/env node
/**
 * 选服（客户端侧，#962）单测
 *
 * 盯的不变量（改登录 → 选角这条路之后必须全绿）：
 * · 登录页与区无关：不拉活区列表、没有区服文案、注册不带 zoneId
 * · 默认区优先级：本机记着的（还开放）→ 服务端当前区（还开放）→ 最新的开放区（id 最大）
 * · 选角页顺序：先对齐区、再拉角色（反了会拉到上一个区的角色）
 * · 选服弹窗：打开时**重拉** `/zones/mine`（状态会变）、维护 / 关闭的区本地就挡下、
 *   成功后先写本机记录再回调
 * · 单区服不给「点击切换」、点它也不开弹窗
 * · 换区之后：退出管理模式 + 清选中态 + 重拉列表（删除按钮指着旧区的角色 id 会误删）
 * · ZoneStore：脏数据当「没记录」、区名一起存（榜单 / 帮会标题要用）
 *
 * 用法：node client/tools/test-zone-select.cjs
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, check, finish, fail } = require("./lib/configs-sandbox.cjs");

let sandbox;
try {
  // ZoneStore 只依赖 cc 的 sys.localStorage：用与公告已读记录同一个沙箱，真实读写
  sandbox = require("./lib/storage-sandbox.cjs").prepareStorage("olua-zone-select", ["ui/core/ZoneStore.ts"]);
} catch (error) {
  fail(`沙箱准备失败：${error.message}`);
  process.exitCode = 1;
}

if (sandbox) {
  const { outDir, shim } = sandbox;
  /** 沙箱的内存 localStorage（直接核对「到底写了什么」，而不是从业务接口倒推） */
  const ls = shim.sys.localStorage;
  const store = require(path.join(outDir, "ui/core/ZoneStore.js"));
  const ZoneStore = store.default ?? store;

  const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");
  const loginSource = read("assets/ui/Login.ts");
  const selectorSource = read("assets/ui/RoleSelector.ts");
  const dialogSource = read("assets/ui/components/dialogs/ZoneSelectDialog.ts");
  const storeSource = read("assets/ui/core/ZoneStore.ts");
  const leaderboardSource = read("assets/ui/components/dialogs/LeaderboardDialog.ts");
  const guildSource = read("assets/ui/components/dialogs/GuildPanel.ts");
  const textsSource = read("assets/configs/texts.ts");
  const scenesSource = read("assets/configs/layout/scenes.ts");
  const dialogsLayoutSource = read("assets/configs/layout/dialogs.ts");
  /** 去掉注释后的源码（用来断言「代码里没有裸中文文案」） */
  const strip = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  console.log("\n== 一、ZoneStore：本机记着的选区（真实读写） ==");
  {
    // 每个断言前先清干净，避免前一条留下的记录影响下一条
    ls.removeItem("olua.zone");

    check(ZoneStore.get() === null, "没记录时返回 null（调用方回落到最新区，而不是拿到一个假区）");

    ZoneStore.set(2, "二区");
    const saved = ZoneStore.get();
    check(!!saved && saved.id === 2 && saved.name === "二区", "set 之后 get 拿到 id 与区名（区名一起存：榜单/帮会标题要用）");
    check(ZoneStore.currentName() === "二区", "currentName 直接给区名");

    // 脏数据：id 不是数字 → 当没记录（宁可回落到最新区，也不要拿坏记录去请求）
    ls.setItem("olua.zone", JSON.stringify({ id: "2", name: "二区" }));
    check(ZoneStore.get() === null, "id 是字符串的脏记录当没记录");
    ls.setItem("olua.zone", "{不是 json");
    check(ZoneStore.get() === null, "坏 JSON 当没记录（不抛异常）");

    // 覆盖写：换区就是覆盖同一条记录
    ZoneStore.set(1, "一区");
    check(ZoneStore.get().id === 1 && ZoneStore.currentName() === "一区", "再选一次就覆盖（本机只留一条，不做历史）");
    ls.removeItem("olua.zone");
  }

  console.log("\n== 二、登录页：与区无关（选服整体搬到选角页） ==");
  {
    const login = strip(loginSource);
    check(!/ZoneApi/.test(login), "Login 不再调任何区接口（登录前不知道账号有哪几个区）");
    check(!/zoneSelector|cycleZone|loadZones|zoneLabel/.test(login), "Login 不再有区服节点 / 循环切换 / 活区列表拉取");
    check(
      /AuthApi\.register\(\{ username: credentials\.username, password: credentials\.password \}\)/.test(login),
      "注册只发账号密码（不带 zoneId —— 区是角色的属性）",
    );
    check(!/login_zone_/.test(textsSource), "texts 里那四条登录页区服文案已删干净（没人再引用）");
  }

  console.log("\n== 三、选角页：先对齐区、再拉角色 ==");
  {
    const selector = strip(selectorSource);
    const bootstrap = /private async bootstrap\(\) \{([\s\S]*?)\n  \}/.exec(selector);
    check(!!bootstrap, "有 bootstrap（进场景的第一步）");
    const body = bootstrap ? bootstrap[1] : "";
    check(
      body.indexOf("await this.ensureZone()") >= 0 &&
        body.indexOf("await this.ensureZone()") < body.indexOf("await this.loadRoles()"),
      "bootstrap 里 ensureZone 在 loadRoles 之前（区不对，GET /roles 拉回来的是另一组角色）",
    );
    const startBody = /\n  start\(\) \{([\s\S]*?)\n  \}/.exec(selector);
    check(
      !!startBody && /void this\.bootstrap\(\)/.test(startBody[1]) && !/this\.loadRoles\(\)/.test(startBody[1]),
      "start 只调 bootstrap，不再直接 loadRoles",
    );

    // 默认区优先级的三个分支（顺序就是语义：先认本机记录，再认服务端，最后才挑最新）
    const pick = /private pickDefaultZone\(zones: MyZone\[\]\): MyZone \| null \{([\s\S]*?)\n  \}/.exec(selector);
    check(!!pick, "有 pickDefaultZone（默认区挑法集中一处）");
    const pickBody = pick ? pick[1] : "";
    const iRemembered = pickBody.indexOf("rememberedHit");
    const iCurrent = pickBody.indexOf("currentHit");
    const iNewest = pickBody.indexOf("open.reduce");
    check(
      iRemembered >= 0 && iRemembered < iCurrent && iCurrent < iNewest,
      "默认区优先级：本机记录 → 服务端当前区 → 最新的开放区（id 最大）",
    );
    check(/zone\.status === "open"/.test(pickBody), "三个分支都只在「还开放」的区里挑（维护/关闭的区不该成为默认落点）");

    check(/ZoneApi\.mine\(\)/.test(selector), "选角页拉 GET /zones/mine（current / roleCount / status 都来自它）");
    check(/ZoneApi\.select\(\{ zoneId: target\.id \}\)/.test(selector), "默认区与服务端不一致时 POST /zones/select");
    check(/ZoneStore\.set\(target\.id, target\.name\)/.test(selector), "对齐成功后写本机记录（下次打开仍停在它）");
    check(
      /拉不到列表不阻塞/.test(selectorSource) || /zone_load_failed_tip/.test(selector),
      "拉不到列表不阻塞进游戏（只提示一句，按服务端记着的区继续）",
    );
  }

  console.log("\n== 四、选角页：顶部区名与打开弹窗 ==");
  {
    const selector = strip(selectorSource);
    check(/zoneLabel/.test(scenesSource) && /role_selector_zone/.test(scenesSource), "布局配置里有区服文案节点（舞台顶部居中）");
    check(/zone_switch_label/.test(selector) && /zone_current_label/.test(selector), "两个及以上活区才写「（点击切换）」，单区服写不带动作的那句");
    check(
      /private async openZonePicker\(\) \{\s*\n\s*if \(this\.zoneCount < 2 \|\| !this\.stage\) return;/.test(selector),
      "单区服点它不开弹窗（弹出来也只有它自己）",
    );
    check(/this\.zoneDialog\.open\(this\.node, \(zone\) => this\.onZonePicked\(zone\)\)/.test(selector), "点区名 → 打开选服弹窗，选完回调 onZonePicked");

    // 换区之后必须做的事：删除按钮挂钩角色 id，留着会对着旧区的 id 发删除
    const picked = /private onZonePicked\(zone: MyZone\) \{([\s\S]*?)\n  \}/.exec(selector);
    check(!!picked, "有 onZonePicked（换区之后统一收口）");
    const pickedBody = picked ? picked[1] : "";
    check(/this\.manageMode = false/.test(pickedBody) && /this\.clearManageNodes\(\)/.test(pickedBody), "换区退出管理模式并清掉删除按钮（它们指着旧区的角色 id）");
    check(/this\.clearSelectedRole\(\)/.test(pickedBody), "换区清掉选中态（底部「角色 ---」、开始游戏置灰）");
    check(/void this\.loadRoles\(\)/.test(pickedBody), "换区后按新区重拉角色列表");
    check(/this\.roleSummaries = \[\]/.test(pickedBody), "换区先把旧角色列表清空（否则底部还挂着上一个区的角色名）");
  }

  console.log("\n== 五、选服弹窗：重拉、挡下不可进的区、先落本机再回调 ==");
  {
    const dialog = strip(dialogSource);
    check(/zones = await ZoneApi\.mine\(\)/.test(dialog), "每次打开都重拉 /zones/mine（运营刚改过状态，缓存会骗人）");
    check(!/silent: true/.test(dialog), "拉列表不静默（拉不到要让玩家知道，静默会让人以为点坏了）");
    check(
      /if \(zone\.status !== "open"\) \{[\s\S]{0,220}?zone_unavailable_tip/.test(dialog) ||
        /zone\.status !== "open"[\s\S]{0,260}?zone_closed_tip/.test(dialog),
      "维护 / 关闭的区本地就挡下并给提示（不浪费一次往返，也不静默）",
    );
    check(/await ZoneApi\.select\(\{ zoneId: zone\.id \}\)/.test(dialog), "点可进的区 → POST /zones/select");
    const selectIdx = dialog.indexOf("await ZoneApi.select(");
    const storeIdx = dialog.indexOf("ZoneStore.set(zone.id, zone.name)");
    const callbackIdx = dialog.indexOf("onPicked?.(zone)");
    check(selectIdx >= 0 && storeIdx > selectIdx && callbackIdx > storeIdx, "顺序：服务端 select 成功 → 写本机记录 → 回调刷新（服务端是权威）");
    check(/zone\.current/.test(dialog), "当前区高亮（描边 + 「上次在」角标）");
    check(/zone\.recommended/.test(dialog), "推荐区有角标（recommended 由 P5 落在库里、P6 补进玩家侧 DTO）");
    check(/zone\.roleCount > 0/.test(dialog), "行内显示「我在这个区有几个角色」（0 时另给一条文案）");
    check(/if \(this\.dialog && isValid\(this\.dialog\)\) return;/.test(dialog), "已经开着就不再叠一个（连点顶部那颗区名）");
  }

  console.log("\n== 六、榜单 / 帮会：标题带区名 ==");
  {
    const board = strip(leaderboardSource);
    const guild = strip(guildSource);
    check(/ZoneStore\.currentName\(\)/.test(board) && /zone_title_prefix/.test(board), "排行榜小结前挂区名（榜是按区的，不写会以为是全服）");
    check(/ZoneStore\.currentName\(\)/.test(guild) && /zone_title_prefix/.test(guild), "帮会列表标题前挂区名");
    check(!/ZoneStore\.currentName\(\)/.test(strip(loginSource)), "登录页不读 ZoneStore（登录页与区无关）");
  }

  console.log("\n== 七、文案与布局：全部走 configs，代码里没有裸中文 ==");
  {
    const keys = [
      "zone_current_label",
      "zone_switch_label",
      "zone_select_title",
      "zone_select_hint",
      "zone_role_count",
      "zone_role_count_empty",
      "zone_tag_current",
      "zone_tag_recommended",
      "zone_status_maintenance",
      "zone_status_closed",
      "zone_unavailable_tip",
      "zone_closed_tip",
      "zone_switched_tip",
      "zone_load_failed_tip",
      "zone_title_prefix",
    ];
    const missing = keys.filter((key) => !new RegExp(`\\b${key}:`).test(textsSource));
    check(missing.length === 0, `区名相关文案 ${keys.length} 条都在 configs/texts`, missing.length ? `缺：${missing.join("、")}` : "");

    // ui/ 里不写面向玩家的中文（注释与 console 日志先剥掉：前者不进构建，后者是给开发者看的）
    const CJK = /[\u4e00-\u9fa5]/;
    const noLog = (source) => strip(source).replace(/console\.(warn|error|log|info)\([\s\S]*?\);/g, "");
    const withCjk = [
      ["ZoneSelectDialog", dialogSource],
      ["RoleSelector", selectorSource],
      ["Login", loginSource],
    ].filter(([, source]) => CJK.test(noLog(source)));
    check(withCjk.length === 0, "ui/ 里没有裸中文文案（全部走 configs/texts）", withCjk.length ? `命中：${withCjk.map(([n]) => n).join("、")}` : "");

    check(/export const zoneSelectLayout/.test(dialogsLayoutSource), "选服弹窗的几何 / 配色在 configs/layout/dialogs（组件里不写坐标）");
    check(/panel: \{ name: "zone_select_panel", size: new Size\(560, 500\) \}/.test(dialogsLayoutSource), "面板尺寸在配置里");
    check(
      !/new (Size|Vec2|Color)\(\s*-?\d/.test(strip(dialogSource)),
      "弹窗组件里不出现硬编码的坐标 / 尺寸 / 色值（数值全部来自配置，传进去的只是 row.* 字段）",
    );
  }

  console.log("\n== 八、文件与生成物 ==");
  {
    const files = [
      "assets/ui/components/dialogs/ZoneSelectDialog.ts",
      "assets/ui/core/ZoneStore.ts",
    ];
    const missingMeta = files.filter((rel) => !fs.existsSync(path.join(PROJECT_ROOT, rel + ".meta")));
    check(missingMeta.length === 0, "新脚本都带 Cocos .meta（没有 meta 引擎不认）", missingMeta.length ? `缺：${missingMeta.join("、")}` : "");
    check(fs.existsSync(path.join(PROJECT_ROOT, "assets/ui/components/dialogs/ZoneSelectDialog.ts")), "选服弹窗文件在 dialogs 目录下");
  }

  finish("选服（客户端）");
}
