import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { ZoneContext } from "../../common/decorators/zone-context.decorator";
import { Permission } from "../../common/constants/permission";
import { ZoneContextGuard } from "../../common/guards/zone-context.guard";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { AdminSendMailDto, MailViewDto } from "./dto/game-mail.dto";
import {
  AdminBroadcastMailDto,
  BroadcastPreviewDto,
  BroadcastPreviewResultDto,
  BroadcastViewDto,
} from "./dto/game-mail-broadcast.dto";
import { GameMailService } from "./game-mail.service";
import { GameMailBroadcastService } from "./game-mail-broadcast.service";

/**
 * 管理端 · 游戏内消息（#437 单发 / #438 群发）
 *
 * 运营接触玩家收件箱的全部人工入口，三条纪律：
 * - **落库只走 `GameMailService`**：不另写 INSERT，否则频道收窄与附件序列化就和系统投递分叉了；
 * - **审计目标 = 角色**（单发）／**`gameMail`**（群发）：群发一次影响成千上万个角色，
 *   逐个留痕没有意义，留的是「这一批是什么、发给了谁、谁发的」——请求体（含附件）由审计拦截器原样留痕；
 * - **撤回不做**（#437 明确不做）：补发的语义是「发出去就归玩家」，撤回要一整套
 *   「已读 / 已领后怎么办」的口径，等真有需求再单独立 issue。
 *
 * **区上下文（#438）**：整个控制器挂 `ZoneContextGuard`。群发的「当前区」取 `X-Zone-Id`
 * （`scope=all` 是唯一跨区的路径，另需 `gameMail:broadcast-all`）；单发按角色 id 走，与区无关
 * —— 角色在别的区也要能补发，那是「客服补偿」的正常场景。
 */
@ApiAudience("admin")
@UseGuards(ZoneContextGuard)
@Controller("admin/game-mail")
export class AdminGameMailController {
  constructor(
    private readonly gameMail: GameMailService,
    private readonly broadcast: GameMailBroadcastService,
  ) {}

  @Post("roles/:id")
  @AuditTarget("role")
  @ApiAdminDoc({
    operationId: "adminGameMail.send",
    summary: "补发游戏消息（单发）",
    description:
      "给指定角色发一封游戏内消息（收件箱四栏里的 `system` / `reward` 两栏）。\n\n" +
      "- `channel` 只允许 `system` / `reward`：`social` / `combat` 是系统自动产生的事实记录，" +
      "人工往里发会污染语义（传了 → 400）。\n" +
      "- `bindGold` / `exp` / `items` 是**可选附件**：玩家在消息中心点「领取」才真的到手，" +
      "发奖与任务交付走同一个入口；不传就是一封纯文本通知。\n" +
      "- 收件人**不要求在线**：邮件本来就是异步的，离线角色下次上线自然看到。\n" +
      "- 角色不存在 → 404；发给谁由路径上的角色 id 决定（角色运营台的「发消息」按钮会带上）。",
    permissions: [Permission.GAME_MAIL_SEND],
  })
  @ApiDataResponse(MailViewDto, { status: 201, description: "已落进收件箱的那封消息" })
  send(@Param("id") id: string, @Body() dto: AdminSendMailDto): MailViewDto {
    return this.gameMail.sendFromAdmin(id, dto);
  }

  @Post("broadcasts/preview")
  @ApiAdminDoc({
    operationId: "adminGameMail.previewBroadcast",
    summary: "群发影响面预估",
    description:
      "按投放范围与等级段算「预计影响 N 人」，不写任何数据 —— 运营在写正文之前就能先看人数。\n\n" +
      "- `scope=zone` 只算**当前区**（请求头 `X-Zone-Id` 指的那个）；`scope=all` 算所有未合并的区，" +
      "**同样需要 `gameMail:broadcast-all`**（否则运营先看到「影响 8 万人」再被发送按钮拒绝）。\n" +
      "- 等级段两端都可省；`minLevel > maxLevel` → 400（填反了必须当场报，否则会「成功发送 0 封」）。",
    permissions: [Permission.GAME_MAIL_BROADCAST],
  })
  @ApiDataResponse(BroadcastPreviewResultDto, { description: "命中人数与覆盖的区" })
  previewBroadcast(
    @CurrentUser() user: AuthenticatedUser,
    @ZoneContext() zoneId: number,
    @Body() dto: BroadcastPreviewDto,
  ): BroadcastPreviewResultDto {
    return this.broadcast.preview(user, zoneId, dto);
  }

  @Post("broadcasts")
  @AuditTarget("gameMail")
  @ApiAdminDoc({
    operationId: "adminGameMail.broadcast",
    summary: "群发游戏消息",
    description:
      "按「当前区 / 全服 + 等级段」给一批角色各发一封游戏内消息，**同步等写完再返回**。\n\n" +
      "- `batchId` 由管理端生成并在重试时**原样复用**：同一批次号只发一次，" +
      "重复提交返回既有结果（`duplicated: true`），不会再写任何一行。\n" +
      "- 分批写入（`GAME_MAIL_BROADCAST_BATCH_SIZE`，默认 500 封/批），每批一个事务、" +
      "批间让出事件循环 —— 一次几万行不会长时间占着写锁。\n" +
      "- 附件同样是**预告**：玩家在消息中心点领取才入包；群发邮件一律**不过期**（补偿不该消失）。\n" +
      "- 离线角色照发（邮件本来就是异步的）；`targetCount` 与 `sentCount` 不等是正常的" +
      "（发送期间有人建号 / 删号）。",
    permissions: [Permission.GAME_MAIL_BROADCAST],
  })
  @ApiDataResponse(BroadcastViewDto, {
    status: 201,
    description: "批次结果（含 batchId / targetCount / sentCount；duplicated = 这个批次号之前发过）",
  })
  async sendBroadcast(
    @CurrentUser() user: AuthenticatedUser,
    @ZoneContext() zoneId: number,
    @Body() dto: AdminBroadcastMailDto,
  ): Promise<BroadcastViewDto> {
    return this.broadcast.broadcast(user, zoneId, dto);
  }

  @Get("broadcasts")
  @ApiAdminDoc({
    operationId: "adminGameMail.broadcasts",
    summary: "群发批次列表",
    description:
      "最近 50 个批次（新发的在前）。**刻意跨区**：在 A 区也要能看到同事刚在 B 区发了什么，" +
      "否则「发错区」这件事在界面上直接消失。\n\n" +
      "`finishedAt` 为空 = 那一批写到一半中断了（行已经发出去了，不补也不删）；" +
      "`targetCount` 与 `sentCount` 的差就是中断或期间增删角色的量。",
    permissions: [Permission.GAME_MAIL_BROADCAST],
  })
  @ApiDataResponse(BroadcastViewDto, { isArray: true, description: "最近批次（最多 50 条）" })
  broadcasts(): BroadcastViewDto[] {
    return this.broadcast.list();
  }
}
