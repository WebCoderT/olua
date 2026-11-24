import type { QuestState } from "../utils/net/ApiModels";
import { allQuests, quests } from "../../configs/game-config";
import type { QuestData } from "../../configs/game-config";
import { getText } from "../../configs/texts";
import MessageLogStore from "./MessageLogStore";

/**
 * 任务状态口径（#396）
 *
 * - `available` 可接：没有进度行，且等级够、前置链已完成；
 * - `accepted` 进行中；`ready` 可交付；`claimed` 已领奖（主线留行做链门控）；
 * - `locked` 未解锁：等级不够或前置没完成 —— **不发请求，客户端自己算**。
 */
export type QuestStatus = "available" | "accepted" | "ready" | "claimed" | "locked" | "unknown";

/** 一条任务在客户端的样子（配置 + 我的状态） */
export interface QuestView {
  quest: QuestData;
  status: QuestStatus;
  progress: number;
  target: number;
}

/**
 * 任务仓（#396：弹窗、追踪栏、NPC 头顶标记的**唯一数据源**）
 *
 * ## 分工
 * - **配置**来自 `configs/quest`（快照覆写后的注册表）；
 * - **我的状态**来自 HTTP（`/quests/me` 全量、接取/交付/对话的响应）与 realtime 的 `quest` 帧；
 * - 两者在这里合成「这条任务现在是什么状态」，消费者只读这里。
 *
 * ## 为什么「可接」由客户端算
 * 服务端只下发**有进度行的**任务（`/quests/me` 的注释写明了：可接的不在快照里）。
 * 「等级够不够、前置链通没通」是纯读计算，配置与 claimed 行都在手边 —— 让服务端多算一遍
 * 只会多一份会漂移的口径。接取时服务端仍会复核（20015 / 20016），客户端算错只是按钮白亮。
 *
 * ## 为什么不在这里发请求
 * 这个类要被 `tools/test-quest.cjs` 编译后直接断言（同 ChatStore 的纪律）：
 * 网络在消费者那边（弹窗 / NPC 对话入口），进来的是响应结果。状态归状态、IO 归 IO。
 */
export default class QuestStore {
  /** 我的进度行（questId → 状态）；`/quests/me` 全量覆盖 */
  private static states = new Map<string, QuestState>();
  /** 当前角色等级（可接判定用；0 = 还没设置，按「不门控」处理） */
  private static level = 0;
  private static listeners: Array<() => void> = [];

  /** 进游戏时带上等级（Game 组合根调用；升级后由同一处再调一次） */
  static setLevel(level: number): void {
    this.level = Math.max(0, Math.floor(level || 0));
    this.notify();
  }

  /** 清空（切场景 / 回登录：Game.destroy 调用） */
  static reset(): void {
    this.states.clear();
    this.level = 0;
    this.listeners = [];
  }

  /** 全量覆盖（`/quests/me`、接取、交付的响应都带完整快照） */
  static applyStates(states: QuestState[]): void {
    // 覆盖前留一份旧表：任务流水（#1224）靠「前后一比」判是不是刚发生的事 ——
    // 首载（登录时的 /quests/me）旧表为空，全部按「首次接触」跳过，不会把进行中的任务报一遍
    const before = this.states;
    const next = new Map<string, QuestState>();
    for (const state of states) {
      if (state && state.questId) next.set(state.questId, state);
    }
    this.states = next;
    // 用 forEach 而不是 for...of Map：打包走 babel loose，迭代器展开在这套配置里不可靠（见 olua-client 技能）
    next.forEach((state, questId) => this.logTransition(questId, before.get(questId) ?? null, state));
    this.notify();
  }

  /**
   * 合并一条（realtime `quest` 帧、NPC 对话的响应）
   *
   * 对话响应只带**该 NPC 名下**的任务，全量覆盖会把别人的进度抹掉，只能合并。
   */
  static applyState(state: QuestState): void {
    if (!state || !state.questId) return;
    const before = this.states.get(state.questId) ?? null;
    this.states.set(state.questId, state);
    this.logTransition(state.questId, before, state);
    this.notify();
  }

  /**
   * 任务流水（#1224，HUD 右下角消息记录的「任务」分类）
   *
   * 只在**状态真的前进**时记一句，四个判据：
   * - 首次接触（`prev` 为空）不记 —— 登录全量快照会把所有进行中任务都算成「新生」；
   * - `accepted → ready` 记「可交付」；`→ claimed` 记「已交付」；
   * - 进度增长（accepted 状态下 progress 变大）记「目标进度」。
   * 文案 key 在 `configs/texts`，任务名取配置表（查不到退回 id）。
   */
  private static logTransition(questId: string, prev: QuestState | null, next: QuestState): void {
    if (!prev) return;
    const quest = quests.get(questId);
    const label = quest?.label ?? questId;
    if (next.status === "claimed" && prev.status !== "claimed") {
      MessageLogStore.push("quest", getText("message_log_quest_claimed", { quest: label }));
      return;
    }
    if (next.status === "ready" && prev.status !== "ready") {
      MessageLogStore.push("quest", getText("message_log_quest_ready", { quest: label }));
      return;
    }
    const progress = Math.max(0, next.progress ?? 0);
    if (next.status === "accepted" && progress > Math.max(0, prev.progress ?? 0)) {
      // 分母优先用进度行上的 target（服务端已钳过），没给才退回配置的目标数
      const target = next.target > 0 ? next.target : quest?.objective.count ?? progress;
      MessageLogStore.push("quest", getText("message_log_quest_progress", { quest: label, done: progress, total: target }));
    }
  }

  /** 某条任务的进度行（没接过返回 null） */
  static stateOf(questId: string): QuestState | null {
    return this.states.get(questId) ?? null;
  }

  /** 某条任务现在的状态（配置里没有 → unknown） */
  static statusOf(questId: string): QuestStatus {
    const quest = quests.get(questId);
    if (!quest) return "unknown";
    const state = this.states.get(questId);
    if (state) return state.status as QuestStatus;
    return this.eligible(quest) ? "available" : "locked";
  }

  /** 某条任务的完整视图（配置里没有返回 null） */
  static view(questId: string): QuestView | null {
    const quest = quests.get(questId);
    if (!quest) return null;
    const state = this.states.get(questId);
    const status = this.statusOf(questId);
    return {
      quest,
      status,
      // 没接过 = 0 进度；collect 的进度由服务端按背包实有量算（客户端不自己数）
      progress: state ? Math.max(0, state.progress) : 0,
      target: state && state.target > 0 ? state.target : quest.objective.count,
    };
  }

  /** 全部任务视图（按配置顺序；未解锁的不返回，面板里没必要列一堆灰条） */
  static views(): QuestView[] {
    const out: QuestView[] = [];
    for (const quest of allQuests()) {
      const view = this.view(quest.id);
      if (view && view.status !== "locked" && view.status !== "unknown") out.push(view);
    }
    return out;
  }

  /** 进行中 + 可交付（追踪栏与「进行中」页签用；可交付排前面） */
  static active(): QuestView[] {
    const order: Record<string, number> = { ready: 0, accepted: 1 };
    return this.views()
      .filter((view) => view.status === "accepted" || view.status === "ready")
      .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
  }

  /** 可接（等级与前置链都满足、且没接过） */
  static available(): QuestView[] {
    return this.views().filter((view) => view.status === "available");
  }

  /** 某个 NPC 名下的任务（标记与对话入口用） */
  static atNpc(npcId: string): QuestView[] {
    return this.views().filter((view) => view.quest.npcId === npcId);
  }

  /** NPC 头顶标记：`?` 有可交付 > `!` 有可接 > null 没任务 */
  static markOf(npcId: string): "?" | "!" | null {
    const views = this.atNpc(npcId);
    if (views.some((view) => view.status === "ready")) return "?";
    if (views.some((view) => view.status === "available")) return "!";
    return null;
  }

  /** 订阅变化（返回取消函数；弹窗 / 追踪栏 / NPC 标记各订各的） */
  static onChange(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  /**
   * 可接判定：等级 + 主线链前置
   *
   * `prevQuestId` 只认 claimed（主线领奖后保留 claimed 行就是为这个）；
   * 日常（daily）没有前置，且**日切在服务端做**：领奖后行留成 claimed，过了 05:00 的行
   * 服务端根本不下发 —— 所以这里看到的日常只有「今天这一轮」，跨天后自然回到可接。
   */
  private static eligible(quest: QuestData): boolean {
    if (this.level > 0 && quest.minLevel > this.level) return false;
    if (!quest.prevQuestId) return true;
    return this.states.get(quest.prevQuestId)?.status === "claimed";
  }

  private static notify(): void {
    for (const listener of this.listeners) listener();
  }
}
