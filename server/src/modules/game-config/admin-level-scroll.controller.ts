import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { LEVEL_SCROLL_LEVEL_MAX, LEVEL_SCROLL_LEVEL_MIN } from "../../common/constants/level-scrolls";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { LEVEL_SCROLL_SORT, sortFieldNames } from "../../database/sort-specs";
import { GameConfigService } from "./game-config.service";
import {
  CreateLevelScrollDto,
  LevelScrollDto,
  LevelScrollPageDto,
  LevelScrollQueryDto,
  RemoveLevelScrollResultDto,
  UpdateLevelScrollDto,
} from "./dto/level-scroll.dto";

/**
 * 管理端 · 升级卷轴（#787）
 *
 * 背包里「使用后硬性 +1 级」的道具，**带等级区间**：Lv1 只在 1~999 级可用，
 * 用完正好到 1000 级 —— 再要升就得换 Lv2（出厂 7 卷覆盖 1~6999）。
 *
 * 与货币道具同一取向：**完整的增删改**。「分多少段等级」是运营自己的事
 * （等级上限调大之后要跟着开新卷），卷轴也不被掉落表按 id 固定引用。
 *
 * 使用行为的权威在服务端（`RolesService.useLevelScroll`）：客户端只说「用背包哪一格」，
 * 区间与 +1 都由服务端判 —— 改包跳过客户端预检也没用。
 *
 * 写操作带 `@AuditTarget("levelScroll")`；资源路径（icon）由运营手填，
 * `audit-resource-refs` 会逐条核对磁盘上有没有那张图。
 */
@ApiAudience("admin")
@Controller("admin/level-scrolls")
export class AdminLevelScrollController {
  constructor(private readonly gameConfigService: GameConfigService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminLevelScroll.list",
    summary: "升级卷轴列表",
    description:
      "出厂 7 卷：Lv1（1~999）/ Lv2（1000~1999）/ … / Lv7（6000~6999）。`keyword` 模糊匹配 id / 名称 / 描述。\n\n" +
      "**区间是两列可改的数**（`minLevel` / `maxLevel`），「每 1000 级换一卷」只是出厂切法 —— " +
      "运营完全可以开一卷「500~800」的怪卷，也可以两卷重叠（不会报错，只会有两卷都能用）。\n\n" +
      "`sellPrice` 是回收价（0 = 不可回收），**商城上架归商城定价管理**，不在这里。\n\n" +
      `**排序**：\`sort\` 取 ${sortFieldNames(LEVEL_SCROLL_SORT)}，\`order\` 取 asc / desc（默认按等级下限升序）。`,
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiQueryModel(LevelScrollQueryDto)
  @ApiDataResponse(LevelScrollPageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: LevelScrollQueryDto): PageResult<LevelScrollDto> {
    return this.gameConfigService.listLevelScrolls(query);
  }

  @Post()
  @AuditTarget("levelScroll")
  @ApiAdminDoc({
    operationId: "adminLevelScroll.create",
    summary: "新建升级卷轴（一段等级一卷）",
    description:
      "**只填等级区间就能建**：`id` / 名称 / 描述 / 图标都可省 —— 区间正好落在出厂切法" +
      "（1~999 / 1000~1999 / …）时派生 `level_scroll_<卷号>`，否则派生 `level_scroll_<下限>_<上限>`。\n\n" +
      `- \`minLevel\` / \`maxLevel\` 取值 ${LEVEL_SCROLL_LEVEL_MIN} ~ ${LEVEL_SCROLL_LEVEL_MAX}，且下限不能大于上限（否则 400 / 40000）。\n` +
      "- `id` 手填撞已有行 → 409（`50044`）—— 同一个 id 指到哪一卷就说不清了。\n" +
      "- `icon` 是 resources 相对路径（不带扩展名），素材放 `client/assets/resources/item/scroll/`。\n\n" +
      "建完客户端下次拉快照就能在背包里看到并使用了。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiDataResponse(LevelScrollDto, { description: "新建的升级卷轴" })
  create(@Body() dto: CreateLevelScrollDto): LevelScrollDto {
    return this.gameConfigService.createLevelScroll(dto);
  }

  @Patch(":id")
  @AuditTarget("levelScroll")
  @ApiAdminDoc({
    operationId: "adminLevelScroll.update",
    summary: "编辑升级卷轴",
    description:
      "**部分更新**：只改请求体里出现的字段。\n\n" +
      "- `minLevel` / `maxLevel`：可用等级区间 —— **改完立刻生效**（使用结算读库，不读快照）。" +
      "只改一个也会按「合成后的区间」校验，下限大于上限 → 400（`40000`）。\n" +
      "- `label` / `description` / `icon`：文案与图标。\n" +
      "- `maxStack` / `sellPrice`：堆叠上限 / 回收价（0 = 不可回收）。\n" +
      "- **`id` 不可改**（路径参数就是主键）：改 id 等于换一件物品，玩家背包里的旧 id 会全变成认不出的格子。\n" +
      "- `id` 不存在 → 404（`50043`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "升级卷轴 id（如 level_scroll_1）" })
  @ApiDataResponse(LevelScrollDto, { description: "更新后的升级卷轴" })
  update(@Param("id") id: string, @Body() dto: UpdateLevelScrollDto): LevelScrollDto {
    return this.gameConfigService.updateLevelScroll(id, dto);
  }

  @Delete(":id")
  @AuditTarget("levelScroll")
  @ApiAdminDoc({
    operationId: "adminLevelScroll.delete",
    summary: "删除升级卷轴",
    description:
      "只删配置行。**不碰玩家存档**：背包里还引用这个 id 的格子会变成「认不出的道具」——" +
      "客户端与结算都只是安静跳过（用不了，也不报错）。\n\n" +
      "`id` 不存在 → 404（`50043`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "升级卷轴 id（如 level_scroll_7）" })
  @ApiDataResponse(RemoveLevelScrollResultDto, { description: "删掉了几行" })
  remove(@Param("id") id: string): RemoveLevelScrollResultDto {
    return this.gameConfigService.removeLevelScroll(id);
  }
}
