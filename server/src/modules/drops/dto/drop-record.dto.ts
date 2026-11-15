import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from "class-validator";
import { PageMetaDto, PageQueryDto } from "../../../common/dto/api-envelope.dto";
import { DROP_RESULTS, DROP_RESULT_LABELS, DropResult, isKnownDropResult } from "../../../common/constants/drop";
import { DropRecordRow } from "../../../database/rows";

/**
 * 一条掉落终态流水（`drop_records` 的一行，#803）
 *
 * 一件掉落的一生只写一行：`createdAt` 是它落地那一刻，`resolvedAt` 是它离开地面那一刻，
 * `livedMs` 是两者之差（管理端按「在地上待了多久」排序用）。
 *
 * `goodType` / `goodLabel` / `monsterLabel` 是**冗余存下来的快照**：物品或怪物配置日后被删，
 * 这条记录仍要能看懂 —— 所以它们允许为 null（存量行 / 配置已被删），而不是回查当前配置。
 */
export class DropRecordDto {
  @ApiProperty({ description: "自增 id（同一毫秒的多条靠它稳定排序）" })
  id: number;

  @ApiProperty({ description: "掉落 id（`d_<区>_<图>_<序号>`）", example: "d_1_1_42" })
  dropId: string;

  @ApiProperty({ description: "区服 id" })
  zoneId: number;

  @ApiProperty({ description: "地图 id", example: "1" })
  mapId: string;

  @ApiProperty({ description: "物品 id", example: "drug_hp_1" })
  goodId: string;

  @ApiProperty({ description: "物品类型（equipment / drug / money / scroll…；配置已删时为 null）", type: "string", nullable: true })
  goodType: string | null;

  @ApiProperty({ description: "物品显示名（掉落那一刻的快照）", type: "string", nullable: true })
  goodLabel: string | null;

  @ApiProperty({ description: "件数" })
  count: number;

  @ApiProperty({ description: "是否绑定（绑定物品不可交易）" })
  bound: boolean;

  @ApiProperty({ description: "来源怪物 key", example: "slime_1" })
  monsterKey: string;

  @ApiProperty({ description: "来源怪物显示名（快照）", type: "string", nullable: true })
  monsterLabel: string | null;

  @ApiProperty({ description: "来源怪物实例 id（同 key 的第几只，排查刷怪用）" })
  monsterInstanceId: string;

  @ApiProperty({ description: "归属者账号 id" })
  ownerAccountId: string;

  @ApiProperty({ description: "归属者角色 id" })
  ownerRoleId: string;

  @ApiProperty({ description: "归属者角色名（快照）" })
  ownerName: string;

  @ApiProperty({
    description: "终态：picked（被捡走）/ expired（自然过期）/ overflow（被挤掉）/ restart_lost（重启丢失）",
    enum: DROP_RESULTS,
    example: "picked",
  })
  result: DropResult;

  @ApiProperty({ description: "结果的中文名（未知值回显原值）", example: "已被拾取" })
  resultLabel: string;

  @ApiProperty({
    description: "结果细分：`overflow` 才有值 —— auto（超单图上限挤掉）/ manual_clear（管理端清空）；其余为 null",
    type: "string",
    nullable: true,
    example: "auto",
  })
  reason: string | null;

  @ApiProperty({ description: "捡走的人的账号 id（只有 picked 有）", type: "string", nullable: true })
  pickedAccountId: string | null;

  @ApiProperty({ description: "捡走的人的角色 id（只有 picked 有）", type: "string", nullable: true })
  pickedRoleId: string | null;

  @ApiProperty({ description: "捡走的人的角色名（只有 picked 有）", type: "string", nullable: true })
  pickedName: string | null;

  @ApiProperty({ description: "掉落落地时刻（毫秒）" })
  createdAt: number;

  @ApiProperty({ description: "离开地面的时刻（毫秒；restart_lost 是进程启动时刻）" })
  resolvedAt: number;

  @ApiProperty({ description: "在地上存活了多久（= resolvedAt - createdAt，服务端算好）" })
  livedMs: number;

  static from(row: DropRecordRow): DropRecordDto {
    const dto = new DropRecordDto();
    dto.id = row.id;
    dto.dropId = row.drop_id;
    dto.zoneId = row.zone_id;
    dto.mapId = row.map_id;
    dto.goodId = row.good_id;
    dto.goodType = row.good_type;
    dto.goodLabel = row.good_label;
    dto.count = row.count;
    dto.bound = row.bound === 1;
    dto.monsterKey = row.monster_key;
    dto.monsterLabel = row.monster_label;
    dto.monsterInstanceId = row.monster_instance_id;
    dto.ownerAccountId = row.owner_account_id;
    dto.ownerRoleId = row.owner_role_id;
    dto.ownerName = row.owner_name;
    dto.result = isKnownDropResult(row.result) ? row.result : (row.result as DropResult);
    dto.resultLabel = isKnownDropResult(row.result) ? DROP_RESULT_LABELS[row.result] : row.result;
    dto.reason = row.reason;
    dto.pickedAccountId = row.picked_account_id;
    dto.pickedRoleId = row.picked_role_id;
    dto.pickedName = row.picked_name;
    dto.createdAt = row.created_at;
    dto.resolvedAt = row.resolved_at;
    dto.livedMs = row.lived_ms;
    return dto;
  }
}

/**
 * 掉落流水查询入参
 *
 * 区**不在**这里：它来自请求头 `X-Zone-Id`（管理端的「当前作业区」是上下文，不是查询参数，
 * 见 docs/39 §2.4）。显式传 `?zoneId=` 会被忽略，管理端也不该提供「全部区」视图。
 */
export class DropRecordQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "只看某张图（地图 id）" })
  @IsOptional()
  @IsString({ message: "地图 id 必须是字符串" })
  @MaxLength(64, { message: "地图 id 过长" })
  mapId?: string;

  @ApiPropertyOptional({ description: "只看某种终态", enum: DROP_RESULTS })
  @IsOptional()
  @IsString({ message: "结果必须是字符串" })
  @IsIn(DROP_RESULTS, { message: "结果取值不合法" })
  result?: string;

  @ApiPropertyOptional({ description: "归属者角色名（模糊匹配；`_` / `%` 会被转义）" })
  @IsOptional()
  @IsString({ message: "归属者名字必须是字符串" })
  @MaxLength(64, { message: "归属者名字过长" })
  ownerName?: string;

  @ApiPropertyOptional({ description: "物品 id（精确匹配：查「这件东西都掉过谁手里」）" })
  @IsOptional()
  @IsString({ message: "物品 id 必须是字符串" })
  @MaxLength(64, { message: "物品 id 过长" })
  goodId?: string;

  @ApiPropertyOptional({ description: "起始时间（毫秒时间戳，含；按掉落落地时刻）", minimum: 0 })
  @IsOptional()
  @IsInt({ message: "起始时间必须是整数" })
  @Min(0, { message: "起始时间不能为负" })
  from?: number;

  @ApiPropertyOptional({ description: "结束时间（毫秒时间戳，含）", minimum: 0 })
  @IsOptional()
  @IsInt({ message: "结束时间必须是整数" })
  @Min(0, { message: "结束时间不能为负" })
  to?: number;
}

/** 掉落流水分页结果 */
export class DropRecordPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的流水（默认按终态时刻倒序）", type: [DropRecordDto] })
  list: DropRecordDto[];
}

/** 一种终态的计数（概况卡的一格） */
export class DropRecordSummaryItemDto {
  @ApiProperty({ description: "终态值", enum: DROP_RESULTS, example: "picked" })
  result: string;

  @ApiProperty({ description: "终态的中文名", example: "已被拾取" })
  resultLabel: string;

  @ApiProperty({ description: "当前筛选条件下的条数" })
  total: number;
}

/**
 * 概况（页面顶部的分组计数）
 *
 * **只吃筛选条件里除 `result` 之外的那几项**：传了 `result` 就是「只看 picked」，
 * 再按 picked 分组只剩一行 —— 那不是概况。
 *
 * 四个终态**恒出现**（没有数据的给 0）：少一个格子会让运营以为「这种结果不存在」，
 * 而 0 一眼就能看出「这类还没发生过」。
 */
export class DropRecordSummaryDto {
  @ApiProperty({ description: "按终态分组的计数（四个终态恒出现，空数据为 0）", type: [DropRecordSummaryItemDto] })
  items: DropRecordSummaryItemDto[];

  @ApiProperty({ description: "合计条数（= 各项之和）" })
  total: number;
}
