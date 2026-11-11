/**
 * 装备穿戴规则的**唯一副本**（#838）
 *
 * ===========================================================================
 * 这一份是什么
 * ===========================================================================
 * 「这个角色能不能穿这件装备」的判据。写入侧只有一个调用点（`RolesService.bagOp` 的
 * `equip` 分支），但客户端也有一份**同顺序**的预检（`ui/core/GameHelper.getEquipmentRejectReason`），
 * 两处口径必须一致 —— 所以判据写在这里当唯一副本，客户端那份只用来提前提示
 * （改包跳过它只会收到服务端的 20021）。
 *
 * ## 三项判据与顺序
 *
 * **等级 → 性别 → 职业**，与客户端逐项一致。顺序影响的是「玩家看到哪条理由」：
 * 一个 1 级的战士去穿 60 级的法师装，正确答案是「需要等级 60」而不是「职业不符」——
 * 前者是他升到 60 级就能解决的问题，后者是换个角色才能解决，说错理由比不说更糟。
 *
 * ## 为什么「没配」= 不限制
 *
 * 两个限制字段都可能读成 `null`（不是装备 / 基础件行缺列 / 手改库把值清空）。这时**放行**：
 * 校验的目的是拦住「故意绕过限制」，不是替运营清理脏数据。反过来（认不出就当不合法）
 * 会让一次配置事故变成「全服某部位装备集体脱不下来 / 穿不上」，代价远大于漏拦一件。
 * 管理端写入口的 DTO 已经用枚举锁死了取值（`EQUIPMENT_OCCUPATION_KEYS` / `EQUIPMENT_SEX_KEYS`），
 * 正常路径造不出空值。
 *
 * ## 这里**不做**什么
 *
 * - 不判「是不是装备」：那是 `equipmentSlotOf` 的活，认不出部位就根本没有槽位可穿。
 * - 不判双手 / 副手互斥：本作**没有副手槽**（用户口径 2026-11-11「没有副手，以后也不会有」），
 *   所以「双手武器占副手槽」没有落点。`hand_type` 也一并暂时放置，重开条件见
 *   `docs/37` G4 与 `docs/24`。
 * - 不读配置表、不碰数据库：值是调用方从缓存里取好传进来的，这样它能在单测 / e2e 里直接跑。
 */

import { OCCUPATION_LABELS, SEX_LABELS } from "../../common/constants/game-enums";

/** 「全职业」码（装备侧；角色永远不会是它） */
export const EQUIP_OCCUPATION_ANY = "4";

/** 「全性别」码（装备侧；角色永远不会是它） */
export const EQUIP_SEX_ANY = "3";

/** 穿戴这件装备需要的角色信息（只有这三项参与裁决） */
export interface EquipRuleRole {
  level: number;
  /** 职业码：`1` 战士 / `2` 魔法师 / `3` 道士 */
  occupation: string;
  /** 性别码：`1` 男 / `2` 女 */
  sex: string;
}

/** 待裁决的装备（三项都可为 null = 没配；`level` 为 null 时调用方已按「认不出」拒过） */
export interface EquipRuleItem {
  level: number | null;
  occupation: string | null;
  sex: string | null;
}

/**
 * 穿不上时给玩家看的中文理由；**穿得上返回 `null`**
 *
 * 文案口径与客户端 `configs/texts` 的 `reject_equip_level` / `reject_equip_sex` /
 * `reject_equip_occupation` 一致，只是服务端会补上「这件装备」把句子说完整 ——
 * 玩家可能同时在开两个弹窗，太短的话不知道是哪件被拒了。
 */
export function equipRefusalOf(item: EquipRuleItem, role: EquipRuleRole): string | null {
  // —— 一、等级 ——
  if (item.level !== null && item.level > role.level) {
    return `需要等级 ${item.level} 才能穿戴这件装备`;
  }

  // —— 二、性别 ——
  const sex = item.sex;
  if (sex && sex !== EQUIP_SEX_ANY && sex !== role.sex) {
    const label = SEX_LABELS[sex];
    return label ? `${label}角色才能穿戴这件装备` : "性别不符，无法穿戴这件装备";
  }

  // —— 三、职业 ——
  const occupation = item.occupation;
  if (occupation && occupation !== EQUIP_OCCUPATION_ANY && occupation !== role.occupation) {
    const label = OCCUPATION_LABELS[occupation];
    return label ? `职业不符，只有${label}才能穿戴这件装备` : "职业不符，无法穿戴这件装备";
  }

  return null;
}
