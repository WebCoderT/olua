import { ApiProperty } from "@nestjs/swagger";
import { AccountDto } from "./account.dto";

/** 登录 / 注册成功后的返回 */
export class AuthTokenDto {
  @ApiProperty({ description: "访问令牌（放 Authorization: Bearer <token>）" })
  token: string;

  @ApiProperty({ description: "令牌有效期（与 JWT_EXPIRES_IN 一致）", example: "7d" })
  expiresIn: string;

  @ApiProperty({ description: "账号信息", type: AccountDto })
  account: AccountDto;
}
