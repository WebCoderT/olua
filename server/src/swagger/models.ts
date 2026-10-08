import { AccountDto } from "../modules/auth/dto/account.dto";
import { AuthTokenDto } from "../modules/auth/dto/auth-token.dto";
import { AdminLoginDto, AdminRegisterDto } from "../modules/admin/dto/admin-auth.dto";
import { AdminDto, AdminTokenDto, AdminUpdateDto } from "../modules/admin/dto/admin.dto";
import { AdminPatchRoleDto } from "../modules/admin/dto/patch-role.dto";
import { AccountQueryDto, AdminQueryDto, RoleQueryDto, UpdateAccountStatusDto } from "../modules/admin/dto/query.dto";
import { AdminAccountDetailDto, AdminStatsDto } from "../modules/admin/dto/stats.dto";
import { ApiEnvelopeDto, PageQueryDto } from "../common/dto/api-envelope.dto";
import { HealthDto } from "../modules/health/dto/health.dto";
import { CreateRoleDto, SaveRoleDto } from "../modules/roles/dto/create-role.dto";
import { AdminRoleDto, RoleDto, RoleSummaryDto } from "../modules/roles/dto/role.dto";
import { LoginDto, RegisterDto } from "../modules/auth/dto/register.dto";

/**
 * Swagger 文档要注册的模型清单
 *
 * `@ApiDataResponse(XxxDto)` 生成的 schema 是 `$ref`，被引用的模型必须在文档里存在，
 * 所以统一在这里登记进 `extraModels`（新增响应 DTO 时**补到这里**，否则 Swagger 上会缺 schema）。
 */
export const SWAGGER_MODELS = [
  ApiEnvelopeDto,
  PageQueryDto,
  // 客户端
  RegisterDto,
  LoginDto,
  AccountDto,
  AuthTokenDto,
  CreateRoleDto,
  SaveRoleDto,
  RoleSummaryDto,
  RoleDto,
  // 管理端
  AdminRegisterDto,
  AdminLoginDto,
  AdminDto,
  AdminTokenDto,
  AdminAccountDetailDto,
  AdminStatsDto,
  AdminRoleDto,
  AdminPatchRoleDto,
  AdminUpdateDto,
  AccountQueryDto,
  RoleQueryDto,
  AdminQueryDto,
  UpdateAccountStatusDto,
  // 系统
  HealthDto,
];
