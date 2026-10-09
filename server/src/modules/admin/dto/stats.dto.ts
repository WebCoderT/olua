import { ApiProperty } from "@nestjs/swagger";
import { AccountDto } from "../../auth/dto/account.dto";
import { RoleSummaryDto } from "../../roles/dto/role.dto";

/** 账号详情（账号 + 其名下角色概要） */
export class AdminAccountDetailDto {
  @ApiProperty({ description: "账号信息", type: AccountDto })
  account: AccountDto;

  @ApiProperty({ description: "该账号的角色列表", type: RoleSummaryDto, isArray: true })
  roles: RoleSummaryDto[];
}

/** 概览统计 */
export class AdminStatsDto {
  @ApiProperty({ description: "账号总数" })
  accountCount: number;

  @ApiProperty({ description: "角色总数" })
  roleCount: number;

  @ApiProperty({ description: "已选中在线角色的账号数" })
  onlineAccountCount: number;

  @ApiProperty({ description: "今日新增账号数" })
  todayNewAccountCount: number;

  @ApiProperty({ description: "今日新增角色数" })
  todayNewRoleCount: number;

  @ApiProperty({ description: "当前封禁中的账号数（永久封禁与未到期的临时封禁都算）" })
  bannedAccountCount: number;

  @ApiProperty({ description: "管理员数量" })
  adminCount: number;
}

/** 趋势图上的一个点（按天） */
export class StatsTrendPointDto {
  @ApiProperty({ description: "日期（服务器本地时区，YYYY-MM-DD）", example: "2026-10-09" })
  day: string;

  @ApiProperty({ description: "当日新增账号数" })
  newAccounts: number;

  @ApiProperty({ description: "当日新增角色数" })
  newRoles: number;
}

/** 增长趋势 */
export class StatsTrendDto {
  @ApiProperty({ description: "统计天数", example: 7 })
  days: number;

  /**
   * 逐日数据，**已补齐没有数据的日期（值为 0）** ——
   * 否则前端拿到的是稀疏数组，折线会在缺日的地方画成直线，看起来像「那天有人注册」。
   */
  @ApiProperty({ description: "逐日数据（含没有数据的日期，值为 0）", type: StatsTrendPointDto, isArray: true })
  points: StatsTrendPointDto[];

  @ApiProperty({ description: "区间内新增账号合计" })
  totalNewAccounts: number;

  @ApiProperty({ description: "区间内新增角色合计" })
  totalNewRoles: number;
}

/** 分布里的一项 */
export class StatsBreakdownItemDto {
  /**
   * 分组键：等级档是区间起点（`"1"` 代表 1~10 级）；职业 / 性别 / 地图是客户端的 id；
   * 地图为空串表示快照里没有该字段（老数据）。
   *
   * 这里**只给键与数量，不给展示名** —— 职业 / 性别 / 地图的字典权威在客户端 `configs`，
   * 服务端复制一份就会两边漂移（见 README「服务端不认识客户端配置」）。
   */
  @ApiProperty({ description: "分组键（等级档起点 / 职业 id / 性别 id / 地图 id；空串表示未知）", example: "1" })
  key: string;

  @ApiProperty({ description: "数量" })
  count: number;
}

/**
 * 分布统计
 *
 * 与 `AdminStatsDto` 一样只做「数数」——展示名由管理端按客户端字典补。
 */
export class StatsBreakdownDto {
  @ApiProperty({ description: "等级分布（10 级一档，key 为区间起点）", type: StatsBreakdownItemDto, isArray: true })
  levels: StatsBreakdownItemDto[];

  @ApiProperty({ description: "职业分布（key 为职业 id）", type: StatsBreakdownItemDto, isArray: true })
  occupations: StatsBreakdownItemDto[];

  @ApiProperty({ description: "性别分布（key 为性别 id）", type: StatsBreakdownItemDto, isArray: true })
  sexes: StatsBreakdownItemDto[];

  @ApiProperty({ description: "所在地图分布（key 为角色快照里的 onMap）", type: StatsBreakdownItemDto, isArray: true })
  maps: StatsBreakdownItemDto[];
}

/** 最近动态的一项（复用操作日志表，只取展示需要的字段） */
export class StatsRecentItemDto {
  @ApiProperty({ description: "操作时间（毫秒）", example: 1760000000000 })
  createdAt: number;

  @ApiProperty({ description: "操作人账号名（系统事件为 null）", type: "string", nullable: true })
  actorName: string | null;

  @ApiProperty({ description: "动作（即接口的 operationId）", example: "adminAccount.updateStatus" })
  action: string;

  @ApiProperty({ description: "目标类型：account | role | admin", type: "string", nullable: true })
  targetType: string | null;

  @ApiProperty({ description: "目标 id", type: "string", nullable: true })
  targetId: string | null;

  @ApiProperty({ description: "是否成功" })
  success: boolean;
}
