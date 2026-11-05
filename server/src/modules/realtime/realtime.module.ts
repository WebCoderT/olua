import { Module } from "@nestjs/common";
import { RolesModule } from "../roles/roles.module";
import { QuestModule } from "../quest/quest.module";
import { PartyModule } from "../party/party.module";
import { WorldModule } from "../world/world.module";
import { BlockService } from "./block.service";
import { ChatService } from "./chat.service";
import { CombatSettlementService } from "./combat-settlement.service";
import { MapMonitorService } from "./map-monitor.service";
import { MonsterAiService } from "./monster-ai.service";
import { PlayerPresenceService } from "./player-presence.service";
import { RealtimeController } from "./realtime.controller";
import { RealtimeService } from "./realtime.service";
import { SoakPointService } from "./soak-point.service";

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
 * 队伍（#399）反过来：队伍态住 `PartyModule`（存档进程也要读），实时进程只是它的
 * **收发口**（帧、连接位置、屏蔽判定三根线在本模块接上去）—— 经验分成也在结算侧调用它。
 * 地图（#573）：进图条件**不在这一层判**（`worldJoin` 只登记）。登录与传送共用同一条
 * 消息，登录时进的就是玩家脚下那张图，硬拦会把人锁在门外；判定在客户端 `changeOnMap`，
 * 它读的是配置快照里那份 `maps`（服务端下发）。原因见 `MapService` 顶部。
 * 屏蔽（#398）不是消费者而是**过滤器**：聊天投递与互见帧都要先问它「这个收件人拉黑了对方吗」，
 * 缓存（`BlockService`）住在本模块 —— 只有实时进程需要它，放社交模块会让 HTTP 进程也养一份。
 */
@Module({
  imports: [RolesModule, QuestModule, WorldModule, PartyModule],
  controllers: [RealtimeController],
  providers: [
    RealtimeService,
    CombatSettlementService,
    MonsterAiService,
    PlayerPresenceService,
    MapMonitorService,
    ChatService,
    BlockService,
    // 泡点活动（#722）：在线 tick 发经验。住本模块的理由见服务头注释 ——
    // 拆进程形态里只有实时进程装载本模块，tick 天然只跑一份
    SoakPointService,
  ],
})
export class RealtimeModule {}
