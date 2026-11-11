import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from "class-validator";
import { PageMetaDto, PageQueryDto } from "../../../common/dto/api-envelope.dto";
import {
  COMBAT_KEYS,
  CONTROL_FLAG_KEYS,
  TICK_EFFECT_KEYS,
  parseCombatJson,
  parseControlFlagsJson,
  parseTickEffectJson,
} from "../../../common/config-json";
import { SKILL_OWNER_VALUES, STATUS_KIND_VALUES, STATUS_SOURCE_VALUES } from "../../../common/constants/game-config";
import { StatusRow } from "../../../database/rows";

/**
 * 状态配置（#367）
 *
 * 状态 = 一段持续效果：身上特效 + 图标栏徽标 + 战斗数值修正。角色与怪物同表（`owner` 区分）。
 *
 * `combat` 的语义是本表最需要说清楚的一块：它**不规定公式**，只声明「这个状态在数值上
 * 意味着什么」（格挡概率 / 格挡系数 / 防御倍率 / 攻击倍率），真正的结算实现在
 * 客户端的 `ui/utils/battle/BattleMath`（角色）与服务端的 `MonsterAiService`（怪物，#372）。
 * 加新的修正维度要同时改这两处消费方，否则存了也不生效。
 */

/** 状态的战斗数值修正（全部可选，缺省 = 该维度不参与） */
export class StatusCombatDto {
  @ApiPropertyOptional({ description: "格挡触发概率 0~1（缺省 = 不参与格挡判定）", minimum: 0, maximum: 1 })
  @IsOptional()
  @IsNumber({}, { message: "blockChance 必须是数字" })
  @Min(0, { message: "blockChance 不能小于 0" })
  @Max(1, { message: "blockChance 不能大于 1" })
  blockChance?: number;

  @ApiPropertyOptional({ description: "格挡触发时本次伤害的乘数（0~1，0.5 = 减半）", minimum: 0, maximum: 1 })
  @IsOptional()
  @IsNumber({}, { message: "blockFactor 必须是数字" })
  @Min(0, { message: "blockFactor 不能小于 0" })
  @Max(1, { message: "blockFactor 不能大于 1" })
  blockFactor?: number;

  @ApiPropertyOptional({ description: "防御乘法系数（≥1，1.5 = 防御 ×1.5；多个状态连乘）", minimum: 0, maximum: 10 })
  @IsOptional()
  @IsNumber({}, { message: "defenseMultiplier 必须是数字" })
  @Min(0, { message: "defenseMultiplier 不能小于 0" })
  @Max(10, { message: "defenseMultiplier 不能大于 10" })
  defenseMultiplier?: number;

  @ApiPropertyOptional({ description: "攻击乘法系数（≥1，1.5 = 攻击 ×1.5；多个状态连乘）", minimum: 0, maximum: 10 })
  @IsOptional()
  @IsNumber({}, { message: "attackMultiplier 必须是数字" })
  @Min(0, { message: "attackMultiplier 不能小于 0" })
  @Max(10, { message: "attackMultiplier 不能大于 10" })
  attackMultiplier?: number;
}

/** 每个周期拍做什么（#826 第三批；全缺省 = 无周期效果） */
export class StatusTickDto {
  @ApiPropertyOptional({ description: "每拍掉多少血（负数扣血，正数当治疗）", minimum: -1000000, maximum: 1000000 })
  @IsOptional()
  @IsNumber({}, { message: "hp 必须是数字" })
  hp?: number;

  @ApiPropertyOptional({ description: "每拍回多少蓝（负数扣蓝）", minimum: -1000000, maximum: 1000000 })
  @IsOptional()
  @IsNumber({}, { message: "mp 必须是数字" })
  mp?: number;

  @ApiPropertyOptional({ description: "每拍按最大血量的比例变化（-0.02 = 每拍掉 2%）", minimum: -1, maximum: 1 })
  @IsOptional()
  @IsNumber({}, { message: "hpPercent 必须是数字" })
  @Min(-1, { message: "hpPercent 不能小于 -1" })
  @Max(1, { message: "hpPercent 不能大于 1" })
  hpPercent?: number;

  @ApiPropertyOptional({ description: "每拍按最大蓝量的比例变化", minimum: -1, maximum: 1 })
  @IsOptional()
  @IsNumber({}, { message: "mpPercent 必须是数字" })
  @Min(-1, { message: "mpPercent 不能小于 -1" })
  @Max(1, { message: "mpPercent 不能大于 1" })
  mpPercent?: number;
}

/** 控制标记（#826 第三批；stun 既禁移动也禁出手，root 只禁移动，silence 只禁出手） */
export class StatusControlDto {
  @ApiPropertyOptional({ description: "眩晕 / 麻痹：禁止移动与出手（两者在服务端是同一条判据，只是来源与图标不同）" })
  @IsOptional()
  @IsBoolean({ message: "stun 必须是布尔值" })
  stun?: boolean;

  @ApiPropertyOptional({ description: "定身：只禁止移动，仍可出手" })
  @IsOptional()
  @IsBoolean({ message: "root 必须是布尔值" })
  root?: boolean;

  @ApiPropertyOptional({ description: "沉默：只禁止出手，仍可移动" })
  @IsOptional()
  @IsBoolean({ message: "silence 必须是布尔值" })
  silence?: boolean;
}

/** 管理端看到的一条状态配置 */
export class StatusDto {
  @ApiProperty({ description: "状态 id（技能 statusId 与将来的装备 / 特权引用它）" })
  id: string;

  @ApiProperty({ description: `归属：${SKILL_OWNER_VALUES.join(" / ")}`, enum: SKILL_OWNER_VALUES })
  owner: string;

  @ApiProperty({ description: "状态名" })
  label: string;

  @ApiProperty({ description: "状态图标资源路径（resources 相对路径，不含扩展名）" })
  icon: string;

  @ApiProperty({ description: "持续时间（秒；重复获得时从获得时刻重新计时，不叠层）" })
  duration: number;

  @ApiProperty({ description: "来源：skill / equipment / privilege / other", enum: STATUS_SOURCE_VALUES })
  source: string;

  @ApiProperty({ description: "描述文案" })
  description: string;

  @ApiProperty({ description: "身上特效图集路径（空串 = 只在图标栏显示）" })
  effect: string;

  @ApiProperty({ description: "身上特效是否只播一遍并停在尾帧（脉冲类特效配 true）" })
  effectHoldLast: boolean;

  @ApiProperty({ description: "战斗数值修正（缺省 = 纯表现状态）", type: StatusCombatDto })
  combat: StatusCombatDto;

  @ApiProperty({ description: "分类：buff / damage / control / speed（只用于分组，判据看 controlFlags 与 tickMs）" })
  kind: string;

  @ApiProperty({ description: "最大层数（1 = 不叠；同 id 再加一层 → +1 并刷新到期）" })
  maxStacks: number;

  @ApiProperty({ description: "周期触发间隔（毫秒；0 = 无周期）" })
  tickMs: number;

  @ApiProperty({ description: "每拍做什么", type: StatusTickDto })
  tickEffect: StatusTickDto;

  @ApiProperty({ description: "控制标记", type: StatusControlDto })
  controlFlags: StatusControlDto;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: StatusRow): StatusDto {
    const dto = new StatusDto();
    dto.id = row.id;
    dto.owner = row.owner;
    dto.label = row.label;
    dto.icon = row.icon;
    dto.duration = row.duration;
    dto.source = row.source;
    dto.description = row.description;
    dto.effect = row.effect;
    dto.effectHoldLast = row.effect_hold_last === 1;
    dto.combat = parseCombat(row.combat);
    dto.kind = row.kind || "buff";
    dto.maxStacks = Math.max(1, Math.floor(Number(row.max_stacks) || 1));
    dto.tickMs = Math.max(0, Math.floor(Number(row.tick_ms) || 0));
    dto.tickEffect = parseTick(row.tick_effect);
    dto.controlFlags = parseControl(row.control_flags);
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 状态列表查询入参 */
export class StatusQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: `归属筛选：${SKILL_OWNER_VALUES.join(" / ")}（不传 = 两边都要）`, enum: SKILL_OWNER_VALUES })
  @IsOptional()
  @IsIn(SKILL_OWNER_VALUES, { message: `owner 必须是 ${SKILL_OWNER_VALUES.join(" / ")} 之一` })
  declare owner?: string;

  @ApiPropertyOptional({ description: "关键字：模糊匹配 id 与状态名" })
  @IsOptional()
  @IsString({ message: "关键字必须是字符串" })
  declare keyword?: string;
}

/** 状态分页结果 */
export class StatusPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的状态配置", type: [StatusDto] })
  list: StatusDto[];
}

/**
 * 编辑状态入参（**部分更新**）
 *
 * 与技能同一取向：不改行身份、不提供创建 / 删除 —— 状态 id 被技能引用，
 * 删掉一行等于让引用它的人变隐形状态。
 */
export class UpdateStatusDto {
  @ApiPropertyOptional({ description: "状态名（≤50 字）", maxLength: 50 })
  @IsOptional()
  @IsString({ message: "状态名必须是字符串" })
  @MaxLength(50, { message: "状态名不能超过 50 字" })
  label?: string;

  @ApiPropertyOptional({ description: "图标资源路径（≤200 字；空串 = 不显示图标）", maxLength: 200 })
  @IsOptional()
  @IsString({ message: "图标必须是字符串" })
  @MaxLength(200, { message: "图标路径不能超过 200 字" })
  icon?: string;

  @ApiPropertyOptional({ description: "持续时间（秒，>0）", minimum: 0, maximum: 86400 })
  @IsOptional()
  @IsNumber({}, { message: "duration 必须是数字" })
  @Min(0, { message: "duration 不能小于 0" })
  @Max(86400, { message: "duration 不能大于 24 小时" })
  duration?: number;

  @ApiPropertyOptional({ description: "来源：skill / equipment / privilege / other", enum: STATUS_SOURCE_VALUES })
  @IsOptional()
  @IsIn(STATUS_SOURCE_VALUES, { message: `source 必须是 ${STATUS_SOURCE_VALUES.join(" / ")} 之一` })
  source?: string;

  @ApiPropertyOptional({ description: "描述文案（≤500 字）", maxLength: 500 })
  @IsOptional()
  @IsString({ message: "描述必须是字符串" })
  @MaxLength(500, { message: "描述不能超过 500 字" })
  description?: string;

  @ApiPropertyOptional({ description: "身上特效图集路径（≤200 字；空串 = 只在图标栏显示）", maxLength: 200 })
  @IsOptional()
  @IsString({ message: "特效必须是字符串" })
  @MaxLength(200, { message: "特效路径不能超过 200 字" })
  effect?: string;

  @ApiPropertyOptional({ description: "身上特效是否只播一遍停在尾帧" })
  @IsOptional()
  @IsBoolean({ message: "effectHoldLast 必须是布尔值" })
  effectHoldLast?: boolean;

  @ApiPropertyOptional({ description: "战斗数值修正（整份替换：不传则不改）", type: StatusCombatDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => StatusCombatDto)
  combat?: StatusCombatDto;

  @ApiPropertyOptional({ description: "分类：buff / damage / control / speed", enum: STATUS_KIND_VALUES })
  @IsOptional()
  @IsIn(STATUS_KIND_VALUES, { message: `kind 必须是 ${STATUS_KIND_VALUES.join(" / ")} 之一` })
  kind?: string;

  @ApiPropertyOptional({ description: "最大层数（1~99，1 = 不叠）", minimum: 1, maximum: 99 })
  @IsOptional()
  @IsNumber({}, { message: "maxStacks 必须是数字" })
  @Min(1, { message: "maxStacks 不能小于 1（1 = 不叠）" })
  @Max(99, { message: "maxStacks 不能大于 99" })
  maxStacks?: number;

  @ApiPropertyOptional({ description: "周期触发间隔（毫秒；0 = 无周期，最小 100）", minimum: 0, maximum: 600000 })
  @IsOptional()
  @IsNumber({}, { message: "tickMs 必须是数字" })
  @Min(0, { message: "tickMs 不能小于 0" })
  @Max(600000, { message: "tickMs 不能大于 10 分钟" })
  tickMs?: number;

  @ApiPropertyOptional({ description: "每拍做什么（整份替换：不传则不改）", type: StatusTickDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => StatusTickDto)
  tickEffect?: StatusTickDto;

  @ApiPropertyOptional({ description: "控制标记（整份替换：不传则不改）", type: StatusControlDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => StatusControlDto)
  controlFlags?: StatusControlDto;
}

/** 把落库的 JSON 读成对象（脏数据不炸接口：解析失败按空对象兜底） */
export function parseCombat(raw: string): StatusCombatDto {
  const dto = new StatusCombatDto();
  // 解析口径下沉在 common/config-json：服务端怪物 AI 也读这一列（#372）
  const value = parseCombatJson(raw);
  for (const key of COMBAT_KEYS) {
    const entry = value[key];
    if (typeof entry === "number") dto[key] = entry;
  }
  return dto;
}

/** 把 DTO 的修正对象压成落库 JSON（只保留显式给出的键，缺省不写） */
export function serializeCombat(combat: StatusCombatDto | undefined): string {
  const entries: Record<string, number> = {};
  if (combat) {
    for (const key of COMBAT_KEYS) {
      const value = combat[key];
      if (typeof value === "number") entries[key] = value;
    }
  }
  return Object.keys(entries).length ? JSON.stringify(entries) : "{}";
}

/** 把落库的 tick_effect 读成 DTO（坏 JSON 按空对象兜底） */
export function parseTick(raw: string): StatusTickDto {
  const dto = new StatusTickDto();
  const value = parseTickEffectJson(raw);
  for (const key of TICK_EFFECT_KEYS) {
    const entry = value[key];
    if (typeof entry === "number") dto[key] = entry;
  }
  return dto;
}

/** 把 DTO 的周期效果压成落库 JSON（显式 null / undefined 都当「不配」） */
export function serializeTick(tick: StatusTickDto | undefined): string {
  const entries: Record<string, number> = {};
  if (tick) {
    for (const key of TICK_EFFECT_KEYS) {
      const value = tick[key];
      if (typeof value === "number" && Number.isFinite(value)) entries[key] = value;
    }
  }
  return Object.keys(entries).length ? JSON.stringify(entries) : "{}";
}

/** 把落库的 control_flags 读成 DTO */
export function parseControl(raw: string): StatusControlDto {
  const dto = new StatusControlDto();
  const value = parseControlFlagsJson(raw);
  for (const key of CONTROL_FLAG_KEYS) dto[key] = value[key];
  return dto;
}

/** 把 DTO 的控制标记压成落库 JSON（只写 true 的键，读侧补 false） */
export function serializeControl(control: StatusControlDto | undefined): string {
  const entries: Record<string, number> = {};
  if (control) {
    for (const key of CONTROL_FLAG_KEYS) {
      if (control[key] === true) entries[key] = 1;
    }
  }
  return Object.keys(entries).length ? JSON.stringify(entries) : "{}";
}
