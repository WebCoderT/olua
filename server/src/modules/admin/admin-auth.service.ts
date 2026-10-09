import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { BizCode } from "../../common/constants/biz-code";
import { AdminRole } from "../../common/constants/permission";
import { ENTITY_STATUS } from "../../common/constants/status";
import { BizException } from "../../common/errors/biz.exception";
import { LoginThrottleService } from "../../common/security/login-throttle.service";
import { hashPassword, verifyPassword } from "../../common/utils/password.util";
import { AdminRepository } from "../../database/repositories/admin.repository";
import { AdminRow } from "../../database/rows";
import { AuditService } from "../audit/audit.service";
import { TokenService } from "../token/token.service";
import { AdminRegisterDto, AdminLoginDto } from "./dto/admin-auth.dto";
import { AdminDto, AdminTokenDto } from "./dto/admin.dto";
import { ChangeAdminPasswordDto } from "./dto/password.dto";

/**
 * 管理端认证
 *
 * 与玩家账号**完全分表**（admins）：玩家令牌与管理员令牌的 aud 不同，
 * 两边都拿不到对方的接口；管理员账号也不能被玩家注册流程撞名。
 */
@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);

  constructor(
    private readonly admins: AdminRepository,
    private readonly tokens: TokenService,
    private readonly config: ConfigService,
    private readonly throttle: LoginThrottleService,
    private readonly audit: AuditService,
  ) {}

  /**
   * 注册管理员
   *
   * 两条规矩：
   * - 服务端配置了 ADMIN_REGISTER_CODE 时必须带对注册码 —— 否则部署到公网等于人人可开后台
   * - **第一个**管理员自动是超级管理员（否则没人能管管理员），之后注册的一律是普通管理员，
   *   要提权得由超管在管理端改（PATCH /admin/admins/:id）
   */
  register(dto: AdminRegisterDto): AdminTokenDto {
    const requiredCode = this.config.get<string>("adminRegisterCode") ?? "";
    if (requiredCode && dto.registerCode !== requiredCode) {
      throw new BizException(BizCode.ADMIN_REGISTER_CODE_WRONG, "注册码不正确", HttpStatus.FORBIDDEN);
    }
    const username = dto.username.trim();
    if (this.admins.findByUsername(username)) throw BizException.conflict(BizCode.ADMIN_EXISTS, "该管理员账号已存在");

    const isFirstAdmin = this.admins.countAll() === 0;
    const now = Date.now();
    const admin: AdminRow = {
      id: randomUUID(),
      username,
      password: hashPassword(dto.password),
      status: ENTITY_STATUS.ACTIVE,
      role: isFirstAdmin ? AdminRole.SUPER : AdminRole.ADMIN,
      token_version: 0,
      created_at: now,
      updated_at: now,
      last_login_at: now,
    };
    this.admins.insert(admin);
    if (isFirstAdmin) this.logger.log(`首个管理员 ${username} 已自动设为超级管理员`);
    return this.issue(admin);
  }

  /**
   * 登录
   *
   * 与玩家登录同一套顺序：限流 → 口令 → 状态。管理端后台是**最值得爆破的目标**，
   * 所以这里的限流不是可选项（失败 5 次 / 10 分钟即锁，见 .env 的 LOGIN_*）。
   */
  login(dto: AdminLoginDto, ip?: string): AdminTokenDto {
    const username = dto.username.trim();
    this.throttle.assertAllowed(username, ip, BizCode.ADMIN_LOGIN_LOCKED);

    const admin = this.admins.findByUsername(username);
    if (!admin || !verifyPassword(dto.password, admin.password)) {
      this.throttle.recordFailure(username, ip);
      this.audit.recordLoginAttempt({
        action: "adminAuth.login",
        route: "admin/auth/login",
        username,
        ip,
        ok: false,
        errorCode: BizCode.ADMIN_PASSWORD_WRONG,
        errorMessage: "账号或密码错误",
      });
      throw new BizException(BizCode.ADMIN_PASSWORD_WRONG, "账号或密码错误", HttpStatus.UNAUTHORIZED);
    }
    if (admin.status !== ENTITY_STATUS.ACTIVE) {
      this.audit.recordLoginAttempt({
        action: "adminAuth.login",
        route: "admin/auth/login",
        username: admin.username,
        ip,
        ok: false,
        errorCode: BizCode.ADMIN_DISABLED,
        errorMessage: "管理员账号已停用",
        statusCode: HttpStatus.FORBIDDEN,
      });
      throw new BizException(BizCode.ADMIN_DISABLED, "管理员账号已停用", HttpStatus.FORBIDDEN);
    }
    this.throttle.recordSuccess(username, ip);
    admin.last_login_at = Date.now();
    this.admins.updateById(admin.id, { last_login_at: admin.last_login_at });
    this.audit.recordLoginAttempt({
      action: "adminAuth.login",
      route: "admin/auth/login",
      username: admin.username,
      ip,
      ok: true,
      actor: { id: admin.id, username: admin.username, role: admin.role },
    });
    return this.issue(admin);
  }

  /**
   * 自助改密（任何已登录管理员都能改自己的）
   *
   * 必须带原密码：令牌可能被别人（或自己忘关的浏览器）拿着，光凭令牌不该能改口令。
   * 改完**直接回一份新令牌**：库里令牌版本号已经 +1，旧令牌当场失效 ——
   * 不回新令牌的话，管理员改完密码立刻被自己的系统踢回登录页。
   * 这次操作本身由审计拦截器自动留痕（含打码后的请求体），这里不再重复记。
   */
  changePassword(adminId: string, dto: ChangeAdminPasswordDto): AdminTokenDto {
    const admin = this.admins.findById(adminId);
    if (!admin) throw BizException.notFound(BizCode.ADMIN_NOT_FOUND, "管理员账号不存在");
    if (!verifyPassword(dto.oldPassword, admin.password)) {
      throw new BizException(BizCode.ADMIN_OLD_PASSWORD_WRONG, "原密码不正确", HttpStatus.UNAUTHORIZED);
    }
    if (dto.newPassword === dto.oldPassword) {
      throw BizException.conflict(BizCode.ADMIN_PASSWORD_SAME, "新密码不能与当前密码相同");
    }
    this.admins.updatePasswordAndBumpVersion(adminId, hashPassword(dto.newPassword));
    const fresh = this.admins.findById(adminId);
    if (!fresh) throw BizException.notFound(BizCode.ADMIN_NOT_FOUND, "管理员账号不存在");
    this.logger.log(`管理员 ${fresh.username} 修改了自己的密码，此前签发的令牌已作废`);
    return this.issue(fresh);
  }

  /** 当前登录管理员 */
  me(adminId: string): AdminDto {
    const admin = this.admins.findById(adminId);
    if (!admin) throw BizException.notFound(BizCode.ADMIN_NOT_FOUND, "管理员账号不存在");
    return AdminDto.from(admin);
  }

  private issue(admin: AdminRow): AdminTokenDto {
    const dto = new AdminTokenDto();
    dto.token = this.tokens.sign({ id: admin.id, username: admin.username, version: admin.token_version ?? 0 }, "admin");
    dto.expiresIn = this.config.get<string>("jwtExpiresIn") ?? "";
    dto.admin = AdminDto.from(admin);
    return dto;
  }
}
