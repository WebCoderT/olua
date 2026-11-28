import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
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
import { CreateNpcDto, NpcDto, NpcPageDto, NpcQueryDto, UpdateNpcDto } from "./dto/npc.dto";

/**
 * 管理端 · NPC 基础数据（#258 / #1379 起支持手动增删）
 *
 * 建 / 删 / 改都走这里（id 手填，保留分段命名习惯；删除前查地图点位与任务引用）。
 * 出厂数据由出厂快照 seed 落库（见 `config-sync.sql` 的 npcs 段），运营新建的行混在同一张表里。
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

  @Post()
  @AuditTarget("npc")
  @ApiAdminDoc({
    operationId: "adminNpc.create",
    summary: "新建 NPC（id 手填）",
    description:
      "运营手动加一行 NPC（#1379）：`id` 手填（字母 / 数字 / 下划线 / 短横线，1~32 位），保留 0002 / 1001 / 9002 这类分段命名习惯。\n\n" +
      "- 同名 id → 409（`50048`）。\n" +
      "- `label` 必填；`dialog` / `src` 缺省空串，缩放缺省 1、偏移缺省 0。\n" +
      "- 建完在「地图管理」把该 NPC 点放到图上，客户端下次进图由快照取到。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiDataResponse(NpcDto, { description: "新建后的 NPC 基础数据" })
  create(@Body() dto: CreateNpcDto): NpcDto {
    return this.gameConfigService.createNpc(dto);
  }

  @Get()
  @ApiAdminDoc({
    operationId: "adminNpc.list",
    summary: "NPC 基础数据列表",
    description:
      "清单含出厂 seed 行与运营手动新建的行（#1379）。" +
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
      "- `feature`：入口功能绑定（#1369，不传则不改；空串 = 解绑；`title` 称号 / `soul` 战魂 / `rank` 军衔）。" +
      "绑上后客户端点击该 NPC 直开对应弹窗；同功能在别的 NPC 上的绑定自动清掉（一个功能同时只挂一个 NPC）。\n" +
      "- `id` 不存在 → 404（`50020`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "NPC id（如 \"0002\"）" })
  @ApiDataResponse(NpcDto, { description: "更新后的 NPC 基础数据" })
  update(@Param("id") id: string, @Body() dto: UpdateNpcDto): NpcDto {
    return this.gameConfigService.updateNpc(id, dto);
  }

  @Delete(":id")
  @AuditTarget("npc")
  @ApiAdminDoc({
    operationId: "adminNpc.delete",
    summary: "删除 NPC（有引用则拒绝）",
    description:
      "删一行 NPC（#1379）。**还有地图点位或任务引用 → 409（`50049`）**，提示先去对应页删干净；" +
      "不连带删引用、不碰玩家任务进度。无引用时删除成功，返回被删的那一行。\n\n" +
      "注意：`npcs` 是配置快照整表导入的表——若之后导入了还含这个 id 的旧快照，它会被带回来（与其它可增删配置表一致）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "NPC id（如 \"9003\"）" })
  @ApiDataResponse(NpcDto, { description: "被删掉的 NPC 基础数据" })
  remove(@Param("id") id: string): NpcDto {
    return this.gameConfigService.removeNpc(id);
  }
}
