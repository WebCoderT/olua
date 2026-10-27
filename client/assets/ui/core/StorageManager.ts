import { sys } from "cc";
import RoleUIManager from "./RoleUIManager";
import SceneManager from "./SceneManager";
import SkillManager from "./SkillManager";
import { levelMap } from "../../configs/level";
import { roleMaxLevel } from "../../configs/growth";
import { initialShortcutKeys, bagRow, bagCol } from "../../configs/role";
import { Role } from "../../entities/Role";
import { BagCell, EQUIPMENT_TYPE, Equipment, getGoodCount, Goods, isDrug, isEquipment } from "../../types/good";
import { MapId } from "../../types/map";
import { NeedSetShortcutKeyConfig } from "../../types/role";
import { SkillId } from "../../types/skill";
import GameHelper from "./GameHelper";
import GameUiHelper from "../helpers/GameUiHelper";
import LayerManager from "./LayerManager";
import MpHelper from "../utils/battle/MpHelper";
import HpHelper from "../utils/battle/HpHelper";
import { skills } from "../../configs/skill";
import { getEquipment, getItem, moveBagCellGrid, normalizeBagGrid, resolveDrugRecovery, summarizeBagRecycle, tidyBagGrid, findBagEquipmentUpgrade } from "../../configs/items";
import { getMallPrice } from "../../configs/mall";
import { getFashion, fashionData } from "../../configs/fashionClothes";
import { getEquipmentNameParts } from "../../configs/equipments";
import { getSoulLevel } from "../../configs/soul";
import { getTitleLevel } from "../../configs/title";
import { getRankLevel } from "../../configs/rank";
import RoleSync from "../utils/net/RoleSync";
import Session from "../utils/net/Session";
import { RoleApi } from "../utils/net/Api";
import type { CombatKillReward } from "../utils/net/CombatChannel";
import type { DrugUseResult, GrowthUpgradeResult, MallPurchaseResult, SellGoodsResult } from "../utils/net/ApiModels";

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
   * 角色数量上限由服务端把关（server/.env 的 ROLE_MAX_PER_ACCOUNT），本地不再自己拦。
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
   * 登录场景启动时调用一次：进登录页一律重新登录，避免上个账号的角色缓存与令牌串到下一个账号。
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
   * - 快捷键：按 configs/role.initialShortcutKeys 的按键码对齐（保留玩家已绑定的技能，补齐新增的按键槽，
   *   例如快捷键由 4 个扩展到 6 个后，旧存档会补出 5/6 两格，否则快捷键栏只显示旧有的 4 格）
   * - 装备槽：旧存档存的是装备快照对象，迁移为只存装备 id（新格式经配置表实时解析，改配置重启即生效）
   * - 背包：旧存档格子存的是物品快照对象，迁移为 { id, count }（物品数据经配置表实时解析）
   */
  static ensureRoleDefaults(role: Role) {
    MpHelper.ensureDefaults(role);
    HpHelper.ensureDefaults(role);
    (Object.keys(role.equipments) as EQUIPMENT_TYPE[]).forEach((slot) => {
      const value = role.equipments[slot] as unknown;
      if (value && typeof value === "object") {
        // 旧快照对象：取它的 id 作为槽位值（快照无 id 或 id 不在配置表时视为空槽）
        role.equipments[slot] = (value as Goods).id ?? null;
      } else if (typeof value !== "string") {
        role.equipments[slot] = null;
      }
    });
    // 背包格子迁移：旧快照（带 type 的完整物品对象）收敛为 { id, count }；新格式原样规整；无法确定 id 的格子丢弃
    role.bag = (Array.isArray(role.bag) ? role.bag : []).map((row) =>
      row.map((cell) => {
        if (!cell || typeof cell !== "object") return null;
        const snapshot = cell as Goods & Partial<BagCell>;
        const id = snapshot.id;
        if (!id) return null;
        // 旧快照带 type 字段：数量按物品叠加规则取（不可叠加恒 1）；新格式直接读 count
        const count = "type" in cell ? getGoodCount(cell as Goods) : Math.max(1, snapshot.count ?? 1);
        return { id, count };
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
    // 属性计入角色属性与战斗力，升级后重算（称号头顶名牌动画由调用方经 RoleUIManager.updateTitleShow 刷新）
    Object.assign(role, GameHelper.combatCalc(role));
    this.updateOnlineRole(role);
    this.updateUi(role);
    GameUiHelper.createTip(tipKey, { level: result.gainedLevel, label: result.gainedLabel });
    return true;
  }

  /**
   * 战魂升级（当前在线角色）：扣费与推进在服务端（见 configs/soul 仅作本地预检）
   * @returns 是否升级成功（失败原因已用浮动提示告知）
   */
  static async upgradeSoul(): Promise<boolean> {
    const role = this.findOnlineRole();
    if (!role) return false;
    const next = getSoulLevel(role.soulOfWar + 1);
    if (!next) {
      GameUiHelper.createTip("soul_max_tip");
      return false;
    }
    if (role.bindGold < next.bindGold) {
      GameUiHelper.createTip("soul_bind_gold_tip", { need: next.bindGold });
      return false;
    }
    return this.upgradeGrowthOnServer(role, "soul", next.level, "soul_upgrade_tip");
  }

  /**
   * 称号升级/解锁（当前在线角色）：扣费与推进在服务端（configs/title 仅作本地预检；0 阶升 1 阶即解锁）
   * @returns 是否升级成功（失败原因已用浮动提示告知）
   */
  static async upgradeTitle(): Promise<boolean> {
    const role = this.findOnlineRole();
    if (!role) return false;
    const next = getTitleLevel(role.title + 1);
    if (!next) {
      GameUiHelper.createTip("title_max_tip");
      return false;
    }
    if (role.bindGold < next.bindGold) {
      GameUiHelper.createTip("title_bind_gold_tip", { need: next.bindGold });
      return false;
    }
    return this.upgradeGrowthOnServer(role, "title", next.level, "title_upgrade_tip");
  }

  /**
   * 军衔晋升/授衔（当前在线角色）：扣费与推进在服务端（configs/rank 仅作本地预检；0 阶晋 1 阶即授衔）
   * 军衔的外显就是头顶那行红字，随 updateUi → RoleUIManager.updateRoleData → RoleDisplay.updateHead 自动刷新，
   * 不需要像称号那样另外调一次外显刷新
   * @returns 是否晋升成功（失败原因已用浮动提示告知）
   */
  static async upgradeRank(): Promise<boolean> {
    const role = this.findOnlineRole();
    if (!role) return false;
    const next = getRankLevel(role.rank + 1);
    if (!next) {
      GameUiHelper.createTip("rank_max_tip");
      return false;
    }
    if (role.bindGold < next.bindGold) {
      GameUiHelper.createTip("rank_bind_gold_tip", { need: next.bindGold });
      return false;
    }
    return this.upgradeGrowthOnServer(role, "rank", next.level, "rank_upgrade_tip");
  }

  /** 角色获得经验(当前在线角色) */
  static onlineRoleGetExp(exp: number) {
    const role = this.findOnlineRole();
    role.exp += exp;
    // 确认是否升级,经验满了则升级
    if (role.exp >= levelMap.get(role.level).exp) {
      // 扣除升级所需经验
      role.exp -= levelMap.get(role.level).exp;
      // 升级（等级上限跟成长曲线走，见 configs/growth 的 roleMaxLevel）
      if (role.level >= roleMaxLevel) role.level = roleMaxLevel;
      else role.level += 1;
      // 属性重新计算
      Object.assign(role, GameHelper.combatCalc(role));
      // 升级时补满血量与魔法值至最大值
      role.hp = role.maxHp;
      role.mp = role.maxMp;
      // 播放升级特效
      LayerManager.addToUILayer(GameUiHelper.createUpgradeEffect());
    }
    // 保存
    this.updateOnlineRole(role);
    // 更新UI
    this.updateUi(role);
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
      // 属性重新计算（等级变了，maxHp / 攻防都跟着曲线走）
      Object.assign(role, GameHelper.combatCalc(role));
      // 升级时补满血量与魔法值至最大值
      role.hp = role.maxHp;
      role.mp = role.maxMp;
      // 播放升级特效
      LayerManager.addToUILayer(GameUiHelper.createUpgradeEffect());
    }
    // 保存并刷新（revision 已与服务端对齐，下一次落盘不会撞乐观锁）
    this.updateOnlineRole(role);
    this.updateUi(role);
    return reward.exp;
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
   * 服务端拾取落账（#325：入包的权威在服务端，picked 帧带回的就是落账后的格子）
   *
   * 把服务端实际写入的格子照搬进本地背包（叠加进已有堆 = 该格更新后的形状，
   * 新占格 = 原样落位），revision 一并照搬 —— 入包推进了修订号，本地基线不更新的话
   * 下一次防抖存档就会撞乐观锁（与 applyKillReward 同一纪律）。
   * 坐标对不上本地网格（两端配置漂了的边角）就丢掉那一格，等全量同步兜底。
   */
  static applyPickResult(placed: Array<{ row: number; col: number; id: string; count: number }>, revision: number): void {
    const role = this.findOnlineRole();
    if (!role) return;
    for (const cell of placed) {
      const line = role.bag[cell.row];
      if (!line || cell.col < 0 || cell.col >= line.length) continue;
      line[cell.col] = { id: cell.id, count: cell.count };
    }
    role.revision = revision;
    this.updateOnlineRole(role);
    this.updateUi(role);
  }

  //#region 背包物品使用

  /**
   * 使用背包物品（统一入口：背包左键、快捷键等一切「使用物品」都走这里）
   * 按物品大类分发，新增物品类型时在此补一条分支并实现对应的 useXxx：
   * 装备 → 穿戴、药品 → 服用、材料/其他 → 暂未开放（后续合成、任务用途在此扩展）
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
    if (isEquipment(good)) return this.equipFromBag(row, col);
    if (isDrug(good)) return await this.useDrug(row, col);
    GameUiHelper.createTip("good_unsupported_tip");
    return false;
  }

  /**
   * 从背包穿戴装备：脱下同槽位的旧装备并放回刚腾出的格子
   * 等级/性别/职业不符时提示原因并放弃（校验与文案由 GameHelper 给出）
   * @param row 背包行
   * @param col 背包列
   * @returns 是否穿戴成功
   */
  static equipFromBag(row: number, col: number): boolean {
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
    // 旧装备放回刚腾空的格子：格数守恒，换装不会丢装备（格子存 key，槽位也是 key）
    const wornId = role.equipments[good.slot];
    role.bag[row][col] = wornId ? { id: wornId, count: 1 } : null;
    role.equipments[good.slot] = good.id ?? cell.id;
    this.applyEquipmentChange(role, good.slot);
    return true;
  }

  /**
   * 脱下装备放入背包（放进第一个空格；背包已满时提示并放弃）
   * @param slot 装备槽位
   * @returns 是否脱下成功
   */
  static unequipToBag(slot: EQUIPMENT_TYPE): boolean {
    const role = this.findOnlineRole();
    const equipmentId = role?.equipments[slot];
    if (!role || !equipmentId) return false;
    const cell = this.findEmptyBagCell(role);
    if (!cell) {
      GameUiHelper.createTip("bag_full_tip");
      return false;
    }
    // 从配置确认装备存在后，格子存 key（脱下后槽位清空）
    const equipment = getItem(equipmentId);
    if (!equipment) {
      GameUiHelper.createTip("equip_missing_tip");
      role.equipments[slot] = null;
      return false;
    }
    role.bag[cell.row][cell.col] = { id: equipmentId, count: 1 };
    role.equipments[slot] = null;
    this.applyEquipmentChange(role, slot);
    return true;
  }

  //#region 时装（#377：只换外观，不换数值）

  /**
   * 穿上一件时装（换上 = 覆盖当前时装，不需要先脱）
   *
   * 与时装的「拥有」无关：本版是**衣柜口径**（表里 20 套任选），获取渠道（商城/活动/掉落）
   * 另开一刀；等有了拥有清单，这里只多一道「有没有这件」的校验。
   * 不校验性别/职业 —— 时装配置没有这两个维度。
   *
   * @param fashionId 时装 id（fashions 表主键，如 cloth_2）
   * @returns 是否穿上（id 不在配置表里返回 false）
   */
  static wearFashion(fashionId: string): boolean {
    const role = this.findOnlineRole();
    const fashion = getFashion(fashionId);
    if (!role || !fashion) return false;
    if (role.fashionCloth === fashion.id) return true;
    role.fashionCloth = fashion.id;
    this.applyFashionChange(role);
    return true;
  }

  /**
   * 脱下当前时装（没穿时返回 false，不打扰）
   * @returns 是否真的脱下了一件
   */
  static unwearFashion(): boolean {
    const role = this.findOnlineRole();
    if (!role || !role.fashionCloth) return false;
    role.fashionCloth = null;
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

  /** 找背包的第一个空格（没有空格返回 null） */
  private static findEmptyBagCell(role: Role) {
    for (let row = 0; row < role.bag.length; row++) {
      for (let col = 0; col < role.bag[row].length; col++) {
        if (!role.bag[row][col]) return { row, col };
      }
    }
    return null;
  }

  /**
   * 取身上某槽位穿戴的装备（未穿戴/解析不出返回 null）
   * 背包悬停详情「按住 Ctrl 对比」的数据源（见 GameUiHelper.createGood 的 compareWornProvider）
   * @param slot 装备槽位
   */
  static getWornEquipment(slot: EQUIPMENT_TYPE): Equipment | null {
    return getEquipment(this.findOnlineRole()?.equipments[slot] ?? null);
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
      getEquipment(role.equipments[slot]),
    );
    return candidate ? { row: candidate.row, col: candidate.col } : null;
  }

  /**
   * 一键换上背包里该槽位更好的装备（角色信息弹窗提示角标的点击入口）
   * 复用 equipFromBag：校验/换装/旧装备回原格/属性重算与各处刷新都是同一条路
   * @param slot 装备槽位
   * @returns 是否换上成功（没有更好的装备时返回 false，不打扰）
   */
  static equipBetterFromBag(slot: EQUIPMENT_TYPE): boolean {
    const better = this.findBetterEquipmentInBag(slot);
    if (!better) return false;
    return this.equipFromBag(better.row, better.col);
  }

  /**
   * 装备变更后的统一收尾：属性重算 → 血量修正 → 落盘 → 刷新各视图
   * 装备影响 maxHp，脱下加血装备时当前血量要跟随上限下调，避免血量超过上限
   */
  private static applyEquipmentChange(role: Role, slot: EQUIPMENT_TYPE) {
    Object.assign(role, GameHelper.combatCalc(role));
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
   * 规则判定与提示都在本层（界面只上报点击，见 BagDialog 的丢弃模式），丢弃不动属性/战力，故无需 updateUi
   * @param row 背包行
   * @param col 背包列
   * @returns 是否丢弃成功（空格子或越界时返回 false 并提示）
   */
  static discardBagGood(row: number, col: number): boolean {
    const role = this.findOnlineRole();
    const cell = role?.bag[row]?.[col];
    if (!role || !cell) {
      GameUiHelper.createTip("bag_discard_empty_tip");
      return false;
    }
    const label = getItem(cell.id)?.label ?? cell.id;
    const count = Math.max(1, cell.count);
    role.bag[row][col] = null;
    // 保存并刷新背包显示
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
   * 搬运算法是纯函数 `configs/items.tidyBagGrid`（合并同类可叠加物 → 按等级/部位排序 → **从第一个格子起铺满**），
   * 这里只负责：取角色 → 调用 → **有变动才落盘刷新**，背包本来就整齐时不重复写存储
   * @returns 是否有变动（无角色/背包为空/整理前后一致时返回 false）
   */
  static tidyBag(): boolean {
    const role = this.findOnlineRole();
    if (!role) return false;
    if (this.bagIsEmpty(role.bag)) return false;
    const before = this.bagSignature(role.bag);
    role.bag = tidyBagGrid(role.bag);
    if (this.bagSignature(role.bag) === before) return false;
    // 保存并刷新背包显示
    this.updateOnlineRole(role);
    RoleUIManager.refreshBag();
    GameUiHelper.createTip("bag_tidy_tip");
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
   * 其余 = 交换；这里只负责取角色 → 调用 → **真的动了才落盘刷新**。
   *
   * 与「整理」同一口径：**不弹提示** —— 拖动的反馈就是物品的位置/数量变化本身，
   * 每次落子都飘一条字反而吵；无效拖动（拖空格、拖回原格）静默返回 false
   * @returns 是否有变动（起点为空、起终点相同、越界、无角色时返回 false）
   */
  static moveBagGood(fromRow: number, fromCol: number, toRow: number, toCol: number): boolean {
    const role = this.findOnlineRole();
    if (!role) return false;
    const result = moveBagCellGrid(role.bag, { row: fromRow, col: fromCol }, { row: toRow, col: toCol });
    if (!result.moved) return false;
    role.bag = result.bag;
    // 保存并刷新背包显示
    this.updateOnlineRole(role);
    RoleUIManager.refreshBag();
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
   * 商城购买（当前在线角色）：扣**绑定元宝** → 物品入包（第一个空格，可叠加则先合并）
   * 商品与价格口径见 configs/mall（全场装备，默认 1 绑定元宝/件，特殊定价在那张表里扩展）；
   * 入包复用统一的 addGood（拾取/奖励同一入口），购买数量恒 1（商城只上架不可叠加的装备）。
   *
   * **先扣款落盘、再入包**：addGood 内部会自己取一次在线角色并落盘，若反过来（先入包、再用
   * 本方法手里的旧实例落盘），刚放进背包的东西会被旧实例覆盖掉 —— 角色对象每次反序列化都是
   * 新实例，跨调用不能复用（见 findOnlineRole）。背包满时把扣掉的元宝原路退回。
   * @param id 物品 id（商城只上架装备，见 configs/mall.getMallGoods）
   * @returns 是否购买成功
   */
  /**
   * 商城购买（当前在线角色）：**扣费与入包都在服务端**（role.mallPurchase，#304）
   *
   * 价格读服务端（特殊价优先，未定价走统一价——与商城定价管理端同源，后台改价即时生效）；
   * 物品由服务端放进存档背包网格。本地预检只做即时 UX（下架/余额不足提示），服务端结果为准：
   * 服务端拒绝时（后台改价、被踢、乐观锁冲突）提示经请求层失败出口弹给玩家。
   *
   * 成功后以服务端返回为准刷新本地存档（bindGold / bag / revision），再走既有落盘与 UI 链路
   * （防抖推回 revision 与服务端一致，幂等）。买装备不改战斗属性，无需重算。
   * @returns 是否购买成功（失败原因已用浮动提示告知）
   */
  static async buyMallGood(id: string): Promise<boolean> {
    const good = getItem(id);
    // 只卖装备：非装备 id（或解析不出配置）一律当「已下架」拒绝（本地预检，省一次请求）
    if (!good || !isEquipment(good)) {
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
   * 添加物品至背包（拾取掉落物/任务奖励等统一入口）
   * 可叠加物品优先合并到已有格子，剩余数量再占用空格
   * @param good 物品（取其 id 与叠加规则；格子只存 key + 数量，不存物品数据）
   * @param count 数量，缺省取物品自身数量
   * @returns 是否全部放入（背包满时返回 false，可能有部分放入）
   */
  static addGood(good: Goods, count: number = getGoodCount(good)): boolean {
    const role = this.findOnlineRole();
    // 掉落/奖励链路的物品都经 items 注册表带 id；没有 id 的物品无法入包
    const goodId = good.id;
    if (!role || count <= 0 || !goodId) return false;
    const stackable = !!good.stackable;
    const maxStack = good.maxStack ?? 99;
    let remaining = count;

    /** 剩余数量放入空格 */
    const fillEmptyCells = () => {
      for (let row = 0; row < role.bag.length && remaining > 0; row++) {
        for (let col = 0; col < role.bag[row].length && remaining > 0; col++) {
          if (role.bag[row][col]) continue;
          const add = stackable ? Math.min(maxStack, remaining) : 1;
          role.bag[row][col] = { id: goodId, count: add };
          remaining -= add;
        }
      }
    };

    if (stackable) {
      const stackCells: BagCell[] = [];
      role.bag.forEach((row) =>
        row.forEach((cell) => {
          if (cell && cell.id === goodId) stackCells.push(cell);
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

  /** 跳转地图（不满足地图进入条件时提示并放弃，所有传送入口都经过这里） */
  static changeOnMap(mapId: MapId) {
    // 进入限制校验：等级/战斗力未达标时提示原因，不切换地图
    const reason = GameHelper.getMapEnterRejectReason(mapId);
    if (reason) {
      GameUiHelper.createTip(reason.key, reason.params);
      return;
    }
    // 获取最新信息
    const role = this.findOnlineRole();
    // 更改所在地图
    role.onMap = mapId;
    // 保存
    this.updateOnlineRole(role);
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

