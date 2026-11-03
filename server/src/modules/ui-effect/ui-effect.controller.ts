import { Body, Controller, Get, Param, Patch } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permission } from "../../common/constants/permission";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { SaveUiEffectDto, UiEffectDto, UiEffectListDto } from "./dto/ui-effect.dto";
import { UiEffectService } from "./ui-effect.service";

/**
 * 管理端 · 特效管理（#594 升级特效 / #634 掉落光效）
 *
 * 管的是特效的**表现参数**（摆位 / 缩放 / 旋转 / 时长 / 开关），与武器外观同一套取向。
 * 图集本体在客户端资源包里（`effect/<key>/<key>.plist`，资源路径不入库），所以
 * **没有 POST / DELETE**（e2e 固化它们 404）：一个特效 key 存在的前提是客户端有消费代码，
 * 后台凭空建一行只会得到一个永远不生效的开关。后续加特效（如「物品掉落在地图上的特效」）
 * = 客户端写消费代码 + `UI_EFFECT_KEYS` 登记 + `UI_EFFECT_DEFAULTS` 给出厂值，页面自动多一行。
 */
@ApiAudience("admin")
@Controller("admin/ui-effects")
export class AdminUiEffectController {
  constructor(private readonly uiEffectService: UiEffectService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminUiEffect.list",
    summary: "特效列表",
    description:
      "全部特效的表现参数：摆位 / 缩放 / 旋转 / 时长 / 开关 + 追账字段。\n\n" +
      "行由启动 seed 按 `UI_EFFECT_DEFAULTS` 补出来，**没有新建 / 删除接口** ——\n" +
      "key 的取值域由客户端的消费代码决定（升级特效 `upgrade` + 掉落光效 `light_1`…`light_6`）。\n\n" +
      "不分页，按 seed 顺序（= `UI_EFFECT_KEYS` 的登记顺序，升级特效在最前）返回。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiDataResponse(UiEffectListDto, { description: "特效列表（total / list）" })
  list(): UiEffectListDto {
    return this.uiEffectService.list();
  }

    // 路由参数必须是 :id —— @AuditTarget("uiEffect") 的 targetId 取 request.params?.id（审计拦截器口径）
  @Patch(":id")
  @AuditTarget("uiEffect")
  @ApiAdminDoc({
    operationId: "adminUiEffect.save",
    summary: "保存特效的表现参数（整份覆盖）",
    description:
      "改的是**表现参数**：摆位偏移 / 横纵缩放 / 旋转 / 一轮时长 / 开关。保存后立刻生效 ——\n" +
      "配置快照每次查表，客户端下次触发特效（升级、掉落光柱）就按新参数演，不用重打客户端包。\n\n" +
      "- **整份覆盖**，不是部分更新：一个特效的参数是联动的一组状态，分字段更新会留下上一次的其它字段；\n" +
      "- `enabled = false` 时客户端**不创建**特效节点（不是播一次空的）；\n" +
      "- 图集路径不在这里：那是客户端资源约定（升级 `effect/<key>/<key>.plist`、掉落光效\n" +
      "  `effect/light/<key>.plist`），换美术要换资源重发包。\n\n" +
      "key 不存在 → 404（`50145`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "特效 key（升级特效 upgrade、掉落光效 light_1~light_6）" })
  @ApiDataResponse(UiEffectDto, { description: "保存后的特效配置（含追账字段）" })
  save(@Param("id") key: string, @Body() dto: SaveUiEffectDto, @CurrentUser() actor: AuthenticatedUser): UiEffectDto {
    return this.uiEffectService.save(key, dto, actor);
  }
}
