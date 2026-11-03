import { ApiProperty } from "@nestjs/swagger";

/**
 * 复活结果（#596：满血由服务端落账，客户端照搬刷新血球即可）
 *
 * 上下限都是**服务端重算**的（与用药同一口径）；血蓝 = 各自上限（复活即满状态）。
 */
export class ReviveResultDto {
  @ApiProperty({ description: "复活后的生命值（= maxHp）" })
  hp: number;

  @ApiProperty({ description: "复活后的魔法值（= maxMp）" })
  mp: number;

  @ApiProperty({ description: "服务端重算的生命上限" })
  maxHp: number;

  @ApiProperty({ description: "服务端重算的魔法上限" })
  maxMp: number;
}
