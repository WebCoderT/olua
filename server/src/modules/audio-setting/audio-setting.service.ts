import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { AUDIO_DEFAULTS, AUDIO_KEYS, AUDIO_LIMITS, audioLabelOf, audioPathProblem } from "../../common/constants/audio";
import { AudioSettingRow } from "../../database/rows";
import { AudioSettingRepository } from "../../database/repositories/audio-setting.repository";
import { AudioSettingDto, AudioSettingListDto, SaveAudioSettingDto } from "./dto/audio-setting.dto";

/**
 * 音效配置（#680）
 *
 * 管的是**用哪个文件 + 多大声 + 循环不循环 + 开不开**：
 *
 * - **没有新建 / 删除接口**：行由 `onModuleInit` 按 `AUDIO_DEFAULTS` 补出来（`INSERT OR IGNORE`，
 *   幂等；api 与 realtime 两个进程各跑一次也无副作用），一个 key 在不在取决于客户端有没有
 *   这个音效的播放入口 —— 后台造一行没人消费的行，等于一个永远不响的开关。
 * - **文件路径可换**：这是本模块与特效管理的差别。特效图集路径是两端约定（`effect/<key>/<key>.plist`），
 *   换美术必须重打包；音效的文件是运营挑的，所以路径**入库**（`sounds/xxx.wav`），
 *   换一首登录曲只要新文件已经在资源包里。
 * - **路径合法性在服务端判**：`sounds/` 前缀、扩展名白名单、不许 `..`、字符集收敛
 *   （判据在 `common/constants/audio` 的 `audioPathProblem`，管理端只做预检提示）。
 *
 * 本轮**不下发配置快照**：客户端还没有播放代码（用户 2026-11-04 明确「先不与客户端对接」）。
 * 对接时在 `ClientConfigService` 加一段 `audio`（读这里的 `list()` 即可），别在客户端写死默认值。
 */
@Injectable()
export class AudioSettingService implements OnModuleInit {
  private readonly logger = new Logger(AudioSettingService.name);

  constructor(private readonly audioSettings: AudioSettingRepository) {}

  /** 按出厂值清单补行（幂等；运营改过的行不会被重启盖回来） */
  onModuleInit(): void {
    let seeded = 0;
    for (const key of AUDIO_KEYS) {
      if (this.audioSettings.getByKey(key)) continue;
      const preset = AUDIO_DEFAULTS[key];
      this.audioSettings.seedRow({
        audio_key: key,
        file_path: preset.filePath,
        volume: preset.volume,
        loop: preset.loop ? 1 : 0,
        enabled: preset.enabled ? 1 : 0,
        updated_by: "",
        updated_at: 0,
      });
      seeded += 1;
    }
    if (seeded > 0) this.logger.log(`音效配置已补 ${seeded} 行（共 ${this.audioSettings.countAll()} 个音效项）`);
  }

  /** 管理端列表（含展示名与追账字段） */
  list(): AudioSettingListDto {
    const list = this.audioSettings.listAll().map((row) => this.dtoOf(row));
    const dto = new AudioSettingListDto();
    dto.total = list.length;
    dto.list = list;
    return dto;
  }

  /**
   * 保存一个音效项（整份覆盖）
   *
   * key 不认识 → 404（`AUDIO_KEY_NOT_FOUND`）：不是参数错（400），是「没有这个音效」——
   * 客户端没有播放入口的 key 就算存进表里也不会有任何声音，不如直接挡住。
   */
  save(key: string, dto: SaveAudioSettingDto, actor: AuthenticatedUser): AudioSettingDto {
    const before = this.requireRow(key);
    const filePath = this.requirePath(dto.filePath);
    const volume = this.requireVolume(dto.volume);
    const row: AudioSettingRow = {
      ...before,
      file_path: filePath,
      volume,
      loop: dto.loop ? 1 : 0,
      enabled: dto.enabled ? 1 : 0,
      updated_by: actor.username,
      updated_at: Date.now(),
    };
    this.audioSettings.update(row);
    this.logger.log(
      `音效 ${key} 已更新：文件 "${before.file_path || "(未配置)"}"→"${row.file_path || "(未配置)"}" / ` +
        `音量 ${before.volume}→${row.volume} / 循环 ${before.loop}→${row.loop} / 开关 ${before.enabled}→${row.enabled}`,
    );
    return this.dtoOf(row);
  }

  /**
   * 路径校验（人话提示，400 `PARAM_INVALID`）
   *
   * 只做「能不能用」，不判断文件是否真的存在 —— 服务端没有客户端资源包（资源不在镜像里），
   * 强行查会让「本地有、线上没有」这种真问题被掩盖。存在性由管理端的试听按钮当场暴露。
   */
  private requirePath(rawPath: string): string {
    const filePath = (rawPath ?? "").trim().replace(/\\/g, "/");
    const problem = audioPathProblem(filePath);
    if (problem) throw new BizException(BizCode.PARAM_INVALID, problem);
    return filePath;
  }

  /** 音量兜底（DTO 已经限过范围，这里挡住「跳过校验的调用方」与小数） */
  private requireVolume(rawVolume: number): number {
    const volume = Math.round(Number(rawVolume));
    if (!Number.isFinite(volume) || volume < AUDIO_LIMITS.volumeMin || volume > AUDIO_LIMITS.volumeMax) {
      throw new BizException(
        BizCode.PARAM_INVALID,
        `音量必须是 ${AUDIO_LIMITS.volumeMin}~${AUDIO_LIMITS.volumeMax} 之间的整数（当前 ${rawVolume}）`,
      );
    }
    return volume;
  }

  /** 取一行，没有就 404（用 notFound：`new BizException(code, msg)` 默认是 400） */
  private requireRow(key: string): AudioSettingRow {
    const row = this.audioSettings.getByKey(key);
    if (!row) {
      throw BizException.notFound(BizCode.AUDIO_KEY_NOT_FOUND, `音效 ${key} 不存在（客户端没有这个音效的播放入口）`);
    }
    return row;
  }

  private dtoOf(row: AudioSettingRow): AudioSettingDto {
    const dto = new AudioSettingDto();
    dto.key = row.audio_key;
    dto.label = audioLabelOf(row.audio_key);
    dto.filePath = row.file_path;
    dto.volume = row.volume;
    dto.loop = row.loop === 1;
    dto.enabled = row.enabled === 1;
    dto.updatedBy = row.updated_by;
    dto.updatedAt = row.updated_at;
    return dto;
  }
}
