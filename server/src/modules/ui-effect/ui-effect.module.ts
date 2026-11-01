import { Module } from "@nestjs/common";
import { AdminUiEffectController } from "./ui-effect.controller";
import { UiEffectService } from "./ui-effect.service";

/**
 * 界面特效模块（#594：升级特效的表现参数归服务端）
 *
 * 与 game-config 分开的原因同地图（#573）：这里管的不是「客户端配置的镜像」，
 * 而是特效自己的表现参数（摆位 / 缩放 / 旋转 / 时长 / 开关），特效的**图集本体**
 * 根本不在服务端（在客户端资源包里，路径是两端约定）。混进 game-config 会让人
 * 以为「特效也能像装备那样整套替换」。
 *
 * 仓储由全局 DatabaseModule 提供；seed 在 `UiEffectService.onModuleInit`
 * （按 `UI_EFFECT_DEFAULTS` 补行，`INSERT OR IGNORE` 幂等，api 与 realtime 两个进程
 * 各跑一次也无副作用）。`exports: UiEffectService` 是给 `ClientConfigService`
 * （配置快照）用的 —— 客户端拿到快照后在触发特效时自己读参数。
 */
@Module({
  controllers: [AdminUiEffectController],
  providers: [UiEffectService],
  exports: [UiEffectService],
})
export class UiEffectModule {}
