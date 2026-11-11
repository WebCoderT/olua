import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { QUEST_NPC_RADIUS, QUEST_POS_STALE_MS, weekStartDayOf } from "../../common/constants/quest";
import { BizException } from "../../common/errors/biz.exception";
import { GameEventsService, MonsterKilledEvent } from "../../common/events/game-events.service";
import { resetDayOf } from "../../common/utils/daily-clock";
import { MapNpcRepository } from "../../database/repositories/map-npc.repository";
import { NpcRepository } from "../../database/repositories/npc.repository";
import { QuestProgressRepository } from "../../database/repositories/quest-progress.repository";
import { QuestRepository } from "../../database/repositories/quest.repository";
import { RolePositionRepository } from "../../database/repositories/role-position.repository";
import { QuestProgressRow, QuestRow } from "../../database/rows";
import { parseRewardItems } from "../game-config/dto/quest.dto";
import { RolesService } from "../roles/roles.service";
import {
  MyQuestsDto,
  NpcTalkResultDto,
  QuestRewardResultDto,
  QuestStateDto,
  QuestSubmitResultDto,
} from "./dto/quest-state.dto";

/**
 * 击杀事件的形状 —— 与总线的 `monster:killed` 同形（#401 起由 `GameEventsService` 分发，
 * 不再由结算代码直接调本 service）
 */
export type QuestKillEvent = MonsterKilledEvent;

/**
 * 任务进度状态机（#396）
 *
 * **结算权威在服务端**：客户端只能「接 / 交 / 对话 / 放弃」，永远不能上报「我完成了」——
 * 击杀进度由 realtime 结算发 `monster:killed` 事件递进来（#401 起走总线，任务与成就
 * 共享同一个采集点），对话进度由 npc-talk 递进来，collect 在交付时查背包。
 * 三处写入口都收敛在本 service。
 *
 * 交互的**距离门槛**（#862/#863）：`accept` 与 `npcTalk` 都要求「角色此刻在发布 NPC 旁边」。
 * 位置从 `role_positions` 读 —— 那是实时进程每秒写的快照（两个进程只有 SQLite 一条路），
 * 带新鲜度窗口：查不到位置 / 快照太旧一律拒绝，绝不因为「不知道他在哪」就放行。
 *
 * **周期**（#864）：main 一次性 / daily 按每日 05:00 切 / weekly 按周一 05:00 切。
 * 三者共用 `quest_progress.reset_day` 一列：存的是**本轮的起点天号**（日常 = 今天、
 * 周常 = 本周周一），所以「行落后了」永远是同一个比较 `reset_day < 本轮起点`。
 *
 * 进度帧（`quest`）只推给本人连接：`onProgress` 由 RealtimeService 在启动时接线
 * （connections 表是它的私有状态）；HTTP 进程不装 realtime 模块时回调为空，
 * 对话/接取/交付的进度变化由 HTTP 响应自己带回。
 *
 * 交付成功后 `emit("quest:claimed")` —— 成就的「累计交付 N 个任务」由此记账，
 * 任务这边不需要知道有谁在听。
 */
@Injectable()
export class QuestService implements OnModuleInit {
  private readonly logger = new Logger(QuestService.name);

  /** 进度变化出口（RealtimeService 接线；HTTP 进程为空） */
  onProgress: ((accountId: string, data: QuestStateDto) => void) | null = null;

  /** 已经告警过「这个 NPC 在图上没有点位」的键（`mapId:npcId`）；避免每次交互刷一条日志 */
  private readonly warnedNpcKeys = new Set<string>();

  constructor(
    private readonly questsRepo: QuestRepository,
    private readonly progressRepo: QuestProgressRepository,
    private readonly roles: RolesService,
    private readonly npcsRepo: NpcRepository,
    private readonly mapNpcsRepo: MapNpcRepository,
    private readonly positionsRepo: RolePositionRepository,
    private readonly events: GameEventsService,
  ) {}

  /** 订阅击杀事件（结算侧只负责 emit，本 service 是订阅方之一） */
  onModuleInit(): void {
    this.events.on("monster:killed", (event) => this.onMonsterKilled(event));
  }

  /** 我的任务快照（可接任务不在内：客户端按快照配置与 claimed 行自己算） */
  mine(accountId: string): MyQuestsDto {
    return { quests: this.statesOf(accountId) };
  }

  /**
   * 接取（等级 / 前置 / 周期闸门 / **站到发布 NPC 旁边**都在服务端复核）
   *
   * 客户端的判断只是提前灰按钮：任意 `questId` 直接打过来，服务端会按下面的顺序拒：
   * 1. 任务不存在（50031）→ 2. 等级不够（20016）→ 3. 不在 NPC 旁边（20032，#863）；
   * 4. 周期闸门（见下）→ 5. 主线链前置没完成（20015）。
   *
   * **周期闸门**（#815 日常 / #864 周常）：行还在就不再是「可接」，要看它属于哪一轮 ——
   * - 本轮的行已领奖 → `already_done`（这一轮到此为止，下一轮自然可再接）；
   * - 本轮的行还没领 → 「已经接取了这个任务」；
   * - 行属于更早的轮次 → 原地覆盖重置（进度清零、回 accepted）。
   *
   * 最后一条同时覆盖了「昨天接了没做完，今天重新接」与「昨天接了没交，跨期后照常可接」——
   * 过期行在 `statesOf` 里不下发，客户端看到的本来就是可接态，这里补的是服务端那一半。
   */
  accept(accountId: string, questId: string): MyQuestsDto {
    const quest = this.requireQuest(questId);
    const role = this.onlineRole(accountId);
    if (role.level < quest.min_level) {
      throw BizException.conflict(BizCode.QUEST_LEVEL_LOW, `等级达到 ${quest.min_level} 级才能接取「${quest.label}」`);
    }
    // #863：接取也要人在 NPC 旁边（以前任意 id 直接接，跑图任务等于白送）
    this.requireNearNpc(role.id, quest.npc_id, quest.label);
    const periodDay = this.periodDayOf(quest);
    const existing = this.progressRepo.findByKey(role.id, questId);
    if (existing) {
      if (this.isPeriodic(quest) && existing.reset_day < periodDay) {
        this.progressRepo.resetForNewDay(role.id, questId, periodDay);
        return this.mine(accountId);
      }
      if (this.isPeriodic(quest) && existing.status === "claimed") {
        throw BizException.conflict(BizCode.QUEST_ALREADY_DONE, this.periodDoneMessage(quest));
      }
      // 剩下的都是「行在这、这一轮动不了」：日常已接未交 / 主线已接或已领
      throw BizException.conflict(
        BizCode.QUEST_STATE_INVALID,
        existing.status === "claimed" ? "该任务已完成，不能重复接取" : "已经接取了这个任务",
      );
    }
    if (quest.prev_quest_id) {
      const prev = this.progressRepo.findByKey(role.id, quest.prev_quest_id);
      if (!prev || prev.status !== "claimed") {
        throw BizException.conflict(BizCode.QUEST_STATE_INVALID, "先完成前置任务才能接取");
      }
    }
    const now = Date.now();
    this.progressRepo.insert({
      role_id: role.id,
      quest_id: questId,
      status: "accepted",
      progress: 0,
      claimed_at: null,
      reset_day: periodDay,
      created_at: now,
      updated_at: now,
    });
    return this.mine(accountId);
  }

  /**
   * 放弃（#865）
   *
   * 只放进行中 / 可交付的行：**已领奖的不能放弃**（那是「这一轮的证据」，删了就回到可接，
   * 等于把日常变成无限经验矿 —— #815 的洞就是这么开的）。
   *
   * 放弃 = 删行 = 回到可接态：日常 / 周常当轮还能再接一次（没领奖就没占额度），
   * 主线也回到「没接过」。已经过期的行删掉同样是幂等的（本来就等价于没接）。
   */
  abandon(accountId: string, questId: string): MyQuestsDto {
    this.requireQuest(questId);
    const role = this.onlineRole(accountId);
    const row = this.progressRepo.findByKey(role.id, questId);
    if (!row) throw BizException.conflict(BizCode.QUEST_STATE_INVALID, "还没有接取这个任务");
    if (row.status === "claimed") {
      throw BizException.conflict(BizCode.QUEST_STATE_INVALID, "已完成的任务不能放弃（奖励已经领过了）");
    }
    this.progressRepo.remove(role.id, questId);
    return this.mine(accountId);
  }

  /**
   * 交付（可交付 = kill/talk 已到 ready；collect 直接查背包）
   *
   * **过期不可交付**（#865）：日常 / 周常的行如果属于更早的一轮（`reset_day` 落后），
   * 一律 `quest_expired`（20033）—— 以前这种行会照常发奖，「昨天接了没交，今天补交」
   * 白拿一轮奖励，而且这一轮还会被算成「今天领过」。
   *
   * 发奖走 `grantQuestRewards` 的**单次落库**：材料不足（20017）与背包放不下（20012）
   * 都在校验阶段抛出，进度行保持原状 —— collect 任务材料不够时仍是 accepted，
   * 补齐材料后可以再来交付。
   */
  submit(accountId: string, questId: string): QuestSubmitResultDto {
    const quest = this.requireQuest(questId);
    const role = this.onlineRole(accountId);
    const row = this.progressRepo.findByKey(role.id, questId);
    if (!row) throw BizException.conflict(BizCode.QUEST_STATE_INVALID, "还没有接取这个任务");
    if (row.status === "claimed") throw BizException.conflict(BizCode.QUEST_STATE_INVALID, "奖励已经领取过了");
    if (this.isPeriodic(quest) && row.reset_day < this.periodDayOf(quest)) {
      throw new BizException(BizCode.QUEST_EXPIRED, this.periodExpiredMessage(quest));
    }

    let consume: { goodId: string; count: number } | null = null;
    if (quest.objective_type === "collect") {
      if (row.status !== "accepted") throw BizException.conflict(BizCode.QUEST_STATE_INVALID, "任务状态不正确");
      consume = { goodId: quest.objective_target, count: quest.objective_count };
    } else if (row.status !== "ready") {
      throw BizException.conflict(BizCode.QUEST_STATE_INVALID, "任务还未完成，不能交付");
    }

    const rewards = {
      bindGold: quest.reward_bind_gold,
      exp: quest.reward_exp,
      items: parseRewardItems(quest.reward_items),
    };
    const settled = this.roles.grantQuestRewards(accountId, role.id, consume, rewards, "quest");

    // daily 与 main 一样只改状态、不删行（#815）：删行会把「今天领过」的证据一起删掉，
    // 于是 accept 无从判断，一条日常能被刷上千次。日切靠 reset_day，跨天由 accept 覆盖重置。
    this.progressRepo.markClaimed(role.id, questId);

    // 交付成功 → 广播（成就的「累计交付 N 个任务」由此记账；订阅方失败不影响本次交付）
    this.events.emit("quest:claimed", { accountId, roleId: role.id, roleName: role.name, questId, kind: quest.kind });

    const reward: QuestRewardResultDto = {
      bindGold: rewards.bindGold,
      exp: rewards.exp,
      items: rewards.items,
      level: settled.level,
      leveledUp: settled.leveledUp,
    };
    return { quests: this.statesOf(accountId), reward };
  }

  /**
   * NPC 对话（#396 的 talk 目标入口）
   *
   * 一次对话做三件事：推进进行中的 talk 任务（+1，到量转 ready）、
   * 带回该 NPC 名下全部任务在当前角色上的状态（含可接但未接的 —— 客户端据此
   * 在对话后打开任务界面）、带回管理端配置的对话文案。
   *
   * **先过距离门槛再推进度**（#862）：以前只凭请求里的 `npcId` 就算完成，
   * 连点两次请求就能把「走过去找人」的跑图任务刷完。
   */
  npcTalk(accountId: string, npcId: string): NpcTalkResultDto {
    const npc = this.npcsRepo.findByKey(npcId);
    if (!npc) throw BizException.notFound(BizCode.NPC_NOT_FOUND, `NPC ${npcId} 不存在`);
    const role = this.onlineRole(accountId);
    // 不存在 / 不同图 / 太远都在这道闸里（返 20032 not_near_npc）
    this.requireNearNpc(role.id, npcId, npc.label);

    // 推进进行中的 talk 目标：只看 accepted 行，配置对得上才 +1
    for (const row of this.progressRepo.listByStatus(role.id, "accepted")) {
      const quest = this.questsRepo.findByKey(row.quest_id);
      if (!quest || quest.objective_type !== "talk" || quest.objective_target !== npcId) continue;
      // 过期的行不推进（#865）：日常 / 周常跨轮之后，那一行已经不是「这一轮的任务」了
      if (this.isStale(quest, row)) continue;
      const bumped = this.progressRepo.bumpProgress(role.id, quest.id, quest.objective_count);
      if (bumped) this.emitProgress(accountId, quest.id, bumped.status, bumped.progress, quest.objective_count);
    }

    // NPC 名下全部任务的状态（可接未接的返回 available 态 —— 客户端据此亮出「接取」按钮）
    const quests: QuestStateDto[] = [];
    for (const quest of this.questsRepo.listAll()) {
      if (quest.npc_id !== npcId) continue;
      const row = this.progressRepo.findByKey(role.id, quest.id);
      if (row && !this.isStale(quest, row)) {
        quests.push(this.stateOf(accountId, quest, row.status, row.progress));
      } else {
        quests.push(QuestStateDto.from(quest.id, "available", 0, quest.objective_count));
      }
    }
    return { dialog: npc.dialog, quests };
  }

  /**
   * 击杀事件 → kill 目标推进度（realtime 结算调用）
   *
   * 找不到匹配任务 / 没有进行中的行都是正常情况（大多数击杀与任务无关），静默返回；
   * 写库失败只打日志**不向上抛** —— 任务进度失败不该回滚世界击杀与经验/掉落。
   */
  onMonsterKilled(event: QuestKillEvent): void {
    try {
      for (const row of this.progressRepo.listByStatus(event.roleId, "accepted")) {
        const quest = this.questsRepo.findByKey(row.quest_id);
        if (!quest || quest.objective_type !== "kill" || quest.objective_target !== event.monsterKey) continue;
        // 过期行不推进（#865）：跨轮的日常 / 周常行留着当「上一轮领过没有」的证据，
        // 但它已经不该再长进度了（否则下一轮接取时被 resetForNewDay 清零，白干）
        if (this.isStale(quest, row)) continue;
        const bumped = this.progressRepo.bumpProgress(event.roleId, quest.id, quest.objective_count);
        if (bumped) {
          this.emitProgress(event.accountId, quest.id, bumped.status, bumped.progress, quest.objective_count);
        }
      }
    } catch (error) {
      this.logger.warn(
        `任务击杀进度写入失败：账号 ${event.accountId} 角色 ${event.roleId} 怪物 ${event.monsterKey} —— ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // —— 内部 ——

  /** 进度行 → 客户端状态（collect 的进度实时算背包持有量，与目标取小） */
  private statesOf(accountId: string): QuestStateDto[] {
    const role = this.roles.online(accountId);
    if (!role) return [];
    const out: QuestStateDto[] = [];
    for (const row of this.progressRepo.listByRole(role.id)) {
      const quest = this.questsRepo.findByKey(row.quest_id);
      if (!quest) continue;
      if (this.isStale(quest, row)) continue;
      out.push(this.stateOf(accountId, quest, row.status, row.progress));
    }
    return out;
  }

  /**
   * 这一行是不是「上一轮留下的」
   *
   * 日常 / 周常才有时效：`reset_day` 记的是**本轮起点天号**（日常 = 那天、周常 = 本周周一），
   * 落后就说明换轮了。主线没有轮次（一次性），永远不过期。
   */
  private isStale(quest: QuestRow, row: QuestProgressRow): boolean {
    return this.isPeriodic(quest) && row.reset_day < this.periodDayOf(quest);
  }

  /** 有时效的任务（日常按天、周常按周）；主线一次性，不参与轮次计算 */
  private isPeriodic(quest: QuestRow): boolean {
    return quest.kind === "daily" || quest.kind === "weekly";
  }

  /**
   * 本轮起点的天号
   *
   * 日常 = 今天的天号（05:00 切）／周常 = 本周周一的天号（周一 05:00 切）。
   * 两把尺子都在 `common/constants/quest.ts` 与 `daily-clock.ts` 里，别在别处再算一遍。
   */
  private periodDayOf(quest: QuestRow, now: number = Date.now()): number {
    return quest.kind === "weekly" ? weekStartDayOf(now) : resetDayOf(now);
  }

  /** 「这一轮已经完成」的文案（日常 / 周常的下一轮时点不同，别让玩家猜） */
  private periodDoneMessage(quest: QuestRow): string {
    return quest.kind === "weekly"
      ? `本周的「${quest.label}」已经完成过了，下周一 05:00 之后再来`
      : `今天的「${quest.label}」已经完成过了，明天 05:00 之后再来`;
  }

  /** 「这一行已经过期」的文案（#865：跨轮之后不许交付） */
  private periodExpiredMessage(quest: QuestRow): string {
    return quest.kind === "weekly"
      ? `「${quest.label}」是上一周的周常，已经过期了，重新接取本周的吧`
      : `「${quest.label}」是昨天（或更早）的日常，已经过期了，重新接取今天的吧`;
  }

  /**
   * 站到 NPC 旁边了才算数（#862/#863）
   *
   * 四道判据，任何一道不过都返 `not_near_npc`（20032，400）：
   * - 配置里没有发布 NPC（老数据空串）→ **不拦**：没有可站的地方，硬拦等于把任务关掉；
   * - 位置快照查不到 / 超过 `QUEST_POS_STALE_MS` → 不知道他在哪，拒绝（不能因为「不知道」就放行，
   *   否则「不上报位置」就是绕过距离校验的开关）；
   * - 这个 NPC 在他所在的图上**没有点位** → 放行 + 告警一次（见下）；
   * - 直线距离超过 `QUEST_NPC_RADIUS` → 拒绝，文案里带上实际距离便于玩家自己判断。
   *
   * **为什么「缺点位」放行而不是拒绝**（2026-11-11 定）：`npcs` 有行、`map_npcs` 没点位的
   * NPC 在现网是存在的（任务 8004 的战魂使者 9002 就是），玩家根本无处可站 —— 拿配置缺口
   * 卡住主线，比「暂时没有距离保护」坏得多。与 #850「越界区宁可贴边也不让这区消失」同一取向：
   * 缺的东西要能被看见（告警一次），但不能变成玩家侧的阻塞。点位补上之后**自动生效**，
   * 不需要再改代码。
   */
  private requireNearNpc(roleId: string, npcId: string, label: string): void {
    if (!npcId) return;
    const npc = this.npcsRepo.findByKey(npcId);
    if (!npc) throw BizException.notFound(BizCode.NPC_NOT_FOUND, `NPC ${npcId} 不存在`);
    const position = this.positionsRepo.findByRole(roleId);
    if (!position || Date.now() - position.updated_at > QUEST_POS_STALE_MS) {
      throw new BizException(BizCode.QUEST_NOT_NEAR_NPC, `还没收到你的位置，走到「${npc.label}」旁边再试`);
    }
    const spot = this.mapNpcsRepo.findByNpc(position.map_id, npcId);
    if (!spot) {
      // 两种「本图查不到」要分开（见 MapNpcRepository.countByNpc 的注释）：
      // 全服都没摆 = 配置缺口 → 放行 + 告警；只摆在别的图 = 玩家走错图 → 拒绝
      if (this.mapNpcsRepo.countByNpc(npcId) > 0) {
        throw new BizException(BizCode.QUEST_NOT_NEAR_NPC, `「${npc.label}」不在你当前这张图上，走过去找他`);
      }
      const key = `${position.map_id}:${npcId}`;
      if (!this.warnedNpcKeys.has(key)) {
        this.warnedNpcKeys.add(key);
        this.logger.warn(
          `NPC「${npc.label}」(${npcId}) 在任何图上都没有点位（map_npcs 缺行），该任务暂时不做距离校验 —— 管理端地图页摆上去即自动生效`,
        );
      }
      return;
    }
    const distance = Math.hypot(spot.cx - position.x, spot.cy - position.y);
    if (distance > QUEST_NPC_RADIUS) {
      throw new BizException(
        BizCode.QUEST_NOT_NEAR_NPC,
        `离「${npc.label}」太远了（${Math.round(distance)} 像素，需要 ${QUEST_NPC_RADIUS} 以内），走近再试`,
      );
    }
  }

  private stateOf(accountId: string, quest: QuestRow, status: string, progress: number): QuestStateDto {
    let value = Math.max(0, progress);
    if (status === "accepted" && quest.objective_type === "collect" && quest.objective_target) {
      const held = this.roles.countGoodInBag(accountId, quest.objective_target);
      value = Math.min(held, quest.objective_count);
    }
    return QuestStateDto.from(quest.id, status, value, quest.objective_count);
  }

  private emitProgress(accountId: string, questId: string, status: string, progress: number, target: number): void {
    try {
      this.onProgress?.(accountId, QuestStateDto.from(questId, status, progress, target));
    } catch (error) {
      this.logger.warn(`任务进度帧发送失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private requireQuest(id: string): QuestRow {
    const row = this.questsRepo.findByKey(id);
    if (!row) throw BizException.notFound(BizCode.QUEST_NOT_FOUND, `任务 ${id} 不存在`);
    return row;
  }

  private onlineRole(accountId: string) {
    const role = this.roles.online(accountId);
    if (!role) throw BizException.conflict(BizCode.ROLE_NOT_FOUND, "当前没有在线角色，先选一个角色再操作");
    return role;
  }
}
