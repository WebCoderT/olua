/**
 * 战斗力权重（**唯一书写处**，服务端）
 *
 * 角色战斗力由服务端算（`modules/combat/role-attributes.ts` 消费生成物 `COMBAT_WEIGHTS`），
 * 客户端只在「背包里这件装备是不是更好」的提示上用到同一组权重
 * （`configs/equipments.equipmentCombatValue`）。#603 之前这组倍率写在客户端
 * `configs/battle.ts`，服务端经生成器抄一份 —— 归属反了：改一个权重要在客户端改。
 *
 * 现在只在这里写：生成器读它出 `COMBAT_WEIGHTS`（三端同一份），
 * 客户端经配置快照的 `combatWeights` 段拿到同一组数字，本地不再存。
 *
 * **#605 起这里只是出厂值**：当前值在 `combat_weights` 表（运营在管理端「战斗力权重」页改），
 * 服务端结算经 `shared/runtime-overrides.combatWeightsOf()` 读覆盖层、缺省才回落这份种子；
 * 客户端跟着快照走。改这里的值 = 改出厂值（只对没被运营改过的键生效，seed 幂等）。
 *
 * **hpRecover（每秒回血）不在表里**：战斗力是地图准入门槛（`maps.combat`），
 * 它是「能不能扛住 / 打不打得动」的综合刻度，而回血是持续回复、不改变输出与承伤上限；
 * 算进来会凭空抬高所有地图的门槛（回血量只有血量的约 1%）。
 *
 * 顺序即快照与生成物的字段顺序（Map 的自然顺序），改动它会改生成物字节。
 */
export const COMBAT_WEIGHTS_SEED: Record<string, number> = {
  magicAttack: 5,
  physicalAttack: 5,
  taoistAttack: 5,
  magicDefense: 10,
  physicalDefense: 10,
  taoistDefense: 10,
  maxHp: 15,
};
