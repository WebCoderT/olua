import type { ChatChannel, ChatEntry } from "../utils/net/CombatChannel";

/** 每个频道保留的最近消息条数（内存态；换场景整个 reset，聊天不跨会话持久） */
const MAX_PER_CHANNEL = 50;

/** 一个私聊对象（会话列表用：从私聊消息里聚出来，不单独存储） */
export interface ChatPeer {
  accountId: string;
  roleId: string;
  username: string;
}

/**
 * 聊天消息仓（#395：面板、气泡、未读角标的**唯一数据源**）
 *
 * ## 为什么是纯数据类
 * 消费者有三个（弹窗的消息列表、屏幕气泡、页签角标），它们生命周期各异
 * （弹窗会关、气泡会炸、角标常驻）——状态放任何一个消费者手里，另外两个
 * 都得「问」它，问的时机一错就丢消息。所以状态收在这里一处：
 * **`CombatChannel.onChat` 只喂这里，三个消费者各自订阅 `onChange`**。
 *
 * ## 回显即成功
 * 自己发的消息也在收到的帧里（服务端回显），所以这里**只有一条入口**
 * `applyEntry` —— 「发送时本地先插一条」是所有聊天 UI 经典的双写事故来源
 * （发送失败会多出一条没人回复的幽灵消息），不做。
 *
 * ## 未读
 * 每频道一个计数：非自己的消息 +1（弹窗开着也不加——开着的那个频道
 * 由弹窗在 `markRead` 里立刻清掉）。私聊的角标是唯一上界面上面的：
 * 气泡替世界 / 帮会扛「有人在说话」，角标替私聊扛「有人找我」。
 *
 * **刻意不 import cc**：这个类要被 `tools/test-chat.cjs` 直接编译断言，
 * 挂上引擎依赖单测就得连 Cocos 一起装 —— 状态归状态、演出归演出。
 */
export default class ChatStore {
  /** 各频道的消息（尾端最新；超上限从头丢） */
  private static messages = new Map<ChatChannel, ChatEntry[]>();
  /** 各频道未读数（非自己的消息累计，markRead 清零） */
  private static unread = new Map<ChatChannel, number>();
  /** 自己的账号 id（回显的消息不再计未读） */
  private static selfAccountId = "";
  private static listeners: Array<() => void> = [];

  /** 进游戏时带上自己（Game 组合根调用；判定「这条消息是不是我发的」用） */
  static setSelf(accountId: string): void {
    this.selfAccountId = accountId;
  }

  /** 清空（切场景 / 回登录：Game.destroy 调用） */
  static reset(): void {
    this.messages.clear();
    this.unread.clear();
    this.selfAccountId = "";
    this.listeners = [];
  }

  /** 唯一入口：服务端来的每一条聊天帧都走这里（含自己的回显） */
  static applyEntry(entry: ChatEntry): void {
    if (!entry || !entry.channel || !entry.from) return;
    const list = this.messages.get(entry.channel) ?? [];
    list.push(entry);
    if (list.length > MAX_PER_CHANNEL) list.splice(0, list.length - MAX_PER_CHANNEL);
    this.messages.set(entry.channel, list);
    if (entry.from.accountId !== this.selfAccountId) {
      this.unread.set(entry.channel, (this.unread.get(entry.channel) ?? 0) + 1);
    }
    this.notify();
  }

  /** 某频道的消息（引用只读约定：调用方别排序/改写，要变体自己复制） */
  static list(channel: ChatChannel): ChatEntry[] {
    return this.messages.get(channel) ?? [];
  }

  /** 某频道与一个人的私聊会话（from 或 to 任一侧是这个人就算） */
  static conversationWith(roleId: string): ChatEntry[] {
    return this.list("private").filter((entry) => entry.from.roleId === roleId || entry.to?.roleId === roleId);
  }

  /** 私聊对象列表（最近发言靠前；从消息里聚出来，不单独存储） */
  static privatePeers(): ChatPeer[] {
    const peers = new Map<string, ChatPeer>();
    // 倒着扫（尾端最新）：Map 按插入序去重，先插入的排前面 = 最近聊过的排前面
    for (let i = this.list("private").length - 1; i >= 0; i--) {
      const entry = this.list("private")[i];
      const other = entry.from.accountId === this.selfAccountId ? entry.to : { ...entry.from };
      if (!other || !other.roleId) continue;
      if (!peers.has(other.roleId)) {
        peers.set(other.roleId, { accountId: other.accountId, roleId: other.roleId, username: other.username });
      }
    }
    // 必须 Array.from，不能 `[...peers.values()]`：打包走 babel loose，展开迭代器被转成
    // `[].concat(迭代器)`，而 concat 不展开非数组 —— 返回值会变成「装着迭代器本身的数组」，
    // 调用方拿到的每一条都不是 peer（#471：私聊选人页因此多出一行空名字的幽灵行）
    return Array.from(peers.values());
  }

  /** 某频道未读数 */
  static unreadOf(channel: ChatChannel): number {
    return this.unread.get(channel) ?? 0;
  }

  /** 标记某频道已读（弹窗打开 / 切到该页签时调用） */
  static markRead(channel: ChatChannel): void {
    if (!this.unread.get(channel)) return;
    this.unread.delete(channel);
    this.notify();
  }

  /** 订阅变化（返回取消函数；弹窗 / 气泡 / 角标各订各的） */
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
