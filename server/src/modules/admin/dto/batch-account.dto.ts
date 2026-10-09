import { ApiProperty } from "@nestjs/swagger";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString } from "class-validator";
import { UpdateAccountStatusDto } from "./query.dto";

/** 一次批量封禁 / 解封的账号条数上限（与批量删角色同量级：不会一把封光全服，也不会把 SQL 的 IN 撑爆） */
export const ACCOUNT_BATCH_STATUS_MAX = 100;

/**
 * 批量封禁 / 解封账号
 *
 * 字段直接继承单条接口的 `UpdateAccountStatusDto`（状态 / 原因 / 时长），只多一个 id 列表 ——
 * 这样「封禁要写哪几个字段」只有一处定义，不会出现批量路径漏清在线标记之类的差异。
 * 已不存在的 id 静默跳过（管理端列表可能已过期，为一条陈旧 id 整体失败更难用）。
 */
export class BatchUpdateAccountStatusDto extends UpdateAccountStatusDto {
  @ApiProperty({
    description: `要变更的账号 id 列表（最多 ${ACCOUNT_BATCH_STATUS_MAX} 条）`,
    type: [String],
    example: ["1760000000000"],
  })
  @IsArray({ message: "账号 id 必须是数组" })
  @ArrayMinSize(1, { message: "至少选一个账号" })
  @ArrayMaxSize(ACCOUNT_BATCH_STATUS_MAX, { message: `一次最多操作 ${ACCOUNT_BATCH_STATUS_MAX} 个账号` })
  @IsString({ each: true, message: "账号 id 必须是字符串" })
  ids: string[];
}

/** 批量封禁 / 解封的结果 */
export class BatchStatusResultDto {
  @ApiProperty({ description: "请求操作的条数（含重复提交的 id）" })
  requested: number;

  @ApiProperty({ description: "实际改到的条数（已不存在的 id 不计入）" })
  updated: number;

  @ApiProperty({ description: "实际改到的账号 id", type: [String] })
  ids: string[];

  @ApiProperty({ description: "因本次封禁被清掉在线角色的账号 id（解封时为空）", type: [String] })
  clearedOnlineAccountIds: string[];
}
