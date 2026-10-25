import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Length, Matches, Min } from "class-validator";

/** 玩家注册入参 */
export class RegisterDto {
  @ApiProperty({ description: "游戏账号：3~20 位字母 / 数字 / 下划线", example: "player001" })
  @IsString({ message: "账号必须是字符串" })
  @Matches(/^[A-Za-z0-9_]{3,20}$/, { message: "账号需为 3~20 位字母、数字或下划线" })
  username: string;

  @ApiProperty({ description: "密码：6~32 位", example: "123456" })
  @IsString({ message: "密码必须是字符串" })
  @Length(6, 32, { message: "密码长度需为 6~32 位" })
  password: string;

  /**
   * 归属区（#295 阶段二）：注册时选定，之后只随合并区变化。
   * 可省略 —— 老客户端不知道区服，省略时落一区（默认区），行为与区服上线前完全一致。
   */
  @ApiProperty({ description: "归属区 id（可省略，默认 1 = 一区；活区清单见 GET /zones）", required: false, example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "zoneId 必须是整数" })
  @Min(1, { message: "zoneId 必须是正整数" })
  zoneId?: number;
}

/** 玩家登录入参（只校验非空 —— 格式不对也统一回「账号或密码错误」，避免暴露账号是否存在） */
export class LoginDto {
  @ApiProperty({ description: "游戏账号", example: "player001" })
  @IsString({ message: "账号必须是字符串" })
  @Length(1, 64, { message: "请输入账号" })
  username: string;

  @ApiProperty({ description: "密码", example: "123456" })
  @IsString({ message: "密码必须是字符串" })
  @Length(1, 64, { message: "请输入密码" })
  password: string;
}
