import { Body, Controller, Get, Patch } from "@nestjs/common";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { GuideSettingsService } from "./guide-settings.service";
import { GuideStepsDto, UpdateGuideStepsDto } from "./dto/guide.dto";

/**
 * 管理端 · 新手引导步骤（#605）
 *
 * 一张有序的小表（出厂 6 步、上限 64 步）：**整份读、整份写**。
 * 引导的推进逻辑与进度都在客户端 / 角色存档里，服务端不参与 ——
 * 这里改的是「引导这张表长什么样」，改完玩家下次进游戏拉配置快照时生效。
 *
 * 写操作带 `@AuditTarget("guideSteps")`：改一句新手文案看着无害，但它是所有新玩家的
 * 第一屏体验，出事要能追溯是谁在什么时候改的。
 */
@ApiAudience("admin")
@Controller("admin/guide-steps")
export class AdminGuideController {
  constructor(private readonly guideSettingsService: GuideSettingsService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminGuide.get",
    summary: "新手引导步骤",
    description:
      "整份步骤表（数组顺序 = 体验顺序）+ 最后修改时间（**单行配置，没有分页**）。\n\n" +
      "`spot` / `trigger` 的取值是**客户端能力白名单**：一个新的高亮位要 `GuideOverlay` 认识这个节点，\n" +
      "一个新的推进事件要在玩法代码里 `notify` 一次 —— 所以它们不能凭运营自由填写。\n\n" +
      "缺行 / 坏行回落出厂值（`shared/guide-seed.ts`），坏行会被丢弃（好行保留）。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiDataResponse(GuideStepsDto, { description: "当前步骤表（含 updatedAt）" })
  get(): GuideStepsDto {
    return this.guideSettingsService.get();
  }

  @Patch()
  @AuditTarget("guideSteps")
  @ApiAdminDoc({
    operationId: "adminGuide.update",
    summary: "编辑新手引导步骤",
    description:
      "**整份替换**：提交的数组就是新的步骤表（顺序即体验顺序），不是增量。\n\n" +
      "约束：至少 1 步、最多 64 步（存档里的步数上限也是它）；`id` 唯一且以小写字母开头；\n" +
      "标题 1~20 字、正文 1~200 字；`spot` / `trigger` 必须在客户端白名单内。\n\n" +
      "任何一步不合法 → 40000 且**整份不落库**（半份步骤表会让玩家卡在某一步推进不了）。\n\n" +
      "改完玩家下次进游戏拉配置快照后生效；引导进度（走到第几步）不受影响。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiDataResponse(GuideStepsDto, { description: "更新后的步骤表" })
  update(@Body() dto: UpdateGuideStepsDto): GuideStepsDto {
    return this.guideSettingsService.update(dto);
  }
}
