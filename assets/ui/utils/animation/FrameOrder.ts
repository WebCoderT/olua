/**
 * 帧序号解析（纯函数，零依赖，便于单测）
 *
 * 为什么必须有它：`AnimationHelper` 按 `configs/animation` 的帧号表（动作段起点 + 方向下标 × 帧长 + 帧内下标）
 * 从整包帧里挑帧，靠的就是**帧资源名里的帧序号**；帧的排序同理。而帧名不是稳定形态：
 * - 小写 `.png` 会被导入器识别为图片 → 子资源名 = 去掉扩展名的文件名（如 "00000"、"sfx_13001_0_0003"）
 * - **大写 `.PNG` 不被识别** → 文件名整串当子资源名（如 "00000.PNG"）→ 直接 `Number(name)` 得到 NaN
 * 衣服/武器的外观帧恰好全是大写扩展名（clothes/weapons 各上万张，怪物/NPC/称号等都是小写），
 * 帧号解析出 NaN 会让「一个片段都切不出来」→ 装备外观整个不显示（内观是静态图，不经过这里）。
 * 因此统一「先去扩展名，再取末尾连续数字」，两种形态一张表都能吃到。
 */

/**
 * 从帧资源名里取帧序号；取不到返回 null
 * null 与 0 必须区分：0 是合法帧序号（第 0 帧），只有「名字里没有数字」才返回 null
 */
export function getFrameIndex(name: string): number | null {
  const match = name.replace(/\.[^.]*$/, "").match(/(\d+)$/);
  return match ? Number(match[1]) : null;
}

/** 排序用帧序号：取不到序号按 0（只用于排序，判断「有没有帧号」要用 getFrameIndex） */
export function getFrameOrder(name: string): number {
  return getFrameIndex(name) ?? 0;
}
