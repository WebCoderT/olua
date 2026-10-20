import { Module } from "@nestjs/common";
import { RolesModule } from "../roles/roles.module";
import { WorldModule } from "../world/world.module";
import { CombatSettlementService } from "./combat-settlement.service";
import { RealtimeController } from "./realtime.controller";
import { RealtimeService } from "./realtime.service";

/**
 * 实时模块（服务端侧的 WebSocket 通道）
 *
 * 战斗结算（#34）要读在线角色的存档（技能等级 → 伤害系数），所以引入 `RolesModule`
 * —— 归属校验与「不透明文档」的解析都在那一条路上，不在这里另开一条。
 * 世界权威（#35）是另一个模块：结算往世界实例上扣血、进图走 worldJoin，
 * 通道只是世界状态的「喇叭」（广播出口由本模块接线到世界层）。
 */
@Module({
  imports: [RolesModule, WorldModule],
  controllers: [RealtimeController],
  providers: [RealtimeService, CombatSettlementService],
})
export class RealtimeModule {}
