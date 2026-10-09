import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { BizCode } from "../../common/constants/biz-code";
import {
  MAIL_MIN_ATTEMPTS,
  MAIL_STATUS_LABELS,
  MAIL_VARIABLE_VALUE_MAX,
  MailStatus,
  MailStatusValue,
} from "../../common/constants/mail";
import { BizException } from "../../common/errors/biz.exception";
import { AuthenticatedUser, PageResult } from "../../common/interfaces/api-envelope.interface";
import { retryDelayMs } from "../../common/utils/mail-retry.util";
import { AccountRepository } from "../../database/repositories/account.repository";
import { MailListOptions, MailRepository } from "../../database/repositories/mail.repository";
import { MailQueueRow, MailQueueWithAccountRow } from "../../database/rows";
import { MAIL_TEMPLATES, findMailTemplate, MAIL_TEMPLATE_CUSTOM, missingVariables, renderMail } from "./mail-templates";
import { MAIL_TRANSPORT, MailTransport } from "./mail-transport";
import {
  MAIL_DEFAULT_PAGE_SIZE,
  MailJobDto,
  MailQueryDto,
  MailTemplateDto,
  SendMailDto,
  SendMailResultDto,
} from "./dto/mail.dto";

/**
 * 邮件业务
 *
 * ## 发信为什么是「入队」而不是「直接发」
 * SMTP 是外部依赖：它可能慢、可能拒绝连接、可能让你等 30 秒才超时。
 * 让管理端的一个 POST 请求去等它，运营点下「发送」之后只能盯着转圈，
 * 最后拿到一个网关超时 —— 而他自己不知道邮件到底发出去没有。
 * 所以接口只负责把信**冻进队列**（渲染结果也一并冻住），投递交给后台调度器。
 *
 * ## 未启用时怎么办
 * 一句话：**明确拒绝，不静默吞掉**。通道没配 SMTP 时报 50003，
 * 而不是「假装成功」或「丢进队列后再也发不出去」—— 后者会让运营以为玩家收到了。
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    private readonly mails: MailRepository,
    private readonly accounts: AccountRepository,
    private readonly config: ConfigService,
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
  ) {}

  /** 发信（入队即返回；投递结果去投递记录里查） */
  send(actor: AuthenticatedUser, dto: SendMailDto): SendMailResultDto {
    this.assertEnabled();

    const template = findMailTemplate(dto.templateKey);
    if (!template) throw new BizException(BizCode.MAIL_TEMPLATE_NOT_FOUND, "邮件模板不存在");

    const accountId = this.resolveAccountId(dto.accountId);
    const variables = this.normalizeVariables(dto.variables);

    // 自定义模板没有必填变量，但标题与正文必须由运营当场填
    if (template.key === MAIL_TEMPLATE_CUSTOM) {
      const subject = (dto.subject ?? "").trim();
      const body = (dto.body ?? "").trim();
      if (!subject || !body) {
        throw new BizException(BizCode.MAIL_VARIABLE_MISSING, "自定义邮件必须填写标题与正文");
      }
    } else {
      const missing = missingVariables(template, variables);
      if (missing.length > 0) {
        throw new BizException(BizCode.MAIL_VARIABLE_MISSING, `模板变量缺失：${missing.join("、")}`);
      }
    }

    const rendered = renderMail(template, variables, { subject: dto.subject, body: dto.body });
    const now = Date.now();
    const row: MailQueueRow = {
      id: randomUUID(),
      to_email: dto.to.trim(),
      account_id: accountId,
      template_key: template.key,
      subject: rendered.subject,
      body: rendered.body,
      status: MailStatus.PENDING,
      attempts: 0,
      next_retry_at: null,
      last_error: null,
      created_by: actor.username,
      created_at: now,
      updated_at: now,
      sent_at: null,
    };
    this.mails.insert(row);
    this.logger.log(`邮件入队：${row.id} → ${row.to_email}（模板 ${row.template_key}）`);

    return { id: row.id, status: row.status, subject: row.subject };
  }

  /** 投递记录（分页 + 状态 / 关键字筛选） */
  list(query: MailQueryDto): PageResult<MailJobDto> {
    const options: MailListOptions = {
      page: query.page ?? 1,
      size: query.size ?? MAIL_DEFAULT_PAGE_SIZE,
      keyword: query.keyword,
      status: query.status,
      sort: query.sort,
      order: query.order,
    };
    const rows = this.mails.list(options);
    const total = this.mails.count(options);
    return {
      list: rows.map((row) => MailJobDto.from(row)),
      total,
      page: options.page,
      size: options.size,
    };
  }

  /** 全部邮件模板（管理端下拉框用） */
  templates(): MailTemplateDto[] {
    return MAIL_TEMPLATES.map((item) => ({
      key: item.key,
      name: item.name,
      hint: item.hint,
      variables: [...item.variables],
      subject: item.subject,
      body: item.body,
    }));
  }

  /**
   * 重投一条**最终失败**的任务
   *
   * 只允许终态：正在发送 / 已成功的任务重投会造成重复发信，
   * 而「重试中」的任务本来就在调度器的计划里，手动插一脚只会打乱退避节奏。
   */
  retry(id: string): MailJobDto {
    const row = this.requireWithAccount(id);
    if (row.status !== MailStatus.FAILED) {
      throw new BizException(
        BizCode.MAIL_JOB_NOT_RETRYABLE,
        `只有「${MAIL_STATUS_LABELS[MailStatus.FAILED]}」的任务可以重投（当前是「${
          MAIL_STATUS_LABELS[row.status as MailStatusValue] ?? row.status
        }」）`,
      );
    }
    this.mails.resetForRetry(id, Date.now());
    return MailJobDto.from(this.requireWithAccount(id));
  }

  /**
   * 投递一条已认领的任务（调度器调用；**每个异常都要落到 last_error 里**）
   *
   * 这里不抛异常：投递失败是**预期内的正常事件**（SMTP 会挂），
   * 让它冒泡到调度器只会让整个 tick 中断、后面的任务一起卡住。
   */
  async deliver(row: MailQueueRow, now: number): Promise<void> {
    try {
      await this.transport.send({ to: row.to_email, subject: row.subject, body: row.body });
      this.mails.markSent(row.id, now);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const attempts = row.attempts + 1;
      if (attempts >= this.maxAttempts()) {
        this.mails.markFailed(row.id, reason, now);
        this.logger.warn(`邮件最终失败：${row.id}（尝试 ${attempts} 次）${reason}`);
        return;
      }
      const delay = retryDelayMs(attempts, this.retryBaseMs());
      this.mails.markRetry(row.id, reason, now + delay, now);
      this.logger.warn(`邮件投递失败，${delay}ms 后第 ${attempts + 1} 次尝试：${row.id} ${reason}`);
    }
  }

  /** 取一条（带账号名），不存在就抛（重投路径的统一入口） */
  private requireWithAccount(id: string): MailQueueWithAccountRow {
    const row = this.mails.findWithAccountById(id);
    if (!row) throw BizException.notFound(BizCode.MAIL_JOB_NOT_FOUND, "投递任务不存在");
    return row;
  }

  /** 通道未启用时统一在这里拒（发信与重投共用同一条判据与同一句提示） */
  private assertEnabled(): void {
    if (this.config.get<boolean>("mailEnabled")) return;
    throw new BizException(
      BizCode.MAIL_DISABLED,
      "邮件通道未启用：请在服务端 .env 配齐 SMTP_HOST / SMTP_USER / SMTP_PASS 后重启",
    );
  }

  /** 关联的玩家账号（不传就不关联；传了不存在的 id 要报错，免得留一条指向空气的追溯线） */
  private resolveAccountId(accountId?: string): string | null {
    if (!accountId) return null;
    const account = this.accounts.findById(accountId);
    if (!account) throw BizException.notFound(BizCode.MAIL_ACCOUNT_NOT_FOUND, "收件账号不存在");
    return account.id;
  }

  /**
   * 模板变量归一化（只留字符串值，空值剔除）
   *
   * 值是动态 map，DTO 层只能验到「是个对象」；这里补上「值是字符串、且不超长」。
   * 超长就报错而不是截断 —— 截断会静默改变运营写的内容。
   */
  private normalizeVariables(input?: Record<string, string>): Record<string, string> {
    if (!input) return {};
    const result: Record<string, string> = {};
    Object.keys(input).forEach((key) => {
      const value = input[key];
      if (value === undefined || value === null) return;
      const text = String(value);
      if (text.length > MAIL_VARIABLE_VALUE_MAX) {
        throw new BizException(BizCode.MAIL_VARIABLE_MISSING, `模板变量 ${key} 的值太长（最长 ${MAIL_VARIABLE_VALUE_MAX} 字）`);
      }
      result[key] = text;
    });
    return result;
  }

  private maxAttempts(): number {
    return Math.max(MAIL_MIN_ATTEMPTS, Number(this.config.get<number>("mailMaxAttempts") ?? MAIL_MIN_ATTEMPTS));
  }

  private retryBaseMs(): number {
    return Math.max(0, Number(this.config.get<number>("mailRetryBaseMs") ?? 0));
  }
}
