import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule, JwtModuleOptions } from "@nestjs/jwt";
import { toExpiresIn } from "./jwt-expires.util";
import { TokenService } from "./token.service";

/** 令牌模块（全局：认证守卫与两个登录入口都要用） */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService): JwtModuleOptions => ({
        secret: config.get<string>("jwtSecret"),
        signOptions: { expiresIn: toExpiresIn(config.get<string>("jwtExpiresIn")) },
      }),
    }),
  ],
  providers: [TokenService],
  exports: [TokenService],
})
export class TokenModule {}
