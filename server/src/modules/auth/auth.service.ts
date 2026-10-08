import { HttpStatus, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { BizCode } from "../../common/constants/biz-code";
import { ENTITY_STATUS } from "../../common/constants/status";
import { BizException } from "../../common/errors/biz.exception";
import { hashPassword, verifyPassword } from "../../common/utils/password.util";
import { AccountRepository } from "../../database/repositories/account.repository";
import { AccountRow } from "../../database/rows";
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
      created_at: now,
      updated_at: now,
      last_login_at: now,
    };
    this.accounts.insert(account);
    return this.issue(account);
  }

  /** 登录 */
  login(dto: LoginDto): AuthTokenDto {
    const account = this.accounts.findByUsername(dto.username.trim());
    // 账号不存在与密码错误回同一句：不向调用方暴露账号是否存在
    if (!account || !verifyPassword(dto.password, account.password)) {
      throw new BizException(BizCode.PASSWORD_WRONG, "账号或密码错误", HttpStatus.UNAUTHORIZED);
    }
    if (account.status !== ENTITY_STATUS.ACTIVE) {
      throw new BizException(BizCode.ACCOUNT_DISABLED, "账号已被封禁，请联系客服", HttpStatus.FORBIDDEN);
    }
    account.last_login_at = Date.now();
    this.accounts.updateById(account.id, { last_login_at: account.last_login_at });
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
    dto.token = this.tokens.sign({ id: account.id, username: account.username }, "player");
    dto.expiresIn = this.config.get<string>("jwtExpiresIn") ?? "";
    dto.account = AccountDto.from(account);
    return dto;
  }
}
