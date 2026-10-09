import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permission } from "../../common/constants/permission";
import { AuthenticatedUser, PageResult } from "../../common/interfaces/api-envelope.interface";
import { MAIL_SORT, sortFieldNames } from "../../database/sort-specs";
import { MailService } from "./mail.service";
import {
  MailJobDto,
  MailJobPageDto,
  MailQueryDto,
  MailTemplateDto,
  SendMailDto,
  SendMailResultDto,
} from "./dto/mail.dto";

/**
 * 管理端 · 邮件
 *
 * 两个写操作都带 `@AuditTarget("mail")`：「谁在什么时候向哪个玩家发了什么」必须可追溯 ——
 * 邮件是直接触达真实用户的通道，比后台改一条数据更接近「对外发声」。
 *
 * 发信只是**入队**（返回 201 + 任务 id），不等投递结果；结果在列表里查。
 */
@ApiAudience("admin")
@Controller("admin/mails")
export class AdminMailController {
  constructor(private readonly mailService: MailService) {}

  @Get("templates")
  @ApiAdminDoc({
    operationId: "adminMail.templates",
    summary: "邮件模板列表",
    description:
      "发信前先拉这份列表：`variables` 是**必填变量**，缺一个就直接拒发（不会发出「亲爱的 ，」这种信）。" +
      "`custom` 是不用模板、标题与正文由运营自己填，此时 `subject` / `body` 必填。",
    permissions: [Permission.MAIL_READ],
  })
  @ApiDataResponse(MailTemplateDto, { isArray: true, description: "全部模板（顺序即界面展示顺序）" })
  templates(): MailTemplateDto[] {
    return this.mailService.templates();
  }

  @Get()
  @ApiAdminDoc({
    operationId: "adminMail.list",
    summary: "邮件投递记录",
    description:
      "`keyword` 模糊匹配收件邮箱 / 标题 / 收件账号名；`status` 可筛（待发送 / 发送中 / 重试中 / 已发送 / 发送失败）。\n\n" +
      "`lastError` 是最近一次失败的**原始原因**（SMTP 的报错原文或测试发信器的说明），" +
      "`attempts` 是已尝试次数 —— 这两个字段合起来回答「这封信为什么没到」。\n\n" +
      `**排序**：\`sort\` 取 ${sortFieldNames(MAIL_SORT)}，\`order\` 取 asc / desc（默认 createdAt 倒序）。`,
    permissions: [Permission.MAIL_READ],
  })
  @ApiQueryModel(MailQueryDto)
  @ApiDataResponse(MailJobPageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: MailQueryDto): PageResult<MailJobDto> {
    return this.mailService.list(query);
  }

  @Post()
  @AuditTarget("mail")
  @ApiAdminDoc({
    operationId: "adminMail.send",
    summary: "发送邮件",
    description:
      "**入队即返回**（201），不代表已经投递成功 —— 投递由后台调度器完成，结果在投递记录里查。\n\n" +
      "这样 SMTP 服务器不可达时，运营点下「发送」不会卡到网关超时，也不会不知道邮件到底有没有发出去。\n\n" +
      "渲染结果**冻在入队那一刻**：模板后来被改了、玩家改名了，重投三天前失败的任务也仍然发当时的内容。\n\n" +
      "未配置 SMTP 时整体禁用（50003）：不会静默丢信，也不会假装成功。",
    permissions: [Permission.MAIL_WRITE],
  })
  @ApiDataResponse(SendMailResultDto, { status: 201, description: "已入队（status 恒为 pending）" })
  send(@CurrentUser() user: AuthenticatedUser, @Body() dto: SendMailDto): SendMailResultDto {
    return this.mailService.send(user, dto);
  }

  @Post(":id/retry")
  @AuditTarget("mail")
  @ApiAdminDoc({
    operationId: "adminMail.retry",
    summary: "重投一封失败的邮件",
    description:
      "只有**最终失败**（重试次数用尽）的任务可以重投：正在发送或已成功的重投会造成重复发信。\n\n" +
      "重投会**把尝试次数归零**而不是续着数 —— 重投的前提是故障已排除，让它重新拿到完整次数。",
    permissions: [Permission.MAIL_WRITE],
  })
  @ApiParam({ name: "id", description: "投递任务 id" })
  @ApiDataResponse(MailJobDto, { description: "重投后的任务（状态回到 pending）" })
  retry(@Param("id") id: string): MailJobDto {
    return this.mailService.retry(id);
  }
}
