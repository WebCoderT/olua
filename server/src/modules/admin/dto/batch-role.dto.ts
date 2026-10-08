import { ApiProperty } from "@nestjs/swagger";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString } from "class-validator";

/** 一次批量删除的角色条数上限（避免一个请求删光全服，也不会把 SQL 的 IN 撑爆） */
export const ROLE_BATCH_DELETE_MAX = 100;

/**
 * 批量删除角色
 *
 * 语义是「这几条 id 删掉」，已不存在的 id 静默跳过（幂等）——
 * 管理端列表可能已经过期，为一条陈旧 id 整体失败反而更难用。
 */
export class BatchDeleteRolesDto {
  @ApiProperty({ description: `要删除的角色 id 列表（最多 ${ROLE_BATCH_DELETE_MAX} 条）`, type: [String], example: ["1760000000000"] })
  @IsArray({ message: "角色 id 必须是数组" })
  @ArrayMinSize(1, { message: "至少选一个角色" })
  @ArrayMaxSize(ROLE_BATCH_DELETE_MAX, { message: `一次最多删除 ${ROLE_BATCH_DELETE_MAX} 个角色` })
  @IsString({ each: true, message: "角色 id 必须是字符串" })
  ids: string[];
}

/** 批量删除结果 */
export class BatchDeleteResultDto {
  @ApiProperty({ description: "请求删除的条数" })
  requested: number;

  @ApiProperty({ description: "实际删除的条数（已不存在的 id 不计入）" })
  deleted: number;

  @ApiProperty({ description: "实际被删掉的角色 id", type: [String] })
  ids: string[];

  @ApiProperty({ description: "被顺带清掉在线角色标记的账号 id（删的是在线角色时）", type: [String] })
  clearedOnlineAccountIds: string[];
}
