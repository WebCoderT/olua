import { Controller, Post } from "@nestjs/common";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiPlayerDoc } from "../../common/decorators/api-doc.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { RealtimeTicketDto } from "./dto/realtime.dto";
import { REALTIME_PATH } from "./realtime.protocol";
import { RealtimeService } from "./realtime.service";

/**
 * 实时通道（HTTP 这一半）
 *
 * 通道本身是 WebSocket，但**建连前的鉴权走普通 HTTP** —— 这样令牌校验与其余接口
 * 是同一段代码（全局 AuthGuard），实时通道不需要另写一套「怎么认人」。
 */
@Controller(REALTIME_PATH)
export class RealtimeController {
  constructor(private readonly realtime: RealtimeService) {}

  @Post("ticket")
  @ApiPlayerDoc({
    operationId: "realtime.ticket",
    summary: "取实时连接票据",
    description:
      "取一张**一次性**票据，用它去 `ws://<host>/<API_PREFIX>/realtime?ticket=<票据>` 建立实时连接。\n\n" +
      "票据默认 **30 秒**过期、**用过即焚**、与账号绑定；重新连接要重新取票。\n\n" +
      "之所以不直接用访问令牌建连：WS 握手没有 `Authorization` 头的便利，而访问令牌能用 7 天，" +
      "放进 URL query 会被代理日志 / 浏览器历史留痕。票据是随机字节、状态只在服务端内存里，" +
      "泄漏一张已期票据拿不到任何东西。\n\n" +
      "同一个账号只保留**一条**连接：新连接会把旧连接关掉（关闭码 `4000`）。",
  })
  @ApiDataResponse(RealtimeTicketDto, { description: "一次性连接票据与它的有效期" })
  ticket(@CurrentUser() user: AuthenticatedUser): RealtimeTicketDto {
    return this.realtime.issueTicket(user);
  }
}
