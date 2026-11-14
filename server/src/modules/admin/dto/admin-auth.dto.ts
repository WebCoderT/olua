import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsOptional, IsString, Length, Matches } from "class-validator";

/** 管理端注册入参（是否需要注册码由服务端 ADMIN_REGISTER_CODE 决定） */
export class AdminRegisterDto {
  @ApiProperty({ description: "管理员账号：3~20 位字母 / 数字 / 下划线", example: "gm001" })
  @IsString({ message: "账号必须是字符串" })
  @Matches(/^[A-Za-z0-9_]{3,20}$/, { message: "账号需为 3~20 位字母、数字或下划线" })
  username: string;

  @ApiProperty({ description: "密码：6~32 位", example: "admin123" })
  @IsString({ message: "密码必须是字符串" })
  @Length(6, 32, { message: "密码长度需为 6~32 位" })
  password: string;

  @ApiPropertyOptional({ description: "注册码（服务端配置了 ADMIN_REGISTER_CODE 时必填；未配置且未开 ADMIN_REGISTER_OPEN 时，管理端注册整体关闭）", example: "olua-admin-2026" })
  @IsOptional()
  @IsString({ message: "注册码必须是字符串" })
  registerCode?: string;
}

/** 管理端登录入参 */
export class AdminLoginDto {
  @ApiProperty({ description: "管理员账号", example: "gm001" })
  @IsString({ message: "账号必须是字符串" })
  @Length(1, 64, { message: "请输入账号" })
  username: string;

  @ApiProperty({ description: "密码", example: "admin123" })
  @IsString({ message: "密码必须是字符串" })
  @Length(1, 64, { message: "请输入密码" })
  password: string;

  /**
   * 登录后进入哪个区（#960）
   *
   * **必填**：管理端一次只在一个区里干活，登录时就定下来（之后顶栏可切）。
   * 可选区清单走 `GET /admin/auth/zones`（公开，登录页先拉它）。
   */
  @ApiPropertyOptional({
    description:
      "登录后所在的区服 id（可选清单见 GET /admin/auth/zones）。**必填，但校验不在这里**：" +
      "缺失 / 非整数 / 区不存在 / 区已合并统一由 `resolveZoneId` 回 400 `ZONE_REQUIRED(50029)`，" +
      "四种理由对客户端是同一句话（选一个区服）。",
    example: 1,
  })
  @IsOptional()
  @Type(() => Number)
  zoneId?: number;
}
