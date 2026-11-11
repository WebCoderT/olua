import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse, ApiVoidResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiPlayerDoc } from "../../common/decorators/api-doc.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { CreateRoleDto, SaveRoleDto } from "./dto/create-role.dto";
import { BagOpDto, BagOpResultDto } from "./dto/bag-op.dto";
import { DrugUseDto, DrugUseResultDto } from "./dto/drug-use.dto";
import { MoneyUseDto, MoneyUseResultDto } from "./dto/money-use.dto";
import { LevelScrollUseDto, LevelScrollUseResultDto } from "./dto/level-scroll-use.dto";
import { GrowthUpgradeDto } from "./dto/growth-upgrade.dto";
import { GrowthUpgradeResultDto, RoleDto, RoleSummaryDto } from "./dto/role.dto";
import { MallPurchaseDto, MallPurchaseResultDto } from "./dto/mall-purchase.dto";
import { MallLimitsDto } from "../game-config/dto/mall.dto";
import { FashionBuyDto, FashionBuyResultDto, FashionWearDto, FashionWearResultDto } from "./dto/fashion.dto";
import { ReviveResultDto } from "./dto/revive.dto";
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
  @ApiPlayerDoc({
    operationId: "role.select",
    summary: "选中（进入）角色",
    description:
      "把该角色设为账号的在线角色。**进入游戏即存档版本闸**：老版本存档当场迁到当前版本并落库" +
      "（迁移不推进修订号）；存档版本比服务端新、或迁移链缺环时拒登（20028，提示联系客服），" +
      "此时在线标记不变、存档一个字节都不动。",
  })
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
      "扣绑定元宝后物品进背包（存档 bag 网格里找空格，装备每件占一格；没有空格 → 20012）。\n" +
      "每日限购与全服库存在同一事务里占位（#846）：买满 → 50029、售罄 → 50030，两种都不扣钱不发货。\n\n" +
      "失败路径：20011 绑定元宝不足 / 20012 背包已满 / 50029 今日限购已满 / 50030 售罄；" +
      "带上 revision 时乐观锁语义与 role.save 相同（20006 / 20007）。",
  })
  @ApiParam({ name: "id", description: "角色 id" })
  @ApiDataResponse(MallPurchaseResultDto, { description: "购买后的角色（含本次消耗与买完之后的限购/库存数）" })
  mallPurchase(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: MallPurchaseDto): MallPurchaseResultDto {
    return this.rolesService.purchaseMallGood(user.id, id, dto);
  }

  @Get(":id/mall-limits")
  @ApiPlayerDoc({
    operationId: "role.mallLimits",
    summary: "商城的每日限购与库存（只读，客户端打开商城时拉一遍）",
    description:
      "一次返回**全部上架商品**的运行时数字：今天已买几件、每日限购、全服已售、全服库存，以及一个 " +
      "`purchasable`（只看限购与库存，等级与余额客户端另有判据）。\n\n" +
      "快照里只有配置（`dailyLimit` / `stock`），「今天买了几个」随角色与时刻变，不能进快照 —— 走这个接口。\n" +
      "天号每日 05:00 切（与日常任务同一把尺子），跨天不需要任何结算动作。",
  })
  @ApiParam({ name: "id", description: "角色 id" })
  @ApiDataResponse(MallLimitsDto, { description: "逐件商品的限购与库存" })
  mallLimits(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string): MallLimitsDto {
    return this.rolesService.mallLimits(user.id, id);
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

  @Post(":id/money-use")
  @HttpCode(HttpStatus.OK)
  @ApiPlayerDoc({
    operationId: "role.moneyUse",
    summary: "使用货币道具（入账与扣减都在服务端）",
    description:
      "货币道具（绑定元宝，各档面值）使用后直接给角色账本入账：金额与币种读服务端 `money_items` 表，" +
      "**客户端报「用哪一格」，不报金额**。\n" +
      "使用后扣减背包格子数量（减到 0 清格），revision 原子 +1。\n\n" +
      "不结算血蓝、不判「已满」、无冷却（与药品是两条链路）。\n\n" +
      "失败路径：20023 格子为空 / 不是货币道具 / 该行没有配置入账金额；" +
      "带上 revision 时乐观锁语义与 role.save 相同（20006 / 20007）。",
  })
  @ApiParam({ name: "id", description: "角色 id" })
  @ApiDataResponse(MoneyUseResultDto, { description: "使用后的角色（含本次入账金额与余额）" })
  moneyUse(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: MoneyUseDto): MoneyUseResultDto {
    return this.rolesService.useMoneyItem(user.id, id, dto);
  }

  @Post(":id/level-scroll-use")
  @HttpCode(HttpStatus.OK)
  @ApiPlayerDoc({
    operationId: "role.levelScrollUse",
    summary: "使用升级卷轴（硬性 +1 级，带等级区间）",
    description:
      "使用后**等级直接 +1**（不看经验够不够，经验原样保留），并按新等级重算战斗属性、补满血蓝。\n" +
      "区间与等级上限读服务端 `level_scrolls` 表：Lv1 只在 1~999 级可用，用出这段就返回 20025（该换 Lv2 了）。\n" +
      "**客户端报「用哪一格」，不报等级与跳级数** —— 改包也跳不出区间。\n\n" +
      "失败路径：20024 格子为空 / 不是升级卷轴 / 区间配置不合法；20025 等级不在区间内；" +
      "20026 已达等级上限；带上 revision 时乐观锁语义与 role.save 相同（20006 / 20007）。",
  })
  @ApiParam({ name: "id", description: "角色 id" })
  @ApiDataResponse(LevelScrollUseResultDto, { description: "使用后的角色（含使用前后等级与经验）" })
  levelScrollUse(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() dto: LevelScrollUseDto,
  ): LevelScrollUseResultDto {
    return this.rolesService.useLevelScroll(user.id, id, dto);
  }

  @Post(":id/revive")
  @HttpCode(HttpStatus.OK)
  @ApiPlayerDoc({
    operationId: "role.revive",
    summary: "复活：血蓝补到上限（满血由服务端落账）",
    description:
      "死亡状态（hp ≤ 0）时把血蓝补到服务端重算的上限、清零自然回复累加器；未死亡时拒收（20015）。\n\n" +
      "客户端死亡弹窗的两个选项（原地 / 回城复活）都调它，差别只在**复活位置**（纯演出），\n" +
      "满血这件事只在服务端发生 —— 改包上报满血存档是无效的（血蓝在 save 时被服务端结算值覆盖）。\n\n" +
      "revision 不推进（与受击同一纪律：血量型写入走实时帧），返回值带上限供客户端照搬。",
  })
  @ApiParam({ name: "id", description: "角色 id" })
  @ApiDataResponse(ReviveResultDto, { description: "复活后的血蓝与上限" })
  revive(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string): ReviveResultDto {
    return this.rolesService.revive(user.id, id);
  }

  @Post(":id/fashion-buy")
  @HttpCode(HttpStatus.OK)
  @ApiPlayerDoc({
    operationId: "role.fashionBuy",
    summary: "购买时装（扣费与拥有清单都在服务端）",
    description:
      "渠道 = `fashions.acquire_channel === \"upgrade\"` 且 `sell_price > 0` 才可买（与称号渠道同语义）；\n" +
      "价格只认 fashions 表（管理端改价即时生效），扣绑定元宝后写入拥有清单 `fashionsOwned`。\n\n" +
      "拥有清单是**独占字段**：客户端存档上报无效，只能由购买与管理端发放书写 ——\n" +
      "改包把清单填满不会让任何一件时装变成「已拥有」。\n\n" +
      "失败路径：20016 渠道未开放 / 售价为 0 / 已拥有；20011 绑定元宝不足；乐观锁与 role.save 相同（20006 / 20007）。",
  })
  @ApiParam({ name: "id", description: "角色 id" })
  @ApiDataResponse(FashionBuyResultDto, { description: "购买结果（余额 + 完整拥有清单）" })
  fashionBuy(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: FashionBuyDto): FashionBuyResultDto {
    return this.rolesService.fashionBuy(user.id, id, dto);
  }

  @Post(":id/fashion-wear")
  @HttpCode(HttpStatus.OK)
  @ApiPlayerDoc({
    operationId: "role.fashionWear",
    summary: "穿 / 脱时装（「拥有才给穿」在服务端校验）",
    description:
      "改的是存档 `fashionCloth`；不在拥有清单（20017）或时装表里没有这个 id 都拒收。\n" +
      "穿时装不改任何数值（时装只换外观），revision +1。\n\n" +
      "`fashionId` 传 null = 脱下当前时装（幂等：没穿时也返回成功）。\n\n" +
      "老档迁移：`fashionsOwned` 上线前的存档没有清单，首次穿 / 脱时把当前穿着认领进去。",
  })
  @ApiParam({ name: "id", description: "角色 id" })
  @ApiDataResponse(FashionWearResultDto, { description: "穿着态与拥有清单" })
  fashionWear(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: FashionWearDto): FashionWearResultDto {
    return this.rolesService.fashionWear(user.id, id, dto);
  }

  @Post(":id/bag-op")
  @HttpCode(HttpStatus.OK)
  @ApiPlayerDoc({
    operationId: "role.bagOp",
    summary: "背包操作：穿戴 / 卸下 / 丢弃 / 整理 / 搬运（#556）",
    description:
      "五个动作共用一条写路径，`action` 区分，字段组合在服务端逐条校验。\n\n" +
      "**穿 / 脱 / 丢由服务端自己算**：`equip` 先证明这件东西真在那一格、确实是该部位的装备、等级够，" +
      "再把旧装备放回刚腾出的格子；`unequip` 由服务端找第一个空格；`discard` 只认格子坐标。" +
      "**整理 / 搬运只验守恒**：`move` / `tidy` 传操作后的完整内容（稀疏格子），" +
      "服务端只校验「网格形状不变 + 同 id 总件数不变」—— 多一件少一件都会被拒。\n\n" +
      "穿戴 / 卸下会重算战斗属性并把血蓝夹回上限（`combat` / `maxHp` 等字段随响应一起回来）。\n\n" +
      "失败路径：20020 目标不合法（空格子 / 空槽位）/ 20021 穿不上（不是装备 / 认不出 / 等级不够）" +
      "/ 20022 排布与库里对不上 / 20012 背包满（卸下时没有空格）；" +
      "带上 revision 时乐观锁语义与 role.save 相同（20006 / 20007）。",
  })
  @ApiParam({ name: "id", description: "角色 id" })
  @ApiDataResponse(BagOpResultDto, { description: "操作后的角色（含背包 / 装备槽位 / 重算后的战斗属性）" })
  bagOp(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: BagOpDto): BagOpResultDto {
    return this.rolesService.bagOp(user.id, id, dto);
  }

  @Delete(":id")
  @ApiPlayerDoc({ operationId: "role.remove", summary: "删除角色", description: "不可恢复；删的正好是在线角色时同时清掉在线标记。" })
  @ApiParam({ name: "id", description: "角色 id" })
  @ApiVoidResponse("删除成功（data 为 null）")
  remove(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string): null {
    return this.rolesService.remove(user.id, id);
  }
}
