import { Injectable, OnModuleInit } from "@nestjs/common";
import { GameEventsService, MonsterKilledEvent, QuestClaimedEvent } from "../../common/events/game-events.service";
import { EVENT_TYPE } from "../../common/constants/event-type";
import { EventLogService } from "./event-log.service";

/**
 * 把总线事件翻译成行为流水（#886）
 *
 * 只订阅**已经有采集点**的那两类（`monster:killed` / `quest:claimed`）——
 * 结算与任务交付各自只 emit 一次（#401 定下的「采集点唯一」），要留痕就订阅，
 * 不再回去改一次结算代码。
 *
 * 其余六类（登录 / 进图 / 拾取 / 获得 / 消耗 / 邮件）**没有**总线事件，由各自的
 * 写入口直接调 `EventLogService.record` —— 给它们硬造总线事件，等于往总线里塞一堆
 * 「只有一个订阅方」的类型，反而让「哪些事件真有人用」变得模糊。
 */
@Injectable()
export class EventLogListener implements OnModuleInit {
  constructor(
    private readonly events: GameEventsService,
    private readonly logs: EventLogService,
  ) {}

  onModuleInit(): void {
    this.events.on("monster:killed", (event) => this.onMonsterKilled(event));
    this.events.on("quest:claimed", (event) => this.onQuestClaimed(event));
  }

  private onMonsterKilled(event: MonsterKilledEvent): void {
    this.logs.record({
      type: EVENT_TYPE.KILL,
      accountId: event.accountId,
      roleId: event.roleId,
      roleName: event.roleName,
      mapId: event.mapId,
      target: event.monsterKey,
      // 一条流水 = 一只怪；要统计「一晚杀了多少」直接 SUM(amount)
      amount: 1,
      detail: { tier: event.monsterTier, label: event.monsterLabel, x: event.x, y: event.y },
    });
  }

  private onQuestClaimed(event: QuestClaimedEvent): void {
    this.logs.record({
      type: EVENT_TYPE.QUEST,
      accountId: event.accountId,
      roleId: event.roleId,
      roleName: event.roleName,
      target: event.questId,
      detail: { kind: event.kind },
    });
  }
}
