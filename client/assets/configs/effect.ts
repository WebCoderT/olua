import { Color, Vec2 } from "cc";
import type { UiEffectConfig } from "../ui/utils/net/ApiModels";

/**
 * 特效配置
 * 技能特效的资源路径与作用对象见 configs/skill 的 effect / effectIsOnSelf（每个技能各自配置），
 * 这里只放**统一的挂点口径**：特效节点与角色外观节点同一套规则（锚点居中、原始尺寸），
 * 因此特效与角色美术天然对齐，通常不需要偏移；需要整体上下/左右微调时改下面的偏移量。
 */
export const skillEffect = {
  /** 挂在释放者身上时的世界坐标偏移（角色节点锚点在脚底，正数向上/向右） */
  selfOffset: new Vec2(0, 0),
  /** 挂在目标（怪物）身上时的世界坐标偏移 */
  targetOffset: new Vec2(0, 0),
};

/**
 * 状态特效的统一口径（进行中的状态在角色身上循环播放的特效，见 core/StatusManager）
 * 各状态用哪张图集在 configs/status 的 effect 配置，这里只放共用的挂点偏移与播放帧率
 */
export const statusEffect = {
  /** 相对角色锚点（脚底）的世界坐标偏移 */
  offset: new Vec2(0, 0),
  /** 循环播放帧率（每秒帧数） */
  frameRate: 12,
};

/**
 * 选中怪物指示器的统一口径（选中怪物脚下循环播放的光圈，见 ui/components/hud/MonsterSelectIndicator）
 * 选中时创建、取消选中/目标失效即销毁，生命周期与怪物信息面板一致（见 core/RoleUIManager）
 */
export const selectIndicator = {
  /** 光圈图集（resources 路径，不含扩展名；TexturePacker 图集 plist + png 同名） */
  atlas: "effect/selected/select_monster@0",
  /** 相对怪物节点锚点的世界坐标偏移：怪物节点锚点居中（身体中心），负数向下压向脚底 */
  offset: new Vec2(0, -40),
  /** 循环播放帧率（每秒帧数） */
  frameRate: 10,
};

/**
 * 玩家受击的屏幕反馈（怪物普攻命中后全屏闪一下红，见 GameUiHelper.showHitScreenFlash）
 * 挂特效层、以相机为中心铺满可视区，淡入即淡出；无素材依赖（Graphics 画纯色矩形）
 */
export const hitScreenFlash = {
  /** 闪光颜色（配合 UIOpacity 淡入淡出，颜色本身不透明） */
  color: new Color(255, 0, 0, 255),
  /** 峰值不透明度（0~1）：只做一层薄红，闪一下提示即可，不能盖住画面 */
  maxOpacity: 0.16,
  /** 淡入时长（秒） */
  fadeIn: 0.05,
  /** 淡出时长（秒） */
  fadeOut: 0.25,
  /**
   * 限频间隔（毫秒）：连续挨打时不重触发，避免被围殴期间红屏常驻
   * （一次闪烁从淡入到淡出约 0.3 秒，限频略大于此即可看起来「每波命中闪一次」）
   */
  cooldownMs: 400,
  /** 铺满可视区再放大的倍率（镜头边缘/适配留白时防止四周露出未覆盖的底） */
  overscan: 1.2,
};

//#region 界面特效运行时表（#594）

/**
 * 升级特效的兜底参数（= 服务端 `UI_EFFECT_DEFAULTS.upgrade` 的出厂值）
 *
 * 服务端表在、快照没到 / 表里没有 `upgrade` 行时用它 —— 搬家不改行为：
 * 出厂值在两端各有一份（同一注释放着），但**权威在服务端**，这里只是兜底。
 */
export const upgradeEffectDefaults: Omit<UiEffectConfig, "key"> = {
  offsetX: 0,
  offsetY: 90,
  scaleX: 1,
  scaleY: 1,
  rotate: 0,
  durationMs: 1000,
  enabled: true,
};

/**
 * 运行时界面特效表（key → 表现参数，#594）
 *
 * 内容由服务端配置快照的 `uiEffects` 段填充（`applyUiEffectRows`，进游戏时一次，
 * **整表重建**）。**不要往这里写死数据** —— 那等于把配置又搬回了客户端。
 * key 的取值域由客户端的消费代码决定（`upgrade` 之外加特效 = 写消费代码 +
 * 服务端 `UI_EFFECT_KEYS` 登记，两端对上才有东西可演）。
 */
export const uiEffects = new Map<string, UiEffectConfig>();

/**
 * 取升级特效的表现参数（摆位与缩放都归服务端，见 GameUiHelper.createUpgradeEffect）
 *
 * 逐字段与出厂值合并：快照行覆盖它带来的字段，缺的字段回落出厂值 ——
 * 这里全是标量，浅合并正好安全；将来加字段时老快照不会把新字段带成 undefined。
 */
export function upgradeEffectConfig(): UiEffectConfig {
  // 逐字段合并（快照行覆盖它带来的字段，缺的字段留在出厂值）——
  // 不直接 {...defaults, ...row} 展开：老快照缺新字段时会把 undefined 盖到出厂值上
  const merged: Omit<UiEffectConfig, "key"> = { ...upgradeEffectDefaults };
  const row = uiEffects.get("upgrade");
  if (row) {
    const source = row as unknown as Record<string, unknown>;
    for (const field of Object.keys(upgradeEffectDefaults) as Array<keyof typeof upgradeEffectDefaults>) {
      const value = source[field];
      if (value !== undefined) (merged as Record<string, unknown>)[field] = value;
    }
  }
  return { key: "upgrade", ...merged };
}

//#endregion
