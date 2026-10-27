import { Module } from "@nestjs/common";
import { RolesModule } from "../roles/roles.module";
import { QuestModule } from "../quest/quest.module";
import { WorldModule } from "../world/world.module";
import { ChatService } from "./chat.service";
import { CombatSettlementService } from "./combat-settlement.service";
import { MonsterAiService } from "./monster-ai.service";
import { PlayerPresenceService } from "./player-presence.service";
import { RealtimeController } from "./realtime.controller";
import { RealtimeService } from "./realtime.service";

/**
 * 实时模块（服务端侧的 WebSocket 通道）
 *
 * 战斗结算（#34）要读在线角色的存档（技能等级 → 伤害系数），所以引入 `RolesModule`
 * —— 归属校验与「不透明文档」的解析都在那一条路上，不在这里另开一条。
 * 世界权威（#35）是另一个模块：结算往世界实例上扣血、进图走 worldJoin，
 * 通道只是世界状态的「喇叭」（广播出口由本模块接线到世界层）。
 * 怪物 AI（#323）同样住在本模块：结算把「打伤了谁」递给它（记恨），它把受击结果
 * 与怪物位置通过广播出口发出去 —— AI 的输入（位置上报）与输出（广播帧）都走通道。
 * 玩家互见（#324）是同一模式的第三个消费者：pos 帧喂出在场表，players 帧发出去。
 * 聊天（#395）是第四个：chat 帧进来，ChatService 按频道选好收件人列表，
 * 广播出口照旧由本模块接线（世界频道复用互见的观看者集合）。
 */
@Module({
  imports: [RolesModule, QuestModule, WorldModule],
  controllers: [RealtimeController],
  providers: [RealtimeService, CombatSettlementService, MonsterAiService, PlayerPresenceService, ChatService],
})
export class RealtimeModule {}
