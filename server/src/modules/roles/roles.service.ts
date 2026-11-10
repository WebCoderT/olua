import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BizCode } from "../../common/constants/biz-code";
import { ROLE_MAX_PER_ACCOUNT_DEFAULT } from "../../common/constants/role";
import { todayResetDay } from "../../common/utils/daily-clock";
import { BizException } from "../../common/errors/biz.exception";
import { bindOnDropOf } from "../../common/runtime-config-cache";
import { compareRoleAttributesOfRole } from "../combat/role-attribute-comparison";
import { roleAttributeSourceOf, summarizeRoleAttributes } from "../combat/role-attributes";
import { MallPricingService } from "../game-config/mall-pricing.service";
import {
  drugOf,
  equipmentLevelOf,
  equipmentSlotOf,
  growthScalarOf,
  isEquipmentSlot,
  itemBaseOf,
  itemTypeOf,
  roleLevelCurveMaxLevel,
  roleLevelExpOf,
  sellPriceOf,
} from "../../common/runtime-config-cache";
import { AccountRepository } from "../../database/repositories/account.repository";
import { DrugRepository } from "../../database/repositories/drug.repository";
import { MoneyItemRepository } from "../../database/repositories/money-item.repository";
import { LevelScrollRepository } from "../../database/repositories/level-scroll.repository";
import { MallRepository } from "../../database/repositories/mall.repository";
import { FashionRepository } from "../../database/repositories/fashion.repository";
import { AcquireChannel } from "../../common/constants/game-config";
import { MONEY_KINDS, MoneyKind } from "../../common/constants/money-items";
import { GrowthRepository } from "../../database/repositories/growth.repository";
import { RankRepository } from "../../database/repositories/rank.repository";
import { RoleRepository } from "../../database/repositories/role.repository";
import { RoleStatusService } from "./role-status.service";
import { UseCooldown } from "./use-cooldown";
import { NO_STATUS_MODIFIERS, RoleStatusModifiers } from "../combat/status-combat";
import { SoulRepository } from "../../database/repositories/soul.repository";
import { TitleRepository } from "../../database/repositories/title.repository";
import { AccountRow, RankRow, RoleRow, SoulRow, TitleRow } from "../../database/rows";
import { CreateRoleDto, SaveRoleDto } from "./dto/create-role.dto";
import { BagOpDto, BagOpResultDto } from "./dto/bag-op.dto";
import { EventLogService } from "../event-log/event-log.service";
import { EVENT_TYPE } from "../../common/constants/event-type";
import { DrugUseDto, DrugUseResultDto } from "./dto/drug-use.dto";
import { MoneyUseDto, MoneyUseResultDto } from "./dto/money-use.dto";
import { LevelScrollUseDto, LevelScrollUseResultDto } from "./dto/level-scroll-use.dto";
import { GrowthUpgradeDto, GrowthKind } from "./dto/growth-upgrade.dto";
import { GrowthUpgradeResultDto, RoleDto, RoleSummaryDto } from "./dto/role.dto";
import { MallPurchaseDto, MallPurchaseResultDto } from "./dto/mall-purchase.dto";
import { MallLimitsDto } from "../game-config/dto/mall.dto";
import { FashionBuyDto, FashionBuyResultDto, FashionWearDto, FashionWearResultDto } from "./dto/fashion.dto";
import { ReviveResultDto } from "./dto/revive.dto";
import { SellGoodsDto, SellGoodsResultDto, SellLineDto } from "./dto/sell-goods.dto";
import { decodeStoredRoleData, decodeStoredRoleDataStrict, normalizeBagCells, normalizeEnum, normalizeLevel, normalizeName, parseRoleData, applyBagCells, ROLE_OCCUPATIONS, ROLE_SEXES } from "./role-data.util";
import { migrateRoleData } from "./role-migration";
import { clampVitals, enforceServerAuthority, settleVitalsAuthority } from "./role-authority";
import { buildInitialRoleData } from "./initial-role";
import { resolveLevelUp, type LevelUpOutcome } from "./level-up";
import {
  BagGrid,
  BagOrigin,
  cellAt,
  discardAt,
  equipAt,
  readBagGrid,
  readWornEquipments,
  reconcileBagCells,
  sameBagContent,
  sameGridShape,
  sanitizeEquipments,
  unequipSlot,
} from "./role-inventory";

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
  /** 实际写入的格子；`bound` / `from` 随格子一起回给客户端（详情弹窗要显示） */
  placed: Array<{ row: number; col: number; id: string; count: number; bound?: boolean; from?: BagOrigin }>;
}

/** 拾取时随物品写入格子的元数据（#789：绑定与溯源，由掉落结算判定，客户端说了不算） */
export interface PickDropMeta {
  /** 是否绑定角色（不可交易） */
  bound?: boolean;
  /** 掉落溯源（只有装备会带） */
  from?: BagOrigin;
}

/**
 * 货币道具的最小使用间隔（#847，毫秒）
 *
 * 写成常量而不是 `money_items` 的配置列：那张表进快照，加一列要动
 * DTO / `snapshot()` / 客户端 `game-config` / 管理端表单 / `configs-sandbox` 五处，
 * 只为「点一下别太快」不划算。C1 之后这些 legacy 币种本来就不再投放。
 */
const MONEY_ITEM_COOLDOWN_MS = 1000;

/**
 * 角色业务（玩家侧）
 *
 * 所有方法都带 accountId：**归属校验在这里**（越权访问别人的角色一律 403），
 * 控制器只从令牌取 accountId，绝不接受请求体里的账号 id。
 */
@Injectable()
export class RolesService {
  private readonly logger = new Logger(RolesService.name);

  /** 等级上限缺失的 error 是否已经打过（#832：每级查一次，不节流等于没有日志） */
  private maxLevelWarned = false;

  /**
   * 上次清理「更早天号」限购计数的天号（#846）
   *
   * 限购只对今天有意义，历史行没人读；但每买一件都跑一次全表 DELETE 就太浪费了 ——
   * 记住上次跑过的天号，一天只跑一次（进程重启会再跑一次，重复执行也无害）。
   */
  private lastSalesPurgeDay = 0;

  /**
   * 道具使用的服务端冷却（#847 / #848）
   *
   * 药品按各自的 `drugs.cooldown`（秒）算，货币道具用下面那个常量；
   * 键是「角色 + 道具 id」，所以红的喝完了不影响蓝的。**进程内一份**，
   * 重启即丢（代价只是重登后能立刻用一次，没有数据后果）。
   */
  private readonly useCooldowns = new UseCooldown();

  constructor(
    private readonly roles: RoleRepository,
    private readonly accounts: AccountRepository,
    private readonly titles: TitleRepository,
    private readonly souls: SoulRepository,
    private readonly ranks: RankRepository,
    private readonly mallPricing: MallPricingService,
    /**
     * 商城限购 / 库存计数（#846）：购买要在**同一个事务**里占库存 + 占今日名额 + 扣款入包。
     *
     * 事务透传放在仓储上（`MallRepository.transaction()`）—— 业务 service 不直接注入
     * `DatabaseService`，那是 `audit-server-boundaries` 的白名单规则。与时装同一取向：
     * 「拥有才给穿」与「买得着才卖」都必须在服务端判。
     */
    private readonly malls: MallRepository,
    private readonly drugs: DrugRepository,
    private readonly fashions: FashionRepository,
    private readonly growth: GrowthRepository,
    /** 货币道具（#785）：使用结算读库里的面值与币种 —— 运营改完立刻生效 */
    private readonly moneyItems: MoneyItemRepository,
    /** 升级卷轴（#787）：使用结算读库里的等级区间 —— 运营改完立刻生效 */
    private readonly levelScrolls: LevelScrollRepository,
    /** 角色状态（#822）：结算读数值，死亡 / 下线清空 —— 都在这个域里，不跨域 */
    private readonly statuses: RoleStatusService,
    /** 配置（#878 起用它读 `ROLE_MAX_PER_ACCOUNT`：上限进配置，e2e 才压得小） */
    private readonly config: ConfigService,
    /** 玩家行为流水（#886）：拾取 / 获得 / 消耗在各自的写入口记一条 */
    private readonly eventLogs: EventLogService,
  ) {}

  /**
   * 一个账号最多几个角色（#878 / I3）
   *
   * 脏值回落出厂默认：上限读错不该让「建号」变成「一个也建不了」。
   */
  private roleLimitPerAccount(): number {
    const raw = Number(this.config.get<number>("roleMaxPerAccount") ?? ROLE_MAX_PER_ACCOUNT_DEFAULT);
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : ROLE_MAX_PER_ACCOUNT_DEFAULT;
  }

  /**
   * 存档里服务端自己记下的位置（`data.mapAt`）
   *
   * 行为流水用它标「在哪」—— 位置只认服务端记的那一份（#606 定的口径：客户端报 OnMap 是
   * 客户端的事），读不到就是 null，不拿别的字段猜。
   */
  private mapAtOf(data: Record<string, unknown>): string | null {
    const value = data.mapAt;
    return typeof value === "string" && value ? value : null;
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
   * #597 起建号职责整体在服务端：客户端只传**名称 / 职业 / 性别**三样（它自己才知道的：
   * 输入框与选中态），初始数据（背包 / 装备 / 货币 / 技能 / 引导…）由 `buildInitialRoleData()`
   * 构造 —— 背包、装备、货币全空不赠物品，技能全解锁 1 级，等级钉 1。
   *
   * 校验顺序：同账号是否重名 → 该账号角色数是否已达上限（#878：默认 6，`ROLE_MAX_PER_ACCOUNT`）。
   * 第一个角色自动设为在线（与客户端「建完就能进游戏」的体验一致）。
   */
  create(accountId: string, dto: CreateRoleDto): RoleDto {
    const account = this.mustAccount(accountId);
    const name = normalizeName(dto.name);
    const occupation = normalizeEnum(dto.occupation, ROLE_OCCUPATIONS, "职业");
    const sex = normalizeEnum(dto.sex, ROLE_SEXES, "性别");

    if (this.roles.findByAccountAndName(accountId, name)) throw BizException.conflict(BizCode.ROLE_NAME_EXISTS, "该账号下已存在同名角色");

    // 角色数上限（#878 / I3）：先数再插。并发下两道请求可能同时通过这一关 ——
    // 兜底是表上的 `UNIQUE(account_id, name)`（重名）与「先到先得」的语义：
    // 真撞上也只是多一个角色，不会变成无限建号（这一道闸挡的是脚本刷行）
    const limit = this.roleLimitPerAccount();
    if (this.roles.findByAccount(accountId).length >= limit) {
      throw new BizException(BizCode.ROLE_LIMIT_EXCEEDED, `每个账号最多 ${limit} 个角色，请先删除一个再建`, HttpStatus.BAD_REQUEST);
    }

    const id = this.generateRoleId();
    const now = Date.now();
    // 初始文档由服务端构造（#597）：客户端入参里没有 data，自然也没有「改包开号满级 /
    // 建号塞金币」这条路 —— 此前的 clampInitialCurrency / pinInitialLevel 随之整体退场
    const data = buildInitialRoleData(id, name, occupation, sex);
    // 战斗属性与战斗力在落库前由服务端重算（权威值），血蓝按满值起
    this.applyAuthoritativeAttributes(1, data);
    data.hp = data.maxHp;
    data.mp = data.maxMp;
    data.hpRecoverAccumulator = 0;
    data.mpRecoverAccumulator = 0;
    // 回复结算游标（#596）：从建号这一刻起算，之后每次服务端写档按经过时间补回复
    data.vitalsSettledAt = now;
    const row: RoleRow = {
      id,
      account_id: accountId,
      name,
      occupation,
      sex,
      level: 1,
      // 新角色的击杀数从 0 起（#400）：这一列只由结算路径 +1
      kills: 0,
      data: JSON.stringify(data),
      revision: 1,
      // 新号不可能是坏档（data 是本进程刚构造的 JSON）
      corrupted: 0,
      created_at: now,
      updated_at: now,
    };
    this.roles.insert(row);
    // 在线标记一律走 `setOnlineRole`（#547）：它顺带写心跳，否则这一行会被在线清算判成「没人」。
    if (!account.online_role_id) this.accounts.setOnlineRole(accountId, row.id);
    return RoleDto.from(row, account.online_role_id ?? row.id);
  }

  /**
   * 生成一个不冲突的角色 id
   *
   * 沿用客户端时代的「时间戳字符串」形态（对玩家与运营都是不透明的 id，形态无需兼容什么，
   * 但保持同类外观）；同毫秒撞车（同一账号狂点建号）时补随机后缀重试。
   */
  private generateRoleId(): string {
    let id = Date.now().toString();
    while (this.roles.findById(id)) id = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    return id;
  }

  /**
   * 保存角色进度（全量覆盖；id 以路径参数为准，避免换 id 写别人角色）
   *
   * **乐观锁（B62 / #820 起 revision 必填且原子）**：与服务端当前值不一致即拒收（20006）。
   * 典型场景是玩家在游戏里、管理员在后台改了这个角色 —— 若放行，
   * 客户端那份「改之前」的存档会把后台的改动整体覆盖掉（谁最后写谁赢，后台改动静默丢失）。
   *
   * 比对分两道：本函数先比一次（省掉后面的结算），落库时 SQL 里还有 `WHERE revision = ?`
   * 再比一次（见 `role.repository.replace`）—— 第一道给正常路径一个清楚的错误，
   * 第二道保证「读 → 算 → 写」整段之间没有人插进来。
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
    if (dto.revision !== existing.revision) {
      throw BizException.conflict(BizCode.ROLE_REVISION_CONFLICT, "该角色已在别处被修改，请先同步最新数据");
    }
    // 存档结构版本（#818）：客户端手上那份可能还是老版本（它本地缓存的形状），
    // 先按链迁到当前再规整 —— 否则老形状会被当成「当前版本」写回去，版本号就永远不前进。
    // **客户端报的版本只决定「跑不跑链」，不构成信任**：迁移链只做形状变换，
    // 哪个字段该由客户端写由 role-authority 判（收权不在这一层）。
    // 版本比代码新（回滚发布）直接拒 20028，不能把新字段当未知键静默丢掉
    //
    // 身份三字段（#879 / I4）：`name` / `occupation` / `sex` 归服务端独占 —— 存档里报什么都不看，
    // 一律按库里的值写回文档。所以这里把库里那份**作为解析入参**传进去（而不是解析完再覆盖）：
    // 否则改包塞一个非法职业（`occupation: "9"`）会先被 `normalizeEnum` 拒成 20003，
    // 整份存档保存不了 —— 那就不是「忽略」而是「拿一个我们本来不认的字段把玩家卡死」。
    // 改名暂时放置（重开条件：改名卡道具 / 改名接口落地后，那才是唯一的改名入口）；
    // 转职同理（重开条件：做转职系统时另设接口，而不是让存档顺手改）。
    const { data } = parseRoleData(
      migrateRoleData({ ...dto.data, id: roleId }, { wornBoundOf: bindOnDropOf }).data,
      { name: existing.name, occupation: existing.occupation, sex: existing.sex },
    );

    // 权威边界（见 role-authority.ts）：账本 / 成长线阶位 / 进度以库为准，客户端报上来的一律丢弃；
    // 老存档里没有这些键时按空值回填（#819 起不再「缺字段就采纳客户端那份」）。
    // `level` 另有索引列（`roles.level`）压过文档里的那份 —— 列表排序与筛选读的是列，列才是真相
    //
    // 解析**必须用严格版**：坏档折成 `{}` 的话，收权会认为「库里什么都没有」，于是客户端
    // 上报的 gold / bag / equipments 全部放行 —— 那正是 B61 的提权通道（#819 堵的就是它）
    const storedParsed = decodeStoredRoleDataStrict(existing.data);
    if (!storedParsed.ok) {
      this.roles.markCorrupted(roleId, true);
      this.logger.error(`角色 ${roleId} 的存档无法解析（${storedParsed.reason}），已标记 corrupted 并拒绝这次存档`);
      throw BizException.conflict(BizCode.ROLE_DATA_CORRUPTED, "存档已损坏，暂时无法保存，请联系客服");
    }
    if (existing.corrupted) this.roles.markCorrupted(roleId, false);
    const stored = storedParsed.data;
    this.enforceAuthority({ ...stored, level: existing.level }, data);
    // 等级可能被上面回填改掉，索引列必须从**回填后**的文档重取：
    // 否则 `row.level`（客户端报的）与 `data.level`（库里的）各说一套，列表与详情对不上
    const level = normalizeLevel(data.level);
    // 装备槽位的脏数据（部位不符 / 同一件穿在多个槽位）必须在重算**之前**清掉：
    // 属性重算是遍历 `equipments` 的所有值累加的，不看键 —— 同一件算三遍就是三倍战力
    // （收权之前的老存档没经过这层校验，清理只打日志，不打扰玩家）
    const cleanedWorn = sanitizeEquipments(readWornEquipments(data.equipments), (id) => equipmentSlotOf(id));
    if (cleanedWorn.dropped.length) {
      this.logger.warn(
        `角色 ${roleId} 的装备槽位有脏数据，已清理：` +
          cleanedWorn.dropped.map((item) => `${item.slot}=${item.id}（${item.reason}）`).join("；"),
      );
    }
    data.equipments = cleanedWorn.equipments;
    // 比对在前（记录客户端这次上报了什么，观察用），重算在后（落库的一定是服务端算的）：
    // 客户端那份自 #541 起只是演，谁强由这里的公式说了算
    this.warnIfAttributesMismatch(roleId, level, data);
    this.applyAuthoritativeAttributes(level, data);
    // 血蓝收权（#596）：以库里上次落账值为基线，按经过时间结算自然回复后**覆盖**客户端上报值
    // （客户端那份只是血条平滑用的演出预测）。死亡不回复 —— 满血复活必须走 revive 接口。
    // 必须在重算之后：回复上限要用刚算出的 maxHp / maxMp
    settleVitalsAuthority(stored, data, Date.now(), this.mpRecoverPerSecond());
    // 上限是上面那步算出来的，夹在它之后；血蓝已由 settleVitalsAuthority 结算（这里纯防御）
    clampVitals(data);
    const row: RoleRow = {
      ...existing,
      // 身份三字段取库里的（#879）：`fields` 里那份已经把客户端上报值换成了库值，两者同源 ——
      // 这里显式写 `existing.*` 是为了让「这一列只认库」在行构造处一眼可见
      name: existing.name,
      occupation: existing.occupation,
      sex: existing.sex,
      level,
      data: JSON.stringify(data),
      // 与 replace() 里的 `revision = revision + 1` 对齐：SQL 只是落库，这里要给出**落库后**的值，
      // 否则响应里的 revision 比库里小 1，客户端拿它做基线会立刻撞乐观锁（自锁死循环）
      revision: existing.revision + 1,
      updated_at: Date.now(),
    };
    this.persistOrConflict(row, existing.revision, "保存存档");
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
    if (dto.revision !== existing.revision) {
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
    this.persistOrConflict(row, existing.revision, "成长线升级");
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
    if (dto.revision !== existing.revision) {
      throw BizException.conflict(BizCode.ROLE_REVISION_CONFLICT, "该角色已在别处被修改，请先同步最新数据");
    }

    // 商品不存在（不在上架清单）→ 404，消息经请求层弹给玩家
    const price = this.mallPricing.priceOf(dto.goodId);
    // 定价不变式（#814 / C3）：上架与改价时已经拦过，这里兜的是**导入 / 历史脏行** ——
    // `config-import` 与直接改库都能造出「售价 ≤ 回收价」的行，而那一行就是印钞机。
    // 拒绝购买而不是夹取价格：夹取会让客户端看到的价与实扣不一致（#545 的老问题）。
    this.mallPricing.ensurePriceSane(dto.goodId, price);
    // 购买等级服务端权威校验（#758）：客户端按钮置灰只是提前提示，不是防线
    const requiredLevel = this.mallPricing.requiredLevelOf(dto.goodId);
    if (requiredLevel > existing.level) {
      throw BizException.conflict(
        BizCode.MALL_LEVEL_NOT_ENOUGH,
        `购买等级不足：该商品需要 Lv.${requiredLevel}，当前 Lv.${existing.level}`,
      );
    }

    // 限购与库存（#846）：配置读库（改完立刻生效），计数在运行时表
    const { dailyLimit, stock } = this.mallPricing.limitsOfGood(dto.goodId);
    const day = todayResetDay();
    this.purgeStaleSales(day);

    // 占位与扣款**同一个事务**：库存占上了但扣款失败（背包满 / 乐观锁冲突），
    // 必须把名额退回去 —— 否则一次失败购买就白吃一个名额，限量商品会被空转吃光。
    return this.malls.transaction(() => {
      const data = decodeStoredRoleData(existing.data);
      const bindGold = Math.max(0, Math.floor(Number(data.bindGold) || 0));
      if (bindGold < price) {
        throw BizException.conflict(BizCode.MALL_GOLD_NOT_ENOUGH, `绑定元宝不足：还需 ${price - bindGold}`);
      }

      // 库存：条件自增（`sold < stock` 才 +1），卖完就 false
      if (!this.malls.reserveStock(dto.goodId, stock)) {
        throw new BizException(
          BizCode.MALL_OUT_OF_STOCK,
          `该商品已售罄（全服 ${stock} 件已卖完）`,
          HttpStatus.BAD_REQUEST,
          { sold: this.malls.soldOf(dto.goodId), stock },
        );
      }
      // 今日限购：条件自增，买满就 false。`dailyLimit <= 0` = 不限购（不占位也不计数）
      if (!this.malls.reserveDaily(roleId, dto.goodId, day, dailyLimit)) {
        throw new BizException(
          BizCode.MALL_DAILY_LIMIT,
          `这件商品每天限购 ${dailyLimit} 件，明天 05:00 之后再来`,
          HttpStatus.BAD_REQUEST,
          { bought: this.malls.dailyCountOf(roleId, dto.goodId, day), dailyLimit },
        );
      }

      data.bindGold = bindGold - price;
      this.putGoodIntoBag(data, dto.goodId);

      const row: RoleRow = {
        ...existing,
        data: JSON.stringify(data),
        revision: existing.revision + 1,
        updated_at: Date.now(),
      };
      this.persistOrConflict(row, existing.revision, "购买商品");
      // 行为流水（#886）：购买是「非拾取途径的物品入账」—— 地上捡的走 pick，这里走 gain
      this.eventLogs.record({
        type: EVENT_TYPE.GAIN,
        accountId,
        roleId,
        roleName: existing.name,
        mapId: this.mapAtOf(data),
        target: dto.goodId,
        amount: 1,
        detail: { source: "mall", price },
      });
      // 回执带上买完之后的三个运行数：客户端据此就地更新「今日 2/3」「仅剩 5 件」，
      // 不用为了刷新再拉一次 mall-limits
      return MallPurchaseResultDto.fromRow(row, account.online_role_id, price, dto.goodId, {
        dailyBought: this.malls.dailyCountOf(roleId, dto.goodId, day),
        dailyLimit,
        sold: this.malls.soldOf(dto.goodId),
        stock,
      });
    });
  }

  /**
   * 清掉更早天号的限购计数（#846）：一天一次，失败只 warn
   *
   * 不清的后果是每个角色每天每件商品留一行，玩家越多长得越快；但这属于「卫生」而非
   * 「正确性」—— 表长大了也不能让购买失败，所以吞掉异常继续卖。
   */
  private purgeStaleSales(day: number): void {
    if (this.lastSalesPurgeDay === day) return;
    this.lastSalesPurgeDay = day;
    try {
      this.malls.purgeSalesBefore(day);
    } catch (error) {
      this.logger.warn(`清理过期限购计数失败（不影响购买）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 商城的限购 / 库存视图（#846）：客户端打开商城弹窗时拉一遍
   *
   * 只读、不动存档，所以不校验在线标记也不校验 revision —— 「能不能买」由购买链路自己判。
   * 返回**全部上架商品**（运营手挑的几十行），不按商品逐个查：一屏陈列十几件，
   * 逐件请求会出现「一半旧数一半新数」的中途态。
   */
  mallLimits(accountId: string, roleId: string): MallLimitsDto {
    this.mustOwnRole(accountId, roleId);
    return this.mallPricing.limitsOf(roleId);
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
    if (dto.revision !== existing.revision) {
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
    // **绑定件与未绑定件都进 `bindGold`**（#845 / B2）：绑定物品可以卖店，给的是绑定金；
    // 所以这里不需要看格子的 `bound` —— 写进 `gold`（流通）才是「洗白出口」，而这条路
    // 从 #845 收窄后一直不存在（C2：金币不可流通，玩家之间只能以物易物）。
    // e2e-sell 里有一条断言盯着「卖绑定件后 gold / silver 一分不动」。
    data.bindGold = Math.max(0, Math.floor(Number(data.bindGold) || 0)) + total;

    const row: RoleRow = {
      ...existing,
      data: JSON.stringify(data),
      revision: existing.revision + 1,
      updated_at: Date.now(),
    };
    this.persistOrConflict(row, existing.revision, "出售物品");
    // 行为流水（#886）：一件一行（「卖了哪几件、各多少、什么价」事后要能逐条对账）。
    // 整单一次 recordMany —— 一键回收会报上几十条，逐条提交等于几十次 WAL 提交
    const mapId = this.mapAtOf(data);
    this.eventLogs.recordMany(
      sold.map((line) => ({
        type: EVENT_TYPE.CONSUME,
        accountId,
        roleId,
        roleName: existing.name,
        mapId,
        target: line.goodId,
        amount: line.count,
        detail: { reason: "sell", unitPrice: line.unitPrice, total: line.total },
      })),
    );
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
  pickDrop(accountId: string, goodId: string, count: number, meta: PickDropMeta = {}): PickDropResult {
    const account = this.mustAccount(accountId);
    const roleId = account.online_role_id;
    if (!roleId) throw BizException.conflict(BizCode.ROLE_NOT_FOUND, "当前没有在线角色，无法拾取");
    const existing = this.roles.findById(roleId);
    if (!existing || existing.account_id !== accountId) {
      throw BizException.conflict(BizCode.ROLE_NOT_FOUND, "当前没有在线角色，无法拾取");
    }

    // 物品类型来自三张配置表（装备变体 / 药品 / 材料）：掉落表是管理端可改的数据，
    // 里面配上不存在的 id 要在这里拦下
    const itemType = itemTypeOf(goodId);
    if (!itemType) throw BizException.conflict(BizCode.ROLE_DATA_INVALID, `掉落物品不存在：${goodId}`);

    const data = decodeStoredRoleData(existing.data);
    const placed = this.placeGoodsIntoBag(data, goodId, itemType, Math.max(1, Math.floor(count)), meta);

    const row: RoleRow = {
      ...existing,
      data: JSON.stringify(data),
      revision: existing.revision + 1,
      updated_at: Date.now(),
    };
    this.persistOrConflict(row, existing.revision, "拾取物品");
    // 行为流水（#886）：记「捡到了什么」。地图取存档里服务端自己记下的位置 ——
    // pick 的入参里没有坐标（客户端只报 goodId 与数量），位置从 mapAt 读
    this.eventLogs.record({
      type: EVENT_TYPE.PICK,
      accountId,
      roleId,
      roleName: existing.name,
      mapId: this.mapAtOf(data),
      target: goodId,
      amount: Math.max(1, Math.floor(count)),
      detail: meta.bound ? { bound: true } : null,
    });
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
   * **#789 起多一条合并条件**：绑定状态不同的两份**不合并**（`bound` 参与判定）。
   * 否则「捡到一堆绑定的药」会并进未绑定的那堆，绑定就从有变成没有（或反过来 —— 那更糟，
   * 等于白送一堆可交易品）。同状态的才并堆，于是同一种物品在背包里最多分成两堆。
   *
   * @param meta 掉落结算判定的绑定与溯源，原样写进新格子上（`from` 只对装备有意义）
   * @throws MALL_BAG_FULL 背包剩余空间放不下整份（或网格结构不合法）
   */
  private placeGoodsIntoBag(
    data: Record<string, unknown>,
    goodId: string,
    itemType: string,
    count: number,
    meta: PickDropMeta = {},
  ): Array<{ row: number; col: number; id: string; count: number; bound?: boolean; from?: BagOrigin }> {
    const bag = data.bag;
    if (!Array.isArray(bag)) throw BizException.conflict(BizCode.MALL_BAG_FULL, "背包数据不完整，无法放入物品");
    // 单格上限：装备没有叠加概念（1）；药品/材料从各自的表读 maxStack（#252/#255 起入库），读不到按 99
    // #544 起先查运营库覆盖层：管理端改药品叠加上限对服务端入包即时生效
    const stackable = itemType !== "equipment";
    const stackRow = stackable ? (drugOf(goodId) ?? itemBaseOf(goodId)) : undefined;
    const maxStack = stackable ? Math.max(1, Math.floor(Number(stackRow && (stackRow as Record<string, unknown>).maxStack) || 99)) : 1;

    const placed: Array<{ row: number; col: number; id: string; count: number; bound?: boolean; from?: BagOrigin }> = [];
    let remaining = count;
    const grid = bag as unknown[][];
    /** 这一份物品自身的元数据（同一份物品写进每一格都一样，除了 count） */
    const bound = meta.bound === true;
    const from = itemType === "equipment" && meta.from ? meta.from : undefined;
    const metaColumns = (): { bound?: boolean; from?: BagOrigin } => ({
      ...(bound ? { bound: true } : {}),
      ...(from ? { from } : {}),
    });

    // 第一轮：吃已有堆（只有可叠加物品走得到；**绑定状态不同不并**）
    if (stackable) {
      for (let row = 0; row < grid.length && remaining > 0; row++) {
        const line = grid[row];
        if (!Array.isArray(line)) continue;
        for (let col = 0; col < line.length && remaining > 0; col++) {
          const cell = line[col];
          if (!cell || typeof cell !== "object" || (cell as Record<string, unknown>).id !== goodId) continue;
          const record = cell as Record<string, unknown>;
          // 绑定状态必须是同一桶才允许并堆（见方法注释）
          if ((record.bound === true) !== bound) continue;
          const current = Math.max(1, Math.floor(Number(record.count) || 1));
          const room = maxStack - current;
          if (room <= 0) continue;
          const take = Math.min(room, remaining);
          line[col] = { ...record, id: goodId, count: current + take } as Record<string, unknown>;
          placed.push({ row, col, id: goodId, count: current + take, ...metaColumns() });
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
        line[col] = { id: goodId, count: take, ...metaColumns() } as Record<string, unknown>;
        placed.push({ row, col, id: goodId, count: take, ...metaColumns() });
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
   * 往存档的背包网格里放一件商品（#763 起支持药品堆叠）
   *
   * 顺序：**先找同类未满的格子堆上去**（药品可叠，`drugs.max_stack` 决定上限），
   * 再行优先找第一个空格。装备不可叠，每件占一格 —— 查不到 maxStack 的物品（装备 / 材料）
   * 一律按不可叠处理，不会把两件装备塞进同一格。
   *
   * @throws MALL_BAG_FULL 网格里没有空格（或网格结构不合法 —— 结构坏了放东西只会越放越乱，同样拒绝）
   */
  private putGoodIntoBag(data: Record<string, unknown>, goodId: string): void {
    const bag = data.bag;
    if (!Array.isArray(bag)) throw BizException.conflict(BizCode.MALL_BAG_FULL, "背包数据不完整，无法放入商品");
    const maxStack = Math.max(1, Math.floor(Number(this.drugs.findByKey(goodId)?.max_stack) || 1));
    if (maxStack > 1) {
      for (const line of bag) {
        if (!Array.isArray(line)) continue;
        for (const cell of line) {
          if (!cell || typeof cell !== "object") continue;
          const entry = cell as Record<string, unknown>;
          if (entry.id !== goodId) continue;
          const count = Math.max(1, Math.floor(Number(entry.count) || 1));
          if (count >= maxStack) continue;
          entry.count = count + 1;
          return;
        }
      }
    }
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
   * 失败路径：20013 格子为空 / 非药品 / 无生效回复量；20014 血蓝均已满（回复不动任何一项）；
   * 20030 冷却中（读 `drugs.cooldown`，单位秒，键是「角色 + 药品」）。冷却由**服务端**计时，
   * 客户端那份节流只是省往返 —— 改包绕不过服务端（#848）。
   */
  useDrug(accountId: string, roleId: string, dto: DrugUseDto): DrugUseResultDto {
    const account = this.mustAccount(accountId);
    const existing = this.mustOwnRole(accountId, roleId);
    // 与升级 / 购买同一纪律：被踢下线的角色不能继续用药（用药也是写）
    if (account.online_role_id !== roleId) {
      throw BizException.conflict(BizCode.ROLE_KICKED, "该角色已被管理员下线，请重新选择角色进入游戏");
    }
    if (dto.revision !== existing.revision) {
      throw BizException.conflict(BizCode.ROLE_REVISION_CONFLICT, "该角色已在别处被修改，请先同步最新数据");
    }

    const data = decodeStoredRoleData(existing.data);
    // 先结算自然回复再判「已满」（#596）：两次用药之间攒的回复要先入账，
    // 否则攒一会儿就够满的药会被误判成「无需使用」拒掉
    settleVitalsAuthority(data, data, Date.now(), this.mpRecoverPerSecond());
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

    // 服务端冷却（#848）：`drugs.cooldown` 单位是**秒**，0 = 无冷却；键是「角色 + 药品」。
    // 放在「已满」判定之后 —— 满血点药本来就该被 20014 拒，不该顺带吃掉一个冷却。
    const cooldownMs = Math.max(0, Math.floor(Number(drug.cooldown) || 0)) * 1000;
    const cooldownKey = `drug:${roleId}:${drug.id}`;
    const cooling = this.useCooldowns.take(cooldownKey, cooldownMs);
    if (cooling > 0) {
      throw new BizException(
        BizCode.DRUG_COOLING,
        `药品冷却中：还需 ${(cooling / 1000).toFixed(1)} 秒`,
        HttpStatus.BAD_REQUEST,
        { remainingMs: cooling, cooldownMs },
      );
    }

    // 未封顶期望回复量（负值按 0 —— 配置写错不会倒扣血蓝）
    const expectHp = healsHp ? Math.max(0, Math.round(drug.effect_hp + (drug.effect_hp_percent / 100) * maxHp)) : 0;
    const expectMp = healsMp ? Math.max(0, Math.round(drug.effect_mp + (drug.effect_mp_percent / 100) * maxMp)) : 0;
    // 各自封顶后生效（血满蓝不满也照用，只回蓝的部分）
    const recoveredHp = healsHp && !hpFull ? Math.min(maxHp, hp + expectHp) - hp : 0;
    const recoveredMp = healsMp && !mpFull ? Math.min(maxMp, mp + expectMp) - mp : 0;
    if (healsHp && !hpFull) data.hp = hp + recoveredHp;
    if (healsMp && !mpFull) data.mp = mp + recoveredMp;

    // 扣减数量（药品可叠加，减到 0 清格；**只改 count，bound / from 原样保留** —— #816）
    const remaining = Math.max(1, cell.count) - 1;
    this.writeBagCount(data, dto.row, dto.col, remaining);

    const row: RoleRow = {
      ...existing,
      data: JSON.stringify(data),
      revision: existing.revision + 1,
      updated_at: Date.now(),
    };
    this.persistOrConflictGuarded(row, existing.revision, "使用药品", cooldownKey);
    // 行为流水（#886）：药是消耗品，「用了什么、回了多少」记一条
    this.eventLogs.record({
      type: EVENT_TYPE.CONSUME,
      accountId,
      roleId,
      roleName: existing.name,
      mapId: this.mapAtOf(data),
      target: drug.id,
      amount: 1,
      detail: { reason: "drug", hp: recoveredHp, mp: recoveredMp },
    });
    return DrugUseResultDto.fromRow(row, account.online_role_id, drug.id, recoveredHp, recoveredMp);
  }

  /**
   * 货币道具使用（玩家侧 #785）：入账与扣减都在服务端
   *
   * 三种货币直接对应角色存档的三个账本字段（`role-authority.ts` 的 `SERVER_LEDGER_FIELDS`）：
   * `gold` / `bindGold` / `silver`。客户端只报「用背包哪一格」，**金额与币种一律读
   * `money_items` 表** —— 运营把 100000 改成 1，玩家下次使用就只加 1，改包也改不出钱。
   *
   * 与用药的区别：不结算血蓝、不判「已满」；冷却固定 1 秒（`MONEY_ITEM_COOLDOWN_MS`，
   * 键是「角色 + 道具」），以前这里完全没有间隔 —— 改包能把 999 个道具在一秒内变现（#847）。
   *
   * 失败路径：20023 格子为空 / 格子里不是货币道具 / 该行没有配置入账金额；
   * 20031 冷却中；
   * 带上 revision 时乐观锁语义与 role.save 相同（20006）；被踢下线 20007。
   */
  useMoneyItem(accountId: string, roleId: string, dto: MoneyUseDto): MoneyUseResultDto {
    const account = this.mustAccount(accountId);
    const existing = this.mustOwnRole(accountId, roleId);
    // 与用药 / 购买同一纪律：被踢下线的角色不能继续写
    if (account.online_role_id !== roleId) {
      throw BizException.conflict(BizCode.ROLE_KICKED, "该角色已被管理员下线，请重新选择角色进入游戏");
    }
    if (dto.revision !== existing.revision) {
      throw BizException.conflict(BizCode.ROLE_REVISION_CONFLICT, "该角色已在别处被修改，请先同步最新数据");
    }

    const data = decodeStoredRoleData(existing.data);
    const cell = this.readBagCell(
      data,
      dto.row,
      dto.col,
      BizCode.MONEY_ITEM_USE_TARGET_INVALID,
      "该格子为空，没有可使用的货币道具",
    );
    const item = this.moneyItems.findByKey(cell.id);
    if (!item) {
      throw BizException.conflict(BizCode.MONEY_ITEM_USE_TARGET_INVALID, "该格子不是可使用的货币道具");
    }
    if (!(MONEY_KINDS as readonly string[]).includes(item.currency)) {
      // 库里存了三种之外的币种（手改库 / 老数据）→ 拒用而不是往一个不存在的字段上写钱
      throw BizException.conflict(BizCode.MONEY_ITEM_USE_TARGET_INVALID, "该货币道具的币种不合法");
    }
    const currency = item.currency as MoneyKind;
    const amount = Math.max(0, Math.floor(Number(item.amount) || 0));
    if (amount <= 0) {
      throw BizException.conflict(BizCode.MONEY_ITEM_USE_TARGET_INVALID, "该货币道具没有配置入账金额");
    }

    // 服务端冷却（#847）：以前这里完全没有间隔，改包就能把 999 个道具在一秒内变现。
    // 校验全部通过之后才占位，失败（乐观锁 / 写入异常）由 persistOrConflictGuarded 退掉。
    const cooldownKey = `money:${roleId}:${item.id}`;
    const cooling = this.useCooldowns.take(cooldownKey, MONEY_ITEM_COOLDOWN_MS);
    if (cooling > 0) {
      throw new BizException(
        BizCode.MONEY_ITEM_COOLING,
        `这个道具用得有点快：还需 ${(cooling / 1000).toFixed(1)} 秒`,
        HttpStatus.BAD_REQUEST,
        { remainingMs: cooling, cooldownMs: MONEY_ITEM_COOLDOWN_MS },
      );
    }

    // 入账（负数存量按 0 起算 —— 与升级 / 购买处的账本读法同一式）
    const balance = Math.max(0, Math.floor(Number(data[currency]) || 0)) + amount;
    data[currency] = balance;

    // 扣减数量（可叠加，减到 0 清格；**只改 count，bound / from 原样保留** —— #816）
    const remaining = Math.max(1, cell.count) - 1;
    this.writeBagCount(data, dto.row, dto.col, remaining);

    const row: RoleRow = {
      ...existing,
      data: JSON.stringify(data),
      revision: existing.revision + 1,
      updated_at: Date.now(),
    };
    this.persistOrConflictGuarded(row, existing.revision, "使用货币道具", cooldownKey);
    return MoneyUseResultDto.fromRow(row, account.online_role_id, item.id, currency, amount, balance);
  }

  /**
   * 升级卷轴使用（玩家侧 #787）：**硬性 +1 级**，不扣经验
   *
   * 与经验升级的区别就在「不看 `exp` 够不够」：攒够不够是运营的另一条线（打怪 / 泡点），
   * 卷轴是花钱买的一级 —— 所以经验原样保留（下次打怪入账时继续按曲线判定），也不清零。
   *
   * 三条判定，顺序有意义：
   * 1. **区间**（`min_level ~ max_level`，读库，改完立刻生效）：Lv1 用完正好到 1000 级，
   *    再点就是 20025「该换卷了」—— 这是卷轴的核心规则，不是配错；
   * 2. **等级上限**（`roleMaxLevel`）：到顶了给 20026（「抬上限」与「加卷轴」是两件事，
   *    运维看到码要知道去改哪个）；
   * 3. 属性重算 + 补满血蓝：与经验升级同一个惯例（A7「升级统一回满」，四条路径一致），
   *    血蓝上限也跟着新等级走；同时把 `data.level` 与列一起写（B11）。
   *
   * 失败路径：20024 格子为空 / 不是升级卷轴 / 区间配置不合法；20025 等级不在区间内；
   * 20026 已到等级上限；带 revision 时乐观锁与 role.save 同义（20006）；被踢下线 20007。
   */
  useLevelScroll(accountId: string, roleId: string, dto: LevelScrollUseDto): LevelScrollUseResultDto {
    const account = this.mustAccount(accountId);
    const existing = this.mustOwnRole(accountId, roleId);
    // 与用药 / 用货币道具 / 购买同一纪律：被踢下线的角色不能继续写
    if (account.online_role_id !== roleId) {
      throw BizException.conflict(BizCode.ROLE_KICKED, "该角色已被管理员下线，请重新选择角色进入游戏");
    }
    if (dto.revision !== existing.revision) {
      throw BizException.conflict(BizCode.ROLE_REVISION_CONFLICT, "该角色已在别处被修改，请先同步最新数据");
    }

    const data = decodeStoredRoleData(existing.data);
    const cell = this.readBagCell(
      data,
      dto.row,
      dto.col,
      BizCode.LEVEL_SCROLL_USE_TARGET_INVALID,
      "该格子为空，没有可使用的升级卷轴",
    );
    const scroll = this.levelScrolls.findByKey(cell.id);
    if (!scroll) {
      throw BizException.conflict(BizCode.LEVEL_SCROLL_USE_TARGET_INVALID, "该格子不是可使用的升级卷轴");
    }

    const fromLevel = Math.max(1, Math.floor(existing.level));
    const minLevel = Math.floor(Number(scroll.min_level) || 0);
    const maxLevel = Math.floor(Number(scroll.max_level) || 0);
    // 区间本身坏掉（手改库 / 老数据 0 值）→ 拒用而不是「任何等级都能用」
    if (minLevel < 1 || maxLevel < minLevel) {
      throw BizException.conflict(BizCode.LEVEL_SCROLL_USE_TARGET_INVALID, "该升级卷轴的等级区间配置不合法");
    }
    if (fromLevel < minLevel || fromLevel > maxLevel) {
      throw BizException.conflict(
        BizCode.LEVEL_SCROLL_LEVEL_OUT_OF_RANGE,
        `「${scroll.label}」只能在 ${minLevel} ~ ${maxLevel} 级使用（当前 ${fromLevel} 级）`,
      );
    }

    const cap = this.roleMaxLevel();
    if (fromLevel >= cap) {
      throw BizException.conflict(BizCode.LEVEL_SCROLL_MAX_LEVEL_REACHED, `已达到等级上限（${cap} 级），升级卷轴用不了`);
    }

    const toLevel = fromLevel + 1;
    const exp = Math.max(0, Math.floor(Number(data.exp) || 0));
    // 等级变了属性就变：服务端重算写回存档（权威值），血蓝按升级惯例补满。
    // `data.level` 也要一起写（B11）—— 卷轴以前只改列，文档里那份停在旧等级，
    // 管理端详情与客户端本地看到的就是两个数字
    data.level = toLevel;
    this.applyAuthoritativeAttributes(toLevel, data);
    data.hp = typeof data.maxHp === "number" ? data.maxHp : data.hp;
    data.mp = typeof data.maxMp === "number" ? data.maxMp : data.mp;

    // 扣减数量（可叠加，减到 0 清格；**只改 count，bound / from 原样保留** —— #816）
    const remaining = Math.max(1, cell.count) - 1;
    this.writeBagCount(data, dto.row, dto.col, remaining);

    const row: RoleRow = {
      ...existing,
      level: toLevel,
      data: JSON.stringify(data),
      revision: existing.revision + 1,
      updated_at: Date.now(),
    };
    this.persistOrConflict(row, existing.revision, "使用升级卷轴");
    return LevelScrollUseResultDto.fromRow(row, account.online_role_id, scroll.id, fromLevel, exp, this.expNeedOf(toLevel));
  }

  /**
   * 背包与穿戴（#556）：穿戴 / 卸下 / 丢弃 / 整理 / 搬运五个动作共用一条写路径
   *
   * **为什么这五个动作要收到服务端**：`bag` / `equipments` 从这一版起进权威清单
   * （见 `role-authority.ts`）。收权之后，客户端本地改的背包会在下一次存档被回填成库里的值 ——
   * 所以每一个「改背包」的动作都必须先有一个服务端写点，否则那个动作会变成「按下去没反应」。
   *
   * **服务端自己算的三个**（穿 / 脱 / 丢）与**只验守恒的两个**（整理 / 搬运）：
   * 前者决定数值或者销毁物品，后者只是换位置。复刻一遍客户端的 move/merge/swap 会让
   * 两端慢慢漂开（本地那份还带着「合并超过上限留在原格」这类细节），所以改成
   * 「客户端给排布、服务端验内容守恒」—— 少一件多一件都过不去，算子见 `role-inventory.ts`。
   *
   * 失败路径：20020 目标不合法（空格子 / 空槽位）/ 20021 穿不上（不是装备 / 认不出 / 等级不够）
   * / 20022 排布与库里对不上 / 20012 背包满（卸下时没有空格）。
   */
  bagOp(accountId: string, roleId: string, dto: BagOpDto): BagOpResultDto {
    const account = this.mustAccount(accountId);
    const existing = this.mustOwnRole(accountId, roleId);
    // 与升级 / 购买 / 用药同一纪律：被踢下线的角色不能继续改背包
    if (account.online_role_id !== roleId) {
      throw BizException.conflict(BizCode.ROLE_KICKED, "该角色已被管理员下线，请重新选择角色进入游戏");
    }
    if (dto.revision !== existing.revision) {
      throw BizException.conflict(BizCode.ROLE_REVISION_CONFLICT, "该角色已在别处被修改，请先同步最新数据");
    }

    const data = decodeStoredRoleData(existing.data);
    let grid: BagGrid = readBagGrid(data.bag);
    // 老存档的装备槽位可能是收权之前写进去的：顺手清掉「部位不符 / 同一件穿多格」的脏数据，
    // 否则属性重算会把它算进战力（见 sanitizeEquipments 的注释）
    const cleaned = sanitizeEquipments(readWornEquipments(data.equipments), (id) => equipmentSlotOf(id));
    if (cleaned.dropped.length) {
      this.logger.warn(
        `角色 ${roleId} 的装备槽位有脏数据，已清理：` +
          cleaned.dropped.map((item) => `${item.slot}=${item.id}（${item.reason}）`).join("；"),
      );
    }
    const worn = cleaned.equipments;
    let slot: string | null = null;
    /** 丢弃的物品（#886）：记在 switch 里、落库**之后**再写流水 —— 乐观锁失败时不能留假记录 */
    let discarded: { id: string; count: number } | null = null;

    switch (dto.action) {
      case "equip": {
        const cell = cellAt(grid, dto.row, dto.col);
        if (!cell) throw new BizException(BizCode.BAG_TARGET_INVALID, "这一格没有可以穿戴的装备");
        const equipmentSlot = equipmentSlotOf(cell.id);
        if (!equipmentSlot) throw new BizException(BizCode.BAG_EQUIP_REJECTED, "这件物品不是装备，无法穿戴");
        const required = equipmentLevelOf(cell.id);
        if (required === null) throw new BizException(BizCode.BAG_EQUIP_REJECTED, `认不出的装备：${cell.id}`);
        if (required > existing.level) {
          throw new BizException(BizCode.BAG_EQUIP_REJECTED, `需要等级 ${required} 才能穿戴这件装备`);
        }
        equipAt(grid, worn, Number(dto.row), Number(dto.col), equipmentSlot);
        slot = equipmentSlot;
        break;
      }
      case "unequip": {
        if (!dto.slot) throw new BizException(BizCode.BAG_TARGET_INVALID, "缺少装备槽位");
        // 槽位名不在客户端那套清单里（改包塞了个 other99）→ 连脱都不用脱，直接拒绝
        if (!isEquipmentSlot(dto.slot)) {
          throw new BizException(BizCode.BAG_TARGET_INVALID, `没有这个装备槽位：${dto.slot}`);
        }
        unequipSlot(grid, worn, dto.slot);
        slot = dto.slot;
        break;
      }
      case "discard": {
        discarded = discardAt(grid, Number(dto.row), Number(dto.col));
        break;
      }
      case "move":
      case "tidy": {
        if (!dto.cells) throw new BizException(BizCode.BAG_TARGET_INVALID, "缺少操作后的背包内容");
        const arranged = applyBagCells(grid, normalizeBagCells(dto.cells)) as BagGrid;
        // 位置听客户端的，**绑定与溯源听服务器的**（#789）：先把旧网格里的元数据认领回来。
        // 顺序很关键 —— 上报的格子契约里没有 `bound`（客户端只知道 id/count），若拿原始
        // arranged 去比守恒，绑定的那一堆一挪位置就会被当成「凭空冒出几个可交易的」而拒绝。
        // 认领之后再比：交叉合并（绑定 2 + 未绑定 4 报成一格 6 个）会因另一桶归零被抓到。
        const reconciled = reconcileBagCells(grid, arranged);
        // 守恒判据只有两条：形状不变、（绑定状态 + id）的总件数不变
        // （搬运的合并 / 交换、整理的重排都满足；绑定堆与未绑定堆互换会被这里拦下）
        if (!sameGridShape(grid, reconciled) || !sameBagContent(grid, reconciled)) {
          throw new BizException(BizCode.BAG_ARRANGE_INVALID, "背包内容与服务器不一致，请重新打开背包");
        }
        grid = reconciled;
        break;
      }
      default: {
        // DTO 的 @IsIn 已经拦过一遍，这里是给「将来加了动作却忘了写分支」留的显式出口
        throw new BizException(BizCode.BAG_TARGET_INVALID, `不支持的背包操作：${String(dto.action)}`);
      }
    }

    data.bag = grid;
    data.equipments = worn;
    // 穿戴 / 卸下改了 `equipments` —— 它是属性重算的输入，必须当场重算（血蓝上限跟着变）
    if (dto.action === "equip" || dto.action === "unequip") {
      this.applyAuthoritativeAttributes(existing.level, data);
      clampVitals(data);
    }

    const row: RoleRow = {
      ...existing,
      data: JSON.stringify(data),
      revision: existing.revision + 1,
      updated_at: Date.now(),
    };
    this.persistOrConflict(row, existing.revision, "整理背包");
    // 行为流水（#886）：只有「丢弃」是物品离手（穿戴 / 卸下 / 整理只是位置变化，不记）
    if (discarded) {
      this.eventLogs.record({
        type: EVENT_TYPE.CONSUME,
        accountId,
        roleId,
        roleName: existing.name,
        mapId: this.mapAtOf(data),
        target: discarded.id,
        amount: Math.max(1, Math.floor(Number(discarded.count) || 1)),
        detail: { reason: "discard" },
      });
    }
    return BagOpResultDto.fromRow(row, account.online_role_id, dto.action, slot);
  }

  /** 读存档背包网格的指定格子（网格不是数组 / 坐标越界 / 格子为空 → 同一个 20013 失败语义） */
  private readBagCell(
    data: Record<string, unknown>,
    row: number,
    col: number,
    code: number = BizCode.DRUG_USE_TARGET_INVALID,
    message = "该格子为空，没有可使用的药品",
  ): { id: string; count: number } {
    const bag = data.bag;
    const line = Array.isArray(bag) ? (bag as unknown[])[row] : undefined;
    const cell = Array.isArray(line) ? (line as unknown[])[col] : undefined;
    if (!cell || typeof cell !== "object" || typeof (cell as Record<string, unknown>).id !== "string") {
      throw BizException.conflict(code, message);
    }
    const record = cell as Record<string, unknown>;
    return { id: record.id as string, count: Math.max(1, Math.floor(Number(record.count) || 1)) };
  }

  /**
   * 改写某格数量，**其余字段原样保留**（#816）
   *
   * 以前这里是 `{ id: cell.id, count: remaining }` —— 重建对象等于把这一格上的
   * `bound` / `from` 一起抹掉：5 瓶「掉落即绑定」的药用到剩 1 瓶就变成可交易的了，
   * 溯源同理。`bound` 是**格子级**元数据（同一 id 的两堆可以一堆绑定一堆不绑定），
   * 所以它不能从物品配置反推，只能原样搬运。
   *
   * 换新对象而不是原地改 `count`：`readBagCell` 给出去的是副本，就地改不会落回 `data`；
   * 且换新对象能保证写回的那格与任何外部引用都不共享（沿用原写法）。
   */
  private writeBagCount(data: Record<string, unknown>, row: number, col: number, remaining: number): void {
    const bag = data.bag;
    const line = Array.isArray(bag) ? (bag as unknown[])[row] : undefined;
    if (!Array.isArray(line)) return;
    const cells = line as unknown[];
    const cell = cells[col];
    if (remaining <= 0 || !cell || typeof cell !== "object") {
      cells[col] = null;
      return;
    }
    cells[col] = { ...(cell as Record<string, unknown>), count: remaining };
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
    // 先结算自然回复再扣伤害（#596）：两次受击之间攒的回复不能被这一次落账吃掉
    // （这里 stored 与 incoming 是同一个对象，函数内先读后写，顺序安全）
    settleVitalsAuthority(data, data, Date.now(), this.mpRecoverPerSecond());
    const previous = Math.max(0, Math.floor(Number(data.hp) || 0));
    if (previous <= 0) return null; // 已经死了：不再扣也不再报
    const { maxHp } = this.resolveResourceLimits(existing, data);
    const hp = Math.max(0, previous - Math.max(0, Math.floor(damage)));
    data.hp = hp;
    // 不推进修订号（见方法注释）：血量以实时帧为准，revision 留给进度型写入
    this.roles.updateDataKeepRevision(existing.id, JSON.stringify(data), Date.now());
    // 死了就把状态清空（docs/22 §5）：复活后不该带着旧 buff，也不该让「死了还挂加速」成立。
    // 放在落库之后：清状态失败不该影响这一刀的血量（它是演出侧的事实，血量是权威）
    if (hp <= 0) this.statuses.clearOfRole(existing.id);
    return { hp, maxHp };
  }

  //#region 角色状态（#822：结算与受击的权威数值来源）

  /**
   * 本账号在线角色此刻生效中的状态（settle 帧与客户端图标栏的权威快照）
   *
   * 不在线返回空数组而不是抛错：调用方（结算 / 受击）只关心「有没有 buff」，
   * 人不在线时那就是没有。
   */
  statusSnapshotOf(accountId: string): Array<{ id: string; stacks: number; remainingMs: number }> {
    const row = this.onlineRoleRow(accountId);
    return row ? this.statuses.snapshotOf(row.id) : [];
  }

  /**
   * 给本账号在线角色施加一个状态（状态型技能的唯一落点）
   *
   * @returns 施加后的完整快照；`null` = 不在线，或配置里没有这个状态 / 持续时间配成 0
   *          （后者是运营配错，调用方应当当场报错而不是静默放行）
   */
  applyStatusToOnlineRole(accountId: string, statusId: string, skillId: string): Array<{ id: string; stacks: number; remainingMs: number }> | null {
    const row = this.onlineRoleRow(accountId);
    if (!row) return null;
    const applied = this.statuses.apply(row.id, statusId, { skillId });
    return applied ? this.statuses.snapshotOf(row.id) : null;
  }

  /**
   * 本账号在线角色的状态数值修正（受击算格挡 / 防御倍率、出伤算攻击倍率）
   *
   * 不在线 → 中性值（没人可打，调用方前面的闸已经拒了，这里只是不给 undefined）
   */
  statusModifiersOf(accountId: string): RoleStatusModifiers {
    const row = this.onlineRoleRow(accountId);
    return row ? this.statuses.modifiersOf(row.id) : { ...NO_STATUS_MODIFIERS };
  }

  /** 清空本账号在线角色的状态（下线 / 被踢；换图不清 —— 换图不是死亡） */
  clearStatusesOf(accountId: string): void {
    const row = this.onlineRoleRow(accountId);
    if (row) this.statuses.clearOfRole(row.id);
  }

  //#endregion

  /**
   * 当前血蓝（服务端权威值；把自然回复算进去，但**不落库**）
   *
   * 给施法前的「血够不够 / 蓝够不够」判据用（#813）。与 `applyMonsterHit` 同一套结算：
   * 先 `settleVitalsAuthority` 把两次写入之间攒的回复算上，再夹上限 —— 否则「刚回满蓝」
   * 的玩家在库里还是旧值，蓝耗闸会把合法出手误判成蓝不足。
   *
   * 只读：算出来的值不写回存档；真正扣蓝走 `spendCastMp`（它才写库）。
   * 读不到在线角色返回 null（调用方据此拒绝，不要拿 0 当“没蓝”以外的东西）。
   */
  vitalsOf(accountId: string): { hp: number; mp: number; maxHp: number; maxMp: number } | null {
    const row = this.onlineRoleRow(accountId);
    if (!row) return null;
    const stored = decodeStoredRoleData(row.data);
    const { maxHp, maxMp } = this.resolveResourceLimits(row, stored);
    // 上限要先进 incoming 再结算：settleVitalsAuthority 用 incoming 里的上限做夹取
    const incoming: Record<string, unknown> = { ...stored, maxHp, maxMp };
    settleVitalsAuthority(stored, incoming, Date.now(), this.mpRecoverPerSecond());
    return {
      hp: Math.max(0, Math.floor(Number(incoming.hp) || 0)),
      mp: Math.max(0, Math.floor(Number(incoming.mp) || 0)),
      maxHp,
      maxMp,
    };
  }

  /**
   * 施法扣蓝（#813 的耗蓝闸：法力归服务端，客户端改包上报无效）
   *
   * 顺序：先结算自然回复（攒的那部分不能被这一次消耗吃掉），再比、再扣、再落库。
   * - 蓝不足 → null，且**不写库**：回复累加器还在存档里，下次结算照旧算对；
   * - `cost <= 0` → 不写库（绝大多数技能不耗蓝，每次出手写一遍库没有必要）；
   * - **刻意不推进 revision**：与 `applyMonsterHit` 同一纪律 —— 法力是实时型状态，
   *   推进会跟客户端的防抖存档撞乐观锁，玩家反而一直存档失败。
   */
  spendCastMp(accountId: string, cost: number): { mp: number; maxMp: number } | null {
    const account = this.accounts.findById(accountId);
    const existing = account && account.online_role_id ? this.roles.findById(account.online_role_id) : undefined;
    if (!account || !existing) return null;

    const data = decodeStoredRoleData(existing.data);
    settleVitalsAuthority(data, data, Date.now(), this.mpRecoverPerSecond());
    const { maxMp } = this.resolveResourceLimits(existing, data);
    const price = Math.max(0, Math.floor(cost));
    const current = Math.max(0, Math.floor(Number(data.mp) || 0));
    if (current < price) return null;
    if (price <= 0) return { mp: current, maxMp };

    const remaining = current - price;
    data.mp = remaining;
    this.roles.updateDataKeepRevision(existing.id, JSON.stringify(data), Date.now());
    return { mp: remaining, maxMp };
  }

  /**
   * 复活（#596：满血由服务端落账，客户端改包上报满血无效）
   *
   * 死亡状态（hp ≤ 0）时把血蓝补到服务端重算的上限、清零两个回复累加器并重置结算游标；
   * 未死亡时拒收（20015）—— 客户端应当在死亡弹窗里调这个接口，而不是本地把血改满。
   *
   * **刻意不推进 revision**（与 `applyMonsterHit` 同一纪律）：血量型写入走实时帧同步，
   * revision 只由「进度型」写入推进。返回值带上下限，客户端直接照搬刷新血球。
   */
  revive(accountId: string, roleId: string): ReviveResultDto {
    const account = this.mustAccount(accountId);
    const existing = this.mustOwnRole(accountId, roleId);
    if (account.online_role_id !== roleId) {
      throw BizException.conflict(BizCode.ROLE_KICKED, "该角色已被管理员下线，请重新选择角色进入游戏");
    }

    const data = decodeStoredRoleData(existing.data);
    if (Math.max(0, Math.floor(Number(data.hp) || 0)) > 0) {
      throw BizException.conflict(BizCode.ROLE_NOT_DEAD, "角色未死亡，无需复活");
    }
    const { maxHp, maxMp } = this.resolveResourceLimits(existing, data);
    data.hp = maxHp;
    data.mp = maxMp;
    data.hpRecoverAccumulator = 0;
    data.mpRecoverAccumulator = 0;
    data.vitalsSettledAt = Date.now();
    this.roles.updateDataKeepRevision(existing.id, JSON.stringify(data), Date.now());
    return { hp: maxHp, mp: maxMp, maxHp, maxMp };
  }

  /**
   * 购买时装（#596：扣费与拥有清单都在服务端）
   *
   * 渠道 = `fashions.acquire_channel === "upgrade"` 且 `sell_price > 0` 才可买
   * （与称号的渠道语义同源：upgrade = 玩家花绑定元宝获得；grant = 运营发放，走管理端
   * PATCH `fashionsOwned`；unavailable = 未开放）。价格只认 fashions 表（管理端改价即时生效）。
   *
   * 拥有清单 `fashionsOwned` 是**独占字段**（`SERVER_EXCLUSIVE_FIELDS`）：客户端上报无效，
   * 只能由这里与管理端写。重复购买拒收（20016，不做「已拥有转退款」——那是新需求）。
   *
   * 失败路径：20016 渠道未开放 / 售价为 0 / 已拥有；20011 绑定元宝不足；20006 / 20007 同 save。
   */
  fashionBuy(accountId: string, roleId: string, dto: FashionBuyDto): FashionBuyResultDto {
    const account = this.mustAccount(accountId);
    const existing = this.mustOwnRole(accountId, roleId);
    if (account.online_role_id !== roleId) {
      throw BizException.conflict(BizCode.ROLE_KICKED, "该角色已被管理员下线，请重新选择角色进入游戏");
    }
    if (dto.revision !== existing.revision) {
      throw BizException.conflict(BizCode.ROLE_REVISION_CONFLICT, "该角色已在别处被修改，请先同步最新数据");
    }

    const fashion = this.fashions.findByKey(dto.fashionId);
    if (!fashion) throw BizException.conflict(BizCode.FASHION_NOT_OFFERED, "该时装不存在");
    const price = Math.max(0, Math.floor(fashion.sell_price));
    if (fashion.acquire_channel !== AcquireChannel.UPGRADE || price <= 0) {
      throw BizException.conflict(BizCode.FASHION_NOT_OFFERED, "该时装未开放购买");
    }

    const data = decodeStoredRoleData(existing.data);
    const owned = this.readFashionOwned(data);
    if (owned.includes(fashion.id)) {
      throw BizException.conflict(BizCode.FASHION_NOT_OFFERED, "已拥有该时装，无需重复购买");
    }

    const bindGold = Math.max(0, Math.floor(Number(data.bindGold) || 0));
    if (bindGold < price) {
      throw BizException.conflict(BizCode.MALL_GOLD_NOT_ENOUGH, `绑定元宝不足，购买需要 ${price}`);
    }
    data.bindGold = bindGold - price;
    owned.push(fashion.id);
    data.fashionsOwned = owned;
    const bindGoldAfter = bindGold - price;

    const row: RoleRow = {
      ...existing,
      data: JSON.stringify(data),
      revision: existing.revision + 1,
      updated_at: Date.now(),
    };
    this.persistOrConflict(row, existing.revision, "购买时装");
    return { fashionId: fashion.id, price, bindGold: bindGoldAfter, owned, revision: row.revision };
  }

  /**
   * 穿 / 脱时装（#596：穿着态归服务端，「拥有才给穿」在这里校验）
   *
   * 穿时装不改任何数值（时装只换外观，见客户端 `applyFashionChange` 的同一口径），
   * 所以不触发属性重算；穿着态是进度型写入，revision +1。
   *
   * 老档迁移：`fashionsOwned` 上线前的存档没有这个键 —— 第一次穿 / 脱时把**当前穿着**认领进
   * 清单（它只能是历史合法穿着，否则早就被 #377 的校验清掉了），空档给空清单。
   *
   * 失败路径：20017 不在拥有清单 / 时装表里没有这个 id；20006 / 20007 同 save。
   */
  fashionWear(accountId: string, roleId: string, dto: FashionWearDto): FashionWearResultDto {
    const account = this.mustAccount(accountId);
    const existing = this.mustOwnRole(accountId, roleId);
    if (account.online_role_id !== roleId) {
      throw BizException.conflict(BizCode.ROLE_KICKED, "该角色已被管理员下线，请重新选择角色进入游戏");
    }
    if (dto.revision !== existing.revision) {
      throw BizException.conflict(BizCode.ROLE_REVISION_CONFLICT, "该角色已在别处被修改，请先同步最新数据");
    }

    const data = decodeStoredRoleData(existing.data);
    // 迁移后的清单必须写回：readFashionOwned 对老档只做了「内存认领」，
    // 不落库的话换设备 / 重进又变回无清单（第一次穿 / 脱的迁移就白做了）
    const owned = this.readFashionOwned(data);
    data.fashionsOwned = owned;
    const target = dto.fashionId ? String(dto.fashionId) : null;
    if (target) {
      if (!owned.includes(target)) {
        throw BizException.conflict(BizCode.FASHION_NOT_OWNED, "尚未拥有该时装，先购买或由运营发放");
      }
      if (!this.fashions.findByKey(target)) {
        throw BizException.conflict(BizCode.FASHION_NOT_OWNED, "该时装不存在");
      }
    }
    data.fashionCloth = target;

    const row: RoleRow = {
      ...existing,
      data: JSON.stringify(data),
      revision: existing.revision + 1,
      updated_at: Date.now(),
    };
    this.persistOrConflict(row, existing.revision, "更换时装");
    return { fashionCloth: target, owned, revision: row.revision };
  }

  /**
   * 读存档里的时装拥有清单（带老档迁移：没有键时把当前穿着认领进去）
   *
   * 清单元素去重、只留字符串 —— 管理端 PATCH 与购买两条写路都过这里规整一次。
   */
  private readFashionOwned(data: Record<string, unknown>): string[] {
    if (Array.isArray(data.fashionsOwned)) {
      return Array.from(new Set(data.fashionsOwned.filter((id): id is string => typeof id === "string" && id.length > 0)));
    }
    // 老档迁移：清单没建过 → 当前穿着（若有的话）就是历史合法拥有
    const worn = typeof data.fashionCloth === "string" && data.fashionCloth ? [data.fashionCloth] : [];
    return worn;
  }

  /**
   * 击杀计数 +1（#400：排行榜的原料）
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
   * 结算侧算出本次经验后交给这里落账：累加进存档 `data.exp`，按 **等级曲线**（#786 的
   * `exp` 那条，管理端可改、即时生效）判定升级、循环升到 `growth_scalars.roleMaxLevel` 封顶，
   * `roles.level` 索引列与 revision 原子推进。
   *
   * 升级算法本身在 `./level-up`（纯函数）：击杀 / 泡点 / 队友分账 / 发奖四条路共用同一份，
   * 上一版是「击杀一份、发奖再抄一份」，抄着抄着就漂成了「击杀补满血、发奖不补」（B13）。
   *
   * @returns 入账后的角色状态（level / expNow / expNeed / leveledUp / revision）；
   *          角色已被踢下线等无法落账的情况返回 null（调用方跳过奖励，不视为错误）
   */
  applyKillExp(accountId: string, roleId: string, exp: number): KillExpResult | null {
    const account = this.accounts.findById(accountId);
    const existing = account ? this.roles.findById(roleId) : undefined;
    // 与升级 / 购买同一纪律：被踢下线的角色不能再推进度（结算进行到一半被踢是正常情况）
    if (!account || !existing || existing.account_id !== accountId || account.online_role_id !== roleId) return null;

    const data = decodeStoredRoleData(existing.data);
    const outcome = this.settleLevelUp(existing.level, data.exp, exp, data);

    const row: RoleRow = {
      ...existing,
      level: outcome.level,
      data: JSON.stringify(data),
      revision: existing.revision + 1,
      updated_at: Date.now(),
    };
    // 经验入账**不抛冲突**（B62 / #820）：这条路径由服务端自己的击杀 / 泡点节拍驱动，
    // 没有客户端基线可让玩家「重试」。修订号被改动说明这一行的存档刚被别人整体换过
    // （管理端改数值 / 玩家存档落库），此刻按旧 `existing` 覆盖会把对方的改动盖掉 ——
    // 丢掉这一笔经验远比丢掉对方的改动便宜，所以记一条 warn 后返回 null（调用方按「没入账」处理）。
    if (!this.roles.replace(row, existing.revision)) {
      this.logger.warn(`角色 ${roleId} 经验入账时修订号已被改动（基线 ${existing.revision}），本次经验放弃`);
      return null;
    }
    return {
      level: outcome.level,
      expNow: outcome.exp,
      expNeed: this.expNeedOf(outcome.level),
      leveledUp: outcome.leveledUp,
      revision: row.revision,
    };
  }

  /**
   * 泡点入账（#722：在线角色按服务端节拍发经验）
   *
   * 与击杀经验共用同一条升级链路（`applyKillExp`：role_levels 判定、循环升到上限、
   * 权威属性重算），不另起一套 —— 泡点涨的级和打死怪涨的级必须是同一种级。
   *
   * **满级短路**：满级后经验不再有任何去处，每拍白写一次库还推进 revision，
   * 会让客户端每拍多收一帧无意义的 roleUpdate —— 直接跳过。
   *
   * @returns 入账结果；不在线 / 满级 / 角色归属不符返回 null（tick 侧跳过，不视为错误）
   */
  applySoakExp(accountId: string, exp: number): KillExpResult | null {
    const account = this.accounts.findById(accountId);
    const roleId = account?.online_role_id;
    if (!account || !roleId) return null;
    const role = this.roles.findById(roleId);
    if (!role || role.account_id !== accountId) return null;
    if (role.level >= this.roleMaxLevel()) return null;
    return this.applyKillExp(accountId, roleId, exp);
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
    /**
     * 奖励来源（写进行为流水的 `detail.source`）
     *
     * 任务 / 成就 / 邮件三个调用方共用这个方法，而流水里「这批东西是哪来的」正是运营
     * 最常问的一句 —— 默认值只是兜底，真正的调用方都应该传。
     */
    source = "deliver",
  ): KillExpResult {
    return this.applyRewards(this.onlineRoleOrThrow(accountId, roleId), consume, rewards, source);
  }

  /**
   * 按 `roleId` 直接发奖，**不要求角色在线**（#867 邮件过期自动入包）
   *
   * 与 {@link grantQuestRewards} 共用同一段发奖主体（`applyRewards`），差别只有前置：
   * 那个走 `onlineRoleOrThrow`（要「这个账号此刻在玩的就是这个角色」），这个只按 id 取行。
   *
   * 三个边界：
   * - **乐观锁照旧**（`persistOrConflict`）：自动入包与玩家自己保存撞上了就 409，
   *   调用方按「下一轮再试」处理，不在这里重试；
   * - **`accountId` 从角色行上取**（不是入参）：行为流水的 `accountId` 不能因为调用方
   *   传错而对到别的账号；
   * - **只在离线时用**：在线角色的存档在客户端手里，服务端改了库会被下一次全量覆盖冲掉 ——
   *   「要不要入包」由调用方（`GameMailAutoClaimService`）判，这里不判（KISS：
   *   这个方法就是个发奖原语，不背在线语义）。
   */
  grantByRoleId(
    roleId: string,
    rewards: { gold: number; exp: number; items: Array<{ goodId: string; count: number }> },
    source = "mail-auto",
  ): KillExpResult {
    const existing = this.roles.findById(roleId);
    if (!existing) throw BizException.notFound(BizCode.ROLE_NOT_FOUND, "角色不存在");
    return this.applyRewards(existing, null, rewards, source);
  }

  /**
   * 发奖主体（**两个入口共用**：在线交付 / 离线按 id 发）
   *
   * 抽出来是为了不让「在线版」和「离线版」各抄一份循环 —— 上一版击杀经验与任务发奖
   * 各抄一份的教训是「升级补血一边补一边不补」。这里所有校验都在落库之前跑完
   * （材料不足 20017 / 背包放不下 20012），异常路径存档一个字节不动。
   */
  private applyRewards(
    existing: RoleRow,
    consume: { goodId: string; count: number } | null,
    rewards: { gold: number; exp: number; items: Array<{ goodId: string; count: number }> },
    source: string,
  ): KillExpResult {
    // `accountId` 从角色行上取（不是入参）：行为流水的 accountId 不能因为调用方传错而对到别的账号
    const { account_id: accountId, id: roleId } = existing;
    const data = decodeStoredRoleData(existing.data);

    // 1) collect 材料：先点数再扣（不够整单拒绝，不做部分扣除）
    if (consume) {
      this.takeGoodsFromBag(data, consume.goodId, Math.max(1, Math.floor(consume.count)));
    }

    // 2) 奖励物品：逐份入包（放不下 20012，此时还没落库）
    for (const item of rewards.items ?? []) {
      const itemType = itemTypeOf(item.goodId);
      if (!itemType) throw BizException.conflict(BizCode.ROLE_DATA_INVALID, `奖励物品不存在：${item.goodId}`);
      this.placeGoodsIntoBag(data, item.goodId, itemType, Math.max(1, Math.floor(item.count)));
    }

    // 3) 金币（都在 data JSON 里，没有专用列）
    data.gold = Math.max(0, Math.floor(Number(data.gold) || 0)) + Math.max(0, Math.floor(rewards.gold ?? 0));

    // 4) 经验 + 升级：与击杀 / 泡点共用 `settleLevelUp`（等级曲线判定、上限封顶、
    //    `data.level` 同步、升级回满血蓝）
    const outcome = this.settleLevelUp(existing.level, data.exp, Math.max(0, Math.floor(rewards.exp ?? 0)), data);

    const row: RoleRow = {
      ...existing,
      level: outcome.level,
      data: JSON.stringify(data),
      revision: existing.revision + 1,
      updated_at: Date.now(),
    };
    this.persistOrConflict(row, existing.revision, "发放任务奖励");
    // 行为流水（#886）：奖励**物品与金币**各记一条（经验不记 —— 那是成长曲线的事，
    // 击杀 / 泡点早就各自记过了）。source 写 "deliver" 是因为任务与成就共用这个方法
    const gained = [] as Array<{
      type: string;
      accountId: string;
      roleId: string;
      roleName: string;
      mapId: string | null;
      target: string;
      amount: number;
      detail: { source: string };
    }>;
    const mapId = this.mapAtOf(data);
    const gold = Math.max(0, Math.floor(rewards.gold ?? 0));
    if (gold > 0) {
      gained.push({
        type: EVENT_TYPE.GAIN,
        accountId,
        roleId,
        roleName: existing.name,
        mapId,
        target: "gold",
        amount: gold,
        detail: { source },
      });
    }
    for (const item of rewards.items ?? []) {
      gained.push({
        type: EVENT_TYPE.GAIN,
        accountId,
        roleId,
        roleName: existing.name,
        mapId,
        target: item.goodId,
        amount: Math.max(1, Math.floor(item.count)),
        detail: { source },
      });
    }
    this.eventLogs.recordMany(gained);
    return {
      level: outcome.level,
      expNow: outcome.exp,
      expNeed: this.expNeedOf(outcome.level),
      leveledUp: outcome.leveledUp,
      revision: row.revision,
    };
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
        // 部分扣减只改 count：`bound` / `from` 是格子级元数据，重建对象等于把它抹掉（#816）
        else line[col] = { ...(cell as Record<string, unknown>), count: current - take };
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

  /**
   * 升级结算的唯一实现（A7 / A8 / B11 / B12 / B13）
   *
   * 四条会改等级的路径全走这里：击杀经验、泡点、队友分账（后两者都经 `applyKillExp`）、
   * 发奖（任务 / 成就 / 邮件领取）。上一版是两条各抄一份循环，抄出来的差别是
   * 「击杀升级满血、发奖升级不满」—— 同一个「升级」，玩家看出规律就没有规律。
   *
   * 三件事一起做，缺一件就会留下一个「两个真相」：
   * 1. `data.level` 与列同步（B11）—— 只写列的话，任何读文档 `level` 的地方都停在旧值；
   * 2. 属性重算（`data` 里的攻防血蓝上限由服务端公式覆盖）；
   * 3. 升级回满血蓝（A7）。
   *
   * 满级后经验封顶（A8）在 `resolveLevelUp` 里做，这里不重复判。
   *
   * @param currentLevel `roles.level` 列（权威）
   * @param currentExp   `data.exp`（可能是脏值/缺失）
   * @param gain         本次入账的经验
   * @param data         就地写的存档文档（`data.level` / `data.exp` / 属性 / 血蓝）
   */
  private settleLevelUp(currentLevel: number, currentExp: unknown, gain: number, data: Record<string, unknown>): LevelUpOutcome {
    const outcome = resolveLevelUp({
      level: currentLevel,
      exp: Number(currentExp) || 0,
      gain,
      maxLevel: this.roleMaxLevel(),
      expNeedOf: (level) => this.expNeedOf(level),
    });
    data.level = outcome.level;
    data.exp = outcome.exp;
    // 等级变了属性就变：服务端重算并写回存档（权威值，客户端那份只是演）
    this.applyAuthoritativeAttributes(outcome.level, data);
    if (outcome.leveledUp) {
      // 上限由上面那步算出；算不出来（等级在曲线外）时保持原值，不把血写成 undefined
      if (typeof data.maxHp === "number") data.hp = data.maxHp;
      if (typeof data.maxMp === "number") data.mp = data.maxMp;
    }
    return outcome;
  }

  /** 升到下一级所需经验（`role_levels.exp`；升级路径与实时进程 roleUpdate 帧共用；表里没有那一级回落 0） */
  expNeedAt(level: number): number {
    return this.expNeedOf(level);
  }

  private expNeedOf(level: number): number {
    // #786：经验来自等级曲线（`exp` 那条），不再有 `role_levels` 逐级行。
    // 走内存里的曲线投影（升级循环里每级问一次，不能每级一条 SELECT）。
    return Math.max(0, Math.floor(Number(roleLevelExpOf(level)) || 0));
  }

  /**
   * 等级上限（`growth_scalars` 表，管理端可改）
   *
   * 三级兜底（#832 / B14）：以前读不到就按 **1 级**算 —— 库缺一行（迁移没跑 / 被误删）
   * 的后果是**全服永久 1 级**：谁都不掉经验、谁都升不了级，而日志只有一条 warn，
   * 玩家侧看不到任何报错。所以兜底改成：
   *
   * 1. `growth_scalars.roleMaxLevel`（权威，每次现查库）；
   * 2. 运行时缓存里的同一个键（刚改完还没落库的窗口 / 读库失败）；
   * 3. **曲线配到的最高级**（`role_level_curves` 末段 `to_level`）—— 曲线能算到哪，
   *    人就能升到哪，比凭空写一个常数保守；
   * 4. 连曲线都没有（空库首启、迁移没跑）：才回到 1，并且**记 error**（不是 warn）——
   *    这是「玩法已经坏了」，不是「小事一桩」。
   */
  private roleMaxLevel(): number {
    const fromDb = Number(this.growth.findScalar("roleMaxLevel")?.value);
    if (Number.isFinite(fromDb) && fromDb >= 1) return Math.floor(fromDb);
    const fromCache = growthScalarOf("roleMaxLevel");
    if (Number.isFinite(fromCache) && (fromCache as number) >= 1) return Math.floor(fromCache as number);

    const fromCurve = roleLevelCurveMaxLevel();
    if (fromCurve !== null && fromCurve >= 1) {
      this.warnMissingMaxLevel(`已按曲线末段 ${fromCurve} 级兜底`);
      return fromCurve;
    }
    this.warnMissingMaxLevel("曲线也没装载，暂按 1 级（**此时无法升级**）");
    return 1;
  }

  /** 等级上限缺失的告警只打一次：每级查一次、每拍打一条等于没有日志 */
  private warnMissingMaxLevel(extra: string): void {
    if (this.maxLevelWarned) return;
    this.maxLevelWarned = true;
    this.logger.error(
      `[roles] growth_scalars 缺 roleMaxLevel（曲线与缓存都没读到），${extra}。` +
        `请在管理端「成长参数」页补上这一行（出厂值 1000000）`,
    );
  }

  /**
   * 魔法自然回复速度（#605：从写死的常量改成 `growth_scalars` 表，管理端可改）
   *
   * 与等级上限同一读法：**每次结算现查库**（不在进程里缓存），所以管理端改完下一次写档
   * 就按新速度走，不需要重启。读不到（老库没有这行 / 非数字）按 0 处理 —— 0 本来就是
   * 合法值（关闭自然回蓝），所以「没配」与「关掉」在这个键上同义。
   */
  private mpRecoverPerSecond(): number {
    const fromDb = Number(this.growth.findScalar("mpRecoverPerSecond")?.value);
    if (Number.isFinite(fromDb) && fromDb >= 0) return fromDb;
    return growthScalarOf("mpRecoverPerSecond") ?? 0;
  }

  /**
   * 战斗属性与战斗力的**权威重算**：按等级 + 存档（装备/战魂/称号/军衔）现算，
   * 直接覆盖 `data` 里的八项属性与 combat
   *
   * #541 起客户端不再自己算这些值（它那份只是演），凡是服务端写档的路径都要经过这里，
   * 保证库里落的一定是服务端公式的结果。等级不在成长曲线里（旧存档边角）时跳过 ——
   * 保留原值总比把属性抹成 0 好。
   *
   * **跳过时必须留痕**（#554）：曲线外推后「算不出来」只剩等级 < 1（脏存档）一种，
   * 但脏数据照样会让这里静默 —— 属性从此不再重算，而界面上看不出任何异常。
   * 所以打一条 warn 把「没算」说出口。
   */
  private applyAuthoritativeAttributes(level: number, data: Record<string, unknown>): void {
    const summary = summarizeRoleAttributes(roleAttributeSourceOf(level, data));
    if (!summary) {
      this.logger.warn(`[roles] 等级 ${level} 不在成长曲线内（当前上限 ${this.roleMaxLevel()}），战斗属性未重算`);
      return;
    }
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

  /**
   * 服务端记下的角色位置（`data.mapAt`）；还没有记录返回空串（#861）
   *
   * 只读。在场表（`PlayerPresenceService`）用它给「首帧」定坐标：自报的图必须与它一致，
   * 否则条目过期（几秒不上报）之后再来一帧伪造的图，又能把人注入到别的图。
   *
   * 与 `setMapAt` 同一份口径：「玩家在哪」只有服务端说了算，客户端上报的只算位置样本。
   * （与上面那个按 `data` 取值的私有 `mapAtOf` 分开命名 —— 那个还没有角色行可查。）
   */
  mapAtOfOnlineRole(accountId: string): string {
    const row = this.onlineRoleRow(accountId);
    if (!row) return "";
    const data = decodeStoredRoleData(row.data);
    return typeof data.mapAt === "string" ? data.mapAt : "";
  }

  /**
   * 记下「服务端承认的角色位置」（#606：进图门槛拿它当「他现在在哪」）
   *
   * 唯一正常写点是实时通道**接受一次 worldJoin** 的那一刻：客户端报什么不算数，
   * 服务端放行了哪张图才算。第二个写点是管理端摆位（PATCH 带 `onMap` 时一并写，
   * 那是运营的显式决定）。客户端存档里的同名字段一律回填丢弃（见 `role-authority.ts`
   * 的 `SERVER_EXCLUSIVE_FIELDS`）。
   *
   * **不推进 revision**：位置不是进度，推进修订号只会让刚好在切图时冲上来的客户端存档
   * 撞乐观锁（它本地那份 onMap 刚改过，撞上就得整份回滚，人会停在旧图）。
   * 走 `updateDataKeepRevision`，与怪物普攻落账同一条路。
   *
   * @param accountId 账号（位置记在它的在线角色上）
   * @param mapId     这次被接受的图
   */
  setMapAt(accountId: string, mapId: string): void {
    const row = this.onlineRoleRow(accountId);
    if (!row) return;
    const data = decodeStoredRoleData(row.data);
    // 幂等：同一张图重复 join（重连 / 换线）不写库 —— 实时的 join 是高频动作
    if (typeof data.mapAt === "string" && data.mapAt === mapId) return;
    data.mapAt = mapId;
    this.roles.updateDataKeepRevision(row.id, JSON.stringify(data), Date.now());
  }

  /** 选中（在线）角色（#547：标记与心跳一起置上，宽限期从这一刻起算） */
  select(accountId: string, roleId: string): RoleDto {
    this.mustAccount(accountId);
    // 存档版本闸（#818）：**进入游戏**是唯一该判「这份档还能不能玩」的地方。
    // 被拒时不置在线标记 —— 客户端会停在选角界面，飘字由网络层统一给出（20028）
    const row = this.migrateBeforeEnter(this.mustOwnRole(accountId, roleId));
    this.accounts.setOnlineRole(accountId, row.id);
    return RoleDto.from(row, row.id);
  }

  /**
   * 进入游戏前的存档版本闸（#818 / B60）
   *
   * 落后 → 当场迁到当前版本并**落一次库**，返回迁移后的行；已是当前版本 → 原样返回；
   * 迁不动（版本比代码新 / 链缺环）→ 抛 20028，库里一个字节都不动。
   *
   * 为什么在选角落库，而不是像 33 篇 3.1 原稿那样「等下次正常存档一起落」：
   * 服务端的读口有十几处（战斗 / 任务 / 拾取 / 实时快照…），内存里迁完只对**这一条路径**
   * 生效；紧接着一次用药、一次受击就会把库里的老形状原样写回去，版本号永远不前进，
   * 于是每次进入游戏都要重跑一遍链。落一次库的代价是每个角色一次 UPDATE，
   * 而它换来的是「库里那份从此就是当前版本」—— 后续所有读路径不需要知道迁移这回事。
   *
   * 用 `updateDataKeepRevision`（不推进修订号，与 `setMapAt` 同一理由）：迁移不是玩家进度，
   * 推进修订号只会让刚读完档的客户端下一次存档白撞 20006。
   *
   * **坏档也在这道闸里判**（#819）：`data` 解析不出来 → 置 `roles.corrupted=1` 并拒登（20029），
   * 存档原样保留等人工修。绝不把 `{}` 当成「空档」往下走 —— 空档在收权判定里意味着
   * 「库里没有这个字段，客户端那份是唯一来源」，那正好是 B61 那条提权通道。
   */
  private migrateBeforeEnter(row: RoleRow): RoleRow {
    // 严格解析（#819）：坏档必须能被认出来。`decodeStoredRoleData` 把解析失败折成 `{}`，
    // 而空对象在收权判定里是「库里没有这个字段 → 客户端那份是唯一来源」—— 那正是提权通道
    const parsed = decodeStoredRoleDataStrict(row.data);
    if (!parsed.ok) {
      this.roles.markCorrupted(row.id, true);
      this.logger.error(`角色 ${row.id} 的存档无法解析（${parsed.reason}），已标记 corrupted 并拒绝进入游戏`);
      throw BizException.conflict(BizCode.ROLE_DATA_CORRUPTED, "存档已损坏，暂时无法进入游戏，请联系客服");
    }
    // 之前标过坏档、现在能解析了（人工修好 JSON）→ 自动解封，不用运维再点一次
    if (row.corrupted) {
      this.roles.markCorrupted(row.id, false);
      this.logger.log(`角色 ${row.id} 的存档已恢复正常，corrupted 标记清除`);
    }
    const outcome = migrateRoleData(parsed.data, { wornBoundOf: bindOnDropOf });
    if (!outcome.migrated) return row;
    const data = JSON.stringify(outcome.data);
    this.roles.updateDataKeepRevision(row.id, data, Date.now());
    this.logger.log(`角色 ${row.id} 的存档已从 v${outcome.from} 迁到 v${outcome.to}`);
    return { ...row, data, corrupted: 0 };
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

  /**
   * 落库并复核修订号（B62 / #820）
   *
   * 每条写入路径都在开头比对过一次 revision，但那只是「读的那一刻」。
   * 真正的守卫是 `replace` 的 `WHERE id = ? AND revision = ?`：`changes === 0` 意味着
   * 这一行在读完到写完之间被别人改过（管理端改数值、另一条服务器消息并发落账…），
   * 此时**必须**放弃写入 —— 强行覆盖正是 B62 那条「管理端刚改的数值被静默盖掉」。
   *
   * 单进程 + 同步驱动下这个分支跑不到（`roles.service.ts` 全是同步函数）；
   * 留着是为了让「读 → 算 → 写」这件事在代码上成立，而不是靠「碰巧没有 await」。
   *
   * @param action 动作名，直接拼进错误文案（「保存存档」「购买商品」…），玩家看得懂在做什么
   * @throws BizException ROLE_REVISION_CONFLICT（409 / 20006）
   */
  private persistOrConflict(row: RoleRow, expectedRevision: number, action: string): void {
    if (this.roles.replace(row, expectedRevision)) return;
    this.logger.warn(`角色 ${row.id} ${action}时修订号已被改动（基线 ${expectedRevision}），本次写入放弃`);
    throw BizException.conflict(
      BizCode.ROLE_REVISION_CONFLICT,
      `${action}时角色已被其他改动更新，本次操作未生效，请重新同步最新数据`,
    );
  }

  /**
   * 落库失败就把冷却占位退掉（#847 / #848）
   *
   * 冷却是在写库**之前**占的（否则并发两个请求都能过检查）；这里补上反向动作：
   * 409 / 任何写入失败都意味着「这次没真的用掉」，让玩家白等一秒没有道理。
   * 只给用药与用道具用，其余写入口不涉及冷却。
   */
  private persistOrConflictGuarded(row: RoleRow, expectedRevision: number, action: string, cooldownKey: string): void {
    try {
      this.persistOrConflict(row, expectedRevision, action);
    } catch (error) {
      this.useCooldowns.release(cooldownKey);
      throw error;
    }
  }
}
