import { sys } from "cc";
import RoleUIManager from "./RoleUIManager";
import SceneManager from "./SceneManager";
import SkillManager from "./SkillManager";
import SoundManager from "./SoundManager";
import { initialShortcutKeys, bagRow, bagCol } from "../../configs/role";
import { Role } from "../../entities/Role";
import { BagCell, BagOrigin, EQUIPMENT_TYPE, Equipment, getGoodCount, Goods, isDrug, isEquipment, isLevelScroll, isMoneyItem, MoneyCurrency } from "../../types/good";
import { MapId } from "../../types/map";
import { NeedSetShortcutKeyConfig } from "../../types/role";
import { SkillId } from "../../types/skill";
import GameHelper from "./GameHelper";
import GameUiHelper from "../helpers/GameUiHelper";
import LayerManager from "./LayerManager";
import MpHelper from "../utils/battle/MpHelper";
import HpHelper from "../utils/battle/HpHelper";
import { skills } from "../../configs/skill";
import { BAG_ORIGIN_TEXT_MAX } from "../../types/good";
import { MONEY_CURRENCY_LABELS, bagMetaOf, getEquipment, getItem, moveBagCellGrid, normalizeBagGrid, resolveDrugRecovery, summarizeBagRecycle, tidyBagGrid, findBagEquipmentUpgrade, withBagMeta, wornIdOf, wornItemOf } from "../../configs/items";
import { getMallPrice } from "../../configs/game-config";
import { getFashion, fashionData } from "../../configs/game-config";
import { getEquipmentNameParts } from "../../configs/equipments";
import { nextSoulUpgrade } from "../../configs/game-config";
import { nextTitleUpgrade } from "../../configs/game-config";
import { nextRankUpgrade } from "../../configs/game-config";
import RoleSync from "../utils/net/RoleSync";
import Session from "../utils/net/Session";
import { RoleApi } from "../utils/net/Api";
import CombatChannel from "../utils/net/CombatChannel";
import type { CombatKillReward, MapEnterResult, RoleAuthorityUpdate } from "../utils/net/CombatChannel";
import type { BagOp, BagOpResult, DrugUseResult, GrowthUpgradeResult, LevelScrollUseResult, MallPurchaseResult, MoneyUseResult, SellGoodsResult } from "../utils/net/ApiModels";
import { normalizeGuideProgress } from "../utils/guide/guide-progress";
import { guideStepCount } from "../../configs/guide";

/**
 * 传送标记的有效期（毫秒）
 *
 * 传送 → Loading（加载新地图资源）→ Game.start，正常几秒到十几秒。超过这个时长说明
 * 那次进图中途失败了（配置没就绪被弹回 Loading、场景被切走），标记该作废 ——
 * 否则下次从登录进来会莫名其妙响一声传送音。60 秒足够盖住最慢的一次资源加载。
 */
const TELEPORT_MARK_TTL_MS = 60000;

/**
 * 道具使用的连点节流（#847 / #848）
 *
 * **权威冷却在服务端**（药品读 `drugs.cooldown` 秒、货币道具固定 1 秒，超了回 20030 / 20031
 * 带剩余毫秒）。这里只做一件小事：一秒内对**同一个道具**的重复点击不再发请求，
 * 免得玩家连点时被同一个提示刷屏。键里带物品 id，所以先红后蓝照样能用。
 *
 * 用 1 秒而不是读配置：客户端快照里没有 `drugs.cooldown` 这一列，
 * 而猜短一点只是「偶尔被服务端拒一次」，猜长才会挡住正常操作。
 */
const USE_GUARD_MS = 1000;
const useGuardUntil = new Map<string, number>();

/** 一秒内重复点同一个道具 → false（不发请求，也不弹提示） */
function guardRepeatedUse(key: string): boolean {
  const now = Date.now();
  if ((useGuardUntil.get(key) ?? 0) > now) return false;
  useGuardUntil.set(key, now + USE_GUARD_MS);
  return true;
}

/**
 * 存储管理器
 * 负责本地角色数据的读写，以及数据变更后的属性重算、UI刷新与外观更新
 *
 * **本地 roles 是服务端数据的缓存，服务端才是权威**（账号体系见 ui/utils/net）：
 * - 进游戏前由选角场景拉一次完整数据写进缓存（见 cacheRole），游戏内各处照旧同步读；
 * - 任何一次落盘（updateOnlineRole）都会经 RoleSync 防抖推回服务端，不再有「只存本地」的改动；
 * - 账号与令牌不在这里，见 ui/utils/net/Session（clear 会一并清掉会话，避免清了存档还留着登录态）。
 */
export default class StorageManager {
  /**
   * 「这次进游戏场景是传送过来的」时间戳（0 = 不是传送，#685）
   *
   * 传送音不能点在传送那一刻响（那时还在 Loading 场景里转圈，玩家听不出是传送还是加载），
   * 要等角色真的出现在新地图上。而「进游戏场景」这件事本身分不出是登录进来的还是传送进来的，
   * 所以由 `changeOnMap` 留一个标记、`Game.start` 在角色显示出来后取走。
   */
  private static teleportArrivedAt = 0;

  /** 标记「接下来这次进图是传送」（由 changeOnMap 调用） */
  private static markTeleportArrival() {
    this.teleportArrivedAt = Date.now();
  }

  /**
   * 取走传送标记（只在 `Game.start` 里调一次）
   *
   * 带有效期作废（见 TELEPORT_MARK_TTL_MS）：进图流程中途失败时这个标记不该留到下一次进图，
   * 否则登录进来也会莫名其妙响一声传送音。
   */
  static consumeTeleportArrival(): boolean {
    const pending = this.teleportArrivedAt > 0 && Date.now() - this.teleportArrivedAt < TELEPORT_MARK_TTL_MS;
    this.teleportArrivedAt = 0;
    return pending;
  }

  /** 获取角色列表 */
  static getRoles(): Role[] {
    const roles = sys.localStorage.getItem("roles");
    if (roles) return JSON.parse(roles);
    return [];
  }

  /** 更新角色列表 */
  static setRoles(roles: Role[]) {
    sys.localStorage.setItem("roles", JSON.stringify(roles));
  }

  /**
   * 把服务端返回的角色完整数据写进本地缓存（按 id 覆盖）
   *
   * 调用时机只有两处，都是「服务端刚给了一份权威数据」的时刻：
   * 1. 选角场景选中角色（服务端返回完整数据，见 ui/RoleSelector.enterGame）；
   * 2. 选角场景创建角色（服务端落库后回传完整数据）。
   *
   * **不触发**服务端同步：这份数据本来就是从服务端拿的，推回去纯属白跑一趟。
   * 角色数量上限只在服务端（#878，默认 6 个）：本地不存这个数字、也不预拦，
   * 建号被拒时服务端返回 400 / 20018 并带上限，直接展示文案。
   * @param role 服务端返回的角色完整数据（服务端存的就是客户端 entities/Role 的快照）
   */
  static cacheRole(role: Role) {
    const roles = this.getRoles();
    const index = roles.findIndex((item) => item.id === role.id);
    if (index >= 0) roles[index] = role;
    else roles.push(role);
    this.setRoles(roles);
  }

  /**
   * 把**服务端接口返回的角色数据**（详情 / 创建 / 选中 / 冲突后拉取）写进本地缓存
   *
   * 与 cacheRole 的唯一区别：顺手记下服务端修订号（乐观锁基线，见 entities/Role.revision）。
   * 服务端返回的是统一包裹里的 data + 同级的 revision，映射收在这里，
   * 免得每个调用点自己拼 `{ ...data, revision }`（漏一处就一直拿旧版本去撞乐观锁）。
   * @returns 写进缓存的角色；数据不完整（没有 id）时返回 null 并跳过
   */
  static cacheServerRole(detail: { data: unknown; revision: number }): Role | null {
    const source = detail && detail.data && typeof detail.data === "object" ? (detail.data as Role) : null;
    if (!source || !source.id) {
      console.warn("[storage] 服务端返回的角色数据不完整，已跳过缓存");
      return null;
    }
    const role: Role = { ...source, revision: detail.revision };
    this.cacheRole(role);
    return role;
  }

  /**
   * 记下服务端刚给的修订号（推送成功后的基线更新）
   *
   * **不触发同步**：这只是把「我是基于哪一版」对齐，数据本身没变，
   * 推回去纯属白跑一趟（与 cacheRole 同一口径）。
   */
  static applyServerRevision(roleId: string, revision: number) {
    const roles = this.getRoles();
    let changed = false;
    roles.forEach((role) => {
      if (role.id !== roleId || role.revision === revision) return;
      role.revision = revision;
      changed = true;
    });
    if (changed) this.setRoles(roles);
  }

  /** 根据id获取角色 */
  static findRoleById(id: string) {
    return this.getRoles().find((i) => i.id === id);
  }

  /**
   * 删除角色的**本地缓存**（选角界面「管理」入口调用，见 ui/RoleSelector 的删除按钮）
   *
   * 真删在服务端：选角场景先调 RoleApi.remove，服务端删成功后才来这里清缓存
   * ——顺序反了会出现「本地没了但服务端还在」，下次拉列表角色又冒出来。
   * 本地这一步就是从数组移除并落盘，**不可恢复**。
   * 删完必须确认 selectedRole 不再指向已不存在的角色：玩家上次进游戏时选中过它，
   * 残留的选中项会让下一次 findOnlineRole 取到 undefined（进游戏直接卡在取角色那一步）；
   * 顺手也清掉「本来就指向不存在角色」的脏选中项（例如存档被外部改动过）。
   * @param id 角色 id（Role.id）
   * @returns 是否清理成功（角色不在本地缓存时返回 false，调用方据此区分提示）
   */
  static deleteRole(id: string): boolean {
    const roles = this.getRoles();
    const index = roles.findIndex((role) => role.id === id);
    if (index < 0) return false;
    roles.splice(index, 1);
    this.setRoles(roles);
    const selected = sys.localStorage.getItem("selectedRole");
    if (selected && !roles.some((role) => role.id === selected)) sys.localStorage.removeItem("selectedRole");
    return true;
  }

  /**
   * 清空本地存储（角色缓存 + 当前会话）
   *
   * 登录场景启动时调用（**仅未登录时** —— 已有登录态的刷新会直接跳选角并保留缓存，
   * 见 ui/Login.start）：确保换账号重新登录时，上个账号的角色缓存与令牌不会串到下一个账号。
   *
   * 只删自己管的两个键 + 会话，**不调 `sys.localStorage.clear()`**：那个会把本机所有键一起抹掉，
   * 包括与账号无关的展示状态（如公告已读记录，见 AnnouncementReadStore）——
   * 一旦后续有别的模块往本机写东西，全清也会静默带走它们，而这处清缓存的意图只是「换账号重新来」。
   */
  static clear() {
    sys.localStorage.removeItem("roles");
    sys.localStorage.removeItem("selectedRole");
    Session.clear();
  }

  /**
   * 选中角色（本地视角：游戏内 findOnlineRole 认的是它）
   *
   * 服务端侧的「在线角色」由选角场景的 `RoleApi.select` 写入（见 ui/RoleSelector.enterGame），
   * 两者要在同一次进游戏流程里一起写，只写一边会出现「本地进的是 A、服务端记的是 B」。
   */
  static onlineRole(id: string) {
    sys.localStorage.setItem("selectedRole", id);
  }

  /**
   * 清掉本地「当前在线角色」标记（**不删角色数据**）
   *
   * 用在「角色被管理员下线」时（见 utils/net/RoleSync 的 kicked 分支）：角色存档还好好的，
   * 只是账号在服务端的在线角色被清了 —— 本地如果还认为自己在线，进游戏会一路同步失败（20007）。
   * 与 deleteRole 的区别：那个是真的删角色，这里只是让人回选角界面重新选一次。
   */
  static clearOnlineRole() {
    sys.localStorage.removeItem("selectedRole");
  }

  /** 获取当前在线角色（每次读取都会补齐旧存档缺失的字段，见 ensureRoleDefaults） */
  static findOnlineRole() {
    const selectedRole = sys.localStorage.getItem("selectedRole");
    const role = this.getRoles().find((i) => i.id === selectedRole);
    // 存储里是 JSON.parse 出来的普通对象（非 Role 实例），字段可能缺后续版本新增的部分，
    // 统一在这里补齐，避免各调用方（快捷键栏/快捷键设置/落库）各自处理
    if (role) this.ensureRoleDefaults(role);
    return role;
  }

  /**
   * 更新在线角色（**本地落盘的唯一出口**，同时也是写穿服务端的唯一触发点）
   *
   * 打怪升级/拾取/买卖/换装/吃药都会走到这里，所以服务端同步必须防抖
   * （只推最后一份数据、失败不重排，见 utils/net/RoleSync）。
   * 调用方不需要关心同步结果：本地已经落盘，游戏内读到的永远是这一份。
   */
  static updateOnlineRole(role: Role) {
    const roles = this.getRoles().map((i) => {
      if (i.id === role.id) {
        // 修订号只信「有的那一边」：内存里的 role 可能是旧存档解析出来的（没有 revision 字段），
        // 直接 Object.assign 会把已存下的基线抹掉，下一次推送就退回「无乐观锁」的旧行为
        const revision = typeof role.revision === "number" ? role.revision : i.revision;
        Object.assign(i, role);
        if (typeof revision === "number") i.revision = revision;
        else delete i.revision;
      }
      return i;
    });
    this.setRoles(roles);
    RoleSync.schedule(role);
  }

  /**
   * 旧存档补齐（后续版本新增角色字段/新增配置项时都在这里补，保证读到的角色对象字段完整）
   * 调用时机：进入游戏取得在线角色之后（见 ui/Game.start）
   * - 魔法值：mp / maxMp / mpRecoverAccumulator（默认值规则见 utils/battle/MpHelper）
   * - 血量回复：hpRecover / hpRecoverAccumulator（默认值规则见 utils/battle/HpHelper）
   * - 快捷键：按 configs/role.initialShortcutKeys 的按键码对齐（保留玩家已绑定的技能，补齐新增的按键槽；
   *   存档里多出的按键（如曾有的第 6 格）自然丢弃，减格不报错）
   * - 装备槽：槽位值一律规整成 `{ id, bound?, from? }`（#816）。老存档是裸 id 或完整快照对象，
   *   两种都收敛成对象 —— 元数据（绑定 / 溯源）必须跟着走，否则「穿上再脱下」就洗白了
   * - 背包：旧存档格子存的是物品快照对象，迁移为 { id, count }（物品数据经配置表实时解析）
   */
  static ensureRoleDefaults(role: Role) {
    MpHelper.ensureDefaults(role);
    HpHelper.ensureDefaults(role);
    // #597 起服务端建号发空对象（槽位名是客户端枚举的事）—— 按 EQUIPMENT_TYPE 枚举补齐缺失槽；
    // 槽位值规整成 { id, bound?, from? }（#816）：老存档是裸 id / 完整快照，两种都收敛成对象
    role.equipments ??= {} as Role["equipments"];
    (Object.keys(EQUIPMENT_TYPE) as Array<keyof typeof EQUIPMENT_TYPE>).forEach((key) => {
      const slot = EQUIPMENT_TYPE[key];
      // wornItemOf 认裸 id（#816 之前）、完整快照（#597 之前）与对象三种形状；
      // 认不出的直接清空（脏数据不该让「槽位显示」与「属性」各读一半）
      role.equipments[slot] = wornItemOf(role.equipments[slot]);
    });
    // 背包格子迁移：旧快照（带 type 的完整物品对象）收敛为 { id, count }；新格式原样规整；无法确定 id 的格子丢弃
    // **元数据照原样带回**（bound / from，#789）：这里是每次读档都会走的路径，丢了就等于
    // 「重登一次，身上那件绑定装备的背包版就变可交易了」（详情弹窗的「已绑定」与溯源也会一起消失）
    role.bag = (Array.isArray(role.bag) ? role.bag : []).map((row) =>
      row.map((cell) => {
        if (!cell || typeof cell !== "object") return null;
        const snapshot = cell as Goods & Partial<BagCell>;
        const id = snapshot.id;
        if (!id) return null;
        // 旧快照带 type 字段：数量按物品叠加规则取（不可叠加恒 1）；新格式直接读 count
        const count = "type" in cell ? getGoodCount(cell as Goods) : Math.max(1, snapshot.count ?? 1);
        return withBagMeta(id, count, bagMetaOf(cell as BagCell));
      }),
    );
    // 背包尺寸对齐当前配置：旧存档的行/列数可能不是 bagRow × bagCol —— 尺寸不符时整理与拖动会按存档尺寸铺回，
    // 而界面格子是按当前配置生成的，两边对不上就会出现「物品铺进界面没有的格子」（见 configs/items.normalizeBagGrid）
    role.bag = normalizeBagGrid(role.bag, bagRow, bagCol);
    const saved: NeedSetShortcutKeyConfig[] = Array.isArray(role.shortcutKeys) ? role.shortcutKeys : [];
    role.shortcutKeys = initialShortcutKeys.map((config) => {
      const exist = saved.find((i) => i.key === config.key);
      return exist ? { ...config, ...exist } : { ...config };
    });
    // 战魂等级：旧存档缺失补 0（未激活）
    if (typeof role.soulOfWar !== "number") role.soulOfWar = 0;
    if (typeof role.soulShow !== "boolean") role.soulShow = false;
    // 称号等级：旧存档缺失补 0（未激活）
    if (typeof role.title !== "number") role.title = 0;
    // 军衔阶数：旧存档缺失补 0（未授衔）
    if (typeof role.rank !== "number") role.rank = 0;
    // 时装（#377）：旧存档里的 fashionCloth 是历史遗留的数字（从没有人写过），
    // 或者干脆没有这个字段 —— 一律按「没穿」处理；不是字符串或不在配置表里也按没穿
    const fashion = role.fashionCloth as unknown;
    role.fashionCloth = typeof fashion === "string" && getFashion(fashion) ? fashion : null;
    // 时装拥有清单（#596）：归服务端书写，本地只照搬；旧档没有这一项按空清单处理
    role.fashionsOwned = Array.isArray(role.fashionsOwned)
      ? role.fashionsOwned.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    // 新手引导（#402）：读不到 guide 的存档 = 引导上线前就在的角色 → 补成「已完成」，
    // 老号不该突然被弹一脸引导；新角色的 guide 由 Role 构造函数写入第 0 步
    role.guide = normalizeGuideProgress(role.guide, guideStepCount());
  }

  /**
   * 三条成长线（称号 #248 / 战魂 #249 / 军衔 #250）共用的服务端升级流程
   *
   * **扣费与阶位推进都在服务端**（role.growthUpgrade）：客户端只报「哪条线、升到哪阶」，
   * 服务端按库里的成长链算下一阶并校验目标一致，扣绑定元宝后原子推进。
   * 本地预检（上一层的 max / 元宝不足提示）只做即时 UX —— 服务端结果才是权威，
   * 预检放行但服务端拒绝时（成长链被运营改过、后台并发改动），服务端的提示会经
   * 请求层的失败出口弹给玩家。
   *
   * 成功后以服务端返回为准刷新本地存档（bindGold / 阶位 / revision），再走既有的
   * 属性重算 → 落盘 → UI 刷新链路（这次 updateOnlineRole 的防抖推回 revision 与
   * 服务端一致，不会撞乐观锁；推的是同一份已推进的状态，幂等）。
   */
  private static async upgradeGrowthOnServer(
    role: Role,
    kind: "title" | "soul" | "rank",
    nextLevel: number,
    tipKey: string,
  ): Promise<boolean> {
    let result: GrowthUpgradeResult;
    try {
      // 修订号带上做乐观锁：后台改过这个角色时（20006）服务端拒绝升级
      result = await RoleApi.growthUpgrade(role.id, { kind, targetLevel: nextLevel, revision: role.revision });
    } catch {
      return false; // 失败提示已由请求层弹过（非 silent 请求）
    }
    const data = result.data as Record<string, unknown>;
    role.bindGold = Number(data.bindGold ?? role.bindGold);
    if (kind === "title") role.title = Number(data.title ?? nextLevel);
    else if (kind === "soul") role.soulOfWar = Number(data.soulOfWar ?? nextLevel);
    else role.rank = Number(data.rank ?? nextLevel);
    role.revision = result.revision;
    // 属性与战斗力不再本地重算（#541 服务端权威）：升级接口已成功 = 服务端在线，
    // 权威值正由 roleUpdate 帧在路上（服务端已重算落库，轮询下一个节拍就推）
    this.updateOnlineRole(role);
    this.updateUi(role);
    GameUiHelper.createTip(tipKey, { level: result.gainedLevel, label: result.gainedLabel });
    return true;
  }

  /**
   * 战魂升级（当前在线角色）：扣费与推进在服务端
   *
   * 「下一阶」按管理端配的成长链取（`nextSoulUpgrade`），不是 `soulOfWar + 1` ——
   * 运营可拖动排序，阶号与链序解耦。预检只做即时 UX，服务端结果才是权威。
   * @returns 是否升级成功（失败原因已用浮动提示告知）
   */
  static async upgradeSoul(): Promise<boolean> {
    const role = this.findOnlineRole();
    if (!role) return false;
    const step = nextSoulUpgrade(role.soulOfWar);
    if (step.kind === "maxed") {
      GameUiHelper.createTip("soul_max_tip");
      return false;
    }
    if (step.kind === "closed") {
      GameUiHelper.createTip("soul_growth_closed_tip");
      return false;
    }
    if (step.kind === "locked") {
      GameUiHelper.createTip("soul_chain_locked_tip");
      return false;
    }
    const next = step.config;
    if (role.bindGold < next.bindGold) {
      GameUiHelper.createTip("soul_bind_gold_tip", { need: next.bindGold });
      return false;
    }
    return this.upgradeGrowthOnServer(role, "soul", next.level, "soul_upgrade_tip");
  }

  /**
   * 称号升级/解锁（当前在线角色）：扣费与推进在服务端
   *
   * 「下一级」按管理端配的成长链取（`nextTitleUpgrade`）—— 称号链**只含运营放出的等级**
   * （`acquire_channel = upgrade`），所以链上可能跳号；用 `title + 1` 会指向一个没开放的等级，
   * 服务端会以「目标阶位不合法」拒绝。0 阶升链首即解锁。
   * @returns 是否升级成功（失败原因已用浮动提示告知）
   */
  static async upgradeTitle(): Promise<boolean> {
    const role = this.findOnlineRole();
    if (!role) return false;
    const step = nextTitleUpgrade(role.title);
    if (step.kind === "maxed") {
      GameUiHelper.createTip("title_max_tip");
      return false;
    }
    if (step.kind === "closed") {
      GameUiHelper.createTip("title_growth_closed_tip");
      return false;
    }
    if (step.kind === "locked") {
      GameUiHelper.createTip("title_chain_locked_tip");
      return false;
    }
    const next = step.config;
    if (role.bindGold < next.bindGold) {
      GameUiHelper.createTip("title_bind_gold_tip", { need: next.bindGold });
      return false;
    }
    return this.upgradeGrowthOnServer(role, "title", next.level, "title_upgrade_tip");
  }

  /**
   * 军衔晋升/授衔（当前在线角色）：扣费与推进在服务端
   *
   * 「下一阶」也走统一的链口径（`nextRankUpgrade`）：军衔没有 `upgrade_order`，
   * 100 阶天然按阶就是链，结果与 `rank + 1` 等价 —— 三条线共用一套写法，少一条特例分支。
   * 军衔的外显就是头顶那行红字，随 updateUi → RoleUIManager.updateRoleData → RoleDisplay.updateHead 自动刷新，
   * 不需要像称号那样另外调一次外显刷新
   * @returns 是否晋升成功（失败原因已用浮动提示告知）
   */
  static async upgradeRank(): Promise<boolean> {
    const role = this.findOnlineRole();
    if (!role) return false;
    const step = nextRankUpgrade(role.rank);
    if (step.kind === "maxed") {
      GameUiHelper.createTip("rank_max_tip");
      return false;
    }
    if (step.kind === "closed") {
      GameUiHelper.createTip("rank_growth_closed_tip");
      return false;
    }
    if (step.kind === "locked") {
      GameUiHelper.createTip("rank_chain_locked_tip");
      return false;
    }
    const next = step.config;
    if (role.bindGold < next.bindGold) {
      GameUiHelper.createTip("rank_bind_gold_tip", { need: next.bindGold });
      return false;
    }
    return this.upgradeGrowthOnServer(role, "rank", next.level, "rank_upgrade_tip");
  }

  /**
   * 服务端击杀奖励落账（#316：经验与升级判定都在服务端，这里只把入账后的状态接回来演）
   *
   * 经验 / 等级 / 修订号直接以 reward 为准（服务端已落账，带回来的就是入账后的值，
   * 本地不再自己算「够不够升级」——那正是收权要拿掉的决定）；
   * 升级表现（属性重算 / 补满血蓝 / 特效）沿用本地习惯，只对 leveledUp 做。
   * @returns 本次入账的经验（调用方据此决定要不要飘经验字）
   */
  static applyKillReward(reward: CombatKillReward): number {
    const role = this.findOnlineRole();
    if (!role) return 0;
    role.exp = reward.expNow;
    role.level = reward.level;
    role.revision = reward.revision;
    if (reward.leveledUp) {
      // 属性与战斗力不本地重算（#541 服务端权威）：服务端升级时已重算落库并补满血蓝
      // （applyKillExp 的 refillOnLevelUp），权威值由 roleUpdate 帧带回；这里先把血蓝
      // 顶到当前上限做即时演出，帧到达时以服务端值为准
      role.hp = role.maxHp;
      role.mp = role.maxMp;
      // 播放升级特效（#594：服务端可关 —— 关了不建节点）
      const upgradeEffect = GameUiHelper.createUpgradeEffect();
      if (upgradeEffect) LayerManager.addToUILayer(upgradeEffect);
      // 升级音效（#683）：与特效同一处触发 —— `leveledUp` 是服务端判的，客户端不自己算
      void SoundManager.play("level_up");
    }
    // 保存并刷新（revision 已与服务端对齐，下一次落盘不会撞乐观锁）
    this.updateOnlineRole(role);
    this.updateUi(role);
    return reward.exp;
  }

  /**
   * 队友击杀分到的那一份经验（#399：服务端直接入账，`expGain` 帧带回入账后的状态）
   *
   * 与 `applyKillReward` 的差别只有一处：**这条路径不碰血量** —— 队友打怪不是我在挨打，
   * 顺手把 hp 补成 maxHp（或按升级重算）会让客户端血量与服务端悄悄分开。
   * 升级时属性照样重算（等级变了攻防跟着曲线走），但**不补满血蓝**：那是击杀者侧的惯例，
   * 我这里只是「经验条涨了一点」，真正的血量由下一次受击 / 存档同步带回。
   *
   * `revision` 必须照搬：这份经验在服务端已经推进了修订号，本地基线不更新的话，
   * 下一次防抖存档必撞乐观锁（20006）—— 与 `applyPickResult` 同一条纪律。
   *
   * @returns 本次入账的经验（调用方据此飘字）
   */
  static applyPartyExpGain(gain: { exp: number; level: number; expNow: number; revision: number; leveledUp: boolean }): number {
    const role = this.findOnlineRole();
    if (!role) return 0;
    role.exp = gain.expNow;
    role.level = gain.level;
    role.revision = gain.revision;
    if (gain.leveledUp) {
      // 属性不本地重算（#541 服务端权威）：权威值由 roleUpdate 帧带回，也不补满血蓝（见方法注释）
      const upgradeEffect = GameUiHelper.createUpgradeEffect();
      if (upgradeEffect) LayerManager.addToUILayer(upgradeEffect);
      // 升级音效（#683）：队友杀怪我升级，与自己杀怪同一个声音（玩家视角都是「我升级了」）
      void SoundManager.play("level_up");
    }
    this.updateOnlineRole(role);
    this.updateUi(role);
    return gain.exp;
  }

  /**
   * 服务端普攻受击落账（#323：玩家血量的权威在服务端，hit 帧带回的就是落账后的值）
   *
   * 血量 / 资源上限照搬服务端给的（本地不再自己扣）；revision **不变**——
   * 受击不推进修订号（否则战斗期间的防抖存档会频繁撞乐观锁），落库由服务端负责。
   */
  static applyMonsterHit(hit: { hp: number; maxHp: number }): void {
    const role = this.findOnlineRole();
    if (!role) return;
    role.hp = Math.max(0, Math.floor(hit.hp));
    if (hit.maxHp > 0) role.maxHp = hit.maxHp;
    this.updateOnlineRole(role);
    this.updateUi(role);
  }

  /**
   * 服务端角色权威快照落账（#541：roleUpdate 帧带回的服务端重算值）
   *
   * 战斗力 / 八项属性 / 货币 / 等级血蓝**照搬不算**——这是「客户端只演」在角色数值上的落点：
   * 换装、任务/成就/邮件发奖、商城、成长线升级、后台改动、升级，全部由服务端重算后
   * 经这一帧汇合到本地。区间属性缺省（等级不在成长曲线的边角存档）时不动对应字段。
   * 成长线阶位（称号 / 战魂 / 军衔）自 #551 起也走这一帧 —— 后台改完不重进就生效。
   * 只刷新显示、**不触发存档**：帧的内容就是服务端现状，推回去是白推还多占一个防抖节拍。
   */
  static applyServerRoleUpdate(update: RoleAuthorityUpdate): void {
    const role = this.findOnlineRole();
    if (!role) return;
    // 迟到帧守卫（#732）：帧由「行变了」触发，但 bagOp / 称号等 HTTP 应答可能先一步改了本地
    // （revision 更大）；随后才到的旧帧整帧丢弃 —— 否则战斗力 / 货币会被拉回旧值再弹回来（显示抖动）。
    // revision 相同的帧照常应用（幂等快照）；任一侧没有 revision 不设防（老服务端兼容）
    if (typeof update.revision === "number" && typeof role.revision === "number" && update.revision < role.revision) return;
    // 金钱变化音（#683）：这一帧是所有货币变化的汇合点（任务发奖 / 商城 / 回收 / 后台改动），
    // 所以只在**真的变了**的时候响 —— 每帧都响会盖过其它音效（这条帧每几秒就来一次）
    const moneyChanged = update.gold !== role.gold || update.bindGold !== role.bindGold || update.silver !== role.silver;
    role.level = update.level;
    role.exp = Math.max(0, Math.floor(update.exp));
    role.combat = update.combat;
    role.gold = update.gold;
    role.bindGold = update.bindGold;
    role.silver = update.silver;
    role.hp = Math.max(0, Math.floor(update.hp));
    role.mp = Math.max(0, Math.floor(update.mp));
    if (update.maxHp !== undefined) role.maxHp = update.maxHp;
    if (update.hpRecover !== undefined) role.hpRecover = update.hpRecover;
    if (update.maxMp !== undefined) role.maxMp = update.maxMp;
    if (update.physicalAttack) role.physicalAttack = [update.physicalAttack[0], update.physicalAttack[1]];
    if (update.magicAttack) role.magicAttack = [update.magicAttack[0], update.magicAttack[1]];
    if (update.taoistAttack) role.taoistAttack = [update.taoistAttack[0], update.taoistAttack[1]];
    if (update.physicalDefense) role.physicalDefense = [update.physicalDefense[0], update.physicalDefense[1]];
    if (update.magicDefense) role.magicDefense = [update.magicDefense[0], update.magicDefense[1]];
    if (update.taoistDefense) role.taoistDefense = [update.taoistDefense[0], update.taoistDefense[1]];
    // 成长线阶位（#551）：运营在后台改了称号 / 战魂 / 军衔，不重进也要看得见。
    // 三者的外显方式不同，所以先记下「哪一项真的变了」：
    // - 军衔 = 头顶那行红字，`updateUi` → `updateRoleData` → `updateHead` 会带出来；
    // - 称号 / 战魂 = 按角色数据**重建动画**，重建一次就闪一下，只在变了时才调
    const titleChanged = update.title !== undefined && update.title !== role.title;
    const soulChanged = update.soulOfWar !== undefined && update.soulOfWar !== role.soulOfWar;
    if (update.title !== undefined) role.title = update.title;
    if (update.soulOfWar !== undefined) role.soulOfWar = update.soulOfWar;
    if (update.rank !== undefined) role.rank = update.rank;
    // 体验状态（#596 换设备云同步）：归客户端书写、服务端存证 —— 另一台设备改了快捷键 /
    // 后台重置了引导，帧带回就进本地档（下次读档 / 界面重建时生效；进行中的引导流程不回头）
    if (Array.isArray(update.shortcutKeys)) role.shortcutKeys = update.shortcutKeys as Role["shortcutKeys"];
    if (update.guide && typeof update.guide === "object") role.guide = update.guide as Role["guide"];
    if (typeof update.soulShow === "boolean") role.soulShow = update.soulShow;
    // 时装（#596）：穿着态变了要换外观（另一台设备买了/穿了，帧带回就换）；清单只进本地档。
    // 走 applyFashionChange 与本地穿脱同一条收尾：不重算数值，只刷地图主角 / 内观 / 预载。
    const fashionChanged = update.fashionCloth !== undefined && update.fashionCloth !== role.fashionCloth;
    if (update.fashionCloth !== undefined) role.fashionCloth = update.fashionCloth;
    if (Array.isArray(update.fashionsOwned)) role.fashionsOwned = update.fashionsOwned;
    role.hp = Math.min(role.hp, role.maxHp);
    role.revision = update.revision;
    this.updateUi(role);
    // 金钱变化音放在刷 UI 之后：先让数字变，再出声（顺序反了会有「听到声音但数字还没动」的一帧）
    if (moneyChanged) void SoundManager.play("money_change");
    // 角色信息弹窗开着的话，属性列表与战斗力一起跟上（升级/换装的面板刷新缺口在这补上）
    RoleUIManager.refreshRoleAttributes();
    if (titleChanged) RoleUIManager.updateTitleShow();
    if (soulChanged) RoleUIManager.updateSoulShow();
    if (fashionChanged) this.applyFashionChange(role);
  }

  /**
   * 服务端拾取落账（#325：入包的权威在服务端，picked 帧带回的就是落账后的格子）
   *
   * 把服务端实际写入的格子照搬进本地背包（叠加进已有堆 = 该格更新后的形状，
   * 新占格 = 原样落位），revision 一并照搬 —— 入包推进了修订号，本地基线不更新的话
   * 下一次防抖存档就会撞乐观锁（与 applyKillReward 同一纪律）。
   * 坐标对不上本地网格（两端配置漂了的边角）就丢掉那一格，等全量同步兜底。
   *
   * **绑定与溯源照搬**（#789）：服务端判定「这一件是否绑定角色」并把装备的来源
   * （谁 / 什么怪 / 什么时候）写在格子上，客户端只负责显示 —— 本地不重算、不补默认值
   * （补 false 就等于替服务端决定「可交易」，那是交易系统开工时才敢做的事）。
   */
  static applyPickResult(
    placed: Array<{ row: number; col: number; id: string; count: number; bound?: boolean; from?: BagOrigin }>,
    revision: number,
  ): void {
    const role = this.findOnlineRole();
    if (!role) return;
    for (const cell of placed) {
      const line = role.bag[cell.row];
      if (!line || cell.col < 0 || cell.col >= line.length) continue;
      line[cell.col] = withBagMeta(cell.id, cell.count, { bound: cell.bound, from: this.sanitizeOrigin(cell.from) });
    }
    role.revision = revision;
    this.updateOnlineRole(role);
    this.updateUi(role);
    // 背包弹窗开着时实时跟上（updateUi 只刷信息栏/底栏/血条，不含背包）；弹窗没开时是 no-op
    if (placed.length) RoleUIManager.refreshBag();
  }

  /**
   * 溯源字段的本地清洗（**只做「脏数据不该上屏」这一层，不改语义**）
   *
   * 服务端写入时已经截断过一遍（`BAG_ORIGIN_TEXT_MAX`），这里再截一次是因为存档可能
   * 来自更早的版本或被外部工具写过 —— 详情弹窗的标签宽度固定，超长字符串会被 CLAMP 截断，
   * 与其让 Label 截在半个字上，不如按同一个上限先截好。
   * 时间戳只认正整数（0 / 负数 / NaN 一律当「没记录」，客户端不去编一个时间）。
   */
  private static sanitizeOrigin(from?: BagOrigin): BagOrigin | undefined {
    if (!from) return undefined;
    const origin: BagOrigin = {};
    if (from.role) origin.role = from.role.slice(0, BAG_ORIGIN_TEXT_MAX);
    if (from.monster) origin.monster = from.monster.slice(0, BAG_ORIGIN_TEXT_MAX);
    if (typeof from.at === "number" && Number.isFinite(from.at) && from.at > 0) origin.at = from.at;
    return origin.role || origin.monster || origin.at ? origin : undefined;
  }

  //#region 背包物品使用

  /**
   * 使用背包物品（统一入口：背包左键、快捷键等一切「使用物品」都走这里）
   * 按物品大类分发，新增物品类型时在此补一条分支并实现对应的 useXxx：
   * 装备 → 穿戴、药品 → 服用、货币道具 → 入账（#785）、升级卷轴 → 硬性 +1 级（#787）、
   * 材料/其他 → 暂未开放（后续合成、任务用途在此扩展）
   * @param row 背包行
   * @param col 背包列
   * @returns 是否成功使用
   */
  static async useGood(row: number, col: number): Promise<boolean> {
    const role = this.findOnlineRole();
    const cell = role?.bag[row]?.[col];
    if (!role || !cell) return false;
    const good = getItem(cell.id);
    if (!good) return false;
    if (isEquipment(good)) return await this.equipFromBag(row, col);
    if (isDrug(good)) return await this.useDrug(row, col);
    if (isMoneyItem(good)) return await this.useMoneyItem(row, col);
    if (isLevelScroll(good)) return await this.useLevelScroll(row, col);
    GameUiHelper.createTip("good_unsupported_tip");
    return false;
  }

  /**
   * 背包操作的统一出口（#556）：发出 `role.bagOp` 并把服务端那份结果抄回本地
   *
   * `bag` / `equipments` 从这一版起是**服务端独占字段**（见服务端 `role-authority.ts`）：
   * 本地改完会被下一次存档回填成库里的值 —— 所以五个背包动作都必须经过这里，
   * 否则表现就是「按下去没反应」（本地动了，推上去又被打回来）。
   *
   * 抄回来的是**整份**：背包、装备槽位、重算后的战斗属性、当前血量上限（服务端夹过）、修订号。
   * 只抄自己要改的那几格是不行的 —— 穿戴会换掉两处（格子 + 槽位），整理会动一整片。
   *
   * 不在这里刷界面：调用方各自的收尾不同（换装要刷内观与槽位、整理只刷网格），
   * 由它们自己接 `applyEquipmentChange` / `refreshBag`。
   *
   * @returns 服务端结果；失败（含乐观锁、被踢、校验拒绝）返回 null，提示已由请求层弹过
   */
  private static async runBagOp(role: Role, body: Omit<BagOp, "revision">): Promise<BagOpResult | null> {
    let result: BagOpResult;
    try {
      // 修订号带上做乐观锁：后台改过这个角色时（20006）服务端拒绝这次操作
      result = await RoleApi.bagOp(role.id, { ...body, revision: role.revision });
    } catch {
      return null; // 失败提示已由请求层弹过（非 silent 请求）
    }
    const data = result.data as Record<string, unknown>;
    if (Array.isArray(data.bag)) role.bag = data.bag as typeof role.bag;
    if (data.equipments && typeof data.equipments === "object" && !Array.isArray(data.equipments)) {
      role.equipments = data.equipments as typeof role.equipments;
    }
    // 穿脱会改属性，服务端当场重算过 —— 这里照搬，不必等下一个 roleUpdate 帧
    if (typeof data.combat === "number") role.combat = data.combat;
    if (typeof data.maxHp === "number") role.maxHp = data.maxHp;
    if (typeof data.maxMp === "number") role.maxMp = data.maxMp;
    if (typeof data.hpRecover === "number") role.hpRecover = data.hpRecover;
    // 血量当前值服务端会夹到新上限以内（脱掉加血装备时尤其需要），照搬比本地再判一次稳
    if (typeof data.hp === "number") role.hp = data.hp;
    if (typeof data.mp === "number") role.mp = data.mp;
    role.revision = result.revision;
    return result;
  }

  /** 背包内容转成接口要的**稀疏格子**（整理 / 搬运提交用：空格不报） */
  private static sparseBagCells(bag: BagCell[][]): Array<{ row: number; col: number; id: string; count: number }> {
    const cells: Array<{ row: number; col: number; id: string; count: number }> = [];
    bag.forEach((line, row) =>
      line.forEach((cell, col) => {
        if (cell) cells.push({ row, col, id: cell.id, count: Math.max(1, cell.count) });
      }),
    );
    return cells;
  }

  /**
   * 从背包穿戴装备（当前在线角色；穿戴由服务端判定与落库，#556）
   *
   * 本地仍留一道预检（格子解析得出装备、等级/性别/职业够）—— 它只为**即时提示**，
   * 服务端会再按库里的等级与真实的背包内容判一次：改包绕过预检也穿不上。
   * 旧装备由服务端放回刚腾出的那一格（格数守恒），这里不再自己算。
   *
   * @param row 背包行
   * @param col 背包列
   * @returns 是否穿戴成功（失败原因已用浮动提示告知）
   */
  static async equipFromBag(row: number, col: number): Promise<boolean> {
    const role = this.findOnlineRole();
    const cell = role?.bag[row]?.[col];
    if (!role || !cell) return false;
    // 格子只存物品 key，数据实时解析
    const good = getItem(cell.id);
    if (!good) return false;
    if (!isEquipment(good)) {
      GameUiHelper.createTip("equip_unsupported_tip");
      return false;
    }
    const reason = GameHelper.getEquipmentRejectReason(good);
    if (reason) {
      GameUiHelper.createTip(reason.key, reason.params);
      return false;
    }
    const result = await this.runBagOp(role, { action: "equip", row, col });
    if (!result) return false;
    this.applyEquipmentChange(role, (result.slot as EQUIPMENT_TYPE | null) ?? good.slot);
    // 穿戴成功音（#683）：服务端接受之后才响 —— 放在 `if (!result) return false` 后面，
    // 「点了但被拒」不该有成功音
    void SoundManager.play("equip_wear");
    return true;
  }

  /**
   * 脱下装备放入背包（放进第一个空格；背包已满时提示并放弃）
   *
   * 落点由服务端决定（第一个空格），本地不再自己找 —— 两边各找一套只会有一天对不上。
   * @param slot 装备槽位
   * @returns 是否脱下成功（失败原因已用浮动提示告知）
   */
  static async unequipToBag(slot: EQUIPMENT_TYPE): Promise<boolean> {
    const role = this.findOnlineRole();
    if (!role || !wornIdOf(role.equipments[slot])) return false;
    const result = await this.runBagOp(role, { action: "unequip", slot });
    if (!result) return false;
    this.applyEquipmentChange(role, slot);
    return true;
  }

  //#region 时装（#377 穿脱 / #596 拥有清单与购买：只换外观，不换数值）

  /**
   * 是否拥有某件时装（#596：清单归服务端，本地只读 `role.fashionsOwned`）
   */
  static ownsFashion(fashionId: string): boolean {
    const owned = this.findOnlineRole()?.fashionsOwned;
    return owned ? owned.indexOf(fashionId) !== -1 : false;
  }

  /**
   * 购买时装（#596：扣费与拥有清单都在服务端）
   *
   * 服务端校验渠道（upgrade = 可购买）与价格（fashions 表，管理端改价即时生效），
   * 扣绑定元宝后把清单带回 —— 本地照搬（清单是服务端独占字段，本地造的无效）。
   * 失败（渠道没开 / 钱不够 / 已拥有）走请求层的失败出口提示，这里返回 false。
   *
   * @returns 是否购买成功
   */
  static async buyFashion(fashionId: string): Promise<boolean> {
    const role = this.findOnlineRole();
    if (!role) return false;
    const revision = typeof role.revision === "number" ? role.revision : undefined;
    let result: Awaited<ReturnType<typeof RoleApi.fashionBuy>>;
    try {
      result = await RoleApi.fashionBuy(role.id, { fashionId, revision });
    } catch {
      return false; // 失败提示已由请求层弹过（非 silent 请求）
    }
    role.fashionsOwned = result.owned;
    role.bindGold = result.bindGold;
    role.revision = result.revision;
    this.updateOnlineRole(role);
    this.updateUi(role);
    return true;
  }

  /**
   * 穿上时装（#596：穿着态归服务端，「拥有才给穿」在服务端校验）
   *
   * 服务端成功才改本地穿着态（fashionCloth 照搬返回值）；穿时装不重算任何数值
   * （只换外观，与 applyFashionChange 的口径一致）。
   *
   * @returns 是否穿上
   */
  static async wearFashion(fashionId: string): Promise<boolean> {
    const role = this.findOnlineRole();
    const fashion = getFashion(fashionId);
    if (!role || !fashion) return false;
    const revision = typeof role.revision === "number" ? role.revision : undefined;
    let result: Awaited<ReturnType<typeof RoleApi.fashionWear>>;
    try {
      result = await RoleApi.fashionWear(role.id, { fashionId, revision });
    } catch {
      return false; // 失败提示已由请求层弹过（未拥有 / 乐观锁冲突等）
    }
    role.fashionCloth = result.fashionCloth;
    role.fashionsOwned = result.owned;
    role.revision = result.revision;
    this.applyFashionChange(role);
    return true;
  }

  /**
   * 脱下当前时装（#596：与服务端 fashion-wear 同一条路；没穿时服务端幂等返回成功）
   * @returns 是否成功（服务端拒绝 = false，本地不动）
   */
  static async unwearFashion(): Promise<boolean> {
    const role = this.findOnlineRole();
    if (!role) return false;
    const revision = typeof role.revision === "number" ? role.revision : undefined;
    let result: Awaited<ReturnType<typeof RoleApi.fashionWear>>;
    try {
      result = await RoleApi.fashionWear(role.id, { fashionId: null, revision });
    } catch {
      return false; // 失败提示已由请求层弹过
    }
    role.fashionCloth = result.fashionCloth;
    role.fashionsOwned = result.owned;
    role.revision = result.revision;
    this.applyFashionChange(role);
    return true;
  }

  /**
   * 时装变更后的统一收尾（与时装无关的数值一概不动）
   *
   * 外观有三处要看：地图上的主角（RoleAppearance）、角色信息弹窗的内观（RoleInShowView）、
   * 下次进图的预载（PreloadManager）。前两处走 RoleUIManager，第三处读的就是 role 本身。
   * **不重算属性、不改血量** —— 时装只换外观，数值仍由装备决定（这是与「换衣服」最大的区别）。
   */
  private static applyFashionChange(role: Role) {
    this.updateOnlineRole(role);
    this.updateUi(role);
    RoleUIManager.updateRoleOutShow(role);
    RoleUIManager.updateEquipmentDialog(EQUIPMENT_TYPE.CLOTH);
  }

  /** 当前穿戴的时装（没穿/配置里没有这件 → null） */
  static getWornFashion() {
    return getFashion(this.findOnlineRole()?.fashionCloth);
  }

  /** 衣柜清单（表里全部时装，界面按这个渲染） */
  static getFashionWardrobe() {
    return fashionData;
  }

  //#endregion

  /**
   * 取身上某槽位穿戴的装备（未穿戴/解析不出返回 null）
   * 背包悬停详情「按住 Ctrl 对比」的数据源（见 GameUiHelper.createGood 的 compareWornProvider）
   * @param slot 装备槽位
   */
  static getWornEquipment(slot: EQUIPMENT_TYPE): Equipment | null {
    return getEquipment(wornIdOf(this.findOnlineRole()?.equipments[slot]));
  }

  /**
   * 背包里某槽位「更好的装备」在哪一格（角色信息弹窗提示角标的数据源）
   * 判定口径见 configs/items.findBagEquipmentUpgrade：同槽位 + 可穿（等级/性别/职业）+
   * 战斗力贡献严格大于当前穿戴件（空槽时任何可穿件都算提升）
   * @param slot 装备槽位
   * @returns 命中格坐标；没有更好的装备（或无角色）返回 null
   */
  static findBetterEquipmentInBag(slot: EQUIPMENT_TYPE): { row: number; col: number } | null {
    const role = this.findOnlineRole();
    if (!role) return null;
    const candidate = findBagEquipmentUpgrade(
      role.bag,
      slot,
      (equipment) => GameHelper.checkRoleCanUseEquipment(equipment),
      getEquipment(wornIdOf(role.equipments[slot])),
    );
    return candidate ? { row: candidate.row, col: candidate.col } : null;
  }

  /**
   * 一键换上背包里该槽位更好的装备（角色信息弹窗提示角标的点击入口）
   * 复用 equipFromBag：校验/换装/旧装备回原格/属性重算与各处刷新都是同一条路
   * @param slot 装备槽位
   * @returns 是否换上成功（没有更好的装备时返回 false，不打扰）
   */
  static async equipBetterFromBag(slot: EQUIPMENT_TYPE): Promise<boolean> {
    const better = this.findBetterEquipmentInBag(slot);
    if (!better) return false;
    return await this.equipFromBag(better.row, better.col);
  }

  /**
   * 装备变更后的统一收尾：血量修正 → 落盘 → 刷新各视图
   * 装备影响 maxHp，脱下加血装备时当前血量要跟随上限下调，避免血量超过上限
   *
   * 属性与战斗力**不在客户端算**（#541 服务端权威，本游戏无离线形态）：
   * 落盘后服务端权威重算，roleUpdate 帧把结果带回来（applyServerRoleUpdate 统一落账）
   */
  private static applyEquipmentChange(role: Role, slot: EQUIPMENT_TYPE) {
    role.hp = Math.min(role.hp, role.maxHp);
    this.updateOnlineRole(role);
    this.updateUi(role);
    RoleUIManager.updateRoleOutShow(role);
    RoleUIManager.updateEquipmentDialog(slot);
    RoleUIManager.refreshBag();
  }

  //#endregion

  //#region 背包丢弃

  /**
   * 取背包格子的丢弃预览（物品名 + 整格数量），供「两步确认」的第一次点击报数
   * 空格子 / 越界返回 null（调用方据此提示「这里没有可丢弃的物品」）；
   * id 已不在配置表时用 id 兜底当名字（丢弃本来就允许清理认不出的杂物）
   */
  static getBagDiscardPreview(row: number, col: number): { label: string; count: number } | null {
    const role = this.findOnlineRole();
    const cell = role?.bag[row]?.[col];
    if (!cell) return null;
    return { label: getItem(cell.id)?.label ?? cell.id, count: Math.max(1, cell.count) };
  }

  /**
   * 丢弃背包指定格子里的**整格**物品（当前在线角色，**不可恢复**）
   *
   * 与「一键回收」的分工：回收只吃装备、且折算成绑定元宝；丢弃对任何物品（装备/药品/材料）都生效、**不返还任何东西**，
   * 用来清理玩家不想要的东西。两者都会跳过身上穿着的装备 —— 槽位里的装备不在背包里，天然不受影响。
   *
   * 背包格子存的是 id + 数量，丢弃就是把该格置空：**可叠加物品整格一起丢**（不做「丢几个」的数量选择，
   * 要支持它得先引入数量输入控件，别在这里悄悄改语义，见 configs/texts.bag_discard_confirm_tip 的文案口径）。
   *
   * 置空这一步由服务端做（#556）：客户端只报「丢哪一格」，服务端按库里的那一格自己清 ——
   * 客户端报「结果」等于把销毁物品的权力交出去。丢弃不动属性/战力，故无需 updateUi
   * @param row 背包行
   * @param col 背包列
   * @returns 是否丢弃成功（空格子或越界时返回 false 并提示）
   */
  static async discardBagGood(row: number, col: number): Promise<boolean> {
    const role = this.findOnlineRole();
    const cell = role?.bag[row]?.[col];
    if (!role || !cell) {
      GameUiHelper.createTip("bag_discard_empty_tip");
      return false;
    }
    const label = getItem(cell.id)?.label ?? cell.id;
    const count = Math.max(1, cell.count);
    if (!(await this.runBagOp(role, { action: "discard", row, col }))) return false;
    // 服务端已清格：刷新显示（顺带把 updateOnlineRole 的防抖存档排上）
    this.updateOnlineRole(role);
    RoleUIManager.refreshBag();
    GameUiHelper.createTip("bag_discard_done_tip", { name: label, count });
    return true;
  }

  //#endregion

  //#region 背包整理

  /**
   * 一键整理背包（当前在线角色）
   *
   * 排序算法仍是纯函数 `configs/items.tidyBagGrid`（合并同类可叠加物 → 按等级/部位排序 →
   * **从第一个格子起铺满**）—— 它留在客户端是因为它是**展示规则**，而且单测（`test-bag-tidy`）
   * 跑的就是这一份。服务端不重算排布，只验**守恒**（同 id 总件数不变，见 `role.bagOp` 的 `tidy`）。
   *
   * 本地先算一遍的意义是「没变动就不发请求」：背包本来就整齐时点整理不该占一次网络往返。
   * @returns 是否有变动（无角色/背包为空/整理前后一致/请求失败时返回 false）
   */
  static async tidyBag(): Promise<boolean> {
    const role = this.findOnlineRole();
    if (!role) return false;
    if (this.bagIsEmpty(role.bag)) return false;
    const before = this.bagSignature(role.bag);
    const arranged = tidyBagGrid(role.bag);
    if (this.bagSignature(arranged) === before) return false;
    if (!(await this.runBagOp(role, { action: "tidy", cells: this.sparseBagCells(arranged) }))) return false;
    // 服务端那份才是权威排布（万一它按别的规则合并过），照它的结果刷新
    this.updateOnlineRole(role);
    RoleUIManager.refreshBag();
    GameUiHelper.createTip("bag_tidy_tip");
    // 整理成功音（#683）：与上面那句提示同一处 —— 只有「服务端接受 + 界面刷完」才算成功
    void SoundManager.play("bag_resort");
    return true;
  }

  /** 背包是否一件东西都没有（空背包没什么可整理的） */
  private static bagIsEmpty(bag: BagCell[][]): boolean {
    return !bag.some((row) => row.some((cell) => !!cell));
  }

  /**
   * 背包内容指纹（整理前后比对用）：从第一格起逐格拼接，**空格也占一位**（`·`）
   *
   * 空格必须计入：否则「物品顺序没变、只是散着放」的背包（例：把第 3 格的药拖到第 8 格）指纹
   * 与整理完之后的一模一样，`tidyBag` 会判定「已经很整齐」直接返回 —— 玩家点整理却看不到东西
   * 回到第一个格子，这就是「整理要从第一个格子重新排列」这条反馈的来源。
   */
  private static bagSignature(bag: BagCell[][]): string {
    let signature = "";
    bag.forEach((row) =>
      row.forEach((cell) => {
        signature += cell ? `${cell.id}x${cell.count},` : "·";
      }),
    );
    return signature;
  }

  //#endregion

  //#region 背包格子搬运（拖动改变物品所在格子）

  /**
   * 拖动把背包一格里的物品搬到另一格（当前在线角色）
   *
   * 落点规则全在纯函数 `configs/items.moveBagCellGrid`：空格 = 移动、同种可叠加 = 合并（超过单格上限的留在原格）、
   * 其余 = 交换。本地算完之后把**整份排布**交给服务端（`role.bagOp` 的 `move`），
   * 由它验守恒（形状不变 + 同 id 总件数不变）—— 位置是展示规则，件数是钱，只有后者必须服务端说了算。
   *
   * 与「整理」同一口径：**不弹提示** —— 拖动的反馈就是物品的位置/数量变化本身，
   * 每次落子都飘一条字反而吵；无效拖动（拖空格、拖回原格）静默返回 false
   *
   * 只有「真的换成了新排布」才响整理音（#685，用户口径：位置一变就该有反馈）：
   * 请求失败那条分支已经先把界面还原了，那里不响。
   * @returns 是否有变动（起点为空、起终点相同、越界、无角色、请求失败时返回 false）
   */
  static async moveBagGood(fromRow: number, fromCol: number, toRow: number, toCol: number): Promise<boolean> {
    const role = this.findOnlineRole();
    if (!role) return false;
    const result = moveBagCellGrid(role.bag, { row: fromRow, col: fromCol }, { row: toRow, col: toCol });
    if (!result.moved) return false;
    // 拖动是高频操作：本地先摆好再发请求，界面在往返期间就已经是新位置；
    // 服务端拒绝（乐观锁 / 守恒不过）时把本地那份还原，别留一个「看着动了其实没动」的网格
    const previous = role.bag;
    role.bag = result.bag;
    RoleUIManager.refreshBag();
    if (!(await this.runBagOp(role, { action: "move", cells: this.sparseBagCells(result.bag) }))) {
      role.bag = previous;
      RoleUIManager.refreshBag();
      return false;
    }
    this.updateOnlineRole(role);
    RoleUIManager.refreshBag();
    // 背包位置变化音（#685）：与「一键整理」同一个 key —— 玩家听到的是「东西挪好了」。
    // 放在请求成功之后：上面失败分支已经把本地排布还原，那里不该响
    void SoundManager.play("bag_resort");
    return true;
  }

  //#endregion

  //#region 背包回收

  /**
   * 背包里可回收装备的结算预览（件数 + 可得绑定元宝）
   * 回收不可撤销，所以按钮先要一份数给玩家看清楚（见 BagDialog 的二次确认）
   * 判定与计价都在配置层纯函数里（configs/items.summarizeBagRecycle），这里只取当前角色
   */
  static getBagRecycleSummary(): { count: number; totalPrice: number } {
    const role = this.findOnlineRole();
    if (!role) return { count: 0, totalPrice: 0 };
    return summarizeBagRecycle(role.bag);
  }

  /**
   * 一键回收背包内的全部装备（当前在线角色）：按件折算**绑定元宝**入账
   *
   * 只回收**背包里**的装备 —— 身上穿着的槽位不受影响；药品/材料/解析不出配置的 id 一概不动。
   *
   * **结算在服务端**（#397）：本地只负责「把要卖的东西列出来」（goodId + 件数），
   * 价格与扣物都由 `role.sellGoods` 说了算 —— 客户端报的价一概不看，改存档也改不出钱。
   * 服务端返回的 bag / bindGold / revision 直接覆盖本地（与商城购买同一套手法，
   * 见 buyMallGood）：本地不再自己算「扣掉哪几格」，两边各算一套必然有一天对不上。
   *
   * 计价口径见共享快照的出售价表（装备 = configs/growth 的回收价曲线 × 前后缀倍率），
   * 与按钮上「可得多少」的预览同一个来源（configs/items.summarizeBagRecycle）。
   * @returns 是否回收成功（背包里没有可回收的装备时返回 false 并提示）
   */
  static async recycleBagEquipments(): Promise<boolean> {
    const role = this.findOnlineRole();
    if (!role) return false;
    const entries = this.collectBagEquipmentEntries(role.bag);
    const count = entries.reduce((sum, entry) => sum + entry.count, 0);
    if (!count) {
      GameUiHelper.createTip("bag_recycle_empty_tip");
      return false;
    }
    let result: SellGoodsResult;
    try {
      // 修订号带上做乐观锁：后台改过这个角色时（20006）服务端拒绝出售
      result = await RoleApi.sellGoods(role.id, { entries, revision: role.revision });
    } catch {
      return false; // 失败提示已由请求层弹过（非 silent 请求）
    }
    const data = result.data as Record<string, unknown>;
    role.bindGold = Number(data.bindGold ?? role.bindGold);
    // 服务端已经扣完格子：以它那份为准整体替换（格子只存 key + 数量，无引用关系）
    if (Array.isArray(data.bag)) role.bag = data.bag as typeof role.bag;
    role.revision = result.revision;
    this.updateOnlineRole(role);
    this.updateUi(role);
    RoleUIManager.refreshBag();
    GameUiHelper.createTip("bag_recycle_tip", { count: result.count, price: result.total });
    return true;
  }

  /**
   * 背包里的装备清单（回收请求的入参）：同 id 合并件数
   *
   * 只挑**装备**：与 `configs/items.recycleBagEquipmentGrid` 同一口径；
   * 解析不出配置的 id 不动（不认识的东西不替玩家决定）。服务端仍会按快照价复核。
   */
  private static collectBagEquipmentEntries(bag: BagCell[][]): Array<{ goodId: string; count: number }> {
    const merged = new Map<string, number>();
    bag.forEach((row) => {
      row.forEach((cell) => {
        const good = cell ? getItem(cell.id) : null;
        if (!cell || !good || !isEquipment(good) || !cell.id) return;
        merged.set(cell.id, (merged.get(cell.id) ?? 0) + Math.max(1, cell.count));
      });
    });
    return Array.from(merged, ([goodId, count]) => ({ goodId, count }));
  }

  //#endregion

  //#region 商城

  /**
   * 商城购买（当前在线角色）：**扣费与入包都在服务端**（role.mallPurchase，#304）
   *
   * 商品与价格都读服务端（上架行就是唯一价格，与商城管理端同源，后台改价即时生效）；
   * 可售品类也是服务端目录说了算 —— 装备变体与药品（#763），客户端不另设白名单。
   * 物品由服务端放进存档背包网格（可叠加的药品会叠到已有格子）。
   * 本地预检只做即时 UX（下架/余额不足提示），服务端结果为准：
   * 服务端拒绝时（后台改价、被踢、乐观锁冲突）提示经请求层失败出口弹给玩家。
   *
   * 成功后以服务端返回为准刷新本地存档（bindGold / bag / revision），再走既有落盘与 UI 链路
   * （防抖推回 revision 与服务端一致，幂等）。买装备不改战斗属性，无需重算。
   * @returns 是否购买成功（失败原因已用浮动提示告知）
   */
  static async buyMallGood(id: string): Promise<boolean> {
    const good = getItem(id);
    // 解析不出配置 = 已下架 / 本体被删（本地预检，省一次请求）；品类不再在这里卡（#763 起有药品）
    if (!good) {
      GameUiHelper.createTip("mall_good_missing_tip");
      return false;
    }
    const role = this.findOnlineRole();
    if (!role) {
      GameUiHelper.createTip("mall_good_missing_tip");
      return false;
    }
    if (role.bindGold < getMallPrice(good)) {
      GameUiHelper.createTip("mall_gold_not_enough_tip");
      return false;
    }
    let result: MallPurchaseResult;
    try {
      // 修订号带上做乐观锁：后台改过这个角色时（20006）服务端拒绝购买
      result = await RoleApi.mallPurchase(role.id, { goodId: id, revision: role.revision });
    } catch {
      return false; // 失败提示已由请求层弹过（非 silent 请求）
    }
    const data = result.data as Record<string, unknown>;
    role.bindGold = Number(data.bindGold ?? role.bindGold);
    // 服务端已把物品放进背包网格：以服务端那份为准整体替换（格子只存 key + 数量，无引用关系）
    if (Array.isArray(data.bag)) role.bag = data.bag as typeof role.bag;
    role.revision = result.revision;
    this.updateOnlineRole(role);
    this.updateUi(role);
    GameUiHelper.createTip("mall_buy_success_tip", { name: this.getGoodDisplayName(good), price: result.consumed });
    return true;
  }

  /** 物品展示名（装备 = 前缀 + 名称 + 后缀，段文案与配色同走 getEquipmentNameParts，与详情/地面掉落一致） */
  private static getGoodDisplayName(good: Goods): string {
    if (!isEquipment(good)) return good.label;
    const parts = getEquipmentNameParts(good);
    return `${parts.prefix.label}${parts.label}${parts.suffix.label}`;
  }

  //#endregion

  /**
   * 添加物品至背包（本地接口：拾取已改走服务端 `picked` 帧，见 applyPickResult）
   *
   * 可叠加物品优先合并到**绑定态相同**的已有格子，剩余数量再占用空格。
   * 绑定态不同不许并堆（#789）：绑定的那堆不可交易，混进可交易的堆就永远分不开了，
   * 反过来等于凭空洗白一件。
   *
   * @param good 物品（取其 id 与叠加规则；格子只存 key + 数量，不存物品数据）
   * @param count 数量，缺省取物品自身数量
   * @param meta 绑定与溯源（服务端判定好的；缺省 = 未绑定、无溯源）
   * @returns 是否全部放入（背包满时返回 false，可能有部分放入）
   */
  static addGood(good: Goods, count: number = getGoodCount(good), meta: { bound?: boolean; from?: BagOrigin } = {}): boolean {
    const role = this.findOnlineRole();
    // 掉落/奖励链路的物品都经 items 注册表带 id；没有 id 的物品无法入包
    const goodId = good.id;
    if (!role || count <= 0 || !goodId) return false;
    const stackable = !!good.stackable;
    const maxStack = good.maxStack ?? 99;
    const bound = meta.bound === true;
    let remaining = count;

    /** 剩余数量放入空格 */
    const fillEmptyCells = () => {
      for (let row = 0; row < role.bag.length && remaining > 0; row++) {
        for (let col = 0; col < role.bag[row].length && remaining > 0; col++) {
          if (role.bag[row][col]) continue;
          const add = stackable ? Math.min(maxStack, remaining) : 1;
          role.bag[row][col] = withBagMeta(goodId, add, { bound: meta.bound, from: meta.from });
          remaining -= add;
        }
      }
    };

    if (stackable) {
      const stackCells: BagCell[] = [];
      role.bag.forEach((row) =>
        row.forEach((cell) => {
          // 只并进同绑定态的堆：两侧 `bound` 都按「是否 === true」比，脏值不影响判定
          if (cell && cell.id === goodId && (cell.bound === true) === bound) stackCells.push(cell);
        }),
      );
      stackCells.forEach((cell) => {
        if (remaining <= 0) return;
        const canAdd = maxStack - cell.count;
        if (canAdd <= 0) return;
        const add = Math.min(canAdd, remaining);
        cell.count += add;
        remaining -= add;
      });
    }
    // 剩余数量放入空格
    fillEmptyCells();

    if (remaining < count) {
      // 保存并刷新背包显示
      this.updateOnlineRole(role);
      RoleUIManager.refreshBag();
    }
    return remaining <= 0;
  }

  /**
   * 消耗背包指定格子中的一个物品（减到 0 时清空格子；仅可叠加物品有数量概念）
   * @param role 目标角色，缺省取当前在线角色（注意：角色对象每次从存储反序列化，需与调用方用同一个实例）
   */
  static consumeBagGood(row: number, col: number, role: Role | undefined = this.findOnlineRole()) {
    const cell = role?.bag[row]?.[col];
    if (!role || !cell) return;
    const remaining = cell.count - 1;
    role.bag[row][col] = remaining > 0 ? { ...cell, count: remaining } : null;
  }

  /**
   * 使用药品（当前在线角色）：**回复结算与格子扣减都在服务端**（role.drugUse，#308）
   *
   * 回复量与药品管理端同源（drugs 表，管理端改回复量即时生效）；maxHp/maxMp 用服务端重算的
   * 战斗属性。本地预检（空格 / 非药 / 无生效效果 / 血蓝满提示）只做即时 UX —— 服务端结果为准，
   * 预检放行但服务端拒绝时（管理端并发改动、被踢、乐观锁冲突），提示经请求层失败出口弹给玩家。
   *
   * 成功后以服务端返回为准刷新本地存档（hp / mp / bag / revision），再走既有落盘与 UI 链路
   * （防抖推回 revision 与服务端一致，幂等）。用药不改战斗属性，无需重算。
   * @param row 背包行
   * @param col 背包列
   * @returns 是否成功使用（失败原因已用浮动提示告知）
   */
  static async useDrug(row: number, col: number): Promise<boolean> {
    const role = this.findOnlineRole();
    const cell = role?.bag[row]?.[col];
    if (!role || !cell) return false;
    // 格子只存物品 key，数据实时解析
    const good = getItem(cell.id);
    if (!good || !isDrug(good)) return false;
    // 本地期望回复量（未封顶）：没有任何分量的药品等于没实现 —— 只做预检，服务端按库里配置算
    const recovery = resolveDrugRecovery(good.effects, role.maxHp, role.maxMp);
    const healsHp = recovery.hp > 0;
    const healsMp = recovery.mp > 0;
    if (!healsHp && !healsMp) {
      GameUiHelper.createTip("drug_unsupported_tip");
      return false;
    }
    // 血蓝都已满（该药对应的资源都回不动）→ 提示且不发请求（与服务端同一判定式）
    const hpFull = role.hp >= role.maxHp;
    const mpFull = role.mp >= role.maxMp;
    if ((!healsHp || hpFull) && (!healsMp || mpFull)) {
      GameUiHelper.createTip(healsHp ? "drug_full_tip" : "drug_mp_full_tip");
      return false;
    }
    let result: DrugUseResult;
    // 连点节流（#848）：同一瓶药一秒内只发一次请求，冷却本身由服务端裁
    if (!guardRepeatedUse(`drug:${cell.id}`)) return false;
    try {
      // 修订号带上做乐观锁：后台改过这个角色时（20006）服务端拒绝用药
      result = await RoleApi.drugUse(role.id, { row, col, revision: role.revision });
    } catch {
      return false; // 失败提示已由请求层弹过（非 silent 请求）
    }
    const data = result.data as Record<string, unknown>;
    if (data.hp !== undefined) role.hp = Number(data.hp);
    if (data.mp !== undefined) role.mp = Number(data.mp);
    // 服务端已扣减格子：以服务端那份为准整体替换（格子只存 key + 数量，无引用关系）
    if (Array.isArray(data.bag)) role.bag = data.bag as typeof role.bag;
    role.revision = result.revision;
    // 保存并刷新（血蓝与背包）
    this.updateOnlineRole(role);
    this.updateUi(role);
    RoleUIManager.refreshBag();
    return true;
  }

  /**
   * 使用货币物品（当前在线角色）：**入账与格子扣减都在服务端**（role.moneyUse，#785）
   *
   * 金额与币种一律读服务端 `money_items` 表 —— 客户端只报「用哪一格」，报什么都不算数；
   * 管理端改面值 / 删掉一条，玩家手上的旧格子要么按新面值入账、要么被服务端判「用不了」。
   * 本地预检（空格 / 非货币道具）只做即时 UX，服务端结果为准。
   *
   * 成功后以服务端返回为准刷新本地存档（对应账本字段 / bag / revision），再走既有落盘与 UI 链路
   * （防抖推回 revision 与服务端一致，幂等）。入账不改战斗属性，无需重算。
   * @param row 背包行
   * @param col 背包列
   * @returns 是否成功使用（失败原因已用浮动提示告知）
   */
  static async useMoneyItem(row: number, col: number): Promise<boolean> {
    const role = this.findOnlineRole();
    const cell = role?.bag[row]?.[col];
    if (!role || !cell) return false;
    // 格子只存物品 key，数据实时解析（不是货币道具就当不了钱用）
    const good = getItem(cell.id);
    if (!good || !isMoneyItem(good)) {
      GameUiHelper.createTip("money_use_invalid_tip");
      return false;
    }
    let result: MoneyUseResult;
    // 连点节流（#847）：同一个道具一秒内只发一次请求（服务端另有 1 秒权威冷却）
    if (!guardRepeatedUse(`money:${cell.id}`)) return false;
    try {
      // 修订号带上做乐观锁：后台改过这个角色时（20006）服务端拒绝使用
      result = await RoleApi.moneyUse(role.id, { row, col, revision: role.revision });
    } catch {
      return false; // 失败提示已由请求层弹过（非 silent 请求）
    }
    // `result` 是接口 DTO（本次明细 + 修订号），`result.data` 才是角色存档本身
    // （账本字段 / bag 都在里面）
    const data = (result.data ?? {}) as Record<string, unknown>;
    const currency = String(result.currency ?? "") as MoneyCurrency;
    // 账本三字段与快照同源：只认服务端给的那一个字段，其余不动
    if (currency === "gold" || currency === "bindGold" || currency === "silver") {
      role[currency] = Number(data[currency] ?? role[currency]);
    }
    // 服务端已扣减格子：以服务端那份为准整体替换（格子只存 key + 数量，无引用关系）
    if (Array.isArray(data.bag)) role.bag = data.bag as typeof role.bag;
    role.revision = result.revision;
    // 保存并刷新（HUD 金钱 + 背包）
    this.updateOnlineRole(role);
    this.updateUi(role);
    RoleUIManager.refreshBag();
    GameUiHelper.createTip("money_use_success_tip", {
      name: this.getGoodDisplayName(good),
      amount: Number(result.amount ?? 0),
      currency: MONEY_CURRENCY_LABELS[currency] ?? "",
      balance: Number(result.balance ?? 0),
    });
    return true;
  }

  /**
   * 使用升级卷轴（当前在线角色）：**等级 +1 与属性重算都在服务端**（role.levelScrollUse，#787）
   *
   * 等级区间读服务端 `level_scrolls` 表 —— 客户端这份（`configs/game-config` 的 `levelScrolls`）
   * 只用来**先说一句**：等级不在区间里就不发请求（省一个往返），并提示当前该用哪一卷。
   * 服务端仍会照自己的库再判一次，改包跳过这一步也跳不出区间。
   *
   * 成功后以服务端返回为准刷新本地存档：等级 / 经验 / 血蓝上限与当前值（升级补满）/ 战斗力 / bag /
   * revision。**不本地 +1** —— 自增一版就会与服务端落库值漂开（下次存档被回填，表现成「等级弹回去」）。
   * @param row 背包行
   * @param col 背包列
   * @returns 是否成功使用（失败原因已用浮动提示告知）
   */
  static async useLevelScroll(row: number, col: number): Promise<boolean> {
    const role = this.findOnlineRole();
    const cell = role?.bag[row]?.[col];
    if (!role || !cell) return false;
    const good = getItem(cell.id);
    if (!good || !isLevelScroll(good)) {
      GameUiHelper.createTip("level_scroll_use_invalid_tip");
      return false;
    }
    const level = Math.max(1, Math.floor(Number(role.level) || 1));
    if (level < good.minLevel || level > good.maxLevel) {
      // 这一句是玩家的主要反馈：卷轴不对口时他要立刻知道「该换哪一卷」
      GameUiHelper.createTip("level_scroll_level_out_of_range_tip", {
        name: this.getGoodDisplayName(good),
        min: good.minLevel,
        max: good.maxLevel,
        level,
      });
      return false;
    }
    let result: LevelScrollUseResult;
    try {
      // 修订号带上做乐观锁：后台改过这个角色时（20006）服务端拒绝使用
      result = await RoleApi.levelScrollUse(role.id, { row, col, revision: role.revision });
    } catch {
      return false; // 失败提示已由请求层弹过（非 silent 请求）
    }
    // `result` 是接口 DTO（跳级明细 + 修订号），`result.data` 才是角色存档本身
    const data = (result.data ?? {}) as Record<string, unknown>;
    // 服务端已经把「升级后」的整份数值算好：照搬，不在这里再推一遍
    // 等级读 **DTO 顶层**那一列：`row.level` 是唯一权威，存档里的 level 升级时不跟着写
    // （与击杀升级 `applyKillExp` 同一纪律），读存档那份会拿到「升级前的旧等级」
    if (typeof result.level === "number") role.level = result.level;
    if (typeof data.exp === "number") role.exp = data.exp;
    if (typeof data.maxHp === "number") role.maxHp = data.maxHp;
    if (typeof data.maxMp === "number") role.maxMp = data.maxMp;
    if (typeof data.hpRecover === "number") role.hpRecover = data.hpRecover;
    if (typeof data.combat === "number") role.combat = data.combat;
    if (typeof data.hp === "number") role.hp = data.hp;
    if (typeof data.mp === "number") role.mp = data.mp;
    // 服务端已扣减格子：以服务端那份为准整体替换（格子只存 key + 数量，无引用关系）
    if (Array.isArray(data.bag)) role.bag = data.bag as typeof role.bag;
    role.revision = result.revision;
    // 保存并刷新（等级 / 血条上限 / 背包）
    this.updateOnlineRole(role);
    this.updateUi(role);
    RoleUIManager.refreshBag();
    GameUiHelper.createTip("level_scroll_use_success_tip", {
      name: this.getGoodDisplayName(good),
      from: Number(result.fromLevel ?? level),
      level: Number(result.toLevel ?? role.level),
    });
    return true;
  }

  /** 正在等服务端放行的一次换图（`null` = 当前没有；防止连点重复发意图） */
  private static mapEnterPending = false;

  /**
   * 跳转地图（所有传送入口都经过这里）
   *
   * 三段，顺序有意义（#606）：
   *
   * 1. **本地预检**：读配置快照判一次，不满足立刻提示 —— 不联也能给反馈，不必等一个往返；
   * 2. **服务端判定**：权威在服务端（改包跳过第 1 步也没用）。通道不在线时退回老行为
   *    （本地判据说了算），通道在就发 `mapEnter` 等 `mapEnterResult`；
   * 3. **放行才切图**：被拒就按服务端给的那一项提示（文案仍是客户端这份），原地不动。
   *
   * 为什么不能「先切图、等服务端拒绝再退回」：切场景会先卸掉旧场景再加载新图，
   * 等 world 帧回来人已经站在一张空图里了 —— 回滚代价远大于先问一句。
   */
  static changeOnMap(mapId: MapId) {
    // ① 进入限制校验：等级/战斗力未达标时提示原因，不切换地图
    const reason = GameHelper.getMapEnterRejectReason(mapId);
    if (reason) {
      GameUiHelper.createTip(reason.key, reason.params);
      return;
    }
    const role = this.findOnlineRole();
    if (!role) return;
    // 传送点就在脚下：不必问服务端（老行为照样重进一次场景）
    if (role.onMap === mapId) {
      this.applyMapChange(mapId);
      return;
    }
    // 上一次判定还没回来，忽略这次连点（否则两个回调都会去切场景）
    if (this.mapEnterPending) return;
    // 通道不在线：退回老行为，本地判据说了算（断线也有得玩）
    if (!CombatChannel.active) {
      this.applyMapChange(mapId);
      return;
    }
    // ② 服务端判定（超时 / 通道掉线由 CombatChannel 兜底成放行 —— 本地判据已经过了）
    this.mapEnterPending = true;
    CombatChannel.requestMapEnter(mapId, (result: MapEnterResult) => {
      this.mapEnterPending = false;
      if (!result.ok) {
        // ③ 被拒：按服务端指出缺的那一项提示（文案 key 与本地预检同一套）
        const reject = GameHelper.mapEnterRejectText(result);
        if (reject) GameUiHelper.createTip(reject.key, reject.params);
        return;
      }
      this.applyMapChange(mapId);
    });
  }

  /** 真正切图（服务端已放行或通道不可用时的本地路径） */
  private static applyMapChange(mapId: MapId) {
    const role = this.findOnlineRole();
    if (!role) return;
    // 更改所在地图
    role.onMap = mapId;
    // 保存
    this.updateOnlineRole(role);
    // 传送成功音（#685）：**不在这里响**。此处到新地图出现还隔着 Loading 场景的资源加载，
    // 现在响等于「点了传送就有声音」，玩家听不出成功。留标记，等 Game.start 把角色摆出来再播
    // （见 consumeTeleportArrival）
    this.markTeleportArrival();
    // 重新进入游戏场景，走过渡场景完成新地图资源加载后再进入
    SceneManager.loadScene("Game");
  }

  /** 更新UI */
  static updateUi(role: Role) {
    RoleUIManager.updateRoleData(role);
  }

  /** 更换快捷键技能 */
  static changeShortcutKey(index: number, skillId: SkillId) {
    const role = this.findOnlineRole();
    role.shortcutKeys[index].skillId = skillId;
    this.updateOnlineRole(role);
    const skill = skills.get(skillId);
    // 触发统一走 SkillManager（图标更新，回调改为按技能 id 释放，并同步冷却绑定）
    RoleUIManager.updateShortcutIcon(role.shortcutKeys[index].key, skill?.icon, () => SkillManager.release(skillId), skillId);
  }
}

