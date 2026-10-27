import { Injectable, Logger } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";
import { NpcRepository } from "../../database/repositories/npc.repository";
import { QuestProgressRepository } from "../../database/repositories/quest-progress.repository";
import { QuestRepository } from "../../database/repositories/quest.repository";
import { QuestRow } from "../../database/rows";
import { parseRewardItems } from "../game-config/dto/quest.dto";
import { RolesService } from "../roles/roles.service";
import {
  MyQuestsDto,
  NpcTalkResultDto,
  QuestRewardResultDto,
  QuestStateDto,
  QuestSubmitResultDto,
} from "./dto/quest-state.dto";

/** 击杀事件的形状（CombatSettlementService 在世界权威判定死亡后递进来） */
export interface QuestKillEvent {
  accountId: string;
  roleId: string;
  monsterKey: string;
}

/**
 * 任务进度状态机（#396）
 *
 * **结算权威在服务端**：客户端只能「接 / 交 / 对话」，永远不能上报「我完成了」——
 * 击杀进度由 realtime 结算递进来（世界权威判定死亡的那一处），对话进度由 npc-talk
 * 递进来，collect 在交付时查背包。三处写入口都收敛在本 service。
 *
 * 进度帧（`quest`）只推给本人连接：`onProgress` 由 RealtimeService 在启动时接线
 * （connections 表是它的私有状态）；HTTP 进程不装 realtime 模块时回调为空，
 * 对话/接取/交付的进度变化由 HTTP 响应自己带回。
 */
@Injectable()
export class QuestService {
  private readonly logger = new Logger(QuestService.name);

  /** 进度变化出口（RealtimeService 接线；HTTP 进程为空） */
  onProgress: ((accountId: string, data: QuestStateDto) => void) | null = null;

  constructor(
    private readonly questsRepo: QuestRepository,
    private readonly progressRepo: QuestProgressRepository,
    private readonly roles: RolesService,
    private readonly npcsRepo: NpcRepository,
  ) {}

  /** 我的任务快照（可接任务不在内：客户端按快照配置与 claimed 行自己算） */
  mine(accountId: string): MyQuestsDto {
    return { quests: this.statesOf(accountId) };
  }

  /** 接取（等级 / 主线链前置在服务端复核，客户端的判断只是提前灰按钮） */
  accept(accountId: string, questId: string): MyQuestsDto {
    const quest = this.requireQuest(questId);
    const role = this.onlineRole(accountId);
    if (role.level < quest.min_level) {
      throw BizException.conflict(BizCode.QUEST_LEVEL_LOW, `等级达到 ${quest.min_level} 级才能接取「${quest.label}」`);
    }
    const existing = this.progressRepo.findByKey(role.id, questId);
    if (existing) {
      // daily 领奖后行已删除，能查到的 claimed 一定是主线 —— 已完成的主线不能重复接
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
      created_at: now,
      updated_at: now,
    });
    return this.mine(accountId);
  }

  /**
   * 交付（可交付 = kill/talk 已到 ready；collect 直接查背包）
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

    let consume: { goodId: string; count: number } | null = null;
    if (quest.objective_type === "collect") {
      if (row.status !== "accepted") throw BizException.conflict(BizCode.QUEST_STATE_INVALID, "任务状态不正确");
      consume = { goodId: quest.objective_target, count: quest.objective_count };
    } else if (row.status !== "ready") {
      throw BizException.conflict(BizCode.QUEST_STATE_INVALID, "任务还未完成，不能交付");
    }

    const rewards = {
      gold: quest.reward_gold,
      exp: quest.reward_exp,
      items: parseRewardItems(quest.reward_items),
    };
    const settled = this.roles.grantQuestRewards(accountId, role.id, consume, rewards);

    // daily 删行（可重接、进度清零）；main 保留 claimed 行作链门控
    if (quest.kind === "daily") this.progressRepo.remove(role.id, questId);
    else this.progressRepo.markClaimed(role.id, questId);

    const reward: QuestRewardResultDto = {
      gold: rewards.gold,
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
   */
  npcTalk(accountId: string, npcId: string): NpcTalkResultDto {
    const npc = this.npcsRepo.findByKey(npcId);
    if (!npc) throw BizException.notFound(BizCode.NPC_NOT_FOUND, `NPC ${npcId} 不存在`);
    const role = this.onlineRole(accountId);

    // 推进进行中的 talk 目标：只看 accepted 行，配置对得上才 +1
    for (const row of this.progressRepo.listByStatus(role.id, "accepted")) {
      const quest = this.questsRepo.findByKey(row.quest_id);
      if (!quest || quest.objective_type !== "talk" || quest.objective_target !== npcId) continue;
      const bumped = this.progressRepo.bumpProgress(role.id, quest.id, quest.objective_count);
      if (bumped) this.emitProgress(accountId, quest.id, bumped.status, bumped.progress, quest.objective_count);
    }

    // NPC 名下全部任务的状态（可接未接的返回 available 态 —— 客户端据此亮出「接取」按钮）
    const quests: QuestStateDto[] = [];
    for (const quest of this.questsRepo.listAll()) {
      if (quest.npc_id !== npcId) continue;
      const row = this.progressRepo.findByKey(role.id, quest.id);
      if (row) {
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
      out.push(this.stateOf(accountId, quest, row.status, row.progress));
    }
    return out;
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
