import { Controller, Get } from "@nestjs/common";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiPublicDoc } from "../../common/decorators/api-doc.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { AnnouncementService } from "./announcement.service";
import { ActiveAnnouncementDto } from "./dto/announcement.dto";

/**
 * 公告（公共）
 *
 * 不需要令牌：**登录页也要能读**（停机维护公告恰恰是在玩家还没登录时最该看到的信息）。
 * 因此这里只暴露「展示一条公告需要的字段」，发布人 / 启停开关 / 内部时间戳一律不给。
 */
@Controller("announcements")
export class AnnouncementController {
  constructor(private readonly announcementService: AnnouncementService) {}

  @Public()
  @Get("active")
  @ApiPublicDoc({
    operationId: "announcement.active",
    summary: "当前生效中的公告",
    description:
      "只返回**同时满足**三个条件的公告：手动启用了、已到生效开始时间、还没到结束时间" +
      "（`startsAt` / `endsAt` 为 null 分别表示立即生效 / 不设截止）。\n\n" +
      "排序：**重要在前**，同级按发布时间倒序。无生效公告时返回空数组（不是 null）。\n\n" +
      "无需令牌 —— 停机维护这类公告在登录页就要能显示。",
  })
  @ApiDataResponse(ActiveAnnouncementDto, { isArray: true, description: "生效中的公告（可能为空数组）" })
  active(): ActiveAnnouncementDto[] {
    return this.announcementService.listActive();
  }
}
