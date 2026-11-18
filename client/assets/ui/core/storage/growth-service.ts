import { Role } from "../../../entities/Role";
import { RoleApi } from "../../utils/net/Api";
import GameUiHelper from "../../helpers/GameUiHelper";
import { nextRankUpgrade, nextSoulUpgrade, nextTitleUpgrade } from "../../../configs/game-config";
import { withRevision } from "./with-revision";
import RoleCache from "./role-cache";
import { updateRoleUi } from "./ui-bridge";

/**
 * 三条成长线（称号 #248 / 战魂 #249 / 军衔 #250）的升级入口（#1115 批次 6 自 StorageManager 拆出）。
 * 扣费与阶位推进都在服务端；本地预检只做即时 UX。
 */
export default class GrowthService {

  /**
   * 三条成长线（称号 #248 / 战魂 #249 / 军衔 #250）共用的服务端升级流程
   *
   * **扣费与阶位推进都在服务端**（role.growthUpgrade）：客户端只报「哪条线、升到哪阶」，
   * 服务端按库里的成长链算下一阶并校验目标一致，扣绑定元宝后原子推进。
   * 本地预检（上一层的 max / 绑定元宝不足提示）只做即时 UX —— 服务端结果才是权威，
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
    const result = await withRevision(role, (revision) => RoleApi.growthUpgrade(role.id, { kind, targetLevel: nextLevel, revision }));
    if (!result) return false; // 失败提示已由请求层弹过（非 silent 请求）
    const data = result.data as Record<string, unknown>;
    role.bindGold = Number(data.bindGold ?? role.bindGold);
    if (kind === "title") role.title = Number(data.title ?? nextLevel);
    else if (kind === "soul") role.soulOfWar = Number(data.soulOfWar ?? nextLevel);
    else role.rank = Number(data.rank ?? nextLevel);
    // revision 已由 withRevision 壳对齐（下一次落盘不会撞乐观锁）
    // 属性与战斗力不再本地重算（#541 服务端权威）：升级接口已成功 = 服务端在线，
    // 权威值正由 roleUpdate 帧在路上（服务端已重算落库，轮询下一个节拍就推）
    RoleCache.updateOnlineRole(role);
    updateRoleUi(role);
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
    const role = RoleCache.findOnlineRole();
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
    return GrowthService.upgradeGrowthOnServer(role, "soul", next.level, "soul_upgrade_tip");
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
    const role = RoleCache.findOnlineRole();
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
    return GrowthService.upgradeGrowthOnServer(role, "title", next.level, "title_upgrade_tip");
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
    const role = RoleCache.findOnlineRole();
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
    return GrowthService.upgradeGrowthOnServer(role, "rank", next.level, "rank_upgrade_tip");
  }
}
