import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { BizCode } from "../../common/constants/biz-code";
import { BizException, isBizCode } from "../../common/errors/biz.exception";
import { RewardItem, parseRewardItems } from "../../common/utils/reward-items.util";
import { RoleMailRow } from "../../database/rows";
import { RoleMailRepository } from "../../database/repositories/role-mail.repository";
import { RolesService } from "../roles/roles.service";
import {
  MailAttachmentDto,
  MailBoxDto,
  MailClaimAllResultDto,
  MailClaimResultDto,
  MailViewDto,
} from "./dto/game-mail.dto";

/** 发一封带奖励的邮件（成就背包满兜底、系统补发都走这里） */
export interface SendRewardMailInput {
  /** 来源标注：system / achievement / reward */
  kind: string;
  title: string;
  body?: string;
  gold?: number;
  exp?: number;
  items?: RewardItem[];
}

/**
 * 游戏内邮件（#429）
 *
 * 只有一件事要想清楚：**附件什么时候才真的到玩家手里**。
 * 答案是一律在「领取」这一刻，而且走 `RolesService.grantQuestRewards` ——
 * 与任务交付、成就领奖同一个发奖入口（一次落库、revision +1），
 * 所以「邮件里的东西」和「背包里的东西」不会因为两套实现而出现差额。
 *
 * 三条由此推出的纪律：
 * - **未领的邮件不能删**（删了等于替玩家扔掉奖励），`MAIL_UNCLAIMED`；
 * - **领取幂等**：`markClaimed` 只在 `claimed_at IS NULL` 时命中，并发点两次也只发一份；
 * - **背包满时不是「整封失败」而是「这次没领到」**：`claim` 抛 20012 且邮件原样留着，
 *   玩家清包后能再领；`claimAll` 则领到满为止（已领的照常落库，`stoppedByBag` 说明还有剩）。
 *
 * 与 `MailModule`（外发 SMTP 投递队列）没有任何代码关系，两者只是中文都叫「邮件」。
 */
@Injectable()
export class GameMailService {
  constructor(
    private readonly mails: RoleMailRepository,
    private readonly roles: RolesService,
  ) {}

  /** 我的收件箱 */
  box(accountId: string): MailBoxDto {
    const role = this.requireOnlineRole(accountId);
    return this.boxOf(role.id);
  }

  /** 标已读（重复标不动 `read_at`：第一次看到的时刻才有意义） */
  read(accountId: string, mailId: string): MailBoxDto {
    const role = this.requireOnlineRole(accountId);
    const mail = this.ownedMail(role.id, mailId);
    this.mails.markRead(mail.id, Date.now());
    return this.boxOf(role.id);
  }

  /**
   * 领一封
   *
   * 顺序：校验 → 发奖 → 标已领。发奖抛错（背包满 20012）时 `claimed_at` 一个字节都没动，
   * 玩家清出格子再点一次就领到了。
   */
  claim(accountId: string, mailId: string): MailClaimResultDto {
    const role = this.requireOnlineRole(accountId);
    const mail = this.ownedMail(role.id, mailId);
    if (mail.claimed_at !== null) {
      throw BizException.conflict(BizCode.MAIL_ALREADY_CLAIMED, "这封邮件的附件已经领过了");
    }
    const items = parseRewardItems(mail.attachments);
    const granted = this.grantAll(accountId, role.id, [{ gold: mail.gold, exp: mail.exp, items }]);

    const now = Date.now();
    this.mails.markClaimed(mail.id, now);
    // 领了等于看过：不让「已领但仍是未读」这种状态挂在红点上
    this.mails.markRead(mail.id, now);

    const box = this.boxOf(role.id);
    const result = new MailClaimResultDto();
    result.mails = box.mails;
    result.unread = box.unread;
    result.unclaimed = box.unclaimed;
    result.gold = mail.gold;
    result.exp = mail.exp;
    result.items = items;
    result.level = granted.level;
    result.leveledUp = granted.leveledUp;
    return result;
  }

  /**
   * 一键领取（按发出的时间正序，领到背包满为止）
   *
   * 逐封发奖而不是合并成一次：每封邮件是独立的奖励来源（可能来自不同玩法），
   * 合并会让「哪封进了背包」变得无法回溯，也让背包满时的中断点变得随意。
   */
  claimAll(accountId: string): MailClaimAllResultDto {
    const role = this.requireOnlineRole(accountId);
    const pending = this.mails.listUnclaimed(role.id);

    const lines: Array<{ gold: number; exp: number; items: RewardItem[] }> = [];
    let claimedCount = 0;
    let stoppedByBag = false;
    for (const mail of pending) {
      const items = parseRewardItems(mail.attachments);
      try {
        this.roles.grantQuestRewards(accountId, role.id, null, { gold: mail.gold, exp: mail.exp, items });
      } catch (error) {
        // 背包满：已领的照常落库，这一封原样留在箱里
        if (isBizCode(error, BizCode.MALL_BAG_FULL)) {
          stoppedByBag = true;
          break;
        }
        throw error;
      }
      const now = Date.now();
      this.mails.markClaimed(mail.id, now);
      this.mails.markRead(mail.id, now);
      lines.push({ gold: mail.gold, exp: mail.exp, items });
      claimedCount += 1;
    }

    // 等级读「领完之后」的线上角色（经验可能触发升级）
    const level = this.roles.online(accountId)?.level ?? role.level;
    const box = this.boxOf(role.id);
    const result = new MailClaimAllResultDto();
    result.mails = box.mails;
    result.unread = box.unread;
    result.unclaimed = box.unclaimed;
    result.claimedCount = claimedCount;
    result.gold = lines.reduce((sum, line) => sum + line.gold, 0);
    result.exp = lines.reduce((sum, line) => sum + line.exp, 0);
    result.items = mergeItems(lines.flatMap((line) => line.items));
    result.level = level;
    result.leveledUp = level > role.level;
    result.stoppedByBag = stoppedByBag;
    return result;
  }

  /** 删除（附件没领就不能删） */
  remove(accountId: string, mailId: string): MailBoxDto {
    const role = this.requireOnlineRole(accountId);
    const mail = this.ownedMail(role.id, mailId);
    if (mail.claimed_at === null && parseRewardItems(mail.attachments).length > 0) {
      throw BizException.conflict(BizCode.MAIL_UNCLAIMED, "这封邮件还有没领的附件，先领取再删除");
    }
    this.mails.remove(mail.id);
    return this.boxOf(role.id);
  }

  /**
   * 发一封带奖励的邮件（给成就领奖的「背包满兜底」用）
   *
   * 不做合并 / 去重：同一份奖励被发两次就应该是两封（要不要去重是调用方的事，
   * 而这里的调用方是「一次领取动作」，本来就不会重复）。
   */
  sendReward(roleId: string, input: SendRewardMailInput): RoleMailRow {
    const row: RoleMailRow = {
      id: `mail_${Date.now()}_${randomUUID().slice(0, 8)}`,
      role_id: roleId,
      kind: input.kind,
      title: input.title,
      body: input.body ?? "",
      gold: Math.max(0, Math.floor(input.gold ?? 0)),
      exp: Math.max(0, Math.floor(input.exp ?? 0)),
      attachments: JSON.stringify(input.items ?? []),
      read_at: null,
      claimed_at: null,
      created_at: Date.now(),
    };
    this.mails.insert(row);
    return row;
  }

  //#region 内部

  /** 收件箱快照（未读数 / 未领数从同一份列表算，避免两次 COUNT 与列表不一致） */
  private boxOf(roleId: string): MailBoxDto {
    const rows = this.mails.listByRole(roleId);
    const dto = new MailBoxDto();
    dto.mails = rows.map((row) => MailViewDto.of(row));
    dto.unread = rows.filter((row) => row.read_at === null).length;
    dto.unclaimed = rows.filter((row) => row.claimed_at === null).length;
    return dto;
  }

  /** 取一封属于该角色的邮件（别人的邮件一律当作不存在，不做越权探测口） */
  private ownedMail(roleId: string, mailId: string): RoleMailRow {
    const mail = this.mails.findByKey(mailId);
    if (!mail || mail.role_id !== roleId) {
      throw BizException.notFound(BizCode.MAIL_NOT_FOUND, "邮件不存在或已被删除");
    }
    return mail;
  }

  /**
   * 发奖并返回「发完之后」的角色状态
   *
   * 一封奖励都没有的邮件（纯文本系统邮件）**不碰角色存档**：否则「读了封公告」也会把
   * revision 顶一格，客户端下一次保存就撞乐观锁。
   */
  private grantAll(
    accountId: string,
    roleId: string,
    lines: Array<{ gold: number; exp: number; items: RewardItem[] }>,
  ): { level: number; leveledUp: boolean } {
    const gold = lines.reduce((sum, line) => sum + line.gold, 0);
    const exp = lines.reduce((sum, line) => sum + line.exp, 0);
    const items = lines.flatMap((line) => line.items);
    if (gold <= 0 && exp <= 0 && items.length === 0) {
      const role = this.roles.online(accountId);
      return { level: role?.level ?? 1, leveledUp: false };
    }
    const settled = this.roles.grantQuestRewards(accountId, roleId, null, { gold, exp, items });
    return { level: settled.level, leveledUp: settled.leveledUp };
  }

  private requireOnlineRole(accountId: string) {
    const role = this.roles.online(accountId);
    if (!role) throw BizException.conflict(BizCode.ROLE_NOT_FOUND, "当前没有在线角色，先选一个角色再操作");
    return role;
  }

  //#endregion
}

/** 同 id 的附件合并成一行（一键领取的展示口径：别给客户端一串重复 id） */
function mergeItems(items: RewardItem[]): MailAttachmentDto[] {
  const merged = new Map<string, number>();
  for (const item of items) merged.set(item.goodId, (merged.get(item.goodId) ?? 0) + item.count);
  return [...merged.entries()].map(([goodId, count]) => {
    const dto = new MailAttachmentDto();
    dto.goodId = goodId;
    dto.count = count;
    return dto;
  });
}
