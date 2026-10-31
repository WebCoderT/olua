import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";
import { compareRoleAttributesOfRole } from "../combat/role-attribute-comparison";
import { roleAttributeSourceOf, summarizeRoleAttributes } from "../combat/role-attributes";
import { MallPricingService } from "../game-config/mall-pricing.service";
import { GROWTH_SCALARS, ITEM_TYPES } from "../../shared/game-data.generated";
import { drugOf, itemBaseOf, sellPriceOf } from "../../shared/runtime-overrides";
import { AccountRepository } from "../../database/repositories/account.repository";
import { DrugRepository } from "../../database/repositories/drug.repository";
import { GrowthRepository } from "../../database/repositories/growth.repository";
import { RankRepository } from "../../database/repositories/rank.repository";
import { RoleRepository } from "../../database/repositories/role.repository";
import { SoulRepository } from "../../database/repositories/soul.repository";
import { TitleRepository } from "../../database/repositories/title.repository";
import { AccountRow, RankRow, RoleRow, SoulRow, TitleRow } from "../../database/rows";
import { CreateRoleDto, SaveRoleDto } from "./dto/create-role.dto";
import { DrugUseDto, DrugUseResultDto } from "./dto/drug-use.dto";
import { GrowthUpgradeDto, GrowthKind } from "./dto/growth-upgrade.dto";
import { GrowthUpgradeResultDto, RoleDto, RoleSummaryDto } from "./dto/role.dto";
import { MallPurchaseDto, MallPurchaseResultDto } from "./dto/mall-purchase.dto";
import { SellGoodsDto, SellGoodsResultDto, SellLineDto } from "./dto/sell-goods.dto";
import { decodeStoredRoleData, normalizeLevel, parseRoleData } from "./role-data.util";
import { clampInitialCurrency, clampVitals, enforceServerAuthority } from "./role-authority";

/** 一次击杀经验入账后的角色状态（settle 帧的 reward 据此组装） */
export interface KillExpResult {
  level: number;
  expNow: number;
  expNeed: number;
  leveledUp: boolean;
  revision: number;
}

/** 一次拾取入包的结果（picked 帧的 ok 应答据此组装） */
export interface PickDropResult {
  revision: number;
  placed: Array<{ row: number; col: number; id: string; count: number }>;
}

/**
 * 角色业务（玩家侧）
 *
 * 所有方法都带 accountId：**归属校验在这里**（越权访问别人的角色一律 403），
 * 控制器只从令牌取 accountId，绝不接受请求体里的账号 id。
 */
@Injectable()
export class RolesService {
  private readonly logger = new Logger(RolesService.name);

  constructor(
    private readonly roles: RoleRepository,
    private readonly accounts: AccountRepository,
    private readonly titles: TitleRepository,
    private readonly souls: SoulRepository,
    private readonly ranks: RankRepository,
    private readonly mallPricing: MallPricingService,
    private readonly drugs: DrugRepository,
    private readonly growth: GrowthRepository,
  ) {}

  /** 当前账号的角色列表（按创建时间升序，与客户端站位顺序一致） */
  list(accountId: string): RoleSummaryDto[] {
    const account = this.mustAccount(accountId);
    return this.roles.findByAccount(accountId).map((row) => RoleSummaryDto.from(row, account.online_role_id));
  }

  /** 当前选中（在线）角色；未选或角色已被删返回 null */
  online(accountId: string): RoleDto | null {
    const account = this.mustAccount(accountId);
    const roleId = account.online_role_id;
    if (!roleId) return null;
    const row = this.roles.findById(roleId);
    return row ? RoleDto.from(row, roleId) : null;
  }

  /** 角色详情 */
  detail(accountId: string, roleId: string): RoleDto {
    const account = this.mustAccount(accountId);
    return RoleDto.from(this.mustOwnRole(accountId, roleId), account.online_role_id);
  }

  /**
   * 按角色名找人（社交用：#389）
   *
   * 名字只在同一账号内唯一，所以可能返回多个 —— 社交那边据此返回 50116，
   * 让玩家改从「附近」或帮会成员里加，而不是替他随便挑一个。
   */
  idsByName(name: string): string[] {
    return this.roles.findIdsByName(name.trim());
  }

  /** 这个角色 id 是否存在（社交按 id 加好友前的存在性校验：#389） */
  existsById(roleId: string): boolean {
    return Boolean(this.roles.findById(roleId));
  }

  /**
   * 某角色的等级（`roles.level` 索引列；角色不存在返回 0）
   *
   * 给「按等级判门槛」用（#497 组队邀请）：调用方要的是**一个数字**，不是整份存档 ——
   * 只读索引列，不解析 data JSON。0 同时代表「不存在」和「0 级」，两者在门槛判定里
   * 都是「不够级」，调用方不需要区分（要区分存在的先调 `existsById`）。
   */
  levelOf(roleId: string): number {
    const row = this.roles.findById(roleId);
    return row ? Math.max(0, Math.floor(Number(row.level) || 0)) : 0;
  }

  /**
   * 创建角色
   *
   * 校验顺序：id 是否已存在 → 同账号是否重名（角色数量不设上限，选角界面按网格自动排）。
   * 第一个角色自动设为在线（与客户端「建完就能进游戏」的体验一致）。
   */
  create(accountId: string, dto: CreateRoleDto): RoleDto {
    const account = this.mustAccount(accountId);
    const { fields, data } = parseRoleData(dto.data);

    if (this.roles.findById(fields.id)) throw BizException.conflict(BizCode.ROLE_ID_EXISTS, "角色 id 已存在，请重试");
    if (this.roles.findByAccountAndName(accountId, fields.name)) throw BizException.conflict(BizCode.ROLE_NAME_EXISTS, "该账号下已存在同名角色");

    const now = Date.now();
    // 建号的账本只能到「配置给的起点」（#548）：库里还没有值可比，这是唯一需要单独封上界的地方
    clampInitialCurrency(data);
    // 战斗属性与战斗力在落库前由服务端重算（权威值）：客户端给的只是占位/参考
    this.applyAuthoritativeAttributes(fields.level, data);
    const row: RoleRow = {
      id: fields.id,
      account_id: accountId,
      name: fields.name,
      occupation: fields.occupation,
      sex: fields.sex,
      level: fields.level,
      // 新角色的击杀数从 0 起（#400）：这一列只由结算路径 +1，创建时不给客户端任何话语权
      kills: 0,
      data: JSON.stringify(data),
      revision: 1,
      created_at: now,
      updated_at: now,
    };
    this.roles.insert(row);
    // 这里**刻意不做**战斗属性比对（与 save 那条不同）：建号这份 data 是客户端 `new Role(...)`
    // 刚构造出来的初始存档，combat 是构造函数里的占位值 —— 但占位值不会落库：上面那行
    // `applyAuthoritativeAttributes` 已经把它换成了服务端重算的真实值（1 级裸角色约 2310）。
    // 在线标记一律走 `setOnlineRole`（#547）：它顺带写心跳，否则这一行会被在线清算判成「没人」。
    if (!account.online_role_id) this.accounts.setOnlineRole(accountId, row.id);
    return RoleDto.from(row, account.online_role_id ?? row.id);
  }

  /**
   * 保存角色进度（全量覆盖；id 以路径参数为准，避免换 id 写别人角色）
   *
   * **乐观锁**：请求带了 revision 且与服务端当前值不一致时拒收（20006）。
   * 典型场景是玩家在游戏里、管理员在后台改了这个角色 —— 若直接放行，
   * 客户端那份「改之前」的存档会把后台的改动整体覆盖掉（谁最后写谁赢，后台改动静默丢失）。
   * 客户端收到 20006 应拉一次角色详情、以最新数据为基线后再继续推（见 utils/net/RoleSync）。
   */
  save(accountId: string, roleId: string, dto: SaveRoleDto): RoleDto {
    const account = this.mustAccount(accountId);
    const existing = this.mustOwnRole(accountId, roleId);
    // 已被管理员踢下线（不再是账号当前的在线角色）→ 拒收这次存档
    //
    // 为什么必须拦：踢下线只是清掉账号上的在线标记，客户端**本地那份存档还在跑**，
    // 不拦的话它会一直把进度写回来 —— 踢了等于没踢。客户端收到 20007 应当提示并回选角。
    // 这条判定要放在乐观锁之前：被踢的玩家需要的是「回选角」，而不是反复重试同一个冲突。
    if (account.online_role_id !== roleId) {
      throw BizException.conflict(BizCode.ROLE_KICKED, "该角色已被管理员下线，请重新选择角色进入游戏");
    }
    if (dto.revision !== undefined && dto.revision !== existing.revision) {
      throw BizException.conflict(BizCode.ROLE_REVISION_CONFLICT, "该角色已在别处被修改，请先同步最新数据");
    }
    const { fields, data } = parseRoleData({ ...dto.data, id: roleId });

    if (fields.name !== existing.name && this.roles.findByAccountAndName(accountId, fields.name, roleId)) {
      throw BizException.conflict(BizCode.ROLE_NAME_EXISTS, "该账号下已存在同名角色");
    }

    // 权威边界（见 role-authority.ts）：账本 / 成长线阶位 / 进度以库为准，客户端报上来的一律丢弃；
    // 老存档里没有这些键时不回填（客户端那份是唯一来源，删掉等于把玩家的钱清零）。
    // `level` 另有索引列（`roles.level`）压过文档里的那份 —— 列表排序与筛选读的是列，列才是真相
    this.enforceAuthority({ ...decodeStoredRoleData(existing.data), level: existing.level }, data);
    // 等级可能被上面回填改掉，索引列必须从**回填后**的文档重取：
    // 否则 `row.level`（客户端报的）与 `data.level`（库里的）各说一套，列表与详情对不上
    const level = normalizeLevel(data.level);
    // 比对在前（记录客户端这次上报了什么，观察用），重算在后（落库的一定是服务端算的）：
    // 客户端那份自 #541 起只是演，谁强由这里的公式说了算
    this.warnIfAttributesMismatch(roleId, level, data);
    this.applyAuthoritativeAttributes(level, data);
    // 上限是上面那步算出来的，夹在它之后；血蓝的「当前值」仍归客户端（自然回复在本地）
    clampVitals(data);
    const row: RoleRow = {
      ...existing,
      name: fields.name,
      occupation: fields.occupation,
      sex: fields.sex,
      level,
      data: JSON.stringify(data),
      // 与 replace() 里的 `revision = revision + 1` 对齐：SQL 只是落库，这里要给出**落库后**的值，
      // 否则响应里的 revision 比库里小 1，客户端拿它做基线会立刻撞乐观锁（自锁死循环）
      revision: existing.revision + 1,
      updated_at: Date.now(),
    };
    this.roles.replace(row);
    return RoleDto.from(row, account.online_role_id);
  }

  /**
   * 三条成长线在角色存档 data 里的阶位字段（与 ROLE_PATCH_NUMBER_FIELDS 同名）
   */
  private static readonly GROWTH_FIELD: Record<GrowthKind, string> = {
    title: "title",
    soul: "soulOfWar",
    rank: "rank",
  };

  /**
   * 成长线升级（称号 #248 / 战魂 #249 / 军衔 #250）
   *
   * **扣费与阶位推进都在服务端**：客户端只报「哪条线、升到哪阶」，这里算出升级链上的
   * 下一阶并校验目标一致（防跳级、防并发错位），扣绑定元宝后原子推进（revision +1）。
   *
   * 下一阶怎么算（与客户端 configs 的「+1」习惯解耦，以服务端库为准）：
   * - 称号 / 战魂走 **upgrade_order 成长链**（管理端拖动列表改的就是它）——阶号与顺序解耦；
   *   链本身只含可升级的行（称号 listUpgrade 已按渠道过滤）。
   * - 军衔天然按阶，下一阶就是 level + 1。
   *
   * 返回值带 `consumed / gainedLevel / gainedLabel`：客户端弹提示、重算战力都要用，
   * 免得它再回头查一遍配置。
   */
  upgradeGrowth(accountId: string, roleId: string, dto: GrowthUpgradeDto): GrowthUpgradeResultDto {
    const account = this.mustAccount(accountId);
    const existing = this.mustOwnRole(accountId, roleId);
    // 与 save 同一纪律：被踢下线的角色不能再推进度（升级也是一种写）
    if (account.online_role_id !== roleId) {
      throw BizException.conflict(BizCode.ROLE_KICKED, "该角色已被管理员下线，请重新选择角色进入游戏");
    }
    if (dto.revision !== undefined && dto.revision !== existing.revision) {
      throw BizException.conflict(BizCode.ROLE_REVISION_CONFLICT, "该角色已在别处被修改，请先同步最新数据");
    }

    const data = decodeStoredRoleData(existing.data);
    const field = RolesService.GROWTH_FIELD[dto.kind];
    const current = Math.max(0, Math.floor(Number(data[field]) || 0));
    const target = this.resolveGrowthTarget(dto.kind, current);
    // 链上没有下一阶（已满阶）或目标与算出的下一阶不一致 → 同一个失败语义（目标不合法）
    if (!target || target.level !== dto.targetLevel) {
      throw BizException.conflict(
        BizCode.GROWTH_TARGET_INVALID,
        target ? `目标阶位不合法：下一阶是 ${target.level} 阶（${target.label}）` : "已处于成长链顶端，没有下一阶",
      );
    }

    const bindGold = Math.max(0, Math.floor(Number(data.bindGold) || 0));
    if (bindGold < target.bind_gold) {
      throw BizException.conflict(BizCode.GROWTH_GOLD_NOT_ENOUGH, `绑定元宝不足：还需 ${target.bind_gold - bindGold}`);
    }

    data[field] = target.level;
    data.bindGold = bindGold - target.bind_gold;
    // 阶位变了，属性与战斗力跟着变 —— 同样由服务端重算落库
    this.applyAuthoritativeAttributes(existing.level, data);

    const row: RoleRow = {
      ...existing,
      data: JSON.stringify(data),
      revision: existing.revision + 1,
      updated_at: Date.now(),
    };
    this.roles.replace(row);
    return GrowthUpgradeResultDto.fromRow(row, account.online_role_id, target.bind_gold, target.level, target.label);
  }

  /**
   * 算出某条成长线从 current 出发的下一阶
   *
   * @returns 下一阶配置行；已满阶返回 null
   * @throws GROWTH_CHANNEL_LOCKED 称号当前阶不在升级链上（运营把玩家已获得的称号切出了
   *   upgrade 渠道，upgrade_order 已清空）——此时无法定位下一阶，拒绝续升
   */
  private resolveGrowthTarget(kind: GrowthKind, current: number): TitleRow | SoulRow | RankRow | null {
    if (kind === "rank") {
      // 军衔天然按阶：下一阶 = level + 1，没有 0 阶行（1 阶即起点）
      return this.ranks.findByLevel(current + 1) ?? null;
    }
    const chain = kind === "title" ? this.titles.listUpgrade() : this.souls.listUpgrade();
    if (current <= 0) return chain[0] ?? null;
    const currentIndex = chain.findIndex((row) => row.level === current);
    if (currentIndex < 0) {
      throw BizException.conflict(
        BizCode.GROWTH_CHANNEL_LOCKED,
        kind === "title" ? "当前称号不在可升级的成长链上，无法续升" : "当前战魂阶不在成长链上，无法续升",
      );
    }
    return chain[currentIndex + 1] ?? null;
  }

  /**
   * 商城购买（玩家侧 #304）：扣费与入包都在服务端
   *
   * 价格与商城定价管理端**同源**（mall_prices 特殊价优先，未定价走 mall_settings 统一价）——
   * 后台改价立即对购买生效。商品只卖装备变体（MallPricingService 目录即生成物装备全量），
   * 非装备 id 一律 404（没有「玩家能买到别的东西」的口子）。
   *
   * 入包：存档 `data.bag` 是客户端按配置重塑的**固定尺寸网格**（Array<Array<{id,count}|null>>，
   * 见客户端 items.normalizeBagGrid），装备不可叠加、每件占一格 —— 行优先找第一个空格放入。
   * 服务端**不扩容**：网格尺寸归客户端配置管，网格里没有空格就是真的满了（20012）。
   */
  purchaseMallGood(accountId: string, roleId: string, dto: MallPurchaseDto): MallPurchaseResultDto {
    const account = this.mustAccount(accountId);
    const existing = this.mustOwnRole(accountId, roleId);
    // 与升级同一纪律：被踢下线的角色不能继续购买
    if (account.online_role_id !== roleId) {
      throw BizException.conflict(BizCode.ROLE_KICKED, "该角色已被管理员下线，请重新选择角色进入游戏");
    }
    if (dto.revision !== undefined && dto.revision !== existing.revision) {
      throw BizException.conflict(BizCode.ROLE_REVISION_CONFLICT, "该角色已在别处被修改，请先同步最新数据");
    }

    // 商品不存在（不在装备目录）→ 404，消息经请求层弹给玩家
    const price = this.mallPricing.priceOf(dto.goodId);

    const data = decodeStoredRoleData(existing.data);
    const bindGold = Math.max(0, Math.floor(Number(data.bindGold) || 0));
    if (bindGold < price) {
      throw BizException.conflict(BizCode.MALL_GOLD_NOT_ENOUGH, `绑定元宝不足：还需 ${price - bindGold}`);
    }

    data.bindGold = bindGold - price;
    this.putGoodIntoBag(data, dto.goodId);

    const row: RoleRow = {
      ...existing,
      data: JSON.stringify(data),
      revision: existing.revision + 1,
      updated_at: Date.now(),
    };
    this.roles.replace(row);
    return MallPurchaseResultDto.fromRow(row, account.online_role_id, price, dto.goodId);
  }

  /**
   * 出售 / 回收（玩家侧 #397，epic #394）：扣物与入账都在服务端
   *
   * 价格走 `sellPriceOf`（#545）：**先查运营库覆盖层，缺省回落生成物的出厂价签
   * `SELL_PRICES`**（装备 = 回收价曲线已含前后缀倍率，其余 = 条目价签）——
   * 客户端报多少都无效，它只报「卖什么、卖几件」。没有任何价签的 id 就是**不可卖**
   * （任务物 / 关键道具靠这条拦住，20018），与商城「目录之外的 id 一律 404」同口径：
   * 白名单在数据里，不在代码里。
   *
   * #545 之前这里直接读生成物：管理端把某种材料的卖价从 2 调到 20，客户端背包显示 20
   * （快照覆写生效），服务端仍按 2 付钱 —— 玩家看到的是「价签不对」，我们看到的应该是
   * 「这条链路还没接库」。
   *
   * **整单结算**：任何一条不合法（不可卖 / 数量不够）都不落库，不存在「卖了一半」的存档
   * （与 grantQuestRewards 的校验期抛错语义一致）。同 id 的多条先合并 —— 一键回收会把
   * 同一件装备的多个格子拆成多条报上来。
   */
  sellGoods(accountId: string, roleId: string, dto: SellGoodsDto): SellGoodsResultDto {
    const account = this.mustAccount(accountId);
    const existing = this.mustOwnRole(accountId, roleId);
    // 与购买 / 升级同一纪律：被踢下线的角色不能继续结算
    if (account.online_role_id !== roleId) {
      throw BizException.conflict(BizCode.ROLE_KICKED, "该角色已被管理员下线，请重新选择角色进入游戏");
    }
    if (dto.revision !== undefined && dto.revision !== existing.revision) {
      throw BizException.conflict(BizCode.ROLE_REVISION_CONFLICT, "该角色已在别处被修改，请先同步最新数据");
    }

    const data = decodeStoredRoleData(existing.data);
    const wanted = new Map<string, number>();
    for (const entry of dto.entries) {
      const count = Math.max(1, Math.floor(entry.count));
      wanted.set(entry.goodId, (wanted.get(entry.goodId) ?? 0) + count);
    }

    // 1) 计价：价签读运营库（缺省回落出厂价签），客户端报的价一概不看
    const sold: SellLineDto[] = [];
    let total = 0;
    for (const [goodId, count] of wanted) {
      const unitPrice = Math.max(0, Math.floor(sellPriceOf(goodId) ?? 0));
      if (unitPrice <= 0) {
        throw BizException.conflict(BizCode.SELL_NOT_SELLABLE, `该物品不可出售：${goodId}`);
      }
      const line = new SellLineDto();
      line.goodId = goodId;
      line.count = count;
      line.unitPrice = unitPrice;
      line.total = unitPrice * count;
      sold.push(line);
      total += line.total;
    }

    // 2) 扣物：先点数后扣，任何一条不够都整单拒绝（异常路径不落库）
    for (const line of sold) {
      this.takeGoodsFromBag(data, line.goodId, line.count, {
        code: BizCode.SELL_NOT_ENOUGH,
        message: `背包里的物品不够出售：${line.goodId}`,
      });
    }

    // 3) 入账（绑定元宝，与背包「一键回收」的展示口径一致）
    data.bindGold = Math.max(0, Math.floor(Number(data.bindGold) || 0)) + total;

    const row: RoleRow = {
      ...existing,
      data: JSON.stringify(data),
      revision: existing.revision + 1,
      updated_at: Date.now(),
    };
    this.roles.replace(row);
    return SellGoodsResultDto.fromRow(row, account.online_role_id, sold, total);
  }

  /**
   * 拾取入包（#325：地面掉落物的格子级入包，权威在服务端）
   *
   * 与商城购买同一套格子语义，多一层**叠加**：可叠加物品（药品/材料）先吃已有堆
   * （单格上限 maxStack 封顶，与客户端 StorageManager.addGood / tidyBagGrid 同口径），
   * 吃不下再占空格；装备不可叠加，每件一格。整份放不下 → 20012 拒拾，
   * **存档一个字节都不动**（地面掉落物保留，玩家腾出格子后可再拾）。
   *
   * 调用方（实时通道的 pick 帧）已按账本校验过归属 —— 账本按账号隔离，别的账号
   * 既看不到这次掉落也没有账可查；这里只对「当前在线角色」入包。
   *
   * @returns 入包后的修订号与实际写入的格子（客户端照搬合并进本地背包 + revision 基线）
   */
  pickDrop(accountId: string, goodId: string, count: number): PickDropResult {
    const account = this.mustAccount(accountId);
    const roleId = account.online_role_id;
    if (!roleId) throw BizException.conflict(BizCode.ROLE_NOT_FOUND, "当前没有在线角色，无法拾取");
    const existing = this.roles.findById(roleId);
    if (!existing || existing.account_id !== accountId) {
      throw BizException.conflict(BizCode.ROLE_NOT_FOUND, "当前没有在线角色，无法拾取");
    }

    // 物品类型来自生成物总表：掉落表是管理端可改的数据，里面配上不存在的 id 要在这里拦下
    const itemType: string | undefined = (ITEM_TYPES as Record<string, string>)[goodId];
    if (!itemType) throw BizException.conflict(BizCode.ROLE_DATA_INVALID, `掉落物品不存在：${goodId}`);

    const data = decodeStoredRoleData(existing.data);
    const placed = this.placeGoodsIntoBag(data, goodId, itemType, Math.max(1, Math.floor(count)));

    const row: RoleRow = {
      ...existing,
      data: JSON.stringify(data),
      revision: existing.revision + 1,
      updated_at: Date.now(),
    };
    this.roles.replace(row);
    return { revision: row.revision, placed };
  }

  /**
   * 往存档的背包网格里放一份物品（叠加优先，行优先占空格）
   *
   * 叠加语义与客户端 `StorageManager.addGood` 完全同口径：可叠加物品先找同 id 的
   * 已有堆吃（单格 maxStack 封顶），吃不下再找空格按 maxStack 分堆；不可叠加每格一件。
   * 放不下整份时抛 20012 —— data 已被就地修改，但调用方在异常路径上不会落库，
   * 存档不受影响。
   *
   * @throws MALL_BAG_FULL 背包剩余空间放不下整份（或网格结构不合法）
   */
  private placeGoodsIntoBag(
    data: Record<string, unknown>,
    goodId: string,
    itemType: string,
    count: number,
  ): Array<{ row: number; col: number; id: string; count: number }> {
    const bag = data.bag;
    if (!Array.isArray(bag)) throw BizException.conflict(BizCode.MALL_BAG_FULL, "背包数据不完整，无法放入物品");
    // 单格上限：装备没有叠加概念（1）；药品/材料从各自的表读 maxStack（#252/#255 起入库），读不到按 99
    // #544 起先查运营库覆盖层：管理端改药品叠加上限对服务端入包即时生效
    const stackable = itemType !== "equipment";
    const stackRow = stackable ? (drugOf(goodId) ?? itemBaseOf(goodId)) : undefined;
    const maxStack = stackable ? Math.max(1, Math.floor(Number(stackRow && (stackRow as Record<string, unknown>).maxStack) || 99)) : 1;

    const placed: Array<{ row: number; col: number; id: string; count: number }> = [];
    let remaining = count;
    const grid = bag as unknown[][];

    // 第一轮：吃已有堆（只有可叠加物品走得到）
    if (stackable) {
      for (let row = 0; row < grid.length && remaining > 0; row++) {
        const line = grid[row];
        if (!Array.isArray(line)) continue;
        for (let col = 0; col < line.length && remaining > 0; col++) {
          const cell = line[col];
          if (!cell || typeof cell !== "object" || (cell as Record<string, unknown>).id !== goodId) continue;
          const current = Math.max(1, Math.floor(Number((cell as Record<string, unknown>).count) || 1));
          const room = maxStack - current;
          if (room <= 0) continue;
          const take = Math.min(room, remaining);
          line[col] = { id: goodId, count: current + take };
          placed.push({ row, col, id: goodId, count: current + take });
          remaining -= take;
        }
      }
    }

    // 第二轮：占空格（可叠加按 maxStack 分堆，不可叠加每格一件）
    for (let row = 0; row < grid.length && remaining > 0; row++) {
      const line = grid[row];
      if (!Array.isArray(line)) continue;
      for (let col = 0; col < line.length && remaining > 0; col++) {
        const cell = line[col];
        if (cell && typeof cell === "object" && (cell as Record<string, unknown>).id) continue;
        const take = Math.min(maxStack, remaining);
        line[col] = { id: goodId, count: take };
        placed.push({ row, col, id: goodId, count: take });
        remaining -= take;
      }
    }

    if (remaining > 0) throw BizException.conflict(BizCode.MALL_BAG_FULL, "背包已满，无法放入物品");
    return placed;
  }

  /** 当前在线角色的修订号（不在线返回 null）—— 拾取幂等重放应答要用 */
  onlineRevision(accountId: string): number | null {
    const account = this.accounts.findById(accountId);
    const row = account?.online_role_id ? this.roles.findById(account.online_role_id) : undefined;
    return row ? row.revision : null;
  }

  /**
   * 往存档的背包网格里放一件商品（行优先找第一个空格；装备不可叠加，每件占一格）
   *
   * @throws MALL_BAG_FULL 网格里没有空格（或网格结构不合法 —— 结构坏了放东西只会越放越乱，同样拒绝）
   */
  private putGoodIntoBag(data: Record<string, unknown>, goodId: string): void {
    const bag = data.bag;
    if (!Array.isArray(bag)) throw BizException.conflict(BizCode.MALL_BAG_FULL, "背包数据不完整，无法放入商品");
    for (const line of bag) {
      if (!Array.isArray(line)) continue;
      for (let col = 0; col < line.length; col++) {
        const cell = line[col];
        if (cell && typeof cell === "object" && (cell as Record<string, unknown>).id) continue;
        line[col] = { id: goodId, count: 1 };
        return;
      }
    }
    throw BizException.conflict(BizCode.MALL_BAG_FULL, "背包已满，无法放入商品");
  }

  /**
   * 药品使用（玩家侧 #308）：回复结算与格子扣减都在服务端
   *
   * 客户端只报「用背包哪一格」，这里完成整条链：格子校验 → 查 drugs 表（管理端改回复量
   * 即时生效，与 #258 怪物数值读库同一取向）→ 回复量合成 → 血蓝各自封顶 → 扣减格子 →
   * revision 原子 +1。
   *
   * 回复量口径与客户端 `resolveDrugRecovery` 对齐（drugs 表存的是**按键求和后的单值**）：
   * hp = effect_hp + effect_hp_percent ÷ 100 × maxHp，魔法同理，四舍五入，负值按 0。
   * maxHp / maxMp 用**服务端重算**的战斗属性（与 combat 比对同源，客户端报多少不算数）；
   * 等级不在成长曲线里（重算不出）时退回存档里客户端上报的那份 —— 用药是恢复性操作，
   * 兜底比拒绝更符合玩家预期。
   *
   * 失败路径：20013 格子为空 / 非药品 / 无生效回复量；20014 血蓝均已满（回复不动任何一项）。
   * 冷却（drugs.cooldown）目前仍归客户端快捷键节流管，服务端不计时 —— 与客户端现状一致。
   */
  useDrug(accountId: string, roleId: string, dto: DrugUseDto): DrugUseResultDto {
    const account = this.mustAccount(accountId);
    const existing = this.mustOwnRole(accountId, roleId);
    // 与升级 / 购买同一纪律：被踢下线的角色不能继续用药（用药也是写）
    if (account.online_role_id !== roleId) {
      throw BizException.conflict(BizCode.ROLE_KICKED, "该角色已被管理员下线，请重新选择角色进入游戏");
    }
    if (dto.revision !== undefined && dto.revision !== existing.revision) {
      throw BizException.conflict(BizCode.ROLE_REVISION_CONFLICT, "该角色已在别处被修改，请先同步最新数据");
    }

    const data = decodeStoredRoleData(existing.data);
    const cell = this.readBagCell(data, dto.row, dto.col);
    // 格子里必须是药品表里登记过的 id：背包里也可能有装备 / 材料，那些不走用药
    const drug = this.drugs.findByKey(cell.id);
    if (!drug) throw BizException.conflict(BizCode.DRUG_USE_TARGET_INVALID, "该格子不是可使用的药品");

    // 有没有可生效的回复分量（配置四项全 0 的药等于没实现）
    const healsHp = drug.effect_hp > 0 || drug.effect_hp_percent > 0;
    const healsMp = drug.effect_mp > 0 || drug.effect_mp_percent > 0;
    if (!healsHp && !healsMp) {
      throw BizException.conflict(BizCode.DRUG_USE_TARGET_INVALID, "该药品没有任何生效的回复效果");
    }

    const { maxHp, maxMp } = this.resolveResourceLimits(existing, data);
    const hp = Math.max(0, Math.floor(Number(data.hp) || 0));
    const mp = Math.max(0, Math.floor(Number(data.mp) || 0));
    // 血蓝都已满（该药对应的资源都回不动）→ 拒用不扣药（与客户端预检同一判定式）
    const hpFull = hp >= maxHp;
    const mpFull = mp >= maxMp;
    if ((!healsHp || hpFull) && (!healsMp || mpFull)) {
      throw BizException.conflict(BizCode.DRUG_RESOURCE_FULL, healsHp ? "血量已满，无需使用" : "魔法值已满，无需使用");
    }

    // 未封顶期望回复量（负值按 0 —— 配置写错不会倒扣血蓝）
    const expectHp = healsHp ? Math.max(0, Math.round(drug.effect_hp + (drug.effect_hp_percent / 100) * maxHp)) : 0;
    const expectMp = healsMp ? Math.max(0, Math.round(drug.effect_mp + (drug.effect_mp_percent / 100) * maxMp)) : 0;
    // 各自封顶后生效（血满蓝不满也照用，只回蓝的部分）
    const recoveredHp = healsHp && !hpFull ? Math.min(maxHp, hp + expectHp) - hp : 0;
    const recoveredMp = healsMp && !mpFull ? Math.min(maxMp, mp + expectMp) - mp : 0;
    if (healsHp && !hpFull) data.hp = hp + recoveredHp;
    if (healsMp && !mpFull) data.mp = mp + recoveredMp;

    // 扣减格子数量（药品可叠加，减到 0 清格；格子对象整个换新，避免共享引用）
    const remaining = Math.max(1, cell.count) - 1;
    const bagLine = (data.bag as unknown[][])[dto.row] as (Record<string, unknown> | null)[];
    bagLine[dto.col] = remaining > 0 ? { id: cell.id, count: remaining } : null;

    const row: RoleRow = {
      ...existing,
      data: JSON.stringify(data),
      revision: existing.revision + 1,
      updated_at: Date.now(),
    };
    this.roles.replace(row);
    return DrugUseResultDto.fromRow(row, account.online_role_id, drug.id, recoveredHp, recoveredMp);
  }

  /** 读存档背包网格的指定格子（网格不是数组 / 坐标越界 / 格子为空 → 同一个 20013 失败语义） */
  private readBagCell(data: Record<string, unknown>, row: number, col: number): { id: string; count: number } {
    const bag = data.bag;
    const line = Array.isArray(bag) ? (bag as unknown[])[row] : undefined;
    const cell = Array.isArray(line) ? (line as unknown[])[col] : undefined;
    if (!cell || typeof cell !== "object" || typeof (cell as Record<string, unknown>).id !== "string") {
      throw BizException.conflict(BizCode.DRUG_USE_TARGET_INVALID, "该格子为空，没有可使用的药品");
    }
    const record = cell as Record<string, unknown>;
    return { id: record.id as string, count: Math.max(1, Math.floor(Number(record.count) || 1)) };
  }

  /**
   * 用药的资源上限：服务端重算（与 combat 比对同源）优先，重算不出退回存档里客户端上报的值
   * （等级不在成长曲线里属于旧存档边角情况，恢复性操作走兜底而不是拒绝）
   */
  private resolveResourceLimits(existing: RoleRow, data: Record<string, unknown>): { maxHp: number; maxMp: number } {
    const summary = summarizeRoleAttributes(roleAttributeSourceOf(existing.level, data));
    if (summary) return { maxHp: summary.maxHp, maxMp: summary.maxMp };
    return {
      maxHp: Math.max(1, Math.floor(Number(data.maxHp) || 0)),
      maxMp: Math.max(1, Math.floor(Number(data.maxMp) || 0)),
    };
  }

  /**
   * 怪物普攻的玩家受击落账（#323：玩家血量的权威在服务端）
   *
   * 结算侧（MonsterAiService）算出伤害后交给这里：扣 `data.hp`、封 0、立即落库。
   * **刻意不推进 revision** —— 血量在实时模式下以服务端帧为准（客户端收到 hit 帧
   * 照搬），revision 只由「进度型」写入（升级 / 购买 / 用药 / 击杀经验）推进；
   * 若每次受击都 +1，战斗期间的防抖存档会频繁撞乐观锁，玩家存档反而不停失败。
   * 代价是「落库的血量」与「客户端在途存档的血量」有一个防抖窗口的竞态，
   * 以服务端后续的 hit 帧为准自愈 —— 窗口内旧值回写只影响一拍，不积累。
   *
   * @returns 受击后的血量与服务端重算的资源上限；角色不在线 / 已死亡返回 null
   *          （调用方据此停止追击，不视为错误）
   */
  applyMonsterHit(accountId: string, damage: number): { hp: number; maxHp: number } | null {
    const account = this.accounts.findById(accountId);
    const existing = account && account.online_role_id ? this.roles.findById(account.online_role_id) : undefined;
    if (!account || !existing || account.online_role_id !== existing.id) return null;

    const data = decodeStoredRoleData(existing.data);
    const previous = Math.max(0, Math.floor(Number(data.hp) || 0));
    if (previous <= 0) return null; // 已经死了：不再扣也不再报
    const { maxHp } = this.resolveResourceLimits(existing, data);
    const hp = Math.max(0, previous - Math.max(0, Math.floor(damage)));
    data.hp = hp;
    // 不推进修订号（见方法注释）：血量以实时帧为准，revision 留给进度型写入
    this.roles.updateDataKeepRevision(existing.id, JSON.stringify(data), Date.now());
    return { hp, maxHp };
  }

  /**
   * 击杀计数 +1（#400：排行榜的原料）
   *
   * 与 `applyKillExp` **分开调**，因为两者的判定不同：
   * - 经验会因等级差过大而记 0（`settleKillReward` 里 `exp > 0` 才入账）；
   * - 击杀数不看过不过期 —— 杀了就是杀了，哪怕一分经验没有。
   *
   * 刻意不做「在线校验」：玩家刚好在击杀那一瞬被踢下线，这只怪也是他杀的。
   * 也不推进 `revision`（见仓储 `incrementKills` 的注释）—— 客户端存档里没有这一列，
   * 推进修订号只会制造一次假的乐观锁冲突。
   */
  recordKill(roleId: string): void {
    this.roles.incrementKills(roleId);
  }

  /**
   * 击杀经验入账（#316：经验的结算在服务端）
   *
   * 结算侧算出本次经验后交给这里落账：累加进存档 `data.exp`，按 **level_exps 表**（#256
   * 管理端可改，即时生效）判定升级、循环升到曲线封顶（`growth_scalars.roleMaxLevel`），
   * `roles.level` 索引列与 revision 原子推进。
   *
   * @returns 入账后的角色状态（level / expNow / expNeed / leveledUp / revision）；
   *          角色已被踢下线等无法落账的情况返回 null（调用方跳过奖励，不视为错误）
   */
  applyKillExp(accountId: string, roleId: string, exp: number, options: { refillOnLevelUp?: boolean } = {}): KillExpResult | null {
    const account = this.accounts.findById(accountId);
    const existing = account ? this.roles.findById(roleId) : undefined;
    // 与升级 / 购买同一纪律：被踢下线的角色不能再推进度（结算进行到一半被踢是正常情况）
    if (!account || !existing || existing.account_id !== accountId || account.online_role_id !== roleId) return null;

    const data = decodeStoredRoleData(existing.data);
    const gain = Math.max(0, Math.floor(exp));
    let level = Math.max(1, existing.level);
    let expNow = Math.max(0, Math.floor(Number(data.exp) || 0)) + gain;
    let leveledUp = false;
    const maxLevel = this.roleMaxLevel();
    let expNeed = this.expNeedOf(level);
    while (level < maxLevel && expNeed > 0 && expNow >= expNeed) {
      expNow -= expNeed;
      level += 1;
      leveledUp = true;
      expNeed = this.expNeedOf(level);
    }

    data.exp = expNow;
    // 等级变了属性就变：服务端重算并写回存档（权威值，客户端那份只是演）
    this.applyAuthoritativeAttributes(level, data);
    // 击杀者侧的升级惯例：补满血蓝（队友分经验路径**不补** —— 队友打怪不是我在挨打，
    // 与客户端 applyPartyExpGain 的纪律一致；refillOnLevelUp 由调用方按路径传）
    if (leveledUp && options.refillOnLevelUp) {
      data.hp = data.maxHp;
      data.mp = data.maxMp;
    }
    const row: RoleRow = {
      ...existing,
      level,
      data: JSON.stringify(data),
      revision: existing.revision + 1,
      updated_at: Date.now(),
    };
    this.roles.replace(row);
    return { level, expNow, expNeed, leveledUp, revision: row.revision };
  }

  /**
   * 背包里某物品的总数（collect 型任务交付判定与进度展示用）
   *
   * 只读不写：数量够不够由任务侧判断，这里的职责就是把存档网格数清楚。
   * 没有在线角色返回 0（不抛 —— 进度展示不该因「刚被踢下线」炸掉）。
   */
  countGoodInBag(accountId: string, goodId: string): number {
    const account = this.accounts.findById(accountId);
    const roleId = account?.online_role_id;
    const existing = roleId ? this.roles.findById(roleId) : undefined;
    if (!account || !roleId || !existing || existing.account_id !== accountId) return 0;
    const data = decodeStoredRoleData(existing.data);
    return this.countGoods(data, goodId);
  }

  /**
   * 交付类发奖（#396 任务 / #401 成就共用）：扣收集材料 + 发奖励 + 升级，**一次落库**
   *
   * 刻意不复用 `applyKillExp` + `pickDrop` 的组合 —— 那会写两次库、revision +2，
   * 客户端在途存档更容易撞乐观锁。整条链（材料不足 20017 / 背包放不下 20012）
   * 都在校验阶段抛出，异常路径不落库，存档保持原样。
   *
   * `consume` 只有任务的 collect 目标会用到（成就没有「要先交东西」的语义，传 null）。
   *
   * @returns 发奖后的角色状态（与 KillExpResult 同形状，外加发奖后的修订号）
   */
  grantQuestRewards(
    accountId: string,
    roleId: string,
    consume: { goodId: string; count: number } | null,
    rewards: { gold: number; exp: number; items: Array<{ goodId: string; count: number }> },
  ): KillExpResult {
    const existing = this.onlineRoleOrThrow(accountId, roleId);
    const data = decodeStoredRoleData(existing.data);

    // 1) collect 材料：先点数再扣（不够整单拒绝，不做部分扣除）
    if (consume) {
      this.takeGoodsFromBag(data, consume.goodId, Math.max(1, Math.floor(consume.count)));
    }

    // 2) 奖励物品：逐份入包（放不下 20012，此时还没落库）
    for (const item of rewards.items ?? []) {
      const itemType: string | undefined = (ITEM_TYPES as Record<string, string>)[item.goodId];
      if (!itemType) throw BizException.conflict(BizCode.ROLE_DATA_INVALID, `奖励物品不存在：${item.goodId}`);
      this.placeGoodsIntoBag(data, item.goodId, itemType, Math.max(1, Math.floor(item.count)));
    }

    // 3) 金币（都在 data JSON 里，没有专用列）
    data.gold = Math.max(0, Math.floor(Number(data.gold) || 0)) + Math.max(0, Math.floor(rewards.gold ?? 0));

    // 4) 经验 + 升级（与 applyKillExp 同一算法：level_exps 表判定、循环升到曲线封顶）
    let level = Math.max(1, existing.level);
    let expNow = Math.max(0, Math.floor(Number(data.exp) || 0)) + Math.max(0, Math.floor(rewards.exp ?? 0));
    let leveledUp = false;
    const maxLevel = this.roleMaxLevel();
    let expNeed = this.expNeedOf(level);
    while (level < maxLevel && expNeed > 0 && expNow >= expNeed) {
      expNow -= expNeed;
      level += 1;
      leveledUp = true;
      expNeed = this.expNeedOf(level);
    }
    data.exp = expNow;
    // 升级（或任何写档）后属性以服务端重算为准；不补血蓝 —— 发奖路径没有「升级回满」的惯例
    this.applyAuthoritativeAttributes(level, data);

    const row: RoleRow = {
      ...existing,
      level,
      data: JSON.stringify(data),
      revision: existing.revision + 1,
      updated_at: Date.now(),
    };
    this.roles.replace(row);
    return { level, expNow, expNeed, leveledUp, revision: row.revision };
  }

  /** 背包网格里某物品的总数 */
  private countGoods(data: Record<string, unknown>, goodId: string): number {
    const bag = data.bag;
    if (!Array.isArray(bag)) return 0;
    let total = 0;
    for (const line of bag) {
      if (!Array.isArray(line)) continue;
      for (const cell of line) {
        if (cell && typeof cell === "object" && (cell as Record<string, unknown>).id === goodId) {
          total += Math.max(0, Math.floor(Number((cell as Record<string, unknown>).count) || 0));
        }
      }
    }
    return total;
  }

  /**
   * 从背包网格扣走一份物品（先点数后扣）
   *
   * 判据与搬运只有这一处实现：任务交付（collect 材料）与出售（#397）都调它，
   * 只是「不够」的业务码与文案不同（默认 20017 材料不足，出售传 20019）。
   *
   * @throws 由 `lack` 指定（默认 QUEST_MATERIAL_SHORT 材料不足）
   */
  private takeGoodsFromBag(
    data: Record<string, unknown>,
    goodId: string,
    count: number,
    lack: { code: number; message: string } = { code: BizCode.QUEST_MATERIAL_SHORT, message: "材料不足，无法交付任务" },
  ): void {
    if (this.countGoods(data, goodId) < count) {
      throw BizException.conflict(lack.code, lack.message);
    }
    let remaining = count;
    const bag = data.bag as unknown[][];
    for (let row = 0; row < bag.length && remaining > 0; row++) {
      const line = bag[row];
      if (!Array.isArray(line)) continue;
      for (let col = 0; col < line.length && remaining > 0; col++) {
        const cell = line[col];
        if (!cell || typeof cell !== "object" || (cell as Record<string, unknown>).id !== goodId) continue;
        const current = Math.max(1, Math.floor(Number((cell as Record<string, unknown>).count) || 1));
        const take = Math.min(current, remaining);
        if (take >= current) line[col] = null;
        else line[col] = { id: goodId, count: current - take };
        remaining -= take;
      }
    }
  }

  /** 当前在线的那份角色行（交付 / 发奖的公共前置：没在线角色或角色不属于该账号一律拒绝） */
  private onlineRoleOrThrow(accountId: string, roleId: string): RoleRow {
    const account = this.mustAccount(accountId);
    if (account.online_role_id !== roleId) {
      throw BizException.conflict(BizCode.ROLE_KICKED, "该角色已被管理员下线");
    }
    const existing = this.roles.findById(roleId);
    if (!existing || existing.account_id !== accountId) {
      throw BizException.conflict(BizCode.ROLE_NOT_FOUND, "当前没有在线角色");
    }
    return existing;
  }

  /** 升到下一级所需经验（level_exps 表；升级路径与实时进程 roleUpdate 帧共用；曲线没铺到的等级回落 0） */
  expNeedAt(level: number): number {
    return this.expNeedOf(level);
  }

  private expNeedOf(level: number): number {
    return Math.max(0, Math.floor(Number(this.growth.findLevelExp(level)?.exp) || 0));
  }

  /** 等级上限（growth_scalars 表，管理端可改；读不到退回生成物 seed 值） */
  private roleMaxLevel(): number {
    const fromDb = Number(this.growth.findScalar("roleMaxLevel")?.value);
    if (Number.isFinite(fromDb) && fromDb >= 1) return Math.floor(fromDb);
    return Math.max(1, Math.floor(Number(GROWTH_SCALARS.roleMaxLevel) || 60));
  }

  /**
   * 战斗属性与战斗力的**权威重算**：按等级 + 存档（装备/战魂/称号/军衔）现算，
   * 直接覆盖 `data` 里的八项属性与 combat
   *
   * #541 起客户端不再自己算这些值（它那份只是演），凡是服务端写档的路径都要经过这里，
   * 保证库里落的一定是服务端公式的结果。等级不在成长曲线里（旧存档边角）时跳过 ——
   * 保留原值总比把属性抹成 0 好。
   */
  private applyAuthoritativeAttributes(level: number, data: Record<string, unknown>): void {
    const summary = summarizeRoleAttributes(roleAttributeSourceOf(level, data));
    if (!summary) return;
    data.maxHp = summary.maxHp;
    data.hpRecover = summary.hpRecover;
    data.maxMp = summary.maxMp;
    data.physicalAttack = Array.from(summary.physicalAttack);
    data.magicAttack = Array.from(summary.magicAttack);
    data.taoistAttack = Array.from(summary.taoistAttack);
    data.physicalDefense = Array.from(summary.physicalDefense);
    data.magicDefense = Array.from(summary.magicDefense);
    data.taoistDefense = Array.from(summary.taoistDefense);
    data.combat = summary.combat;
  }

  /**
   * 客户端上报的战斗属性与服务端重算还差多少（save 路径的可观测点）
   *
   * #541 起客户端已经不算属性了，这个比对从「防客户端算法漂移」降级为「写库前顺手看一眼
   * 上报值有多旧」：mismatch 只打一条可检索的 warn，**随后 `applyAuthoritativeAttributes`
   * 无条件用服务端结果覆盖落库** —— 观测与权威是两条独立的线，warn 不拦流程、
   * 权威不靠 warn。一致时什么都不打（每次推进度都刷一条等于没有日志）。
   */
  private warnIfAttributesMismatch(roleId: string, level: number, data: Record<string, unknown>): void {
    const comparison = compareRoleAttributesOfRole(level, data);
    if (!comparison.mismatch || !comparison.server) return;
    this.logger.warn(
      `角色 ${roleId}（等级 ${level}）上报的战斗属性与服务端重算不一致：` +
        `服务端 combat=${comparison.server.combat} maxHp=${comparison.server.maxHp}；` +
        `客户端 combat=${comparison.reported.combat} maxHp=${comparison.reported.maxHp}`,
    );
  }

  /**
   * 账本 / 成长线阶位以库为准（权威边界见 `role-authority.ts`）
   *
   * 与 `warnIfAttributesMismatch` 的关系：那条是「派生值算不算得出对」，这条是
   * 「这个字段根本不该由客户端决定」。前者记日志后照样覆盖，后者记日志后**也照样落库**
   * （回填成库里的值再落）—— 都不拒收，因为拒收会让「客户端少收了一帧」变成玩不了。
   */
  private enforceAuthority(stored: Record<string, unknown>, incoming: Record<string, unknown>): void {
    const drift = enforceServerAuthority(stored, incoming);
    if (!drift.length) return;
    // 一个字段一条会比实际短：正常情况下 drift 恒为空（客户端从不本地改这些），
    // 真出现时往往一整批一起出现，合并成一条更好读
    this.logger.warn(
      `账号存档里改动了服务端独占字段，已按库中值为准：` +
        drift.map((d) => `${d.field}（库里 ${JSON.stringify(d.stored)}，上报 ${JSON.stringify(d.reported)}）`).join("；"),
    );
  }

  /**
   * 账号当前在线角色的整行快照（实时进程的 roleUpdate 轮询用）
   *
   * 只做归属校验与取行：属性重算与帧组装在通道侧（它知道该什么时候推）。
   * 没有在线角色 / 角色不属于这个账号返回 null。
   */
  onlineRoleRow(accountId: string): RoleRow | null {
    const account = this.accounts.findById(accountId);
    const roleId = account?.online_role_id;
    if (!roleId) return null;
    const row = this.roles.findById(roleId);
    return row && row.account_id === accountId ? row : null;
  }

  /** 选中（在线）角色（#547：标记与心跳一起置上，宽限期从这一刻起算） */
  select(accountId: string, roleId: string): RoleDto {
    this.mustAccount(accountId);
    const row = this.mustOwnRole(accountId, roleId);
    this.accounts.setOnlineRole(accountId, row.id);
    return RoleDto.from(row, row.id);
  }

  /** 删除角色（删掉的正好是在线角色时，顺带清掉账号上的在线标记） */
  remove(accountId: string, roleId: string): null {
    this.mustAccount(accountId);
    this.mustOwnRole(accountId, roleId);
    this.roles.deleteById(roleId);
    this.accounts.clearOnlineRole(accountId, roleId);
    return null;
  }

  /** 账号必须存在（守卫已校验，这里兜底防御 + 供服务层内部取在线角色） */
  private mustAccount(accountId: string): AccountRow {
    const account = this.accounts.findById(accountId);
    if (!account) throw BizException.notFound(BizCode.ACCOUNT_NOT_FOUND, "账号不存在");
    return account;
  }

  /**
   * 角色必须存在且属于该账号
   * @throws BizException 不存在 → 404；存在但不属于该账号 → 403（越权）
   */
  private mustOwnRole(accountId: string, roleId: string): RoleRow {
    const row = this.roles.findById(roleId);
    if (!row) throw BizException.notFound(BizCode.ROLE_NOT_FOUND, "角色不存在");
    if (row.account_id !== accountId) {
      throw new BizException(BizCode.FORBIDDEN, "无权操作该角色", HttpStatus.FORBIDDEN);
    }
    return row;
  }
}
