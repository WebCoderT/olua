import { Body, Controller, Get, Patch, Post } from "@nestjs/common";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { EquipmentAppearanceService } from "./equipment-appearance.service";
import {
  AppearanceResourceScanDto,
  AppearanceResourceSyncDto,
  EquipmentBorderDto,
  UpdateEquipmentBorderDto,
} from "./dto/equipment-appearance.dto";

/**
 * 管理端 · 装备边框（#695 出端点、#699 拆成独立页面的半边）
 *
 * 装备边框 = 背包格子 / 身上装备槽的物品图标上那圈品质光效框。
 * 「哪个前后缀组合用哪个边框」「哪件特殊装备单独用哪个」是**运营内容**：
 * 这里整边读、整边写（棋盘 + 自定义表是一体的），**背景那半边不受影响** ——
 * 边框页与背景页可以各自独立保存、互不覆盖（#699 拆分的动机）。
 *
 * 每条数据可带 `effect`（#700）：以边框素材第一帧为基准的位置偏移与尺寸倍率，
 * 不传 = 客户端默认适配（contain 缩进 56×56 外框、中心对齐图标）。
 *
 * ## 改的是什么、不改的是什么
 * - **改**：哪个组合 / 哪件特殊装备用哪个边框 key、显示效果；
 * - **不改**：素材本体（客户端资源包 `resources/borders`）与资源清单
 *   （哪些 sfx 编号存在，两端资源约定，客户端有与磁盘一一对应的守卫）。
 *   服务端不校验素材存在 —— 填了不存在的 key，客户端安静跳过（那个品质没边框）。
 *
 * ## 生效时机
 * 玩家下次进游戏拉配置快照（`equipmentAppearance` 段）时重建映射。
 */
@ApiAudience("admin")
@Controller("admin/equipment-borders")
export class AdminEquipmentBorderController {
  constructor(private readonly equipmentAppearanceService: EquipmentAppearanceService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminEquipmentBorder.get",
    summary: "装备边框配置",
    description:
      "边框这半边 + 最后修改时间（**单行配置，没有分页**）：\n\n" +
      "- `assignments`：前后缀组合 → 边框 key，**恰好覆盖当前档数的每种组合**、各一条\n" +
      "  （档数可在「装备配置」页的前后缀弹窗里增删，出厂 5 前缀 × 3 后缀 = 15 格）；\n" +
      "- `customs`：特殊装备 → 边框 key（装备写变体 id 只影响那一个变体，写基础件 key\n" +
      "  影响其全部变体；**优先于**棋盘）。\n\n" +
      "每条可带 `effect`（x/y 偏移 + scale 倍率，#700），不传 = 默认适配结果。\n" +
      "key 指向客户端资源包里的素材（如 border-30123），素材长什么样见客户端\n" +
      "`tools/border-preview.png`（编号索引图）。服务端只校验 key 格式，**不校验素材存在**。\n\n" +
      "缺行 / 坏数据：映射表整份回落出厂映射、自定义表坏条目丢弃（effect 坏只丢效果），均有日志可查。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiDataResponse(EquipmentBorderDto, { description: "当前装备边框配置（含 updatedAt）" })
  get(): EquipmentBorderDto {
    return this.equipmentAppearanceService.getBorder();
  }

  @Patch()
  @AuditTarget("equipmentAppearance")
  @ApiAdminDoc({
    operationId: "adminEquipmentBorder.update",
    summary: "编辑装备边框配置（整边替换）",
    description:
      "**整边替换**：提交的 `assignments` + `customs` 就是边框这半边的新配置，不是增量；\n" +
      "**详情背景那半边不受影响**（两页各自保存互不覆盖）。\n\n" +
      "约束：`assignments` 恰好覆盖当前档数的每种组合且不重复（缺哪个组合，哪个品质就没边框）；\n" +
      "key 形如 `border-30123`；`effect` 数值在范围内（偏移 ±2000、倍率 0.1~10）；\n" +
      "自定义表的装备标识唯一、最多 200 条。\n\n" +
      "任何一条不合法 → 40000 且**整边不落库**。\n\n" +
      "改完玩家下次进游戏拉配置快照后生效；已经在游戏里的那一次不会变。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiDataResponse(EquipmentBorderDto, { description: "更新后的装备边框配置" })
  update(@Body() dto: UpdateEquipmentBorderDto): EquipmentBorderDto {
    return this.equipmentAppearanceService.updateBorder(dto);
  }

  /**
   * 扫描边框资源文件夹（#716「从文件夹同步」的预览）
   *
   * 与 GET 配置的差异：这是去**磁盘**上数素材（`EQUIPMENT_APPEARANCE_RES_DIR` 下的
   * `effect/border/`），返回「文件夹有哪些 key、与当前清单的差集」—— 管理端拿它弹
   * 「将新增 N / 将移除 M」的确认框，确认后才调下面的 sync。
   */
  @Get("resources")
  @ApiAdminDoc({
    operationId: "adminEquipmentBorder.scanResources",
    summary: "扫描边框资源文件夹（同步预览）",
    description:
      "扫资源目录（`EQUIPMENT_APPEARANCE_RES_DIR`，缺省 `../client/assets/resources`；线上 compose\n" +
      "把 `game/resources/` 挂进容器）下的 `effect/border/`，返回：\n\n" +
      "- `keys`：文件夹里的全部边框 key（sfx 编号升序；plist + 同名 png 成对才算）\n" +
      "- `added` / `removed`：与当前清单的差集（同步将新增 / 将移除）\n" +
      "- `removedReferenced`：removed 里仍被棋盘 / 绑定引用的 key（同步允许移除，\n" +
      "  引用处之后会显示异常 —— 以文件夹为准就是要这个效果）\n\n" +
      "目录读不到 → 40000（错误消息里有实际路径，方便排查挂载）。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiDataResponse(AppearanceResourceScanDto, { description: "文件夹 key 与当前清单的差集" })
  scanResources(): AppearanceResourceScanDto {
    return this.equipmentAppearanceService.scanResources("border");
  }

  /**
   * 按资源文件夹同步边框清单（#716）
   *
   * 文件夹是事实来源：同步后清单 = 文件夹里的全部素材。**被引用的条目也允许移除**
   * （引用处显示异常是接受的后果）—— 这是它与整边替换（PATCH）「被引用不可删」
   * 校验的唯一分歧点，必须是显式点击确认的整批动作才走这条路。
   */
  @Post("sync")
  @AuditTarget("equipmentAppearance")
  @ApiAdminDoc({
    operationId: "adminEquipmentBorder.syncResources",
    summary: "按资源文件夹同步边框清单（以文件夹为准）",
    description:
      "**以文件夹为准**重建边框清单：文件夹里的素材全保留（effect 原样），文件夹里没有的\n" +
      "条目移除——**哪怕仍被棋盘 / 特殊装备绑定引用**（引用处会显示异常，客户端安静跳过，\n" +
      "读接口会把被引用的 key 自动并回清单，直到引用修好为止）。\n\n" +
      "只动边框这半边的清单列；棋盘 / 绑定 / 背景那半边都不动。\n\n" +
      "安全阀：目录读不到 / 空目录（多半是挂载配错）/ 超过清单上限 → 40000 且不落库。\n" +
      "改完玩家下次进游戏拉配置快照后生效。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiDataResponse(AppearanceResourceSyncDto, { description: "同步结果（新增 / 移除 / 保留数）" })
  syncResources(): AppearanceResourceSyncDto {
    return this.equipmentAppearanceService.syncResources("border");
  }
}
