import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean, IsInt, IsString, Max, MaxLength, Min } from "class-validator";
import { AUDIO_CATEGORIES, AUDIO_LIMITS } from "../../../common/constants/audio";

/**
 * 音效配置的 DTO（#680）
 *
 * 管的是「用哪个文件 / 多大声 / 循环不循环 / 开不开」，不是音频本体：
 * 文件在客户端资源包里（`client/assets/resources/audio/`），服务端只存**资源相对路径**。
 *
 * 与特效管理（#594）同一取向：**没有新建 / 删除入参**。行由启动 seed 按 `AUDIO_DEFAULTS`
 * 补出来 —— 一个 key 存在的前提是客户端有播它的代码，后台凭空建一行只会得到永远不响的开关。
 *
 * 路径合法性（`audio/` 前缀、扩展名白名单、不许 `..`）由服务端在 `AudioSettingService`
 * 里校验并给人话提示，不写成 DTO 正则：正则的报错是英文技术串，运营看不懂。
 */

/** 管理端列表 / 保存返回的一行（含展示名与追账字段） */
export class AudioSettingDto {
  @ApiProperty({
    description: "音效 key（取值域见 AUDIO_KEYS：登录背景音 login_bgm、战士普攻 warrior_attack…）",
    example: "login_bgm",
  })
  key: string;

  @ApiProperty({ description: "展示名（中文，随接口下发 —— 页面不写死文案，加一个音效只改服务端常量）", example: "登录场景背景音" })
  label: string;

  @ApiProperty({
    description: `所属分类（管理端 tab 分组用；客户端不消费）。取值域：${AUDIO_CATEGORIES.map((item) => item.key).join(" / ")}`,
    example: "login",
  })
  category: string;

  @ApiProperty({ description: "分类展示名（随接口下发，页面不写死文案）", example: "界面与交互" })
  categoryLabel: string;

  @ApiProperty({
    description:
      "资源相对路径（带扩展名，相对 client/assets/resources/；空串 = 未配置，这一项不响）",
    example: "audio/login-bg.wav",
  })
  filePath: string;

  @ApiProperty({ description: `音量百分比（${AUDIO_LIMITS.volumeMin}~${AUDIO_LIMITS.volumeMax}，100 = 原始音量）` })
  volume: number;

  @ApiProperty({ description: "是否循环播放（背景音 true、点击音 false）" })
  loop: boolean;

  @ApiProperty({ description: "开关（false = 客户端整个不播，连文件都不读）" })
  enabled: boolean;

  @ApiProperty({ description: "最后一个改它的管理员账号名（追账用，与审计日志能对上）" })
  updatedBy: string;

  @ApiProperty({ description: "最后修改时间（毫秒时间戳；0 = 从没改过，仍是出厂值）" })
  updatedAt: number;
}

/** 保存一个音效项（整份覆盖） */
export class SaveAudioSettingDto {
  @IsString()
  @MaxLength(AUDIO_LIMITS.pathMaxLength)
  filePath!: string;

  @IsInt()
  @Min(AUDIO_LIMITS.volumeMin)
  @Max(AUDIO_LIMITS.volumeMax)
  volume!: number;

  @IsBoolean()
  loop!: boolean;

  @IsBoolean()
  enabled!: boolean;
}

/** 管理端列表（行由 seed 决定，个位数行，不分页） */
export class AudioSettingListDto {
  @ApiProperty({ description: "行数（= 音效 key 数）" })
  total!: number;

  @ApiProperty({
    description: "全部音效行，按 seed 顺序（= AUDIO_KEYS 登记顺序：登录背景音在前）",
    type: [AudioSettingDto],
  })
  list!: AudioSettingDto[];
}

/**
 * 客户端看到的音效配置（快照 `audio` 段 / 公开接口 `GET /game-config/audio` 共用）
 *
 * 比管理端那份少两样东西：
 * - **追账字段不要**（`updatedBy` / `updatedAt` 是运营排障用的，玩家不需要知道是谁改的）；
 * - **分类不要**：分类只决定管理端的 tab，客户端按 key 取用，多一个字段只会让人以为要读它。
 *
 * 路径**保留扩展名**（`audio/login-bg.wav`）—— 客户端 `resources.load` 前自己去扩展名，
 * 这样运营看到的与管理端一字不差，不会被「这里要带、那里不要带」绕进去。
 */
export class AudioConfigDto {
  @ApiProperty({ description: "音效 key（客户端按它取用，不认分类）", example: "login_bgm" })
  key: string;

  @ApiProperty({
    description: "资源相对路径（带扩展名，相对 resources/）；空串 = 未配置，这一项不播",
    example: "audio/login-bg.wav",
  })
  filePath: string;

  @ApiProperty({ description: `音量百分比（${AUDIO_LIMITS.volumeMin}~${AUDIO_LIMITS.volumeMax}，100 = 原始音量）` })
  volume: number;

  @ApiProperty({ description: "是否循环播放（true 的那一项是背景音：切场景要停）" })
  loop: boolean;

  @ApiProperty({ description: "开关（false = 客户端整个不播，连文件都不读）" })
  enabled: boolean;
}

/** 客户端音效配置列表（公开接口的返回体；快照里是裸数组，形状与本类的 list 一致） */
export class AudioConfigListDto {
  @ApiProperty({ description: "行数（= 音效 key 数）" })
  total!: number;

  @ApiProperty({ description: "全部音效配置，按 AUDIO_KEYS 登记顺序", type: [AudioConfigDto] })
  list!: AudioConfigDto[];
}

