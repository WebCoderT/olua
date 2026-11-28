#!/usr/bin/env node
/**
 * 消息记录单测（client/tools/test-message-log.cjs，issue #1224 建、#1229 扩）
 *
 * 盯的不变量（改 MessageLogStore / 角色差分 / 提示层埋点 / HUD 消息记录后必须全绿）：
 * A. 仓行为（**跑真类**）：push 保序、空串忽略、**满 1000 条整表清空重新累计**（不是淘汰最旧）、
 *    clear 只在有内容时通知、退订后不再回调
 * B. 埋点接线：普通提示 → 系统、任务状态前进 → 任务、错误提示**不记**；
 *    经验 / 拾取不再逐点手记（改由角色差分统一记，避免同一件事两条）
 * C. 角色差分（**跑真类**）：基线静默、经验/等级/货币/物品/四维/技能/成长线/装备/时装的差异各记一条、
 *    背包只换位置不记、血量魔法不记、幂等、换角色与 reset 只建基线
 * D. 会话口径：Game.onDestroy 里先 dispose 再 clear（并重置差分基线）；仓里不出现请求 / 存档 / localStorage
 * E. 与稿一致：上限 1000、不含聊天对话、个人流水口径（design/olua-ui/screens/04-hud.html）
 *
 * MessageLogStore / role-delta-log 刻意不 import cc（同 ChatStore 的纪律），沙箱直接编译真源码跑断言。
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");

const CLIENT_STORE = "assets/ui/core/MessageLogStore.ts";
const CLIENT_DELTA = "assets/ui/core/storage/role-delta-log.ts";
const CLIENT_BRIDGE = "assets/ui/core/storage/ui-bridge.ts";
const CLIENT_ROLE_CACHE = "assets/ui/core/storage/role-cache.ts";
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
  const outDir = prepare("olua-message-log", ["ui/core/MessageLogStore.ts", "ui/core/storage/role-delta-log.ts"]);
  const MessageLogStore = require(path.join(outDir, "ui/core/MessageLogStore.js")).default;
  const RoleDeltaLog = require(path.join(outDir, "ui/core/storage/role-delta-log.js")).default;

  //#region A. 仓行为

  console.log("\n— A. 消息记录仓：保序 / 空串 / 满 1000 整表清空 —");

  guard(() => {
    MessageLogStore.clear();
    MessageLogStore.push("system", "系统提示一");
    MessageLogStore.push("gain", "获得 荒漠血草 ×12");
    MessageLogStore.push("exp", "经验 +3,200");
    MessageLogStore.push("quest", "「剿灭沙盗匪首」目标进度 2 / 3");
    const all = MessageLogStore.all();
    check(all.length === 4, "四条消息全部入仓");
    check(
      all.map((entry) => entry.category).join(",") === "system,gain,exp,quest",
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
      /export function createTip\(name: string, params\?: TextParams, category: MessageLogCategory \| null = "system"\)/.test(tipFx),
      "createTip 默认进「系统」分类，且允许传 null（只飘字不入流水）",
    );
    check(
      /export function createTipText\(text: string, category: MessageLogCategory \| null = "system"\)/.test(tipFx),
      "createTipText 同样带分类参数",
    );
    check(/createErrorTip[\s\S]{0,220}?errorFadeDuration, null\)/.test(tipFx), "错误提示传 null：校验反馈不进流水");
    check(!/MessageLogStore\.push\("fight"/.test(tipFx), "击杀经验不再在提示层单独记（#1229：经验差异统一由角色差分记）");
  });

  guard(() => {
    check(
      /createTip\("pickup_tip"[\s\S]{0,240}?null\)/.test(drop),
      "拾取只飘字不入流水（进包那一刻由背包差异记「获得 X ×N」，覆盖购买/邮件/任务奖励）",
    );
    check(!/createTip\("pickup_tip"[\s\S]{0,240}?"gain"\)/.test(drop), "拾取不再自己写一条（否则同一件事两条）");
  });

  guard(() => {
    check(/if \(!prev\) return;/.test(quest), "任务首载不记（登录全量快照不该把所有进行中任务报一遍）");
    check(/MessageLogStore\.push\("quest", getText\("message_log_quest_claimed"/.test(quest), "交付记「已交付」");
    check(/MessageLogStore\.push\("quest", getText\("message_log_quest_ready"/.test(quest), "目标达成记「可交付」");
    check(/MessageLogStore\.push\("quest", getText\("message_log_quest_progress"/.test(quest), "进度增长记「目标进度」");
    check(/prev\.progress \?\? 0\)\) \{/.test(quest), "进度只增才记（回退/同值不刷屏）");
  });

  //#endregion

  //#region C. 角色差分（#1229）

  console.log("\n— C. 角色差分：基线 / 经验 / 等级 / 货币 / 物品 / 成长 —");

  /** 深拷贝一份角色（差分要「先建基线再改一处」，共享引用会把基线一起改掉） */
  const cloneRole = (value) => JSON.parse(JSON.stringify(value));
  /** 造一个够用的角色（只带差分关心的字段；hp / mp 故意带上，用来验证「操作态不记」） */
  const makeRole = (over = {}) => ({
    id: "role_1",
    level: 40,
    exp: 1200,
    bindGold: 500,
    skillPoints: 2,
    attrPoints: 1,
    combat: 1234,
    soulOfWar: 0,
    title: 0,
    rank: 0,
    hp: 900,
    mp: 300,
    attrs: { str: 3, agi: 0, vit: 1, spi: 0 },
    skills: { skill_1: 1 },
    bag: [[{ id: "good_a", count: 5 }, null], [null, null]],
    equipments: { WEAPON: null, HELMET: null },
    fashionCloth: null,
    ...over,
  });
  /** 从第 from 条起的新增流水（`分类|文案`，方便一条断言看全貌） */
  const textsSince = (from) => MessageLogStore.all().slice(from).map((entry) => `${entry.category}|${entry.text}`);
  /** 清仓 + 重置基线 + 用这份角色建基线 */
  const resetBase = (role) => {
    MessageLogStore.clear();
    RoleDeltaLog.reset();
    RoleDeltaLog.note(cloneRole(role));
  };

  guard(() => {
    MessageLogStore.clear();
    RoleDeltaLog.reset();
    RoleDeltaLog.note(makeRole());
    RoleDeltaLog.note(makeRole());
    check(MessageLogStore.count() === 0, "首次与无变化的 note 都不写流水（登录那份存量不算「刚发生」）");
  });

  guard(() => {
    resetBase(makeRole());
    RoleDeltaLog.note(makeRole({ exp: 3200 }));
    const lines = textsSince(0);
    check(lines.length === 1 && lines[0] === "exp|经验 +2,000", "经验增加记一条（带符号 + 千分位）", lines.join(" / "));
  });

  guard(() => {
    resetBase(makeRole());
    RoleDeltaLog.note(makeRole({ level: 41, exp: 0, skillPoints: 3, attrPoints: 2, combat: 1400 }));
    const lines = textsSince(0);
    check(lines[0] === "level|等级提升 Lv.40 → Lv.41", "等级提升记一条", lines[0]);
    check(!lines.some((line) => line.startsWith("exp|")), "升级把经验条清零不记成「经验 -1,200」");
    check(lines.includes("growth|技能点 +1") && lines.includes("growth|属性点 +1"), "升级附带的点数一并入流");
    check(lines.includes("growth|战斗力 +166"), "战斗力变化入流", lines.join(" / "));
  });

  guard(() => {
    resetBase(makeRole());
    RoleDeltaLog.note(makeRole({ bindGold: 800 }));
    RoleDeltaLog.note(makeRole({ bindGold: 500 }));
    const lines = textsSince(0);
    check(
      lines[0] === "money|绑定元宝 +300" && lines[1] === "money|绑定元宝 -300",
      "金额增减各记一条（进位与减少都带符号）",
      lines.join(" / "),
    );
  });

  guard(() => {
    RoleDeltaLog.configure({ itemName: (id) => (id === "good_a" ? "荒漠血草" : id) });
    resetBase(makeRole());
    RoleDeltaLog.note(makeRole({ bag: [[{ id: "good_a", count: 17 }, { id: "good_b", count: 2 }], [null, null]] }));
    const lines = textsSince(0);
    check(lines.includes("gain|获得 荒漠血草 ×12"), "背包件数增加记「获得 名称 ×N」（按 id 聚合）", lines.join(" / "));
    check(lines.includes("gain|获得 good_b ×2"), "同一批进包的另一件各记一条");
    const before = MessageLogStore.count();
    RoleDeltaLog.note(makeRole({ bag: [[{ id: "good_a", count: 5 }], [null, null]] }));
    check(textsSince(before).includes("gain|消耗 荒漠血草 ×12"), "件数减少记「消耗 名称 ×N」");
  });

  guard(() => {
    resetBase(makeRole({ bag: [[{ id: "good_a", count: 5 }, null]] }));
    RoleDeltaLog.note(makeRole({ bag: [[null, { id: "good_a", count: 5 }]] }));
    check(MessageLogStore.count() === 0, "背包只换位置不记（格子位置是展示规则，流水只看件数）");
  });

  guard(() => {
    resetBase(makeRole());
    RoleDeltaLog.note(
      makeRole({
        attrs: { str: 4, agi: 0, vit: 1, spi: 0 },
        skills: { skill_1: 2 },
        soulOfWar: 1,
        title: 2,
        rank: 3,
        equipments: { WEAPON: { id: "eq_sword" }, HELMET: null },
        fashionCloth: "cloth_2",
      }),
    );
    const lines = textsSince(0);
    check(lines.includes("growth|力量 +1"), "四维加点入流（力量 / 敏捷 / 体质 / 精神）");
    check(lines.includes("growth|skill_1 升至 Lv.2"), "技能升级入流");
    check(
      lines.includes("growth|战魂 Lv.1") && lines.includes("growth|称号 Lv.2") && lines.includes("growth|军衔 第 3 阶"),
      "成长线阶位入流",
      lines.join(" / "),
    );
    check(lines.includes("growth|装备 eq_sword"), "穿上装备入流");
    check(lines.includes("growth|更换时装 cloth_2"), "换时装入流");
  });

  guard(() => {
    resetBase(makeRole({ equipments: { WEAPON: { id: "eq_sword" }, HELMET: null }, fashionCloth: "cloth_2" }));
    RoleDeltaLog.note(makeRole({ equipments: { WEAPON: null, HELMET: null }, fashionCloth: null }));
    const lines = textsSince(0);
    check(lines.includes("growth|脱下 eq_sword") && lines.includes("growth|脱下时装"), "脱下装备 / 时装入流", lines.join(" / "));
  });

  guard(() => {
    resetBase(makeRole());
    RoleDeltaLog.note(makeRole({ hp: 1, mp: 0 }));
    check(MessageLogStore.count() === 0, "血量 / 魔法变化不记（每次受击都变，会把流水刷没）");
  });

  guard(() => {
    resetBase(makeRole());
    RoleDeltaLog.note(makeRole({ exp: 1500 }));
    const afterFirst = MessageLogStore.count();
    check(afterFirst === 1, "经验 +300 记一条");
    RoleDeltaLog.note(makeRole({ exp: 1500 }));
    check(MessageLogStore.count() === afterFirst, "同一份数据再 note 一次不重复写（两个落点互为兜底、幂等）");
    RoleDeltaLog.note(makeRole({ id: "role_2", exp: 99999, bindGold: 99999 }));
    check(MessageLogStore.count() === afterFirst, "换角色只建基线（不跟前一个角色的数据比）");
    RoleDeltaLog.note(makeRole({ id: "role_2", exp: 100000, bindGold: 99999 }));
    check(
      textsSince(afterFirst).join("|") === "exp|经验 +1",
      "换角色之后的变化按新角色基线比",
      textsSince(afterFirst).join("|"),
    );
    RoleDeltaLog.reset();
    RoleDeltaLog.note(makeRole({ id: "role_2", bindGold: 1 }));
    check(textsSince(afterFirst).length === 1, "reset 之后第一次只建基线（下一局进游戏不会冒一串旧差异）");
  });

  guard(() => {
    const delta = read(CLIENT_DELTA);
    check(!/from "cc"/.test(delta), "差分模块不 import cc（沙箱可直接跑真实现）");
    check(!/localStorage|HttpClient|fetch\(/.test(delta), "差分模块不发请求、不落盘（服务端不存流水）");
    check(
      /if \(!prev \|\| prev\.roleId !== next\.roleId\) return;/.test(delta),
      "首次 / 换角色只建基线（源码级守点，不靠注释约定）",
    );
    check(
      /prev\.level !== next\.level/.test(delta) && /prev\.bindGold !== next\.bindGold/.test(delta) && /bagCounts\(role\)/.test(delta),
      "等级 / 货币 / 背包都在对比字段里",
    );
  });

  guard(() => {
    const bridge = read(CLIENT_BRIDGE);
    check(/RoleDeltaLog\.note\(role\)/.test(bridge), "updateRoleUi 里记流水（角色数据变化的单一出口）");
    check(/RoleDeltaLog\.configure\(\{/.test(bridge), "名称解析器在 ui 层注入（差分模块保持纯 TS）");
    const cache = read(CLIENT_ROLE_CACHE);
    check(/RoleDeltaLog\.note\(role\)/.test(cache), "updateOnlineRole 里也记（覆盖只刷背包不刷角色 UI 的路径）");
    check(/RoleDeltaLog\.reset\(\)/.test(game), "Game.onDestroy 里重置差分基线");
  });

  //#endregion

  //#region D. 会话口径 + 不落库

  console.log("\n— D. 会话口径：重新上线清空 / 不请求不落盘 —");

  guard(() => {
    check(/new MessageLog\(this\.messageLogPrefab!\)/.test(game) && /LayerManager\.addToUILayer\(this\.messageLog\)/.test(game), "Game 里用 prefab 创建并挂进 UI 层");
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
    check(/不含聊天对话/.test(design), "设计稿写明不含聊天对话（对话在左下常驻窗）");
    check(/个人流水/.test(design), "设计稿口径已改成「个人流水」（#1229：不只系统消息）");
    check(/经验/.test(design) && /货币/.test(design) && /升级/.test(design), "设计稿示例覆盖经验 / 货币 / 升级");
  });

  //#endregion
} catch (error) {
  fail(`单测无法运行：${error && error.message ? error.message : error}`);
}

if (!finish("消息记录单测全部通过")) process.exitCode = 1;
