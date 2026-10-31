import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { BizException, isBizCode } from "../../common/errors/biz.exception";
import {
  GameEventsService,
  MonsterKilledEvent,
  QuestClaimedEvent,
} from "../../common/events/game-events.service";
import { AchievementRepository } from "../../database/repositories/achievement.repository";
import { RoleAchievementRepository } from "../../database/repositories/role-achievement.repository";
import { AchievementRow, RoleAchievementRow } from "../../database/rows";
import { parseRewardItems } from "../../common/utils/reward-items.util";
import { roleAttributeSourceOf, summarizeRoleAttributes } from "../combat/role-attributes";
import { RoleDto } from "../roles/dto/role.dto";
import { GameMailService } from "../game-mail/game-mail.service";
import { RolesService } from "../roles/roles.service";
import {
  AchievementClaimResultDto,
  AchievementSummaryDto,
  AchievementViewDto,
  MyAchievementsDto,
} from "./dto/achievement.dto";

/** 累计型条件（进度要靠事件记账的那两种） */
const CUMULATIVE_TYPES = new Set(["kill", "quest"]);

/**
 * 成就系统（#401）
 *
 * ## 一条最重要的分界：累计型 vs 状态型
 * - **累计型**（`kill` / `quest`）：条件描述的是「做过多少次」，只有事件流知道 ——
 *   订阅 `monster:killed` / `quest:claimed` 把 `role_achievements.progress` +1。
 * - **状态型**（`level` / `combat` / `collect`）：条件描述的是「现在是什么样」，
 *   每次查询按角色当前状态现算（等级 / 战力 / 背包持有量）。**不落进度** ——
 *   存一份投影的唯一后果是「角色变强了成就进度没动」，还得为它写同步逻辑。
 *
 * ## 达成与领奖是两件事
 * `achieved_at` 非空 = 达成（可领）；`claimed_at` 非空 = 已领。**不自动发奖**：
 * 上线瞬间给全员背包塞东西是事故，而且背包满时自动发奖只能丢。
 * 领取走 `RolesService.grantQuestRewards`（与任务交付同一发奖入口，一次落库）。
 * **背包放不下（20012）时不再把玩家堵在这里**（#429）：整份奖励转成一封邮件，
 * 照常记 `claimed_at`，接口回 `mailId` —— 玩家去收件箱领，不用先猜是哪件东西放不下。
 *
 * ## 状态型的达成时刻
 * 累计型的 `achieved_at` 是真实时刻（事件驱动，写下那一刻就是达成那一刻）；
 * 状态型没有单一时刻（「我什么时候到 10 级的」——那是连续过程），它的
 * `achieved_at` 在**领取时补写**，语义等同「首次确认达成」。查询（GET）不写库：
 * 一个读接口顺手改数据，会让「刷新一下进度变了」这种误会永远解释不完。
 */
@Injectable()
export class AchievementService implements OnModuleInit {
  private readonly logger = new Logger(AchievementService.name);

  constructor(
    private readonly achievementsRepo: AchievementRepository,
    private readonly records: RoleAchievementRepository,
    private readonly roles: RolesService,
    private readonly events: GameEventsService,
    private readonly mails: GameMailService,
  ) {}

  /** 订阅两条累计型事件（结算侧只 emit，不认识成就） */
  onModuleInit(): void {
    this.events.on("monster:killed", (event) => this.onMonsterKilled(event));
    this.events.on("quest:claimed", (event) => this.onQuestClaimed(event));
  }

  /** 我的成就（配置全量 + 我的状态；状态型进度在这里现算） */
  mine(accountId: string): MyAchievementsDto {
    const role = this.requireOnlineRole(accountId);
    const views = this.viewsOf(accountId, role);
    return { achievements: views, summary: this.summaryOf(views) };
  }

  /**
   * 领奖
   *
   * 顺序是**先校验后发奖**：未达成 / 已领都在发奖之前抛出，异常路径不落库。
   * 发奖成功后才写 `achieved_at`（状态型补写）与 `claimed_at` —— 中途失败
   * （背包满 20012）时三个状态一个都没动，玩家清包后重试即可。
   */
  claim(accountId: string, achievementId: string): AchievementClaimResultDto {
    const role = this.requireOnlineRole(accountId);
    const row = this.achievementsRepo.findByKey(achievementId);
    if (!row) throw BizException.notFound(BizCode.ACHIEVEMENT_NOT_FOUND, `成就 ${achievementId} 不存在`);

    const record = this.records.findByKey(role.id, achievementId);
    const view = this.viewOf(accountId, role, row, record);
    if (!view.achieved) {
      throw BizException.conflict(BizCode.ACHIEVEMENT_NOT_ACHIEVED, `成就「${row.label}」还没有达成`);
    }
    if (view.claimed) {
      throw BizException.conflict(BizCode.ACHIEVEMENT_CLAIMED, `成就「${row.label}」的奖励已经领取过了`);
    }

    const items = parseRewardItems(row.reward_items);
    let settled: { level: number; leveledUp: boolean };
    let mailId: string | null = null;
    try {
      settled = this.roles.grantQuestRewards(accountId, role.id, null, {
        gold: row.reward_gold,
        exp: row.reward_exp,
        items,
      });
    } catch (error) {
      // 背包满：整份奖励（金币 / 经验 / 物品）转邮件，而不是让玩家先去猜是哪件东西放不下（#429）
      if (!isBizCode(error, BizCode.MALL_BAG_FULL)) throw error;
      const mail = this.mails.send(role.id, {
        channel: "reward",
        kind: "achievement",
        title: `成就奖励：${row.label}`,
        body: `「${row.label}」的奖励因背包已满转入邮箱，清理背包后在这里领取即可。`,
        gold: row.reward_gold,
        exp: row.reward_exp,
        items,
      });
      mailId = mail.id;
      settled = { level: role.level, leveledUp: false };
    }

    // 状态型的 achieved_at 在这里补写（它没有单一达成时刻，见类注释）
    if (!record || record.achieved_at === null) this.records.markAchieved(role.id, achievementId);
    this.records.markClaimed(role.id, achievementId);

    const views = this.viewsOf(accountId, role);
    return {
      achievements: views,
      summary: this.summaryOf(views),
      gold: row.reward_gold,
      exp: row.reward_exp,
      items,
      level: settled.level,
      leveledUp: settled.leveledUp,
      mailId,
    };
  }

  // —— 事件订阅（累计型）——

  /**
   * 击杀事件 → 累计型成就 +1
   *
   * 写库失败只打日志**不向上抛**：成就进度失败不该回滚世界击杀与经验/掉落
   * （总线本身也会兜，这里再兜一次是为了让日志能说清是哪条链路坏了）。
   */
  private onMonsterKilled(event: MonsterKilledEvent): void {
    try {
      for (const row of this.achievementsRepo.listAll()) {
        if (row.condition_type !== "kill") continue;
        if (row.condition_target !== "*" && row.condition_target !== event.monsterKey) continue;
        this.bump(event.roleId, row);
      }
    } catch (error) {
      this.logger.warn(
        `成就击杀进度写入失败：账号 ${event.accountId} 角色 ${event.roleId} 怪物 ${event.monsterKey} —— ${this.reasonOf(error)}`,
      );
    }
  }

  /** 任务交付事件 → 累计型成就 +1（不区分 main / daily：都是「交付了一个任务」） */
  private onQuestClaimed(event: QuestClaimedEvent): void {
    try {
      for (const row of this.achievementsRepo.listAll()) {
        if (row.condition_type !== "quest") continue;
        this.bump(event.roleId, row);
      }
    } catch (error) {
      this.logger.warn(
        `成就任务进度写入失败：账号 ${event.accountId} 角色 ${event.roleId} 任务 ${event.questId} —— ${this.reasonOf(error)}`,
      );
    }
  }

  /** 累计一次；到量即达成（达成后不再累加，避免这一列无限涨） */
  private bump(roleId: string, row: AchievementRow): void {
    const record = this.records.findByKey(roleId, row.id);
    if (record?.achieved_at) return;
    const bumped = this.records.bump(roleId, row.id);
    if (bumped && bumped.progress >= Math.max(1, row.condition_count)) {
      this.records.markAchieved(roleId, row.id);
    }
  }

  // —— 视图 ——

  private viewsOf(accountId: string, role: RoleDto): AchievementViewDto[] {
    const records = new Map(this.records.listByRole(role.id).map((item) => [item.achievement_id, item]));
    // 状态型要读背包与战力：一次查询里各算一次，不按成就条数重复算
    const bagCounts = new Map<string, number>();
    const combat = summarizeRoleAttributes(roleAttributeSourceOf(role.level, role.data))?.combat ?? 0;
    return this.achievementsRepo.listAll().map((row) =>
      this.viewOf(accountId, role, row, records.get(row.id), { bagCounts, combat }),
    );
  }

  /**
   * 一条成就的当前视图
   *
   * `progress` 一律**钳到门槛**：累计型堆到 137/100 没有意义，客户端也不必自己夹。
   */
  private viewOf(
    accountId: string,
    role: RoleDto,
    row: AchievementRow,
    record: RoleAchievementRow | undefined,
    cache?: { bagCounts: Map<string, number>; combat: number },
  ): AchievementViewDto {
    const target = Math.max(1, row.condition_count);
    const raw = this.currentOf(accountId, role, row, record, cache);
    const achieved = (record?.achieved_at ?? null) !== null || raw >= target;
    const claimed = (record?.claimed_at ?? null) !== null;
    return AchievementViewDto.of(row, Math.min(raw, target), target, achieved, claimed);
  }

  /** 当前进度值：累计型读记账，状态型现算 */
  private currentOf(
    accountId: string,
    role: RoleDto,
    row: AchievementRow,
    record: RoleAchievementRow | undefined,
    cache?: { bagCounts: Map<string, number>; combat: number },
  ): number {
    if (CUMULATIVE_TYPES.has(row.condition_type)) return Math.max(0, record?.progress ?? 0);
    switch (row.condition_type) {
      case "level":
        return Math.max(1, role.level);
      case "combat":
        return cache?.combat ?? summarizeRoleAttributes(roleAttributeSourceOf(role.level, role.data))?.combat ?? 0;
      case "collect": {
        const goodId = row.condition_target;
        if (!goodId) return 0;
        if (cache) {
          const hit = cache.bagCounts.get(goodId);
          if (hit !== undefined) return hit;
          const counted = this.roles.countGoodInBag(accountId, goodId);
          cache.bagCounts.set(goodId, counted);
          return counted;
        }
        return this.roles.countGoodInBag(accountId, goodId);
      }
      default:
        return 0;
    }
  }

  private summaryOf(views: AchievementViewDto[]): AchievementSummaryDto {
    return {
      total: views.length,
      achieved: views.filter((item) => item.achieved).length,
      claimed: views.filter((item) => item.claimed).length,
    };
  }

  private requireOnlineRole(accountId: string): RoleDto {
    const role = this.roles.online(accountId);
    if (!role) throw BizException.conflict(BizCode.ROLE_NOT_FOUND, "当前没有在线角色，先选一个角色再操作");
    return role;
  }

  private reasonOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
