import { Global, Module } from "@nestjs/common";
import { LoginThrottleService } from "./login-throttle.service";

/**
 * 安全能力（全局模块）
 *
 * 目前只有登录限流；后续再加（验证码、IP 黑名单等）也都收在这里，
 * 免得安全相关的状态被各业务模块各存一份。
 */
@Global()
@Module({
  providers: [LoginThrottleService],
  exports: [LoginThrottleService],
})
export class SecurityModule {}
