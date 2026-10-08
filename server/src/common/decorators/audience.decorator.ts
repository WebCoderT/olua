import { SetMetadata } from "@nestjs/common";
import { Audience } from "../interfaces/api-envelope.interface";

export const AUDIENCE_KEY = "olua:audience";

/**
 * 标记接口面向的调用方（默认 player）
 *
 * 管理端接口必须标 `@ApiAudience("admin")`：两种令牌的 aud 不同，
 * 玩家的令牌拿不来调管理端接口（见 common/guards/auth.guard）。
 */
export const ApiAudience = (audience: Audience) => SetMetadata(AUDIENCE_KEY, audience);
