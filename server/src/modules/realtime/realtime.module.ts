import { Module } from "@nestjs/common";
import { RolesModule } from "../roles/roles.module";
import { CombatSettlementService } from "./combat-settlement.service";
import { RealtimeController } from "./realtime.controller";
import { RealtimeService } from "./realtime.service";

/**
 * 实时模块（服务端侧的 WebSocket 通道）
 *
 * 战斗结算（#34）要读在线角色的存档（技能等级 → 伤害系数），所以引入 `RolesModule`
 * —— 归属校验与「不透明文档」的解析都在那一条路上，不在这里另开一条。
 * 结算的**状态**（目标登记簿 / 幂等账）仍只活在内存里：世界权威（#35）之前怪还在客户端，
 * 没什么值得落库的。
 */
@Module({
  imports: [RolesModule],
  controllers: [RealtimeController],
  providers: [RealtimeService, CombatSettlementService],
})
export class RealtimeModule {}
