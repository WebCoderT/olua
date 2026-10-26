import { Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import {
  SKILL_CATEGORY_LABELS,
  SKILL_OWNER_LABELS,
  SKILL_OWNER_VALUES,
  SKILL_TARGET_TYPE_LABELS,
} from "../../common/constants/game-config";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { SKILL_SORT, sortFieldNames } from "../../database/sort-specs";
import { GameConfigService } from "./game-config.service";
import { SkillDto, SkillPageDto, SkillQueryDto, UpdateSkillDto } from "./dto/skill.dto";

/** 归属 / 分类 / 目标类型的中文对照（写进接口文档，省得前端再抄一份） */
const LABEL_HINT =
  `owner：${SKILL_OWNER_VALUES.map((value) => `${value}（${SKILL_OWNER_LABELS[value as "role" | "monster"]}）`).join(" / ")}；` +
  `category：${Object.entries(SKILL_CATEGORY_LABELS).map(([key, label]) => `${key}（${label}）`).join(" / ")}；` +
  `targetType：${Object.entries(SKILL_TARGET_TYPE_LABELS).map(([key, label]) => `${key}（${label}）`).join(" / ")}。`;

/**
 * 管理端 · 技能配置（#367）
 *
 * **角色与怪物同一张表**，`owner` 区分、可筛选 —— 技能对两边完全同构（一个动作 + 一套倍率，
 * 或一段状态），分表只会让「同一个技能既给人又给怪」变成复制两份、还必然漂移。
 *
 * 与称号 / 装备 / 怪物同一取向：**只有 list / update，没有 create / remove** ——
 * 角色技能 id 被技能栏 / 快捷键 / 角色存档引用，行清单固定在生成物里。
 * 怪物技能的可增删随 #12 主体那一刀开（同表 `owner=monster`），不在这个入口放行。
 * 写操作带 `@AuditTarget("skill")`。
 */
@ApiAudience("admin")
@Controller("admin/skills")
export class AdminSkillController {
  constructor(private readonly gameConfigService: GameConfigService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminSkill.list",
    summary: "技能配置列表",
    description:
      "角色与怪物同一张表，用 `owner` 筛选。\n\n" +
      `${LABEL_HINT}\n\n` +
      "`keyword` 模糊匹配 id / 技能名。\n\n" +
      `**排序**：\`sort\` 取 ${sortFieldNames(SKILL_SORT)}，\`order\` 取 asc / desc（默认 id 数值升序）。`,
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiQueryModel(SkillQueryDto)
  @ApiDataResponse(SkillPageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: SkillQueryDto): PageResult<SkillDto> {
    return this.gameConfigService.listSkills(query);
  }

  @Patch(":id")
  @AuditTarget("skill")
  @ApiAdminDoc({
    operationId: "adminSkill.update",
    summary: "编辑技能配置",
    description:
      "**部分更新**：只改请求体里出现的字段。\n\n" +
      "- `damageCoefficients`：**整份替换**（下标 = 技能等级 - 1）；状态型技能可为空数组，主动技能至少一条。\n" +
      "- `statusId`：释放成功后给自己挂的状态；**状态型技能（category=2）必填**，其它分类填了也生效（回蓝 / 回血类同理）。\n" +
      "- `castLockMs`：释放动作锁时长，0 = 跟动画时长走；调大 = 出手后硬直更久（本次施法期间锁移动由动作锁统一保证）。\n" +
      "- `requireTarget`：关掉后自身 / 状态型技能不再要求选中目标。\n" +
      "- `owner` 与 `id` **不可改**（行身份）；`id` 不存在 → 404（`50029`）；`statusId` 不存在 → 404（`50030`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "技能 id（如 \"1000\"）" })
  @ApiDataResponse(SkillDto, { description: "更新后的技能配置" })
  update(@Param("id") id: string, @Body() dto: UpdateSkillDto): SkillDto {
    return this.gameConfigService.updateSkill(id, dto);
  }
}
