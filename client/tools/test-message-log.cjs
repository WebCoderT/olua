#!/usr/bin/env node
/**
 * 消息记录单测（client/tools/test-message-log.cjs，issue #1224）
 *
 * 盯的不变量（改 MessageLogStore / 提示层埋点 / HUD 消息记录后必须全绿）：
 * A. 仓行为（**跑真类**）：push 保序、空串忽略、**满 1000 条整表清空重新累计**（不是淘汰最旧）、
 *    clear 只在有内容时通知、退订后不再回调
 * B. 埋点接线：普通提示 → 系统、拾取 → 获得、击杀经验 → 战斗、任务状态前进 → 任务；
 *    错误提示**不记**（校验反馈不是系统流水）
 * C. 会话口径：Game.onDestroy 里先 dispose 再 clear；仓里不出现请求 / 存档 / localStorage
 * D. 与稿一致：上限 1000（design/olua-ui/screens/04-hud.html 的口径）
 *
 * MessageLogStore 刻意不 import cc（同 ChatStore 的纪律），沙箱直接编译真源码跑断言。
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");

const CLIENT_STORE = "assets/ui/core/MessageLogStore.ts";
const CLIENT_TIP_FX = "assets/ui/helpers/parts/tip-fx.ts";
const CLIENT_DROP = "assets/ui/core/DropManager.ts";
const CLIENT_QUEST = "assets/ui/core/QuestStore.ts";
const CLIENT_GAME = "assets/ui/Game.ts";
const DESIGN_HUD = "../design/olua-ui/screens/04-hud.html";

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
  const outDir = prepare("olua-message-log", ["ui/core/MessageLogStore.ts"]);
  const MessageLogStore = require(path.join(outDir, "ui/core/MessageLogStore.js")).default;

  //#region A. 仓行为

  console.log("\n— A. 消息记录仓：保序 / 空串 / 满 1000 整表清空 —");

  guard(() => {
    MessageLogStore.clear();
    MessageLogStore.push("system", "系统提示一");
    MessageLogStore.push("gain", "拾取 荒漠血草 x12");
    MessageLogStore.push("fight", "+3,200 经验");
    MessageLogStore.push("quest", "「剿灭沙盗匪首」目标进度 2 / 3");
    const all = MessageLogStore.all();
    check(all.length === 4, "四条消息全部入仓");
    check(
      all.map((entry) => entry.category).join(",") === "system,gain,fight,quest",
      "分类与顺序按先来后到保留",
      all.map((entry) => entry.category).join(","),
    );
    check(
      all.every((entry, index) => index === 0 || entry.seq > all[index - 1].seq),
      "seq 自增（同毫秒也不会乱序）",
    );
    check(all.every((entry) => entry.timestamp > 0), "每条带时间戳（面板画 HH:MM 用）");

    const before = MessageLogStore.count();
    MessageLogStore.push("system", "");
    check(MessageLogStore.count() === before, "空串忽略（不上屏空白行）");
  });

  guard(() => {
    MessageLogStore.clear();
    let notified = 0;
    const off = MessageLogStore.onChange(() => (notified += 1));
    MessageLogStore.push("system", "通知一");
    check(notified === 1, "push 通知订阅者一次");
    off();
    MessageLogStore.push("system", "通知二");
    check(notified === 1, "退订后不再回调");
    check(MessageLogStore.count() === 2, "退订只影响通知，不影响入仓");
    MessageLogStore.clear();
    check(MessageLogStore.count() === 0, "clear 清空");
  });

  guard(() => {
    MessageLogStore.clear();
    let notified = 0;
    MessageLogStore.onChange(() => (notified += 1));
    MessageLogStore.clear();
    check(notified === 0, "空仓 clear 不发通知（onDestroy 里连通知都省掉）");
  });

  guard(() => {
    // 满 1000 条：整表清空、重新累计（用户口径「满 1000 条清空一次」）
    MessageLogStore.clear();
    const capacity = MessageLogStore.CAPACITY;
    check(capacity === 1000, "上限 1000 条（稿与用户口径）", `CAPACITY=${capacity}`);
    for (let i = 0; i < capacity; i++) MessageLogStore.push("system", `第 ${i} 条`);
    check(MessageLogStore.count() === capacity, "正好 1000 条时不清空（满 1000 才清）");
    MessageLogStore.push("system", "第 1001 条");
    check(MessageLogStore.count() === 1, "第 1001 条到达时整表清空、只留这一条（重新累计）");
    const only = MessageLogStore.all()[0];
    check(only && only.text === "第 1001 条", "清空后保留的是刚进来的那条，不是最旧的一条");
  });

  //#endregion

  //#region B. 埋点接线

  console.log("\n— B. 埋点接线：提示 / 拾取 / 经验 / 任务 —");

  const tipFx = read(CLIENT_TIP_FX);
  const drop = read(CLIENT_DROP);
  const quest = read(CLIENT_QUEST);
  const game = read(CLIENT_GAME);

  guard(() => {
    check(/MessageLogStore\.push\(log, text\)/.test(tipFx), "普通提示统一在 createFloatingTip 落一条（唯一出口）");
    check(
      /export function createTip\(name: string, params\?: TextParams, category: MessageLogCategory = "system"\)/.test(tipFx),
      "createTip 默认进「系统」分类",
    );
    check(
      /export function createTipText\(text: string, category: MessageLogCategory = "system"\)/.test(tipFx),
      "createTipText 同样带分类参数",
    );
    check(/createErrorTip[\s\S]{0,220}?errorFadeDuration, null\)/.test(tipFx), "错误提示传 null：校验反馈不进流水");
    check(/MessageLogStore\.push\("fight", text\)/.test(tipFx), "击杀经验写「战斗」分类");
  });

  guard(() => {
    check(
      /createTip\("pickup_tip"[\s\S]{0,160}?"gain"\)/.test(drop),
      "拾取提示写「获得」分类（按服务端 ok 之后那一句）",
    );
  });

  guard(() => {
    check(/if \(!prev\) return;/.test(quest), "任务首载不记（登录全量快照不该把所有进行中任务报一遍）");
    check(/MessageLogStore\.push\("quest", getText\("message_log_quest_claimed"/.test(quest), "交付记「已交付」");
    check(/MessageLogStore\.push\("quest", getText\("message_log_quest_ready"/.test(quest), "目标达成记「可交付」");
    check(/MessageLogStore\.push\("quest", getText\("message_log_quest_progress"/.test(quest), "进度增长记「目标进度」");
    check(/prev\.progress \?\? 0\)\) \{/.test(quest), "进度只增才记（回退/同值不刷屏）");
  });

  //#endregion

  //#region C. 会话口径 + 不落库

  console.log("\n— C. 会话口径：重新上线清空 / 不请求不落盘 —");

  guard(() => {
    check(/new MessageLog\(\)/.test(game) && /LayerManager\.addToUILayer\(this\.messageLog\)/.test(game), "Game 里创建并挂进 UI 层");
    const destroyBlock = game.slice(game.indexOf("onDestroy()"));
    const disposeAt = destroyBlock.indexOf("this.messageLog?.dispose()");
    const clearAt = destroyBlock.indexOf("MessageLogStore.clear()");
    check(disposeAt >= 0, "onDestroy 里 dispose 面板");
    check(clearAt >= 0, "onDestroy 里清仓");
    check(disposeAt >= 0 && clearAt > disposeAt, "先退订再清仓（#1188：clear 会 emit，反了就 null.xxx）");
  });

  guard(() => {
    const store = read(CLIENT_STORE);
    check(!/localStorage\s*\./.test(store), "仓不写 localStorage（重新上线必须真的空）");
    check(!/HttpClient|Api\.|fetch\(/.test(store), "仓不发请求（服务端不存这条流水）");
    check(!/from "cc"/.test(store), "仓不 import cc（沙箱可直接跑真类）");
  });

  guard(() => {
    const design = read(DESIGN_HUD);
    check(/1000/.test(design), "设计稿写的是 1000 条上限（稿与实现同一口径）");
    check(/不含聊天对话/.test(design), "设计稿写明不含聊天对话（实现只收系统消息）");
  });

  //#endregion
} catch (error) {
  fail(`单测无法运行：${error && error.message ? error.message : error}`);
}

if (!finish("消息记录单测全部通过")) process.exitCode = 1;
