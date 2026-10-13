import { ApiProperty } from "@nestjs/swagger";

/**
 * 实时连接票据
 *
 * 这是**一次性**的：换到连接之后就作废（用过即焚），所以同一个客户端每次重连都要重新取一张。
 * 形态上是一串随机字节（`base64url`），**不是令牌** —— 它没有签名、不可解析、与账号的对应关系
 * 只存在服务端内存里。这正是它可以被放进 URL query 的原因：泄漏一张已期票据拿不到任何东西。
 */
export class RealtimeTicketDto {
  @ApiProperty({ description: "一次性票据（拼到 ws 地址的 ticket 查询参数上）", example: "K3f9…" })
  ticket: string;

  @ApiProperty({ description: "有效期（毫秒）；过期后必须重新取票", example: 30000 })
  expiresIn: number;

  static of(ticket: string, expiresIn: number): RealtimeTicketDto {
    const dto = new RealtimeTicketDto();
    dto.ticket = ticket;
    dto.expiresIn = expiresIn;
    return dto;
  }
}
