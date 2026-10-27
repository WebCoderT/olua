import { Injectable, Logger } from "@nestjs/common";

/**
 * 游戏事件与载荷（**唯一来源**）
 *
 * 只列**真有发布者与订阅者**的事件。加类型很容易，但「定义了没人发」的死事件
 * 会让后来者以为某条链路已经接通 —— 所以宁可加的时候多改一处。
 */
export interface MonsterKilledEvent {
  accountId: string;
  roleId: string;
  /** 怪物 key（不是实例 id：任务与成就都按种类判） */
  monsterKey: string;
  /** 怪物名（战斗频道写消息用 —— 订阅方不必为了一个名字再查一次库） */
  monsterLabel: string;
  /** 定位：normal / elite / boss（战斗频道只对 boss 落一条，普通怪不刷屏） */
  monsterTier: string;
}

export interface QuestClaimedEvent {
  accountId: string;
  roleId: string;
  questId: string;
  /** main | daily（成就的累计口径不分类，但订阅方要打日志时用得上） */
  kind: string;
}

export interface GameEventPayloads {
  "monster:killed": MonsterKilledEvent;
  "quest:claimed": QuestClaimedEvent;
}

export type GameEventType = keyof GameEventPayloads;
type Handler<K extends GameEventType> = (payload: GameEventPayloads[K]) => void;

/**
 * 游戏事件总线（#401）
 *
 * ## 为什么要有它
 * 在它之前，「打怪」这件事有**两个采集点**：任务进度在 `CombatSettlementService` 里
 * 直接调 `QuestService.onMonsterKilled`，以后成就再来一遍就是三处、四处 —— 每加一个
 * 消费者就要改一次结算代码。收成一条总线后，结算只 `emit` 一次，谁关心谁订阅。
 *
 * ## 两条硬约束
 * 1. **同步分发**：订阅方在自己这一拍里把库写完。事件不是消息队列 —— 击杀结算返回时，
 *    任务进度与成就进度必须已经落库，否则「打完怪立刻打开任务面板」会看到旧进度。
 * 2. **订阅方隔离**：某个订阅方抛错只打日志，**不影响其他订阅方、也不向上冒**。
 *    成就写库失败绝不能回滚一次真实的击杀（世界状态是权威，少记一笔进度可接受）。
 *
 * ## 边界
 * 进程内、单实例：这与当前 SQLite 单库的部署形态一致。真要跨进程广播，那是实时通道的事，
 * 不是这条总线 —— 别把两种「事件」混成一个概念。
 */
@Injectable()
export class GameEventsService {
  private readonly logger = new Logger(GameEventsService.name);

  private readonly handlers = new Map<GameEventType, Array<Handler<GameEventType>>>();

  /** 订阅（同类型可多个订阅方，按注册顺序调用） */
  on<K extends GameEventType>(type: K, handler: Handler<K>): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler as Handler<GameEventType>);
    this.handlers.set(type, list);
  }

  /**
   * 发布
   *
   * 逐个调用订阅方并各自兜异常：一个订阅方坏了，别的照常收到 —— 这是「进度类副作用
   * 一律可丢」的落地方式，也让新增订阅方不可能打断已有链路。
   */
  emit<K extends GameEventType>(type: K, payload: GameEventPayloads[K]): void {
    const list = this.handlers.get(type);
    if (!list || list.length === 0) return;
    for (const handler of list) {
      try {
        (handler as Handler<K>)(payload);
      } catch (error) {
        this.logger.warn(
          `事件 ${type} 的订阅方执行失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** 订阅方数量（单测与启动自检用：能回答「这条事件真有人接吗」） */
  listenerCount(type: GameEventType): number {
    return this.handlers.get(type)?.length ?? 0;
  }

  /** 清空订阅（进程退出 / 单测重置；正常业务不该调用） */
  clear(): void {
    this.handlers.clear();
  }
}
