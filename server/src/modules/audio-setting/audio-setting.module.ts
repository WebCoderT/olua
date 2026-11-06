import { Module } from "@nestjs/common";
import { AdminAudioSettingController } from "./audio-setting.controller";
import { AudioSettingService } from "./audio-setting.service";

/**
 * 音效模块（#680：登录背景音 / 按钮点击音的可配置化）
 *
 * 与特效模块同一取向，但有一处**关键差别**：特效的图集路径是两端约定（`effect/<key>/<key>.plist`），
 * 换美术必须重打包；音效的文件是运营挑的，所以**路径入库**（`audio/xxx.wav`）——
 * 换一首登录曲只要新文件已经在资源包里，不用重打客户端。
 *
 * 仓储由全局 DatabaseModule 提供；seed 在 `AudioSettingService.onModuleInit`
 * （按 `AUDIO_DEFAULTS` 补行，`INSERT OR IGNORE` 幂等，api 与 realtime 两个进程各跑一次也无副作用）。
 * `exports: AudioSettingService` 是给下一步「配置快照下发客户端」留的口子 ——
 * 本轮客户端还没有播放代码，服务端不下发。
 */
@Module({
  controllers: [AdminAudioSettingController],
  providers: [AudioSettingService],
  exports: [AudioSettingService],
})
export class AudioSettingModule {}
