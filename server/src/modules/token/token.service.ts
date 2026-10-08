import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";
import { Audience, JwtPayload } from "../../common/interfaces/api-envelope.interface";
import { toExpiresIn } from "./jwt-expires.util";

/** 令牌主体（签发时给出的身份） */
export interface TokenSubject {
  id: string;
  username: string;
}

/**
 * 令牌服务（签发 / 校验）
 *
 * 玩家与管理员的令牌用同一个密钥签发，但 **aud 不同**：
 * 校验时按接口要求的 audience 校验，因此玩家令牌无法调用管理端接口，反之亦然。
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /** 签发令牌 */
  sign(subject: TokenSubject, audience: Audience): string {
    return this.jwt.sign(
      { username: subject.username, aud: audience },
      { subject: subject.id, expiresIn: toExpiresIn(this.config.get<string>("jwtExpiresIn")) },
    );
  }

  /**
   * 校验令牌并返回载荷
   * @throws BizException 令牌缺失/伪造/受众不符/过期
   */
  verify(token: string, audience: Audience): JwtPayload {
    try {
      const payload = this.jwt.verify<JwtPayload>(token, { audience });
      if (!payload.sub) throw new Error("payload 缺少 sub");
      return payload;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("expired")) throw BizException.unauthorized(BizCode.TOKEN_EXPIRED, "登录已过期，请重新登录");
      throw BizException.unauthorized(BizCode.TOKEN_INVALID, "登录状态无效，请重新登录");
    }
  }

  /** 从 Authorization 头里取 Bearer 令牌（没有返回 null） */
  static extractBearer(header: string | undefined): string | null {
    if (!header) return null;
    const [scheme, value] = header.split(" ");
    if (!value || scheme.toLowerCase() !== "bearer") return null;
    return value.trim() || null;
  }
}
