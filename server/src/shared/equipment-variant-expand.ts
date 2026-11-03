/**
 * 装备变体展开（#655）—— **一次性出厂数据生成**，不是运行时算法
 *
 * ===========================================================================
 * 为什么这个文件存在，而它为什么不算「生成式曲线」
 * ===========================================================================
 * 555 个变体 = 37 个基础件 × 5 前缀 × 3 后缀。如果把 555 行手写在源码里，
 * 改一个基础件的数值就要改 15 行，而且「哪 15 行」只能靠人算 —— 那才是真正的维护灾难。
 *
 * 所以展开算法留着，但**只在建库时跑一次**（`GameConfigService` 启动 seed、
 * `scripts/migrate-derived-tables.cjs` 迁移），把结果写成 555 行入库。
 * 运行时（结算 / 快照）只读表，永不调用这里的函数 —— 由
 * `tools/audit-derived-tables.cjs` 守点，任何模块 import 它就是 FAIL。
 *
 * 换句话说：**这是「出厂数据的构造方式」，不是「每次读取都重算的曲线」**。
 * 想把某件装备调强，改它那一行（管理端「装备变体」页），不是改倍率。
 */

/** 一条装备基础件里参与数值计算的字段（显示字段由基础件表保留，不重复带入） */
export interface EquipmentVariantBase {
  id: string;
  label: string;
  level: number;
  max_hp: number;
  hp_recover: number;
  physical_attack_min: number;
  physical_attack_max: number;
  magic_attack_min: number;
  magic_attack_max: number;
  taoist_attack_min: number;
  taoist_attack_max: number;
  physical_defense_min: number;
  physical_defense_max: number;
  magic_defense_min: number;
  magic_defense_max: number;
  taoist_defense_min: number;
  taoist_defense_max: number;
}

/** 展开出来的一行（不含 updated_at —— 由调用方决定 0 还是当前时间） */
export interface EquipmentVariantExpanded extends EquipmentVariantBase {
  /** 变体 id：基础件原 id（p0s0）或 `${id}_p${prefix}s${suffix}` */
  id: string;
  base_id: string;
  prefix: number;
  suffix: number;
  sell_price: number;
}

/** 一条分段线性曲线的一档（与 growth-seed 同形状，避免两处定义漂移） */
export interface CurveSegment {
  from: number;
  to: number;
  start: number;
  perLevel: number;
}

/** 在分段线性曲线上取值（超出末段按末段斜率外推） */
export function sampleCurve(segments: CurveSegment[], level: number): number {
  if (!segments.length || level <= 0) return 0;
  let last = segments[0];
  for (const segment of segments) {
    if (level <= segment.to) return segment.start + (level - segment.from) * segment.perLevel;
    last = segment;
  }
  return last.start + (level - last.from) * last.perLevel;
}

/**
 * 把 37 个基础件展开成 555 个变体
 *
 * 取整口径与客户端旧版 `buildEquipmentMap` 逐值相同（`Math.round(基础值 × 倍率)`），
 * 所以迁移前后玩家的面板 / 回收价一分钱都不差。
 *
 * @param bases 基础件行（id / 名称 / 等级 / 八项属性）
 * @param prefixRates 前缀倍率（下标 = 前缀序号；空数组 = 一件都不展开，调用方要拦）
 * @param suffixRates 后缀倍率
 * @param recycleCurve 回收价曲线（按基础件等级取基础价，再乘变体倍率）
 */
export function expandEquipmentVariants(
  bases: EquipmentVariantBase[],
  prefixRates: number[],
  suffixRates: number[],
  recycleCurve: CurveSegment[],
): EquipmentVariantExpanded[] {
  const variants: EquipmentVariantExpanded[] = [];
  for (const base of bases) {
    const basePrice = Math.max(0, Math.round(sampleCurve(recycleCurve, Number(base.level) || 1)));
    for (let prefix = 0; prefix < prefixRates.length; prefix++) {
      for (let suffix = 0; suffix < suffixRates.length; suffix++) {
        const rate = prefixRates[prefix] * suffixRates[suffix];
        const scale = (value: number) => Math.round(Number(value) * rate);
        variants.push({
          id: prefix === 0 && suffix === 0 ? base.id : `${base.id}_p${prefix}s${suffix}`,
          base_id: base.id,
          prefix,
          suffix,
          // 名称存**基础名**：前后缀文案由客户端按序号分段渲染并着色，这里拼进去会重复
          label: base.label,
          level: Number(base.level) || 1,
          sell_price: Math.round(basePrice * rate),
          max_hp: scale(base.max_hp),
          hp_recover: scale(base.hp_recover),
          physical_attack_min: scale(base.physical_attack_min),
          physical_attack_max: scale(base.physical_attack_max),
          magic_attack_min: scale(base.magic_attack_min),
          magic_attack_max: scale(base.magic_attack_max),
          taoist_attack_min: scale(base.taoist_attack_min),
          taoist_attack_max: scale(base.taoist_attack_max),
          physical_defense_min: scale(base.physical_defense_min),
          physical_defense_max: scale(base.physical_defense_max),
          magic_defense_min: scale(base.magic_defense_min),
          magic_defense_max: scale(base.magic_defense_max),
          taoist_defense_min: scale(base.taoist_defense_min),
          taoist_defense_max: scale(base.taoist_defense_max),
        });
      }
    }
  }
  return variants;
}
