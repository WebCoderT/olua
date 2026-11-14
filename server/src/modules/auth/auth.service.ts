import { HttpStatus, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { BizCode } from "../../common/constants/biz-code";
import { ENTITY_STATUS } from "../../common/constants/status";
import { BizException } from "../../common/errors/biz.exception";
import { hashPassword, verifyPassword } from "../../common/utils/password.util";
import { describeBan, isBanned } from "../../common/utils/ban.util";
import { LoginThrottleService } from "../../common/security/login-throttle.service";
import { AccountRepository } from "../../database/repositories/account.repository";
import { ZoneRepository } from "../../database/repositories/zone.repository";
import { AccountRow } from "../../database/rows";
import { AuditService } from "../audit/audit.service";
import { EventLogService } from "../event-log/event-log.service";
import { EVENT_TYPE } from "../../common/constants/event-type";
import { TokenService } from "../token/token.service";
import { AccountDto } from "./dto/account.dto";
import { AuthTokenDto } from "./dto/auth-token.dto";
import { LoginDto, RegisterDto } from "./dto/register.dto";

/** 玩家账号认证（注册 / 登录 / 取当前账号） */
@Injectable()
export class AuthService {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly zones: ZoneRepository,
    private readonly tokens: TokenService,
    private readonly config: ConfigService,
    private readonly throttle: LoginThrottleService,
    private readonly audit: AuditService,
    private readonly eventLogs: EventLogService,
  ) {}

  /** 注册（账号名唯一；成功后直接返回令牌，客户端免二次登录） */
  register(dto: RegisterDto): AuthTokenDto {
    // 注册开关：正式服往往要关（防批量刷号），关掉后只有已注册账号能登录
    if (!(this.config.get<boolean>("playerRegisterOpen") ?? true)) {
      throw new BizException(BizCode.REGISTER_CLOSED, "本服已关闭新账号注册", HttpStatus.FORBIDDEN);
    }
    const username = dto.username.trim();
    if (this.accounts.findByUsername(username)) throw BizException.conflict(BizCode.ACCOUNT_EXISTS, "该账号已被注册");

    // 区（#957）：**注册不再定区**。账号只是身份，归属由角色决定（`roles.zone_id`）；
    // 这一列只是「当前浏览区」，注册时先落在第一个活区，玩家选服时由 POST /zones/select 改。
    // 老客户端仍可能带 zoneId —— 直接忽略（忽略而不是报错，否则旧包白屏）。
    const firstZone = this.zones.listLive()[0];
    if (!firstZone) throw BizException.notFound(BizCode.ZONE_NOT_FOUND, "当前没有可用区服");

    const now = Date.now();
    const account: AccountRow = {
      id: randomUUID(),
      username,
      password: hashPassword(dto.password),
      email: null,
      status: ENTITY_STATUS.ACTIVE,
      online_role_id: null,
      online_heartbeat_at: null,
      token_version: 0,
      ban_reason: null,
      ban_until: null,
      banned_by: null,
      banned_at: null,
      active_zone_id: firstZone.id,
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
      this.recordLoginEvent({ accountId: account?.id ?? null, username, ip, ok: false, reason: "账号或密码错误" });
      throw new BizException(BizCode.PASSWORD_WRONG, "账号或密码错误", HttpStatus.UNAUTHORIZED);
    }
    // 封禁判定：到期的临时封禁会被判为「未封禁」，直接放行（见 ban.util）
    if (isBanned(account)) {
      const banMessage = describeBan(account);
      this.audit.recordLoginAttempt({
        action: "auth.login",
        route: "auth/login",
        username: account.username,
        ip,
        ok: false,
        errorCode: BizCode.ACCOUNT_DISABLED,
        errorMessage: banMessage,
        statusCode: HttpStatus.FORBIDDEN,
      });
      this.recordLoginEvent({ accountId: account.id, username: account.username, ip, ok: false, reason: banMessage });
      throw new BizException(BizCode.ACCOUNT_DISABLED, banMessage, HttpStatus.FORBIDDEN);
    }
    // 走到这里说明封禁已到期（临时封禁）：顺手把库里的状态扫回去，
    // 否则后台列表会一直显示「封禁中」，运营看不出这个号其实已经可以登了。
    if (account.status !== ENTITY_STATUS.ACTIVE) {
      this.accounts.liftBan(account.id);
      account.status = ENTITY_STATUS.ACTIVE;
      account.ban_reason = null;
      account.ban_until = null;
      account.banned_by = null;
      account.banned_at = null;
    }
    this.throttle.recordSuccess(username, ip);
    account.last_login_at = Date.now();
    this.accounts.updateById(account.id, { last_login_at: account.last_login_at });
    this.audit.recordLoginAttempt({ action: "auth.login", route: "auth/login", username: account.username, ip, ok: true });
    this.recordLoginEvent({ accountId: account.id, username: account.username, ip, ok: true });
    return this.issue(account);
  }

  /**
   * 登录事件写进行为流水（#886）
   *
   * 与上面那条 `audit.recordLoginAttempt` **不是重复**：
   * - `audit_logs` 是**安全线**（谁在扫号、哪个 IP 爆破），查询入口是操作日志页；
   * - `event_logs` 是**行为线**（这个账号什么时候上线的），与进图 / 击杀 / 拾取连成一条时序。
   *
   * 失败也记：`success = 0`，`roleId` 为空（那时候还没有角色），原因放 `detail.reason`。
   */
  private recordLoginEvent(input: {
    accountId: string | null;
    username: string;
    ip?: string;
    ok: boolean;
    reason?: string;
  }): void {
    this.eventLogs.record({
      type: EVENT_TYPE.LOGIN,
      accountId: input.accountId,
      ip: input.ip ?? null,
      success: input.ok,
      detail: input.reason ? { username: input.username, reason: input.reason } : { username: input.username },
    });
  }

  /** 当前登录账号（守卫已确认存在且状态正常） */
  me(accountId: string): AccountDto {
    const account = this.accounts.findById(accountId);
    if (!account) throw BizException.notFound(BizCode.ACCOUNT_NOT_FOUND, "账号不存在");
    return AccountDto.from(account);
  }

  /**
   * 登出（#880 / I5）：把 `token_version` 推一格，**这台设备与其他设备上的令牌一起作废**
   *
   * 令牌是无状态的，服务端没有一张「有效令牌表」可以删 —— 能吊销它的唯一手段就是
   * 让守卫手里的版本号对不上（`AuthGuard` 每次请求都回查库比对 `ver`）。
   * 所以「只登出这一台设备」这种语义在没有会话表之前做不到，也不该假装能做到：
   * 想要多设备共存，得先有会话表（暂时放置，重开条件：真的出现「一台设备登出、
   * 另一台还该活着」的需求时，改成按会话 id 吊销）。
   *
   * 不清在线角色标记：那是「在游戏里」的状态，由心跳与在线清算管（#547）；
   * 登出只回答「这个令牌还能不能用」。玩家下次登录会拿到新令牌（版本号已是新的）。
   *
   * 幂等：重复登出不报错（客户端可能在 401 之后又补一次）。
   */
  logout(accountId: string): null {
    this.accounts.bumpTokenVersion(accountId);
    return null;
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
