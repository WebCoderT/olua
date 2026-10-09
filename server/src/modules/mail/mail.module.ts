import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DatabaseModule } from "../../database/database.module";
import { AccountRepository } from "../../database/repositories/account.repository";
import { MailRepository } from "../../database/repositories/mail.repository";
import { AdminMailController } from "./admin-mail.controller";
import { FailMailTransport, FakeMailTransport, MAIL_TRANSPORT, MailTransport, SmtpMailTransport } from "./mail-transport";
import { MailSchedulerService } from "./mail-scheduler.service";
import { MailService } from "./mail.service";

/**
 * 邮件模块
 *
 * `MAIL_TRANSPORT` 用工厂按配置挑实现，而不是直接 `useClass` 绑死一个：
 * e2e 是独立进程起服务，拿不到进程内对象，只能靠 `MAIL_TRANSPORT` 这个环境变量
 * 把外部边界换成「一律成功 / 一律失败」的假发信器（见 `mail-transport` 的说明）。
 */
@Module({
  imports: [DatabaseModule],
  controllers: [AdminMailController],
  providers: [
    MailService,
    MailRepository,
    AccountRepository,
    MailSchedulerService,
    {
      provide: MAIL_TRANSPORT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): MailTransport => {
        const kind = config.get<string>("mailTransport");
        if (kind === "fake") return new FakeMailTransport();
        if (kind === "fail") return new FailMailTransport();
        return new SmtpMailTransport(config);
      },
    },
  ],
})
export class MailModule {}
