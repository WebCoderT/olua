import { Body, Controller, Get, Param, Patch } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { GameConfigService } from "./game-config.service";
import {
  EquipmentMetaDto,
  EquipmentSlotDto,
  EQUIPMENT_SLOT_KEYS,
  UpdateEquipmentMetaDto,
  UpdateEquipmentSlotDto,
} from "./dto/equipment.dto";

/**
 * 管理端 · 装备槽位与规则（#603 第九域）
 *
 * 这两样以前写在客户端 `configs/equipments` / `configs/growth` 里：
 * - **槽位表**（13 行）：角色弹窗的槽位名与底图、背包「一键整理」的部位序；
 * - **规则**（单行）：前后缀倍率 / 文案 / 回收价曲线。
 *
 * 现在客户端两者都是空运行时表，进游戏由 `GET /game-config` 快照整表重建，
 * 改这里就是改全服（回收价曲线同时影响「背包一键回收」与服务端卖装备结算）。
 *
 * **都没有 create / remove**：槽位 key 是 `EQUIPMENT_TYPE` 枚举值（封闭集合），
 * 规则恒为单行（id = 1）。写操作带 `@AuditTarget("equipment")`。
 */
@ApiAudience("admin")
@Controller("admin")
export class AdminEquipmentRulesController {
  constructor(private readonly gameConfigService: GameConfigService) {}

  @Get("equipment-slots")
  @ApiAdminDoc({
    operationId: "adminEquipmentSlot.list",
    summary: "装备槽位表",
    description:
      "13 行，**只读清单 + 可改文案/底图/位置分组**，没有创建 / 删除（新增部位属于代码改动）。\n\n" +
      "`order` 同时是角色弹窗的槽位排列顺序与背包「一键整理」的部位序 —— " +
      "客户端 `equipmentSlotOrder` 就是它。\n\n" +
      "key 取值：" + EQUIPMENT_SLOT_KEYS.join(" / ") + "。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiDataResponse(EquipmentSlotDto, { isArray: true, description: "槽位清单（按 order 升序）" })
  listSlots(): EquipmentSlotDto[] {
    return this.gameConfigService.listEquipmentSlots();
  }

  @Patch("equipment-slots/:key")
  @AuditTarget("equipment")
  @ApiAdminDoc({
    operationId: "adminEquipmentSlot.update",
    summary: "编辑装备槽位",
    description:
      "**部分更新**：只改请求体里出现的字段。\n\n" +
      "- `label`：槽位中文名（如「衣服」）。\n" +
      "- `imageSrc`：槽位底图（resources 相对路径，空串 = 不显示底图）。\n" +
      "- `position`：在角色弹窗里的位置分组（left / right / bottom / custom）。\n" +
      "- 顺序不开放编辑（它是种子里的书写序，改了会让背包整理序漂）。\n" +
      "- key 不存在 → 404。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "key", description: "槽位 key（EQUIPMENT_TYPE 的枚举值，如 cloth）" })
  @ApiDataResponse(EquipmentSlotDto, { description: "更新后的槽位" })
  updateSlot(@Param("key") key: string, @Body() dto: UpdateEquipmentSlotDto): EquipmentSlotDto {
    return this.gameConfigService.updateEquipmentSlot(key, dto);
  }

  @Get("equipment-meta")
  @ApiAdminDoc({
    operationId: "adminEquipmentMeta.get",
    summary: "装备规则（前后缀倍率 / 文案 / 回收价曲线）",
    description:
      "单行配置。客户端 `configs/equipments` 展开 15 个变体、`configs/growth` 算回收价都读它。\n\n" +
      "- `prefixRates` / `suffixRates`：属性倍率（下标 = 前后缀序号），变体总倍率是两者相乘。\n" +
      "- `prefixLabels` / `suffixLabels`：名称里显示的品质文案（必须与倍率等长）。\n" +
      "- `recycleCurve`：回收价曲线（分段线性）—— 背包「一键回收」与服务端卖装备结算共用。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiDataResponse(EquipmentMetaDto, { description: "装备规则" })
  getMeta(): EquipmentMetaDto {
    return this.gameConfigService.getEquipmentMeta();
  }

  @Patch("equipment-meta")
  @AuditTarget("equipment")
  @ApiAdminDoc({
    operationId: "adminEquipmentMeta.update",
    summary: "编辑装备规则",
    description:
      "**部分更新**：只改请求体里出现的字段（数组字段是整份替换）。\n\n" +
      "- 倍率与文案**必须等长**（差一位就是某一档没有名字），不等长 → 400。\n" +
      "- 回收价曲线每档要求 `from ≤ to`、`start ≥ 0`、`perLevel ≥ 0`，违反 → 400。\n" +
      "- 改完立刻重装服务端结算层：**卖装备的到账价与背包显示同步变**（不必重启）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiDataResponse(EquipmentMetaDto, { description: "更新后的装备规则" })
  updateMeta(@Body() dto: UpdateEquipmentMetaDto): EquipmentMetaDto {
    return this.gameConfigService.updateEquipmentMeta(dto);
  }
}
