import GameUiHelper from "../helpers/GameUiHelper";
import RoleUIManager from "./RoleUIManager";
import { skills } from "../../configs/skill";
import { getText } from "../../configs/texts";
import { RoleApi } from "../utils/net/Api";
import type { AttrChangeResult } from "../utils/net/ApiModels";
import { AttrPointKey } from "../../types/role";
import { SkillId } from "../../types/skill";
import { attrAllocationFrom } from "./storage/shared";
import { Role } from "../../entities/Role";
import RoleCache from "./storage/role-cache";
import GrowthService from "./storage/growth-service";
import BattleApplier from "./storage/battle-applier";
import BagService from "./storage/bag-service";
import FashionService from "./storage/fashion-service";
import MallService from "./storage/mall-service";
import MapTransition from "./storage/map-transition";
import { withRevision } from "./storage/with-revision";
import { updateRoleUi } from "./storage/ui-bridge";

/**
 * 本地角色数据的门面（#1115 批次 6 起）：读写与各域操作的真实实现拆在 ui/core/storage/，
 * 这一层只保留**全部对外 API 的形状** —— 既有调用方零改动，按域转发：
 *
 * - 角色缓存（localStorage / 修订号 / 旧档补齐）→ storage/role-cache
 * - 三条成长线（称号 / 战魂 / 军衔）→ storage/growth-service
 * - 服务端战斗与权威帧落账 → storage/battle-applier
 * - 背包（使用 / 穿脱 / 丢弃 / 整理 / 搬运 / 回收 / 入包）→ storage/bag-service
 * - 时装 → storage/fashion-service
 * - 商城 → storage/mall-service
 * - 换图与传送标记 → storage/map-transition
 * - 技能升级 / 属性加点 / 快捷键 → 本文件（量小且与 UI 接线耦合）
 */
export default class StorageManager {
  /**
   * 快捷键释放回调（#1115 批次 6 破环：由 SkillManager 模块加载时注入，
   * StorageManager 不再 import SkillManager —— 否则 SkillManager → StorageManager → SkillManager 成环）
   */
  private static shortcutReleaseHandler: ((skillId: SkillId) => void) | null = null;

  /** SkillManager 注入释放回调（见 SkillManager.ts 模块尾部） */
  static setShortcutReleaseHandler(handler: (skillId: SkillId) => void) {
    this.shortcutReleaseHandler = handler;
  }

  // ── 角色缓存 ──────────────────────────────────────────────
  static getRoles(): Role[] { return RoleCache.getRoles(); }
  static setRoles(roles: Role[]) { RoleCache.setRoles(roles); }
  static cacheRole(role: Role) { RoleCache.cacheRole(role); }
  static cacheServerRole(detail: { data: unknown; revision: number }): Role | null { return RoleCache.cacheServerRole(detail); }
  static applyServerRevision(roleId: string, revision: number) { RoleCache.applyServerRevision(roleId, revision); }
  static findRoleById(id: string) { return RoleCache.findRoleById(id); }
  static deleteRole(id: string): boolean { return RoleCache.deleteRole(id); }
  static clear() { RoleCache.clear(); }
  static onlineRole(id: string) { RoleCache.onlineRole(id); }
  static clearOnlineRole() { RoleCache.clearOnlineRole(); }
  static findOnlineRole() { return RoleCache.findOnlineRole(); }
  static updateOnlineRole(role: Role) { RoleCache.updateOnlineRole(role); }
  static ensureRoleDefaults(role: Role) { RoleCache.ensureRoleDefaults(role); }

  // ── 三条成长线 ────────────────────────────────────────────
  static upgradeSoul(): Promise<boolean> { return GrowthService.upgradeSoul(); }
  static upgradeTitle(): Promise<boolean> { return GrowthService.upgradeTitle(); }
  static upgradeRank(): Promise<boolean> { return GrowthService.upgradeRank(); }

  // ── 服务端落账 ────────────────────────────────────────────
  static applyKillReward(reward: Parameters<typeof BattleApplier.applyKillReward>[0]): number { return BattleApplier.applyKillReward(reward); }
  static applyPartyExpGain(gain: Parameters<typeof BattleApplier.applyPartyExpGain>[0]): number { return BattleApplier.applyPartyExpGain(gain); }
  static applyMonsterHit(hit: { hp: number; maxHp: number }): void { BattleApplier.applyMonsterHit(hit); }
  static applyServerRoleUpdate(update: Parameters<typeof BattleApplier.applyServerRoleUpdate>[0]): void { BattleApplier.applyServerRoleUpdate(update); }
  static applyPickResult(
    placed: Parameters<typeof BattleApplier.applyPickResult>[0],
    revision: number,
  ): void { BattleApplier.applyPickResult(placed, revision); }

  // ── 背包 ──────────────────────────────────────────────────
  static async useGood(row: number, col: number): Promise<boolean> { return BagService.useGood(row, col); }
  static async equipFromBag(row: number, col: number): Promise<boolean> { return BagService.equipFromBag(row, col); }
  static async unequipToBag(slot: Parameters<typeof BagService.unequipToBag>[0]): Promise<boolean> { return BagService.unequipToBag(slot); }
  static getWornEquipment(slot: Parameters<typeof BagService.getWornEquipment>[0]) { return BagService.getWornEquipment(slot); }
  static findBetterEquipmentInBag(slot: Parameters<typeof BagService.findBetterEquipmentInBag>[0]) { return BagService.findBetterEquipmentInBag(slot); }
  static async equipBetterFromBag(slot: Parameters<typeof BagService.equipBetterFromBag>[0]): Promise<boolean> { return BagService.equipBetterFromBag(slot); }
  static getBagDiscardPreview(row: number, col: number) { return BagService.getBagDiscardPreview(row, col); }
  static async discardBagGood(row: number, col: number): Promise<boolean> { return BagService.discardBagGood(row, col); }
  static async tidyBag(): Promise<boolean> { return BagService.tidyBag(); }
  static async moveBagGood(fromRow: number, fromCol: number, toRow: number, toCol: number): Promise<boolean> { return BagService.moveBagGood(fromRow, fromCol, toRow, toCol); }
  static getBagRecycleSummary() { return BagService.getBagRecycleSummary(); }
  static async recycleBagEquipments(): Promise<boolean> { return BagService.recycleBagEquipments(); }
  static addGood(good: Parameters<typeof BagService.addGood>[0], count?: number, meta?: Parameters<typeof BagService.addGood>[2]): boolean { return BagService.addGood(good, count, meta); }
  static consumeBagGood(row: number, col: number, role?: Role) { BagService.consumeBagGood(row, col, role); }
  static async useDrug(row: number, col: number): Promise<boolean> { return BagService.useDrug(row, col); }
  static async useMoneyItem(row: number, col: number): Promise<boolean> { return BagService.useMoneyItem(row, col); }
  static async useLevelScroll(row: number, col: number): Promise<boolean> { return BagService.useLevelScroll(row, col); }

  // ── 时装 ──────────────────────────────────────────────────
  static ownsFashion(fashionId: string): boolean { return FashionService.ownsFashion(fashionId); }
  static async buyFashion(fashionId: string): Promise<boolean> { return FashionService.buyFashion(fashionId); }
  static async wearFashion(fashionId: string): Promise<boolean> { return FashionService.wearFashion(fashionId); }
  static async unwearFashion(): Promise<boolean> { return FashionService.unwearFashion(); }
  static getWornFashion() { return FashionService.getWornFashion(); }
  static getFashionWardrobe() { return FashionService.getFashionWardrobe(); }

  // ── 商城 ──────────────────────────────────────────────────
  static async buyMallGood(id: string) { return MallService.buyMallGood(id); }
  static async loadMallLimits() { return MallService.loadMallLimits(); }

  // ── 换图 ──────────────────────────────────────────────────
  static changeOnMap(mapId: Parameters<typeof MapTransition.changeOnMap>[0]) { MapTransition.changeOnMap(mapId); }
  /** 取走传送标记（Game.start 用；有效期与标记状态在 MapTransition） */
  static consumeTeleportArrival(): boolean { return MapTransition.consumeTeleportArrival(); }

  /** 更新UI */
  static updateUi(role: Role) {
    updateRoleUi(role);
  }

  /**
   * 技能升级（#828）：扣点与等级推进都在服务端
   *
   * 客户端只报「升哪个技能」+ 修订号：**报等级就等于让它跳级，报花费就等于让它定价**
   * （`当前等级` 只在服务端 `skill-upgrade.util` 里）。所以这里没有本地预检 ——
   * 点数够不够、是不是已经到顶，都由服务端的业务码回答（20035 / 20036 / 20034），
   * 请求层按码弹提示。
   *
   * 成功后照搬服务端那份 `data.skills` / `data.skillPoints`（**不本地 +1**：
   * 自增一版就会与服务端落库值漂开，下次存档被回填，表现成「刚升的级弹回去」）。
   *
   * @param skillId 要升的技能 id
   * @returns 是否升级成功（失败原因已用浮动提示告知）
   */
  static async upgradeSkillOnServer(skillId: string): Promise<boolean> {
    const role = RoleCache.findOnlineRole();
    if (!role) return false;
    const result = await withRevision(role, (revision) => RoleApi.skillUpgrade(role.id, { skillId, revision }));
    if (!result) return false; // 失败提示已由请求层弹过（非 silent 请求）
    const data = (result.data ?? {}) as Record<string, unknown>;
    if (data.skills && typeof data.skills === "object") role.skills = data.skills as Role["skills"];
    if (typeof data.skillPoints === "number") role.skillPoints = Math.max(0, Math.floor(data.skillPoints));
    // revision 已由 withRevision 壳对齐
    // 技能等级不影响面板数值（只影响下一次出手的倍率），所以不重算属性、不刷血蓝；
    // 但仍要走 updateOnlineRole：它负责落盘 + 与服务端对齐 revision
    RoleCache.updateOnlineRole(role);
    this.updateUi(role);
    GameUiHelper.createTip("label_skill_upgrade_tip", {
      // 技能名读客户端配置（`skills` Map 是快照下发的，与服务端同源）
      skill: skills.get(skillId)?.label ?? skillId,
      level: result.toLevel,
      cost: result.cost,
      remain: result.remainPoints,
    });
    return true;
  }

  /**
   * 属性加点（#833）：四维只能由服务端推进
   *
   * 一次加**一项 1 点**（界面就是四个「+」按钮，点一下加一点）：报增量而不是
   * 「加完是多少」—— 报绝对值就等于让改包直接改面板。够不够、能不能加，
   * 全由服务端的业务码回答（20037 点数不足 / 20038 一个都没加 / 20006 存档过期），
   * 请求层按码弹提示。
   *
   * 成功后照搬服务端那份 `attrs` / `attrPoints`，**并立刻刷一次面板**：
   * 四维是攻防血蓝的乘数，服务端已经在同一次写档里重算过，客户端只负责把新数字画出来。
   */
  static async allocateAttrsOnServer(key: AttrPointKey): Promise<boolean> {
    const role = RoleCache.findOnlineRole();
    if (!role) return false;
    const result = await withRevision(role, (revision) => RoleApi.attrsAllocate(role.id, { [key]: 1, revision }));
    if (!result) return false; // 失败提示已由请求层弹过（非 silent 请求）
    this.applyAttrChangeResult(role, result);
    GameUiHelper.createTip("label_attr_allocate_tip", {
      attr: getText(`label_attr_${key}`),
      points: result.attrPoints,
    });
    return true;
  }

  /**
   * 加点回执的统一收尾（见 `AttrChangeResultDto`；洗点入口已移除 #1113，回执形状不变）
   *
   * 三条都要做，缺一条就是「数值变了但界面没变」：
   * 1. 照搬四维 / 余点 / 绑定元宝（**不本地算**：扣减明细只有服务端知道）；
   * 2. 属性面板重算后的数值一起刷（`refreshRoleAttributes`）；
   * 3. 落盘 + 对齐 revision（否则下一次保存必撞 20006）。
   */
  private static applyAttrChangeResult(role: Role, result: AttrChangeResult) {
    role.attrs = attrAllocationFrom(result.attrs);
    role.attrPoints = Math.max(0, Math.floor(Number(result.attrPoints) || 0));
    const data = (result.data ?? {}) as Record<string, unknown>;
    if (typeof data.bindGold === "number") role.bindGold = Math.max(0, Math.floor(data.bindGold));
    // 面板数值（攻防 / 上限 / 战斗力 / 回血）由服务端重算，回执里在 data 上 —— 整份抄回来
    if (typeof data.maxHp === "number") role.maxHp = data.maxHp;
    if (typeof data.maxMp === "number") role.maxMp = data.maxMp;
    if (typeof data.hpRecover === "number") role.hpRecover = data.hpRecover;
    if (typeof data.combat === "number") role.combat = data.combat;
    if (Array.isArray(data.physicalAttack)) role.physicalAttack = [Number(data.physicalAttack[0]), Number(data.physicalAttack[1])];
    if (Array.isArray(data.magicAttack)) role.magicAttack = [Number(data.magicAttack[0]), Number(data.magicAttack[1])];
    if (Array.isArray(data.taoistAttack)) role.taoistAttack = [Number(data.taoistAttack[0]), Number(data.taoistAttack[1])];
    if (Array.isArray(data.physicalDefense)) role.physicalDefense = [Number(data.physicalDefense[0]), Number(data.physicalDefense[1])];
    if (Array.isArray(data.magicDefense)) role.magicDefense = [Number(data.magicDefense[0]), Number(data.magicDefense[1])];
    if (Array.isArray(data.taoistDefense)) role.taoistDefense = [Number(data.taoistDefense[0]), Number(data.taoistDefense[1])];
    // 上限降低时服务端已经夹过血蓝，这里跟着收一次，免得血条显示超过上限
    role.hp = Math.min(role.hp, role.maxHp);
    // revision 已由 withRevision 壳对齐
    RoleCache.updateOnlineRole(role);
    this.updateUi(role);
    RoleUIManager.refreshRoleAttributes();
  }

  /** 更换快捷键技能 */
  static changeShortcutKey(index: number, skillId: SkillId) {
    const role = RoleCache.findOnlineRole();
    role.shortcutKeys[index].skillId = skillId;
    RoleCache.updateOnlineRole(role);
    const skill = skills.get(skillId);
    // 释放走注入的回调（SkillManager 模块加载时注册，见 setShortcutReleaseHandler —— 破环）
    RoleUIManager.updateShortcutIcon(role.shortcutKeys[index].key, skill?.icon, () => StorageManager.shortcutReleaseHandler?.(skillId), skillId);
  }
}
