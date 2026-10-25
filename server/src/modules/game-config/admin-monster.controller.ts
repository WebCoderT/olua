import { Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { MONSTER_SORT, sortFieldNames } from "../../database/sort-specs";
import { GameConfigService } from "./game-config.service";
import { MonsterDto, MonsterPageDto, MonsterQueryDto, UpdateMonsterDto } from "./dto/monster.dto";

/**
 * 管理端 · 怪物基础数据（#258）
 *
 * 与称号 / 战魂 / 军衔 / 装备基础件同一取向：**只有 list / update，没有 create / remove** ——
 * 怪物 key 被地图刷怪点 / 掉落表 / 技能引用，清单固定（seed 自客户端 configs/monster 的
 * 220 只），e2e 会固化「POST/DELETE 404」。`tier` 不开放编辑（已展开数值才是结算依据）。
 * **改完即时生效**：世界播种与伤害结算直读 monsters 表（两进程共享同一个 SQLite 文件）。
 * 怪物技能与刷怪点位不在本接口范围（#12 / spawn 属客户端与世界层）；掉落表入口归 #254。
 * 写操作带 `@AuditTarget("monster")`。
 */
@ApiAudience("admin")
@Controller("admin/monsters")
export class AdminMonsterController {
  constructor(private readonly gameConfigService: GameConfigService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminMonster.list",
    summary: "怪物基础数据列表",
    description:
      "key 清单固定（seed 自客户端 configs/monster 的 220 只），**没有创建 / 删除**。" +
      "`keyword` 模糊匹配 key / 名称，`tier` 按定位筛。\n\n" +
      "战斗数值是「monsterStats(level, tier) 打底 + 条目覆盖」的**展开结果**——" +
      "改这里的值即时生效（世界播种与伤害结算直读 monsters 表）；" +
      "`level` 是显示用元数据，改它**不会**重算数值。\n\n" +
      `**排序**：\`sort\` 取 ${sortFieldNames(MONSTER_SORT)}，\`order\` 取 asc / desc（默认等级升序）。`,
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiQueryModel(MonsterQueryDto)
  @ApiDataResponse(MonsterPageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: MonsterQueryDto): PageResult<MonsterDto> {
    return this.gameConfigService.listMonsters(query);
  }

  @Patch(":id")
  @AuditTarget("monster")
  @ApiAdminDoc({
    operationId: "adminMonster.update",
    summary: "编辑怪物基础数据",
    description:
      "**部分更新**：只改请求体里出现的字段。改完即时生效（世界播种与伤害结算直读 monsters 表）——" +
      "已活着的世界实例血量上限沿用出生时的值，重生后用新值。\n\n" +
      "- `label`：名称（头顶名牌）。\n" +
      "- `level`：显示用元数据，改它**不会**重算战斗数值。\n" +
      "- `maxHp`：生命上限（已展开值，≥1）。\n" +
      "- `attributes`：六项攻防区间，**整份提交、整份替换**（0 ≤ min ≤ max）。\n" +
      "- `tier` 不开放编辑（仅作标注，改它不影响已展开数值）。\n" +
      "- `id` 不存在 → 404（`50019`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "怪物 key（configs/monster 的关联键，如 \"1\"）" })
  @ApiDataResponse(MonsterDto, { description: "更新后的怪物基础数据" })
  update(@Param("id") id: string, @Body() dto: UpdateMonsterDto): MonsterDto {
    return this.gameConfigService.updateMonster(id, dto);
  }
}
