import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { ApiHeader, ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { ZoneContext } from "../../common/decorators/zone-context.decorator";
import { ZoneContextGuard } from "../../common/guards/zone-context.guard";
import { Permission } from "../../common/constants/permission";
import { LEADERBOARD_BOARDS, LEADERBOARD_BOARD_LABELS } from "../../common/constants/leaderboard";
import { LeaderboardService } from "../leaderboard/leaderboard.service";
import { LeaderboardPageDto, LeaderboardQueryDto } from "../leaderboard/dto/leaderboard.dto";

/** 榜单一览（文档里复用；顺序与 `LEADERBOARD_BOARDS` 一致） */
const BOARD_LIST = LEADERBOARD_BOARDS.map((board) => `\`${board}\`（${LEADERBOARD_BOARD_LABELS[board]}）`).join(" / ");

/**
 * 管理端 · 榜单（#959；#960 起区走统一守卫）
 *
 * 与玩家侧 `GET /leaderboards/:board` 读**同一份快照**（`LeaderboardService.adminPage`）——
 * 客服在后台看到的榜必须和玩家看到的一模一样，「后台另算一遍」是两套口径的开始。
 *
 * 区取自请求头 `X-Zone-Id`（`ZoneContextGuard` 校验后放进 `request.zoneId`）：
 * 管理端一次只在一个区里干活，同一个人切区就能看另一个区的榜，不需要另开权限。
 */
@ApiAudience("admin")
@UseGuards(ZoneContextGuard)
@Controller("admin/leaderboards")
export class AdminLeaderboardsController {
  constructor(private readonly leaderboardService: LeaderboardService) {}

  @Get(":board")
  @ApiAdminDoc({
    operationId: "adminLeaderboard.page",
    summary: "某个区的榜单分页",
    description:
      `\`board\` 取 ${BOARD_LIST}。\n\n` +
      "**区取自请求头 `X-Zone-Id`**（必填；缺失 / 不是正整数 / 区不存在 / 区已合并 → 400 " +
      "`ZONE_REQUIRED`）。不接受 `?zoneId=` —— 管理端的区是「当前上下文」，不是单次查询参数。\n\n" +
      "榜是分区榜（#959）：名次在区内算，上榜条数（`LEADERBOARD_TOP_N`）也按区各截一次。\n\n" +
      "并列规则与玩家侧一致：同分同名次（1、2、2、4），同分按角色 id 升序。" +
      "区里暂时没有角色时返回空榜（`list = []`、`total = 0`），不是错误。",
    permissions: [Permission.ROLE_READ],
  })
  @ApiHeader({ name: "X-Zone-Id", required: true, description: "当前作业区服（未合并的区 id）" })
  @ApiParam({ name: "board", description: `榜单：${BOARD_LIST}`, enum: [...LEADERBOARD_BOARDS] })
  @ApiQueryModel(LeaderboardQueryDto)
  @ApiDataResponse(LeaderboardPageDto, { description: "该区的分页结果（list/total/page/size + computedAt）" })
  page(
    @Param("board") board: string,
    @Query() query: LeaderboardQueryDto,
    @ZoneContext() zoneId: number,
  ): LeaderboardPageDto {
    return this.leaderboardService.adminPage(this.leaderboardService.assertBoard(board), zoneId, query);
  }
}
