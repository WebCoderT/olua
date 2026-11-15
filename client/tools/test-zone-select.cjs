#!/usr/bin/env node
/**
 * 区服（客户端侧，#962 / #1009）单测
 *
 * 盯的不变量（改登录 → 选角这条路之后必须全绿）：
 * · 登录页就定区：拉公共活区列表 `GET /zones`（登录前没有令牌，不碰 `/zones/mine`）
 * · 默认区优先级：本机记着的（还开放）→ 运营推荐（还开放）→ 最新的开放区（id 最大）
 * · 登录后顺序：存会话 → 按所选区 `POST /zones/select` → 进选角页（早一步拉到的是旧区的角色）
 * · select 失败不挡进游戏：重拉列表换个还能进的区并飘字，换不了就按服务端记着的区继续
 * · 选角页不再碰区：没有区服节点 / 选服弹窗 / ensureZone，进场景直接拉角色
 * · 选服弹窗：数据源是公共 `list`、不可进的区本地挡下、选完只写本机（不假装切成功）
 * · 单区服不给「点击切换」、点它也不开弹窗
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
  const leaderboardSource = read("assets/ui/components/dialogs/LeaderboardDialog.ts");
  const guildSource = read("assets/ui/components/dialogs/GuildPanel.ts");
  const textsSource = read("assets/configs/texts.ts");
  const scenesSource = read("assets/configs/layout/scenes.ts");
  const dialogsLayoutSource = read("assets/configs/layout/dialogs.ts");
  /** 去掉注释后的源码（用来断言「代码里没有裸中文文案」与「没有再调某个接口」） */
  const strip = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  const login = strip(loginSource);
  const selector = strip(selectorSource);
  const dialog = strip(dialogSource);

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

  console.log("\n== 二、登录页：进页面就把区定下来 ==");
  {
    // 数据源：登录前没有令牌，只能拿公共活区列表
    check(/ZoneApi\.list\(\)/.test(login), "登录页拉公共活区列表 GET /zones（区名 / 状态 / 推荐）");
    check(!/ZoneApi\.mine\(\)/.test(login), "不调 /zones/mine（登录前没有令牌，会 401）");
    check(/void this\.loadZones\(\)/.test(login), "进页面就拉列表（不 await：区服不该拖慢登录页出现）");

    const load = /private async loadZones\(\): Promise<void> \{([\s\S]*?)\n  \}/.exec(login);
    check(!!load, "有 loadZones（拉列表 → 选默认区 → 刷新区名，集中一处）");
    const loadBody = load ? load[1] : "";
    check(/zone_load_failed_tip/.test(loadBody), "拉不到列表只提示一句，不阻塞登录");
    check(/ZoneStore\.set\(target\.id, target\.name\)/.test(loadBody), "默认区写进本机记录（下次进登录页仍停在它）");
    check(/this\.renderServerButton\(\)/.test(loadBody), "选完刷新面板里的选服按钮（区名 / 状态字）");
    check(/this\.zoneCount = zones\.length/.test(loadBody), "记下活区数（决定选服按钮响不响应点击）");

    // 默认区优先级的三个分支（顺序就是语义：先认本机记录，再认运营推荐，最后才挑最新）
    const pick = /private pickDefaultZone\(zones: Zone\[\]\): Zone \| null \{([\s\S]*?)\n  \}/.exec(login);
    check(!!pick, "有 pickDefaultZone（默认区挑法集中一处）");
    const pickBody = pick ? pick[1] : "";
    const iRemembered = pickBody.indexOf("rememberedHit");
    const iRecommended = pickBody.indexOf("recommended");
    const iNewest = pickBody.indexOf("open.reduce");
    check(
      iRemembered >= 0 && iRemembered < iRecommended && iRecommended < iNewest,
      "默认区优先级：本机记录 → 运营推荐 → 最新的开放区（id 最大）",
    );
    check(/zone\.status === "open"/.test(pickBody), "三个分支都只在「还开放」的区里挑（维护/关闭的区不该成为默认落点）");

    check(/zone_status_open/.test(login) && /zone_status_maintenance/.test(login), "选服按钮按区状态写字（开放中 / 维护中，文案走 configs/texts）");
    check(
      /private async openZonePicker\(\): Promise<void> \{\s*\n\s*if \(this\.zoneCount < 2\) return;/.test(login),
      "单区服点它不开弹窗（弹出来也只有它自己）",
    );
    check(/this\.zoneDialog\.open\(this\.node, this\.pickedZone\?\.id \?\? null/.test(login), "点区名 → 打开选服弹窗，并把当前选中的区传进去（高亮「上次在」）");

    // 登录页的选服按钮是可点节点：走 bindClick 统一接线（点击音 + 鼠标通道拦截防穿透），静态审计也守这条
    check(/this\.bindClick\(serverButton/.test(login), "选服按钮走 bindClick 统一接线（blockClickThrough 防穿透到账号输入框）");
    check(/panel\.server/.test(login) && /login_server_button/.test(scenesSource), "选服按钮的几何 / 文案位置在 loginLayout.panel.server（#1036 整版布局）");
  }

  console.log("\n== 三、登录后：先落区、再进选角 ==");
  {
    const submit = /private async submit\(action: \(\) => Promise<AuthResult>\) \{([\s\S]*?)\n  \}/.exec(login);
    check(!!submit, "有 submit（登录与注册共用一条路）");
    const body = submit ? submit[1] : "";
    const iSave = body.indexOf("Session.save(");
    const iZone = body.indexOf("await this.applyZone()");
    const iScene = body.indexOf('loadScene("RoleSelector")');
    check(
      iSave >= 0 && iZone > iSave && iScene > iZone,
      "顺序：存会话 → applyZone（POST /zones/select）→ 进选角页（区没落地就拉，拿到的是另一个区的角色）",
    );

    const apply = /private async applyZone\(\): Promise<boolean> \{([\s\S]*?)\n  \}/.exec(login);
    check(!!apply, "有 applyZone（登录后把所选区落到服务端，返回「有没有换兜底区」）");
    const applyBody = apply ? apply[1] : "";
    check(/await ZoneApi\.select\(\{ zoneId: zone\.id \}\)/.test(applyBody), "按登录页选的区 POST /zones/select");
    check(/pickFallbackZone\(zone\.id\)/.test(applyBody), "select 失败时挑一个兜底区（不把人卡在登录页）");
    check(/zone_fallback_tip/.test(applyBody), "兜底换区要飘字说明（否则玩家以为选的那个区生效了）");
    check(
      /if \(fellBack\) await this\.waitTipGone\(\)/.test(body),
      "兜底换过区就等飘字走完再换场景（飘字挂在登录页 Canvas 上，立刻换场景会被销毁）",
    );

    const fallback = /private async pickFallbackZone\(failedId: number\): Promise<Zone \| null> \{([\s\S]*?)\n  \}/.exec(login);
    check(!!fallback, "有 pickFallbackZone");
    const fallbackBody = fallback ? fallback[1] : "";
    check(
      /const failed = zones\.find\(\(zone\) => zone\.id === failedId\)/.test(fallbackBody) &&
        /if \(failed && failed\.status === "open"\) return null;/.test(fallbackBody),
      "区还在开放就不换区（一次网络抖动不该把玩家换到别的区）",
    );
    check(/zone\.status === "open"/.test(fallbackBody), "兜底只挑还开放的区（维护 / 关闭的换过去照样进不去）");
    check(/ZoneApi\.list\(\)/.test(fallbackBody), "兜底前重拉一次列表（区刚维护 / 关闭 / 合并，缓存会骗人）");

    check(
      /AuthApi\.register\(\{ username: credentials\.username, password: credentials\.password \}\)/.test(login),
      "注册只发账号密码（不带 zoneId —— 区是角色的属性）",
    );
  }

  console.log("\n== 四、选角页：不再碰区，直接拉角色 ==");
  {
    check(!/ZoneApi/.test(selector), "RoleSelector 不再调任何区接口（区在登录页就定了）");
    // #1059：顶栏要显示「区服 · 账号」，所以允许**只读** ZoneStore.get()；
    // 换区仍然只能在登录页 —— 这里守「不持有选服弹窗、不写 ZoneStore」
    check(/ZoneStore\.get\(\)/.test(selector) && !/ZoneStore\.set\(/.test(selector) && !/ZoneSelectDialog/.test(selector), "选角页只读区名做展示，换区与选服弹窗都不在这里");
    check(
      !/ensureZone|pickDefaultZone|renderZoneLabel|openZonePicker|onZonePicked|zoneLabel|zoneCount/.test(selector),
      "换区那套已经整体移走（没有残留的半截逻辑）",
    );
    const startBody = /\n  start\(\) \{([\s\S]*?)\n  \}/.exec(selector);
    check(!!startBody && /void this\.loadRoles\(\)/.test(startBody[1]), "start 直接 loadRoles（按服务端记着的当前浏览区拉）");
    check(!/bootstrap/.test(selector), "不再有 bootstrap（对齐区那一步没了）");
  }

  console.log("\n== 五、选服弹窗：公共列表、挡下不可进的区、只落本机 ==");
  {
    check(/zones = await ZoneApi\.list\(\)/.test(dialog), "数据源是公共 GET /zones（登录前没有令牌）");
    check(!/ZoneApi\.mine\(\)/.test(dialog), "不调 /zones/mine");
    check(!/ZoneApi\.select\(/.test(dialog), "选完不发 select（登录前没令牌，真正落地在登录成功之后）");
    check(!/silent: true/.test(dialog), "拉列表不静默（拉不到要让玩家知道，静默会让人以为点坏了）");
    check(
      /if \(zone\.status !== "open"\) \{[\s\S]{0,220}?zone_unavailable_tip/.test(dialog) ||
        /zone\.status !== "open"[\s\S]{0,260}?zone_closed_tip/.test(dialog),
      "维护 / 关闭的区本地就挡下并给提示（不浪费一次往返，也不静默）",
    );
    const storeIdx = dialog.indexOf("ZoneStore.set(zone.id, zone.name)");
    const callbackIdx = dialog.indexOf("onPicked?.(zone)");
    check(storeIdx >= 0 && callbackIdx > storeIdx, "顺序：先写本机记录 → 再回调刷新区名");
    check(/zone\.id === currentZoneId/.test(dialog), "当前选中的区那行高亮（描边 + 「上次在」角标）");
    check(/zone\.recommended/.test(dialog), "推荐区有角标（recommended 由 P5 落在库里、P6 补进玩家侧 DTO）");
    check(!/roleCount/.test(dialog), "不再显示角色数（登录前拿不到，也不需要）");
    check(/zone_status_open/.test(dialog), "开放区那行也写清状态（中间一列不留空）");
    check(/if \(this\.dialog && isValid\(this\.dialog\)\) return;/.test(dialog), "已经开着就不再叠一个（连点顶部那颗区名）");
  }

  console.log("\n== 六、榜单 / 帮会：标题带区名 ==");
  {
    const board = strip(leaderboardSource);
    const guild = strip(guildSource);
    check(/ZoneStore\.currentName\(\)/.test(board) && /zone_title_prefix/.test(board), "排行榜小结前挂区名（榜是按区的，不写会以为是全服）");
    check(/ZoneStore\.currentName\(\)/.test(guild) && /zone_title_prefix/.test(guild), "帮会列表标题前挂区名");
  }

  console.log("\n== 七、文案与布局：全部走 configs，代码里没有裸中文 ==");
  {
    const keys = [
      "zone_current_label",
      "zone_switch_label",
      "zone_select_title",
      "zone_select_hint",
      "zone_tag_current",
      "zone_tag_recommended",
      "zone_status_open",
      "zone_status_maintenance",
      "zone_status_closed",
      "zone_unavailable_tip",
      "zone_closed_tip",
      "zone_picked_tip",
      "zone_fallback_tip",
      "zone_load_failed_tip",
      "zone_title_prefix",
    ];
    const missing = keys.filter((key) => !new RegExp(`\\b${key}:`).test(textsSource));
    check(missing.length === 0, `区名相关文案 ${keys.length} 条都在 configs/texts`, missing.length ? `缺：${missing.join("、")}` : "");
    const retired = ["zone_role_count", "zone_role_count_empty", "zone_switched_tip"];
    const left = retired.filter((key) => new RegExp(`\\b${key}:`).test(textsSource));
    check(left.length === 0, "登录前拿不到角色数 / 选完不落服务端，三条旧文案已退休", left.length ? `还在：${left.join("、")}` : "");

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
    // 区服入口在登录页的面板里（#1036 整版布局）：选角页不许再有（#1009）
    check(/name: "login_server_button"/.test(scenesSource), "loginLayout.panel.server 在配置里（登录页面板里的选服按钮）");
    check(!/role_selector_zone/.test(scenesSource), "roleSelectorLayout 里那颗区服文案已删（选角页不再显示 / 切换区服）");
  }

  console.log("\n== 八、文件与生成物 ==");
  {
    const files = ["assets/ui/components/dialogs/ZoneSelectDialog.ts", "assets/ui/core/ZoneStore.ts"];
    const missingMeta = files.filter((rel) => !fs.existsSync(path.join(PROJECT_ROOT, rel + ".meta")));
    check(missingMeta.length === 0, "新脚本都带 Cocos .meta（没有 meta 引擎不认）", missingMeta.length ? `缺：${missingMeta.join("、")}` : "");
    check(fs.existsSync(path.join(PROJECT_ROOT, "assets/ui/components/dialogs/ZoneSelectDialog.ts")), "选服弹窗文件在 dialogs 目录下");
  }

  finish("区服（客户端）");
}
