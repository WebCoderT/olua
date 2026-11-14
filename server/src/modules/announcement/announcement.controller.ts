import { Controller, Get } from "@nestjs/common";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiPlayerDoc, ApiPublicDoc } from "../../common/decorators/api-doc.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { AnnouncementService } from "./announcement.service";
import { ActiveAnnouncementDto } from "./dto/announcement.dto";

/**
 * 公告（公共 + 玩家）
 *
 * 两条读路径，区别只有一个：**有没有区**。
 * - `GET /announcements/active` **不需要令牌**：登录页也要能读（停机维护公告恰恰是在玩家
 *   还没登录时最该看到的信息）。没有令牌就没有区，所以它只返回**全服公告**；
 * - `GET /announcements/mine` 带令牌：区由服务端从账号推导，返回「全服 + 本区」，
 *   游戏内公告板用它。
 *
 * 两条都只暴露「展示一条公告需要的字段」，发布人 / 启停开关 / 内部时间戳一律不给。
 * 客户端**不传 zoneId** —— 传了就能读别区公告（docs/39 §2.4 规则 1）。
 */
@Controller("announcements")
export class AnnouncementController {
  constructor(private readonly announcementService: AnnouncementService) {}

  @Public()
  @Get("active")
  @ApiPublicDoc({
    operationId: "announcement.active",
    summary: "当前生效中的公告（全服）",
    description:
      "只返回**同时满足**三个条件的公告：手动启用了、已到生效开始时间、还没到结束时间" +
      "（`startsAt` / `endsAt` 为 null 分别表示立即生效 / 不设截止）。\n\n" +
      "**只含全服公告**（投放范围为「全服」的那些）：这条路没有令牌、也就没有区，" +
      "登录页与还没选区的玩家看到的就是它。进游戏之后用 `GET /announcements/mine`：" +
      "那条会多带上「本区」公告。\n\n" +
      "排序：**重要在前**，同级按发布时间倒序。无生效公告时返回空数组（不是 null）。\n\n" +
      "无需令牌 —— 停机维护这类公告在登录页就要能显示。",
  })
  @ApiDataResponse(ActiveAnnouncementDto, { isArray: true, description: "生效中的全服公告（可能为空数组）" })
  active(): ActiveAnnouncementDto[] {
    return this.announcementService.listActive();
  }

  @Get("mine")
  @ApiPlayerDoc({
    operationId: "announcement.mine",
    summary: "当前生效中的公告（全服 + 本区）",
    description:
      "与 `GET /announcements/active` 同一套「生效中」判据，只是**多算一层区**：" +
      "返回「全服公告 + 投给我所在区的公告」。\n\n" +
      "区由服务端从**在线角色**推导（还没建角 / 还在选角页就只给全服公告 —— 那时他还不属于任何区），" +
      "**不接受 `zoneId` 入参** —— 传了也不读。\n\n" +
      "登录页那种「还没有令牌」的场景请用公共接口，它只给全服公告。",
  })
  @ApiDataResponse(ActiveAnnouncementDto, { isArray: true, description: "生效中的全服 + 本区公告（可能为空数组）" })
  mine(@CurrentUser() user: AuthenticatedUser): ActiveAnnouncementDto[] {
    return this.announcementService.listActiveForAccount(user.id);
  }
}
