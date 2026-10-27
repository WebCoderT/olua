import type { GuideEvent, GuideProgress } from "../../../types/guide";

/**
 * 引导进度的纯逻辑（#402）
 *
 * 这里**不碰存档、不碰界面**，只做「给一份进度 + 当前这一步 + 一个事件，返回下一份进度」。
 * 好处：`StorageManager` 的旧档补齐与 `GuideStore` 的推进用的是同一套判定，
 * 单测也能拿真逻辑跑（见 client/tools/test-guide.cjs），而不是复刻一份。
 */

/** 旧档/坏值补齐用的「已完成」进度（老号读不到 guide 时落到这里） */
export const GUIDE_PROGRESS_DONE: GuideProgress = { step: 0, done: true, skipped: false };

/** 新角色从第 0 步开始 */
export function newGuideProgress(): GuideProgress {
  return { step: 0, done: false, skipped: false };
}

/**
 * 把存档里读到的任意值规整成一份合法进度
 *
 * 判据是「**有没有这个字段**」而不是等级或建号时间：`guide` 缺失 = 引导功能上线前
 * 就在的角色 → 视为已完成，老号不该突然被弹一脸引导。
 * 有字段但被改坏（step 不是数字 / 越界 / done 不是布尔）同理按「已完成」处理 ——
 * 引导只是个指路的东西，为它把玩家卡在游戏门口不值得。
 */
export function normalizeGuideProgress(raw: unknown, stepCount: number): GuideProgress {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...GUIDE_PROGRESS_DONE };
  const source = raw as Partial<GuideProgress>;
  const step = source.step;
  // 整数判定要单独写：`1.5` 既能 `Number.isFinite` 又在区间内，但它不是合法步数
  if (typeof step !== "number" || !Number.isInteger(step) || step < 0 || step > stepCount) {
    return { ...GUIDE_PROGRESS_DONE };
  }
  return {
    step,
    // 走到末尾等价于 done：step 与 done 两份事实冲突时，以「更靠前那一步」为准
    done: step >= stepCount ? true : source.done === true,
    skipped: source.skipped === true,
  };
}

/** 现在要不要显示引导（新号且没走完、没跳过） */
export function shouldRunGuide(progress: GuideProgress, stepCount: number): boolean {
  if (progress.done || progress.skipped) return false;
  return progress.step >= 0 && progress.step < stepCount;
}

/**
 * 收一个事件，返回推进后的进度（不推进时返回 null）
 *
 * **只有当前步的 `trigger` 命中才前进**：别的事件不越级 —— 否则玩家先点了背包，
 * 「走路 / 打怪 / 拾取」三步会被一起吃掉，引导就变成了三句没人看的废话。
 */
export function advanceGuide(
  progress: GuideProgress,
  currentTrigger: GuideEvent | null,
  event: GuideEvent,
  stepCount: number,
): GuideProgress | null {
  if (!shouldRunGuide(progress, stepCount)) return null;
  if (!currentTrigger || currentTrigger !== event) return null;
  return finishStep(progress, stepCount);
}

/** 主动跳过：落成 skipped，之后不再弹也不再自动开始（玩家点的是显式按钮） */
export function skipGuide(progress: GuideProgress): GuideProgress {
  return { step: progress.step, done: false, skipped: true };
}

/**
 * 无条件推进一步（内部用：`advanceGuide` 校验完事件就落到这里）
 */
function finishStep(progress: GuideProgress, stepCount: number): GuideProgress {
  const step = Math.min(progress.step + 1, stepCount);
  return { step, done: step >= stepCount, skipped: false };
}
