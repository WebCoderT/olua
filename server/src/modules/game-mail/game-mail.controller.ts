import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiPlayerDoc } from "../../common/decorators/api-doc.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { MailBoxDto, MailClaimAllResultDto, MailClaimResultDto } from "./dto/game-mail.dto";
import { GameMailService } from "./game-mail.service";

/**
 * 客户端 · 游戏内邮件（#429）
 *
 * 五个动作：看 / 标已读 / 领一封 / 一键领 / 删。
 * **没有任何「发信」口子** —— 邮件只由服务端产生（成就奖励背包满兜底、以后的运营补发），
 * 客户端能做的只有领取，符合「奖励从哪来归服务端说了算」。
 */
@Controller("mails")
export class GameMailController {
  constructor(private readonly gameMailService: GameMailService) {}

  @Get("me")
  @ApiPlayerDoc({
    operationId: "gameMail.mine",
    summary: "我的收件箱",
    description:
      "整份收件箱（新的在前）+ 未读数 + 未领数。附件的 `gold` / `exp` / `attachments` 是" +
      "**还没到手**的那份奖励，点领取之后才进角色存档。",
  })
  @ApiDataResponse(MailBoxDto, { description: "收件箱快照" })
  mine(@CurrentUser() user: AuthenticatedUser): MailBoxDto {
    return this.gameMailService.box(user.id);
  }

  @Post(":id/read")
  @HttpCode(HttpStatus.OK)
  @ApiPlayerDoc({
    operationId: "gameMail.read",
    summary: "标为已读",
    description:
      "重复标不改写已读时刻（第一次看到的时间才有意义）。邮件不存在 → 50141；" +
      "别人的邮件一律当作不存在（不做越权探测口）。",
  })
  @ApiParam({ name: "id", description: "邮件 id" })
  @ApiDataResponse(MailBoxDto, { description: "标已读后的收件箱" })
  read(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string): MailBoxDto {
    return this.gameMailService.read(user.id, id);
  }

  @Post(":id/claim")
  @HttpCode(HttpStatus.OK)
  @ApiPlayerDoc({
    operationId: "gameMail.claim",
    summary: "领取附件",
    description:
      "金币 / 经验 / 物品一次落库（与任务交付、成就领奖同一个发奖入口）。\n\n" +
      "失败路径：50141 邮件不存在 / 50142 已经领过 / **20012 背包已满（邮件原样留着，清包后能再领）**。",
  })
  @ApiParam({ name: "id", description: "邮件 id" })
  @ApiDataResponse(MailClaimResultDto, { description: "领取后的收件箱 + 本次到手的奖励" })
  claim(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string): MailClaimResultDto {
    return this.gameMailService.claim(user.id, id);
  }

  @Post("claim-all")
  @HttpCode(HttpStatus.OK)
  @ApiPlayerDoc({
    operationId: "gameMail.claimAll",
    summary: "一键领取",
    description:
      "按发出的时间正序逐封领取，**领到背包满为止**：已领的照常落库，`stoppedByBag` 为 true 表示还有剩。",
  })
  @ApiDataResponse(MailClaimAllResultDto, { description: "领取后的收件箱 + 本次合计" })
  claimAll(@CurrentUser() user: AuthenticatedUser): MailClaimAllResultDto {
    return this.gameMailService.claimAll(user.id);
  }

  @Delete(":id")
  @ApiPlayerDoc({
    operationId: "gameMail.remove",
    summary: "删除邮件",
    description: "**附件没领不能删**（50143）—— 删了等于替玩家扔掉奖励。已领或无附件的邮件可以删。",
  })
  @ApiParam({ name: "id", description: "邮件 id" })
  @ApiDataResponse(MailBoxDto, { description: "删除后的收件箱" })
  remove(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string): MailBoxDto {
    return this.gameMailService.remove(user.id, id);
  }
}
