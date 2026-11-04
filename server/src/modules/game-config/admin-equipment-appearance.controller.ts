import { Body, Controller, Get, Patch } from "@nestjs/common";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { EquipmentAppearanceService } from "./equipment-appearance.service";
import { EquipmentAppearanceDto, UpdateEquipmentAppearanceDto } from "./dto/equipment-appearance.dto";

/**
 * 管理端 · 装备外观（#695）：装备边框 + 详情背景的「谁用哪个 key」
 *
 * 单行配置（`equipment_appearance`），**整份读、整份写**（与新手引导同一取向）：
 * 15 个前后缀组合是一个联动的整体（「人级普通 → 神级超神」是一条渐变链），
 * 逐条保存会让中间态可见 —— 玩家会看到「神级还在用普通框」的怪异瞬间。
 *
 * ## 改的是什么、不改的是什么
 * - **改**：哪个组合 / 哪件特殊装备用哪个边框 / 背景 key；
 * - **不改**：素材本体（在客户端资源包 `resources/borders` / `resources/backgrounds`），
 *   资源清单（哪些 sfx 编号存在）是两端资源约定，在客户端有与磁盘文件一一对应的守卫。
 *   服务端不校验素材存在性 —— 资源包不在服务端，查了只会掩盖「本地有、线上没有」；
 *   填了不存在的 key，客户端安静跳过并留日志（回退前后缀表 / 不显示）。
 *
 * ## 生效时机
 * 玩家下次进游戏拉配置快照（`equipmentAppearance` 段）时重建映射；
 * 已经在游戏里的那一次不会变。
 */
@ApiAudience("admin")
@Controller("admin/equipment-appearance")
export class AdminEquipmentAppearanceController {
  constructor(private readonly equipmentAppearanceService: EquipmentAppearanceService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminEquipmentAppearance.get",
    summary: "装备外观（边框 + 详情背景映射）",
    description:
      "四组映射 + 最后修改时间（**单行配置，没有分页**）：\n\n" +
      "- `borders` / `backgrounds`：前后缀组合 → key，**恰好 15 条**（5 前缀 × 3 后缀，每条组合一次）；\n" +
      "- `customBorders` / `customBackgrounds`：特殊装备 → key（装备写变体 id 只影响那一个变体，\n" +
      "  写基础件 key 影响其全部变体；**优先于**前后缀表）。\n\n" +
      "key 指向客户端资源包里的素材（边框 `resources/borders/sfx_<编号>_0` 图集、\n" +
      "背景 `resources/backgrounds/sfx_<编号>` 帧序列目录）；素材长什么样见客户端\n" +
      "`tools/border-preview.png`（编号索引图）。服务端只校验 key 格式，**不校验素材存在**。\n\n" +
      "缺行 / 坏数据：映射表整份回落出厂值、自定义表坏条目丢弃（好条目保留），均有 error 日志可查。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiDataResponse(EquipmentAppearanceDto, { description: "当前装备外观配置（含 updatedAt）" })
  get(): EquipmentAppearanceDto {
    return this.equipmentAppearanceService.get();
  }

  @Patch()
  @AuditTarget("equipmentAppearance")
  @ApiAdminDoc({
    operationId: "adminEquipmentAppearance.update",
    summary: "编辑装备外观（整份替换）",
    description:
      "**整份替换**：提交的四组数组就是新配置，不是增量。\n\n" +
      "约束：`borders` / `backgrounds` 恰好 15 条、前后缀组合**恰好全覆盖且不重复**\n" +
      "（缺哪个组合，哪个品质就没有边框 / 背景）；key 形如 `sfx_30123_0`（边框）/ `sfx_16000`（背景）；\n" +
      "自定义表的装备标识唯一、最多 200 条。\n\n" +
      "任何一条不合法 → 40000 且**整份不落库**。\n\n" +
      "改完玩家下次进游戏拉配置快照后生效；已经在游戏里的那一次不会变。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiDataResponse(EquipmentAppearanceDto, { description: "更新后的装备外观配置" })
  update(@Body() dto: UpdateEquipmentAppearanceDto): EquipmentAppearanceDto {
    return this.equipmentAppearanceService.update(dto);
  }
}
