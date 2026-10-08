import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsArray, IsIn, IsInt, IsObject, IsOptional, IsString, Length, Max, Min, ValidateNested } from "class-validator";
import {
  ROLE_BAG_AXIS_MAX,
  ROLE_BAG_CELL_MAX,
  ROLE_FIELD_VALUE_MAX_LENGTH,
  ROLE_LEVEL_MAX,
  ROLE_NAME_MAX_LENGTH,
  ROLE_OCCUPATIONS,
  ROLE_SEXES,
} from "../../roles/role-data.util";
import { ADMIN_NUMBER_FIELD_MAX } from "./query.dto";

/**
 * 背包里的一个格子（**必须是有装饰器的 DTO 类**，不能写成裸对象）
 *
 * 原因：全局管道开了 `whitelist: true` —— 它会剥掉「没有校验装饰器的属性」，
 * 而且对**嵌套的裸对象**同样生效：写成 `bag?: unknown[]` 时，请求里的
 * `[{ row: 0, col: 0, id: "1", count: 1 }]` 到服务层会变成 `[[]]`（属性被剥光，静默变空数组）。
 * 所以这里必须声明成 DTO 并挂 `@ValidateNested` + `@Type`。
 */
export class RoleBagCellDto {
  @ApiProperty({ description: `格子行号（0 ~ ${ROLE_BAG_AXIS_MAX - 1}）`, minimum: 0, maximum: ROLE_BAG_AXIS_MAX - 1 })
  @IsInt({ message: "背包格子行号必须是整数" })
  @Min(0, { message: "背包格子行号不能为负" })
  @Max(ROLE_BAG_AXIS_MAX - 1, { message: `背包格子行号最大为 ${ROLE_BAG_AXIS_MAX - 1}` })
  row: number;

  @ApiProperty({ description: `格子列号（0 ~ ${ROLE_BAG_AXIS_MAX - 1}）`, minimum: 0, maximum: ROLE_BAG_AXIS_MAX - 1 })
  @IsInt({ message: "背包格子列号必须是整数" })
  @Min(0, { message: "背包格子列号不能为负" })
  @Max(ROLE_BAG_AXIS_MAX - 1, { message: `背包格子列号最大为 ${ROLE_BAG_AXIS_MAX - 1}` })
  col: number;

  @ApiProperty({ description: "物品 id（客户端 configs/items 的 key）", example: "1001" })
  @IsString({ message: "背包物品 id 必须是字符串" })
  @Length(1, ROLE_FIELD_VALUE_MAX_LENGTH, { message: `背包物品 id 需为 1~${ROLE_FIELD_VALUE_MAX_LENGTH} 个字符` })
  id: string;

  @ApiProperty({ description: "数量", minimum: 1, maximum: 999_999 })
  @IsInt({ message: "背包物品数量必须是整数" })
  @Min(1, { message: "背包物品数量至少为 1" })
  @Max(999_999, { message: "背包物品数量过大" })
  count: number;
}

/**
 * 管理端修改角色
 *
 * 开放三类字段，都是「改哪几个就提交哪几个」（未提交的原样保留）：
 * 1. **基础信息**：角色名 / 职业 / 性别 / 等级 / 时装 / 头像 / 所在地图；
 * 2. **常用数值**：金币 / 绑定元宝 / 银两 / 经验 / 战魂 / 称号 / 军衔；
 * 3. **运行时数据**：装备穿戴表 / 技能等级表 / 背包格子（**结构化编辑**）。
 *
 * 第 3 类刻意不做「把整个 data 交给你改」：data 里还有大量游戏运行时细节（快捷键绑定、
 * 速度倍率…），开放整份文档等于把客户端配置的形状当成服务端契约，改一次客户端就漂一次。
 * 这三项则各有明确结构，改完玩家那边读到就是改后的值。
 */
export class AdminPatchRoleDto {
  @ApiPropertyOptional({ description: "角色名", example: "小明" })
  @IsOptional()
  @IsString({ message: "角色名必须是字符串" })
  @Length(1, ROLE_NAME_MAX_LENGTH, { message: `角色名需为 1~${ROLE_NAME_MAX_LENGTH} 个字` })
  name?: string;

  @ApiPropertyOptional({ description: "职业（1 战士 / 2 魔法师 / 3 道士 / 4 全职业）", enum: [...ROLE_OCCUPATIONS] })
  @IsOptional()
  @IsString({ message: "职业必须是字符串" })
  @IsIn([...ROLE_OCCUPATIONS], { message: "职业取值不合法" })
  occupation?: string;

  @ApiPropertyOptional({ description: "性别（1 男 / 2 女 / 3 全性别）", enum: [...ROLE_SEXES] })
  @IsOptional()
  @IsString({ message: "性别必须是字符串" })
  @IsIn([...ROLE_SEXES], { message: "性别取值不合法" })
  sex?: string;

  @ApiPropertyOptional({ description: "等级", minimum: 1, maximum: ROLE_LEVEL_MAX })
  @IsOptional()
  @IsInt({ message: "等级必须是整数" })
  @Min(1, { message: "等级最小为 1" })
  @Max(ROLE_LEVEL_MAX, { message: `等级最大为 ${ROLE_LEVEL_MAX}` })
  level?: number;

  @ApiPropertyOptional({ description: "金币" })
  @IsOptional()
  @IsInt({ message: "金币必须是整数" })
  @Min(0, { message: "金币不能为负" })
  @Max(ADMIN_NUMBER_FIELD_MAX, { message: "金币数值过大" })
  gold?: number;

  @ApiPropertyOptional({ description: "绑定元宝" })
  @IsOptional()
  @IsInt({ message: "绑定元宝必须是整数" })
  @Min(0, { message: "绑定元宝不能为负" })
  @Max(ADMIN_NUMBER_FIELD_MAX, { message: "绑定元宝数值过大" })
  bindGold?: number;

  @ApiPropertyOptional({ description: "银两" })
  @IsOptional()
  @IsInt({ message: "银两必须是整数" })
  @Min(0, { message: "银两不能为负" })
  @Max(ADMIN_NUMBER_FIELD_MAX, { message: "银两数值过大" })
  silver?: number;

  @ApiPropertyOptional({ description: "经验" })
  @IsOptional()
  @IsInt({ message: "经验必须是整数" })
  @Min(0, { message: "经验不能为负" })
  @Max(ADMIN_NUMBER_FIELD_MAX, { message: "经验数值过大" })
  exp?: number;

  @ApiPropertyOptional({ description: "战魂等级" })
  @IsOptional()
  @IsInt({ message: "战魂等级必须是整数" })
  @Min(0, { message: "战魂等级不能为负" })
  @Max(ADMIN_NUMBER_FIELD_MAX, { message: "战魂等级数值过大" })
  soulOfWar?: number;

  @ApiPropertyOptional({ description: "称号等级" })
  @IsOptional()
  @IsInt({ message: "称号等级必须是整数" })
  @Min(0, { message: "称号等级不能为负" })
  @Max(ADMIN_NUMBER_FIELD_MAX, { message: "称号等级数值过大" })
  title?: number;

  @ApiPropertyOptional({ description: "军衔阶数" })
  @IsOptional()
  @IsInt({ message: "军衔阶数必须是整数" })
  @Min(0, { message: "军衔阶数不能为负" })
  @Max(ADMIN_NUMBER_FIELD_MAX, { message: "军衔阶数数值过大" })
  rank?: number;

  //#region 基础信息（外观与位置）

  @ApiPropertyOptional({ description: "时装（外观）id；null = 取消时装", type: "number", nullable: true })
  @IsOptional()
  @IsInt({ message: "时装 id 必须是整数" })
  @Min(0, { message: "时装 id 不能为负" })
  @Max(ADMIN_NUMBER_FIELD_MAX, { message: "时装 id 数值过大" })
  fashionCloth?: number | null;

  @ApiPropertyOptional({ description: "头像编号" })
  @IsOptional()
  @IsInt({ message: "头像编号必须是整数" })
  @Min(0, { message: "头像编号不能为负" })
  @Max(ADMIN_NUMBER_FIELD_MAX, { message: "头像编号数值过大" })
  avatar?: number;

  /**
   * 所在地图 id
   *
   * 地图清单在客户端（configs/map），服务端只校验「是个短字符串」——
   * 认得出地图名的只有客户端，服务端复制一份必然漂移。
   */
  @ApiPropertyOptional({ description: "所在地图 id（客户端 configs/map 的 key）", example: "0" })
  @IsOptional()
  @IsString({ message: "地图 id 必须是字符串" })
  @Length(1, 32, { message: "地图 id 需为 1~32 个字符" })
  onMap?: string;

  //#endregion

  //#region 运行时数据（结构化编辑：服务端只校验结构，内容清单由客户端配置定义）

  /**
   * 装备穿戴表（槽位 → 装备 id，null / 空串表示卸下）
   *
   * 逐项结构与体量校验在 role-data.util.normalizeEquipments（那里有完整理由说明为什么服务端不校验装备 id 是否存在）。
   */
  @ApiPropertyOptional({
    description: "装备穿戴表（槽位名 → 装备 id；null 或空串表示该槽位空着）",
    type: "object",
    additionalProperties: { type: "string", nullable: true },
    example: { WEAPON: "1001", HELMET: null },
  })
  @IsOptional()
  @IsObject({ message: "装备数据必须是对象" })
  equipments?: Record<string, string | null>;

  /** 技能等级表（技能 id → 等级）；逐项校验见 role-data.util.normalizeSkills */
  @ApiPropertyOptional({
    description: "技能等级表（技能 id → 等级）",
    type: "object",
    additionalProperties: { type: "integer" },
    example: { "1001": 3 },
  })
  @IsOptional()
  @IsObject({ message: "技能数据必须是对象" })
  skills?: Record<string, number>;

  /**
   * 背包格子（稀疏格式：只报「哪一格放了什么」）
   *
   * 传空数组 = 清空背包（网格尺寸保留）。二维数组的尺寸由客户端配置决定，
   * 服务端不认识它，详见 role-data.util.normalizeBagCells / applyBagCells。
   */
  @ApiPropertyOptional({
    description: "背包格子（稀疏：行/列/物品 id/数量）；空数组 = 清空背包",
    type: [RoleBagCellDto],
    example: [{ row: 0, col: 0, id: "1001", count: 1 }],
  })
  @IsOptional()
  @IsArray({ message: "背包格子必须是数组" })
  @ValidateNested({ each: true })
  @Type(() => RoleBagCellDto)
  bag?: RoleBagCellDto[];

  //#endregion
}
