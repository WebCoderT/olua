import { ApiProperty } from "@nestjs/swagger";
import { IsString, MaxLength } from "class-validator";

/** 邮箱地址长度上限（RFC 5321 规定 254） */
export const EMAIL_MAX_LENGTH = 254;

/**
 * 补录 / 修改玩家邮箱
 *
 * 传非空串 = 补录或改成该邮箱（服务端会校验格式并查重）；
 * 传空串 = 清空（账号回到「未填写邮箱」状态）。
 *
 * 字段本身不做 `@IsEmail`：那样会把空串也判成格式错误，而空串在这里是「清空」的合法语义。
 * 格式校验放在业务层（`isEmail`），只在非空时才验 —— 与「账号名可被清空」的语义一致。
 */
export class UpdateAccountEmailDto {
  @ApiProperty({
    description: "玩家邮箱；传非空串补录 / 改，传空串清空。同一邮箱只绑一个账号（大小写不敏感）。",
    example: "player@example.com",
    maxLength: EMAIL_MAX_LENGTH,
  })
  @IsString({ message: "邮箱必须是字符串" })
  @MaxLength(EMAIL_MAX_LENGTH, { message: `邮箱最长 ${EMAIL_MAX_LENGTH} 个字符` })
  email: string;
}
