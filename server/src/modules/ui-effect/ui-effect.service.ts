import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { UI_EFFECT_DEFAULTS, UI_EFFECT_KEYS } from "../../common/constants/ui-effect";
import { UiEffectRow } from "../../database/rows";
import { UiEffectRepository } from "../../database/repositories/ui-effect.repository";
import { SaveUiEffectDto, UiEffectConfigDto, UiEffectDto, UiEffectListDto } from "./dto/ui-effect.dto";

/**
 * 特效管理（#594 升级特效 / #634 掉落光效）
 *
 * 管的是**表现参数**（摆位 / 缩放 / 旋转 / 时长 / 开关），与武器外观（`inScaleX / inScaleY /
 * inRotate / inPosition`）同一套取向。图集本体在客户端资源包里（`upgrade` = `effect/<key>/<key>.plist`、
 * 掉落光效 = `effect/light/<key>.plist`，都是两端约定，资源路径不入库 —— 理由见
 * `common/constants/ui-effect` 顶部），所以：
 *
 * - **没有新建 / 删除接口**：行由 `onModuleInit` 按 `UI_EFFECT_DEFAULTS` 补出来（幂等），
 *   一个 key 在不在取决于客户端有没有这个特效的消费代码 —— 后台造一行没人消费的行，
 *   等于一个永远不生效的开关。后续加特效 = 客户端写消费代码 + `UI_EFFECT_KEYS` 登记 +
 *   `UI_EFFECT_DEFAULTS` 给出厂值，三步。
 * - **读库即最新**：快照接口每次查表，保存后下一位触发特效的玩家就按新参数演。
 */
@Injectable()
export class UiEffectService implements OnModuleInit {
  private readonly logger = new Logger(UiEffectService.name);

  constructor(private readonly uiEffects: UiEffectRepository) {}

  /** 按出厂值清单补行（幂等；运营改过的行不会被重启盖回来） */
  onModuleInit(): void {
    let seeded = 0;
    for (const key of UI_EFFECT_KEYS) {
      if (this.uiEffects.getByKey(key)) continue;
      const preset = UI_EFFECT_DEFAULTS[key];
      this.uiEffects.seedRow({
        effect_key: key,
        offset_x: preset.offsetX,
        offset_y: preset.offsetY,
        scale_x: preset.scaleX,
        scale_y: preset.scaleY,
        rotate: preset.rotate,
        duration_ms: preset.durationMs,
        enabled: preset.enabled ? 1 : 0,
        updated_by: "",
        updated_at: 0,
      });
      seeded += 1;
    }
    if (seeded > 0) this.logger.log(`特效配置已补 ${seeded} 行（共 ${this.uiEffects.countAll()} 个特效）`);
  }

  /** 管理端列表（含追账字段） */
  list(): UiEffectListDto {
    const list = this.uiEffects.listAll().map((row) => this.dtoOf(row));
    const dto = new UiEffectListDto();
    dto.total = list.length;
    dto.list = list;
    return dto;
  }

  /** 配置快照的精简行（客户端只需要表现参数） */
  configs(): UiEffectConfigDto[] {
    return this.uiEffects.listAll().map((row) => ({
      key: row.effect_key,
      offsetX: row.offset_x,
      offsetY: row.offset_y,
      scaleX: row.scale_x,
      scaleY: row.scale_y,
      rotate: row.rotate,
      durationMs: row.duration_ms,
      enabled: row.enabled === 1,
    }));
  }

  /**
   * 保存一个特效的表现参数（整份覆盖）
   *
   * key 不认识 → 404（`UI_EFFECT_KEY_NOT_FOUND`）：不是参数错（400），是「没有这个特效」——
   * 客户端没有消费代码的 key 就算存进表里也不会有任何效果，不如直接挡住。
   */
  save(key: string, dto: SaveUiEffectDto, actor: AuthenticatedUser): UiEffectDto {
    const before = this.requireRow(key);
    const row: UiEffectRow = {
      ...before,
      offset_x: dto.offsetX,
      offset_y: dto.offsetY,
      scale_x: dto.scaleX,
      scale_y: dto.scaleY,
      rotate: dto.rotate,
      duration_ms: dto.durationMs,
      enabled: dto.enabled ? 1 : 0,
      updated_by: actor.username,
      updated_at: Date.now(),
    };
    this.uiEffects.update(row);
    this.logger.log(
      `特效 ${key} 已更新：摆位 (${before.offset_x},${before.offset_y})→(${row.offset_x},${row.offset_y}) / ` +
        `缩放 (${before.scale_x},${before.scale_y})→(${row.scale_x},${row.scale_y}) / 旋转 ${before.rotate}→${row.rotate} / ` +
        `时长 ${before.duration_ms}→${row.duration_ms}ms / 开关 ${before.enabled}→${row.enabled}`,
    );
    return this.dtoOf(row);
  }

  /** 取一行，没有就 404（用 notFound：`new BizException(code, msg)` 默认是 400） */
  private requireRow(key: string): UiEffectRow {
    const row = this.uiEffects.getByKey(key);
    if (!row) {
      throw BizException.notFound(BizCode.UI_EFFECT_KEY_NOT_FOUND, `特效 ${key} 不存在（客户端没有这个特效的消费代码）`);
    }
    return row;
  }

  private dtoOf(row: UiEffectRow): UiEffectDto {
    const dto = new UiEffectDto();
    dto.key = row.effect_key;
    dto.offsetX = row.offset_x;
    dto.offsetY = row.offset_y;
    dto.scaleX = row.scale_x;
    dto.scaleY = row.scale_y;
    dto.rotate = row.rotate;
    dto.durationMs = row.duration_ms;
    dto.enabled = row.enabled === 1;
    dto.updatedBy = row.updated_by;
    dto.updatedAt = row.updated_at;
    return dto;
  }
}
