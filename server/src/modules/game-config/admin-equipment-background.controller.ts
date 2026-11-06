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
  EquipmentBackgroundDto,
  UpdateEquipmentBackgroundDto,
} from "./dto/equipment-appearance.dto";

/**
 * 管理端 · 装备详情背景（#695 出端点、#699 拆成独立页面的半边）
 *
 * 详情背景 = 物品详情弹窗的品质背景动画。「哪个前后缀组合用哪个背景」「哪件特殊装备
 * 单独用哪个」是**运营内容**：这里整边读、整边写，**边框那半边不受影响** ——
 * 背景页与边框页可以各自独立保存、互不覆盖（#699 拆分的动机）。
 *
 * 每条数据可带 `effect`（#700）：以背景素材第一帧为基准的位置偏移与尺寸倍率，
 * 不传 = 客户端默认适配（铺满详情弹窗面板）。
 *
 * ## 改的是什么、不改的是什么
 * - **改**：哪个组合 / 哪件特殊装备用哪个背景 key、显示效果；
 * - **不改**：素材本体（客户端资源包 `resources/backgrounds`）与资源清单。
 *   服务端不校验素材存在 —— 填了不存在的 key，客户端保持静态底图不变。
 *
 * ## 生效时机
 * 玩家下次进游戏拉配置快照（`equipmentAppearance` 段）时重建映射。
 */
@ApiAudience("admin")
@Controller("admin/equipment-backgrounds")
export class AdminEquipmentBackgroundController {
  constructor(private readonly equipmentAppearanceService: EquipmentAppearanceService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminEquipmentBackground.get",
    summary: "装备详情背景配置",
    description:
      "背景这半边 + 最后修改时间（**单行配置，没有分页**）：\n\n" +
      "- `assignments`：前后缀组合 → 背景 key，**恰好覆盖当前档数的每种组合**、各一条；\n" +
      "- `customs`：特殊装备 → 背景 key（**优先于**棋盘）。\n\n" +
      "每条可带 `effect`（x/y 偏移 + scale 倍率，#700），不传 = 默认适配（铺满弹窗面板）。\n" +
      "key 形如 `bg-16000`。服务端只校验 key 格式，**不校验素材存在**。\n\n" +
      "缺行 / 坏数据：映射表整份回落出厂映射、自定义表坏条目丢弃（effect 坏只丢效果），均有日志可查。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiDataResponse(EquipmentBackgroundDto, { description: "当前装备详情背景配置（含 updatedAt）" })
  get(): EquipmentBackgroundDto {
    return this.equipmentAppearanceService.getBackground();
  }

  @Patch()
  @AuditTarget("equipmentAppearance")
  @ApiAdminDoc({
    operationId: "adminEquipmentBackground.update",
    summary: "编辑装备详情背景配置（整边替换）",
    description:
      "**整边替换**：提交的 `assignments` + `customs` 就是背景这半边的新配置，不是增量；\n" +
      "**边框那半边不受影响**（两页各自保存互不覆盖）。\n\n" +
      "约束：`assignments` 恰好覆盖当前档数的每种组合且不重复；key 形如 `bg-16000`；\n" +
      "`effect` 数值在范围内（偏移 ±2000、倍率 0.1~10）；自定义表的装备标识唯一、最多 200 条。\n\n" +
      "任何一条不合法 → 40000 且**整边不落库**。\n\n" +
      "改完玩家下次进游戏拉配置快照后生效；已经在游戏里的那一次不会变。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiDataResponse(EquipmentBackgroundDto, { description: "更新后的装备详情背景配置" })
  update(@Body() dto: UpdateEquipmentBackgroundDto): EquipmentBackgroundDto {
    return this.equipmentAppearanceService.updateBackground(dto);
  }

  /**
   * 扫描背景资源文件夹（#716「从文件夹同步」的预览）：与边框控制器同构，
   * 只是子目录换成 `effect/background/`（key = 图集文件名）。
   */
  @Get("resources")
  @ApiAdminDoc({
    operationId: "adminEquipmentBackground.scanResources",
    summary: "扫描背景资源文件夹（同步预览）",
    description:
      "扫资源目录（`EQUIPMENT_APPEARANCE_RES_DIR`，缺省 `../client/assets/resources`；线上 compose\n" +
      "把 `game/resources/` 挂进容器）下的 `effect/background/`，返回：\n\n" +
      "- `keys`：文件夹里的全部背景 key（sfx 编号升序；帧序列目录才算）\n" +
      "- `added` / `removed`：与当前清单的差集（同步将新增 / 将移除）\n" +
      "- `removedReferenced`：removed 里仍被棋盘 / 绑定引用的 key（同步允许移除）\n\n" +
      "目录读不到 → 40000（错误消息里有实际路径，方便排查挂载）。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiDataResponse(AppearanceResourceScanDto, { description: "文件夹 key 与当前清单的差集" })
  scanResources(): AppearanceResourceScanDto {
    return this.equipmentAppearanceService.scanResources("background");
  }

  /** 按资源文件夹同步背景清单（#716）：与边框控制器同构，只动背景这半边的清单列。 */
  @Post("sync")
  @AuditTarget("equipmentAppearance")
  @ApiAdminDoc({
    operationId: "adminEquipmentBackground.syncResources",
    summary: "按资源文件夹同步背景清单（以文件夹为准）",
    description:
      "**以文件夹为准**重建背景清单：文件夹里的素材全保留（effect 原样），文件夹里没有的\n" +
      "条目移除——**哪怕仍被棋盘 / 特殊装备绑定引用**（引用处会显示异常，客户端安静跳过，\n" +
      "读接口会把被引用的 key 自动并回清单，直到引用修好为止）。\n\n" +
      "只动背景这半边的清单列；棋盘 / 绑定 / 边框那半边都不动。\n\n" +
      "安全阀：目录读不到 / 空目录（多半是挂载配错）/ 超过清单上限 → 40000 且不落库。\n" +
      "改完玩家下次进游戏拉配置快照后生效。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiDataResponse(AppearanceResourceSyncDto, { description: "同步结果（新增 / 移除 / 保留数）" })
  syncResources(): AppearanceResourceSyncDto {
    return this.equipmentAppearanceService.syncResources("background");
  }
}
