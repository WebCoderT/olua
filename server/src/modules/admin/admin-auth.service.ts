import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { BizCode } from "../../common/constants/biz-code";
import { AdminRole } from "../../common/constants/permission";
import { ENTITY_STATUS } from "../../common/constants/status";
import { BizException } from "../../common/errors/biz.exception";
import { hashPassword, verifyPassword } from "../../common/utils/password.util";
import { AdminRepository } from "../../database/repositories/admin.repository";
import { AdminRow } from "../../database/rows";
import { TokenService } from "../token/token.service";
import { AdminRegisterDto, AdminLoginDto } from "./dto/admin-auth.dto";
import { AdminDto, AdminTokenDto } from "./dto/admin.dto";

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
      created_at: now,
      updated_at: now,
      last_login_at: now,
    };
    this.admins.insert(admin);
    if (isFirstAdmin) this.logger.log(`首个管理员 ${username} 已自动设为超级管理员`);
    return this.issue(admin);
  }

  /** 登录 */
  login(dto: AdminLoginDto): AdminTokenDto {
    const admin = this.admins.findByUsername(dto.username.trim());
    if (!admin || !verifyPassword(dto.password, admin.password)) {
      throw new BizException(BizCode.ADMIN_PASSWORD_WRONG, "账号或密码错误", HttpStatus.UNAUTHORIZED);
    }
    if (admin.status !== ENTITY_STATUS.ACTIVE) {
      throw new BizException(BizCode.ADMIN_DISABLED, "管理员账号已停用", HttpStatus.FORBIDDEN);
    }
    admin.last_login_at = Date.now();
    this.admins.updateById(admin.id, { last_login_at: admin.last_login_at });
    return this.issue(admin);
  }

  /** 当前登录管理员 */
  me(adminId: string): AdminDto {
    const admin = this.admins.findById(adminId);
    if (!admin) throw BizException.notFound(BizCode.ADMIN_NOT_FOUND, "管理员账号不存在");
    return AdminDto.from(admin);
  }

  private issue(admin: AdminRow): AdminTokenDto {
    const dto = new AdminTokenDto();
    dto.token = this.tokens.sign({ id: admin.id, username: admin.username }, "admin");
    dto.expiresIn = this.config.get<string>("jwtExpiresIn") ?? "";
    dto.admin = AdminDto.from(admin);
    return dto;
  }
}
