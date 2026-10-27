import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsOptional, IsString } from "class-validator";
import { PageMetaDto, PageQueryDto } from "../../../common/dto/api-envelope.dto";
import { REPORT_CATEGORIES, REPORT_CATEGORY_LABELS, REPORT_STATUS } from "../../../common/constants/social";
import { RoleReportWithNameRow } from "../../../database/rows";

/**
 * 一条玩家举报（管理端只读）
 *
 * **名字是查询时 join 出来的**（不是落库时的快照）：角色改名后这里跟着变；
 * 角色被删了则为 null，界面退回显示 id —— 记录本身不随人消失。
 */
export class ReportDto {
  @ApiProperty({ description: "举报 id" })
  id: string;

  @ApiProperty({ description: "举报人角色 id" })
  roleId: string;

  @ApiProperty({ description: "举报人角色名（已删号为 null）", type: "string", nullable: true })
  roleName: string | null;

  @ApiProperty({ description: "被举报角色 id" })
  targetRoleId: string;

  @ApiProperty({ description: "被举报角色名（已删号为 null）", type: "string", nullable: true })
  targetName: string | null;

  @ApiProperty({ description: "类别：abuse / cheat / name / other", example: "abuse" })
  category: string;

  @ApiProperty({ description: "类别中文名（界面直接显示，不必自己映射）", example: "骚扰辱骂" })
  categoryLabel: string;

  @ApiProperty({ description: "补充说明（可空）" })
  reason: string;

  @ApiProperty({ description: "状态：pending / handled / dismissed（v1 只会是 pending）", example: "pending" })
  status: string;

  @ApiProperty({ description: "举报时间（毫秒）", example: 1760000000000 })
  createdAt: number;

  static from(row: RoleReportWithNameRow): ReportDto {
    const dto = new ReportDto();
    dto.id = row.id;
    dto.roleId = row.role_id;
    dto.roleName = row.role_name;
    dto.targetRoleId = row.target_role_id;
    dto.targetName = row.target_name;
    dto.category = row.category;
    dto.categoryLabel = REPORT_CATEGORY_LABELS[row.category as keyof typeof REPORT_CATEGORY_LABELS] ?? row.category;
    dto.reason = row.reason;
    dto.status = row.status;
    dto.createdAt = row.created_at;
    return dto;
  }
}

/** 举报列表筛选（条件之间是「与」） */
export class ReportQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: `类别：${REPORT_CATEGORIES.join(" / ")}` })
  @IsOptional()
  @IsIn(REPORT_CATEGORIES, { message: `类别只能是 ${REPORT_CATEGORIES.join(" / ")}` })
  declare category?: string;

  @ApiPropertyOptional({ description: "状态：pending / handled / dismissed" })
  @IsOptional()
  @IsIn(Object.values(REPORT_STATUS), { message: "状态只能是 pending / handled / dismissed" })
  declare status?: string;

  @ApiPropertyOptional({ description: "关键字：模糊匹配双方角色名或角色 id" })
  @IsOptional()
  @IsString({ message: "关键字必须是字符串" })
  declare keyword?: string;
}

/** 举报分页结果 */
export class ReportPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的举报", type: [ReportDto] })
  list: ReportDto[];
}
