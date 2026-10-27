import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse, ApiVoidResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { QUEST_SORT, sortFieldNames } from "../../database/sort-specs";
import { GameConfigService } from "./game-config.service";
import { CreateQuestDto, QuestDto, QuestPageDto, QuestQueryDto, UpdateQuestDto } from "./dto/quest.dto";

/**
 * 管理端 · 任务配置（#396）
 *
 * 与掉落表同一取向：**允许动态增删**（任务内容是运营内容，不是引擎清单）——
 * 但删除有两条守卫（有玩家进度 / 被主线链前置引用时拒删，见 service）。
 * 写操作带 `@AuditTarget("quest")`。
 */
@ApiAudience("admin")
@Controller("admin/quests")
export class AdminQuestController {
  constructor(private readonly gameConfigService: GameConfigService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminQuest.list",
    summary: "任务配置列表",
    description:
      "seed 自客户端 configs/quest-data（主线 8000 段 / 日常 8100 段），允许动态增删。" +
      "`kind` 筛 main / daily，`keyword` 模糊匹配 id / 名称。\n\n" +
      "`objective` 是单目标（kill = 怪物 key / talk = NPC id / collect = 物品 id）；" +
      "`rewards` 的 items 落库为 JSON 列。\n\n" +
      `**排序**：\`sort\` 取 ${sortFieldNames(QUEST_SORT)}，\`order\` 取 asc / desc（默认 id 升序）。`,
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiQueryModel(QuestQueryDto)
  @ApiDataResponse(QuestPageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: QuestQueryDto): PageResult<QuestDto> {
    return this.gameConfigService.listQuests(query);
  }

  @Patch(":id")
  @AuditTarget("quest")
  @ApiAdminDoc({
    operationId: "adminQuest.update",
    summary: "编辑任务配置",
    description:
      "**部分更新**：只改请求体里出现的字段（`objective` / `rewards` 逐字段合并，`items` 传了就整份替换）。\n\n" +
      "- 目标键必须指向真实数据：kill → 怪物 key、talk → NPC id、collect → 物品 id；\n" +
      "- `prevQuestId` 链不许成环、不许指向不存在的任务；\n" +
      "- `id` 不存在 → 404（`50031`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "任务 id（如 \"8001\"）" })
  @ApiDataResponse(QuestDto, { description: "更新后的任务配置" })
  update(@Param("id") id: string, @Body() dto: UpdateQuestDto): QuestDto {
    return this.gameConfigService.updateQuest(id, dto);
  }

  @Post()
  @AuditTarget("quest")
  @ApiAdminDoc({
    operationId: "adminQuest.create",
    summary: "新建任务",
    description:
      "id 唯一（重复 → 40000）；跨字段校验与编辑同一套（目标键真实存在 / 链不成环 / 奖励物品存在）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiDataResponse(QuestDto, { description: "新建的任务配置" })
  create(@Body() dto: CreateQuestDto): QuestDto {
    return this.gameConfigService.createQuest(dto);
  }

  @Delete(":id")
  @AuditTarget("quest")
  @ApiAdminDoc({
    operationId: "adminQuest.remove",
    summary: "删除任务",
    description:
      "两条拒删守卫（40000）：仍有玩家进度引用；仍被别的任务当主线链前置。先清理再删。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "任务 id" })
  @ApiVoidResponse("删除成功（data 为 null）")
  remove(@Param("id") id: string): null {
    this.gameConfigService.deleteQuest(id);
    return null;
  }
}
