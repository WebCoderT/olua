import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";
import { compareRoleAttributesOfRole } from "../combat/role-attribute-comparison";
import { MallPricingService } from "../game-config/mall-pricing.service";
import { AccountRepository } from "../../database/repositories/account.repository";
import { RankRepository } from "../../database/repositories/rank.repository";
import { RoleRepository } from "../../database/repositories/role.repository";
import { SoulRepository } from "../../database/repositories/soul.repository";
import { TitleRepository } from "../../database/repositories/title.repository";
import { AccountRow, RankRow, RoleRow, SoulRow, TitleRow } from "../../database/rows";
import { CreateRoleDto, SaveRoleDto } from "./dto/create-role.dto";
import { GrowthUpgradeDto, GrowthKind } from "./dto/growth-upgrade.dto";
import { GrowthUpgradeResultDto, RoleDto, RoleSummaryDto } from "./dto/role.dto";
import { MallPurchaseDto, MallPurchaseResultDto } from "./dto/mall-purchase.dto";
import { decodeStoredRoleData, parseRoleData } from "./role-data.util";

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
    private readonly config: ConfigService,
    private readonly titles: TitleRepository,
    private readonly souls: SoulRepository,
    private readonly ranks: RankRepository,
    private readonly mallPricing: MallPricingService,
  ) {}

  /**
   * 角色数量上限（**业务上限只在这一处**）
   *
   * 客户端**没有**第二份数字：它那边的「上限」是选角界面的**站位数量**
   * （`configs/layout/scenes` 的 `roleSelectorLayout.rolePositions`），那是界面容量。
   * 所以这个值**只能调低** —— 不得超过站位数量，否则玩家能建出界面上没处放的角色
   * （多出来的取不到站位，会叠在原点）。这条关系由 `tools/audit-shared-data.cjs` 守着。
   */
  private get maxRoles(): number {
    return this.config.get<number>("roleMaxPerAccount") ?? 3;
  }

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
   * 创建角色
   *
   * 校验顺序：数量上限 → id 是否已存在 → 同账号是否重名。
   * 第一个角色自动设为在线（与客户端「建完就能进游戏」的体验一致）。
   */
  create(accountId: string, dto: CreateRoleDto): RoleDto {
    const account = this.mustAccount(accountId);
    const { fields, data } = parseRoleData(dto.data);

    if (this.roles.countByAccount(accountId) >= this.maxRoles) {
      throw BizException.conflict(BizCode.ROLE_LIMIT, `角色数量已达上限（最多 ${this.maxRoles} 个）`);
    }
    if (this.roles.findById(fields.id)) throw BizException.conflict(BizCode.ROLE_ID_EXISTS, "角色 id 已存在，请重试");
    if (this.roles.findByAccountAndName(accountId, fields.name)) throw BizException.conflict(BizCode.ROLE_NAME_EXISTS, "该账号下已存在同名角色");

    const now = Date.now();
    const row: RoleRow = {
      id: fields.id,
      account_id: accountId,
      name: fields.name,
      occupation: fields.occupation,
      sex: fields.sex,
      level: fields.level,
      data: JSON.stringify(data),
      revision: 1,
      created_at: now,
      updated_at: now,
    };
    this.roles.insert(row);
    // 这里**刻意不做**战斗属性比对（与 save 那条不同）：
    // 建号这份 data 是客户端 `new Role(...)` **刚构造出来的初始存档**，它的 `combat` 是构造函数里的
    // 占位值（`maxHp * 10`），压根没经过 `GameHelper.combatCalc` —— 实测 1 级裸角色重算是 2310、
    // 而占位值是 1000，**必然不一致**。那不是任何人的 bug，比了只会每次建号刷一条噪音。
    if (!account.online_role_id) this.accounts.updateById(accountId, { online_role_id: row.id });
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

    const row: RoleRow = {
      ...existing,
      name: fields.name,
      occupation: fields.occupation,
      sex: fields.sex,
      level: fields.level,
      data: JSON.stringify(data),
      // 与 replace() 里的 `revision = revision + 1` 对齐：SQL 只是落库，这里要给出**落库后**的值，
      // 否则响应里的 revision 比库里小 1，客户端拿它做基线会立刻撞乐观锁（自锁死循环）
      revision: existing.revision + 1,
      updated_at: Date.now(),
    };
    this.roles.replace(row);
    this.warnIfAttributesMismatch(row.id, row.level, data);
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
   * 玩家上报的那份战斗属性，与服务端重算的对不对得上
   *
   * ===========================================================================
   * 为什么在这里做（而不是只靠管理端详情那个 `derived.mismatch`）
   * ===========================================================================
   * 详情接口上的那个布尔要**有人点开才发生** —— 那是抽查。而这里是**玩家每次推进度都会经过**
   * 的地方，是唯一的全量观测点：客户端口径一旦漂了，当天就能在日志里看见，
   * 不必等哪天有人翻后台。
   *
   * ===========================================================================
   * 只记不拦
   * ===========================================================================
   * **不改写存档、不拒绝写入**。存进去了就是玩家的存档 —— 服务端没有纠正它的立场，
   * 而且 `mismatch` 也不等于作弊：
   *
   * - 玩家在「升级」与「下一次 combatCalc」之间存档 → 客户端那份是旧的 → 会命中
   * - 存档里留着客户端配置已经删掉的装备 id → 会命中
   * - 客户端配置漂了、服务端快照还没跟上 → 会命中（有 audit-shared-data 守着部署时的一致性）
   *
   * 拿它去拒收，正常玩法当场被打断。所以这里只让它变成一条**能检索**的日志。
   *
   * 一致时**什么都不打**（不打 info —— 每次推进度都刷一条等于没有日志）。
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

  /** 选中（在线）角色 */
  select(accountId: string, roleId: string): RoleDto {
    this.mustAccount(accountId);
    const row = this.mustOwnRole(accountId, roleId);
    this.accounts.updateById(accountId, { online_role_id: row.id });
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
