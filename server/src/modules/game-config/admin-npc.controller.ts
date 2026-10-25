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
 * NPC id 被 Tiled 地图对象组引用，清单固定（seed 自客户端 configs/npc-data 的 21 个），
 * e2e 会固化「POST/DELETE 404」。外观资源（src / scale / position）与点击行为是表现层
 * 配置，不进服务端；`dialog` 对话文案 seed 为空串（客户端暂无对话数据形态），
 * 在这里运营可改，客户端消费等对接（#248/#249）。写操作带 `@AuditTarget("npc")`。
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
      "id 清单固定（seed 自客户端 configs/npc-data 的 21 个），**没有创建 / 删除**。" +
      "`keyword` 模糊匹配 id / 名称。\n\n" +
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
      "- `label`：名称。\n" +
      "- `dialog`：对话文案（空串 = 清空；≤2000 字）。\n" +
      "- `id` 不存在 → 404（`50020`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "NPC id（如 \"0002\"）" })
  @ApiDataResponse(NpcDto, { description: "更新后的 NPC 基础数据" })
  update(@Param("id") id: string, @Body() dto: UpdateNpcDto): NpcDto {
    return this.gameConfigService.updateNpc(id, dto);
  }
}
