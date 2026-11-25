import { BadRequestException, Controller, Get, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { SystemService } from "./system.service";
import { SystemInfoDto } from "./dto/system.dto";
import { ConfigSnapshotExportDto, ConfigSnapshotImportResultDto } from "./dto/system.dto";
import { ConfigSnapshotService, MAX_IMPORT_BYTES, importBodyTooLarge } from "./config-snapshot.service";

/**
 * 管理端 · 系统信息（运维自查）
 *
 * `GET /admin/system` 只读，**没有** `@AuditTarget` —— 看自己的运行状态不该造审计。
 * 配置快照的两个接口（#1266）与之同页：导出是只读备份不记审计，导入是整表替换、
 * 由审计拦截器按 operationId 自动留痕。
 */
@ApiAudience("admin")
@Controller("admin/system")
export class AdminSystemController {
  constructor(
    private readonly systemService: SystemService,
    private readonly configSnapshot: ConfigSnapshotService,
  ) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminSystem.info",
    summary: "系统信息",
    description:
      "版本 / Node 版本 / 运行时长 / 内存 / 数据文件路径与体积 / 各表行数 / 脱敏配置快照。\n\n" +
      "**配置快照走白名单**：只有服务端 `CONFIG_SNAPSHOT` 表里登记过的项才会出现，`JWT_SECRET` 与 " +
      "`ADMIN_REGISTER_CODE` 只报「已配置 / 仍是默认值」这类形态，绝不回显原文 —— " +
      "白名单的意义是「将来新增密钥时默认不暴露」，而黑名单要靠人记得去加。\n\n" +
      "`warning: true` 的项是运维该注意的（内置 JWT 密钥未改、CORS 全开）。只读观察员没有 `system:read`。",
    permissions: [Permission.SYSTEM_READ],
  })
  @ApiDataResponse(SystemInfoDto, { description: "系统信息" })
  info(): SystemInfoDto {
    return this.systemService.info();
  }

  //#region 配置快照导入导出（#1266）

  @Get("config-snapshot/export")
  @ApiAdminDoc({
    operationId: "adminSystem.exportConfigSnapshot",
    summary: "导出配置快照",
    description:
      "把当前库的全部配置表序列化成 `config-sync.sql` 的**文件内容**（文本随 JSON 信封返回，前端转 Blob 落盘）。\n\n" +
      "- 内容与 `make config-export` 的产物**完全一致**（同一个脚本生成）：只含配置表，" +
      "账号 / 角色存档 / 审计日志不进文件；\n" +
      "- 导出是**只读**的：服务端在跑也能导（WAL 保证读到已提交的一致状态），不需要停服；\n" +
      "- 拿这份文件可以：留档备份、传到另一台机器 `make config-import`、或在管理端本页导入；\n" +
      "- `tables` / `rows` / `version` 是给界面展示的统计（张数按 DELETE 段数、行数按 INSERT 条数现算）。\n\n" +
      "内存库部署形态（`:memory:`，e2e / 临时环境）没有文件可导，返回 50151 并说明原因。\n\n" +
      "只读备份不记审计（与「系统信息」同一取向）。",
    permissions: [Permission.SYSTEM_READ],
  })
  @ApiDataResponse(ConfigSnapshotExportDto, { description: "快照全文与统计" })
  async exportSnapshot(): Promise<ConfigSnapshotExportDto> {
    return this.configSnapshot.export();
  }

  @Post("config-snapshot/import")
  @AuditTarget("config")
  @ApiAdminDoc({
    operationId: "adminSystem.importConfigSnapshot",
    summary: "导入配置快照",
    description:
      "上传一份 `config-sync.sql` 的**文件内容**（请求体就是 SQL 全文，`Content-Type` 不限），" +
      "整表替换库里的全部配置表。安全语义与 `make config-import` 完全一致（同一个脚本执行）：\n\n" +
      "- **只动配置表**：账号、角色存档、审计日志、世界怪物实例一个字都不碰；\n" +
      "- **导入前自动留档**到 `server/data/backups/config-before-import-<时间>.sql`，导错了指回去就能还原；\n" +
      "- **三道自保**：格式与表清单校验（少一张表就拒绝，否则那张会被清空）、" +
      "版本闸（文件比库旧拒绝）、导入后逐字节读回校验；\n" +
      "- **版本闸拒绝是正常分支**：界面把版本差展示给用户，用户勾「我确认要回退」后带 " +
      "`?force=true` 重试（留档照做，版本号只升不降）；\n" +
      "- **成功后必须重启服务端**：进程内存里的配置覆盖层（运行时参数等）不会自动刷新，" +
      "返回的 `report` 里带脚本自己的这条提醒；\n" +
      "- 导入全程互斥：已有一次导入进行中返回 409（50153）。\n\n" +
      "整表替换全服生效，由审计拦截器按 operationId 自动留痕（targetType `config`）。",
    permissions: [Permission.SYSTEM_WRITE],
  })
  @ApiDataResponse(ConfigSnapshotImportResultDto, { description: "导入脚本的完整输出" })
  async importSnapshot(@Req() request: Request, @Query("force") forceQuery?: string): Promise<ConfigSnapshotImportResultDto> {
    const sql = await readRawBody(request);
    return this.configSnapshot.import(sql, forceQuery === "true");
  }

  //#endregion
}

/**
 * 把请求体按原始文本收下来（导入接口专用）
 *
 * **不走 JSON 解析器**：一份快照 4MB+，express 的 json 解析器默认 100KB 就会把请求
 * 顶回去，放宽全局上限又给所有接口开了口子。这里的请求体是 `text/plain` 直传，
 * json / urlencoded 解析器都不认这个 Content-Type，流原样到得了控制器 —— 自己按块
 * 收、边收边卡体积上限，超限立即断开，不给超大请求留传输时间。
 */
async function readRawBody(request: Request): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  return new Promise<string>((resolve, reject) => {
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_IMPORT_BYTES) {
        request.destroy();
        reject(importBodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", () => reject(new BadRequestException("请求中断，请重新上传")));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim().length === 0) {
        reject(new BadRequestException("上传内容为空 —— 请选择 config-sync.sql 文件后再导入"));
        return;
      }
      resolve(text);
    });
  });
}
