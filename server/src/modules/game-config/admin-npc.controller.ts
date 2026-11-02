import { Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { NPC_SORT, sortFieldNames } from "../../database/sort-specs";
import { GameConfigService } from "./game-config.service";
import { NpcDto, NpcPageDto, NpcQueryDto, UpdateNpcDto } from "./dto/npc.dto";

/**
 * 管理端 · NPC 基础数据（#258）
 *
 * 与称号 / 战魂 / 军衔 / 装备基础件同一取向：**只有 list / update，没有 create / remove** ——
 * NPC id 被 Tiled 地图对象组引用，清单固定（seed 自服务端 `npc-seed.ts` 的 21 个），
 * e2e 会固化「POST/DELETE 404」。
 *
 * #603 第七域起**客户端不再存 NPC 的任何显示数据**（此前 `configs/npc-data.ts` 有一份）：
 * 名称 / 素材目录 / 缩放 / 偏移全部在这里改，进游戏由 `GET /game-config` 的 `npcs` 段下发。
 * 只留点击行为（弹哪个窗）在客户端 `configs/npcClicks`，那是 UI 组件、不能进库。
 * `dialog` 对话文案 seed 为空串（客户端暂无对话数据形态），在这里运营可改（#248/#249）。
 * 写操作带 `@AuditTarget("npc")`。
 */
@ApiAudience("admin")
@Controller("admin/npcs")
export class AdminNpcController {
  constructor(private readonly gameConfigService: GameConfigService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminNpc.list",
    summary: "NPC 基础数据列表",
    description:
      "id 清单固定（seed 自服务端 npc-seed 的 21 个），**没有创建 / 删除**。" +
      "`keyword` 模糊匹配 id / 名称。\n\n" +
      "`src` / `scaleX` / `scaleY` / `posX` / `posY` 是外观（素材目录 + 缩放 + 偏移）：" +
      "客户端不再存这份数据，改完下次进游戏由配置快照整表重建。\n\n" +
      "`dialog` 是对话文案列：客户端目前没有对话数据形态（都写死在弹窗组件里），seed 为空串，" +
      "在这里运营可改，客户端消费等对接。\n\n" +
      `**排序**：\`sort\` 取 ${sortFieldNames(NPC_SORT)}，\`order\` 取 asc / desc（默认 id 升序）。`,
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiQueryModel(NpcQueryDto)
  @ApiDataResponse(NpcPageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: NpcQueryDto): PageResult<NpcDto> {
    return this.gameConfigService.listNpcs(query);
  }

  @Patch(":id")
  @AuditTarget("npc")
  @ApiAdminDoc({
    operationId: "adminNpc.update",
    summary: "编辑 NPC 基础数据",
    description:
      "**部分更新**：只改请求体里出现的字段。\n\n" +
      "- `label`：名称（≤50 字）。\n" +
      "- `dialog`：对话文案（空串 = 清空；≤2000 字）。\n" +
      "- `src`：素材目录（resources 相对路径；空串 = 该 NPC 不显示）。\n" +
      "- `scaleX` / `scaleY`：缩放（0.1~10，1 = 原尺寸）。\n" +
      "- `posX` / `posY`：偏移（像素，±4000，0 = 不偏移）。\n" +
      "- `id` 不存在 → 404（`50020`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "NPC id（如 \"0002\"）" })
  @ApiDataResponse(NpcDto, { description: "更新后的 NPC 基础数据" })
  update(@Param("id") id: string, @Body() dto: UpdateNpcDto): NpcDto {
    return this.gameConfigService.updateNpc(id, dto);
  }
}
