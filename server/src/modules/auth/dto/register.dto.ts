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
   * @deprecated #957 起**注册不再定区**：账号只是身份，角色才属于区。
   *
   * 字段留一版只为兼容旧客户端（它会把 zoneId 一起发上来），服务端**忽略**它。
   * 下一版删；删之前别在服务端读它 —— 读了就等于「区可以由客户端指定」，那正是要堵的路。
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
