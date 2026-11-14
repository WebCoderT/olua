import { ApiProperty } from "@nestjs/swagger";
import { IsString, Length, Matches } from "class-validator";

/**
 * 玩家注册入参
 *
 * **没有 `zoneId`**（#957 起）：账号只是身份，角色才属于区。注册落在第一个 `open` 的
 * 区（`AuthService.register`），玩家真正决定在哪玩是「选服」（`POST /zones/select`）。
 *
 * 旧客户端仍会发 `zoneId` 上来 —— 全局 `ValidationPipe` 开了 `whitelist: true` 且没开
 * `forbidNonWhitelisted`，多余字段被**静默剥掉**，请求照常成功。所以这里不需要为一个
 * 即将消失的字段留 `@IsOptional()` 占位：占位反而会让守点（`audit-zone-scope` 的
 * `dto-input`）以为「注册又能由客户端指定区了」。
 */
export class RegisterDto {
  @ApiProperty({ description: "游戏账号：3~20 位字母 / 数字 / 下划线", example: "player001" })
  @IsString({ message: "账号必须是字符串" })
  @Matches(/^[A-Za-z0-9_]{3,20}$/, { message: "账号需为 3~20 位字母、数字或下划线" })
  username: string;

  @ApiProperty({ description: "密码：6~32 位", example: "123456" })
  @IsString({ message: "密码必须是字符串" })
  @Length(6, 32, { message: "密码长度需为 6~32 位" })
  password: string;
}
