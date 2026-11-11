import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, Min, ValidateNested } from "class-validator";
import { Type } from "class-transformer";

/**
 * 客户端运行时参数（#605）：掉落手感 / 自动战斗 / 帮会规则
 *
 * 三个分组各自可**部分更新**（管理端一次只提交改动过的字段），共用一份出厂值
 * （`config-sync.sql`）——缺键回落出厂，所以加参数不用给存量库补列。
 *
 * 第四组**怪物 AI 参数**（#853 / #854）也在这个文件里，但走**另外两条接口**：
 * 它是纯服务端手感，不下发客户端，见 `MonsterAiParamsDto` 上的说明。
 *
 * 取值域写在 DTO 上（单字段），跨字段约束（`nameMin ≤ nameMax`）在 service 里判，
 * 与成长曲线「DTO 管单字段、service 管跨行」同一分工。
 */

/** 掉落参数（手感那四个数归客户端；`bindChance` 是**服务端掉落结算**读的） */
export class DropRuntimeParamsDto {
  @ApiProperty({ description: "自动拾取半径（像素）：脚底距离小于它即拾取", example: 40 })
  @IsInt()
  @Min(0)
  @Max(500)
  autoPickupRadius: number;

  @ApiProperty({
    description:
      "服务端拾取距离闸（像素，#817）：玩家离掉落物落地位置超过它就拒收拾取请求。" +
      "与 autoPickupRadius 是两把尺子（那是客户端手感，这是服务端权威）；0 = 关闭校验，别当出货值",
    example: 200,
  })
  @IsInt()
  @Min(0)
  @Max(2000)
  pickAcceptRadius: number;

  @ApiProperty({ description: "背包已满的提示 / 重试间隔（毫秒）", example: 1500 })
  @IsInt()
  @Min(0)
  @Max(60000)
  fullTipInterval: number;

  @ApiProperty({ description: "多件掉落物的最小中心间距（像素）", example: 52 })
  @IsInt()
  @Min(0)
  @Max(500)
  scatterMinDistance: number;

  @ApiProperty({ description: "服务端拾取应答等待上限（毫秒），超时允许重试", example: 5000 })
  @IsInt()
  @Min(100)
  @Max(60000)
  pickReplyTimeout: number;

  @ApiProperty({
    description:
      "随机绑定概率（百分比 0~100）：物品与怪物都没有「强制绑定」时，按它掷一次决定这一件是否绑定角色。" +
      "0 = 从不随机绑定",
    example: 30,
  })
  @IsInt()
  @Min(0)
  @Max(100)
  bindChance: number;
}

/** 自动战斗 / 寻路参数（`configs/autoBattle.ts` 的行为部分，样式与颜色不在其中） */
export class AutoBattleParamsDto {
  @ApiProperty({ description: "自动选目标的最大距离（像素，0 = 不限，全图取最近）", example: 0 })
  @IsInt()
  @Min(0)
  @Max(5000)
  maxTargetDistance: number;

  @ApiProperty({ description: "自动移动是否使用跑步速度", example: true })
  @IsBoolean()
  moveByRun: boolean;

  @ApiProperty({ description: "A* 网格单元边长（像素）：越小越贴合障碍、搜索越慢", example: 40 })
  @IsInt()
  @Min(8)
  @Max(200)
  cellSize: number;

  @ApiProperty({ description: "通行余量（像素）：障碍矩形向外扩张这么多再烙进网格", example: 20 })
  @IsInt()
  @Min(0)
  @Max(200)
  clearance: number;

  @ApiProperty({ description: "重新寻路间隔（毫秒）", example: 400 })
  @IsInt()
  @Min(50)
  @Max(10000)
  repathInterval: number;

  @ApiProperty({ description: "到达路点的判定半径（像素）", example: 14 })
  @IsInt()
  @Min(0)
  @Max(200)
  waypointTolerance: number;

  @ApiProperty({ description: "卡住检测间隔（毫秒）", example: 500 })
  @IsInt()
  @Min(100)
  @Max(10000)
  stuckInterval: number;

  @ApiProperty({ description: "卡住判定：该间隔内位移小于此值视为卡住（像素）", example: 8 })
  @IsInt()
  @Min(0)
  @Max(200)
  stuckDistance: number;

  @ApiProperty({ description: "连续卡住多少次后放弃当前目标", example: 3 })
  @IsInt()
  @Min(1)
  @Max(20)
  stuckRetryLimit: number;

  @ApiProperty({ description: "被放弃目标的拉黑时长（毫秒）", example: 5000 })
  @IsInt()
  @Min(0)
  @Max(600000)
  targetBanDuration: number;

  @ApiProperty({ description: "场上没目标时，隔多久再找一次（毫秒）", example: 500 })
  @IsInt()
  @Min(50)
  @Max(10000)
  targetSearchInterval: number;

  @ApiProperty({ description: "点击寻路的到达判定半径（像素）", example: 20 })
  @IsInt()
  @Min(0)
  @Max(200)
  arriveTolerance: number;

  @ApiProperty({ description: "传送落点吸附半径（格）", example: 12 })
  @IsInt()
  @Min(0)
  @Max(64)
  teleportSnapRadius: number;

  @ApiProperty({ description: "突进类技能的落点吸附半径（像素）", example: 60 })
  @IsInt()
  @Min(0)
  @Max(500)
  dashSnapRadius: number;
}

/**
 * 帮会规则门槛（**服务端校验读它**）
 *
 * 客户端也收到这一份，用途只是「提前提示」：真正能不能建帮 / 公告能不能发由服务端判，
 * 客户端改配置只能让提示更松或更严，改不了结果。
 */
export class GuildRuleParamsDto {
  @ApiProperty({ description: "帮会名最短字数", example: 2 })
  @IsInt()
  @Min(1)
  @Max(20)
  nameMin: number;

  @ApiProperty({ description: "帮会名最长字数（必须 ≥ 最短字数）", example: 12 })
  @IsInt()
  @Min(1)
  @Max(30)
  nameMax: number;

  @ApiProperty({ description: "帮会公告最长字数（0 = 不限）", example: 200 })
  @IsInt()
  @Min(0)
  @Max(2000)
  noticeMax: number;

  @ApiProperty({ description: "入帮申请留言最长字数（0 = 不限）", example: 50 })
  @IsInt()
  @Min(0)
  @Max(500)
  applicationMessageMax: number;

  @ApiProperty({ description: "建帮所需最低角色等级（0 = 不限等级）", example: 10 })
  @IsInt()
  @Min(0)
  @Max(1000)
  createLevelMin: number;

  @ApiProperty({ description: "建帮消耗绑定元宝（0 = 免费）", example: 100000 })
  @IsInt()
  @Min(0)
  @Max(100000000)
  createCostBindGold: number;
}

/** 三个分组合体（快照 `runtimeParams` 段与 GET 响应的形状） */
export class RuntimeParamsDto {
  @ApiProperty({ description: "掉落物手感参数（服务端只下发，不消费）", type: DropRuntimeParamsDto })
  @ValidateNested()
  @Type(() => DropRuntimeParamsDto)
  drop: DropRuntimeParamsDto;

  @ApiProperty({ description: "自动战斗 / 寻路参数（服务端只下发，不消费）", type: AutoBattleParamsDto })
  @ValidateNested()
  @Type(() => AutoBattleParamsDto)
  autoBattle: AutoBattleParamsDto;

  @ApiProperty({ description: "帮会规则门槛（服务端校验读它）", type: GuildRuleParamsDto })
  @ValidateNested()
  @Type(() => GuildRuleParamsDto)
  guild: GuildRuleParamsDto;

  @ApiProperty({ description: "最后修改时间（毫秒）", example: 1762000000000 })
  updatedAt: number;
}

/** 部分更新：只提交改动过的分组，组内也只提交改动过的字段 */
export class UpdateDropRuntimeParamsDto {
  @ApiPropertyOptional({ description: "自动拾取半径（像素）" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(500)
  autoPickupRadius?: number;

  @ApiPropertyOptional({ description: "服务端拾取距离闸（像素；0 = 关闭校验）" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2000)
  pickAcceptRadius?: number;

  @ApiPropertyOptional({ description: "背包已满的提示 / 重试间隔（毫秒）" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60000)
  fullTipInterval?: number;

  @ApiPropertyOptional({ description: "多件掉落物的最小中心间距（像素）" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(500)
  scatterMinDistance?: number;

  @ApiPropertyOptional({ description: "服务端拾取应答等待上限（毫秒）" })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(60000)
  pickReplyTimeout?: number;

  @ApiPropertyOptional({ description: "随机绑定概率（百分比 0~100；0 = 从不随机绑定）" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  bindChance?: number;
}

/** 部分更新：自动战斗分组 */
export class UpdateAutoBattleParamsDto {
  @ApiPropertyOptional({ description: "自动选目标的最大距离（像素，0 = 不限）" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5000)
  maxTargetDistance?: number;

  @ApiPropertyOptional({ description: "自动移动是否使用跑步速度" })
  @IsOptional()
  @IsBoolean()
  moveByRun?: boolean;

  @ApiPropertyOptional({ description: "A* 网格单元边长（像素）" })
  @IsOptional()
  @IsInt()
  @Min(8)
  @Max(200)
  cellSize?: number;

  @ApiPropertyOptional({ description: "通行余量（像素）" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(200)
  clearance?: number;

  @ApiPropertyOptional({ description: "重新寻路间隔（毫秒）" })
  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(10000)
  repathInterval?: number;

  @ApiPropertyOptional({ description: "到达路点的判定半径（像素）" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(200)
  waypointTolerance?: number;

  @ApiPropertyOptional({ description: "卡住检测间隔（毫秒）" })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(10000)
  stuckInterval?: number;

  @ApiPropertyOptional({ description: "卡住判定位移阈值（像素）" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(200)
  stuckDistance?: number;

  @ApiPropertyOptional({ description: "连续卡住多少次后放弃当前目标" })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  stuckRetryLimit?: number;

  @ApiPropertyOptional({ description: "被放弃目标的拉黑时长（毫秒）" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(600000)
  targetBanDuration?: number;

  @ApiPropertyOptional({ description: "没目标时的重找间隔（毫秒）" })
  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(10000)
  targetSearchInterval?: number;

  @ApiPropertyOptional({ description: "点击寻路的到达判定半径（像素）" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(200)
  arriveTolerance?: number;

  @ApiPropertyOptional({ description: "传送落点吸附半径（格）" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(64)
  teleportSnapRadius?: number;

  @ApiPropertyOptional({ description: "突进类技能的落点吸附半径（像素）" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(500)
  dashSnapRadius?: number;
}

/** 部分更新：帮会规则分组 */
export class UpdateGuildRuleParamsDto {
  @ApiPropertyOptional({ description: "帮会名最短字数" })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  nameMin?: number;

  @ApiPropertyOptional({ description: "帮会名最长字数（必须 ≥ 最短字数）" })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  nameMax?: number;

  @ApiPropertyOptional({ description: "帮会公告最长字数（0 = 不限）" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2000)
  noticeMax?: number;

  @ApiPropertyOptional({ description: "入帮申请留言最长字数（0 = 不限）" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(500)
  applicationMessageMax?: number;

  @ApiPropertyOptional({ description: "建帮所需最低角色等级（0 = 不限等级）" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  createLevelMin?: number;

  @ApiPropertyOptional({ description: "建帮消耗绑定元宝（0 = 免费）" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000000)
  createCostBindGold?: number;
}

/**
 * 怪物 AI 参数（`runtime_params.monster_ai` 列，**服务端消费，不下发客户端**）
 *
 * 单独一组、单独两条接口，而不是并进 `RuntimeParamsDto`：那个 DTO 就是客户端快照
 * `runtimeParams` 段的形状，往里加东西等于「快照多一段」（DTO / snapshot / 客户端
 * `game-config` / `configs-sandbox` 四处一起改）。AI 手感客户端一个字节都用不上。
 */
export class MonsterAiParamsDto {
  @ApiProperty({ description: "普攻间隔（毫秒）", example: 2000 })
  @IsInt()
  @Min(100)
  @Max(60000)
  attackInterval: number;

  @ApiProperty({ description: "普攻距离（像素）", example: 60 })
  @IsInt()
  @Min(1)
  @Max(2000)
  attackRange: number;

  @ApiProperty({ description: "施法硬直兜底（毫秒）：技能没配 cast_lock_ms 时用它", example: 400 })
  @IsInt()
  @Min(0)
  @Max(5000)
  attackActionTime: number;

  @ApiProperty({ description: "击退时长（毫秒）：技能只配距离时用它换算击退速度", example: 200 })
  @IsInt()
  @Min(50)
  @Max(5000)
  pushDuration: number;

  @ApiProperty({ description: "待机游走间隔区间（毫秒，[最小, 最大]）", example: [4000, 9000], isArray: true, type: Number })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsInt({ each: true })
  idleMoveInterval: [number, number];

  @ApiProperty({ description: "待机游走每次走多久（毫秒，[最小, 最大]）", example: [300, 800], isArray: true, type: Number })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsInt({ each: true })
  idleMoveDuration: [number, number];

  @ApiProperty({ description: "游走速度倍率（乘在怪物 moveSpeed 上）", example: 0.5 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.1)
  @Max(5)
  idleMoveSpeedScale: number;

  @ApiProperty({ description: "游走活动半径（像素，围绕出生点）", example: 60 })
  @IsInt()
  @Min(1)
  @Max(2000)
  wanderRadius: number;

  @ApiProperty({
    description: "牵引半径（像素）：目标跑出这个距离就脱战回家。必须大于普攻距离，否则怪永远追不上就脱战",
    example: 600,
  })
  @IsInt()
  @Min(100)
  @Max(5000)
  leashRange: number;

  @ApiProperty({ description: "回家速度倍率（乘在 moveSpeed 上；比追击快，免得被拖着遛）", example: 1.5 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.1)
  @Max(5)
  returnSpeedRate: number;

  @ApiProperty({ description: "回家超时（毫秒）：到点还没走回去就吸附到出生点", example: 20000 })
  @IsInt()
  @Min(1000)
  @Max(300000)
  returnTimeoutMs: number;
}

/** 怪物 AI 参数的部分更新（只提交改动过的字段） */
export class UpdateMonsterAiParamsDto {
  @ApiPropertyOptional({ description: "普攻间隔（毫秒）" })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(60000)
  attackInterval?: number;

  @ApiPropertyOptional({ description: "普攻距离（像素）" })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2000)
  attackRange?: number;

  @ApiPropertyOptional({ description: "施法硬直兜底（毫秒）" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5000)
  attackActionTime?: number;

  @ApiPropertyOptional({ description: "击退时长（毫秒）" })
  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(5000)
  pushDuration?: number;

  @ApiPropertyOptional({ description: "待机游走间隔区间（毫秒，[最小, 最大]）", isArray: true, type: Number })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsInt({ each: true })
  idleMoveInterval?: [number, number];

  @ApiPropertyOptional({ description: "待机游走每次走多久（毫秒，[最小, 最大]）", isArray: true, type: Number })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsInt({ each: true })
  idleMoveDuration?: [number, number];

  @ApiPropertyOptional({ description: "游走速度倍率" })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.1)
  @Max(5)
  idleMoveSpeedScale?: number;

  @ApiPropertyOptional({ description: "游走活动半径（像素）" })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2000)
  wanderRadius?: number;

  @ApiPropertyOptional({ description: "牵引半径（像素，必须大于普攻距离）" })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(5000)
  leashRange?: number;

  @ApiPropertyOptional({ description: "回家速度倍率" })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.1)
  @Max(5)
  returnSpeedRate?: number;

  @ApiPropertyOptional({ description: "回家超时（毫秒）" })
  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(300000)
  returnTimeoutMs?: number;
}

/** 运行时参数的部分更新请求（组可选、组内字段可选） */
export class UpdateRuntimeParamsDto {
  @ApiPropertyOptional({ description: "掉落物手感参数（只提交改动过的字段）", type: UpdateDropRuntimeParamsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateDropRuntimeParamsDto)
  drop?: UpdateDropRuntimeParamsDto;

  @ApiPropertyOptional({ description: "自动战斗 / 寻路参数（只提交改动过的字段）", type: UpdateAutoBattleParamsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateAutoBattleParamsDto)
  autoBattle?: UpdateAutoBattleParamsDto;

  @ApiPropertyOptional({ description: "帮会规则门槛（只提交改动过的字段）", type: UpdateGuildRuleParamsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateGuildRuleParamsDto)
  guild?: UpdateGuildRuleParamsDto;

  @ApiPropertyOptional({ description: "修改备注（写进审计日志的上下文，便于追溯「为什么改」）" })
  @IsOptional()
  @IsString()
  note?: string;
}
