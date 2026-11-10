import { Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { ConfigRevisionService } from "./config-revision.service";
import { ConfigVersionService } from "./config-version.service";
import {
  ConfigRestoreResultDto,
  ConfigRevisionDiffDto,
  ConfigRevisionListDto,
  ConfigRevisionQueryDto,
  ConfigVersionDto,
} from "./dto/config-revision.dto";

/**
 * 管理端 · 配置版本与回滚（#881 / #882）
 *
 * ===========================================================================
 * 这里回答的是「改错了怎么办」
 * ===========================================================================
 * 以前只有一个答案：照着 `audit_logs` 的 detail 一条条手工改回去（一次改 50 个字段
 * 就是 50 条日志，等于重做一遍）。现在多了两个：
 *
 * - **看清**：`revisions` 列表（谁 / 什么时候 / 改了什么接口 / 多大）+ 两层之间的逐表 diff；
 * - **回去**：`restore` 一键把 38 张配置表整体写回某一层，**单事务**。
 *
 * 回滚本身也是一层新版本（版本号继续往前、旧的层不删），所以「回滚错了」还能再滚回来。
 *
 * ## 为什么单列 `config:restore`
 *
 * 回滚是「一次改 38 张表」，敏感度高于任何单表写权限（`gameConfig:write` 改一行）。
 * 想让某人只能微调数值、不能整体回退时，这一条就是闸。
 *
 * ## 缓存
 *
 * 回滚后版本 +1 → 快照缓存（`ClientConfigService.snapshot()` 按版本失效）下一跳就是新值，
 * 不用重启进程；客户端靠 `ETag` / `GET /game-config/version` 自己发现变了。
 */
@ApiAudience("admin")
@Controller("admin/config")
export class AdminConfigController {
  constructor(
    private readonly versions: ConfigVersionService,
    private readonly revisions: ConfigRevisionService,
  ) {}

  @Get("version")
  @ApiAdminDoc({
    operationId: "adminConfig.version",
    summary: "当前配置版本",
    description:
      "与玩家侧 `GET /game-config/version` 同一个数字：每次管理端写配置成功 +1。\n\n" +
      "管理端用它做「我看到的页面是不是最新」的判断（另一个管理员改完之后这里会变）。",
    permissions: [Permission.CONFIG_READ],
  })
  @ApiDataResponse(ConfigVersionDto, { description: "当前配置版本" })
  version(): ConfigVersionDto {
    return ConfigVersionDto.of(this.versions.current());
  }

  @Get("revisions")
  @ApiAdminDoc({
    operationId: "adminConfig.revisions",
    summary: "配置版本历史（最近 N 层）",
    description:
      "按版本号倒序。每层是一份**全量配置**（38 张表），所以列表只回元信息 + 行数，不回 payload。\n\n" +
      "`label` 是触发这次改动的接口标识（如 `adminSkill.update`）；`createdBy` 是操作人。\n" +
      "同一人 `CONFIG_REVISION_THROTTLE_MS`（默认 10 秒）内的连点会合并成一层。\n\n" +
      "默认保留 20 层（`CONFIG_REVISION_RETAIN`），超出删最老的。",
    permissions: [Permission.CONFIG_READ],
  })
  @ApiQueryModel(ConfigRevisionQueryDto)
  @ApiDataResponse(ConfigRevisionListDto, { description: "版本列表（最新在前）" })
  list(@Query() query: ConfigRevisionQueryDto): ConfigRevisionListDto {
    return this.revisions.list(query.limit ?? 20);
  }

  @Get("revisions/:from/diff/:to")
  @ApiAdminDoc({
    operationId: "adminConfig.diff",
    summary: "两个版本之间的差异（按表统计行数）",
    description:
      "只回**有变化的表**：每张表的行数变化、新增行数、删除行数。\n\n" +
      "**行级不是字段级**：payload 是不透明 JSON，没有可靠的主键可用 —— 改一行会体现成「一删一加」。\n" +
      "这样至少绝不谎报「这张表没变」（字段级 diff 需要给 38 张表各写一套主键定义，收益不抵成本）。",
    permissions: [Permission.CONFIG_READ],
  })
  @ApiParam({ name: "from", description: "旧版本号" })
  @ApiParam({ name: "to", description: "新版本号" })
  @ApiDataResponse(ConfigRevisionDiffDto, { description: "逐表差异" })
  diff(@Param("from") from: string, @Param("to") to: string): ConfigRevisionDiffDto {
    return this.revisions.diff(versionParam(from, "from"), versionParam(to, "to"));
  }

  @Post("revisions/:version/restore")
  @AuditTarget("config")
  @ApiAdminDoc({
    operationId: "adminConfig.restore",
    summary: "回滚到某一版（单事务全量恢复）",
    description:
      "把这一层的**全量配置**写回库里：38 张配置表逐表 `DELETE` + 逐行 `INSERT`，**一个事务** ——\n" +
      "要么全回去，要么一行不动。外键检查推到提交时（`defer_foreign_keys`），所以中途状态合法。\n\n" +
      "- 只写配置表（`config-tables.cjs` 的白名单）；payload 里有、库里没有的表**跳过并告警**，不做结构迁移；\n" +
      "- 只写 payload 与当前表结构**交集**的列 —— 加过列的老版本也能回；\n" +
      "- 回滚本身是**一层新版本**（版本 +1、历史不删），所以回滚错了还能再滚回来；\n" +
      "- **不踢人**：服务端读库，下一跳就是旧值；客户端在下一个安全点换表。\n\n" +
      "权限点单列（`config:restore`）：这是「一次改 38 张表」，不是普通数值微调。",
    permissions: [Permission.CONFIG_RESTORE],
  })
  @ApiParam({ name: "version", description: "要回到的版本号" })
  @ApiDataResponse(ConfigRestoreResultDto, { description: "回滚结果（新版本号 / 恢复的表与行数 / 跳过的表）" })
  restore(@Param("version") version: string, @CurrentUser() user: AuthenticatedUser): ConfigRestoreResultDto {
    return this.revisions.restore(versionParam(version, "version"), { id: user.id, username: user.username });
  }
}

/** 路径里的版本号：非数字 / 负数直接 400（别让它变成 SQL 参数里的 NaN） */
function versionParam(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new BizException(BizCode.PARAM_INVALID, `${name} 必须是非负整数（收到 ${raw}）`);
  }
  return value;
}
