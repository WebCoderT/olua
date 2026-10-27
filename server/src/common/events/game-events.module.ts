import { Global, Module } from "@nestjs/common";
import { GameEventsService } from "./game-events.service";

/**
 * 游戏事件总线模块（#401）
 *
 * `@Global()`：订阅方分散在 quest / achievement / realtime 三个模块里，
 * 每个都要 imports 一遍只会让「漏写一个 imports 就收不到事件」变成常态故障。
 */
@Global()
@Module({
  providers: [GameEventsService],
  exports: [GameEventsService],
})
export class GameEventsModule {}
