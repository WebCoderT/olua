import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsString, Matches, MaxLength, Min } from "class-validator";
import { RoleRow } from "../../../database/rows";
import { RoleDto } from "./role.dto";

/** 技能 id 的形状（与 `skills.id` 同口径：数字串；服务端只按表查，不做语义解释） */
const SKILL_ID_PATTERN = /^[0-9]{1,8}$/;

/**
 * 技能升级请求（#828）
 *
 * 客户端只报「升哪个技能」——**等级、花费、上限一概不报**，全由服务端从库里算。
 * 报花费就等于让改包自己定价，报等级就等于让它跳级。
 */
export class SkillUpgradeDto {
  @ApiProperty({ description: "要升的技能 id（必须是已学会的技能，见 `data.skills`）", example: "1000" })
  @IsString({ message: "skillId 必须是字符串" })
  @MaxLength(8)
  @Matches(SKILL_ID_PATTERN, { message: "skillId 只能是数字串（如 1000）" })
  skillId!: string;

  @ApiProperty({
    description: "修订号（乐观锁，必填）：客户端读到的值，与服务端不一致时 20006，需先拉最新存档（B62 / #820）",
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  revision!: number;
}

/**
 * 技能升级结果（#828）
 *
 * 继承 `RoleDto`：`data.skills` / `data.skillPoints` 已经是升级后的权威值，
 * 客户端**整份抄回去**即可（与升级卷轴 / 背包操作同一纪律：只照搬，不重算）。
 * 另外三个字段是「这一次发生了什么」，给飘字与面板用：
 *
 * - `fromLevel` / `toLevel`：升前升后（恒差 1）；
 * - `cost` / `remainPoints`：这次花了多少、还剩多少 —— 客户端不需要知道 `1 + 等级` 这条公式，
 *   想显示「再升一级要 X 点」就照上一次回执的 `nextCost`；
 * - `nextCost` / `maxLevel`：下一级的价格与该技能的天花板（`maxLevel` 之后不再升得动）。
 */
export class SkillUpgradeResultDto extends RoleDto {
  @ApiProperty({ description: "升级的技能 id" })
  skillId: string;

  @ApiProperty({ description: "升级前的技能等级" })
  fromLevel: number;

  @ApiProperty({ description: "升级后的技能等级（恒为 fromLevel + 1）" })
  toLevel: number;

  @ApiProperty({ description: "本次消耗的技能点" })
  cost: number;

  @ApiProperty({ description: "升级后剩余的技能点" })
  remainPoints: number;

  @ApiProperty({ description: "再升一级要多少点（已到顶时为 0）" })
  nextCost: number;

  @ApiProperty({ description: "该技能的等级上限（= 伤害系数档数）" })
  maxLevel: number;

  static fromRow(
    row: RoleRow,
    onlineRoleId: string | null,
    detail: {
      skillId: string;
      fromLevel: number;
      toLevel: number;
      cost: number;
      remainPoints: number;
      nextCost: number;
      maxLevel: number;
    },
  ): SkillUpgradeResultDto {
    const dto = new SkillUpgradeResultDto();
    Object.assign(dto, RoleDto.from(row, onlineRoleId));
    dto.skillId = detail.skillId;
    dto.fromLevel = detail.fromLevel;
    dto.toLevel = detail.toLevel;
    dto.cost = detail.cost;
    dto.remainPoints = detail.remainPoints;
    dto.nextCost = detail.nextCost;
    dto.maxLevel = detail.maxLevel;
    return dto;
  }
}
