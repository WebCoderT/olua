import { Body, Controller, Delete, Get, Param, Put } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse, ApiVoidResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permission } from "../../common/constants/permission";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { EquipAlignService } from "./equip-align.service";
import { EquipAlignDto, EquipAlignListDto, SaveEquipAlignDto } from "./dto/equip-align.dto";

/**
 * 管理端 · 装备对齐几何（#513）
 *
 * 「装备对齐」工作台（`/equip-align`）的读写口：以裸模为基准，把每件衣服 / 武器 / 裸模
 * 在 8 个朝向上拖到位，**点保存直接落库**，客户端重进游戏就生效（不再需要导出 JSON + 跑脚本）。
 *
 * 只有 list / save（覆盖）/ reset（删行）：**没有 create** —— 对齐目标的 id 来自客户端配置，
 * 不存在"新建一件衣服"这回事；**没有分页** —— 33 行，工作台一次要看全量。
 *
 * 写操作带 `@AuditTarget("equipAlign")`：改的是全服玩家的外观，必须可追溯。
 */
@ApiAudience("admin")
@Controller("admin/equip-aligns")
export class AdminEquipAlignController {
  constructor(private readonly equipAlignService: EquipAlignService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminEquipAlign.list",
    summary: "装备对齐几何列表",
    description:
      "全部**已保存**的对齐几何（不分页：12 件衣服 + 19 把武器 + 2 套裸模，量很小）。\n\n" +
      "**没有行 = 用客户端配置里的值**（`client/assets/configs/equipments.ts` / `role.ts`）—— " +
      "所以「哪些调过」就是这份列表的 id 集合，不需要另存默认值副本。\n\n" +
      "`outPositions` 是 8 个方向的位移（顺序见客户端 `configs/animation` 的 `directions`）；" +
      "`outManual=true` 表示它是绝对位置（工作台手调过），false 表示运行时按身体帧自动算、只当微调。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiDataResponse(EquipAlignListDto, { description: "全部已保存的对齐几何" })
  list(): EquipAlignListDto {
    return this.equipAlignService.list();
  }

  @Put(":id")
  @AuditTarget("equipAlign")
  @ApiAdminDoc({
    operationId: "adminEquipAlign.save",
    summary: "保存一条对齐几何（整份覆盖）",
    description:
      "**整份覆盖**，不是部分更新：位置 / 缩放 / 是否用绝对值是联动的一组状态，分字段更新会让" +
      "「只想改缩放」的请求留下上一次的位置，页面上表现为「改完缩放位置也跟着变了」。\n\n" +
      "- `outPositions` **必须正好 8 个**（多一个少一个都说明页面与配置已经错位）；\n" +
      "- `outScale` 必须在 0.05 ~ 10 之间；\n" +
      "- `outManual` 只对武器有意义：true = `outPositions` 是绝对位置，false = 运行时自动算。\n\n" +
      "**只有外观**：内观（角色弹窗里转盘上的位置）是客户端运行时按身体内容 bbox 现算的，" +
      "没有可以手调的常量，所以这里没有对应字段。\n\n" +
      "`id` 只校验形态（`cloth:<基础件>` / `weapon:<基础件>` / `role:<1|2>`），**不校验存在性** —— " +
      "装备清单在客户端配置里，服务端硬编一份会漂移，而且会让「新增一件衣服得先发服务端」成为发布依赖。\n\n" +
      "同 id 重复保存是幂等的（UPSERT），不会报 409。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "对齐目标：`cloth:cloth_1` / `weapon:weapon_1` / `role:1`" })
  @ApiDataResponse(EquipAlignDto, { description: "保存后的对齐几何" })
  save(@Param("id") id: string, @Body() dto: SaveEquipAlignDto, @CurrentUser() actor: AuthenticatedUser): EquipAlignDto {
    return this.equipAlignService.save(id, dto, actor);
  }

  @Delete(":id")
  @AuditTarget("equipAlign")
  @ApiAdminDoc({
    operationId: "adminEquipAlign.reset",
    summary: "重置为客户端配置里的值（删行）",
    description:
      "删掉这条覆盖，客户端下次拉快照时就用 `configs/equipments.ts` / `role.ts` 里的值。\n\n" +
      "**幂等**：这条本来就没保存过也返回成功 —— 它表达的是「这件回到默认」这个状态，" +
      "工作台上「还原本件」连点两次不该第二次报错。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "对齐目标：`cloth:cloth_1` / `weapon:weapon_1` / `role:1`" })
  @ApiVoidResponse("已重置（无返回体）")
  reset(@Param("id") id: string): void {
    this.equipAlignService.remove(id);
  }
}
