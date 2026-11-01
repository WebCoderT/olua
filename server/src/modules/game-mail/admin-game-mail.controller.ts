import { Body, Controller, Param, Post } from "@nestjs/common";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { AdminSendMailDto, MailViewDto } from "./dto/game-mail.dto";
import { GameMailService } from "./game-mail.service";

/**
 * 管理端 · 游戏内消息补发（#437）
 *
 * 运营给某个玩家补一份东西的唯一人工入口 —— 在此之前只能改库。
 * 三条由此定下的纪律：
 * - **落库只走 `GameMailService.sendFromAdmin` → `send`**：不另写 INSERT，否则
 *   频道收窄与附件序列化就和系统投递分叉了；
 * - **审计目标 = 角色**（`@AuditTarget("role")`）：「谁在什么时候给哪个玩家发了什么」
 *   必须可追溯，请求体（含附件金额与物品）由审计拦截器原样留痕；
 * - **撤回不做**（#437 明确不做）：补发的语义是「发出去就归玩家」，撤回要一整套
 *   「已读 / 已领后怎么办」的口径，等真有需求再单独立 issue。
 */
@ApiAudience("admin")
@Controller("admin/game-mail")
export class AdminGameMailController {
  constructor(private readonly gameMail: GameMailService) {}

  @Post("roles/:id")
  @AuditTarget("role")
  @ApiAdminDoc({
    operationId: "adminGameMail.send",
    summary: "补发游戏消息（单发）",
    description:
      "给指定角色发一封游戏内消息（收件箱四栏里的 `system` / `reward` 两栏）。\n\n" +
      "- `channel` 只允许 `system` / `reward`：`social` / `combat` 是系统自动产生的事实记录，" +
      "人工往里发会污染语义（传了 → 400）。\n" +
      "- `gold` / `exp` / `items` 是**可选附件**：玩家在消息中心点「领取」才真的到手，" +
      "发奖与任务交付走同一个入口；不传就是一封纯文本通知。\n" +
      "- 收件人**不要求在线**：邮件本来就是异步的，离线角色下次上线自然看到。\n" +
      "- 角色不存在 → 404；发给谁由路径上的角色 id 决定（角色运营台的「发消息」按钮会带上）。",
    permissions: [Permission.GAME_MAIL_SEND],
  })
  @ApiDataResponse(MailViewDto, { status: 201, description: "已落进收件箱的那封消息" })
  send(@Param("id") id: string, @Body() dto: AdminSendMailDto): MailViewDto {
    return this.gameMail.sendFromAdmin(id, dto);
  }
}
