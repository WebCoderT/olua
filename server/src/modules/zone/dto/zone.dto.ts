import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsString, Length, Min } from "class-validator";
import { ZoneRow } from "../../../database/rows";

/** 区服视图（玩家注册下拉框用：只发 id 与名字，不发运营细节） */
export class ZoneDto {
  @ApiProperty({ description: "区服 id", example: 1 })
  id: number;

  @ApiProperty({ description: "区服名", example: "一区" })
  name: string;

  static from(row: ZoneRow): ZoneDto {
    const dto = new ZoneDto();
    dto.id = row.id;
    dto.name = row.name;
    return dto;
  }
}

/** 区服视图（管理端登录页下拉：#960 —— 只发「选哪个」要用的四个字段） */
export class ZoneOptionDto {
  @ApiProperty({ description: "区服 id", example: 1 })
  id: number;

  @ApiProperty({ description: "区服名", example: "一区" })
  name: string;

  @ApiProperty({
    description: "运营状态：`open`（正常） / `closed`（停止注册，仍可进去查历史）",
    example: "open",
    enum: ["open", "closed"],
  })
  status: string;

  @ApiProperty({ description: "下拉排序（升序，同值按 id）", example: 0 })
  sort: number;

  static from(row: ZoneRow): ZoneOptionDto {
    const dto = new ZoneOptionDto();
    dto.id = row.id;
    dto.name = row.name;
    dto.status = row.status;
    dto.sort = row.sort;
    return dto;
  }
}

/** 区服视图（管理端：带合并标记与账号数） */
export class AdminZoneDto {
  @ApiProperty({ description: "区服 id", example: 1 })
  id: number;

  @ApiProperty({ description: "区服名", example: "一区" })
  name: string;

  @ApiProperty({ description: "已并入的区服 id（未合并为 null）", type: "number", nullable: true, example: null })
  mergedInto: number | null;

  @ApiProperty({ description: "运营状态：open / closed", example: "open", enum: ["open", "closed"] })
  status: string;

  @ApiProperty({ description: "下拉排序（升序，同值按 id）", example: 0 })
  sort: number;

  @ApiProperty({ description: "当前归属本区的账号数", example: 42 })
  accountCount: number;

  @ApiProperty({ description: "开区时间（毫秒）", example: 1760000000000 })
  createdAt: number;

  @ApiProperty({ description: "最近更新时间（毫秒）", example: 1760000000000 })
  updatedAt: number;

  static from(row: ZoneRow, accountCount: number): AdminZoneDto {
    const dto = new AdminZoneDto();
    dto.id = row.id;
    dto.name = row.name;
    dto.mergedInto = row.merged_into;
    dto.status = row.status;
    dto.sort = row.sort;
    dto.accountCount = accountCount;
    dto.createdAt = row.created_at;
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 开新区入参 */
export class CreateZoneDto {
  @ApiProperty({ description: "区服名（1~20 字，唯一）", example: "二区" })
  @IsString({ message: "区服名必须是字符串" })
  @Length(1, 20, { message: "区服名需为 1~20 字" })
  name: string;
}

/** 合并区入参 */
export class MergeZoneDto {
  @ApiProperty({ description: "被并入的区（from，合并后打上已合并标记）", example: 2 })
  @Type(() => Number)
  @IsInt({ message: "fromZoneId 必须是整数" })
  @Min(1, { message: "fromZoneId 必须是正整数" })
  fromZoneId: number;

  @ApiProperty({ description: "并入的目标区（to，必须还是活区）", example: 1 })
  @Type(() => Number)
  @IsInt({ message: "toZoneId 必须是整数" })
  @Min(1, { message: "toZoneId 必须是正整数" })
  toZoneId: number;
}

/** 我的区服（选服弹窗：#957）：区 + 我在这区的角色数 + 是不是当前浏览区 */
export class MyZoneDto extends ZoneDto {
  @ApiProperty({ description: "我在这个区有几个角色", example: 2 })
  roleCount: number;

  @ApiProperty({ description: "是不是当前浏览区（选角页拉的就是它）", example: true })
  current: boolean;
}

/** 选服入参（#957）：只允许切到「我有角色 / 还能建角」的活区 */
export class SelectZoneDto {
  @ApiProperty({ description: "要切到的区服 id（活区清单见 GET /zones/mine）", example: 2 })
  @Type(() => Number)
  @IsInt({ message: "zoneId 必须是整数" })
  @Min(1, { message: "zoneId 必须是正整数" })
  zoneId: number;
}

/** 选服结果 */
export class SelectZoneResultDto {
  @ApiProperty({ description: "切换后的当前浏览区", example: 2 })
  zoneId: number;
}
