import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsString, MaxLength, MinLength } from "class-validator";

/** 口令长度约定（与注册接口保持一致，改一处即可） */
export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_LENGTH = 32;

/** 后台重置某个玩家账号的密码 */
export class ResetAccountPasswordDto {
  @ApiProperty({ description: `新密码（${PASSWORD_MIN_LENGTH}~${PASSWORD_MAX_LENGTH} 位）`, example: "new-pass-123" })
  @IsString({ message: "密码必须是字符串" })
  @MinLength(PASSWORD_MIN_LENGTH, { message: `密码至少 ${PASSWORD_MIN_LENGTH} 位` })
  @MaxLength(PASSWORD_MAX_LENGTH, { message: `密码最多 ${PASSWORD_MAX_LENGTH} 位` })
  password: string;
}

/** 超管重置某个管理员的密码 */
export class ResetAdminPasswordDto extends ResetAccountPasswordDto {}

/** 管理员自助改密（必须带上原密码） */
export class ChangeAdminPasswordDto {
  @ApiProperty({ description: "当前密码" })
  @IsString({ message: "原密码必须是字符串" })
  @MinLength(1, { message: "请输入原密码" })
  oldPassword: string;

  @ApiProperty({ description: `新密码（${PASSWORD_MIN_LENGTH}~${PASSWORD_MAX_LENGTH} 位）` })
  @IsString({ message: "新密码必须是字符串" })
  @MinLength(PASSWORD_MIN_LENGTH, { message: `新密码至少 ${PASSWORD_MIN_LENGTH} 位` })
  @MaxLength(PASSWORD_MAX_LENGTH, { message: `新密码最多 ${PASSWORD_MAX_LENGTH} 位` })
  newPassword: string;
}

/** 重置类接口的统一回执（不回显密码本身） */
export class ResetPasswordResultDto {
  @ApiProperty({ description: "被重置的对象 id" })
  id: string;

  @ApiProperty({ description: "被重置的对象名（账号名 / 管理员名，界面直接展示）" })
  name: string;

  @ApiPropertyOptional({
    description: "提示：口令变更后，该对象此前签发的令牌**已全部作废**，需要用它重新登录",
    example: true,
  })
  revokedTokens?: boolean;
}
