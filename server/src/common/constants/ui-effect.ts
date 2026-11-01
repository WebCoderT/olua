/**
 * 界面特效配置（#594）
 *
 * 界面层特效（首个：升级特效）的表现参数。与武器外观（`inScaleX / inScaleY / inRotate /
 * inPosition`）同一套取向：**数值归服务端、管理端可改、客户端随快照拉走** ——
 * 调一次摆位不用重打 3G 的客户端包。
 *
 * ## 资源路径为什么不在配置里（#573 同一条纪律）
 *
 * 图集路径是**两端约定**（`effect/<key>/<key>.plist`，见 `configs/effect.ts`），不是数据：
 * 存了就会有人在后台改它，而改它只会把客户端指到一张不存在的图上（加载失败、特效消失，
 * 管理端还以为保存成功了）。要换特效美术，路只有一条：换图集资源 → 重新分发资源包；
 * 表里管的只是「这张图怎么摆、放多快、开不开」。
 *
 * ## 行的来源
 *
 * 行由启动 seed 按 `UI_EFFECT_DEFAULTS` 补出来（`INSERT OR IGNORE` 幂等）——
 * 一个 key 在不在，取决于「客户端有没有这个特效的消费代码」，后台不该凭空造行
 * （造出来的行没人消费，等于一个永远不生效的开关）。所以**没有新建 / 删除接口**。
 */

/** 界面特效 key（唯一来源；加新特效 = 客户端有消费代码 + 这里登记 + DEFAULTS 给出厂值） */
export const UI_EFFECT_KEYS = ["upgrade"] as const;

export type UiEffectKey = (typeof UI_EFFECT_KEYS)[number];

/** 校验边界（SaveUiEffectDto 与管理端输入框共用同一组数） */
export const UI_EFFECT_LIMITS = {
  /** 摆位偏移（像素，相对 UI 层锚点；y 向上为正） */
  offsetMin: -2000,
  offsetMax: 2000,
  /** 缩放（1 = 原始尺寸） */
  scaleMin: 0.1,
  scaleMax: 5,
  /** 旋转（度，顺时针） */
  rotateMin: -360,
  rotateMax: 360,
  /** 一轮播放总时长（毫秒）；帧率由帧数 / 时长推出 */
  durationMinMs: 100,
  durationMaxMs: 10_000,
} as const;

export interface UiEffectDefault {
  offsetX: number;
  offsetY: number;
  scaleX: number;
  scaleY: number;
  rotate: number;
  durationMs: number;
  enabled: boolean;
}

/**
 * 出厂值（key → 表现参数）
 *
 * `upgrade` 那行就是「升级特效」写死在 `GameUiHelper.createUpgradeEffect` 里的那组数
 * （摆位 (0, 90)、原尺寸、1 秒一轮）—— 搬家不改行为，只是把「改它要发版」变成「管理端点保存」。
 */
export const UI_EFFECT_DEFAULTS: Record<UiEffectKey, UiEffectDefault> = {
  upgrade: { offsetX: 0, offsetY: 90, scaleX: 1, scaleY: 1, rotate: 0, durationMs: 1000, enabled: true },
};

/** 有出厂值的 key（seed 用） */
export function uiEffectDefaultOf(key: string): UiEffectDefault | null {
  return (UI_EFFECT_DEFAULTS as Record<string, UiEffectDefault | undefined>)[key] ?? null;
}
