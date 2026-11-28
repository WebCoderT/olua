import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min, ValidateNested } from "class-validator";
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
 *
 * ## #1172：每个装饰器都带中文 message
 *
 * 裸 `@Min/@Max` 会落回 class-validator 的英文默认模板（`ttlMs must not be less than
 * 10000`），管理端保存时直接把英文吐给运营。这里的 message 样式沿用 `map.dto.ts`
 * 的「时限至少 1 秒」：**带单位带边界**，不依赖字段名反推语义。写漏的装饰器由
 * `httpValidationPipe` 的兜底翻译接住（路径前缀 + 通用中文），但兜底只知道「不能小于
 * 10000」，不知道这是掉落存活时长 —— 管理端要长期看的页面按这里的写法来。
 */

/** 掉落参数（手感那四个数归客户端；`bindChance` 是**服务端掉落结算**读的） */
export class DropRuntimeParamsDto {
  @ApiProperty({ description: "自动拾取半径（像素）：脚底距离小于它即拾取", example: 40 })
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "自动拾取半径不能为负" })
  @Max(500, { message: "自动拾取半径不能超过 500 像素" })
  autoPickupRadius: number;

  @ApiProperty({
    description:
      "服务端拾取距离闸（像素，#817）：玩家离掉落物落地位置超过它就拒收拾取请求。" +
      "与 autoPickupRadius 是两把尺子（那是客户端手感，这是服务端权威）；0 = 关闭校验，别当出货值",
    example: 200,
  })
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "拾取距离闸不能为负（0 = 关闭校验）" })
  @Max(2000, { message: "拾取距离闸不能超过 2000 像素" })
  pickAcceptRadius: number;

  @ApiProperty({ description: "背包已满的提示 / 重试间隔（毫秒）", example: 1500 })
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "背包已满提示间隔不能为负" })
  @Max(60000, { message: "背包已满提示间隔不能超过 60 秒（60000 毫秒）" })
  fullTipInterval: number;

  @ApiProperty({ description: "多件掉落物的最小中心间距（像素）", example: 52 })
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "最小中心间距不能为负" })
  @Max(500, { message: "最小中心间距不能超过 500 像素" })
  scatterMinDistance: number;

  @ApiProperty({ description: "服务端拾取应答等待上限（毫秒），超时允许重试", example: 5000 })
  @IsInt({ message: "必须是整数" })
  @Min(100, { message: "拾取应答等待至少 100 毫秒" })
  @Max(60000, { message: "拾取应答等待不能超过 60 秒（60000 毫秒）" })
  pickReplyTimeout: number;

  @ApiProperty({
    description:
      "随机绑定概率（百分比 0~100）：物品与怪物都没有「强制绑定」时，按它掷一次决定这一件是否绑定角色。" +
      "0 = 从不随机绑定",
    example: 30,
  })
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "随机绑定概率不能为负" })
  @Max(100, { message: "随机绑定概率不能超过 100" })
  bindChance: number;

  @ApiProperty({
    description:
      "掉落物存活时长（毫秒，#802）：到点从地面消失并记一条 expired 流水。" +
      "末段没有任何提示（不闪、不显示秒数）—— 改这个值会让「单图 200 件上限」更早/更晚触发",
    example: 180000,
  })
  @IsInt({ message: "必须是整数" })
  @Min(10000, { message: "掉落存活时长至少 10 秒（10000 毫秒）" })
  @Max(300000, { message: "掉落存活时长不能超过 5 分钟（300000 毫秒）" })
  ttlMs: number;

  @ApiProperty({ description: "归属保护期（毫秒）：这之前只有归属者与掉落时的同队队友能捡", example: 30000 })
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "归属保护期不能为负" })
  @Max(300000, { message: "归属保护期不能超过 5 分钟（300000 毫秒）" })
  protectMs: number;

  @ApiProperty({ description: "单图地面掉落上限（件）：超出按落下的先后挤掉最旧的", example: 200 })
  @IsInt({ message: "必须是整数" })
  @Min(20, { message: "单图地面上限至少 20 件" })
  @Max(1000, { message: "单图地面上限不能超过 1000 件" })
  maxGroundPerMap: number;

  @ApiProperty({ description: "boss 掉落是否发全服公告（30 秒最多一条）", example: true })
  @IsBoolean({ message: "必须是布尔值" })
  announceBoss: boolean;
}

/** 自动战斗 / 寻路参数（`configs/autoBattle.ts` 的行为部分，样式与颜色不在其中） */
export class AutoBattleParamsDto {
  @ApiProperty({ description: "自动选目标的最大距离（像素，0 = 不限，全图取最近）", example: 0 })
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "自动选目标距离不能为负" })
  @Max(5000, { message: "自动选目标距离不能超过 5000 像素" })
  maxTargetDistance: number;

  @ApiProperty({ description: "自动移动是否使用跑步速度", example: true })
  @IsBoolean({ message: "必须是布尔值" })
  moveByRun: boolean;

  @ApiProperty({
    description: "经典走路模式：开启后移动为一格一步的格子走动（必须走完一步才走下一步，停点为格心）；关闭为连续移动",
    example: false,
  })
  @IsBoolean({ message: "必须是布尔值" })
  classicWalkMode: boolean;

  @ApiProperty({ description: "A* 网格单元边长（像素）：越小越贴合障碍、搜索越慢", example: 40 })
  @IsInt({ message: "必须是整数" })
  @Min(8, { message: "A* 网格边长至少 8 像素" })
  @Max(200, { message: "A* 网格边长不能超过 200 像素" })
  cellSize: number;

  @ApiProperty({ description: "通行余量（像素）：障碍矩形向外扩张这么多再烙进网格", example: 20 })
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "通行余量不能为负" })
  @Max(200, { message: "通行余量不能超过 200 像素" })
  clearance: number;

  @ApiProperty({ description: "重新寻路间隔（毫秒）", example: 400 })
  @IsInt({ message: "必须是整数" })
  @Min(50, { message: "重新寻路间隔至少 50 毫秒" })
  @Max(10000, { message: "重新寻路间隔不能超过 10 秒（10000 毫秒）" })
  repathInterval: number;

  @ApiProperty({ description: "到达路点的判定半径（像素）", example: 14 })
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "到达判定半径不能为负" })
  @Max(200, { message: "到达判定半径不能超过 200 像素" })
  waypointTolerance: number;

  @ApiProperty({ description: "卡住检测间隔（毫秒）", example: 500 })
  @IsInt({ message: "必须是整数" })
  @Min(100, { message: "卡住检测间隔至少 100 毫秒" })
  @Max(10000, { message: "卡住检测间隔不能超过 10 秒（10000 毫秒）" })
  stuckInterval: number;

  @ApiProperty({ description: "卡住判定：该间隔内位移小于此值视为卡住（像素）", example: 8 })
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "卡住判定位移阈值不能为负" })
  @Max(200, { message: "卡住判定位移阈值不能超过 200 像素" })
  stuckDistance: number;

  @ApiProperty({ description: "连续卡住多少次后放弃当前目标", example: 3 })
  @IsInt({ message: "必须是整数" })
  @Min(1, { message: "连续卡住次数至少 1 次" })
  @Max(20, { message: "连续卡住次数不能超过 20 次" })
  stuckRetryLimit: number;

  @ApiProperty({ description: "被放弃目标的拉黑时长（毫秒）", example: 5000 })
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "拉黑时长不能为负" })
  @Max(600000, { message: "拉黑时长不能超过 10 分钟（600000 毫秒）" })
  targetBanDuration: number;

  @ApiProperty({ description: "场上没目标时，隔多久再找一次（毫秒）", example: 500 })
  @IsInt({ message: "必须是整数" })
  @Min(50, { message: "重找目标间隔至少 50 毫秒" })
  @Max(10000, { message: "重找目标间隔不能超过 10 秒（10000 毫秒）" })
  targetSearchInterval: number;

  @ApiProperty({ description: "点击寻路的到达判定半径（像素）", example: 20 })
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "到达判定半径不能为负" })
  @Max(200, { message: "到达判定半径不能超过 200 像素" })
  arriveTolerance: number;

  @ApiProperty({ description: "传送落点吸附半径（格）", example: 12 })
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "传送吸附半径不能为负" })
  @Max(64, { message: "传送吸附半径不能超过 64 格" })
  teleportSnapRadius: number;

  @ApiProperty({ description: "突进类技能的落点吸附半径（像素）", example: 60 })
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "突进吸附半径不能为负" })
  @Max(500, { message: "突进吸附半径不能超过 500 像素" })
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
  @IsInt({ message: "必须是整数" })
  @Min(1, { message: "帮会名最短字数至少 1 字" })
  @Max(20, { message: "帮会名最短字数不能超过 20 字" })
  nameMin: number;

  @ApiProperty({ description: "帮会名最长字数（必须 ≥ 最短字数）", example: 12 })
  @IsInt({ message: "必须是整数" })
  @Min(1, { message: "帮会名最长字数至少 1 字" })
  @Max(30, { message: "帮会名最长字数不能超过 30 字" })
  nameMax: number;

  @ApiProperty({ description: "帮会公告最长字数（0 = 不限）", example: 200 })
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "帮会公告最长字数不能为负" })
  @Max(2000, { message: "帮会公告最长字数不能超过 2000 字" })
  noticeMax: number;

  @ApiProperty({ description: "入帮申请留言最长字数（0 = 不限）", example: 50 })
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "申请留言最长字数不能为负" })
  @Max(500, { message: "申请留言最长字数不能超过 500 字" })
  applicationMessageMax: number;

  @ApiProperty({ description: "建帮所需最低角色等级（0 = 不限等级）", example: 10 })
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "建帮等级门槛不能为负" })
  @Max(1000, { message: "建帮等级门槛不能超过 1000 级" })
  createLevelMin: number;

  @ApiProperty({ description: "建帮消耗绑定元宝（0 = 免费）", example: 100000 })
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "建帮消耗不能为负" })
  @Max(100000000, { message: "建帮消耗不能超过 1 亿（100000000）" })
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

/** 部分更新：只提交改动过的分组，组内也只提交改动过的字段（message 与对应的全量 DTO 同一条） */
export class UpdateDropRuntimeParamsDto {
  @ApiPropertyOptional({ description: "自动拾取半径（像素）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "自动拾取半径不能为负" })
  @Max(500, { message: "自动拾取半径不能超过 500 像素" })
  autoPickupRadius?: number;

  @ApiPropertyOptional({ description: "服务端拾取距离闸（像素；0 = 关闭校验）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "拾取距离闸不能为负（0 = 关闭校验）" })
  @Max(2000, { message: "拾取距离闸不能超过 2000 像素" })
  pickAcceptRadius?: number;

  @ApiPropertyOptional({ description: "背包已满的提示 / 重试间隔（毫秒）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "背包已满提示间隔不能为负" })
  @Max(60000, { message: "背包已满提示间隔不能超过 60 秒（60000 毫秒）" })
  fullTipInterval?: number;

  @ApiPropertyOptional({ description: "多件掉落物的最小中心间距（像素）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "最小中心间距不能为负" })
  @Max(500, { message: "最小中心间距不能超过 500 像素" })
  scatterMinDistance?: number;

  @ApiPropertyOptional({ description: "服务端拾取应答等待上限（毫秒）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(100, { message: "拾取应答等待至少 100 毫秒" })
  @Max(60000, { message: "拾取应答等待不能超过 60 秒（60000 毫秒）" })
  pickReplyTimeout?: number;

  @ApiPropertyOptional({ description: "随机绑定概率（百分比 0~100；0 = 从不随机绑定）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "随机绑定概率不能为负" })
  @Max(100, { message: "随机绑定概率不能超过 100" })
  bindChance?: number;

  @ApiPropertyOptional({ description: "掉落物存活时长（毫秒，10000~300000）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(10000, { message: "掉落存活时长至少 10 秒（10000 毫秒）" })
  @Max(300000, { message: "掉落存活时长不能超过 5 分钟（300000 毫秒）" })
  ttlMs?: number;

  @ApiPropertyOptional({ description: "归属保护期（毫秒）：不得超过 ttlMs" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "归属保护期不能为负" })
  @Max(300000, { message: "归属保护期不能超过 5 分钟（300000 毫秒）" })
  protectMs?: number;

  @ApiPropertyOptional({ description: "单图地面掉落上限（件，20~1000）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(20, { message: "单图地面上限至少 20 件" })
  @Max(1000, { message: "单图地面上限不能超过 1000 件" })
  maxGroundPerMap?: number;

  @ApiPropertyOptional({ description: "boss 掉落是否发全服公告" })
  @IsOptional()
  @IsBoolean({ message: "必须是布尔值" })
  announceBoss?: boolean;
}

/** 部分更新：自动战斗分组 */
export class UpdateAutoBattleParamsDto {
  @ApiPropertyOptional({ description: "自动选目标的最大距离（像素，0 = 不限）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "自动选目标距离不能为负" })
  @Max(5000, { message: "自动选目标距离不能超过 5000 像素" })
  maxTargetDistance?: number;

  @ApiPropertyOptional({ description: "自动移动是否使用跑步速度" })
  @IsOptional()
  @IsBoolean({ message: "必须是布尔值" })
  moveByRun?: boolean;

  @ApiPropertyOptional({ description: "经典走路模式：一格一步的格子走动" })
  @IsOptional()
  @IsBoolean({ message: "必须是布尔值" })
  classicWalkMode?: boolean;

  @ApiPropertyOptional({ description: "A* 网格单元边长（像素）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(8, { message: "A* 网格边长至少 8 像素" })
  @Max(200, { message: "A* 网格边长不能超过 200 像素" })
  cellSize?: number;

  @ApiPropertyOptional({ description: "通行余量（像素）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "通行余量不能为负" })
  @Max(200, { message: "通行余量不能超过 200 像素" })
  clearance?: number;

  @ApiPropertyOptional({ description: "重新寻路间隔（毫秒）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(50, { message: "重新寻路间隔至少 50 毫秒" })
  @Max(10000, { message: "重新寻路间隔不能超过 10 秒（10000 毫秒）" })
  repathInterval?: number;

  @ApiPropertyOptional({ description: "到达路点的判定半径（像素）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "到达判定半径不能为负" })
  @Max(200, { message: "到达判定半径不能超过 200 像素" })
  waypointTolerance?: number;

  @ApiPropertyOptional({ description: "卡住检测间隔（毫秒）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(100, { message: "卡住检测间隔至少 100 毫秒" })
  @Max(10000, { message: "卡住检测间隔不能超过 10 秒（10000 毫秒）" })
  stuckInterval?: number;

  @ApiPropertyOptional({ description: "卡住判定位移阈值（像素）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "卡住判定位移阈值不能为负" })
  @Max(200, { message: "卡住判定位移阈值不能超过 200 像素" })
  stuckDistance?: number;

  @ApiPropertyOptional({ description: "连续卡住多少次后放弃当前目标" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(1, { message: "连续卡住次数至少 1 次" })
  @Max(20, { message: "连续卡住次数不能超过 20 次" })
  stuckRetryLimit?: number;

  @ApiPropertyOptional({ description: "被放弃目标的拉黑时长（毫秒）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "拉黑时长不能为负" })
  @Max(600000, { message: "拉黑时长不能超过 10 分钟（600000 毫秒）" })
  targetBanDuration?: number;

  @ApiPropertyOptional({ description: "没目标时的重找间隔（毫秒）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(50, { message: "重找目标间隔至少 50 毫秒" })
  @Max(10000, { message: "重找目标间隔不能超过 10 秒（10000 毫秒）" })
  targetSearchInterval?: number;

  @ApiPropertyOptional({ description: "点击寻路的到达判定半径（像素）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "到达判定半径不能为负" })
  @Max(200, { message: "到达判定半径不能超过 200 像素" })
  arriveTolerance?: number;

  @ApiPropertyOptional({ description: "传送落点吸附半径（格）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "传送吸附半径不能为负" })
  @Max(64, { message: "传送吸附半径不能超过 64 格" })
  teleportSnapRadius?: number;

  @ApiPropertyOptional({ description: "突进类技能的落点吸附半径（像素）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "突进吸附半径不能为负" })
  @Max(500, { message: "突进吸附半径不能超过 500 像素" })
  dashSnapRadius?: number;
}

/** 部分更新：帮会规则分组 */
export class UpdateGuildRuleParamsDto {
  @ApiPropertyOptional({ description: "帮会名最短字数" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(1, { message: "帮会名最短字数至少 1 字" })
  @Max(20, { message: "帮会名最短字数不能超过 20 字" })
  nameMin?: number;

  @ApiPropertyOptional({ description: "帮会名最长字数（必须 ≥ 最短字数）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(1, { message: "帮会名最长字数至少 1 字" })
  @Max(30, { message: "帮会名最长字数不能超过 30 字" })
  nameMax?: number;

  @ApiPropertyOptional({ description: "帮会公告最长字数（0 = 不限）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "帮会公告最长字数不能为负" })
  @Max(2000, { message: "帮会公告最长字数不能超过 2000 字" })
  noticeMax?: number;

  @ApiPropertyOptional({ description: "入帮申请留言最长字数（0 = 不限）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "申请留言最长字数不能为负" })
  @Max(500, { message: "申请留言最长字数不能超过 500 字" })
  applicationMessageMax?: number;

  @ApiPropertyOptional({ description: "建帮所需最低角色等级（0 = 不限等级）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "建帮等级门槛不能为负" })
  @Max(1000, { message: "建帮等级门槛不能超过 1000 级" })
  createLevelMin?: number;

  @ApiPropertyOptional({ description: "建帮消耗绑定元宝（0 = 免费）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "建帮消耗不能为负" })
  @Max(100000000, { message: "建帮消耗不能超过 1 亿（100000000）" })
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
  @IsInt({ message: "必须是整数" })
  @Min(100, { message: "普攻间隔至少 100 毫秒" })
  @Max(60000, { message: "普攻间隔不能超过 60 秒（60000 毫秒）" })
  attackInterval: number;

  @ApiProperty({ description: "普攻距离（像素）", example: 60 })
  @IsInt({ message: "必须是整数" })
  @Min(1, { message: "普攻距离至少 1 像素" })
  @Max(2000, { message: "普攻距离不能超过 2000 像素" })
  attackRange: number;

  @ApiProperty({ description: "施法硬直兜底（毫秒）：技能没配 cast_lock_ms 时用它", example: 400 })
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "施法硬直兜底不能为负" })
  @Max(5000, { message: "施法硬直兜底不能超过 5 秒（5000 毫秒）" })
  attackActionTime: number;

  @ApiProperty({ description: "击退时长（毫秒）：技能只配距离时用它换算击退速度", example: 200 })
  @IsInt({ message: "必须是整数" })
  @Min(50, { message: "击退时长至少 50 毫秒" })
  @Max(5000, { message: "击退时长不能超过 5 秒（5000 毫秒）" })
  pushDuration: number;

  @ApiProperty({ description: "待机游走间隔区间（毫秒，[最小, 最大]）", example: [4000, 9000], isArray: true, type: Number })
  @IsArray({ message: "必须是数组" })
  @ArrayMinSize(2, { message: "必须是 [最小, 最大] 两个值" })
  @ArrayMaxSize(2, { message: "必须是 [最小, 最大] 两个值" })
  @IsInt({ each: true, message: "区间每一项必须是整数" })
  idleMoveInterval: [number, number];

  @ApiProperty({ description: "待机游走每次走多久（毫秒，[最小, 最大]）", example: [300, 800], isArray: true, type: Number })
  @IsArray({ message: "必须是数组" })
  @ArrayMinSize(2, { message: "必须是 [最小, 最大] 两个值" })
  @ArrayMaxSize(2, { message: "必须是 [最小, 最大] 两个值" })
  @IsInt({ each: true, message: "区间每一项必须是整数" })
  idleMoveDuration: [number, number];

  @ApiProperty({ description: "游走速度倍率（乘在怪物 moveSpeed 上）", example: 0.5 })
  @IsNumber({ maxDecimalPlaces: 2 }, { message: "最多保留 2 位小数" })
  @Min(0.1, { message: "游走速度倍率至少 0.1" })
  @Max(5, { message: "游走速度倍率不能超过 5" })
  idleMoveSpeedScale: number;

  @ApiProperty({ description: "游走活动半径（像素，围绕出生点）", example: 60 })
  @IsInt({ message: "必须是整数" })
  @Min(1, { message: "游走半径至少 1 像素" })
  @Max(2000, { message: "游走半径不能超过 2000 像素" })
  wanderRadius: number;

  @ApiProperty({
    description: "牵引半径（像素）：目标跑出这个距离就脱战回家。必须大于普攻距离，否则怪永远追不上就脱战",
    example: 600,
  })
  @IsInt({ message: "必须是整数" })
  @Min(100, { message: "牵引半径至少 100 像素" })
  @Max(5000, { message: "牵引半径不能超过 5000 像素" })
  leashRange: number;

  @ApiProperty({ description: "回家速度倍率（乘在 moveSpeed 上；比追击快，免得被拖着遛）", example: 1.5 })
  @IsNumber({ maxDecimalPlaces: 2 }, { message: "最多保留 2 位小数" })
  @Min(0.1, { message: "回家速度倍率至少 0.1" })
  @Max(5, { message: "回家速度倍率不能超过 5" })
  returnSpeedRate: number;

  @ApiProperty({ description: "回家超时（毫秒）：到点还没走回去就吸附到出生点", example: 20000 })
  @IsInt({ message: "必须是整数" })
  @Min(1000, { message: "回家超时至少 1 秒（1000 毫秒）" })
  @Max(300000, { message: "回家超时不能超过 5 分钟（300000 毫秒）" })
  returnTimeoutMs: number;
}

/** 怪物 AI 参数的部分更新（只提交改动过的字段；message 与对应的全量 DTO 同一条） */
export class UpdateMonsterAiParamsDto {
  @ApiPropertyOptional({ description: "普攻间隔（毫秒）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(100, { message: "普攻间隔至少 100 毫秒" })
  @Max(60000, { message: "普攻间隔不能超过 60 秒（60000 毫秒）" })
  attackInterval?: number;

  @ApiPropertyOptional({ description: "普攻距离（像素）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(1, { message: "普攻距离至少 1 像素" })
  @Max(2000, { message: "普攻距离不能超过 2000 像素" })
  attackRange?: number;

  @ApiPropertyOptional({ description: "施法硬直兜底（毫秒）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "施法硬直兜底不能为负" })
  @Max(5000, { message: "施法硬直兜底不能超过 5 秒（5000 毫秒）" })
  attackActionTime?: number;

  @ApiPropertyOptional({ description: "击退时长（毫秒）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(50, { message: "击退时长至少 50 毫秒" })
  @Max(5000, { message: "击退时长不能超过 5 秒（5000 毫秒）" })
  pushDuration?: number;

  @ApiPropertyOptional({ description: "待机游走间隔区间（毫秒，[最小, 最大]）", isArray: true, type: Number })
  @IsOptional()
  @IsArray({ message: "必须是数组" })
  @ArrayMinSize(2, { message: "必须是 [最小, 最大] 两个值" })
  @ArrayMaxSize(2, { message: "必须是 [最小, 最大] 两个值" })
  @IsInt({ each: true, message: "区间每一项必须是整数" })
  idleMoveInterval?: [number, number];

  @ApiPropertyOptional({ description: "待机游走每次走多久（毫秒，[最小, 最大]）", isArray: true, type: Number })
  @IsOptional()
  @IsArray({ message: "必须是数组" })
  @ArrayMinSize(2, { message: "必须是 [最小, 最大] 两个值" })
  @ArrayMaxSize(2, { message: "必须是 [最小, 最大] 两个值" })
  @IsInt({ each: true, message: "区间每一项必须是整数" })
  idleMoveDuration?: [number, number];

  @ApiPropertyOptional({ description: "游走速度倍率" })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 }, { message: "最多保留 2 位小数" })
  @Min(0.1, { message: "游走速度倍率至少 0.1" })
  @Max(5, { message: "游走速度倍率不能超过 5" })
  idleMoveSpeedScale?: number;

  @ApiPropertyOptional({ description: "游走活动半径（像素）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(1, { message: "游走半径至少 1 像素" })
  @Max(2000, { message: "游走半径不能超过 2000 像素" })
  wanderRadius?: number;

  @ApiPropertyOptional({ description: "牵引半径（像素，必须大于普攻距离）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(100, { message: "牵引半径至少 100 像素" })
  @Max(5000, { message: "牵引半径不能超过 5000 像素" })
  leashRange?: number;

  @ApiPropertyOptional({ description: "回家速度倍率" })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 }, { message: "最多保留 2 位小数" })
  @Min(0.1, { message: "回家速度倍率至少 0.1" })
  @Max(5, { message: "回家速度倍率不能超过 5" })
  returnSpeedRate?: number;

  @ApiPropertyOptional({ description: "回家超时（毫秒）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(1000, { message: "回家超时至少 1 秒（1000 毫秒）" })
  @Max(300000, { message: "回家超时不能超过 5 分钟（300000 毫秒）" })
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
  @IsString({ message: "必须是字符串" })
  note?: string;
}

/**
 * 位移校验参数（`runtime_params.movement` 列，#811，**服务端消费，不下发客户端**）
 *
 * 与怪物 AI 参数同一处理：单独一组、单独两条接口，理由也一样 ——
 * `RuntimeParamsDto` 就是客户端快照 `runtimeParams` 段的形状，往里加东西等于
 * 「快照多一段」。而且档位**更不能**下发：告诉客户端「现在是 log 档」等于告诉作弊者
 * 「现在随便瞬移」。
 */
export class MovementGuardParamsDto {
  @ApiProperty({
    description: "档位：off 完全不校验 / log 只记账放行（出厂）/ enforce 拒绝并拉回",
    enum: ["off", "log", "enforce"],
    example: "log",
  })
  @IsIn(["off", "log", "enforce"], { message: "档位只能是 off / log / enforce" })
  mode: "off" | "log" | "enforce";

  @ApiProperty({ description: "速度上限（像素/秒）：单帧位移超过 上限×容差×Δt + 抖动 即判超速", example: 400 })
  @IsNumber({ maxDecimalPlaces: 2 }, { message: "最多保留 2 位小数" })
  @Min(10, { message: "速度上限至少 10 像素/秒" })
  @Max(20000, { message: "速度上限不能超过 20000 像素/秒" })
  maxSpeed: number;

  @ApiProperty({ description: "容差倍率（留给刚体加减速与插值）", example: 1.35 })
  @IsNumber({ maxDecimalPlaces: 2 }, { message: "最多保留 2 位小数" })
  @Min(1, { message: "容差至少 1（比 1 还严 = 正常移动全被误判）" })
  @Max(3, { message: "容差不能超过 3" })
  tolerance: number;

  @ApiProperty({ description: "抖动余量（像素）：抵掉坐标取整与上报相位差", example: 24 })
  @IsNumber({ maxDecimalPlaces: 2 }, { message: "最多保留 2 位小数" })
  @Min(0, { message: "抖动余量不能为负" })
  @Max(500, { message: "抖动余量不能超过 500 像素" })
  jitterPx: number;

  @ApiProperty({ description: "是否做穿墙校验（与档位分开，碰撞数据出问题时可单独止血）", example: true })
  @IsBoolean({ message: "必须是布尔值" })
  wallCheck: boolean;

  @ApiProperty({ description: "同一连接两次 posCorrect 的最小间隔（毫秒）", example: 500 })
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "posCorrect 最小间隔不能为负" })
  @Max(10000, { message: "posCorrect 最小间隔不能超过 10 秒（10000 毫秒）" })
  correctIntervalMs: number;
}

/** 位移校验参数的部分更新（只提交改动过的字段） */
export class UpdateMovementGuardParamsDto {
  @ApiPropertyOptional({ description: "档位：off / log / enforce", enum: ["off", "log", "enforce"] })
  @IsOptional()
  @IsIn(["off", "log", "enforce"], { message: "档位只能是 off / log / enforce" })
  mode?: "off" | "log" | "enforce";

  @ApiPropertyOptional({ description: "速度上限（像素/秒）" })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 }, { message: "最多保留 2 位小数" })
  @Min(10, { message: "速度上限至少 10 像素/秒" })
  @Max(20000, { message: "速度上限不能超过 20000 像素/秒" })
  maxSpeed?: number;

  @ApiPropertyOptional({ description: "容差倍率" })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 }, { message: "最多保留 2 位小数" })
  @Min(1, { message: "容差至少 1（比 1 还严 = 正常移动全被误判）" })
  @Max(3, { message: "容差不能超过 3" })
  tolerance?: number;

  @ApiPropertyOptional({ description: "抖动余量（像素）" })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 }, { message: "最多保留 2 位小数" })
  @Min(0, { message: "抖动余量不能为负" })
  @Max(500, { message: "抖动余量不能超过 500 像素" })
  jitterPx?: number;

  @ApiPropertyOptional({ description: "是否做穿墙校验" })
  @IsOptional()
  @IsBoolean({ message: "必须是布尔值" })
  wallCheck?: boolean;

  @ApiPropertyOptional({ description: "同一连接两次 posCorrect 的最小间隔（毫秒）" })
  @IsOptional()
  @IsInt({ message: "必须是整数" })
  @Min(0, { message: "posCorrect 最小间隔不能为负" })
  @Max(10000, { message: "posCorrect 最小间隔不能超过 10 秒（10000 毫秒）" })
  correctIntervalMs?: number;
}

/** 出手距离闸参数（#1030；`runtime_params.cast_range` 列，服务端独占、不下发客户端） */
export class CastRangeParamsDto {
  @ApiProperty({
    description: "档位：off 完全不判 / log 只记账放行（出厂）/ enforce 超距即拒该次出手",
    enum: ["off", "log", "enforce"],
    example: "log",
  })
  @IsIn(["off", "log", "enforce"], { message: "档位只能是 off / log / enforce" })
  mode: "off" | "log" | "enforce";

  @ApiProperty({
    description: "抖动余量（像素）：抵掉 10Hz 上报的相位差与怪物插值滞后，出厂 24（与 movement.jitterPx 同源）",
    example: 24,
  })
  @IsNumber({ maxDecimalPlaces: 2 }, { message: "最多保留 2 位小数" })
  @Min(0, { message: "抖动余量不能为负" })
  @Max(500, { message: "抖动余量不能超过 500 像素" })
  jitterPx: number;
}

/** 出手距离闸参数的部分更新（只提交改动过的字段） */
export class UpdateCastRangeParamsDto {
  @ApiPropertyOptional({ description: "档位：off / log / enforce", enum: ["off", "log", "enforce"] })
  @IsOptional()
  @IsIn(["off", "log", "enforce"], { message: "档位只能是 off / log / enforce" })
  mode?: "off" | "log" | "enforce";

  @ApiPropertyOptional({ description: "抖动余量（像素）" })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 }, { message: "最多保留 2 位小数" })
  @Min(0, { message: "抖动余量不能为负" })
  @Max(500, { message: "抖动余量不能超过 500 像素" })
  jitterPx?: number;
}

/**
 * AOI 推送口径（`runtime_params.aoi` 列，#1170）
 *
 * 推送架构的四个参数：格子边长（视野 = 3×3 格并集）/ 单帧实体上限 /
 * 离开视野延迟 / 互见广播节拍。纯服务端消费、不下发客户端。
 *
 * **生效时机是重启**：格子边长变了等于把所有已成形的格子索引作废，
 * 四个参数统一启动时读一次 —— 页面上要标「重启后生效」。
 */
export class AoiParamsDto {
  @ApiProperty({
    description: "格子边长（像素，出厂 512）：视野 = 玩家所在格 + 周围 8 格的并集。改它需要重建全部格子索引，重启生效",
    example: 512,
  })
  @IsInt()
  @Min(128)
  @Max(2048)
  cellSize: number;

  @ApiProperty({
    description: "单帧实体上限（出厂 200）：一个视野里塞进几百只时只留离格心最近的 N 个，防单帧 JSON 顶爆",
    example: 200,
  })
  @IsInt()
  @Min(10)
  @Max(500)
  maxEntities: number;

  @ApiProperty({
    description: "离开视野延迟（毫秒，出厂 1000）：出视野先记账，期内又看见就取消 —— 站格子边界来回走不闪",
    example: 1000,
  })
  @IsInt()
  @Min(0)
  @Max(10000)
  leaveDelayMs: number;

  @ApiProperty({
    description: "互见广播节拍（Hz，出厂 10）：格子索引与进出差量每拍刷新一次；下限 50ms 由服务端夹",
    example: 10,
  })
  @IsInt()
  @Min(1)
  @Max(20)
  broadcastHz: number;
}

/** AOI 口径的部分更新：只提交改动过的字段，没提交的保持原值 */
export class UpdateAoiParamsDto {
  @ApiPropertyOptional({ description: "格子边长（像素），128 ~ 2048" })
  @IsOptional()
  @IsInt()
  @Min(128)
  @Max(2048)
  cellSize?: number;

  @ApiPropertyOptional({ description: "单帧实体上限，10 ~ 500" })
  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(500)
  maxEntities?: number;

  @ApiPropertyOptional({ description: "离开视野延迟（毫秒），0 ~ 10000" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  leaveDelayMs?: number;

  @ApiPropertyOptional({ description: "互见广播节拍（Hz），1 ~ 20" })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  broadcastHz?: number;
}

/** 七组推荐值（`GET admin/runtime-params/recommended` 的形状，#1185；值来自服务端常量，不走校验管道） */
export class RecommendedRuntimeParamsDto {
  @ApiProperty({ description: "掉落参数推荐值", type: DropRuntimeParamsDto })
  drop: DropRuntimeParamsDto;

  @ApiProperty({ description: "自动战斗参数推荐值", type: AutoBattleParamsDto })
  autoBattle: AutoBattleParamsDto;

  @ApiProperty({ description: "帮会规则推荐值", type: GuildRuleParamsDto })
  guild: GuildRuleParamsDto;

  @ApiProperty({ description: "怪物 AI 参数推荐值", type: MonsterAiParamsDto })
  monsterAi: MonsterAiParamsDto;

  @ApiProperty({ description: "位移校验参数推荐值", type: MovementGuardParamsDto })
  movement: MovementGuardParamsDto;

  @ApiProperty({ description: "出手距离闸参数推荐值", type: CastRangeParamsDto })
  castRange: CastRangeParamsDto;

  @ApiProperty({ description: "AOI 推送口径推荐值", type: AoiParamsDto })
  aoi: AoiParamsDto;
}
