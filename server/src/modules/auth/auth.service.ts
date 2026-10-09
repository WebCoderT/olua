import { HttpStatus, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { BizCode } from "../../common/constants/biz-code";
import { ENTITY_STATUS } from "../../common/constants/status";
import { BizException } from "../../common/errors/biz.exception";
import { hashPassword, verifyPassword } from "../../common/utils/password.util";
import { LoginThrottleService } from "../../common/security/login-throttle.service";
import { AccountRepository } from "../../database/repositories/account.repository";
import { AccountRow } from "../../database/rows";
import { AuditService } from "../audit/audit.service";
import { TokenService } from "../token/token.service";
import { AccountDto } from "./dto/account.dto";
import { AuthTokenDto } from "./dto/auth-token.dto";
import { LoginDto, RegisterDto } from "./dto/register.dto";

/** 玩家账号认证（注册 / 登录 / 取当前账号） */
@Injectable()
export class AuthService {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly tokens: TokenService,
    private readonly config: ConfigService,
    private readonly throttle: LoginThrottleService,
    private readonly audit: AuditService,
  ) {}

  /** 注册（账号名唯一；成功后直接返回令牌，客户端免二次登录） */
  register(dto: RegisterDto): AuthTokenDto {
    const username = dto.username.trim();
    if (this.accounts.findByUsername(username)) throw BizException.conflict(BizCode.ACCOUNT_EXISTS, "该账号已被注册");

    const now = Date.now();
    const account: AccountRow = {
      id: randomUUID(),
      username,
      password: hashPassword(dto.password),
      status: ENTITY_STATUS.ACTIVE,
      online_role_id: null,
      token_version: 0,
      created_at: now,
      updated_at: now,
      last_login_at: now,
    };
    this.accounts.insert(account);
    return this.issue(account);
  }

  /**
   * 登录
   *
   * 三道关：**限流**（先查，锁定中直接 429，连口令都不比对）→ 口令 → 账号状态。
   * 登录成功与失败都会写一条操作日志（失败时把尝试的用户名与来源 IP 记下来，
   * 事后能看出是谁在扫号）。`ip` 来自 express 的 `request.ip`，反代下需 TRUST_PROXY=true。
   */
  login(dto: LoginDto, ip?: string): AuthTokenDto {
    const username = dto.username.trim();
    this.throttle.assertAllowed(username, ip, BizCode.LOGIN_LOCKED);

    const account = this.accounts.findByUsername(username);
    // 账号不存在与密码错误回同一句：不向调用方暴露账号是否存在
    if (!account || !verifyPassword(dto.password, account.password)) {
      this.throttle.recordFailure(username, ip);
      this.audit.recordLoginAttempt({
        action: "auth.login",
        route: "auth/login",
        username,
        ip,
        ok: false,
        errorCode: BizCode.PASSWORD_WRONG,
        errorMessage: "账号或密码错误",
      });
      throw new BizException(BizCode.PASSWORD_WRONG, "账号或密码错误", HttpStatus.UNAUTHORIZED);
    }
    if (account.status !== ENTITY_STATUS.ACTIVE) {
      this.audit.recordLoginAttempt({
        action: "auth.login",
        route: "auth/login",
        username: account.username,
        ip,
        ok: false,
        errorCode: BizCode.ACCOUNT_DISABLED,
        errorMessage: "账号已被封禁",
        statusCode: HttpStatus.FORBIDDEN,
      });
      throw new BizException(BizCode.ACCOUNT_DISABLED, "账号已被封禁，请联系客服", HttpStatus.FORBIDDEN);
    }
    this.throttle.recordSuccess(username, ip);
    account.last_login_at = Date.now();
    this.accounts.updateById(account.id, { last_login_at: account.last_login_at });
    this.audit.recordLoginAttempt({ action: "auth.login", route: "auth/login", username: account.username, ip, ok: true });
    return this.issue(account);
  }

  /** 当前登录账号（守卫已确认存在且状态正常） */
  me(accountId: string): AccountDto {
    const account = this.accounts.findById(accountId);
    if (!account) throw BizException.notFound(BizCode.ACCOUNT_NOT_FOUND, "账号不存在");
    return AccountDto.from(account);
  }

  /** 签发令牌 + 组装返回体 */
  private issue(account: AccountRow): AuthTokenDto {
    const dto = new AuthTokenDto();
    dto.token = this.tokens.sign({ id: account.id, username: account.username, version: account.token_version ?? 0 }, "player");
    dto.expiresIn = this.config.get<string>("jwtExpiresIn") ?? "";
    dto.account = AccountDto.from(account);
    return dto;
  }
}
