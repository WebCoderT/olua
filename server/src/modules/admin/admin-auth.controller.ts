import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Patch, Post } from "@nestjs/common";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc, ApiPublicDoc } from "../../common/decorators/api-doc.decorator";
import { AuditTarget } from "../../common/decorators/audit-target.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { AdminAuthService } from "./admin-auth.service";
import { AdminLoginDto, AdminRegisterDto } from "./dto/admin-auth.dto";
import { AdminDto, AdminTokenDto } from "./dto/admin.dto";
import { ChangeAdminPasswordDto } from "./dto/password.dto";

/**
 * 管理端 · 认证接口
 *
 * 注意分组是按**单个接口**打的（类上不写 `@ApiTags`）：注册 / 登录属于「公共接口」，
 * me 属于「管理端」，同一个控制器里两种都要有。见 common/decorators/api-doc.decorator。
 */
@ApiAudience("admin")
@Controller("admin/auth")
export class AdminAuthController {
  constructor(private readonly adminAuthService: AdminAuthService) {}

  @Public()
  @Post("register")
  @ApiPublicDoc({
    operationId: "adminAuth.register",
    summary: "注册管理员",
    description:
      "注册许可由两件配置决定：配了 `ADMIN_REGISTER_CODE` 就必须带对注册码；没配则要求 `ADMIN_REGISTER_OPEN=true`（**默认关闭** —— 忘记配注册码不该等于人人可开后台）。**第一个**注册的管理员自动成为超级管理员，之后注册的一律是普通管理员。",
  })
  @ApiDataResponse(AdminTokenDto, { status: HttpStatus.CREATED, description: "注册成功" })
  register(@Body() dto: AdminRegisterDto): AdminTokenDto {
    return this.adminAuthService.register(dto);
  }

  @Public()
  @Post("login")
  @HttpCode(HttpStatus.OK)
  @ApiPublicDoc({
    operationId: "adminAuth.login",
    summary: "管理员登录",
    description:
      "成功后把返回的 token 放到 `Authorization: Bearer <token>`。\n\n" +
      "**失败限流**：同一用户名连续失败 5 次、或同一 IP 在 10 分钟内失败 20 次，会被临时锁定并返回 429 / 30009（阈值见服务端 `.env` 的 `LOGIN_*`）。",
  })
  @ApiDataResponse(AdminTokenDto, { description: "登录成功" })
  login(@Body() dto: AdminLoginDto, @Ip() ip: string): AdminTokenDto {
    return this.adminAuthService.login(dto, ip);
  }

  @Get("me")
  @ApiAdminDoc({
    operationId: "adminAuth.me",
    summary: "获取当前登录管理员",
    description: "返回当前管理员的角色与**权限点清单** —— 管理端据此显示 / 隐藏菜单与按钮（服务端仍会独立校验，前端隐藏只是体验）。",
  })
  @ApiDataResponse(AdminDto, { description: "当前管理员" })
  me(@CurrentUser() user: AuthenticatedUser): AdminDto {
    return this.adminAuthService.me(user.id);
  }

  @Patch("password")
  @AuditTarget("admin", "self")
  @ApiAdminDoc({
    operationId: "adminAuth.changePassword",
    summary: "修改自己的密码",
    description:
      "任何已登录管理员都能改**自己**的密码，需要带上原密码（光有令牌不该能改口令）。\n\n" +
      "改完直接返回**新的令牌**：库里令牌版本号已 +1，此前签发的令牌全部作废 —— " +
      "管理端应当用返回的 token 覆盖本地那一份，否则会被自己的系统踢回登录页。",
  })
  @ApiDataResponse(AdminTokenDto, { description: "改密成功（含新令牌）" })
  changePassword(@CurrentUser() user: AuthenticatedUser, @Body() dto: ChangeAdminPasswordDto): AdminTokenDto {
    return this.adminAuthService.changePassword(user.id, dto);
  }
}
