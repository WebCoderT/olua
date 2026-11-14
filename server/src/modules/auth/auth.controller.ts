import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Post } from "@nestjs/common";
import { ApiDataResponse, ApiVoidResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiPlayerDoc, ApiPublicDoc } from "../../common/decorators/api-doc.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { AuthService } from "./auth.service";
import { AccountDto } from "./dto/account.dto";
import { AuthTokenDto } from "./dto/auth-token.dto";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto } from "./dto/login.dto";

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
  @ApiPublicDoc({ operationId: "auth.register", summary: "注册账号", description: "账号名唯一；注册成功直接返回令牌，无需再登录一次。" })
  @ApiDataResponse(AuthTokenDto, { status: HttpStatus.CREATED, description: "注册成功" })
  register(@Body() dto: RegisterDto): AuthTokenDto {
    return this.authService.register(dto);
  }

  @Public()
  @Post("login")
  @HttpCode(HttpStatus.OK)
  @ApiPublicDoc({
    operationId: "auth.login",
    summary: "账号登录",
    description:
      "账号不存在与密码错误返回同一句提示（不暴露账号是否存在）。\n\n" +
      "**失败限流**：同一用户名连续失败 5 次、或同一 IP 在 10 分钟内失败 20 次，会被临时锁定并返回 429 / 10005（阈值见服务端 `.env` 的 `LOGIN_*`）。",
  })
  @ApiDataResponse(AuthTokenDto, { description: "登录成功" })
  login(@Body() dto: LoginDto, @Ip() ip: string): AuthTokenDto {
    return this.authService.login(dto, ip);
  }

  @Get("me")
  @ApiPlayerDoc({ operationId: "auth.me", summary: "获取当前登录账号", description: "用令牌里的账号 id 查，不接受任何入参指定账号。" })
  @ApiDataResponse(AccountDto, { description: "当前账号" })
  me(@CurrentUser() user: AuthenticatedUser): AccountDto {
    return this.authService.me(user.id);
  }

  /**
   * 登出（#880 / I5）
   *
   * 放在这里而不是客户端「清 localStorage」就完事：令牌是无状态的，客户端删掉本地副本
   * 只是自己看不见它 —— 泄漏出去的那一份照旧能用满 7 天。真正的吊销只能由服务端做
   * （`token_version` +1，守卫每次请求回查库比对）。
   */
  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @ApiPlayerDoc({
    operationId: "auth.logout",
    summary: "登出（吊销当前账号的全部令牌）",
    description:
      "把账号的令牌版本号 +1，**这台设备与其他设备上已签发的令牌全部失效**（401 / 40103）。\n\n" +
      "没有「只吊销这一台」：服务端不存会话表，令牌里只有账号 id + 版本号（见 docs/33）。" +
      "重复调用是幂等的；不影响在线角色标记（那由心跳与在线清算管）。",
  })
  @ApiVoidResponse("登出成功（data 为 null）")
  logout(@CurrentUser() user: AuthenticatedUser): null {
    return this.authService.logout(user.id);
  }
}
