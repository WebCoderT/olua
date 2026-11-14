import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Length, Min } from "class-validator";

/**
 * 玩家登录入参（只校验非空 —— 格式不对也统一回「账号或密码错误」，避免暴露账号是否存在）
 *
 * 单独一个文件（#961）：`zoneId` 是这份 DTO 里**唯一**一个「客户端能指定区」的字段，
 * 而 `register.dto.ts` 里的同名旧字段是另一件事（兼容旧包、服务端忽略）。两者挤在一个
 * 文件里时，区边界守点（`tools/audit-zone-scope.cjs`，按 规则+文件+字段 记豁免）分不清
 * 谁是谁 —— 一条豁免会顺带盖住另一处，白名单就失去了「逐条说清为什么」的意义。
 */
export class LoginDto {
  @ApiProperty({ description: "游戏账号", example: "player001" })
  @IsString({ message: "账号必须是字符串" })
  @Length(1, 64, { message: "请输入账号" })
  username: string;

  @ApiProperty({ description: "密码", example: "123456" })
  @IsString({ message: "密码必须是字符串" })
  @Length(1, 64, { message: "请输入密码" })
  password: string;

  /**
   * 登录到哪个区（#961，可选）
   *
   * 不传 = 用账号的「当前浏览区」（老客户端就是这条路径）。传了 = 顺便把当前浏览区
   * 切过去 —— 给「当前区在维护、玩家想直接登进另一个区」留一条路，否则维护区会把
   * 多区账号锁死在登录页（那时候还没有令牌，调不了 `POST /zones/select`）。
   *
   * 为什么这一处「客户端指定区」是可以的：它**不是数据范围**，是「进哪个服」的选择。
   * 服务端校验完（必须 open、未合并）就写进 `accounts.active_zone_id`，之后所有读接口
   * 仍然只认服务端这一列 —— 与老客户端「先登录再用 /zones/select 切」落到同一个状态。
   *
   * 取值域不在这里校验：区不存在 / 已合并 / 维护中都由 `AuthService` 回 `ZONE_*` 那几码，
   * 比 DTO 的 40000 更能说明问题。
   */
  @ApiPropertyOptional({ description: "登录到哪个区（可省略 = 当前浏览区；活区清单见 GET /zones）", example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "zoneId 必须是整数" })
  @Min(1, { message: "zoneId 必须是正整数" })
  zoneId?: number;
}
