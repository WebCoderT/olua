import { Controller, Get, Param, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiPlayerDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { LEADERBOARD_BOARDS, LEADERBOARD_BOARD_LABELS } from "../../common/constants/leaderboard";
import { LeaderboardService } from "./leaderboard.service";
import { LeaderboardPageDto, LeaderboardQueryDto, LeaderboardSelfDto } from "./dto/leaderboard.dto";

/** 榜单一览（文档里复用；顺序与 `LEADERBOARD_BOARDS` 一致） */
const BOARD_LIST = LEADERBOARD_BOARDS.map((board) => `\`${board}\`（${LEADERBOARD_BOARD_LABELS[board]}）`).join(" / ");

/**
 * 排行榜（#400）
 *
 * 三个榜共用同一套分页与名次规则，路由上只差一个 `:board`：
 * `GET /leaderboards/level|combat|kills`。
 *
 * 榜是**物化**的（默认每分钟重算一次），响应里的 `computedAt` 就是这份快照的时刻 ——
 * 客户端据此说「每分钟更新」，而不是让人以为刚升一级就该立刻跳名次。
 */
@Controller("leaderboards")
export class LeaderboardController {
  constructor(private readonly leaderboardService: LeaderboardService) {}

  @Get(":board/me")
  @ApiPlayerDoc({
    operationId: "leaderboard.me",
    summary: "我在某个榜上的名次",
    description:
      `\`board\` 取 ${BOARD_LIST}（下同）。\n\n` +
      "取的是**当前在线角色**：玩家在游戏里看榜，关心的是「我这个角色第几」。\n" +
      "没有在线角色（还没进游戏 / 被踢下线）时返回 `rank = 0` 与 `entry = null` —— " +
      "**不是 404**：界面上「你还没有名次」是正常状态，客户端不必为它写错误分支。\n\n" +
      "名次在**全量排序**里算，所以即使玩家排在上榜条数（`LEADERBOARD_TOP_N`）之外，" +
      "这里也能拿到真实名次。",
  })
  @ApiParam({ name: "board", description: `榜单：${BOARD_LIST}`, enum: [...LEADERBOARD_BOARDS] })
  @ApiDataResponse(LeaderboardSelfDto, { description: "我的名次（未上榜时 rank=0、entry=null）" })
  me(@CurrentUser() user: AuthenticatedUser, @Param("board") board: string): LeaderboardSelfDto {
    return this.leaderboardService.me(this.leaderboardService.assertBoard(board), user.id);
  }

  @Get(":board")
  @ApiPlayerDoc({
    operationId: "leaderboard.page",
    summary: "榜单分页",
    description:
      `\`board\` 取 ${BOARD_LIST}。\n\n` +
      "**排序是固定的**（等级 / 战力 / 击杀各自降序），所以没有 `sort` / `keyword` 参数 —— " +
      "名次一旦能改排序就没有意义了。\n\n" +
      "**并列规则**：同分同名次（竞赛排名，1、2、2、4），同分之间按角色 id 升序，" +
      "两次重算之间次序不抖。\n\n" +
      "**离线也上榜**：榜读的是角色存档，不要求在线。\n\n" +
      "`size` 超过上榜条数（`LEADERBOARD_TOP_N`，默认 100）时会被**夹到上限**而不是报错 —— " +
      "榜本来只有这么长。\n\n" +
      "响应里的 `computedAt` 是这份快照算出来的时刻：榜单默认每分钟重算一次，" +
      "刚升级的玩家最多等一分钟才看到自己往上挪。",
  })
  @ApiParam({ name: "board", description: `榜单：${BOARD_LIST}`, enum: [...LEADERBOARD_BOARDS] })
  @ApiQueryModel(LeaderboardQueryDto)
  @ApiDataResponse(LeaderboardPageDto, { description: "分页结果（list/total/page/size + computedAt）" })
  page(@Param("board") board: string, @Query() query: LeaderboardQueryDto): LeaderboardPageDto {
    return this.leaderboardService.page(this.leaderboardService.assertBoard(board), query);
  }
}
