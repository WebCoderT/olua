import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsNumber, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { PageMetaDto, PageQueryDto } from "../../../common/dto/api-envelope.dto";
import { NpcRow } from "../../../database/rows";

/**
 * 管理端看到的一条 NPC 数据（#258 / #603 第七域）
 *
 * #603 起**客户端不再存 NPC 的任何显示数据**：名称、素材目录、缩放、偏移都在这一张表里，
 * 进游戏由 `GET /game-config` 的 `npcs` 段下发，客户端据此建节点。走快照而不是走管理端接口 ——
 * 玩家侧不该需要 `gameConfig:read` 权限。
 */
export class NpcDto {
  @ApiProperty({ description: "NPC id（Tiled 对象组的关联键，如 \"0002\"）" })
  id: string;

  @ApiProperty({ description: "名称（后台可改）" })
  label: string;

  @ApiProperty({ description: "对话文案（客户端暂无对话数据形态，seed 为空串；消费等 #248/#249）" })
  dialog: string;

  @ApiProperty({ description: "素材目录（resources 相对路径，图集动画；列表缩略图取首帧）" })
  src: string;

  @ApiProperty({ description: "精灵横向缩放（1 = 原尺寸）" })
  scaleX: number;

  @ApiProperty({ description: "精灵纵向缩放（1 = 原尺寸）" })
  scaleY: number;

  @ApiProperty({ description: "精灵横向偏移（像素，0 = 不偏移）" })
  posX: number;

  @ApiProperty({ description: "精灵纵向偏移（像素，0 = 不偏移）" })
  posY: number;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: NpcRow): NpcDto {
    const dto = new NpcDto();
    dto.id = row.id;
    dto.label = row.label;
    dto.dialog = row.dialog;
    dto.src = row.src;
    dto.scaleX = row.scale_x;
    dto.scaleY = row.scale_y;
    dto.posX = row.pos_x;
    dto.posY = row.pos_y;
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** NPC 列表查询入参 */
export class NpcQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "关键字：模糊匹配 id 与名称" })
  @IsOptional()
  @IsString({ message: "关键字必须是字符串" })
  declare keyword?: string;
}

/** NPC 分页结果 */
export class NpcPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的 NPC 数据", type: [NpcDto] })
  list: NpcDto[];
}

/** 缩放取值范围：0.1~10 倍（0 会让节点整个消失，负数是镜像 —— 都不给） */
const MIN_SCALE = 0.1;
const MAX_SCALE = 10;
/** 偏移取值范围（像素）：±4000 足够把精灵推到节点任一侧，再大必然是手滑 */
const MAX_OFFSET = 4000;

/**
 * 编辑 NPC 数据入参（**部分更新**）
 *
 * **没有 Create / Delete**：NPC id 被 Tiled 地图对象组引用，清单固定 ——
 * 这是有意不提供的能力，不是漏了（e2e 会固化「POST/DELETE 路由不存在」）。
 *
 * #603 第七域起外观（src / scale / position）也归这里：运营改完下次进游戏生效
 * （快照整表重建客户端 `npcs`）。要「还原成原尺寸」就传 1 / 0，不需要删列。
 */
export class UpdateNpcDto {
  @ApiPropertyOptional({ description: "名称（不传则不改）", maxLength: 50 })
  @IsOptional()
  @IsString({ message: "名称必须是字符串" })
  @MaxLength(50, { message: "名称不能超过 50 字" })
  label?: string;

  @ApiPropertyOptional({ description: "对话文案（不传则不改；空串 = 清空）", maxLength: 2000 })
  @IsOptional()
  @IsString({ message: "对话文案必须是字符串" })
  @MaxLength(2000, { message: "对话文案不能超过 2000 字" })
  dialog?: string;

  @ApiPropertyOptional({ description: "素材目录（resources 相对路径；不传则不改；空串 = 该 NPC 不显示）" })
  @IsOptional()
  @IsString({ message: "素材目录必须是字符串" })
  @MaxLength(200, { message: "素材目录不能超过 200 字" })
  src?: string;

  @ApiPropertyOptional({ description: `横向缩放（${MIN_SCALE}~${MAX_SCALE}，不传则不改；1 = 原尺寸）` })
  @IsOptional()
  @IsNumber({}, { message: "横向缩放必须是数字" })
  @Min(MIN_SCALE, { message: `横向缩放不能小于 ${MIN_SCALE}` })
  @Max(MAX_SCALE, { message: `横向缩放不能大于 ${MAX_SCALE}` })
  scaleX?: number;

  @ApiPropertyOptional({ description: `纵向缩放（${MIN_SCALE}~${MAX_SCALE}，不传则不改；1 = 原尺寸）` })
  @IsOptional()
  @IsNumber({}, { message: "纵向缩放必须是数字" })
  @Min(MIN_SCALE, { message: `纵向缩放不能小于 ${MIN_SCALE}` })
  @Max(MAX_SCALE, { message: `纵向缩放不能大于 ${MAX_SCALE}` })
  scaleY?: number;

  @ApiPropertyOptional({ description: `横向偏移（像素，±${MAX_OFFSET}，不传则不改；0 = 不偏移）` })
  @IsOptional()
  @IsNumber({}, { message: "横向偏移必须是数字" })
  @Min(-MAX_OFFSET, { message: `横向偏移不能小于 -${MAX_OFFSET}` })
  @Max(MAX_OFFSET, { message: `横向偏移不能大于 ${MAX_OFFSET}` })
  posX?: number;

  @ApiPropertyOptional({ description: `纵向偏移（像素，±${MAX_OFFSET}，不传则不改；0 = 不偏移）` })
  @IsOptional()
  @IsNumber({}, { message: "纵向偏移必须是数字" })
  @Min(-MAX_OFFSET, { message: `纵向偏移不能小于 -${MAX_OFFSET}` })
  @Max(MAX_OFFSET, { message: `纵向偏移不能大于 ${MAX_OFFSET}` })
  posY?: number;
}
