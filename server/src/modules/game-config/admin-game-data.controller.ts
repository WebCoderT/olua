import { Controller, Get } from "@nestjs/common";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { Permission } from "../../common/constants/permission";
import { ClientConfigService } from "./client-config.service";
import { GameConfigSnapshotDto } from "./dto/client-config.dto";

/**
 * 管理端 · 游戏数据字典（#655）
 *
 * ===========================================================================
 * 为什么需要这个接口
 * ===========================================================================
 * 管理端有大量「同步渲染」的查表：角色详情里背包那件装备叫什么、掉落条目引用的是
 * 哪只怪、实体选择器的下拉清单有哪几个物品……这些名字以前来自**生成物**
 * （`server/src/shared/game-data.generated.ts`），于是「代码里躺着第二份数据」——
 * 改一个名字要重新生成、忘记重生成就与库里对不上。
 *
 * #655 起唯一权威是数据库，于是管理端改成：登录后（`Layout` 挂载时）拉一次这份字典，
 * 之后同步查表（`admin/src/api/gameData.ts`）。**返回的就是客户端拿的那份快照**
 * ——同一份 `ClientConfigService.snapshot()`，不是另写一套拼装逻辑，所以
 * 「管理端看到的名字」与「客户端看到的名字」天然一致，不会各拼一份。
 *
 * 与 `GET /game-config` 的差别只有两点，都在鉴权层：
 * - 路径在 `/admin/` 下，走管理员令牌 + `gameConfig:read` 权限点（客户端那份要玩家令牌）；
 * - 文档归类为管理端（`@ApiAudience("admin")`）。
 *
 * 数据量约 1MB（555 件装备变体是大头）。只读、无副作用、无参数，前端缓存到会话结束。
 */
@ApiAudience("admin")
@Controller("admin/game-data")
export class AdminGameDataController {
  constructor(private readonly clientConfig: ClientConfigService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminGameData.snapshot",
    summary: "游戏数据字典（管理端查表用）",
    description:
      "与 `GET /game-config` **同一份快照**：称号 / 战魂 / 军衔 / 装备变体 / 药品 / 物品 / 怪物 / " +
      "怪物表现 / NPC / 时装 / 技能 / 状态 / 任务 / 成就 / 地图 / 等级表 / 成长标量 / 商城价 / 掉落表。\n\n" +
      "管理端登录后拉一次存内存，用于「角色背包里那件装备叫什么」「掉落引用了哪只怪」这类" +
      "**同步查表**的展示；名字与 id 都来自数据库，代码里不再有第二份数据副本。\n\n" +
      "只读、无副作用、无参数。数据量约 1MB（555 件装备变体是大头），不要在每次渲染时调用。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiDataResponse(GameConfigSnapshotDto, { description: "全部运营配置（与客户端快照同形）" })
  snapshot(): GameConfigSnapshotDto {
    return this.clientConfig.snapshot();
  }
}
