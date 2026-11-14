import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsBoolean, IsInt, IsOptional, IsString, Length, MaxLength, Min } from "class-validator";
import { ZoneRow } from "../../../database/rows";

/** 区服视图（玩家注册下拉框用：id / 名字 / 状态，不发运营细节） */
export class ZoneDto {
  @ApiProperty({ description: "区服 id", example: 1 })
  id: number;

  @ApiProperty({ description: "区服名", example: "一区" })
  name: string;

  /**
   * 运营状态（#961）
   *
   * 玩家侧也要发：注册下拉得把「维护中」的区置灰并排到后面，否则新玩家点了才被拒。
   * 只发状态字，不发 `note` / `opened_at` 这些运营字段。
   */
  @ApiProperty({ description: "运营状态：open / maintenance / closed", example: "open", enum: ["open", "maintenance", "closed"] })
  status: string;

  static from(row: ZoneRow): ZoneDto {
    const dto = new ZoneDto();
    dto.id = row.id;
    dto.name = row.name;
    dto.status = row.status;
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
    description: "运营状态：`open`（正常） / `maintenance`（维护中） / `closed`（停止注册，仍可进去查历史）",
    example: "open",
    enum: ["open", "maintenance", "closed"],
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

/** 区状态（#961：进图闸门 / 维护巡检用） */
export class ZoneStatusDto {
  @ApiProperty({ description: "区服 id", example: 1 })
  id: number;

  @ApiProperty({ description: "区服名", example: "一区" })
  name: string;

  @ApiProperty({ description: "运营状态：open / maintenance / closed", example: "open" })
  status: string;

  @ApiProperty({ description: "已并入的区服 id（未合并为 null）", type: "number", nullable: true, example: null })
  mergedInto: number | null;
}

/** 区服列表的聚合列（#961：一屏看清这个区现在什么规模） */
export interface ZoneStats {
  accountCount: number;
  roleCount: number;
  onlineCount: number;
  monsterCount: number;
  guildCount: number;
  pendingReloads: number;
}

/** 区服视图（管理端：运营字段 + 聚合列） */
export class AdminZoneDto {
  @ApiProperty({ description: "区服 id", example: 1 })
  id: number;

  @ApiProperty({ description: "区服名", example: "一区" })
  name: string;

  @ApiProperty({ description: "已并入的区服 id（未合并为 null）", type: "number", nullable: true, example: null })
  mergedInto: number | null;

  @ApiProperty({ description: "运营状态：open / maintenance / closed", example: "open", enum: ["open", "maintenance", "closed"] })
  status: string;

  @ApiProperty({ description: "下拉排序（升序，同值按 id）", example: 0 })
  sort: number;

  @ApiProperty({ description: "开服时间（毫秒）", example: 1760000000000 })
  openedAt: number;

  @ApiProperty({ description: "是否推荐区（选服弹窗里标「推荐」）", example: false })
  recommended: boolean;

  @ApiProperty({ description: "运营备注（仅后台可见）", type: "string", nullable: true, example: null })
  note: string | null;

  @ApiProperty({ description: "本区账号数（在本区有角色的去重账号）", example: 42 })
  accountCount: number;

  @ApiProperty({ description: "本区角色数", example: 57 })
  roleCount: number;

  @ApiProperty({ description: "本区在线账号数", example: 3 })
  onlineCount: number;

  @ApiProperty({ description: "本区世界实例数（所有图的怪物行）", example: 240 })
  monsterCount: number;

  @ApiProperty({ description: "本区帮会数", example: 4 })
  guildCount: number;

  @ApiProperty({ description: "本区待执行的单图重载请求数", example: 0 })
  pendingReloads: number;

  @ApiProperty({ description: "建行时间（毫秒；一区是 0）", example: 1760000000000 })
  createdAt: number;

  @ApiProperty({ description: "最近更新时间（毫秒）", example: 1760000000000 })
  updatedAt: number;

  static from(row: ZoneRow, stats: ZoneStats): AdminZoneDto {
    const dto = new AdminZoneDto();
    dto.id = row.id;
    dto.name = row.name;
    dto.mergedInto = row.merged_into;
    dto.status = row.status;
    dto.sort = row.sort;
    dto.openedAt = row.opened_at;
    dto.recommended = row.recommended === 1;
    dto.note = row.note;
    dto.accountCount = stats.accountCount;
    dto.roleCount = stats.roleCount;
    dto.onlineCount = stats.onlineCount;
    dto.monsterCount = stats.monsterCount;
    dto.guildCount = stats.guildCount;
    dto.pendingReloads = stats.pendingReloads;
    dto.createdAt = row.created_at;
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 开新区入参（#961：区名 + 开服时间 + 排序 + 推荐 + 备注） */
export class CreateZoneDto {
  @ApiProperty({ description: "区服名（1~20 字，唯一）", example: "二区" })
  @IsString({ message: "区服名必须是字符串" })
  @Length(1, 20, { message: "区服名需为 1~20 字" })
  name: string;

  @ApiPropertyOptional({ description: "开服时间（毫秒；不传 = 现在）", example: 1760000000000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "openedAt 必须是整数（毫秒时间戳）" })
  @Min(0, { message: "openedAt 不能是负数" })
  openedAt?: number;

  @ApiPropertyOptional({ description: "下拉排序（升序；越小越前）", example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "sort 必须是整数" })
  sort?: number;

  @ApiPropertyOptional({ description: "是否推荐区", example: false })
  @IsOptional()
  @IsBoolean({ message: "recommended 必须是布尔值" })
  recommended?: boolean;

  @ApiPropertyOptional({ description: "运营备注（仅后台可见，≤200 字）", example: "首发区" })
  @IsOptional()
  @IsString({ message: "note 必须是字符串" })
  @MaxLength(200, { message: "备注最多 200 字" })
  note?: string;
}

/** 改区服运营字段（#961；名字不在其中 —— 改名会让公告与客服话术全部对不上） */
export class UpdateZoneDto {
  @ApiPropertyOptional({ description: "下拉排序（升序；越小越前）", example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "sort 必须是整数" })
  sort?: number;

  @ApiPropertyOptional({ description: "是否推荐区", example: true })
  @IsOptional()
  @IsBoolean({ message: "recommended 必须是布尔值" })
  recommended?: boolean;

  @ApiPropertyOptional({ description: "运营备注（仅后台可见，≤200 字；空串 = 清空）", example: "首发区" })
  @IsOptional()
  @IsString({ message: "note 必须是字符串" })
  @MaxLength(200, { message: "备注最多 200 字" })
  note?: string;

  @ApiPropertyOptional({ description: "开服时间（毫秒）", example: 1760000000000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "openedAt 必须是整数（毫秒时间戳）" })
  @Min(0, { message: "openedAt 不能是负数" })
  openedAt?: number;
}

/** 改状态入参（#961 状态机：open ⇄ maintenance → closed，关闭不可逆） */
export class SetZoneStatusDto {
  @ApiProperty({ description: "目标状态", example: "maintenance", enum: ["open", "maintenance", "closed"] })
  @IsString({ message: "status 必须是字符串" })
  status: string;

  @ApiPropertyOptional({ description: "变更原因（写进操作日志，≤200 字）", example: "版本更新" })
  @IsOptional()
  @IsString({ message: "reason 必须是字符串" })
  @MaxLength(200, { message: "原因最多 200 字" })
  reason?: string;
}

/** 合区预检结果（#961：`ok = false` 时前端不让点「确认合并」） */
export class MergePrecheckDto {
  @ApiProperty({ description: "源区 id", example: 2 })
  fromZoneId: number;

  @ApiProperty({ description: "目标区 id", example: 1 })
  toZoneId: number;

  @ApiProperty({ description: "源区名", example: "二区" })
  fromName: string;

  @ApiProperty({ description: "目标区名", example: "一区" })
  toName: string;

  @ApiProperty({ description: "源区状态", example: "open" })
  fromStatus: string;

  @ApiProperty({ description: "目标区状态", example: "open" })
  toStatus: string;

  @ApiProperty({ description: "源区当前在线账号数（合并会断开他们）", example: 2 })
  onlineCount: number;

  @ApiProperty({ description: "源区待执行重载请求数（合并会作废）", example: 1 })
  pendingReloads: number;

  @ApiProperty({ description: "源区账号数（会搬走）", example: 12 })
  accountCount: number;

  @ApiProperty({ description: "源区角色数（会搬走）", example: 18 })
  roleCount: number;

  @ApiProperty({ description: "源区帮会数（会搬走）", example: 2 })
  guildCount: number;

  @ApiProperty({ description: "源区世界实例数（会重排发牌）", example: 96 })
  monsterCount: number;

  @ApiProperty({
    description: "撞名的帮会清单（**恒为空**：帮会名全服唯一，#958）",
    type: "array",
    items: { type: "string" },
    example: [],
  })
  guildConflicts: string[];

  @ApiProperty({ description: "不能合并的原因（空数组 = 可以合）", type: "array", items: { type: "string" }, example: [] })
  blockers: string[];

  @ApiProperty({ description: "预检是否通过", example: true })
  ok: boolean;
}

/** 被系统改名的角色（合并时同账号在两个区同名，后缀 = 源区名） */
export class RenamedRoleDto {
  @ApiProperty({ description: "角色 id", example: "1794643918370" })
  id: string;

  @ApiProperty({ description: "改名前的名字", example: "双面人" })
  name: string;

  @ApiProperty({ description: "改名后的名字", example: "双面人·二区" })
  renamed: string;
}

/** 合并报告（#961：运营事后对账的唯一凭据，逐项写清「动了多少」） */
export class MergeReportDto {
  @ApiProperty({ description: "源区 id", example: 2 })
  fromZoneId: number;

  @ApiProperty({ description: "目标区 id", example: 1 })
  toZoneId: number;

  @ApiProperty({ description: "源区名", example: "二区" })
  fromName: string;

  @ApiProperty({ description: "目标区名", example: "一区" })
  toName: string;

  @ApiProperty({ description: "搬走的账号数", example: 12 })
  accountCount: number;

  @ApiProperty({ description: "搬走的角色数", example: 18 })
  roleCount: number;

  @ApiProperty({ description: "重排发牌的世界实例数", example: 96 })
  monsterCount: number;

  @ApiProperty({ description: "搬走的帮会数", example: 2 })
  guildCount: number;

  @ApiProperty({
    description: "被系统改名的角色（同账号在两个区同名）",
    type: () => [RenamedRoleDto],
  })
  renamedRoles: RenamedRoleDto[];

  @ApiProperty({ description: "作废的待执行重载请求数", example: 1 })
  failedReloads: number;

  @ApiProperty({ description: "清掉的监控快照行数", example: 3 })
  removedMonitorStates: number;

  @ApiProperty({ description: "清掉的监控事件行数", example: 40 })
  removedMonitorEvents: number;

  @ApiProperty({ description: "清掉的角色位置行数", example: 5 })
  removedPositions: number;

  @ApiProperty({ description: "合并时在源区在线的账号数（会被断开）", example: 2 })
  onlineDisconnected: number;

  @ApiProperty({ description: "合并完成时刻（毫秒）", example: 1760000000000 })
  mergedAt: number;
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

/** 我的区服（选服弹窗：#957）：区 + 我在这区的角色数 + 是不是当前浏览区（状态在 ZoneDto 上） */
export class MyZoneDto extends ZoneDto {
  @ApiProperty({ description: "我在这个区有几个角色", example: 2 })
  roleCount: number;

  @ApiProperty({ description: "是不是当前浏览区（选角页拉的就是它）", example: true })
  current: boolean;

  /**
   * 由行 + 账号视角组装
   *
   * 不叫 `from`：继承来的静态 `from` 签名是 `(row) => ZoneDto`，同名不同参会让整个
   * 静态侧类型不兼容（TS2417）—— 换个名字比硬塞重载清楚。
   */
  static of(row: ZoneRow, roleCount: number, current: boolean): MyZoneDto {
    const dto = new MyZoneDto();
    dto.id = row.id;
    dto.name = row.name;
    dto.status = row.status;
    dto.roleCount = roleCount;
    dto.current = current;
    return dto;
  }
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
