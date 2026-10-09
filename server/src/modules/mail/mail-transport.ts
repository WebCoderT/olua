import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createTransport, Transporter } from "nodemailer";

/** 一封待投递的邮件（渲染完成后的最终形态） */
export interface MailMessage {
  to: string;
  subject: string;
  body: string;
}

/**
 * 发信器（**外部边界的抽象**）
 *
 * 把「怎么把一封信送出去」从这里收口，业务层（服务与调度器）就只认识这一个方法。
 * 这样做的直接好处是**回归测试不需要 SMTP 服务器**：换成假实现，就能断言
 * 「投递有没有按预期被触发 / 队列状态有没有正确流转」，而不是「邮件有没有真的到」 ——
 * 后者既慢又不稳定，还会在 CI 里外发真实邮件。
 */
export interface MailTransport {
  send(message: MailMessage): Promise<void>;
}

/** 依赖注入令牌（模块里按配置挑实现） */
export const MAIL_TRANSPORT = Symbol("MAIL_TRANSPORT");

/** 真实 SMTP 发信（nodemailer；连接参数全部来自配置，代码里没有主机名字面量） */
@Injectable()
export class SmtpMailTransport implements MailTransport {
  private readonly logger = new Logger(SmtpMailTransport.name);
  private transporter?: Transporter;

  constructor(private readonly config: ConfigService) {}

  async send(message: MailMessage): Promise<void> {
    await this.client().sendMail({
      from: this.config.get<string>("smtpFrom") || this.config.get<string>("smtpUser"),
      to: message.to,
      subject: message.subject,
      text: message.body,
    });
  }

  /**
   * 惰性建连接
   *
   * 不在构造函数里建：模块装配时就去连 SMTP，会让「服务启动」依赖「SMTP 可达」 ——
   * 邮件只是个旁路功能，它不该有能力拖垮整个后台的启动。
   */
  private client(): Transporter {
    if (this.transporter) return this.transporter;
    this.transporter = createTransport({
      host: this.config.get<string>("smtpHost"),
      port: this.config.get<number>("smtpPort"),
      secure: this.config.get<boolean>("smtpSecure"),
      auth: {
        user: this.config.get<string>("smtpUser"),
        pass: this.config.get<string>("smtpPass"),
      },
    });
    this.logger.log(`SMTP 发信器就绪：${this.config.get<string>("smtpHost")}:${this.config.get<number>("smtpPort")}`);
    return this.transporter;
  }
}

/**
 * 假发信器：一律成功（**只用于回归测试**）
 *
 * 不发信，但会打一条日志 —— 让「这封信其实没出门」在日志里留痕，
 * 免得有人拿测试环境的数据当真实投递结果看。
 */
@Injectable()
export class FakeMailTransport implements MailTransport {
  private readonly logger = new Logger(FakeMailTransport.name);

  async send(message: MailMessage): Promise<void> {
    this.logger.warn(`[fake] 假装已发送 → ${message.to}：《${message.subject}》`);
  }
}

/**
 * 假发信器：一律失败（**只用于回归测试**）
 *
 * 抛出的 message 会原样落进 `mail_queue.last_error`，e2e 断言的就是它 ——
 * 所以这里写清楚「这是测试发信器」：运维在系统信息页看到这个原因时，
 * 应当立刻反应过来是 `MAIL_TRANSPORT` 配错了，而不是 SMTP 服务器坏了。
 */
@Injectable()
export class FailMailTransport implements MailTransport {
  async send(message: MailMessage): Promise<void> {
    throw new Error(`测试发信器（MAIL_TRANSPORT=fail）拒绝投递：${message.to}`);
  }
}
