import { Body, Controller, Get, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiAdminDoc, ApiPublicDoc } from "../../common/decorators/api-doc.decorator";
import { ApiAudience } from "../../common/decorators/audience.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { AdminAuthService } from "./admin-auth.service";
import { AdminLoginDto, AdminRegisterDto } from "./dto/admin-auth.dto";
import { AdminDto, AdminTokenDto } from "./dto/admin.dto";

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
    summary: "注册管理员",
    description:
      "服务端配置了 `ADMIN_REGISTER_CODE` 时，registerCode 必须一致，否则拒绝注册。**第一个**注册的管理员自动成为超级管理员，之后注册的一律是普通管理员。",
  })
  @ApiDataResponse(AdminTokenDto, { status: HttpStatus.CREATED, description: "注册成功" })
  register(@Body() dto: AdminRegisterDto): AdminTokenDto {
    return this.adminAuthService.register(dto);
  }

  @Public()
  @Post("login")
  @HttpCode(HttpStatus.OK)
  @ApiPublicDoc({ summary: "管理员登录", description: "成功后把返回的 token 放到 `Authorization: Bearer <token>`。" })
  @ApiDataResponse(AdminTokenDto, { description: "登录成功" })
  login(@Body() dto: AdminLoginDto): AdminTokenDto {
    return this.adminAuthService.login(dto);
  }

  @Get("me")
  @ApiAdminDoc({
    summary: "获取当前登录管理员",
    description: "返回当前管理员的角色与**权限点清单** —— 管理端据此显示 / 隐藏菜单与按钮（服务端仍会独立校验，前端隐藏只是体验）。",
  })
  @ApiDataResponse(AdminDto, { description: "当前管理员" })
  me(@CurrentUser() user: AuthenticatedUser): AdminDto {
    return this.adminAuthService.me(user.id);
  }
}
