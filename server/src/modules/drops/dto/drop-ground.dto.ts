import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";
import { PageMetaDto, PageQueryDto } from "../../../common/dto/api-envelope.dto";
import { WorldDropRow } from "../../../database/rows";

/**
 * 当前地面的一件掉落（`world_drops` 投影的一行，#805）
 *
 * 与服务端 `dropSpawn` 帧是**同一份事实的两种读法**：帧给客户端铺地，这里给运营看
 * 「现在地上有什么」。字段上比帧多了三样：`goodLabel` / `remainMs` / `totalMs` ——
 * 后两个由服务端算，页面不读客户端时钟，也不把 `ttlMs=180s` 写进前端（那是配置算出来的）。
 *
 * `bound` 是「掉出来那一刻是否绑定」，不是物品当前的配置值：配置改了以后，地上那件
 * 东西不会跟着变（与 `drop_records.bound` 同一口径）。
 */
export class DropGroundDto {
  @ApiProperty({ description: "掉落 id（`d_<区>_<图>_<序号>`）", example: "d_1_1_42" })
  dropId: string;

  @ApiProperty({ description: "区服 id" })
  zoneId: number;

  @ApiProperty({ description: "地图 id", example: "1" })
  mapId: string;

  @ApiProperty({ description: "物品 id", example: "drug_hp_1" })
  goodId: string;

  @ApiProperty({
    description: "物品显示名（按**当前**配置现查；配置已删时回落成 id）",
    example: "金创药（小）",
  })
  goodLabel: string;

  @ApiProperty({ description: "件数" })
  count: number;

  @ApiProperty({ description: "是否绑定（掉落那一刻的判定结果）" })
  bound: boolean;

  @ApiProperty({ description: "落点 x（服务端散落算出来的，客户端不再自己撒）" })
  x: number;

  @ApiProperty({ description: "落点 y" })
  y: number;

  @ApiProperty({ description: "归属者账号 id" })
  ownerAccountId: string;

  @ApiProperty({ description: "归属者角色 id" })
  ownerRoleId: string;

  @ApiProperty({ description: "归属者角色名（保护期内的「XX的」就是这个）" })
  ownerName: string;

  @ApiProperty({ description: "来源怪物 key", example: "slime_1" })
  monsterKey: string;

  @ApiProperty({ description: "来源怪物显示名（快照；存量行为 null）", type: "string", nullable: true })
  monsterLabel: string | null;

  @ApiProperty({ description: "来源怪物实例 id（同 key 的第几只）" })
  monsterInstanceId: string;

  @ApiProperty({ description: "落地时刻（毫秒）" })
  createdAt: number;

  @ApiProperty({ description: "过期时刻（毫秒）" })
  expireAt: number;

  @ApiProperty({ description: "归属保护期结束时刻（毫秒；之前只有归属者与队友能捡）" })
  protectUntil: number;

  @ApiProperty({ description: "还剩多少毫秒过期（服务端算：max(0, expireAt - now)）" })
  remainMs: number;

  @ApiProperty({
    description: "这件掉落的总存活时长（= expireAt - createdAt，进度条的分母）",
    example: 180000,
  })
  totalMs: number;

  @ApiProperty({ description: "此刻是否还在保护期（= protectUntil > now，服务端判，页面不自己比时钟）" })
  protecting: boolean;

  static from(row: WorldDropRow, now: number, goodLabel: string): DropGroundDto {
    const dto = new DropGroundDto();
    dto.dropId = row.drop_id;
    dto.zoneId = row.zone_id;
    dto.mapId = row.map_id;
    dto.goodId = row.good_id;
    dto.goodLabel = goodLabel;
    dto.count = row.count;
    dto.bound = row.bound === 1;
    dto.x = row.x;
    dto.y = row.y;
    dto.ownerAccountId = row.owner_account_id;
    dto.ownerRoleId = row.owner_role_id;
    dto.ownerName = row.owner_name;
    dto.monsterKey = row.monster_key;
    dto.monsterLabel = row.monster_label;
    dto.monsterInstanceId = row.monster_instance_id;
    dto.createdAt = row.created_at;
    dto.expireAt = row.expire_at;
    dto.protectUntil = row.protect_until;
    dto.remainMs = Math.max(0, row.expire_at - now);
    dto.totalMs = Math.max(1, row.expire_at - row.created_at);
    dto.protecting = row.protect_until > now;
    return dto;
  }
}

/**
 * 当前地面查询入参
 *
 * 区**不在**这里（走 `X-Zone-Id`，与流水同一条口径）。`keyword` 匹配的是**物品 id**
 * —— `world_drops` 只存 id 不存名字，写「物品名模糊」是句空话；名字由接口按当前配置拼给页面。
 */
export class DropGroundQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "只看某张图（地图 id）" })
  @IsOptional()
  @IsString({ message: "地图 id 必须是字符串" })
  @MaxLength(64, { message: "地图 id 过长" })
  mapId?: string;

  @ApiPropertyOptional({ description: "归属者角色名（模糊匹配；`_` / `%` 会被转义）" })
  @IsOptional()
  @IsString({ message: "归属者名字必须是字符串" })
  @MaxLength(64, { message: "归属者名字过长" })
  ownerName?: string;
}

/** 当前地面的分页结果 */
export class DropGroundPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的地面掉落（默认按过期时刻升序：最先消失的在前）", type: [DropGroundDto] })
  list: DropGroundDto[];
}

/** 概况卡里按图分组的一格 */
export class DropGroundSummaryItemDto {
  @ApiProperty({ description: "地图 id", example: "1" })
  mapId: string;

  @ApiProperty({ description: "这张图地上的件数" })
  total: number;

  @ApiProperty({ description: "这张图还在归属保护期内的件数" })
  protectedTotal: number;

  @ApiProperty({ description: "这张图在窗口内就要过期的件数" })
  expiringTotal: number;

  @ApiProperty({ description: "单图上限（运行时参数 `drop.maxGroundPerMap`）；水位 = total / cap" })
  cap: number;
}

/**
 * 当前地面概况（页面顶部四格）
 *
 * 全部由服务端算，理由和 `DropRecordSummaryDto` 一样：分页的列表算不出全量数字。
 * `serverNow` 也一并给出来 —— 页面拿它判「剩余几秒」就不会被本机时钟拖偏。
 */
export class DropGroundSummaryDto {
  @ApiProperty({ description: "当前区地上总件数" })
  total: number;

  @ApiProperty({ description: "还在归属保护期内的总件数" })
  protectedTotal: number;

  @ApiProperty({ description: "在窗口内就要过期的总件数" })
  expiringTotal: number;

  @ApiProperty({ description: "「即将过期」的窗口长度（毫秒）", example: 60000 })
  expiringWindowMs: number;

  @ApiProperty({ description: "单图上限（运行时参数 `drop.maxGroundPerMap`）" })
  capPerMap: number;

  @ApiProperty({ description: "按图分组的明细（没有掉落时为空数组）", type: [DropGroundSummaryItemDto] })
  byMap: DropGroundSummaryItemDto[];

  @ApiProperty({ description: "服务端此刻的时间戳（页面算剩余秒数用它，不读本机时钟）" })
  serverNow: number;

  @ApiProperty({
    description:
      "本区最近的清空请求（未完成的 + 最近完成的，按 id 倒序）：页面拿 `POST /admin/drops/clear` " +
      "返回的 `requestId` 在这里找，找到且 `doneAt` 有值就显示「已清空 N 件」",
    type: () => [DropClearRequestViewDto],
  })
  clears: DropClearRequestViewDto[];
}

/**
 * 一条清空请求的**执行状态**（#805）
 *
 * 清空是跨进程的：管理端（3100）插一行就返回「已受理」，真正清掉的是实时进程（3101）。
 * 所以页面不能拿 200 当「清完了」—— 要看这里的 `doneAt` / `cleared`。
 * 超过 10 秒还没 `doneAt`，说明实时进程可能没起来（页面据此提示）。
 */
export class DropClearRequestViewDto {
  @ApiProperty({ description: "请求 id（POST 的返回里给的就是它）" })
  id: number;

  @ApiProperty({ description: "地图 id", example: "1" })
  mapId: string;

  @ApiProperty({ description: "提交时刻（毫秒）" })
  requestedAt: number;

  @ApiProperty({ description: "执行完成时刻（毫秒）；null = 还没执行", type: "number", nullable: true })
  doneAt: number | null;

  @ApiProperty({ description: "实际清掉多少件（0 也是有效结果：那张图本来就是空的）" })
  cleared: number;
}

/**
 * 清空某张图地面的入参（#805）
 *
 * **两道确认都在这里表达**：`confirm` 必须是 `true`（页面上是「我确认」勾选），`mapId` 必须
 * 由调用方原样给出（页面上是输入地图名）。少一个就 400 —— 这是不可逆操作，
 * 「少传一个字段也照清」比报错糟糕得多。
 */
export class DropClearDto {
  @ApiProperty({ description: "要清空的地图 id（与页面输入的地图名一致才放行）", example: "1" })
  @IsString({ message: "地图 id 必须是字符串" })
  @MaxLength(64, { message: "地图 id 过长" })
  mapId: string;

  @ApiProperty({ description: "二次确认开关（必须为 true）", example: true })
  @IsBoolean({ message: "confirm 必须是布尔值" })
  confirm: boolean;
}

/** 清空请求的受理结果（不是「清完了」，见 `DropClearRequestViewDto`） */
export class DropClearResultDto {
  @ApiProperty({ description: "请求 id（拿它去概况的 `clears` 里看执行结果）" })
  requestId: number;

  @ApiProperty({ description: "地图 id", example: "1" })
  mapId: string;

  @ApiProperty({ description: "提交时刻（毫秒）" })
  requestedAt: number;

  @ApiProperty({
    description: "是否合并进了已有的未完成请求（同一张图连点两下不会清两遍）",
  })
  merged: boolean;

  @ApiProperty({
    description: "提交那一刻投影表里这张图的件数（页面用它提示「大约 N 件」，不是精确值）",
  })
  groundTotal: number;
}

/**
 * 怪物掉落反查的一行（一只怪 × 一件物品，#805）
 *
 * 数据是从 `monster_drops` 的 JSON 列**展开**出来的：内联条目池（`source=entries`）直接摊平，
 * 引用具名表（`source=table`）先把表里的条目池取出来再摊平。没有条目（`source=none`）的怪
 * 不产生行 —— 「它会掉什么」的答案是「走兜底表」，那不是一个可比对的条目。
 */
export class MonsterDropIndexItemDto {
  @ApiProperty({ description: "怪物 key（= 怪物配置主键）", example: "slime_1" })
  monsterKey: string;

  @ApiProperty({ description: "怪物显示名（按当前配置现查；查不到回落成 key）" })
  monsterLabel: string;

  @ApiProperty({ description: "物品 id", example: "drug_hp_1" })
  goodId: string;

  @ApiProperty({ description: "物品显示名（按当前配置现查；查不到回落成 id）" })
  goodLabel: string;

  @ApiProperty({
    description: "条目来源：`entries`（这只怪内联）/ `table`（引用具名表）",
    enum: ["entries", "table"],
  })
  source: string;

  @ApiProperty({ description: "引用的具名表 id（`source=entries` 时为 null）", type: "string", nullable: true })
  tableId: string | null;

  @ApiProperty({ description: "抽取权重（同一池内相对值，缺省 1）" })
  weight: number;

  @ApiProperty({ description: "掉落概率 0~1（抽中后再生效，缺省 1 = 必掉）" })
  chance: number;

  @ApiProperty({ description: "件数下限（count 区间的第一位）" })
  minCount: number;

  @ApiProperty({ description: "件数上限（count 区间的第二位）" })
  maxCount: number;

  @ApiProperty({ description: "这只怪的掉落是否整体强制绑定（`monster_drops.bind_drops`）" })
  bindDrops: boolean;

  @ApiProperty({ description: "物品自身是否「掉出即绑定」（五张配置表的 `bind_on_drop`）" })
  bindOnDrop: boolean;

  @ApiProperty({
    description: "合成结论：两者取「或」—— 任一为真，掉出来就是绑定的（与掉落结算的判定同一口径）",
  })
  bound: boolean;
}

/** 怪物掉落反查的查询入参 */
export class MonsterDropIndexQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "只看某个物品（精确匹配：这件东西都有谁会掉）" })
  @IsOptional()
  @IsString({ message: "物品 id 必须是字符串" })
  @MaxLength(64, { message: "物品 id 过长" })
  goodId?: string;

  @ApiPropertyOptional({ description: "只看某只怪（精确匹配怪物 key）" })
  @IsOptional()
  @IsString({ message: "怪物 key 必须是字符串" })
  @MaxLength(64, { message: "怪物 key 过长" })
  monsterKey?: string;
}

/** 怪物掉落反查的分页结果 */
export class MonsterDropIndexPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的反查行", type: [MonsterDropIndexItemDto] })
  list: MonsterDropIndexItemDto[];
}
