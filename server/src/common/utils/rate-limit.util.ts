/**
 * 登录失败限流（**纯函数**，不碰时钟也不碰存储）
 *
 * 拆成纯函数是为了能单独测：`server/test/e2e.cjs` 里有一组用例直接 require 编译产物
 * （`dist/common/utils/rate-limit.util.js`）跑边界值，不必起服务。
 *
 * 规则形状：连续失败到 `maxFailures` 次 → 锁 `lockMs`；**锁定后计数清零**，
 * 锁定期满重新从 0 开始。这样正常用户被误锁后不会「一错再错」，
 * 而爆破者的速率上限依然是 maxFailures / lockMs。
 */

/** 一个维度的失败状态 */
export interface AttemptState {
  /** 当前连续失败次数（进入锁定期时归零） */
  failures: number;
  /** 锁定到什么时候（毫秒时间戳；0 = 未锁定） */
  lockedUntil: number;
}

/** 限流规则 */
export interface ThrottleRule {
  /** 连续失败多少次触发锁定 */
  maxFailures: number;
  /** 锁定多久（毫秒） */
  lockMs: number;
}

/** 初始状态（未失败过） */
export function createAttemptState(): AttemptState {
  return { failures: 0, lockedUntil: 0 };
}

/**
 * 还需锁多久（毫秒）；未锁定返回 0
 *
 * `maxFailures <= 0` 视为关掉该维度（返回 0，永不锁）。
 */
export function lockedForMs(state: AttemptState | undefined, rule: ThrottleRule, now: number): number {
  if (!state || rule.maxFailures <= 0) return 0;
  return state.lockedUntil > now ? state.lockedUntil - now : 0;
}

/** 记一次失败，返回新状态 */
export function afterFailure(state: AttemptState | undefined, rule: ThrottleRule, now: number): AttemptState {
  const current = state ?? createAttemptState();
  const failures = current.failures + 1;
  if (failures >= rule.maxFailures) return { failures: 0, lockedUntil: now + rule.lockMs };
  return { failures, lockedUntil: 0 };
}

/** 登录成功后清空（成功即证明是本人，不该继续背失败计数） */
export function afterSuccess(): AttemptState {
  return createAttemptState();
}

/** 还剩几次可以试（用于提示文案；锁定中返回 0） */
export function remainingAttempts(state: AttemptState | undefined, rule: ThrottleRule, now: number): number {
  if (lockedForMs(state, rule, now) > 0) return 0;
  return Math.max(0, rule.maxFailures - (state?.failures ?? 0));
}

/** 把毫秒数说成人话（提示文案用）：不足 1 分钟按 1 分钟算，向上取整 */
export function describeWait(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return `${minutes} 分钟`;
}

/** 该状态是否已经「无用」（未锁定且没有计数）—— 内存表清理用 */
export function isIdle(state: AttemptState, now: number): boolean {
  return state.failures === 0 && state.lockedUntil <= now;
}
