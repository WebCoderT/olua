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
 *    击杀推进只写给 accepted 行、日常删行 / 主线保留 claimed
 * D. 客户端消费纪律：quest 帧只喂 QuestStore（单一落点）、点 NPC 即上报对话、
 *    追踪栏点开任务面板、切场景三处都 reset
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
const CLIENT_TRACKER = "assets/ui/components/hud/QuestTracker.ts";
const CLIENT_SPAWNER = "assets/ui/components/map/MapObjectSpawner.ts";
const CLIENT_BOTTOM_BAR = "assets/ui/components/hud/BottomBar.ts";
const CLIENT_GAME = "assets/ui/Game.ts";

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
  const { quests } = require(path.join(outDir, "configs/quest.js"));

  //#region A. 任务仓（跑真类）

  console.log("\n— A. 任务仓：可接判定 / 状态合成 / 排序 / 标记 —");

  guard(() => {
    QuestStore.reset();
    QuestStore.setLevel(1);
    // 8001 无前置 → 等级够就可接；8002 前置是 8001（没领奖）→ locked
    check(QuestStore.statusOf("8001") === "available", "无前置 + 等级够 = 可接");
    check(QuestStore.statusOf("8002") === "locked", "前置没领奖 = 未解锁（客户端算，不发请求）");
    check(QuestStore.statusOf("8101") === "available", "日常没有前置，等级够即可接");
    check(QuestStore.statusOf("9999") === "unknown", "配置里没有的任务 id 是 unknown（不瞎显示）");
    check(QuestStore.available().length === 2, "可接列表只含真能接的（8003 也没解锁）");

    QuestStore.setLevel(0);
    check(QuestStore.statusOf("8001") === "available", "等级未设置（0）时不做等级门控（进图前不误锁）");
    QuestStore.reset();
  });

  guard(() => {
    QuestStore.reset();
    QuestStore.setLevel(1);
    QuestStore.applyStates([
      { questId: "8001", status: "claimed", progress: 1, target: 1 },
      { questId: "8002", status: "accepted", progress: 2, target: 5 },
    ]);
    check(QuestStore.statusOf("8001") === "claimed", "全量覆盖：claimed 行进仓");
    check(QuestStore.statusOf("8002") === "accepted", "全量覆盖：进行中的行进仓");
    check(QuestStore.statusOf("8003") === "locked", "前置 8002 还没领奖 → 8003 仍未解锁");
    check(QuestStore.view("8002").progress === 2 && QuestStore.view("8002").target === 5, "视图带进度与目标");

    // 单条合并不能抹掉别的行（NPC 对话响应只带该 NPC 的任务）
    QuestStore.applyState({ questId: "8002", status: "ready", progress: 5, target: 5 });
    check(QuestStore.statusOf("8002") === "ready", "单条合并：状态就地更新");
    check(QuestStore.statusOf("8001") === "claimed", "单条合并不抹掉其它行");

    const active = QuestStore.active();
    check(active.length === 1 && active[0].quest.id === "8002", "进行中只含有进度行的任务");
    check(active[0].status === "ready", "可交付排在前面（active 排序口径）");
    // 8001 已领奖 → 8002 变可接的前提是它没有进度行；这里它有 accepted 行，所以可接只有链上的下一环
    const available = QuestStore.available();
    check(available.every((view) => QuestStore.statusOf(view.quest.id) === "available"), "可接列表里每条都是 available 态");
    check(!available.some((view) => view.quest.id === "8002"), "可接不含已接 / 已领奖的");
    QuestStore.applyState({ questId: "8002", status: "claimed", progress: 5, target: 5 });
    check(QuestStore.statusOf("8003") === "available", "前置 8002 领奖后 8003 解锁（链式门控）");
    QuestStore.reset();
  });

  guard(() => {
    QuestStore.reset();
    QuestStore.setLevel(1);
    // 0002 名下：8001 可接、8003 未解锁；9002 名下：8004 未解锁
    check(QuestStore.markOf("0002") === "!", "有可接任务 → NPC 头顶 !");
    check(QuestStore.markOf("9002") === null, "任务全未解锁 → 不挂标记");
    check(QuestStore.markOf("1234") === null, "没有任务的 NPC → 不挂标记");

    QuestStore.applyStates([{ questId: "8001", status: "ready", progress: 1, target: 1 }]);
    check(QuestStore.markOf("0002") === "?", "有可交付 → ? 压过 !（先交再谈接新的）");
    check(QuestStore.atNpc("0002").length === 2, "atNpc 返回该 NPC 名下全部任务视图");

    let fired = 0;
    const off = QuestStore.onChange(() => (fired += 1));
    QuestStore.applyState({ questId: "8002", status: "accepted", progress: 1, target: 5 });
    check(fired === 1, "onChange 在状态变化时触发（追踪栏 / 标记靠它刷新）");
    off();
    QuestStore.applyState({ questId: "8002", status: "accepted", progress: 2, target: 5 });
    check(fired === 1, "退订后不再触发（订阅函数成对给）");
    QuestStore.reset();
    check(QuestStore.statusOf("8001") === "available" && QuestStore.active().length === 0, "reset 清空（切角色不留旧进度）");
  });

  guard(() => {
    // 配置表本身的不变量：奖励物品 id 非空、目标数量 ≥1、主线链不成环
    const list = [...quests.values()];
    check(list.length >= 5, "任务配置至少 5 条（主线 4 + 日常 1）");
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
    check(serverQuest.includes("已完成的主线不能重复接"), "已完成的主线不能再接（daily 靠删行回到可接）");
  });

  guard(() => {
    check(serverQuest.includes('quest.objective_type === "collect"'), "交付时 collect 型按目标类型分流");
    check(serverQuest.includes("grantQuestRewards"), "发奖走 RolesService 的单次落库（扣材料 + 发奖励 + 升级）");
    check(serverQuest.includes("this.progressRepo.remove(role.id, questId)"), "日常领奖后删行（可重接、进度清零）");
    check(serverQuest.includes("markClaimed"), "主线领奖后保留 claimed 行（作链门控）");
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
    check(!/distance|getWorldPosition/.test(dialog), "v1 不做距离校验（位置是客户端权威，拿它当准入等于自己说了算）");
  });

  guard(() => {
    const spawner = read(CLIENT_SPAWNER);
    check(spawner.includes("QuestTalk.report(id)"), "点 NPC 即上报一次对话（talk 进度入口）");
    check(spawner.includes("QuestNpcMarks.attach(npcNode, id)"), "NPC 落位后挂头顶标记");
    check(spawner.includes("npc.onClick && npc.onClick()"), "原有点击行为保留（传送 / 战魂不因任务改动失效）");
    const bottomBar = read(CLIENT_BOTTOM_BAR);
    check(bottomBar.includes("task: () => this.questDialog.open()"), "底部「任务」入口接上任务弹窗");
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

  //#endregion
} catch (error) {
  fail(`任务单测跑挂：${error && error.message ? error.message : error}`);
}

finish("✅ 任务单测全绿");
