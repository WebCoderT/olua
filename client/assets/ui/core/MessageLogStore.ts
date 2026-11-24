/**
 * 消息记录仓（#1224：HUD 右下角常驻系统消息流水）
 *
 * ## 口径（用户 2026-11-24 拍板）
 * - **只收系统消息**：系统提示 / 获得 / 战斗 / 任务；**聊天对话不进这里**（聊天在左下 ChatStore）；
 * - **服务端不存**：纯客户端内存，不落存档、不发请求、不进 localStorage；
 * - **重新上线就清空**：`Game.onDestroy`（离开游戏场景回登录/选角）调 `clear()`，与 ChatStore 不跨会话一致；
 * - **上限 1000 条，满 1000 整表清空一次、重新累计**（产品规则，不是分页淘汰）。
 *
 * ## 为什么是静态仓（同 ChatStore / QuestStore 的纪律）
 * 写消息的是「提示层 / 任务 / 拾取 / 经验」这些互不认识的地方，读的只有 HUD 上的 MessageLog 一块，
 * 中间少一层就会变成「谁都得拿到面板引用」。仓在这里、消费者订阅 onChange，重画交给面板。
 *
 * ## 不 import cc
 * 本类要能被 `tools/test-message-log.cjs` 直接编译跑断言（同 ChatStore），所以只留纯 TypeScript。
 */
export type MessageLogCategory = "system" | "gain" | "fight" | "quest";

/** 一条消息记录（展示所需的最小字段） */
export interface MessageLogEntry {
  category: MessageLogCategory;
  /** 已经取好文案的正文（提示层负责把 key / 参数换成文字，仓不认文案） */
  text: string;
  /** 客户端本地时间（毫秒）；只用于显示 HH:MM，不参与任何判定 */
  timestamp: number;
  /** 自增序号（同一毫秒内多条也保持先来后到） */
  seq: number;
}

export default class MessageLogStore {
  /**
   * 条数上限：满 1000 条**整表清空**、从 0 重新累计（用户口径），不是淘汰最旧的一条。
   * 纯产品规则，与界面布局无关，所以留在仓里而不是 configs/layout。
   */
  static readonly CAPACITY = 1000;

  private static entries: MessageLogEntry[] = [];
  private static seq = 0;
  private static listeners: Array<() => void> = [];

  /** 记一条（文案由调用方取好；空串直接忽略，避免出现空白行） */
  static push(category: MessageLogCategory, text: string): void {
    if (!text) return;
    // 满 1000 条：先整表清空再记这一条 —— 计数从 0 重新累计（界面 head 的容量条同步归零）
    if (this.entries.length >= this.CAPACITY) this.entries = [];
    this.entries.push({ category, text, timestamp: Date.now(), seq: ++this.seq });
    this.notify();
  }

  /** 当前全部记录（按时间正序；返回副本，调用方改不动仓） */
  static all(): MessageLogEntry[] {
    return this.entries.slice();
  }

  /** 当前条数（head 的计数与容量条用） */
  static count(): number {
    return this.entries.length;
  }

  /**
   * 清空（离开游戏场景时调用：消息流水不跨会话）
   *
   * 有变动才 emit —— `Game.onDestroy` 里是「先 dispose 面板再 clear」，空仓时连通知都省掉。
   */
  static clear(): void {
    if (!this.entries.length) return;
    this.entries = [];
    this.notify();
  }

  /** 订阅变化（返回取消函数；面板销毁时退订） */
  static onChange(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  private static notify(): void {
    for (const listener of this.listeners) listener();
  }
}
