import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { GameEventsService, MonsterKilledEvent } from "../../common/events/game-events.service";
import { GameMailService } from "./game-mail.service";

/**
 * 战斗频道的消息投递（#436）
 *
 * 为什么是「订阅」而不是在结算里直接发：结算是打怪这条链路上最热的一段，
 * 它只应该 emit 一次 `monster:killed`（#401 定下的采集点唯一），
 * 谁想在这件事上做文章谁就订阅 —— 加一个频道不必再改一次结算代码。
 *
 * 只对 **boss** 落消息：普通怪一天能杀几百只，每只一条会把战斗频道变成日志。
 * boss 击杀本身是里程碑（20 只 BOSS 散布在 10~60 级），一条一封正好。
 *
 * 不带奖励：这条消息纯粹是「你干了件大事」的记录，奖励走它自己的掉落与经验路径 ——
 * 在这里再发一份东西就等于给 boss 加了隐藏奖励，那是数值设计的事，不该藏在消息里。
 */
@Injectable()
export class GameMailEventsService implements OnModuleInit {
  private readonly logger = new Logger(GameMailEventsService.name);

  constructor(
    private readonly events: GameEventsService,
    private readonly mails: GameMailService,
  ) {}

  onModuleInit(): void {
    this.events.on("monster:killed", (event) => this.onMonsterKilled(event));
    // 启动时把订阅数打出来：`monster:killed` 的订阅方分散在三处（任务 / 成就 / 战斗消息），
    // 少一个不会报错，只会「某些功能静默不生效」—— 这条日志是唯一的旁证
    this.logger.log(`战斗频道已订阅 monster:killed（当前订阅方 ${this.events.listenerCount("monster:killed")} 个）`);
  }

  private onMonsterKilled(event: MonsterKilledEvent): void {
    // 每只怪都打一行会把日志刷满（一天几百只），所以只有 debug 级别留痕；
    // 真正落了消息的那几只才用 info —— 排查「战斗频道为什么没消息」看订阅数那条就够
    this.logger.debug(`击杀事件：${event.monsterKey} tier=${event.monsterTier} role=${event.roleId}`);
    if (event.monsterTier !== "boss") return;
    this.logger.log(`战斗频道：${event.roleId} 击杀 ${event.monsterKey}（${event.monsterLabel}）`);
    this.mails.send(event.roleId, {
      channel: "combat",
      kind: "boss",
      title: `击杀 ${event.monsterLabel}`,
      body: `你击杀了 BOSS「${event.monsterLabel}」。这条记录留在战斗频道，方便回看自己的进度。`,
    });
  }
}
