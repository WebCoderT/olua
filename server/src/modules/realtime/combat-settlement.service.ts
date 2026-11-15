import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { bindOnDropOf, growthScalarOf, itemTypeOf, skillOf } from "../../common/runtime-config-cache";
import { ATTACK_ATTRIBUTES, DEFENSE_BY_ATTACK, MONSTER_STAT_COLUMN, type AttackAttribute } from "../../common/constants/game-enums";
import { PARTY_EXP_SHARE_DISTANCE_DEFAULT } from "../../common/constants/social";
import { DropTableRepository } from "../../database/repositories/drop-table.repository";
import { GrowthRepository } from "../../database/repositories/growth.repository";
import { MonsterDropRepository } from "../../database/repositories/monster-drop.repository";
import { MonsterRepository } from "../../database/repositories/monster.repository";
import { RuntimeParamsRepository } from "../../database/repositories/runtime-params.repository";
import { MonsterRow } from "../../database/rows";
import { DEFAULT_CRIT_DAMAGE, roleAttributeSourceOf, summarizeRoleAttributes } from "../combat/role-attributes";
import { RolesService } from "../roles/roles.service";
import { GameEventsService } from "../../common/events/game-events.service";
import { PartyService } from "../party/party.service";
import { WorldService } from "../world/world.service";
import { roomKey } from "../../common/utils/room-key.util";
import { MapMonitorService } from "./map-monitor.service";
import { MapService, type MapRules } from "../map/map.service";
import { MonsterAiService } from "./monster-ai.service";
import { PlayerPresenceService } from "./player-presence.service";
import { CastGuardService } from "./cast-guard.service";
import { DropService } from "./drop.service";
import type { RealtimeKillReward, RealtimeSettleData, RealtimeSettleHit, RealtimeSettleOk } from "./realtime.protocol";

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
 * 同一 `castId` 的重复投递（网络重传 / 客户端重发）**不重复结算**：每个账号按
 * `roleId:mapId:castId` 记住结果，重复的原样重发（`duplicate: true`），血量不会扣两次。
 * 账目**按时间过期**（`CAST_DEDUPE_TTL_MS`，≥ 最长技能冷却），不再靠「只留 256 条、
 * 超出挤掉最旧」—— 挤掉最旧等于「打得够久，早先的出手就能重放一遍」（#827）。
 * 序号由客户端按会话单调递增生成；换图（worldJoin）与断线仍整份清掉（见 `resetTargets`）。
 */
@Injectable()
export class CombatSettlementService {
  private readonly logger = new Logger(CombatSettlementService.name);

  /**
   * 每个账号最近的结算结果（`roleId:mapId:castId` → 结果 + 写入时刻，幂等重发用）
   *
   * 键里带角色与地图（#827，F1 口径）：同一账号换角色 / 换图后 castId 可能从头数，
   * 只按 castId 记会让新图的第一发命中旧账、把别的角色或上一次战斗的结果原样发回去。
   */
  private readonly recentSettles = new Map<string, Map<string, RecentSettle>>();

  /** 已经报过「群体技能没配作用半径」的技能 id（缓存 1 秒重建，不去重会刷屏） */
  private readonly warnedNoRadius = new Set<string>();

  constructor(
    private readonly roles: RolesService,
    private readonly world: WorldService,
    private readonly monsterAi: MonsterAiService,
    private readonly monsterConfigs: MonsterRepository,
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
    /** 分成距离阈值（#877 的 PARTY_EXP_SHARE_DISTANCE）走配置，e2e 压小用 */
    private readonly config: ConfigService,
    /** 地面掉落物的世界权威（#802）：算完的掉落交给它实体化、广播、过期 */
    private readonly drops: DropService,
    /**
     * 地图级玩法规则（#812 / docs/20 §5.5）：经验与掉落的倍率、是否允许掉落
     *
     * 走**地图域的公开口**而不是自己注入 `map-rule` 仓储：规则是「这张图的玩法配置」，
     * 归地图域拥有（仓储白名单只开了 map 与 world 两个域）。每次结算**现读库**，
     * 与 `enterRejectOf` / 怪物数值同一取向 —— 运营改完下一刀生效，不需要重载房间。
     * 倍率只在服务端乘，**不进客户端快照**（否则两端算出来的经验会漂）。
     */
    private readonly maps: MapService,
  ) {}

  /** 结算一次出手（结果直接作为 settle 帧的 data 发回） */
  settle(accountId: string, raw: unknown): RealtimeSettleData {
    const cast = parseCast(raw);
    if (!cast) {
      return { castId: extractCastId(raw), ok: false, code: "bad_request", message: "cast 消息缺 castId / skillId / targetId / monsterKey" };
    }

    // 幂等：同一 castId 原样重发，不重复结算
    const dedupeKey = this.dedupeKeyOf(accountId, cast.castId);
    const previous = this.recentSettles.get(accountId)?.get(dedupeKey);
    if (previous && Date.now() - previous.at <= CAST_DEDUPE_TTL_MS) {
      return previous.result.ok ? { ...previous.result, duplicate: true } : previous.result;
    }

    const result = this.settleNew(accountId, cast);
    this.remember(accountId, dedupeKey, result);
    return result;
  }

  /**
   * 清掉本账号的幂等账（世界状态不受影响）
   *
   * 两个调用方：`worldJoin` 放行时服务端**自己**调（#817：换图清账不能依赖客户端消息），
   * 以及客户端发来的 `targetsReset`（旧客户端 / 主动清，双保险）。
   *
   * **#802 起不再清掉落**：掉落是世界实体（与账号 / 连接无关），换图只是你自己不在那张图了，
   * 东西还躺在地上等人捡（`pick` 会因为 `not_on_map` 拒你）。这是行为变化。
   */
  resetTargets(accountId: string): void {
    // 幂等账照样清（#827）：键里虽然带了 `roleId:mapId`，但客户端换图 / 换角色后是否重置
    // `castSeq` 不由服务端决定 —— 万一它归 0，不清账就会把上一场的结果当成「重复」发回去。
    // 「换图不会撞」由键保证，「castSeq 归 0 也不撞」由这里保证，两道都要。
    this.recentSettles.delete(accountId);
  }

  /** 连接断开：清幂等账（世界状态是共享的，不随任何账号的连接断开而清，掉落同理 #802） */
  dropAccount(accountId: string): void {
    this.recentSettles.delete(accountId);
    // 判定链的进程内状态一起清（#813）：冷却与令牌桶是「这条会话的节奏」，人走了就不必留着
    this.guard.dropAccount(accountId);
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

  /**
   * 自身 / 区域 / 群体技能（#824）
   *
   * ===========================================================================
   * 为什么单开一条路
   * ===========================================================================
   * 单体技能的「目标」是一只怪（`targetId` + `monsterKey`，身份由服务端发牌）。
   * 自身 / 区域 / 群体技能的「目标」是**一块地**或**自己** —— 客户端送来的 `targetId`
   * 本来就是空的。原来那条路第一句就是「没有目标 → bad_request」，于是这类技能
   * 一次也放不出来（1008 十步一杀因此等于不存在）。
   *
   * 命中集合**由服务端算**：以作用点为中心、`skills.distance` 为半径，扫服务端自己持有的
   * 怪物实例（同区同图、存活、按距离排序、取最近的 `AOE_MAX_TARGETS` 只）。客户端只发意图
   * 与落点，打中谁、打多少都不由它决定。
   *
   * **落点不信客户端**：先按施法者当前坐标（`presence.positionOf`，4Hz 自报 + 最小仲裁）
   * 把落点夹到 `distance` 半径内 —— 与客户端 `skill_1008` 自己那段
   * `Math.min(travel, config.distance)` 同一口径，所以正常玩家两边界算出的落点一致。
   * 拿不到施法者坐标就**拒绝**而不是「信落点」：没有参照点就没法判断落点是不是在半个地图外。
   *
   * ===========================================================================
   * 三种「没有伤害」的情形
   * ===========================================================================
   * - `target_type = 3`（自身）：本来就是给自己用的，不掷伤害；
   * - `damage_coefficients` 为空数组：这不是配置坏了，而是「这个技能不掷伤害」——
   *   1008 十步一杀是纯位移（客户端本地瞬移 + 落点特效），配置里就该是空。
   *   **只有单体系数缺失才算坏配置**（那条判断留在单体路径里）；
   * - 半径内一只怪都没有（打空）：`hits` 是空数组，不是错误。
   *
   * 这三种都**照常过六道闸**（存活 / 冷却 / 耗蓝 / 频率）：区域技能一样能被改包连放，
   * 而位移技能的一次瞬移同样要付冷却与法力。
   */
  private castAreaSkill(accountId: string, cast: ParsedCast, skill: Record<string, unknown>): RealtimeSettleData {
    const fail = (code: string, message: string): RealtimeSettleData => ({ castId: cast.castId, ok: false, code, message });

    const role = this.roles.online(accountId);
    if (!role) return fail("no_role", "当前没有在线角色，无法结算");
    const summary = summarizeRoleAttributes(roleAttributeSourceOf(role.level, role.data));
    if (!summary) return fail("no_role", `角色等级 ${role.level} 不在成长曲线里，算不出属性`);
    const skillLevel = readSkillLevel(role.data, cast.skillId);
    if (!skillLevel) return fail("skill_not_learned", `技能 ${cast.skillId} 尚未学习`);

    // 六道闸：**不传 target** —— 中心是一块地，不存在「跨图打」与「隔图打」这回事
    // （落点已经被夹到施法者周围了）。存活 / 冷却 / 耗蓝 / 频率四道照走。
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

    const coefficient = readDamageCoefficient(skill, skillLevel);
    const targetType = String(skill.targetType ?? "1");
    const statuses = this.roles.statusSnapshotOf(accountId);

    // 自身技能 / 不掷伤害的区域技能（位移、纯表现）：过闸记账就结束
    if (targetType === "3" || coefficient === null) {
      this.logger.debug(
        `无伤害技能：账号 ${accountId} 技能 ${cast.skillId}(Lv${skillLevel}) target_type=${targetType}` +
          `${coefficient === null ? "（配置里没有伤害系数）" : ""}`,
      );
      return {
        castId: cast.castId,
        ok: true,
        skillId: cast.skillId,
        targetId: "",
        damage: 0,
        hp: 0,
        maxHp: 0,
        killed: false,
        duplicate: false,
        noDamage: true,
        hits: [],
        statuses,
      };
    }

    const spot = this.areaSpotOf(accountId, cast, skill);
    if (!spot) {
      return fail("bad_request", "服务端还没收到你的位置，无法验证区域技能的作用点（先移动一下再放）");
    }

    // 跨图闸（与单体路径同一道，但判据不同）：单体是「目标在哪张图」，
    // 区域是「**你以为自己在哪张图**」—— 作用点的地图来自客户端自报的 pos 帧，
    // 不比对服务端记下的 mapAt，改包就能站主城清空另一张图的怪。
    // mapAt 缺失（老档 / 刚建号）时放行，与 `CastGuardService` 第二道同一取向。
    const mapAt = typeof role.data?.mapAt === "string" ? role.data.mapAt : "";
    if (mapAt && mapAt !== spot.mapId) {
      return {
        castId: cast.castId,
        ok: false,
        code: "cross_map",
        message: `你说自己在 ${spot.mapId}，但服务端只放行过你在 ${mapAt}`,
        rejected: "cross_map",
      };
    }

    // 候选：同区同图、存活、半径内，按距离升序取最近的一批。
    // 位置优先用 AI 运行时坐标（怪会游走，出生点可能早就不在原地了），与单体路径同一取向。
    const candidates = this.world
      .monstersOf(spot.roomId)
      .map((monster) => {
        const live = this.monsterAi.livePositionOf(monster.instanceId) ?? { x: monster.x, y: monster.y };
        return { monster, x: live.x, y: live.y, distance: Math.hypot(live.x - spot.x, live.y - spot.y) };
      })
      .filter((entry) => entry.monster.alive && entry.distance <= spot.radius)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, AOE_MAX_TARGETS);

    const killerName = this.roleNameOf(role);
    const hits: RealtimeSettleHit[] = [];
    /** 这一发打出来的所有掉落（#802 起只是给日志 / 事件用的汇总，实体化在每只怪的击杀分支里做） */
    const drops: Array<{ goodId: string; count: number; bound: boolean; monsterKey: string; mapId: string; x: number; y: number }> = [];

    for (const entry of candidates) {
      const stats = this.monsterConfigs.findByKey(entry.monster.monsterKey);
      // 数值表里没有这只 = 不是可战对象（配置漏了），跳过而不是按 0 防算出一刀秒杀
      if (!stats) continue;

      // 每一只独立掷骰：攻击区间各自随机，防御也吃各自的状态修正，暴击也各掷一次。
      // 拿一次掷骰套到 N 只身上，会让「同一刀打死五只」变成可预测的结果。
      const { damage, critical, suppressed } = rollCastDamage({
        attackRange: readRange(summary, coefficient.baseType),
        attackMultiplier: this.roles.statusModifiersOf(accountId).attackMultiplier,
        rate: coefficient.baseTypeRate,
        defenseRange: monsterDefenseRange(stats, coefficient.baseType),
        defenseMultiplier: this.monsterAi.defenseMultiplierOf(entry.monster.instanceId),
        defIgnore: readNumber(skill, "defIgnore"),
        crit: critProfileOf(summary, skill),
        // 等级压制逐只算（#826 第三批）：一片怪里等级可能不同，拿主目标那一份套全片会算错
        suppression: suppressionOf(role.level, stats.level),
      });

      const applied = this.world.applyDamage(entry.monster.instanceId, damage);
      if (!applied) continue;

      // 技能自带的状态（#826 第三批）：逐只挂，与单体路径同一口径（打死的怪不挂）
      let hitStatus: string | undefined;
      if (!applied.killed) {
        const statusId = typeof skill.statusId === "string" ? skill.statusId : "";
        if (statusId) {
          const attached = this.monsterAi.applyStatusToMonster(entry.monster.instanceId, statusId, accountId);
          if (attached) hitStatus = attached.statusId;
        }
      }

      let reward: RealtimeKillReward | undefined;
      if (applied.killed) {
        // 击杀奖励逐只算：经验按「击杀者等级 vs 这一只的等级」各自算，掉落各自抽。
        // 击杀点 = 这只怪的实时坐标（倒下的地方）；分成距离闸（#877）以它为参照
        reward = this.settleKillReward(accountId, role.id, role.level, role.revision, stats, entry.monster.monsterKey, killerName, {
          mapId: spot.mapId,
          x: entry.x,
          y: entry.y,
        });
        this.roles.recordKill(role.id);
        // 掉落逐只实体化（#802）：这一堆东西躺在**这只怪**倒下的地方。
        // 每只各自 spawn（各自散落、各自 dropId）—— 与「一次施放一份账本」的旧形态不同，
        // 现在定位靠 dropId，不需要再按施放合并。
        this.attachDrops(reward, {
          mapId: entry.monster.mapId,
          ownerAccountId: accountId,
          x: entry.x,
          y: entry.y,
          ownerRoleId: role.id,
          ownerName: killerName,
          source: {
            instanceId: entry.monster.instanceId,
            monsterKey: entry.monster.monsterKey,
            label: stats.label,
            tier: stats.tier,
          },
        });
        for (const drop of reward.drops) {
          drops.push({ ...drop, monsterKey: entry.monster.monsterKey, mapId: spot.mapId, x: entry.x, y: entry.y });
        }
        this.events.emit("monster:killed", {
          accountId,
          roleId: role.id,
          roleName: this.roleNameOf(role),
          monsterKey: entry.monster.monsterKey,
          monsterLabel: stats.label,
          monsterTier: stats.tier,
          // 死亡点 = 这只怪的实时坐标（群攻每只各自记，不然 8 条流水全指向同一个点）
          mapId: spot.mapId,
          x: entry.x,
          y: entry.y,
        });
        this.monitor.recordKill({
          instanceId: entry.monster.instanceId,
          monsterKey: entry.monster.monsterKey,
          label: stats.label,
          zoneId: entry.monster.zoneId,
          mapId: entry.monster.mapId,
          x: entry.x,
          y: entry.y,
          killer: killerName,
          drops: reward.drops,
          respawnAt: entry.monster.respawnAt ?? Date.now(),
        });
        this.monsterAi.onMonsterKilled(entry.monster.instanceId, {
          zoneId: entry.monster.zoneId,
          mapId: entry.monster.mapId,
          accountId,
          x: entry.x,
          y: entry.y,
          drops: reward.drops,
        });
      } else {
        // 打伤 = 记恨这一手（与单体路径同一取向：谁打的找谁）
        this.monsterAi.provoke(entry.monster.instanceId, accountId);
      }

      this.monitor.recordDamage({
        instanceId: entry.monster.instanceId,
        monsterKey: entry.monster.monsterKey,
        label: stats.label,
        zoneId: entry.monster.zoneId,
        mapId: entry.monster.mapId,
        x: entry.x,
        y: entry.y,
        attacker: killerName,
        skillId: cast.skillId,
        skillLabel: String(skill.label ?? ""),
        amount: damage,
        hpAfter: applied.hp,
        maxHp: entry.monster.maxHp,
        killed: applied.killed,
        // 击退只对单体生效（docs/22：AOE 把一片怪同时推开会让落点校验雪崩），AOE 恒 0
        pushDistance: 0,
      });

      const hit: RealtimeSettleHit = {
        targetId: entry.monster.instanceId,
        monsterKey: entry.monster.monsterKey,
        damage,
        hp: applied.hp,
        maxHp: entry.monster.maxHp,
        killed: applied.killed,
        // 暴击逐只标（#826）：一次区域施放里可能只爆一只 —— 客户端按 hit 播特效，
        // 不能拿顶层那一个标志去染整片
        ...(critical ? { critical: true } : {}),
        // 等级压制同样逐只标（#826 第三批）：一片怪等级可能不同，压制与否也不同
        ...(suppressed ? { suppressed: true as const } : {}),
      };
      if (hitStatus) hit.status = hitStatus;
      if (reward) hit.reward = reward;
      hits.push(hit);
    }

    // 观看者只看到「他放了一个技能」：一次出手记一次，目标取最近的那只（打空时为空串）
    this.presence.recordAction(spot.roomId, { a: accountId, s: cast.skillId, t: hits[0]?.targetId ?? "" });

    const primary = hits[0];
    this.logger.debug(
      `区域结算：账号 ${accountId} 技能 ${cast.skillId}(Lv${skillLevel}) 作用点 (${Math.round(spot.x)}, ${Math.round(spot.y)}) 半径 ${Math.round(spot.radius)} → 命中 ${hits.length} 只` +
        `${primary ? `，主目标 ${primary.targetId}(${primary.monsterKey}) 伤害 ${primary.damage}` : "（打空）"}`,
    );

    const ok: RealtimeSettleOk = {
      castId: cast.castId,
      ok: true,
      skillId: cast.skillId,
      // 顶层字段 = 最近的那一只（旧客户端只认这几个字段，不至于因为 AOE 而「什么都不显示」）
      targetId: primary?.targetId ?? "",
      damage: primary?.damage ?? 0,
      hp: primary?.hp ?? 0,
      maxHp: primary?.maxHp ?? 0,
      killed: primary?.killed ?? false,
      duplicate: false,
      hits,
      statuses,
      // 顶层 = 主目标那一只的暴击（与 damage / hp 同一口径：只认最近那只）
      ...(primary?.critical ? { critical: true } : {}),
      // 顶层 = 主目标那一只的压制（同上；逐只看 hits[i].suppressed）
      ...(primary?.suppressed ? { suppressed: true as const } : {}),
    };
    return primary?.reward ? { ...ok, reward: primary.reward } : ok;
  }

  /**
   * 区域技能的作用点与半径（#824）
   *
   * 落点来自客户端（`cast.x / cast.y`），但**只当意图**：
   * - 半径与可达距离共用 `skills.distance`（配 0 → `AOE_DEFAULT_RADIUS` 并 warn 一次）；
   * - 落点按施法者坐标夹到可达距离内，方向保留 —— 与客户端 `skill_1008` 的截断口径一致；
   * - 客户端没给落点（自身周围 AOE / 老客户端）→ 以施法者脚下为中心；
   * - 拿不到施法者坐标 → null，调用方拒绝（没有参照点就没法判断落点是否合法）。
   */
  private areaSpotOf(
    accountId: string,
    cast: ParsedCast,
    skill: Record<string, unknown>,
  ): { roomId: string; zoneId: number; mapId: string; x: number; y: number; radius: number } | null {
    const position = this.presence.positionOf(accountId);
    if (!position) return null;

    const configured = Number(skill.distance);
    let radius = Number.isFinite(configured) && configured > 0 ? configured : 0;
    if (radius <= 0) {
      // 群体技能配 0 = 不限施法距离，那个语义对「一块地」是灾难（等于全图 AOE），
      // 所以退回默认半径并报一次配置问题 —— 静默按无限大会让运营永远不知道自己配错了
      radius = AOE_DEFAULT_RADIUS;
      const ticket = `${cast.skillId}`;
      if (!this.warnedNoRadius.has(ticket)) {
        this.warnedNoRadius.add(ticket);
        this.logger.warn(`技能 ${cast.skillId} 是区域 / 群体技能，但 skills.distance 配成 0（不限距离）—— 已按默认半径 ${AOE_DEFAULT_RADIUS} 处理，请在管理端配上作用半径`);
      }
    }

    let x = position.x;
    let y = position.y;
    if (typeof cast.x === "number" && typeof cast.y === "number") {
      const dx = cast.x - position.x;
      const dy = cast.y - position.y;
      const distance = Math.hypot(dx, dy);
      if (distance > radius) {
        x = position.x + (dx / distance) * radius;
        y = position.y + (dy / distance) * radius;
      } else {
        x = cast.x;
        y = cast.y;
      }
    }

    // roomId 一并带上（#809）：群体技能的候选池从「一张图」收窄到「一间房」，
    // 否则 1 线的 AOE 会打到公共线的怪（分线之后这是最容易被漏掉的一处）
    return { roomId: position.roomId, zoneId: position.zoneId, mapId: position.mapId, x, y, radius };
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

    // 自身 / 区域 / 群体技能（#824）：它们的「目标」不是一只怪，走另一条路。
    // 判据读 `skills.target_type` + `require_target` —— 这两个字段以前**没人读**：
    // 服务端靠「客户端送的 targetId 空不空」间接猜，于是任何非单体技能都进不来结算
    // （1008 十步一杀就是被这一条挡在门外的）。
    if (!needsMonsterTarget(skill)) return this.castAreaSkill(accountId, cast, skill);

    // 伤害型单体技能必须有目标（状态型 / 区域型已经在上面分流走了）
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
    // #957：攻击者的区按在线角色算，不再读账号行
    const attackerZone = this.roles.zoneOf(accountId);
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
    const targetBox = this.monsterAi.monsterBoxOf(cast.monsterKey);
    const verdict = this.guard.guard({
      accountId,
      skill,
      skillId: cast.skillId,
      roleData: role.data ?? {},
      target: {
        mapId: target.mapId,
        x: targetSpot.x,
        y: targetSpot.y,
        halfWidth: targetBox?.halfWidth,
        halfHeight: targetBox?.halfHeight,
      },
      // 距离闸（#1030）要施法者坐标与它的时刻：位置未知 / 过期由闸自己放行
      caster: this.presence.positionOf(accountId) ?? undefined,
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
    // 暴击与破防（#826）收在 `rollCastDamage` 里，与区域路径共用一条公式
    const modifiers = this.roles.statusModifiersOf(accountId);
    const { damage, critical, suppressed } = rollCastDamage({
      attackRange: readRange(summary, coefficient.baseType),
      attackMultiplier: modifiers.attackMultiplier,
      rate: coefficient.baseTypeRate,
      defenseRange: monsterDefenseRange(stats, coefficient.baseType),
      defenseMultiplier: this.monsterAi.defenseMultiplierOf(cast.targetId),
      defIgnore: readNumber(skill, "defIgnore"),
      crit: critProfileOf(summary, skill),
      // 等级压制（#826 第三批）：单体只算这一只，与区域路径的逐只算法是同一个函数
      suppression: suppressionOf(role.level, stats.level),
    });

    // 扣血与世界状态（血量 / 死亡判定都在世界服务里，这里只拿结果演）
    const first = this.world.applyDamage(cast.targetId, damage);
    if (!first) return fail("target_dead", `目标 ${cast.targetId}（${cast.monsterKey}）已死亡`);

    // 两段连击（#826 第三批）：第一段没打死才补第二段
    // - 系数是配置列（`skills.second_hit_ratio`，0 = 没有第二段），第二段 = 第一段 × 系数；
    //   用户口径就是「配置列系数」，所以第二段**不单独掷区间、不单独判暴击** ——
    //   它是第一段的延续，两段合起来是一条伤害曲线，拆开掷会让同一次出手的方差翻倍。
    // - 第一段就打死 → 不补（没有「再鞭尸一下」这回事，奖励与掉落也只算一次）；
    // - 第一段 0 伤害（被等级压制打不动 / 防御吃满）→ 不补：补一下还是 0，
    //   只会让客户端多播一次空飘字。`secondDamage > 0` 是这两个条件的合流处。
    const secondRatio = Math.max(0, Number(skill.secondHitRatio) || 0);
    let secondDamage = 0;
    let applied = first;
    if (!first.killed && secondRatio > 0) {
      const extra = Math.round(damage * secondRatio);
      if (extra > 0) {
        const second = this.world.applyDamage(cast.targetId, extra);
        // 第二段返回 null 只可能是指针指向的那只已经不在世界表里（并发清图）——
        // 那就是「第二段没落地」，回执不能报一个没生效的数
        if (second) {
          applied = second;
          secondDamage = extra;
        }
      }
    }

    // 技能自带的状态（#826 第三批）：伤害型技能命中后把 `status_id` 挂到怪身上
    // （眩晕 / 麻痹 / 灼烧这一侧）。状态**先于**死亡判定写：打到残血的怪该被控住，
    // 打死的怪不写（`!applied.killed`）—— 给尸体挂 buff 只会留在运行时里等重生时被清。
    // 挂不上（配置里没这个状态 / 持续时间 0）就当这一发是纯伤害，不报错：
    // 那是运营配置问题，管理端状态页看得见，不该让玩家看到「技能放了但没伤害以外的错」。
    let targetStatus: string | undefined;
    if (!applied.killed) {
      const statusId = typeof skill.statusId === "string" ? skill.statusId : "";
      if (statusId) {
        const attached = this.monsterAi.applyStatusToMonster(cast.targetId, statusId, accountId);
        if (attached) targetStatus = attached.statusId;
      }
    }

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
    /** 这一下把怪拉近了多少（#826 第三批；与推互斥，实际值由 AI 侧截断后返回） */
    let pullDistance = 0;

    // 击杀奖励（#316）：经验入账与掉落抽取都在服务端 —— 经验入账失败（打到一半被踢等）
    // 只跳过 reward，不回滚这次击杀：世界状态是权威，经验少记一笔可接受
    let reward: RealtimeKillReward | undefined;
    if (applied.killed) {
      reward = this.settleKillReward(accountId, role.id, role.level, role.revision, stats, cast.monsterKey, this.roleNameOf(role), {
        mapId: this.presence.identityOf(accountId)?.mapId ?? "",
        x: hitSpot.x,
        y: hitSpot.y,
      });
      // 击杀计数（#400）：排行榜的原料。与经验分开记 —— 等级差过大时经验为 0，但这一杀算数
      this.roles.recordKill(role.id);
      // 掉落生成（#802）：账本没了 —— 算出来的东西直接变成世界实体（内存 + 广播 + 投影表）。
      // 落点 = 这一下打在哪（`hitSpot`，与死亡点、伤害日志同一个坐标），散落偏移由 DropService 算，
      // 客户端拿到的是**同一份**坐标（#804 起不再自己散落）。
      // 幂等重发走上面的 recentSettles 原样重放，不会重复生成。
      this.attachDrops(reward, {
        mapId: target.mapId,
        ownerAccountId: accountId,
        x: hitSpot.x,
        y: hitSpot.y,
        ownerRoleId: role.id,
        ownerName: this.roleNameOf(role),
        source: { instanceId: cast.targetId, monsterKey: cast.monsterKey, label: stats.label, tier: stats.tier },
      });
      // 击杀事件（#401 起走总线）：任务进度与成就进度都是订阅方，各自兜异常 ——
      // 任何一方写库失败都不回滚这次击杀（世界状态是权威，少记一笔进度可接受）
      this.events.emit("monster:killed", {
        accountId,
        roleId: role.id,
        roleName: this.roleNameOf(role),
        monsterKey: cast.monsterKey,
        monsterLabel: stats.label,
        monsterTier: stats.tier,
        // 与上面那处同一口径：死亡点用「这一下打在哪」（hitSpot 已在闸之前取好）。
        // 图取**目标怪所在的图**而不是在场表：单体出手不要求玩家先报 pos，
        // 拿 `presence` 会得到一个空串（#886 的 e2e 就是被这个抓到过）
        mapId: target.mapId,
        x: hitSpot.x,
        y: hitSpot.y,
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
      // #826 第二批：撞飞还要过两道闸 —— ① 概率（`push_chance`，0 = 从不撞，1 = 必撞，
      // 缺字段按必撞处理，与旧行为一致）；② 等级（desc 写「等级低于自身的目标撞飞」，
      // 严格小于：施法者等级必须**大于**怪物等级）。两道闸都没过就不推，
      // 回执与监控里的 pushDistance 都是 0 —— 推没推只有服务端知道，客户端不自己掷。
      const wantPush = Number(skill.pushDistance) || 0;
      const chance = Number(skill.pushChance);
      const passedChance = Math.random() < (Number.isFinite(chance) ? chance : 1);
      if (wantPush > 0 && passedChance && role.level > stats.level) {
        pushDistance = wantPush;
        this.monsterAi.applyPush(cast.targetId, accountId, pushDistance);
      }

      // 拉人（#826 第三批，`skills.pull_distance`）：与撞飞方向相反（怪 → 施法者），
      // 共用 AI 那套位移运行时。三条口径：
      // - **与推互斥**：推了就跳过拉 —— 两个都配的话「先撞飞再拉回来」在一帧里播两个
      //   相反的位移，客户端插值会抖成残影。配了两列的时代价是「推优先」，与字段顺序一致。
      // - **不判概率也不判等级**：desc 里拉人是「一定拉过来」的技能语义，不是撞飞那类
      //   「按概率击退」。要按概率就再给一列，别偷偷复用 `push_chance`（配击退概率会
      //   连带改拉人，运营调一个参数坏两个玩法）。
      // - **回执给实际值**：贴到 `PULL_STOP_GAP` 内会被截断，下发配置值会让客户端把怪
      //   画进玩家身上（或墙里）。0 = 没拉（配置为 0 / 已经贴脸 / 拿不到施法者坐标）。
      const wantPull = Number(skill.pullDistance) || 0;
      if (pushDistance === 0 && wantPull > 0) {
        pullDistance = this.monsterAi.applyPull(cast.targetId, accountId, wantPull);
      }
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
      // 两段连击算一行：`hpBefore = hpAfter + amount` 是监控页面的自洽前提，
      // 只记第一段会让「200 → 137（-63）」的减法对不上（少掉第二段那一截）
      amount: damage + secondDamage,
      hpAfter: applied.hp,
      maxHp: target.maxHp,
      killed: applied.killed,
      pushDistance,
    });

    // 玩家动作事件（#693）：观看者据此播「他出手了」的攻击/技能动画 —— settle 只回出手者
    // 本人，不记这条，别人的屏幕上他永远站着发呆。普攻与技能同一形状（普攻也是技能）。
    // 只在新结算路径记 —— 幂等重发在上面早退，不会重复广播。
    this.presence.recordAction(roomKey(target.zoneId, target.mapId, target.slot), {
      a: accountId,
      s: cast.skillId,
      t: cast.targetId,
    });

    this.logger.debug(
      `结算：账号 ${accountId} 技能 ${cast.skillId}(Lv${skillLevel}) → 目标 ${cast.targetId}(${cast.monsterKey}) 伤害 ${damage}` +
        `${secondDamage > 0 ? `+${secondDamage}（两段）` : ""}${suppressed ? "（等级压制）" : ""}，血量 ${applied.hp}/${target.maxHp}` +
        `${applied.killed ? "，击杀" : ""}${reward ? `，经验 +${reward.exp}，掉落 ${reward.drops.length} 种` : ""}`,
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
      // 暴击（#826）：只在真触发时出现 —— 客户端用它换飘字 / 特效，缺字段就是没暴击
      ...(critical ? { critical: true } : {}),
      // 等级压制（#826 第三批）：只在系数真的 < 1 时出现。`damage: 0 + suppressed: true`
      // 是「越 20 级打不动」的确定信号，与「防御吃满打出 0」区分得开
      ...(suppressed ? { suppressed: true as const } : {}),
      // 两段连击（#826 第三批）：只在第二段真落地时出现。`hp` 已是两段之后的血量，
      // 客户端按 damage → secondDamage → hp 的顺序演
      ...(secondDamage > 0 ? { secondDamage } : {}),
      // 撞飞（#826 第二批）：只在真推了时出现。位移本身走位置广播（#670 不加协议帧），
      // 回执带这个数是给客户端表现用的确定性信号（击退方向 = 施法者 → 怪），缺字段就是没推
      ...(pushDistance > 0 ? { pushDistance } : {}),
      // 拉人（#826 第三批）：与撞飞互斥，方向相反（怪 → 施法者）。给的是**实际**拉近距离
      ...(pullDistance > 0 ? { pullDistance } : {}),
      // 挂到目标身上的状态（#826 第三批）：客户端可据此在怪身上播一次控制 / 燃烧特效。
      // 缺字段 = 这一发没带状态（或怪已经死了）
      ...(targetStatus ? { targetStatus } : {}),
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
    killSpot: { mapId: string; x: number; y: number },
  ): RealtimeKillReward {
    // 地图倍率（#812）：现读库，改完下一刀生效。`expRate = 0` 的图不给经验（活动图 / 试炼场）
    const rules = this.rulesOfMap(killSpot.mapId);
    const exp = scaleExp(this.killExpFor(roleLevel, stats.level), rules.expRate);
    // 无经验（等级差过大 / 这张图不给经验）不入账不推 revision；有经验但落账失败（打到一半被踢）跳过奖励
    const applied = exp > 0 ? this.roles.applyKillExp(accountId, roleId, exp) : null;
    if (exp > 0 && !applied) {
      this.logger.warn(`击杀奖励入账失败：账号 ${accountId} 角色 ${roleId}（可能已被下线），本次经验 ${exp} 未记`);
      return { exp: 0, level: roleLevel, expNow: 0, expNeed: 0, leveledUp: false, revision: roleRevision, drops: [] };
    }
    // 队友分成（#399）：与击杀者的入账分开走 —— 击杀者那份照旧全额，
    // 队友那份按他自己的等级差算，失败也不该影响击杀者的这一笔。
    // **倍率同口径**（#812）：队友也乘 `expRate`，否则同图两个人拿到的倍率不一致，
    // 「带人刷高倍率图」会变成对队友的惩罚（表现上就是一条报错）
    this.sharePartyExp(accountId, roleId, killerName, killSpot, stats.level, rules);
    return {
      exp,
      level: applied ? applied.level : roleLevel,
      expNow: applied ? applied.expNow : 0,
      expNeed: applied ? applied.expNeed : 0,
      leveledUp: applied ? applied.leveledUp : false,
      revision: applied ? applied.revision : roleRevision,
      drops: this.rollDrops(monsterKey, rules),
    };
  }

  /**
   * 把一次击杀抽出来的掉落交给世界（#802）
   *
   * 三件事：取「掉落那一刻」的队伍快照（保护期的依据，队伍解散即退化为全员可捡）、
   * 让 `DropService` 生成实体（落点与散落偏移都在那边算）、把 `dropId` 回填进
   * `settle.reward.drops`（对账 / 排查用；客户端铺地一律等 `dropSpawn`，不等这一帧）。
   */
  private attachDrops(
    reward: RealtimeKillReward,
    spot: {
      mapId: string;
      ownerAccountId: string;
      x: number;
      y: number;
      ownerRoleId: string;
      ownerName: string;
      source: { instanceId: string; monsterKey: string; label: string; tier: string };
    },
  ): void {
    if (!reward.drops.length) return;
    const created = this.drops.spawn({
      mapId: spot.mapId,
      x: spot.x,
      y: spot.y,
      owner: { accountId: spot.ownerAccountId, roleId: spot.ownerRoleId, name: spot.ownerName },
      // 空串 = 没队伍（`partyIdOfRole` 无队返回 ""）；统一成 null 让实体只有一个「无队」表示
      partyId: this.party.partyIdOfRole(spot.ownerRoleId) || null,
      source: spot.source,
      drops: reward.drops.map((drop) => ({ goodId: drop.goodId, count: drop.count, bound: drop.bound })),
    });
    // spawn 按输入顺序返回，下标一一对应（数量为 0 的条目已在抽取阶段被过滤掉）
    created.forEach((entity, index) => {
      const entry = reward.drops[index];
      if (entry) entry.dropId = entity.dropId;
    });
  }

  /**
   * 队友经验分成（#399）
   *
   * 规则（写进 #399 认领留言的第 4 条）：**同图且距击杀点足够近的在线队友**每人得
   * `floor(killExp(他自己的等级, 怪物等级) × PARTY_EXP_MATE_SHARE)`，击杀者拿全额。
   *
   * - 不均分：击杀者不该因为带人变慢（那会让「组队」变成一种惩罚）；
   * - 不加成：加成会引出「多开小号刷经验」，而这一刀没有反多开的机制；
   * - 队友那份走**他自己的等级差**：高等级带小号打高级怪时，小号对那只怪的基数是 0，
   *   乘任何比例还是 0 —— 拉小号这件事被公式本身挡住，不需要另加规则；
   * - 离线 / **不同房** / 等级差过大的队友**不发帧**（没有经验可演），也不写库；
   *   「同房」= `zone:map:slot` 三键全等（#958）：只比 mapId 时两个区同在 3 图的队友会互相
   *   分经验，两套经济就此串味；
   * - **距离闸（#877）**：同房但距击杀点超过 `PARTY_EXP_SHARE_DISTANCE`（默认 800px）的
   *   队友同样不分 —— 站城里挂机的小号不该白拿一半经验。同房与距离读的是同一份
   *   在场位置（`presence.positionOf`），判定收在 `withinShareDistance` 一处。
   */
  private sharePartyExp(
    killerAccountId: string,
    killerRoleId: string,
    killerName: string,
    killSpot: { mapId: string; x: number; y: number },
    monsterLevel: number,
    rules: MapRules,
  ): void {
    const share = this.party.expMateShare();
    if (share <= 0) return;
    // 房号（zone:map:slot）从击杀者的在场条目来：他自己就在那个房间里击杀的（#958）
    const roomId = this.presence.identityOf(killerAccountId)?.roomId ?? "";
    const mates = this.party.sameRoomMates(killerRoleId, roomId);
    if (mates.length === 0) return;
    for (const mate of mates) {
      const role = this.roles.online(mate.accountId);
      // 在线角色不是他（切角色 / 连接还没换过来）就跳过：入账必须落在**当前在线角色**上
      if (!role || role.id !== mate.roleId) continue;
      if (!this.withinShareDistance(mate.accountId, roomId, killSpot)) continue;
      // 顺序与击杀者同口径（docs/20 §5.5）：**先乘地图倍率、再乘队伍分成**，最后取整一次
      const gain = Math.floor(this.killExpFor(role.level, monsterLevel) * rules.expRate * share);
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

  /**
   * 分成距离闸（#877）：**同房** + 距击杀点 `PARTY_EXP_SHARE_DISTANCE` 内
   *
   * 同房与距离读**同一份**在场位置（`presence.positionOf`，4Hz 自报 + 最小仲裁）——
   * 判定收在这一处，别处（sameRoomMates 的 locationOf）只做粗筛；位置还没上报过
   * （pos 帧一帧都没来）按「不在场」处理：没有参照坐标的距离是无意义的。
   *
   * 比的是**房号**而不是 `mapId`（#958）：两个区的同名图坐标完全可能重合，
   * 光比 mapId 会让别区的队友隔着「同一张图」拿到经验。
   */
  private withinShareDistance(
    mateAccountId: string,
    roomId: string,
    killSpot: { mapId: string; x: number; y: number },
  ): boolean {
    const position = this.presence.positionOf(mateAccountId);
    if (!position) return false;
    if (position.roomId !== roomId) return false;
    const limit = Math.max(0, Number(this.config.get<number>("partyExpShareDistance") ?? PARTY_EXP_SHARE_DISTANCE_DEFAULT));
    return Math.hypot(position.x - killSpot.x, position.y - killSpot.y) <= limit;
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
   * 一张图的规则（#812）：`map_rules` 一行不存在 = 出厂默认（`DEFAULT_MAP_RULES`）
   *
   * 经地图域公开口现读，与 `enterRejectOf` / 怪物数值同一取向 —— 运营改完倍率下一刀就生效，
   * 不需要重载房间。房间对象上那份 `capacity` 是「进图那一刻的快照」，与这里不共用。
   */
  private rulesOfMap(mapId: string): MapRules {
    return this.maps.rulesConfigOf(mapId);
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
  private rollDrops(monsterKey: string, rules: MapRules): Array<{ goodId: string; count: number; bound: boolean }> {
    // 这张图不掉东西（活动图 / 剧情图的常态）：**一件都不抽**，而不是抽完再丢 ——
    // 世界侧因此不会生成实体，客户端也不会收到 `dropSpawn`，表现上就是「地上什么都没有」
    if (!rules.allowDrop) return [];
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
    const result: Array<{ goodId: string; count: number; bound: boolean }> = [];
    for (const drop of rollDropTable(table, rules.dropRate)) {
      // 掉落表是管理端可改的数据：配了不存在的物品 id 就在这里拦下（#802）。
      // 以前是等拾取时才报错 —— 那件东西会永远躺在地上，谁都捡不起来，也没有任何提示。
      if (!itemTypeOf(drop.goodId)) {
        this.logger.warn(`掉落表里配了不存在的物品 ${drop.goodId}（来源怪物 ${monsterKey}）：这一件不生成`);
        continue;
      }
      result.push({
        ...drop,
        bound: monsterBind || bindOnDropOf(drop.goodId) || Math.random() * 100 < bindChance,
      });
    }
    return result;
  }

  /**
   * 随机绑定概率（百分比 0~100，读 `runtime_params.drop_params.bindChance`）
   *
   * 缺键 / 坏值 → 0（不随机绑定）：绑定会限制交易，配漏了就该「不生效」而不是
   * 「所有掉落都被锁」，前者只是少一个玩法，后者是玩家集体投诉。
   */
  private dropBindChance(): number {
    const value = Number(this.dropParams().bindChance);
    if (!Number.isFinite(value)) return 0;
    return Math.min(100, Math.max(0, value));
  }

  /** 掉落参数原样（`runtime_params.drop_params`；坏 JSON / 空列 → 空对象，不带任何默认值） */
  private dropParams(): Record<string, unknown> {
    const raw = this.runtimeParams.get()?.drop_params;
    if (!raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /**
   * 幂等键：`roleId:mapId:castId`（#827）
   *
   * 拿不到角色 / 位置（老档、刚建号、离线结算）就用空串占位 —— 空串只会让键更粗，
   * 不会让两条不同的出手撞在一起（castId 本身是单调递增的）。
   */
  private dedupeKeyOf(accountId: string, castId: number): string {
    const role = this.roles.online(accountId);
    const roleId = role?.id ?? "";
    const mapAt = typeof role?.data?.mapAt === "string" ? role.data.mapAt : "";
    return `${roleId}:${mapAt}:${castId}`;
  }

  /** 记住一次结算结果（按时间过期 + 容量上限兜底，超容量挤掉最旧的） */
  private remember(accountId: string, key: string, result: RealtimeSettleData): void {
    let book = this.recentSettles.get(accountId);
    if (!book) {
      book = new Map<string, RecentSettle>();
      this.recentSettles.set(accountId, book);
    }
    const now = Date.now();
    // Map 保持插入顺序 = 时间顺序，从头剔到第一个未过期为止
    for (const [entryKey, entry] of book) {
      if (now - entry.at <= CAST_DEDUPE_TTL_MS) break;
      book.delete(entryKey);
    }
    if (book.size >= CAST_DEDUPE_CAPACITY) {
      const oldest = book.keys().next().value;
      if (oldest !== undefined) book.delete(oldest);
    }
    book.set(key, { result, at: now });
  }

  //#endregion
}

//#region 类型与小工具（纯函数，e2e 可对照）

/** 幂等账的一条（#827：结果 + 写入时刻，供 TTL 剔除） */
interface RecentSettle {
  result: RealtimeSettleData;
  /** 写入时刻（`Date.now()`） */
  at: number;
}

/** 客户端 cast 消息解析后的形状 */
interface ParsedCast {
  castId: number;
  skillId: string;
  targetId: string;
  monsterKey: string;
  /** 区域 / 群体技能的作用点（#824；单体技能没有，缺省 = 以施法者为中心） */
  x?: number;
  y?: number;
}

// 三系攻击属性与「攻击 → 防御」映射在 common/constants/game-enums（怪物 AI 侧同一份，#823）
/**
 * 幂等账有效期（#827）：**≥ 最长技能冷却** —— 冷却内的重复投递一律拒，冷却走完再重放
 * 本来也打不出第二发（`cast-guard` 的冷却闸会拦）。`skills.cooldown` 现在最长 60s（1010），
 * 取 2 倍留余量；改技能表时要跟着看这里。
 */
const CAST_DEDUPE_TTL_MS = 120_000;

/**
 * 幂等账容量（#827）：TTL 内可能写多少条，就留多少位置 ——
 * 客户端最快约 250ms 一发，120s ≈ 480 发，留一倍余量取 1024。
 * **这个数只是内存兜底**，过期才是主逻辑；256 那种固定值会让「打得久」变成可重放。
 */
const CAST_DEDUPE_CAPACITY = 1024;

/**
 * 一次区域 / 群体施放最多命中几只（#824）
 *
 * 不是「玩法上限」而是**防爆量**：一份 cast 帧打中几百只怪 = 一次结算写几百行日志、
 * 几百次 AI 记恨、几百条掉落记账，一条改包帧就能把进程拖住。8 只盖住当前所有近战横扫
 * 的合理范围（刷怪区密度下，半径 200 内很少超过 5 只）。
 * 要按技能调这个数时再给 `skills` 加列 —— 现在全表零个群体技能，加一列没人填的字段
 * 只会多一处「配了没生效」的怀疑对象。
 */
const AOE_MAX_TARGETS = 8;

/**
 * 区域技能配了 `distance = 0`（不限距离）时退回的作用半径（#824）
 *
 * 「不限施法距离」对单体技能是合理的（擒龙手就是全图抓），对「一块地」则是全图 AOE。
 * 所以配 0 时按这个半径算并 warn 一次：静默按无限大处理，运营永远不知道自己配错了。
 * 取 200 是因为十步一杀的突进距离就是 200，近战横扫的量级一致。
 */
const AOE_DEFAULT_RADIUS = 200;

/**
 * 这个技能要不要点一只怪当目标（#824）
 *
 * 判据 = `target_type === "1"`（单体）且 `require_target` 没关（`#822` 起状态型技能配 0）。
 * 与客户端 `SkillManager.tryCast` 的判断同一口径
 * （`config.targetType === SINGLE && config.requireTarget !== false`）——
 * 两边各写一套的结果是「客户端去找目标、服务端说不用」，或者反过来。
 */
function needsMonsterTarget(skill: Record<string, unknown>): boolean {
  const targetType = String(skill.targetType ?? "1");
  if (targetType !== "1") return false;
  return skill.requireTarget !== false;
}

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
  // 落点（#824）：只有区域 / 群体技能会带。非数字 / NaN 一律当没给 ——
  // 区域技能那时退回「以施法者为中心」，而不是拒绝整帧
  const x = typeof data.x === "number" && Number.isFinite(data.x) ? data.x : undefined;
  const y = typeof data.y === "number" && Number.isFinite(data.y) ? data.y : undefined;
  return { castId, skillId: data.skillId, targetId, monsterKey, ...(x === undefined || y === undefined ? {} : { x, y }) };
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

/** 从配置行里读一个数字（缺字段 / 非数字 / NaN → `fallback`） */
function readNumber(source: object | null | undefined, key: string, fallback = 0): number {
  const value = Number((source as Record<string, unknown> | null | undefined)?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

/** 一次出手的暴击参数（角色基础 + 技能自带合成后的结果，#826） */
interface CritProfile {
  /** 触发概率（0~1） */
  rate: number;
  /** 触发后的倍率（> 1） */
  damage: number;
}

/**
 * 合成这一次出手的暴击参数（#826）
 *
 * - 概率**相加**：`desc` 里「附带 15% 暴击率」是叠加在角色暴击之上的 15 个百分点，
 *   不是替换。相加后裁到 1 —— 角色和技能都配满也不会变成「必然暴击」的意外。
 * - 倍率**技能优先、不相乘**：技能配了 > 1 就用自己的，否则用角色那 1.5。
 *   相乘会让「技能倍率」变成角色倍率的放大器 —— 调角色一个数，所有技能的暴击一起变。
 */
function critProfileOf(summary: object, skill: object): CritProfile {
  const rate = readNumber(summary, "critRate") + readNumber(skill, "critRate");
  const skillDamage = readNumber(skill, "critDamage");
  const roleDamage = readNumber(summary, "critDamage");
  return {
    rate: Math.min(1, Math.max(0, rate)),
    damage: skillDamage > 1 ? skillDamage : roleDamage > 1 ? roleDamage : DEFAULT_CRIT_DAMAGE,
  };
}

/**
 * 等级差每级的伤害压制系数（`growth_scalars.levelGapSuppress`，出厂 0.05）
 *
 * 从代码字面量搬进配置表是 #834 的收口项：系数属于「运营随时会改的数」，
 * 写死就意味着每调一次要发一版服务端。
 *
 * 三条读法：缺行 / 非数 → 出厂 0.05（老库没有这一行时行为与改动前一致）；
 * 负数 → 出厂值（负的压制等于「越级打怪更疼」，那不是配置错，是开了一个刷怪口子）；
 * 上限夹到 1（1 = 越 1 级就打不动，是合法语义，> 1 只会让整数等级差全部归零）。
 */
export const DEFAULT_LEVEL_GAP_SUPPRESS = 0.05;

function levelGapSuppressPerLevel(): number {
  const value = growthScalarOf("levelGapSuppress");
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return DEFAULT_LEVEL_GAP_SUPPRESS;
  return Math.min(1, value);
}

/**
 * 等级压制系数（#826 第三批，docs/22 §2.2 已定「严格压制」；#834 系数改配置）
 *
 * `sup = max(0, 1 − 系数 × max(0, targetLevel − attackerLevel))`
 *
 * - **只算目标比攻击者高多少**，不取绝对值：打低级怪既不吃惩罚也不加成；
 * - 出厂每级 -5%，越 20 级就是 0（打不动），不再有下限保护；
 * - 与经验侧的 `maxLevelGap` 是两条独立的线，都生效。
 */
function suppressionOf(attackerLevel: number, targetLevel: number): number {
  const gap = Math.max(0, Math.floor(targetLevel) - Math.floor(attackerLevel));
  // 同级 / 打低级怪直接短路：连配置都不读，热路径上省一次查表（系数对 gap=0 恒为 1）
  if (gap <= 0) return 1;
  return Math.max(0, 1 - levelGapSuppressPerLevel() * gap);
}

/**
 * 一次出手的伤害（#826：暴击与破防都收在这里，单体与区域共用一条公式）
 *
 * ```
 * 防御 = round(掷防御区间 × 怪物状态倍率 × (1 − 破防比例))
 * 基础 = max(0, round(掷攻击区间 × 状态攻击倍率 × 技能倍率 × 等级压制 − 防御))
 * 暴击 = 基础 > 0 && rand < 暴击率  →  伤害 = round(基础 × 暴击倍率)
 * ```
 *
 * 四处顺序都是刻意的：
 * - **破防削的是防御那一项**，不是最终伤害 —— 「无视防御」对高防目标收益更大，
 *   与 `desc` 里「目标防御越高增幅越明显」是同一个方向。
 * - **等级压制乘在扣防之前**（#826 第三批）：先按等级把「能打出多少」压下来，再减防御。
 *   反过来（先扣防再压制）会让 `sup=0` 时减完防御的 0 变成负数再被夹成 0，
 *   结果一样但语义混乱 —— 「越 20 级伤害为 0」应该是压制本身的结果。
 * - **基础伤害为 0 时不判暴击**（22 篇第 26 条）：0 伤害暴击只会让客户端播一个空特效。
 * - **暴击乘在最后**（22 篇第 23 条）：受击侧的格挡乘在它之后，顺序固定两端才不会算出不同数。
 */
function rollCastDamage(input: {
  attackRange: [number, number];
  attackMultiplier: number;
  rate: number;
  defenseRange: [number, number];
  defenseMultiplier: number;
  defIgnore: number;
  crit: CritProfile;
  /** 等级压制系数（1 = 无压制；0 = 打不动）。缺省 1，老调用方行为不变 */
  suppression?: number;
}): { damage: number; critical: boolean; suppressed: boolean } {
  const suppression = Math.max(0, Math.min(1, input.suppression ?? 1));
  const attack = rollRange(input.attackRange) * input.attackMultiplier * suppression;
  const ignore = Math.min(1, Math.max(0, input.defIgnore));
  const defense = Math.round(rollRange(input.defenseRange) * input.defenseMultiplier * (1 - ignore));
  const base = Math.max(0, Math.round(attack * input.rate - defense));
  const critical = base > 0 && input.crit.rate > 0 && Math.random() < input.crit.rate;
  return {
    damage: critical ? Math.round(base * input.crit.damage) : base,
    critical,
    // 「被压制」只看系数是否小于 1：sup=0 是它的极端情况，客户端据此显示「等级压制」而不是「伤害 0」
    suppressed: suppression < 1,
  };
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
 * 经验乘地图倍率（#812）：`floor(基础值 × rate)`，负数与 NaN 一律归 0
 *
 * 单独抽成纯函数是为了能直接对表断言（`e2e-map-rules` 拿 dist 里的它跑一组用例）——
 * 走真实击杀去验「恰好 2 倍」既慢又会因为中途升级而假红。
 */
export function scaleExp(base: number, rate: number): number {
  const factor = Number.isFinite(rate) && rate > 0 ? rate : 0;
  const value = Number.isFinite(base) ? base : 0;
  return Math.max(0, Math.floor(value * factor));
}

/**
 * 掉落概率乘地图倍率（#812）：`min(1, chance × rate)`
 *
 * **乘在 `chance` 而不是 `picks` 上**（2026-11-15 拍板）：掉落表是「先定抽取次数 → 每次按权重
 * 抽一条 → 过 chance 闸」的模型，乘 `picks` 会让 `rate = 2` 变成「抽两次」= 掉落真的翻倍，
 * 与运营对「这张图掉率翻倍」的直觉一致但会把事件次数也翻倍（掉落流水、消耗品产出都翻倍）；
 * 乘 `chance` 只改「抽到的那条落不落地」，事件次数不变。
 *
 * 封顶 1：`rate = 3` 时 `chance = 1` 的条目仍然是必掉（不是概率 3.0）——
 * 这也是「不掉率」口径 `P' = min(1, P × rate)` 的等价写法。
 */
export function scaleDropChance(chance: number, rate: number): number {
  const base = Number.isFinite(chance) ? chance : 0;
  const factor = Number.isFinite(rate) && rate > 0 ? rate : 0;
  return Math.max(0, Math.min(1, base * factor));
}

/**
 * 结算一次掉落表（与客户端 utils/drop/DropRoller.rollDropTable 同一口径）：
 * 先定抽取次数（数字 = 固定，[min, max] = 区间随机），再按权重独立抽取该次数
 * （可重复命中同一条目），每次命中后过概率、数量取区间随机，同一物品合并数量。
 *
 * `dropRate` = 地图的掉率倍率（#812）：只作用在 `chance` 闸上，见 `scaleDropChance`。
 * **抽取次数不乘** —— 乘了就等于「同一只怪掉两次」，流水与产出都会翻倍。
 */
function rollDropTable(
  table: { picks: number | [number, number]; entries: DropEntryRow[] },
  dropRate = 1,
): Array<{ goodId: string; count: number }> {
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
    // 概率判定（默认必掉；地图掉率在这里乘，封顶 1）与数量（默认 1）
    if (Math.random() > scaleDropChance(entry.chance ?? 1, dropRate)) continue;
    const count = dropRandomInt(entry.count?.[0] ?? 1, entry.count?.[1] ?? 1);
    if (count <= 0) continue;
    const existed = results.find((result) => result.goodId === entry.goodId);
    if (existed) existed.count += count;
    else results.push({ goodId: entry.goodId, count });
  }
  return results;
}

//#endregion
