import { Injectable } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { EquipAlignRepository } from "../../database/repositories/equip-align.repository";
import { EquipAlignRow } from "../../database/rows";
import {
  EQUIP_ALIGN_ID_PATTERN,
  EquipAlignDto,
  EquipAlignListDto,
  SaveEquipAlignDto,
  serializePositions,
} from "./dto/equip-align.dto";

/**
 * 装备对齐几何（#513）
 *
 * 服务端在这里只做三件事：**存、发、删**。不做任何几何计算 ——
 * 「某件衣服在第 3 个方向上该偏移多少」是客户端布局问题，服务端算不出来，
 * 也不该为它维护第二套口径（那正是 #505 自动算法翻车的路子：服务端以为对，客户端看着歪）。
 *
 * 没有行 = 用客户端配置里的值，所以「重置」就是删行，不需要存默认值副本 ——
 * 默认值永远只有客户端 `configs/equipments.ts` / `configs/role.ts` 这一份。
 */
@Injectable()
export class EquipAlignService {
  constructor(private readonly repository: EquipAlignRepository) {}

  /** 整份下发（33 行上下，不分页） */
  list(): EquipAlignListDto {
    return { list: this.repository.list().map(EquipAlignDto.from) };
  }

  /**
   * 保存一条（**整份覆盖**保留 `outManual` 的语义：勾了就存 1，没勾存 0）
   *
   * `updated_by` 记当前管理员账号名而不是 id：审计日志里也是账号名，两处对得上才追得动
   * 「上周三把 cloth_1 拖歪了的是谁」。
   */
  save(id: string, dto: SaveEquipAlignDto, actor: AuthenticatedUser): EquipAlignDto {
    this.requireIdForm(id);
    const row: EquipAlignRow = {
      id,
      out_scale: dto.outScale,
      out_positions: serializePositions(dto.outPositions),
      out_manual: dto.outManual ? 1 : 0,
      updated_by: actor.username,
      updated_at: Date.now(),
    };
    this.repository.upsert(row);
    return EquipAlignDto.from(row);
  }

  /**
   * 重置为客户端配置里的值（删行）
   *
   * **幂等**：删 0 行也算成功。它表达的是「这件回到默认」这个**状态**，
   * 不是「删掉某条记录」这个动作 —— 工作台上「还原本件」连点两次不该第二次报 404。
   */
  remove(id: string): void {
    this.requireIdForm(id);
    this.repository.remove(id);
  }

  /**
   * id 形态校验（**不查是否存在**）
   *
   * 装备 id 的清单在客户端配置里（变体规则在代码里），服务端没有那份表；硬编一份百科
   * 会与配置漂移，而且会让「新增一件衣服得先发服务端」成为事实上的发布顺序依赖。
   * 所以只校验形态：允许未知 id，页面上调得出来就存得进去。
   */
  private requireIdForm(id: string): void {
    if (!EQUIP_ALIGN_ID_PATTERN.test(id)) {
      throw new BizException(
        BizCode.PARAM_INVALID,
        `对齐目标 id 形态不合法：${id}（应为 cloth:<基础件> / weapon:<基础件> / role:<1|2>）`,
      );
    }
  }
}
