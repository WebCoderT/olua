import { Body, Controller, Get, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiPlayerDoc } from "../../common/decorators/api-doc.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { AchievementService } from "./achievement.service";
import { AchievementClaimResultDto, AchievementIdDto, MyAchievementsDto } from "./dto/achievement.dto";

/**
 * 客户端 · 成就（#401）
 *
 * 只有两个动作：查 / 领。**没有「上报进度」的口子** —— 累计型进度由事件流
 * （击杀结算、任务交付）在服务端记账，状态型（等级 / 战力 / 持有）每次查询现算。
 */
@Controller("achievements")
export class AchievementController {
  constructor(private readonly achievementService: AchievementService) {}

  @Get("me")
  @ApiPlayerDoc({
    operationId: "achievement.mine",
    summary: "我的成就快照",
    description:
      "全量成就配置 + 当前角色的状态（含未达成的）。`progress` 已按门槛钳制、" +
      "`target` 直接给客户端免查快照。\n\n" +
      "累计型（kill / quest）的进度由服务端事件记账；状态型（level / combat / collect）" +
      "每次查询现算 —— 所以「角色升到 10 级」这类成就不需要任何同步动作就会自己变达成。",
  })
  @ApiDataResponse(MyAchievementsDto, { description: "成就快照 + 统计" })
  mine(@CurrentUser() user: AuthenticatedUser): MyAchievementsDto {
    return this.achievementService.mine(user.id);
  }

  @Post("claim")
  @HttpCode(HttpStatus.OK)
  @ApiPlayerDoc({
    operationId: "achievement.claim",
    summary: "领取成就奖励",
    description:
      "未达成 → 50132；已领过 → 50133；成就不存在 → 50131。\n\n" +
      "发奖走与任务交付同一个入口（金币 / 经验 / 物品一次落库）。" +
      "**背包放不下 → 20012，且不消耗领取资格** —— 清包后可以再领。",
  })
  @ApiDataResponse(AchievementClaimResultDto, { description: "领取后的快照 + 本次奖励" })
  claim(@CurrentUser() user: AuthenticatedUser, @Body() dto: AchievementIdDto): AchievementClaimResultDto {
    return this.achievementService.claim(user.id, dto.achievementId);
  }
}
