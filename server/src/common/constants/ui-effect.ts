/**
 * 特效配置（#594 升级特效 / #634 掉落光效）
 *
 * 特效的**表现参数**（摆位 / 缩放 / 旋转 / 时长 / 开关）。与武器外观（`inScaleX / inScaleY /
 * inRotate / inPosition`）同一套取向：**数值归服务端、管理端可改、客户端随快照拉走** ——
 * 调一次摆位不用重打 3G 的客户端包。
 *
 * ## 现在管着两族特效
 *
 * | 族 | key | 图集 | 挂在哪 |
 * |---|---|---|---|
 * | 升级特效 | `upgrade` | `effect/<key>/<key>.plist` | UI 层，相对 UI 锚点摆位 |
 * | 掉落光效 | `light_1` ~ `light_6` | `effect/light/<key>.plist` | 掉落物节点上，相对**图标中心**摆位 |
 *
 * 掉落光效一档一个 key（不是合成一个 `dropLight`）：六张图集是六份美术，谁想单独放大某一档
 * 都该能做到；而且 key 直接取素材名，客户端 `getEquipmentLightKey()` 返回的就是它，两端不用
 * 再维护一层「档位 → key」的翻译表。**「哪档装备用哪张光柱」（前缀表 + 特殊装备自定义表）
 * 仍然在客户端** —— 那是美术分配，不是「这张图怎么摆」，塞不进这张扁平的表（见
 * `client/assets/configs/light.ts`）。
 *
 * ## 资源路径为什么不在配置里（#573 同一条纪律）
 *
 * 图集路径是**两端约定**（管理端预览按 `effectAtlasPath` 的规则拼，见 `admin/src/pages/uiEffects/preview.ts`），
 * 不是数据：存了就会有人在后台改它，而改它只会把客户端指到一张不存在的图上（加载失败、
 * 特效消失，管理端还以为保存成功了）。要换特效美术，路只有一条：换图集资源 → 重新分发资源包；
 * 表里管的只是「这张图怎么摆、放多快、开不开」。
 *
 * ## 行的来源
 *
 * 行由启动 seed 按 `UI_EFFECT_DEFAULTS` 补出来（`INSERT OR IGNORE` 幂等）——
 * 一个 key 在不在，取决于「客户端有没有这个特效的消费代码」，后台不该凭空造行
 * （造出来的行没人消费，等于一个永远不生效的开关）。所以**没有新建 / 删除接口**。
 */

/** 特效 key（唯一来源；加新特效 = 客户端有消费代码 + 这里登记 + DEFAULTS 给出厂值） */
export const UI_EFFECT_KEYS = ["upgrade", "light_1", "light_2", "light_3", "light_4", "light_5", "light_6"] as const;

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
 *
 * `light_*` 那六行是「装备掉落光柱」的原值（`configs/layout/lights` 的 400×400 + 10fps、
 * 挂在图标中心）：
 * - 偏移 (0, 0) = **与掉落物图标同心**（客户端把它加到 `dropItemLayout.iconOffsetY` 上）；
 * - 缩放 1 = 素材原始 400×400 画布；
 * - 时长 = 帧数 × 100ms（10fps 的等效口径）：1 号 14 帧 = 1400，2~6 号各 15 帧 = 1500。
 *   **换素材改帧数时这里要跟着改**（客户端兜底值同理），`client/tools/test-equipment-light.cjs`
 *   拿 plist 的实际帧数逐条核对，对不上会红。
 */
export const UI_EFFECT_DEFAULTS: Record<UiEffectKey, UiEffectDefault> = {
  upgrade: { offsetX: 0, offsetY: 90, scaleX: 1, scaleY: 1, rotate: 0, durationMs: 1000, enabled: true },
  light_1: { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotate: 0, durationMs: 1400, enabled: true },
  light_2: { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotate: 0, durationMs: 1500, enabled: true },
  light_3: { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotate: 0, durationMs: 1500, enabled: true },
  light_4: { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotate: 0, durationMs: 1500, enabled: true },
  light_5: { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotate: 0, durationMs: 1500, enabled: true },
  light_6: { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotate: 0, durationMs: 1500, enabled: true },
};

/** 有出厂值的 key（seed 用） */
export function uiEffectDefaultOf(key: string): UiEffectDefault | null {
  return (UI_EFFECT_DEFAULTS as Record<string, UiEffectDefault | undefined>)[key] ?? null;
}
