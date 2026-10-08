import { JwtSignOptions } from "@nestjs/jwt";

/**
 * 把 `JWT_EXPIRES_IN`（环境变量，字符串如 "7d" / "1h"）收敛成 jsonwebtoken 要求的类型
 *
 * 类型收口只放在这里：环境变量天生是字符串，而库的类型是 ms 的字面量联合，
 * 与其在签名/注册两处各写一次断言，不如统一走这个函数（也便于将来换成秒数）。
 */
export function toExpiresIn(value: string | undefined): JwtSignOptions["expiresIn"] {
  return (value && value.trim() ? value.trim() : "7d") as JwtSignOptions["expiresIn"];
}
