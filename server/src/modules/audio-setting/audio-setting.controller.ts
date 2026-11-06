import { Body, Controller, Get, Param, Patch } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permission } from "../../common/constants/permission";
import { AUDIO_LIMITS } from "../../common/constants/audio";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { AudioSettingDto, AudioSettingListDto, SaveAudioSettingDto } from "./dto/audio-setting.dto";
import { AudioSettingService } from "./audio-setting.service";

/**
 * 管理端 · 音效配置（#680）
 *
 * 管的是「用哪个文件 / 多大声 / 循环不循环 / 开不开」，不是音频本体：文件在客户端资源包
 * （`client/assets/resources/audio/`），服务端只存资源相对路径。
 *
 * 所以**没有 POST / DELETE**：一个 key 存在的前提是客户端有播它的代码（登录背景音 `login_bgm`、
 * 按钮点击音 `ui_click`）。后续加音效（如「战斗背景音」「拾取音」）= 客户端写播放入口 +
 * `AUDIO_KEYS` 登记 + `AUDIO_DEFAULTS` 给出厂值，页面自动多一行。
 *
 * 客户端怎么拿到（#683）：进游戏走配置快照的 `audio` 段，登录场景走公开接口
 * `GET /game-config/audio` —— 两条路同形状，见 `AudioSettingService.configs()`。
 */
@ApiAudience("admin")
@Controller("admin/audio-settings")
export class AdminAudioSettingController {
  constructor(private readonly audioSettingService: AudioSettingService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminAudioSetting.list",
    summary: "音效列表",
    description:
      "全部音效项的配置：文件路径 / 音量 / 循环 / 开关 + 展示名 + 追账字段。\n\n" +
      "行由启动 seed 按 `AUDIO_DEFAULTS` 补出来，**没有新建 / 删除接口** ——\n" +
      "key 的取值域由客户端的播放入口决定（`login_bgm` 登录场景背景音 / `ui_click` 全站按钮点击音）。\n\n" +
      "`filePath` 是相对 `client/assets/resources/` 的路径（带扩展名，如 `audio/login-bg.wav`）；\n" +
      "**空串 = 未配置**（这一项不响），不是错误。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiDataResponse(AudioSettingListDto, { description: "音效列表（total / list）" })
  list(): AudioSettingListDto {
    return this.audioSettingService.list();
  }

  // 路由参数必须是 :id —— @AuditTarget("audioSetting") 的 targetId 取 request.params?.id（审计拦截器口径）
  @Patch(":id")
  @AuditTarget("audioSetting")
  @ApiAdminDoc({
    operationId: "adminAudioSetting.save",
    summary: "保存一个音效项（整份覆盖）",
    description:
      "改的是「文件路径 / 音量 / 循环 / 开关」四项，**整份覆盖**（不是部分更新：这四项是一组联动状态，\n" +
      "分字段更新会留下上一次的其它字段）。\n\n" +
      "- `filePath`：相对 `client/assets/resources/`、**带扩展名**、只能放 `audio/` 下，\n" +
      `  例如 \`audio/login-bg.wav\`；扩展名限 ${AUDIO_LIMITS.extensions.join(" / ")}；\n` +
      "  空串 = 未配置（文件还没进资源包时就这样留着）。服务端**不检查文件是否存在** ——\n" +
      "  资源包不在服务端，查了只会掩盖「本地有、线上没有」；存在性由管理端的试听按钮当场暴露。\n" +
      `- \`volume\`：${AUDIO_LIMITS.volumeMin}~${AUDIO_LIMITS.volumeMax} 的整数（百分比）。\n` +
      "- `enabled = false`：客户端整个不播（连文件都不读），与「音量调 0」不是一回事。\n\n" +
      "保存后**下一次进游戏生效**：客户端进图时随配置快照取一次 `audio` 段（登录场景走公开接口\n" +
      "`GET /game-config/audio`），没有热更新 —— 已经在游戏里的那一次不会变。\n\n" +
      "key 不存在 → 404（`50037`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "音效 key（登录背景音 login_bgm、按钮点击音 ui_click）" })
  @ApiDataResponse(AudioSettingDto, { description: "保存后的音效配置（含追账字段）" })
  save(@Param("id") key: string, @Body() dto: SaveAudioSettingDto, @CurrentUser() actor: AuthenticatedUser): AudioSettingDto {
    return this.audioSettingService.save(key, dto, actor);
  }
}
