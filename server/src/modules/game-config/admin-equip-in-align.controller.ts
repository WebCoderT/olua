import { Body, Controller, Delete, Get, Param, Put } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse, ApiVoidResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permission } from "../../common/constants/permission";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { EquipInAlignService } from "./equip-in-align.service";
import { EquipInAlignDto, EquipInAlignListDto, SaveEquipInAlignDto } from "./dto/equip-in-align.dto";

/**
 * 管理端 · 装备内观几何（#523）
 *
 * 「内观对齐」工作台（`/equip-in-align`）的读写口：把每件衣服 / 每把武器摆到角色信息弹窗的
 * 圆盘上（武器以**第一件衣服**为参照，19 把共用同一个参照系），点保存直接落库，
 * 客户端下次打开弹窗就是新的位置。
 *
 * 与外观的 `admin/equip-aligns` 刻意不合并：两组几何的写操作必须独立 ——
 * 重置内观不该顺手把外观也清掉（反之亦然）。
 */
@ApiAudience("admin")
@Controller("admin/equip-in-aligns")
export class AdminEquipInAlignController {
  constructor(private readonly equipInAlignService: EquipInAlignService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminEquipInAlign.list",
    summary: "装备内观几何列表",
    description:
      "全部**已保存**的内观几何（不分页：12 件衣服 + 19 把武器，量很小）。\n\n" +
      "**没有行 = 用客户端配置里的值**（`client/assets/configs/equipments.ts` 的 `inPosition` / `inScaleX` / `inScaleY`），" +
      "所以「哪些调过」就是这份列表的 id 集合。\n\n" +
      "内观只有一个朝向（弹窗里角色正面站着），因此没有方向数组：`inPosition` 是一个点，" +
      "`inScaleX` / `inScaleY` 是两轴缩放（衣服常有 `inScaleX ≠ inScaleY` 的素材）。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiDataResponse(EquipInAlignListDto, { description: "全部已保存的内观几何" })
  list(): EquipInAlignListDto {
    return this.equipInAlignService.list();
  }

  @Put(":id")
  @AuditTarget("equipInAlign")
  @ApiAdminDoc({
    operationId: "adminEquipInAlign.save",
    summary: "保存一条内观几何（整份覆盖）",
    description:
      "**整份覆盖**，不是部分更新：位置与两轴缩放是联动的一组状态，分字段更新会让" +
      "「只想改缩放」的请求留下上一次的位置。\n\n" +
      "- `inScaleX` / `inScaleY` 各自在 0.05 ~ 10 之间（素材画布差异大，两轴不一定相等）；\n" +
      "- `inPosition` 是弹窗坐标系里的点（原点 = 弹窗中心，y 向上）；\n" +
      "- `inManual` 只对武器有意义：true = 用这个绝对位置；false = 客户端仍按「当前衣服的内容 bbox」自动算。\n\n" +
      "**没有旋转**：`inRotate` 不在契约里 —— 工作台不调它，存了也没人读（与「不做存了没人读的字段」一致）。\n\n" +
      "`id` 只校验形态（`cloth:<基础件>` / `weapon:<基础件>`），**不校验存在性**；" +
      "同 id 重复保存是幂等的（UPSERT），不会报 409。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "内观目标：`cloth:cloth_1` / `weapon:weapon_1`" })
  @ApiDataResponse(EquipInAlignDto, { description: "保存后的内观几何" })
  save(@Param("id") id: string, @Body() dto: SaveEquipInAlignDto, @CurrentUser() actor: AuthenticatedUser): EquipInAlignDto {
    return this.equipInAlignService.save(id, dto, actor);
  }

  @Delete(":id")
  @AuditTarget("equipInAlign")
  @ApiAdminDoc({
    operationId: "adminEquipInAlign.reset",
    summary: "重置为客户端配置里的值（删行）",
    description:
      "删掉这条覆盖，客户端下次打开弹窗就用 `configs/equipments.ts` 里的值。\n\n" +
      "**幂等**：这条本来就没保存过也返回成功（「还原本件」连点两次不该第二次报错）。\n\n" +
      "**只删内观**：外观的 `equip_aligns` 不受影响，两张表是独立的两份覆盖。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "内观目标：`cloth:cloth_1` / `weapon:weapon_1`" })
  @ApiVoidResponse("已重置（无返回体）")
  reset(@Param("id") id: string): void {
    this.equipInAlignService.remove(id);
  }
}
