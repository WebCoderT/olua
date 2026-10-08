import { Body, Controller, Get, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiPlayerDoc, ApiPublicDoc } from "../../common/decorators/api-doc.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { AuthService } from "./auth.service";
import { AccountDto } from "./dto/account.dto";
import { AuthTokenDto } from "./dto/auth-token.dto";
import { LoginDto, RegisterDto } from "./dto/register.dto";

/**
 * 客户端 · 认证接口
 *
 * 注册 / 登录属于「公共接口」分组，me 属于「客户端」分组 —— 分组按**方法**标，
 * 所以类上不写 `@ApiTags`（自动类名分组已在 main.ts 关掉，
 * 见 common/decorators/api-doc.decorator）。
 */
@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post("register")
  @ApiPublicDoc({ summary: "注册账号", description: "账号名唯一；注册成功直接返回令牌，无需再登录一次。" })
  @ApiDataResponse(AuthTokenDto, { status: HttpStatus.CREATED, description: "注册成功" })
  register(@Body() dto: RegisterDto): AuthTokenDto {
    return this.authService.register(dto);
  }

  @Public()
  @Post("login")
  @HttpCode(HttpStatus.OK)
  @ApiPublicDoc({ summary: "账号登录", description: "账号不存在与密码错误返回同一句提示（不暴露账号是否存在）。" })
  @ApiDataResponse(AuthTokenDto, { description: "登录成功" })
  login(@Body() dto: LoginDto): AuthTokenDto {
    return this.authService.login(dto);
  }

  @Get("me")
  @ApiPlayerDoc({ summary: "获取当前登录账号", description: "用令牌里的账号 id 查，不接受任何入参指定账号。" })
  @ApiDataResponse(AccountDto, { description: "当前账号" })
  me(@CurrentUser() user: AuthenticatedUser): AccountDto {
    return this.authService.me(user.id);
  }
}
