import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse, ApiVoidResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { ACHIEVEMENT_SORT, sortFieldNames } from "../../database/sort-specs";
import { GameConfigService } from "./game-config.service";
import {
  AchievementDto,
  AchievementPageDto,
  AchievementQueryDto,
  CreateAchievementDto,
  UpdateAchievementDto,
} from "./dto/achievement.dto";

/**
 * 管理端 · 成就配置（#401）
 *
 * 与任务配置同一取向：**允许动态增删**（成就是运营内容，不是引擎清单）——
 * 但删除有一条守卫（有玩家成就记录时拒删，见 service）。
 * 写操作带 `@AuditTarget("achievement")`。
 */
@ApiAudience("admin")
@Controller("admin/achievements")
export class AdminAchievementController {
  constructor(private readonly gameConfigService: GameConfigService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminAchievement.list",
    summary: "成就配置列表",
    description:
      "seed 自客户端 configs/achievement-data，允许动态增删。`category` 筛 battle / growth / explore，" +
      "`keyword` 模糊匹配 id / 名称。\n\n" +
      "`condition` 分两类：`kill` / `quest` 是**累计型**（进度由事件流落库），" +
      "`level` / `combat` / `collect` 是**状态型**（每次查询按角色当前状态现算，不落进度）。\n\n" +
      `**排序**：\`sort\` 取 ${sortFieldNames(ACHIEVEMENT_SORT)}，\`order\` 取 asc / desc（默认分类内顺序）。`,
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiQueryModel(AchievementQueryDto)
  @ApiDataResponse(AchievementPageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: AchievementQueryDto): PageResult<AchievementDto> {
    return this.gameConfigService.listAchievements(query);
  }

  @Patch(":id")
  @AuditTarget("achievement")
  @ApiAdminDoc({
    operationId: "adminAchievement.update",
    summary: "编辑成就配置",
    description:
      "**部分更新**：只改请求体里出现的字段（`condition` / `rewards` 逐字段合并，`items` 传了就整份替换）。\n\n" +
      "- `kill` 的 target 必须是真实怪物 key 或 `*`（任意怪）；\n" +
      "- `collect` 的 target 必须是真实物品 id；\n" +
      "- 奖励物品必须存在；\n" +
      "- `id` 不存在 → 404（`50131`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "成就 id（如 \"ach_kill_10\"）" })
  @ApiDataResponse(AchievementDto, { description: "更新后的成就配置" })
  update(@Param("id") id: string, @Body() dto: UpdateAchievementDto): AchievementDto {
    return this.gameConfigService.updateAchievement(id, dto);
  }

  @Post()
  @AuditTarget("achievement")
  @ApiAdminDoc({
    operationId: "adminAchievement.create",
    summary: "新建成就",
    description: "id 唯一（重复 → 40000）；跨字段校验与编辑同一套（目标键真实存在 / 奖励物品存在）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiDataResponse(AchievementDto, { description: "新建的成就配置" })
  create(@Body() dto: CreateAchievementDto): AchievementDto {
    return this.gameConfigService.createAchievement(dto);
  }

  @Delete(":id")
  @AuditTarget("achievement")
  @ApiAdminDoc({
    operationId: "adminAchievement.remove",
    summary: "删除成就",
    description:
      "一条拒删守卫（40000）：仍有玩家成就记录引用（哪怕只是累计进度、未达成）。先清理记录再删。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "成就 id" })
  @ApiVoidResponse("删除成功（data 为 null）")
  remove(@Param("id") id: string): null {
    this.gameConfigService.deleteAchievement(id);
    return null;
  }
}
