import { Injectable } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { EquipInAlignRepository } from "../../database/repositories/equip-in-align.repository";
import { EquipInAlignRow } from "../../database/rows";
import {
  EQUIP_IN_ALIGN_ID_PATTERN,
  EquipInAlignDto,
  EquipInAlignListDto,
  SaveEquipInAlignDto,
} from "./dto/equip-in-align.dto";

/**
 * 装备内观几何（#523）
 *
 * 与外观同一套职责边界：**只存、发、删**，不做任何几何计算。内观的问题本来就是
 * 「自动算法猜不准」（`RoleInShowView` 按当前衣服的内容 bbox 现算武器位置，换件衣服就飘），
 * 服务端再算一套只会多一个不一致的来源。
 *
 * 没有行 = 用客户端配置里的值，所以「重置」就是删行，默认值只有
 * `client/assets/configs/equipments.ts` 这一份。
 */
@Injectable()
export class EquipInAlignService {
  constructor(private readonly repository: EquipInAlignRepository) {}

  /** 整份下发（31 行上下，不分页） */
  list(): EquipInAlignListDto {
    return { list: this.repository.list().map(EquipInAlignDto.from) };
  }

  /**
   * 保存一条（整份覆盖）
   *
   * `updated_by` 记管理员账号名（与审计日志同一个口径），追「上周谁把这件衣服挪下圆盘」时
   * 两处能对上。
   */
  save(id: string, dto: SaveEquipInAlignDto, actor: AuthenticatedUser): EquipInAlignDto {
    this.requireIdForm(id);
    const row: EquipInAlignRow = {
      id,
      in_scale_x: dto.inScaleX,
      in_scale_y: dto.inScaleY,
      in_x: dto.inPosition.x,
      in_y: dto.inPosition.y,
      in_manual: dto.inManual ? 1 : 0,
      updated_by: actor.username,
      updated_at: Date.now(),
    };
    this.repository.upsert(row);
    return EquipInAlignDto.from(row);
  }

  /**
   * 重置为客户端配置里的值（删行）
   *
   * **幂等**：删 0 行也算成功 —— 它表达的是「这件回到默认」这个状态，
   * 工作台上「还原本件」连点两次不该第二次报 404。
   */
  remove(id: string): void {
    this.requireIdForm(id);
    this.repository.remove(id);
  }

  /** id 形态校验（不查存在性：装备清单在客户端配置里，服务端硬编会漂移） */
  private requireIdForm(id: string): void {
    if (!EQUIP_IN_ALIGN_ID_PATTERN.test(id)) {
      throw new BizException(
        BizCode.PARAM_INVALID,
        `内观对齐目标 id 形态不合法：${id}（应为 cloth:<基础件> / weapon:<基础件>）`,
      );
    }
  }
}
