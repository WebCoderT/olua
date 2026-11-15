import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { ApiHeader } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { ZoneContext } from "../../common/decorators/zone-context.decorator";
import { ZoneContextGuard } from "../../common/guards/zone-context.guard";
import { Permission } from "../../common/constants/permission";
import { DROP_RESULTS } from "../../common/constants/drop";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { DROP_RECORD_SORT, DROP_GROUND_SORT, sortFieldNames } from "../../database/sort-specs";
import { DropsService } from "./drops.service";
import {
  DropClearDto,
  DropClearResultDto,
  DropGroundDto,
  DropGroundPageDto,
  DropGroundQueryDto,
  DropGroundSummaryDto,
  MonsterDropIndexItemDto,
  MonsterDropIndexPageDto,
  MonsterDropIndexQueryDto,
} from "./dto/drop-ground.dto";
import {
  DropRecordDto,
  DropRecordPageDto,
  DropRecordQueryDto,
  DropRecordSummaryDto,
} from "./dto/drop-record.dto";

/**
 * 管理端 · 掉落（#803 流水 / #805 监控与反查）
 *
 * 五个只读接口 + 一个写接口，分四组：
 * - `ground*`：**现在地上有什么**（读实时进程写的 `world_drops` 投影）；
 * - `records*`：**这件东西最后去哪了**（读 append-only 的 `drop_records`）；
 * - `monster-index`：**这件东西都有谁会掉**（读配置，不分区）。
 *
 * 读接口全是 GET，**天然不进审计**（`AuditInterceptor` 只审写方法）。唯一的写接口是
 * `POST /clear`（清空某图地面）：它走 `@AuditTarget("drop")` 且已登记 `AUDIT_TARGET_TYPES`。
 *
 * 区取自请求头 `X-Zone-Id`（`ZoneContextGuard` 校验后放进 `request.zoneId`）：
 * 掉落是分区的，管理端一次只在一个区里干活，切区就能看另一个区，不需要另开权限。
 * **不接受 `?zoneId=`** —— 管理端的区是「当前上下文」，不是单次查询参数（docs/39 §2.4）。
 * `monster-index` 是唯一不吃区头的接口（配置不分区），但它仍然挂了 guard —— 管理端
 * 没有「无区」的会话，统一要求区头能让前端只维护一套请求习惯。
 */
@ApiAudience("admin")
@UseGuards(ZoneContextGuard)
@Controller("admin/drops")
export class AdminDropsController {
  constructor(private readonly drops: DropsService) {}

  @Get("ground/summary")
  @ApiAdminDoc({
    operationId: "adminDrop.groundSummary",
    summary: "当前地面概况（总件数 / 保护中 / 即将过期 / 单图水位）",
    description:
      "监控页顶部的四格：当前区地上总件数、还在归属保护期内的件数、窗口内即将过期的件数，\n" +
      "以及按图分组的明细（每图件数 + 单图上限 `cap`，水位 = total / cap）。\n\n" +
      "四个数字从**同一次**分组查询求和而来，不会是四个不同时间点的快照。\n\n" +
      "`serverNow` 一并返回：页面算「还剩几秒」用它，不读本机时钟（客户端时钟漂了也不影响）。\n\n" +
      "数据来自 `world_drops` 投影 —— 实时进程 100ms 批量刷一次，**最多差一拍**，" +
      "不承诺毫秒级精确。\n\n" +
      "**区取自请求头 `X-Zone-Id`**（必填；缺失 / 非法 → 400 `ZONE_REQUIRED`）。",
    permissions: [Permission.DROP_READ],
  })
  @ApiHeader({ name: "X-Zone-Id", required: true, description: "当前作业区服（未合并的区 id）" })
  @ApiQueryModel(DropGroundQueryDto)
  @ApiDataResponse(DropGroundSummaryDto, { description: "四格数字 + 按图明细 + 服务端时间" })
  groundSummary(@Query() query: DropGroundQueryDto, @ZoneContext() zoneId: number): DropGroundSummaryDto {
    return this.drops.groundSummary(zoneId, query);
  }

  @Get("ground")
  @ApiAdminDoc({
    operationId: "adminDrop.groundList",
    summary: "当前地面掉落",
    description:
      "一页「现在地上有什么」：哪张图、什么物品、谁打的、落在哪、还剩多久过期、是否在保护期。\n\n" +
      "`mapId` 精确、`keyword` 模糊匹配**物品 id**（`world_drops` 只存 id 不存名字，显示名由接口\n" +
      "按当前配置拼好返回）、`ownerName` 模糊匹配归属者角色名。条件之间是「与」。\n\n" +
      `**排序**：\`sort\` 取 ${sortFieldNames(DROP_GROUND_SORT)}，默认 \`expireAt\` 升序 —— ` +
      "最先消失的排在最上面，运营才来得及去现场看。\n\n" +
      "`remainMs` / `totalMs` / `protecting` 都是服务端算好的：页面不读时钟、也不把 `ttlMs` 写死。\n\n" +
      "**区取自请求头 `X-Zone-Id`**（必填；缺失 / 非法 → 400 `ZONE_REQUIRED`）。",
    permissions: [Permission.DROP_READ],
  })
  @ApiHeader({ name: "X-Zone-Id", required: true, description: "当前作业区服（未合并的区 id）" })
  @ApiQueryModel(DropGroundQueryDto)
  @ApiDataResponse(DropGroundPageDto, { description: "分页结果（list/total/page/size）" })
  groundList(@Query() query: DropGroundQueryDto, @ZoneContext() zoneId: number): PageResult<DropGroundDto> {
    return this.drops.listGround(zoneId, query);
  }

  @Get("records/summary")
  @ApiAdminDoc({
    operationId: "adminDrop.recordSummary",
    summary: "掉落流水概况（按终态分组计数）",
    description:
      "页面顶部的概况卡：按终态（picked / expired / overflow / restart_lost）分组计数。\n\n" +
      "**四个终态恒出现**（没有数据的给 0）：少一格会让运营以为「这种结果不存在」，而 0 一眼能看出「还没发生过」。\n\n" +
      "`result` 筛选在这里**不生效**（刻意）：传了就是「只看 picked」，再按 picked 分组只剩一行。\n" +
      "其余条件（`mapId` / `ownerName` / `monsterKey` / `pickedName` / `goodId` / `from` / `to`）照常生效。\n\n" +
      "**区取自请求头 `X-Zone-Id`**（必填；缺失 / 非法 → 400 `ZONE_REQUIRED`）。",
    permissions: [Permission.DROP_READ],
  })
  @ApiHeader({ name: "X-Zone-Id", required: true, description: "当前作业区服（未合并的区 id）" })
  @ApiQueryModel(DropRecordQueryDto)
  @ApiDataResponse(DropRecordSummaryDto, { description: "按终态分组的计数 + 合计" })
  summary(@Query() query: DropRecordQueryDto, @ZoneContext() zoneId: number): DropRecordSummaryDto {
    return this.drops.summary(zoneId, query);
  }

  @Get("records")
  @ApiAdminDoc({
    operationId: "adminDrop.recordList",
    summary: "掉落流水",
    description:
      "一页掉落终态记录（一件掉落的一生只有一行）：谁打的、掉在哪张图、在地上待了多久、最后被谁捡走 / 怎么消失的。\n\n" +
      `\`result\` 取 ${DROP_RESULTS.map((item) => `\`${item}\``).join(" / ")}；` +
      "`mapId` / `ownerName`（模糊）/ `monsterKey`（模糊，key 与快照名都试）/ `pickedName`（模糊）/ " +
      "`goodId`（精确）/ `from` / `to`（按掉落落地时刻）均可选，条件之间是「与」。\n\n" +
      `**排序**：\`sort\` 取 ${sortFieldNames(DROP_RECORD_SORT)}，\`order\` 取 asc / desc（默认 \`resolvedAt\` 倒序）。\n\n` +
      "**同 `dropId` 可能有多行**：`dropId` 里的序号每区自增，进程重启后从 1 重新开始 —— 所以两次\n" +
      "进程生命周期里可能生成同一个 `dropId`，而它们的流水都留着。排序与翻页一律按自增 `id`，\n" +
      "**不要按 `dropId` 去重**（docs/18 §3.5）。\n\n" +
      "**保留策略**：每区每图 `DROP_RECORD_KEEP_PER_MAP`（默认 2000）条 + `DROP_RECORD_RETENTION_DAYS`（默认 7 天），" +
      "两道闸取先到 —— 「三天前的记录查不到」既可能是被条数挤掉、也可能是超了保留天数。\n\n" +
      "**区取自请求头 `X-Zone-Id`**（必填；缺失 / 非法 → 400 `ZONE_REQUIRED`）。",
    permissions: [Permission.DROP_READ],
  })
  @ApiHeader({ name: "X-Zone-Id", required: true, description: "当前作业区服（未合并的区 id）" })
  @ApiQueryModel(DropRecordQueryDto)
  @ApiDataResponse(DropRecordPageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: DropRecordQueryDto, @ZoneContext() zoneId: number): PageResult<DropRecordDto> {
    return this.drops.list(zoneId, query);
  }

  @Get("monster-index")
  @ApiAdminDoc({
    operationId: "adminDrop.monsterIndex",
    summary: "怪物掉落反查（这件东西都有谁会掉）",
    description:
      "把每只怪的掉落池**摊平**成「怪物 × 物品」的一行：权重、概率、件数区间、绑定状态，\n" +
      "点一行可以跳到怪物配置页打开那只怪的掉落弹窗。\n\n" +
      "两种配置写法都会摊平：内联条目池（`source=entries`）与引用具名表（`source=table`）；\n" +
      "没配掉落（`source=none`，走兜底表）的怪不产生行 —— 「走兜底」不是一个可比对的条目。\n\n" +
      "`goodId` 精确（查「这件装备谁掉」）、`monsterKey` 精确、`keyword` 模糊匹配物品 id。\n" +
      "结果按怪物 key 再按物品 id 稳定排序。\n\n" +
      "**不分区**：这是配置反查，配置是全区共用的一份。请求头 `X-Zone-Id` 仍要求（管理端没有\n" +
      "「无区」会话），只是本接口不拿它筛数据。",
    permissions: [Permission.DROP_READ],
  })
  @ApiHeader({ name: "X-Zone-Id", required: true, description: "当前作业区服（未合并的区 id）" })
  @ApiQueryModel(MonsterDropIndexQueryDto)
  @ApiDataResponse(MonsterDropIndexPageDto, { description: "分页结果（list/total/page/size）" })
  monsterIndex(@Query() query: MonsterDropIndexQueryDto): PageResult<MonsterDropIndexItemDto> {
    return this.drops.monsterIndex(query);
  }

  @Post("clear")
  @ApiAdminDoc({
    operationId: "adminDrop.clear",
    summary: "清空某张图的地面掉落（跨进程指令）",
    description:
      "**不可逆**：这张图上玩家还没捡起来的东西会全部消失 —— 每件写一条 `overflow / manual_clear` 流水，" +
      "东西本身不会还回去。\n\n" +
      "地面掉落活在**实时进程的内存**里，本进程删投影表没用（下一拍会被原样写回来），所以这里只落一行" +
      "待办就返回「已受理」：实时进程每秒读一次未完成的请求，清完之后回写 `cleared`。页面在" +
      "`GET /admin/drops/ground/summary` 的 `clears` 里按 `requestId` 看执行结果，" +
      "超过 10 秒还没有 `doneAt` 就是「实时进程可能没起来」。\n\n" +
      "**两道确认**：`confirm` 必须为 `true`，`mapId` 必须是页面上输入的那张图 —— 少一个就 400。\n\n" +
      "同一张图已有未完成的请求时**就地合并**（`merged: true`）：连点两下不会清两遍，" +
      "第二遍清出 0 件只会在流水里多一批空记录。\n\n" +
      "写操作，进审计（目标类型 `drop`，正文是请求体；清掉多少件在 `drop_records` 与" +
      "`drop_clear_requests.cleared` 里，不在审计正文 —— 审计写在请求返回那一刻，那时还没清）。",
    permissions: [Permission.DROP_CLEAR],
  })
  @ApiHeader({ name: "X-Zone-Id", required: true, description: "当前作业区服（未合并的区 id）" })
  @AuditTarget("drop")
  @ApiDataResponse(DropClearResultDto, { description: "受理结果（requestId + 提交时的地面件数）" })
  clear(@Body() dto: DropClearDto, @ZoneContext() zoneId: number): DropClearResultDto {
    return this.drops.clear(zoneId, dto);
  }
}

