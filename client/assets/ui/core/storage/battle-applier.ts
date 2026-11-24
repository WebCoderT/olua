import { Role } from "../../../entities/Role";
import type { CombatKillReward, RoleAuthorityUpdate } from "../../utils/net/CombatChannel";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../LayerManager";
import SoundManager from "../SoundManager";
import RoleUIManager from "../RoleUIManager";
import { BagOrigin, BAG_ORIGIN_TEXT_MAX } from "../../../types/good";
import { withBagMeta } from "../../../configs/items";
import { attrAllocationFrom } from "./shared";
import RoleCache from "./role-cache";
import FashionService from "./fashion-service";
import { updateRoleUi } from "./ui-bridge";

/**
 * 服务端战斗 / 权威帧落账（#1115 批次 6 自 StorageManager 拆出）：
 * 击杀奖励 / 队友经验 / 受击 / roleUpdate 权威快照 / 拾取，全部「服务端已落账，这里只接回来演」。
 */
export default class BattleApplier {

  /**
   * 服务端击杀奖励落账（#316：经验与升级判定都在服务端，这里只把入账后的状态接回来演）
   *
   * 经验 / 等级 / 修订号直接以 reward 为准（服务端已落账，带回来的就是入账后的值，
   * 本地不再自己算「够不够升级」——那正是收权要拿掉的决定）；
   * 升级表现（属性重算 / 补满血蓝 / 特效）沿用本地习惯，只对 leveledUp 做。
   * @returns 本次入账的经验（调用方据此决定要不要飘经验字）
   */
  static applyKillReward(reward: CombatKillReward): number {
    const role = RoleCache.findOnlineRole();
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
    RoleCache.updateOnlineRole(role);
    updateRoleUi(role);
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
    const role = RoleCache.findOnlineRole();
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
    RoleCache.updateOnlineRole(role);
    updateRoleUi(role);
    return gain.exp;
  }

  /**
   * 服务端普攻受击落账（#323：玩家血量的权威在服务端，hit 帧带回的就是落账后的值）
   *
   * 血量 / 资源上限照搬服务端给的（本地不再自己扣）；revision **不变**——
   * 受击不推进修订号（否则战斗期间的防抖存档会频繁撞乐观锁），落库由服务端负责。
   */
  static applyMonsterHit(hit: { hp: number; maxHp: number }): void {
    const role = RoleCache.findOnlineRole();
    if (!role) return;
    role.hp = Math.max(0, Math.floor(hit.hp));
    if (hit.maxHp > 0) role.maxHp = hit.maxHp;
    RoleCache.updateOnlineRole(role);
    updateRoleUi(role);
  }

  /**
   * 服务端角色权威快照落账（#541：roleUpdate 帧带回的服务端重算值）
   *
   * 战斗力 / 八项属性 / 货币 / 等级血蓝**照搬不算**——这是「客户端只演」在角色数值上的落点：
   * 换装、任务/成就/邮件发奖、商城、成长线升级、后台改动、升级，全部由服务端重算后
   * 经这一帧汇合到本地。区间属性缺省（等级不在成长曲线的边角存档）时不动对应字段。
   * 成长线阶位（称号 / 战魂 / 军衔）自 #551 起也走这一帧 —— 后台改完不重进就生效。
   * 只刷新显示 + 落本地缓存、**不推服务端**：帧的内容就是服务端现状，推回去是白推还多占一个
   * 防抖节拍（`RoleCache.writeBack`，见 #1236 —— 落本地这一步不能省，缓存里那份 mp 没人别的路径更新）。
   */
  static applyServerRoleUpdate(update: RoleAuthorityUpdate): void {
    const role = RoleCache.findOnlineRole();
    if (!role) return;
    // 迟到帧守卫（#732）：帧由「行变了」触发，但 bagOp / 称号等 HTTP 应答可能先一步改了本地
    // （revision 更大）；随后才到的旧帧整帧丢弃 —— 否则战斗力 / 货币会被拉回旧值再弹回来（显示抖动）。
    // revision 相同的帧照常应用（幂等快照）；任一侧没有 revision 不设防（老服务端兼容）
    if (typeof update.revision === "number" && typeof role.revision === "number" && update.revision < role.revision) return;
    // 金钱变化音（#683）：这一帧是所有货币变化的汇合点（任务发奖 / 商城 / 回收 / 后台改动），
    // 所以只在**真的变了**的时候响 —— 每帧都响会盖过其它音效（这条帧每几秒就来一次）
    const moneyChanged = update.bindGold !== role.bindGold;
    role.level = update.level;
    role.exp = Math.max(0, Math.floor(update.exp));
    role.combat = update.combat;
    role.bindGold = update.bindGold;
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
    // 技能点（#828）：升级在实时进程结算，帧带回的就是最新余额。技能**等级**不在帧里 ——
    // 它只会被 HTTP 的升级接口改（应答里整份 data 带回来），帧再带一份就是两个来源
    if (typeof update.skillPoints === "number") role.skillPoints = Math.max(0, Math.floor(update.skillPoints));
    // 属性点与四维（#833）：同上 —— 升级给的点、另一台设备加的点，都要在这里落到本地档。
    // 四维变了面板数值会变，但**不用**在这里重算：服务端已经把重算后的攻防血蓝一起下发
    if (typeof update.attrPoints === "number") role.attrPoints = Math.max(0, Math.floor(update.attrPoints));
    if (update.attrs && typeof update.attrs === "object") role.attrs = attrAllocationFrom(update.attrs);
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
    // 写回本地缓存（#1236）：上面改的 `role` 是 `findOnlineRole()` 从 localStorage 反序列化出来的
    // 临时对象，只刷 UI 不落缓存的话，缓存里的 hp / mp 会停在上一次真落盘的时刻 —— 而打怪时
    // 蓝量每秒都在变，下一次击杀奖励 / 拾取读缓存就把旧蓝量刷上屏、一秒后被下一帧拉回。
    // **只落本地、不推服务端**：帧的内容就是服务端现状，推回去是白占一个防抖节拍
    RoleCache.writeBack(role);
    updateRoleUi(role);
    // 金钱变化音放在刷 UI 之后：先让数字变，再出声（顺序反了会有「听到声音但数字还没动」的一帧）
    if (moneyChanged) void SoundManager.play("money_change");
    // 角色信息弹窗开着的话，属性列表与战斗力一起跟上（升级/换装的面板刷新缺口在这补上）
    RoleUIManager.refreshRoleAttributes();
    if (titleChanged) RoleUIManager.updateTitleShow();
    if (soulChanged) RoleUIManager.updateSoulShow();
    if (fashionChanged) FashionService.applyFashionChange(role);
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
    const role = RoleCache.findOnlineRole();
    if (!role) return;
    for (const cell of placed) {
      const line = role.bag[cell.row];
      if (!line || cell.col < 0 || cell.col >= line.length) continue;
      line[cell.col] = withBagMeta(cell.id, cell.count, { bound: cell.bound, from: this.sanitizeOrigin(cell.from) });
    }
    role.revision = revision;
    RoleCache.updateOnlineRole(role);
    updateRoleUi(role);
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
}
