import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BizCode } from "../../common/constants/biz-code";
import { BizException, isBizCode } from "../../common/errors/biz.exception";
import { parseRewardItems } from "../../common/utils/reward-items.util";
import { RoleMailRepository } from "../../database/repositories/role-mail.repository";
import { RoleMailRow } from "../../database/rows";
import { RolesService } from "../roles/roles.service";

/** 一轮自动入包的结果（测试与运维看三个数就够，不返回明细 —— 明细在 `event_logs` 里） */
export interface MailAutoClaimSweepResult {
  /** 本轮扫到的候选数（快过期 + 未领 + 有奖励 + 主人离线） */
  scanned: number;
  /** 成功入包（邮件同时被标已领、正文追加一行） */
  claimed: number;
  /** 失败（背包满 / 乐观锁冲突等），已记 `auto_attempts + 1` */
  failed: number;
}

/**
 * 过期前自动入包（#867）
 *
 * ## 解决的问题
 *
 * 邮件到期后**读口就滤掉了**（#439），玩家 30 天没上线回来只看到「邮件没了」。而清理任务
 * 又不敢删带未领奖励的行，于是 `attachments = '[]'` 的**纯金币 / 纯经验补偿邮件**反而被
 * 直接物理删除，奖励凭空蒸发 —— 这是 #867 真正的病灶（不是 issue 原文说的「磁盘只增」）。
 *
 * 口径（已定）：**过期不删、自动入包**。到期前 3 天把附件塞进背包，入包成功才允许清理。
 *
 * ## 三条硬约束
 *
 * 1. **只对离线角色做**。在线角色的存档在客户端手里（它随时会全量覆盖），服务端改了库
 *    会被冲掉 —— 那是「静默丢东西」里最难查的一种。判据在仓储的 SQL 里（JOIN accounts）。
 * 2. **每个角色一份独立事务、逐封处理**。与一键领取同一个理由：一封失败不拖累其他封。
 * 3. **失败不删、只记次数**。`auto_attempts` 到上限就停手，邮件留在箱里等人工 ——
 *    「宁可占一行，不能替玩家扔奖励」。
 *
 * ## 双进程互斥
 *
 * `GameMailModule` 同时挂在 API 与实时两个进程的 imports 上，两边都会起这个定时器。
 * 互斥**不靠内存锁**（跨进程无效），靠 #868 那条 SQL：事务里先 `markClaimed`
 * （`WHERE claimed_at IS NULL`），命中 0 行即说明另一个进程已经领走 → 抛 50142 整体回滚。
 */
@Injectable()
export class GameMailAutoClaimService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GameMailAutoClaimService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly mails: RoleMailRepository,
    private readonly roles: RolesService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const interval = this.intervalMs();
    if (interval <= 0) {
      this.logger.warn("MAIL_AUTO_CLAIM_INTERVAL_MS 非正数：过期前自动入包未启动（到期邮件只能靠玩家自己领）");
      return;
    }
    this.timer = setInterval(() => this.sweep(), interval);
    // 不阻止进程退出 —— 否则 e2e 跑完会挂在那里
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * 跑一轮（测试直接调，不用等定时器）
   *
   * @param now 注入「现在」，测试可以把时间拨到过期前 2 天
   */
  sweep(now: number = Date.now()): MailAutoClaimSweepResult {
    const result: MailAutoClaimSweepResult = { scanned: 0, claimed: 0, failed: 0 };
    let candidates: RoleMailRow[];
    try {
      candidates = this.mails.listAutoClaimCandidates(now + this.leadMs(), this.maxAttempts(), this.batchSize());
    } catch (error) {
      // 旁路任务：扫不动就下一轮，绝不把启动流程拖挂
      this.logger.warn(`自动入包扫描失败：${messageOf(error)}`);
      return result;
    }
    result.scanned = candidates.length;

    for (const mail of candidates) {
      const items = parseRewardItems(mail.attachments);
      try {
        this.mails.transaction(() => {
          // 闸门：命中 0 行 = 玩家刚点了领取 / 另一个进程先动了，这封就别再发一次
          if (!this.mails.markClaimed(mail.id, now)) {
            throw BizException.conflict(BizCode.MAIL_ALREADY_CLAIMED, "这封邮件的附件已经领过了");
          }
          this.roles.grantByRoleId(mail.role_id, { gold: mail.gold, exp: mail.exp, items }, "mail-auto");
          this.mails.markAutoClaimed(mail.id, now);
          // 领了等于看过，并且告诉玩家东西送哪去了（**追加**，不改原文）
          this.mails.markRead(mail.id, now);
          this.mails.appendBody(mail.id, autoClaimNote(now));
        });
        result.claimed += 1;
        this.logger.log(`自动入包：角色 ${mail.role_id} 的邮件 ${mail.id}（金币 ${mail.gold} / 经验 ${mail.exp} / 物品 ${items.length} 件）`);
      } catch (error) {
        // 失败计数必须写在事务**外面**：事务已回滚，写在里面会被一起抹掉
        try {
          this.mails.bumpAutoAttempts(mail.id);
        } catch (bumpError) {
          this.logger.warn(`自动入包失败次数没记上（${mail.id}）：${messageOf(bumpError)}`);
        }
        result.failed += 1;
        // 背包满是最常见的失败，单独给出可读的一句（运营看到日志就知道该扩容还是该清）
        const reason = isBizCode(error, BizCode.MALL_BAG_FULL) ? "背包已满" : messageOf(error);
        this.logger.warn(`自动入包跳过（第 ${mail.auto_attempts + 1} 次）：邮件 ${mail.id}，${reason}`);
      }
    }

    if (result.scanned > 0) {
      this.logger.log(`自动入包本轮：候选 ${result.scanned} / 成功 ${result.claimed} / 失败 ${result.failed}`);
    }
    return result;
  }

  private intervalMs(): number {
    return Number(this.config.get<number>("mailAutoClaimIntervalMs") ?? 60 * 60 * 1000);
  }

  private leadMs(): number {
    return Math.max(0, Number(this.config.get<number>("mailAutoClaimLeadMs") ?? 3 * 24 * 60 * 60 * 1000));
  }

  private batchSize(): number {
    return Math.max(1, Number(this.config.get<number>("mailAutoClaimBatch") ?? 200));
  }

  private maxAttempts(): number {
    return Math.max(1, Number(this.config.get<number>("mailAutoClaimMaxAttempts") ?? 5));
  }
}

/**
 * 追加进正文的那一句
 *
 * 用日期而不是时间戳：玩家看到的是「哪天东西进了包」，精确到秒反而像日志。
 * 时区按服务器本地时间（与运营看到的日志同一口径）。
 */
function autoClaimNote(now: number): string {
  const date = new Date(now);
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `\n\n[系统] 附件已于 ${stamp} 自动入包（邮件到期前由系统代为领取，无需再点）`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
