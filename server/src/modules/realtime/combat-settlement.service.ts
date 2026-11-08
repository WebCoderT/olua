import { Injectable, Logger } from "@nestjs/common";
import { bindOnDropOf, growthScalarOf, itemTypeOf, skillOf } from "../../common/runtime-config-cache";
import { BizCode } from "../../common/constants/biz-code";
import { ATTACK_ATTRIBUTES, DEFENSE_BY_ATTACK, MONSTER_STAT_COLUMN, type AttackAttribute } from "../../common/constants/game-enums";
import { BizException } from "../../common/errors/biz.exception";
import { AccountRepository } from "../../database/repositories/account.repository";
import { DropTableRepository } from "../../database/repositories/drop-table.repository";
import { GrowthRepository } from "../../database/repositories/growth.repository";
import { MonsterDropRepository } from "../../database/repositories/monster-drop.repository";
import { MonsterRepository } from "../../database/repositories/monster.repository";
import { RuntimeParamsRepository } from "../../database/repositories/runtime-params.repository";
import { MonsterRow } from "../../database/rows";
import { roleAttributeSourceOf, summarizeRoleAttributes } from "../combat/role-attributes";
import { RolesService } from "../roles/roles.service";
import type { BagOrigin } from "../roles/role-inventory";
import { GameEventsService } from "../../common/events/game-events.service";
import { PartyService } from "../party/party.service";
import { WorldService } from "../world/world.service";
import { MapMonitorService } from "./map-monitor.service";
import { MonsterAiService } from "./monster-ai.service";
import { PlayerPresenceService } from "./player-presence.service";
import { CastGuardService } from "./cast-guard.service";
import type { RealtimeKillReward, RealtimePickedData, RealtimeSettleData } from "./realtime.protocol";

/**
 * 伤害结算（#34：客户端发指令，服务端算结果）
 *
 * ===========================================================================
 * 这条服务做什么
 * ===========================================================================
 * 客户端不再自己决定伤害：出手经实时通道送上来，这里按**服务端自己的属性表**算出
 * 一次出手的伤害与目标剩余血量，把结果发回去 —— 客户端只负责把数字演出来。
 *
 * 输入的每一项都来自服务端那份权威：
 * - 攻击者的六项攻防区间：`summarizeRoleAttributes`（#29/#30 的产物，对齐客户端 combatCalc，
 *   素材来自生成物的等级 / 装备 / 战魂 / 称号 / 军衔表）；
 * - 目标（怪物）：**世界服务持有的实例**（#35 起）—— 身份由服务端发牌（`worldJoin` 的
 *   instanceId），血量 / 存活都在那里；战斗数值来自 monsters 表（#258 起后台可改，即时生效）；
 * - 技能倍率：`skillOf`（先查运营库覆盖层，没改过用生成物 `SKILLS`；`damageCoefficients`
 *   下标 = 技能等级）—— #544 起管理端改技能数值对结算即时生效。
 *
 * ===========================================================================
 * 目标状态的归属（#35 之后的边界）
 * ===========================================================================
 * 怪物的血量 / 存活**只在世界服务里**（tick 负责重生、SQLite 负责持久化）——
 * 本服务不再自留一份账号维度的登记簿（#34 的过渡形态已删）：两份血量必然漂移。
 * 这里只保留**幂等账**（castId → 上次结果），它是每账号的会话状态，与世界无关。
 *
 * 击杀奖励（经验 + 掉落）也在这里结算（#316）：经验入账走存档服务（RolesService.applyKillExp），
 * 掉落读 monster_drops / drop_tables 表抽取，结果以 settle 帧的 `reward` 发回 ——
 * 客户端只负责演（经验飘字、升级表现、地面掉落物），不再自己决定掉什么、给多少经验。
 * 怪打人已由服务端的怪物 AI 结算（#323 起在 `MonsterAiService.attack`，走 `RolesService.applyMonsterHit`），
 * 客户端不再有本地伤害路径（#670 删掉了最后那一份 `MonsterAI.hitPlayer`）。
 *
 * ===========================================================================
 * 幂等
 * ===========================================================================
 * 同一 `castId` 的重复投递（网络重传 / 客户端重发）**不重复结算**：每个账号记最近
 * `CAST_DEDUPE_CAPACITY` 次结果，重复的原样重发（`duplicate: true`），血量不会扣两次。
 * 序号由客户端按会话单调递增生成；断线重连 / 换图（worldJoin）后清掉旧账重新计数。
 */
@Injectable()
export class CombatSettlementService {
  private readonly logger = new Logger(CombatSettlementService.name);

  /** 每个账号最近的结算结果（castId → 结果，幂等重发用） */
  private readonly recentSettles = new Map<string, Map<number, RealtimeSettleData>>();

  /**
   * 掉落账本（#325）：账号 → castId → 该次击杀的掉落条目（picked 标记是否已拾）
   *
   * settle 帧的 reward 只发给击杀者本人 —— 别的账号既看不到这份掉落也没有账可查，
   * 归属校验因此天然成立（伪造的 castId 在这里查不到账）。账目随幂等账一起清理
   * （换图 / 断线），容量与幂等账同一上限：掉落长期不拾本来就该消失，内存不能陪它涨。
   */
  private readonly dropLedgers = new Map<string, Map<number, DropLedgerEntry[]>>();

  constructor(
    private readonly roles: RolesService,
    private readonly world: WorldService,
    private readonly monsterAi: MonsterAiService,
    private readonly monsterConfigs: MonsterRepository,
    private readonly accounts: AccountRepository,
    private readonly monsterDrops: MonsterDropRepository,
    private readonly dropTables: DropTableRepository,
    private readonly growth: GrowthRepository,
    private readonly events: GameEventsService,
    private readonly party: PartyService,
    private readonly presence: PlayerPresenceService,
    private readonly monitor: MapMonitorService,
    /** 出手判定链（#813：存活 / 跨图 / 距离 / 冷却 / 耗蓝 / 频率） */
    private readonly guard: CastGuardService,
    /** 掉落参数（#789：随机绑定概率）。与怪物数值同一取向 —— 现读库，管理端改完下一刀生效 */
    private readonly runtimeParams: RuntimeParamsRepository,
  ) {}

  /** 结算一次出手（结果直接作为 settle 帧的 data 发回） */
  settle(accountId: string, raw: unknown): RealtimeSettleData {
    const cast = parseCast(raw);
    if (!cast) {
      return { castId: extractCastId(raw), ok: false, code: "bad_request", message: "cast 消息缺 castId / skillId / targetId / monsterKey" };
    }

    // 幂等：同一 castId 原样重发，不重复结算
    const previous = this.recentSettles.get(accountId)?.get(cast.castId);
    if (previous) {
      return previous.ok ? { ...previous, duplicate: true } : previous;
    }

    const result = this.settleNew(accountId, cast);
    this.remember(accountId, cast.castId, result);
    return result;
  }

  /**
   * 清掉本账号的幂等账与掉落账本（世界状态不受影响）
   *
   * 两个调用方：`worldJoin` 放行时服务端**自己**调（#817：换图清账不能依赖客户端消息），
   * 以及客户端发来的 `targetsReset`（旧客户端 / 主动清，双保险）。
   */
  resetTargets(accountId: string): void {
    this.recentSettles.delete(accountId);
    // 掉落账本随之清：换图后旧图的掉落不再可拾（客户端换图也会清掉地面掉落物）
    this.dropLedgers.delete(accountId);
  }

  /** 连接断开：清幂等账（世界状态是共享的，不随任何账号的连接断开而清） */
  dropAccount(accountId: string): void {
    this.recentSettles.delete(accountId);
    this.dropLedgers.delete(accountId);
    // 判定链的进程内状态一起清（#813）：冷却与令牌桶是「这条会话的节奏」，人走了就不必留着
    this.guard.dropAccount(accountId);
  }

  /**
   * 拾取一次击杀的掉落（#325：账本校验 + 格子级入包，都在这里编排）
   *
   * 流程：账本里找到那条掉落 → 已拾过的幂等应答 → 没拾过的交给 RolesService.pickDrop
   * 入包 → 入包成功才在账本上标记已拾。**标记放在入包成功之后**：背包满被拒时地面
   * 掉落物必须还在，玩家腾出格子后同一 castId/index 可以再拾。
   *
   * ## 两道归属闸
   *
   * - **跨图**（#817）：账本按账号存、`worldJoin` 放行时整份清掉 —— 换图后旧图的 castId
   *   查不到条目，直接 `unknown_drop`。清账由**服务端**在 join 时做，不看客户端发不发
   *   `targetsReset`（那条消息改包就能省掉）。
   * - **距离**：暂时不校验，等 #811 —— 账本里没有记掉落点坐标，而角色坐标是客户端 4Hz
   *   自报的（`PlayerPresenceService` 的最小仲裁不是权威，客户端还按碰撞盒边缘算），
   *   拿它当准入会大面积误伤，与技能距离闸（`cast-guard.service.ts` 第三道）同一处境。
   *   **重开条件**：账本补 `mapId` + 掉落点坐标，且 #811 把位置源收口之后接距离闸；
   *   拒绝码沿用这里已有的 `code` 风格（新增 `too_far`），不新增帧类型。
   */
  pickDrop(accountId: string, castId: number, index: number): RealtimePickedData {
    const fail = (code: string, message: string): RealtimePickedData => ({ castId, index, ok: false, code, message });

    const ledger = this.dropLedgers.get(accountId)?.get(castId);
    const entry = ledger && index >= 0 && index < ledger.length ? ledger[index] : undefined;
    if (!entry) return fail("unknown_drop", `找不到这次掉落（castId=${castId} 第 ${index} 件）：不存在、已随会话清理或不属于你`);
    if (entry.picked) {
      const revision = this.roles.onlineRevision(accountId);
      return revision === null
        ? fail("no_role", "当前没有在线角色，无法拾取")
        : { castId, index, ok: true, revision, placed: [], alreadyPicked: true };
    }

    try {
      const result = this.roles.pickDrop(accountId, entry.goodId, entry.count, { bound: entry.bound, from: entry.from });
      entry.picked = true;
      return { castId, index, ok: true, revision: result.revision, placed: result.placed, alreadyPicked: false };
    } catch (error) {
      // 业务拒绝（背包满 / 角色被踢等）转成 picked 错误帧 —— 连接不断，地面掉落物保留
      if (error instanceof BizException) {
        const code = error.code === BizCode.MALL_BAG_FULL
          ? "bag_full"
          : error.code === BizCode.ROLE_KICKED
            ? "role_kicked"
            : error.code === BizCode.ROLE_NOT_FOUND
              ? "no_role"
              : "pick_failed";
        return fail(code, error.message);
      }
      throw error;
    }
  }

  //#region 内部实现

  /**
   * 状态型技能（`category = "2"`）：不掷伤害，只给自己挂状态（#822 / docs/22 A4）
   *
   * 走这条分支的技能（当前配置里是 1010 护体神盾、1011 金刚护体）以前会被当伤害技能结算 ——
   * `damageCoefficients` 对状态技能来说是**无意义的遗留数据**（配置里抄了 3.0 倍），
   * 于是「护体神盾」成了 300% 核弹、玩家的 buff 一次都没落地。
   *
   * 与伤害分支的差别只有三点：不查目标、不掷骰、不碰世界状态；六道闸里跟目标无关的
   * 四道（存活 / 冷却 / 耗蓝 / 频率）照走 —— 状态技能同样能被改包连放。
   *
   * `settle` 回执带 `statusOnly: true` 与整份 `statuses`：客户端据此重建图标栏，
   * **不要**再去读 `damage` / `hp`（那里是 0 占位，不代表任何血量变化）。
   */
  private castStatusSkill(accountId: string, cast: ParsedCast, skill: Record<string, unknown>): RealtimeSettleData {
    const fail = (code: string, message: string): RealtimeSettleData => ({ castId: cast.castId, ok: false, code, message });

    const role = this.roles.online(accountId);
    if (!role) return fail("no_role", "当前没有在线角色，无法结算");
    const skillLevel = readSkillLevel(role.data, cast.skillId);
    if (!skillLevel) return fail("skill_not_learned", `技能 ${cast.skillId} 尚未学习`);

    const statusId = typeof skill.statusId === "string" ? skill.statusId : "";
    if (!statusId) return fail("bad_request", `技能 ${cast.skillId} 是状态型，但配置里没有 statusId`);

    const verdict = this.guard.guard({ accountId, skill, skillId: cast.skillId, roleData: role.data ?? {} });
    if (!verdict.ok) {
      return {
        castId: cast.castId,
        ok: false,
        code: verdict.rejected,
        message: verdict.message,
        rejected: verdict.rejected,
        ...(verdict.remainMs === undefined ? {} : { remainMs: verdict.remainMs }),
        ...(verdict.need === undefined ? {} : { need: verdict.need }),
        ...(verdict.have === undefined ? {} : { have: verdict.have }),
      };
    }

    const statuses = this.roles.applyStatusToOnlineRole(accountId, statusId, cast.skillId);
    // null = 配置里没这个状态 / 持续时间配成 0：运营配错要当场报出来，不能静默放行
    // （静默的后果是「放了技能什么都不发生」，玩家只会以为技能坏了）
    if (!statuses) return fail("bad_request", `状态 ${statusId} 不存在或持续时间为 0（检查 statuses 表）`);

    this.logger.debug(`状态技能：账号 ${accountId} 技能 ${cast.skillId}(Lv${skillLevel}) → 状态 ${statusId}`);
    return {
      castId: cast.castId,
      ok: true,
      skillId: cast.skillId,
      targetId: cast.targetId,
      damage: 0,
      hp: 0,
      maxHp: 0,
      killed: false,
      duplicate: false,
      statusOnly: true,
      appliedStatus: statusId,
      statuses,
    };
  }

  private settleNew(accountId: string, cast: ParsedCast): RealtimeSettleData {
    const fail = (code: string, message: string): RealtimeSettleData => ({ castId: cast.castId, ok: false, code, message });

    // 技能：存在 + 已学习 + 该等级有伤害系数（先查运营库覆盖层，没改过就是出厂值）
    const skill = skillOf(cast.skillId);
    if (!skill) return fail("unknown_skill", `技能不存在：${cast.skillId}`);

    // 状态型技能（`category = "2"`）**先分流**（#822）：它不掷伤害、不查目标，只给自己挂状态。
    // 这条判断必须放在目标校验之前 —— 护体神盾 / 金刚护体是自身 buff（`require_target = 0`），
    // 客户端送来的目标本来就是空的，走「目标存在」那套会被 unknown_target 拦掉。
    // 分流之后它仍然过六道闸里跟目标无关的四道（存活 / 冷却 / 耗蓝 / 频率）。
    if (String(skill.category ?? "") === "2") return this.castStatusSkill(accountId, cast, skill);

    // 伤害型技能必须有目标（状态型已经在上面分流走了）
    if (!cast.targetId || !cast.monsterKey) return fail("bad_request", `技能 ${cast.skillId} 需要目标（targetId / monsterKey 不能为空）`);

    // 目标：战斗数值表里要有这只怪，世界里要有这只实例（instanceId 由服务端发牌，
    // 伪造的 / 已被卸载图的一律 unknown_target），且 key 与实例登记的一致。
    // 区归属也要对上（#295 阶段二）：instanceId 带区段但毕竟可猜测，
    // 拿别的区的实例 id 来打必须拒绝 —— 目标区和攻击者账号当前区是同一区才放行。
    // 直读 monsters 表（#258）：管理端改了数值即时生效，不经快照不经缓存
    const stats = this.monsterConfigs.findByKey(cast.monsterKey);
    if (!stats) return fail("unknown_target", `目标怪物不存在：${cast.monsterKey}`);
    const target = this.world.find(cast.targetId);
    if (!target) return fail("unknown_target", `目标实例不存在：${cast.targetId}`);
    if (target.monsterKey !== cast.monsterKey) {
      return fail("unknown_target", `目标 ${cast.targetId} 是怪物 ${target.monsterKey}，与本次的 ${cast.monsterKey} 不符`);
    }
    const attackerZone = this.accounts.findById(accountId)?.zone_id ?? 1;
    if (target.zoneId !== attackerZone) {
      return fail("unknown_target", `目标 ${cast.targetId} 不在你所在的世界里`);
    }
    if (!target.alive) return fail("target_dead", `目标 ${cast.targetId}（${cast.monsterKey}）已死亡`);

    // 角色：在线角色 + 等级可汇总 + 技能已学习
    const role = this.roles.online(accountId);
    if (!role) return fail("no_role", "当前没有在线角色，无法结算");
    // RoleDto 顶层数据在 `data` 里，必须摊平后再汇总 —— 直接传 DTO 只会按裸等级算（装备/成长线全丢）
    const summary = summarizeRoleAttributes(roleAttributeSourceOf(role.level, role.data));
    if (!summary) return fail("no_role", `角色等级 ${role.level} 不在成长曲线里，算不出属性`);
    const skillLevel = readSkillLevel(role.data, cast.skillId);
    if (!skillLevel) return fail("skill_not_learned", `技能 ${cast.skillId} 尚未学习`);
    const coefficient = readDamageCoefficient(skill, skillLevel);
    if (coefficient === null) return fail("bad_request", `技能 ${cast.skillId} 等级 ${skillLevel} 没有伤害系数`);

    // 判定链六道闸（#813 / A1）：存活 → 跨图 → 距离 → 冷却 → 耗蓝 → 频率。
    // 位置在「配置与目标都对上」之后、掷随机数之前：前面任何一步失败都不该记冷却 / 扣令牌，
    // 而伤害一旦掷了骰子就没法回滚。闸的副作用（扣蓝、记冷却、扣令牌）在它内部最后一步统一提交。
    const targetSpot = this.monsterAi.livePositionOf(cast.targetId) ?? { x: target.x, y: target.y };
    const verdict = this.guard.guard({
      accountId,
      skill,
      skillId: cast.skillId,
      roleData: role.data ?? {},
      target: { mapId: target.mapId, x: targetSpot.x, y: targetSpot.y },
    });
    if (!verdict.ok) {
      // `code` 是老字段（一直存在），`rejected` 是 A3 的六道闸分类；闸拒绝时两者同值。
      // remainMs / need / have 是给客户端做表现用的附带字段（缺了也不影响判定）
      return {
        castId: cast.castId,
        ok: false,
        code: verdict.rejected,
        message: verdict.message,
        rejected: verdict.rejected,
        ...(verdict.remainMs === undefined ? {} : { remainMs: verdict.remainMs }),
        ...(verdict.need === undefined ? {} : { need: verdict.need }),
        ...(verdict.have === undefined ? {} : { have: verdict.have }),
      };
    }

    // 伤害公式与客户端 BattleMath.calcSkillDamage 同一口径：
    //   round(攻击区间随机值 × 倍率 − 防御区间随机值)，下限 0
    // 攻击用哪项属性以**生成物里系数的 baseType** 为准（不信任客户端传参），防御按同名映射取
    // 玩家身上的状态修正（#822）：攻击倍率乘在出伤上，与受击侧的防御倍率同一个来源
    const attack = rollRange(readRange(summary, coefficient.baseType)) * this.roles.statusModifiersOf(accountId).attackMultiplier;
    // 怪物身上的状态修正（#372）：防御 × 状态连乘 —— 没有这条，「硬化皮肤」只是客户端动画
    const defense = Math.round(rollRange(monsterDefenseRange(stats, coefficient.baseType)) * this.monsterAi.defenseMultiplierOf(cast.targetId));
    const damage = Math.max(0, Math.round(attack * coefficient.baseTypeRate - defense));

    // 扣血与世界状态（血量 / 死亡判定都在世界服务里，这里只拿结果演）
    const applied = this.world.applyDamage(cast.targetId, damage);
    if (!applied) return fail("target_dead", `目标 ${cast.targetId}（${cast.monsterKey}）已死亡`);

    // 怪物 AI（#323）：打伤 = 被动怪记恨这次出手的人（AI 收权后追击由服务端驱动）；
    // 击杀则清掉它的 AI 运行时（重生回出生点按新一轮游走开始）
    //
    // 死亡点要在清运行时**之前**取（#665 实时地图监控）：AI 运行时一删，这只怪「倒在哪」
    // 就只剩出生点了；取不到（图没人看 / AI 还没跑过）退回出生点，那是服务端唯一稳定的坐标。
    // 同一次取到的坐标也是「这一下打在哪」—— 伤害日志用它标点（#745）。
    // 取值在闸之前就做了（距离闸要用同一份坐标），这里直接复用，避免两次读到不同的位置
    const hitSpot = targetSpot;

    const deathSpot = applied.killed ? hitSpot : null;
    /** 这一下把怪推开了多远（#670；击杀时不推，所以默认 0） */
    let pushDistance = 0;

    // 击杀奖励（#316）：经验入账与掉落抽取都在服务端 —— 经验入账失败（打到一半被踢等）
    // 只跳过 reward，不回滚这次击杀：世界状态是权威，经验少记一笔可接受
    let reward: RealtimeKillReward | undefined;
    if (applied.killed) {
      reward = this.settleKillReward(accountId, role.id, role.level, role.revision, stats, cast.monsterKey, this.roleNameOf(role));
      // 击杀计数（#400）：排行榜的原料。与经验分开记 —— 等级差过大时经验为 0，但这一杀算数
      this.roles.recordKill(role.id);
      // 掉落记账（#325）：只在新结算路径记 —— 幂等重发走 recentSettles 原样重放，不重复入账
      this.rememberDrops(accountId, cast.castId, reward.drops, {
        killerName: this.roleNameOf(role),
        monsterKey: cast.monsterKey,
      });
      // 击杀事件（#401 起走总线）：任务进度与成就进度都是订阅方，各自兜异常 ——
      // 任何一方写库失败都不回滚这次击杀（世界状态是权威，少记一笔进度可接受）
      this.events.emit("monster:killed", {
        accountId,
        roleId: role.id,
        monsterKey: cast.monsterKey,
        monsterLabel: stats.label,
        monsterTier: stats.tier,
      });
      // 实时地图监控（#665）：这条文字（谁在哪打死了什么、掉了什么、几时刷新）给管理端看。
      // 只在这一条「新结算」路径记 —— 幂等重发在上面早退，不会重复记两条。
      if (deathSpot) {
        this.monitor.recordKill({
          instanceId: cast.targetId,
          monsterKey: cast.monsterKey,
          label: stats.label,
          zoneId: target.zoneId,
          mapId: target.mapId,
          x: deathSpot.x,
          y: deathSpot.y,
          killer: this.roleNameOf(role),
          drops: reward.drops,
          respawnAt: target.respawnAt ?? Date.now(),
        });
      }
      // AI 运行时清场 + 击杀事件广播（#689）：奖励结算完才清（kill 事件要带 drops），
      // 同图观看者的下一拍 monster-ai 帧会带上，别人的屏幕据此清场与铺掉落。
      // 幂等重发走 recentSettles 早退，不会重复广播。
      this.monsterAi.onMonsterKilled(cast.targetId, {
        zoneId: target.zoneId,
        mapId: target.mapId,
        accountId,
        x: deathSpot?.x ?? target.x,
        y: deathSpot?.y ?? target.y,
        drops: reward.drops,
      });
    } else {
      this.monsterAi.provoke(cast.targetId, accountId);
      // 技能击退（#670）：位移只能由服务端产生 —— 客户端推一下只在本机生效，同图其他人
      // 看到的怪还在原地，落点就已经不一致了。方向（施法者 → 怪）与时长都由 AI 侧决定，
      // 这里只给「推多远」（`skills.push_distance`，管理端可改）。
      pushDistance = Number(skill.pushDistance) || 0;
      if (pushDistance > 0) this.monsterAi.applyPush(cast.targetId, accountId, pushDistance);
    }

    // 实时地图监控（#745）：一次伤害一行 —— 「谁、用什么、打了多少、怪还剩多少」。
    // 数字全部来自这次结算本身（不是两次快照差分）：差分只能说「掉了血」，
    // 说不出是谁打的、用什么打的、这一下多少，而管理端要的正是这几件事。
    this.monitor.recordDamage({
      instanceId: cast.targetId,
      monsterKey: cast.monsterKey,
      label: stats.label,
      zoneId: target.zoneId,
      mapId: target.mapId,
      x: hitSpot.x,
      y: hitSpot.y,
      attacker: this.roleNameOf(role),
      skillId: cast.skillId,
      skillLabel: String(skill.label ?? ""),
      amount: damage,
      hpAfter: applied.hp,
      maxHp: target.maxHp,
      killed: applied.killed,
      pushDistance,
    });

    // 玩家动作事件（#693）：观看者据此播「他出手了」的攻击/技能动画 —— settle 只回出手者
    // 本人，不记这条，别人的屏幕上他永远站着发呆。普攻与技能同一形状（普攻也是技能）。
    // 只在新结算路径记 —— 幂等重发在上面早退，不会重复广播。
    this.presence.recordAction(target.zoneId, target.mapId, { accountId, skillId: cast.skillId, targetId: cast.targetId });

    this.logger.debug(
      `结算：账号 ${accountId} 技能 ${cast.skillId}(Lv${skillLevel}) → 目标 ${cast.targetId}(${cast.monsterKey}) 伤害 ${damage}，血量 ${applied.hp}/${target.maxHp}${applied.killed ? "，击杀" : ""}${reward ? `，经验 +${reward.exp}，掉落 ${reward.drops.length} 种` : ""}`,
    );

    const ok: RealtimeSettleData = {
      castId: cast.castId,
      ok: true,
      skillId: cast.skillId,
      targetId: cast.targetId,
      damage,
      hp: applied.hp,
      maxHp: target.maxHp,
      killed: applied.killed,
      duplicate: false,
      // 状态快照（#822）：出伤不改变自己的状态，但顺手带上 —— 客户端只有这一条通道能刷新图标，
      // 缺了它「状态到期后图标还在」就只能靠本地倒计时硬撑
      statuses: this.roles.statusSnapshotOf(accountId),
    };
    return reward ? { ...ok, reward } : ok;
  }

  /**
   * 结算一次击杀的奖励（经验入账 + 掉落抽取，都在服务端）
   *
   * 经验公式与客户端 configs/level.getKillExp 同一口径：
   *   同级 = (怪物等级 + 1) × expGain.expPerLevel，等级差线性衰减，差 ≥ expGain.maxLevelGap 无经验。
   * 标量读 **growth_scalars 表**（#256 管理端可改，即时生效），读不到退回生成物 seed 值；
   * 怪物等级来自 monsters 表行（#258 起结算直读库）。
   */
  private settleKillReward(
    accountId: string,
    roleId: string,
    roleLevel: number,
    roleRevision: number,
    stats: MonsterRow,
    monsterKey: string,
    killerName: string,
  ): RealtimeKillReward {
    const exp = this.killExpFor(roleLevel, stats.level);
    // 无经验（等级差过大）不入账不推 revision；有经验但落账失败（打到一半被踢）跳过奖励
    const applied = exp > 0 ? this.roles.applyKillExp(accountId, roleId, exp) : null;
    if (exp > 0 && !applied) {
      this.logger.warn(`击杀奖励入账失败：账号 ${accountId} 角色 ${roleId}（可能已被下线），本次经验 ${exp} 未记`);
      return { exp: 0, level: roleLevel, expNow: 0, expNeed: 0, leveledUp: false, revision: roleRevision, drops: [] };
    }
    // 队友分成（#399）：与击杀者的入账分开走 —— 击杀者那份照旧全额，
    // 队友那份按他自己的等级差算，失败也不该影响击杀者的这一笔
    this.sharePartyExp(accountId, roleId, stats.level, killerName);
    return {
      exp,
      level: applied ? applied.level : roleLevel,
      expNow: applied ? applied.expNow : 0,
      expNeed: applied ? applied.expNeed : 0,
      leveledUp: applied ? applied.leveledUp : false,
      revision: applied ? applied.revision : roleRevision,
      drops: this.rollDrops(monsterKey),
    };
  }

  /**
   * 队友经验分成（#399）
   *
   * 规则（写进 #399 认领留言的第 4 条）：**同图在线的队友**每人得
   * `floor(killExp(他自己的等级, 怪物等级) × PARTY_EXP_MATE_SHARE)`，击杀者拿全额。
   *
   * - 不均分：击杀者不该因为带人变慢（那会让「组队」变成一种惩罚）；
   * - 不加成：加成会引出「多开小号刷经验」，而这一刀没有反多开的机制；
   * - 队友那份走**他自己的等级差**：高等级带小号打高级怪时，小号对那只怪的基数是 0，
   *   乘任何比例还是 0 —— 拉小号这件事被公式本身挡住，不需要另加规则；
   * - 离线 / 不同图 / 等级差过大的队友**不发帧**（没有经验可演），也不写库。
   */
  private sharePartyExp(killerAccountId: string, killerRoleId: string, monsterLevel: number, killerName: string): void {
    const share = this.party.expMateShare();
    if (share <= 0) return;
    const mapId = this.presence.identityOf(killerAccountId)?.mapId ?? "";
    const mates = this.party.sameMapMates(killerRoleId, mapId);
    if (mates.length === 0) return;
    for (const mate of mates) {
      const role = this.roles.online(mate.accountId);
      // 在线角色不是他（切角色 / 连接还没换过来）就跳过：入账必须落在**当前在线角色**上
      if (!role || role.id !== mate.roleId) continue;
      const gain = Math.floor(this.killExpFor(role.level, monsterLevel) * share);
      if (gain <= 0) continue;
      const applied = this.roles.applyKillExp(mate.accountId, mate.roleId, gain);
      if (!applied) continue;
      this.party.notifyExpGain(mate.accountId, {
        exp: gain,
        level: applied.level,
        expNow: applied.expNow,
        expNeed: applied.expNeed,
        leveledUp: applied.leveledUp,
        // revision 一并给：队友客户端照搬做新基线，否则下一次防抖存档会撞乐观锁（20006）
        revision: applied.revision,
        from: { roleId: killerRoleId, username: killerName },
      });
    }
  }

  /** 击杀者的显示名（`from` 字段用；取不到就空串，客户端飘字会退化成「队友击杀」） */
  private roleNameOf(role: { data?: Record<string, unknown> }): string {
    const name = role?.data?.name;
    return typeof name === "string" ? name : "";
  }

  /** 击杀经验（与客户端 getKillExp 同口径；角色与怪物等级差为绝对值） */
  private killExpFor(roleLevel: number, monsterLevel: number): number {
    const perLevel = this.scalarNumber("expGain.expPerLevel");
    const maxGap = this.scalarNumber("expGain.maxLevelGap");
    const gap = Math.abs(roleLevel - monsterLevel);
    if (gap >= maxGap) return 0;
    return Math.max(1, Math.round((monsterLevel + 1) * perLevel * (1 - gap / maxGap)));
  }

  /**
   * 成长标量（`growth_scalars` 表即时生效）
   *
   * 现读库优先（管理端改完下一笔结算就认），读不到再取启动时装载的那一份。
   * 两处都没有 = 没配 → 0（`maxLevelGap = 0` 会让所有击杀都不给经验，是显眼的坏配置，
   * 不会像「悄悄用一个代码里的常数」那样被忽略）。
   */
  private scalarNumber(key: string): number {
    const fromDb = Number(this.growth.findScalar(key)?.value);
    if (Number.isFinite(fromDb) && fromDb > 0) return fromDb;
    return growthScalarOf(key) ?? 0;
  }

  /**
   * 抽取一次掉落（读库：monster_drops → drop_tables，管理端改值即时生效）
   *
   * 三选一与 #254 管理端语义一致：table = 引用具名表（行内 picks 可覆盖件数）、
   * entries = 内联条目池、none/缺行 = 兜底表 default。抽取算法与客户端 DropRoller
   * 同一口径：权重随机（可重复命中）、命中后再过概率、数量取区间随机、同物品合并。
   *
   * **绑定判定（#789）**在每个条目上单独做，三条规则按「先硬后软」：
   * 1. 物品侧 `bind_on_drop` 为真 → 绑定；
   * 2. 怪物侧 `monster_drops.bind_drops` 为真 → 绑定（这只怪掉什么都绑）；
   * 3. 两个都不为真 → 按 `drop_params.bindChance`（百分比）掷一次。
   * 判定放在抽取这一侧而不是拾取那一侧：同一次击杀的同一份掉落，掉落账本与
   * 客户端拿到的 reward 必须说同一件事，拾取时再算一次就可能前后不一致。
   */
  private rollDrops(monsterKey: string): Array<{ goodId: string; count: number; bound: boolean }> {
    const row = this.monsterDrops.findByKey(monsterKey);
    let table: { picks: number | [number, number]; entries: DropEntryRow[] } | null = null;
    if (row && row.source === "table" && row.table_id) {
      const referenced = this.dropTables.findByKey(row.table_id);
      if (referenced) {
        table = {
          picks: row.picks ? JSON.parse(row.picks) : JSON.parse(referenced.picks),
          entries: JSON.parse(referenced.entries),
        };
      }
    } else if (row && row.source === "entries" && row.entries) {
      table = { picks: row.picks ? JSON.parse(row.picks) : 1, entries: JSON.parse(row.entries) };
    } else {
      const fallback = this.dropTables.findByKey("default");
      table = fallback ? { picks: JSON.parse(fallback.picks), entries: JSON.parse(fallback.entries) } : null;
    }
    if (!table) return [];
    const monsterBind = row?.bind_drops === 1;
    const bindChance = this.dropBindChance();
    return rollDropTable(table).map((drop) => ({
      ...drop,
      bound: monsterBind || bindOnDropOf(drop.goodId) || Math.random() * 100 < bindChance,
    }));
  }

  /**
   * 随机绑定概率（百分比 0~100，读 `runtime_params.drop_params.bindChance`）
   *
   * 缺键 / 坏值 → 0（不随机绑定）：绑定会限制交易，配漏了就该「不生效」而不是
   * 「所有掉落都被锁」，前者只是少一个玩法，后者是玩家集体投诉。
   */
  private dropBindChance(): number {
    const raw = this.runtimeParams.get()?.drop_params;
    if (!raw) return 0;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return 0;
      const value = Number((parsed as Record<string, unknown>).bindChance);
      if (!Number.isFinite(value)) return 0;
      return Math.min(100, Math.max(0, value));
    } catch {
      return 0;
    }
  }

  /** 记住一次结算结果（每账号限量，超出挤掉最旧的） */
  private remember(accountId: string, castId: number, result: RealtimeSettleData): void {
    let book = this.recentSettles.get(accountId);
    if (!book) {
      book = new Map<number, RealtimeSettleData>();
      this.recentSettles.set(accountId, book);
    }
    if (book.size >= CAST_DEDUPE_CAPACITY) {
      const oldest = book.keys().next().value;
      if (oldest !== undefined) book.delete(oldest);
    }
    book.set(castId, result);
  }

  /**
   * 记住一次击杀的掉落（#325；容量与幂等账同一上限，超出挤掉最旧的一次击杀）
   *
   * #789 起账本条目多两件事：**绑定**（拾取时原样写进背包格子）与**溯源**（谁杀的 /
   * 哪个怪 / 什么时候）。溯源只给装备 —— 用户口径是「只有装备会溯源，其他物品只按是否
   * 绑定分成两种」，一堆药记「谁掉的」没有意义，而且会让存档无谓变大。
   */
  private rememberDrops(accountId: string, castId: number, drops: Array<{ goodId: string; count: number; bound: boolean }>, origin: KillOrigin): void {
    if (!drops.length) return;
    let book = this.dropLedgers.get(accountId);
    if (!book) {
      book = new Map<number, DropLedgerEntry[]>();
      this.dropLedgers.set(accountId, book);
    }
    if (book.size >= CAST_DEDUPE_CAPACITY) {
      const oldest = book.keys().next().value;
      if (oldest !== undefined) book.delete(oldest);
    }
    const at = Date.now();
    book.set(
      castId,
      drops.map((drop) => ({
        goodId: drop.goodId,
        count: drop.count,
        bound: drop.bound,
        from: itemTypeOf(drop.goodId) === "equipment" ? { role: origin.killerName, monster: origin.monsterKey, at } : undefined,
        picked: false,
      })),
    );
  }

  //#endregion
}

//#region 类型与小工具（纯函数，e2e 可对照）

/** 一次击杀的身份信息（掉落溯源用：#789） */
interface KillOrigin {
  /** 击杀者角色名（掉落那一刻的名字） */
  killerName: string;
  /** 怪物 key —— 客户端用怪物配置翻成中文名 */
  monsterKey: string;
}

/** 掉落账本里的一条（#325 账本 + #789 绑定与溯源） */
interface DropLedgerEntry {
  goodId: string;
  count: number;
  /** 是否绑定角色（拾取时原样写进背包格子） */
  bound: boolean;
  /** 溯源，只有装备会有 */
  from?: BagOrigin;
  /** 是否已被拾取（幂等：同一次击杀的同一件不能入包两次） */
  picked: boolean;
}

/** 客户端 cast 消息解析后的形状 */
interface ParsedCast {
  castId: number;
  skillId: string;
  targetId: string;
  monsterKey: string;
}

// 三系攻击属性与「攻击 → 防御」映射在 common/constants/game-enums（怪物 AI 侧同一份，#823）
/** 幂等账本容量：足够盖住任何合理的重传窗口，又不会随游玩时长无限涨 */
const CAST_DEDUPE_CAPACITY = 256;

function parseCast(raw: unknown): ParsedCast | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const castId = data.castId;
  if (typeof castId !== "number" || !Number.isFinite(castId)) return null;
  if (typeof data.skillId !== "string" || !data.skillId) return null;
  // 目标可以为空（#822）：状态型技能是自身 buff（`require_target = 0`），客户端送空串。
  // 伤害型技能在后面仍然要求目标存在 —— 那道判断在 settleNew 里，不要在这里一并拦掉。
  const targetId = typeof data.targetId === "string" ? data.targetId : "";
  const monsterKey = typeof data.monsterKey === "string" ? data.monsterKey : "";
  return { castId, skillId: data.skillId, targetId, monsterKey };
}

/** 解析失败时尽量把 castId 带回去（客户端要靠它把拒绝结果对回某次出手）。
 *  settle() 收到的 raw 就是 cast 消息的 data 对象（RealtimeService 已剥掉外层帧），所以直接读 castId */
function extractCastId(raw: unknown): number {
  const castId = (raw as { castId?: unknown } | null)?.castId;
  return typeof castId === "number" && Number.isFinite(castId) ? castId : 0;
}

/** 从角色存档里读技能等级（data.skills 是客户端写的技能表：skillId → 等级） */
function readSkillLevel(data: Record<string, unknown>, skillId: string): number | null {
  const skills = data?.skills;
  if (!skills || typeof skills !== "object") return null;
  const level = (skills as Record<string, unknown>)[skillId];
  return typeof level === "number" && level >= 1 ? Math.trunc(level) : null;
}

/** 取技能在该等级的伤害系数（damageCoefficients 下标 = 技能等级 − 1，与客户端一致） */
function readDamageCoefficient(
  skill: { damageCoefficients?: unknown },
  skillLevel: number,
): { baseType: AttackAttribute; baseTypeRate: number } | null {
  const list = skill?.damageCoefficients;
  if (!Array.isArray(list)) return null;
  const item = list[skillLevel - 1];
  if (!item || typeof item !== "object") return null;
  const rate = (item as { baseTypeRate?: unknown }).baseTypeRate;
  const baseType = (item as { baseType?: unknown }).baseType;
  if (typeof rate !== "number" || !Number.isFinite(rate)) return null;
  if (typeof baseType !== "string" || !ATTACK_ATTRIBUTES.includes(baseType as AttackAttribute)) return null;
  return { baseType: baseType as AttackAttribute, baseTypeRate: rate };
}

/** 服务端角色属性摘要里的攻防区间（区间上下限颠倒时按交换处理） */
function readRange(source: object, attribute: AttackAttribute): [number, number] {
  const value = (source as Record<string, unknown>)[attribute];
  if (!Array.isArray(value) || value.length < 2) return [0, 0];
  return [Number(value[0]) || 0, Number(value[1]) || 0];
}

/**
 * 怪物侧该吃哪一项防御（物攻打物防 / 法攻打法防 / 道攻打道防）
 *
 * 映射表在 `game-enums`：怪物 AI 打玩家时读的是同一张（#823），两边各写一份就会分裂成
 * 「玩家打怪按物防、怪打玩家按魔防」这种只在数值层面才看得出来的错。
 */
function monsterDefenseRange(stats: MonsterRow, attribute: AttackAttribute): [number, number] {
  const column = MONSTER_STAT_COLUMN[DEFENSE_BY_ATTACK[attribute]] ?? "physical_defense";
  return [Number(stats[`${column}_min`]) || 0, Number(stats[`${column}_max`]) || 0];
}

/**
 * 属性区间随机取整数（与客户端 BattleMath.rollAttributeRange 同一口径：含两端、自动纠正颠倒）
 */
function rollRange(range: [number, number]): number {
  const minimum = Math.ceil(Math.min(range[0], range[1]));
  const maximum = Math.floor(Math.max(range[0], range[1]));
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}

/** 掉落条目（drop_tables.entries / monster_drops.entries JSON 解析后的形状；库内已全显式，缺省只为容错） */
interface DropEntryRow {
  goodId: string;
  weight?: number;
  chance?: number;
  count?: [number, number];
}

/** 在 [min, max] 区间随机取整数（含两端、自动纠正颠倒；与客户端 DropRoller.randomInt 同口径） */
function dropRandomInt(min: number, max: number): number {
  const minimum = Math.ceil(Math.min(min, max));
  const maximum = Math.floor(Math.max(min, max));
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}

/**
 * 结算一次掉落表（与客户端 utils/drop/DropRoller.rollDropTable 同一口径）：
 * 先定抽取次数（数字 = 固定，[min, max] = 区间随机），再按权重独立抽取该次数
 * （可重复命中同一条目），每次命中后过概率、数量取区间随机，同一物品合并数量。
 */
function rollDropTable(table: { picks: number | [number, number]; entries: DropEntryRow[] }): Array<{ goodId: string; count: number }> {
  const picks = Array.isArray(table.picks)
    ? Math.max(0, dropRandomInt(table.picks[0], table.picks[1]))
    : Math.max(0, Math.floor(table.picks ?? 1));
  if (!picks || !table.entries.length) return [];

  const weighted = table.entries.filter((entry) => (entry.weight ?? 1) > 0);
  const total = weighted.reduce((sum, entry) => sum + (entry.weight ?? 1), 0);
  const results: Array<{ goodId: string; count: number }> = [];
  for (let index = 0; index < picks && weighted.length > 0 && total > 0; index++) {
    let roll = Math.random() * total;
    let entry = weighted[weighted.length - 1];
    for (const candidate of weighted) {
      roll -= candidate.weight ?? 1;
      if (roll < 0) {
        entry = candidate;
        break;
      }
    }
    // 概率判定（默认必掉）与数量（默认 1）
    if (Math.random() > (entry.chance ?? 1)) continue;
    const count = dropRandomInt(entry.count?.[0] ?? 1, entry.count?.[1] ?? 1);
    if (count <= 0) continue;
    const existed = results.find((result) => result.goodId === entry.goodId);
    if (existed) existed.count += count;
    else results.push({ goodId: entry.goodId, count });
  }
  return results;
}

//#endregion
