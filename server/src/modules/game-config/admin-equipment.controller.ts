import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc } from "../../common/decorators/api-doc.decorator";
import { ApiQueryModel } from "../../common/decorators/api-query-model.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { Permission } from "../../common/constants/permission";
import { PageResult } from "../../common/interfaces/api-envelope.interface";
import { EQUIPMENT_SORT, EQUIPMENT_VARIANT_SORT, sortFieldNames } from "../../database/sort-specs";
import { GameConfigService } from "./game-config.service";
import {
  CreateEquipmentDto,
  CreateEquipmentResultDto,
  EquipmentDto,
  EquipmentPageDto,
  EquipmentQueryDto,
  EquipmentSlotSummaryDto,
  EquipmentVariantDto,
  EquipmentVariantPageDto,
  EquipmentVariantQueryDto,
  EquipmentVariantRebuildResultDto,
  EQUIPMENT_SLOT_KEYS,
  RemoveEquipmentResultDto,
  UpdateEquipmentDto,
  UpdateEquipmentVariantDto,
} from "./dto/equipment.dto";

/**
 * 管理端 · 装备基础件配置（#252 / #773）
 *
 * **管的是基础件**（如 `cloth_1`，37 件）：显示字段（图标 / 图集 / 几何 / 职业限制）与它
 * 自己的数值。变体（`_pXsY`，每件基础件 15 行）**各自是一行、单独可改**，入口在
 * `admin/equipment-variants`（#655）。
 *
 * #773 起多了**新建与删除**（此前是刻意的「只能改」）：
 * - 新建一件基础件会**连带展开它的全部变体**（档数取 `equipment_meta`）—— 只写 `equipments`
 *   是不够的，客户端认的是 `equipment_variants` 的行；
 * - 删除会连带删变体与工作台几何，且**商城还在架就拒删**（先下架）。
 *
 * **商城售价不在这里**（归商城定价管理），避免一个值两个写入口。
 * 写操作带 `@AuditTarget("equipment")`：改的是全服玩家的数值，必须可追溯。
 */
@ApiAudience("admin")
@Controller("admin/equipments")
export class AdminEquipmentController {
  constructor(private readonly gameConfigService: GameConfigService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminEquipment.list",
    summary: "装备基础件配置列表",
    description:
      "**只收基础件**（如 `cloth_1`），变体（`cloth_1_p3s2`）在 `admin/equipment-variants` 单独管。\n\n" +
      "`keyword` 模糊匹配 id 与名称；`slot` 按部位筛（" +
      EQUIPMENT_SLOT_KEYS.join(" / ") +
      "）；`minLevel` / `maxLevel` 按穿戴需求等级段筛（均含端）。\n\n" +
      "`sellPrice` 是客户端条目的售卖价（0 = 不可售卖），**商城售价归商城定价管理**，不在这里。\n\n" +
      `**排序**：\`sort\` 取 ${sortFieldNames(EQUIPMENT_SORT)}，\`order\` 取 asc / desc（默认 level 升序）。`,
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiQueryModel(EquipmentQueryDto)
  @ApiDataResponse(EquipmentPageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: EquipmentQueryDto): PageResult<EquipmentDto> {
    return this.gameConfigService.listEquipments(query);
  }

  /**
   * 部位盘点（#773）
   *
   * 管理端列表按部位拆页签，页签上的件数就是这里来的 —— 一次拿全，不用每个部位各发一条
   * `?slot=` 只为数个数。顺序 = `equipment_slots.sort_order`（与角色弹窗槽位排列同源）。
   */
  @Get("summary")
  @ApiAdminDoc({
    operationId: "adminEquipment.summary",
    summary: "装备件数按部位盘点",
    description:
      "返回装备总数与每个部位的件数，供管理端「按部位拆页签」用。\n\n" +
      "- 顺序 = `equipment_slots.sort_order`（与角色弹窗槽位排列、背包整理序同一份）。\n" +
      "- `equipments` 里出现但槽位表没有的部位补在末尾（`label` 退回 key）—— 历史脏数据也要点得到。\n" +
      "- 件数为 0 的部位照样返回（页签上显示 0，而不是凭空少一个部位）。",
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiDataResponse(EquipmentSlotSummaryDto, { description: "总数 + 按部位的件数" })
  summary(): EquipmentSlotSummaryDto {
    return this.gameConfigService.equipmentSlotSummary();
  }

  /**
   * 新建装备基础件（#773）
   *
   * 与 `PATCH` 的分界：新建只收「身份 + 基础数值」，资源细节与八项属性从 `templateId` 复制。
   * 连带展开全部变体，回包带展开行数。
   */
  @Post()
  @AuditTarget("equipment")
  @ApiAdminDoc({
    operationId: "adminEquipment.create",
    summary: "新建装备基础件（连带展开全部变体）",
    description:
      "**新建只填身份与基础数值** —— 部位 / 名称 / 等级 / 售价 / 职业性别 / 描述 / 标签 / 三个资源路径；" +
      "缩放、旋转、锚点、8 向位置与八项属性从 `templateId`（同部位的一件现成装备）复制，建完再在编辑弹窗里逐项改。\n\n" +
      "- `id` 可省：缺省按 `部位_序号` 生成（该部位现有最大序号 + 1）；手填撞已有 id → 409（`50039`）。\n" +
      "- `slot` 必须是装备槽位表里的 key（放开的是「这个部位下的装备」，不是新部位）→ 否则 400。\n" +
      "- `templateId` 不存在 → 404（`50016`）。\n" +
      "- **连带展开全部变体**（前缀档数 × 后缀档数，出厂 15 行）：不展开的话客户端根本看不到这件装备。\n" +
      "- 写完立刻重装结算层；客户端下次拉快照生效。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiDataResponse(CreateEquipmentResultDto, { description: "新建的装备 + 连带展开的变体行数" })
  create(@Body() dto: CreateEquipmentDto): CreateEquipmentResultDto {
    return this.gameConfigService.createEquipment(dto);
  }

  @Patch(":id")
  @AuditTarget("equipment")
  @ApiAdminDoc({
    operationId: "adminEquipment.update",
    summary: "编辑装备基础件配置",
    description:
      "**部分更新**：只改请求体里出现的字段。\n\n" +
      "- `level`：穿戴需求等级（装备定强的锚点）。\n" +
      "- `sellPrice`：售卖价（0 = 不可售卖）；**商城售价不在这里** —— 唯一写入口归商城定价管理。\n" +
      "- `attributes`：八项基础属性，**整份提交、整份替换**；区间型要求 0 ≤ min ≤ max（跨字段校验在服务端）。" +
      "改基础件**不再带动变体**（#655 起变体各自成行）；要改某一档前缀/后缀的数值去「装备变体」页。\n" +
      "- `slot` / `id` 不开放编辑（部位结构与引用键固定）—— 要换部位就新建一件（`POST`）再下架旧的。\n" +
      "- `id` 不存在 → 404（`50016`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "装备基础件 id（如 cloth_1）" })
  @ApiDataResponse(EquipmentDto, { description: "更新后的装备基础件配置" })
  update(@Param("id") id: string, @Body() dto: UpdateEquipmentDto): EquipmentDto {
    return this.gameConfigService.updateEquipment(id, dto);
  }

  /**
   * 删除装备基础件（#773）
   *
   * 连带删变体与两套工作台几何；**商城还在架就 409**（先下架）。不碰玩家存档 ——
   * 已穿戴 / 背包里引用它的格子会变成认不出的路径（属性失效），管理端删除确认里讲这条。
   */
  @Delete(":id")
  @AuditTarget("equipment")
  @ApiAdminDoc({
    operationId: "adminEquipment.delete",
    summary: "删除装备基础件（连带变体与工作台几何）",
    description:
      "删掉一件基础件，并**连带删除**：\n\n" +
      "- 它的**全部变体**（`equipment_variants` 里 `base_id` 对应的行）；\n" +
      "- 「装备对齐」/「内观对齐」工作台里指向这些 id 的几何行（派生数据，留着只是孤儿行）。\n\n" +
      "**还在商城上架清单里 → 409（`50040`）**：先下架再删，否则客户端会陈列一件名字退回 id、" +
      "图标空的幽灵商品。`id` 不存在 → 404（`50016`）。\n\n" +
      "**不碰玩家存档**：背包 / 身上还引用这些 id 的角色，那些格子会变成认不出的路径" +
      "（服务端与客户端都只是跳过，不报错，但那件装备的属性不再生效）。删除前请先确认没人穿着。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "装备基础件 id（如 cloth_1）" })
  @ApiDataResponse(RemoveEquipmentResultDto, { description: "连带清掉了什么（变体行数 / 几何行数）" })
  remove(@Param("id") id: string): RemoveEquipmentResultDto {
    return this.gameConfigService.removeEquipment(id);
  }
}

/**
 * 管理端 · 装备变体（#655：逐行配置）
 *
 * 以前变体是「基础件 × 前后缀倍率」在运行时现算的，管理端只能改基础件；
 * 现在每一件（含 `_pXsY`）都是独立行，属性 / 回收价 / 穿戴等级都能单独改。
 *
 * **没有创建 / 删除**：变体 id 由「基础件 × 前后缀」确定，删掉一个会让背包里已有的
 * id 变成孤儿。要「下线」某件装备请把它的卖价改 0 / 等级抬到不可达，而不是删行。
 */
@ApiAudience("admin")
@Controller("admin/equipment-variants")
export class AdminEquipmentVariantController {
  constructor(private readonly gameConfigService: GameConfigService) {}

  @Get()
  @ApiAdminDoc({
    operationId: "adminEquipmentVariant.list",
    summary: "装备变体列表",
    description:
      "每件基础件展开 5 前缀 × 3 后缀 = 15 行（行数随基础件浮动）。`baseId` 只看某一件基础件的 15 个变体；" +
      "`keyword` 模糊匹配变体 id 与名称；`slot` 按部位筛（部位取自基础件）、`minLevel` / `maxLevel` 取穿戴等级段（含两端）。\n\n" +
      "**这是唯一能改单个变体数值的地方** —— 以前改基础件会连带 15 个变体按倍率一起变，" +
      "现在每个变体是独立的一行。\n\n" +
      `**排序**：\`sort\` 取 ${sortFieldNames(EQUIPMENT_VARIANT_SORT)}，\`order\` 取 asc / desc（默认 baseId 升序）。`,
    permissions: [Permission.GAME_CONFIG_READ],
  })
  @ApiQueryModel(EquipmentVariantQueryDto)
  @ApiDataResponse(EquipmentVariantPageDto, { description: "分页结果（list/total/page/size）" })
  list(@Query() query: EquipmentVariantQueryDto): PageResult<EquipmentVariantDto> {
    return this.gameConfigService.listVariantPage(query);
  }

  @Patch(":id")
  @AuditTarget("equipmentVariant")
  @ApiAdminDoc({
    operationId: "adminEquipmentVariant.update",
    summary: "编辑装备变体",
    description:
      "**部分更新**：`label` / `level` / `sellPrice` 传哪个改哪个；`attributes` 是八项属性，**整份提交**。\n\n" +
      "- 属性区间两端由服务端校验（下限 ≤ 上限），不合规 400（40000）。\n" +
      "- 改完立刻重装结算层：服务端下一次算角色属性就用新值（客户端重进后生效）。\n" +
      "- 变体 id 不存在 → 404（`50010`）。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiParam({ name: "id", description: "变体 id（如 cloth_1_p3s2；基础件本身就是 p0s0）" })
  @ApiDataResponse(EquipmentVariantDto, { description: "更新后的变体" })
  update(@Param("id") id: string, @Body() dto: UpdateEquipmentVariantDto): EquipmentVariantDto {
    return this.gameConfigService.updateEquipmentVariant(id, dto);
  }

  /**
   * 重新生成全部装备变体（#697）
   *
   * 唯一会**删除**既有变体行的入口：按 equipment_meta 当前前后缀倍率整批重算。
   * 属性 / 名称 / 等级覆盖，**卖价保留原值**（新组合按公式垫底）；档位缩小时被删
   * 组合的持有者会变无效引用 —— 管理端按钮自带二次确认。
   */
  @Post("rebuild")
  @AuditTarget("equipmentVariant")
  @ApiAdminDoc({
    operationId: "adminEquipmentVariant.rebuild",
    summary: "重新生成全部装备变体",
    description:
      "按装备规则（前后缀档位，`GET /admin` 下的 `equipment-meta` 单行表）**当前**的前后缀倍率，把每个基础件 × 每个组合整批重算：\n\n" +
      "- 属性 = `round(基础值 × 前缀倍率 × 后缀倍率)`；名称 / 穿戴等级取基础件。\n" +
      "- **卖价保留原值**（运营逐条调过的价不被覆盖）；新增组合（扩档后）按 `round(10 × 等级 × 倍率)` 垫底。\n" +
      "- 档位缩小后，被删组合的变体行会消失 —— 背包 / 穿戴里还引用那些 id 的装备变成无效引用。\n" +
      "- 幂等：同一份倍率连点两次，第二次只刷新 updated_at。\n" +
      "- 重建完立刻重装结算层，服务端即时生效；客户端下次拉快照生效。",
    permissions: [Permission.GAME_CONFIG_WRITE],
  })
  @ApiDataResponse(EquipmentVariantRebuildResultDto, { description: "重建盘点（基础件数 / 组合数 / 变体行数）" })
  rebuild(): EquipmentVariantRebuildResultDto {
    return this.gameConfigService.rebuildEquipmentVariants();
  }
}
