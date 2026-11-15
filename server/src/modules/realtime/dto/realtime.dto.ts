import { ApiProperty } from "@nestjs/swagger";

/**
 * 实时连接票据
 *
 * 这是**一次性**的：换到连接之后就作废（用过即焚），所以同一个客户端每次重连都要重新取一张。
 * 形态是 `<payload>.<签名>`（#770 分片后改成签名的，理由见 `realtime-ticket.util.ts`）：
 * 它自带「账号 / 区 / 过期时刻」三条结论，任何一个实时进程都能独立解开 —— 分片之后
 * 取票请求与握手请求会落在**不同进程**上，票据不能再只活在一个进程的内存里。
 *
 * 仍然可以放进 URL query：30 秒过期、一次性、只给握手用，泄漏一张过期票拿不到任何东西。
 */
export class RealtimeTicketDto {
  @ApiProperty({ description: "一次性票据（拼到 ws 地址的 ticket 查询参数上）", example: "K3f9…" })
  ticket: string;

  @ApiProperty({ description: "有效期（毫秒）；过期后必须重新取票", example: 30000 })
  expiresIn: number;

  @ApiProperty({
    description:
      "这张票该连哪个分片（#770 按区分片）：连接地址是 `…/realtime/s<shard>?ticket=…`。\n\n" +
      "不分片的部署里恒为 `0`，且不带 `/s0` 的老地址同样可用（旧客户端不需要改）。",
    example: 0,
  })
  shard: number;

  static of(ticket: string, expiresIn: number, shard: number): RealtimeTicketDto {
    const dto = new RealtimeTicketDto();
    dto.ticket = ticket;
    dto.expiresIn = expiresIn;
    dto.shard = shard;
    return dto;
  }
}
