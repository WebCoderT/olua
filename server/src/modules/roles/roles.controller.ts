import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse, ApiVoidResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiPlayerDoc } from "../../common/decorators/api-doc.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { CreateRoleDto, SaveRoleDto } from "./dto/create-role.dto";
import { DrugUseDto, DrugUseResultDto } from "./dto/drug-use.dto";
import { GrowthUpgradeDto } from "./dto/growth-upgrade.dto";
import { GrowthUpgradeResultDto, RoleDto, RoleSummaryDto } from "./dto/role.dto";
import { MallPurchaseDto, MallPurchaseResultDto } from "./dto/mall-purchase.dto";
import { SellGoodsDto, SellGoodsResultDto } from "./dto/sell-goods.dto";
import { RolesService } from "./roles.service";

/**
 * 客户端 · 角色接口
 *
 * 全部以**令牌里的账号**为准：路由里没有 accountId，也不读请求体里的账号，
 * 因此不存在「改个 id 就能操作别人角色」的口子。
 * 分组由方法级装饰器决定（自动类名分组已在 main.ts 关掉）。
 */
@Controller("roles")
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  @ApiPlayerDoc({ operationId: "role.list", summary: "角色列表", description: "按创建时间升序；不含 data（选角列表用）。" })
  @ApiDataResponse(RoleSummaryDto, { isArray: true, description: "角色概要列表" })
  list(@CurrentUser() user: AuthenticatedUser): RoleSummaryDto[] {
    return this.rolesService.list(user.id);
  }

  @Get("online")
  @ApiPlayerDoc({ operationId: "role.online", summary: "当前在线角色", description: "未选角色 / 在线角色已删时返回 null。" })
  @ApiDataResponse(RoleDto, { description: "在线角色完整数据，可能为 null", nullable: true })
  online(@CurrentUser() user: AuthenticatedUser): RoleDto | null {
    return this.rolesService.online(user.id);
  }

  @Post()
  @ApiPlayerDoc({
    operationId: "role.create",
    summary: "创建角色",
    description: "data 由客户端按自身配置生成；服务端校验结构、索引字段、数量上限与重名。第一个角色自动设为在线。",
  })
  @ApiDataResponse(RoleDto, { status: HttpStatus.CREATED, description: "创建成功" })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateRoleDto): RoleDto {
    return this.rolesService.create(user.id, dto);
  }

  @Get(":id")
  @ApiPlayerDoc({ operationId: "role.detail", summary: "角色详情", description: "只能查自己账号下的角色（否则 403）。" })
  @ApiParam({ name: "id", description: "角色 id" })
  @ApiDataResponse(RoleDto, { description: "角色完整数据" })
  detail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string): RoleDto {
    return this.rolesService.detail(user.id, id);
  }

  @Put(":id")
  @ApiPlayerDoc({
    operationId: "role.save",
    summary: "保存角色进度",
    description:
      "全量覆盖 data；id 以路径为准（请求体里的 id 会被忽略）。\n\n" +
      "请求体可带 `revision`（客户端上次读到的修订号）：带上即开启**乐观锁**，与服务端当前值不一致时返回 20006 " +
      "（角色已在别处被修改），客户端应先拉一次详情、以最新数据为基线再继续推；不带则不做冲突校验。",
  })
  @ApiParam({ name: "id", description: "角色 id" })
  @ApiDataResponse(RoleDto, { description: "保存后的角色" })
  save(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: SaveRoleDto): RoleDto {
    return this.rolesService.save(user.id, id, dto);
  }

  @Post(":id/select")
  @HttpCode(HttpStatus.OK)
  @ApiPlayerDoc({ operationId: "role.select", summary: "选中（进入）角色", description: "把该角色设为账号的在线角色。" })
  @ApiParam({ name: "id", description: "角色 id" })
  @ApiDataResponse(RoleDto, { description: "被选中的角色" })
  select(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string): RoleDto {
    return this.rolesService.select(user.id, id);
  }

  @Post(":id/growth-upgrade")
  @HttpCode(HttpStatus.OK)
  @ApiPlayerDoc({
    operationId: "role.growthUpgrade",
    summary: "成长线升级（称号 / 战魂 / 军衔）",
    description:
      "扣费与阶位推进都在服务端：按库里的成长链（upgrade_order / 军衔阶号）算出下一阶并校验 `targetLevel` 一致，" +
      "扣绑定元宝后原子推进（revision +1）。\n\n" +
      "失败路径业务码分段：20008 目标不是下一阶（含已满阶）/ 20009 绑定元宝不足 / 20010 当前称号不在升级链上（渠道被切走）；" +
      "带上 `revision` 时乐观锁语义与 role.save 相同（20006 / 20007）。",
  })
  @ApiParam({ name: "id", description: "角色 id" })
  @ApiDataResponse(GrowthUpgradeResultDto, { description: "升级后的角色（含本次消耗与到达阶位）" })
  growthUpgrade(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: GrowthUpgradeDto): GrowthUpgradeResultDto {
    return this.rolesService.upgradeGrowth(user.id, id, dto);
  }

  @Post(":id/mall-purchase")
  @HttpCode(HttpStatus.OK)
  @ApiPlayerDoc({
    operationId: "role.mallPurchase",
    summary: "商城购买（扣费与入包都在服务端）",
    description:
      "价格与商城定价管理端同源（特殊价优先，未定价走统一价）；商品只卖装备变体（不在目录 → 404 50021）。\n" +
      "扣绑定元宝后物品进背包（存档 bag 网格里找空格，装备每件占一格；没有空格 → 20012）。\n\n" +
      "失败路径：20011 绑定元宝不足 / 20012 背包已满；带上 revision 时乐观锁语义与 role.save 相同（20006 / 20007）。",
  })
  @ApiParam({ name: "id", description: "角色 id" })
  @ApiDataResponse(MallPurchaseResultDto, { description: "购买后的角色（含本次消耗）" })
  mallPurchase(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: MallPurchaseDto): MallPurchaseResultDto {
    return this.rolesService.purchaseMallGood(user.id, id, dto);
  }

  @Post(":id/sell")
  @HttpCode(HttpStatus.OK)
  @ApiPlayerDoc({
    operationId: "role.sellGoods",
    summary: "出售 / 回收物品（扣物与入账都在服务端）",
    description:
      "价格只认共享快照的出售价表（装备 = 回收价曲线含前后缀倍率，材料 / 药品 = 条目价签），" +
      "**客户端报「卖什么、卖几件」，不报价**。同 id 的多条先合并；整单结算，任一条不合法都不落库。\n\n" +
      "失败路径：20018 该物品不可出售（快照里没有价签 —— 任务物 / 关键道具）/ 20019 背包数量不够卖；" +
      "带上 revision 时乐观锁语义与 role.save 相同（20006 / 20007）。",
  })
  @ApiParam({ name: "id", description: "角色 id" })
  @ApiDataResponse(SellGoodsResultDto, { description: "出售后的角色（含逐行结算明细）" })
  sellGoods(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: SellGoodsDto): SellGoodsResultDto {
    return this.rolesService.sellGoods(user.id, id, dto);
  }

  @Post(":id/drug-use")
  @HttpCode(HttpStatus.OK)
  @ApiPlayerDoc({
    operationId: "role.drugUse",
    summary: "药品使用（回复结算与扣减都在服务端）",
    description:
      "回复量与药品管理端同源（drugs 表，管理端改回复量即时生效）：固定值 + 百分比 × maxHp/maxMp，各自封顶。\n" +
      "maxHp/maxMp 用服务端重算的战斗属性；使用后扣减背包格子数量（减到 0 清格）。\n\n" +
      "失败路径：20013 格子为空 / 非药品 / 无生效回复；20014 血蓝均已满；带上 revision 时乐观锁语义与 role.save 相同（20006 / 20007）。",
  })
  @ApiParam({ name: "id", description: "角色 id" })
  @ApiDataResponse(DrugUseResultDto, { description: "使用后的角色（含本次回复量）" })
  drugUse(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: DrugUseDto): DrugUseResultDto {
    return this.rolesService.useDrug(user.id, id, dto);
  }

  @Delete(":id")
  @ApiPlayerDoc({ operationId: "role.remove", summary: "删除角色", description: "不可恢复；删的正好是在线角色时同时清掉在线标记。" })
  @ApiParam({ name: "id", description: "角色 id" })
  @ApiVoidResponse("删除成功（data 为 null）")
  remove(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string): null {
    return this.rolesService.remove(user.id, id);
  }
}
