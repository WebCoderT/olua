import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { BizCode } from "../../common/constants/biz-code";
import { BizException, isBizCode } from "../../common/errors/biz.exception";
import { RewardItem, parseRewardItems } from "../../common/utils/reward-items.util";
import { RoleMailRow } from "../../database/rows";
import { RoleMailRepository } from "../../database/repositories/role-mail.repository";
import { RolesService } from "../roles/roles.service";
import { EventLogEntryInput, EventLogService } from "../event-log/event-log.service";
import { EVENT_TYPE } from "../../common/constants/event-type";
import {
  AdminSendMailDto,
  MailAttachmentDto,
  MailBoxDto,
  MailChannelSummaryDto,
  MailClaimAllResultDto,
  MailClaimFailureDto,
  MailClaimResultDto,
  MailViewDto,
} from "./dto/game-mail.dto";
import { MAIL_CHANNELS, MailChannel, isMailChannel, toMailChannel } from "./mail-channel";

/**
 * 人工补发允许的频道（#437）
 *
 * social / combat 是系统自动产生的事实记录（好友申请 / BOSS 战报），人工往里发
 * 会污染语义 —— 运营想说的永远是「系统通知你一声」或「给你一份奖励」。
 */
export const ADMIN_SEND_CHANNELS = ["system", "reward"] as const;

/** BOSS 战报的保质期（#439）：战报是「回看进度」用的记录，7 天后让位给新的里程碑 */
export const BOSS_MAIL_TTL_MS = 7 * 24 * 3600_000;

/**
 * 发一条消息（成就兜底、好友申请、BOSS 战报、运营补发都走这里）
 *
 * `channel` 必填：发送方必须想清楚「这条消息玩家会在哪一栏找它」——
 * 让它默认落到「系统」，等于把分类责任推给玩家。
 */
export interface SendMailInput {
  channel: MailChannel;
  /** 更细的来源标签（achievement / friend / boss …），只用于日志与排查 */
  kind: string;
  title: string;
  body?: string;
  gold?: number;
  exp?: number;
  items?: RewardItem[];
  /**
   * 保质期（#439，毫秒）：`expires_at = 发送时刻 + ttlMs`；不传 = 永不过期。
   * 由**投递方**给 —— 不同来源的保质期不同（BOSS 战报 7 天、运营补发永久），
   * 集中在清理任务里算就表达不了这个差异。带未领附件的行不会因此被清（判据在清理 SQL）。
   */
  ttlMs?: number;
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
 *
 * ## 频道（#436）
 * 每条消息带一个 `channel`（system / reward / social / combat），玩家在消息中心按栏查看。
 * **接口不做频道过滤**：一次给全量 + 每个频道的角标，客户端本地筛 —— 切页签不发请求、
 * 不会「切回全部要重拉」、红点口径天然一致。唯一带频道参数的是 `claimAll`（只领当前这一栏）。
 */
@Injectable()
export class GameMailService {
  constructor(
    private readonly mails: RoleMailRepository,
    private readonly roles: RolesService,
    /** 玩家行为流水（#886）：领取记一条（附件本身由 `grantQuestRewards` 记成 gain） */
    private readonly eventLogs: EventLogService,
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
   * **顺序：先标已领，再发奖，两步在同一个事务里**（#868）。
   *
   * 反过来（先发后标）的漏洞是：发完奖、还没落 `claimed_at` 时进程崩溃 → 重试再发一次，
   * 奖励翻倍。改成先标之后，`markClaimed` 的 `WHERE claimed_at IS NULL` 就成了**闸门**：
   * 命中 0 行说明这封已经被别人（并发请求 / 另一个进程的自动入包）领走了，直接抛
   * 50142 并整体回滚 —— 奖励一个字节都没发出去。
   *
   * 事务里发奖抛错（背包满 20012 / 乐观锁 409）时同样整体回滚：`claimed_at` 回到 NULL，
   * 玩家清出格子再点一次就领到了。
   */
  claim(accountId: string, mailId: string): MailClaimResultDto {
    const role = this.requireOnlineRole(accountId);
    const mail = this.ownedMail(role.id, mailId);
    if (mail.claimed_at !== null) {
      throw BizException.conflict(BizCode.MAIL_ALREADY_CLAIMED, "这封邮件的附件已经领过了");
    }
    const items = parseRewardItems(mail.attachments);
    const now = Date.now();

    const granted = this.mails.transaction(() => {
      if (!this.mails.markClaimed(mail.id, now)) {
        throw BizException.conflict(BizCode.MAIL_ALREADY_CLAIMED, "这封邮件的附件已经领过了");
      }
      const settled = this.grantAll(accountId, role.id, [{ gold: mail.gold, exp: mail.exp, items }]);
      // 领了等于看过：不让「已领但仍是未读」这种状态挂在红点上
      this.mails.markRead(mail.id, now);
      return settled;
    });

    // 行为流水（#886）：一条记「领了哪封信」。附件本身已由 grantQuestRewards 记成
    // `gain`（source = mail）—— 两件事分开记，才能回答「这封补偿有没有人领」和
    // 「这批东西哪来的」这两个不同的问题
    this.eventLogs.record(this.claimEntryOf(accountId, role, mail, items));

    const box = this.boxOf(role.id);
    const result = new MailClaimResultDto();
    result.mails = box.mails;
    result.unread = box.unread;
    result.unclaimed = box.unclaimed;
    result.channels = box.channels;
    result.gold = mail.gold;
    result.exp = mail.exp;
    result.items = items;
    result.level = granted.level;
    result.leveledUp = granted.leveledUp;
    return result;
  }

  /**
   * 一键领取（按发出的时间正序，逐封领取）
   *
   * 逐封发奖而不是合并成一次：每封邮件是独立的奖励来源（可能来自不同玩法），
   * 合并会让「哪封进了背包」变得无法回溯，也让背包满时的中断点变得随意。
   *
   * `channel` 传了就只领这一栏（面板在「奖励」页签点一键领取时，不该把社交栏的消息也动了）；
   * 不传 = 全部频道。
   *
   * ## 一封失败不拖累其他封（#870）
   *
   * 老实现只 catch 背包满、其余异常直接往上抛 —— 结果是「前几封已领、后面的全部没处理，
   * 客户端只看到一句报错」。现在**每封一个独立事务 + 独立 try/catch**：
   *
   * - 背包满 → 记进 `failures`，**继续往后领**：它只挡「要放物品」的那几封，
   *   排在后面的纯金币 / 纯经验邮件照样能到手（这正是「一箱补偿里能领的先领完」）；
   * - 其他异常（奖励物品不存在 20003 / 乐观锁 409 / 已被人领走 50142）→ 同样只影响这一封。
   *
   * 失败清单透传给客户端（`failures[]` + `failedCount`），玩家能知道「领了 3 封、2 封没领到」，
   * 而不是只看到一句「领取失败」。
   */
  claimAll(accountId: string, channel?: string): MailClaimAllResultDto {
    const role = this.requireOnlineRole(accountId);
    const scope = this.scopeOf(channel);
    const pending = this.mails.listUnclaimed(role.id, scope, Date.now());

    const lines: Array<{ gold: number; exp: number; items: RewardItem[] }> = [];
    /** 领到的邮件（#886）：循环里收着，末尾一次 recordMany —— 一键领取可能几十封 */
    const claimedMails: Array<{ mail: RoleMailRow; items: RewardItem[] }> = [];
    /** 没领到的（#870）：一封一条，随结果透传给客户端 */
    const failures: MailClaimFailureDto[] = [];
    let claimedCount = 0;
    let stoppedByBag = false;
    for (const mail of pending) {
      const items = parseRewardItems(mail.attachments);
      const now = Date.now();
      try {
        // 每封一个事务（#868）：先标已领再发奖，标不上（已被别人领走）就整体回滚
        this.mails.transaction(() => {
          if (!this.mails.markClaimed(mail.id, now)) {
            throw BizException.conflict(BizCode.MAIL_ALREADY_CLAIMED, "这封邮件的附件已经领过了");
          }
          this.roles.grantQuestRewards(accountId, role.id, null, { gold: mail.gold, exp: mail.exp, items }, "mail");
          this.mails.markRead(mail.id, now);
        });
      } catch (error) {
        // 背包满：它不是「整单失败」，只挡这一封；后面的纯金币邮件仍能领（#870）
        if (isBizCode(error, BizCode.MALL_BAG_FULL)) stoppedByBag = true;
        failures.push(failureOf(mail.id, error));
        continue;
      }
      lines.push({ gold: mail.gold, exp: mail.exp, items });
      claimedMails.push({ mail, items });
      claimedCount += 1;
    }

    this.eventLogs.recordMany(claimedMails.map((line) => this.claimEntryOf(accountId, role, line.mail, line.items)));

    // 等级读「领完之后」的线上角色（经验可能触发升级）
    const level = this.roles.online(accountId)?.level ?? role.level;
    const box = this.boxOf(role.id);
    const result = new MailClaimAllResultDto();
    result.mails = box.mails;
    result.unread = box.unread;
    result.unclaimed = box.unclaimed;
    result.channels = box.channels;
    result.claimedCount = claimedCount;
    result.gold = lines.reduce((sum, line) => sum + line.gold, 0);
    result.exp = lines.reduce((sum, line) => sum + line.exp, 0);
    result.items = mergeItems(lines.flatMap((line) => line.items));
    result.level = level;
    result.leveledUp = level > role.level;
    result.stoppedByBag = stoppedByBag;
    result.failedCount = failures.length;
    result.failures = failures;
    return result;
  }

  /**
   * 删除（还有没领的奖励就不能删）
   *
   * 判据是 {@link hasUnclaimedReward}：**金币 / 经验 / 附件任一未领就拒**（#866）。
   * 老实现只数 `attachments`，于是一封「补偿 5000 金币」的邮件在没领时就能被删掉，
   * 奖励直接消失 —— 而玩家点删除时多半以为「这封我看过了」，没有「我在扔钱」的预期。
   *
   * 纯文本 / 公告邮件没有奖励，删它不拦（那才是「看过了，清掉」的正常语义）。
   */
  remove(accountId: string, mailId: string): MailBoxDto {
    const role = this.requireOnlineRole(accountId);
    const mail = this.ownedMail(role.id, mailId);
    if (hasUnclaimedReward(mail)) {
      throw BizException.conflict(BizCode.MAIL_UNCLAIMED, "这封邮件还有没领的奖励，先领取再删除");
    }
    this.mails.remove(mail.id);
    return this.boxOf(role.id);
  }

  /**
   * 发一条消息（不给奖励也能发：好友申请、BOSS 战报都是纯文本 + 一个分类）
   *
   * 不做合并 / 去重：同一份奖励被发两次就应该是两封（要不要去重是调用方的事，
   * 而这里的调用方都是「一次具体动作」，本来就不会重复）。
   */
  send(roleId: string, input: SendMailInput): RoleMailRow {
    const created_at = Date.now();
    const row: RoleMailRow = {
      id: `mail_${created_at}_${randomUUID().slice(0, 8)}`,
      role_id: roleId,
      channel: toMailChannel(input.channel),
      kind: input.kind,
      title: input.title,
      body: input.body ?? "",
      gold: Math.max(0, Math.floor(input.gold ?? 0)),
      exp: Math.max(0, Math.floor(input.exp ?? 0)),
      attachments: JSON.stringify(input.items ?? []),
      read_at: null,
      claimed_at: null,
      // 保质期由投递方声明（#439）：不传 = 永不过期（运营补发的实物补偿通常就是这类）
      expires_at: input.ttlMs && input.ttlMs > 0 ? created_at + Math.floor(input.ttlMs) : null,
      created_at,
    };
    this.mails.insert(row);
    return row;
  }

  /**
   * 管理端补发（#437）
   *
   * 不另写 INSERT：落库只走 {@link send} 这一个口子 —— channel 收窄、附件序列化、
   * id 规则都收敛在一处，管理端补发与成就兜底 / 好友申请发出去的行永远同形。
   *
   * 两道校验的分工：
   * - **角色存在性**（404）：入参是管理端手输的 id，不存在是常态输入错误，不是异常；
   * - **频道语义**（400）：DTO 的 `@IsIn` 管形状，这里再拦一道兜底（直连调用方绕不过）。
   *
   * 不要求收件人在线：邮件本来就是异步的，离线角色的行等他下次上线自然看到。
   */
  sendFromAdmin(roleId: string, dto: AdminSendMailDto): MailViewDto {
    if (!(dto.channel as string) || !ADMIN_SEND_CHANNELS.includes(dto.channel as (typeof ADMIN_SEND_CHANNELS)[number])) {
      throw new BizException(BizCode.PARAM_INVALID, `人工补发只允许 ${ADMIN_SEND_CHANNELS.join(" / ")} 频道`);
    }
    if (!this.roles.existsById(roleId)) {
      throw BizException.notFound(BizCode.ROLE_NOT_FOUND, "角色不存在");
    }
    const row = this.send(roleId, {
      channel: dto.channel as MailChannel,
      kind: "admin",
      title: dto.title,
      body: dto.body,
      gold: dto.gold,
      exp: dto.exp,
      items: dto.items,
    });
    return MailViewDto.of(row);
  }

  //#region 内部

  /**
   * 收件箱快照（未读数 / 未领数 / 频道角标都从同一份列表算）
   *
   * 一次取回再本地聚合，而不是发几条 COUNT：多次查询之间可能插进新消息，
   * 「列表里 5 封未读、角标写 4」这种自相矛盾比多一次遍历难查得多。
   *
   * `unclaimed` 用 {@link hasUnclaimedReward} 而不是「`claimed_at IS NULL`」（#869）：
   * 公告 / 系统通知这类**没有奖励**的消息永远领不了，把它算进「待领」
   * 等于给玩家一个永远清不掉的红点，也让「一键领取」按钮永远亮着。
   * 它们只贡献 `unread`（点开就减），这才是「有没有新的」该有的语义。
   */
  private boxOf(roleId: string): MailBoxDto {
    const rows = this.mails.listByRole(roleId, Date.now());
    const dto = new MailBoxDto();
    dto.mails = rows.map((row) => MailViewDto.of(row));
    dto.unread = rows.filter((row) => row.read_at === null).length;
    dto.unclaimed = rows.filter(hasUnclaimedReward).length;
    // 四个频道固定出现（没有消息的频道也要有条目，客户端才能画出 0 角标的页签）
    dto.channels = MAIL_CHANNELS.map((channel) => {
      const summary = new MailChannelSummaryDto();
      summary.channel = channel;
      const own = rows.filter((row) => row.channel === channel);
      summary.total = own.length;
      summary.unread = own.filter((row) => row.read_at === null).length;
      summary.unclaimed = own.filter(hasUnclaimedReward).length;
      return summary;
    });
    return dto;
  }

  /**
   * 频道参数收窄
   *
   * 传了就必须是合法频道：静默当成「全部」会让人以为只领了这一栏，实际把整个箱子都领了 ——
   * 这种「宽容」在发奖路径上是危险的。不传 = 全部频道（「全部」页签的一键领取）。
   */
  private scopeOf(channel?: string): MailChannel | undefined {
    if (channel === undefined || channel === "") return undefined;
    if (!isMailChannel(channel)) {
      throw new BizException(BizCode.PARAM_INVALID, `不认识的消息频道：${channel}`);
    }
    return channel;
  }

  /** 取一封属于该角色的邮件（别人的邮件一律当作不存在，不做越权探测口） */
  private ownedMail(roleId: string, mailId: string): RoleMailRow {
    const mail = this.mails.findByKey(mailId);
    // 过期的信按「不存在」处理（#439）：列表里已经看不见了，点旧链接来领 / 标读也不该有响应
    if (!mail || mail.role_id !== roleId || isExpired(mail, Date.now())) {
      throw BizException.notFound(BizCode.MAIL_NOT_FOUND, "邮件不存在或已被删除");
    }
    return mail;
  }

  /**
   * 一条「领取邮件」流水（#886）
   *
   * `target` 是邮件 id（不是标题）：查「这封补偿有没有人领」要按 id 精确匹配。
   * 标题与附件放进 `detail`，人眼看时才有信息量。
   */
  private claimEntryOf(
    accountId: string,
    role: { id: string; name: string },
    mail: RoleMailRow,
    items: RewardItem[],
  ): EventLogEntryInput {
    return {
      type: EVENT_TYPE.MAIL,
      accountId,
      roleId: role.id,
      roleName: role.name,
      target: mail.id,
      amount: items.length,
      detail: { title: mail.title, channel: mail.channel, gold: mail.gold, exp: mail.exp, items },
    };
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
    const settled = this.roles.grantQuestRewards(accountId, roleId, null, { gold, exp, items }, "mail");
    return { level: settled.level, leveledUp: settled.leveledUp };
  }

  private requireOnlineRole(accountId: string) {
    const role = this.roles.online(accountId);
    if (!role) throw BizException.conflict(BizCode.ROLE_NOT_FOUND, "当前没有在线角色，先选一个角色再操作");
    return role;
  }

  //#endregion
}

/** 是否已过保质期（#439）：读口与单封操作的同一把尺子（NULL = 永不过期） */
function isExpired(row: RoleMailRow, now: number): boolean {
  return row.expires_at !== null && row.expires_at <= now;
}

/**
 * 这封邮件带奖励吗（金币 / 经验 / 附件任一存在）
 *
 * **三个都是奖励载体**。老实现处处只认 `attachments`，于是「补偿 5000 金币」这种邮件
 * 在系统眼里是一封「空信」—— 能删（#866）、不算待领（#869）、过期就被清（#867）。
 * 判据收在这一个函数里，三处读同一个答案。
 *
 * 与 `role-mail.repository.ts` 的 `purgeExpired` 是同一个口径，那边只能写成 SQL
 * （`gold > 0 OR exp > 0 OR attachments != '[]'`），改一处必须同时改另一边。
 */
function hasReward(row: RoleMailRow): boolean {
  return row.gold > 0 || row.exp > 0 || parseRewardItems(row.attachments).length > 0;
}

/** 还有没到手的奖励吗（已领过的一律不算） */
function hasUnclaimedReward(row: RoleMailRow): boolean {
  return row.claimed_at === null && hasReward(row);
}

/**
 * 一封没领到的邮件 → 给客户端的一条失败记录（#870）
 *
 * 只有 `BizException` 的 message 能直接展示（那个类约定「message 一定是人话」）；
 * 其他异常可能是英文技术细节，一律换成通用文案，真实原因留在 `code = 0` 让运维按日志查。
 */
function failureOf(mailId: string, error: unknown): MailClaimFailureDto {
  const dto = new MailClaimFailureDto();
  dto.mailId = mailId;
  if (error instanceof BizException) {
    dto.code = error.code;
    dto.reason = error.message;
  } else {
    dto.code = 0;
    dto.reason = "领取失败，稍后再试";
  }
  return dto;
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
