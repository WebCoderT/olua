#!/usr/bin/env node
/**
 * 社交关系单测（client/tools/test-social.cjs，issue #389）
 *
 * 盯的不变量（改关系判定 / 互见帧 / 社交面板后必须全绿）：
 * A. 判定优先级：拉黑 > 敌人 > 同队 > 同帮 > 好友 > 同地图 > 普通（**跑真函数**，不是复刻一份逻辑）
 * B. 配色与标签：六种关系都有颜色与中文名；未知关系回落普通
 * C. 协议两端同形：互见帧带 roleId / guildId / guildName，客户端三项可选
 * D. 服务端成本：帮会与外观同一趟懒刷新（不每帧查库），帮会变化进增量判据
 * E. 客户端上色：判定只有一个入口，颜色只在关系变化时才改（不重建节点）
 * F. 服务端数据纪律：好友镜像两行 + 成对改（事务），敌人单向一行
 * G. 屏蔽与举报（#398）：拉黑单向成行、过滤在服务端（聊天 + 互见）、隐私口径（不下发「谁拉黑了我」）、
 *    举报只落库且管理端只读
 * H. 队伍仓（#399）：同队优先级、邀请合并与过期、空快照 = 不在队伍、清空不拆订阅
 *
 * 表现层依赖 cc 引擎（Node / Graphics / Label），沙箱起不来 —— 这里跑真实的
 * `configs/social.ts`（判定与配色是纯函数）+ 源码契约断言，界面行为由真机双窗口验证。
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");
/** PROJECT_ROOT 是 client/ 目录，服务端与根目录下的文件要往上走一层 */
const readRepo = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, "..", rel), "utf8");

const SERVER_PROTOCOL = "server/src/modules/realtime/realtime.protocol.ts";
const SERVER_PRESENCE = "server/src/modules/realtime/player-presence.service.ts";
const SERVER_SOCIAL_REPO = "server/src/database/repositories/social.repository.ts";
const SERVER_SOCIAL_SERVICE = "server/src/modules/social/social.service.ts";
const SERVER_BIZ_CODE = "server/src/common/constants/biz-code.ts";
const CLIENT_CHANNEL = "assets/ui/utils/net/CombatChannel.ts";
const CLIENT_MANAGER = "assets/ui/core/OtherPlayerManager.ts";
const CLIENT_STORE = "assets/ui/core/SocialStore.ts";
const CLIENT_DIALOG = "assets/ui/components/dialogs/SocialDialog.ts";
const CLIENT_GUILD_PANEL = "assets/ui/components/dialogs/GuildPanel.ts";
const CLIENT_ROLE_INFO = "assets/ui/components/dialogs/RoleInfoDialog.ts";
const CLIENT_DIALOGS_LAYOUT = "assets/configs/layout/dialogs.ts";
const CLIENT_DIALOGS_REPORT = "assets/ui/components/dialogs/SocialDialog.ts";
const CLIENT_DIALOGS_REPORT_DIALOG = "assets/ui/components/dialogs/ReportDialog.ts";

/** 从一段源码里抽出某个 interface 的字段名（两空格缩进 + 可选 ?；注释行不匹配） */
function fieldNames(source, interfaceName) {
  const block = new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`).exec(source);
  if (!block) return null;
  return Array.from(block[1].matchAll(/^ {2}(\w+)\??:/gm)).map((match) => match[1]);
}

/** 数一个字符串出现次数（写断言时比 match.length 直观） */
const count = (source, needle) => source.split(needle).length - 1;

try {
  // PartyStore 只 import type（CombatChannel 的帧形状），编译后没有依赖 —— 可以直接跑真函数
  const outDir = prepare("olua-social", ["configs/social.ts", "ui/core/PartyStore.ts"]);
  const social = require(path.join(outDir, "configs/social.js"));
  const { RELATION, RELATION_PRIORITY, relationColors, relationLabels, resolveRelation, getRelationColor } = social;

  //#region A. 判定优先级（跑真函数）

  console.log("\n— A. 判定优先级（拉黑 > 敌人 > 同队 > 同帮 > 好友 > 同地图 > 普通） —");

  const me = { roleId: "r1", guildId: "g1", friendIds: ["r2", "r3"], enemyIds: ["r3"], blockIds: ["r4"] };
  const both = { roleId: "r3", guildId: "g1" }; // 既是好友、也是同帮、还被标了敌人
  check(resolveRelation(me, both, true) === RELATION.ENEMY, "敌人压过同帮与好友（标了敌人就是要看见红名）");
  const guildMate = { roleId: "r2", guildId: "g1" }; // 好友 + 同帮
  check(resolveRelation(me, guildMate, true) === RELATION.GUILD, "同帮压过好友（组织关系强于私人交情）");
  const friendOnly = { roleId: "r2", guildId: "g2" };
  check(resolveRelation(me, friendOnly, true) === RELATION.FRIEND, "好友压过同地图（好友名字是绿的）");
  const stranger = { roleId: "r9", guildId: "g2" };
  check(resolveRelation(me, stranger, true) === RELATION.MAP, "同图陌生人是「同地图」（默认白名）");
  check(resolveRelation(me, stranger, false) === RELATION.NORMAL, "不同图又没关系是「普通」");
  check(resolveRelation(me, { roleId: "r1", guildId: "g1" }, true) === RELATION.SELF, "自己优先于一切（互见帧会过滤掉，口径仍要完整）");
  check(
    resolveRelation({ roleId: "r1", guildId: "", friendIds: [], enemyIds: [], blockIds: [] }, { roleId: "r9", guildId: "" }, true) === RELATION.MAP,
    "两边都没帮会时不算同帮（空串不等于同帮）",
  );
  check(
    resolveRelation({ roleId: "r1", guildId: "g1", friendIds: [], enemyIds: [], blockIds: [] }, { roleId: "r9", guildId: "g1" }, false) === RELATION.GUILD,
    "不同图也是同帮（帮会关系不依赖看得见）",
  );
  // 同队（#399）：队伍是「此刻一起打怪」的临时关系，比组织（帮会）与私交（好友）都更即时
  const partyMe = { ...me, partyId: "p1" };
  check(resolveRelation(partyMe, { roleId: "r2", guildId: "g1", partyId: "p1" }, true) === RELATION.PARTY, "同队压过同帮与好友（好友进队就该显示队友金）");
  check(resolveRelation(partyMe, { roleId: "r3", guildId: "g1", partyId: "p1" }, true) === RELATION.ENEMY, "敌人仍压过同队（标了敌人就是红名）");
  check(resolveRelation(partyMe, { roleId: "r9", guildId: "g2", partyId: "p2" }, true) === RELATION.MAP, "两个不同的队不算同队");
  check(
    resolveRelation(
      { roleId: "r1", guildId: "", partyId: "", friendIds: [], enemyIds: [], blockIds: [] },
      { roleId: "r9", guildId: "", partyId: "" },
      true,
    ) === RELATION.MAP,
    "两边都没队伍时不算同队（空串不等于同一支队）",
  );
  check(
    resolveRelation(partyMe, { roleId: "r9", guildId: "g2" }, true) === RELATION.MAP,
    "对方没带 partyId（好友列表 / 聊天记录里的旧帧）按不同队处理",
  );
  check(
    RELATION_PRIORITY.join(",") === "self,block,enemy,party,guild,friend,map,normal",
    `优先级表的顺序写死（实得 ${RELATION_PRIORITY.join(" > ")}）`,
  );
  // 拉黑是最高优先（#398）：既是敌人又是同帮的好友，一旦拉黑就必须算「已拉黑」
  const blockedAndEnemy = { roleId: "r4", guildId: "g1" };
  check(
    resolveRelation({ ...me, friendIds: ["r4"], enemyIds: ["r4"] }, blockedAndEnemy, true) === RELATION.BLOCK,
    "拉黑压过敌人 / 同帮 / 好友（残帧漏进来也不能按旧关系上色）",
  );
  check(resolveRelation(me, { roleId: "r4", guildId: "g2" }, false) === RELATION.BLOCK, "拉黑关系不依赖同图（名单里也是这个标签）");
  check(
    count(read("assets/configs/social.ts"), "if (self.enemyIds.indexOf(target.roleId) >= 0)") === 1,
    "敌人判定用 indexOf（客户端编译目标是 ES2015，includes 不存在）",
  );

  //#endregion

  //#region B. 配色与标签

  console.log("\n— B. 配色与标签 —");

  const rgb = (color) => `${color.r},${color.g},${color.b}`;
  check(rgb(relationColors[RELATION.ENEMY]) === "255,91,91", "敌人 = 红");
  check(rgb(relationColors[RELATION.GUILD]) === "110,168,255", "同帮 = 蓝");
  check(rgb(relationColors[RELATION.FRIEND]) === "123,224,123", "好友 = 绿");
  check(rgb(relationColors[RELATION.MAP]) === "255,255,255", "同地图 = 白（与默认名色一致，陌生人保持现状）");
  check(rgb(getRelationColor("bogus")) === "200,200,200", "未知关系回落普通色（不炸）");
  const kinds = Object.keys(RELATION).map((key) => RELATION[key]);
  check(
    kinds.every((kind) => !!relationColors[kind] && !!relationLabels[kind]),
    "八种关系都有配色与中文名（漏一种就是一块没上色的字）",
  );
  check(rgb(relationColors[RELATION.PARTY]) === "255,209,102", "同队 = 金（满屏里一眼能挑出自己人）");
  check(relationLabels[RELATION.PARTY] === "同队", "同队的中文标签");
  check(rgb(relationColors[RELATION.BLOCK]) === "120,126,138", "拉黑 = 暗灰（正常看不到这个人，颜色只出现在名单里）");

  //#endregion

  //#region C. 协议两端同形

  console.log("\n— C. 协议两端同形（互见帧带 roleId / guildId / guildName） —");

  const serverEntry = fieldNames(readRepo(SERVER_PROTOCOL), "RealtimePlayerEntry") ?? [];
  const clientEntry = fieldNames(read(CLIENT_CHANNEL), "PlayerEntry") ?? [];
  check(serverEntry.indexOf("roleId") >= 0, "服务端互见条目带 roleId（社交关系按角色记，不是按账号）");
  check(serverEntry.indexOf("guildId") >= 0 && serverEntry.indexOf("guildName") >= 0, "服务端互见条目带 guildId / guildName");
  check(clientEntry.indexOf("roleId") >= 0 && clientEntry.indexOf("guildId") >= 0 && clientEntry.indexOf("guildName") >= 0, "客户端同形");
  const clientSource = read(CLIENT_CHANNEL);
  check(/roleId\?: string;/.test(clientSource) && /guildId\?: string;/.test(clientSource), "客户端三项都是可选（旧服务端不发时按无帮会处理）");
  check(serverEntry.indexOf("partyId") >= 0, "服务端互见条目带 partyId（#399：队标与队友金的原料）");
  check(clientEntry.indexOf("partyId") >= 0, "客户端互见条目同形（可选，旧服务端不发时按没队伍）");

  //#endregion

  //#region D. 服务端成本

  console.log("\n— D. 服务端成本（帮会搭外观的懒刷新，不每帧查库） —");

  const presence = readRepo(SERVER_PRESENCE);
  check(count(presence, "this.guilds.guildOfRole(") === 1, "整个在场表只在一处查帮会（readGuild）");
  check(
    /const guild = this\.readGuild\(role\?\.id \?\? existed\.roleId\);/.test(presence),
    "帮会与外观在同一趟懒刷新里读（换装 / 升级 / 入帮共用一个 5 秒窗口）",
  );
  check(/private readGuild\(roleId: string\)/.test(presence), "无角色直接回空串（不查库）");
  check(/const guildChanged = this\.guildKey\(entry\) !== entry\.sentGuild;/.test(presence), "帮会变化进增量判据");
  check(
    /if \(!moved && !turned && !hurt && !redressed && !maxHpChanged && !guildChanged && !partyChanged\) continue;/.test(presence),
    "入帮 / 退帮站着不动也会广播（否则名字颜色要等他动一下才变）",
  );
  check(
    /const partyChanged = partyId !== entry\.sentParty;/.test(presence) && /entry\.sentParty = entry\.partyId;/.test(presence),
    "组队 / 退队同样进增量判据（#399：队友金与队标要立刻变，不等他动一下）",
  );
  check(
    /partyId: this\.partyOfRole\?\.\(roleId\) \?\? ""/.test(presence),
    "队伍 id 每个节拍现算（一次内存 Map 查询，不走 5 秒的外观懒刷新）",
  );
  check(/return `\$\{entry\.guildId\}\|\$\{entry\.guildName\}`;/.test(presence), "帮会键含名字（帮会改名也要重发）");
  check(!/resolveRelation/.test(presence), "服务端不算关系（O(n²) 的事放客户端，只下发原料）");

  //#endregion

  //#region E. 客户端上色

  console.log("\n— E. 客户端上色（唯一入口 + 就地重刷） —");

  const manager = read(CLIENT_MANAGER);
  check(/import SocialStore from "\.\/SocialStore";/.test(manager), "远端玩家从 SocialStore 取「我这一半」快照");
  check(/resolveRelation\(\s*SocialStore\.relationSelf\(\)/.test(manager), "关系判定走 configs/social 的唯一入口");
  check(/partyId: view\.partyId/.test(manager), "队伍 id 也进判定入参（#399：队友金）");
  check(/PartyStore\.onChange\(\(\) => this\.applyRelations\(\)\)/.test(manager), "队伍一变也重刷名字颜色（刚组队立刻变金）");
  check(
    /import PartyStore from "\.\/PartyStore";/.test(read(CLIENT_STORE)) && /const partyId = PartyStore\.partyId\(\);/.test(read(CLIENT_STORE)),
    "「我这一半」的 partyId 从 PartyStore 取（面板与上色同一个数）",
  );
  check(count(manager, "getRelationColor(") >= 2, "名字颜色统一走 getRelationColor（新建与重刷各一处）");
  check(/if \(relation === view\.relation\) continue;/.test(manager), "关系没变就不动 Label（别每帧刷一遍颜色）");
  check(/static applyRelations\(\): void \{/.test(manager), "有 applyRelations（社交快照一变就重刷全部名字）");
  check(/SocialStore\.onChange\(\(\) => this\.applyRelations\(\)\)/.test(manager), "订阅快照变化（加好友 / 标敌人立刻变色）");
  check(/static nearby\(\): NearbyPlayer\[\]/.test(manager), "附近列表取源 = 当前互见帧（此刻真的看得见的人）");
  check(!/SocialApi/.test(manager), "远端玩家不直接打 HTTP（快照只由 SocialStore 一处维护）");

  const store = read(CLIENT_STORE);
  check(/friendIds: snapshot\.friends\.map\(\(entry\) => entry\.roleId\)/.test(store), "快照转判定入参只在这里做一次");
  check(/if \(this\.loading\) return this\.loading;/.test(store), "并发 refresh 合并成一次请求");
  check(/\.catch\(\(\) => undefined\)/.test(store), "拉取失败静默（社交是装饰性数据，不该打断进图）");

  const dialog = read(CLIENT_DIALOG);
  check(
    /const TABS: SocialTab\[\] = \["guild", "friends", "enemies", "nearby", "blocks"\];/.test(dialog),
    "五个页签：帮会 / 好友 / 敌人 / 附近 / 黑名单（#398）",
  );
  check(/OtherPlayerManager\.nearby\(\)/.test(dialog), "「附近」页读互见帧内存态");
  check(/relationLabels\[player\.relation\]/.test(dialog), "关系标签直接用已算好的值（面板里不再判一遍）");
  check(!/resolveRelation/.test(dialog), "面板不重复判定关系（两处判定迟早显示不一致）");
  check(/this\.guildPanel\.mount\(body\)/.test(dialog), "帮会页内嵌（#388 的整套逻辑原样复用）");
  check(!/createDialog\(/.test(read(CLIENT_GUILD_PANEL)), "帮会页自己不再开弹窗（框由 SocialDialog 管）");
  check(/mount\(parent: Node\)/.test(read(CLIENT_GUILD_PANEL)), "帮会页有 mount / unmount");
  check(/new SocialDialog\(\)\.open\(\)/.test(read(CLIENT_ROLE_INFO)), "角色信息弹窗第五格打开社交弹窗");

  const layoutSource = read(CLIENT_DIALOGS_LAYOUT);
  check(/export const socialDialogLayout = \{/.test(layoutSource), "有 socialDialogLayout");
  check(/size: new Size\(600, 560\)/.test(layoutSource), "社交弹窗加高 60（多出来的一行放页签，帮会页坐标不用挪）");
  check(/columns: \[-208, -104, 0, 104, 208\]/.test(layoutSource), "五个页签的列位 + texts.tabs 与 TABS 一一对应");

  //#endregion

  //#region F. 服务端数据纪律

  console.log("\n— F. 服务端数据纪律（好友镜像两行 / 敌人单向一行） —");

  const repo = readRepo(SERVER_SOCIAL_REPO);
  check(count(repo, "this.db.run(sql, [friendId, roleId") >= 2, "发申请 / 同意 / 删除都成对写（镜像两行：两个方向各一次）");
  check(count(repo, "ON CONFLICT(role_id, friend_id) DO UPDATE") === 1, "重复申请覆盖而不是堆两行");
  check(/transaction<T>\(work: \(\) => T\): T/.test(repo), "事务开在仓储里（业务层不摸 DatabaseService）");
  check(count(repo, '"INSERT INTO role_enemies') === 1, "敌人只写一行（单向：我标我的）");
  check(!/INSERT INTO role_enemies[\s\S]{0,200}enemy_id, role_id/.test(repo), "敌人没有镜像反向行（对方不会知道）");
  const service = readRepo(SERVER_SOCIAL_SERVICE);
  check(/this\.social\.transaction\(/.test(service), "业务层用仓储事务包住两行改动");
  const bizCode = readRepo(SERVER_BIZ_CODE);
  check(
    ["50109", "50110", "50111", "50112", "50113", "50114", "50115", "50116"].every((code) => bizCode.indexOf(code) > 0),
    "社交业务码 50109~50116 齐全（含 50116 重名，让玩家从「附近」点选）",
  );

  //#endregion

  //#region G. 屏蔽与举报（#398）

  console.log("\n— G. 屏蔽与举报（单向 / 服务端过滤 / 隐私口径） —");

  const blockService = readRepo("server/src/modules/realtime/block.service.ts");
  check(/allBlockPairs\(\)/.test(blockService), "过滤缓存整表读一次（200ms 互见节拍上不可能逐人查库）");
  check(/socialBlockCacheMs/.test(blockService), "缓存过期时间走配置（生产 2 秒，e2e 压到 0 = 立即生效）");
  check(/this\.logger\.warn\(/.test(blockService) && /沿用上一次的过滤快照/.test(blockService), "读库失败保留旧缓存（屏蔽读失败不该让聊天与互见整体停摆）");

  const chat = readRepo("server/src/modules/realtime/chat.service.ts");
  check(/private reachable\(/.test(chat) && count(chat, "this.reachable(") === 2, "世界 / 帮会两条频道都逐收件人过滤拉黑");
  check(/blocks\.hiddenFor\(target\.id, identity\.roleId\)/.test(chat), "私聊：被拉黑的一方只看到「不在线」（不暴露屏蔽）");
  check(/blocks\.hiddenFor\(identity\.roleId, target\.id\)/.test(chat), "私聊：拉黑者这边明说原因（那是自己的设置）");

  const realtime = readRepo("server/src/modules/realtime/realtime.service.ts");
  check(/private visiblePlayers\(/.test(realtime) && count(realtime, "this.visiblePlayers(") === 2, "互见的增量与 full 快照都过屏蔽过滤");
  check(/不滤 `left`/.test(realtime), "left 事件不过滤（漏发会留一个幽灵节点）");

  check(/blocked_role_id/.test(repo) && !/INSERT INTO role_blocks[\s\S]{0,160}blocked_role_id, role_id/.test(repo), "拉黑只写一行（单向，没有镜像反向行）");
  check(/allBlockPairs\(\)/.test(repo), "仓储给实时进程开了整表读（allBlockPairs）");

  check(/blocks: SocialEntryDto\[\]/.test(readRepo("server/src/modules/social/dto/social.dto.ts")), "社交快照带 blocks（我拉黑的人）");
  check(/blockedBy|whoBlockedMe/.test(readRepo("server/src/modules/social/dto/social.dto.ts")) === false, "快照**不**下发「谁拉黑了我」（下发等于把屏蔽变成可观测信号）");
  check(/findBlock\(targetId, me\.id\)/.test(service), "他拉黑我时好友申请被挡（唯一能绕过屏蔽送达的通道）");
  check(/this\.social\.removePair\(me\.id, targetId\)/.test(service), "拉黑会剪掉好友关系（两行一起删，走事务）");

  const reportRepo = readRepo("server/src/database/repositories/report.repository.ts");
  check(/LEFT JOIN roles/.test(reportRepo), "举报双方名字查询时关联（角色删了显示 id，记录不随人消失）");
  const reportTable = readRepo("server/src/database/database.service.ts").split("CREATE TABLE IF NOT EXISTS role_reports")[1].split("CREATE INDEX")[0];
  check(/REFERENCES/.test(reportTable) === false, "举报表不加外来键（证据不该随被举报人删号消失）");
  check(/onlyRead|只读/.test(readRepo("server/src/modules/social/admin-report.controller.ts")), "管理端举报只有读接口（处置是后续一整刀）");
  check(
    ["50117", "50118", "50119", "50120"].every((code) => bizCode.indexOf(code) > 0),
    "屏蔽 / 举报业务码 50117~50120 齐全",
  );

  const storeSource = read(CLIENT_STORE);
  check(/isBlocked\(roleId: string\)/.test(storeSource), "SocialStore 有 isBlocked（附近行据此置灰按钮）");
  check(/blockIds: snapshot\.blocks\.map/.test(storeSource), "快照转判定入参带上 blockIds");
  check(/relation === RELATION\.BLOCK/.test(manager) && /this\.remove\(accountId\)/.test(manager), "拉黑后本地摘掉那个人的节点（服务端已不发他的帧，留着就是一个雕像）");
  const socialDialog = read(CLIENT_DIALOGS_REPORT);
  check(/ReportDialog\.open\(/.test(socialDialog) && /blockById\(/.test(socialDialog), "附近行能拉黑与举报（拉黑走二次确认，举报开独立弹窗）");
  const reportDialog = read(CLIENT_DIALOGS_REPORT_DIALOG);
  check(/SocialApi\.report\(/.test(reportDialog), "举报走生成的 SocialApi（不手写路径）");
  check(!/resolveRelation/.test(reportDialog), "举报框不参与关系判定（两件事不该纠缠）");

  //#endregion

  //#region H. 队伍仓（#399：邀请过期 / 同一人合并 / 清空不拆订阅）

  console.log("\n— H. 队伍仓（PartyStore） —");

  const { default: PartyStore } = require(path.join(outDir, "ui/core/PartyStore.js"));
  let notified = 0;
  const off = PartyStore.onChange(() => (notified += 1));

  const snapshotOf = (partyId, members, isLeader = false) => ({
    partyId,
    leaderRoleId: members.length > 0 ? members[0].roleId : "",
    limit: 4,
    members,
    isLeader,
  });
  const member = (roleId, extra = {}) => ({ roleId, name: roleId, level: 1, online: true, sameMap: true, leader: false, ...extra });

  PartyStore.applySnapshot(snapshotOf("p1", [member("r1", { leader: true }), member("r2", { sameMap: false })], true));
  check(PartyStore.partyId() === "p1" && PartyStore.inParty(), "落一份快照后 partyId 与「在队伍」都成立");
  check(PartyStore.isLeader(), "isLeader 照快照走（服务端说我是队长才是）");
  check(PartyStore.has("r2") && !PartyStore.has("r9"), "has() 只认名单里的人");
  check(PartyStore.sameMapCount() === 1, "sameMapCount 只数同图队友（异图的拿不到击杀经验）");
  check(PartyStore.limit() === 4, "上限照快照走（面板显示 2 / 4）");

  const invite = (fromRoleId, expiresIn) => ({
    partyId: "p1",
    fromRoleId,
    fromName: fromRoleId,
    fromLevel: 1,
    memberCount: 1,
    limit: 4,
    expiresAt: Date.now() + expiresIn,
  });
  PartyStore.applyInvite(invite("r5", 30_000));
  PartyStore.applyInvite(invite("r5", 30_000));
  check(PartyStore.pendingInvites().length === 1, "同一个人重复邀请只留一条（面板不叠同名行）");
  PartyStore.applyInvite(invite("r6", -1_000));
  check(PartyStore.pendingInvites().map((item) => item.fromRoleId).join(",") === "r5", "过期邀请读的时候就扔掉（留一条点不动的僵尸更糟）");
  PartyStore.dropInvite("r5");
  check(PartyStore.pendingInvites().length === 0, "同意 / 拒绝后能摘掉那条邀请（同一条不能点两次）");

  PartyStore.applySnapshot(snapshotOf("", [], false));
  check(!PartyStore.inParty() && PartyStore.partyId() === "", "空快照 = 不在队伍（退队 / 被踢 / 解散都是这一份）");

  const before = notified;
  PartyStore.clear();
  check(notified === before + 1, "清空会通知订阅者（界面跟着清）");
  PartyStore.applySnapshot(snapshotOf("p2", [member("r1", { leader: true })], true));
  check(notified > before + 1 && PartyStore.inParty(), "清空**不拆订阅**：换角色回来后仍然收得到变化（否则队友名字永远是白的）");
  off();

  //#endregion

  finish("PASS：社交关系（优先级 / 配色 / 协议同形 / 客户端上色 / 服务端纪律 / 屏蔽与举报）全部通过");
} catch (error) {
  fail(`社交关系单测异常：${error.message}`);
  process.exitCode = 1;
}
