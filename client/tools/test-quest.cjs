#!/usr/bin/env node
/**
 * 任务单测（client/tools/test-quest.cjs，issue #396）
 *
 * 盯的不变量（改 QuestStore / 任务协议 / 任务服务端纪律后必须全绿）：
 * A. 任务仓（**跑真类**）：可接判定（等级 / 主线链前置）、全量覆盖与单条合并、
 *    进行中排序（可交付在前）、NPC 标记优先级（? 压过 !）、订阅与 reset
 * B. 协议两端同形：服务端 RealtimeQuestMessage 与客户端 QuestProgressFrame 字段一致，
 *    QuestState 的三个可下发状态与客户端口径一致
 * C. 服务端权威纪律：接取复核等级与前置链、交付按目标类型判定（collect 查背包）、
 *    击杀推进只写给 accepted 行、周期日切（本轮已领 20027 / 跨轮覆盖重置 / 领奖不删行）、
 *    #865 放弃接口只删未领过的行
 * D. 客户端消费纪律：quest 帧只喂 QuestStore（单一落点）、点 NPC 即上报对话、
 *    追踪栏点开任务面板 + 「详」开任务详情弹窗（放弃两步确认 / 前往寻路）、切场景三处都 reset
 *
 * QuestStore 刻意不 import 网络（见它的类注释），沙箱直接编译真源码跑断言。
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");
/** PROJECT_ROOT 是 client/ 目录，服务端与根目录下的文件要往上走一层 */
const readRepo = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, "..", rel), "utf8");

const SERVER_PROTOCOL = "server/src/modules/realtime/realtime.protocol.ts";
const SERVER_QUEST = "server/src/modules/quest/quest.service.ts";
const CLIENT_CHANNEL = "assets/ui/utils/net/CombatChannel.ts";
const CLIENT_STORE = "assets/ui/core/QuestStore.ts";
const CLIENT_DIALOG = "assets/ui/components/dialogs/QuestDialog.ts";
const CLIENT_DETAIL = "assets/ui/components/dialogs/QuestDetailDialog.ts";
const CLIENT_TRACKER = "assets/ui/components/hud/QuestTracker.ts";
const CLIENT_SPAWNER = "assets/ui/components/map/MapObjectSpawner.ts";
const CLIENT_BOTTOM_BAR = "assets/ui/components/hud/BottomBar.ts";
const CLIENT_GAME = "assets/ui/Game.ts";

/**
 * 抽某个类方法的正文（从 `  name(` 到同缩进的收尾 `\n  }`）
 *
 * 为什么需要：全文件 `includes` 会把别的同名调用算进来 —— #865 加了 `abandon()` 之后，
 * 「领奖不删行」这条断言被 abandon 里的 `progressRepo.remove` 误伤成假红。
 * 断言要钉在具体方法上，否则改别处就误报（或者更糟：改成别处漏检）。
 */
function methodBody(source, name) {
  const start = new RegExp(`\\n  (?:async )?${name}\\(`).exec(source);
  if (!start) return null;
  const from = start.index + start[0].length;
  const end = source.indexOf("\n  }\n", from);
  return end < 0 ? null : source.slice(from, end);
}

/** 从一段源码里抽出某个 interface 的字段名（两空格缩进 + 可选 ?；注释行不匹配） */
function fieldNames(source, interfaceName) {
  const block = new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`).exec(source);
  if (!block) return null;
  return Array.from(block[1].matchAll(/^ {2}(\w+)\??:/gm)).map((match) => match[1]);
}

let failures = 0;
const guard = (fn) => {
  try {
    fn();
  } catch (error) {
    failures += 1;
    console.log(`  [!!] 单测抛异常：${error && error.stack ? error.stack.split("\n")[0] : error}`);
  }
};

try {
  const outDir = prepare("olua-quest", ["ui/core/QuestStore.ts"]);
  const QuestStore = require(path.join(outDir, "ui/core/QuestStore.js")).default;
  const { quests } = require(path.join(outDir, "configs/game-config.js"));

  //#region A. 任务仓（跑真类）

  console.log("\n— A. 任务仓：可接判定 / 状态合成 / 排序 / 标记 —");

  guard(() => {
    QuestStore.reset();
    QuestStore.setLevel(1);
    // 7001 无前置（星灯纪链首）→ 等级够就可接；7002 前置是 7001（没领奖）→ locked
    check(QuestStore.statusOf("7001") === "available", "无前置 + 等级够 = 可接");
    check(QuestStore.statusOf("7002") === "locked", "前置没领奖 = 未解锁（客户端算，不发请求）");
    check(QuestStore.statusOf("7003") === "locked", "链上第二环也锁着（前置的前置未完成）");
    check(QuestStore.statusOf("9999") === "unknown", "配置里没有的任务 id 是 unknown（不瞎显示）");
    check(QuestStore.available().length === 1, "可接列表只含真能接的（7002/7003 都没解锁）");

    QuestStore.setLevel(0);
    check(QuestStore.statusOf("7001") === "available", "等级未设置（0）时不做等级门控（进图前不误锁）");
    QuestStore.reset();
  });

  guard(() => {
    QuestStore.reset();
    QuestStore.setLevel(3);
    QuestStore.applyStates([
      { questId: "7001", status: "claimed", progress: 1, target: 1 },
      { questId: "7002", status: "accepted", progress: 2, target: 5 },
    ]);
    check(QuestStore.statusOf("7001") === "claimed", "全量覆盖：claimed 行进仓");
    check(QuestStore.statusOf("7002") === "accepted", "全量覆盖：进行中的行进仓");
    check(QuestStore.statusOf("7003") === "locked", "前置 7002 还没领奖 → 7003 仍未解锁");
    check(QuestStore.view("7002").progress === 2 && QuestStore.view("7002").target === 5, "视图带进度与目标");

    // 单条合并不能抹掉别的行（NPC 对话响应只带该 NPC 的任务）
    QuestStore.applyState({ questId: "7002", status: "ready", progress: 5, target: 5 });
    check(QuestStore.statusOf("7002") === "ready", "单条合并：状态就地更新");
    check(QuestStore.statusOf("7001") === "claimed", "单条合并不抹掉其它行");

    const active = QuestStore.active();
    check(active.length === 1 && active[0].quest.id === "7002", "进行中只含有进度行的任务");
    check(active[0].status === "ready", "可交付排在前面（active 排序口径）");
    // 7001 已领奖 → 7002 变可接的前提是它没有进度行；这里它有 accepted 行，所以可接只有链上的下一环
    const available = QuestStore.available();
    check(available.every((view) => QuestStore.statusOf(view.quest.id) === "available"), "可接列表里每条都是 available 态");
    check(!available.some((view) => view.quest.id === "7002"), "可接不含已接 / 已领奖的");
    QuestStore.applyState({ questId: "7002", status: "claimed", progress: 5, target: 5 });
    check(QuestStore.statusOf("7003") === "available", "前置 7002 领奖后 7003 解锁（链式门控）");
    QuestStore.reset();
  });

  guard(() => {
    QuestStore.reset();
    QuestStore.setLevel(1);
    // 1101（苍梧）名下 7001 在 1 级即可接；1103（白芷）名下 7005~7007 全在 6 级以上 → 1 级全锁
    check(QuestStore.markOf("1101") === "!", "有可接任务 → NPC 头顶 !");
    check(QuestStore.markOf("1103") === null, "任务全未解锁 → 不挂标记");
    check(QuestStore.markOf("1234") === null, "没有任务的 NPC → 不挂标记");

    // 走到第九章初：7001~7007 全领过 → 1101 名下 7004/7008 解锁（7001 领过 + 两环可接）
    QuestStore.setLevel(9);
    QuestStore.applyStates(
      ["7001", "7002", "7003", "7004", "7005", "7006", "7007"].map((id) => ({ questId: id, status: "claimed", progress: 1, target: 1 })),
    );
    check(QuestStore.atNpc("1101").length === 3, "atNpc 返回该 NPC 名下已解锁的任务视图（领过 1 + 可接 2）");
    QuestStore.applyState({ questId: "7004", status: "ready", progress: 1, target: 1 });
    check(QuestStore.markOf("1101") === "?", "有可交付 → ? 压过 !（先交再谈接新的）");

    let fired = 0;
    const off = QuestStore.onChange(() => (fired += 1));
    QuestStore.applyState({ questId: "7005", status: "accepted", progress: 1, target: 5 });
    check(fired === 1, "onChange 在状态变化时触发（追踪栏 / 标记靠它刷新）");
    off();
    QuestStore.applyState({ questId: "7005", status: "accepted", progress: 2, target: 5 });
    check(fired === 1, "退订后不再触发（订阅函数成对给）");
    QuestStore.reset();
    check(QuestStore.statusOf("7001") === "available" && QuestStore.active().length === 0, "reset 清空（切角色不留旧进度）");
  });

  guard(() => {
    // 配置表本身的不变量：奖励物品 id 非空、目标数量 ≥1、主线链不成环
    const list = [...quests.values()];
    check(list.length >= 28, "任务配置至少 28 条（星灯纪 28 环主线）");
    check(list.filter((quest) => !quest.prevQuestId).length === 1, "链首唯一（只有 7001 没有前置）");
    check(list.every((quest) => quest.objective.count >= 1), "每个任务的目标数量 ≥1");
    check(list.every((quest) => ["kill", "talk", "collect"].includes(quest.objective.type)), "目标类型只有 kill / talk / collect");
    check(list.every((quest) => quest.rewards.items.every((item) => item.goodId)), "奖励物品 goodId 都非空");
    const cyclic = list.filter((quest) => quest.prevQuestId && !quests.has(quest.prevQuestId));
    check(cyclic.length === 0, "前置任务 id 都在任务表里（链不断）");
  });

  //#endregion

  //#region B. 协议两端同形

  console.log("\n— B. 协议两端同形（quest 帧字段与状态取值） —");

  const serverProtocol = readRepo(SERVER_PROTOCOL);
  const clientChannel = read(CLIENT_CHANNEL);
  guard(() => {
    // 服务端的帧是 { type, data: {...} } 两层；客户端把它摊平成 data 本身 —— 比的是里层字段
    const messageBlock = /export interface RealtimeQuestMessage \{([\s\S]*?)\n\}/.exec(serverProtocol);
    const dataBlock = messageBlock ? /\n  data: \{([\s\S]*?)\n  \};/.exec(messageBlock[1]) : null;
    const serverFields = dataBlock ? Array.from(dataBlock[1].matchAll(/^ {4}(\w+)\??:/gm)).map((match) => match[1]) : null;
    const clientFields = fieldNames(clientChannel, "QuestProgressFrame");
    check(!!serverFields && !!clientFields, "两端都声明了 quest 帧的类型");
    check(JSON.stringify(clientFields) === JSON.stringify(serverFields), `quest 帧字段两端一致（服务端 ${serverFields} / 客户端 ${clientFields}）`);
    check(clientFields.includes("questId") && clientFields.includes("progress") && clientFields.includes("target"), "帧里带 questId / status / progress / target（客户端免查快照）");
  });

  guard(() => {
    const models = read("assets/ui/utils/net/ApiModels.ts");
    const block = /export type QuestState = \{([\s\S]*?)\n\};/.exec(models);
    check(!!block, "客户端有 QuestState 模型（进度行形状）");
    const statusLine = /status: "([^"]+)" \| "([^"]+)" \| "([^"]+)" \| "([^"]+)"/.exec(block ? block[1] : "");
    check(!!statusLine, "QuestState.status 是四态枚举");
    check(statusLine && statusLine[1] === "available", "四态含 available（可接态由服务端在对话响应里下发）");
  });

  //#endregion

  //#region C. 服务端权威纪律

  console.log("\n— C. 服务端权威纪律（接取 / 交付 / 击杀 / 领奖） —");

  const serverQuest = readRepo(SERVER_QUEST);
  guard(() => {
    check(serverQuest.includes("role.level < quest.min_level"), "接取复核等级（客户端算的可接只是提前灰按钮）");
    check(serverQuest.includes("quest.prev_quest_id") && serverQuest.includes('prev.status !== "claimed"'), "接取复核主线链前置（claimed 才算完成）");
    check(serverQuest.includes("已经接取了这个任务"), "重复接取被拒");
    check(serverQuest.includes("该任务已完成，不能重复接取"), "已完成的主线不能再接");
  });

  guard(() => {
    check(serverQuest.includes('quest.objective_type === "collect"'), "交付时 collect 型按目标类型分流");
    check(serverQuest.includes("grantQuestRewards"), "发奖走 RolesService 的单次落库（扣材料 + 发奖励 + 升级）");
    check(serverQuest.includes("QUEST_ALREADY_DONE"), "日常今天已领过 → 20027（#815：不再靠删行回到可接）");
    check(serverQuest.includes("resetForNewDay"), "日常跨天原地覆盖重置（进度清零、回 accepted）");
    // 领奖走 submit()；#865 起 abandon() 也删行（放弃就是放弃），所以断言只看 submit 的方法体
    const submitBody = methodBody(serverQuest, "submit");
    check(!!submitBody, "任务服务里有 submit（交付 + 领奖）");
    check(!!submitBody && !submitBody.includes("progressRepo.remove"), "领奖**不删行**（删了就抹掉「这一轮领过」的证据）");
    const abandonBody = methodBody(serverQuest, "abandon");
    check(!!abandonBody && abandonBody.includes('row.status === "claimed"'), "放弃不删已领过的行（那是「这一轮领过」的唯一证据）");
    check(serverQuest.includes("markClaimed"), "领奖一律留 claimed 行（daily 与 main 同处理）");
    check(serverQuest.includes("listByStatus(role.id, \"accepted\")"), "只有 accepted 行会被推进（ready / claimed 不再涨进度）");
  });

  guard(() => {
    check(serverQuest.includes("onMonsterKilled"), "击杀进度入口在服务端（realtime 结算调用）");
    check(serverQuest.includes("listByStatus(event.roleId, \"accepted\")"), "击杀推进只看本人的 accepted 行");
    check(serverQuest.includes("catch (error)") && serverQuest.includes("任务击杀进度写入失败"), "进度写库失败只打日志（不回滚世界击杀）");
    check(serverQuest.includes('quest.objective_target !== npcId'), "NPC 对话只推进目标就是这个 NPC 的 talk 任务");
  });

  //#endregion

  //#region D. 客户端消费纪律

  console.log("\n— D. 客户端消费纪律（帧落点 / NPC 对话 / 追踪栏 / 清理） —");

  guard(() => {
    check(clientChannel.includes("static dispatchQuest"), "CombatChannel 有 quest 帧的入口");
    check(clientChannel.includes("typeof frame.questId !== \"string\""), "坏帧（没有 questId）直接丢弃");
    const realtime = read("assets/ui/utils/net/RealtimeClient.ts");
    check(realtime.includes('frame.type === "quest"') && realtime.includes("dispatchQuest"), "RealtimeClient 把 quest 帧转给 CombatChannel");
    const game = read(CLIENT_GAME);
    check(game.includes("CombatChannel.onQuest = (frame) =>"), "组合根把 quest 帧接到 QuestStore（单一落点）");
    check(game.includes("CombatChannel.onQuest = null"), "退出游戏摘掉回调（不留悬挂引用）");
    check(game.includes("QuestStore.reset()"), "退出游戏清空任务仓（进度不跨角色）");
    check(game.includes("QuestNpcMarks.reset()"), "退出游戏清空 NPC 标记");
  });

  guard(() => {
    const store = read(CLIENT_STORE);
    check(!/from "\.\.\/utils\/net\/Api"/.test(store), "QuestStore 不 import 网络层（状态归状态、IO 归 IO）");
    const dialog = read(CLIENT_DIALOG);
    check(dialog.includes("QuestApi.mine()"), "弹窗打开时拉一次全量（帧只推变化，可能落后）");
    check(dialog.includes("QuestApi.accept") && dialog.includes("QuestApi.submit"), "接取 / 交付都在弹窗里（响应即最新快照）");
    check(dialog.includes("QuestStore.applyStates(result.quests)"), "交付响应直接覆盖快照（不再请求一次）");
    check(!/distance|getWorldPosition/.test(dialog), "客户端不做距离校验（#862：距离闸在服务端，客户端拿位置当准入等于自己说了算）");
  });

  guard(() => {
    const spawner = read(CLIENT_SPAWNER);
    check(spawner.includes("QuestTalk.report(id)"), "点 NPC 即上报一次对话（talk 进度入口）");
    check(spawner.includes("QuestNpcMarks.attach(npcNode, id)"), "NPC 落位后挂头顶标记");
    check(spawner.includes("npc.onClick && npc.onClick()"), "原有点击行为保留（传送 / 战魂不因任务改动失效）");
    const bottomBar = read(CLIENT_BOTTOM_BAR);
    // 任务入口已从底部导航移除（见 configs/bottomNav）——
    // 任务面板唯一入口 = 任务追踪栏点击 → openQuests（面板仍归底部栏持有）
    check(!bottomBar.includes("task: () => this.questDialog.open()"), "底部导航已无「任务」入口（任务走追踪栏）");
    check(bottomBar.includes("openQuests()"), "追踪栏点击走 openQuests（面板归底部栏持有）");
    const tracker = read(CLIENT_TRACKER);
    check(tracker.includes("QuestStore.onChange"), "追踪栏订阅任务仓（状态变即重画）");
    check(tracker.includes("layout.maxRows"), "追踪栏有行数上限（不盖住地图）");
    check(tracker.includes("addComponent(UITransform)"), "追踪栏自己是按钮，必须自己有 UITransform（否则引擎读 trans!.cameraPriority 抛空指针，整个游戏的指针事件全废）");
    check(
      /addComponent\(UITransform\)[\s\S]{0,400}blockClickThrough\(\s*this\s*\)/.test(tracker),
      "顺序：先补 UITransform 再 blockClickThrough（反了防呆会静默跳过鼠标登记，点追踪栏会穿透到世界）",
    );
    check(tracker.includes("this.active = rows.length > 0"), "没有任务时整块收起来（命中区常驻，留着活动会让点左侧空白也开面板）");
  });

  // #1191 任务详情弹窗：入口 / 放弃两步确认 / 前往
  guard(() => {
    const tracker = read(CLIENT_TRACKER);
    const bottomBar = read(CLIENT_BOTTOM_BAR);
    const game = readRepo("client/assets/ui/Game.ts");
    const detail = read(CLIENT_DETAIL);
    // 入口链路：HUD「详」按钮 → openQuestDetail → BottomBar 持有的 QuestDetailDialog
    check(tracker.includes("onOpenDetail"), "追踪栏有第二个入口回调（详 = 详情弹窗，与整块点击开面板并存）");
    check(
      tracker.includes("quest_tracker_detail_button") && tracker.includes("blockClickThrough(detail)"),
      "「详」按钮挡穿透（不冒泡成整块的「开面板」）",
    );
    check(game.includes("openQuestDetail()"), "Game 把「详」接线到 openQuestDetail（详情弹窗归底部栏持有）");
    check(bottomBar.includes("new QuestDetailDialog()") && bottomBar.includes("openQuestDetail()"), "底部栏持有并转开任务详情弹窗");
    // 数据：同面板一个仓、打开即对账
    check(detail.includes("QuestStore.onChange") && detail.includes("QuestApi.mine()"), "详情弹窗订阅任务仓 + 打开即全量对账（与面板同一数据源）");
    check(detail.includes("QuestStore.active()"), "详情卡只列进行中 / 可交付（可接在面板的「可接」页签）");
    // 放弃：两步确认 + 服务端接口 + 快照覆盖
    check(detail.includes("QuestApi.abandon") && detail.includes("QuestStore.applyStates"), "放弃走 abandon 接口，响应覆盖快照（进行中被引用的环由服务端拒绝）");
    check(
      detail.includes("armedQuestId") && detail.includes("layout.abandon.confirmTimeout"),
      "放弃两步确认：armed 状态 + 3 秒到点复位（与回收 / 丢弃 / 删角色同一套口径）",
    );
    check(detail.includes("clearAbandonPending()") && /onClose[\s\S]{0,200}clearAbandonPending/.test(detail), "关弹窗时清两步确认定时器（不挂着跨开关）");
    // 前往：关弹窗 + 寻路至交付 NPC；跨图不传送只提示
    check(/go\(view[\s\S]*?this\.close\(\)/.test(detail), "「前往」先关弹窗再寻路（稿：前往 = 关闭弹窗并寻路）");
    check(detail.includes("AutoBattle.requestMoveTo"), "「前往」复用点击寻路（NPC 目标格被挡由 findPath 就近改寻兜底）");
    check(detail.includes("maps.get(AutoBattle.getMapId())"), "「前往」读快照 maps 表拿 NPC 点位（不读 TMX）");
    check(detail.includes("goOtherMapTip"), "交付 NPC 不在本地图时提示所在地图（不做跨图传送）");
  });

  //#endregion
} catch (error) {
  fail(`任务单测跑挂：${error && error.message ? error.message : error}`);
}

finish("✅ 任务单测全绿");
