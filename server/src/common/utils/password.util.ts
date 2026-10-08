import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** 摘要格式：`scrypt$<saltHex>$<hashHex>` */
const ALGORITHM = "scrypt";
const SALT_BYTES = 16;
const KEY_LENGTH = 64;

/**
 * 口令摘要
 *
 * 用 Node 内置 scrypt（不引第三方 bcrypt，避免原生模块编译；强度足够）。
 * 存的是「算法 + 盐 + 摘要」，因此将来更换算法时可以按前缀平滑迁移。
 */
export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_BYTES).toString("hex");
  const hash = scryptSync(plain, salt, KEY_LENGTH).toString("hex");
  return `${ALGORITHM}$${salt}$${hash}`;
}

/** 校验口令（摘要格式不合法一律判失败，不抛异常） */
export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== ALGORITHM) return false;
  const [, salt, hash] = parts;
  const expected = Buffer.from(hash, "hex");
  if (expected.length !== KEY_LENGTH) return false;
  return timingSafeEqual(scryptSync(plain, salt, KEY_LENGTH), expected);
}
