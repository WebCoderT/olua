import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse, ApiVoidResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permission } from "../../common/constants/permission";
import { AuthenticatedUser, PageResult } from "../../common/interfaces/api-envelope.interface";
import { ANNOUNCEMENT_SORT, sortFieldNames } from "../../database/sort-specs";
import { AnnouncementService } from "./announcement.service";
import {
  AnnouncementDto,
  AnnouncementPageDto,
  AnnouncementQueryDto,
  CreateAnnouncementDto,
  UpdateAnnouncementDto,
} from "./dto/announcement.dto";

/**
 * 管理端 · 公告
 *
 * 写操作都带 `@AuditTarget("announcement")` —— 「谁在什么时候向全服发了什么」是必须可追溯的
 * 运营动作（动作取自 operationId，无需另设清单）。
 * 编辑用 PATCH（**部分更新**）：列表上的启停按钮只回传 `enabled`，不会覆盖运营正在编辑的正文。
 */
@ApiAudience("admin")
@Controller("admin/announcements")
export class AdminAnnouncementController {
  constructor(private readonly announcementService: AnnouncementService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminAnnouncement.list",
    summary: "公告列表",
    description:
      "`keyword` 模糊匹配标题与正文；`level` / `enabled` / `active` 可筛。\n\n" +
      "`active=true` 得到的就是「玩家现在能看到的那一批」—— 与公共接口 " +
      "`GET /announcements/active` 用的是同一段判据，不会出现后台看着已生效、玩家却看不到。" +
      "`active=false` 是它的补集（含未开始与已过期，也含被停用的）。\n\n" +
      `**排序**：\`sort\` 取 ${sortFieldNames(ANNOUNCEMENT_SORT)}，\`order\` 取 asc / desc（默认 updatedAt 倒序）。` +
      "同毫秒的多条另有 id 兜底次序，保证翻页稳定。",
    permissions: [Permission.ANNOUNCEMENT_READ],
  })
  @ApiQueryModel(AnnouncementQueryDto)
  @ApiDataResponse(AnnouncementPageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: AnnouncementQueryDto): PageResult<AnnouncementDto> {
    return this.announcementService.list(query);
  }

  @Post()
  @AuditTarget("announcement")
  @ApiAdminDoc({
    operationId: "adminAnnouncement.create",
    summary: "发布公告",
    description:
      "不传 `startsAt` = 立即生效，不传 `endsAt` = 不设截止（**不要**为了「长期有效」编一个很远的结束时间）。\n\n" +
      "发布人取当前登录的管理员账号名，不接受入参指定；`endsAt` 必须晚于 `startsAt`（否则 50002）。",
    permissions: [Permission.ANNOUNCEMENT_WRITE],
  })
  @ApiDataResponse(AnnouncementDto, { status: 201, description: "创建成功" })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateAnnouncementDto): AnnouncementDto {
    return this.announcementService.create(user, dto);
  }

  @Patch(":id")
  @AuditTarget("announcement")
  @ApiAdminDoc({
    operationId: "adminAnnouncement.update",
    summary: "编辑公告",
    description:
      "**部分更新**：只改请求体里出现的字段 —— 列表上的「启用 / 停用」只传 `enabled` 即可，不会覆盖其它字段。\n\n" +
      "`startsAt` / `endsAt` 传 `null` 表示改为「立即生效」/「不设截止」，不传则保持原值。" +
      "时间窗按**合并后的结果**校验（只传 `endsAt` 时也会与库里已有的 `startsAt` 比对）。",
    permissions: [Permission.ANNOUNCEMENT_WRITE],
  })
  @ApiParam({ name: "id", description: "公告 id" })
  @ApiDataResponse(AnnouncementDto, { description: "更新后的公告" })
  update(@Param("id") id: string, @Body() dto: UpdateAnnouncementDto): AnnouncementDto {
    return this.announcementService.update(id, dto);
  }

  @Delete(":id")
  @AuditTarget("announcement")
  @ApiAdminDoc({
    operationId: "adminAnnouncement.remove",
    summary: "删除公告",
    description: "不可恢复（**没有软删除**）：只是想让它不再对玩家展示，应当用「停用」或设置结束时间。",
    permissions: [Permission.ANNOUNCEMENT_WRITE],
  })
  @ApiParam({ name: "id", description: "公告 id" })
  @ApiVoidResponse("删除成功（data 为 null）")
  remove(@Param("id") id: string): null {
    return this.announcementService.remove(id);
  }
}
