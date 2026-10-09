import { HttpStatus, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BizCode } from "../constants/biz-code";
import { BizException } from "../errors/biz.exception";
import { afterFailure, afterSuccess, AttemptState, createAttemptState, describeWait, isIdle, lockedForMs, ThrottleRule } from "../utils/rate-limit.util";

/** 两个维度的键前缀（同一个 Map 存两类计数，避免开两张表） */
const USER_PREFIX = "u:";
const IP_PREFIX = "i:";

/** 内存表超过这个规模就顺手清一遍（防「换着用户名撞库」把内存撑爆） */
const SWEEP_THRESHOLD = 1000;

/**
 * 登录限流（内存态）
 *
 * 解决的是「密码可以无限次猜」这个问题：玩家登录与管理端登录共用这一套，
 * 两个维度分别计数 ——
 * - **用户名维度**：盯着某个账号猛试密码（5 次 / 10 分钟，见 .env 的 LOGIN_*）
 * - **IP 维度**：换着用户名撞库、扫号（20 次 / 10 分钟）
 *
 * 为什么放内存而不是落库：这是一份**短命**的速率状态（锁定期满即无意义），
 * 落库要额外建表、写放大、还得清垃圾；代价是进程重启后计数归零 —— 对本项目
 * （单实例 SQLite）可以接受，真要多实例时换成 Redis 即可，接口形状不用变。
 *
 * 反向代理注意：`ip` 取自 express 的 `request.ip`，它只有在 `TRUST_PROXY=true`
 * 时才认 `X-Forwarded-For`；**挂在 Nginx 后面却忘了开，会让所有玩家共用一个 IP
 * 而被一起锁死**（见 config/configuration 与 main.ts）。
 */
@Injectable()
export class LoginThrottleService {
  private readonly buckets = new Map<string, AttemptState>();

  constructor(private readonly config: ConfigService) {}

  /** 用户名维度规则 */
  private get userRule(): ThrottleRule {
    return { maxFailures: this.config.get<number>("loginMaxFailures") ?? 5, lockMs: this.config.get<number>("loginLockMs") ?? 600_000 };
  }

  /** IP 维度规则 */
  private get ipRule(): ThrottleRule {
    return {
      maxFailures: this.config.get<number>("loginIpMaxFailures") ?? 20,
      lockMs: this.config.get<number>("loginIpLockMs") ?? 600_000,
    };
  }

  /**
   * 检查是否允许尝试登录
   * @param bizCode 抛错用的业务码（玩家与管理端各一个，便于两端文案分开）
   * @throws BizException 429 + 对应业务码
   */
  assertAllowed(username: string, ip: string | undefined, bizCode: number): void {
    const now = Date.now();
    const wait = Math.max(this.lockedFor(username, now), this.lockedForIp(ip, now));
    if (wait > 0) {
      throw new BizException(bizCode, `登录失败次数过多，请 ${describeWait(wait)} 后再试`, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /** 记一次登录失败（用户名与 IP 各记一笔） */
  recordFailure(username: string, ip: string | undefined): void {
    const now = Date.now();
    if (this.userRule.maxFailures > 0) {
      this.buckets.set(USER_PREFIX + keyOf(username), afterFailure(this.buckets.get(USER_PREFIX + keyOf(username)), this.userRule, now));
    }
    if (ip && this.ipRule.maxFailures > 0) {
      this.buckets.set(IP_PREFIX + ip, afterFailure(this.buckets.get(IP_PREFIX + ip), this.ipRule, now));
    }
    this.sweepIfNeeded(now);
  }

  /** 登录成功：清掉该用户名与 IP 的计数 */
  recordSuccess(username: string, ip: string | undefined): void {
    this.buckets.set(USER_PREFIX + keyOf(username), afterSuccess());
    if (ip) this.buckets.set(IP_PREFIX + ip, afterSuccess());
  }

  /** 用户名维度还需锁多久 */
  private lockedFor(username: string, now: number): number {
    return lockedForMs(this.buckets.get(USER_PREFIX + keyOf(username)), this.userRule, now);
  }

  /** IP 维度还需锁多久 */
  private lockedForIp(ip: string | undefined, now: number): number {
    if (!ip) return 0;
    return lockedForMs(this.buckets.get(IP_PREFIX + ip), this.ipRule, now);
  }

  /** 内存表过大时清掉「已无用」的条目（未锁定且计数为 0；锁定中的绝不能清） */
  private sweepIfNeeded(now: number): void {
    if (this.buckets.size <= SWEEP_THRESHOLD) return;
    for (const [key, state] of this.buckets) {
      if (isIdle(state ?? createAttemptState(), now)) this.buckets.delete(key);
    }
  }
}

/** 用户名归一化：去掉首尾空格并统一小写 —— 免得「换大小写」绕开限流 */
function keyOf(username: string): string {
  return username.trim().toLowerCase();
}
